// v0.15 批量 Git 摘要：collectGitSummary（轻量工作线摘要）与
// POST /api/kanban/git/summaries（允许集合 / 校验 / 缓存）的测试。
// 全部用 os.tmpdir() 下的真实临时仓库，离线、提交身份与时间固定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectGitSummary } from '../lib/git.js'
import { createRoutes } from '../lib/routes.js'
import { api, tempDir, testStore } from './helpers.mjs'

const execFileAsync = promisify(execFile)
/** 固定提交时间基线（同 git.test.mjs），保证 ahead/behind 与排序可重复。 */
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

/** 发起一个空提交，seq 决定固定的作者/提交时间。 */
async function commit(cwd, subject, seq) {
  const stamp = `@${BASE_EPOCH + seq} +0000`
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', subject], { cwd, env })
  return git(cwd, ['rev-parse', 'HEAD'])
}

async function initRepo(t, name = 'repo', { branch = 'main' } = {}) {
  const root = await tempDir(t, 'dsh-git-summary-')
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '-q', '-b', branch])
  return { root, repo }
}

/** 建一个带 origin 裸远端、main 已 push -u 的仓库。 */
async function initOriginRepo(t, name = 'repo') {
  const root = await tempDir(t, 'dsh-git-summary-')
  const remoteDir = join(root, 'origin.git')
  await git(root, ['init', '-q', '--bare', '-b', 'main', remoteDir])
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '-q', '-b', 'main'])
  const shaA = await commit(repo, 'A 初始提交', 1)
  await git(repo, ['remote', 'add', 'origin', remoteDir])
  await git(repo, ['push', '-q', '-u', 'origin', 'main'])
  return { root, repo, remoteDir, shaA }
}

// ---------------- collectGitSummary ----------------

test('collectGitSummary：feature 工作线（相对主分支与 upstream 的 ahead/behind）', async t => {
  const { root, repo } = await initOriginRepo(t)
  await git(repo, ['checkout', '-q', '-b', 'feat/x'])
  await commit(repo, 'F1 分支提交', 2)
  await git(repo, ['push', '-q', '-u', 'origin', 'feat/x'])
  await commit(repo, 'F2 分支提交', 3) // 本地未推 → 领先 upstream 1
  // 远端 main 前进 1（不影响 base：feature 始终与本地 main 比）
  const other = join(root, 'other')
  await git(root, ['clone', '-q', join(root, 'origin.git'), other])
  await commit(other, 'E1 远端提交', 4)
  await git(other, ['push', '-q', 'origin', 'main'])
  await git(repo, ['fetch', '-q', 'origin'])

  const realRepo = await realpath(repo)
  assert.deepEqual(await collectGitSummary(repo), {
    available: true,
    dir: realRepo,
    branch: 'feat/x',
    detached: false,
    mainBranch: 'main',
    base: { kind: 'main', ahead: 2, behind: 0 },
    upstream: { ref: 'origin/feat/x', ahead: 1, behind: 0 },
    isWorktree: false,
    worktreePath: realRepo,
  })
})

test('collectGitSummary：主线分支 base.kind=upstream；无 upstream 仓库为 0/0 + null', async t => {
  const { root, repo } = await initOriginRepo(t)
  const other = join(root, 'other')
  await git(root, ['clone', '-q', join(root, 'origin.git'), other])
  await commit(other, 'E1 远端提交', 2)
  await git(other, ['push', '-q', 'origin', 'main'])
  await git(repo, ['fetch', '-q', 'origin'])

  const onMain = await collectGitSummary(repo)
  assert.equal(onMain.available, true)
  assert.equal(onMain.branch, 'main')
  assert.equal(onMain.mainBranch, 'main')
  assert.deepEqual(onMain.base, { kind: 'upstream', ahead: 0, behind: 1 })
  assert.deepEqual(onMain.upstream, { ref: 'origin/main', ahead: 0, behind: 1 })

  // 纯本地仓库（无远端 / 无 upstream）：主线自身 0/0，upstream=null
  const local = await initRepo(t, 'local')
  await commit(local.repo, 'L1 初始提交', 1)
  const noUpstream = await collectGitSummary(local.repo)
  assert.equal(noUpstream.available, true)
  assert.equal(noUpstream.branch, 'main')
  assert.equal(noUpstream.mainBranch, 'main')
  assert.deepEqual(noUpstream.base, { kind: 'main', ahead: 0, behind: 0 })
  assert.equal(noUpstream.upstream, null)

  // 探测不到主分支（trunk）：mainBranch=null，base 仍给 main/0/0（前端降级为 feature 但数值安全）
  const trunk = await initRepo(t, 'trunk', { branch: 'trunk' })
  await commit(trunk.repo, 'T1 初始提交', 1)
  const noMain = await collectGitSummary(trunk.repo)
  assert.equal(noMain.available, true)
  assert.equal(noMain.branch, 'trunk')
  assert.equal(noMain.mainBranch, null)
  assert.deepEqual(noMain.base, { kind: 'main', ahead: 0, behind: 0 })
  assert.equal(noMain.upstream, null)
})

test('collectGitSummary：linked worktree 与 detached HEAD', async t => {
  const { root, repo } = await initRepo(t)
  await commit(repo, 'A 初始提交', 1)
  await commit(repo, 'B 主分支提交', 2)
  const linked = join(root, 'wt-feat')
  await git(repo, ['worktree', 'add', '-q', '-b', 'wt-branch', linked])
  await commit(linked, 'C 工作树提交', 3)
  const realRepo = await realpath(repo)
  const realLinked = await realpath(linked)

  const fromMain = await collectGitSummary(repo)
  assert.equal(fromMain.isWorktree, false)
  assert.equal(fromMain.worktreePath, realRepo)
  assert.equal(fromMain.branch, 'main')

  const fromLinked = await collectGitSummary(linked)
  assert.equal(fromLinked.available, true)
  assert.equal(fromLinked.isWorktree, true)
  assert.equal(fromLinked.worktreePath, realLinked)
  assert.equal(fromLinked.dir, realLinked)
  assert.equal(fromLinked.branch, 'wt-branch')
  // wt-branch 从 main(B) 分出再提交 C：领先主线 1
  assert.deepEqual(fromLinked.base, { kind: 'main', ahead: 1, behind: 0 })

  // detached HEAD：branch=null，仍与主分支比较（HEAD 在 A，落后 main(B) 1）
  await git(repo, ['checkout', '-q', '--detach', (await git(repo, ['rev-parse', 'HEAD~1']))])
  const detached = await collectGitSummary(repo)
  assert.equal(detached.available, true)
  assert.equal(detached.detached, true)
  assert.equal(detached.branch, null)
  assert.equal(detached.mainBranch, 'main')
  assert.deepEqual(detached.base, { kind: 'main', ahead: 0, behind: 1 })
})

test('collectGitSummary：no_cwd / missing / not_git / no_commits 收敛为 available:false', async t => {
  const root = await tempDir(t, 'dsh-git-summary-')
  assert.deepEqual(await collectGitSummary(''), { available: false, reason: 'no_cwd' })
  assert.deepEqual(await collectGitSummary(undefined), { available: false, reason: 'no_cwd' })
  assert.deepEqual(await collectGitSummary(join(root, 'does-not-exist')), { available: false, reason: 'missing' })

  const plain = join(root, 'plain')
  await mkdir(plain)
  assert.deepEqual(await collectGitSummary(plain), { available: false, reason: 'not_git' })

  const empty = join(root, 'empty')
  await mkdir(empty)
  await git(empty, ['init', '-q', '-b', 'main'])
  assert.deepEqual(await collectGitSummary(empty), { available: false, reason: 'no_commits' })

  const bare = join(root, 'bare.git')
  await git(root, ['init', '-q', '--bare', '-b', 'main', bare])
  assert.deepEqual(await collectGitSummary(bare), { available: false, reason: 'not_git' })

  const plainFile = join(root, 'file.txt')
  await writeFile(plainFile, 'x')
  assert.deepEqual(await collectGitSummary(plainFile), { available: false, reason: 'missing' })
})

test('collectGitSummary：git 命令超时收敛为 reason=timeout', async t => {
  const { repo } = await initRepo(t)
  await commit(repo, 'A 初始提交', 1)
  // 把 PATH 最前面塞一个只会 sleep 的假 git，让单条 2s 超时生效
  const stubDir = await tempDir(t, 'dsh-git-stub-')
  await writeFile(join(stubDir, 'git'), '#!/bin/sh\nexec /bin/sleep 3\n', { mode: 0o755 })
  const originalPath = process.env.PATH
  process.env.PATH = `${stubDir}:${originalPath}`
  t.after(() => { process.env.PATH = originalPath })

  const startedAt = Date.now()
  const summary = await collectGitSummary(repo)
  const elapsed = Date.now() - startedAt
  assert.deepEqual(summary, { available: false, reason: 'timeout' })
  assert.ok(elapsed >= 1500, `应在 2s 左右被超时截断，实际 ${elapsed}ms`)
  assert.ok(elapsed < 3500, `不应远超单条命令超时，实际 ${elapsed}ms`)
})

// ---------------- POST /git/summaries ----------------

/** 与 test/helpers.mjs 的 startServer 一致，只是额外支持注入 createRoutes 选项（缓存 TTL）。 */
async function startServer(t, { store, gitSummaryCacheTtlMs } = {}) {
  await store.ready()
  const routes = createRoutes({
    store,
    version: '0.0.0-test',
    ...(gitSummaryCacheTtlMs === undefined ? {} : { gitSummaryCacheTtlMs }),
  })
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
  const res = await api(server, '/api/kanban/cards', { method: 'POST', body: { title: '工作线卡片', ...body } })
  assert.equal(res.status, 200, res.text)
  return res.json.card
}

/** 建一个只有初始提交的普通 git 仓库（main）。 */
async function makeGitRepo(t, name = 'repo') {
  const { repo } = await initRepo(t, name)
  await commit(repo, 'A 初始提交', 1)
  return repo
}

test('POST /git/summaries：非法 body 一律 400 BAD_REQUEST', async t => {
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
    const res = await api(server, '/api/kanban/git/summaries', { method: 'POST', body })
    assert.equal(res.status, 400, `body=${JSON.stringify(body)}`)
    assert.equal(res.json.error.code, 'BAD_REQUEST')
  }
})

test('POST /git/summaries：允许集合=未归档卡 cwd，其余 forbidden，key 用请求原文', async t => {
  const { server } = await setupServer(t)
  const repo = await makeGitRepo(t)
  const archivedRepo = await makeGitRepo(t, 'archived')
  const allowedCard = await createCard(server, { cwd: repo })
  const archivedCard = await createCard(server, { cwd: archivedRepo })
  // 归档后不应再在允许集合里
  assert.equal((await api(server, `/api/kanban/cards/${archivedCard.id}?version=1`, { method: 'DELETE' })).status, 200)
  const unlisted = await tempDir(t, 'dsh-git-summary-unlisted-')
  const spaced = ` ${repo} `

  const state = await api(server, '/api/kanban/state')
  const res = await api(server, '/api/kanban/git/summaries', {
    method: 'POST',
    body: { dirs: [repo, unlisted, archivedRepo, spaced] },
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.revision, state.json.revision)
  assert.deepEqual(Object.keys(res.json.summaries), [repo, unlisted, archivedRepo, spaced])

  const normal = res.json.summaries[repo]
  assert.equal(normal.available, true)
  assert.equal(normal.dir, await realpath(repo))
  assert.equal(normal.branch, 'main')
  assert.equal(normal.detached, false)
  assert.equal(normal.mainBranch, 'main')
  assert.deepEqual(normal.base, { kind: 'main', ahead: 0, behind: 0 })
  assert.equal(normal.upstream, null)
  assert.equal(normal.isWorktree, false)
  assert.equal(normal.worktreePath, await realpath(repo))

  // 未列入卡片 cwd / 已归档卡片的 cwd：批量容错，逐项 forbidden
  assert.deepEqual(res.json.summaries[unlisted], { available: false, reason: 'forbidden' })
  assert.deepEqual(res.json.summaries[archivedRepo], { available: false, reason: 'forbidden' })
  // 请求原文（含首尾空格）作为 key，但去空格后命中卡片 cwd → 正常采集
  assert.deepEqual(res.json.summaries[spaced], normal)
  assert.equal(allowedCard.cwd, repo)
})

test('POST /git/summaries：允许目录的可采集/不可采集都 200，逐项返回 reason', async t => {
  const { server } = await setupServer(t)
  const plain = await tempDir(t, 'dsh-git-summary-plain-')
  const emptyRepo = join(plain, 'empty')
  await mkdir(emptyRepo)
  await git(emptyRepo, ['init', '-q', '-b', 'main'])
  const missing = join(plain, 'gone')
  const normal = await makeGitRepo(t)

  await createCard(server, { cwd: plain })
  await createCard(server, { cwd: emptyRepo })
  await createCard(server, { cwd: missing })
  await createCard(server, { cwd: normal })

  const mixed = await api(server, '/api/kanban/git/summaries', {
    method: 'POST',
    body: { dirs: [plain, emptyRepo, missing, normal] },
  })
  assert.equal(mixed.status, 200)
  assert.deepEqual(mixed.json.summaries[plain], { available: false, reason: 'not_git' })
  assert.deepEqual(mixed.json.summaries[emptyRepo], { available: false, reason: 'no_commits' })
  assert.deepEqual(mixed.json.summaries[missing], { available: false, reason: 'missing' })
  assert.equal(mixed.json.summaries[normal].available, true)

  // 全部失败也 200（不返回 4xx/5xx）
  const allFailed = await api(server, '/api/kanban/git/summaries', {
    method: 'POST',
    body: { dirs: [plain, missing] },
  })
  assert.equal(allFailed.status, 200)
  assert.equal(allFailed.json.ok, true)
  assert.equal(Object.values(allFailed.json.summaries).every(item => item.available === false), true)
})

test('POST /git/summaries：同目录命中服务端缓存（10s 内不重新采集）', async t => {
  const { server } = await setupServer(t)
  const repo = await makeGitRepo(t)
  await createCard(server, { cwd: repo })

  const first = await api(server, '/api/kanban/git/summaries', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(first.json.summaries[repo].branch, 'main')

  // 缓存期内切换分支：仍应返回缓存里的 main
  await git(repo, ['checkout', '-q', '-b', 'feat/x'])
  const second = await api(server, '/api/kanban/git/summaries', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(second.status, 200)
  assert.deepEqual(second.json.summaries[repo], first.json.summaries[repo])
  assert.equal(second.json.summaries[repo].branch, 'main')
})

test('POST /git/summaries：缓存 TTL 过期后重新采集', async t => {
  const { server } = await setupServer(t, { gitSummaryCacheTtlMs: 50 })
  const repo = await makeGitRepo(t)
  await createCard(server, { cwd: repo })
  const first = await api(server, '/api/kanban/git/summaries', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(first.json.summaries[repo].branch, 'main')
  await git(repo, ['checkout', '-q', '-b', 'feat/x'])
  await new Promise(resolve => setTimeout(resolve, 120)) // 越过 50ms TTL（不依赖采集耗时）
  const second = await api(server, '/api/kanban/git/summaries', { method: 'POST', body: { dirs: [repo] } })
  assert.equal(second.json.summaries[repo].branch, 'feat/x')
})

test('POST /git/summaries：非 POST 405，未知子路径 404，全部 forbidden 仍 200', async t => {
  const { server } = await setupServer(t)
  const get = await api(server, '/api/kanban/git/summaries')
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
  const unknown = await api(server, '/api/kanban/git/unknown', { method: 'POST', body: { dirs: ['/tmp/x'] } })
  assert.equal(unknown.status, 404)

  const unlisted = await tempDir(t, 'dsh-git-summary-unlisted-')
  const res = await api(server, '/api/kanban/git/summaries', {
    method: 'POST',
    body: { dirs: [join(unlisted, 'a'), join(unlisted, 'b')] },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(Object.values(res.json.summaries), [
    { available: false, reason: 'forbidden' },
    { available: false, reason: 'forbidden' },
  ])
})
