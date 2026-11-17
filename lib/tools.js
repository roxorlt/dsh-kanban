// agent 工具：14 个 kanban_* 工具，让 DSH Agent 把看板当作任务控制面。
// 每个工具返回 JSON 字符串（成功 {ok:true,...}，失败 {ok:false,error:{code,message,extra?}}）。
// 工具内部强制乐观锁（不需要 version），actor 统一记录为 DSH Agent。
// 拆卡纪律（L0）：卡片=可验收的交付物，执行步骤写 checklist 或多会话；只有真正独立、
// 需要单独验收/交接的交付物才新建卡片，避免卡片膨胀。
import {
  APPROVAL_OUTCOMES, APPROVAL_TONES, COLUMNS, COLUMN_OF_STATUS, COLUMN_LABELS, LIMITS, PRIORITIES, STATUSES,
  DomainError, applyCardAgentAttribution, archiveCards, changeStatus, cleanText, completeCard, countsFor, createCard, findCard,
  findConvergentCardForCreate, linkSession, mergeCards, moveCard, normalizeChecklists, normalizeStatus,
  patchCard, pushActivity, requestApproval, requireCard, resolveAgentAttribution, restoreCards,
  reviewBoard, touchCard, touchMeta,
} from './domain.js'
import { APPROVAL_DECISION_STATES, DECISION_TYPES } from './decisions.js'
import { SESSION_MODES, bindingActivity, currentSession } from './session-binding.js'

export const TOOL_NAMES = [
  'kanban_boards', 'kanban_cards', 'kanban_card', 'kanban_decisions', 'kanban_create_card',
  'kanban_update_card', 'kanban_move_card', 'kanban_add_activity', 'kanban_request_approval',
  'kanban_link_session', 'kanban_complete_card',
  'kanban_review_board', 'kanban_merge_cards', 'kanban_archive_cards',
]

const ACTIVITY_INPUT_TYPES = ['progress', 'comment', 'checklist', 'artifact', 'result', 'error', 'ack']

const failure = (code, message, extra) => JSON.stringify({
  ok: false,
  error: { code, message, ...(extra !== undefined ? { extra } : {}) },
})
const success = value => JSON.stringify({ ok: true, ...value })

function toolFailure(error) {
  if (error instanceof DomainError) return failure(error.code, error.message, error.extra)
  const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'INTERNAL'
  const message = code === 'INTERNAL' ? '看板操作未完成，请稍后重试' : (error?.message || '看板操作未完成')
  return failure(code, message)
}

function agentActor(exec) {
  const id = exec?.agent?.id
  const explicitName = cleanText(exec?.agent?.name, LIMITS.agentName)
  const rawHarness = cleanText(exec?.agent?.harness, 64).toLowerCase()
  const isExternal = Boolean(rawHarness && rawHarness !== 'dsh' && rawHarness !== 'deepseek')
  const resolved = isExternal ? resolveAgentAttribution(exec?.agent, { defaultHarness: rawHarness }) : null
  const name = isExternal ? (resolved?.name || explicitName || 'DSH Agent') : (explicitName || 'DSH Agent')
  return { kind: 'agent', name, ...(typeof id === 'string' && id ? { id } : {}) }
}

function execCardAgent(exec) {
  return resolveAgentAttribution(exec?.agent, { defaultHarness: 'dsh' })
}

function assertLive(exec) {
  if (exec?.signal?.aborted) throw exec.signal.reason ?? Object.assign(new Error('操作已取消'), { name: 'AbortError' })
  exec?.signal?.throwIfAborted?.()
}

async function execute(exec, work) {
  try {
    assertLive(exec)
    const value = await work()
    return success(value)
  } catch (error) {
    if (exec?.signal?.aborted) throw exec.signal.reason ?? error
    return toolFailure(error)
  }
}

function assertCardId(id) {
  if (typeof id !== 'string' || !/^card-[a-f0-9]{6,8}$/.test(id)) throw new DomainError('BAD_REQUEST', 'cardId 必须是 card-xxxxxxxx 形式的卡片 ID')
  return id
}

function bumpToolCall(card, extra) {
  const metadata = { ...(card.metadata || { toolCalls: 0, searches: 0 }) }
  metadata.toolCalls = (metadata.toolCalls || 0) + 1
  if (extra && typeof extra === 'object') {
    for (const key of ['searches', 'elapsedMs', 'tokensIn', 'tokensOut']) {
      const value = Number(extra[key])
      if (Number.isFinite(value) && value > 0) metadata[key] = (metadata[key] || 0) + Math.round(value)
    }
  }
  card.metadata = metadata
}

/** 统一的写路径：store 串行队列 + 每次工具写操作给卡片 toolCalls +1 + 按需自动归属执行 Agent。 */
async function mutate(store, exec, work, { agentMode = 'owner' } = {}) {
  assertLive(exec)
  const actor = agentActor(exec)
  const cardAgent = agentMode === 'none' ? null : execCardAgent(exec)
  const now = Date.now()
  const { result, revision } = await store.update(draft => {
    const output = work(draft, { actor, now })
    if (output?.card) {
      bumpToolCall(output.card, output.metadataDelta)
      if (cardAgent && agentMode !== 'none') {
        applyCardAgentAttribution(output.card, cardAgent, { overwrite: agentMode === 'owner' })
      }
    }
    return output
  })
  return { result, revision, actor }
}

function cardBrief(card) {
  const pending = (card.approvals || []).find(approval => approval.status === 'pending')
  return {
    id: card.id,
    boardId: card.boardId,
    title: card.title,
    summary: card.summary,
    currentAction: card.currentAction,
    status: card.status,
    column: COLUMN_OF_STATUS[card.status] || 'backlog',
    columnLabel: COLUMN_LABELS[COLUMN_OF_STATUS[card.status]] || '待办',
    priority: card.priority,
    labels: card.labels,
    project: card.project,
    ...(card.agent ? { agent: card.agent } : {}),
    sessionIds: card.sessionIds,
    parentCardId: card.parentCardId ?? null,
    dependsOn: card.dependsOn || [],
    ...(card.autoStart === true ? { autoStart: true } : {}),
    progress: card.progress,
    handoff: card.handoff,
    metadata: card.metadata,
    ...(pending ? {
      pendingApproval: {
        id: pending.id,
        title: pending.title,
        multiSelect: pending.multiSelect === true,
        questionCount: Array.isArray(pending.questions) ? pending.questions.length : 0,
      },
    } : {}),
    version: card.version,
    updatedAt: card.updatedAt,
  }
}

function hintFor(card) {
  if (card.status === 'needs_you') {
    const pending = (card.approvals || []).find(approval => approval.status === 'pending')
    const questionCount = Array.isArray(pending?.questions) ? pending.questions.length : 0
    if (questionCount > 1) return `卡片有 ${questionCount} 题的待确认审批；用户会在看板逐题作答，不要自行替用户回答。`
    return '卡片正在等待用户确认；不要自行推进，等用户在看板处理审批。'
  }
  if (card.status === 'done') return '卡片已完成；同一交付物的追问微调请直接重开本卡（kanban_move_card 到 running），只有开启全新独立交付物时才新建一张卡片。'
  return '执行中可用 kanban_update_card 更新 currentAction/progress，关键节点用 kanban_add_activity 记录。'
}

/** 建卡后给 agent 的下一步提示：有会话绑定时说明绑定结果。 */
function createHint(binding) {
  const next = '下一步建议：kanban_move_card 移到 running，再用 kanban_update_card 写 currentAction。'
  if (!binding) return next
  if (binding.created) return `已新建会话 ${binding.sessionId} 并绑定到卡片；${next}`
  if (binding.sessionId) return `已${binding.source === 'explicit' ? '绑定指定' : '自动绑定当前'}会话；${next}`
  if (binding.mode === 'new') return `新建会话未完成，可稍后在卡片里手动新建会话；${next}`
  return next
}

/** 拆卡纪律软提示（L0）：没显式挂父卡时提醒优先用 checklist/多会话，不要给步骤单独建卡。 */
const DISCIPLINE_HINT = '如果这其实是某张卡的步骤，优先用 checklist/多会话，不新建卡。'

/**
 * 建卡前置校验（防孤儿会话）：真的要新建宿主会话前先读一次 store，在快照上试跑一次 createCard，
 * 让 domain 的全部校验（看板存在、卡片数未超限、标题非空、状态/优先级合法…）提前抛错；
 * 校验失败直接向上抛、不建会话。快照是一次性副本，试跑不会落盘。
 */
async function assertCanCreateCard(store, args) {
  createCard(await store.read(), args)
}

const approvalOptionSchema = {
  oneOf: [
    { type: 'string', maxLength: LIMITS.approvalOption },
    {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', maxLength: 40 },
        label: { type: 'string', maxLength: LIMITS.approvalOption },
        description: { type: 'string', maxLength: 300 },
        tone: { type: 'string', enum: APPROVAL_TONES },
        outcome: {
          type: 'string', enum: APPROVAL_OUTCOMES,
          description: '用户选中该项后卡片立即进入的列：继续处理填 running（批准默认）；确认收尾/完成填 done；不再推进、回待办填 backlog（驳回默认）',
        },
      },
      required: ['label'],
    },
  ],
}
const approvalOptionsSchema = {
  type: 'array', minItems: 1, maxItems: LIMITS.approvalOptions, items: approvalOptionSchema,
  description: '1-8 个选项；字符串会自动生成 id，危险操作建议 tone:"danger"（选择即视为拒绝）。可用 outcome 声明「选中后卡片进哪一列」，不填＝批准回进行中、驳回回待办',
}
const cardIdProperty = { type: 'string', pattern: '^card-[a-f0-9]{6,8}$', description: '卡片 ID，例如 card-1a2b3c4d' }
const boardIdProperty = { type: 'string', description: '看板 ID；缺省使用第一个看板' }
const limitProperty = (max, fallback, description) => ({ type: 'integer', minimum: 1, maximum: max, default: fallback, description })

function defineTool({ name, description, properties, required = [], execute: body }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
    },
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: String(value) }] } },
    execute: body,
  }
}

export function createTools({ store, sessionBinding } = {}) {
  if (!store) throw new Error('createTools 需要 store')

  return [
    defineTool({
      name: 'kanban_boards',
      description: '列出 DSH 看板及每个看板四列（待办/进行中/待你确认/已完成）的卡片数量。开始处理看板任务、确认 boardId 或了解当前工作量时先调用。只读，不修改数据。',
      properties: {},
      execute(_args, exec) {
        return execute(exec, async () => {
          const data = await store.read()
          return {
            boards: data.boards.map(board => ({
              id: board.id, name: board.name, description: board.description,
              counts: countsFor(data.cards, board.id), updatedAt: board.updatedAt,
            })),
            revision: data.meta.revision,
            hint: '用 kanban_cards 按看板/状态查询卡片；用 kanban_card 看单卡时间线。',
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_cards',
      description: '查询看板卡片摘要列表，支持按看板、状态、项目、标签、关键词和绑定的 DSH 会话过滤。用于找到要接着做的卡片、查看某项目的进度。只读；返回摘要，详情和时间线请用 kanban_card。',
      properties: {
        boardId: boardIdProperty,
        status: { type: 'string', enum: STATUSES, description: '按状态精确过滤（待办/进行中/待你确认/受阻/失败/已完成/已取消）' },
        project: { type: 'string', maxLength: 120, description: '按项目名过滤（不区分大小写）' },
        label: { type: 'string', maxLength: 24, description: '按标签过滤（不区分大小写）' },
        q: { type: 'string', maxLength: 200, description: '关键词，匹配标题/摘要/当前动作/项目/标签' },
        sessionId: { type: 'string', maxLength: 160, description: '只看绑定了该 DSH 会话的卡片' },
        limit: limitProperty(100, 20, '最多返回多少张，默认 20'),
      },
      execute(args, exec) {
        return execute(exec, async () => {
          const data = await store.read()
          const boardId = cleanText(args.boardId, 120) || data.boards[0]?.id
          if (!data.boards.some(board => board.id === boardId)) throw new DomainError('BOARD_NOT_FOUND', '看板不存在', 404)
          const project = cleanText(args.project, 120).toLowerCase()
          const label = cleanText(args.label, 24).toLowerCase()
          const query = cleanText(args.q, 200).toLowerCase()
          const sessionId = cleanText(args.sessionId, 160)
          const limit = Math.min(100, Math.max(1, Number.isInteger(args.limit) ? args.limit : 20))
          const matched = data.cards.filter(card => {
            if (card.boardId !== boardId || card.archived) return false
            if (args.status && card.status !== args.status) return false
            if (project && String(card.project || '').toLowerCase() !== project) return false
            if (label && !(card.labels || []).some(item => item.toLowerCase() === label)) return false
            if (sessionId && !(card.sessionIds || []).includes(sessionId)) return false
            if (query) {
              const haystack = [card.title, card.summary, card.currentAction, card.project, card.agent?.name, card.agent?.harness, ...(card.labels || [])].join('\n').toLowerCase()
              if (!haystack.includes(query)) return false
            }
            return true
          }).sort((a, b) => b.updatedAt - a.updatedAt)
          return {
            boardId,
            cards: matched.slice(0, limit).map(cardBrief),
            total: matched.length,
            counts: countsFor(data.cards, boardId),
            revision: data.meta.revision,
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_card',
      description: '读取一张卡片的完整详情：五层摘要（summary/currentAction/最近节点/result/待决策）、checklist、审批、产物和最近时间线。每次更新卡片前后、或需要判断是否在等用户确认时调用。只读。',
      properties: {
        cardId: cardIdProperty,
        activityLimit: limitProperty(100, 30, '返回最近多少条时间线节点，默认 30'),
      },
      required: ['cardId'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          const data = await store.read()
          const card = findCard(data, args.cardId)
          if (!card) throw new DomainError('CARD_NOT_FOUND', '卡片不存在或已归档', 404)
          const limit = Math.min(100, Math.max(1, Number.isInteger(args.activityLimit) ? args.activityLimit : 30))
          const activities = data.activities.filter(item => item.cardId === card.id).sort((a, b) => b.at - a.at).slice(0, limit)
          const pending = (card.approvals || []).find(approval => approval.status === 'pending')
          // 父子卡/依赖卡：详情里直接给出子卡与依赖卡摘要（含状态），方便 agent 判断能否收口。
          const children = data.cards
            .filter(item => item.parentCardId === card.id && !item.archived)
            .map(cardBrief)
          const dependsOnCards = (card.dependsOn || []).map(dependencyId => {
            const dependency = data.cards.find(item => item.id === dependencyId)
            return dependency ? cardBrief(dependency) : { id: dependencyId, missing: true }
          })
          const openChildren = children.filter(item => item.status !== 'done' && item.status !== 'canceled')
          return {
            card,
            activities,
            pendingApproval: pending || null,
            questions: pending?.questions ?? [],
            children,
            dependsOnCards,
            revision: data.meta.revision,
            hint: openChildren.length
              ? `${hintFor(card)} 还有 ${openChildren.length} 张未收口子卡，完成前需先收口（或 force 强完成）。`
              : hintFor(card),
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_decisions',
      description: '只读查询决策日志（decisions.jsonl）：正式审批从请求到结果的原始事件流——含正在等你做的选择、你最终做过的选择与未提交就关闭的待定项。可按卡片/看板/事件类型/生命周期状态/时间过滤。用于回顾历史决定、分析等待时长与决策上下文；不写数据、不替用户决策。',
      properties: {
        cardId: { type: 'string', pattern: '^card-[a-f0-9]{6,8}$', description: '只看某张卡片的决策事件' },
        boardId: boardIdProperty,
        type: { type: 'string', enum: DECISION_TYPES, description: '事件类型：approval_requested 请求 / approval_resolved 提交 / approval_unresolved 未决关闭 / log_initialized 日志起点 / data_reset 数据重置' },
        state: { type: 'string', enum: APPROVAL_DECISION_STATES, description: '只匹配请求事件的生命周期：waiting 仍在等待 / resolved 已提交 / unresolved 未提交就关闭' },
        limit: limitProperty(100, 20, '最多返回多少条事件，默认 20'),
        before: { type: 'string', maxLength: 40, description: '上一页最后一条事件 id（分页游标）' },
        since: { type: 'integer', minimum: 0, description: '只返回 at ≥ since（epoch 毫秒）' },
        until: { type: 'integer', minimum: 0, description: '只返回 at ≤ until（epoch 毫秒）' },
      },
      execute(args, exec) {
        return execute(exec, async () => {
          const log = store.decisionLog
          if (!log) throw new DomainError('NOT_FOUND', '决策日志未启用', 404)
          const result = await log.list({
            cardId: args.cardId, boardId: args.boardId, type: args.type, state: args.state,
            limit: args.limit, before: args.before, since: args.since, until: args.until,
          })
          return {
            ...result,
            file: log.file,
            hint: result.waiting > 0
              ? `日志里有 ${result.waiting} 条审批仍在等待用户处理；不要替用户作答。`
              : '决策日志只读；原始事件流文件在 file 路径。',
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_create_card',
      description: '创建一张新卡片，把需要多步执行、需要用户决策或产物可验收的任务放上看板。拆卡纪律（L0）：卡片=可验收的交付物，执行步骤写进 checklist 或多会话推进；只有真正独立、需要单独验收/交接的交付物才新建卡片。默认落在「待办」列；开始执行后用 kanban_move_card 移到 running。默认会自动绑定当前 DSH 会话，并把当前会话的工作区/执行目录补全到卡片（sessionMode:"reuse"）；要在新目录/新会话里做这张卡时传 sessionMode:"new"（按 workspaceId/cwd 新建会话并绑定）；不想绑定会话传 "none"。可用 parentCardId 挂到父卡、dependsOn 声明前置依赖（依赖都完成后卡片才就绪）；不传 parentCardId 时若当前会话恰好只有 1 张进行中卡片会自动挂上。返回的 binding 说明绑定结果，warnings 非空时按提示处理，失败不会影响建卡。创建成功后记住返回的 card.id 用于后续更新。',
      properties: {
        boardId: boardIdProperty,
        title: { type: 'string', maxLength: LIMITS.title, description: '卡片标题（必填，会截断到 120 字）' },
        summary: { type: 'string', maxLength: LIMITS.summary, description: '摘要（≤600 字）：要做什么、验收标准是什么；看板折叠态只展示前两行，详情抽屉完整展示' },
        status: { type: 'string', enum: STATUSES, default: 'backlog', description: '初始状态，默认 backlog' },
        priority: { type: 'string', enum: PRIORITIES, default: 'none', description: '优先级' },
        labels: { type: 'array', items: { type: 'string', maxLength: LIMITS.label }, maxItems: LIMITS.labels, description: '标签，最多 12 个' },
        project: { type: 'string', maxLength: 120, description: '项目名（展示用），如 dsh-kanban' },
        workspaceId: { type: 'string', maxLength: 160, description: 'DSH workspace id（可选）；new 模式下作为新会话要 attach 的工作区' },
        cwd: { type: 'string', maxLength: 1000, description: '执行目录绝对路径（可选）；new 模式且传子目录时卡片保留该目录、会话落在所属工作区根' },
        externalRef: { type: 'string', maxLength: 200, description: '外部关联标识（如 github:owner/repo#42）' },
        externalThreadId: { type: 'string', maxLength: 200, description: '外部 IM 线程标识（如 feishu:oc_xxx）' },
        sessionId: { type: 'string', maxLength: LIMITS.sessionId, description: '显式绑定为主会话的 DSH 会话 ID（可选，优先级最高；传了就不再自动复用/新建）' },
        sessionMode: {
          type: 'string', enum: SESSION_MODES, default: 'reuse',
          description: '会话绑定方式：reuse（默认）=自动绑定当前 DSH 会话并补全工作区/目录；new=新建一个会话并绑定（按 workspaceId/cwd 或当前会话位置解析，旧宿主会降级并在 warnings 提示手动新建）；none=不绑定会话（仍补全目录/工作区）',
        },
        parentCardId: {
          oneOf: [
            { type: 'string', maxLength: 160, description: '父卡 ID：把本卡挂到一张已有的卡下（父子关系只有一层）' },
            { type: 'null', description: '显式不挂父卡（跳过自动挂父卡）' },
          ],
          description: '父卡：不传时若当前会话恰好只有 1 张进行中卡片，会自动把它作为父卡',
        },
        dependsOn: {
          type: 'array', items: cardIdProperty, maxItems: LIMITS.dependsOn,
          description: `前置依赖卡（最多 ${LIMITS.dependsOn} 张）：它们都 done/canceled 后本卡才算就绪（受阻中的卡会自动回到待办）`,
        },
        autoStart: {
          type: 'boolean', default: false,
          description: '前置依赖全部完成后是否自动将本卡移入 running 并通过 Outbox 唤醒会话继续推进（会注入上游产物与摘要）',
        },
        forceNew: {
          type: 'boolean', default: false,
          description: '确需强制新建独立卡片时传 true；默认 false 会自动去重复用同名未完成卡、重开同会话刚完成的同名卡，或在单会话未收口卡超上限（≥8 张）时自动收敛为主卡 checklist 项',
        },
      },
      required: ['title'],
      execute(args, exec) {
        return execute(exec, async () => {
          const current = currentSession(exec?.agent, exec)
          const prepared = sessionBinding
            ? await sessionBinding.prepareCreate({ args, agent: exec?.agent, exec, precheck: () => assertCanCreateCard(store, args) })
            : { input: args, binding: null, warnings: [] }
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => {
            const warnings = []
            let input = { ...prepared.input, ...(args.forceNew ? { forceNew: true } : {}) }
            const convergent = findConvergentCardForCreate(draft, input, {
              sessionId: current?.sessionId || input.sessionId || null,
              now,
            })
            if (convergent) {
              const target = convergent.card
              if (input.sessionId && !(target.sessionIds || []).includes(input.sessionId)) {
                linkSession(draft, target.id, { sessionId: input.sessionId, actor, now })
              }
              if (convergent.kind === 'duplicate_open') {
                if (input.summary && !target.summary) target.summary = cleanText(input.summary, LIMITS.summary)
                if (input.status === 'running' && target.status === 'backlog') {
                  changeStatus(draft, target, 'running', { actor, now, text: '同名卡片开始推进' })
                }
                pushActivity(draft, target, {
                  type: 'progress',
                  actor,
                  text: `建卡收敛：自动复用同名未完成卡片「${target.title}」`,
                  data: { converged: 'duplicate_open' },
                  at: now,
                })
                touchCard(target, now)
                touchMeta(draft, actor, now)
                warnings.push(`已存在同名未完成卡片「${target.title}」（${target.id}），已自动复用避免重复建卡`)
                return { card: target, reused: true, convergedKind: 'duplicate_open', autoParentId: target.parentCardId ?? null, warnings }
              }
              if (convergent.kind === 'reopen_recent_done') {
                const nextStatus = input.status === 'backlog' ? 'backlog' : 'running'
                changeStatus(draft, target, nextStatus, {
                  actor,
                  now,
                  text: `同会话追问续接：自动重开刚完成的卡片「${target.title}」`,
                })
                touchCard(target, now)
                touchMeta(draft, actor, now)
                warnings.push(`同会话刚完成的同名卡片「${target.title}」（${target.id}）已自动重开续接`)
                return { card: target, reused: true, reopened: true, convergedKind: 'reopen_recent_done', autoParentId: target.parentCardId ?? null, warnings }
              }
              if (convergent.kind === 'wip_cap_checklist') {
                const itemText = cleanText(input.title, LIMITS.checklistText)
                target.checklists = normalizeChecklists([...(target.checklists || []), { text: itemText, done: false }])
                pushActivity(draft, target, {
                  type: 'checklist',
                  actor,
                  text: `建卡收敛：未收口卡片已达上限，将「${itemText}」合并为主卡检查项`,
                  data: { converged: 'wip_cap_checklist', itemText },
                  at: now,
                })
                touchCard(target, now)
                touchMeta(draft, actor, now)
                if (convergent.runningCount >= 3) warnings.push(`当前会话已有 ${convergent.runningCount} 张进行中卡片，建议先收口`)
                warnings.push(`当前会话已有 ${convergent.openCount} 张未收口卡片（待办+进行中），建议先收敛再开新卡`)
                return {
                  card: target,
                  reused: true,
                  convergedToChecklist: true,
                  convergedKind: 'wip_cap_checklist',
                  autoParentId: target.parentCardId ?? null,
                  warnings,
                }
              }
            }

            let autoParentId = null
            // 自动挂父卡：未显式传 parentCardId 时，当前会话恰好 1 张未归档 running 卡就挂上去。
            if (input.parentCardId === undefined && current?.sessionId) {
              const runningCards = draft.cards.filter(card => !card.archived
                && card.status === 'running'
                && (card.sessionIds || []).includes(current.sessionId))
              if (runningCards.length === 1) autoParentId = runningCards[0].id
              else if (runningCards.length > 1) warnings.push(`当前会话有 ${runningCards.length} 张进行中卡片，未能自动挂父卡，请显式传 parentCardId`)
            }
            if (autoParentId) input = { ...input, parentCardId: autoParentId }
            const output = createCard(draft, input, { actor, now })
            // 绑定了会话时在同一个事务里补一条 session_linked 时间线（actor=agent）。
            const linked = bindingActivity(prepared.binding)
            if (linked) pushActivity(draft, output.card, { type: 'session_linked', actor, text: linked.text, data: linked.data, at: now })
            // 软提醒（不阻止）：当前会话同时进行/未收口的卡片过多时提醒先收口。
            if (current?.sessionId) {
              const bound = draft.cards.filter(card => !card.archived && (card.sessionIds || []).includes(current.sessionId))
              const running = bound.filter(card => card.status === 'running')
              const open = bound.filter(card => card.status === 'running' || card.status === 'backlog')
              if (running.length >= 3) warnings.push(`当前会话已有 ${running.length} 张进行中卡片，建议先收口`)
              if (open.length >= 8) warnings.push(`当前会话已有 ${open.length} 张未收口卡片（待办+进行中），建议先收敛再开新卡`)
            }
            return { ...output, autoParentId, warnings }
          })
          const parentCardId = result.card.parentCardId ?? null
          const explicitParent = args.parentCardId !== undefined && args.parentCardId !== null
          let hint = result.reused
            ? `已自动收敛到现有卡片 ${result.card.id}（${result.convergedKind}）；请直接在该卡片上推进。`
            : createHint(prepared.binding)
          if (!explicitParent && !result.reused) hint += ' ' + DISCIPLINE_HINT
          const payload = {
            card: result.card,
            parentCardId,
            revision,
            hint,
            ...(result.reused ? { reused: true } : {}),
            ...(result.reopened ? { reopened: true } : {}),
            ...(result.convergedToChecklist ? { convergedToChecklist: true } : {}),
          }
          if (prepared.binding) payload.binding = { ...prepared.binding, parentCardId }
          const warnings = [...new Set([...(prepared.warnings || []), ...(result.warnings || [])])]
          if (warnings.length) payload.warnings = warnings
          return payload
        })
      },
    }),

    defineTool({
      name: 'kanban_update_card',
      description: '更新卡片的字段：标题、摘要、当前动作、结果、状态、优先级、标签、项目、执行目录、agent、进度、checklist、产物、统计、交接摘要（handoff）、父卡（parentCardId）与前置依赖（dependsOn）。执行中定期更新 currentAction/progress，让用户知道你在做什么；卡片状态变化会写入时间线。会话暂停/归档/交接时写 handoff，新会话据此续接（handoff:null 清除）。parentCardId:null 清除父卡、dependsOn:[] 清除依赖。拆卡纪律：卡片=可验收的交付物，步骤用 checklist 而不是新建卡片。',
      properties: {
        cardId: cardIdProperty,
        title: { type: 'string', maxLength: LIMITS.title },
        summary: { type: 'string', maxLength: LIMITS.summary },
        currentAction: { type: 'string', maxLength: LIMITS.currentAction, description: '当前正在做的动作，例如「正在跑测试并修失败用例」' },
        result: { type: 'string', maxLength: LIMITS.result, description: '完成后的结果摘要（done 卡片展示）' },
        status: { type: 'string', enum: STATUSES, description: '状态：running 进行中 / needs_you 待确认 / blocked 受阻 / failed 失败 / done 完成 / canceled 取消 / backlog 待办' },
        priority: { type: 'string', enum: PRIORITIES },
        labels: { type: 'array', items: { type: 'string', maxLength: LIMITS.label }, maxItems: LIMITS.labels },
        project: { type: 'string', maxLength: 120 },
        workspaceId: { type: 'string', maxLength: 160 },
        cwd: { type: 'string', maxLength: 1000 },
        externalRef: { type: 'string', maxLength: 200 },
        externalThreadId: { type: 'string', maxLength: 200 },
        parentCardId: {
          oneOf: [
            { type: 'string', maxLength: 160, description: '挂到这张父卡下（父子关系只有一层，不能成环）' },
            { type: 'null', description: '清除父卡关系' },
          ],
        },
        dependsOn: {
          type: 'array', items: cardIdProperty, maxItems: LIMITS.dependsOn,
          description: `完整替换前置依赖（最多 ${LIMITS.dependsOn} 张，[] 清除）：依赖都 done/canceled 后本卡才就绪`,
        },
        autoStart: {
          type: 'boolean',
          description: '前置依赖全部完成后是否自动将本卡移入 running 并通过 Outbox 唤醒会话继续推进',
        },
        waitCondition: {
          oneOf: [
            { type: 'null', description: '清除等待条件' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['time', 'session_idle'], description: '等待条件类型：time=到达时间窗口后自动唤醒；session_idle=目标会话空闲后自动唤醒' },
                notBefore: { type: 'integer', minimum: 0, description: 'kind=time 时的唤醒时间戳（epoch 毫秒）' },
                targetSessionId: { type: 'string', maxLength: LIMITS.sessionId, description: 'kind=session_idle 时的目标会话 ID' },
                reason: { type: 'string', maxLength: 300, description: '等待原因说明' },
              },
              required: ['kind'],
            },
          ],
          description: '显式等待条件（用于压制 Watchdog 静默停滞催办，并在条件就绪时自动唤醒）',
        },
        forceComplete: {
          type: 'boolean', default: false,
          description: '仅 status=done 时生效：存在未收口子卡时仍强制完成（会写一条「强制完成，留下 N 张未收口子卡」审计节点）',
        },
        agent: { type: 'object', properties: { name: { type: 'string', maxLength: 80 }, id: { type: 'string', maxLength: 160 }, harness: { type: 'string', maxLength: 40 } }, required: ['name'], additionalProperties: false },
        progress: {
          type: 'object', additionalProperties: false,
          properties: { step: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 0 }, percent: { type: 'integer', minimum: 0, maximum: 100 }, text: { type: 'string', maxLength: LIMITS.progressText } },
          description: '进度，例如 {step:2,total:5,text:"实现 routes"}',
        },
        checklists: {
          type: 'array', maxItems: LIMITS.checklists,
          items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string', maxLength: LIMITS.checklistText }, done: { type: 'boolean' } }, required: ['text'] },
          description: '完整替换 checklist；保留已有 id 可避免 UI 重新渲染',
        },
        artifacts: {
          type: 'array', maxItems: LIMITS.artifacts,
          items: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['file', 'link', 'report', 'commit', 'image'] }, label: { type: 'string', maxLength: 120 }, url: { type: 'string', maxLength: 2000 }, path: { type: 'string', maxLength: 800 } }, required: ['label'] },
        },
        metadata: {
          type: 'object', additionalProperties: false,
          properties: { toolCalls: { type: 'integer', minimum: 0 }, searches: { type: 'integer', minimum: 0 }, elapsedMs: { type: 'integer', minimum: 0 }, tokensIn: { type: 'integer', minimum: 0 }, tokensOut: { type: 'integer', minimum: 0 } },
          description: '覆盖统计值（绝对数），不是增量',
        },
        handoff: {
          oneOf: [
            { type: 'null' },
            {
              type: 'object', additionalProperties: false,
              properties: {
                summary: { type: 'string', maxLength: LIMITS.handoffSummary, description: '交接摘要（必填，≤400 字）：当前做到哪、关键决定、已知风险' },
                nextSteps: { type: 'string', maxLength: LIMITS.handoffNextSteps, description: '后续步骤（可选，≤600 字）' },
                sessionId: { type: 'string', maxLength: LIMITS.handoffSessionId, description: '交接来源的 DSH 会话 ID（可选）' },
              },
              required: ['summary'],
            },
          ],
          description: '交接摘要：对象=覆盖写（at/by 由服务端补，写入 handoff 活动），null=清除；不改变卡片状态',
        },
      },
      required: ['cardId'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          const changes = {}
          for (const key of ['title', 'summary', 'currentAction', 'result', 'status', 'priority', 'labels', 'project', 'workspaceId', 'cwd', 'parentCardId', 'dependsOn', 'autoStart', 'waitCondition', 'agent', 'progress', 'checklists', 'artifacts', 'metadata', 'handoff']) {
            if (args[key] !== undefined) changes[key] = args[key]
          }
          if (!Object.keys(changes).length) throw new DomainError('BAD_REQUEST', '没有可更新的字段')
          // forceComplete 只在 status=done 时生效（契约：强完成必须留下审计节点）。
          const forceComplete = args.forceComplete === true && args.status === 'done'
          const agentMode = args.agent !== undefined ? 'none' : 'owner'
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => patchCard(draft, args.cardId, changes, { actor, now, forceComplete, strictChecklists: true }), { agentMode })
          return { card: result.card, revision, hint: hintFor(result.card) }
        })
      },
    }),

    defineTool({
      name: 'kanban_move_card',
      description: '把卡片移动到指定列（backlog/running/needs_you/done）或指定状态，并写入一条时间线。开始执行时移到 running；需要用户决策时改用 kanban_request_approval（会自动移到待你确认）。可传原因 text。移到 done 时若有未收口子卡会被拦截，确需强完成传 forceComplete:true。',
      properties: {
        cardId: cardIdProperty,
        column: { type: 'string', enum: COLUMNS, description: '目标列：backlog 待办 / running 进行中 / needs_you 待你确认 / done 已完成' },
        status: { type: 'string', enum: STATUSES, description: '也可以直接指定状态；与 column 二选一，column 优先' },
        text: { type: 'string', maxLength: 200, description: '移动原因，会写进时间线' },
        forceComplete: {
          type: 'boolean', default: false,
          description: '仅移动到 done 时生效：存在未收口子卡仍强制完成（会写审计节点）',
        },
      },
      required: ['cardId'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          if (args.column === undefined && args.status === undefined) throw new DomainError('BAD_REQUEST', '需要提供 column 或 status')
          if (args.status !== undefined) normalizeStatus(args.status)
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => moveCard(draft, args.cardId, {
            column: args.column, status: args.status, text: args.text, actor, now,
            forceComplete: args.forceComplete === true,
            strictChecklists: true,
          }))
          return { card: result.card, activity: result.activity, revision, hint: hintFor(result.card) }
        })
      },
    }),

    defineTool({
      name: 'kanban_add_activity',
      description: '给卡片时间线追加一个进展节点（progress/comment/error/checklist/artifact/result/ack）。用于记录对用户有意义的里程碑、阻塞和错误；不要为每次工具调用都写节点。可选 metadata 会累加到卡片统计。',
      properties: {
        cardId: cardIdProperty,
        text: { type: 'string', maxLength: LIMITS.activityText, description: '要展示给用户的一句话（必填）' },
        type: { type: 'string', enum: ACTIVITY_INPUT_TYPES, default: 'progress', description: '节点类型，默认 progress' },
        data: { type: 'object', description: '可选结构化数据，随节点保存' },
        metadata: {
          type: 'object', additionalProperties: false,
          properties: { toolCalls: { type: 'integer', minimum: 0 }, searches: { type: 'integer', minimum: 0 }, elapsedMs: { type: 'integer', minimum: 0 }, tokensIn: { type: 'integer', minimum: 0 }, tokensOut: { type: 'integer', minimum: 0 } },
          description: '可选：累加到卡片统计的计数（增量）',
        },
      },
      required: ['cardId', 'text'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          const type = args.type === undefined ? 'progress' : args.type
          if (!ACTIVITY_INPUT_TYPES.includes(type)) throw new DomainError('BAD_REQUEST', '不支持的时间线类型')
          const text = cleanText(args.text, LIMITS.activityText)
          if (!text) throw new DomainError('BAD_REQUEST', 'text 不能为空')
          const counters = args.metadata && typeof args.metadata === 'object' ? args.metadata : undefined
          const agentMode = type === 'progress' || type === 'result' ? 'owner' : 'backfill'
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => {
            const card = requireCard(draft, args.cardId)
            const activity = pushActivity(draft, card, { type, actor, text, data: args.data, at: now })
            touchCard(card, now)
            touchMeta(draft, actor, now)
            return { card, activity, metadataDelta: counters }
          }, { agentMode })
          return { card: cardBrief(result.card), activity: result.activity, revision }
        })
      },
    }),

    defineTool({
      name: 'kanban_request_approval',
      description: '当任务需要用户做决定时，向看板请求审批：卡片自动进入「待你确认」列。两种形态二选一：单题传 title+options（需要多选时 multiSelect:true）；多题（最多 6 题，每题独立单选/多选）传 questions[]，title 由服务端从第一题生成。多题审批在看板里逐题翻页作答，每道题末尾自动带「其他（自行填写）」入口（用户可填自定义答案，≤600 字），不需要自己再加“其他”选项。用户提交后卡片会立即离开「待你确认」：选中选项声明了 outcome 就进该列，否则批准回「进行中」、驳回回「待办」（确认收尾用 outcome:"done"）——所以提交后不要再用 kanban_move_card 补移列。绝不要替用户做决定或伪造批准；请求后等待用户逐题处理。',
      properties: {
        cardId: cardIdProperty,
        title: { type: 'string', maxLength: LIMITS.approvalTitle, description: '要用户确认的问题，例如「是否把迁移脚本跑到生产？」' },
        detail: { type: 'string', maxLength: LIMITS.approvalDetail, description: '背景、影响、风险，帮助用户判断' },
        options: approvalOptionsSchema,
        multiSelect: { type: 'boolean', default: false, description: '单题审批是否多选：true 时用户可勾选多个选项（选项 1-8 个）' },
        questions: {
          type: 'array', minItems: 1, maxItems: LIMITS.approvalQuestions,
          description: '多题审批：1-6 个问题（与 title/options 二选一；传了 questions 后 title 由服务端生成，每题独立单选/多选）',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', maxLength: 40 },
              header: { type: 'string', maxLength: LIMITS.approvalQuestionHeader, description: '题组标题，例如「发布窗口」' },
              question: { type: 'string', maxLength: LIMITS.approvalQuestion, description: '题目（必填）' },
              multiSelect: { type: 'boolean', default: false, description: '该题是否多选' },
              options: approvalOptionsSchema,
            },
            required: ['question', 'options'],
          },
        },
        sessionId: { type: 'string', maxLength: LIMITS.sessionId, description: '请求来自哪个 DSH 会话（可选）' },
      },
      required: ['cardId'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => requestApproval(draft, args.cardId, args, { actor, now }))
          const questionCount = Array.isArray(result.approval.questions) ? result.approval.questions.length : 0
          return {
            approval: result.approval,
            questionCount,
            card: cardBrief(result.card),
            revision,
            hint: questionCount > 1
              ? `已请求用户逐题确认（${questionCount} 题），卡片在「待你确认」列。不要自行替用户作答，等用户处理；提交后卡片会自动进入对应列（选项未声明 outcome 时批准回「进行中」、驳回回「待办」），无需手动补移列。`
              : '已请求用户确认，卡片在「待你确认」列。不要自行替用户批准，等用户处理后再继续；提交后卡片会自动进入对应列（选项未声明 outcome 时批准回「进行中」、驳回回「待办」），无需手动补移列。',
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_link_session',
      description: '把当前 DSH 会话绑定到卡片（主会话排第一位）。之后用户在卡片里回复、打开会话都走这个会话。同一会话不会重复绑定。',
      properties: {
        cardId: cardIdProperty,
        sessionId: { type: 'string', maxLength: LIMITS.sessionId, description: '要绑定的 DSH 会话 ID（必填）' },
        title: { type: 'string', maxLength: 120, description: '会话标题，仅用于时间线展示' },
      },
      required: ['cardId', 'sessionId'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => linkSession(draft, args.cardId, {
            sessionId: args.sessionId, title: args.title, actor, now,
          }), { agentMode: 'backfill' })
          return {
            card: result.card,
            revision,
            primarySessionId: result.card.sessionIds[0] ?? null,
            ...(result.linked ? {} : result.primaryChanged ? { hint: '该会话已是卡片绑定的会话，已设为主会话。' } : { hint: '该会话已经是卡片主会话，未重复写入时间线。' }),
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_complete_card',
      description: '把卡片标记为完成并写入结果（进入「已完成」列）。result 要写清交付物与验收结论，用户会在已完成卡片和详情里看到。还有后续工作请新建卡片，不要复用已完成的卡片。若还有未收口子卡会被 409 拦截（error.extra.openChildren 列出子卡）；确需强完成传 force:true，会写一条「强制完成，留下 N 张未收口子卡」审计节点。拆卡纪律：卡片=可验收的交付物，步骤用 checklist。',
      properties: {
        cardId: cardIdProperty,
        result: { type: 'string', maxLength: LIMITS.result, description: '完成结果：做了什么、产出在哪、如何验收（必填）' },
        force: { type: 'boolean', default: false, description: '存在未收口子卡时仍强制完成（会写审计节点）' },
      },
      required: ['cardId', 'result'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          const result = cleanText(args.result, LIMITS.result)
          if (!result) throw new DomainError('BAD_REQUEST', 'result 不能为空')
          const { result: outcome, revision } = await mutate(store, exec, (draft, { actor, now }) => completeCard(draft, args.cardId, {
            result, actor, now, forceComplete: args.force === true, strictChecklists: true,
          }))
          let hint = '卡片已完成。同一交付物的追问微调请直接重开本卡（kanban_move_card 到 running），只有开启全新独立交付物时才新建卡片。'
          if (outcome.parentReady) {
            hint += ` 父卡「${outcome.parentReady.title}」（${outcome.parentReady.id}）下的全部 ${outcome.parentReady.totalChildren} 张子卡均已收口，请立即调用 kanban_complete_card 收口父卡。`
          }
          if (outcome.wokenDependents?.length) {
            const names = outcome.wokenDependents.map(item => `「${item.title}」（${item.id}）`).join('、')
            hint += ` 下游依赖卡 ${names} 的前置依赖已全部就绪，可立即推进（kanban_move_card 到 running）。`
          }
          return {
            card: outcome.card,
            revision,
            hint,
            ...(outcome.parentReady ? { parentReady: outcome.parentReady } : {}),
            ...(outcome.wokenDependents?.length ? { wokenDependents: outcome.wokenDependents } : {}),
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_review_board',
      description: '收敛巡检（只读）：一次找出陈旧待办、已完成未归档、疑似重复卡片、同一会话多张开卡、缺执行目录的卡片，并给出人话建议。拆卡纪律：卡片=可验收的交付物，步骤写进 checklist，不要为步骤单独建卡。开新卡前或感觉看板膨胀时先跑一次；发现重复用 kanban_merge_cards（可先 dryRun:true 看报告），批量清理用 kanban_archive_cards（可先 dryRun:true）。只读，不写数据。',
      properties: {
        boardId: boardIdProperty,
        staleDays: limitProperty(365, 7, '待办超过多少天未更新算陈旧，默认 7'),
        limit: limitProperty(100, 20, '每个分组最多返回多少条样例，默认 20'),
      },
      execute(args, exec) {
        return execute(exec, async () => {
          const data = await store.read()
          const report = reviewBoard(data, {
            boardId: cleanText(args.boardId, 120) || undefined,
            staleDays: args.staleDays,
            limit: args.limit,
          })
          return {
            ...report,
            revision: data.meta.revision,
            hint: '巡检只读；建议先用 kanban_merge_cards（dryRun:true 预览）合并重复卡、再用 kanban_archive_cards（dryRun:true 预览）归档已完成卡片。',
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_merge_cards',
      description: '把一张卡片合并进另一张（收敛去重）：源的子卡改挂 target、全盘 dependsOn 重指向 target、源会话并入 target、源摘要追加到 target 摘要，然后归档源卡并记录 mergedInto=targetId。源卡还有未收口子卡时拒绝（先收口再合并）。可传 title 覆盖 target 标题、dryRun:true 只做校验与报告不写数据。只在两张卡确实是同一个交付物时使用；卡片=交付物，步骤用 checklist。',
      properties: {
        sourceCardId: { ...cardIdProperty, description: '被合并并归档的源卡 ID' },
        targetCardId: { ...cardIdProperty, description: '保留并接收子卡/依赖/会话的目标卡 ID' },
        title: { type: 'string', maxLength: LIMITS.title, description: '可选：合并后把目标卡标题改成该值（不传保持原标题）' },
        dryRun: { type: 'boolean', default: false, description: 'true=只做校验与「将发生什么」的报告，不写数据' },
      },
      required: ['sourceCardId', 'targetCardId'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.sourceCardId)
          assertCardId(args.targetCardId)
          if (args.dryRun === true) {
            // dryRun 不能走 mutate（不允许写 store）：直接读快照做校验与报告。
            const data = await store.read()
            const preview = mergeCards(data, args.sourceCardId, args.targetCardId, { title: args.title, dryRun: true })
            return {
              dryRun: true,
              source: preview.source,
              target: preview.target,
              willMoveChildren: preview.willMoveChildren,
              willRepointDependsOn: preview.willRepointDependsOn,
              willMoveSessions: preview.willMoveSessions,
              willAppendSummary: preview.willAppendSummary,
              warnings: preview.warnings,
              revision: data.meta.revision,
            }
          }
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => {
            const merged = mergeCards(draft, args.sourceCardId, args.targetCardId, { actor, now, title: args.title })
            return { card: merged.target, ...merged }
          }, { agentMode: 'none' })
          return {
            source: result.source,
            target: result.target,
            movedChildren: result.movedChildren,
            repointedDependsOn: result.repointedDependsOn,
            revision,
            hint: `已把「${result.source.title}」合并到「${result.target.title}」并归档源卡；后续继续在 target 上推进。`,
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_archive_cards',
      description: '批量归档/恢复卡片（收敛清理）：restore:false（默认）归档已完成/废弃卡片，跳过不存在、已归档以及仍有未收口子卡的卡片并在 skipped 里给出原因；restore:true 把已归档卡片恢复回原状态列。dryRun:true 时只返回将发生什么的报告、不写数据（大批量历史清理前先 dry-run）。归档可逆，但只归档真正收尾的卡片；卡片=交付物，步骤用 checklist。',
      properties: {
        cardIds: {
          type: 'array', minItems: 1, maxItems: LIMITS.batchCards, items: cardIdProperty,
          description: `要归档/恢复的卡片 ID（1-${LIMITS.batchCards} 个）`,
        },
        reason: { type: 'string', maxLength: 200, description: '归档原因，会写进时间线（restore 时忽略）' },
        restore: { type: 'boolean', default: false, description: 'true=恢复归档（restored），false=归档（archived）' },
        dryRun: { type: 'boolean', default: false, description: 'true=只返回将发生什么的报告，不写数据' },
      },
      required: ['cardIds'],
      execute(args, exec) {
        return execute(exec, async () => {
          const cardIds = Array.isArray(args.cardIds) ? args.cardIds : []
          const restore = args.restore === true
          const dryRun = args.dryRun === true
          if (dryRun) {
            // dryRun 只读快照，不调用 store.update。
            const data = await store.read()
            const preview = restore
              ? restoreCards(data, cardIds, { dryRun: true })
              : archiveCards(data, cardIds, { dryRun: true })
            return restore
              ? { dryRun: true, wouldRestore: preview.wouldRestore, skipped: preview.skipped, revision: data.meta.revision }
              : { dryRun: true, wouldArchive: preview.wouldArchive, skipped: preview.skipped, revision: data.meta.revision }
          }
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => {
            const output = restore
              ? restoreCards(draft, cardIds, { actor, now })
              : archiveCards(draft, cardIds, { actor, now, reason: args.reason })
            return { card: output.cards[0], cards: output.cards, skipped: output.skipped }
          }, { agentMode: 'none' })
          const ids = result.cards.map(card => card.id)
          return {
            ...(restore ? { restored: ids } : { archived: ids }),
            skipped: result.skipped,
            revision,
            ...(ids.length
              ? { hint: restore ? '已恢复归档卡片，它们回到原状态列。' : '已归档卡片；如需找回可用 kanban_archive_cards restore:true 恢复。' }
              : {}),
          }
        })
      },
    }),
  ]
}
