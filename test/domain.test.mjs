// domain.js：状态/列映射、种子结构、规范化、写操作原语（卡片/移动/审批/会话/完成/归档）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COLUMNS, COLUMN_OF_STATUS, DEFAULT_BOARD_ID, LIMITS, STATUSES, STATUS_OF_COLUMN, DomainError,
  ackCard, applySeedMode, archiveCard, cardsOfBoard, cleanText, completeCard, countsFor, createCard,
  createSeed, isValidId, linkSession, moveCard, newActivityId, newApprovalId, newArtifactId, newBoardId,
  newCardId, newChecklistId, normalizeStore, patchCard, requestApproval, requireCard, resolveApproval,
  sortColumnCards, unlinkSession,
} from '../lib/domain.js'

const FIXED_NOW = 1_760_000_000_000
const seedDraft = () => normalizeStore(createSeed('demo', FIXED_NOW), FIXED_NOW)
const findCardByStatus = (draft, status) => draft.cards.find(card => card.status === status)

test('状态与列映射覆盖全部状态，且与代表 status 自洽', () => {
  assert.equal(Object.keys(COLUMN_OF_STATUS).length, STATUSES.length)
  for (const status of STATUSES) assert.ok(COLUMNS.includes(COLUMN_OF_STATUS[status]))
  for (const column of COLUMNS) assert.equal(COLUMN_OF_STATUS[STATUS_OF_COLUMN[column]], column)
  assert.equal(COLUMN_OF_STATUS.blocked, 'needs_you')
  assert.equal(COLUMN_OF_STATUS.failed, 'needs_you')
  assert.equal(COLUMN_OF_STATUS.canceled, 'done')
})

test('ID 生成器符合契约格式且唯一', () => {
  const generators = [newBoardId, newCardId, newApprovalId, newActivityId, newChecklistId, newArtifactId]
  const patterns = [/^board-[a-f0-9]{8}$/, /^card-[a-f0-9]{8}$/, /^ap-[a-f0-9]{8}$/, /^ev-[a-f0-9]{8}$/, /^ck-[a-f0-9]{6}$/, /^art-[a-f0-9]{6}$/]
  generators.forEach((generate, index) => {
    const ids = new Set(Array.from({ length: 20 }, generate))
    assert.equal(ids.size, 20)
    for (const id of ids) {
      assert.match(id, patterns[index])
      assert.ok(isValidId(id))
    }
  })
  assert.ok(isValidId(DEFAULT_BOARD_ID))
  assert.ok(!isValidId('card-XYZ'))
  assert.ok(!isValidId('card-abc'))
})

test('demo 种子覆盖五层摘要与 required 状态形态，时间戳相对固定 now', () => {
  const seed = createSeed('demo', FIXED_NOW)
  assert.equal(seed.schemaVersion, 1)
  assert.equal(seed.boards.length, 1)
  assert.equal(seed.boards[0].id, DEFAULT_BOARD_ID)
  assert.equal(seed.boards[0].name, 'DSH 看板')
  assert.ok(seed.cards.length >= 5 && seed.cards.length <= 6)
  const statuses = new Set(seed.cards.map(card => card.status))
  for (const required of ['running', 'needs_you', 'blocked', 'done', 'backlog']) assert.ok(statuses.has(required), required)
  assert.ok(seed.cards.every(card => card.project === 'dsh-kanban'))
  const running = seed.cards.find(card => card.status === 'running')
  assert.ok(running.currentAction && running.progress && running.checklists.length >= 2)
  assert.ok(seed.activities.filter(item => item.cardId === running.id).length >= 3)
  const needsYou = seed.cards.find(card => card.status === 'needs_you')
  const pending = needsYou.approvals.find(approval => approval.status === 'pending')
  assert.ok(pending)
  assert.equal(pending.options.length, 2)
  assert.ok(pending.options.every(option => option.id && option.label))
  const done = seed.cards.find(card => card.status === 'done')
  assert.ok(done.result && done.completedAt)
  for (const card of seed.cards) {
    assert.ok(card.createdAt <= FIXED_NOW)
    assert.ok(card.updatedAt <= FIXED_NOW)
  }
  for (const activity of seed.activities) assert.ok(activity.at <= FIXED_NOW)
  // 每张卡恰好出现在一列的 cardOrder 中
  const ordered = Object.values(seed.boards[0].cardOrder).flat()
  assert.equal(ordered.length, seed.cards.length)
  assert.equal(new Set(ordered).size, seed.cards.length)
})

test('normalizeStore 修复缺失字段、非法状态、重复标签/会话，丢弃孤儿 activity', () => {
  const data = normalizeStore({
    boards: [{ id: DEFAULT_BOARD_ID, cardOrder: { backlog: ['card-zzzzzzzz'], running: 'x' } }],
    cards: [{ id: 'card-deadbeef', boardId: DEFAULT_BOARD_ID, title: '  带空格的标题  ', status: 'weird', labels: ['a', 'a'], sessionIds: ['s1', 's1'], approvals: [{ title: '确认?', options: [{ label: '好' }] }] }],
    activities: [
      { cardId: 'card-missing', text: '孤儿节点' },
      { cardId: 'card-deadbeef', text: ' 保留  ', at: 5, type: 'progress' },
    ],
    meta: {},
  }, FIXED_NOW)
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.cards.length, 1)
  const card = data.cards[0]
  assert.equal(card.title, '带空格的标题')
  assert.equal(card.status, 'backlog')
  assert.deepEqual(card.labels, ['a'])
  assert.deepEqual(card.sessionIds, ['s1'])
  assert.equal(card.approvals.length, 1)
  assert.equal(card.approvals[0].status, 'pending')
  assert.equal(data.activities.length, 1)
  assert.equal(data.activities[0].text, '保留')
  assert.equal(data.meta.revision, 0)
  assert.equal(data.boards[0].name, '未命名看板')
  assert.throws(() => normalizeStore(null), error => error instanceof DomainError && error.code === 'STORE_DATA_INVALID')
  assert.throws(() => normalizeStore({}), error => error.code === 'STORE_DATA_INVALID')
})

test('createCard：默认列、ID/version、截断、startedAt、created 节点、插入列头', () => {
  const draft = seedDraft()
  const board = draft.boards[0]
  const before = draft.cards.length
  const { card, activity } = createCard(draft, {
    boardId: DEFAULT_BOARD_ID,
    title: 'x'.repeat(300),
    summary: '摘要'.repeat(200),
    status: 'running',
    priority: 'high',
    labels: ['a', 'a', 'b'],
    sessionId: 'session-1',
    project: 'dsh-kanban',
  }, { actor: { kind: 'agent', name: 'DSH Agent' }, now: FIXED_NOW })
  assert.equal(draft.cards.length, before + 1)
  assert.match(card.id, /^card-[a-f0-9]{8}$/)
  assert.equal(card.title.length, LIMITS.title)
  assert.equal(card.summary.length, LIMITS.summary)
  assert.deepEqual(card.labels, ['a', 'b'])
  assert.equal(card.status, 'running')
  assert.equal(card.version, 1)
  assert.equal(card.startedAt, FIXED_NOW)
  assert.equal(card.completedAt, undefined)
  assert.deepEqual(card.sessionIds, ['session-1'])
  assert.equal(activity.type, 'created')
  assert.equal(activity.actor.name, 'DSH Agent')
  assert.equal(board.cardOrder.running[0], card.id)
  assert.equal(draft.meta.updatedAt, FIXED_NOW)
  assert.throws(() => createCard(draft, { title: '  ' }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => createCard(draft, { title: 'ok', status: 'nope' }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => createCard(draft, { title: 'ok', boardId: 'board-ffffffff' }), error => error.code === 'BOARD_NOT_FOUND')
})

test('patchCard：乐观锁版本+1、状态 Activity、startedAt/completedAt、currentAction 进度节点', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  const version = card.version
  const { card: patched, activities } = patchCard(draft, card.id, {
    title: '改后的标题',
    currentAction: '正在写测试',
    progress: { step: 2, total: 4 },
    labels: ['x'],
    unknownField: '忽略',
  }, { now: FIXED_NOW })
  assert.equal(patched.title, '改后的标题')
  assert.equal(patched.version, version + 1)
  assert.equal(patched.progress.percent, 50)
  assert.deepEqual(patched.labels, ['x'])
  assert.equal(patched.unknownField, undefined)
  assert.equal(activities.length, 1)
  assert.equal(activities[0].type, 'progress')
  assert.equal(activities[0].text, '正在写测试')

  const statusResult = patchCard(draft, card.id, { status: 'running' }, { now: FIXED_NOW + 1 })
  assert.equal(statusResult.card.status, 'running')
  assert.equal(statusResult.card.startedAt, FIXED_NOW + 1)
  assert.equal(statusResult.activities[0].type, 'status')
  assert.equal(statusResult.activities[0].data.to, 'running')

  const done = patchCard(draft, card.id, { status: 'done', result: '完成啦' }, { now: FIXED_NOW + 2 })
  assert.equal(done.card.completedAt, FIXED_NOW + 2)
  assert.ok(done.activities.some(item => item.type === 'status'))
  assert.ok(done.activities.some(item => item.type === 'result'))

  const reopened = patchCard(draft, card.id, { status: 'running' }, { now: FIXED_NOW + 3 })
  assert.equal(reopened.card.completedAt, undefined)
})

test('moveCard：column→代表 status、cardOrder 相对位置、reason 写入时间线', () => {
  const draft = seedDraft()
  const backlog = findCardByStatus(draft, 'backlog')
  const doneColumn = draft.boards[0].cardOrder.done
  const { card, activity } = moveCard(draft, backlog.id, { column: 'done', text: '人工确认完成', now: FIXED_NOW })
  assert.equal(card.status, 'done')
  assert.equal(card.completedAt, FIXED_NOW)
  assert.equal(draft.boards[0].cardOrder.done[0], backlog.id)
  assert.equal(draft.boards[0].cardOrder.done.length, doneColumn.length + 1)
  assert.equal(activity.type, 'status')
  assert.match(activity.text, /移到「已完成」/)
  assert.match(activity.text, /人工确认完成/)

  const running = findCardByStatus(draft, 'running')
  const doneId = draft.boards[0].cardOrder.done[0]
  moveCard(draft, running.id, { column: 'done', beforeId: doneId, now: FIXED_NOW })
  assert.equal(draft.boards[0].cardOrder.done[0], running.id)
  assert.equal(draft.boards[0].cardOrder.done[1], doneId)
  moveCard(draft, running.id, { column: 'done', afterId: doneId, now: FIXED_NOW })
  assert.equal(draft.boards[0].cardOrder.done[1], running.id)
  assert.throws(() => moveCard(draft, running.id, { column: 'nope' }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => moveCard(draft, 'card-ffffffff', { column: 'done' }), error => error.code === 'CARD_NOT_FOUND')
})

test('approval：请求进入待你确认、选项规范化、解决写入决议，重复解决冲突', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  const { approval, card: updated } = requestApproval(draft, card.id, {
    title: '是否执行迁移？',
    detail: '会修改生产表结构',
    options: ['执行', { id: 'no', label: '先不执行', tone: 'danger' }],
    sessionId: 'session-1',
  }, { actor: { kind: 'agent', name: 'DSH Agent' }, now: FIXED_NOW })
  assert.equal(updated.status, 'needs_you')
  assert.equal(updated.id, card.id)
  assert.equal(approval.status, 'pending')
  assert.equal(approval.options.length, 2)
  assert.equal(approval.options[0].id, 'option-1')
  assert.equal(approval.options[1].tone, 'danger')
  assert.equal(approval.requestedBy.name, 'DSH Agent')
  assert.equal(draft.boards[0].cardOrder.needs_you[0], card.id)
  assert.ok(draft.activities.some(item => item.type === 'approval_requested' && item.cardId === card.id))

  const resolved = resolveApproval(draft, card.id, approval.id, {
    optionId: 'no', comment: '先观察', actor: { kind: 'user', name: '你' }, now: FIXED_NOW + 1,
  })
  assert.equal(resolved.approval.status, 'rejected')
  assert.equal(resolved.approval.resolution.optionId, 'no')
  assert.equal(resolved.approval.resolution.comment, '先观察')
  assert.equal(resolved.approval.resolvedBy.name, '你')
  assert.match(resolved.activity.text, /已拒绝「是否执行迁移？」/)
  assert.throws(() => resolveApproval(draft, card.id, approval.id, { optionId: 'no' }), error => error.code === 'CONFLICT')
  assert.throws(() => resolveApproval(draft, card.id, 'ap-ffffffff', { optionId: 'no' }), error => error.code === 'APPROVAL_NOT_FOUND')
  const another = requestApproval(draft, card.id, { title: '再问一次', options: ['好'] }, { now: FIXED_NOW + 2 })
  assert.throws(() => resolveApproval(draft, card.id, another.approval.id, { optionId: 'nope' }), error => error.code === 'BAD_REQUEST')
})

test('approvals 超过 20 条时只保留最近 20 条', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  for (let index = 0; index < 25; index++) {
    requestApproval(draft, card.id, { title: `问题 ${index}`, options: ['好'] }, { now: FIXED_NOW + index })
  }
  const stored = requireCard(draft, card.id)
  assert.equal(stored.approvals.length, LIMITS.approvals)
  assert.equal(stored.approvals.at(-1).title, '问题 24')
})

test('completeCard / archiveCard / 会话绑定 / ack 的行为', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'running')
  const completed = completeCard(draft, card.id, { result: 'r'.repeat(900), actor: { kind: 'agent', name: 'DSH Agent' }, now: FIXED_NOW + 10 })
  assert.equal(completed.card.status, 'done')
  assert.equal(completed.card.result.length, LIMITS.result)
  assert.equal(completed.card.completedAt, FIXED_NOW + 10)
  assert.equal(draft.boards[0].cardOrder.running.includes(card.id), false)
  assert.equal(draft.boards[0].cardOrder.done[0], card.id)
  assert.ok(completed.activities.some(item => item.type === 'status'))
  assert.ok(completed.activities.some(item => item.type === 'result'))

  const linked = linkSession(draft, card.id, { sessionId: 'session-a', title: '讨论', now: FIXED_NOW + 11 })
  assert.equal(linked.card.sessionIds[0], 'session-a')
  const linkedAgain = linkSession(draft, card.id, { sessionId: 'session-a', now: FIXED_NOW + 12 })
  assert.equal(linkedAgain.card.sessionIds.filter(id => id === 'session-a').length, 1)
  const unlinked = unlinkSession(draft, card.id, { sessionId: 'session-a', now: FIXED_NOW + 13 })
  assert.equal(unlinked.card.sessionIds.includes('session-a'), false)
  assert.throws(() => unlinkSession(draft, card.id, { sessionId: 'session-a' }), error => error.code === 'CONFLICT')

  const acked = ackCard(draft, card.id, { now: FIXED_NOW + 14 })
  assert.equal(acked.activity.type, 'ack')

  const archived = archiveCard(draft, card.id, { now: FIXED_NOW + 15 })
  assert.equal(archived.card.archived, true)
  assert.equal(cardsOfBoard(draft, DEFAULT_BOARD_ID).includes(archived.card), false)
  assert.throws(() => requireCard(draft, card.id), error => error.code === 'CARD_NOT_FOUND')
})

test('列内排序：cardOrder 优先，未入列卡片按 updatedAt desc 兜底；counts 正确', () => {
  const draft = seedDraft()
  const board = draft.boards[0]
  const counts = countsFor(draft.cards, board.id)
  assert.equal(counts.total, 6)
  assert.equal(counts.needs_you, 3) // needs_you + blocked + failed
  const backlog = sortColumnCards(board, draft.cards, 'backlog')
  assert.equal(backlog.length, counts.backlog)
  const extra = createCard(draft, { title: '额外的卡', status: 'backlog' }, { now: FIXED_NOW })
  const sorted = sortColumnCards(board, draft.cards, 'backlog')
  assert.equal(sorted.length, counts.backlog + 1)
  assert.equal(sorted[0].id, extra.card.id) // 新卡插入列头
  assert.equal(countsFor(draft.cards, board.id).total, 7)
})

test('applySeedMode：demo 覆盖、empty 清空保留看板、reset 重建默认看板、保留 revision', () => {
  const draft = seedDraft()
  draft.meta.revision = 42
  draft.cards.push({ id: 'card-aaaaaaaa' })
  const board = draft.boards[0]
  board.name = '被改过的名字'
  applySeedMode(draft, 'empty', FIXED_NOW + 1)
  assert.equal(draft.cards.length, 0)
  assert.equal(draft.activities.length, 0)
  assert.equal(draft.boards[0].name, '被改过的名字') // 保留现有看板
  assert.equal(draft.meta.revision, 42)

  board.cardOrder = { backlog: [], running: [], needs_you: [], done: [] }
  applySeedMode(draft, 'demo', FIXED_NOW + 2)
  assert.equal(draft.cards.length, 6)
  assert.equal(draft.meta.revision, 42)
  assert.equal(draft.meta.seededAt, FIXED_NOW + 2)

  draft.boards.push({ id: 'board-aaaaaaaa', name: '额外看板' })
  applySeedMode(draft, 'reset', FIXED_NOW + 3)
  assert.equal(draft.boards.length, 1)
  assert.equal(draft.boards[0].id, DEFAULT_BOARD_ID)
  assert.equal(draft.cards.length, 0)
  assert.throws(() => applySeedMode(draft, 'nope'), error => error.code === 'BAD_REQUEST')
})

test('cleanText 截断并去控制字符，保留换行', () => {
  assert.equal(cleanText('  a\u0000b\u0007c  ', 10), 'abc')
  assert.equal(cleanText('第一行\n第二行', 100), '第一行\n第二行')
  assert.equal(cleanText('abcdef', 3), 'abc')
  assert.equal(cleanText(undefined, 10), '')
})
