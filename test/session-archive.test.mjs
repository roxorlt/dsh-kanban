// session-archive.js / 会话归档接口：适配器能力探测、错误映射、单卡归档/恢复、批量预检与执行、活动写入。
import test from 'node:test'
import assert from 'node:assert/strict'
import { api, startServer, testStore } from './helpers.mjs'
import { createSessionArchive } from '../lib/session-archive.js'
import {
  batchSessionArchivePlan,
  sessionArchivePlan,
  DomainError,
} from '../lib/domain.js'

/** 假 registry：模拟 DSH workspaceRegistry 的可逆归档语义（active/unknown 可配置）。 */
function createFakeRegistry({ archived = [], active = [], unknown = [] } = {}) {
  const state = {
    archived: new Set(archived),
    active: new Set(active),
    unknown: new Set(unknown),
    calls: [],
  }
  return {
    get archivedSessionIds() { return [...state.archived] },
    async archiveSession(sessionId, options = {}) {
      state.calls.push({ action: 'archive', sessionId, stopActivity: options.stopActivity === true })
      if (state.unknown.has(sessionId)) {
        const error = new Error('unknown session')
        error.name = 'WorkspaceUnknownSessionError'
        throw error
      }
      if (options.stopActivity !== true && state.active.has(sessionId)) {
        const error = new Error('session active')
        error.name = 'WorkspaceActiveSessionError'
        error.activity = [{ kind: 'turn' }]
        throw error
      }
      state.archived.add(sessionId)
    },
    async unarchiveSession(sessionId) {
      state.calls.push({ action: 'unarchive', sessionId })
      state.archived.delete(sessionId)
    },
    state,
  }
}

function makeArchive(registry) {
  return createSessionArchive({ getRegistry: () => registry })
}

async function setup(t, options = {}) {
  const { store } = await testStore(t, { seedMode: 'empty' })
  const registry = options.registry ?? createFakeRegistry()
  const archive = options.archive ?? makeArchive(registry)
  const server = await startServer(t, { store, sessionArchive: archive })
  return { store, server, registry }
}

async function createCard(server, title = '卡片') {
  const res = await api(server, '/api/kanban/cards', { method: 'POST', body: { title } })
  assert.equal(res.status, 200, res.text)
  return res.json.card
}

async function moveCard(server, cardId, column) {
  const res = await api(server, `/api/kanban/cards/${cardId}/move`, { method: 'POST', body: { column } })
  assert.equal(res.status, 200, res.text)
  return res.json.card
}

async function bind(server, cardId, sessionId) {
  const res = await api(server, `/api/kanban/cards/${cardId}/session`, { method: 'POST', body: { sessionId } })
  assert.equal(res.status, 200, res.text)
  return res.json.card
}

async function activities(server, cardId) {
  const res = await api(server, `/api/kanban/cards/${cardId}/activities?limit=50`)
  assert.equal(res.status, 200, res.text)
  return res.json.activities
}

test('适配器：宿主缺失/不支持取消归档时 available=false 且操作返回 SESSION_ARCHIVE_UNAVAILABLE', async () => {
  const missing = createSessionArchive({ getRegistry: () => null })
  assert.equal(missing.available(), false)
  assert.deepEqual(missing.archivedSessionIds(), [])
  await assert.rejects(() => missing.archive('session-1'), error => {
    assert.ok(error instanceof DomainError)
    assert.equal(error.code, 'SESSION_ARCHIVE_UNAVAILABLE')
    assert.equal(error.status, 501)
    return true
  })

  const irreversible = createSessionArchive({ getRegistry: () => ({ archiveSession: async () => {} }) })
  assert.equal(irreversible.available(), false)
  await assert.rejects(() => irreversible.archive('session-1'), error => error.code === 'SESSION_ARCHIVE_UNAVAILABLE')
})

test('适配器：archive/unarchive 透传 stopActivity 并翻译宿主错误', async () => {
  const registry = createFakeRegistry({ active: ['session-active'], unknown: ['session-gone'] })
  const archive = makeArchive(registry)
  assert.equal(archive.available(), true)

  assert.deepEqual(await archive.archive('session-ok'), ['session-ok'])
  assert.equal(registry.state.archived.has('session-ok'), true)

  await assert.rejects(() => archive.archive('session-active'), error => {
    assert.equal(error.code, 'SESSION_ACTIVE')
    assert.deepEqual(error.extra.activity, [{ kind: 'turn' }])
    return true
  })
  await archive.archive('session-active', { stopActivity: true })
  assert.equal(registry.state.archived.has('session-active'), true)
  assert.deepEqual(registry.state.calls.at(-2), { action: 'archive', sessionId: 'session-active', stopActivity: false })
  assert.deepEqual(registry.state.calls.at(-1), { action: 'archive', sessionId: 'session-active', stopActivity: true })

  await assert.rejects(() => archive.archive('session-gone'), error => error.code === 'SESSION_NOT_FOUND')

  await archive.unarchive('session-ok')
  assert.equal(registry.state.archived.has('session-ok'), false)
  assert.deepEqual(await archive.archivedSessionIds(), ['session-active'])
})

test('domain：sessionArchivePlan 校验完成状态、绑定关系与反向依赖', async t => {
  const { store } = await testStore(t, { seedMode: 'empty' })
  const data = await store.read()
  // 直接构造草稿级断言（不落库）
  data.cards = [
    { id: 'card-aaaaaaaa', title: '完成卡', status: 'done', archived: false, sessionIds: ['session-1'] },
    { id: 'card-bbbbbbbb', title: '进行中的卡', status: 'running', archived: false, sessionIds: ['session-1'] },
    { id: 'card-cccccccc', title: '未绑定卡', status: 'running', archived: false, sessionIds: [] },
  ]
  data.activities = []
  data.meta = { ...data.meta, revision: 1 }
  assert.throws(() => sessionArchivePlan(data, { cardId: 'card-bbbbbbbb', sessionId: 'session-1' }), error => {
    assert.equal(error.code, 'CARD_NOT_DONE')
    return true
  })
  assert.throws(() => sessionArchivePlan(data, { cardId: 'card-aaaaaaaa', sessionId: 'session-2' }), error => {
    assert.equal(error.code, 'SESSION_NOT_BOUND')
    return true
  })
  assert.throws(() => sessionArchivePlan(data, { cardId: 'card-aaaaaaaa', sessionId: 'session-1' }), error => {
    assert.equal(error.code, 'SESSION_BUSY_CARDS')
    assert.deepEqual(error.extra.blockingCards, [{ id: 'card-bbbbbbbb', title: '进行中的卡', status: 'running' }])
    return true
  })
  // 把进行中的卡取消后即可归档
  data.cards[1].status = 'canceled'
  const plan = sessionArchivePlan(data, { cardId: 'card-aaaaaaaa', sessionId: 'session-1' })
  assert.equal(plan.sessionId, 'session-1')
  assert.deepEqual(plan.blockingCards, [])
  // 已归档的卡片不阻塞
  data.cards[1].archived = true
  assert.doesNotThrow(() => sessionArchivePlan(data, { cardId: 'card-aaaaaaaa', sessionId: 'session-1' }))
})

test('domain：batchSessionArchivePlan 聚合多卡共享会话、跳过阻塞与已归档、支持 completedBefore', async t => {
  const { store } = await testStore(t, { seedMode: 'empty' })
  const data = await store.read()
  data.cards = [
    { id: 'card-aaaaaaaa', title: 'A', status: 'done', completedAt: 1000, archived: false, sessionIds: ['session-1'] },
    { id: 'card-bbbbbbbb', title: 'B', status: 'canceled', completedAt: 2000, archived: false, sessionIds: ['session-1', 'session-2'] },
    { id: 'card-cccccccc', title: 'C', status: 'running', archived: false, sessionIds: ['session-2'] },
    { id: 'card-dddddddd', title: 'D', status: 'done', completedAt: 3000, archived: false, sessionIds: ['session-3'] },
    { id: 'card-eeeeeeee', title: 'E', status: 'done', archived: true, sessionIds: ['session-1'] },
  ]
  data.activities = []
  data.meta = { ...data.meta, revision: 1 }
  const plan = batchSessionArchivePlan(data, { archivedSessionIds: ['session-3'] })
  assert.deepEqual(plan.archivable, [{ sessionId: 'session-1', cardId: 'card-aaaaaaaa', cardIds: ['card-aaaaaaaa', 'card-bbbbbbbb'] }])
  const skippedByReason = Object.fromEntries(plan.skipped.map(item => [item.sessionId, item]))
  assert.equal(skippedByReason['session-2'].reason, 'blocking_cards')
  assert.deepEqual(skippedByReason['session-2'].blockingCards, [{ id: 'card-cccccccc', title: 'C', status: 'running' }])
  assert.equal(skippedByReason['session-3'].reason, 'already_archived')

  const oldOnly = batchSessionArchivePlan(data, { archivedSessionIds: [], completedBefore: 1500 })
  assert.deepEqual(oldOnly.archivable.map(item => item.sessionId), ['session-1'])
})

test('GET /sessions/archive 返回能力与归档集合；无宿主时 available=false', async t => {
  const { server } = await setup(t, { registry: createFakeRegistry({ archived: ['session-a'] }) })
  const res = await api(server, '/api/kanban/sessions/archive')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { ok: true, available: true, archivedSessionIds: ['session-a'] })

  const { store } = await testStore(t, { seedMode: 'empty' })
  const noHost = await startServer(t, { store })
  const res2 = await api(noHost, '/api/kanban/sessions/archive')
  assert.equal(res2.json.available, false)
})

test('POST 单卡归档：成功写 session_archived 活动并返回归档集合', async t => {
  const { server, registry } = await setup(t)
  const card = await createCard(server, '完成卡')
  await bind(server, card.id, 'session-1')
  await moveCard(server, card.id, 'done')

  const res = await api(server, `/api/kanban/cards/${card.id}/sessions/session-1/archive`, { method: 'POST' })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.card.status, 'done')
  assert.deepEqual(res.json.archivedSessionIds, ['session-1'])
  assert.equal(registry.state.archived.has('session-1'), true)

  const list = await activities(server, card.id)
  const archived = list.find(item => item.type === 'session_archived')
  assert.ok(archived, '应写入 session_archived 活动')
  assert.equal(archived.data.sessionId, 'session-1')
})

test('POST 单卡归档：未完成卡片 / 共享会话有未完成卡 / 运行中会话的拒绝路径', async t => {
  const { server } = await setup(t, { registry: createFakeRegistry({ active: ['session-active'], unknown: ['session-gone'] }) })
  const running = await createCard(server, '进行中卡')
  await moveCard(server, running.id, 'running')
  await bind(server, running.id, 'session-shared')
  const done = await createCard(server, '完成卡')
  await bind(server, done.id, 'session-shared')
  await moveCard(server, done.id, 'done')

  const notDone = await api(server, `/api/kanban/cards/${running.id}/sessions/session-shared/archive`, { method: 'POST' })
  assert.equal(notDone.status, 409)
  assert.equal(notDone.json.error.code, 'CARD_NOT_DONE')

  const busy = await api(server, `/api/kanban/cards/${done.id}/sessions/session-shared/archive`, { method: 'POST' })
  assert.equal(busy.status, 409)
  assert.equal(busy.json.error.code, 'SESSION_BUSY_CARDS')
  // sendError 把 DomainError.extra 平铺在顶层
  assert.deepEqual(busy.json.blockingCards, [{ id: running.id, title: '进行中卡', status: 'running' }])

  const activeCard = await createCard(server, '运行中会话卡')
  await bind(server, activeCard.id, 'session-active')
  await moveCard(server, activeCard.id, 'done')
  const active = await api(server, `/api/kanban/cards/${activeCard.id}/sessions/session-active/archive`, { method: 'POST' })
  assert.equal(active.status, 409)
  assert.equal(active.json.error.code, 'SESSION_ACTIVE')
  assert.deepEqual(active.json.activity, [{ kind: 'turn' }])
  const stopped = await api(server, `/api/kanban/cards/${activeCard.id}/sessions/session-active/archive`, {
    method: 'POST', body: { stopActivity: true },
  })
  assert.equal(stopped.status, 200)

  const goneCard = await createCard(server, '已删除会话卡')
  await bind(server, goneCard.id, 'session-gone')
  await moveCard(server, goneCard.id, 'done')
  const gone = await api(server, `/api/kanban/cards/${goneCard.id}/sessions/session-gone/archive`, { method: 'POST' })
  assert.equal(gone.status, 404)
  assert.equal(gone.json.error.code, 'SESSION_NOT_FOUND')
})

test('POST 取消归档：写 session_unarchived 活动且幂等', async t => {
  const { server, registry } = await setup(t, { registry: createFakeRegistry({ archived: ['session-1'] }) })
  const card = await createCard(server, '完成卡')
  await bind(server, card.id, 'session-1')
  await moveCard(server, card.id, 'done')

  const res = await api(server, `/api/kanban/cards/${card.id}/sessions/session-1/unarchive`, { method: 'POST' })
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(res.json.archivedSessionIds, [])
  assert.equal(registry.state.archived.has('session-1'), false)
  const list = await activities(server, card.id)
  assert.ok(list.find(item => item.type === 'session_unarchived'))

  const again = await api(server, `/api/kanban/cards/${card.id}/sessions/session-1/unarchive`, { method: 'POST' })
  assert.equal(again.status, 200)
})

test('POST 批量归档：dryRun 只出计划，执行时跳过运行中会话并写活动', async t => {
  const { server, registry } = await setup(t, { registry: createFakeRegistry({ active: ['session-2'] }) })
  const doneA = await createCard(server, '完成 A')
  await bind(server, doneA.id, 'session-1')
  await moveCard(server, doneA.id, 'done')
  const doneB = await createCard(server, '完成 B')
  await bind(server, doneB.id, 'session-2')
  await moveCard(server, doneB.id, 'done')
  const doneC = await createCard(server, '完成 C')
  await bind(server, doneC.id, 'session-3')
  await moveCard(server, doneC.id, 'done')
  const blocked = await createCard(server, '未完成卡')
  await bind(server, blocked.id, 'session-3')
  await moveCard(server, blocked.id, 'running')

  const dry = await api(server, '/api/kanban/sessions/archive-batch', { method: 'POST', body: { dryRun: true } })
  assert.equal(dry.status, 200)
  assert.equal(dry.json.dryRun, true)
  assert.deepEqual(dry.json.archivable.map(item => item.sessionId).sort(), ['session-1', 'session-2'])
  const drySkip = Object.fromEntries(dry.json.skipped.map(item => [item.sessionId, item.reason]))
  assert.equal(drySkip['session-3'], 'blocking_cards')
  assert.equal(registry.state.archived.size, 0, 'dryRun 不应调用宿主')

  const run = await api(server, '/api/kanban/sessions/archive-batch', { method: 'POST', body: {} })
  assert.equal(run.status, 200)
  assert.equal(run.json.dryRun, false)
  assert.deepEqual(run.json.archivable.map(item => item.sessionId), ['session-1'])
  const skip = Object.fromEntries(run.json.skipped.map(item => [item.sessionId, item.reason]))
  assert.equal(skip['session-2'], 'running')
  assert.equal(skip['session-3'], 'blocking_cards')
  assert.equal(registry.state.archived.has('session-1'), true)

  const list = await activities(server, doneA.id)
  assert.ok(list.find(item => item.type === 'session_archived' && item.data.sessionId === 'session-1'))
})

test('无宿主适配器：归档/恢复/批量执行返回 SESSION_ARCHIVE_UNAVAILABLE，GET 返回 available=false', async t => {
  const { store } = await testStore(t, { seedMode: 'empty' })
  const server = await startServer(t, { store })
  const card = await createCard(server, '完成卡')
  await bind(server, card.id, 'session-1')
  await moveCard(server, card.id, 'done')

  const state = await api(server, '/api/kanban/sessions/archive')
  assert.equal(state.json.available, false)
  const archive = await api(server, `/api/kanban/cards/${card.id}/sessions/session-1/archive`, { method: 'POST' })
  assert.equal(archive.status, 501)
  assert.equal(archive.json.error.code, 'SESSION_ARCHIVE_UNAVAILABLE')
  const unarchive = await api(server, `/api/kanban/cards/${card.id}/sessions/session-1/unarchive`, { method: 'POST' })
  assert.equal(unarchive.status, 501)
  const batch = await api(server, '/api/kanban/sessions/archive-batch', { method: 'POST', body: {} })
  assert.equal(batch.status, 200) // 批量不强制要求宿主（UI 由 available 隐藏），但执行时逐项失败
  assert.equal(batch.json.available, false)
})
