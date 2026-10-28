// v0.18 回收站：cleanup 写 manifest.json、GET /git/trash 列表、
// POST /git/trash/restore 恢复工作副本、DELETE /git/trash/:id 彻底删除。
// 全部用 os.tmpdir() 下的真实临时仓库与临时回收站，离线、不碰真实 ~/.dsh-kanban。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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

function stampedEnv(seq) {
  const stamp = `@${BASE_EPOCH + seq} +0000`
  return { ...GIT_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
}

async function commitFile(cwd, subject, seq, file, content) {
  await writeFile(join(cwd, file), content, 'utf8')
  await git(cwd, ['add', file])
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], { cwd, env: stampedEnv(seq) })
  return git(cwd, ['rev-parse', 'HEAD'])
}

async function initRepo(t, name = 'repo') {
  const root = await tempDir(t, 'dsh-git-trash-')
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '-q', '-b', 'main'])
  return { root, repo }
}

async function exists(value) {
  try { await stat(value); return true } catch { return false }
}

/** 与 test/helpers.mjs 的 startServer 一致，额外支持 createRoutes 选项（回收站根目录）。 */
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
  const trashRoot = await tempDir(t, 'dsh-git-trashroot-')
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

function restore(server, id) {
  return api(server, '/api/kanban/git/trash/restore', { method: 'POST', body: { id } })
}

function purge(server, id) {
  return api(server, `/api/kanban/git/trash/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

function listTrash(server) {
  return api(server, '/api/kanban/git/trash')
}

/** 建「主工作副本 + 从 main 分出的干净工作副本」，返回常用路径。 */
async function makeFixture(t, { branch = 'feat/clean', name = 'wt' } = {}) {
  const { root, repo } = await initRepo(t)
  const head = await commitFile(repo, 'A 初始提交', 1, 'a.txt', 'a\n')
  const wt = join(root, name)
  await git(repo, ['worktree', 'add', '-q', '-b', branch, wt])
  const realRepo = await realpath(repo)
  const realWt = await realpath(wt)
  return { root, repo, wt, realRepo, realWt, head }
}

// ---------------- manifest 与列表 ----------------

test('cleanup 写 manifest.json；GET /git/trash 列出条目（按 trashedAt 倒序，旧条目 restorable:false）', async t => {
  const { server, trashRoot } = await setupServer(t)
  const { repo, wt, realRepo, realWt, head } = await makeFixture(t)
  await createCard(server, { cwd: repo })

  const cleaned = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  assert.equal(cleaned.status, 200, cleaned.text)
  const id = basename(cleaned.json.cleanup.trashedTo)
  const manifest = JSON.parse(await readFile(join(trashRoot, id, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.repoRoot, realRepo)
  assert.equal(manifest.worktreePath, realWt)
  assert.equal(manifest.branch, 'feat/clean')
  assert.equal(manifest.sha, head)
  assert.equal(manifest.branchDeleted, false)
  assert.match(manifest.trashedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)

  // 两个旧条目（无 manifest）+ 一个杂散文件：杂散文件不占条目，旧条目按时间排在后面
  await mkdir(join(trashRoot, '20200101-000000-old-repo-oldwt'), { recursive: true })
  await mkdir(join(trashRoot, '20250101-000000-mid-repo-midwt'), { recursive: true })
  await writeFile(join(trashRoot, 'stray-file.txt'), 'x', 'utf8')

  const state = await api(server, '/api/kanban/state')
  const listed = await listTrash(server)
  assert.equal(listed.status, 200)
  assert.equal(listed.json.ok, true)
  assert.equal(listed.json.revision, state.json.revision)
  assert.equal(listed.json.entries.length, 3)
  assert.deepEqual(listed.json.entries.map(entry => entry.id), [id, '20250101-000000-mid-repo-midwt', '20200101-000000-old-repo-oldwt'])
  assert.deepEqual(listed.json.entries[0], {
    id,
    repoRoot: realRepo,
    worktreePath: realWt,
    repoName: 'repo',
    worktreeName: 'wt',
    branch: 'feat/clean',
    sha: head,
    trashedAt: manifest.trashedAt,
    branchDeleted: false,
    restorable: true,
  })
  const legacy = listed.json.entries[2]
  assert.equal(legacy.restorable, false)
  assert.equal(legacy.repoRoot, null)
  assert.equal(legacy.worktreePath, null)
  assert.match(legacy.trashedAt, /^2020-01-01T00:00:00[+-]\d{2}:\d{2}$/)
})

test('GET /git/trash：回收站目录不存在时返回空列表', async t => {
  const missingTrash = join(await tempDir(t, 'dsh-git-trash-absent-'), 'not-created')
  const { store } = await testStore(t, { seedMode: 'empty' })
  const server = await startServer(t, { store, gitTrashRoot: missingTrash })
  const res = await listTrash(server)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.entries, [])
})

// ---------------- 恢复 ----------------

test('restore：分支仍在 → git worktree add <原路径> <分支>，并恢复未保存改动/未跟踪文件', async t => {
  const { server } = await setupServer(t)
  const { repo, wt, realRepo, realWt, head } = await makeFixture(t)
  await createCard(server, { cwd: repo })
  await writeFile(join(wt, 'a.txt'), 'changed in worktree\n', 'utf8')
  await writeFile(join(wt, 'new-file.txt'), 'untracked\n', 'utf8')

  const cleaned = await cleanup(server, { repoRoot: repo, worktreePath: wt, confirmLoss: true })
  assert.equal(cleaned.status, 200, cleaned.text)
  const id = basename(cleaned.json.cleanup.trashedTo)
  assert.equal(await exists(realWt), false)

  const res = await restore(server, id)
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(res.json.restored, {
    id, repoRoot: realRepo, worktreePath: realWt, restoredTo: realWt,
    branch: 'feat/clean', branchRestored: false,
  })
  assert.equal(await exists(realWt), true)
  assert.equal(await readFile(join(realWt, 'a.txt'), 'utf8'), 'changed in worktree\n')
  assert.equal(await readFile(join(realWt, 'new-file.txt'), 'utf8'), 'untracked\n')
  // worktree 元数据恢复、分支仍在；回收站条目已删除
  const listedWorktrees = await git(repo, ['worktree', 'list', '--porcelain'])
  assert.equal(listedWorktrees.includes(realWt), true)
  assert.equal(await git(repo, ['rev-parse', 'feat/clean']), head)
  assert.deepEqual((await listTrash(server)).json.entries, [])
})

test('restore：分支已删（branchDeleted）→ git worktree add -b <分支> <原路径> <sha>', async t => {
  const { server } = await setupServer(t)
  const { repo, wt, realRepo, realWt, head } = await makeFixture(t)
  await createCard(server, { cwd: repo })
  await writeFile(join(wt, 'a.txt'), 'modified before cleanup\n', 'utf8')

  const cleaned = await cleanup(server, { repoRoot: repo, worktreePath: wt, deleteBranch: true, confirmLoss: true })
  assert.equal(cleaned.status, 200, cleaned.text)
  assert.equal(cleaned.json.cleanup.branchDeleted, true)
  const id = basename(cleaned.json.cleanup.trashedTo)
  assert.equal(await git(repo, ['branch', '--list', 'feat/clean']), '')

  const res = await restore(server, id)
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(res.json.restored, {
    id, repoRoot: realRepo, worktreePath: realWt, restoredTo: realWt,
    branch: 'feat/clean', branchRestored: true,
  })
  assert.equal(await git(repo, ['rev-parse', 'feat/clean']), head)
  assert.equal(await readFile(join(realWt, 'a.txt'), 'utf8'), 'modified before cleanup\n')
  assert.equal((await git(repo, ['worktree', 'list', '--porcelain'])).includes(realWt), true)
  assert.deepEqual((await listTrash(server)).json.entries, [])
})

test('restore：原路径已存在 → 409 RESTORE_PATH_EXISTS', async t => {
  const { server } = await setupServer(t)
  const { repo, wt, realWt } = await makeFixture(t)
  await createCard(server, { cwd: repo })
  const cleaned = await cleanup(server, { repoRoot: repo, worktreePath: wt })
  const id = basename(cleaned.json.cleanup.trashedTo)
  await mkdir(realWt, { recursive: true })

  const res = await restore(server, id)
  assert.equal(res.status, 409)
  assert.equal(res.json.error.code, 'RESTORE_PATH_EXISTS')
  assert.equal((await listTrash(server)).json.entries.length, 1) // 失败不删条目
})

test('restore：sha 对象不存在 → 409 RESTORE_SHA_MISSING', async t => {
  const { server, trashRoot } = await setupServer(t)
  const { repo, wt } = await makeFixture(t)
  await createCard(server, { cwd: repo })
  const cleaned = await cleanup(server, { repoRoot: repo, worktreePath: wt, deleteBranch: true })
  assert.equal(cleaned.status, 200, cleaned.text)
  const id = basename(cleaned.json.cleanup.trashedTo)
  // 模拟提交已被 gc：把 manifest.sha 改成不存在的对象
  const manifestPath = join(trashRoot, id, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.sha = '0'.repeat(40)
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

  const res = await restore(server, id)
  assert.equal(res.status, 409)
  assert.equal(res.json.error.code, 'RESTORE_SHA_MISSING')
})

test('restore：条目不存在 / 无 manifest → 404', async t => {
  const { server, trashRoot } = await setupServer(t)
  const noManifest = '20200101-000000-old-repo-oldwt'
  await mkdir(join(trashRoot, noManifest), { recursive: true })
  assert.equal((await restore(server, noManifest)).status, 404)
  assert.equal((await restore(server, 'not-exists')).status, 404)
})

test('restore / purge：id 非法或目录穿越 → 400 BAD_REQUEST', async t => {
  const { server } = await setupServer(t)
  const invalidIds = ['', '   ', '..', '../etc', 'a/b', 'a\\b', 'a\u0000b']
  for (const id of invalidIds) {
    const res = await restore(server, id)
    assert.equal(res.status, 400, `restore id=${JSON.stringify(id)}`)
    assert.equal(res.json.error.code, 'BAD_REQUEST')
  }
  // body 缺 id / id 非字符串
  const missing = await api(server, '/api/kanban/git/trash/restore', { method: 'POST', body: {} })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error.code, 'BAD_REQUEST')
  const nonString = await api(server, '/api/kanban/git/trash/restore', { method: 'POST', body: { id: 123 } })
  assert.equal(nonString.status, 400)

  // DELETE 路径里的穿越（URL 编码的 ../）
  for (const raw of ['..%2Fetc', '..%2F..%2Fetc']) {
    const res = await api(server, `/api/kanban/git/trash/${raw}`, { method: 'DELETE' })
    assert.equal(res.status, 400, `delete raw=${raw}`)
    assert.equal(res.json.error.code, 'BAD_REQUEST')
  }
})

// ---------------- 彻底删除 ----------------

test('purge：删除条目、列表减少；重复删除 / 无 manifest 条目 404', async t => {
  const { server, trashRoot } = await setupServer(t)
  const first = await makeFixture(t, { branch: 'feat/one', name: 'wt-one' })
  const second = await makeFixture(t, { branch: 'feat/two', name: 'wt-two' })
  await createCard(server, { cwd: first.repo })
  await createCard(server, { cwd: second.repo })
  const cleanedOne = await cleanup(server, { repoRoot: first.repo, worktreePath: first.wt })
  const cleanedTwo = await cleanup(server, { repoRoot: second.repo, worktreePath: second.wt })
  const idOne = basename(cleanedOne.json.cleanup.trashedTo)
  const idTwo = basename(cleanedTwo.json.cleanup.trashedTo)
  assert.equal((await listTrash(server)).json.entries.length, 2)

  const purged = await purge(server, idOne)
  assert.equal(purged.status, 200, purged.text)
  assert.deepEqual(purged.json.purged, { id: idOne })
  assert.equal(await exists(join(trashRoot, idOne)), false)
  assert.deepEqual((await listTrash(server)).json.entries.map(entry => entry.id), [idTwo])

  const again = await purge(server, idOne)
  assert.equal(again.status, 404)
  assert.equal(again.json.error.code, 'NOT_FOUND')

  // 无 manifest 的旧条目不允许通过接口彻底删除（只能在 7 天后自动清理）
  const legacy = '20200101-000000-old-repo-oldwt'
  await mkdir(join(trashRoot, legacy), { recursive: true })
  const legacyPurge = await purge(server, legacy)
  assert.equal(legacyPurge.status, 404)
})

// ---------------- 方法校验 ----------------

test('trash 路由方法校验：405（GET/POST/DELETE 各归位）', async t => {
  const { server } = await setupServer(t)
  const badList = await api(server, '/api/kanban/git/trash', { method: 'POST', body: {} })
  assert.equal(badList.status, 405)
  assert.equal(badList.headers.get('allow'), 'GET, HEAD')

  const badRestore = await api(server, '/api/kanban/git/trash/restore')
  assert.equal(badRestore.status, 405)
  assert.equal(badRestore.headers.get('allow'), 'POST')

  const badPurge = await api(server, '/api/kanban/git/trash/some-id', { method: 'POST', body: {} })
  assert.equal(badPurge.status, 405)
  assert.equal(badPurge.headers.get('allow'), 'DELETE')

  const deleteNoId = await api(server, '/api/kanban/git/trash', { method: 'DELETE' })
  assert.equal(deleteNoId.status, 405)

  const getEntry = await api(server, '/api/kanban/git/trash/some-id')
  assert.equal(getEntry.status, 405)
  assert.equal(getEntry.headers.get('allow'), 'DELETE')
})
