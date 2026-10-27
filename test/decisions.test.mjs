// decisions.js：decision.jsonl 事件流的追加、读取、派生状态、回填与 store 接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APPROVAL_DECISION_STATES, DECISION_TYPES, buildBackfillEntries, createDecisionLog,
  decisionIdFor, normalizeDecisionEntry,
} from '../lib/decisions.js'
import {
  applySeedMode, archiveCard, createCard, createSeed, dismissStalePendingApprovals,
  hasStalePendingApprovals, normalizeStore, requestApproval, resolveApproval,
} from '../lib/domain.js'
import { createStore } from '../lib/store.js'
import { tempDir } from './helpers.mjs'

const FIXED_NOW = 1_792_700_000_000
const CARD = 'card-aaaaaaaa'
const APPROVAL = 'ap-aaaaaaaa'
const USER = { kind: 'user', name: '你' }
const AGENT = { kind: 'agent', name: 'DSH Agent' }

const readLines = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

function requestEntry(overrides = {}) {
  return {
    type: 'approval_requested',
    at: FIXED_NOW,
    boardId: 'board-default',
    cardId: CARD,
    approvalId: APPROVAL,
    actor: AGENT,
    card: { title: '测试卡', summary: '摘要', status: 'running' },
    approval: {
      title: '是否继续？',
      detail: '上下文',
      multiSelect: false,
      options: [{ id: 'yes', label: '继续', outcome: 'running' }, { id: 'no', label: '停止', tone: 'danger' }],
    },
    ...overrides,
  }
}

function resolveEntry(overrides = {}) {
  return {
    type: 'approval_resolved',
    at: FIXED_NOW + 5_000,
    boardId: 'board-default',
    cardId: CARD,
    approvalId: APPROVAL,
    actor: USER,
    card: { title: '测试卡', summary: '摘要', status: 'needs_you' },
    decision: 'approved',
    resolution: { optionIds: ['yes'], labels: ['继续'] },
    waitedMs: 5_000,
    outcomeColumn: 'running',
    ...overrides,
  }
}

async function newLog(t) {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  return { dir, file, log }
}

test('append：JSONL 格式、seq 递增、确定性 id、0600 权限', async t => {
  const { file, log } = await newLog(t)
  const written = await log.append([requestEntry(), resolveEntry()], { revision: 7 })
  assert.equal(written.length, 2)
  assert.equal(written[0].seq, 1)
  assert.equal(written[1].seq, 2)
  assert.equal(written[0].id, decisionIdFor(CARD, APPROVAL, 'requested'))
  assert.equal(written[1].id, decisionIdFor(CARD, APPROVAL, 'resolved'))
  assert.equal(written[1].requestId, written[0].id)
  assert.equal(written[0].revision, 7)
  assert.equal(written[0].source, 'live')
  assert.match(written[0].id, /^dec-[a-f0-9]{12}$/)

  const lines = await readLines(file)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].seq, 1)
  assert.equal(lines[0].type, 'approval_requested')
  assert.equal(lines[1].type, 'approval_resolved')
  assert.equal(lines[1].requestId, lines[0].id)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const list = await log.list({})
  assert.equal(list.decisions.length, 2)
  assert.equal(list.hasMore, false)
  assert.equal(list.nextBefore, null)
  assert.equal(list.total, 2)
  assert.equal(list.filtered, 2)
  assert.equal(list.waiting, 0)
  assert.equal(list.decisions[0].type, 'approval_resolved')
  assert.equal(list.decisions[1].type, 'approval_requested')
  assert.equal(list.decisions[1].state, 'resolved')
  assert.equal(list.decisions[1].decision, 'approved')
  assert.equal(list.decisions[1].closedAt, FIXED_NOW + 5_000)
})

test('list：倒序、筛选（type/cardId/boardId/since/until/source）、游标分页与派生 state', async t => {
  const { log } = await newLog(t)
  await log.append([
    requestEntry({ approvalId: 'ap-aaaaaaab', at: FIXED_NOW }),
    resolveEntry({ approvalId: 'ap-aaaaaaab', at: FIXED_NOW + 1_000 }),
    requestEntry({ approvalId: 'ap-aaaaaaac', at: FIXED_NOW + 2_000 }),
    { type: 'approval_unresolved', at: FIXED_NOW + 3_000, boardId: 'board-default', cardId: CARD, approvalId: 'ap-aaaaaaac', actor: { kind: 'system', name: 'system' }, card: { title: 't', summary: '', status: 'done' }, reason: 'archived', waitedMs: 1_000 },
    { type: 'log_initialized', at: FIXED_NOW + 4_000, source: 'backfill', counts: { cards: 0, approvals: 0, requested: 0, resolved: 0, pending: 0, activities: 0, entries: 0 } },
  ])

  const all = await log.list({})
  assert.equal(all.total, 5)
  assert.equal(all.filtered, 5)
  assert.equal(all.decisions[0].type, 'log_initialized')
  assert.equal(all.decisions.at(-1).type, 'approval_requested')
  assert.equal(all.waiting, 0)

  // 派生状态：第一条已提交 → resolved；第二条未决关闭 → unresolved；再补一条等待中的
  const resolvedRequest = all.decisions.find(entry => entry.type === 'approval_requested' && entry.approvalId === 'ap-aaaaaaab')
  assert.equal(resolvedRequest.state, 'resolved')
  assert.equal(resolvedRequest.decision, 'approved')
  assert.equal(typeof resolvedRequest.closedAt, 'number')
  const unresolvedRequest = all.decisions.find(entry => entry.type === 'approval_requested' && entry.approvalId === 'ap-aaaaaaac')
  assert.equal(unresolvedRequest.state, 'unresolved')
  assert.equal(unresolvedRequest.unresolvedReason, 'archived')

  const byType = await log.list({ type: 'approval_requested' })
  assert.equal(byType.filtered, 2)
  assert.deepEqual(byType.decisions.map(entry => entry.approvalId), ['ap-aaaaaaac', 'ap-aaaaaaab'])
  const byState = await log.list({ state: 'resolved' })
  assert.equal(byState.filtered, 1)
  assert.equal(byState.decisions[0].approvalId, 'ap-aaaaaaab')
  assert.equal(byState.waiting, 0)
  const byCard = await log.list({ cardId: CARD })
  assert.equal(byCard.filtered, 4) // log_initialized 没有 cardId

  const other = await log.list({ cardId: 'card-bbbbbbbb' })
  assert.equal(other.filtered, 0)
  const since = await log.list({ since: FIXED_NOW + 2_500 })
  assert.equal(since.filtered, 2)
  const until = await log.list({ until: FIXED_NOW + 500 })
  assert.equal(until.filtered, 1) // 只有第一条 request 在 FIXED_NOW
  const backfillOnly = await log.list({ source: 'backfill' })
  assert.equal(backfillOnly.filtered, 1)

  // 游标分页：每页 2 条，nextBefore 指向本页最后一条
  const page1 = await log.list({ limit: 2 })
  assert.equal(page1.decisions.length, 2)
  assert.equal(page1.hasMore, true)
  assert.equal(page1.nextBefore, page1.decisions[1].id)
  const page2 = await log.list({ limit: 2, before: page1.nextBefore })
  assert.equal(page2.decisions.length, 2)
  assert.equal(page2.hasMore, true)
  const page3 = await log.list({ limit: 2, before: page2.nextBefore })
  assert.equal(page3.decisions.length, 1)
  assert.equal(page3.hasMore, false)
  assert.equal(page3.nextBefore, null)
  const distinct = new Set([...page1.decisions, ...page2.decisions, ...page3.decisions].map(entry => entry.id))
  assert.equal(distinct.size, 5)

  // 非法参数 → BAD_REQUEST
  await assert.rejects(log.list({ type: 'nope' }), error => error.code === 'BAD_REQUEST')
  await assert.rejects(log.list({ state: 'pending' }), error => error.code === 'BAD_REQUEST')
  await assert.rejects(log.list({ source: 'seed' }), error => error.code === 'BAD_REQUEST')
  await assert.rejects(log.list({ since: 'abc' }), error => error.code === 'BAD_REQUEST')
  await assert.rejects(log.list({ limit: 0 }), error => error.code === 'BAD_REQUEST')
  await assert.rejects(log.list({ cardId: 'bad' }), error => error.code === 'BAD_REQUEST')
  await assert.rejects(log.list({ before: 'dec-ffffffffffff' }), error => error.code === 'BAD_REQUEST')
  assert.deepEqual(APPROVAL_DECISION_STATES, ['waiting', 'resolved', 'unresolved'])
  assert.ok(DECISION_TYPES.includes('data_reset'))
})

test('stats / exportText：计数、等待数、起点、坏行统计与原样导出', async t => {
  const { file, log } = await newLog(t)
  await log.append([requestEntry(), resolveEntry()])
  const stats = await log.stats()
  assert.equal(stats.logVersion, 1)
  assert.equal(stats.file, file)
  assert.equal(stats.exists, true)
  assert.equal(stats.entries, 2)
  assert.equal(stats.skippedLines, 0)
  assert.equal(stats.byType.approval_requested, 1)
  assert.equal(stats.byType.approval_resolved, 1)
  assert.equal(stats.waiting, 0)
  assert.equal(stats.firstAt, FIXED_NOW)
  assert.equal(stats.lastAt, FIXED_NOW + 5_000)
  assert.equal(stats.initializedAt, undefined)
  assert.ok(stats.sizeBytes > 0)

  // 未初始化时 exists=false / export 为空
  const emptyDir = await tempDir(t)
  const emptyFile = join(emptyDir, 'decisions.jsonl')
  const empty = createDecisionLog({ file: emptyFile })
  t.after(() => empty.close())
  assert.equal((await empty.stats()).exists, false)
  assert.equal(await empty.exportText(), '')

  // 原样导出（含未知字段，不做规范化）
  const raw = await readFile(file, 'utf8')
  assert.equal(await log.exportText(), raw)
})

test('坏行容忍：跳过但保留、seq 连续、写入从有效行继续', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  const validA = JSON.stringify({ ...requestEntry(), id: decisionIdFor(CARD, APPROVAL, 'requested'), seq: 1 })
  const validB = JSON.stringify({ ...resolveEntry(), id: decisionIdFor(CARD, APPROVAL, 'resolved'), seq: 2, requestId: decisionIdFor(CARD, APPROVAL, 'requested') })
  await writeFile(file, validA + '\n{坏行不是 JSON\n' + validB + '\n', 'utf8')
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  const list = await log.list({})
  assert.equal(list.total, 2)
  const stats = await log.stats()
  assert.equal(stats.skippedLines, 1)
  // 坏行不被删除
  assert.match(await readFile(file, 'utf8'), /\{坏行不是 JSON/)
  // 新写入接着有效行编号
  const written = await log.append([requestEntry({ approvalId: 'ap-bbbbbbbb', at: FIXED_NOW + 9_000 })])
  assert.equal(written[0].seq, 3)
  assert.equal((await log.stats()).entries, 3)
})

test('normalizeDecisionEntry：未知类型/缺关键字段返回 null，文本与字段做宽松规范化', () => {
  assert.equal(normalizeDecisionEntry(null), null)
  assert.equal(normalizeDecisionEntry({ type: 'unknown', at: 1 }), null)
  assert.equal(normalizeDecisionEntry({ type: 'approval_requested', at: 1 }), null)
  assert.equal(normalizeDecisionEntry({ type: 'approval_resolved', cardId: CARD, approvalId: APPROVAL, at: 1, actor: USER }), null) // 缺 decision
  assert.equal(normalizeDecisionEntry({ type: 'approval_unresolved', cardId: CARD, approvalId: APPROVAL, at: 1, reason: 'bad' }), null)
  assert.equal(normalizeDecisionEntry({ type: 'data_reset', at: 1, mode: 'nope' }), null)

  const request = normalizeDecisionEntry({ ...requestEntry(), at: 123, summary: undefined })
  assert.equal(request.at, 123)
  assert.equal(request.source, 'live')
  assert.equal(request.approval.title, '是否继续？')
  assert.equal(request.id, decisionIdFor(CARD, APPROVAL, 'requested'))
  assert.equal(normalizeDecisionEntry(requestEntry({ card: { title: 'x'.repeat(500), summary: 'y'.repeat(900), status: 'weird' } })).card.title.length, 120)
})

test('initializeFromSnapshot：从 data.json 回填请求/已决/未决 + log_initialized，第二次不重复', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  // 在 demo 种子上先提交一条审批，确保快照里同时有已决与待决审批。
  const snapshot = normalizeStore(createSeed('demo', FIXED_NOW), FIXED_NOW)
  const pendingCard = snapshot.cards.find(card => (card.approvals || []).some(approval => approval.status === 'pending'))
  const pending = pendingCard.approvals.find(approval => approval.status === 'pending')
  resolveApproval(snapshot, pendingCard.id, pending.id, {
    optionIds: [pending.options[0].id], actor: USER, now: FIXED_NOW + 1_000,
  })

  const result = await log.initializeFromSnapshot(snapshot, { now: FIXED_NOW + 10_000 })
  assert.equal(result.created, true)
  assert.ok(result.entries > 0)
  const lines = await readLines(file)
  assert.equal(lines.length, result.entries)
  assert.equal(lines.at(-1).type, 'log_initialized')
  assert.equal(lines.at(-1).source, 'backfill')
  assert.ok(lines.at(-1).counts.approvals > 0)
  // 每条事件都有 id/seq；resolved 的 requestId 指向 requested
  const requested = new Map(lines.filter(line => line.type === 'approval_requested').map(line => [line.id, line]))
  const resolved = lines.filter(line => line.type === 'approval_resolved')
  assert.ok(resolved.length > 0)
  for (const entry of resolved) assert.ok(requested.has(entry.requestId))
  assert.ok([...requested.values()].every(entry => entry.approval.options.length > 0))
  const stats = await log.stats()
  assert.equal(stats.initializedAt, FIXED_NOW + 10_000)

  // 已初始化：不重复回填
  const again = await log.initializeFromSnapshot(snapshot, { now: FIXED_NOW + 20_000 })
  assert.equal(again.created, false)
  assert.equal((await log.stats()).entries, lines.length)
})

test('initializeFromSnapshot：只剩活动记录的审批回填为 degraded，并保持审批关联', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  const snapshot = {
    cards: [{ id: 'card-bbbbbbbb', boardId: 'board-default', title: '只剩活动的卡', summary: '', status: 'done', updatedAt: FIXED_NOW, approvals: [] }],
    activities: [
      { id: 'ev-000001', cardId: 'card-bbbbbbbb', type: 'approval_requested', actor: AGENT, text: '请求确认：「旧问题」', at: FIXED_NOW, data: { approvalId: 'ap-bbbbbbbb', options: ['yes'] } },
      { id: 'ev-000002', cardId: 'card-bbbbbbbb', type: 'approval_resolved', actor: USER, text: '已批准「旧问题」：继续', at: FIXED_NOW + 2_000, data: { approvalId: 'ap-bbbbbbbb', decision: 'approved', optionIds: ['yes'] } },
    ],
  }
  await log.initializeFromSnapshot(snapshot, { now: FIXED_NOW + 5_000 })
  const list = await log.list({ cardId: 'card-bbbbbbbb' })
  const request = list.decisions.find(entry => entry.type === 'approval_requested')
  const resolve = list.decisions.find(entry => entry.type === 'approval_resolved')
  assert.equal(request.degraded, true)
  assert.equal(request.approval.title, '旧问题')
  assert.equal(request.rawText, '请求确认：「旧问题」')
  assert.equal(resolve.degraded, true)
  assert.equal(resolve.decision, 'approved')
  assert.equal(resolve.waitedMs, 2_000)
  assert.equal(resolve.requestId, request.id)
  // 只剩活动记录：没有卡片内审批 → log_initialized 的 approvals 计数为 0
  assert.equal((await log.stats()).byType.log_initialized, 1)
})

test('store 接线：请求/提交审批写 2 条事件、带 revision、data.json 不留 __decisions', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  t.after(() => store.close())
  assert.ok(store.decisionLog)
  const { result: created } = await store.update(draft => createCard(draft, { title: '接线卡', status: 'running' }))
  const cardId = created.card.id
  const { result: requested, revision: requestedRevision } = await store.update(draft => requestApproval(draft, cardId, {
    title: '继续吗？', options: [{ id: 'yes', label: '继续', outcome: 'running' }],
  }))
  assert.equal((await store.decisionLog.stats()).entries, 1)
  const { revision: resolvedRevision } = await store.update(draft => resolveApproval(draft, cardId, requested.approval.id, { optionIds: ['yes'], actor: USER }))
  const lines = await readLines(join(dir, 'decisions.jsonl'))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].revision, requestedRevision)
  assert.equal(lines[1].revision, resolvedRevision)
  assert.equal(lines[1].requestId, lines[0].id)
  assert.equal(lines[1].outcomeColumn, 'running')
  const dataText = await readFile(join(dir, 'data.json'), 'utf8')
  assert.equal(dataText.includes('__decisions'), false)
  const data = await store.read()
  assert.equal(data.meta.revision, resolvedRevision)
  assert.equal(data.cards.find(card => card.id === cardId).approvals[0].status, 'approved')

  // 没有决策事件的操作不写日志：新建第二张卡后行数不变
  await store.update(draft => createCard(draft, { title: '无审批卡' }))
  assert.equal((await readLines(join(dir, 'decisions.jsonl'))).length, 2)
})

test('store 接线：日志写失败会中止操作（DECISION_LOG_IO），data.json 不提交', async t => {
  const dir = await tempDir(t)
  // 用同名目录占住 decisions.jsonl，让 append 必然失败
  await mkdir(join(dir, 'decisions.jsonl'))
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  t.after(() => store.close())
  const { result: created } = await store.update(draft => createCard(draft, { title: '日志失败卡', status: 'running' }))
  const cardId = created.card.id
  const beforeRevision = store.revision
  await assert.rejects(
    store.update(draft => requestApproval(draft, cardId, { title: '会被日志失败拦住', options: ['继续'] })),
    error => error.code === 'DECISION_LOG_IO' && /决策日志写入失败/.test(error.message),
  )
  const data = await store.read()
  assert.equal(data.meta.revision, beforeRevision)
  assert.equal(data.cards.find(card => card.id === cardId).approvals.length, 0)
  assert.equal(data.cards.find(card => card.id === cardId).status, 'running')
})

test('归档 / 离开待你确认 / seed 重置：pending 审批关闭并落未决事件', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  t.after(() => store.close())
  const { result: created } = await store.update(draft => createCard(draft, { title: '未决卡', status: 'running' }))
  const cardId = created.card.id
  await store.update(draft => requestApproval(draft, cardId, { title: '等你选择', options: ['好'] }))
  await store.update(draft => archiveCard(draft, cardId, { actor: USER }))
  let data = await store.read()
  const archived = data.cards.find(card => card.id === cardId)
  assert.equal(archived.archived, true)
  assert.equal(archived.approvals[0].status, 'dismissed')
  let decisions = await store.decisionLog.list({ cardId })
  const unresolved = decisions.decisions.find(entry => entry.type === 'approval_unresolved')
  assert.equal(unresolved.reason, 'archived')
  assert.equal(unresolved.actor.kind, 'user')

  // seed 重置：等待中的审批收口为 data_reset，data.json 清空但日志保留
  const { result: second } = await store.update(draft => createCard(draft, { title: '重置前的卡', status: 'running' }))
  const { result: secondApproval } = await store.update(draft => requestApproval(draft, second.card.id, { title: '重置前的问题', options: ['好'] }))
  const { result: mode } = await store.update(draft => applySeedMode(draft, 'empty', FIXED_NOW))
  assert.equal(mode.cards.length, 0)
  data = await store.read()
  assert.equal(data.cards.length, 0)
  decisions = await store.decisionLog.list({})
  const reset = decisions.decisions.find(entry => entry.type === 'data_reset')
  assert.equal(reset.mode, 'empty')
  assert.equal(reset.before.pending, 1)
  const resetUnresolved = decisions.decisions.find(entry => entry.type === 'approval_unresolved' && entry.reason === 'data_reset')
  assert.ok(resetUnresolved)
  assert.equal(resetUnresolved.approvalId, secondApproval.approval.id)
  assert.equal(decisions.decisions.filter(entry => entry.type === 'approval_unresolved' && entry.reason === 'data_reset').length, 1)
})

test('单卡 20 条审批上限：被挤掉的 pending 审批记 trimmed 未决事件', () => {
  const card = { id: 'card-cccccccc', boardId: 'board-default', title: '上限卡', status: 'running', approvals: [], version: 1, updatedAt: FIXED_NOW, createdAt: FIXED_NOW }
  for (let index = 0; index < 20; index += 1) {
    card.approvals.push({
      id: 'ap-' + String(index).padStart(6, '0'),
      title: '旧审批 ' + index,
      multiSelect: false,
      options: [{ id: 'ok', label: '好' }],
      status: 'pending',
      requestedBy: AGENT,
      requestedAt: FIXED_NOW,
    })
  }
  const data = { boards: [{ id: 'board-default', name: 'DSH 看板', cardOrder: { backlog: [], running: [], needs_you: [], done: [] }, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }], cards: [card], activities: [], meta: { createdAt: FIXED_NOW, updatedAt: FIXED_NOW, revision: 1 } }
  const requested = requestApproval(data, card.id, { title: '第 21 条', options: ['好'] }, { now: FIXED_NOW + 1 })
  assert.equal(card.approvals.length, 20)
  const events = data.__decisions || []
  const trimmed = events.find(entry => entry.type === 'approval_unresolved' && entry.reason === 'trimmed')
  assert.ok(trimmed)
  assert.equal(trimmed.approvalId, 'ap-000000')
  assert.equal(trimmed.waitedMs, 1)
  assert.ok(events.some(entry => entry.type === 'approval_requested' && entry.approvalId === requested.approval.id))
})

test('decisionIdFor：确定性、格式合法、不同 kind 得到不同 id', () => {
  const a = decisionIdFor(CARD, APPROVAL, 'requested')
  const b = decisionIdFor(CARD, APPROVAL, 'requested')
  assert.equal(a, b)
  assert.match(a, /^dec-[a-f0-9]{12}$/)
  assert.notEqual(decisionIdFor(CARD, APPROVAL, 'resolved'), a)
  assert.notEqual(decisionIdFor(CARD, 'ap-aaaaaaab', 'requested'), a)
  // 回填与在线写入对同一条审批得到同样的 requestId
  const backfilled = buildBackfillEntries(normalizeStore(createSeed('demo', FIXED_NOW), FIXED_NOW), { now: FIXED_NOW + 1 })
  const requests = backfilled.filter(entry => entry.type === 'approval_requested')
  assert.ok(requests.length > 0)
  assert.ok(requests.every(entry => typeof entry.id === 'undefined' || /^dec-/.test(entry.id)))
})

test('initializeFromSnapshot：以 log_initialized 标记判断，先有实时事件也会补回填且不产生重复 id', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  const snapshot = normalizeStore(createSeed('demo', FIXED_NOW), FIXED_NOW)
  // 模拟启动瞬间先来了实时写入：写的就是快照里某条 pending 审批（同一 cardId+approvalId → 同一确定性 id）
  const pendingCard = snapshot.cards.find(card => (card.approvals || []).some(approval => approval.status === 'pending'))
  const pending = pendingCard.approvals.find(approval => approval.status === 'pending')
  await log.append([{
    type: 'approval_requested',
    at: FIXED_NOW,
    boardId: pendingCard.boardId,
    cardId: pendingCard.id,
    approvalId: pending.id,
    actor: AGENT,
    card: { title: pendingCard.title, summary: '', status: 'running' },
    approval: pending,
  }])
  const result = await log.initializeFromSnapshot(snapshot, { now: FIXED_NOW + 10_000 })
  assert.equal(result.created, true)
  const lines = await readLines(file)
  assert.equal(lines[0].source, 'live') // 实时事件仍在文件开头
  assert.equal(lines.at(-1).type, 'log_initialized')
  // 实时写入的那条不会被回填重复写
  assert.equal(new Set(lines.map(line => line.id)).size, lines.length, '事件 id 不应重复')
  const requests = lines.filter(line => line.type === 'approval_requested')
  assert.equal(requests.length, 3) // demo 种子 3 条 pending 审批
  assert.equal(new Set(requests.map(line => line.id)).size, 3)
  // waiting 按唯一 requestId 计数：3 条都还在等
  assert.equal((await log.stats()).waiting, 3)
  // 再有标记后不再回填
  const again = await log.initializeFromSnapshot(snapshot, { now: FIXED_NOW + 20_000 })
  assert.equal(again.created, false)
})

test('历史重复 id（旧竞态遗留）：waiting 按唯一 requestId 计数、分页游标不会死循环', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  const base = { ...requestEntry(), id: decisionIdFor(CARD, APPROVAL, 'requested') }
  await writeFile(file, `${JSON.stringify({ ...base, seq: 1 })}\n${JSON.stringify({ ...base, seq: 2 })}\n`, 'utf8')
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  assert.equal((await log.stats()).waiting, 1)
  assert.equal((await log.list({ state: 'waiting' })).filtered, 2) // 两条都命中筛选，但 waiting 只算 1
  let before
  let pages = 0
  let visited = 0
  for (;;) {
    const page = await log.list({ limit: 1, before })
    pages += 1
    visited += page.decisions.length
    assert.ok(pages < 10, '分页不应死循环')
    if (!page.hasMore) break
    before = page.nextBefore
  }
  // 重复 id 的游标语义：回到重复 id 时跳过整组（防死循环），不保证逐条翻页
  assert.ok(visited >= 1)
  assert.ok(pages <= 3)
})

test('历史遗留 pending：回填后静默置 dismissed，日志与 data 一致且幂等', async t => {
  const dir = await tempDir(t)
  const seed = normalizeStore(createSeed('demo', FIXED_NOW), FIXED_NOW)
  const legacyCard = seed.cards.find(card => (card.approvals || []).some(approval => approval.status === 'pending'))
  legacyCard.status = 'done' // 模拟旧版本：卡片被拖走，但审批仍 pending
  legacyCard.updatedAt = FIXED_NOW + 1_000
  await writeFile(join(dir, 'data.json'), JSON.stringify(seed), 'utf8')
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  t.after(() => store.close())
  const snapshot = await store.read()
  assert.equal(hasStalePendingApprovals(snapshot), true)
  await store.decisionLog.initializeFromSnapshot(snapshot, { now: FIXED_NOW + 5_000 })
  const { result: count } = await store.update(draft => dismissStalePendingApprovals(draft, { now: FIXED_NOW + 5_000 }))
  assert.ok(count >= 1)
  const stored = (await store.read()).cards.find(card => card.id === legacyCard.id)
  assert.equal(stored.approvals.some(approval => approval.status === 'pending'), false)
  assert.ok(stored.approvals.some(approval => approval.status === 'dismissed'))
  const events = await store.decisionLog.list({ cardId: legacyCard.id })
  const unresolved = events.decisions.filter(entry => entry.type === 'approval_unresolved')
  assert.ok(unresolved.length >= 1)
  assert.equal(unresolved[0].reason, 'left_needs_you')
  const request = events.decisions.find(entry => entry.type === 'approval_requested')
  assert.equal(request.state, 'unresolved')
  // 幂等：再次启动同步不会重复改动
  const { result: again } = await store.update(draft => dismissStalePendingApprovals(draft, { now: FIXED_NOW + 6_000 }))
  assert.equal(again, 0)
  assert.equal(hasStalePendingApprovals(await store.read()), false)
})

test('applySeedMode demo：重新播种的演示审批补请求事件，避免 resolved 孤儿', () => {
  const draft = normalizeStore(createSeed('empty', FIXED_NOW), FIXED_NOW)
  applySeedMode(draft, 'demo', FIXED_NOW + 1_000)
  const pending = draft.cards.flatMap(card => (card.approvals || []).filter(approval => approval.status === 'pending').map(approval => ({ card, approval })))
  assert.ok(pending.length >= 3)
  const requested = (draft.__decisions || []).filter(event => event.type === 'approval_requested')
  assert.equal(requested.length, pending.length)
  const pendingKeys = new Set(pending.map(item => `${item.card.id}:${item.approval.id}`))
  for (const event of requested) assert.ok(pendingKeys.has(`${event.cardId}:${event.approvalId}`))
  // 演示审批后来被提交时，resolved 的 requestId 能对上（确定性 id）
  const target = pending[0]
  resolveApproval(draft, target.card.id, target.approval.id, { optionIds: [target.approval.options[0].id], actor: USER, now: FIXED_NOW + 2_000 })
  const resolved = (draft.__decisions || []).find(event => event.type === 'approval_resolved' && event.approvalId === target.approval.id)
  assert.ok(resolved)
  assert.deepEqual(resolved.resolution.optionIds, [target.approval.options[0].id])
})

test('启动初始化：回填/遗留迁移与 live 写在同一个 store 队列里串行，只产生一条收口', async t => {
  const dir = await tempDir(t)
  // 构造旧版本遗留：卡片已离开待你确认（done），审批仍 pending
  const seed = normalizeStore(createSeed('demo', FIXED_NOW), FIXED_NOW)
  const legacyCard = seed.cards.find(card => (card.approvals || []).some(approval => approval.status === 'pending'))
  const legacyApproval = legacyCard.approvals.find(approval => approval.status === 'pending')
  legacyCard.status = 'done'
  legacyCard.updatedAt = FIXED_NOW + 1_000
  await writeFile(join(dir, 'data.json'), JSON.stringify(seed), 'utf8')
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  t.after(() => store.close())

  // 模拟插件启动：一个 store.update 里回填 + 迁移；紧接着（同队列）来了一个 live 归档。
  const startup = store.update(draft => (async () => {
    const backfill = await store.decisionLog.initializeFromSnapshot(draft)
    const staleClosed = dismissStalePendingApprovals(draft)
    return { ...backfill, staleClosed }
  })())
  const live = store.update(draft => archiveCard(draft, legacyCard.id, { actor: USER, now: FIXED_NOW + 9_000 }))
  const [{ result: startupResult }] = await Promise.all([startup, live])
  assert.equal(startupResult.created, true)
  assert.ok(startupResult.staleClosed >= 1)

  const data = await store.read()
  const storedCard = data.cards.find(card => card.id === legacyCard.id)
  assert.equal(storedCard.archived, true)
  assert.equal(storedCard.approvals.find(approval => approval.id === legacyApproval.id).status, 'dismissed')

  const events = await store.decisionLog.list({ cardId: legacyCard.id })
  const closeEvents = events.decisions.filter(entry => entry.type === 'approval_unresolved' || entry.type === 'approval_resolved')
  assert.equal(closeEvents.length, 1, '同一审批只应有一条收口事件')
  assert.equal(closeEvents[0].type, 'approval_unresolved')
  assert.equal(closeEvents[0].reason, 'left_needs_you')
  const requests = events.decisions.filter(entry => entry.type === 'approval_requested' && entry.approvalId === legacyApproval.id)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].state, 'unresolved')
})

test('收口感知回填：日志里已有 live 收口时，回填不再补第二条收口', async t => {
  const dir = await tempDir(t)
  const seed = normalizeStore(createSeed('demo', FIXED_NOW), FIXED_NOW)
  const card = seed.cards.find(item => (item.approvals || []).some(approval => approval.status === 'pending'))
  const approval = card.approvals.find(item => item.status === 'pending')
  // 模拟「上一进程 live 归档收口后」的数据：卡片已归档、审批已 dismissed
  card.archived = true
  card.archivedAt = FIXED_NOW + 500
  card.status = 'done'
  approval.status = 'dismissed'
  approval.resolvedAt = FIXED_NOW + 500
  approval.resolvedBy = USER
  await writeFile(join(dir, 'data.json'), JSON.stringify(seed), 'utf8')
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  t.after(() => store.close())
  // 预写一条 live 未决事件（模拟上一进程的收口；文件还没有 log_initialized 标记）
  await store.decisionLog.append([{
    type: 'approval_unresolved',
    at: FIXED_NOW + 500,
    boardId: card.boardId,
    cardId: card.id,
    approvalId: approval.id,
    actor: USER,
    card: { title: card.title, summary: '', status: 'done' },
    reason: 'archived',
    waitedMs: 500,
  }])
  const result = await store.decisionLog.initializeFromSnapshot(await store.read(), { now: FIXED_NOW + 5_000 })
  assert.equal(result.created, true)
  const events = await store.decisionLog.list({ cardId: card.id })
  const closes = events.decisions.filter(entry => entry.type === 'approval_unresolved' || entry.type === 'approval_resolved')
  assert.equal(closes.filter(entry => entry.approvalId === approval.id).length, 1, '不应补第二条收口')
  assert.equal(closes.find(entry => entry.approvalId === approval.id).reason, 'archived')
  const request = events.decisions.find(entry => entry.type === 'approval_requested' && entry.approvalId === approval.id)
  assert.equal(request.state, 'unresolved')
})

test('已存在的日志文件在下次 append 时收紧为 0600', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  await writeFile(file, JSON.stringify({ ...requestEntry(), id: decisionIdFor(CARD, APPROVAL, 'requested'), seq: 1 }) + '\n', { mode: 0o644 })
  await chmod(file, 0o644)
  assert.equal((await stat(file)).mode & 0o777, 0o644)
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  await log.append([resolveEntry()])
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('导出原始字节：invalid UTF-8 不被替换，且与文件字节一致', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  const validLine = JSON.stringify({ ...requestEntry(), id: decisionIdFor(CARD, APPROVAL, 'requested'), seq: 1 })
  const raw = Buffer.concat([Buffer.from(validLine + '\n', 'utf8'), Buffer.from([0xff, 0xfe, 0x0a])])
  await writeFile(file, raw)
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  const bytes = await log.exportBytes()
  assert.deepEqual(bytes, await readFile(file))
  assert.equal(bytes.includes(0xff), true, '原始 0xff 应保留')
  // 文本视图允许替换为 U+FFFD（HTTP 导出走 exportBytes，不受影响）
  assert.ok((await log.exportText()).includes('\uFFFD'))
})

test('坏行导致 seq 断档：新追加的 seq 不与原始文件里的任何 seq 重号', async t => {
  const dir = await tempDir(t)
  const file = join(dir, 'decisions.jsonl')
  const first = { ...requestEntry(), approvalId: 'ap-aaaaaaab', id: decisionIdFor(CARD, 'ap-aaaaaaab', 'requested'), seq: 1 }
  // 原本 seq=2 的事件整行损坏；seq=3 的事件完好
  const third = { ...requestEntry(), approvalId: 'ap-aaaaaaac', id: decisionIdFor(CARD, 'ap-aaaaaaac', 'requested'), seq: 3 }
  await writeFile(file, `${JSON.stringify(first)}\n{"broken":\n${JSON.stringify(third)}\n`, 'utf8')
  const log = createDecisionLog({ file })
  t.after(() => log.close())
  assert.equal((await log.stats()).skippedLines, 1)
  const [appended] = await log.append([resolveEntry()])
  assert.equal(appended.seq, 4)
  const rawSeqs = (await readFile(file, 'utf8')).trim().split('\n').filter(line => line.startsWith('{') && line.endsWith('}')).map(line => JSON.parse(line).seq)
  assert.equal(new Set(rawSeqs).size, rawSeqs.length, `原始文件 seq 不应重复：${rawSeqs.join(',')}`)
})

test('decisionIdFor：sha1 固定向量（改算法会被测出）', () => {
  assert.equal(decisionIdFor('card-aaaaaaaa', 'ap-aaaaaaaa', 'requested'), 'dec-fe9f4b09ce31')
  assert.equal(decisionIdFor('card-aaaaaaaa', 'ap-aaaaaaaa', 'resolved'), 'dec-caa31834f73b')
})

test('多题 + 自定义回答 + 备注：决策日志完整保留，且 resolved 能关联到请求', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  t.after(() => store.close())
  const { result: created } = await store.update(draft => createCard(draft, { title: '多题决策卡', status: 'running' }))
  const cardId = created.card.id
  const { result: requested } = await store.update(draft => requestApproval(draft, cardId, {
    detail: '需要逐题确认',
    questions: [
      { header: '方案', question: '选哪个方案？', options: [{ id: 'a', label: '方案 A', description: '稳妥' }, { id: 'b', label: '方案 B' }] },
      { header: '范围', question: '还要带哪些？', multiSelect: true, options: [{ id: 'unit', label: '单测' }, { id: 'build', label: '构建' }] },
    ],
  }))
  const questions = requested.approval.questions
  await store.update(draft => resolveApproval(draft, cardId, requested.approval.id, {
    answers: [
      { questionId: questions[1].id, optionIds: ['unit'] },
      { questionId: questions[0].id, custom: '用方案 C（自定义说明）' },
    ],
    comment: '统一备注：按 C 做',
    actor: USER,
  }))
  const events = await store.decisionLog.list({ cardId })
  const request = events.decisions.find(entry => entry.type === 'approval_requested')
  assert.equal(request.approval.questions.length, 2)
  assert.equal(request.approval.questions[0].options[0].description, '稳妥')
  assert.equal(request.state, 'resolved')
  const resolved = events.decisions.find(entry => entry.type === 'approval_resolved')
  assert.equal(resolved.requestId, request.id)
  assert.equal(resolved.decision, 'approved')
  assert.equal(resolved.resolution.comment, '统一备注：按 C 做')
  const custom = resolved.resolution.answers.find(answer => answer.custom)
  assert.equal(custom.custom, '用方案 C（自定义说明）')
  assert.deepEqual(resolved.resolution.optionIds, ['unit'])
  assert.equal(resolved.outcomeColumn, 'running')
  assert.ok(resolved.waitedMs >= 0)
})
