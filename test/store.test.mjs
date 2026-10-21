// store.js：首次种子、原子写、并发串行、revision 单调、订阅广播、损坏恢复、schema 策略。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { tempDir } from './helpers.mjs'

const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

test('首次启动用 demo 种子建 data.json，revision=1 且不残留 tmp 文件', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  t.after(() => store.close())
  const snapshot = await store.snapshot()
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.data.schemaVersion, 1)
  assert.equal(snapshot.data.boards.length, 1)
  assert.equal(snapshot.data.boards[0].id, 'board-default')
  assert.ok(snapshot.data.cards.length >= 5)
  const onDisk = await readJson(join(dir, 'data.json'))
  assert.equal(onDisk.meta.revision, 1)
  const files = await readdir(dir)
  assert.deepEqual(files, ['data.json'])
  const mode = (await stat(join(dir, 'data.json'))).mode & 0o777
  assert.equal(mode, 0o600)
})

test('read() 返回副本，外部修改不影响缓存', async t => {
  const { store } = await (async () => {
    const dir = await tempDir(t)
    const store = createStore({ dataDir: dir, forceNew: true })
    t.after(() => store.close())
    return { store }
  })()
  const first = await store.read()
  first.cards[0].title = '被外部改掉'
  first.cards.push({ id: 'x' })
  const second = await store.read()
  assert.notEqual(second.cards[0].title, '被外部改掉')
  assert.equal(second.cards.length, first.cards.length - 1)
})

test('并发 update 串行执行，revision 单调递增且文件始终合法', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  t.after(() => store.close())
  await store.ready()
  const events = []
  store.subscribe(event => events.push(event.revision))
  const runs = Array.from({ length: 25 }, () => store.update(draft => {
    draft.cards[0].metadata.toolCalls = (draft.cards[0].metadata.toolCalls || 0) + 1
    return draft.meta.revision
  }))
  const results = await Promise.all(runs)
  assert.equal(new Set(results.map(item => item.revision)).size, 25)
  const data = await store.read()
  const original = (await readJson(join(dir, 'data.json')))
  assert.equal(data.meta.revision, 26)
  assert.equal(original.meta.revision, 26)
  assert.equal(original.cards.length, data.cards.length)
  // 每次写入的 revision 严格 +1
  assert.deepEqual([...new Set(events)].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 2))
  const files = (await readdir(dir)).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(files, [])
})

test('update 抛错不写盘，队列继续工作', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  t.after(() => store.close())
  await store.ready()
  const before = await store.read()
  await assert.rejects(store.update(() => { throw new Error('业务失败') }), /业务失败/)
  const afterFailure = await store.read()
  assert.equal(afterFailure.meta.revision, before.meta.revision)
  const next = await store.update(draft => { draft.cards[0].summary = '恢复后写入'; return 1 })
  assert.equal(next.revision, before.meta.revision + 1)
  assert.equal((await store.read()).cards[0].summary, '恢复后写入')
})

test('schemaVersion 高于当前版本时拒绝加载且不覆盖原文件', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'data.json')
  const original = JSON.stringify({ schemaVersion: 99, boards: [], cards: [], activities: [], meta: { revision: 9 } })
  await writeFile(file, original)
  const store = createStore({ dataDir: dir, forceNew: true })
  t.after(() => store.close())
  await assert.rejects(store.read(), error => error.code === 'STORE_SCHEMA_NEWER')
  assert.equal(await readFile(file, 'utf8'), original)
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('data.json.corrupt-')))
})

test('损坏 JSON 备份为 .corrupt-<ts> 后用种子重建', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'data.json')
  const garbage = '{ 这不是 JSON'
  await writeFile(file, garbage)
  const store = createStore({ dataDir: dir, forceNew: true })
  t.after(() => store.close())
  const snapshot = await store.snapshot()
  assert.equal(snapshot.data.cards.length >= 5, true)
  const backups = (await readdir(dir)).filter(name => name.startsWith('data.json.corrupt-'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), garbage)
  const rebuilt = await readJson(file)
  assert.equal(rebuilt.schemaVersion, 1)
  assert.equal(rebuilt.meta.revision, 1)
})

test('结构不可修复（boards 不是数组）也走备份+种子，原数据保留', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'data.json')
  const bad = JSON.stringify({ schemaVersion: 1, boards: 'nope' })
  await writeFile(file, bad)
  const store = createStore({ dataDir: dir, forceNew: true })
  t.after(() => store.close())
  const snapshot = await store.snapshot()
  assert.equal(snapshot.data.boards.length, 1)
  const backups = (await readdir(dir)).filter(name => name.startsWith('data.json.corrupt-'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), bad)
})

test('缺失/旧 schemaVersion 迁移为 1 并立即写回', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'data.json')
  const legacy = {
    boards: [{ id: 'board-default', name: '老看板', cardOrder: { backlog: ['card-aaaaaaaa'], running: [], needs_you: [], done: [] }, createdAt: 1, updatedAt: 2 }],
    cards: [{ id: 'card-aaaaaaaa', boardId: 'board-default', title: '老卡片', status: 'running', createdAt: 3, updatedAt: 4 }],
    activities: [],
    meta: { revision: 7, createdAt: 1, updatedAt: 2 },
  }
  await writeFile(file, JSON.stringify(legacy))
  const store = createStore({ dataDir: dir, forceNew: true })
  t.after(() => store.close())
  const data = await store.read()
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.meta.revision, 7)
  assert.equal(data.cards.length, 1)
  assert.equal(data.cards[0].status, 'running')
  assert.equal((await readJson(file)).schemaVersion, 1)
})

test('空种子模式只建默认看板', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  t.after(() => store.close())
  const data = await store.read()
  assert.equal(data.cards.length, 0)
  assert.equal(data.boards[0].id, 'board-default')
})

test('同一 dataDir 复用同一实例，避免两条写队列', async t => {
  const dir = await tempDir(t)
  const first = createStore({ dataDir: dir })
  t.after(() => first.close())
  const second = createStore({ dataDir: dir })
  assert.ok(first === second)
})
