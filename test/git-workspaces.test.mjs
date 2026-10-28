// v0.16 工作区地图：collectGitWorkspaces（按仓库聚合工作副本）与
// POST /api/kanban/git/workspaces（允许集合 / 校验 / 缓存）的测试。
// 全部用 os.tmpdir() 下的真实临时仓库，离线、提交身份与时间固定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectGitWorkspaces } from '../lib/git.js'
import { createRoutes } from '../lib/routes.js'
import { api, tempDir, testStore } from './helpers.mjs'

const execFileAsync = promisify(execFile)
/** 固定提交时间基线（同其它 git 测试），保证 ahead/behind 可重复。 */
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

/** 空提交（不改文件）。 */
async function commit(cwd, subject, seq) {
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', subject], { cwd, env: stampedEnv(seq) })
  return git(cwd, ['rev-parse', 'HEAD'])
}

/** 带文件改动的提交（dirty 测试需要被跟踪的文件）。 */
async function commitFile(cwd, subject, seq, file, content) {
  await writeFile(join(cwd, file), content, 'utf8')
  await git(cwd, ['add', file])
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], { cwd, env: stampedEnv(seq) })
  return git(cwd, ['rev-parse', 'HEAD'])
}

async function initRepo(t, name = 'repo', { branch = 'main' } = {}) {
  const root = await tempDir(t, 'dsh-git-workspaces-')
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '-q', '-b', branch])
  return { root, repo }
}

// ---------------- collectGitWorkspaces ----------------

test('collectGitWorkspaces：多 dir 同仓库去重 + linked worktree 的 isMain/isCurrent/ahead/behind', async t => {
  const { root, repo } = await initRepo(t)
  const shaA = await commitFile(repo, 'A 初始提交', 1, 'file.txt', 'a\n')
  await commit(repo, 'B 主分支提交', 2)
  const wtFeat = join(root, 'wt-feat')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/x', wtFeat, shaA])
  await commit(wtFeat, 'C 分支提交', 3)
  await mkdir(join(repo, 'sub'))
  await mkdir(join(wtFeat, 'sub2'))
  const realRepo = await realpath(repo)
  const realWtFeat = await realpath(wtFeat)

  // 同一个仓库的 4 个目录 + 一个重复目录 → 只返回 1 个仓库
  const { repos, unavailable } = await collectGitWorkspaces([repo, join(repo, 'sub'), wtFeat, join(wtFeat, 'sub2'), repo])
  assert.deepEqual(unavailable, [])
  assert.equal(repos.length, 1)
  const [entry] = repos
  assert.equal(entry.root, realRepo)
  assert.equal(entry.name, realRepo.split('/').at(-1))
  assert.equal(entry.commonDir, await realpath(join(repo, '.git')))
  assert.equal(entry.mainBranch, 'main')
  assert.equal(entry.worktrees.length, 2)

  const [mainRow, featRow] = entry.worktrees
  assert.deepEqual(mainRow, {
    path: realRepo,
    branch: 'main',
    detached: false,
    sha: await git(repo, ['rev-parse', 'main']),
    shortSha: (await git(repo, ['rev-parse', 'main'])).slice(0, 7),
    isMain: true,
    isCurrent: true, // repo 与 repo/sub 都在主工作副本里
    aheadOfBase: 0,
    behindOfBase: 0,
    dirty: false,
    // 请求目录→工作副本的精确映射（原文），供前端归组（含符号链接写法的目录）
    dirs: [repo, join(repo, 'sub')],
    // v0.17 Phase A 增量字段
    mergedIntoBase: true,
    upstream: null,
    modifiedCount: 0,
    untrackedCount: 0, // sub/ 是空目录，git 不统计空目录
    locked: false,
    prunable: false,
    lastCommitAt: '2026-01-01T00:00:02+00:00',
  })
  assert.equal(featRow.path, realWtFeat)
  assert.equal(featRow.branch, 'feat/x')
  assert.equal(featRow.detached, false)
  assert.equal(featRow.isMain, false)
  assert.equal(featRow.isCurrent, true) // wtFeat 与 wtFeat/sub2 都在这个工作副本里
  // feat/x 从 A 分出、提交 C；main 在 A 之后有 B → 领先 1、落后 1
  assert.equal(featRow.aheadOfBase, 1)
  assert.equal(featRow.behindOfBase, 1)
  assert.equal(featRow.dirty, false)
  assert.deepEqual(featRow.dirs, [wtFeat, join(wtFeat, 'sub2')])
  // v0.17 Phase A 增量字段
  assert.equal(featRow.mergedIntoBase, false)
  assert.equal(featRow.upstream, null)
  assert.equal(featRow.modifiedCount, 0)
  assert.equal(featRow.untrackedCount, 0) // sub2/ 是空目录，git 不统计空目录
  assert.equal(featRow.locked, false)
  assert.equal(featRow.prunable, false)
  assert.equal(featRow.lastCommitAt, '2026-01-01T00:00:03+00:00')

  // 符号链接写法：请求 dir 原文与 git 返回的 realpath 不一致，也要能映射到工作副本
  const alias = join(root, 'alias-repo')
  await symlink(repo, alias)
  const aliased = await collectGitWorkspaces([alias])
  assert.equal(aliased.repos.length, 1)
  assert.equal(aliased.repos[0].worktrees[0].path, realRepo)
  assert.deepEqual(aliased.repos[0].worktrees[0].dirs, [alias])
})

test('collectGitWorkspaces：dirty 只看已跟踪改动（--untracked-files=no）', async t => {
  const { root, repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'file.txt', 'a\n')
  await commit(repo, 'B 主分支提交', 2)
  const wtFeat = join(root, 'wt-feat')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/x', wtFeat])

  // 主工作副本：改动已跟踪文件 → dirty:true；feat 工作副本：只有 untracked 文件 → dirty:false
  await writeFile(join(repo, 'file.txt'), 'changed\n', 'utf8')
  await writeFile(join(wtFeat, 'untracked.txt'), 'new\n', 'utf8')
  let result = await collectGitWorkspaces([repo, wtFeat])
  let rows = result.repos[0].worktrees
  assert.equal(rows.find(row => row.isMain).dirty, true)
  assert.equal(rows.find(row => !row.isMain).dirty, false)

  // 恢复已跟踪文件 → 主工作副本也干净；untracked 仍被忽略
  await git(repo, ['checkout', '--', 'file.txt'])
  result = await collectGitWorkspaces([repo, wtFeat])
  rows = result.repos[0].worktrees
  assert.equal(rows.every(row => row.dirty === false), true)
})

test('collectGitWorkspaces：主分支探测（master）与探测不到（trunk → mainBranch null）', async t => {
  const master = await initRepo(t, 'master-repo', { branch: 'master' })
  const shaA = await commit(master.repo, 'M1 初始提交', 1)
  const wt = join(master.root, 'wt-topic')
  await git(master.repo, ['worktree', 'add', '-q', '-b', 'topic', wt, shaA])
  await commit(wt, 'M2 分支提交', 2)

  const masterResult = await collectGitWorkspaces([master.repo, wt])
  assert.equal(masterResult.repos.length, 1)
  assert.equal(masterResult.repos[0].mainBranch, 'master')
  const topicRow = masterResult.repos[0].worktrees.find(row => row.branch === 'topic')
  assert.equal(topicRow.aheadOfBase, 1)
  assert.equal(topicRow.behindOfBase, 0)

  const trunk = await initRepo(t, 'trunk-repo', { branch: 'trunk' })
  await commit(trunk.repo, 'T1 初始提交', 1)
  const trunkResult = await collectGitWorkspaces([trunk.repo])
  assert.equal(trunkResult.repos.length, 1)
  assert.equal(trunkResult.repos[0].mainBranch, null)
  assert.equal(trunkResult.repos[0].worktrees[0].aheadOfBase, null)
  assert.equal(trunkResult.repos[0].worktrees[0].behindOfBase, null)
})

test('collectGitWorkspaces：工作副本上限 12，主工作副本与请求目录所在副本优先保留', async t => {
  const { root, repo } = await initRepo(t)
  await commit(repo, 'A 初始提交', 1)
  for (let index = 1; index <= 14; index += 1) {
    await git(repo, ['worktree', 'add', '-q', '-b', `b${index}`, join(root, `wt-${index}`)])
  }
  const lastWorktree = join(root, 'wt-14')
  const realLastWorktree = await realpath(lastWorktree)

  const { repos, unavailable } = await collectGitWorkspaces([repo, lastWorktree])
  assert.deepEqual(unavailable, [])
  assert.equal(repos.length, 1)
  const { worktrees } = repos[0]
  assert.equal(worktrees.length, 12) // 主工作副本 + 14 个 linked，截到 12
  assert.equal(worktrees[0].isMain, true)
  assert.equal(worktrees[0].isCurrent, true)
  const currentRows = worktrees.filter(row => row.isCurrent)
  assert.equal(currentRows.length, 2) // 主工作副本 + 请求的 wt-14
  assert.equal(currentRows.some(row => row.path === realLastWorktree), true)
})

test('collectGitWorkspaces：missing / not_git / 空仓库 / 裸仓库的收敛', async t => {
  const root = await tempDir(t, 'dsh-git-workspaces-')
  const plain = join(root, 'plain')
  await mkdir(plain)
  const bare = join(root, 'bare.git')
  await git(root, ['init', '-q', '--bare', '-b', 'main', bare])

  const { repos, unavailable } = await collectGitWorkspaces([join(root, 'missing'), plain, bare])
  assert.deepEqual(repos, [])
  assert.deepEqual(unavailable, [
    { dir: join(root, 'missing'), reason: 'missing' },
    { dir: plain, reason: 'not_git' },
    { dir: bare, reason: 'not_git' },
  ])

  // 空仓库（unborn HEAD）：照常返回仓库，工作副本 sha 为 null、ahead/behind 为 null
  const empty = join(root, 'empty')
  await mkdir(empty)
  await git(empty, ['init', '-q', '-b', 'main'])
  const emptyResult = await collectGitWorkspaces([empty])
  assert.deepEqual(emptyResult.unavailable, [])
  assert.equal(emptyResult.repos.length, 1)
  const row = emptyResult.repos[0].worktrees[0]
  assert.equal(row.sha, null)
  assert.equal(row.shortSha, null)
  assert.equal(row.aheadOfBase, null)
  assert.equal(row.behindOfBase, null)
  assert.equal(emptyResult.repos[0].mainBranch, null)
})

// ---------------- POST /git/workspaces ----------------

/** 与 test/helpers.mjs 的 startServer 一致，只是额外支持注入 createRoutes 选项（缓存 TTL）。 */
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
  const { store } = await testStore(t, { seedMode: options.seedMode })
  const server = await startServer(t, { store, ...options })
  return { store, server }
}

async function createCard(server, body = {}) {
  const res = await api(server, '/api/kanban/cards', { method: 'POST', body: { title: '工作区卡片', ...body } })
  assert.equal(res.status, 200, res.text)
  return res.json.card
}

test('POST /git/workspaces：非法 body 一律 400 BAD_REQUEST', async t => {
  const { server } = await setupServer(t)
  const tooMany = Array.from({ length: 33 }, (_, index) => `/tmp/dir-${index}`)
  const cases = [
    {},
    { dirs: null },
    { dirs: 'not-array' },
    { dirs: [] },
    { dirs: tooMany },
    { dirs: [''] },
    { dirs: ['   '] },
    { dirs: [1] },
    { dirs: [null] },
    { dirs: ['/tmp/a', 2] },
  ]
  for (const body of cases) {
    const res = await api(server, '/api/kanban/git/workspaces', { method: 'POST', body })
    assert.equal(res.status, 400, `body=${JSON.stringify(body)}`)
    assert.equal(res.json.error.code, 'BAD_REQUEST')
  }
})

test('POST /git/workspaces：允许集合=未归档卡 cwd，其余进 unavailable（request 顺序）', async t => {
  const { server } = await setupServer(t)
  const { repo } = await initRepo(t, 'allowed')
  await commit(repo, 'A 初始提交', 1)
  const plain = await tempDir(t, 'dsh-git-workspaces-plain-')
  const missing = join(plain, 'gone')
  const archivedRepo = await (async () => {
    const created = await initRepo(t, 'archived')
    await commit(created.repo, 'A 初始提交', 1)
    return created.repo
  })()

  await createCard(server, { cwd: repo })
  await createCard(server, { cwd: plain })
  await createCard(server, { cwd: missing })
  const archivedCard = await createCard(server, { cwd: archivedRepo })
  assert.equal((await api(server, `/api/kanban/cards/${archivedCard.id}?version=1`, { method: 'DELETE' })).status, 200)
  const unlisted = await tempDir(t, 'dsh-git-workspaces-unlisted-')
  const spaced = ` ${repo} `

  const state = await api(server, '/api/kanban/state')
  const res = await api(server, '/api/kanban/git/workspaces', {
    method: 'POST',
    body: { dirs: [repo, plain, missing, unlisted, archivedRepo, spaced] },
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.revision, state.json.revision)
  assert.equal(res.json.repos.length, 1)
  assert.equal(res.json.repos[0].root, await realpath(repo))
  // 请求原文里带空格的 dir 也被允许集合（trim）命中，不会重复出现
  assert.deepEqual(res.json.unavailable, [
    { dir: plain, reason: 'not_git' },
    { dir: missing, reason: 'missing' },
    { dir: unlisted, reason: 'forbidden' },
    { dir: archivedRepo, reason: 'forbidden' },
  ])
})

test('POST /git/workspaces：同仓库多个 dir 去重成一个 repos 项，并标记 isCurrent', async t => {
  const { server } = await setupServer(t)
  const { root, repo } = await initRepo(t)
  await commit(repo, 'A 初始提交', 1)
  const wt = join(root, 'wt-feat')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/x', wt])
  await mkdir(join(repo, 'sub'))
  await createCard(server, { cwd: repo })
  await createCard(server, { cwd: join(repo, 'sub') })
  await createCard(server, { cwd: wt })

  const res = await api(server, '/api/kanban/git/workspaces', {
    method: 'POST',
    body: { dirs: [repo, join(repo, 'sub'), wt, repo] },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.unavailable, [])
  assert.equal(res.json.repos.length, 1)
  const worktrees = res.json.repos[0].worktrees
  assert.equal(worktrees.length, 2)
  assert.equal(worktrees.filter(row => row.isCurrent).length, 2) // 主工作副本 + feat worktree 都有卡片
  assert.equal(worktrees.every(row => typeof row.dirty === 'boolean'), true)
})

test('POST /git/workspaces：按仓库缓存 8s（缓存期内不再重新采集）', async t => {
  const { server } = await setupServer(t)
  const { repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'file.txt', 'a\n')
  await createCard(server, { cwd: repo })

  const first = await api(server, '/api/kanban/git/workspaces', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(first.json.repos[0].worktrees[0].dirty, false)

  // 缓存期内改动已跟踪文件：仍返回缓存里的 dirty:false
  await writeFile(join(repo, 'file.txt'), 'changed\n', 'utf8')
  const second = await api(server, '/api/kanban/git/workspaces', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(second.status, 200)
  assert.equal(second.json.repos[0].worktrees[0].dirty, false)
})

test('POST /git/workspaces：缓存 TTL 过期后重新采集（dirty 变化可见）', async t => {
  const { server } = await setupServer(t, { gitWorkspaceCacheTtlMs: 50 })
  const { repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'file.txt', 'a\n')
  await createCard(server, { cwd: repo })

  const first = await api(server, '/api/kanban/git/workspaces', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(first.json.repos[0].worktrees[0].dirty, false)
  await writeFile(join(repo, 'file.txt'), 'changed\n', 'utf8')
  await new Promise(resolve => setTimeout(resolve, 120)) // 越过 50ms TTL
  const second = await api(server, '/api/kanban/git/workspaces', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(second.json.repos[0].worktrees[0].dirty, true)
})

test('POST /git/workspaces：非 POST 405，未知子路径 404', async t => {
  const { server } = await setupServer(t)
  const get = await api(server, '/api/kanban/git/workspaces')
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
  const unknown = await api(server, '/api/kanban/git/unknown', { method: 'POST', body: { dirs: ['/tmp/x'] } })
  assert.equal(unknown.status, 404)
})
