// domain.js：状态/列映射、种子结构、规范化、写操作原语（卡片/移动/审批/会话/完成/归档）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COLUMNS, COLUMN_OF_STATUS, DEFAULT_BOARD_ID, LIMITS, STATUSES, STATUS_OF_COLUMN, DomainError,
  ackCard, applySeedMode, archiveCard, cardsOfBoard, cleanText, completeCard, countsFor, createCard,
  createSeed, isValidId, linkSession, moveCard, newActivityId, newApprovalId, newArtifactId, newBoardId, newQuestionId,
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
  const generators = [newBoardId, newCardId, newApprovalId, newActivityId, newChecklistId, newArtifactId, newQuestionId]
  const patterns = [/^board-[a-f0-9]{8}$/, /^card-[a-f0-9]{8}$/, /^ap-[a-f0-9]{8}$/, /^ev-[a-f0-9]{8}$/, /^ck-[a-f0-9]{6}$/, /^art-[a-f0-9]{6}$/, /^q-[a-f0-9]{6}$/]
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
  assert.equal(seed.cards.length, 8)
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
  // 多选审批示例卡
  const multiCard = seed.cards.find(card => (card.approvals || []).some(approval => approval.multiSelect === true))
  assert.ok(multiCard, '种子应包含多选审批卡片')
  const multiApproval = multiCard.approvals.find(approval => approval.multiSelect === true)
  assert.equal(multiApproval.options.length, 4)
  assert.deepEqual(multiApproval.options.map(option => option.label), ['单元测试', '构建', '真实设备', '文档'])
  assert.equal(multiApproval.status, 'pending')
  // 多问题审批示例卡
  const reviewCard = seed.cards.find(card => (card.approvals || []).some(approval => (approval.questions || []).length))
  assert.ok(reviewCard, '种子应包含多问题审批卡片')
  const reviewApproval = reviewCard.approvals.find(approval => (approval.questions || []).length)
  assert.equal(reviewApproval.questions.length, 3)
  assert.equal(reviewApproval.questions[0].multiSelect, false)
  assert.equal(reviewApproval.questions[1].multiSelect, true)
  assert.equal(reviewApproval.questions[2].multiSelect, false)
  assert.equal(reviewApproval.questions[1].options.length, 4)
  assert.deepEqual(reviewApproval.options, reviewApproval.questions[0].options) // 兼容字段取第一题
  assert.equal(reviewApproval.title, '发布窗口：选择本次发布窗口') // 多题 title 取第一题摘要
  for (const question of reviewApproval.questions) {
    assert.match(question.id, /^q-[a-f0-9]{6}$/)
    assert.ok(question.question && question.options.length >= 1)
  }
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
  assert.equal(approval.multiSelect, false)
  assert.equal(approval.requestedBy.name, 'DSH Agent')
  assert.equal(draft.boards[0].cardOrder.needs_you[0], card.id)
  assert.ok(draft.activities.some(item => item.type === 'approval_requested' && item.cardId === card.id))

  const resolved = resolveApproval(draft, card.id, approval.id, {
    optionId: 'no', comment: '先观察', actor: { kind: 'user', name: '你' }, now: FIXED_NOW + 1,
  })
  assert.equal(resolved.approval.status, 'rejected')
  assert.deepEqual(resolved.approval.resolution.optionIds, ['no'])
  assert.deepEqual(resolved.approval.resolution.labels, ['先不执行'])
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
  assert.equal(counts.total, 8)
  assert.equal(counts.needs_you, 5) // needs_you×2 + 多问题审批 + blocked + failed
  const backlog = sortColumnCards(board, draft.cards, 'backlog')
  assert.equal(backlog.length, counts.backlog)
  const extra = createCard(draft, { title: '额外的卡', status: 'backlog' }, { now: FIXED_NOW })
  const sorted = sortColumnCards(board, draft.cards, 'backlog')
  assert.equal(sorted.length, counts.backlog + 1)
  assert.equal(sorted[0].id, extra.card.id) // 新卡插入列头
  assert.equal(countsFor(draft.cards, board.id).total, 9)
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
  assert.equal(draft.cards.length, 8)
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

test('multiSelect 审批：optionIds 多选 resolve、resolution 存 optionIds/labels、全 danger 判 rejected', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  const { approval } = requestApproval(draft, card.id, {
    title: '发布前要带哪些检查？',
    multiSelect: true,
    options: [
      { id: 'unit-test', label: '单元测试' },
      { id: 'build', label: '构建' },
      { id: 'docs', label: '文档' },
    ],
  }, { now: FIXED_NOW })
  assert.equal(approval.multiSelect, true)
  const resolved = resolveApproval(draft, card.id, approval.id, {
    optionIds: ['build', 'unit-test', 'build'], comment: '都跑过', now: FIXED_NOW + 1,
  })
  assert.equal(resolved.approval.status, 'approved')
  assert.deepEqual(resolved.approval.resolution.optionIds, ['build', 'unit-test'])
  assert.deepEqual(resolved.approval.resolution.labels, ['构建', '单元测试'])
  assert.match(resolved.activity.text, /已批准「发布前要带哪些检查？」：构建、单元测试/)
  assert.deepEqual(resolved.activity.data.optionIds, ['build', 'unit-test'])

  const rejectedRequest = requestApproval(draft, card.id, {
    title: '是否全部发布？', multiSelect: true,
    options: [{ id: 'no', label: '不发布', tone: 'danger' }, { id: 'reject', label: '拒绝', tone: 'danger' }],
  }, { now: FIXED_NOW + 2 })
  const rejected = resolveApproval(draft, card.id, rejectedRequest.approval.id, {
    optionIds: ['no', 'reject'], now: FIXED_NOW + 3,
  })
  assert.equal(rejected.approval.status, 'rejected')
  assert.match(rejected.activity.text, /已拒绝/)
})

test('resolveApproval 校验：单选不允许多个、选项必须存在、至少一个、旧 optionId 兼容', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  const single = requestApproval(draft, card.id, { title: '单选审批', options: ['A', 'B'] }, { now: FIXED_NOW })
  assert.equal(single.approval.multiSelect, false)
  assert.throws(() => resolveApproval(draft, card.id, single.approval.id, { optionIds: ['option-1', 'option-2'] }),
    error => error instanceof DomainError && error.code === 'BAD_REQUEST')
  assert.throws(() => resolveApproval(draft, card.id, single.approval.id, { optionIds: [] }),
    error => error.code === 'BAD_REQUEST')
  assert.throws(() => resolveApproval(draft, card.id, single.approval.id, { optionIds: ['nope'] }),
    error => error.code === 'BAD_REQUEST')
  // 旧 optionId 参数仍可用，写回的 resolution 是新结构
  const legacy = resolveApproval(draft, card.id, single.approval.id, { optionId: 'option-2', now: FIXED_NOW + 1 })
  assert.equal(legacy.approval.status, 'approved')
  assert.deepEqual(legacy.approval.resolution.optionIds, ['option-2'])
  assert.deepEqual(legacy.approval.resolution.labels, ['B'])
})

test('审批选项上限为 8：8 个可创建，9 个 BAD_REQUEST', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  const eight = Array.from({ length: 8 }, (_, index) => `选项${index + 1}`)
  const result = requestApproval(draft, card.id, { title: '8 个选项', options: eight }, { now: FIXED_NOW })
  assert.equal(result.approval.options.length, 8)
  assert.throws(() => requestApproval(draft, card.id, {
    title: '9 个选项', options: [...eight, '选项9'],
  }), error => error instanceof DomainError && error.code === 'BAD_REQUEST')
})

test('旧数据 compatibility：resolution 旧结构 {optionId,label} 读取迁移为 {optionIds,labels}', () => {
  const data = normalizeStore({
    boards: [{ id: DEFAULT_BOARD_ID, cardOrder: { backlog: [], running: [], needs_you: [], done: [] } }],
    cards: [{
      id: 'card-aaaaaaaa', boardId: DEFAULT_BOARD_ID, title: '旧的卡', status: 'done',
      approvals: [{
        id: 'ap-aaaaaaaa', title: '旧审批', detail: '', options: [{ id: 'no', label: '拒绝' }, { id: 'yes', label: '批准' }],
        status: 'rejected', requestedAt: 1, resolution: { optionId: 'no', label: '拒绝', comment: '不做了' },
      }],
    }],
    activities: [], meta: { revision: 3 },
  }, FIXED_NOW)
  const approval = data.cards[0].approvals[0]
  assert.equal(approval.multiSelect, false)
  assert.deepEqual(approval.resolution.optionIds, ['no'])
  assert.deepEqual(approval.resolution.labels, ['拒绝'])
  assert.equal(approval.resolution.comment, '不做了')
})

test('多问题审批：创建（title 取第一题摘要、questions 规范化、兼容字段取第一题）', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  const { approval } = requestApproval(draft, card.id, {
    detail: '请逐题选择',
    questions: [
      { header: '发布窗口', question: '何时发布？', multiSelect: false, options: ['今天', { id: 'hold', label: '暂缓', tone: 'danger' }] },
      { header: '检查项', question: '带哪些检查？', multiSelect: true, options: ['单测', '构建', '文档'] },
    ],
  }, { actor: { kind: 'agent', name: 'DSH Agent' }, now: FIXED_NOW })
  assert.equal(approval.questions.length, 2)
  assert.equal(approval.title, '发布窗口：何时发布？')
  assert.equal(approval.detail, '请逐题选择')
  assert.equal(approval.options, approval.questions[0].options) // 旧字段取第一题
  assert.equal(approval.multiSelect, false) // 取第一题
  assert.equal(approval.questions[1].multiSelect, true)
  assert.match(approval.questions[0].id, /^q-[a-f0-9]{6}$/)
  assert.notEqual(approval.questions[0].id, approval.questions[1].id)
  assert.equal(approval.status, 'pending')
  assert.ok(draft.activities.some(item => item.type === 'approval_requested' && /2 题/.test(item.text)))
})

test('多问题审批校验：题目/选项/题数边界', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  assert.throws(() => requestApproval(draft, card.id, { questions: [] }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => requestApproval(draft, card.id, { questions: Array.from({ length: 7 }, (_, index) => ({ question: `Q${index}`, options: ['A'] })) }),
    error => error.code === 'BAD_REQUEST')
  assert.throws(() => requestApproval(draft, card.id, { questions: [{ options: ['A'] }] }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => requestApproval(draft, card.id, { questions: [{ question: '缺选项', options: [] }] }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => requestApproval(draft, card.id, { questions: [{ question: '选项过多', options: Array.from({ length: 9 }, (_, index) => `O${index}`) }] }),
    error => error.code === 'BAD_REQUEST')
  assert.throws(() => requestApproval(draft, card.id, {}), error => error.code === 'BAD_REQUEST')
})

test('多问题审批 resolve：answers 逐题作答、拍平 resolution、全 danger 判 rejected', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  const { approval } = requestApproval(draft, card.id, {
    questions: [
      { header: '发布窗口', question: '何时发布？', options: [{ id: 'today', label: '今天' }, { id: 'hold', label: '暂缓', tone: 'danger' }] },
      { header: '检查项', question: '带哪些检查？', multiSelect: true, options: [{ id: 'unit', label: '单测' }, { id: 'build', label: '构建' }] },
      { header: '回滚', question: '回滚就绪？', options: [{ id: 'ready', label: '已就绪' }, { id: 'no', label: '未就绪', tone: 'danger' }] },
    ],
  }, { now: FIXED_NOW })

  // 缺一题
  assert.throws(() => resolveApproval(draft, card.id, approval.id, {
    answers: [{ questionId: approval.questions[0].id, optionIds: ['today'] }],
  }), error => error.code === 'BAD_REQUEST')
  // 题号非法
  assert.throws(() => resolveApproval(draft, card.id, approval.id, {
    answers: approval.questions.map(question => ({ questionId: 'q-ffffff', optionIds: [question.options[0].id] })),
  }), error => error.code === 'BAD_REQUEST')
  // 重复作答
  assert.throws(() => resolveApproval(draft, card.id, approval.id, {
    answers: [0, 1, 2].map(index => ({ questionId: approval.questions[index].id, optionIds: [approval.questions[index].options[0].id] })).concat([{ questionId: approval.questions[0].id, optionIds: [approval.questions[0].options[0].id] }]),
  }), error => error.code === 'BAD_REQUEST')
  // 选项不存在
  assert.throws(() => resolveApproval(draft, card.id, approval.id, {
    answers: approval.questions.map(question => ({ questionId: question.id, optionIds: ['nope'] })),
  }), error => error.code === 'BAD_REQUEST')
  // 单选给多个
  assert.throws(() => resolveApproval(draft, card.id, approval.id, {
    answers: [
      { questionId: approval.questions[0].id, optionIds: ['today', 'hold'] },
      { questionId: approval.questions[1].id, optionIds: ['unit'] },
      { questionId: approval.questions[2].id, optionIds: ['ready'] },
    ],
  }), error => error.code === 'BAD_REQUEST')

  const resolved = resolveApproval(draft, card.id, approval.id, {
    answers: [
      { questionId: approval.questions[0].id, optionIds: ['today'] },
      { questionId: approval.questions[1].id, optionIds: ['build', 'unit', 'build'] },
      { questionId: approval.questions[2].id, optionIds: ['ready'] },
    ],
    comment: '逐题确认', now: FIXED_NOW + 1,
  })
  assert.equal(resolved.approval.status, 'approved')
  assert.equal(resolved.approval.resolution.answers.length, 3)
  assert.deepEqual(resolved.approval.resolution.answers[1].optionIds, ['build', 'unit'])
  assert.deepEqual(resolved.approval.resolution.optionIds, ['today', 'build', 'unit', 'ready'])
  assert.deepEqual(resolved.approval.resolution.labels, ['今天', '构建', '单测', '已就绪'])
  assert.equal(resolved.approval.resolution.comment, '逐题确认')
  assert.match(resolved.activity.text, /（3 题）/)
  assert.deepEqual(resolved.activity.data.questionIds, approval.questions.map(question => question.id))

  // 所有题都选 danger/id=no → rejected
  const card2 = findCardByStatus(draft, 'running')
  const { approval: second } = requestApproval(draft, card2.id, {
    questions: [
      { question: 'Q1', options: [{ id: 'no', label: '否', tone: 'danger' }] },
      { question: 'Q2', multiSelect: true, options: [{ id: 'reject', label: '拒绝', tone: 'danger' }, { id: 'deny', label: '否决', tone: 'danger' }] },
    ],
  }, { now: FIXED_NOW + 2 })
  const rejected = resolveApproval(draft, card2.id, second.id, {
    answers: [
      { questionId: second.questions[0].id, optionIds: ['no'] },
      { questionId: second.questions[1].id, optionIds: ['reject', 'deny'] },
    ],
    now: FIXED_NOW + 3,
  })
  assert.equal(rejected.approval.status, 'rejected')
  assert.match(rejected.activity.text, /已拒绝/)
})

test('多问题审批兼容：单题旧字段 resolve 不受影响，旧数据读取仍可用', () => {
  const draft = seedDraft()
  const card = findCardByStatus(draft, 'backlog')
  const legacy = requestApproval(draft, card.id, { title: '旧单题', options: ['A', 'B'] }, { now: FIXED_NOW })
  assert.equal(legacy.approval.questions, undefined)
  const resolved = resolveApproval(draft, card.id, legacy.approval.id, { optionIds: ['option-1'], now: FIXED_NOW + 1 })
  assert.equal(resolved.approval.status, 'approved')
  assert.equal(resolved.approval.resolution.answers, undefined)
  assert.deepEqual(resolved.approval.resolution.optionIds, ['option-1'])

  const data = normalizeStore({
    boards: [{ id: DEFAULT_BOARD_ID, cardOrder: { backlog: [], running: [], needs_you: [], done: [] } }],
    cards: [{
      id: 'card-bbbbbbbb', boardId: DEFAULT_BOARD_ID, title: '旧卡', status: 'needs_you',
      approvals: [{ id: 'ap-bbbbbbbb', title: '旧审批', options: [{ id: 'yes', label: '批准' }, { id: 'no', label: '拒绝' }], status: 'pending', requestedAt: 1 }],
    }],
    activities: [], meta: { revision: 2 },
  }, FIXED_NOW)
  const approval = data.cards[0].approvals[0]
  assert.equal(approval.questions, undefined)
  assert.equal(approval.multiSelect, false)
  assert.equal(approval.options.length, 2)
})
