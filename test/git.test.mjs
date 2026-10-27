// lib/git.js：只读 git 上下文采集。测试全部用 os.tmpdir() 下的真实临时仓库，
// 提交身份/时间固定（离线、可重复），覆盖契约 §7 要求的仓库形态与不可用原因。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { GIT_LIMITS, collectGitContext } from '../lib/git.js'
import { tempDir } from './helpers.mjs'

const execFileAsync = promisify(execFile)
/** 固定提交时间基线，保证列表顺序与 committedAt 断言可重复。 */
const BASE_EPOCH = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000)

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: '测试作者',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: '测试提交者',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  LC_ALL: 'C',
}

async function git(cwd, args, env = GIT_ENV) {
  const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

function commitEpoch(seq) {
  return BASE_EPOCH + seq
}

/** 发起一个空提交（不改文件），返回完整 sha；seq 决定固定的作者/提交时间。 */
async function commit(cwd, subject, seq) {
  const stamp = `@${commitEpoch(seq)} +0000`
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', subject], { cwd, env })
  return git(cwd, ['rev-parse', 'HEAD'])
}

async function initRepo(t, name = 'repo', { branch = 'main' } = {}) {
  const root = join(await tempDir(t, 'dsh-git-context-'), name)
  await mkdir(root, { recursive: true })
  await git(root, ['init', '-q', '-b', branch])
  return root
}

const subjectsOf = list => list.map(item => item.subject)

test('普通仓库：repo/current/base/commits/refs/limits 逐字段符合契约', async t => {
  const repo = await initRepo(t)
  const shaA = await commit(repo, 'A 初始提交', 1)
  const shaB = await commit(repo, 'B 第二个提交', 2)
  await git(repo, ['checkout', '-q', '-b', 'feat/x'])
  const shaC = await commit(repo, 'C 分支提交', 3)
  const shaD = await commit(repo, 'D 分支提交', 4)
  const realRepo = await realpath(repo)

  const ctx = await collectGitContext({ cwd: repo })
  assert.equal(ctx.available, true)
  assert.equal(ctx.reason, null)
  assert.equal(ctx.message, null)
  assert.equal(ctx.dir, realRepo)
  assert.equal(ctx.requestedDir, null)
  assert.ok(ctx.fetchedAt > 0)
  assert.ok(ctx.durationMs >= 0)

  assert.deepEqual(ctx.repo, {
    name: basename(realRepo),
    root: realRepo,
    commonDir: await realpath(join(repo, '.git')),
  })

  assert.equal(ctx.current.worktree, realRepo)
  assert.equal(ctx.current.isWorktree, false)
  assert.equal(ctx.current.isMainWorktree, true)
  assert.equal(ctx.current.branch, 'feat/x')
  assert.equal(ctx.current.detached, false)
  assert.equal(ctx.current.sha, shaD)
  assert.equal(ctx.current.shortSha, shaD.slice(0, 7))
  assert.equal(ctx.current.subject, 'D 分支提交')
  assert.equal(ctx.current.authorName, '测试作者')
  assert.equal(ctx.current.committedAt, (commitEpoch(4)) * 1000)

  assert.equal(ctx.upstream, null)

  assert.equal(ctx.base.kind, 'main')
  assert.equal(ctx.base.label, 'main')
  assert.equal(ctx.base.branch, 'main')
  assert.equal(ctx.base.remoteRef, null)
  assert.equal(ctx.base.ahead, 2)
  assert.equal(ctx.base.behind, 0)
  assert.deepEqual(ctx.base.mergeBase, { sha: shaB, shortSha: shaB.slice(0, 7) })
  assert.equal(ctx.base.remoteAhead, null)
  assert.equal(ctx.base.remoteBehind, null)

  assert.deepEqual(subjectsOf(ctx.commits.ahead), ['D 分支提交', 'C 分支提交'])
  assert.deepEqual(ctx.commits.behind, [])
  assert.deepEqual(subjectsOf(ctx.commits.shared), ['B 第二个提交', 'A 初始提交'])
  assert.deepEqual(ctx.commits.ahead.map(item => item.sha), [shaD, shaC])

  assert.equal(ctx.worktrees.length, 1)
  assert.deepEqual(ctx.worktrees[0], {
    path: realRepo,
    branch: 'feat/x',
    detached: false,
    sha: shaD,
    shortSha: shaD.slice(0, 7),
    isMain: true,
    isCurrent: true,
    aheadOfBase: 2,
    behindOfBase: 0,
  })
  assert.equal(ctx.worktreesTruncated, 0)

  assert.deepEqual(ctx.refs, [
    { name: 'HEAD', sha: shaD, shortSha: shaD.slice(0, 7), kind: 'head' },
    { name: 'feat/x', sha: shaD, shortSha: shaD.slice(0, 7), kind: 'branch' },
    { name: 'main', sha: shaB, shortSha: shaB.slice(0, 7), kind: 'base' },
  ])
  assert.deepEqual(ctx.limits, { ...GIT_LIMITS })

  // detached HEAD：branch=null、图仍以主分支为参照
  await git(repo, ['checkout', '-q', '--detach', shaC])
  const detached = await collectGitContext({ cwd: repo })
  assert.equal(detached.available, true)
  assert.equal(detached.current.detached, true)
  assert.equal(detached.current.branch, null)
  assert.equal(detached.base.kind, 'main')
  assert.equal(detached.base.label, 'main')
  assert.equal(detached.base.ahead, 1)
  assert.equal(detached.base.behind, 0)
  assert.deepEqual(detached.base.mergeBase, { sha: shaB, shortSha: shaB.slice(0, 7) })
  assert.deepEqual(subjectsOf(detached.commits.ahead), ['C 分支提交'])
  assert.deepEqual(subjectsOf(detached.commits.shared), ['B 第二个提交', 'A 初始提交'])
  assert.deepEqual(detached.refs.map(ref => ref.name), ['HEAD', 'main'])
  assert.equal(detached.refs[0].kind, 'head')
  assert.equal(detached.refs[1].kind, 'base')
  assert.equal(detached.worktrees[0].detached, true)
  assert.equal(detached.worktrees[0].branch, null)
  assert.equal(detached.worktrees[0].sha, shaC)
  assert.equal(detached.worktrees[0].aheadOfBase, null)
  assert.equal(detached.worktrees[0].behindOfBase, null)
})

test('upstream：base 用 upstream，领先/落后计数完整，refs 带 origin 引用', async t => {
  const root = await tempDir(t, 'dsh-git-')
  const remoteDir = join(root, 'origin.git')
  await git(root, ['init', '-q', '--bare', '-b', 'main', remoteDir])

  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  const shaA = await commit(repo, 'A 初始提交', 1)
  await git(repo, ['remote', 'add', 'origin', remoteDir])
  await git(repo, ['push', '-q', '-u', 'origin', 'main'])

  // 另一个克隆模拟远端前进 2 个提交
  const other = join(root, 'other')
  await git(root, ['clone', '-q', remoteDir, other])
  await commit(other, 'E1 远端提交', 2)
  const shaE2 = await commit(other, 'E2 远端提交', 3)
  await git(other, ['push', '-q', 'origin', 'main'])

  // 本地分叉：main 上再加 1 个提交，然后同步远端引用
  const shaB = await commit(repo, 'B 本地提交', 4)
  await git(repo, ['fetch', '-q', 'origin'])

  const ctx = await collectGitContext({ cwd: repo })
  assert.equal(ctx.available, true)
  assert.deepEqual(ctx.upstream, {
    ref: 'origin/main',
    remote: 'origin',
    branch: 'main',
    ahead: 1,
    behind: 2,
  })
  assert.equal(ctx.base.kind, 'upstream')
  assert.equal(ctx.base.label, 'origin/main')
  assert.equal(ctx.base.branch, 'main')
  assert.equal(ctx.base.remoteRef, 'origin/main')
  assert.equal(ctx.base.ahead, 1)
  assert.equal(ctx.base.behind, 2)
  assert.deepEqual(ctx.base.mergeBase, { sha: shaA, shortSha: shaA.slice(0, 7) })
  // remoteAhead/remoteBehind = rev-list --left-right --count origin/main...main 的右/左计数
  assert.equal(ctx.base.remoteAhead, 1)
  assert.equal(ctx.base.remoteBehind, 2)

  assert.deepEqual(subjectsOf(ctx.commits.ahead), ['B 本地提交'])
  assert.deepEqual(subjectsOf(ctx.commits.behind), ['E2 远端提交', 'E1 远端提交'])
  assert.deepEqual(subjectsOf(ctx.commits.shared), ['A 初始提交'])
  assert.equal(ctx.worktrees[0].aheadOfBase, 1)
  assert.equal(ctx.worktrees[0].behindOfBase, 2)

  // refs：HEAD / 当前分支 / 主分支远端引用（upstream 同名去重）
  assert.deepEqual(ctx.refs.map(ref => [ref.name, ref.kind]), [['HEAD', 'head'], ['main', 'branch'], ['origin/main', 'base']])
  assert.equal(ctx.refs[2].sha, shaE2)
  assert.equal(ctx.current.sha, shaB)

  // v0.14 graph：当前分支就是主分支，HEAD/当前分支/origin 主分支各一次，upstream 同名去重
  assert.deepEqual(ctx.graph.refs.map(ref => [ref.name, ref.kind]), [
    ['HEAD', 'head'], ['main', 'branch'], ['origin/main', 'remote'],
  ])
  assert.equal(ctx.graph.refs[1].isCurrent, true)
  assert.equal(ctx.graph.refs[1].upstream, 'origin/main')
  assert.equal(ctx.graph.refs[1].ahead, 1)
  assert.equal(ctx.graph.refs[1].behind, 2)
  assert.equal('isCurrent' in ctx.graph.refs[2], false)

  // 只有远端 main、没有本地 main：主分支仍可从 origin/main 探测，比较用远端引用
  await git(repo, ['checkout', '-q', '-b', 'dev'])
  await git(repo, ['branch', '-D', 'main'])
  const remoteOnly = await collectGitContext({ cwd: repo })
  assert.equal(remoteOnly.available, true)
  assert.equal(remoteOnly.current.branch, 'dev')
  assert.equal(remoteOnly.base.kind, 'main')
  assert.equal(remoteOnly.base.label, 'main')
  assert.equal(remoteOnly.base.branch, 'main')
  assert.equal(remoteOnly.base.remoteRef, 'origin/main')
  assert.equal(remoteOnly.base.ahead, 1)
  assert.equal(remoteOnly.base.behind, 2)
  assert.equal(remoteOnly.base.remoteAhead, 0)
  assert.equal(remoteOnly.base.remoteBehind, 0)
})

test('主分支探测：origin/HEAD 命名，比较引用优先本地同名分支', async t => {
  const root = await tempDir(t, 'dsh-git-')
  const remoteDir = join(root, 'origin.git')
  await git(root, ['init', '-q', '--bare', '-b', 'main', remoteDir])
  const seed = join(root, 'seed')
  await mkdir(seed)
  await git(seed, ['init', '-q', '-b', 'main'])
  const shaA = await commit(seed, 'S1 初始提交', 1)
  await git(seed, ['remote', 'add', 'origin', remoteDir])
  await git(seed, ['push', '-q', '-u', 'origin', 'main'])

  // clone 自带 refs/remotes/origin/HEAD → 主分支名从 origin/HEAD 探测
  const repo = join(root, 'clone')
  await git(root, ['clone', '-q', remoteDir, repo])
  const shaB = await commit(repo, 'B 本地未推送提交', 2)
  await git(repo, ['checkout', '-q', '-b', 'dev'])

  const ctx = await collectGitContext({ cwd: repo })
  assert.equal(ctx.available, true)
  assert.equal(ctx.current.branch, 'dev')
  assert.equal(ctx.base.kind, 'main')
  assert.equal(ctx.base.label, 'main')
  assert.equal(ctx.base.branch, 'main')
  // 名字虽来自 origin/HEAD，但本地存在 main 时比较引用取本地 main（与 dev 同 sha）
  assert.equal(ctx.base.ahead, 0)
  assert.equal(ctx.base.behind, 0)
  assert.deepEqual(ctx.base.mergeBase, { sha: shaB, shortSha: shaB.slice(0, 7) })
  assert.equal(ctx.base.remoteRef, 'origin/main')
  // origin/main...main 的右/左计数：本地 main 领先远端 1
  assert.equal(ctx.base.remoteAhead, 1)
  assert.equal(ctx.base.remoteBehind, 0)

  // 删掉本地 main 后只能与 origin/main 比较
  await git(repo, ['branch', '-D', 'main'])
  const remoteOnly = await collectGitContext({ cwd: repo })
  assert.equal(remoteOnly.base.kind, 'main')
  assert.equal(remoteOnly.base.label, 'main')
  assert.equal(remoteOnly.base.ahead, 1)
  assert.equal(remoteOnly.base.behind, 0)
  assert.deepEqual(remoteOnly.base.mergeBase, { sha: shaA, shortSha: shaA.slice(0, 7) })
  assert.equal(remoteOnly.base.remoteAhead, 0)
  assert.equal(remoteOnly.base.remoteBehind, 0)
})

test('linked worktree 与 ?cwd= 候选：同仓库且方向正确才采用，其余静默忽略', async t => {
  const root = await tempDir(t, 'dsh-git-')
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  await commit(repo, 'A 初始提交', 1)
  await commit(repo, 'B 主分支提交', 2)
  const linked = join(root, 'wt-feat')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/x', linked])
  const shaC = await commit(linked, 'C 工作树提交', 3)
  const realRepo = await realpath(repo)
  const realLinked = await realpath(linked)

  // card.cwd 在主工作树、候选在 linked worktree → 采用候选
  const adopted = await collectGitContext({ cwd: repo, requestedDir: linked })
  assert.equal(adopted.available, true)
  assert.equal(adopted.dir, realLinked)
  assert.equal(adopted.requestedDir, linked)
  assert.equal(adopted.repo.root, realRepo)
  assert.equal(adopted.current.worktree, realLinked)
  assert.equal(adopted.current.isWorktree, true)
  assert.equal(adopted.current.isMainWorktree, false)
  assert.equal(adopted.current.branch, 'feat/x')
  assert.equal(adopted.current.sha, shaC)
  assert.equal(adopted.base.label, 'main')
  assert.equal(adopted.base.ahead, 1)
  assert.equal(adopted.base.behind, 0)
  assert.equal(adopted.worktrees.length, 2)
  assert.equal(adopted.worktrees[0].path, realRepo)
  assert.equal(adopted.worktrees[0].isMain, true)
  assert.equal(adopted.worktrees[0].isCurrent, false)
  assert.equal(adopted.worktrees[1].path, realLinked)
  assert.equal(adopted.worktrees[1].isMain, false)
  assert.equal(adopted.worktrees[1].isCurrent, true)
  assert.equal(adopted.worktrees[1].aheadOfBase, 1)
  assert.equal(adopted.worktrees[1].behindOfBase, 0)

  // 不传候选：采集主工作树，但工作树列表里仍能看到当前工作树
  const baseline = await collectGitContext({ cwd: repo })
  assert.equal(baseline.dir, realRepo)
  assert.equal(baseline.current.isWorktree, false)
  assert.equal(baseline.worktrees[1].aheadOfBase, 1)
  assert.equal(baseline.worktrees[1].behindOfBase, 0)

  // 候选落在 linked worktree 的子目录：仍属于该工作树，采用
  await mkdir(join(linked, 'sub'))
  const subCandidate = await collectGitContext({ cwd: repo, requestedDir: join(linked, 'sub') })
  assert.equal(subCandidate.dir, await realpath(join(linked, 'sub')))
  assert.equal(subCandidate.current.worktree, realLinked)

  // 跨仓库候选：忽略
  const other = join(root, 'other')
  await mkdir(other)
  await git(other, ['init', '-q', '-b', 'main'])
  await commit(other, 'X 另一个仓库', 1)
  const cross = await collectGitContext({ cwd: repo, requestedDir: other })
  assert.equal(cross.dir, realRepo)
  assert.equal(cross.requestedDir, other)
  assert.equal(cross.current.isWorktree, false)

  // 方向相反（卡片本身在 linked worktree，候选是主工作树）：忽略
  const reverse = await collectGitContext({ cwd: linked, requestedDir: repo })
  assert.equal(reverse.dir, realLinked)
  assert.equal(reverse.current.isWorktree, true)

  // 候选不存在 / 是文件 / 非绝对路径：都忽略
  const missingCandidate = await collectGitContext({ cwd: repo, requestedDir: join(root, 'nope') })
  assert.equal(missingCandidate.dir, realRepo)
  const plainFile = join(root, 'plain.txt')
  await writeFile(plainFile, 'x')
  const fileCandidate = await collectGitContext({ cwd: repo, requestedDir: plainFile })
  assert.equal(fileCandidate.dir, realRepo)
  const relativeCandidate = await collectGitContext({ cwd: repo, requestedDir: 'relative/path' })
  assert.equal(relativeCandidate.dir, realRepo)
})

test('工作树上限：最多 8 个，主工作树与当前工作树优先保留', async t => {
  const root = await tempDir(t, 'dsh-git-')
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  await commit(repo, 'A 初始提交', 1)
  for (let index = 1; index <= 10; index += 1) {
    await git(repo, ['worktree', 'add', '-q', '-b', `b${index}`, join(root, `wt-${index}`)])
  }

  const fromMain = await collectGitContext({ cwd: repo })
  assert.equal(fromMain.available, true)
  assert.equal(fromMain.worktrees.length, 8)
  assert.equal(fromMain.worktreesTruncated, 3) // 主工作树 + 10 个 linked = 11
  assert.equal(fromMain.worktrees[0].isMain, true)
  assert.equal(fromMain.worktrees[0].isCurrent, true)
  assert.equal(fromMain.worktrees.filter(item => item.isCurrent).length, 1)

  // 当前工作树排在列表尾部（第 11 项）也必须保留
  const lastWorktree = join(root, 'wt-10')
  const fromWorktree = await collectGitContext({ cwd: lastWorktree })
  assert.equal(fromWorktree.worktrees.length, 8)
  assert.equal(fromWorktree.worktreesTruncated, 3)
  assert.equal(fromWorktree.worktrees[0].isMain, true)
  assert.equal(fromWorktree.current.isWorktree, true)
  assert.equal(fromWorktree.current.worktree, await realpath(lastWorktree))
  const currentRows = fromWorktree.worktrees.filter(item => item.isCurrent)
  assert.equal(currentRows.length, 1)
  assert.equal(currentRows[0].path, await realpath(lastWorktree))
})

test('提交列表上限：ahead 12 / behind 8 / shared 4，但 base 计数完整', async t => {
  const repo = await initRepo(t)
  for (let index = 1; index <= 6; index += 1) await commit(repo, `M${index} 主分支提交`, index)
  const shaMainTip = await git(repo, ['rev-parse', 'HEAD'])
  await git(repo, ['checkout', '-q', '-b', 'feat/x'])
  for (let index = 1; index <= 13; index += 1) await commit(repo, `F${index} 分支提交`, 10 + index)
  await git(repo, ['checkout', '-q', 'main'])
  for (let index = 1; index <= 9; index += 1) await commit(repo, `N${index} 主分支新提交`, 30 + index)
  await git(repo, ['checkout', '-q', 'feat/x'])

  const ctx = await collectGitContext({ cwd: repo })
  assert.equal(ctx.current.branch, 'feat/x')
  assert.equal(ctx.base.ahead, 13)
  assert.equal(ctx.base.behind, 9)
  assert.equal(ctx.base.mergeBase.sha, shaMainTip)
  assert.equal(ctx.commits.ahead.length, GIT_LIMITS.ahead)
  assert.equal(ctx.commits.ahead[0].subject, 'F13 分支提交')
  assert.equal(ctx.commits.ahead.at(-1).subject, 'F2 分支提交')
  assert.equal(ctx.commits.behind.length, GIT_LIMITS.behind)
  assert.equal(ctx.commits.behind[0].subject, 'N9 主分支新提交')
  assert.equal(ctx.commits.behind.at(-1).subject, 'N2 主分支新提交')
  assert.equal(ctx.commits.shared.length, GIT_LIMITS.shared)
  assert.deepEqual(subjectsOf(ctx.commits.shared), ['M6 主分支提交', 'M5 主分支提交', 'M4 主分支提交', 'M3 主分支提交'])
})

test('不可用原因：no_cwd / missing / not_git / no_commits，候选不兜底', async t => {
  const root = await tempDir(t, 'dsh-git-')

  const noCwd = await collectGitContext({})
  assert.equal(noCwd.available, false)
  assert.equal(noCwd.reason, 'no_cwd')
  assert.equal(noCwd.message, null)
  assert.equal(noCwd.requestedDir, null)
  assert.equal(noCwd.dir, undefined)
  assert.ok(noCwd.fetchedAt > 0)
  assert.ok(noCwd.durationMs >= 0)

  // card.cwd 缺失时不接受 ?cwd= 候选（避免沦为任意目录探测器），但仍回显原值
  const noCwdWithCandidate = await collectGitContext({ cwd: null, requestedDir: root })
  assert.equal(noCwdWithCandidate.reason, 'no_cwd')
  assert.equal(noCwdWithCandidate.requestedDir, root)

  const notGitDir = join(root, 'plain')
  await mkdir(notGitDir)
  const notGit = await collectGitContext({ cwd: notGitDir })
  assert.equal(notGit.available, false)
  assert.equal(notGit.reason, 'not_git')
  assert.equal(notGit.message, null)

  const empty = join(root, 'empty')
  await mkdir(empty)
  await git(empty, ['init', '-q', '-b', 'main'])
  const noCommits = await collectGitContext({ cwd: empty })
  assert.equal(noCommits.available, false)
  assert.equal(noCommits.reason, 'no_commits')

  const missing = await collectGitContext({ cwd: join(root, 'does-not-exist') })
  assert.equal(missing.reason, 'missing')

  // 路径存在但不是目录：同样归为 missing
  const plainFile = join(root, 'file.txt')
  await writeFile(plainFile, 'x')
  const notDirectory = await collectGitContext({ cwd: plainFile })
  assert.equal(notDirectory.reason, 'missing')
})

test('主分支探测：本地 main 优先于 master，探测不到时退化为单泳道', async t => {
  // 同时存在 main 与 master：按契约顺序 main 优先
  const both = await initRepo(t, 'both', { branch: 'master' })
  await commit(both, 'S1 初始提交', 1)
  await git(both, ['branch', 'main'])
  await git(both, ['checkout', '-q', '-b', 'topic'])
  await commit(both, 'S2 分支提交', 2)
  const preferred = await collectGitContext({ cwd: both })
  assert.equal(preferred.base.kind, 'main')
  assert.equal(preferred.base.label, 'main')
  assert.equal(preferred.base.branch, 'main')
  assert.equal(preferred.base.ahead, 1)

  // 只有 master：第二步探测回退到 master
  const masterOnly = await initRepo(t, 'master-only', { branch: 'master' })
  await commit(masterOnly, 'M1 初始提交', 1)
  await git(masterOnly, ['checkout', '-q', '-b', 'topic'])
  await commit(masterOnly, 'M2 分支提交', 2)
  const masterBase = await collectGitContext({ cwd: masterOnly })
  assert.equal(masterBase.base.label, 'master')
  assert.equal(masterBase.base.ahead, 1)

  // 只有 trunk（无 main/master、无 origin）：base=null，共享提交从 HEAD 起
  const trunk = await initRepo(t, 'trunk-repo', { branch: 'trunk' })
  for (let index = 1; index <= 5; index += 1) await commit(trunk, `T${index} 主干提交`, index)
  const single = await collectGitContext({ cwd: trunk })
  assert.equal(single.available, true)
  assert.equal(single.current.branch, 'trunk')
  assert.equal(single.base, null)
  assert.deepEqual(single.commits.ahead, [])
  assert.deepEqual(single.commits.behind, [])
  assert.deepEqual(subjectsOf(single.commits.shared), ['T5 主干提交', 'T4 主干提交', 'T3 主干提交', 'T2 主干提交'])
  assert.deepEqual(single.refs.map(ref => [ref.name, ref.kind]), [['HEAD', 'head'], ['trunk', 'branch']])
  assert.equal(single.worktrees[0].aheadOfBase, null)
  assert.equal(single.worktrees[0].behindOfBase, null)
})

// ---------------- v0.14 Fork 风格多分支提交图（graph，契约 §4.5） ----------------

/** 固定作者/提交时间的 git 环境（merge 提交等需要精确排序的场景）。 */
function stampedEnv(seq) {
  const stamp = `@${commitEpoch(seq)} +0000`
  return { ...GIT_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
}

test('graph：合并提交多父、date-order 拓扑（父提交永远排在孩子之后）', async t => {
  const repo = await initRepo(t)
  const shaA = await commit(repo, 'A 初始提交', 1)
  const shaB = await commit(repo, 'B 主分支提交', 2)
  await git(repo, ['checkout', '-q', '-b', 'feat/x'])
  const shaC = await commit(repo, 'C 分支提交', 3)
  await git(repo, ['checkout', '-q', 'main'])
  const shaD = await commit(repo, 'D 主分支提交', 4)
  await git(repo, ['merge', '--no-ff', '-q', '-m', 'merge feat/x', 'feat/x'], stampedEnv(5))
  const shaM = await git(repo, ['rev-parse', 'HEAD'])

  const ctx = await collectGitContext({ cwd: repo })
  assert.equal(ctx.available, true)
  const graph = ctx.graph
  assert.ok(graph, 'graph 应存在（仓库可读、有提交）')
  assert.deepEqual(graph.refs.map(ref => ref.name), ['HEAD', 'main', 'feat/x'])
  assert.deepEqual(graph.refs[0], { name: 'HEAD', kind: 'head', sha: shaM, shortSha: shaM.slice(0, 7), branch: 'main' })
  assert.deepEqual(graph.refs[1], {
    name: 'main', kind: 'branch', sha: shaM, shortSha: shaM.slice(0, 7),
    isCurrent: true, upstream: null, ahead: null, behind: null,
  })
  assert.deepEqual(graph.refs[2], {
    name: 'feat/x', kind: 'branch', sha: shaC, shortSha: shaC.slice(0, 7),
    isCurrent: false, upstream: null, ahead: null, behind: null,
  })
  assert.equal(graph.refsTruncated, 0)
  assert.equal(graph.maxCommits, 48)
  assert.equal(graph.maxRefs, 10)

  assert.deepEqual(graph.commits.map(item => item.sha), [shaM, shaD, shaC, shaB, shaA])
  const mergeCommit = graph.commits[0]
  assert.deepEqual(mergeCommit.parents, [shaD, shaC])
  assert.equal(mergeCommit.committedAt, commitEpoch(5) * 1000)
  assert.equal(mergeCommit.subject, 'merge feat/x')
  assert.equal(mergeCommit.authorName, '测试作者')
  assert.deepEqual(graph.commits.find(item => item.sha === shaB).parents, [shaA])
  assert.deepEqual(graph.commits.find(item => item.sha === shaA).parents, [])
  // --date-order 保证父提交永远排在孩子之后（前端泳道布局依赖该拓扑性）
  const indexBySha = new Map(graph.commits.map((item, index) => [item.sha, index]))
  for (const item of graph.commits) {
    for (const parent of item.parents) {
      if (indexBySha.has(parent)) assert.ok(indexBySha.get(parent) > indexBySha.get(item.sha), `${parent} 应排在 ${item.sha} 之后`)
    }
  }
  assert.equal(graph.truncated, 0)
  // v0.13 兼容：老字段照旧可用
  assert.equal(ctx.base.label, 'main')
  assert.equal(ctx.current.branch, 'main')
})

test('graph：引用选取顺序与去重（HEAD→当前→主分支→origin 主分支→upstream→工作树分支→其余本地→origin 分支）', async t => {
  const root = await tempDir(t, 'dsh-git-graph-')
  const remoteDir = join(root, 'origin.git')
  await git(root, ['init', '-q', '--bare', '-b', 'main', remoteDir])
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  const shaA = await commit(repo, 'A 初始提交', 1)
  await git(repo, ['remote', 'add', 'origin', remoteDir])
  await git(repo, ['push', '-q', '-u', 'origin', 'main'])

  // 当前分支 feat/x：推送建立 upstream 后本地再加 1 个提交 → ahead 1
  await git(repo, ['checkout', '-q', '-b', 'feat/x'])
  await commit(repo, 'F1 分支提交', 2)
  await git(repo, ['push', '-q', '-u', 'origin', 'feat/x'])
  const shaF2 = await commit(repo, 'F2 分支提交', 3)

  // 远端 main 前进 1 → 本地 main 落后 1（track [behind 1]）
  const other = join(root, 'other')
  await git(root, ['clone', '-q', remoteDir, other])
  const shaE1 = await commit(other, 'E1 远端提交', 4)
  await git(other, ['push', '-q', 'origin', 'main'])
  await git(repo, ['fetch', '-q', 'origin'])

  // b2：本地分支并推到 origin（不带 -u：无 upstream，但存在 origin/b2 远端引用）
  await git(repo, ['branch', 'b2', 'main'])
  await git(repo, ['push', '-q', 'origin', 'b2'])

  // 工作树分支：worktree list 顺序应排在「其余本地分支」之前
  const linkedRoot = await tempDir(t, 'dsh-git-graph-wt-')
  const linked = join(linkedRoot, 'wt')
  await git(repo, ['worktree', 'add', '-q', '-b', 'wt-branch', linked])

  const ctx = await collectGitContext({ cwd: repo })
  const graph = ctx.graph
  assert.ok(graph)
  assert.deepEqual(graph.refs.map(ref => ref.name), [
    'HEAD', 'feat/x', 'main', 'origin/main', 'origin/feat/x', 'wt-branch', 'b2', 'origin/b2',
  ])
  assert.deepEqual(graph.refs.map(ref => ref.kind), [
    'head', 'branch', 'branch', 'remote', 'remote', 'branch', 'branch', 'remote',
  ])
  assert.equal(graph.refs.length, 8)
  assert.equal(graph.refsTruncated, 0)

  const byName = new Map(graph.refs.map(ref => [ref.name, ref]))
  assert.equal(byName.get('HEAD').branch, 'feat/x')
  assert.equal(byName.get('HEAD').sha, shaF2)
  assert.equal(byName.get('feat/x').isCurrent, true)
  assert.equal(byName.get('feat/x').upstream, 'origin/feat/x')
  assert.equal(byName.get('feat/x').ahead, 1)
  assert.equal(byName.get('feat/x').behind, 0)
  assert.equal(byName.get('main').isCurrent, false)
  assert.equal(byName.get('main').upstream, 'origin/main')
  assert.equal(byName.get('main').ahead, 0)
  assert.equal(byName.get('main').behind, 1)
  // 远端引用只有 name/kind/sha/shortSha（契约只给本地分支 ahead/behind/isCurrent）
  assert.equal('isCurrent' in byName.get('origin/main'), false)
  assert.equal('upstream' in byName.get('origin/main'), false)
  assert.equal('ahead' in byName.get('origin/main'), false)
  assert.equal(byName.get('b2').upstream, null)
  assert.equal(byName.get('b2').ahead, null)
  assert.equal(byName.get('b2').behind, null)
  assert.equal(byName.get('wt-branch').upstream, null)

  // 提交集合来自选中的 raw 引用（包含只存在于 origin/main 上的远端提交）
  const shas = graph.commits.map(item => item.sha)
  assert.ok(shas.includes(shaF2))
  assert.ok(shas.includes(shaE1))
  assert.ok(shas.includes(shaA))
  assert.equal(graph.truncated, 0)

  // clone 仓库带 refs/remotes/origin/HEAD 符号引用：不应出现在 graph.refs 里
  const cloneCtx = await collectGitContext({ cwd: other })
  assert.ok(cloneCtx.graph)
  assert.equal(cloneCtx.graph.refs.some(ref => ref.name === 'origin/HEAD'), false)
})

test('graph：%(upstream:track) 解析（ahead/behind 单边、同步、gone、无 upstream）', async t => {
  const root = await tempDir(t, 'dsh-git-graph-track-')
  const remoteDir = join(root, 'origin.git')
  await git(root, ['init', '-q', '--bare', '-b', 'main', remoteDir])
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  await commit(repo, 'A 初始提交', 1)
  await git(repo, ['remote', 'add', 'origin', remoteDir])
  await git(repo, ['push', '-q', '-u', 'origin', 'main'])

  // b-ahead：推送后本地再加 1 个提交 → ahead 1 / behind 0（track [ahead 1]）
  await git(repo, ['checkout', '-q', '-b', 'b-ahead'])
  await commit(repo, 'BA1 提交', 2)
  await git(repo, ['push', '-q', '-u', 'origin', 'b-ahead'])
  const shaBA2 = await commit(repo, 'BA2 提交', 3)

  // b-behind：推送后远端再前进 1 个提交 → ahead 0 / behind 1（track [behind 1]）
  await git(repo, ['checkout', '-q', '-b', 'b-behind', 'main'])
  await commit(repo, 'BB1 提交', 4)
  await git(repo, ['push', '-q', '-u', 'origin', 'b-behind'])
  const other = join(root, 'other')
  await git(root, ['clone', '-q', remoteDir, other])
  await git(other, ['fetch', '-q', 'origin'])
  await git(other, ['checkout', '-q', '-b', 'b-behind', 'origin/b-behind'])
  await commit(other, 'E-behind 远端提交', 5)
  await git(other, ['push', '-q', 'origin', 'b-behind'])
  await git(repo, ['fetch', '-q', 'origin'])

  // b-sync：推送后不再提交 → 与 upstream 一致（track 为空 → 0/0）
  await git(repo, ['checkout', '-q', '-b', 'b-sync', 'main'])
  const shaBS = await commit(repo, 'BS1 提交', 6)
  await git(repo, ['push', '-q', '-u', 'origin', 'b-sync'])

  // b-gone：推送后删除远端分支并 prune → [gone] → ahead/behind null（upstream 名仍保留）
  await git(repo, ['checkout', '-q', '-b', 'b-gone', 'main'])
  await commit(repo, 'BG1 提交', 7)
  await git(repo, ['push', '-q', '-u', 'origin', 'b-gone'])
  await git(remoteDir, ['branch', '-D', 'b-gone'])
  await git(repo, ['fetch', '-q', '--prune', 'origin'])

  // b-none：纯本地分支，无 upstream
  await git(repo, ['checkout', '-q', '-b', 'b-none', 'main'])
  await git(repo, ['checkout', '-q', 'main'])

  const ctx = await collectGitContext({ cwd: repo })
  const byName = new Map(ctx.graph.refs.map(ref => [ref.name, ref]))
  assert.deepEqual(byName.get('b-ahead'), {
    name: 'b-ahead', kind: 'branch', sha: shaBA2, shortSha: shaBA2.slice(0, 7),
    isCurrent: false, upstream: 'origin/b-ahead', ahead: 1, behind: 0,
  })
  assert.equal(byName.get('b-behind').upstream, 'origin/b-behind')
  assert.equal(byName.get('b-behind').ahead, 0)
  assert.equal(byName.get('b-behind').behind, 1)
  assert.equal(byName.get('b-sync').upstream, 'origin/b-sync')
  assert.equal(byName.get('b-sync').ahead, 0)
  assert.equal(byName.get('b-sync').behind, 0)
  assert.equal(byName.get('b-sync').sha, shaBS)
  assert.equal(byName.get('b-gone').upstream, 'origin/b-gone')
  assert.equal(byName.get('b-gone').ahead, null)
  assert.equal(byName.get('b-gone').behind, null)
  assert.equal(byName.get('b-none').upstream, null)
  assert.equal(byName.get('b-none').ahead, null)
  assert.equal(byName.get('b-none').behind, null)
  // 当前分支 main 与 origin/main 同步
  assert.equal(byName.get('main').ahead, 0)
  assert.equal(byName.get('main').behind, 0)
})

test('graph：提交上限 48 与 truncated 计数', async t => {
  const repo = await initRepo(t)
  for (let index = 1; index <= 60; index += 1) await commit(repo, `C${index} 提交`, index)
  const headSha = await git(repo, ['rev-parse', 'HEAD'])
  const ctx = await collectGitContext({ cwd: repo })
  const graph = ctx.graph
  assert.equal(graph.commits.length, 48)
  assert.equal(graph.commits[0].sha, headSha)
  assert.equal(graph.commits.at(-1).subject, 'C13 提交') // 最旧的 12 条（C1..C12）被截掉
  assert.equal(graph.truncated, 12)
  assert.equal(graph.maxCommits, 48)
  assert.deepEqual(graph.refs.map(ref => ref.name), ['HEAD', 'main'])
  // 线性历史的 date-order：每条提交的第一父就是下一条
  for (let index = 0; index < graph.commits.length - 1; index += 1) {
    assert.deepEqual(graph.commits[index].parents, [graph.commits[index + 1].sha])
  }
})

test('graph：引用上限 10 与 refsTruncated（其余本地分支按 committerdate 倒序）', async t => {
  const repo = await initRepo(t)
  for (let index = 1; index <= 12; index += 1) {
    await commit(repo, `M${index} 提交`, index)
    await git(repo, ['branch', `b${index}`])
  }
  const ctx = await collectGitContext({ cwd: repo })
  const graph = ctx.graph
  assert.deepEqual(graph.refs.map(ref => ref.name), [
    'HEAD', 'main', 'b12', 'b11', 'b10', 'b9', 'b8', 'b7', 'b6', 'b5',
  ])
  assert.equal(graph.refs.length, 10)
  assert.equal(graph.refsTruncated, 4) // 候选 14 条（HEAD + 当前/主分支 + 12 个分支），b4..b1 被挤掉
  assert.equal(graph.maxRefs, 10)
  assert.equal(graph.commits.length, 12)
  assert.equal(graph.truncated, 0)
})

test('graph：老分支 tip 被 48 条上限截掉时仍返回引用，truncated 只计数', async t => {
  const repo = await initRepo(t)
  const shaOld = await commit(repo, 'O1 老分支提交', 1)
  await git(repo, ['branch', 'old-branch'])
  for (let index = 2; index <= 56; index += 1) await commit(repo, `C${index} 提交`, index)
  const ctx = await collectGitContext({ cwd: repo })
  const graph = ctx.graph
  const oldRef = graph.refs.find(ref => ref.name === 'old-branch')
  assert.ok(oldRef, '老分支引用应保留（只截提交，不截引用）')
  assert.equal(oldRef.sha, shaOld)
  assert.equal(graph.commits.some(item => item.sha === shaOld), false)
  assert.equal(graph.commits.length, 48)
  assert.equal(graph.truncated, 56 - 48)
})

test('graph：detached HEAD 仍出图（HEAD.branch=null、无 isCurrent）', async t => {
  const repo = await initRepo(t)
  const shaA = await commit(repo, 'A 初始提交', 1)
  const shaB = await commit(repo, 'B 主分支提交', 2)
  await git(repo, ['branch', 'feat/x', shaA])
  await git(repo, ['checkout', '-q', '--detach', shaA])

  const ctx = await collectGitContext({ cwd: repo })
  assert.equal(ctx.current.detached, true)
  const graph = ctx.graph
  assert.ok(graph)
  assert.deepEqual(graph.refs[0], { name: 'HEAD', kind: 'head', sha: shaA, shortSha: shaA.slice(0, 7), branch: null })
  assert.equal(graph.refs.some(ref => ref.isCurrent === true), false)
  // 无当前分支时仍能看到主分支与其它本地分支：HEAD → main → feat/x
  assert.deepEqual(graph.refs.map(ref => ref.name), ['HEAD', 'main', 'feat/x'])
  assert.deepEqual(graph.commits.map(item => item.sha).sort(), [shaA, shaB].sort())
  assert.equal(graph.commits[0].sha, shaB) // date-order：新提交在前
})

test('graph：探测不到主分支（trunk）时仍按 HEAD/当前分支出图', async t => {
  const repo = await initRepo(t, 'solo', { branch: 'trunk' })
  for (let index = 1; index <= 3; index += 1) await commit(repo, `T${index} 提交`, index)
  const ctx = await collectGitContext({ cwd: repo })
  assert.equal(ctx.base, null)
  const graph = ctx.graph
  assert.ok(graph)
  assert.deepEqual(graph.refs.map(ref => [ref.name, ref.kind]), [['HEAD', 'head'], ['trunk', 'branch']])
  assert.equal(graph.commits.length, 3)
  assert.equal(graph.truncated, 0)
})
