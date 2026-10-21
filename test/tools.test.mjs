// tools.js：10 个 agent 工具的 schema 形态、只读查询、写入流程、错误 JSON、取消信号。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools, TOOL_NAMES } from '../lib/tools.js'
import { testStore } from './helpers.mjs'

const EXEC = { agent: { id: 'agent-test-1' } }
const parse = text => JSON.parse(text)

async function setup(t) {
  const { store } = await testStore(t)
  const tools = createTools({ store })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return { store, tools, byName }
}

test('10 个工具名字固定且 schema 形态完整', async t => {
  const { tools } = await setup(t)
  assert.deepEqual(tools.map(tool => tool.name), TOOL_NAMES)
  const approvalTool = tools.find(tool => tool.name === 'kanban_request_approval')
  assert.ok(approvalTool.parameters.properties.questions)
  assert.equal(approvalTool.parameters.properties.questions.maxItems, 6)
  assert.ok(approvalTool.parameters.properties.questions.items.properties.options)
  assert.equal(new Set(TOOL_NAMES).size, 10)
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object', tool.name)
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.ok(tool.description.length > 20, `${tool.name} 缺少中文说明`)
    assert.equal(tool.output.schema.type, 'string')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    const rendered = tool.output.render({}, '{"ok":true}')
    assert.deepEqual(rendered, [{ type: 'text', text: '{"ok":true}' }])
  }
})

test('kanban_boards / kanban_cards：只读查询与过滤', async t => {
  const { byName } = await setup(t)
  const boards = parse(await byName.get('kanban_boards').execute({}, EXEC))
  assert.equal(boards.ok, true)
  assert.equal(boards.boards.length, 1)
  assert.equal(boards.boards[0].counts.total, 8)
  assert.equal(boards.boards[0].counts.needs_you, 5)

  const cardsTool = byName.get('kanban_cards')
  const all = parse(await cardsTool.execute({}, EXEC))
  assert.equal(all.ok, true)
  assert.equal(all.cards.length, 8)
  assert.equal(all.total, 8)
  assert.equal(all.cards[0].status !== undefined, true)
  assert.equal(all.cards[0].columnLabel.length > 0, true)
  assert.equal(Object.hasOwn(all.cards[0], 'approvals'), false) // 列表用摘要，不带全量审批

  assert.equal(parse(await cardsTool.execute({ status: 'blocked' }, EXEC)).total, 1)
  assert.equal(parse(await cardsTool.execute({ status: 'needs_you' }, EXEC)).total, 3)
  assert.equal(parse(await cardsTool.execute({ label: 'mvp' }, EXEC)).total, 2)
  assert.equal(parse(await cardsTool.execute({ project: 'dsh-kanban' }, EXEC)).total, 8)
  assert.equal(parse(await cardsTool.execute({ project: 'other' }, EXEC)).total, 0)
  assert.ok(parse(await cardsTool.execute({ q: '看板' }, EXEC)).total >= 1)
  // 种子卡片不再伪造会话绑定；会话过滤在下面 link_session 流程里覆盖。
  assert.equal(parse(await cardsTool.execute({ sessionId: 'session-kanban-demo' }, EXEC)).total, 0)
  const limited = parse(await cardsTool.execute({ limit: 2 }, EXEC))
  assert.equal(limited.cards.length, 2)
  assert.ok(limited.total > 2)

  const badBoard = parse(await cardsTool.execute({ boardId: 'board-ffffffff' }, EXEC))
  assert.equal(badBoard.ok, false)
  assert.equal(badBoard.error.code, 'BOARD_NOT_FOUND')
})

test('kanban_card 返回完整卡片、时间线与 pending approval（单选/多选）', async t => {
  const { byName } = await setup(t)
  const list = parse(await byName.get('kanban_cards').execute({ status: 'needs_you' }, EXEC))
  const single = list.cards.find(card => card.pendingApproval?.multiSelect === false && card.pendingApproval?.questionCount === 0)
  assert.ok(single, '种子应包含单选审批卡')
  const cardId = single.id
  const detail = parse(await byName.get('kanban_card').execute({ cardId, activityLimit: 2 }, EXEC))
  assert.equal(detail.ok, true)
  assert.equal(detail.card.id, cardId)
  assert.equal(detail.card.checklists.length, 0)
  assert.equal(detail.pendingApproval.multiSelect, false)
  assert.equal(detail.pendingApproval.options.length, 2)
  assert.equal(detail.activities.length, 2)
  assert.ok(detail.activities[0].at >= detail.activities[1].at)
  assert.match(detail.hint, /等待用户确认/)

  const multi = list.cards.find(card => card.pendingApproval?.multiSelect === true && card.pendingApproval?.questionCount === 0)
  assert.ok(multi, '种子应包含多选审批卡')
  const multiDetail = parse(await byName.get('kanban_card').execute({ cardId: multi.id }, EXEC))
  assert.equal(multiDetail.pendingApproval.multiSelect, true)
  assert.equal(multiDetail.pendingApproval.options.length, 4)

  // 多问题审批示例卡：kanban_card 返回 questions（逐题单选/多选）
  const review = list.cards.find(card => card.pendingApproval?.questionCount === 3)
  assert.ok(review, '种子应包含 3 题多问题审批卡')
  const reviewDetail = parse(await byName.get('kanban_card').execute({ cardId: review.id }, EXEC))
  assert.equal(reviewDetail.pendingApproval.questions.length, 3)
  assert.equal(reviewDetail.questions.length, 3)
  assert.equal(reviewDetail.questions[1].multiSelect, true)
  assert.match(reviewDetail.hint, /3 题/)

  const missing = parse(await byName.get('kanban_card').execute({ cardId: 'card-ffffffff' }, EXEC))
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'CARD_NOT_FOUND')
  const invalid = parse(await byName.get('kanban_card').execute({ cardId: 'bad-id' }, EXEC))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'BAD_REQUEST')
})

test('kanban_create_card / kanban_update_card / kanban_move_card 串起工作流', async t => {
  const { store, byName } = await setup(t)
  const created = parse(await byName.get('kanban_create_card').execute({
    title: '工具创建的卡', summary: '验证 agent 工具写路径', project: 'dsh-kanban', labels: ['agent'], priority: 'medium',
  }, EXEC))
  assert.equal(created.ok, true)
  assert.equal(created.card.status, 'backlog')
  assert.equal(created.card.version, 1)
  assert.equal(created.card.metadata.toolCalls, 1)
  assert.match(created.hint, /kanban_move_card/)
  const cardId = created.card.id

  const updated = parse(await byName.get('kanban_update_card').execute({
    cardId, status: 'running', currentAction: '正在写工具测试', progress: { step: 1, total: 3 },
  }, EXEC))
  assert.equal(updated.ok, true)
  assert.equal(updated.card.status, 'running')
  assert.equal(updated.card.currentAction, '正在写工具测试')
  assert.equal(updated.card.progress.percent, 33)
  assert.equal(updated.card.metadata.toolCalls, 2)

  const noFields = parse(await byName.get('kanban_update_card').execute({ cardId }, EXEC))
  assert.equal(noFields.ok, false)
  assert.equal(noFields.error.code, 'BAD_REQUEST')

  const moved = parse(await byName.get('kanban_move_card').execute({ cardId, column: 'done', text: '工具移动' }, EXEC))
  assert.equal(moved.ok, true)
  assert.equal(moved.card.status, 'done')
  assert.match(moved.activity.text, /移到「已完成」：工具移动/)

  const missing = parse(await byName.get('kanban_move_card').execute({ cardId: 'card-ffffffff', column: 'running' }, EXEC))
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'CARD_NOT_FOUND')
  const noTarget = parse(await byName.get('kanban_move_card').execute({ cardId }, EXEC))
  assert.equal(noTarget.error.code, 'BAD_REQUEST')

  // 写操作 actor 统一记录为 DSH Agent
  const data = await store.read()
  const createdActivity = data.activities.find(item => item.cardId === cardId && item.type === 'created')
  assert.equal(createdActivity.actor.kind, 'agent')
  assert.equal(createdActivity.actor.name, 'DSH Agent')
  assert.equal(createdActivity.actor.id, 'agent-test-1')
})

test('kanban_add_activity 写入节点并可累加 metadata 计数', async t => {
  const { store, byName } = await setup(t)
  const created = parse(await byName.get('kanban_create_card').execute({ title: '活动测试卡' }, EXEC))
  const cardId = created.card.id
  const added = parse(await byName.get('kanban_add_activity').execute({
    cardId, text: '读完了契约文档', type: 'progress', data: { docs: 3 }, metadata: { searches: 2, elapsedMs: 1500 },
  }, EXEC))
  assert.equal(added.ok, true)
  assert.equal(added.activity.type, 'progress')
  assert.equal(added.activity.text, '读完了契约文档')
  assert.equal(added.card.metadata.toolCalls, 2)
  assert.equal(added.card.metadata.searches, 2)
  assert.equal(added.card.metadata.elapsedMs, 1500)

  const detail = parse(await byName.get('kanban_card').execute({ cardId }, EXEC))
  assert.ok(detail.activities.some(item => item.text === '读完了契约文档' && item.data.docs === 3))
  const badType = parse(await byName.get('kanban_add_activity').execute({ cardId, text: 'x', type: 'diagnosis' }, EXEC))
  assert.equal(badType.error.code, 'BAD_REQUEST')
  const emptyText = parse(await byName.get('kanban_add_activity').execute({ cardId, text: '  ' }, EXEC))
  assert.equal(emptyText.error.code, 'BAD_REQUEST')
  assert.ok((await store.read()).cards.find(card => card.id === cardId))
})

test('kanban_request_approval → needs_you + pending；kanban_link_session；kanban_complete_card', async t => {
  const { store, byName } = await setup(t)
  const created = parse(await byName.get('kanban_create_card').execute({ title: '需要审批的卡' }, EXEC))
  const cardId = created.card.id

  const approvalResult = parse(await byName.get('kanban_request_approval').execute({
    cardId,
    title: '是否把迁移脚本跑到生产？',
    detail: '会锁表约 30 秒',
    options: ['执行', { id: 'no', label: '先不执行', tone: 'danger' }],
    sessionId: 'session-1',
  }, EXEC))
  assert.equal(approvalResult.ok, true)
  assert.equal(approvalResult.card.status, 'needs_you')
  assert.equal(approvalResult.approval.status, 'pending')
  assert.equal(approvalResult.approval.options.length, 2)
  assert.match(approvalResult.hint, /不要自行替用户批准/)
  const noOptions = parse(await byName.get('kanban_request_approval').execute({ cardId, title: 'x', options: [] }, EXEC))
  assert.equal(noOptions.ok, false)
  assert.equal(noOptions.error.code, 'BAD_REQUEST')

  // 多选审批：multiSelect + 最多 8 个选项
  const multi = parse(await byName.get('kanban_request_approval').execute({
    cardId, title: '发布前要带哪些检查？', multiSelect: true,
    options: [{ id: 'unit-test', label: '单元测试' }, { id: 'build', label: '构建' }, { id: 'docs', label: '文档' }],
  }, EXEC))
  assert.equal(multi.ok, true)
  assert.equal(multi.approval.multiSelect, true)
  assert.equal(multi.approval.options.length, 3)
  const tooMany = parse(await byName.get('kanban_request_approval').execute({
    cardId, title: '9 个选项', options: Array.from({ length: 9 }, (_, index) => `选项${index + 1}`),
  }, EXEC))
  assert.equal(tooMany.ok, false)
  assert.equal(tooMany.error.code, 'BAD_REQUEST')

  // 多题模式：questions 与 title/options 二选一，title 由服务端生成
  const questionsResult = parse(await byName.get('kanban_request_approval').execute({
    cardId,
    questions: [
      { header: '发布窗口', question: '何时发布？', options: ['今天', { id: 'hold', label: '暂缓', tone: 'danger' }] },
      { header: '检查项', question: '带哪些检查？', multiSelect: true, options: ['单测', '构建'] },
    ],
  }, EXEC))
  assert.equal(questionsResult.ok, true)
  assert.equal(questionsResult.questionCount, 2)
  assert.equal(questionsResult.approval.title, '发布窗口：何时发布？')
  assert.equal(questionsResult.approval.questions.length, 2)
  assert.match(questionsResult.hint, /逐题确认/)
  const sevenQuestions = parse(await byName.get('kanban_request_approval').execute({
    cardId, questions: Array.from({ length: 7 }, (_, index) => ({ question: `Q${index + 1}`, options: ['A'] })),
  }, EXEC))
  assert.equal(sevenQuestions.ok, false)
  assert.equal(sevenQuestions.error.code, 'BAD_REQUEST')

  const linked = parse(await byName.get('kanban_link_session').execute({ cardId, sessionId: 'session-tool-1', title: '工具会话' }, EXEC))
  assert.equal(linked.ok, true)
  assert.equal(linked.card.sessionIds[0], 'session-tool-1')
  const relinked = parse(await byName.get('kanban_link_session').execute({ cardId, sessionId: 'session-tool-1' }, EXEC))
  assert.equal(relinked.card.sessionIds.filter(id => id === 'session-tool-1').length, 1)

  const completed = parse(await byName.get('kanban_complete_card').execute({ cardId, result: '迁移脚本已验证，未执行生产变更' }, EXEC))
  assert.equal(completed.ok, true)
  assert.equal(completed.card.status, 'done')
  assert.equal(completed.card.result, '迁移脚本已验证，未执行生产变更')
  assert.ok(completed.card.completedAt > 0)
  assert.match(completed.hint, /新建卡片/)
  const noResult = parse(await byName.get('kanban_complete_card').execute({ cardId }, EXEC))
  assert.equal(noResult.error.code, 'BAD_REQUEST')

  // 审批状态变化时间线都在
  const detail = parse(await byName.get('kanban_card').execute({ cardId }, EXEC))
  assert.ok(detail.activities.some(item => item.type === 'approval_requested'))
  assert.ok(detail.activities.some(item => item.type === 'session_linked'))
  assert.ok(detail.activities.some(item => item.type === 'result'))

  const missingCard = parse(await byName.get('kanban_link_session').execute({ cardId: 'card-ffffffff', sessionId: 's' }, EXEC))
  assert.equal(missingCard.error.code, 'CARD_NOT_FOUND')
  assert.ok((await store.read()).cards.find(card => card.id === cardId).result)
})

test('工具尊重 exec.signal 取消：已取消时不执行、直接抛出', async t => {
  const { byName } = await setup(t)
  const controller = new AbortController()
  controller.abort()
  const exec = { ...EXEC, signal: controller.signal }
  await assert.rejects(byName.get('kanban_boards').execute({}, exec))
  await assert.rejects(byName.get('kanban_create_card').execute({ title: '不该创建' }, exec))
  const liveController = new AbortController()
  const ok = parse(await byName.get('kanban_boards').execute({}, { ...EXEC, signal: liveController.signal }))
  assert.equal(ok.ok, true)
})
