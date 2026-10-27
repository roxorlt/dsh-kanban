// 会话运行失败同步（v0.9.6）单测：宿主 turn/end → 卡片时间线 / 状态。
// 覆盖：失败判定口径、只同步主会话、自动置失败、同轮去重、恢复回进行中、监听器接线与容错。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_TURN_FAILURE, SESSION_TURN_RECOVERED,
  cardsByMainSession, createCard, createSeed, mainSessionId, normalizeStore, recordSessionTurnFailure,
  recordSessionTurnRecovered,
} from '../lib/domain.js'
import { createSessionTurnSync, registerSessionTurnSync, turnFailureOf } from '../lib/session-sync.js'

const FIXED_NOW = 1_760_000_000_000
const SESSION = 'session-main-0001'
const OTHER_SESSION = 'session-other-0002'

const emptyDraft = () => normalizeStore(createSeed('empty', FIXED_NOW), FIXED_NOW)

function runningCard(sessionId = SESSION, extra = {}) {
  const draft = emptyDraft()
  const { card } = createCard(draft, { title: '同步失败', status: 'running', sessionId }, { now: FIXED_NOW })
  Object.assign(card, extra)
  return { draft, card }
}

const failureInput = (overrides = {}) => ({
  sessionId: SESSION, turn: 3, seq: 41, at: FIXED_NOW + 1000,
  reasonKind: 'error', message: 'DeepSeek Messages transport failed', code: 'TRANSPORT',
  ...overrides,
})

function fakeStore(draft) {
  let data = draft
  const calls = { update: 0, read: 0 }
  return {
    calls,
    peek: () => data,
    read: async () => { calls.read += 1; return structuredClone(data) },
    update: async fn => {
      calls.update += 1
      const next = structuredClone(data)
      const result = await fn(next)
      data = next
      return { result, revision: 1, data }
    },
    get data() { return data },
  }
}

const turnEnd = (turn, reason, extra = {}) => ({
  type: 'turn/end', seq: extra.seq ?? 41, time: FIXED_NOW + 1000, data: { turn, reason }, ...extra,
})

test('turnFailureOf：与 DSH 聊天界面「本轮运行失败」同口径', () => {
  assert.deepEqual(turnFailureOf({ kind: 'error', error: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } }), {
    reasonKind: 'error', message: 'DeepSeek Messages transport failed', code: 'TRANSPORT',
  })
  assert.deepEqual(turnFailureOf({ kind: 'error', error: { message: '  额度不足  ' } }), { reasonKind: 'error', message: '额度不足' })
  assert.deepEqual(turnFailureOf({ kind: 'error', error: {} }), { reasonKind: 'error', message: '未知错误' })
  assert.deepEqual(turnFailureOf({ kind: 'interrupted' }), { reasonKind: 'interrupted', message: 'DSH 进程在本轮结束前退出', code: 'INTERRUPTED' })
  assert.deepEqual(turnFailureOf({ kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } }), {
    reasonKind: 'aborted', message: '已退出 DeepSeek 账号，本轮中止', code: 'ACCOUNT_SIGNED_OUT',
  })
  assert.equal(turnFailureOf({ kind: 'aborted', reason: { kind: 'user' } }), null)
  assert.equal(turnFailureOf({ kind: 'completed' }), null)
  assert.equal(turnFailureOf(undefined), null)
})

test('mainSessionId / cardsByMainSession：只认第一个绑定会话且跳过归档卡', () => {
  const { draft, card } = runningCard()
  card.sessionIds = [SESSION, OTHER_SESSION]
  assert.equal(mainSessionId(card), SESSION)
  assert.deepEqual(cardsByMainSession(draft, SESSION).map(item => item.id), [card.id])
  assert.deepEqual(cardsByMainSession(draft, OTHER_SESSION), [])
  card.archived = true
  assert.deepEqual(cardsByMainSession(draft, SESSION), [])
})

test('失败同步：进行中→失败、时间线 error 节点、同轮只记一次', () => {
  const { draft, card } = runningCard()
  const first = recordSessionTurnFailure(draft, failureInput())
  assert.equal(first.cards.length, 1)
  assert.equal(card.status, 'failed')
  const errors = draft.activities.filter(item => item.cardId === card.id && item.type === 'error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].data.kind, SESSION_TURN_FAILURE)
  assert.equal(errors[0].data.turn, 3)
  assert.equal(errors[0].data.code, 'TRANSPORT')
  assert.match(errors[0].text, /会话第 3 轮运行失败/)
  assert.match(errors[0].text, /TRANSPORT/)
  assert.equal(errors[0].actor.kind, 'system')
  const status = draft.activities.filter(item => item.cardId === card.id && item.type === 'status')
  assert.equal(status.length, 1)
  assert.equal(status[0].data.reason, SESSION_TURN_FAILURE)

  const second = recordSessionTurnFailure(draft, failureInput())
  assert.equal(second.cards.length, 0)
  assert.equal(draft.activities.filter(item => item.cardId === card.id && item.type === 'error').length, 1)
})

test('失败同步：其它状态的卡片只记时间线、不自动改状态', () => {
  for (const status of ['needs_you', 'blocked', 'done', 'canceled', 'backlog']) {
    const { draft, card } = runningCard()
    card.status = status
    const result = recordSessionTurnFailure(draft, failureInput())
    assert.equal(result.cards.length, 1, status)
    assert.equal(card.status, status, status)
    assert.equal(draft.activities.filter(item => item.cardId === card.id && item.type === 'error').length, 1, status)
  }
})

test('失败同步：非主会话 / 归档卡 / 非法事件参数不写', () => {
  const { draft, card } = runningCard()
  card.sessionIds = [SESSION, OTHER_SESSION]
  recordSessionTurnFailure(draft, failureInput({ sessionId: OTHER_SESSION }))
  assert.equal(card.status, 'running')
  recordSessionTurnFailure(draft, failureInput({ turn: 0 }))
  recordSessionTurnFailure(draft, failureInput({ sessionId: '' }))
  assert.equal(draft.activities.filter(item => item.type === 'error').length, 0)
})

test('恢复同步：自动失败标记回进行中，手工失败不回', () => {
  const { draft, card } = runningCard()
  recordSessionTurnFailure(draft, failureInput())
  assert.equal(card.status, 'failed')
  const recovered = recordSessionTurnRecovered(draft, { sessionId: SESSION, turn: 4, seq: 45, at: FIXED_NOW + 2000 })
  assert.equal(recovered.cards.length, 1)
  assert.equal(card.status, 'running')
  const progress = draft.activities.filter(item => item.cardId === card.id && item.data && item.data.kind === SESSION_TURN_RECOVERED)
  assert.equal(progress.length, 1)
  assert.equal(progress[0].data.turn, 4)

  // 手工把卡片置为失败：恢复事件不应自动回进行中
  const manual = runningCard()
  manual.card.status = 'failed'
  manual.draft.activities.push({
    id: 'ev-manual1', cardId: manual.card.id, type: 'status', actor: { kind: 'user', name: '你' },
    text: '把状态改为「失败」', at: FIXED_NOW, data: { from: 'running', to: 'failed' },
  })
  const manualResult = recordSessionTurnRecovered(manual.draft, { sessionId: SESSION, turn: 4, at: FIXED_NOW + 2000 })
  assert.equal(manualResult.cards.length, 0)
  assert.equal(manual.card.status, 'failed')
})

test('恢复同步：非失败卡不写；再次失败会重新置失败', () => {
  const { draft, card } = runningCard()
  const idle = recordSessionTurnRecovered(draft, { sessionId: SESSION, turn: 2, at: FIXED_NOW + 100 })
  assert.equal(idle.cards.length, 0)
  recordSessionTurnFailure(draft, failureInput())
  recordSessionTurnRecovered(draft, { sessionId: SESSION, turn: 4, at: FIXED_NOW + 2000 })
  assert.equal(card.status, 'running')
  recordSessionTurnFailure(draft, failureInput({ turn: 5, seq: 50, at: FIXED_NOW + 3000 }))
  assert.equal(card.status, 'failed')
  assert.equal(draft.activities.filter(item => item.cardId === card.id && item.type === 'error').length, 2)
})

test('监听器：只处理 turn/end，无关会话不写盘，失败/恢复走 store', async () => {
  const { draft, card } = runningCard()
  const store = fakeStore(draft)
  const storedCard = () => store.data.cards.find(item => item.id === card.id)
  const handle = createSessionTurnSync({ store, logger: { info() {}, warn() {} } })
  await handle({ id: SESSION }, { type: 'step/start', seq: 40, time: FIXED_NOW, data: {} })
  await handle({ id: OTHER_SESSION }, turnEnd(3, { kind: 'error', error: { message: 'x', code: 'X' } }))
  await handle({ id: SESSION }, turnEnd(3, { kind: 'completed' }))
  assert.equal(store.calls.update, 0)
  assert.equal(store.calls.read, 0)

  await handle({ id: SESSION }, turnEnd(3, { kind: 'error', error: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } }))
  assert.equal(store.calls.update, 1)
  assert.equal(storedCard().status, 'failed')

  await handle({ id: SESSION }, turnEnd(4, { kind: 'completed' }, { seq: 45 }))
  assert.equal(store.calls.update, 2)
  assert.equal(storedCard().status, 'running')
})

test('监听器：异常输入不抛错', async () => {
  const store = fakeStore(runningCard().draft)
  const handle = createSessionTurnSync({ store, logger: { info() {}, warn() {} } })
  await assert.doesNotReject(handle(undefined, undefined))
  await assert.doesNotReject(handle({}, {}))
  await assert.doesNotReject(handle({ id: SESSION }, { type: 'turn/end', data: null }))
  await assert.doesNotReject(handle({ id: SESSION }, { type: 'turn/end', seq: 1, data: { turn: 'x', reason: { kind: 'error' } } }))
})

test('registerSessionTurnSync：以 global 监听 session/event，可重复挂载并返回 disposer', () => {
  const calls = []
  const ctx = {
    on(name, handler, options) { calls.push({ name, handler, options }); return () => { calls.disposed = true } },
  }
  const dispose = registerSessionTurnSync(ctx, { store: fakeStore(runningCard().draft) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'session/event')
  assert.equal(calls[0].options.global, true)
  assert.equal(typeof calls[0].handler, 'function')
  assert.equal(typeof dispose, 'function')
  assert.equal(registerSessionTurnSync({}, {})(), undefined)
})
