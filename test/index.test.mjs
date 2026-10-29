// index.js：插件导出契约与 apply 接线（fake ctx 验证路由/工具注册与卸载）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { TOOL_NAMES } from '../lib/tools.js'
import { createStore } from '../lib/store.js'
import { createCard, createSeed, normalizeStore } from '../lib/domain.js'
import { tempDir } from './helpers.mjs'

function fakeContext() {
  const state = { routes: [], tools: [], effects: [], events: new Map(), routeDisposers: 0, toolDisposers: 0 }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      register(route) {
        if (state.routes.some(item => item.kind === route.kind && item.path === route.path)) throw new Error('重复路由')
        state.routes.push(route)
        return () => { state.routeDisposers += 1 }
      },
    },
    tools: {
      register(tool) {
        state.tools.push(tool)
        return () => { state.toolDisposers += 1 }
      },
    },
    on(name, handler, options) {
      state.events.set(name, { handler, options })
      return () => { state.events.delete(name) }
    },
    effect(fn) { state.effects.push(fn()) },
  }
  return { ctx, state }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 80))

test('插件导出 name/inject/apply 契约', () => {
  assert.equal(name, 'dsh-kanban')
  assert.deepEqual(inject, ['webServer', 'tools'])
  assert.equal(typeof apply, 'function')
})

test('apply 注册两条前缀路由与 14 个工具，并种下 demo 数据', async t => {
  const dir = await tempDir(t)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: dir, seed: 'demo' })
  assert.equal(state.routes.length, 2)
  assert.deepEqual(state.routes.map(route => [route.kind, route.path]), [['prefix', '/api/kanban'], ['prefix', '/dsh-kanban']])
  assert.ok(state.routes.every(route => typeof route.handler === 'function'))
  assert.deepEqual(state.tools.map(tool => tool.name), TOOL_NAMES)
  await flush()
  const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.cards.length, 8)
  // 决策日志：首次启动从 demo 数据回填（approval_requested / resolved + log_initialized 收尾）
  const logFile = join(dir, 'decisions.jsonl')
  assert.ok(await waitForFile(async () => {
    try { return (await stat(logFile)).size > 0 } catch { return false }
  }), '决策日志应在启动回填后存在')
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines[0].type, 'approval_requested')
  assert.ok(lines.at(-1).counts.requested > 0)
  assert.ok(lines.at(-1).counts.pending > 0)
  assert.equal(lines[lines.length - 1].type, 'log_initialized')
  assert.equal(lines[lines.length - 1].source, 'backfill')
  // 清理：按注册顺序执行 disposer，不应抛错
  for (const dispose of state.effects.reverse()) if (typeof dispose === 'function') await dispose()
  assert.equal(state.routeDisposers, 2)
  assert.equal(state.toolDisposers, TOOL_NAMES.length)
})

test('apply 支持 seed=empty 与自定义 dataDir', async t => {
  const dir = await tempDir(t)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: join(dir, 'custom'), seed: 'empty' })
  await flush()
  const data = JSON.parse(await readFile(join(dir, 'custom', 'data.json'), 'utf8'))
  assert.equal(data.cards.length, 0)
  assert.equal(data.boards[0].id, 'board-default')
  for (const dispose of state.effects.reverse()) if (typeof dispose === 'function') await dispose()
})

async function waitForFile(predicate, { timeout = 3000 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function closeEffects(state) {
  for (const dispose of state.effects.reverse()) if (typeof dispose === 'function') await dispose()
}

/** 预先写一份 data.json：很旧的 done/canceled 卡片 + 旧 completedAt 的 running 卡片。 */
async function seedOldCompletedCards(dir) {
  const store = createStore({ dataDir: dir, forceNew: true })
  await store.ready()
  const old = Date.now() - 40 * 86_400_000
  let doneId, canceledId, runningId
  await store.update(draft => {
    const done = createCard(draft, { title: '旧 done 卡', status: 'done' }, { now: old }).card
    done.completedAt = old
    doneId = done.id
    const canceled = createCard(draft, { title: '旧 canceled 卡', status: 'canceled' }, { now: old }).card
    canceled.completedAt = old
    canceledId = canceled.id
    const running = createCard(draft, { title: '旧 running 卡', status: 'running' }, { now: old }).card
    running.completedAt = old
    runningId = running.id
    return null
  })
  await store.close()
  return { doneId, canceledId, runningId }
}

test('apply autoArchiveDays：启动后立即归档超期 done/canceled，running 不归档，定时器随 effect 清理', async t => {
  const dir = await tempDir(t)
  const { doneId, canceledId, runningId } = await seedOldCompletedCards(dir)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: dir, autoArchiveDays: 1 })
  await waitForFile(async () => {
    try {
      const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
      return data.cards.find(card => card.id === doneId)?.archived === true
    } catch { return false }
  })
  const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
  const done = data.cards.find(card => card.id === doneId)
  const canceled = data.cards.find(card => card.id === canceledId)
  const running = data.cards.find(card => card.id === runningId)
  assert.equal(done.archived, true)
  assert.ok(done.archivedAt > 0)
  assert.equal(canceled.archived, true)
  assert.equal(running.archived, undefined)
  const event = data.activities.find(item => item.cardId === doneId && item.type === 'archived')
  assert.match(event.text, /自动归档：已完成超过 1 天/)
  assert.equal(event.actor.kind, 'system')
  await closeEffects(state)
})

test('apply autoArchiveDays=0 关闭自动归档；默认 30 天归档 40 天前完成的卡', async t => {
  // 0 = 关闭
  const offDir = await tempDir(t)
  const off = await seedOldCompletedCards(offDir)
  const offContext = fakeContext()
  apply(offContext.ctx, { dataDir: offDir, autoArchiveDays: 0 })
  await new Promise(resolve => setTimeout(resolve, 120))
  const offData = JSON.parse(await readFile(join(offDir, 'data.json'), 'utf8'))
  assert.equal(offData.cards.find(card => card.id === off.doneId).archived, undefined)
  await closeEffects(offContext.state)

  // 默认 30 天：40 天前的 done 会被归档
  const defaultDir = await tempDir(t)
  const seeded = await seedOldCompletedCards(defaultDir)
  const defaultContext = fakeContext()
  apply(defaultContext.ctx, { dataDir: defaultDir })
  await waitForFile(async () => {
    try {
      const data = JSON.parse(await readFile(join(defaultDir, 'data.json'), 'utf8'))
      return data.cards.find(card => card.id === seeded.doneId)?.archived === true
    } catch { return false }
  })
  const defaultData = JSON.parse(await readFile(join(defaultDir, 'data.json'), 'utf8'))
  assert.equal(defaultData.cards.find(card => card.id === seeded.doneId).archived, true)
  assert.match(
    defaultData.activities.find(item => item.cardId === seeded.doneId && item.type === 'archived').text,
    /自动归档：已完成超过 30 天/,
  )
  await closeEffects(defaultContext.state)
})


/** 预先写一份 data.json：模拟旧版本留下的「卡片已离开待你确认但审批仍 pending」。 */
async function seedLegacyPending(dir) {
  const seededAt = 1_700_000_000_000
  const seed = normalizeStore(createSeed('demo', seededAt), seededAt)
  const card = seed.cards.find(item => (item.approvals || []).some(approval => approval.status === 'pending'))
  card.status = 'done'
  card.updatedAt = seededAt + 1_000
  await writeFile(join(dir, 'data.json'), JSON.stringify(seed), 'utf8')
  return { cardId: card.id }
}

test('apply 启动时把历史遗留 pending 审批同步为 dismissed，决策日志记录未决事件', async t => {
  const dir = await tempDir(t)
  const { cardId } = await seedLegacyPending(dir)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: dir })
  assert.ok(await waitForFile(async () => {
    try {
      const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
      const card = data.cards.find(item => item.id === cardId)
      return card && (card.approvals || []).every(approval => approval.status !== 'pending')
    } catch { return false }
  }), '历史遗留 pending 审批应被同步关闭')
  const logLines = (await readFile(join(dir, 'decisions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(logLines.some(line => line.type === 'approval_unresolved' && line.reason === 'left_needs_you' && line.cardId === cardId))
  assert.equal(logLines.at(-1).type, 'log_initialized')
  await closeEffects(state)
})

test('apply 首启 demo：种子卡在首个生命周期内可直接请求审批（种子已规范化）', async t => {
  const dir = await tempDir(t)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: dir, seed: 'demo' })
  await flush()
  const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
  const target = data.cards.find(card => card.status !== 'needs_you' && (card.approvals || []).length === 0) || data.cards[0]
  const tool = state.tools.find(item => item.name === 'kanban_request_approval')
  const result = JSON.parse(await tool.execute({ cardId: target.id, title: '首启种子卡审批', options: ['好'] }, { agent: { id: 'agent-test-1' } }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.card.status, 'needs_you')
  const lines = (await readFile(join(dir, 'decisions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(lines.some(line => line.type === 'approval_requested' && line.cardId === target.id))
  await closeEffects(state)
})

test('apply 挂载 session/event 监听：turn/end 失败自动置卡片失败，成功轮自动恢复', async t => {
  const dir = await tempDir(t)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: dir, seed: 'demo' })
  await flush()
  const listener = state.events.get('session/event')
  assert.ok(listener, '缺少 session/event 监听')
  assert.equal(listener.options.global, true)

  // 通过共享 store 建一张绑定主会话的进行中卡片（apply 内部与这里拿到同一个实例）。
  const store = createStore({ dataDir: dir })
  const { result } = await store.update(draft => ({
    card: createCard(draft, { title: '失败同步卡', status: 'running', sessionId: 'session-fail-sync' }, { now: Date.now() }).card,
  }))
  const cardId = result.card.id
  const readCard = async () => {
    const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
    return { data, card: data.cards.find(item => item.id === cardId) }
  }

  await listener.handler(
    { id: 'session-fail-sync' },
    { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'BOOM' } } } },
  )
  let current = await readCard()
  assert.equal(current.card.status, 'failed')
  const failure = current.data.activities.find(item => item.cardId === cardId && item.type === 'error')
  assert.equal(failure.data.kind, 'session_turn_failure')
  assert.equal(failure.data.code, 'BOOM')

  await listener.handler(
    { id: 'session-fail-sync' },
    { type: 'turn/end', seq: 6, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } },
  )
  current = await readCard()
  assert.equal(current.card.status, 'running')
  assert.ok(current.data.activities.some(item => item.cardId === cardId && item.data && item.data.kind === 'session_turn_recovered'))
  await closeEffects(state)
})

test('apply sessionFailureSync=false：不挂 session/event 监听', async t => {
  const dir = await tempDir(t)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: dir, seed: 'empty', sessionFailureSync: false })
  await flush()
  assert.equal(state.events.has('session/event'), false)
  await closeEffects(state)
})
