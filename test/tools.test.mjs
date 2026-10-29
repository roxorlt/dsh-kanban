// tools.js：11 个 agent 工具的 schema 形态、只读查询、写入流程、错误 JSON、取消信号。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools, TOOL_NAMES } from '../lib/tools.js'
import { resolveApproval } from '../lib/domain.js'
import { createSessionBinding } from '../lib/session-binding.js'
import { testStore } from './helpers.mjs'

const EXEC = { agent: { id: 'agent-test-1' } }
const parse = text => JSON.parse(text)

/** 带宿主 session 的 exec：生产环境里 agent.session 提供当前会话 id 与 cwd。 */
const SESSION_EXEC = {
  agent: { id: 'agent-session-test', session: { id: 'session-current', header: { cwd: '/repo/kanban' } } },
}

/** 假 workspaceRegistry：get 按 id 查、resolveByPath 按路径前缀解析（未注册路径抛错）。 */
function createFakeRegistry(workspaces = [{ id: 'ws-1', path: '/repo/kanban' }]) {
  return {
    get: id => workspaces.find(workspace => workspace.id === id),
    resolveByPath(path) {
      const found = workspaces
        .filter(workspace => path === workspace.path || path.startsWith(workspace.path + '/'))
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (!found) throw new Error('路径未注册')
      return found
    },
  }
}

/** 假 sessionController：记录 create/rename 调用，可配置失败。 */
function createFakeSessionController({ sessionId = 'session-created-1', failCreate = false, failRename = false } = {}) {
  const calls = []
  return {
    calls,
    async create(request) {
      calls.push({ action: 'create', request })
      if (failCreate) throw new Error('create failed')
      return { sessionId }
    },
    async rename(request) {
      calls.push({ action: 'rename', request })
      if (failRename) throw new Error('rename failed')
    },
  }
}

async function setup(t) {
  const { store } = await testStore(t)
  const tools = createTools({ store })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return { store, tools, byName }
}

/** 注入 sessionBinding 的工具集合（模拟 lib/index.js 在宿主里的接线）。 */
async function setupBound(t, options = {}) {
  const { store } = await testStore(t)
  const registry = options.registry === undefined ? createFakeRegistry() : options.registry
  const controller = options.controller === undefined ? createFakeSessionController() : options.controller
  const sessionBinding = createSessionBinding({
    getWorkspaceRegistry: () => registry,
    getSessionController: () => controller,
    logger: options.logger,
  })
  const tools = createTools({ store, sessionBinding })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return { store, tools, byName, registry, controller }
}

test('14 个工具名字固定且 schema 形态完整', async t => {
  const { tools } = await setup(t)
  assert.deepEqual(tools.map(tool => tool.name), TOOL_NAMES)
  const approvalTool = tools.find(tool => tool.name === 'kanban_request_approval')
  assert.ok(approvalTool.parameters.properties.questions)
  assert.equal(approvalTool.parameters.properties.questions.maxItems, 6)
  assert.ok(approvalTool.parameters.properties.questions.items.properties.options)
  assert.equal(new Set(TOOL_NAMES).size, 14)
  // v0.22.0 新增：收敛巡检 / 合并 / 批量归档恢复
  for (const name of ['kanban_review_board', 'kanban_merge_cards', 'kanban_archive_cards']) {
    assert.ok(tools.some(tool => tool.name === name), `缺少工具 ${name}`)
  }
  assert.ok(tools.find(tool => tool.name === 'kanban_merge_cards').parameters.properties.dryRun)
  assert.ok(tools.find(tool => tool.name === 'kanban_archive_cards').parameters.properties.restore)
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
  assert.equal(linked.primarySessionId, 'session-tool-1')
  const relinked = parse(await byName.get('kanban_link_session').execute({ cardId, sessionId: 'session-tool-1' }, EXEC))
  assert.equal(relinked.card.sessionIds.filter(id => id === 'session-tool-1').length, 1)
  assert.match(relinked.hint, /已经是卡片主会话/)
  const secondSession = parse(await byName.get('kanban_link_session').execute({ cardId, sessionId: 'session-tool-2', title: '第二个' }, EXEC))
  assert.equal(secondSession.hint, undefined)
  assert.equal(secondSession.primarySessionId, 'session-tool-2')
  const setPrimary = parse(await byName.get('kanban_link_session').execute({ cardId, sessionId: 'session-tool-1', title: '工具会话' }, EXEC))
  assert.match(setPrimary.hint, /已设为主会话/)
  assert.equal(setPrimary.primarySessionId, 'session-tool-1')

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

test('kanban_update_card / kanban_card / kanban_cards 支持 handoff（含 null 清除与校验）', async t => {
  const { byName } = await setup(t)
  const updateTool = byName.get('kanban_update_card')
  assert.ok(updateTool.parameters.properties.handoff)
  assert.equal(updateTool.parameters.properties.handoff.oneOf.length, 2)
  assert.match(updateTool.description, /handoff/)

  const created = parse(await byName.get('kanban_create_card').execute({ title: 'handoff 工具卡' }, EXEC))
  const cardId = created.card.id
  const updated = parse(await updateTool.execute({
    cardId,
    handoff: { summary: '暂停在写测试', nextSteps: '继续跑冒烟', sessionId: 's-1' },
  }, EXEC))
  assert.equal(updated.ok, true)
  assert.equal(updated.card.handoff.summary, '暂停在写测试')
  assert.equal(updated.card.handoff.nextSteps, '继续跑冒烟')
  assert.equal(updated.card.handoff.sessionId, 's-1')
  assert.ok(updated.card.handoff.at > 0)
  assert.match(updated.card.handoff.by.name, /DSH Agent/)

  // kanban_card 详情与 kanban_cards 摘要都含 handoff
  const detail = parse(await byName.get('kanban_card').execute({ cardId }, EXEC))
  assert.equal(detail.card.handoff.summary, '暂停在写测试')
  const list = parse(await byName.get('kanban_cards').execute({ q: 'handoff 工具卡' }, EXEC))
  assert.equal(list.cards.find(card => card.id === cardId).handoff.summary, '暂停在写测试')
  const timeline = parse(await byName.get('kanban_card').execute({ cardId }, EXEC))
  assert.ok(timeline.activities.some(item => item.type === 'handoff' && item.text === '更新了交接摘要'))

  // null 清除
  const cleared = parse(await updateTool.execute({ cardId, handoff: null }, EXEC))
  assert.equal(cleared.ok, true)
  assert.equal(cleared.card.handoff, undefined)
  // 空 summary → 错误 JSON
  const invalid = parse(await updateTool.execute({ cardId, handoff: { summary: '  ' } }, EXEC))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'BAD_REQUEST')
})

test('kanban_request_approval：选项 outcome 声明提交后卡片进入的列', async t => {
  const { store, byName } = await setup(t)
  const created = parse(await byName.get('kanban_create_card').execute({ title: '收尾确认', status: 'running' }, EXEC))
  const cardId = created.card.id
  const result = parse(await byName.get('kanban_request_approval').execute({
    cardId,
    title: '这次任务可以收尾了吗？',
    options: [
      { id: 'finish', label: '确认完成', tone: 'primary', outcome: 'done' },
      { id: 'keep', label: '继续处理' },
    ],
  }, EXEC))
  assert.equal(result.ok, true)
  assert.equal(result.card.status, 'needs_you')
  assert.equal(result.approval.options[0].outcome, 'done')
  assert.equal(result.approval.options[1].outcome, undefined)
  assert.match(result.hint, /自动进入对应列/)
  const stored = (await store.read()).cards.find(card => card.id === cardId)
  assert.equal(stored.approvals[0].options[0].outcome, 'done')

  // 非法 outcome 被 domain 严格校验拒绝
  const invalid = parse(await byName.get('kanban_request_approval').execute({
    cardId, title: '坏去向', options: [{ label: '收尾', outcome: 'canceled' }],
  }, EXEC))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'BAD_REQUEST')

  // schema 里暴露枚举，agent 能按契约声明去向
  const schema = byName.get('kanban_request_approval').parameters.properties.options.items.oneOf[1].properties.outcome
  assert.deepEqual(schema.enum, ['running', 'backlog', 'done'])
})

test('kanban_decisions：只读查询决策日志、state 过滤与等待计数', async t => {
  const { store, byName } = await setup(t)
  const tool = byName.get('kanban_decisions')
  assert.ok(tool, '应注册 kanban_decisions')
  assert.ok(tool.parameters.properties.state)
  assert.equal(tool.parameters.properties.limit.maximum, 100)

  const created = parse(await byName.get('kanban_create_card').execute({ title: '决策日志工具卡', status: 'running' }, EXEC))
  const cardId = created.card.id
  const requested = parse(await byName.get('kanban_request_approval').execute({
    cardId, title: '要继续吗？', detail: '上下文', options: [{ id: 'yes', label: '继续', outcome: 'running' }],
  }, EXEC))
  assert.equal(requested.ok, true)

  // 等用户提交前：state=waiting 能看到这条请求
  const waiting = parse(await tool.execute({ cardId, state: 'waiting' }, EXEC))
  assert.equal(waiting.ok, true)
  assert.equal(waiting.total, 1)
  assert.equal(waiting.waiting, 1)
  assert.equal(waiting.decisions.length, 1)
  assert.equal(waiting.decisions[0].type, 'approval_requested')
  assert.equal(waiting.decisions[0].state, 'waiting')
  assert.equal(waiting.decisions[0].approval.title, '要继续吗？')
  assert.equal(waiting.file, store.decisionLog.file)

  // 用户提交（工具没有 resolve，直接走 domain + store.update 模拟用户在板上点选）
  await store.update(draft => resolveApproval(draft, cardId, requested.approval.id, {
    optionIds: ['yes'], actor: { kind: 'user', name: '你' },
  }))
  const resolved = parse(await tool.execute({ cardId, state: 'resolved' }, EXEC))
  assert.equal(resolved.waiting, 0)
  assert.equal(resolved.decisions.length, 1)
  assert.equal(resolved.decisions[0].decision, 'approved')
  const resolvedEvent = parse(await tool.execute({ cardId, type: 'approval_resolved' }, EXEC))
  assert.equal(resolvedEvent.decisions.length, 1)
  assert.equal(resolvedEvent.decisions[0].outcomeColumn, 'running')
  assert.equal(resolvedEvent.decisions[0].requestId, resolved.decisions[0].id)

  // 事件类型过滤 + since 过滤（把未来时间当 since → 空）
  const requestedOnly = parse(await tool.execute({ cardId, type: 'approval_requested' }, EXEC))
  assert.equal(requestedOnly.filtered, 1)
  assert.equal(requestedOnly.total, 2) // total 是日志总条数，filtered 才是筛选命中数
  const future = parse(await tool.execute({ cardId, since: Date.now() + 60_000 }, EXEC))
  assert.equal(future.decisions.length, 0)
  assert.equal(future.filtered, 0)

  // 非法 type/state → 错误 JSON
  const badType = parse(await tool.execute({ cardId, type: 'not_a_type' }, EXEC))
  assert.equal(badType.ok, false)
  assert.equal(badType.error.code, 'BAD_REQUEST')
  const badState = parse(await tool.execute({ cardId, state: 'pending' }, EXEC))
  assert.equal(badState.ok, false)
  assert.equal(badState.error.code, 'BAD_REQUEST')
})

// ---------------- 建卡自动绑定会话 / 工作区（v0.20.1） ----------------

test('kanban_create_card 默认 reuse：自动绑定当前会话、补全工作区/目录并写 session_linked', async t => {
  const { store, byName } = await setupBound(t)
  const tool = byName.get('kanban_create_card')
  assert.deepEqual(tool.parameters.properties.sessionMode.enum, ['reuse', 'new', 'none'])
  assert.equal(tool.parameters.properties.sessionMode.default, 'reuse')
  assert.match(tool.description, /sessionMode/)

  const created = parse(await tool.execute({ title: '自动绑定卡', summary: '验证 reuse 默认' }, SESSION_EXEC))
  assert.equal(created.ok, true)
  assert.equal(created.card.metadata.toolCalls, 1)
  assert.equal(created.card.sessionIds[0], 'session-current')
  assert.equal(created.card.cwd, '/repo/kanban')
  assert.equal(created.card.workspaceId, 'ws-1')
  assert.deepEqual(created.binding, {
    mode: 'reuse', sessionId: 'session-current', created: false, source: 'agent', workspaceId: 'ws-1', cwd: '/repo/kanban',
    parentCardId: null,
  })
  assert.equal(created.parentCardId, null)
  assert.equal(created.warnings, undefined)
  assert.match(created.hint, /自动绑定当前会话/)

  const data = await store.read()
  const linked = data.activities.find(item => item.cardId === created.card.id && item.type === 'session_linked')
  assert.ok(linked, '建卡时应写入 session_linked 时间线')
  assert.equal(linked.actor.kind, 'agent')
  assert.equal(linked.text, '建卡时自动绑定了当前会话')
  assert.equal(linked.data.sessionId, 'session-current')
  assert.equal(linked.data.action, 'auto')
  assert.equal(linked.data.source, 'agent')
  assert.equal(linked.data.created, false)
  assert.equal(linked.data.workspaceId, 'ws-1')
  assert.equal(linked.data.cwd, '/repo/kanban')
})

test('kanban_create_card sessionMode:new：真实新建会话、绑定新 id 并改名', async t => {
  const { store, byName, controller } = await setupBound(t)
  const created = parse(await byName.get('kanban_create_card').execute({
    title: '新会话卡', sessionMode: 'new', cwd: '/repo/kanban/sub',
  }, SESSION_EXEC))
  assert.equal(created.ok, true)
  assert.equal(created.binding.mode, 'new')
  assert.equal(created.binding.sessionId, 'session-created-1')
  assert.equal(created.binding.created, true)
  assert.equal(created.binding.source, 'agent')
  assert.equal(created.card.sessionIds[0], 'session-created-1')
  assert.equal(created.card.cwd, '/repo/kanban/sub')
  assert.equal(created.card.workspaceId, 'ws-1')
  assert.match(created.hint, /已新建会话/)
  assert.deepEqual(controller.calls[0], { action: 'create', request: { workspaceId: 'ws-1' } })
  assert.deepEqual(controller.calls[1], { action: 'rename', request: { sessionId: 'session-created-1', title: '新会话卡' } })

  const data = await store.read()
  const linked = data.activities.find(item => item.cardId === created.card.id && item.type === 'session_linked')
  assert.equal(linked.text, '建卡时新建并绑定了会话')
  assert.equal(linked.data.created, true)
  assert.equal(linked.data.action, 'auto')
})

test('kanban_create_card sessionMode:new：宿主不支持新建会话时卡片照常创建 + warnings', async t => {
  const logs = []
  const { store, byName } = await setupBound(t, { controller: null, logger: { warn: message => logs.push(message) } })
  const created = parse(await byName.get('kanban_create_card').execute({ title: '降级卡', sessionMode: 'new' }, SESSION_EXEC))
  assert.equal(created.ok, true)
  assert.equal(created.binding.sessionId, null)
  assert.equal(created.binding.created, false)
  assert.deepEqual(created.card.sessionIds, [])
  assert.equal(created.card.cwd, '/repo/kanban')
  assert.equal(created.card.workspaceId, 'ws-1')
  assert.ok(Array.isArray(created.warnings) && created.warnings.some(item => /不支持自动新建会话/.test(item)))
  assert.match(created.hint, /新建会话未完成/)
  assert.ok((await store.read()).cards.find(card => card.id === created.card.id), '卡片应照常创建')
  const detail = parse(await byName.get('kanban_card').execute({ cardId: created.card.id }, SESSION_EXEC))
  assert.equal(detail.activities.some(item => item.type === 'session_linked'), false)
})

test('kanban_create_card sessionMode:new：宿主新建失败时卡片照常创建 + warnings', async t => {
  const controller = createFakeSessionController({ failCreate: true })
  const { store, byName } = await setupBound(t, { controller })
  const created = parse(await byName.get('kanban_create_card').execute({ title: '失败降级卡', sessionMode: 'new' }, SESSION_EXEC))
  assert.equal(created.ok, true)
  assert.equal(created.binding.sessionId, null)
  assert.equal(created.binding.workspaceId, 'ws-1')
  assert.ok(created.warnings.some(item => /新建会话失败/.test(item)))
  assert.ok((await store.read()).cards.find(card => card.id === created.card.id))
})

test('kanban_create_card sessionMode:none：不绑定会话但补全目录/工作区；无会话上下文时同旧行为', async t => {
  const { store, byName } = await setupBound(t)
  const created = parse(await byName.get('kanban_create_card').execute({ title: '不绑定卡', sessionMode: 'none' }, SESSION_EXEC))
  assert.equal(created.ok, true)
  assert.equal(created.binding.sessionId, null)
  assert.equal(created.binding.source, null)
  assert.deepEqual(created.card.sessionIds, [])
  assert.equal(created.card.cwd, '/repo/kanban')
  assert.equal(created.card.workspaceId, 'ws-1')
  const data = await store.read()
  assert.equal(data.activities.some(item => item.cardId === created.card.id && item.type === 'session_linked'), false)

  // 单测/旧宿主没有 agent.session：保持旧行为，不自动补全
  const legacy = parse(await byName.get('kanban_create_card').execute({ title: '无会话上下文卡' }, EXEC))
  assert.equal(legacy.ok, true)
  assert.equal(legacy.binding.sessionId, null)
  assert.deepEqual(legacy.card.sessionIds, [])
  assert.equal(legacy.warnings, undefined)
})

test('kanban_create_card 显式 sessionId：source=explicit，不新建会话', async t => {
  const { store, byName, controller } = await setupBound(t)
  const created = parse(await byName.get('kanban_create_card').execute({
    title: '显式会话卡', sessionMode: 'new', sessionId: 'session-explicit',
  }, SESSION_EXEC))
  assert.equal(created.ok, true)
  assert.equal(created.binding.sessionId, 'session-explicit')
  assert.equal(created.binding.source, 'explicit')
  assert.equal(created.binding.created, false)
  assert.equal(created.card.sessionIds[0], 'session-explicit')
  assert.equal(controller.calls.length, 0)
  const data = await store.read()
  const linked = data.activities.find(item => item.cardId === created.card.id && item.type === 'session_linked')
  assert.equal(linked.text, '建卡时绑定了指定会话')
  assert.equal(linked.data.action, 'link')
})

test('kanban_create_card sessionMode:new：建卡前置校验失败时不建会话（防孤儿）', async t => {
  const { store, byName, controller } = await setupBound(t)
  const badBoard = parse(await byName.get('kanban_create_card').execute({
    title: '坏看板卡', sessionMode: 'new', boardId: 'board-ffffffff',
  }, SESSION_EXEC))
  assert.equal(badBoard.ok, false)
  assert.equal(badBoard.error.code, 'BOARD_NOT_FOUND')
  const emptyTitle = parse(await byName.get('kanban_create_card').execute({ title: '  ', sessionMode: 'new' }, SESSION_EXEC))
  assert.equal(emptyTitle.ok, false)
  assert.equal(emptyTitle.error.code, 'BAD_REQUEST')
  assert.equal(controller.calls.length, 0)
  assert.equal((await store.read()).cards.filter(card => card.title === '坏看板卡').length, 0)
})
