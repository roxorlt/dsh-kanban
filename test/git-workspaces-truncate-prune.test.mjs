// v0.20 工作区批量 1：/git/workspaces 的 worktreeCount / truncatedWorktrees，
// 以及 POST /git/worktrees/prune（git worktree prune，只清失效记录）。
// 全部用 os.tmpdir() 下的真实临时仓库，离线、不碰真实 ~/.dsh-kanban。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRoutes } from '../lib/routes.js'
import { api, tempDir, testStore } from './helpers.mjs'

const execFileAsync = promisify(execFile)
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

async function commitFile(cwd, subject, seq, file, content) {
  const stamp = `@${BASE_EPOCH + seq} +0000`
  const env = { ...GIT_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
  await writeFile(join(cwd, file), content, 'utf8')
  await git(cwd, ['add', file])
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], { cwd, env })
  return git(cwd, ['rev-parse', 'HEAD'])
}

async function initRepo(t, name = 'repo') {
  const root = await tempDir(t, 'dsh-git-ws-batch-')
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '-q', '-b', 'main'])
  return { root, repo }
}

async function exists(value) {
  try { await stat(value); return true } catch { return false }
}

/** 与 test/helpers.mjs 的 startServer 一致，额外支持 createRoutes 选项（缓存 TTL / 回收站根目录）。 */
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
  const trashRoot = await tempDir(t, 'dsh-git-ws-batch-trash-')
  const { store } = await testStore(t, { seedMode: 'empty' })
  const server = await startServer(t, { store, gitTrashRoot: trashRoot, ...options })
  return { store, server, trashRoot }
}

async function createCard(server, body = {}) {
  const res = await api(server, '/api/kanban/cards', { method: 'POST', body: { title: '工作区卡片', ...body } })
  assert.equal(res.status, 200, res.text)
  return res.json.card
}

function workspaces(server, dirs) {
  return api(server, '/api/kanban/git/workspaces', { method: 'POST', body: { dirs } })
}

function prune(server, repoRoot) {
  return api(server, '/api/kanban/git/worktrees/prune', { method: 'POST', body: { repoRoot } })
}

/** 建一个 main 提交 + N 个 linked worktree 的仓库。 */
async function makeRepoWithWorktrees(t, count) {
  const { root, repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  const paths = []
  for (let index = 1; index <= count; index += 1) {
    const path = join(root, `wt-${index}`)
    await git(repo, ['worktree', 'add', '-q', '-b', `b${index}`, path])
    paths.push(path)
  }
  return { root, repo, paths }
}

// ---------------- worktreeCount / truncatedWorktrees ----------------

test('workspaces：工作副本超过 12 个时返回 worktreeCount 与 truncatedWorktrees（总数不受上限影响）', async t => {
  const { server } = await setupServer(t)
  const { repo, paths } = await makeRepoWithWorktrees(t, 14)
  await createCard(server, { cwd: repo })
  await createCard(server, { cwd: paths[13] })

  const res = await workspaces(server, [repo, paths[13]])
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.repos.length, 1)
  const [entry] = res.json.repos
  assert.equal(entry.worktreeCount, 15) // 主工作副本 + 14 个 linked
  assert.equal(entry.worktrees.length, 12)
  assert.equal(entry.truncatedWorktrees, 3)
  // 当前请求目录所在的工作副本仍被优先保留
  const realLast = await realpath(paths[13])
  assert.equal(entry.worktrees.some(row => row.path === realLast && row.isCurrent), true)
})

test('workspaces：无截断时 truncatedWorktrees 为 0', async t => {
  const { server } = await setupServer(t)
  const { repo } = await makeRepoWithWorktrees(t, 2)
  await createCard(server, { cwd: repo })
  const res = await workspaces(server, [repo])
  const [entry] = res.json.repos
  assert.equal(entry.worktreeCount, 3)
  assert.equal(entry.worktrees.length, 3)
  assert.equal(entry.truncatedWorktrees, 0)

  // 只有主工作副本的仓库
  const solo = await initRepo(t, 'solo')
  await commitFile(solo.repo, 'S1 初始提交', 2, 's.txt', 's\n')
  await createCard(server, { cwd: solo.repo })
  const soloRes = await workspaces(server, [solo.repo])
  const [soloEntry] = soloRes.json.repos
  assert.equal(soloEntry.worktreeCount, 1)
  assert.equal(soloEntry.truncatedWorktrees, 0)
})

test('workspaces：缓存命中时仍返回总数字段；TTL 过期后反映新增工作副本', async t => {
  const { server } = await setupServer(t, { gitWorkspaceCacheTtlMs: 500 })
  const { root, repo } = await initRepo(t, 'cache-repo')
  await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  await createCard(server, { cwd: repo })

  const first = await workspaces(server, [repo])
  assert.equal(first.json.repos[0].worktreeCount, 1)
  assert.equal(first.json.repos[0].truncatedWorktrees, 0)

  // 新增一个工作副本，但缓存期内仍返回缓存的旧总数（字段依旧存在）
  await git(repo, ['worktree', 'add', '-q', '-b', 'late', join(root, 'wt-late')])
  const cached = await workspaces(server, [repo])
  assert.equal(cached.json.repos[0].worktreeCount, 1)
  assert.equal(cached.json.repos[0].truncatedWorktrees, 0)

  await new Promise(resolve => setTimeout(resolve, 700)) // 越过 500ms TTL
  const refreshed = await workspaces(server, [repo])
  assert.equal(refreshed.json.repos[0].worktreeCount, 2)
  assert.equal(refreshed.json.repos[0].truncatedWorktrees, 0)
})

// ---------------- POST /git/worktrees/prune ----------------

test('prune：手动删掉工作副本目录后调用 → 失效记录被清除（removed:true），现存目录/分支不受影响', async t => {
  const { server } = await setupServer(t)
  const { root, repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  const keep = join(root, 'wt-keep')
  const gone = join(root, 'wt-gone')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/keep', keep])
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/gone', gone])
  await createCard(server, { cwd: repo })
  const realGone = await realpath(gone)
  const realKeep = await realpath(keep)
  await rm(gone, { recursive: true, force: true }) // 模拟用户手动删除目录，git 记录还在

  // 清理前：列表里能看到 prunable 记录
  const before = await workspaces(server, [repo])
  assert.equal(before.json.repos[0].worktreeCount, 3)
  const prunableRow = before.json.repos[0].worktrees.find(row => row.branch === 'feat/gone')
  assert.ok(prunableRow)
  assert.equal(prunableRow.prunable, true)

  const realRepo = await realpath(repo)
  const res = await prune(server, repo)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.ok, true)
  assert.deepEqual(res.json.pruned, { repoRoot: realRepo, removed: true })

  // 失效记录消失；现存工作副本与分支都还在
  const listed = await git(repo, ['worktree', 'list', '--porcelain'])
  assert.equal(listed.includes(realGone), false)
  assert.equal(listed.includes(realKeep), true)
  assert.equal(await exists(keep), true)
  assert.equal(await exists(repo), true)
  assert.equal(await git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/keep']), (await git(repo, ['rev-parse', 'feat/keep'])))
  assert.equal(await git(repo, ['branch', '--list', 'feat/gone']), 'feat/gone')
})

test('prune：没有失效记录时 removed:false，工作副本不受影响', async t => {
  const { server } = await setupServer(t)
  const { root, repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  const wt = join(root, 'wt')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/ok', wt])
  await createCard(server, { cwd: repo })

  const res = await prune(server, repo)
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(res.json.pruned, { repoRoot: await realpath(repo), removed: false })
  const listed = await git(repo, ['worktree', 'list', '--porcelain'])
  assert.equal(listed.includes(await realpath(wt)), true)
  assert.equal(await exists(wt), true)
})

test('prune：成功后工作区地图缓存失效（刷新立刻看不到失效记录）', async t => {
  const { server } = await setupServer(t)
  const { root, repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  const gone = join(root, 'wt-gone')
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/gone', gone])
  await createCard(server, { cwd: repo })
  await rm(gone, { recursive: true, force: true })

  // 先请求一次，把「2 个工作副本（含 prunable 行）」写进 8s 缓存
  assert.equal((await workspaces(server, [repo])).json.repos[0].worktreeCount, 2)
  assert.equal((await prune(server, repo)).status, 200)

  const refreshed = await workspaces(server, [repo])
  assert.equal(refreshed.json.repos[0].worktreeCount, 1)
  assert.equal(refreshed.json.repos[0].worktrees.some(row => row.prunable), false)
})

test('prune：repoRoot 非法 / 不在卡片 cwd 推导出的仓库里 → 400 / 404', async t => {
  const { server } = await setupServer(t)
  const { repo } = await initRepo(t)
  await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')

  // 没有任何卡片 cwd 指向该仓库 → 404
  const notDerived = await prune(server, repo)
  assert.equal(notDerived.status, 404)
  assert.equal(notDerived.json.error.code, 'NOT_FOUND')

  await createCard(server, { cwd: repo })
  // 任意其它路径 / 不存在的路径 → 404
  const other = await initRepo(t, 'other-repo')
  await commitFile(other.repo, 'O1 初始提交', 2, 'o.txt', 'o\n')
  assert.equal((await prune(server, other.repo)).status, 404)
  assert.equal((await prune(server, join(repo, 'not-a-repo'))).status, 404)

  // body 校验 → 400
  const badBodies = [{}, { repoRoot: '' }, { repoRoot: '   ' }, { repoRoot: 123 }, { repoRoot: null }]
  for (const body of badBodies) {
    const res = await api(server, '/api/kanban/git/worktrees/prune', { method: 'POST', body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(res.json.error.code, 'BAD_REQUEST')
  }
})

test('prune：非 POST → 405', async t => {
  const { server } = await setupServer(t)
  const res = await api(server, '/api/kanban/git/worktrees/prune')
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'POST')
})
