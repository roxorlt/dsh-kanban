// routes.js：健康检查/状态、看板与卡片 CRUD、移动、审批、评论、会话、时间线、种子、
// SSE、同源拒绝、JSON 限制、静态资源与路径穿越、SPA fallback。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api, openSse, rawRequest, startServer, tempDir, testStore, writeStaticFixture } from './helpers.mjs'

async function setup(t, options = {}) {
  const { store, dir } = await testStore(t, { seedMode: options.seedMode })
  const server = await startServer(t, { store, staticRoot: options.staticRoot })
  return { store, dir, server }
}

async function createCard(server, body = {}) {
  const res = await api(server, '/api/kanban/cards', { method: 'POST', body: { title: '测试卡片', ...body } })
  assert.equal(res.status, 200, res.text)
  return res.json.card
}

test('GET /health 返回版本、schemaVersion、dataDir、revision', async t => {
  const { server, store } = await setup(t)
  const res = await api(server, '/api/kanban/health')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(res.json.ok, true)
  assert.equal(res.json.version, '0.0.0-test')
  assert.equal(res.json.schemaVersion, 1)
  assert.equal(res.json.dataDir, store.dataDir)
  assert.equal(res.json.revision, 1)
})

test('GET /state 返回看板快照、列计数、按列排序的卡片，不内嵌 activities', async t => {
  const { server } = await setup(t)
  const res = await api(server, '/api/kanban/state')
  assert.equal(res.status, 200)
  const body = res.json
  assert.equal(body.ok, true)
  assert.equal(body.activities, undefined)
  assert.equal(body.boards.length, 1)
  assert.equal(body.board.id, 'board-default')
  assert.equal(body.boards[0].counts.total, 8)
  assert.equal(body.cards.length, 8)
  assert.equal(body.revision, 1)
  assert.ok(body.serverTime > 0)
  // 按列展开：backlog 在最前，每张卡只出现一次
  assert.equal(body.cards[0].status, 'backlog')
  assert.deepEqual(body.cards.map(card => card.id).sort(), [...new Set(body.cards.map(card => card.id))].sort())
  assert.equal(body.board.cardOrder.needs_you.length, 5)

  const scoped = await api(server, '/api/kanban/state?boardId=board-default')
  assert.equal(scoped.status, 200)
  const missing = await api(server, '/api/kanban/state?boardId=board-ffffffff')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'BOARD_NOT_FOUND')
  const bad = await api(server, '/api/kanban/state?boardId=..%2Fetc')
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'BAD_REQUEST')
})

test('看板 CRUD：创建/改名/删除；默认看板与含卡看板不可删', async t => {
  const { server } = await setup(t)
  const created = await api(server, '/api/kanban/boards', { method: 'POST', body: { name: '新看板', description: '测试用' } })
  assert.equal(created.status, 200)
  assert.match(created.json.board.id, /^board-[a-f0-9]{8}$/)
  assert.equal(created.json.board.name, '新看板')
  assert.equal(created.json.revision, 2)
  const boardId = created.json.board.id

  const patched = await api(server, `/api/kanban/boards/${boardId}`, { method: 'PATCH', body: { name: '改名后' } })
  assert.equal(patched.status, 200)
  assert.equal(patched.json.board.name, '改名后')

  const defaultDelete = await api(server, '/api/kanban/boards/board-default', { method: 'DELETE' })
  assert.equal(defaultDelete.status, 409)
  assert.equal(defaultDelete.json.error.code, 'CONFLICT')

  await createCard(server, { boardId, title: '占用卡' })
  const nonEmpty = await api(server, `/api/kanban/boards/${boardId}`, { method: 'DELETE' })
  assert.equal(nonEmpty.status, 409)

  const emptyBoard = await api(server, '/api/kanban/boards', { method: 'POST', body: { name: '空看板' } })
  const removed = await api(server, `/api/kanban/boards/${emptyBoard.json.board.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.equal(removed.json.ok, true)

  const boards = await api(server, '/api/kanban/boards')
  assert.equal(boards.json.boards.length, 2)
  assert.equal(boards.json.boards[0].counts.total, 8)
})

test('卡片创建：字段白名单、默认值、version=1、created 时间线', async t => {
  const { server } = await setup(t)
  const res = await api(server, '/api/kanban/cards', {
    method: 'POST',
    body: { title: '实现详情抽屉', summary: '右侧抽屉展示时间线', status: 'backlog', priority: 'high', labels: ['ui'], project: 'dsh-kanban', sessionId: 'session-1', agent: { name: 'DSH Agent' }, summaryOnly: true },
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.revision, 2)
  const card = res.json.card
  assert.match(card.id, /^card-[a-f0-9]{8}$/)
  assert.equal(card.version, 1)
  assert.equal(card.title, '实现详情抽屉')
  assert.equal(card.priority, 'high')
  assert.deepEqual(card.labels, ['ui'])
  assert.deepEqual(card.sessionIds, ['session-1'])
  assert.equal(card.project, 'dsh-kanban')
  assert.equal(card.agent.name, 'DSH Agent')
  assert.deepEqual(card.metadata, { toolCalls: 0, searches: 0 })
  assert.equal(card.archived, undefined)
  const timeline = await api(server, `/api/kanban/cards/${card.id}/activities`)
  assert.equal(timeline.json.activities[0].type, 'created')
  assert.match(timeline.json.activities[0].text, /实现详情抽屉/)

  assert.equal((await api(server, '/api/kanban/cards', { method: 'POST', body: { title: '  ' } })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards', { method: 'POST', body: { title: 'x', status: 'nope' } })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards', { method: 'POST', body: { title: 'x', boardId: 'board-ffffffff' } })).status, 404)
})

test('卡片 PATCH 乐观锁：缺 version=400、过期=409 带最新卡、force 可跳过', async t => {
  const { server } = await setup(t)
  const card = await createCard(server)
  const updated = await api(server, `/api/kanban/cards/${card.id}`, { method: 'PATCH', body: { version: 1, changes: { title: '第一版', currentAction: '写代码' } } })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.card.version, 2)
  assert.equal(updated.json.card.title, '第一版')
  assert.equal(updated.json.revision, 3)

  const noVersion = await api(server, `/api/kanban/cards/${card.id}`, { method: 'PATCH', body: { changes: { title: 'x' } } })
  assert.equal(noVersion.status, 400)
  assert.equal(noVersion.json.error.code, 'BAD_REQUEST')

  const stale = await api(server, `/api/kanban/cards/${card.id}`, { method: 'PATCH', body: { version: 1, changes: { title: '旧版本提交' } } })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error.code, 'VERSION_CONFLICT')
  assert.equal(stale.json.card.version, 2)

  const forced = await api(server, `/api/kanban/cards/${card.id}`, { method: 'PATCH', body: { force: true, changes: { priority: 'urgent' } } })
  assert.equal(forced.status, 200)
  assert.equal(forced.json.card.priority, 'urgent')
  assert.equal(forced.json.card.version, 3)

  const badStatus = await api(server, `/api/kanban/cards/${card.id}`, { method: 'PATCH', body: { force: true, changes: { status: 'whatever' } } })
  assert.equal(badStatus.status, 400)
})

test('卡片 DELETE：归档、隐藏、版本校验、重复删除 404', async t => {
  const { server } = await setup(t)
  const card = await createCard(server)
  const noVersion = await api(server, `/api/kanban/cards/${card.id}`, { method: 'DELETE' })
  assert.equal(noVersion.status, 400)
  const archived = await api(server, `/api/kanban/cards/${card.id}?version=1`, { method: 'DELETE' })
  assert.equal(archived.status, 200)
  assert.equal(archived.json.ok, true)
  assert.equal(archived.json.card.archived, true)
  const state = await api(server, '/api/kanban/state')
  assert.equal(state.json.cards.some(item => item.id === card.id), false)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}`, { method: 'DELETE', body: { version: 2 } })).status, 404)
})

test('move：列→代表 status、cardOrder 更新、version 可选校验、Activity 文案', async t => {
  const { server } = await setup(t)
  const card = await createCard(server, { title: '待移动' })
  const moved = await api(server, `/api/kanban/cards/${card.id}/move`, { method: 'POST', body: { column: 'running' } })
  assert.equal(moved.status, 200)
  assert.equal(moved.json.card.status, 'running')
  assert.ok(moved.json.card.startedAt)
  const state = await api(server, '/api/kanban/state')
  assert.equal(state.json.board.cardOrder.running[0], card.id)
  const timeline = await api(server, `/api/kanban/cards/${card.id}/activities`)
  assert.match(timeline.json.activities[0].text, /移到「进行中」/)

  const stale = await api(server, `/api/kanban/cards/${card.id}/move`, { method: 'POST', body: { column: 'done', version: 1 } })
  assert.equal(stale.status, 409)
  const stillMoved = await api(server, `/api/kanban/cards/${card.id}/move`, { method: 'POST', body: { column: 'done', version: moved.json.card.version } })
  assert.equal(stillMoved.status, 200)
  assert.equal(stillMoved.json.card.status, 'done')
  assert.ok(stillMoved.json.card.completedAt)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/move`, { method: 'POST', body: { column: 'nope' } })).status, 400)
})

test('审批：创建→待你确认、选项解析、解决→已批准/已拒绝、重复解决 409', async t => {
  const { server } = await setup(t)
  const card = await createCard(server)
  const created = await api(server, `/api/kanban/cards/${card.id}/approvals`, {
    method: 'POST',
    body: { title: '是否上线？', detail: '影响线上用户', options: ['上线', { id: 'no', label: '暂不上线', tone: 'danger' }], sessionId: 'session-1' },
  })
  assert.equal(created.status, 200)
  const approval = created.json.approval
  assert.match(approval.id, /^ap-[a-f0-9]{8}$/)
  assert.equal(approval.status, 'pending')
  assert.equal(created.json.card.status, 'needs_you')
  assert.equal(created.json.approval.multiSelect, false)
  const state = await api(server, '/api/kanban/state')
  assert.equal(state.json.board.cardOrder.needs_you[0], card.id)

  const badOption = await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, { method: 'POST', body: { optionId: 'nope' } })
  assert.equal(badOption.status, 400)
  const approved = await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, { method: 'POST', body: { optionId: 'option-1', comment: '可以' } })
  assert.equal(approved.status, 200)
  assert.equal(approved.json.approval.status, 'approved')
  assert.deepEqual(approved.json.approval.resolution.optionIds, ['option-1'])
  assert.deepEqual(approved.json.approval.resolution.labels, ['上线'])
  assert.equal(approved.json.approval.resolution.comment, '可以')
  assert.match(approved.json.approval.resolvedBy.name, /你/)
  const timeline = await api(server, `/api/kanban/cards/${card.id}/activities`)
  assert.ok(timeline.json.activities.some(item => item.type === 'approval_requested'))
  assert.ok(timeline.json.activities.some(item => item.type === 'approval_resolved'))

  const twice = await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, { method: 'POST', body: { optionId: 'no' } })
  assert.equal(twice.status, 409)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/approvals/ap-ffffffff/resolve`, { method: 'POST', body: { optionId: 'no' } })).status, 404)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/approvals`, { method: 'POST', body: { title: '无选项', options: [] } })).status, 400)
})

test('评论与时间线接口：倒序、limit 上限、空文本 400、卡片不存在 404', async t => {
  const { server } = await setup(t)
  const card = await createCard(server)
  for (const text of ['第一条', '第二条', '第三条']) {
    const res = await api(server, `/api/kanban/cards/${card.id}/comments`, { method: 'POST', body: { text } })
    assert.equal(res.status, 200)
    assert.equal(res.json.activity.type, 'comment')
    assert.equal(res.json.activity.actor.name, '你')
  }
  const all = await api(server, `/api/kanban/cards/${card.id}/activities`)
  assert.equal(all.status, 200)
  assert.equal(all.json.ok, true)
  assert.equal(all.json.activities.length, 4)
  for (let index = 1; index < all.json.activities.length; index++) {
    assert.ok(all.json.activities[index - 1].at >= all.json.activities[index].at)
  }
  assert.equal(all.json.hasMore, false)
  assert.equal(all.json.nextBefore, null)
  const limited = await api(server, `/api/kanban/cards/${card.id}/activities?limit=2`)
  assert.equal(limited.json.activities.length, 2)
  assert.equal(limited.json.activities[0].text, '第三条')
  assert.equal(limited.json.hasMore, true)
  const clamped = await api(server, `/api/kanban/cards/${card.id}/activities?limit=999`)
  assert.equal(clamped.json.activities.length, 4)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/comments`, { method: 'POST', body: { text: '   ' } })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards/card-ffffffff/activities')).status, 404)
  assert.equal((await api(server, '/api/kanban/cards/not-an-id/activities')).status, 400)
})

test('会话绑定/解绑/重复绑定去重、ack 写入已读节点', async t => {
  const { server } = await setup(t)
  const card = await createCard(server)
  const first = await api(server, `/api/kanban/cards/${card.id}/session`, { method: 'POST', body: { sessionId: 's-1', title: '会话一' } })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json.card.sessionIds, ['s-1'])
  const second = await api(server, `/api/kanban/cards/${card.id}/session`, { method: 'POST', body: { sessionId: 's-2' } })
  assert.deepEqual(second.json.card.sessionIds, ['s-2', 's-1'])
  const again = await api(server, `/api/kanban/cards/${card.id}/session`, { method: 'POST', body: { sessionId: 's-1' } })
  assert.deepEqual(again.json.card.sessionIds, ['s-1', 's-2'])
  const unlinked = await api(server, `/api/kanban/cards/${card.id}/session/s-1`, { method: 'DELETE' })
  assert.equal(unlinked.status, 200)
  assert.deepEqual(unlinked.json.card.sessionIds, ['s-2'])
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/session/s-1`, { method: 'DELETE' })).status, 409)

  const acked = await api(server, `/api/kanban/cards/${card.id}/ack`, { method: 'POST', body: {} })
  assert.equal(acked.status, 200)
  assert.equal(acked.json.ok, true)
  const timeline = await api(server, `/api/kanban/cards/${card.id}/activities`)
  assert.equal(timeline.json.activities[0].type, 'ack')
})

test('多选审批：multiSelect + optionIds resolve、全 danger 判 rejected、单选拒绝多个/空/不存在选项', async t => {
  const { server } = await setup(t)
  const card = await createCard(server)
  const created = await api(server, `/api/kanban/cards/${card.id}/approvals`, {
    method: 'POST',
    body: {
      title: '发布前要带哪些检查？',
      multiSelect: true,
      options: [
        { id: 'unit-test', label: '单元测试' },
        { id: 'build', label: '构建' },
        { id: 'no', label: '本次不发布', tone: 'danger' },
      ],
    },
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.approval.multiSelect, true)
  const approval = created.json.approval
  const approved = await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, {
    method: 'POST', body: { optionIds: ['build', 'unit-test', 'build'], comment: '两项都过' },
  })
  assert.equal(approved.status, 200)
  assert.equal(approved.json.approval.status, 'approved')
  assert.deepEqual(approved.json.approval.resolution.optionIds, ['build', 'unit-test'])
  assert.deepEqual(approved.json.approval.resolution.labels, ['构建', '单元测试'])
  assert.match(approved.json.approval.resolvedBy.name, /你/)
  const timeline = await api(server, `/api/kanban/cards/${card.id}/activities`)
  assert.ok(timeline.json.activities.some(item => item.type === 'approval_resolved' && item.data.optionIds.length === 2))

  // 全部选中 danger 选项 → rejected
  const rejectCard = await createCard(server, { title: '全 danger 审批' })
  const created2 = await api(server, `/api/kanban/cards/${rejectCard.id}/approvals`, {
    method: 'POST',
    body: { title: '是否全部取消？', multiSelect: true, options: [{ id: 'no', label: '全部取消', tone: 'danger' }, { id: 'reject', label: '拒绝', tone: 'danger' }] },
  })
  const rejected = await api(server, `/api/kanban/cards/${rejectCard.id}/approvals/${created2.json.approval.id}/resolve`, {
    method: 'POST', body: { optionIds: ['no', 'reject'] },
  })
  assert.equal(rejected.json.approval.status, 'rejected')

  // 单选审批不允许多个 optionIds
  const singleCard = await createCard(server, { title: '单选审批' })
  const single = await api(server, `/api/kanban/cards/${singleCard.id}/approvals`, { method: 'POST', body: { title: '单选', options: ['A', 'B'] } })
  assert.equal(single.json.approval.multiSelect, false)
  assert.equal((await api(server, `/api/kanban/cards/${singleCard.id}/approvals/${single.json.approval.id}/resolve`, {
    method: 'POST', body: { optionIds: ['option-1', 'option-2'] },
  })).status, 400)
  assert.equal((await api(server, `/api/kanban/cards/${singleCard.id}/approvals/${single.json.approval.id}/resolve`, {
    method: 'POST', body: { optionIds: [] },
  })).status, 400)
  assert.equal((await api(server, `/api/kanban/cards/${singleCard.id}/approvals/${single.json.approval.id}/resolve`, {
    method: 'POST', body: { optionIds: ['nope'] },
  })).status, 400)
  // 旧 optionId 仍兼容
  const legacy = await api(server, `/api/kanban/cards/${singleCard.id}/approvals/${single.json.approval.id}/resolve`, {
    method: 'POST', body: { optionId: 'option-1' },
  })
  assert.equal(legacy.status, 200)
  assert.deepEqual(legacy.json.approval.resolution.optionIds, ['option-1'])

  // 8 个选项可创建，9 个 400
  const eight = await api(server, `/api/kanban/cards/${singleCard.id}/approvals`, {
    method: 'POST', body: { title: '8 个选项', options: Array.from({ length: 8 }, (_, index) => `选项${index + 1}`) },
  })
  assert.equal(eight.status, 200)
  assert.equal(eight.json.approval.options.length, 8)
  assert.equal((await api(server, `/api/kanban/cards/${singleCard.id}/approvals`, {
    method: 'POST', body: { title: '9 个选项', options: Array.from({ length: 9 }, (_, index) => `选项${index + 1}`) },
  })).status, 400)
})

test('多问题审批：POST questions 创建、resolve answers 逐题作答、逐题校验与旧参数兼容', async t => {
  const { server } = await setup(t)
  const card = await createCard(server, { title: '多问题审批 HTTP' })
  const created = await api(server, `/api/kanban/cards/${card.id}/approvals`, {
    method: 'POST',
    body: {
      detail: '请逐题选择',
      questions: [
        { header: '发布窗口', question: '选择发布窗口', options: [{ id: 'today', label: '今天' }, { id: 'hold', label: '暂缓', tone: 'danger' }] },
        { header: '检查项', question: '带哪些检查？', multiSelect: true, options: [{ id: 'unit', label: '单测' }, { id: 'build', label: '构建' }, { id: 'docs', label: '文档' }] },
        { header: '回滚', question: '回滚就绪？', options: [{ id: 'ready', label: '已就绪' }, { id: 'no', label: '未就绪', tone: 'danger' }] },
      ],
    },
  })
  assert.equal(created.status, 200)
  const approval = created.json.approval
  assert.equal(approval.questions.length, 3)
  assert.equal(approval.title, '发布窗口：选择发布窗口')
  assert.equal(approval.questions[1].multiSelect, true)
  assert.equal(created.json.card.status, 'needs_you')
  const [q1, q2, q3] = approval.questions

  // 缺题 / 非法题号 / 非法选项 / 单选多选均 400
  const missing = await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, {
    method: 'POST', body: { answers: [{ questionId: q1.id, optionIds: ['today'] }] },
  })
  assert.equal(missing.status, 400)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, {
    method: 'POST', body: { answers: [{ questionId: 'q-ffffff', optionIds: ['today'] }] },
  })).status, 400)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, {
    method: 'POST', body: { answers: [{ questionId: q1.id, optionIds: ['nope'] }, { questionId: q2.id, optionIds: ['unit'] }, { questionId: q3.id, optionIds: ['ready'] }] },
  })).status, 400)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, {
    method: 'POST', body: { answers: [{ questionId: q1.id, optionIds: ['today', 'hold'] }, { questionId: q2.id, optionIds: ['unit'] }, { questionId: q3.id, optionIds: ['ready'] }] },
  })).status, 400)
  // 多题审批不能只传旧 optionIds
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, {
    method: 'POST', body: { optionIds: ['today'] },
  })).status, 400)

  const resolved = await api(server, `/api/kanban/cards/${card.id}/approvals/${approval.id}/resolve`, {
    method: 'POST',
    body: {
      answers: [
        { questionId: q1.id, optionIds: ['today'] },
        { questionId: q2.id, optionIds: ['unit', 'build'] },
        { questionId: q3.id, optionIds: ['ready'] },
      ],
      comment: '逐题确认',
    },
  })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.json.approval.status, 'approved')
  assert.equal(resolved.json.approval.resolution.answers.length, 3)
  assert.deepEqual(resolved.json.approval.resolution.answers[1].labels, ['单测', '构建'])
  assert.deepEqual(resolved.json.approval.resolution.optionIds, ['today', 'unit', 'build', 'ready'])
  assert.equal(resolved.json.approval.resolution.comment, '逐题确认')

  // 全部题目都选 danger → rejected
  const card2 = await createCard(server, { title: '多问题全 danger' })
  const created2 = await api(server, `/api/kanban/cards/${card2.id}/approvals`, {
    method: 'POST',
    body: { questions: [{ question: 'Q1', options: [{ id: 'no', label: '否', tone: 'danger' }] }, { question: 'Q2', multiSelect: true, options: [{ id: 'reject', label: '拒绝', tone: 'danger' }] }] },
  })
  const rejected = await api(server, `/api/kanban/cards/${card2.id}/approvals/${created2.json.approval.id}/resolve`, {
    method: 'POST',
    body: { answers: created2.json.approval.questions.map(question => ({ questionId: question.id, optionIds: [question.options[0].id] })) },
  })
  assert.equal(rejected.json.approval.status, 'rejected')

  // 题数边界：6 题可创建，7 题 400；旧单题 POST 仍可用
  const six = await api(server, `/api/kanban/cards/${card2.id}/approvals`, {
    method: 'POST', body: { questions: Array.from({ length: 6 }, (_, index) => ({ question: `Q${index + 1}`, options: ['A'] })) },
  })
  assert.equal(six.status, 200)
  assert.equal(six.json.approval.questions.length, 6)
  assert.equal((await api(server, `/api/kanban/cards/${card2.id}/approvals`, {
    method: 'POST', body: { questions: Array.from({ length: 7 }, (_, index) => ({ question: `Q${index + 1}`, options: ['A'] })) },
  })).status, 400)
  const legacy = await api(server, `/api/kanban/cards/${card2.id}/approvals`, {
    method: 'POST', body: { title: '旧单题', options: ['A', 'B'] },
  })
  assert.equal(legacy.status, 200)
  assert.equal(legacy.json.approval.questions, undefined)
})

test('时间线分页：before 游标/hasMore/nextBefore、limit 默认 30 上限 100、非法游标 400', async t => {
  const { server, store } = await setup(t)
  const card = await createCard(server)
  const base = Date.now() - 120_000
  await store.update(draft => {
    for (let index = 0; index < 120; index++) {
      draft.activities.push({
        id: 'ev-' + String(index).padStart(8, '0'),
        cardId: card.id, type: 'progress', actor: { kind: 'agent', name: 'DSH Agent' },
        text: `节点 ${index}`, at: base + index,
      })
    }
    return null
  })
  const first = await api(server, `/api/kanban/cards/${card.id}/activities`)
  assert.equal(first.status, 200)
  assert.equal(first.json.activities.length, 30) // 默认 30
  assert.equal(first.json.hasMore, true)
  assert.equal(first.json.nextBefore, first.json.activities.at(-1).id)
  for (let index = 1; index < first.json.activities.length; index++) {
    assert.ok(first.json.activities[index - 1].at >= first.json.activities[index].at)
  }
  const second = await api(server, `/api/kanban/cards/${card.id}/activities?limit=10&before=${first.json.nextBefore}`)
  assert.equal(second.json.activities.length, 10)
  const firstIds = new Set(first.json.activities.map(item => item.id))
  assert.ok(second.json.activities.every(item => !firstIds.has(item.id)))
  assert.equal(second.json.hasMore, true)

  let page = first.json
  const seen = new Set(page.activities.map(item => item.id))
  let guard = 0
  while (page.hasMore && guard++ < 10) {
    const response = await api(server, `/api/kanban/cards/${card.id}/activities?before=${page.nextBefore}&limit=30`)
    page = response.json
    for (const activity of page.activities) {
      assert.ok(!seen.has(activity.id), '分页不应重复')
      seen.add(activity.id)
    }
  }
  assert.equal(seen.size, 121) // 120 条直写 + 1 条 created
  assert.equal(page.hasMore, false)
  assert.equal(page.nextBefore, null)

  const capped = await api(server, `/api/kanban/cards/${card.id}/activities?limit=999`)
  assert.equal(capped.json.activities.length, 100) // 上限 100
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/activities?before=ev-ffffffff`)).status, 400)
  assert.equal((await api(server, `/api/kanban/cards/${card.id}/activities?before=not-an-id`)).status, 400)
})

test('POST /seed：demo/empty/reset、revision 单调，非法模式 400', async t => {
  const { server } = await setup(t)
  const empty = await api(server, '/api/kanban/seed', { method: 'POST', body: { mode: 'empty' } })
  assert.equal(empty.status, 200)
  assert.equal((await api(server, '/api/kanban/state')).json.cards.length, 0)
  const demo = await api(server, '/api/kanban/seed', { method: 'POST', body: { mode: 'demo' } })
  assert.equal(demo.json.revision, empty.json.revision + 1)
  const state = await api(server, '/api/kanban/state')
  assert.equal(state.json.cards.length, 8)
  assert.equal(state.json.revision, demo.json.revision)
  assert.equal((await api(server, '/api/kanban/seed', { method: 'POST', body: { mode: 'nope' } })).status, 400)
})

test('SSE：连接先发当前 revision，写操作后广播 change', async t => {
  const { server } = await setup(t)
  const sse = await openSse(server.url + '/api/kanban/events')
  t.after(() => sse.close())
  assert.equal(sse.status, 200)
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  const initial = await sse.nextEvent()
  assert.equal(initial.event, 'change')
  assert.equal(initial.data.revision, 1)
  const before = await api(server, '/api/kanban/health')
  await createCard(server, { title: '触发广播' })
  const event = await sse.nextEvent()
  assert.equal(event.event, 'change')
  assert.ok(event.data.revision > initial.data.revision)
  assert.ok(event.data.revision > before.json.revision)
})

test('同源校验、JSON 限制与错误码', async t => {
  const { server, store, dir } = await setup(t)
  assert.equal(store.dataDir, dir)
  const evil = await api(server, '/api/kanban/cards', {
    method: 'POST', headers: { origin: 'http://evil.example' }, body: { title: 'x' },
  })
  assert.equal(evil.status, 403)
  assert.equal(evil.json.error.code, 'FORBIDDEN_ORIGIN')
  const sameOrigin = await api(server, '/api/kanban/cards', {
    method: 'POST', headers: { origin: server.url }, body: { title: '同源请求' },
  })
  assert.equal(sameOrigin.status, 200)
  const crossSite = await api(server, '/api/kanban/cards', {
    method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { title: 'x' },
  })
  assert.equal(crossSite.status, 403)

  const wrongType = await api(server, '/api/kanban/cards', { method: 'POST', headers: { 'content-type': 'text/plain' }, rawBody: '{"title":"x"}' })
  assert.equal(wrongType.status, 415)
  const badJson = await api(server, '/api/kanban/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, rawBody: '{oops' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.error.code, 'BAD_JSON')
  const arrayBody = await api(server, '/api/kanban/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, rawBody: '[1,2,3]' })
  assert.equal(arrayBody.status, 400)

  const hugeBody = JSON.stringify({ title: 'x', summary: 'y'.repeat(300 * 1024) })
  const huge = await rawRequest(server.port, '/api/kanban/cards', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(hugeBody) }, body: hugeBody,
  })
  assert.equal(huge.status, 413)
  assert.equal(JSON.parse(huge.text).error.code, 'TOO_LARGE')

  const unknown = await api(server, '/api/kanban/does-not-exist')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error.code, 'NOT_FOUND')
  const asset = await api(server, '/api/kanban/asset/anything')
  assert.equal(asset.status, 404)
  assert.equal((await api(server, '/api/kanban/state', { method: 'PUT' })).status, 405)
})

test('静态资源：index/assets/SPA fallback/HEAD/缓存头/防穿越/符号链接逃逸', async t => {
  const rootBase = await tempDir(t)
  const root = join(rootBase, 'dist')
  await writeStaticFixture(root, {
    'index.html': '<html><head><title>看板</title></head><body>kanban-index</body></html>',
    'assets/app-abc12345.js': 'console.log("kanban")',
    'assets/style.css': 'body{}',
    'nested/index.html': '<html>nested-index</html>',
  })
  const secret = join(rootBase, 'secret.txt')
  await writeFile(secret, 'TOP-SECRET')
  await symlink(secret, join(root, 'escape.txt'))
  const { server } = await setup(t, { staticRoot: root })

  const index = await api(server, '/dsh-kanban/')
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type'), /text\/html/)
  assert.match(index.text, /kanban-index/)
  assert.match(index.text, /<base href="\/dsh-kanban\/">/)
  assert.equal(index.headers.get('cache-control'), 'no-store')

  const redirect = await rawRequest(server.port, '/dsh-kanban')
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, '/dsh-kanban/')

  const asset = await api(server, '/dsh-kanban/assets/app-abc12345.js')
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /text\/javascript/)
  assert.match(asset.headers.get('cache-control'), /immutable/)
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff')

  const spa = await api(server, '/dsh-kanban/board/card-123')
  assert.equal(spa.status, 200)
  assert.match(spa.text, /kanban-index/)
  assert.match(spa.text, /<base href="\/dsh-kanban\/">/)
  assert.equal((await api(server, '/dsh-kanban/assets/missing.js')).status, 404)
  assert.equal((await api(server, '/dsh-kanban/', { method: 'POST' })).status, 405)

  const head = await rawRequest(server.port, '/dsh-kanban/assets/style.css', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  assert.ok(Number(head.headers['content-length']) > 0)

  for (const path of ['/dsh-kanban/..%2Fsecret.txt', '/dsh-kanban/..%2F..%2Fsecret.txt', '/dsh-kanban/%2e%2e/secret.txt', '/dsh-kanban/....//secret.txt', '/dsh-kanban/escape.txt']) {
    const res = await rawRequest(server.port, path)
    assert.ok([404, 400].includes(res.status), `${path} -> ${res.status}`)
    assert.ok(!res.text.includes('TOP-SECRET'), `${path} 泄露了外部文件`)
  }
})

test('web/dist 不存在时返回占位页而不是 404', async t => {
  const dir = await tempDir(t)
  const { server } = await setup(t, { staticRoot: join(dir, 'not-built') })
  const res = await api(server, '/dsh-kanban/')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.match(res.text, /还没有构建/)
  assert.match(res.text, /npm run build/)
  const apiError = await api(server, '/api/kanban/health')
  assert.equal(apiError.status, 200)
})

test('并发的写请求串行落盘，最终 state 与 revision 一致', async t => {
  const { server, store } = await setup(t)
  const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => api(server, '/api/kanban/cards', {
    method: 'POST', body: { title: `并发卡 ${index}` },
  })))
  assert.ok(responses.every(res => res.status === 200))
  const revisions = responses.map(res => res.json.revision)
  assert.equal(new Set(revisions).size, 10)
  const state = await api(server, '/api/kanban/state')
  assert.equal(state.json.cards.length, 18)
  assert.equal(state.json.revision, store.peek().meta.revision)
})

test('POST /cards/batch：批量归档/移动、跳过不存在/已归档、上限与参数校验', async t => {
  const { server, store } = await setup(t)
  const first = await createCard(server, { title: '批量归档 A' })
  const second = await createCard(server, { title: '批量移动 B' })
  const third = await createCard(server, { title: '已归档 C' })
  const archived = await api(server, `/api/kanban/cards/${third.id}?version=1`, { method: 'DELETE' })
  assert.equal(archived.status, 200)

  // 批量归档：有效 1 张，跳过不存在 + 已归档
  const batchArchive = await api(server, '/api/kanban/cards/batch', {
    method: 'POST',
    body: { action: 'archive', cardIds: [first.id, 'card-ffffffff', third.id], reason: '批量清理' },
  })
  assert.equal(batchArchive.status, 200)
  assert.equal(batchArchive.json.ok, true)
  assert.deepEqual(batchArchive.json.cards.map(card => card.id), [first.id])
  assert.equal(batchArchive.json.cards[0].archived, true)
  assert.ok(batchArchive.json.cards[0].archivedAt > 0)
  assert.equal(batchArchive.json.skipped.length, 2)
  assert.deepEqual(batchArchive.json.skipped.map(item => item.reason).sort(), ['archived', 'not_found'])
  const archivedTimeline = await api(server, `/api/kanban/cards/${first.id}/activities`)
  assert.equal(archivedTimeline.status, 404) // 归档卡片不再提供时间线
  const firstActivity = (await store.read()).activities.find(item => item.cardId === first.id && item.type === 'archived')
  assert.match(firstActivity.text, /批量清理/)
  const stateAfterArchive = await api(server, '/api/kanban/state')
  assert.equal(stateAfterArchive.json.cards.some(card => card.id === first.id), false)

  // 批量移动：有效 1 张，跳过不存在 + 已归档；cardOrder 头部
  const batchMove = await api(server, '/api/kanban/cards/batch', {
    method: 'POST',
    body: { action: 'move', cardIds: [second.id, 'card-ffffffff', first.id], column: 'running' },
  })
  assert.equal(batchMove.status, 200)
  assert.deepEqual(batchMove.json.cards.map(card => card.id), [second.id])
  assert.equal(batchMove.json.cards[0].status, 'running')
  assert.equal(batchMove.json.skipped.length, 2)
  const stateAfterMove = await api(server, '/api/kanban/state')
  assert.equal(stateAfterMove.json.board.cardOrder.running[0], second.id)
  const secondTimeline = await api(server, `/api/kanban/cards/${second.id}/activities`)
  assert.match(secondTimeline.json.activities[0].text, /移到「进行中」/)

  // 校验：空数组 / 非数组 / 超过 200 / 非法 action / move 缺 column / 非法 column / 方法
  assert.equal((await api(server, '/api/kanban/cards/batch', { method: 'POST', body: { action: 'archive', cardIds: [] } })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards/batch', { method: 'POST', body: { action: 'archive', cardIds: 'nope' } })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards/batch', {
    method: 'POST', body: { action: 'archive', cardIds: Array.from({ length: 201 }, (_, index) => 'card-' + String(index).padStart(8, '0')) },
  })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards/batch', { method: 'POST', body: { action: 'nope', cardIds: [second.id] } })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards/batch', { method: 'POST', body: { action: 'move', cardIds: [second.id] } })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards/batch', { method: 'POST', body: { action: 'move', cardIds: [second.id], column: 'nope' } })).status, 400)
  assert.equal((await api(server, '/api/kanban/cards/batch')).status, 405)

  // 200 个不存在的 ID 合法（全部跳过）
  const missingOnly = await api(server, '/api/kanban/cards/batch', {
    method: 'POST', body: { action: 'archive', cardIds: Array.from({ length: 200 }, (_, index) => 'card-' + String(index).padStart(8, '0')) },
  })
  assert.equal(missingOnly.status, 200)
  assert.equal(missingOnly.json.cards.length, 0)
  assert.equal(missingOnly.json.skipped.length, 200)
})
