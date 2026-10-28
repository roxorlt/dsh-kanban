// Git 上下文采集（只读派生数据，契约 docs/contracts/06-git-context.md）：
// 对卡片 cwd 执行一组只读 git 命令，产出卡片详情抽屉泳道图所需的
// 仓库 / 当前分支 / upstream / 主分支参照 / 工作树 / 提交列表 / 引用标记，
// 以及 v0.14 的 Fork 风格多分支提交图数据（graph，§4.5；可选增强，缺失时前端隐藏图）。
// v0.16/v0.17 追加工作区地图（§12）与工作副本清理（§13：软删除到回收站 + prune + 可选删分支）；
// v0.18 追加回收站列表/恢复/彻底删除（§14，清理目录内写 manifest.json 供恢复）。
// 除 §13 清理 / §14 恢复外所有 git 调用都走 execFile（不拼 shell、不读用户交互输入）；单条 2s、整次 4s 兜底；
// 任何采集失败都收敛成 available:false + reason，不抛给路由层；GIT_OPTIONAL_LOCKS=0 保证不动仓库。
import { execFile } from 'node:child_process'
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 列表上限（契约 §3 limits / §4.2 / §4.3）。 */
export const GIT_LIMITS = Object.freeze({ ahead: 12, behind: 8, shared: 4, worktrees: 8 })

/** Fork 风格多分支提交图的上限（契约 §4.5）。 */
export const GIT_GRAPH_LIMITS = Object.freeze({ commits: 48, refs: 10 })

/** 单元分隔符（提交行 / 引用行解析共用）。 */
const FIELD_SEP = '\x1f'
/** 提交行格式：完整 sha / 短 sha / 提交时间（秒）/ 作者 / subject。 */
const COMMIT_FORMAT = '%H%x1f%h%x1f%ct%x1f%an%x1f%s'
/** graph 提交行：额外带父 sha（空格分隔，合并提交有多个），用于前端泳道出弯。 */
const GRAPH_COMMIT_FORMAT = '%H%x1f%h%x1f%P%x1f%ct%x1f%an%x1f%s'
/**
 * graph 引用行格式。注意 for-each-ref 不认 %x1f（那是 pretty-format 的转义），
 * 这里用真实的 0x1f 字符当分隔符；末尾额外带 %(refname) 全名，
 * 用来可靠区分 refs/heads 与 refs/remotes（%(refname:short) 在重名时会被改写）。
 */
const GRAPH_REF_FORMAT = [
  '%(refname:short)', '%(objectname)', '%(upstream:short)', '%(upstream:track)',
  '%(committerdate:unix)', '%(refname)',
].join(FIELD_SEP)
const COMMAND_TIMEOUT_MS = 2_000
const TOTAL_BUDGET_MS = 4_000
const MAX_BUFFER = 4 * 1024 * 1024

/** 单条 git 命令或整次采集超出预算（契约 §1 / §3.1 的 timeout）。 */
class GitTimeout extends Error {}

/** git 可执行文件本身不可用（例如 PATH 里没有 git），归为 error。 */
class GitBinaryMissing extends Error {}

/** 只读 git 命令的环境：固定可选锁与 locale，保证解析稳定。 */
function gitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
}

/**
 * 执行一条只读 git 命令（不经过 shell，参数原样传给 git）。
 * 返回 { ok, stdout, stderr }：git 以非零退出返回 ok:false（调用方按语义处理），
 * 超时/找不到 git 则抛异常，由入口统一归到 reason。
 */
function runGit(dir, args, context) {
  const remaining = TOTAL_BUDGET_MS - (Date.now() - context.startedAt)
  if (remaining <= 0) return Promise.reject(new GitTimeout('git 采集超过 4s 预算'))
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, {
      cwd: dir,
      timeout: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remaining)),
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      env: gitEnv(),
    }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        return
      }
      if (error.killed || error.signal) {
        rejectPromise(new GitTimeout(`git ${args[0] || ''} 超时`))
        return
      }
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        rejectPromise(new GitBinaryMissing(`无法执行 git：${error.message}`))
        return
      }
      resolvePromise({ ok: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

// ---------------- 路径与引用工具 ----------------

async function realOrNull(value) {
  try { return await realpath(value) } catch { return null }
}

/** realpath 且必须是目录；不存在 / 不可访问 / 不是目录都返回 null（reason=missing）。 */
async function realDirectory(value) {
  try {
    const target = await realpath(value)
    return (await stat(target)).isDirectory() ? target : null
  } catch { return null }
}

/** child 是否等于 root 或位于 root 之下（两者都应是 realpath）。 */
function isInside(child, root) {
  const rel = relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function shortShaOf(sha) {
  return sha.slice(0, 7)
}

function shaPair(sha) {
  return { sha, shortSha: shortShaOf(sha) }
}

/** 校验引用存在并取回 sha；引用不存在或命令失败都返回 null。 */
async function verifyRef(dir, ref, context) {
  const result = await runGit(dir, ['rev-parse', '--verify', '--quiet', ref], context)
  const sha = result.ok ? result.stdout.trim() : ''
  return sha ? { sha } : null
}

/**
 * 解析目录所属的 git 仓库身份：
 * gitDir = 当前工作树自己的 .git（linked worktree 指向 <主仓库>/.git/worktrees/<name>），
 * commonDir = 整个仓库共享的 .git；两者 realpath 相同即主工作树。
 * 目录不在 git 仓库内时返回 null。
 */
async function repoIdentity(dir, context) {
  const result = await runGit(dir, ['rev-parse', '--git-dir', '--git-common-dir'], context)
  if (!result.ok) return null
  const lines = result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const gitDir = await realOrNull(resolve(dir, lines[0]))
  const commonDir = await realOrNull(resolve(dir, lines[1]))
  if (!gitDir || !commonDir) return null
  return { gitDir, commonDir, isMainWorktree: gitDir === commonDir }
}

/** `git rev-list --left-right --count left...right`：left=左侧独有，right=右侧独有。 */
async function countRange(dir, leftRef, rightRef, context) {
  const result = await runGit(dir, ['rev-list', '--left-right', '--count', `${leftRef}...${rightRef}`], context)
  if (!result.ok) return null
  const [left, right] = result.stdout.trim().split(/\s+/).map(Number)
  return Number.isFinite(left) && Number.isFinite(right) ? { left, right } : null
}

// ---------------- 提交与工作树解析 ----------------

function parseCommitLine(line) {
  const parts = line.split(FIELD_SEP)
  if (parts.length < 5) return null
  const [sha, shortSha, seconds, authorName] = parts
  const committedAt = Number(seconds) * 1000
  if (!sha || !shortSha || !Number.isFinite(committedAt)) return null
  // subject 里理论上也可能出现分隔符，余下部分原样拼回
  return { sha, shortSha, subject: parts.slice(4).join(FIELD_SEP), authorName, committedAt }
}

function parseCommitLog(text) {
  return text.split('\n').filter(line => line.length > 0).map(parseCommitLine).filter(Boolean)
}

/** 按契约 §4.2 取一段提交（新 → 旧）；命令失败按空列表处理，不影响 available。 */
async function readCommitLog(dir, range, limit, context) {
  const result = await runGit(dir, ['log', '--date-order', `--max-count=${limit}`, `--format=${COMMIT_FORMAT}`, range], context)
  return result.ok ? parseCommitLog(result.stdout) : []
}

/** 解析 `git worktree list --porcelain`（空行分隔的键值块，主工作树恒为第一项）。 */
function parseWorktreeList(text) {
  const entries = []
  let current = null
  const flush = () => { if (current) { entries.push(current); current = null } }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) { flush(); continue }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length), sha: null, branch: null, detached: false, locked: false, prunable: false }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) current.sha = line.slice('HEAD '.length).trim() || null
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      if (ref.startsWith('refs/heads/')) current.branch = ref.slice('refs/heads/'.length)
    } else if (line === 'detached') current.detached = true
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true
  }
  flush()
  return entries
}

/** 工作树路径统一转 realpath（macOS /tmp → /private/tmp 等符号链接要在同一坐标系里比较）。 */
async function resolveWorktrees(entries) {
  const resolved = []
  for (const entry of entries) {
    const real = await realOrNull(entry.path)
    resolved.push({ ...entry, path: real ?? entry.path, realPath: real ?? entry.path, exists: real !== null })
  }
  return resolved
}

/** 最长前缀匹配：dir 落在哪个工作树里；没有匹配返回 -1。 */
function findCurrentWorktree(entries, dir) {
  let best = -1
  let bestLength = -1
  entries.forEach((entry, index) => {
    if (!isInside(dir, entry.realPath)) return
    if (entry.realPath.length > bestLength) { best = index; bestLength = entry.realPath.length }
  })
  return best
}

/** 超过上限时优先保留主工作树（第 0 项）与当前工作树，其余按 worktree list 原顺序补齐。 */
function prioritizeWorktrees(entries, currentIndex) {
  const limit = GIT_LIMITS.worktrees
  if (entries.length <= limit) {
    return { selected: entries.map((entry, index) => ({ entry, index })), truncated: 0 }
  }
  const keep = new Set([0])
  if (currentIndex >= 0) keep.add(currentIndex)
  for (let index = 0; keep.size < limit && index < entries.length; index += 1) keep.add(index)
  const selected = entries.map((entry, index) => ({ entry, index })).filter(item => keep.has(item.index))
  return { selected, truncated: entries.length - selected.length }
}

// ---------------- 目录选择（契约 §1.1） ----------------

/**
 * 选择实际采集目录：card.cwd 是基准，?cwd= 只是候选。
 * 候选必须同时满足：realpath 存在且是目录、与 card.cwd 属于同一仓库（git-common-dir 相同）、
 * 且候选是 linked worktree 而 card.cwd 在主工作树；否则静默忽略候选。
 */
async function selectDirectory(cardDir, requestedDir, context) {
  if (!requestedDir || !isAbsolute(requestedDir)) return cardDir
  const candidateDir = await realDirectory(requestedDir)
  if (!candidateDir || candidateDir === cardDir) return cardDir
  const candidateRepo = await repoIdentity(candidateDir, context)
  if (!candidateRepo) return cardDir
  const cardRepo = await repoIdentity(cardDir, context)
  if (!cardRepo) return cardDir
  if (candidateRepo.commonDir !== cardRepo.commonDir) return cardDir
  // 只接受「卡片在主工作树、候选在 linked worktree」这一个方向
  if (candidateRepo.isMainWorktree || !cardRepo.isMainWorktree) return cardDir
  return candidateDir
}

// ---------------- 主分支 / upstream / 参照物（契约 §4.1） ----------------

/**
 * 按契约 §4.1 的顺序探测主分支名：
 * origin/HEAD → 本地 main → 本地 master → origin/main → origin/master。
 * 名字定下来后，比较引用优先取本地同名分支（即使名字来自 origin/HEAD），
 * 这样「本地 main 领先 origin/main」这类差异能被正确比较。
 */
async function detectMainBranch(dir, context) {
  const candidates = []
  const symbolic = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], context)
  if (symbolic.ok) {
    const target = symbolic.stdout.trim()
    const slash = target.indexOf('/')
    const name = slash >= 0 ? target.slice(slash + 1) : ''
    if (name) candidates.push({ name, full: `refs/remotes/${target}` })
  }
  for (const name of ['main', 'master']) candidates.push({ name, full: `refs/heads/${name}` })
  for (const name of ['main', 'master']) candidates.push({ name, full: `refs/remotes/origin/${name}` })
  for (const candidate of candidates) {
    const found = await verifyRef(dir, candidate.full, context)
    if (!found) continue
    if (candidate.full.startsWith('refs/remotes/')) {
      const local = await verifyRef(dir, `refs/heads/${candidate.name}`, context)
      if (local) return { name: candidate.name, full: `refs/heads/${candidate.name}`, sha: local.sha }
    }
    return { name: candidate.name, full: candidate.full, sha: found.sha }
  }
  return null
}

/** 当前分支的 upstream（`@{u}`），无 upstream 返回 null。 */
async function detectUpstream(dir, context) {
  const named = await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], context)
  if (!named.ok) return null
  const ref = named.stdout.trim()
  if (!ref || ref === '@{u}') return null
  const found = await verifyRef(dir, ref, context)
  if (!found) return null
  const slash = ref.indexOf('/')
  // 上游通常是远端跟踪分支（origin/x），也可能是本地分支（main）：只有前者有 remote
  const remote = slash > 0 ? ref.slice(0, slash) : null
  const branch = slash > 0 ? ref.slice(slash + 1) : ref
  const full = ref.startsWith('refs/') ? ref : slash > 0 ? `refs/remotes/${ref}` : `refs/heads/${ref}`
  return { ref, full, remote, branch, sha: found.sha }
}

/** 主分支在 origin 上的同名引用（如 origin/main），不存在返回 null。 */
async function detectRemoteRef(dir, mainBranch, context) {
  const short = `origin/${mainBranch}`
  const found = await verifyRef(dir, `refs/remotes/${short}`, context)
  return found ? { short, full: `refs/remotes/${short}`, sha: found.sha } : null
}

/**
 * 按契约 §4.1 选泳道 0 参照物（base）与实际比较引用 compare：
 * - 当前分支 ≠ 主分支 / detached：与主分支比较，kind=main；
 * - 当前分支 = 主分支且有 upstream：与 upstream 比较，kind=upstream；
 * - 当前分支 = 主分支且无 upstream：无比较对象，mergeBase 为 null、图退化为单泳道。
 * compare 为 null 表示没有可比的引用（内部字段，不进响应）。
 */
function buildBase({ mainInfo, upstream, remoteRef, branch }) {
  if (!mainInfo) return { base: null, compare: null }
  const onMain = branch !== null && branch === mainInfo.name
  const kind = onMain && upstream ? 'upstream' : 'main'
  let label
  let compare = null
  if (kind === 'upstream') {
    label = upstream.ref
    compare = { full: upstream.full, short: upstream.ref }
  } else if (!onMain) {
    label = mainInfo.name
    compare = { full: mainInfo.full, short: mainInfo.name }
  } else {
    label = mainInfo.name
  }
  return {
    base: {
      kind,
      label,
      branch: mainInfo.name,
      remoteRef: remoteRef ? remoteRef.short : null,
      ahead: 0,
      behind: 0,
      mergeBase: null,
      remoteAhead: null,
      remoteBehind: null,
    },
    compare,
  }
}

// ---------------- Fork 风格多分支提交图（契约 §4.5，v0.14） ----------------

/**
 * 解析 `%(upstream:track)`：
 * `[ahead N, behind M]` / `[ahead N]` / `[behind M]` → 具体计数；
 * 空串 = 有 upstream 且与之一致（0/0）；`[gone]` = 上游已删除 → null。
 */
function parseUpstreamCounts(upstreamShort, trackText) {
  if (!upstreamShort) return { ahead: null, behind: null }
  const text = String(trackText || '').trim()
  if (!text) return { ahead: 0, behind: 0 }
  if (text === '[gone]') return { ahead: null, behind: null }
  const ahead = /ahead (\d+)/.exec(text)
  const behind = /behind (\d+)/.exec(text)
  if (!ahead && !behind) return { ahead: null, behind: null }
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 }
}

/**
 * 解析 for-each-ref 输出为本地分支 / origin 远端引用两组记录。
 * refs/remotes/origin/HEAD 是符号引用，不参与 graph（避免和 origin/<主分支> 抢泳道种子）。
 */
function parseGraphRefRecords(text) {
  const locals = []
  const remotes = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const parts = line.split(FIELD_SEP)
    if (parts.length < 6) continue
    const [, sha, upstreamShort, trackText, seconds, fullName] = parts
    if (!sha || !fullName) continue
    if (fullName === 'refs/remotes/origin/HEAD') continue
    let name = ''
    let isRemote = false
    if (fullName.startsWith('refs/heads/')) {
      name = fullName.slice('refs/heads/'.length)
    } else if (fullName.startsWith('refs/remotes/')) {
      name = fullName.slice('refs/remotes/'.length)
      isRemote = true
    } else continue
    const committedAt = Number(seconds) * 1000
    const record = {
      fullName,
      name,
      sha,
      shortSha: shortShaOf(sha),
      committedAt: Number.isFinite(committedAt) ? committedAt : 0,
      isRemote,
      upstream: upstreamShort || null,
      ...parseUpstreamCounts(upstreamShort, trackText),
    }
    if (isRemote) remotes.push(record)
    else locals.push(record)
  }
  return { locals, remotes }
}

/**
 * 按契约 §4.5 的优先级挑选 graph 引用（数组顺序 = 前端泳道种子顺序）：
 * HEAD → 当前分支 → 主分支 → origin/主分支 → 当前 upstream →
 * 工作树分支（worktree list 顺序）→ 其余本地分支（committerdate 倒序）→ 已列本地分支的 origin/<branch>。
 * 超过 maxRefs 的引用计入 refsTruncated（数组已按优先级截断）。
 */
function selectGraphRefs({ locals, remotes, branch, mainInfo, upstreamInfo, worktreeBranches }) {
  const localByName = new Map(locals.map(record => [record.name, record]))
  const remoteByName = new Map(remotes.map(record => [record.name, record]))
  const picked = [{ head: true }]
  const used = new Set(['HEAD'])
  const add = record => {
    if (!record || used.has(record.fullName)) return
    used.add(record.fullName)
    picked.push(record)
  }
  // 2) 当前分支
  if (branch) add(localByName.get(branch))
  // 3) 主分支（本地 refs/heads 存在时）
  if (mainInfo && mainInfo.full.startsWith('refs/heads/')) add(localByName.get(mainInfo.name))
  // 4) origin/<主分支>
  if (mainInfo) add(remoteByName.get(`origin/${mainInfo.name}`))
  // 5) 当前分支的 upstream（非 origin 远端时 for-each-ref 不含它，用已校验的 sha 合成一条）
  if (upstreamInfo) {
    const known = localByName.get(upstreamInfo.ref) || remoteByName.get(upstreamInfo.ref)
    if (known) add(known)
    else if (upstreamInfo.full) {
      add({
        fullName: upstreamInfo.full,
        name: upstreamInfo.ref,
        sha: upstreamInfo.sha,
        shortSha: shortShaOf(upstreamInfo.sha),
        committedAt: 0,
        isRemote: true,
        upstream: null,
        ahead: null,
        behind: null,
      })
    }
  }
  // 6) 工作树分支（worktree list 顺序）
  for (const name of worktreeBranches) add(localByName.get(name))
  // 7) 其余本地分支（committerdate 倒序，同时间按名字稳定排序）
  const rest = [...locals].sort((a, b) => (b.committedAt - a.committedAt) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const record of rest) add(record)
  // 8) 已列本地分支在 origin 上的同名引用
  for (const record of picked.filter(entry => !entry.head && !entry.isRemote)) {
    add(remoteByName.get(`origin/${record.name}`))
  }
  const refs = picked.slice(0, GIT_GRAPH_LIMITS.refs)
  return { picked: refs, refsTruncated: Math.max(0, picked.length - refs.length) }
}

/** 把选中的引用记录映射成契约 §3 的 graph.refs 结构（HEAD/remote 无 ahead/behind）。 */
function toGraphRefs(picked, { headSha, branch }) {
  return picked.map(entry => {
    if (entry.head) {
      return { name: 'HEAD', kind: 'head', sha: headSha, shortSha: shortShaOf(headSha), branch: branch ?? null }
    }
    if (entry.isRemote) {
      return { name: entry.name, kind: 'remote', sha: entry.sha, shortSha: entry.shortSha }
    }
    return {
      name: entry.name,
      kind: 'branch',
      sha: entry.sha,
      shortSha: entry.shortSha,
      isCurrent: entry.name === branch,
      upstream: entry.upstream,
      ahead: entry.ahead,
      behind: entry.behind,
    }
  })
}

/** 解析 graph 提交行（父 sha 用空格分隔，合并提交有多个）。 */
function parseGraphCommits(text) {
  const commits = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const parts = line.split(FIELD_SEP)
    if (parts.length < 6) continue
    const [sha, shortSha, parentsText, seconds, authorName] = parts
    const committedAt = Number(seconds) * 1000
    if (!sha || !shortSha || !Number.isFinite(committedAt)) continue
    commits.push({
      sha,
      shortSha,
      subject: parts.slice(5).join(FIELD_SEP),
      authorName,
      committedAt,
      parents: parentsText.trim() ? parentsText.trim().split(/\s+/) : [],
    })
  }
  return commits
}

/**
 * 采集 Fork 风格多分支提交图（契约 §4.5）。可选增强：
 * for-each-ref / log / rev-list 的任何失败都退化为 graph=null，不影响 available 主流程；
 * 只有整次预算真的耗尽（>4s）才把超时抛回主流程，保持契约 §1 的 timeout 语义。
 */
async function collectGraphContext({ dir, context, refsResult, headSha, branch, mainInfo, upstreamInfo, worktreeBranches }) {
  try {
    if (!refsResult || !refsResult.ok) return null
    const { locals, remotes } = parseGraphRefRecords(refsResult.stdout)
    const { picked, refsTruncated } = selectGraphRefs({
      locals, remotes, branch, mainInfo, upstreamInfo, worktreeBranches,
    })
    const rawRefs = picked.map(entry => (entry.head ? 'HEAD' : entry.fullName))
    const [logResult, countResult] = await Promise.all([
      runGit(dir, [
        'log', '--date-order', `--max-count=${GIT_GRAPH_LIMITS.commits}`,
        `--pretty=format:${GRAPH_COMMIT_FORMAT}`, ...rawRefs,
      ], context),
      runGit(dir, ['rev-list', '--count', ...rawRefs], context),
    ])
    if (!logResult.ok) return null
    const commits = parseGraphCommits(logResult.stdout)
    const total = countResult.ok ? Number(countResult.stdout.trim()) : NaN
    return {
      refs: toGraphRefs(picked, { headSha, branch }),
      refsTruncated,
      commits,
      // 引用范围内总提交数 − 返回条数；计数失败时兜底 0（graph 本身仍可用）
      truncated: Number.isFinite(total) ? Math.max(0, total - commits.length) : 0,
      maxCommits: GIT_GRAPH_LIMITS.commits,
      maxRefs: GIT_GRAPH_LIMITS.refs,
    }
  } catch (error) {
    if (Date.now() - context.startedAt >= TOTAL_BUDGET_MS) throw error
    return null // 单条新命令超时/失败：只让 graph 缺失
  }
}

// ---------------- 轻量摘要（契约 02-http-api §11 / 06 §4.6，v0.15） ----------------

/**
 * 采集单个目录的轻量工作线摘要（卡片徽标用）：不采 graph、不取提交列表，
 * 只回答「在哪条工作线、相对主线多/少、线上同步没有」。
 * 失败收敛为 { available:false, reason }，不抛异常。
 * @param {string} cwd 目录（通常为卡片 cwd；内部 trim + realpath）
 */
export async function collectGitSummary(cwd) {
  const startedAt = Date.now()
  const context = { startedAt }
  try {
    const rawDir = typeof cwd === 'string' ? cwd.trim() : ''
    if (!rawDir) return { available: false, reason: 'no_cwd' }
    const dir = await realDirectory(rawDir)
    if (!dir) return { available: false, reason: 'missing' }
    return await collectSummaryAvailable(dir, context)
  } catch (error) {
    if (error instanceof GitTimeout) return { available: false, reason: 'timeout' }
    return { available: false, reason: 'error' }
  }
}

/**
 * 在 dir 内采集轻量摘要（约 6–9 条只读命令，全部并行分批）。
 * 主分支/泳道参照物语义与 v0.13 的 base 保持一致：
 * 当前分支 = 主分支且有 upstream → kind:"upstream"（相对 upstream 计数）；
 * 其余 → kind:"main"（相对主分支计数；无主分支或无比较对象时 ahead/behind 为 0）。
 */
async function collectSummaryAvailable(dir, context) {
  // 1) 仓库身份 / 工作树判定：不在 git 工作树内一律 not_git（裸仓库 show-toplevel 会失败）
  const [identity, toplevel, listed] = await Promise.all([
    repoIdentity(dir, context),
    runGit(dir, ['rev-parse', '--show-toplevel'], context),
    runGit(dir, ['worktree', 'list', '--porcelain'], context),
  ])
  if (!identity || !toplevel.ok) return { available: false, reason: 'not_git' }
  if (!listed.ok) return { available: false, reason: 'error' }
  const entries = await resolveWorktrees(parseWorktreeList(listed.stdout))
  if (!entries.length) return { available: false, reason: 'error' }
  const currentIndex = findCurrentWorktree(entries, dir)
  const currentEntry = currentIndex >= 0 ? entries[currentIndex] : null
  const isWorktree = currentEntry ? currentIndex !== 0 : !identity.isMainWorktree
  const worktreePath = currentEntry ? currentEntry.path : entries[0].path

  // 2) HEAD / 当前分支 / 主分支 / upstream：彼此独立，并行执行
  //    rev-parse --abbrev-ref HEAD 在 detached 时输出 HEAD、空仓库时失败（→ no_commits）
  const [headRef, mainInfo, upstreamName] = await Promise.all([
    runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], context),
    detectMainBranch(dir, context),
    runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], context),
  ])
  if (!headRef.ok) return { available: false, reason: 'no_commits' }
  const headBranch = headRef.stdout.trim()
  const detached = headBranch === '' || headBranch === 'HEAD'
  const branch = detached ? null : headBranch
  const upstreamRef = upstreamName.ok ? upstreamName.stdout.trim() : ''
  const mainBranch = mainInfo ? mainInfo.name : null

  // 3) 泳道参照物（与 v0.13 base 同一规则）：主线卡片相对 upstream，其余相对主分支
  const onMain = branch !== null && mainInfo !== null && branch === mainInfo.name
  const kind = onMain && upstreamRef ? 'upstream' : 'main'
  const compareRef = kind === 'upstream' ? upstreamRef : mainInfo ? mainInfo.full : null
  const [baseCounts, upstreamCounts] = await Promise.all([
    // kind=upstream 时 base 与 upstream 是同一比较对象，下面直接复用 upstream 计数
    kind === 'upstream' || !compareRef ? null : countRange(dir, compareRef, 'HEAD', context),
    upstreamRef ? countRange(dir, upstreamRef, 'HEAD', context) : null,
  ])

  const aheadUpstream = upstreamRef ? (upstreamCounts ? upstreamCounts.right : 0) : null
  const behindUpstream = upstreamRef ? (upstreamCounts ? upstreamCounts.left : 0) : null
  const base = { kind, ahead: 0, behind: 0 }
  if (kind === 'upstream') {
    base.ahead = aheadUpstream ?? 0
    base.behind = behindUpstream ?? 0
  } else if (baseCounts) {
    base.ahead = baseCounts.right
    base.behind = baseCounts.left
  }

  return {
    available: true,
    dir,
    branch,
    detached,
    mainBranch,
    base,
    upstream: upstreamRef ? { ref: upstreamRef, ahead: aheadUpstream, behind: behindUpstream } : null,
    isWorktree,
    worktreePath,
  }
}

// ---------------- 工作区地图（契约 02-http-api §12 / 06 §4.7，v0.16） ----------------

/** 每仓库最多返回的工作副本数（契约 §12：多余丢弃，不报错）。 */
const WORKSPACE_WORKTREES_MAX = 12
/** 空仓库 unborn HEAD 的 sha 是全 0：展示为 null（该工作副本还没有提交）。 */
const ZERO_SHA = /^0{40}$/
/**
 * 工作副本分支信息（Phase A）：短名 / upstream 短名 / upstream ahead·behind 摘要 / 分支 tip 提交时间（ISO）。
 * 一次 for-each-ref 拿全仓库分支，避免每个工作副本多跑 2 条 rev-parse。
 */
const WORKSPACE_BRANCH_FORMAT = [
  '%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:iso-strict)',
].join(FIELD_SEP)

/** 解析 for-each-ref refs/heads：分支名 → { upstream: {ref,ahead,behind}|null, lastCommitAt }。 */
function parseWorkspaceBranches(text) {
  const branches = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    const parts = line.split(FIELD_SEP)
    if (parts.length < 4) continue
    const [name, upstreamShort, trackText, committedAt] = parts
    if (!name) continue
    // upstream:short 存在但 ahead/behind 解析不出（[gone] / 未知格式）→ 视为「无可用远端」
    let upstream = null
    if (upstreamShort) {
      const counts = parseUpstreamCounts(upstreamShort, trackText)
      if (counts.ahead !== null || counts.behind !== null) {
        upstream = { ref: upstreamShort, ahead: counts.ahead ?? 0, behind: counts.behind ?? 0 }
      }
    }
    branches.set(name, { upstream, lastCommitAt: committedAt || null })
  }
  return branches
}

/**
 * 判断目录是否在 git 工作树内，并取所属仓库的 commonDir（realpath）。
 * 一条命令同时拿 is-inside-work-tree / git-dir / git-common-dir；裸仓库与 .git 目录内返回 null。
 */
async function worktreeRepoIdentity(dir, context) {
  const result = await runGit(dir, ['rev-parse', '--is-inside-work-tree', '--git-dir', '--git-common-dir'], context)
  if (!result.ok) return null
  const lines = result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length < 3 || lines[0] !== 'true') return null
  const commonDir = await realOrNull(resolve(dir, lines[2]))
  return commonDir ? { commonDir } : null
}

/**
 * 把本次请求的目录原文映射到「它所属的工作副本」：前端按 dir→worktree 精确归组，
 * 避免卡片 cwd 是 /tmp/... 而 git 返回 realpath /private/tmp/... 时前缀匹配失败。
 * @param {object} repo collectWorkspaceRepo 的结果（不含 dirs，供缓存复用）
 * @param {{dir: string, realDir: string}[]} entries 本次请求的真实目录
 */
function attachWorkspaceDirs(repo, entries) {
  return {
    ...repo,
    worktrees: repo.worktrees.map(row => ({
      ...row,
      dirs: entries.filter(item => isInside(item.realDir, row.path)).map(item => item.dir),
    })),
  }
}

/** 超过 12 个时优先保留主工作副本与请求目录所在的工作副本，其余按 worktree list 原顺序补齐。 */
function prioritizeWorkspaceWorktrees(entries, currentIndexes) {
  if (entries.length <= WORKSPACE_WORKTREES_MAX) return entries.map((entry, index) => ({ entry, index }))
  const keep = new Set([0])
  for (const index of [...currentIndexes].sort((a, b) => a - b)) {
    if (keep.size >= WORKSPACE_WORKTREES_MAX) break
    keep.add(index)
  }
  for (let index = 1; keep.size < WORKSPACE_WORKTREES_MAX && index < entries.length; index += 1) keep.add(index)
  return entries.map((entry, index) => ({ entry, index })).filter(item => keep.has(item.index))
}

/**
 * 单个仓库的工作区地图：工作副本列表 + 每个副本相对主分支的 ahead/behind + dirty。
 * ahead/behind 相对 §4.1 探测出的主分支；主分支探测不到时全部为 null。
 */
async function collectWorkspaceRepo({ commonDir, entries }) {
  const context = { startedAt: Date.now() }
  const repDir = entries[0].realDir
  const [listed, mainInfo, branchRefs] = await Promise.all([
    runGit(repDir, ['worktree', 'list', '--porcelain'], context),
    detectMainBranch(repDir, context),
    runGit(repDir, ['for-each-ref', `--format=${WORKSPACE_BRANCH_FORMAT}`, 'refs/heads'], context),
  ])
  if (!listed.ok) throw new Error('读取工作树列表失败')
  const worktrees = await resolveWorktrees(parseWorktreeList(listed.stdout))
  if (!worktrees.length) throw new Error('工作树列表为空')
  const branches = parseWorkspaceBranches(branchRefs.ok ? branchRefs.stdout : '')

  // 请求目录落在哪些工作副本里（最长前缀）→ isCurrent
  const currentIndexes = new Set()
  for (const item of entries) {
    const index = findCurrentWorktree(worktrees, item.realDir)
    if (index >= 0) currentIndexes.add(index)
  }
  const selection = prioritizeWorkspaceWorktrees(worktrees, currentIndexes)
  const mainName = mainInfo ? mainInfo.name : null
  const mainRef = mainInfo ? mainInfo.full : null

  // 每个要返回的工作副本：相对主分支的计数 + 全量 status 计数 + upstream/最后提交时间（并行；只采要返回的副本）
  const details = await Promise.all(selection.map(async ({ entry }) => {
    let counts = null
    if (entry.branch && mainRef) {
      counts = entry.branch === mainName
        ? { left: 0, right: 0 } // 主工作副本自身 0/0，省一条命令
        : await countRange(repDir, mainRef, `refs/heads/${entry.branch}`, context)
    }
    // 一次 status 全量输出：`??` 行 = 未跟踪，其余非空行 = 已跟踪改动
    const status = await runGit(repDir, ['-C', entry.path, 'status', '--porcelain'], context)
    const statusLines = status.ok ? status.stdout.split('\n').filter(line => line.length > 0) : []
    const untrackedCount = statusLines.filter(line => line.startsWith('??')).length
    const modifiedCount = statusLines.length - untrackedCount
    const branchInfo = entry.branch ? branches.get(entry.branch) : null
    let lastCommitAt = branchInfo?.lastCommitAt ?? null
    // 分支信息缺失（或 detached HEAD）时回退到该工作副本 HEAD 的提交时间
    if (!lastCommitAt && entry.sha && !ZERO_SHA.test(entry.sha)) {
      const headLog = await runGit(repDir, ['-C', entry.path, 'log', '-1', '--format=%cI'], context)
      lastCommitAt = headLog.ok ? headLog.stdout.trim() || null : null
    }
    return {
      ahead: counts ? counts.right : null,
      behind: counts ? counts.left : null,
      modifiedCount,
      untrackedCount,
      dirty: modifiedCount > 0,
      lastCommitAt,
      prunable: entry.prunable === true || entry.exists === false,
      upstream: branchInfo?.upstream ?? null,
    }
  }))

  const rows = selection.map(({ entry, index }, position) => {
    const detail = details[position]
    const sha = entry.sha && !ZERO_SHA.test(entry.sha) ? entry.sha : null
    return {
      path: entry.path,
      branch: entry.branch,
      detached: entry.detached || !entry.branch,
      sha,
      shortSha: sha ? shortShaOf(sha) : null,
      isMain: index === 0,
      isCurrent: currentIndexes.has(index),
      aheadOfBase: detail.ahead,
      behindOfBase: detail.behind,
      dirty: detail.dirty,
      mergedIntoBase: detail.ahead === null ? null : detail.ahead === 0,
      upstream: detail.upstream,
      modifiedCount: detail.modifiedCount,
      untrackedCount: detail.untrackedCount,
      locked: entry.locked === true,
      prunable: detail.prunable,
      lastCommitAt: detail.lastCommitAt,
    }
  })

  const root = worktrees[0].path
  // 总工作副本数不受 12 上限影响；截断数按本次实际返回的行数计算（缓存对象里保存总数）
  return {
    root,
    name: basename(root),
    commonDir,
    mainBranch: mainName,
    worktreeCount: worktrees.length,
    truncatedWorktrees: Math.max(0, worktrees.length - rows.length),
    worktrees: rows,
  }
}

/**
 * 采集工作区地图（卡片 cwd 列表 → 按仓库聚合的工作副本）。
 * 按 git-common-dir（realpath）去重仓库；失败目录进 unavailable（missing/not_git/timeout/error）。
 * cache 可选：{ get(repoKey), set(repoKey, repo) }，由路由层提供 8s/64 条的服务端缓存。
 * @returns {Promise<{ repos: object[], unavailable: { dir: string, reason: string }[] }>}
 */
export async function collectGitWorkspaces(dirs, { cache } = {}) {
  const requested = []
  const seen = new Set()
  for (const raw of Array.isArray(dirs) ? dirs : []) {
    const dir = typeof raw === 'string' ? raw.trim() : ''
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    requested.push(dir)
  }

  // 1) 每个目录：realpath + 仓库身份（1 条命令），并行；失败逐项收敛
  const unavailable = []
  const resolved = await Promise.all(requested.map(async dir => {
    try {
      const realDir = await realDirectory(dir)
      if (!realDir) return { dir, reason: 'missing' }
      const identity = await worktreeRepoIdentity(realDir, { startedAt: Date.now() })
      if (!identity) return { dir, reason: 'not_git' }
      return { dir, realDir, commonDir: identity.commonDir }
    } catch (error) {
      return { dir, reason: error instanceof GitTimeout ? 'timeout' : 'error' }
    }
  }))

  // 2) 按 commonDir 分组（组顺序 = 目录首次出现顺序）
  const groups = new Map()
  for (const item of resolved) {
    if (item.reason) { unavailable.push({ dir: item.dir, reason: item.reason }); continue }
    let group = groups.get(item.commonDir)
    if (!group) { group = { commonDir: item.commonDir, entries: [] }; groups.set(item.commonDir, group) }
    group.entries.push(item)
  }

  // 3) 每仓库采集一次（命中缓存则跳过重命令）；仓库级失败 → 该仓库所有目录 unavailable
  const repos = []
  for (const group of groups.values()) {
    const cached = cache?.get?.(group.commonDir)
    if (cached) { repos.push(attachWorkspaceDirs(cached, group.entries)); continue }
    try {
      const repo = await collectWorkspaceRepo(group)
      cache?.set?.(group.commonDir, repo)
      repos.push(attachWorkspaceDirs(repo, group.entries))
    } catch (error) {
      const reason = error instanceof GitTimeout ? 'timeout' : 'error'
      for (const item of group.entries) unavailable.push({ dir: item.dir, reason })
    }
  }
  return { repos, unavailable }
}

// ---------------- 失效工作副本记录清理（Phase C，契约 02-http-api §15，v0.20） ----------------

/**
 * 在仓库里执行 `git worktree prune`：只清理「目录已被手动删除、git 还记着」的失效记录，
 * 不删除任何现存工作副本目录或分支。调用方负责校验 repoRoot 来自看板卡片 cwd。
 * @returns {Promise<{ repoRoot: string, removed: boolean }>} removed = 是否有失效记录被清掉
 */
export async function pruneWorktreeRecords(repoRoot) {
  const context = { startedAt: Date.now() }
  const before = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], context)
  const beforeEntries = before.ok ? parseWorktreeList(before.stdout) : []
  const pruned = await runGit(repoRoot, ['worktree', 'prune'], context)
  if (!pruned.ok) {
    const failed = new Error(`git worktree prune 失败：${pruned.stderr.trim() || pruned.stdout.trim()}`)
    failed.code = 'PRUNE_FAILED'
    throw failed
  }
  const after = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], context)
  const afterEntries = after.ok ? parseWorktreeList(after.stdout) : beforeEntries
  const removed = beforeEntries.some(entry => entry.prunable === true) || afterEntries.length < beforeEntries.length
  return { repoRoot, removed }
}

// ---------------- 工作副本清理（Phase B，契约 02-http-api §13 / 06 §4.8，v0.17） ----------------

/** 回收站保留天数（契约 §13：默认 7 天，可补救）。 */
export const TRASH_RETENTION_DAYS = 7

/** 路径 child 是否在 root 之下（「卡片 cwd 落在该工作副本内」判定；调用方负责先 realpath）。 */
export function isPathInside(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string' || !child || !root) return false
  return isInside(child, root)
}

async function pathExists(value) {
  try { await stat(value); return true } catch { return false }
}

/** 回收站目录名时间戳：本地时间 yyyyMMdd-HHmmss（契约 §13 的 `<时间戳>-<仓库名>-<工作副本名>`）。 */
function trashTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 本地时间的 ISO 8601（带时区偏移，如 2026-10-28T20:54:58+08:00）；manifest.trashedAt / 列表展示用。 */
function isoLocalTimestamp(date = new Date()) {
  const pad = value => String(Math.abs(value)).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}

/** 把名字里不适合做目录名的字符替换掉（保留中文/空格，避免路径分隔符）。 */
function safeTrashName(value) {
  return String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'worktree'
}

/** 解析回收站目录名前缀的本地时间戳；命名不规范返回 null（保留不动）。 */
function parseTrashTimestamp(name) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(name)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const time = new Date(year, month - 1, day, hour, minute, second).getTime()
  return Number.isFinite(time) ? time : null
}

/** 尽力清理回收站里超过保留期的条目（按目录名时间戳判断），返回删除数量。 */
export async function cleanupTrash(trashDir, retentionDays = TRASH_RETENTION_DAYS, now = Date.now()) {
  let names
  try { names = await readdir(trashDir) } catch { return 0 }
  const cutoff = now - retentionDays * 86_400_000
  let removed = 0
  for (const name of names) {
    const time = parseTrashTimestamp(name)
    if (time === null || time >= cutoff) continue
    try {
      await rm(join(trashDir, name), { recursive: true, force: true })
      removed += 1
    } catch {}
  }
  return removed
}

/**
 * 软删除一个工作副本（调用方负责全部安全校验）：目录 rename 到回收站 → 写 manifest.json →
 * `git worktree prune` → 可选删本地分支（已并入主线用 `-d`，未合并但已确认用 `-D`）→ 尽力清理过期回收站条目。
 * manifest 供 v0.18 的回收站恢复使用：{ version, trashedAt, repoRoot, worktreePath, branch, sha, branchDeleted }。
 * 失败抛出的 Error 带 code：NOT_FOUND / TRASH_MOVE_FAILED / WORKTREE_MANIFEST_FAILED /
 * WORKTREE_PRUNE_FAILED / BRANCH_DELETE_FAILED。
 * @returns {Promise<{ trashedTo: string, branchName: string|null, branchDeleted: boolean, trashRetentionDays: number }>}
 */
export async function cleanupWorktree({
  repoRoot, worktreePath, trashDir, branchName = null, sha = null, mergedIntoBase = null,
  deleteBranch = false, locked = false, retentionDays = TRASH_RETENTION_DAYS,
}) {
  const context = { startedAt: Date.now() }
  await mkdir(trashDir, { recursive: true })

  // 0) locked 的工作副本 prune 不会清理其元数据：移走前先解锁（目录都要进回收站了，锁不再有意义）
  if (locked) await runGit(repoRoot, ['worktree', 'unlock', worktreePath], context)

  // 1) 目录移入回收站（rename；跨磁盘 EXDEV 等失败不强删）
  const baseName = `${trashTimestamp()}-${safeTrashName(basename(repoRoot))}-${safeTrashName(basename(worktreePath))}`
  let trashedTo = join(trashDir, baseName)
  let suffix = 1
  while (await pathExists(trashedTo)) {
    suffix += 1
    trashedTo = join(trashDir, `${baseName}-${suffix}`)
  }
  try {
    await rename(worktreePath, trashedTo)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const missing = new Error('工作副本目录已不存在')
      missing.code = 'NOT_FOUND'
      throw missing
    }
    const failed = new Error(`移动工作副本到回收站失败：${error?.message || error}`)
    failed.code = 'TRASH_MOVE_FAILED'
    throw failed
  }

  // 2) 清理 git 元数据（目录已移走 → prune 移除该 worktree 记录），并确认记录真的消失
  const prune = await runGit(repoRoot, ['worktree', 'prune'], context)
  if (!prune.ok) {
    const failed = new Error(`git worktree prune 失败：${prune.stderr.trim() || prune.stdout.trim()}`)
    failed.code = 'WORKTREE_PRUNE_FAILED'
    throw failed
  }
  const listed = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], context)
  if (listed.ok) {
    const stillThere = parseWorktreeList(listed.stdout)
      .some(entry => entry.path === worktreePath || resolve(entry.path) === worktreePath)
    if (stillThere) {
      const failed = new Error('git worktree prune 后工作副本记录仍然存在')
      failed.code = 'WORKTREE_PRUNE_FAILED'
      throw failed
    }
  }

  // 3) 可选删分支：已并入主线用 -d（安全），未合并但用户确认过损失用 -D
  let branchDeleted = false
  if (deleteBranch && branchName) {
    const removed = await runGit(repoRoot, ['branch', mergedIntoBase === true ? '-d' : '-D', branchName], context)
    if (!removed.ok) {
      const failed = new Error(`删除分支 ${branchName} 失败：${removed.stderr.trim() || removed.stdout.trim()}`)
      failed.code = 'BRANCH_DELETE_FAILED'
      throw failed
    }
    branchDeleted = true
  }

  // 4) 写 manifest.json（回收站列表/恢复依据；sha = 清理前工作副本 HEAD）
  const manifest = {
    version: 1,
    trashedAt: isoLocalTimestamp(),
    repoRoot,
    worktreePath,
    branch: branchName ?? null,
    sha: sha ?? null,
    branchDeleted,
  }
  try {
    await writeFile(join(trashedTo, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch (error) {
    const failed = new Error(`写入回收站 manifest.json 失败：${error?.message || error}`)
    failed.code = 'WORKTREE_MANIFEST_FAILED'
    throw failed
  }

  // 5) 顺手清理过期回收站条目（尽力而为，不影响本次结果）
  await cleanupTrash(trashDir, retentionDays).catch(() => 0)
  return { trashedTo, branchName: branchName ?? null, branchDeleted, trashRetentionDays: retentionDays }
}

// ---------------- 回收站（v0.18，契约 02-http-api §14） ----------------

/** manifest 结构校验：路径必须是绝对路径，branch/sha 可为 null。 */
function isValidTrashManifest(value) {
  if (!value || typeof value !== 'object') return false
  if (value.version !== 1) return false
  if (typeof value.repoRoot !== 'string' || !isAbsolute(value.repoRoot)) return false
  if (typeof value.worktreePath !== 'string' || !isAbsolute(value.worktreePath)) return false
  if (value.branch !== null && typeof value.branch !== 'string') return false
  if (value.sha !== null && typeof value.sha !== 'string') return false
  if (typeof value.branchDeleted !== 'boolean') return false
  return true
}

/** 读取条目 manifest；不存在 / 解析失败 / 结构不合法返回 null。 */
async function readTrashManifest(entryDir) {
  try {
    const manifest = JSON.parse(await readFile(join(entryDir, 'manifest.json'), 'utf8'))
    return isValidTrashManifest(manifest) ? manifest : null
  } catch { return null }
}

/** 旧条目（无 manifest）从目录名 `YYYYMMDD-HHMMSS-<repo>-<worktree>` 尽量兜底展示字段。 */
function parseTrashFallbackName(id) {
  const time = parseTrashTimestamp(id)
  const trashedAt = time === null ? null : isoLocalTimestamp(new Date(time))
  const match = /^\d{8}-\d{6}-(.+)$/.exec(id)
  if (!match) return { repoName: null, worktreeName: null, trashedAt }
  const rest = match[1]
  const dash = rest.indexOf('-')
  return dash < 0
    ? { repoName: rest, worktreeName: null, trashedAt }
    : { repoName: rest.slice(0, dash), worktreeName: rest.slice(dash + 1), trashedAt }
}

/** 列出回收站根下所有「直接子目录」条目（按 trashedAt 倒序）；读不到目录返回空列表。 */
export async function listTrashEntries(trashDir) {
  let dirents
  try { dirents = await readdir(trashDir, { withFileTypes: true }) } catch { return [] }
  const rows = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const id = dirent.name
    const manifest = await readTrashManifest(join(trashDir, id))
    if (manifest) {
      rows.push({
        id,
        repoRoot: manifest.repoRoot,
        worktreePath: manifest.worktreePath,
        repoName: basename(manifest.repoRoot),
        worktreeName: basename(manifest.worktreePath),
        branch: manifest.branch,
        sha: manifest.sha,
        trashedAt: typeof manifest.trashedAt === 'string' ? manifest.trashedAt : null,
        branchDeleted: manifest.branchDeleted,
        restorable: true,
        sortAt: Date.parse(manifest.trashedAt) || parseTrashTimestamp(id) || 0,
      })
      continue
    }
    const fallback = parseTrashFallbackName(id)
    rows.push({
      id,
      repoRoot: null,
      worktreePath: null,
      repoName: fallback.repoName,
      worktreeName: fallback.worktreeName,
      branch: null,
      sha: null,
      trashedAt: fallback.trashedAt,
      branchDeleted: false,
      restorable: false,
      sortAt: (fallback.trashedAt ? Date.parse(fallback.trashedAt) : NaN) || parseTrashTimestamp(id) || 0,
    })
  }
  rows.sort((a, b) => b.sortAt - a.sortAt)
  return rows.map(({ sortAt, ...row }) => row)
}

/** 校验并解析 id → trash 根下的直接子目录绝对路径（拒绝分隔符 / .. / 越界）。 */
function resolveTrashEntryDir(trashDir, id) {
  const invalid = message => {
    const error = new Error(message)
    error.code = 'BAD_REQUEST'
    return error
  }
  const normalized = typeof id === 'string' ? id.trim() : ''
  if (!normalized || normalized === '.' || normalized === '..') throw invalid('回收站条目 ID 不合法')
  if (normalized.includes('/') || normalized.includes('\\') || normalized.includes('\u0000')) {
    throw invalid('回收站条目 ID 不能包含路径分隔符')
  }
  const root = resolve(trashDir)
  const entryDir = resolve(root, normalized)
  if (dirname(entryDir) !== root) throw invalid('只允许操作回收站根下的直接子目录')
  return entryDir
}

/**
 * 恢复一个回收站条目（manifest 为唯一路径依据）：
 * 分支还在 → `git worktree add <原路径> <分支>`；分支已删 → `git worktree add -b <分支> <原路径> <sha>`
 * （detached 清理的条目用 `--detach <sha>`），再把回收站里的工作区文件覆盖回去（排除 manifest.json / .git），
 * 最后删除回收站条目。失败抛出的 Error 带 code：BAD_REQUEST / NOT_FOUND / RESTORE_PATH_EXISTS /
 * RESTORE_SHA_MISSING / RESTORE_FAILED。
 */
export async function restoreTrashEntry({ trashDir, id }) {
  const entryDir = resolveTrashEntryDir(trashDir, id)
  const manifest = await readTrashManifest(entryDir)
  if (!manifest) {
    const error = new Error('回收站条目不存在或不可恢复（缺少 manifest）')
    error.code = 'NOT_FOUND'
    throw error
  }
  const context = { startedAt: Date.now() }

  // 原仓库必须仍然是 git 仓库（manifest.repoRoot 为准，不信任客户端其它路径）
  const repoCheck = await runGit(manifest.repoRoot, ['rev-parse', '--git-dir'], context)
  if (!repoCheck.ok) {
    const error = new Error('原仓库不存在或已不是 git 仓库，无法恢复')
    error.code = 'RESTORE_FAILED'
    throw error
  }
  if (await pathExists(manifest.worktreePath)) {
    const error = new Error('原路径已存在，无法恢复')
    error.code = 'RESTORE_PATH_EXISTS'
    throw error
  }

  const branch = typeof manifest.branch === 'string' && manifest.branch ? manifest.branch : null
  const sha = typeof manifest.sha === 'string' && manifest.sha ? manifest.sha : null
  let branchRestored = false
  let addArgs
  const branchExists = branch
    ? (await runGit(manifest.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], context)).ok
    : false
  if (branch && branchExists) {
    addArgs = ['worktree', 'add', manifest.worktreePath, branch]
  } else {
    if (!sha) {
      const error = new Error('缺少可恢复的提交（sha），无法恢复')
      error.code = 'RESTORE_SHA_MISSING'
      throw error
    }
    const shaExists = (await runGit(manifest.repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], context)).ok
    if (!shaExists) {
      const error = new Error('原提交已不存在（可能已被 gc），无法恢复')
      error.code = 'RESTORE_SHA_MISSING'
      throw error
    }
    if (branch) {
      addArgs = ['worktree', 'add', '-b', branch, manifest.worktreePath, sha]
      branchRestored = true
    } else {
      addArgs = ['worktree', 'add', '--detach', manifest.worktreePath, sha]
    }
  }

  // 原路径的父目录可能已经不在了（清理只移走叶子目录）：先尽力补上
  await mkdir(dirname(manifest.worktreePath), { recursive: true }).catch(() => {})
  const added = await runGit(manifest.repoRoot, addArgs, context)
  if (!added.ok) {
    const error = new Error(`git worktree add 失败：${added.stderr.trim() || added.stdout.trim()}`)
    error.code = 'RESTORE_FAILED'
    throw error
  }

  // 把回收站里的工作区内容覆盖回原路径（保留未保存改动 / 未跟踪文件）；
  // 排除 manifest.json 与 .git（新工作副本有 git 自己写的正确 .git 文件）
  try {
    for (const name of await readdir(entryDir)) {
      if (name === 'manifest.json' || name === '.git') continue
      await cp(join(entryDir, name), join(manifest.worktreePath, name), { recursive: true, force: true })
    }
  } catch (error) {
    const failed = new Error(`恢复工作区文件失败：${error?.message || error}`)
    failed.code = 'RESTORE_FAILED'
    throw failed
  }
  try { await rm(entryDir, { recursive: true, force: true }) } catch {}

  return {
    id,
    repoRoot: manifest.repoRoot,
    worktreePath: manifest.worktreePath,
    restoredTo: manifest.worktreePath,
    branch,
    branchRestored,
  }
}

/** 彻底删除一个回收站条目（只允许 trash 根下的直接子目录，且必须带 manifest.json）。 */
export async function purgeTrashEntry({ trashDir, id }) {
  const entryDir = resolveTrashEntryDir(trashDir, id)
  let info
  try { info = await stat(entryDir) } catch {
    const error = new Error('回收站条目不存在')
    error.code = 'NOT_FOUND'
    throw error
  }
  if (!info.isDirectory() || !(await pathExists(join(entryDir, 'manifest.json')))) {
    const error = new Error('回收站条目不存在或缺少 manifest，无法彻底删除')
    error.code = 'NOT_FOUND'
    throw error
  }
  try {
    await rm(entryDir, { recursive: true, force: true })
  } catch (error) {
    const failed = new Error(`彻底删除回收站条目失败：${error?.message || error}`)
    failed.code = 'TRASH_DELETE_FAILED'
    throw failed
  }
  return { id }
}

// ---------------- 采集主流程 ----------------

function addRef(refs, name, sha, kind) {
  if (!name || !sha) return
  if (refs.some(ref => ref.name === name)) return
  refs.push({ name, sha, shortSha: shortShaOf(sha), kind })
}

/**
 * 在 dir 内采集完整上下文。失败时返回 { available:false, reason, message }，
 * 由 collectGitContext 统一补齐 requestedDir/fetchedAt/durationMs。
 */
async function collectAvailable(dir, context) {
  // 1) 仓库身份 + 顶层目录 + 工作树列表：彼此独立，并行探测；不在 git 工作树内一律 not_git
  const [identity, toplevel, listed] = await Promise.all([
    repoIdentity(dir, context),
    runGit(dir, ['rev-parse', '--show-toplevel'], context),
    runGit(dir, ['worktree', 'list', '--porcelain'], context),
  ])
  if (!identity) return { available: false, reason: 'not_git', message: null }
  if (!toplevel.ok) return { available: false, reason: 'not_git', message: null }
  const toplevelDir = (await realOrNull(toplevel.stdout.trim())) ?? dir

  // 2) 工作树列表（主工作树恒为第一项）
  if (!listed.ok) return { available: false, reason: 'error', message: listed.stderr.trim() || '读取工作树列表失败' }
  const entries = await resolveWorktrees(parseWorktreeList(listed.stdout))
  if (!entries.length) return { available: false, reason: 'error', message: '工作树列表为空' }
  const currentIndex = findCurrentWorktree(entries, dir)
  const currentEntry = currentIndex >= 0 ? entries[currentIndex] : null

  // graph 的引用列表与后续 HEAD/主分支探测无关，提前发起以并行；失败（含超时）只让 graph 缺失
  const graphRefsResult = runGit(
    dir, ['for-each-ref', `--format=${GRAPH_REF_FORMAT}`, 'refs/heads', 'refs/remotes/origin'], context,
  ).catch(() => null)

  // 3) HEAD / 当前分支 / 主分支 / upstream 都是独立的只读查询，并行执行
  const [headRev, headRef, headLog, mainInfo, upstreamInfo] = await Promise.all([
    runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], context),
    runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], context),
    runGit(dir, ['log', '-1', `--format=${COMMIT_FORMAT}`, 'HEAD'], context),
    detectMainBranch(dir, context),
    detectUpstream(dir, context),
  ])
  // 空仓库（unborn HEAD）单独归为 no_commits
  if (!headRev.ok) return { available: false, reason: 'no_commits', message: null }
  const headSha = headRev.stdout.trim()
  const headCommit = headLog.ok ? parseCommitLog(headLog.stdout)[0] : null
  if (!headCommit) return { available: false, reason: 'error', message: headLog.stderr.trim() || '读取 HEAD 提交失败' }

  // detached HEAD 时 symbolic-ref 失败 → branch=null
  const branch = headRef.ok ? headRef.stdout.trim() || null : null

  // 4) 主分支在 origin 上的同名引用 → 泳道 0 参照物
  const remoteRef = mainInfo ? await detectRemoteRef(dir, mainInfo.name, context) : null
  const { base, compare } = buildBase({ mainInfo, upstream: upstreamInfo, remoteRef, branch })

  // 5) base 的完整计数与 merge-base：计数来自 rev-list，不受提交列表上限影响；
  //    与远端/upstream 计数彼此独立，并行执行
  const upstream = upstreamInfo
    ? { ref: upstreamInfo.ref, remote: upstreamInfo.remote, branch: upstreamInfo.branch, ahead: 0, behind: 0 }
    : null
  if (base && compare) {
    const [counts, mergeBase] = await Promise.all([
      countRange(dir, compare.full, 'HEAD', context),
      runGit(dir, ['merge-base', compare.full, 'HEAD'], context),
    ])
    if (counts) { base.ahead = counts.right; base.behind = counts.left }
    const mergeSha = mergeBase.ok ? mergeBase.stdout.trim() : ''
    if (mergeSha) base.mergeBase = shaPair(mergeSha)
  }
  // remoteAhead/remoteBehind：base.branch 相对 origin/<mainBranch> 的右/左计数
  const [remoteCounts, upstreamCounts] = await Promise.all([
    base && remoteRef && mainInfo ? countRange(dir, remoteRef.full, mainInfo.full, context) : null,
    upstreamInfo ? countRange(dir, upstreamInfo.full, 'HEAD', context) : null,
  ])
  if (remoteCounts) { base.remoteAhead = remoteCounts.right; base.remoteBehind = remoteCounts.left }
  if (upstreamCounts) { upstream.ahead = upstreamCounts.right; upstream.behind = upstreamCounts.left }
  // 6) 泳道提交列表（新 → 旧，超上限只截断列表不截断计数）
  const commits = { ahead: [], behind: [], shared: [] }
  if (compare) {
    const mergeBaseSha = base?.mergeBase?.sha
    const [aheadLog, behindLog, sharedLog] = await Promise.all([
      readCommitLog(dir, `${compare.full}..HEAD`, GIT_LIMITS.ahead, context),
      readCommitLog(dir, `HEAD..${compare.full}`, GIT_LIMITS.behind, context),
      mergeBaseSha ? readCommitLog(dir, mergeBaseSha, GIT_LIMITS.shared, context) : [],
    ])
    commits.ahead = aheadLog
    commits.behind = behindLog
    commits.shared = sharedLog
  } else {
    // 单泳道：从 HEAD 起最近 shared 条
    commits.shared = await readCommitLog(dir, 'HEAD', GIT_LIMITS.shared, context)
  }

  // 7) 工作树（上限 8，主工作树/当前工作树优先保留；相对 base 参照物计算领先/落后）
  const selection = prioritizeWorktrees(entries, currentIndex)
  const worktreeCompare = compare ?? (mainInfo ? { full: mainInfo.full, short: mainInfo.name } : null)
  const worktrees = await Promise.all(selection.selected.map(async ({ entry, index }) => {
    const worktreeBranch = entry.branch
    let aheadOfBase = null
    let behindOfBase = null
    if (worktreeBranch && worktreeCompare) {
      if (compare && worktreeBranch === branch) {
        // 当前工作树已经在 base 里算过，直接复用完整计数
        aheadOfBase = base.ahead
        behindOfBase = base.behind
      } else if (!compare && mainInfo && worktreeBranch === mainInfo.name) {
        aheadOfBase = 0
        behindOfBase = 0
      } else {
        const counts = await countRange(dir, worktreeCompare.full, `refs/heads/${worktreeBranch}`, context)
        if (counts) { aheadOfBase = counts.right; behindOfBase = counts.left }
      }
    }
    return {
      path: entry.path,
      branch: worktreeBranch,
      detached: entry.detached || !worktreeBranch,
      sha: entry.sha,
      shortSha: entry.sha ? shortShaOf(entry.sha) : null,
      isMain: index === 0,
      isCurrent: index === currentIndex,
      aheadOfBase,
      behindOfBase,
    }
  }))

  // 8) refs 标记（按存在性追加；同名去重，同 sha 的不同 kind 交给前端合并）
  const refs = []
  addRef(refs, 'HEAD', headSha, 'head')
  if (branch) addRef(refs, branch, headSha, 'branch')
  if (base && mainInfo) {
    if (base.remoteRef && remoteRef) addRef(refs, base.remoteRef, remoteRef.sha, 'base')
    else addRef(refs, mainInfo.name, mainInfo.sha, 'base')
  }
  if (upstreamInfo) addRef(refs, upstreamInfo.ref, upstreamInfo.sha, 'upstream')

  // 9) v0.14 Fork 风格多分支提交图（契约 §4.5）：可选增强，失败时 graph 为 null
  const graph = await collectGraphContext({
    dir,
    context,
    refsResult: await graphRefsResult,
    headSha,
    branch,
    mainInfo,
    upstreamInfo,
    worktreeBranches: entries.map(entry => entry.branch).filter(Boolean),
  })

  const repoRoot = entries[0].path
  return {
    available: true,
    reason: null,
    message: null,
    repo: { name: basename(repoRoot), root: repoRoot, commonDir: identity.commonDir },
    current: {
      worktree: currentEntry ? currentEntry.path : toplevelDir,
      isWorktree: currentEntry ? currentIndex !== 0 : !identity.isMainWorktree,
      isMainWorktree: currentEntry ? currentIndex === 0 : identity.isMainWorktree,
      branch,
      detached: branch === null,
      sha: headSha,
      shortSha: shortShaOf(headSha),
      subject: headCommit.subject,
      authorName: headCommit.authorName,
      committedAt: headCommit.committedAt,
    },
    upstream,
    base,
    worktrees,
    worktreesTruncated: selection.truncated,
    graph,
    commits,
    refs,
    limits: { ...GIT_LIMITS },
  }
}

/** 补齐元信息：失败结构只有 available/reason/message + 这三个字段（契约 §3.1）。 */
function withMeta(value, requestedDir, startedAt) {
  return {
    ...value,
    requestedDir,
    fetchedAt: Date.now(),
    durationMs: Date.now() - startedAt,
  }
}

/**
 * 采集一张卡片的 git 上下文（只读，永不抛异常）。
 * @param {{ cwd?: string|null, requestedDir?: string|null }} input
 *   cwd = 卡片 cwd（基准目录）；requestedDir = 前端 ?cwd= 候选（可能被忽略）
 * @returns {Promise<object>} 契约 §3 的结构；不可用时 available:false + reason。
 */
export async function collectGitContext({ cwd, requestedDir } = {}) {
  const startedAt = Date.now()
  const requested = typeof requestedDir === 'string' && requestedDir.trim() ? requestedDir : null
  const context = { startedAt }
  const unavailable = (reason, message = null) => withMeta({ available: false, reason, message }, requested, startedAt)
  try {
    const rawCwd = typeof cwd === 'string' ? cwd.trim() : ''
    if (!rawCwd) return unavailable('no_cwd')
    const cardDir = await realDirectory(rawCwd)
    if (!cardDir) return unavailable('missing')
    const dir = await selectDirectory(cardDir, requested, context)
    const collected = await collectAvailable(dir, context)
    if (!collected.available) return unavailable(collected.reason, collected.message ?? null)
    return withMeta({ ...collected, dir }, requested, startedAt)
  } catch (error) {
    if (error instanceof GitTimeout) return unavailable('timeout', error.message)
    if (error instanceof GitBinaryMissing) return unavailable('error', error.message)
    return unavailable('error', error?.message || String(error))
  }
}
