// agent 工具：10 个 kanban_* 工具，让 DSH Agent 把看板当作任务控制面。
// 每个工具返回 JSON 字符串（成功 {ok:true,...}，失败 {ok:false,error:{code,message}}）。
// 工具内部强制乐观锁（不需要 version），actor 统一记录为 DSH Agent。
import {
  APPROVAL_TONES, COLUMNS, COLUMN_OF_STATUS, COLUMN_LABELS, LIMITS, PRIORITIES, STATUSES,
  DomainError, cleanText, completeCard, countsFor, createCard, findCard, linkSession, moveCard,
  normalizeStatus, patchCard, pushActivity, requestApproval, requireCard, touchCard, touchMeta,
} from './domain.js'

export const TOOL_NAMES = [
  'kanban_boards', 'kanban_cards', 'kanban_card', 'kanban_create_card', 'kanban_update_card',
  'kanban_move_card', 'kanban_add_activity', 'kanban_request_approval', 'kanban_link_session',
  'kanban_complete_card',
]

const ACTIVITY_INPUT_TYPES = ['progress', 'comment', 'checklist', 'artifact', 'result', 'error', 'ack']

const failure = (code, message) => JSON.stringify({ ok: false, error: { code, message } })
const success = value => JSON.stringify({ ok: true, ...value })

function toolFailure(error) {
  if (error instanceof DomainError) return failure(error.code, error.message)
  const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'INTERNAL'
  const message = code === 'INTERNAL' ? '看板操作未完成，请稍后重试' : (error?.message || '看板操作未完成')
  return failure(code, message)
}

function agentActor(exec) {
  const id = exec?.agent?.id
  return { kind: 'agent', name: 'DSH Agent', ...(typeof id === 'string' && id ? { id } : {}) }
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

/** 统一的写路径：store 串行队列 + 每次工具写操作给卡片 toolCalls +1。 */
async function mutate(store, exec, work) {
  assertLive(exec)
  const actor = agentActor(exec)
  const now = Date.now()
  const { result, revision } = await store.update(draft => {
    const output = work(draft, { actor, now })
    if (output?.card) bumpToolCall(output.card, output.metadataDelta)
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
    sessionIds: card.sessionIds,
    progress: card.progress,
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
  if (card.status === 'done') return '卡片已完成；如还有后续任务，建议新建一张卡片。'
  return '执行中可用 kanban_update_card 更新 currentAction/progress，关键节点用 kanban_add_activity 记录。'
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
      },
      required: ['label'],
    },
  ],
}
const approvalOptionsSchema = {
  type: 'array', minItems: 1, maxItems: LIMITS.approvalOptions, items: approvalOptionSchema,
  description: '1-8 个选项；字符串会自动生成 id，危险操作建议 tone:"danger"（选择即视为拒绝）',
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

export function createTools({ store } = {}) {
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
              const haystack = [card.title, card.summary, card.currentAction, card.project, ...(card.labels || [])].join('\n').toLowerCase()
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
          return {
            card,
            activities,
            pendingApproval: pending || null,
            questions: pending?.questions ?? [],
            revision: data.meta.revision,
            hint: hintFor(card),
          }
        })
      },
    }),

    defineTool({
      name: 'kanban_create_card',
      description: '创建一张新卡片，把需要多步执行、需要用户决策或产出可验收的任务放上看板。默认落在「待办」列；开始执行后用 kanban_move_card 移到 running。创建成功后记住返回的 card.id 用于后续更新。',
      properties: {
        boardId: boardIdProperty,
        title: { type: 'string', maxLength: LIMITS.title, description: '卡片标题（必填，会截断到 120 字）' },
        summary: { type: 'string', maxLength: LIMITS.summary, description: '一句话摘要：要做什么、验收标准是什么' },
        status: { type: 'string', enum: STATUSES, default: 'backlog', description: '初始状态，默认 backlog' },
        priority: { type: 'string', enum: PRIORITIES, default: 'none', description: '优先级' },
        labels: { type: 'array', items: { type: 'string', maxLength: LIMITS.label }, maxItems: LIMITS.labels, description: '标签，最多 12 个' },
        project: { type: 'string', maxLength: 120, description: '项目名（展示用），如 dsh-kanban' },
        workspaceId: { type: 'string', maxLength: 160, description: 'DSH workspace id（可选）' },
        cwd: { type: 'string', maxLength: 1000, description: '执行目录绝对路径（创建会话时用）' },
        sessionId: { type: 'string', maxLength: LIMITS.sessionId, description: '绑定为主会话的 DSH 会话 ID' },
      },
      required: ['title'],
      execute(args, exec) {
        return execute(exec, async () => {
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => createCard(draft, args, { actor, now }))
          return { card: result.card, revision, hint: '下一步建议：kanban_move_card 移到 running，再用 kanban_update_card 写 currentAction。' }
        })
      },
    }),

    defineTool({
      name: 'kanban_update_card',
      description: '更新卡片的字段：标题、摘要、当前动作、结果、状态、优先级、标签、项目、执行目录、agent、进度、checklist、产物和统计。执行中定期更新 currentAction/progress，让用户知道你在做什么；卡片状态变化会写入时间线。',
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
        agent: { type: 'object', properties: { name: { type: 'string', maxLength: 80 }, id: { type: 'string', maxLength: 160 } }, required: ['name'], additionalProperties: false },
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
      },
      required: ['cardId'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          const changes = {}
          for (const key of ['title', 'summary', 'currentAction', 'result', 'status', 'priority', 'labels', 'project', 'workspaceId', 'cwd', 'agent', 'progress', 'checklists', 'artifacts', 'metadata']) {
            if (args[key] !== undefined) changes[key] = args[key]
          }
          if (!Object.keys(changes).length) throw new DomainError('BAD_REQUEST', '没有可更新的字段')
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => patchCard(draft, args.cardId, changes, { actor, now }))
          return { card: result.card, revision, hint: hintFor(result.card) }
        })
      },
    }),

    defineTool({
      name: 'kanban_move_card',
      description: '把卡片移动到指定列（backlog/running/needs_you/done）或指定状态，并写入一条时间线。开始执行时移到 running；需要用户决策时改用 kanban_request_approval（会自动移到待你确认）。可传原因 text。',
      properties: {
        cardId: cardIdProperty,
        column: { type: 'string', enum: COLUMNS, description: '目标列：backlog 待办 / running 进行中 / needs_you 待你确认 / done 已完成' },
        status: { type: 'string', enum: STATUSES, description: '也可以直接指定状态；与 column 二选一，column 优先' },
        text: { type: 'string', maxLength: 200, description: '移动原因，会写进时间线' },
      },
      required: ['cardId'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          if (args.column === undefined && args.status === undefined) throw new DomainError('BAD_REQUEST', '需要提供 column 或 status')
          if (args.status !== undefined) normalizeStatus(args.status)
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => moveCard(draft, args.cardId, {
            column: args.column, status: args.status, text: args.text, actor, now,
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
          const { result, revision } = await mutate(store, exec, (draft, { actor, now }) => {
            const card = requireCard(draft, args.cardId)
            const activity = pushActivity(draft, card, { type, actor, text, data: args.data, at: now })
            touchCard(card, now)
            touchMeta(draft, actor, now)
            return { card, activity, metadataDelta: counters }
          })
          return { card: cardBrief(result.card), activity: result.activity, revision }
        })
      },
    }),

    defineTool({
      name: 'kanban_request_approval',
      description: '当任务需要用户做决定时，向看板请求审批：卡片自动进入「待你确认」列。两种形态二选一：单题传 title+options（需要多选时 multiSelect:true）；多题（最多 6 题，每题独立单选/多选）传 questions[]，title 由服务端从第一题生成。绝不要替用户做决定或伪造批准；请求后等待用户逐题处理。',
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
              ? `已请求用户逐题确认（${questionCount} 题），卡片在「待你确认」列。不要自行替用户作答，等用户处理。`
              : '已请求用户确认，卡片在「待你确认」列。不要自行替用户批准，等用户处理后再继续。',
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
          }))
          return { card: result.card, revision }
        })
      },
    }),

    defineTool({
      name: 'kanban_complete_card',
      description: '把卡片标记为完成并写入结果（进入「已完成」列）。result 要写清交付物与验收结论，用户会在已完成卡片和详情里看到。还有后续工作请新建卡片，不要复用已完成的卡片。',
      properties: {
        cardId: cardIdProperty,
        result: { type: 'string', maxLength: LIMITS.result, description: '完成结果：做了什么、产出在哪、如何验收（必填）' },
      },
      required: ['cardId', 'result'],
      execute(args, exec) {
        return execute(exec, async () => {
          assertCardId(args.cardId)
          const result = cleanText(args.result, LIMITS.result)
          if (!result) throw new DomainError('BAD_REQUEST', 'result 不能为空')
          const { result: outcome, revision } = await mutate(store, exec, (draft, { actor, now }) => completeCard(draft, args.cardId, { result, actor, now }))
          return { card: outcome.card, revision, hint: '卡片已完成。若用户还要继续，请新建卡片而不是复用已完成的卡。' }
        })
      },
    }),
  ]
}
