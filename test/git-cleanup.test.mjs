// v0.17 工作副本清理：/git/workspaces 的 Phase A 增量字段 +
// POST /git/worktrees/cleanup（软删除到回收站 + prune + 可选删分支）的测试。
// 全部用 os.tmpdir() 下的真实临时仓库与临时回收站，离线、不碰真实 ~/.dsh-kanban。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectGitWorkspaces } from '../lib/git.js'
import { createRoutes } from '../lib/routes.js'
import { api, tempDir, testStore } from './helpers.mjs'

const execFileAsync = promisify(execFile)
/** 固定提交时间基线（同其它 git 测试），保证 ahead/behind 与 lastCommitAt 可重复。 */
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

function stampedEnv(seq) {
  const stamp = `@${BASE_EPOCH + seq} +0000`
  return { ...GIT_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
}

/** 该 seq 的提交时间（git %(committerdate:iso-strict) 格式，环境固定 +0000）。 */
function isoAt(seq) {
  return new Date((BASE_EPOCH + seq) * 1000).toISOString().replace('.000Z', '+00:00')
}

async function commit(cwd, subject, seq) {
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', subject], { cwd, env: stampedEnv(seq) })
  return git(cwd, ['rev-parse', 'HEAD'])
}

async function commitFile(cwd, subject, seq, file, content) {
  await writeFile(join(cwd, file), content, 'utf8')
  await git(cwd, ['add', file])
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], { cwd, env: stampedEnv(seq) })
  return git(cwd, ['rev-parse', 'HEAD'])
}

async function initRepo(t, name = 'repo', { branch = 'main' } = {}) {
  const root = await tempDir(t, 'dsh-git-cleanup-')
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '-q', '-b', branch])
  return { root, repo }
}

async function exists(value) {
  try { await stat(value); return true } catch { return false }
}

/** 与 test/helpers.mjs 的 startServer 一致，额外支持 createRoutes 选项（回收站根目录等）。 */
async function startServer(t, { store, ...options } = {}) {
  await store.ready()
  const routes = createRoutes({ store, version: '0.0.0-test', ...options })
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      let best
      for (const route of routes.routes) {
        if (route.kind === 'exact' && url.pathname === route.path) { best = route; break }
        if (route.kind === 'prefix' && (url.pathname === route.path || url.pathname.startsWith(route.path + '/'))) {
          if (!best || route.path.length > best.path.length) best = route
        }
      }
      if (!best) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
      await best.handler(req, res)
    } catch (error) {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error') }
      console.error('test server error', error)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(async () => {
    await routes.close()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  })
  return { url: `http://127.0.0.1:${port}`, port, routes }
}

async function setupServer(t, options = {}) {
  const trashRoot = await tempDir(t, 'dsh-git-trash-')
  const { store } = await testStore(t, { seedMode: 'empty' })
  const server = await startServer(t, { store, gitTrashRoot: trashRoot, ...options })
  return { store, server, trashRoot }
}

async function createCard(server, body = {}) {
  const res = await api(server, '/api/kanban/cards', { method: 'POST', body: { title: '工作区卡片', ...body } })
  assert.equal(res.status, 200, res.text)
  return res.json.card
}

function cleanup(server, body) {
  return api(server, '/api/kanban/git/worktrees/cleanup', { method: 'POST', body })
}

/** 回收站目录名时间戳（本地时间，与 lib/git.js 的命名一致）。 */
function trashTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

// ---------------- Phase A：/git/workspaces 增量字段 ----------------

test('/git/workspaces Phase A：mergedIntoBase / upstream / modifiedCount / untrackedCount / locked / prunable / lastCommitAt', async t => {
  const root = await tempDir(t, 'dsh-git-phasea-')
  const remoteDir = join(root, 'origin.git')
  await git(root, ['init', '-q', '--bare', '-b', 'main', remoteDir])
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '-q', '-b', 'main'])
  const shaA = await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  await git(repo, ['remote', 'add', 'origin', remoteDir])
  await git(repo, ['push', '-q', '-u', 'origin', 'main'])

  // 远端前进 1 + 本地提交 1 → main 的 upstream：ahead 1 / behind 1
  const other = join(root, 'other')
  await git(root, ['clone', '-q', remoteDir, other])
  await commit(other, 'E1 远端提交', 2)
  await git(other, ['push', '-q', 'origin', 'main'])
  await commitFile(repo, 'B 主分支提交', 3, 'a.txt', 'b\n')
  await git(repo, ['fetch', '-q', 'origin'])

  // feat/x：从 A 分出、提交 C（未合并且领先 main 1 / 落后 1）
  const wtFeat = join(root, 'wt-feat')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/x', wtFeat, shaA])
  await commit(wtFeat, 'C 分支提交', 4)
  // feat/merged：从 main（B）分出、与主分支同点 → 已并入；并锁住
  const wtMerged = join(root, 'wt-merged')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/merged', wtMerged])
  await git(repo, ['worktree', 'lock', wtMerged])
  // 主工作副本制造脏状态：改已跟踪文件 + 一个未跟踪文件
  await writeFile(join(repo, 'a.txt'), 'dirty\n', 'utf8')
  await writeFile(join(repo, 'untracked.txt'), 'new\n', 'utf8')

  const result = await collectGitWorkspaces([repo])
  assert.deepEqual(result.unavailable, [])
  assert.equal(result.repos.length, 1)
  const byBranch = new Map(result.repos[0].worktrees.map(row => [row.branch, row]))

  const mainRow = byBranch.get('main')
  assert.equal(mainRow.mergedIntoBase, true)
  assert.deepEqual(mainRow.upstream, { ref: 'origin/main', ahead: 1, behind: 1 })
  assert.equal(mainRow.modifiedCount, 1)
  assert.equal(mainRow.untrackedCount, 1)
  assert.equal(mainRow.dirty, true)
  assert.equal(mainRow.locked, false)
  assert.equal(mainRow.prunable, false)
  assert.equal(mainRow.lastCommitAt, isoAt(3))

  const featRow = byBranch.get('feat/x')
  assert.equal(featRow.mergedIntoBase, false)
  assert.equal(featRow.aheadOfBase, 1)
  assert.equal(featRow.behindOfBase, 1)
  assert.equal(featRow.upstream, null)
  assert.equal(featRow.modifiedCount, 0)
  assert.equal(featRow.untrackedCount, 0)
  assert.equal(featRow.dirty, false)
  assert.equal(featRow.lastCommitAt, isoAt(4))

  const mergedRow = byBranch.get('feat/merged')
  assert.equal(mergedRow.mergedIntoBase, true)
  assert.equal(mergedRow.locked, true)

  // prunable：目录被删掉但 worktree 记录还在
  const wtGone = join(root, 'wt-gone')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/gone', wtGone])
  await rm(wtGone, { recursive: true, force: true })
  const withGone = await collectGitWorkspaces([repo])
  const goneRow = withGone.repos[0].worktrees.find(row => row.branch === 'feat/gone')
  assert.ok(goneRow)
  assert.equal(goneRow.prunable, true)
  assert.equal(goneRow.locked, false)
})

// ---------------- Phase B：POST /git/worktrees/cleanup ----------------

/** 建一个「主工作副本 + 一个从 main 分出的干净工作副本」，返回常用路径。 */
async function makeCleanupFixture(t, { branch = 'feat/clean', name = 'wt' } = {}) {
  const { root, repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  const wt = join(root, name)
  await git(repo, ['worktree', 'add', '-q', '-b', branch, wt])
  const realRepo = await realpath(repo)
  const realWt = await realpath(wt)
  return { root, repo, wt, realRepo, realWt }
}

test('cleanup：正常软删除（移入回收站 + prune，保留分支）', async t => {
  const { server, trashRoot } = await setupServer(t)
  const { repo, wt, realRepo, realWt } = await makeCleanupFixture(t)
  await createCard(server, { cwd: repo })
  const state = await api(server, '/api/kanban/state')

  const res = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.revision, state.json.revision)
  const { cleanup: result } = res.json
  assert.equal(result.repoRoot, realRepo)
  assert.equal(result.worktreePath, realWt)
  assert.equal(result.branchName, 'feat/clean')
  assert.equal(result.branchDeleted, false)
  assert.equal(result.trashRetentionDays, 7)
  assert.match(result.trashedTo, /\/\d{8}-\d{6}-repo-wt$/)
  assert.equal(await exists(result.trashedTo), true)
  assert.equal(await exists(realWt), false)
  assert.equal(await exists(join(result.trashedTo, 'a.txt')), true)
  // prune 后 git 不再记录该工作副本；分支保留
  const listed = await git(repo, ['worktree', 'list', '--porcelain'])
  assert.equal(listed.includes(realWt), false)
  assert.equal(await git(repo, ['branch', '--list', 'feat/clean']), 'feat/clean')

  // 同仓库再来一个同名 basename 的工作副本：二次清理命名不冲突
  const { repo: repo2, wt: wt2 } = await (async () => {
    const fixture = await initRepo(t, 'repo2')
    await commitFile(fixture.repo, 'A2 初始提交', 2, 'a.txt', 'a\n')
    const second = join(fixture.root, 'wt')
    await git(fixture.repo, ['worktree', 'add', '-q', '-b', 'feat/clean2', second])
    return { repo: fixture.repo, wt: second }
  })()
  await createCard(server, { cwd: repo2 })
  const res2 = await cleanup(server, { repoRoot: repo2, worktreePath: wt2 })
  assert.equal(res2.status, 200, res2.text)
  assert.equal(await exists(res2.json.cleanup.trashedTo), true)
  assert.notEqual(res2.json.cleanup.trashedTo, result.trashedTo)
})

test('cleanup：deleteBranch 删已合并分支（git branch -d）', async t => {
  const { server } = await setupServer(t)
  const { repo, wt } = await makeCleanupFixture(t, { branch: 'feat/merged' })
  await createCard(server, { cwd: repo })

  const res = await cleanup(server, { repoRoot: repo, worktreePath: wt, deleteBranch: true })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.cleanup.branchName, 'feat/merged')
  assert.equal(res.json.cleanup.branchDeleted, true)
  assert.equal(await exists(res.json.cleanup.trashedTo), true)
  assert.equal(await git(repo, ['branch', '--list', 'feat/merged']), '')
  // 分支确实没了，工作副本记录也清掉
  const listed = await git(repo, ['worktree', 'list', '--porcelain'])
  assert.equal(listed.includes(await realpath(wt).catch(() => wt)), false)
})

test('cleanup：未合并分支需 confirmLoss，确认后用 -D 删分支', async t => {
  const { server } = await setupServer(t)
  const { repo, wt } = await makeCleanupFixture(t, { branch: 'feat/unmerged' })
  await commit(wt, 'C 未合并提交', 2)
  await createCard(server, { cwd: repo })

  const refused = await cleanup(server, { repoRoot: repo, worktreePath: wt, deleteBranch: true })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'WORKTREE_UNMERGED')
  assert.equal(refused.json.ahead, 1)
  assert.equal(await exists(wt), true) // 拒绝时不做任何移动

  const confirmed = await cleanup(server, {
    repoRoot: repo, worktreePath: wt, deleteBranch: true, confirmLoss: true,
  })
  assert.equal(confirmed.status, 200, confirmed.text)
  assert.equal(confirmed.json.cleanup.branchDeleted, true)
  assert.equal(await git(repo, ['branch', '--list', 'feat/unmerged']), '')
})

test('cleanup：脏工作副本（已跟踪改动 / 仅未跟踪）需 confirmLoss，trash 保留改动文件', async t => {
  const { server } = await setupServer(t)
  const { repo, wt } = await makeCleanupFixture(t, { branch: 'feat/dirty' })
  await writeFile(join(wt, 'a.txt'), 'changed\n', 'utf8')
  await createCard(server, { cwd: repo })

  const refused = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'WORKTREE_DIRTY')
  assert.equal(refused.json.modifiedCount, 1)
  assert.equal(refused.json.untrackedCount, 0)
  assert.equal(await exists(wt), true)

  // 仅未跟踪文件也算「需要确认损失」
  const { root: root2, repo: repo2 } = await initRepo(t, 'repo-untracked')
  await commitFile(repo2, 'A 初始提交', 3, 'a.txt', 'a\n')
  const wt2 = join(root2, 'wt')
  await git(repo2, ['worktree', 'add', '-q', '-b', 'feat/untracked', wt2])
  await writeFile(join(wt2, 'new.txt'), 'new\n', 'utf8')
  await createCard(server, { cwd: repo2 })
  const refused2 = await cleanup(server, { repoRoot: repo2, worktreePath: wt2 })
  assert.equal(refused2.status, 409)
  assert.equal(refused2.json.error.code, 'WORKTREE_DIRTY')
  assert.equal(refused2.json.untrackedCount, 1)

  const confirmed = await cleanup(server, { repoRoot: repo, worktreePath: wt, confirmLoss: true })
  assert.equal(confirmed.status, 200, confirmed.text)
  assert.equal(await readFile(join(confirmed.json.cleanup.trashedTo, 'a.txt'), 'utf8'), 'changed\n')
})

test('cleanup：主工作副本拒绝 400 WORKTREE_MAIN', async t => {
  const { server } = await setupServer(t)
  const { repo } = await makeCleanupFixture(t)
  await createCard(server, { cwd: repo })
  const res = await cleanup(server, { repoRoot: repo, worktreePath: repo })
  assert.equal(res.status, 400)
  assert.equal(res.json.error.code, 'WORKTREE_MAIN')
})

test('cleanup：有未完成卡片占用时 409 WORKTREE_IN_USE（归档后可清理）', async t => {
  const { server } = await setupServer(t)
  const { repo, wt } = await makeCleanupFixture(t, { branch: 'feat/used' })
  await createCard(server, { cwd: repo })
  await mkdir(join(wt, 'sub'))
  const usingCard = await createCard(server, { cwd: join(wt, 'sub') })

  const refused = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'WORKTREE_IN_USE')
  assert.equal(refused.json.count, 1)
  assert.equal(refused.json.cards[0].id, usingCard.id)
  assert.equal(await exists(wt), true)

  // 归档占用卡片后即可清理
  assert.equal((await api(server, `/api/kanban/cards/${usingCard.id}?version=1`, { method: 'DELETE' })).status, 200)
  const allowed = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(allowed.status, 200, allowed.text)
  assert.equal(await exists(wt), false)
})

test('cleanup：只有 done/canceled 终态卡片占用时允许清理（v0.21.0 #15）', async t => {
  const { server } = await setupServer(t)
  const { repo, wt, realWt } = await makeCleanupFixture(t, { branch: 'feat/settled' })
  // 卡片 cwd 都落在目标工作副本内，但都已收口为终态
  await mkdir(join(wt, 'done-dir'))
  await mkdir(join(wt, 'canceled-dir'))
  const doneCard = await createCard(server, { title: '已完成卡片', cwd: join(wt, 'done-dir'), status: 'done' })
  const canceledCard = await createCard(server, { title: '已取消卡片', cwd: join(wt, 'canceled-dir'), status: 'canceled' })
  assert.equal(doneCard.status, 'done')
  assert.equal(canceledCard.status, 'canceled')

  const res = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(res.status, 200, res.text)
  assert.equal(await exists(realWt), false)
})

test('cleanup：终态卡片 cwd 仍进入探测允许集合，工作区地图可见（v0.21.0 #15）', async t => {
  const { server } = await setupServer(t)
  const { repo, realWt } = await makeCleanupFixture(t)
  const doneCard = await createCard(server, { title: '已完成卡片', cwd: repo, status: 'done' })

  // allowedCardDirs 不变：done 卡片 cwd（repo）仍被接受，不落 unavailable:forbidden
  const res = await api(server, '/api/kanban/git/workspaces', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(res.json.unavailable, [])
  assert.equal(res.json.repos.length, 1)
  assert.equal(res.json.repos[0].root, await realpath(repo))
  assert.equal(res.json.repos[0].worktrees.some(row => row.path === realWt), true)
  // done 卡片仍在 /state 里，cwd 原样保留
  const state = await api(server, '/api/kanban/state')
  assert.equal(state.json.cards.find(card => card.id === doneCard.id).cwd, repo)
})

test('cleanup：混有未完成卡片时仍 409，count/details 只数未完成卡片（v0.21.0 #15）', async t => {
  const { server } = await setupServer(t)
  const { repo, wt } = await makeCleanupFixture(t, { branch: 'feat/mixed' })
  for (const dir of ['done', 'canceled', 'running', 'backlog']) await mkdir(join(wt, dir))
  const doneCard = await createCard(server, { title: '已完成', cwd: join(wt, 'done'), status: 'done' })
  const canceledCard = await createCard(server, { title: '已取消', cwd: join(wt, 'canceled'), status: 'canceled' })
  const runningCard = await createCard(server, { title: '进行中', cwd: join(wt, 'running'), status: 'running' })
  const backlogCard = await createCard(server, { title: '待办', cwd: join(wt, 'backlog'), status: 'backlog' })

  const refused = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'WORKTREE_IN_USE')
  // 只数未完成卡片：done + canceled 不算占用
  assert.equal(refused.json.count, 2)
  assert.match(refused.json.error.message, /2 张未完成卡片使用/)
  assert.deepEqual(
    refused.json.cards.map(card => card.id).sort(),
    [runningCard.id, backlogCard.id].sort(),
  )
  assert.equal(refused.json.cards.some(card => card.id === doneCard.id || card.id === canceledCard.id), false)
  assert.equal(await exists(wt), true)

  // 两张未完成卡片收口后即可清理
  const finish = await api(server, `/api/kanban/cards/${runningCard.id}`, {
    method: 'PATCH', body: { version: 1, changes: { status: 'done' } },
  })
  assert.equal(finish.status, 200, finish.text)
  const cancel = await api(server, `/api/kanban/cards/${backlogCard.id}`, {
    method: 'PATCH', body: { version: 1, changes: { status: 'canceled' } },
  })
  assert.equal(cancel.status, 200, cancel.text)

  const allowed = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(allowed.status, 200, allowed.text)
  assert.equal(await exists(wt), false)
})

test('cleanup：不在卡片 cwd 推导出的仓库/工作副本里 → 404', async t => {
  const { server } = await setupServer(t)
  const { repo } = await makeCleanupFixture(t)
  await createCard(server, { cwd: repo })

  // 另一个仓库（没有任何卡片 cwd 指向它）
  const other = await initRepo(t, 'other-repo')
  await commitFile(other.repo, 'O1 初始提交', 1, 'o.txt', 'o\n')
  const otherWt = join(other.root, 'wt-other')
  await git(other.repo, ['worktree', 'add', '-q', '-b', 'feat/other', otherWt])
  const foreign = await cleanup(server, { repoRoot: other.repo, worktreePath: otherWt })
  assert.equal(foreign.status, 404)
  assert.equal(foreign.json.error.code, 'NOT_FOUND')
  assert.equal(await exists(otherWt), true)

  const missing = await cleanup(server, { repoRoot: repo, worktreePath: join(repo, 'nope') })
  assert.equal(missing.status, 404)
})

test('cleanup：非法 body → 400 BAD_REQUEST', async t => {
  const { server } = await setupServer(t)
  const cases = [
    {},
    { repoRoot: '' },
    { repoRoot: 123, worktreePath: '/tmp/x' },
    { repoRoot: '/tmp/x', worktreePath: 123 },
    { repoRoot: '/tmp/x', worktreePath: '/tmp/y', deleteBranch: 'yes' },
    { repoRoot: '/tmp/x', worktreePath: '/tmp/y', confirmLoss: 1 },
  ]
  for (const body of cases) {
    const res = await cleanup(server, body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(res.json.error.code, 'BAD_REQUEST')
  }
})

test('cleanup：非 POST 405，未知子路径 404', async t => {
  const { server } = await setupServer(t)
  const get = await api(server, '/api/kanban/git/worktrees/cleanup')
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
  const unknown = await api(server, '/api/kanban/git/worktrees/other', { method: 'POST', body: {} })
  assert.equal(unknown.status, 404)
})

test('cleanup：locked 工作副本也能清理（先解锁再 prune）', async t => {
  const { server } = await setupServer(t)
  const { repo, wt, realWt } = await makeCleanupFixture(t, { branch: 'feat/locked' })
  await git(repo, ['worktree', 'lock', wt])
  await createCard(server, { cwd: repo })

  const res = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(res.status, 200, res.text)
  assert.equal(await exists(realWt), false)
  const listed = await git(repo, ['worktree', 'list', '--porcelain'])
  assert.equal(listed.includes(realWt), false)
})

test('cleanup：回收站里超过 7 天的条目被尽力清理，新的保留', async t => {
  const { server, trashRoot } = await setupServer(t)
  const { repo, wt } = await makeCleanupFixture(t, { branch: 'feat/trash' })
  await createCard(server, { cwd: repo })

  const oldEntry = join(trashRoot, '20200101-000000-old-repo-wt')
  const freshEntry = join(trashRoot, `${trashTimestamp()}-keep-repo-wt`)
  await mkdir(oldEntry, { recursive: true })
  await writeFile(join(oldEntry, 'old.txt'), 'old\n', 'utf8')
  await mkdir(freshEntry, { recursive: true })
  await writeFile(join(freshEntry, 'keep.txt'), 'keep\n', 'utf8')

  const res = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(res.status, 200, res.text)
  assert.equal(await exists(oldEntry), false)
  assert.equal(await exists(freshEntry), true)
  assert.equal(await exists(res.json.cleanup.trashedTo), true)
})

test('cleanup：deleteBranch 指向主分支 → 400 BRANCH_MAIN', async t => {
  const { server } = await setupServer(t)
  const { root, repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  // 主工作副本切到 dev，把 main 让给 linked worktree（这样目标不是主工作副本，但分支是主分支）
  await git(repo, ['checkout', '-q', '-b', 'dev'])
  const wtMain = join(root, 'wt-main')
  await git(repo, ['worktree', 'add', '-q', wtMain, 'main'])
  await createCard(server, { cwd: repo })

  const res = await cleanup(server, { repoRoot: repo, worktreePath: wtMain, deleteBranch: true })
  assert.equal(res.status, 400)
  assert.equal(res.json.error.code, 'BRANCH_MAIN')
  assert.equal(await exists(wtMain), true)
})

test('cleanup：成功后工作区地图缓存立即失效（刷新后不再出现目标）', async t => {
  const { server } = await setupServer(t)
  const { repo, wt, realWt } = await makeCleanupFixture(t, { branch: 'feat/cache' })
  await createCard(server, { cwd: repo })

  // 先请求一次工作区地图，把「2 个工作副本」写进 8s 缓存
  const before = await api(server, '/api/kanban/git/workspaces', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(before.json.repos[0].worktrees.length, 2)

  const cleaned = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(cleaned.status, 200, cleaned.text)

  const after = await api(server, '/api/kanban/git/workspaces', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(after.json.repos[0].worktrees.length, 1)
  assert.equal(after.json.repos[0].worktrees.some(row => row.path === realWt), false)
})
