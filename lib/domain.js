// dsh-kanban 领域模型：状态/列映射、规范化、卡片变更原语、种子数据。
// 本模块不碰文件系统与 HTTP，路由层和 agent 工具共用这里的写操作，
// 保证 REST 与工具对同一状态迁移只有一份语义。
import { randomBytes } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const DEFAULT_BOARD_ID = 'board-default'

export const STATUSES = ['backlog', 'running', 'needs_you', 'blocked', 'failed', 'done', 'canceled']
export const COLUMNS = ['backlog', 'running', 'needs_you', 'done']

/**
 * 终态状态（完成/取消）。终态卡片已收口，不再「占用」工作副本（v0.21.0 #15），
 * 与 web/src/lib/sessionArchive.ts 的 isTerminalCardStatus 语义一致。
 */
const TERMINAL_STATUSES = new Set(['done', 'canceled'])

/** 卡片状态是否为终态（done / canceled）。工作副本清理的占用判定与会话归档判定共用。 */
export function isTerminalCardStatus(status) {
  return TERMINAL_STATUSES.has(status)
}

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent']
export const ARTIFACT_KINDS = ['file', 'link', 'report', 'commit', 'image']
export const APPROVAL_TONES = ['primary', 'danger', 'ghost']
/** 审批选项声明的提交去向列（不含 needs_you：留下继续等用户不应由选项声明）。 */
export const APPROVAL_OUTCOMES = ['running', 'backlog', 'done']
export const ACTIVITY_TYPES = [
  'created', 'status', 'progress', 'comment', 'approval_requested', 'approval_resolved',
  'session_linked', 'session_primary', 'session_archived', 'session_unarchived', 'checklist', 'artifact', 'result', 'error', 'ack', 'archived', 'unarchived', 'handoff',
]

/** 唯一权威的状态→列映射（契约 §2）。 */
export const COLUMN_OF_STATUS = {
  backlog: 'backlog',
  running: 'running',
  needs_you: 'needs_you',
  blocked: 'needs_you',
  failed: 'needs_you',
  done: 'done',
  canceled: 'done',
}

/** 用户拖拽到某列时写入的代表 status（契约 §2）。 */
export const STATUS_OF_COLUMN = { backlog: 'backlog', running: 'running', needs_you: 'needs_you', done: 'done' }

export const COLUMN_LABELS = { backlog: '待办', running: '进行中', needs_you: '待你确认', done: '已完成' }
export const STATUS_LABELS = {
  backlog: '待办', running: '进行中', needs_you: '待你确认', blocked: '受阻',
  failed: '失败', done: '已完成', canceled: '已取消',
}

/** 长度与数量上限，全部来自数据模型契约。 */
export const LIMITS = {
  boardName: 120, boardDescription: 600,
  title: 120, summary: 600, currentAction: 160, result: 600,
  labels: 12, label: 24,
  sessionId: 160, sessionIds: 8,
  progressText: 160,
  checklistText: 160, checklists: 50,
  artifactLabel: 120, artifactPath: 800, artifacts: 50,
  approvalTitle: 160, approvalDetail: 1200, approvalOption: 80, approvalOptions: 8, approvals: 20,
  approvalQuestion: 240, approvalQuestionHeader: 40, approvalQuestions: 6, approvalAnswers: 6,
  approvalAnswerCustom: 600,
  handoffSummary: 400, handoffNextSteps: 600, handoffSessionId: 160,
  activityText: 400, activitiesPerCard: 300,
  cards: 2000, batchCards: 200,
  /** 父子卡/依赖关系（v0.22.0）：单卡最多 8 张前置依赖，父卡链上溯深度上限 64。 */
  dependsOn: 8, parentChainDepth: 64,
  agentName: 80, agentId: 160,
  /** Transactional Outbox（v0.27.0）：最多保留最近 200 条指令，单条 prompt 上限 4000 字符。 */
  outbox: 200, outboxPrompt: 4000, outboxIdempotencyKey: 200,
}

export const OUTBOX_STATUSES = ['pending', 'leased', 'acked', 'failed', 'expired']
export const OUTBOX_KINDS = ['wake', 'nudge', 'retry', 'wait_resume', 'approval', 'start', 'restart_resume']

/** Watchdog 时间线节点 data.kind 常量（v0.27.0）。 */
export const WATCHDOG_NUDGE = 'watchdog_nudge'
export const WATCHDOG_STALLED = 'watchdog_stalled'
export const WATCHDOG_RETRY = 'watchdog_retry'
export const WATCHDOG_WAIT_READY = 'watchdog_wait_ready'

/** 可由 Watchdog 自动退避重试的瞬时错误码集合。 */
export const TRANSIENT_ERROR_CODES = new Set([
  'TRANSPORT', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'RATE_LIMIT', 'OVERLOADED',
  'SERVER', 'STREAM_CLOSED', 'INTERRUPTED', '502', '503', '504',
])

/** 判定会话 turn/end 的失败是否属于可自动退避重试的瞬时传输/限流错误。 */
export function isTransientTurnError(code, message) {
  const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : ''
  if (normalizedCode && TRANSIENT_ERROR_CODES.has(normalizedCode)) return true
  const text = typeof message === 'string' ? message.trim() : ''
  return /transport failed|ETIMEDOUT|ECONNRESET|rate limit|overloaded|service is too busy|stream ended before message_stop|进程在本轮结束前退出|temporarily unavailable|502|503|504/i.test(text)
}

export class DomainError extends Error {
  constructor(code, message, status = 400, extra) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.status = status
    if (extra !== undefined) this.extra = extra
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function nowMs() { return Date.now() }

/** trim + 去控制字符 + 截断（契约：超长截断而不是报错）。 */
export function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(CONTROL_CHARS, '').trim()
  return max > 0 ? text.slice(0, max) : text
}

export function requiredText(value, max, code, message) {
  if (typeof value !== 'string') throw new DomainError(code, message)
  const text = cleanText(value, max)
  if (!text) throw new DomainError(code, message)
  return text
}

export function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function integer(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = finiteNumber(value, NaN)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function isValidId(id) {
  return id === DEFAULT_BOARD_ID || typeof id === 'string' && /^(board|card|ap|ev|art|ck|q)-[a-f0-9]{6,8}$/.test(id)
}

/** 卡片 ID 判定（与 isValidId 的 card- 分支一致）；父子卡/dependsOn 关系字段只接受这种形态。 */
export function isCardId(value) {
  return typeof value === 'string' && /^card-[a-f0-9]{6,8}$/.test(value)
}

const hex = bytes => randomBytes(bytes).toString('hex')
export const newBoardId = () => 'board-' + hex(4)
export const newCardId = () => 'card-' + hex(4)
export const newApprovalId = () => 'ap-' + hex(4)
export const newActivityId = () => 'ev-' + hex(4)
export const newChecklistId = () => 'ck-' + hex(3)
export const newArtifactId = () => 'art-' + hex(3)
export const newQuestionId = () => 'q-' + hex(3)

// ---------------- 规范化 ----------------

export function normalizeActor(actor, fallbackKind = 'user') {
  if (!isObject(actor)) return defaultActor(fallbackKind)
  const kind = ['user', 'agent', 'system'].includes(actor.kind) ? actor.kind : fallbackKind
  const fallbackName = kind === 'agent' ? 'DSH Agent' : kind === 'system' ? 'system' : '你'
  const name = cleanText(actor.name, LIMITS.agentName) || fallbackName
  const id = cleanText(actor.id, LIMITS.agentId)
  return { kind, name, ...(id ? { id } : {}) }
}

export function defaultActor(kind = 'user') {
  if (kind === 'agent') return { kind, name: 'DSH Agent' }
  if (kind === 'system') return { kind, name: 'system' }
  return { kind: 'user', name: '你' }
}

export function normalizeStatus(status, fallback) {
  if (status === undefined && fallback !== undefined) return fallback
  if (!STATUSES.includes(status)) throw new DomainError('BAD_REQUEST', `未知状态：${String(status)}`)
  return status
}

export function normalizePriority(priority, fallback = 'none') {
  if (priority === undefined) return fallback
  if (!PRIORITIES.includes(priority)) throw new DomainError('BAD_REQUEST', `未知优先级：${String(priority)}`)
  return priority
}

export function normalizeLabels(labels) {
  if (labels === undefined || labels === null) return []
  if (!Array.isArray(labels)) throw new DomainError('BAD_REQUEST', 'labels 必须是字符串数组')
  const out = []
  for (const label of labels) {
    if (typeof label !== 'string') continue
    const text = cleanText(label, LIMITS.label)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= LIMITS.labels) break
  }
  return out
}

export function normalizeAgent(agent) {
  if (agent === undefined || agent === null) return undefined
  if (typeof agent === 'string') return { name: cleanText(agent, LIMITS.agentName) || 'DSH Agent' }
  if (!isObject(agent)) return undefined
  const name = cleanText(agent.name, LIMITS.agentName) || 'DSH Agent'
  const id = cleanText(agent.id, LIMITS.agentId)
  const harness = cleanText(agent.harness, 64)
  return { name, ...(id ? { id } : {}), ...(harness ? { harness } : {}) }
}

export function normalizeProgress(progress) {
  if (progress === undefined || progress === null) return undefined
  if (!isObject(progress)) throw new DomainError('BAD_REQUEST', 'progress 必须是对象')
  const step = integer(progress.step, 0, 0)
  const total = progress.total === undefined ? undefined : integer(progress.total, 1, 0)
  let percent = progress.percent === undefined ? undefined : integer(progress.percent, 0, 0, 100)
  if (percent === undefined && total && total > 0) percent = Math.min(100, Math.round(step / total * 100))
  const text = cleanText(progress.text, LIMITS.progressText)
  return { step, ...(total !== undefined ? { total } : {}), ...(percent !== undefined ? { percent } : {}), ...(text ? { text } : {}) }
}

export function normalizeChecklists(items) {
  if (items === undefined || items === null) return []
  if (!Array.isArray(items)) throw new DomainError('BAD_REQUEST', 'checklists 必须是数组')
  const out = []
  for (const item of items.slice(0, LIMITS.checklists)) {
    if (!isObject(item)) continue
    const text = cleanText(item.text, LIMITS.checklistText)
    if (!text) continue
    const id = isValidId(item.id) && item.id.startsWith('ck-') ? item.id : newChecklistId()
    out.push({ id, text, done: item.done === true })
  }
  return out
}

export function normalizeUrl(url) {
  const text = cleanText(url, 2000)
  if (!text) return undefined
  if (text.startsWith('/') && !text.startsWith('//')) return text
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch { return undefined }
}

export function normalizeArtifacts(items) {
  if (items === undefined || items === null) return []
  if (!Array.isArray(items)) throw new DomainError('BAD_REQUEST', 'artifacts 必须是数组')
  const out = []
  for (const item of items.slice(0, LIMITS.artifacts)) {
    if (!isObject(item)) continue
    const label = cleanText(item.label, LIMITS.artifactLabel)
    if (!label) continue
    const kind = ARTIFACT_KINDS.includes(item.kind) ? item.kind : 'link'
    const url = normalizeUrl(item.url)
    const path = cleanText(item.path, LIMITS.artifactPath)
    const id = isValidId(item.id) && item.id.startsWith('art-') ? item.id : newArtifactId()
    out.push({ id, kind, label, ...(url ? { url } : {}), ...(path ? { path } : {}) })
  }
  return out
}

/** 交接摘要：summary 必填 ≤400；nextSteps ≤600；sessionId ≤160；at/by 由服务端写。 */
export function normalizeHandoff(raw, { now = nowMs(), actor, at, strict = true } = {}) {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) {
    if (strict) throw new DomainError('BAD_REQUEST', 'handoff 必须是对象或 null')
    return null
  }
  const summary = cleanText(raw.summary, LIMITS.handoffSummary)
  if (!summary) {
    if (strict) throw new DomainError('BAD_REQUEST', 'handoff.summary 不能为空')
    return null
  }
  const nextSteps = cleanText(raw.nextSteps, LIMITS.handoffNextSteps)
  const sessionId = cleanText(raw.sessionId, LIMITS.handoffSessionId)
  return {
    summary,
    ...(nextSteps ? { nextSteps } : {}),
    ...(sessionId ? { sessionId } : {}),
    at: integer(at !== undefined ? at : raw.at, now, 0),
    // 写入路径传入 actor/at 时以服务端为准；读取旧数据时才回落到存储值。
    by: normalizeActor(actor !== undefined ? actor : raw.by, 'system'),
  }
}

export function normalizeMetadata(metadata) {
  const base = { toolCalls: 0, searches: 0 }
  if (!isObject(metadata)) return base
  for (const key of ['toolCalls', 'searches', 'elapsedMs', 'tokensIn', 'tokensOut']) {
    if (metadata[key] !== undefined) base[key] = integer(metadata[key], 0, 0)
  }
  return base
}

/**
 * 卡片运行时状态（v0.27.0 Super-Agent Runtime）：
 * - generation：状态代数（fencing token），离开/重入进行中或切换主会话时自增，隔离旧异步回调；
 * - budget：当前代内的自动动作预算（nudgesUsed ≤ 1, retriesUsed ≤ 2）；
 * - turnWatermark：主会话最近一轮的进度水位；
 * - waitCondition：结构化等待条件（如 { kind: 'time', notBefore, reason }）。
 */
export function normalizeCardRuntime(raw) {
  const src = isObject(raw) ? raw : {}
  const generation = Math.max(1, integer(src.generation, 1, 1))
  const budgetSrc = isObject(src.budget) ? src.budget : {}
  const budget = {
    nudgesUsed: integer(budgetSrc.nudgesUsed, 0, 0),
    retriesUsed: integer(budgetSrc.retriesUsed, 0, 0),
    lastAutoActionAt: integer(budgetSrc.lastAutoActionAt, 0, 0),
  }
  const wmSrc = isObject(src.turnWatermark) ? src.turnWatermark : null
  const wmSession = wmSrc ? cleanText(wmSrc.sessionId, LIMITS.sessionId) : ''
  const turnWatermark = wmSrc && wmSession
    ? {
        sessionId: wmSession,
        turn: integer(wmSrc.turn, 0, 0),
        phase: ['running', 'idle', 'error'].includes(wmSrc.phase) ? wmSrc.phase : 'idle',
        at: integer(wmSrc.at, 0, 0),
        ...(cleanText(wmSrc.code, 64) ? { code: cleanText(wmSrc.code, 64) } : {}),
        ...(wmSrc.lastHandledTurn !== undefined ? { lastHandledTurn: integer(wmSrc.lastHandledTurn, 0, 0) } : {}),
        ...(wmSrc.lastRetryTurn !== undefined ? { lastRetryTurn: integer(wmSrc.lastRetryTurn, 0, 0) } : {}),
        ...(wmSrc.lastRetryExhaustedTurn !== undefined ? { lastRetryExhaustedTurn: integer(wmSrc.lastRetryExhaustedTurn, 0, 0) } : {}),
        ...(wmSrc.lastMeteredTurn !== undefined ? { lastMeteredTurn: integer(wmSrc.lastMeteredTurn, 0, 0) } : {}),
      }
    : undefined
  const wcSrc = isObject(src.waitCondition) ? src.waitCondition : null
  const waitCondition = wcSrc && ['time', 'session_idle'].includes(wcSrc.kind)
    ? {
        kind: wcSrc.kind,
        ...(wcSrc.notBefore !== undefined ? { notBefore: integer(wcSrc.notBefore, 0, 0) } : {}),
        ...(cleanText(wcSrc.targetSessionId, LIMITS.sessionId) ? { targetSessionId: cleanText(wcSrc.targetSessionId, LIMITS.sessionId) } : {}),
        ...(cleanText(wcSrc.reason, 200) ? { reason: cleanText(wcSrc.reason, 200) } : {}),
      }
    : undefined
  return {
    generation,
    budget,
    ...(turnWatermark ? { turnWatermark } : {}),
    ...(waitCondition ? { waitCondition } : {}),
    ...(src.priorityWake === 'person' ? { priorityWake: 'person' } : {}),
  }
}

export function ensureCardRuntime(card) {
  card.runtime = normalizeCardRuntime(card.runtime)
  return card.runtime
}

/** 推进卡片运行时 generation 并重置自动动作预算（用于状态跨越与主会话切换）。 */
export function bumpCardGeneration(card, { resetBudget = true, clearWatermark = true } = {}) {
  const runtime = ensureCardRuntime(card)
  runtime.generation += 1
  if (resetBudget) {
    runtime.budget = { nudgesUsed: 0, retriesUsed: 0, lastAutoActionAt: 0 }
  }
  if (clearWatermark) {
    delete runtime.turnWatermark
  }
  return runtime
}

function normalizeSessionIds(ids) {
  if (!Array.isArray(ids)) return []
  const out = []
  for (const id of ids) {
    const text = cleanText(id, LIMITS.sessionId)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= LIMITS.sessionIds) break
  }
  return out
}

/** dependsOn 防御性规范化：只留合法卡片 ID、去重、去掉自引用、最多 LIMITS.dependsOn 张。 */
export function normalizeDependsOn(values, { exclude } = {}) {
  if (!Array.isArray(values)) return []
  const out = []
  for (const value of values) {
    if (!isCardId(value) || value === exclude || out.includes(value)) continue
    out.push(value)
    if (out.length >= LIMITS.dependsOn) break
  }
  return out
}

export function emptyCardOrder() {
  return { backlog: [], running: [], needs_you: [], done: [] }
}

export function newBoard({ id = newBoardId(), name = '未命名看板', description = '', now = nowMs() } = {}) {
  return {
    id, name: cleanText(name, LIMITS.boardName) || '未命名看板',
    ...(cleanText(description, LIMITS.boardDescription) ? { description: cleanText(description, LIMITS.boardDescription) } : {}),
    cardOrder: emptyCardOrder(), createdAt: now, updatedAt: now,
  }
}

export function normalizeBoard(raw, fallbackNow = nowMs()) {
  const board = isObject(raw) ? raw : {}
  const id = board.id === DEFAULT_BOARD_ID || isValidId(board.id) ? board.id : newBoardId()
  const order = emptyCardOrder()
  if (isObject(board.cardOrder)) {
    for (const column of COLUMNS) {
      const ids = Array.isArray(board.cardOrder[column]) ? board.cardOrder[column] : []
      order[column] = [...new Set(ids.filter(value => typeof value === 'string'))]
    }
  }
  return {
    id,
    name: cleanText(board.name, LIMITS.boardName) || '未命名看板',
    ...(cleanText(board.description, LIMITS.boardDescription) ? { description: cleanText(board.description, LIMITS.boardDescription) } : {}),
    cardOrder: order,
    createdAt: integer(board.createdAt, fallbackNow, 0),
    updatedAt: integer(board.updatedAt, fallbackNow, 0),
  }
}

export function normalizeCard(raw, { boardId, now = nowMs() } = {}) {
  const card = isObject(raw) ? raw : {}
  const handoff = normalizeHandoff(card.handoff, { now, strict: false })
  const status = STATUSES.includes(card.status) ? card.status : 'backlog'
  const resolvedBoardId = isValidId(card.boardId) && card.boardId.startsWith('board-') ? card.boardId : boardId || DEFAULT_BOARD_ID
  const createdAt = integer(card.createdAt, now, 0)
  // 关系字段防御性校验（v0.22.0）：非法 ID / 自引用直接丢弃，不因此判整份存储损坏。
  const id = isCardId(card.id) ? card.id : newCardId()
  const parentCardId = isCardId(card.parentCardId) && card.parentCardId !== id ? card.parentCardId : undefined
  const mergedInto = isCardId(card.mergedInto) && card.mergedInto !== id ? card.mergedInto : undefined
  return {
    id,
    boardId: resolvedBoardId,
    title: cleanText(card.title, LIMITS.title) || '未命名卡片',
    summary: cleanText(card.summary, LIMITS.summary),
    ...(cleanText(card.currentAction, LIMITS.currentAction) ? { currentAction: cleanText(card.currentAction, LIMITS.currentAction) } : {}),
    ...(cleanText(card.result, LIMITS.result) ? { result: cleanText(card.result, LIMITS.result) } : {}),
    status,
    priority: PRIORITIES.includes(card.priority) ? card.priority : 'none',
    labels: normalizeLabels(Array.isArray(card.labels) ? card.labels : []),
    ...(cleanText(card.project, LIMITS.boardName) ? { project: cleanText(card.project, LIMITS.boardName) } : {}),
    ...(cleanText(card.workspaceId, LIMITS.sessionId) ? { workspaceId: cleanText(card.workspaceId, LIMITS.sessionId) } : {}),
    ...(cleanText(card.cwd, 1000) ? { cwd: cleanText(card.cwd, 1000) } : {}),
    ...(cleanText(card.externalRef, 200) ? { externalRef: cleanText(card.externalRef, 200) } : {}),
    ...(cleanText(card.externalThreadId, 200) ? { externalThreadId: cleanText(card.externalThreadId, 200) } : {}),
    sessionIds: normalizeSessionIds(card.sessionIds),
    dependsOn: normalizeDependsOn(card.dependsOn, { exclude: id }),
    ...(parentCardId ? { parentCardId } : {}),
    ...(mergedInto ? { mergedInto } : {}),
    ...(normalizeAgent(card.agent) ? { agent: normalizeAgent(card.agent) } : {}),
    ...(card.progress !== undefined ? (() => { const p = normalizeProgress(card.progress); return p ? { progress: p } : {} })() : {}),
    checklists: normalizeChecklists(Array.isArray(card.checklists) ? card.checklists : []),
    approvals: (Array.isArray(card.approvals) ? card.approvals : []).map(normalizeStoredApproval).filter(Boolean).slice(-LIMITS.approvals),
    artifacts: normalizeArtifacts(Array.isArray(card.artifacts) ? card.artifacts : []),
    ...(handoff ? { handoff } : {}),
    ...(card.autoStart === true ? { autoStart: true } : {}),
    ...(isObject(card.runtime) ? { runtime: normalizeCardRuntime(card.runtime) } : {}),
    metadata: normalizeMetadata(card.metadata),
    order: integer(card.order, 0, 0),
    version: Math.max(1, integer(card.version, 1, 1)),
    ...(card.archived === true ? { archived: true } : {}),
    ...(card.archivedAt !== undefined ? { archivedAt: integer(card.archivedAt, createdAt, 0) } : {}),
    createdAt,
    updatedAt: integer(card.updatedAt, createdAt, 0),
    ...(card.startedAt !== undefined ? { startedAt: integer(card.startedAt, createdAt, 0) } : {}),
    ...(card.completedAt !== undefined ? { completedAt: integer(card.completedAt, createdAt, 0) } : {}),
  }
}

/** 多题审批：title 摘要取第一题 header+question（契约：多题时 title 由服务端生成）。 */
function approvalTitleFromQuestion(question) {
  return cleanText(question.header ? `${question.header}：${question.question}` : question.question, LIMITS.approvalTitle)
}

function dedupeOptionIds(options) {
  const seen = new Set()
  for (const option of options) {
    while (seen.has(option.id)) option.id = option.id + '-' + (seen.size + 1)
    seen.add(option.id)
  }
  return options
}

/** 选项数组规范化；strict=false 用于读取旧数据（坏项丢弃而不是让整份存储判损坏）。 */
function normalizeOptions(rawOptions, { strict = true, label = '审批' } = {}) {
  const list = Array.isArray(rawOptions) ? rawOptions : []
  if (strict && (list.length < 1 || list.length > LIMITS.approvalOptions)) {
    throw new DomainError('BAD_REQUEST', `${label}需要 1-${LIMITS.approvalOptions} 个选项`)
  }
  const options = list.map((option, index) => normalizeOption(option, index, strict)).filter(Boolean).slice(0, LIMITS.approvalOptions)
  if (strict && !options.length) throw new DomainError('BAD_REQUEST', `${label}选项无效`)
  return dedupeOptionIds(options)
}

/** 单题结构；strict=false 时非法题返回 null（读取旧数据不因此判整份存储损坏）。 */
function normalizeApprovalQuestion(raw, index, { strict = true } = {}) {
  const data = isObject(raw) ? raw : {}
  const question = cleanText(data.question, LIMITS.approvalQuestion)
  if (!question) {
    if (strict) throw new DomainError('BAD_REQUEST', `第 ${index + 1} 题缺少题目`)
    return null
  }
  const options = normalizeOptions(data.options, { strict, label: `第 ${index + 1} 题` })
  if (!options.length) return null
  const header = cleanText(data.header, LIMITS.approvalQuestionHeader)
  return {
    id: typeof data.id === 'string' && /^q-[a-f0-9]{6,8}$/.test(data.id) ? data.id : newQuestionId(),
    ...(header ? { header } : {}),
    question,
    multiSelect: data.multiSelect === true,
    options,
  }
}

function normalizeStoredApproval(raw) {
  if (!isObject(raw)) return null
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .map((question, index) => normalizeApprovalQuestion(question, index, { strict: false }))
    .filter(Boolean)
    .slice(0, LIMITS.approvalQuestions)
  const firstQuestion = questions[0]
  const options = normalizeOptions(raw.options, { strict: false })
  // 多题审批的兼容字段 options 取第一题选项；title 缺省时由第一题摘要兜底。
  const legacyOptions = options.length ? options : firstQuestion ? firstQuestion.options : []
  if (!legacyOptions.length) return null
  const title = cleanText(raw.title, LIMITS.approvalTitle) || (firstQuestion ? approvalTitleFromQuestion(firstQuestion) : '')
  if (!title) return null
  return {
    id: isValidId(raw.id) && raw.id.startsWith('ap-') ? raw.id : newApprovalId(),
    title,
    detail: cleanText(raw.detail, LIMITS.approvalDetail),
    multiSelect: raw.multiSelect === true || (firstQuestion ? firstQuestion.multiSelect === true : false),
    options: legacyOptions,
    ...(questions.length ? { questions } : {}),
    status: ['pending', 'approved', 'rejected', 'dismissed'].includes(raw.status) ? raw.status : 'pending',
    requestedBy: normalizeActor(raw.requestedBy, 'agent'),
    requestedAt: integer(raw.requestedAt, nowMs(), 0),
    ...(raw.resolvedBy ? { resolvedBy: normalizeActor(raw.resolvedBy) } : {}),
    ...(raw.resolvedAt !== undefined ? { resolvedAt: integer(raw.resolvedAt, 0, 0) } : {}),
    ...(isObject(raw.resolution) ? { resolution: normalizeResolution(raw.resolution, legacyOptions, questions) } : {}),
    ...(cleanText(raw.sessionId, LIMITS.sessionId) ? { sessionId: cleanText(raw.sessionId, LIMITS.sessionId) } : {}),
  }
}

// resolution 读取兼容：v0.4 {optionIds, labels, answers[{questionId, optionIds, labels, custom?}], comment}；
// v0.3 同构但无 custom；v0.2 {optionIds, labels} 或 {optionId, label}。
export function normalizeResolution(raw, options = [], questions = []) {
  const answers = (Array.isArray(raw.answers) ? raw.answers : []).map(answer => {
    if (!isObject(answer)) return null
    const questionId = cleanText(answer.questionId, 40)
    if (!questionId) return null
    const question = questions.find(item => item.id === questionId)
    const sourceOptions = question ? question.options : options
    const optionIds = []
    for (const value of Array.isArray(answer.optionIds) ? answer.optionIds : []) {
      const id = cleanText(value, 40)
      if (id && !optionIds.includes(id)) optionIds.push(id)
    }
    const labels = optionIds.map((id, index) => {
      const matched = sourceOptions.find(option => option.id === id)
      if (matched) return matched.label
      return Array.isArray(answer.labels) && typeof answer.labels[index] === 'string'
        ? cleanText(answer.labels[index], LIMITS.approvalOption) : ''
    })
    const custom = cleanText(answer.custom, LIMITS.approvalAnswerCustom)
    return { questionId, optionIds, labels, ...(custom ? { custom } : {}) }
  }).filter(Boolean).slice(0, LIMITS.approvalAnswers)

  const rawIds = Array.isArray(raw.optionIds) ? raw.optionIds : raw.optionId !== undefined ? [raw.optionId] : []
  const optionIds = []
  for (const value of rawIds) {
    const id = cleanText(value, 40)
    if (id && !optionIds.includes(id)) optionIds.push(id)
  }
  // 拍平字段缺失时从逐题答案派生（多题新数据总会有 options，这里只做兜底）。
  const flattened = optionIds.length ? optionIds : [...new Set(answers.flatMap(answer => answer.optionIds))]
  const allOptions = [...options, ...questions.flatMap(question => question.options)]
  const labels = flattened.map((id, index) => {
    const matched = allOptions.find(option => option.id === id)
    if (matched) return matched.label
    if (Array.isArray(raw.labels) && typeof raw.labels[index] === 'string') return cleanText(raw.labels[index], LIMITS.approvalOption)
    if (flattened.length === 1 && typeof raw.label === 'string') return cleanText(raw.label, LIMITS.approvalOption)
    for (const answer of answers) {
      const answerIndex = answer.optionIds.indexOf(id)
      if (answerIndex >= 0 && answer.labels[answerIndex]) return answer.labels[answerIndex]
    }
    return ''
  })
  const comment = cleanText(raw.comment, 800)
  return { optionIds: flattened, labels, ...(answers.length ? { answers } : {}), ...(comment ? { comment } : {}) }
}

/** 选项声明的提交去向：running/backlog/done；不填＝批准回进行中、驳回回待办。 */
function normalizeOptionOutcome(raw, { label, strict }) {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'string' && APPROVAL_OUTCOMES.includes(raw)) return raw
  if (strict) {
    throw new DomainError('BAD_REQUEST', `选项「${label}」的 outcome 不合法，只能是 ${APPROVAL_OUTCOMES.join(' / ')}`)
  }
  return undefined
}

function normalizeOption(raw, index, strict = true) {
  if (typeof raw === 'string') {
    const label = cleanText(raw, LIMITS.approvalOption)
    return label ? { id: 'option-' + (index + 1), label } : null
  }
  if (!isObject(raw)) return null
  const label = cleanText(raw.label, LIMITS.approvalOption)
  if (!label) return null
  const id = cleanText(raw.id, 40) || 'option-' + (index + 1)
  const description = cleanText(raw.description, 300)
  const outcome = normalizeOptionOutcome(raw.outcome, { label, strict })
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(APPROVAL_TONES.includes(raw.tone) ? { tone: raw.tone } : {}),
    ...(outcome ? { outcome } : {}),
  }
}

/** 加载/迁移时校验并修复整份存储；结构不可修复时抛 STORE_DATA_INVALID。 */
export function normalizeStore(raw, fallbackNow = nowMs()) {
  if (!isObject(raw)) throw new DomainError('STORE_DATA_INVALID', '数据文件不是有效对象', 500)
  if (!Array.isArray(raw.boards)) throw new DomainError('STORE_DATA_INVALID', '数据文件缺少 boards', 500)
  const boards = raw.boards.filter(isObject).map(board => normalizeBoard(board, fallbackNow))
  if (!boards.length) boards.push(newBoard({ id: DEFAULT_BOARD_ID, name: 'DSH 看板', now: fallbackNow }))
  const boardIds = new Set(boards.map(board => board.id))
  const cards = (Array.isArray(raw.cards) ? raw.cards : [])
    .filter(isObject)
    .map(card => normalizeCard(card, { now: fallbackNow }))
    .filter(card => boardIds.has(card.boardId))
  const cardIds = new Set(cards.map(card => card.id))
  const activities = (Array.isArray(raw.activities) ? raw.activities : [])
    .filter(item => isObject(item) && cardIds.has(item.cardId) && typeof item.text === 'string')
    .map(item => ({
      id: isValidId(item.id) ? item.id : newActivityId(),
      cardId: item.cardId,
      type: ACTIVITY_TYPES.includes(item.type) ? item.type : 'progress',
      actor: normalizeActor(item.actor),
      text: cleanText(item.text, LIMITS.activityText),
      at: integer(item.at, fallbackNow, 0),
      ...(isObject(item.data) ? { data: item.data } : {}),
    }))
    .sort((a, b) => a.at - b.at)
  const meta = isObject(raw.meta) ? raw.meta : {}
  const lastActor = normalizeActor(meta.lastActor, 'system')
  const outbox = normalizeOutbox(raw.outbox, fallbackNow)
  return {
    schemaVersion: SCHEMA_VERSION,
    boards,
    cards,
    activities,
    ...(outbox.length ? { outbox } : {}),
    meta: {
      createdAt: integer(meta.createdAt, fallbackNow, 0),
      updatedAt: integer(meta.updatedAt, fallbackNow, 0),
      revision: Math.max(0, integer(meta.revision, 0, 0)),
      ...(meta.seededAt !== undefined ? { seededAt: integer(meta.seededAt, fallbackNow, 0) } : {}),
      ...(meta.outboxSeq !== undefined ? { outboxSeq: integer(meta.outboxSeq, 0, 0) } : {}),
      ...(cleanText(meta.superAgentSessionId, LIMITS.sessionId) ? { superAgentSessionId: cleanText(meta.superAgentSessionId, LIMITS.sessionId) } : {}),
      ...(typeof meta.autoAdvanceEnabled === 'boolean' ? { autoAdvanceEnabled: meta.autoAdvanceEnabled } : {}),
      lastActor,
    },
  }
}

/** 读取或注册常驻 Super-Agent 总台会话（受保护，禁止被自动/批量归档）。 */
export function getSuperAgentSessionId(draft) {
  return cleanText(draft?.meta?.superAgentSessionId, LIMITS.sessionId) || null
}

export function setSuperAgentSessionId(draft, sessionId, { actor = defaultActor('user'), now = nowMs() } = {}) {
  if (!isObject(draft.meta)) draft.meta = { createdAt: now, updatedAt: now, revision: 0, lastActor: actor }
  const cleaned = cleanText(sessionId, LIMITS.sessionId)
  if (!cleaned) {
    delete draft.meta.superAgentSessionId
  } else {
    draft.meta.superAgentSessionId = cleaned
  }
  touchMeta(draft, actor, now)
  return { sessionId: getSuperAgentSessionId(draft) }
}

/** 读取或设置看板全局「自动推进（Autopilot）」总开关（默认开启 true；暂停时保留各卡片自身的 autoStart 配置）。 */
export function getAutoAdvanceEnabled(draft) {
  return draft?.meta?.autoAdvanceEnabled !== false
}

export function setAutoAdvanceEnabled(draft, enabled, { actor = defaultActor('user'), now = nowMs() } = {}) {
  if (!isObject(draft.meta)) draft.meta = { createdAt: now, updatedAt: now, revision: 0, lastActor: actor }
  draft.meta.autoAdvanceEnabled = enabled !== false
  touchMeta(draft, actor, now)
  return { enabled: getAutoAdvanceEnabled(draft) }
}

// ---------------- 查询与排序 ----------------

export function cardsOfBoard(draft, boardId, { includeArchived = false } = {}) {
  return draft.cards.filter(card => card.boardId === boardId && (includeArchived || !card.archived))
}

export function countsFor(cardsOrDraft, boardId) {
  const list = Array.isArray(cardsOrDraft)
    ? cardsOrDraft
    : (Array.isArray(cardsOrDraft?.cards) ? cardsOrDraft.cards : [])
  const counts = { backlog: 0, running: 0, needs_you: 0, done: 0, total: 0 }
  for (const card of list) {
    if (!card || card.archived) continue
    if (boardId !== undefined && card.boardId !== boardId) continue
    const column = COLUMN_OF_STATUS[card.status] || 'backlog'
    counts[column] += 1
    counts.total += 1
  }
  return counts
}

/** 列内排序：cardOrder 优先，未入列的卡片按 updatedAt desc 兜底。 */
export function sortColumnCards(board, cards, column) {
  const byId = new Map(cards.filter(card => card.boardId === board.id && !card.archived).map(card => [card.id, card]))
  const ordered = []
  for (const id of board.cardOrder?.[column] || []) {
    const card = byId.get(id)
    if (card && COLUMN_OF_STATUS[card.status] === column) { ordered.push(card); byId.delete(id) }
  }
  const rest = [...byId.values()].filter(card => COLUMN_OF_STATUS[card.status] === column).sort((a, b) => b.updatedAt - a.updatedAt)
  return [...ordered, ...rest]
}

/** 按列展开后的卡片数组（供 /state 使用）。 */
export function orderedCards(board, cards) {
  return COLUMNS.flatMap(column => sortColumnCards(board, cards, column))
}

export function findBoard(draft, boardId) {
  return draft.boards.find(board => board.id === boardId)
}

export function requireBoard(draft, boardId) {
  const board = boardId === undefined || boardId === null ? draft.boards[0] : findBoard(draft, boardId)
  if (!board) throw new DomainError('BOARD_NOT_FOUND', '看板不存在', 404)
  return board
}

export function findCard(draft, cardId, { includeArchived = false } = {}) {
  return draft.cards.find(card => card.id === cardId && (includeArchived || !card.archived))
}

export function requireCard(draft, cardId, options) {
  const card = findCard(draft, cardId, options)
  if (!card) throw new DomainError('CARD_NOT_FOUND', '卡片不存在或已归档', 404)
  return card
}

/** 按 ID 找卡片（含已归档）：归档/恢复与关系回显需要读到已归档卡。 */
export function findCardAny(draft, cardId) {
  return (draft.cards || []).find(card => card.id === cardId)
}

/** 直接子卡：parentCardId 指向本卡且未归档的卡片（含已完成/取消）。 */
export function directChildren(draft, cardId) {
  return (draft.cards || []).filter(card => !card.archived && card.parentCardId === cardId)
}

/** 未收口的直接子卡：状态不在 done/canceled（完成拦截与归档守卫共用）。 */
export function openDirectChildren(draft, cardId) {
  return directChildren(draft, cardId).filter(card => !TERMINAL_STATUSES.has(card.status))
}

/** 关系错误 extra 用的卡片摘要。 */
export function relationCardBrief(card) {
  return { id: card.id, title: card.title, status: card.status }
}

/** 关系目标必须存在且未归档；否则 404。 */
function requireRelationTarget(draft, cardId, label) {
  const card = findCard(draft, cardId)
  if (!card) throw new DomainError('CARD_NOT_FOUND', `${label}不存在或已归档：${cardId}`, 404)
  return card
}

/** parentCardId 校验：目标存在未归档、父卡链不成环、上溯深度不超过 LIMITS.parentChainDepth。 */
function assertParentLink(draft, cardId, parentCardId) {
  let cursor = requireRelationTarget(draft, parentCardId, '父卡')
  let depth = 0
  while (cursor) {
    if (cardId && cursor.id === cardId) {
      throw new DomainError('CARD_RELATION_CYCLE', '父卡链成环：不能把卡片自己或自己的子孙设为父卡', 409, { parentCardId })
    }
    depth += 1
    if (depth > LIMITS.parentChainDepth) {
      throw new DomainError('CARD_RELATION_CYCLE', `父卡链超过 ${LIMITS.parentChainDepth} 层，疑似成环`, 409, { parentCardId })
    }
    cursor = cursor.parentCardId ? findCardAny(draft, cursor.parentCardId) : undefined
  }
  return parentCardId
}

/** dependsOn 入参格式校验（不校验存在性/环）：非法 ID / 超上限 → BAD_REQUEST。 */
function normalizeDependsOnInput(value) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new DomainError('BAD_REQUEST', 'dependsOn 必须是卡片 ID 数组')
  const out = []
  for (const item of value) {
    if (!isCardId(item)) throw new DomainError('BAD_REQUEST', 'dependsOn 里的每一项都必须是 card-xxxxxxxx 形式的卡片 ID')
    if (!out.includes(item)) out.push(item)
    if (out.length > LIMITS.dependsOn) throw new DomainError('BAD_REQUEST', `dependsOn 最多 ${LIMITS.dependsOn} 张前置卡`)
  }
  return out
}

/** dependsOn 校验：目标存在未归档、不自引用、依赖图不成环（DFS）。 */
function assertDependsLink(draft, cardId, dependsOn) {
  const byId = new Map((draft.cards || []).map(card => [card.id, card]))
  for (const depId of dependsOn) {
    const dep = byId.get(depId)
    if (!dep || dep.archived) throw new DomainError('CARD_NOT_FOUND', `依赖卡不存在或已归档：${depId}`, 404)
    if (cardId && depId === cardId) throw new DomainError('CARD_RELATION_CYCLE', '依赖不能指向卡片自己', 409, { dependsOn: [depId] })
    // 从依赖卡沿 dependsOn 上溯：能回到本卡说明这条新边会成环。
    const stack = [...(dep.dependsOn || [])]
    const seen = new Set()
    while (stack.length) {
      const currentId = stack.pop()
      if (cardId && currentId === cardId) throw new DomainError('CARD_RELATION_CYCLE', '依赖关系成环', 409, { dependsOn: [depId] })
      if (seen.has(currentId)) continue
      seen.add(currentId)
      if (seen.size > LIMITS.dependsOn * LIMITS.parentChainDepth) {
        throw new DomainError('CARD_RELATION_CYCLE', '依赖链过深，疑似成环', 409, { dependsOn: [depId] })
      }
      const node = byId.get(currentId)
      for (const next of node?.dependsOn || []) stack.push(next)
    }
  }
  return dependsOn
}

/** 返回卡片中尚未完成的检查项（done !== true）。 */
export function openChecklistItems(card) {
  return Array.isArray(card?.checklists) ? card.checklists.filter(item => item && item.done !== true) : []
}

/**
 * 完成拦截：
 * 1) 存在未收口直接子卡时默认抛 CARD_HAS_OPEN_CHILDREN(409)；
 * 2) strictChecklists=true 时，若存在未完成检查清单项（done !== true）默认抛 CARD_HAS_OPEN_CHECKLISTS(409)；
 * forceComplete=true 放行并返回未收口子卡/检查项（调用方必须补一条强制完成审计节点）。
 */
function completionGuard(draft, card, forceComplete, { strictChecklists = false, nextChecklists } = {}) {
  if (card.status === 'done') return []
  const openChildren = openDirectChildren(draft, card.id)
  if (openChildren.length && forceComplete !== true) {
    throw new DomainError('CARD_HAS_OPEN_CHILDREN', `还有 ${openChildren.length} 张未收口子卡，先收口或显式传 forceComplete 强完成`, 409, {
      openChildren: openChildren.map(relationCardBrief),
    })
  }
  if (strictChecklists) {
    const effectiveChecklists = nextChecklists !== undefined ? normalizeChecklists(nextChecklists) : card.checklists
    const openItems = openChecklistItems({ checklists: effectiveChecklists })
    if (openItems.length && forceComplete !== true) {
      const sample = openItems.slice(0, 3).map(item => item.text).join('、')
      throw new DomainError(
        'CARD_HAS_OPEN_CHECKLISTS',
        `还有 ${openItems.length} 项检查清单未完成（${sample}），请先完成并勾选 done:true，或将待排期项拆分为独立卡片后再完成；若确需带未完成项强行收口请传 force/forceComplete:true`,
        409,
        { openChecklists: openItems },
      )
    }
  }
  return openChildren
}

/** 强完成审计节点：文本固定含「强制完成，留下 N 张未收口子卡」或「强制完成，留下 N 项未完成检查项」。 */
function pushForceCompleteActivity(draft, card, openChildren, { actor, now, openChecklists = [] }) {
  const parts = []
  if (openChildren.length) parts.push(`留下 ${openChildren.length} 张未收口子卡`)
  if (openChecklists.length) parts.push(`留下 ${openChecklists.length} 项未完成检查项`)
  return pushActivity(draft, card, {
    type: 'progress',
    actor,
    text: `强制完成，${parts.join('，') || '跳过完成守卫'}`,
    data: {
      forceComplete: true,
      ...(openChildren.length ? { openChildren: openChildren.map(relationCardBrief) } : {}),
      ...(openChecklists.length ? { openChecklists: openChecklists.map(item => ({ id: item.id, text: item.text })) } : {}),
    },
    at: now,
  })
}

export function findApproval(card, approvalId) {
  return (card.approvals || []).find(approval => approval.id === approvalId)
}

export function pendingApproval(card) {
  return (card.approvals || []).find(approval => approval.status === 'pending')
}

// ---------------- 决策日志事件收集 ----------------
// domain 只负责把「正式审批」的请求 / 提交 / 未决关闭塞进 draft.__decisions；
// 真正的落盘（decisions.jsonl）由 store.js 在同一个 update 事务里完成（先日志后 data.json）。

/** 把一条决策事件挂到本次 update 的草稿上；store.js 会在写盘前取走并追加到 decisions.jsonl。 */
export function pushDecision(draft, entry) {
  if (!isObject(entry)) return null
  if (!Array.isArray(draft.__decisions)) draft.__decisions = []
  const event = { source: 'live', at: nowMs(), ...entry }
  draft.__decisions.push(event)
  return event
}

/** 取走本次 update 收集的决策事件（不写入 data.json）。 */
export function takePendingDecisions(draft) {
  if (!Array.isArray(draft.__decisions)) return []
  const events = draft.__decisions
  delete draft.__decisions
  return events
}

/** 决策事件里的卡片上下文快照（请求/提交时刻的原始信息）。 */
export function decisionCardContext(card) {
  return normalizeDecisionCardContext(card)
}

export function normalizeDecisionCardContext(raw) {
  const source = isObject(raw) ? raw : {}
  return {
    title: cleanText(source.title, LIMITS.title),
    summary: cleanText(source.summary, LIMITS.summary),
    status: STATUSES.includes(source.status) ? source.status : 'backlog',
    ...(cleanText(source.project, LIMITS.boardName) ? { project: cleanText(source.project, LIMITS.boardName) } : {}),
    ...(cleanText(source.cwd, 1000) ? { cwd: cleanText(source.cwd, 1000) } : {}),
    ...(cleanText(source.workspaceId, LIMITS.sessionId) ? { workspaceId: cleanText(source.workspaceId, LIMITS.sessionId) } : {}),
    ...(cleanText(source.currentAction, LIMITS.currentAction) ? { currentAction: cleanText(source.currentAction, LIMITS.currentAction) } : {}),
  }
}

/** 审批的完整请求快照（题目 / 选项原文），供决策日志持久化与读取规范化共用。 */
export function normalizeApprovalSnapshot(raw) {
  const data = isObject(raw) ? raw : {}
  const options = normalizeOptions(data.options, { strict: false })
  const questions = (Array.isArray(data.questions) ? data.questions : [])
    .map((question, index) => normalizeApprovalQuestion(question, index, { strict: false }))
    .filter(Boolean)
    .slice(0, LIMITS.approvalQuestions)
  const legacyOptions = options.length ? options : questions[0]?.options || []
  if (!questions.length && !legacyOptions.length) return null
  const title = cleanText(data.title, LIMITS.approvalTitle) || (questions[0] ? approvalTitleFromQuestion(questions[0]) : '')
  if (!title) return null
  return {
    title,
    detail: cleanText(data.detail, LIMITS.approvalDetail),
    multiSelect: data.multiSelect === true || (questions[0] ? questions[0].multiSelect === true : false),
    options: legacyOptions,
    ...(questions.length ? { questions } : {}),
  }
}

function decisionSessionId(card, approval) {
  const declared = cleanText(approval?.sessionId, LIMITS.sessionId)
  if (declared) return declared
  return Array.isArray(card?.sessionIds) ? cleanText(card.sessionIds[0], LIMITS.sessionId) : ''
}

/**
 * 关闭卡片上所有 pending 审批（归档 / 离开待你确认列 / 20 条上限裁剪 / 数据重置）：
 * 审批状态置为 dismissed 并写 resolvedAt/resolvedBy（不伪造 resolution），每一条各记一条未决事件。
 */
function closePendingApprovals(draft, card, { reason, actor, now, context } = {}) {
  const pending = (card.approvals || []).filter(approval => approval.status === 'pending')
  if (!pending.length) return 0
  const closer = normalizeActor(actor)
  const cardContext = context || decisionCardContext(card)
  for (const approval of pending) {
    approval.status = 'dismissed'
    approval.resolvedAt = now
    approval.resolvedBy = closer
    const sessionId = decisionSessionId(card, approval)
    pushDecision(draft, {
      type: 'approval_unresolved',
      at: now,
      boardId: card.boardId,
      cardId: card.id,
      approvalId: approval.id,
      actor: closer,
      ...(sessionId ? { sessionId } : {}),
      card: cardContext,
      reason,
      waitedMs: Math.max(0, now - integer(approval.requestedAt, now, 0)),
    })
  }
  return pending.length
}

/** 是否存在「历史遗留 pending」：归档卡上、或已不在待你确认列的未提交审批。 */
export function hasStalePendingApprovals(draft) {
  return (draft?.cards || []).some(card => (card.approvals || []).some(approval => approval.status === 'pending')
    && (card.archived === true || COLUMN_OF_STATUS[card.status] !== 'needs_you'))
}

/**
 * 静默关闭历史遗留的 pending 审批（归档卡 / 不在待你确认列）：
 * 这类审批的未决事实已由决策日志回填记录，这里只把 data.json 的状态同步为 dismissed，
 * 不再写决策事件，避免同一审批出现两条未决记录；启动时幂等调用。
 */
export function dismissStalePendingApprovals(draft, { actor = defaultActor('system'), now = nowMs() } = {}) {
  const closer = normalizeActor(actor)
  let count = 0
  for (const card of draft.cards) {
    const stale = (card.approvals || []).filter(approval => approval.status === 'pending')
    if (!stale.length) continue
    if (!card.archived && COLUMN_OF_STATUS[card.status] === 'needs_you') continue
    for (const approval of stale) {
      approval.status = 'dismissed'
      approval.resolvedAt = now
      approval.resolvedBy = closer
      count += 1
    }
    touchCard(card, now)
  }
  if (count) touchMeta(draft, actor, now)
  return count
}

// ---------------- 写操作原语 ----------------

export function touchCard(card, now) {
  card.updatedAt = now
  card.version = (card.version || 0) + 1
}

export function touchMeta(draft, actor, now) {
  draft.meta.updatedAt = now
  if (actor) draft.meta.lastActor = normalizeActor(actor)
}

function touchBoard(draft, boardId, now) {
  const board = findBoard(draft, boardId)
  if (board) board.updatedAt = now
}

export function pushActivity(draft, card, { type, actor, text, data, at }) {
  const activity = {
    id: newActivityId(),
    cardId: card.id,
    type: ACTIVITY_TYPES.includes(type) ? type : 'progress',
    actor: normalizeActor(actor),
    text: cleanText(text, LIMITS.activityText),
    at: at ?? nowMs(),
    ...(isObject(data) ? { data } : {}),
  }
  draft.activities.push(activity)
  trimActivities(draft, card.id)
  return activity
}

function trimActivities(draft, cardId) {
  const own = draft.activities.filter(activity => activity.cardId === cardId)
  if (own.length <= LIMITS.activitiesPerCard) return
  const drop = new Set(own.slice(0, own.length - LIMITS.activitiesPerCard).map(activity => activity.id))
  draft.activities = draft.activities.filter(activity => !drop.has(activity.id))
}

/** 从所有列的 cardOrder 移除，再按 beforeId/afterId 插入目标列（都没有则插入头部）。 */
export function moveInOrder(board, card, column, { beforeId, afterId } = {}) {
  rebuildOrder(board)
  for (const key of COLUMNS) board.cardOrder[key] = board.cardOrder[key].filter(id => id !== card.id)
  const list = board.cardOrder[column]
  const beforeIndex = beforeId ? list.indexOf(beforeId) : -1
  const afterIndex = afterId ? list.indexOf(afterId) : -1
  if (beforeIndex >= 0) list.splice(beforeIndex, 0, card.id)
  else if (afterIndex >= 0) list.splice(afterIndex + 1, 0, card.id)
  else list.unshift(card.id)
}

function rebuildOrder(board) {
  if (!isObject(board.cardOrder)) board.cardOrder = emptyCardOrder()
  for (const column of COLUMNS) {
    if (!Array.isArray(board.cardOrder[column])) board.cardOrder[column] = []
  }
}

function applyStatusFields(card, status, now, { fromStatus = card.status, reason } = {}) {
  card.status = status
  if (status === 'running' && !card.startedAt) card.startedAt = now
  if (status === 'done' || status === 'canceled') card.completedAt = now
  else if (card.completedAt !== undefined) delete card.completedAt
  // 状态代数（fencing token）演进：
  // 同一轮执行内的自动瞬时失败与恢复（SESSION_TURN_FAILURE / SESSION_TURN_RECOVERED）保留当前代数与退避预算；
  // 其余跨状态迁移（离开 running、人工重试、审批通过回 running、依赖唤醒入 running）一律推进 generation 并重置预算。
  if (fromStatus !== status && reason !== SESSION_TURN_FAILURE && reason !== SESSION_TURN_RECOVERED) {
    if (isObject(card.runtime) || fromStatus === 'running' || status === 'running') {
      bumpCardGeneration(card, { resetBudget: true, clearWatermark: true })
    }
  }
}

/** 子卡进入这些状态时回写父卡时间线（不改父卡状态）。 */
const CHILD_STATUS_NOTIFY = new Set(['done', 'canceled', 'failed', 'needs_you'])

/**
 * 状态迁移后的关系联动（只在状态真正变化后调用，不改卡片自身状态）：
 * 1) 子卡进入 done/canceled/failed/needs_you → 父卡写一条 progress 时间线；
 * 2) 卡片进入 done/canceled → 依赖它的卡片若已全部就绪则唤醒（blocked → backlog）。
 * 防递归：backlog 不在回写集合里，也不触发唤醒，所以唤醒时的状态改动不会再次联动。
 */
function expireStaleOutboxForCard(draft, card, now = nowMs()) {
  if (!Array.isArray(draft?.outbox) || !card) return
  const currentGen = card.runtime?.generation ?? 1
  for (const entry of draft.outbox) {
    if (entry.cardId === card.id && entry.status === 'pending' && entry.expectedGeneration !== currentGen) {
      entry.status = 'expired'
      entry.updatedAt = now
    }
  }
}

function afterStatusChange(draft, card, from, to, { actor, now } = {}) {
  expireStaleOutboxForCard(draft, card, now)
  if (card.archived) return
  if (CHILD_STATUS_NOTIFY.has(to) && card.parentCardId) {
    const parent = findCard(draft, card.parentCardId)
    if (parent) {
      pushActivity(draft, parent, {
        type: 'progress',
        actor,
        text: `子卡「${card.title}」进入「${STATUS_LABELS[to]}」`,
        data: { childCardId: card.id, childStatus: to },
        at: now,
      })
      const children = directChildren(draft, parent.id)
      if (children.length > 0) {
        const settledCount = children.filter(child => TERMINAL_STATUSES.has(child.status)).length
        parent.progress = normalizeProgress({
          step: settledCount,
          total: children.length,
          text: `子卡进度 ${settledCount}/${children.length}`,
        })
        if (settledCount === children.length && !TERMINAL_STATUSES.has(parent.status)) {
          parent.currentAction = `全部 ${children.length} 张子卡已收口，等待父卡汇总验收`
        }
      }
    }
  }
  if (TERMINAL_STATUSES.has(to)) wakeDependents(draft, card, { actor, now })
}

/**
 * 从已完成的前置依赖卡合成结构化交接摘要（Upstream-to-Downstream Handoff Injection）：
 * 自动汇总前置卡的标题、结论（result）、产物（artifacts）与执行目录（cwd）。
 */
export function synthesizeUpstreamHandoff(card, dependencies, { now = nowMs(), actor = defaultActor('system') } = {}) {
  const settledDeps = (Array.isArray(dependencies) ? dependencies : []).filter(Boolean)
  if (!settledDeps.length) return null
  const summaryLines = settledDeps.map(dep => {
    const parts = [`【前置完成】「${dep.title}」`]
    if (dep.result) parts.push(`结论：${dep.result}`)
    if (Array.isArray(dep.artifacts) && dep.artifacts.length) {
      const labels = dep.artifacts.slice(0, 5).map(a => a.path || a.url || a.label).filter(Boolean)
      if (labels.length) parts.push(`产物：${labels.join('、')}`)
    }
    if (dep.cwd) parts.push(`目录：${dep.cwd}`)
    return parts.join('｜')
  })
  const summary = cleanText(summaryLines.join('\n'), LIMITS.handoffSummary)
  if (!summary) return null
  const primaryDep = settledDeps[settledDeps.length - 1]
  const nextSteps = cleanText(
    card.currentAction || card.summary || '请基于前置卡交付结论与产物继续推进本卡任务。',
    LIMITS.handoffNextSteps,
  )
  return normalizeHandoff({
    summary,
    ...(nextSteps ? { nextSteps } : {}),
    ...(mainSessionId(primaryDep) ? { sessionId: mainSessionId(primaryDep) } : {}),
  }, { now, actor, at: now, strict: false })
}

/** 生成依赖就绪自动点火（wake）的会话提示词。 */
export function buildCardWakePrompt(card) {
  const lines = [
    `【看板·依赖就绪自动推进】卡片「${card.title}」（ID: ${card.id}）的前置依赖已全部完成，现已自动进入「进行中」。`,
  ]
  if (card.summary) lines.push(`任务摘要：${card.summary}`)
  if (card.currentAction) lines.push(`当前待办：${card.currentAction}`)
  if (card.cwd) lines.push(`工作目录：${card.cwd}`)
  if (card.handoff?.summary) lines.push(`前置交接摘要：\n${card.handoff.summary}`)
  if (card.handoff?.nextSteps) lines.push(`建议下一步：${card.handoff.nextSteps}`)
  if (Array.isArray(card.checklists) && card.checklists.length) {
    const todo = card.checklists.filter(item => !item.done).map(item => `- [ ] ${item.text}`).join('\n')
    if (todo) lines.push(`待完成检查项：\n${todo}`)
  }
  lines.push('请直接开始执行本卡任务，过程中用 kanban_update_card 同步进度，完成后调用 kanban_complete_card 收口。')
  return cleanText(lines.join('\n'), LIMITS.outboxPrompt)
}

/** 依赖唤醒：扫描未归档、dependsOn 含 completedCard 的卡片；全部依赖都已收口才唤醒。 */
function wakeDependents(draft, completedCard, { actor, now } = {}) {
  const byId = new Map((draft.cards || []).map(card => [card.id, card]))
  const woken = []
  for (const card of draft.cards || []) {
    if (card.archived || !Array.isArray(card.dependsOn) || !card.dependsOn.includes(completedCard.id)) continue
    const deps = card.dependsOn.map(id => byId.get(id))
    const ready = deps.every(dependency => dependency && TERMINAL_STATUSES.has(dependency.status))
    if (!ready) continue
    // 自动把上游完成卡的结论/产物/目录注入下游卡的 handoff 与上下文
    if (!card.cwd && completedCard.cwd) card.cwd = completedCard.cwd
    if (!card.workspaceId && completedCard.workspaceId) card.workspaceId = completedCard.workspaceId
    const synthesized = synthesizeUpstreamHandoff(card, deps, { now, actor: defaultActor('system') })
    if (synthesized) card.handoff = synthesized

    pushActivity(draft, card, {
      type: 'progress',
      actor,
      text: `依赖卡「${completedCard.title}」已完成，依赖已就绪`,
      data: { dependencyCardId: completedCard.id },
      at: now,
    })
    let enteredRunning = false
    const autoAdvance = getAutoAdvanceEnabled(draft)
    if (card.status === 'blocked') {
      const nextStatus = (autoAdvance && card.autoStart === true) ? 'running' : 'backlog'
      changeStatus(draft, card, nextStatus, {
        actor,
        now,
        text: nextStatus === 'running'
          ? '依赖已就绪，从「受阻」自动进入「进行中」'
          : '依赖已就绪，从「受阻」回到「待办」',
        data: { reason: 'dependency_ready', dependencyCardId: completedCard.id },
      })
      enteredRunning = nextStatus === 'running'
    } else if (autoAdvance && card.status === 'backlog' && card.autoStart === true) {
      changeStatus(draft, card, 'running', {
        actor,
        now,
        text: '依赖已就绪，从「待办」自动进入「进行中」',
        data: { reason: 'dependency_ready', dependencyCardId: completedCard.id },
      })
      enteredRunning = true
    }
    if (enteredRunning) {
      const runtime = ensureCardRuntime(card)
      enqueueOutbox(draft, {
        idempotencyKey: `wake:${card.id}:gen:${runtime.generation}`,
        cardId: card.id,
        expectedGeneration: runtime.generation,
        kind: 'wake',
        target: {
          ...(mainSessionId(card) ? { sessionId: mainSessionId(card) } : {}),
          ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
          ...(card.cwd ? { cwd: card.cwd } : {}),
        },
        prompt: buildCardWakePrompt(card),
        mode: 'queue',
        notBefore: now,
      }, { now })
    }
    woken.push(card)
  }
  return woken
}

/** 状态迁移的统一入口：同步 startedAt/completedAt、cardOrder 与 status Activity。 */
export function changeStatus(draft, card, status, { actor, now, text, data } = {}) {
  const from = card.status
  if (from === status) return null
  const board = findBoard(draft, card.boardId)
  const leavingNeedsYou = COLUMN_OF_STATUS[from] === 'needs_you' && COLUMN_OF_STATUS[status] !== 'needs_you'
  const cardContext = leavingNeedsYou ? decisionCardContext(card) : null
  applyStatusFields(card, status, now, { fromStatus: from, reason: data?.reason })
  if (board) moveInOrder(board, card, COLUMN_OF_STATUS[status])
  // 离开「待你确认」列时，未提交的审批随之关闭（正式审批的未决事实进决策日志）。
  if (leavingNeedsYou) closePendingApprovals(draft, card, { reason: 'left_needs_you', actor, now, context: cardContext })
  const activity = pushActivity(draft, card, {
    type: 'status',
    actor,
    text: text || `把状态改为「${STATUS_LABELS[status]}」`,
    data: { from, to: status, ...(isObject(data) ? data : {}) },
    at: now,
  })
  afterStatusChange(draft, card, from, status, { actor, now })
  return activity
}

function nextOrder(draft) {
  return draft.cards.reduce((max, card) => Math.max(max, card.order || 0), 0) + 1
}

export function createCard(draft, input, { actor = defaultActor('user'), now = nowMs() } = {}) {
  if (draft.cards.filter(card => !card.archived).length >= LIMITS.cards) {
    throw new DomainError('CONFLICT', `卡片数量已达上限 ${LIMITS.cards}`, 409)
  }
  const board = requireBoard(draft, input.boardId)
  const title = requiredText(input.title, LIMITS.title, 'BAD_REQUEST', '卡片标题不能为空')
  const status = normalizeStatus(input.status, 'backlog')
  const sessionId = cleanText(input.sessionId, LIMITS.sessionId)
  // 父子卡/依赖（v0.22.0）：目标卡必须存在且未归档；不能成环。新卡 ID 先分配，环检测才能覆盖「指向自己」。
  const id = newCardId()
  let parentCardId
  if (input.parentCardId !== undefined && input.parentCardId !== null) {
    if (!isCardId(input.parentCardId)) {
      throw new DomainError('BAD_REQUEST', 'parentCardId 必须是 card-xxxxxxxx 形式的卡片 ID')
    }
    parentCardId = assertParentLink(draft, id, input.parentCardId)
  }
  const dependsOn = normalizeDependsOnInput(input.dependsOn)
  assertDependsLink(draft, id, dependsOn)
  const card = {
    id,
    boardId: board.id,
    title,
    summary: cleanText(input.summary, LIMITS.summary),
    status,
    priority: normalizePriority(input.priority),
    labels: normalizeLabels(input.labels),
    ...(cleanText(input.project, LIMITS.boardName) ? { project: cleanText(input.project, LIMITS.boardName) } : {}),
    ...(cleanText(input.workspaceId, LIMITS.sessionId) ? { workspaceId: cleanText(input.workspaceId, LIMITS.sessionId) } : {}),
    ...(cleanText(input.cwd, 1000) ? { cwd: cleanText(input.cwd, 1000) } : {}),
    ...(cleanText(input.externalRef, 200) ? { externalRef: cleanText(input.externalRef, 200) } : {}),
    ...(cleanText(input.externalThreadId, 200) ? { externalThreadId: cleanText(input.externalThreadId, 200) } : {}),
    sessionIds: sessionId ? [sessionId] : [],
    ...(parentCardId ? { parentCardId } : {}),
    dependsOn,
    ...(input.autoStart === true ? { autoStart: true } : {}),
    ...(normalizeAgent(input.agent) ? { agent: normalizeAgent(input.agent) } : {}),
    checklists: Array.isArray(input.checklists) ? normalizeChecklists(input.checklists) : [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0 },
    order: input.order === undefined ? nextOrder(draft) : integer(input.order, 0, 0),
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...(status === 'running' ? { startedAt: now } : {}),
    ...(status === 'done' || status === 'canceled' ? { completedAt: now } : {}),
  }
  draft.cards.push(card)
  moveInOrder(board, card, COLUMN_OF_STATUS[status])
  board.updatedAt = now
  const activity = pushActivity(draft, card, {
    type: 'created', actor, text: `创建了卡片「${card.title}」`,
    data: { status }, at: now,
  })
  touchMeta(draft, actor, now)
  return { card, activity }
}

function patchTextField(card, key, value, max) {
  if (value === null) { delete card[key]; return false }
  if (typeof value !== 'string') throw new DomainError('BAD_REQUEST', `${key} 必须是字符串`)
  const text = cleanText(value, max)
  if (!text) { delete card[key]; return true }
  card[key] = text
  return true
}

/** PATCH /cards/:id 的核心实现；工具也复用它（区别只是是否需要乐观锁）。 */
export function patchCard(draft, cardId, changes, { actor = defaultActor('user'), now = nowMs(), forceComplete = false, strictChecklists = false } = {}) {
  if (!isObject(changes)) throw new DomainError('BAD_REQUEST', 'changes 必须是对象')
  const card = requireCard(draft, cardId)
  const activities = []
  const board = findBoard(draft, card.boardId)
  let statusChanged = false
  if (changes.checklists !== undefined) {
    card.checklists = normalizeChecklists(changes.checklists)
  }
  for (const [key, value] of Object.entries(changes)) {
    switch (key) {
      case 'title': {
        const text = requiredText(value, LIMITS.title, 'BAD_REQUEST', '卡片标题不能为空')
        card.title = text
        break
      }
      case 'summary': patchTextField(card, 'summary', value, LIMITS.summary); card.summary ||= ''; break
      case 'currentAction': case 'result': patchTextField(card, key, value, key === 'result' ? LIMITS.result : LIMITS.currentAction); break
      case 'status': {
        const status = normalizeStatus(value)
        if (status !== card.status) {
          statusChanged = true
          // 若同一笔 PATCH 同时传了 result，先写入 result 以便 wakeDependents 合成完整交接摘要
          if (changes.result !== undefined && changes.result !== null && typeof changes.result === 'string') {
            patchTextField(card, 'result', changes.result, LIMITS.result)
          }
          // 进入「已完成」前拦截：有未收口子卡（或 strictChecklists 下有未完成检查项）时默认 409，forceComplete=true 才放行（放行后写审计节点）。
          const openChildren = status === 'done'
            ? completionGuard(draft, card, forceComplete, { strictChecklists })
            : []
          const openChecklists = status === 'done' && strictChecklists ? openChecklistItems(card) : []
          const activity = changeStatus(draft, card, status, { actor, now })
          if (activity) activities.push(activity)
          if (openChildren.length || openChecklists.length) {
            activities.push(pushForceCompleteActivity(draft, card, openChildren, { actor, now, openChecklists }))
          }
        }
        break
      }
      case 'autoStart': {
        if (value === true) card.autoStart = true
        else if (value === false || value === null) delete card.autoStart
        break
      }
      case 'waitCondition': {
        const runtime = ensureCardRuntime(card)
        if (value === null) {
          delete runtime.waitCondition
        } else if (isObject(value) && ['time', 'session_idle'].includes(value.kind)) {
          runtime.waitCondition = normalizeCardRuntime({ waitCondition: value }).waitCondition
        } else {
          throw new DomainError('BAD_REQUEST', 'waitCondition 必须是有效等待条件对象或 null')
        }
        break
      }
      case 'priority': card.priority = normalizePriority(value); break
      case 'labels': card.labels = normalizeLabels(value); break
      case 'project': case 'workspaceId': case 'cwd': patchTextField(card, key, value, key === 'cwd' ? 1000 : LIMITS.boardName); break
      case 'externalRef': case 'externalThreadId': patchTextField(card, key, value, 200); break
      case 'parentCardId': {
        if (value === null) { delete card.parentCardId; break }
        if (!isCardId(value)) throw new DomainError('BAD_REQUEST', 'parentCardId 必须是 card-xxxxxxxx 形式的卡片 ID')
        card.parentCardId = assertParentLink(draft, card.id, value)
        break
      }
      case 'dependsOn': card.dependsOn = assertDependsLink(draft, card.id, normalizeDependsOnInput(value)); break
      case 'agent': {
        const agent = normalizeAgent(value)
        if (agent) card.agent = agent; else delete card.agent
        break
      }
      case 'progress': {
        const progress = normalizeProgress(value)
        if (progress) card.progress = progress; else delete card.progress
        break
      }
      case 'checklists': card.checklists = normalizeChecklists(value); break
      case 'artifacts': card.artifacts = normalizeArtifacts(value); break
      case 'handoff': {
        if (value === null) {
          if (card.handoff !== undefined) {
            delete card.handoff
            activities.push(pushActivity(draft, card, { type: 'handoff', actor, text: '清除了交接摘要', at: now }))
          }
        } else {
          const handoff = normalizeHandoff(value, { now, actor, at: now })
          card.handoff = handoff
          activities.push(pushActivity(draft, card, {
            type: 'handoff', actor, text: '更新了交接摘要',
            data: handoff.sessionId ? { sessionId: handoff.sessionId } : undefined, at: now,
          }))
        }
        break
      }
      case 'metadata': card.metadata = { ...normalizeMetadata(card.metadata), ...normalizeMetadata(value) }; break
      case 'order': card.order = integer(value, card.order, 0); break
      default: break // 契约：忽略未知字段
    }
  }
  if (!statusChanged && (changes.currentAction !== undefined || changes.progress !== undefined)) {
    const progress = card.progress
    const text = card.currentAction || progress?.text || (progress ? `进度 ${progress.step}${progress.total ? '/' + progress.total : ''}` : '更新了进展')
    activities.push(pushActivity(draft, card, { type: 'progress', actor, text, data: progress ? { progress } : undefined, at: now }))
  }
  if (changes.result !== undefined && card.status === 'done') {
    activities.push(pushActivity(draft, card, { type: 'result', actor, text: card.result || '已标记完成', at: now }))
  }
  if (board) board.updatedAt = now
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activities }
}

export function moveCard(draft, cardId, { column, status, beforeId, afterId, text, actor = defaultActor('user'), now = nowMs(), forceComplete = false, strictChecklists = false } = {}) {
  const card = requireCard(draft, cardId)
  const board = findBoard(draft, card.boardId)
  const targetColumn = column !== undefined ? normalizeColumn(column) : COLUMN_OF_STATUS[normalizeStatus(status)]
  const targetStatus = status !== undefined ? normalizeStatus(status) : STATUS_OF_COLUMN[targetColumn]
  const reason = cleanText(text, 200)
  const label = COLUMN_LABELS[targetColumn]
  const fromStatus = card.status
  const leavingNeedsYou = COLUMN_OF_STATUS[fromStatus] === 'needs_you' && targetColumn !== 'needs_you'
  const cardContext = leavingNeedsYou ? decisionCardContext(card) : null
  // 移到「已完成」前拦截未收口子卡（与 completeCard 一致）；forceComplete=true 放行并写审计节点。
  const openChildren = targetStatus !== fromStatus && targetStatus === 'done'
    ? completionGuard(draft, card, forceComplete, { strictChecklists })
    : []
  const openChecklists = targetStatus !== fromStatus && targetStatus === 'done' && strictChecklists
    ? openChecklistItems(card)
    : []
  applyStatusFields(card, targetStatus, now, { fromStatus })
  moveInOrder(board, card, targetColumn, { beforeId: cleanText(beforeId, 40) || undefined, afterId: cleanText(afterId, 40) || undefined })
  if (leavingNeedsYou) closePendingApprovals(draft, card, { reason: 'left_needs_you', actor, now, context: cardContext })
  const activity = pushActivity(draft, card, {
    type: 'status', actor,
    text: `把卡片移到「${label}」${reason ? '：' + reason : ''}`,
    data: { column: targetColumn, status: targetStatus, ...(reason ? { reason } : {}) },
    at: now,
  })
  if (openChildren.length || openChecklists.length) {
    pushForceCompleteActivity(draft, card, openChildren, { actor, now, openChecklists })
  }
  if (targetStatus !== fromStatus) afterStatusChange(draft, card, fromStatus, targetStatus, { actor, now })
  touchCard(card, now)
  board.updatedAt = now
  touchMeta(draft, actor, now)
  return { card, activity }
}

export function normalizeColumn(column) {
  if (!COLUMNS.includes(column)) throw new DomainError('BAD_REQUEST', `未知列：${String(column)}`)
  return column
}

export function addComment(draft, cardId, { text, actor = defaultActor('user'), now = nowMs() }) {
  const card = requireCard(draft, cardId)
  const message = requiredText(text, LIMITS.activityText, 'BAD_REQUEST', '评论不能为空')
  const activity = pushActivity(draft, card, { type: 'comment', actor, text: message, at: now })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity }
}

export function requestApproval(draft, cardId, input, { actor = defaultActor('agent'), now = nowMs() } = {}) {
  const card = requireCard(draft, cardId)
  if (!Array.isArray(card.approvals)) card.approvals = []
  // 两种形态二选一：questions[]（多题，v0.3）或 title/options（单题，旧契约）。
  let questions
  if (input.questions !== undefined) {
    if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > LIMITS.approvalQuestions) {
      throw new DomainError('BAD_REQUEST', `多题审批需要 1-${LIMITS.approvalQuestions} 个问题`)
    }
    questions = input.questions.map((question, index) => normalizeApprovalQuestion(question, index))
    if (!questions.length) throw new DomainError('BAD_REQUEST', '多题审批至少需要 1 个有效问题')
  }
  const firstQuestion = questions ? questions[0] : undefined
  const title = questions
    ? approvalTitleFromQuestion(firstQuestion)
    : requiredText(input.title, LIMITS.approvalTitle, 'BAD_REQUEST', '审批标题不能为空')
  // 多题时兼容字段 options/multiSelect 取第一题，旧 UI 仍可渲染摘要。
  const options = questions
    ? (input.options !== undefined ? normalizeOptions(input.options) : firstQuestion.options)
    : normalizeOptions(input.options)
  const multiSelect = questions ? firstQuestion.multiSelect === true : input.multiSelect === true
  const detail = cleanText(input.detail, LIMITS.approvalDetail)
  const board = findBoard(draft, card.boardId)
  const sessionId = cleanText(input.sessionId, LIMITS.sessionId)
  const approval = {
    id: newApprovalId(),
    title,
    detail,
    multiSelect,
    options,
    ...(questions ? { questions } : {}),
    status: 'pending',
    requestedBy: normalizeActor(input.actor ?? actor, actor.kind === 'agent' ? 'agent' : 'user'),
    requestedAt: now,
    ...(sessionId ? { sessionId } : {}),
  }
  const cardContext = decisionCardContext(card)
  const requestSession = decisionSessionId(card, approval)
  card.approvals.push(approval)
  const trimmed = card.approvals.length > LIMITS.approvals ? card.approvals.slice(0, card.approvals.length - LIMITS.approvals) : []
  if (trimmed.length) card.approvals = card.approvals.slice(-LIMITS.approvals)
  // 请求快照先落日志：之后即使审批被裁剪 / 卡片被重置，原始请求也不变。
  pushDecision(draft, {
    type: 'approval_requested',
    at: now,
    boardId: card.boardId,
    cardId: card.id,
    approvalId: approval.id,
    actor: approval.requestedBy,
    ...(requestSession ? { sessionId: requestSession } : {}),
    card: cardContext,
    approval: normalizeApprovalSnapshot(approval),
  })
  // 单卡 20 条审批上限：被挤掉的 pending 审批补一条未决事件（其请求事件早已在日志里）。
  for (const dropped of trimmed) {
    if (!isObject(dropped) || dropped.status !== 'pending') continue
    pushDecision(draft, {
      type: 'approval_unresolved',
      at: now,
      boardId: card.boardId,
      cardId: card.id,
      approvalId: dropped.id,
      actor: normalizeActor(actor),
      card: cardContext,
      reason: 'trimmed',
      waitedMs: Math.max(0, now - integer(dropped.requestedAt, now, 0)),
    })
  }
  const statusActivity = changeStatus(draft, card, 'needs_you', { actor, now, text: '等待你的确认' })
  const activity = pushActivity(draft, card, {
    type: 'approval_requested', actor,
    text: questions ? `请求确认（${questions.length} 题）：「${title}」` : `请求确认：「${title}」`,
    data: {
      approvalId: approval.id,
      multiSelect,
      ...(questions
        ? { questions: questions.map(question => ({ id: question.id, options: question.options.map(option => option.id) })) }
        : { options: options.map(option => option.id) }),
    },
    at: now,
  })
  if (board) board.updatedAt = now
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, approval, activities: statusActivity ? [statusActivity, activity] : [activity] }
}

const REJECT_OPTION_IDS = ['no', 'reject', 'rejected', 'deny', 'cancel']
const isRejectOption = option => option.tone === 'danger' || REJECT_OPTION_IDS.includes(option.id)

function selectedIds(values, label, { allowEmpty = false } = {}) {
  const ids = []
  for (const value of Array.isArray(values) ? values : values !== undefined ? [values] : []) {
    const id = cleanText(value, 40)
    if (id && !ids.includes(id)) ids.push(id)
  }
  if (!ids.length && !allowEmpty) throw new DomainError('BAD_REQUEST', `${label}至少需要选择 1 个选项`)
  return ids
}

/**
 * 解决审批：多题用 answers[{questionId, optionIds[], custom?}] 逐题作答；
 * 每题必须「选中至少 1 个选项」或「填写 custom（≤600 字）」，单选两者互斥；
 * 判定 rejected = 所有选中选项均为拒绝语义且没有任何自定义回答。
 * 单题兼容 optionIds[]（v0.2）与 optionId（v0.1）。
 */
export function resolveApproval(draft, cardId, approvalId, { answers, optionIds, optionId, comment, actor = defaultActor('user'), now = nowMs() } = {}) {
  const card = requireCard(draft, cardId)
  const approval = findApproval(card, approvalId)
  if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', '审批不存在', 404)
  if (approval.status !== 'pending') throw new DomainError('CONFLICT', '该审批已处理', 409)
  const questions = Array.isArray(approval.questions) ? approval.questions : []
  const resolvedAnswers = []
  const selected = []
  if (questions.length) {
    if (!Array.isArray(answers) || !answers.length) {
      throw new DomainError('BAD_REQUEST', `该审批有 ${questions.length} 题，需要逐题作答（answers）`)
    }
    const byId = new Map(questions.map(question => [question.id, question]))
    const answered = new Map()
    for (const answer of answers) {
      if (!isObject(answer)) throw new DomainError('BAD_REQUEST', '答案格式不合法')
      const questionId = cleanText(answer.questionId, 40)
      const question = byId.get(questionId)
      if (!question) throw new DomainError('BAD_REQUEST', `题号不存在：${questionId || '(空)'}`)
      if (answered.has(questionId)) throw new DomainError('BAD_REQUEST', `题目重复作答：${questionId}`)
      const ids = selectedIds(answer.optionIds !== undefined ? answer.optionIds : answer.optionId, `第 ${questionId} 题`, { allowEmpty: true })
      const picked = ids.map(id => {
        const option = question.options.find(item => item.id === id)
        if (!option) throw new DomainError('BAD_REQUEST', `题目 ${questionId} 中不存在选项：${id}`)
        return option
      })
      const custom = cleanText(answer.custom, LIMITS.approvalAnswerCustom)
      if (!picked.length && !custom) {
        throw new DomainError('BAD_REQUEST', `题目 ${questionId} 需要选择选项或填写自定义内容`)
      }
      if (question.multiSelect !== true) {
        if (custom && picked.length) {
          throw new DomainError('BAD_REQUEST', `题目 ${questionId} 为单选，填写自定义内容时不能再选选项`)
        }
        if (!custom && picked.length !== 1) {
          throw new DomainError('BAD_REQUEST', `题目 ${questionId} 为单选，只能选择 1 个选项`)
        }
      }
      answered.set(questionId, { picked, custom })
      selected.push(...picked)
    }
    const missing = questions.filter(question => !answered.has(question.id))
    if (missing.length) throw new DomainError('BAD_REQUEST', `还有 ${missing.length} 题未作答：${missing.map(question => question.id).join('、')}`)
    for (const question of questions) {
      const entry = answered.get(question.id)
      resolvedAnswers.push({
        questionId: question.id,
        optionIds: entry.picked.map(option => option.id),
        labels: entry.picked.map(option => option.label),
        ...(entry.custom ? { custom: entry.custom } : {}),
      })
    }
  } else {
    const ids = selectedIds(optionIds !== undefined ? optionIds : optionId, '审批')
    for (const id of ids) {
      const option = approval.options.find(item => item.id === id)
      if (!option) throw new DomainError('BAD_REQUEST', `选项不存在：${id}`)
      selected.push(option)
    }
    if (approval.multiSelect !== true && selected.length !== 1) {
      throw new DomainError('BAD_REQUEST', '该审批为单选，只能选择 1 个选项')
    }
  }
  const customCount = resolvedAnswers.filter(answer => answer.custom).length
  const rejected = selected.length > 0 && selected.every(isRejectOption) && customCount === 0
  approval.status = rejected ? 'rejected' : 'approved'
  approval.resolvedBy = normalizeActor(actor)
  approval.resolvedAt = now
  const optionIdsFlat = selected.map(option => option.id)
  const labelsFlat = selected.map(option => option.label)
  const trimmedComment = cleanText(comment, 800)
  approval.resolution = {
    optionIds: optionIdsFlat,
    labels: labelsFlat,
    ...(resolvedAnswers.length ? { answers: resolvedAnswers } : {}),
    ...(trimmedComment ? { comment: trimmedComment } : {}),
  }
  // 提交时刻的卡片上下文（移列前），以及这次选择的原始记录。
  const cardContext = decisionCardContext(card)
  const resolveSession = decisionSessionId(card, approval)
  const decisionEntry = {
    type: 'approval_resolved',
    at: now,
    boardId: card.boardId,
    cardId: card.id,
    approvalId: approval.id,
    actor: approval.resolvedBy,
    ...(resolveSession ? { sessionId: resolveSession } : {}),
    card: cardContext,
    decision: approval.status,
    resolution: { ...approval.resolution },
    waitedMs: Math.max(0, now - integer(approval.requestedAt, now, 0)),
  }
  const activity = pushActivity(draft, card, {
    type: 'approval_resolved', actor,
    text: `${rejected ? '已拒绝' : '已批准'}「${approval.title}」${questions.length ? `（${questions.length} 题）` : ''}：${labelsFlat.join('、') || '（自定义回答）'}${customCount ? ` + ${customCount} 题自定义` : ''}`,
    data: {
      approvalId: approval.id,
      optionIds: optionIdsFlat,
      ...(resolvedAnswers.length ? { questionIds: resolvedAnswers.map(answer => answer.questionId) } : {}),
      ...(customCount ? { customCount } : {}),
      decision: approval.status,
    },
    at: now,
  })
  const statusActivity = followApprovalOutcome(draft, card, { approval, selected, rejected, actor, now })
  if (statusActivity?.data?.column) decisionEntry.outcomeColumn = statusActivity.data.column
  pushDecision(draft, decisionEntry)
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, approval, activity, ...(statusActivity ? { statusActivity } : {}) }
}

/** 审批提交后卡片落到的列：选中选项声明了 outcome 就用它，否则批准回进行中、驳回回待办。 */
export function approvalOutcomeColumn(selected, { rejected = false } = {}) {
  const declared = (Array.isArray(selected) ? selected : []).find(option => option && APPROVAL_OUTCOMES.includes(option.outcome))
  if (declared) return declared.outcome
  return rejected ? 'backlog' : 'running'
}

/**
 * 最后一条待确认审批提交后立刻迁移卡片（v0.9.5）：按所选选项声明的 outcome 进入对应列，
 * 未声明时批准回「进行中」、驳回回「待办」。仍有其它 pending 审批、已归档、或卡片不在
 * `needs_you`（如受阻/失败、被拖去别的列）时保持不动。
 */
function followApprovalOutcome(draft, card, { approval, selected, rejected, actor, now }) {
  if (card.archived) return null
  if (card.approvals.some(item => item.status === 'pending')) return null
  if (card.status !== 'needs_you') return null
  const column = approvalOutcomeColumn(selected, { rejected })
  return changeStatus(draft, card, STATUS_OF_COLUMN[column], {
    actor, now,
    text: column === 'running' ? '审批已提交，卡片回到「进行中」' : `审批已提交，卡片进入「${COLUMN_LABELS[column]}」`,
    data: { approvalId: approval.id, column, reason: 'approval_resolved' },
  })
}

/**
 * 绑定会话 / 设为主会话（M2 多会话）。
 *
 * 卡片的主会话是 `sessionIds[0]`；三种情况写入不同时间线节点：
 * - 新绑定：`session_linked`「关联了 DSH 会话「X」」，已有主会话时补「设为主会话」；
 * - 已绑定但不是主会话 → `session_primary`「主会话切换为「X」」（携带前后主会话）；
 * - 已经是主会话 → 幂等空操作，不写节点、不刷新卡片（避免重复绑定刷屏）。
 */
export function linkSession(draft, cardId, { sessionId, title, actor = defaultActor('user'), now = nowMs() }) {
  const card = requireCard(draft, cardId)
  const session = requiredText(sessionId, LIMITS.sessionId, 'BAD_REQUEST', '会话 ID 不能为空')
  const previousPrimary = (card.sessionIds || [])[0] ?? null
  const alreadyBound = (card.sessionIds || []).includes(session)
  const label = cleanText(title, 120)
  if (alreadyBound && previousPrimary === session) {
    return { card, activity: null, linked: false, primaryChanged: false, previousPrimary }
  }
  if (alreadyBound) {
    // 设为主会话：不新增绑定，只把该会话挪到第一位并记录切换
    card.sessionIds = [session, ...card.sessionIds.filter(id => id !== session)]
    if (previousPrimary && previousPrimary !== session) {
      bumpCardGeneration(card, { resetBudget: true, clearWatermark: true })
      expireStaleOutboxForCard(draft, card, now)
    }
    const activity = pushActivity(draft, card, {
      type: 'session_primary', actor,
      text: label ? `主会话切换为「${label}」` : '切换了主会话',
      data: { sessionId: session, action: 'primary', previousSessionId: previousPrimary }, at: now,
    })
    touchCard(card, now)
    touchMeta(draft, actor, now)
    return { card, activity, linked: false, primaryChanged: true, previousPrimary }
  }
  // 新绑定：绑定即置顶（有其它会话时同时切换了主会话）
  card.sessionIds = [session, ...card.sessionIds.filter(id => id !== session)].slice(0, LIMITS.sessionIds)
  if (previousPrimary && previousPrimary !== session && isObject(card.runtime)) {
    bumpCardGeneration(card, { resetBudget: true, clearWatermark: true })
  }
  const suffix = previousPrimary ? '，设为主会话' : ''
  const activity = pushActivity(draft, card, {
    type: 'session_linked', actor,
    text: `关联了 DSH 会话${label ? '「' + label + '」' : ''}${suffix}`,
    data: {
      sessionId: session, action: 'link', primary: true,
      ...(previousPrimary ? { previousSessionId: previousPrimary } : {}),
    }, at: now,
  })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity, linked: true, primaryChanged: true, previousPrimary }
}

export function unlinkSession(draft, cardId, { sessionId, actor = defaultActor('user'), now = nowMs() }) {
  const card = requireCard(draft, cardId)
  const session = cleanText(sessionId, LIMITS.sessionId)
  if (!session || !(card.sessionIds || []).includes(session)) throw new DomainError('CONFLICT', '该会话未绑定到卡片', 409)
  card.sessionIds = card.sessionIds.filter(id => id !== session)
  const activity = pushActivity(draft, card, {
    type: 'session_linked', actor, text: '解绑了一个 DSH 会话', data: { sessionId: session, action: 'unlink' }, at: now,
  })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity }
}

// ---------------- 会话运行失败同步（v0.11.0，原 v0.9.6） ----------------

/** 时间线节点 data.kind：会话某一轮开始 / 运行失败 / 恢复运行 / 完成后重开。 */
export const SESSION_TURN_STARTED = 'session_turn_started'
export const SESSION_TURN_REOPENED = 'session_turn_reopened'
export const SESSION_TURN_FAILURE = 'session_turn_failure'
export const SESSION_TURN_RECOVERED = 'session_turn_recovered'

/** 卡片主会话（第一个绑定会话）；只有主会话参与运行失败/恢复同步。 */
export function mainSessionId(card) {
  const ids = Array.isArray(card && card.sessionIds) ? card.sessionIds : []
  return typeof ids[0] === 'string' && ids[0] ? ids[0] : null
}

/** 主会话为指定会话、且未归档的卡片。 */
export function cardsByMainSession(draft, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return []
  return draft.cards.filter(card => !card.archived && mainSessionId(card) === sessionId)
}

function latestStatusActivity(draft, cardId) {
  for (let index = draft.activities.length - 1; index >= 0; index -= 1) {
    const activity = draft.activities[index]
    if (activity.cardId === cardId && activity.type === 'status') return activity
  }
  return null
}

/**
 * 记录会话某一轮运行失败：给主会话为 sessionId 的卡片写 error 节点；
 * 卡片处于「进行中」时自动置为「失败」（进「待你确认」列）。同一卡片同一会话同一轮只记一次。
 * 由宿主 session/event 监听器调用；输入非法时静默返回空结果，不抛错。
 */
export function recordSessionTurnFailure(draft, {
  sessionId, turn, seq, at, message, code, reasonKind = 'error',
} = {}) {
  const session = cleanText(sessionId, LIMITS.sessionId)
  const turnNumber = integer(turn, 0, 0)
  if (!session || turnNumber < 1) return { cards: [], activities: [] }
  const now = Number.isFinite(at) && at > 0 ? at : nowMs()
  const actor = defaultActor('system')
  const label = cleanText(message, 300) || '未知错误'
  const errorCode = cleanText(code, 64)
  const text = `会话第 ${turnNumber} 轮运行失败：${label}${errorCode ? `（${errorCode}）` : ''}`
  const cards = []
  const activities = []
  for (const card of cardsByMainSession(draft, session)) {
    const duplicated = draft.activities.some(activity => activity.cardId === card.id
      && activity.type === 'error'
      && activity.data && activity.data.kind === SESSION_TURN_FAILURE
      && activity.data.sessionId === session
      && activity.data.turn === turnNumber)
    if (duplicated) continue
    const activity = pushActivity(draft, card, {
      type: 'error',
      actor,
      text,
      data: {
        kind: SESSION_TURN_FAILURE,
        sessionId: session,
        turn: turnNumber,
        ...(Number.isInteger(seq) ? { seq } : {}),
        reason: reasonKind,
        ...(errorCode ? { code: errorCode } : {}),
        message: label,
      },
      at: now,
    })
    const statusActivity = card.status === 'running'
      ? changeStatus(draft, card, 'failed', {
        actor,
        now,
        text: '会话运行失败，卡片自动置为「失败」',
        data: { reason: SESSION_TURN_FAILURE, sessionId: session, turn: turnNumber },
      })
      : null
    touchCard(card, now)
    touchMeta(draft, actor, now)
    cards.push(card)
    activities.push(activity)
    if (statusActivity) activities.push(statusActivity)
  }
  return { cards, activities }
}

/**
 * 记录会话恢复运行：主会话为 sessionId、且当前因自动失败标记处于「失败」的卡片回到「进行中」；
 * 时间线保留失败节点，另写一条 progress 节点。手工置为「失败」的卡片不动。
 */
export function recordSessionTurnRecovered(draft, { sessionId, turn, seq, at } = {}) {
  const session = cleanText(sessionId, LIMITS.sessionId)
  const turnNumber = integer(turn, 0, 0)
  if (!session || turnNumber < 1) return { cards: [], activities: [] }
  const now = Number.isFinite(at) && at > 0 ? at : nowMs()
  const actor = defaultActor('system')
  const cards = []
  const activities = []
  for (const card of cardsByMainSession(draft, session)) {
    if (card.status !== 'failed') continue
    const lastStatus = latestStatusActivity(draft, card.id)
    if (!lastStatus || !lastStatus.data || lastStatus.data.reason !== SESSION_TURN_FAILURE) continue
    const activity = pushActivity(draft, card, {
      type: 'progress',
      actor,
      text: `会话已恢复运行（第 ${turnNumber} 轮完成），自动解除「失败」标记`,
      data: {
        kind: SESSION_TURN_RECOVERED,
        sessionId: session,
        turn: turnNumber,
        ...(Number.isInteger(seq) ? { seq } : {}),
      },
      at: now,
    })
    const statusActivity = changeStatus(draft, card, 'running', {
      actor,
      now,
      text: '会话恢复运行，卡片回到「进行中」',
      data: { reason: SESSION_TURN_RECOVERED, sessionId: session, turn: turnNumber },
    })
    touchCard(card, now)
    touchMeta(draft, actor, now)
    cards.push(card)
    activities.push(activity)
    if (statusActivity) activities.push(statusActivity)
  }
  return { cards, activities }
}

/**
 * 记录会话开始新一轮对话（turn/start）：
 * - 主会话为 sessionId 且处于「待办（backlog）」的卡片（若无未完成依赖）自动推进到「进行中（running）」；
 * - 若该会话名下无任何未完成卡片，但有一张近期「已完成（done）」卡片，则自动重开回到「进行中（running）」。
 */
export function recordSessionTurnStart(draft, { sessionId, turn, seq, at } = {}) {
  const session = cleanText(sessionId, LIMITS.sessionId)
  if (!session) return { cards: [], activities: [] }
  const turnNumber = integer(turn, 0, 0)
  const now = Number.isFinite(at) && at > 0 ? at : nowMs()
  const actor = defaultActor('system')
  const relevant = cardsByMainSession(draft, session)
  if (!relevant.length) return { cards: [], activities: [] }
  const byId = new Map((draft.cards || []).map(item => [item.id, item]))
  const hasDependenciesPending = card => Array.isArray(card.dependsOn) && card.dependsOn.some(depId => {
    const dep = byId.get(depId)
    return dep && !TERMINAL_STATUSES.has(dep.status)
  })
  const cards = []
  const activities = []

  // 1) 待办卡片自动推进到进行中
  for (const card of relevant) {
    if (card.status !== 'backlog' || hasDependenciesPending(card)) continue
    const statusActivity = changeStatus(draft, card, 'running', {
      actor,
      now,
      text: '主会话开始执行，卡片自动进入「进行中」',
      data: {
        reason: SESSION_TURN_STARTED,
        sessionId: session,
        ...(turnNumber >= 1 ? { turn: turnNumber } : {}),
        ...(Number.isInteger(seq) ? { seq } : {}),
      },
    })
    touchCard(card, now)
    touchMeta(draft, actor, now)
    cards.push(card)
    if (statusActivity) activities.push(statusActivity)
  }
  if (cards.length) return { cards, activities }

  // 2) 若该主会话当前没有任何未完成卡片，但绑定了已完成的卡片 → 新对话自动重开最近一张 done 卡
  const hasOpen = relevant.some(card => !TERMINAL_STATUSES.has(card.status))
  if (!hasOpen) {
    const latestDone = relevant
      .filter(card => card.status === 'done')
      .sort((a, b) => (b.completedAt ?? b.updatedAt ?? 0) - (a.completedAt ?? a.updatedAt ?? 0))[0]
    if (latestDone) {
      const statusActivity = changeStatus(draft, latestDone, 'running', {
        actor,
        now,
        text: '主会话开启新一轮对话，卡片自动重开回到「进行中」',
        data: {
          reason: SESSION_TURN_REOPENED,
          sessionId: session,
          ...(turnNumber >= 1 ? { turn: turnNumber } : {}),
          ...(Number.isInteger(seq) ? { seq } : {}),
        },
      })
      touchCard(latestDone, now)
      touchMeta(draft, actor, now)
      cards.push(latestDone)
      if (statusActivity) activities.push(statusActivity)
    }
  }
  return { cards, activities }
}

/**
 * M3 会话事件自动填充卡片计量（工具调用数 / 搜索数 / 耗时 / Token）：
 * - 按主会话 sessionId 匹配处于「进行中（running）」的卡片；
 * - 使用 runtime.turnWatermark.lastMeteredTurn 保证同一轮 turn/end 幂等不重复累加。
 */
export function recordSessionTurnMetrics(draft, {
  sessionId,
  turn,
  toolCalls = 0,
  searches = 0,
  elapsedMs = 0,
  tokensIn = 0,
  tokensOut = 0,
  at = nowMs(),
} = {}) {
  const session = cleanText(sessionId, LIMITS.sessionId)
  const turnNum = integer(turn, 0, 0)
  if (!session || turnNum < 1) return { cards: [] }
  const dTools = integer(toolCalls, 0, 0)
  const dSearches = integer(searches, 0, 0)
  const dElapsed = integer(elapsedMs, 0, 0)
  const dIn = integer(tokensIn, 0, 0)
  const dOut = integer(tokensOut, 0, 0)
  if (dTools === 0 && dSearches === 0 && dElapsed === 0 && dIn === 0 && dOut === 0) {
    return { cards: [] }
  }
  const now = Number.isFinite(at) && at > 0 ? at : nowMs()
  const actor = defaultActor('system')
  const cards = []
  for (const card of cardsByMainSession(draft, session)) {
    if (card.status !== 'running') continue
    const runtime = ensureCardRuntime(card)
    if (runtime.turnWatermark?.lastMeteredTurn === turnNum) continue
    runtime.turnWatermark = {
      ...(runtime.turnWatermark || {}),
      sessionId: session,
      turn: Math.max(integer(runtime.turnWatermark?.turn, 0, 0), turnNum),
      lastMeteredTurn: turnNum,
    }
    const meta = isObject(card.metadata) ? { ...card.metadata } : {}
    if (dTools > 0) meta.toolCalls = integer(meta.toolCalls, 0, 0) + dTools
    if (dSearches > 0) meta.searches = integer(meta.searches, 0, 0) + dSearches
    if (dElapsed > 0) meta.elapsedMs = integer(meta.elapsedMs, 0, 0) + dElapsed
    if (dIn > 0) meta.tokensIn = integer(meta.tokensIn, 0, 0) + dIn
    if (dOut > 0) meta.tokensOut = integer(meta.tokensOut, 0, 0) + dOut
    card.metadata = normalizeMetadata(meta)
    touchCard(card, now)
    touchMeta(draft, actor, now)
    cards.push(card)
  }
  return { cards }
}

// ---------------- 会话归档联动（docs/11-session-archive-linkage.md） ----------------

const SETTLED_STATUSES = TERMINAL_STATUSES

/** 卡片对会话归档而言是否已收口：完成/取消，或卡片本身已归档（卡片归档单向，视为不再需要会话）。 */
export function isSettledCard(card) {
  return card?.archived === true || SETTLED_STATUSES.has(card?.status)
}

/** 会话绑定校验：归档/恢复都必须由「绑定了该会话的卡片」发起。 */
export function requireSessionBound(card, sessionId) {
  const session = cleanText(sessionId, LIMITS.sessionId)
  if (!session || !(card.sessionIds || []).includes(session)) {
    throw new DomainError('SESSION_NOT_BOUND', '该会话未绑定到卡片', 409, { sessionId: session })
  }
  return session
}

/**
 * 单卡归档预检（规则 R1/R2/R4）：
 * - 触发卡必须处于 done/canceled；
 * - 会话必须绑定在该卡上；
 * - 常驻 Super-Agent 入口会话（meta.superAgentSessionId）受保护不可归档；
 * - 所有绑定该会话、未归档且未完成的卡片都阻塞归档。
 * @returns {{card: object, sessionId: string, blockingCards: object[]}}
 */
export function sessionArchivePlan(draft, { cardId, sessionId } = {}) {
  const card = requireCard(draft, cardId)
  const session = requireSessionBound(card, sessionId)
  if (getSuperAgentSessionId(draft) && getSuperAgentSessionId(draft) === session) {
    throw new DomainError('SUPER_AGENT_PROTECTED', '常驻 Super Agent 入口会话受保护，不可归档', 409, { sessionId: session })
  }
  if (!SETTLED_STATUSES.has(card.status)) {
    throw new DomainError('CARD_NOT_DONE', '只有已完成或已取消的卡片可以归档会话', 409, { cardId: card.id })
  }
  const blockingCards = draft.cards
    .filter(item => item.id !== card.id && !item.archived && (item.sessionIds || []).includes(session) && !SETTLED_STATUSES.has(item.status))
    .map(item => ({ id: item.id, title: item.title, status: item.status }))
  if (blockingCards.length) {
    throw new DomainError(
      'SESSION_BUSY_CARDS',
      `该会话还关联 ${blockingCards.length} 张未完成卡片：${blockingCards.map(item => item.title).join('、')}`,
      409,
      { sessionId: session, blockingCards },
    )
  }
  return { card, sessionId: session, blockingCards: [] }
}

/** 写会话归档/恢复活动（会同时 touch 卡片版本与看板元数据）。 */
export function appendSessionArchiveActivity(draft, cardId, {
  sessionId,
  unarchive = false,
  auto = false,
  autoDays,
  actor = defaultActor('user'),
  now = nowMs(),
} = {}) {
  const card = findCard(draft, cardId, { includeArchived: true })
  if (!card) throw new DomainError('CARD_NOT_FOUND', '卡片不存在或已归档', 404)
  const session = cleanText(sessionId, LIMITS.sessionId)
  const days = Number.isFinite(autoDays) && autoDays > 0 ? Math.floor(autoDays) : undefined
  const text = unarchive
    ? `恢复了会话${auto ? '（自动恢复）' : ''}`
    : auto
      ? `自动归档了会话（卡片已完成超过 ${days ?? '若干'} 天）`
      : '归档了会话，可在卡片详情恢复'
  const activity = pushActivity(draft, card, {
    type: unarchive ? 'session_unarchived' : 'session_archived',
    actor,
    text,
    data: { sessionId: session, ...(auto ? { auto: true, ...(days !== undefined ? { autoDays: days } : {}) } : {}) },
    at: now,
  })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity }
}

/**
 * 批量归档预检：按「已完成卡片 → 其绑定会话」聚合，逐会话做与单卡一致的判定。
 * 只产出计划，不调用宿主；运行中/待确认由宿主活动检查在执行阶段拦截并回填 skipped。
 * @param {object} draft 数据快照/草稿
 * @param {{archivedSessionIds?: string[], cardIds?: string[], completedBefore?: number}} [options]
 *   cardIds 限定触发卡（完成列批量）；completedBefore 只取 completedAt 不晚于该时间的卡（自动归档）。
 * @returns {{archivable: Array<{sessionId:string, cardId:string, cardIds:string[]}>, skipped: object[]}}
 */
export function batchSessionArchivePlan(draft, { archivedSessionIds = [], cardIds, completedBefore } = {}) {
  const archived = new Set((Array.isArray(archivedSessionIds) ? archivedSessionIds : []).map(String))
  const allowedCards = Array.isArray(cardIds) ? new Set(cardIds.map(String)) : null
  const triggers = draft.cards.filter(card => !card.archived
    && SETTLED_STATUSES.has(card.status)
    && (allowedCards === null || allowedCards.has(card.id))
    && (completedBefore === undefined || Number(card.completedAt ?? 0) <= completedBefore))
  const candidates = new Map()
  for (const card of triggers) {
    for (const sessionId of card.sessionIds || []) {
      const existing = candidates.get(sessionId)
      if (existing) { existing.cardIds.add(card.id); continue }
      candidates.set(sessionId, { cardId: card.id, cardIds: new Set([card.id]) })
    }
  }
  const superAgentSess = getSuperAgentSessionId(draft)
  const archivable = []
  const skipped = []
  for (const [sessionId, entry] of candidates) {
    const cardIdsOfSession = [...entry.cardIds]
    if (superAgentSess && sessionId === superAgentSess) {
      skipped.push({ sessionId, cardId: entry.cardId, cardIds: cardIdsOfSession, reason: 'super_agent_protected' })
      continue
    }
    if (archived.has(sessionId)) {
      skipped.push({ sessionId, cardId: entry.cardId, cardIds: cardIdsOfSession, reason: 'already_archived' })
      continue
    }
    const blockingCards = draft.cards
      .filter(card => !card.archived && (card.sessionIds || []).includes(sessionId) && !SETTLED_STATUSES.has(card.status))
      .map(card => ({ id: card.id, title: card.title, status: card.status }))
    if (blockingCards.length) {
      skipped.push({ sessionId, cardId: entry.cardId, cardIds: cardIdsOfSession, reason: 'blocking_cards', blockingCards })
      continue
    }
    archivable.push({ sessionId, cardId: entry.cardId, cardIds: cardIdsOfSession })
  }
  const byId = (left, right) => (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)
  archivable.sort(byId)
  skipped.sort(byId)
  return { archivable, skipped }
}

export function ackCard(draft, cardId, { actor = defaultActor('user'), now = nowMs() } = {}) {
  const card = requireCard(draft, cardId)
  const activity = pushActivity(draft, card, { type: 'ack', actor, text: '已读卡片动态', at: now })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity }
}

export function completeCard(draft, cardId, { result, actor = defaultActor('agent'), now = nowMs(), forceComplete = false, strictChecklists = false } = {}) {
  const card = requireCard(draft, cardId)
  const activities = []
  // 完成拦截：有未收口直接子卡（或 strictChecklists 下有未完成检查项）时默认 409；forceComplete=true 放行并补审计节点。
  const openChildren = completionGuard(draft, card, forceComplete, { strictChecklists })
  const openChecklists = strictChecklists ? openChecklistItems(card) : []
  if (result !== undefined && result !== null) {
    const text = cleanText(result, LIMITS.result)
    if (text) card.result = text
  }
  const statusActivity = changeStatus(draft, card, 'done', { actor, now, text: '完成了卡片' })
  if (statusActivity) activities.push(statusActivity)
  if (openChildren.length || openChecklists.length) {
    activities.push(pushForceCompleteActivity(draft, card, openChildren, { actor, now, openChecklists }))
  }
  activities.push(pushActivity(draft, card, {
    type: 'result', actor, text: card.result || '完成，无补充说明', data: { completedAt: now }, at: now,
  }))
  touchCard(card, now)
  touchMeta(draft, actor, now)

  // 计算父卡是否因本子卡完成而全部子卡收口就绪
  let parentReady = null
  if (card.parentCardId) {
    const parent = findCard(draft, card.parentCardId)
    if (parent && !TERMINAL_STATUSES.has(parent.status) && openDirectChildren(draft, parent.id).length === 0) {
      const totalChildren = directChildren(draft, parent.id).length
      parentReady = {
        id: parent.id,
        title: parent.title,
        status: parent.status,
        totalChildren,
        sessionIds: parent.sessionIds || [],
      }
    }
  }

  // 计算因本卡完成而全部前置依赖就绪的下游卡片
  const byId = new Map((draft.cards || []).map(item => [item.id, item]))
  const wokenDependents = (draft.cards || [])
    .filter(item => !item.archived
      && !TERMINAL_STATUSES.has(item.status)
      && Array.isArray(item.dependsOn)
      && item.dependsOn.includes(card.id)
      && item.dependsOn.every(depId => {
        const dep = byId.get(depId)
        return dep && TERMINAL_STATUSES.has(dep.status)
      }))
    .map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      sessionIds: item.sessionIds || [],
    }))

  return { card, activities, parentReady, wokenDependents }
}

export function archiveCard(draft, cardId, { actor = defaultActor('user'), now = nowMs(), reason, text } = {}) {
  const card = requireCard(draft, cardId)
  const board = findBoard(draft, card.boardId)
  const cardContext = decisionCardContext(card)
  card.archived = true
  card.archivedAt = now
  card.updatedAt = now
  if (board) {
    rebuildOrder(board)
    for (const column of COLUMNS) board.cardOrder[column] = board.cardOrder[column].filter(id => id !== card.id)
    board.updatedAt = now
  }
  // 卡片归档 = 未提交审批的最终结局：置 dismissed 并记一条未决事件，避免永远 pending。
  closePendingApprovals(draft, card, { reason: 'archived', actor, now, context: cardContext })
  const trimmedReason = cleanText(reason, 200)
  const activity = pushActivity(draft, card, {
    type: 'archived', actor,
    text: text || (trimmedReason ? `归档了卡片：${trimmedReason}` : '归档了卡片'),
    data: { archived: true, archivedAt: now, ...(trimmedReason ? { reason: trimmedReason } : {}) },
    at: now,
  })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity }
}

/**
 * 恢复归档卡片（v0.22.0）：回到原状态所在列的列尾，写一条 unarchived 时间线。
 * 只有已归档的卡片能恢复；未归档抛 CONFLICT(409)，不存在抛 CARD_NOT_FOUND(404)。
 */
export function unarchiveCard(draft, cardId, { actor = defaultActor('user'), now = nowMs() } = {}) {
  const card = findCardAny(draft, cardId)
  if (!card) throw new DomainError('CARD_NOT_FOUND', '卡片不存在', 404)
  if (card.archived !== true) throw new DomainError('CONFLICT', '卡片未归档', 409)
  card.archived = false
  delete card.archivedAt
  const board = findBoard(draft, card.boardId)
  if (board) {
    if (!isObject(board.cardOrder)) board.cardOrder = emptyCardOrder()
    for (const column of COLUMNS) {
      if (!Array.isArray(board.cardOrder[column])) board.cardOrder[column] = []
      board.cardOrder[column] = board.cardOrder[column].filter(id => id !== card.id)
    }
    // 恢复的卡片回到原状态所在列的列尾，避免抢占用户手工排好的列头。
    board.cardOrder[COLUMN_OF_STATUS[card.status] || 'backlog'].push(card.id)
    board.updatedAt = now
  }
  const activity = pushActivity(draft, card, { type: 'unarchived', actor, text: '恢复了归档卡片', at: now })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity }
}

function normalizeBatchCardIds(cardIds) {
  if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > LIMITS.batchCards) {
    throw new DomainError('BAD_REQUEST', `cardIds 需要 1-${LIMITS.batchCards} 个卡片 ID`)
  }
  const ids = []
  for (const value of cardIds) {
    const id = cleanText(value, 40)
    if (id && !ids.includes(id)) ids.push(id)
  }
  if (!ids.length) throw new DomainError('BAD_REQUEST', 'cardIds 不能为空')
  return ids
}

/**
 * 批量归档（v0.22.0）：跳过不存在/已归档的卡片，以及仍有未收口子卡的卡片（skipped 带原因）；
 * 其余归档。返回 {cards, skipped}；dryRun=true 时只产出 wouldArchive 计划、不写数据。
 */
export function archiveCards(draft, cardIds, { actor = defaultActor('user'), now = nowMs(), reason, dryRun = false } = {}) {
  const ids = normalizeBatchCardIds(cardIds)
  const byId = new Map(draft.cards.map(card => [card.id, card]))
  const cards = []
  const wouldArchive = []
  // dryRun 不落库但按入参顺序模拟「前面几张归档后，后面的父卡就能归档」，报告与真跑一致。
  const plannedArchived = new Set()
  const skipped = []
  for (const id of ids) {
    const card = byId.get(id)
    if (!card) { skipped.push({ id, reason: 'not_found' }); continue }
    if (card.archived) { skipped.push({ id, reason: 'archived' }); continue }
    const openChildren = openDirectChildren(draft, id).filter(child => !plannedArchived.has(child.id))
    if (openChildren.length) {
      skipped.push({ id, reason: 'has_open_children', openChildren: openChildren.map(relationCardBrief) })
      continue
    }
    if (dryRun) { plannedArchived.add(card.id); wouldArchive.push({ id: card.id, title: card.title }); continue }
    cards.push(archiveCard(draft, id, { actor, now, reason }).card)
  }
  return { cards, skipped, ...(dryRun ? { dryRun: true, wouldArchive } : {}) }
}

/** 兼容旧名（v0.21 及之前的调用方与测试）。 */
export const batchArchive = archiveCards

/**
 * 批量恢复归档卡片（v0.22.0）：逐张 unarchiveCard；不存在/未归档进 skipped。
 * 返回 {cards, skipped}；dryRun=true 时只产出 wouldRestore 计划、不写数据。
 */
export function restoreCards(draft, cardIds, { actor = defaultActor('user'), now = nowMs(), dryRun = false } = {}) {
  const ids = normalizeBatchCardIds(cardIds)
  const cards = []
  const wouldRestore = []
  const skipped = []
  for (const id of ids) {
    const card = findCardAny(draft, id)
    if (!card) { skipped.push({ id, reason: 'not_found' }); continue }
    if (card.archived !== true) { skipped.push({ id, reason: 'not_archived' }); continue }
    if (dryRun) { wouldRestore.push({ id: card.id, title: card.title }); continue }
    cards.push(unarchiveCard(draft, id, { actor, now }).card)
  }
  return { cards, skipped, ...(dryRun ? { dryRun: true, wouldRestore } : {}) }
}

/**
 * 合并两张卡片（v0.22.0 收敛去重）：源的子卡改挂 target、全盘 dependsOn 重指 target、
 * 源会话并入 target、源摘要追加到 target 摘要，然后归档源卡并记 mergedInto=targetId。
 * 源卡有未收口子卡时拒绝；dryRun=true 时只做校验与「将发生什么」的报告，不写数据。
 */
export function mergeCards(draft, sourceId, targetId, { actor = defaultActor('agent'), now = nowMs(), title, dryRun = false } = {}) {
  if (sourceId === targetId) throw new DomainError('BAD_REQUEST', '不能把卡片合并到自己')
  const source = requireCard(draft, sourceId)
  const target = requireCard(draft, targetId)
  if (source.boardId !== target.boardId) throw new DomainError('BAD_REQUEST', '只能在同一看板内合并卡片')
  const openChildren = openDirectChildren(draft, source.id)
  if (openChildren.length) {
    throw new DomainError('CARD_HAS_OPEN_CHILDREN', `源卡还有 ${openChildren.length} 张未收口子卡，先收口再合并`, 409, {
      openChildren: openChildren.map(relationCardBrief),
    })
  }
  const children = directChildren(draft, source.id).filter(child => child.id !== target.id)
  const repointedCards = draft.cards.filter(card => Array.isArray(card.dependsOn) && card.dependsOn.includes(source.id))
  const movedSessionIds = (source.sessionIds || []).filter(id => !(target.sessionIds || []).includes(id))
  const mergedSessionIds = []
  for (const sessionId of [...(source.sessionIds || []), ...(target.sessionIds || [])]) {
    if (sessionId && !mergedSessionIds.includes(sessionId)) mergedSessionIds.push(sessionId)
    if (mergedSessionIds.length >= LIMITS.sessionIds) break
  }
  const nextTitle = cleanText(title, LIMITS.title)
  if (title !== undefined && title !== null && typeof title !== 'string') {
    throw new DomainError('BAD_REQUEST', 'title 必须是字符串')
  }
  const appendSummary = Boolean(source.summary)
  if (dryRun) {
    const warnings = []
    if (children.length) warnings.push(`源卡有 ${children.length} 张子卡将改挂到目标卡`)
    if (movedSessionIds.length) warnings.push(`源卡有 ${movedSessionIds.length} 个会话将并入目标卡`)
    if (appendSummary) warnings.push('目标卡摘要将追加源卡摘要')
    if (nextTitle) warnings.push(`目标卡标题将改为「${nextTitle}」`)
    if (!cleanText(target.cwd, 1000) && cleanText(source.cwd, 1000)) warnings.push('目标卡将继承源卡执行目录 cwd')
    if (!cleanText(target.workspaceId, LIMITS.sessionId) && cleanText(source.workspaceId, LIMITS.sessionId)) warnings.push('目标卡将继承源卡工作区')
    return {
      dryRun: true,
      source: { id: source.id, title: source.title },
      target: { id: target.id, title: target.title },
      willMoveChildren: children.length,
      willRepointDependsOn: repointedCards.length,
      willMoveSessions: movedSessionIds.length,
      willAppendSummary: appendSummary,
      warnings,
    }
  }
  const movedChildren = []
  for (const child of children) {
    child.parentCardId = target.id
    touchCard(child, now)
    movedChildren.push(relationCardBrief(child))
  }
  // 边界：target 原本挂在 source 下时，合并后不能把 target 设成自己的父卡，改为继承 source 的父卡。
  if (target.parentCardId === source.id) {
    if (source.parentCardId) target.parentCardId = source.parentCardId
    else delete target.parentCardId
  }
  const repointedDependsOn = []
  for (const card of repointedCards) {
    const next = []
    for (const id of card.dependsOn) {
      const mapped = id === source.id ? target.id : id
      if (mapped === card.id || next.includes(mapped)) continue
      next.push(mapped)
    }
    card.dependsOn = next.slice(0, LIMITS.dependsOn)
    touchCard(card, now)
    repointedDependsOn.push(card.id)
  }
  target.sessionIds = mergedSessionIds
  // 摘要/结果合并：源摘要追加到 target（截断到上限），target 未填结果时补上源结果。
  if (appendSummary) {
    const note = `合并自卡片「${source.title}」：${source.summary}`
    target.summary = cleanText(target.summary ? `${target.summary}\n${note}` : note, LIMITS.summary)
  }
  if (!cleanText(target.result, LIMITS.result) && cleanText(source.result, LIMITS.result)) {
    target.result = cleanText(source.result, LIMITS.result)
  }
  if (nextTitle) target.title = nextTitle
  // v0.22.1：合并继承执行上下文——target 为空时从源卡补 cwd/workspaceId/project（不覆盖已有值）。
  if (!cleanText(target.cwd, 1000) && cleanText(source.cwd, 1000)) target.cwd = source.cwd
  if (!cleanText(target.workspaceId, LIMITS.sessionId) && cleanText(source.workspaceId, LIMITS.sessionId)) target.workspaceId = source.workspaceId
  if (!cleanText(target.project, LIMITS.boardName) && cleanText(source.project, LIMITS.boardName)) target.project = source.project
  const mergeText = cleanText(`合并了卡片「${source.title}」${source.summary ? '；摘要已并入' : ''}`, LIMITS.activityText)
  const activity = pushActivity(draft, target, {
    type: 'progress',
    actor,
    text: mergeText,
    data: {
      mergedFrom: source.id,
      mergedFromTitle: source.title,
      ...(source.summary ? { summary: source.summary } : {}),
      ...(source.result ? { result: source.result } : {}),
    },
    at: now,
  })
  touchCard(target, now)
  // 源卡：先记 mergedInto，再走 archiveCard 的归档字段/审计节点（不重复写归档节点）。
  source.mergedInto = target.id
  const archived = archiveCard(draft, source.id, {
    actor, now, text: `合并到卡片「${target.title}」并归档`,
  })
  return {
    source: archived.card,
    target,
    activity,
    movedChildren,
    repointedDependsOn,
  }
}

/** 批量移动：代表 status + 插入目标列头部 + status 活动；跳过不存在/已归档的卡片。 */
export function batchMove(draft, cardIds, column, { actor = defaultActor('user'), now = nowMs() } = {}) {
  const ids = normalizeBatchCardIds(cardIds)
  const targetColumn = normalizeColumn(column)
  const targetStatus = STATUS_OF_COLUMN[targetColumn]
  const byId = new Map(draft.cards.map(card => [card.id, card]))
  const cards = []
  const skipped = []
  // 倒序插入列头，保证批量结果与入参顺序一致。
  for (const id of [...ids].reverse()) {
    const card = byId.get(id)
    if (!card) { skipped.push({ id, reason: 'not_found' }); continue }
    if (card.archived) { skipped.push({ id, reason: 'archived' }); continue }
    const board = findBoard(draft, card.boardId)
    const fromStatus = card.status
    const leavingNeedsYou = COLUMN_OF_STATUS[fromStatus] === 'needs_you' && targetColumn !== 'needs_you'
    const cardContext = leavingNeedsYou ? decisionCardContext(card) : null
    applyStatusFields(card, targetStatus, now)
    moveInOrder(board, card, targetColumn)
    if (leavingNeedsYou) closePendingApprovals(draft, card, { reason: 'left_needs_you', actor, now, context: cardContext })
    pushActivity(draft, card, {
      type: 'status', actor, text: `把卡片移到「${COLUMN_LABELS[targetColumn]}」`,
      data: { column: targetColumn, status: targetStatus, batch: true }, at: now,
    })
    if (targetStatus !== fromStatus) afterStatusChange(draft, card, fromStatus, targetStatus, { actor, now })
    touchCard(card, now)
    board.updatedAt = now
    cards.push(card)
  }
  cards.sort((left, right) => ids.indexOf(left.id) - ids.indexOf(right.id))
  touchMeta(draft, actor, now)
  return { cards, skipped }
}

/** 自动归档候选：done/canceled 且 completedAt 早于 now - days，或已标记 mergedInto 但未归档的历史卡片。 */
export function autoArchiveCandidates(cards, { days = 3, now = nowMs() } = {}) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  if (!safeDays) return []
  const cutoff = now - safeDays * 86_400_000
  return cards.filter(card => !card.archived
    && (
      Boolean(card.mergedInto)
      || (
        (card.status === 'done' || card.status === 'canceled')
        && Number.isFinite(card.completedAt)
        && card.completedAt <= cutoff
      )
    ))
}

/** 已完成自动归档；返回归档数量（供插件定时任务记录日志）。 */
export function autoArchiveCompleted(draft, { days = 3, now = nowMs() } = {}) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  if (!safeDays) return 0
  const candidates = autoArchiveCandidates(draft.cards, { days: safeDays, now })
  const system = defaultActor('system')
  for (const card of candidates) {
    const text = card.mergedInto
      ? `自动归档：已合并到 ${card.mergedInto}`
      : `自动归档：已完成超过 ${safeDays} 天`
    archiveCard(draft, card.id, { actor: system, now, text })
  }
  return candidates.length
}

// ---------------- 收敛巡检与 Fast-Path 建卡准入守卫（v0.22.0+） ----------------

/** 疑似重复标题的规范化：去空白与常见标点、转小写，用于互为前缀/相等的粗判。 */
export function normalizeTitleForDuplicate(title) {
  return cleanText(title, LIMITS.title).toLowerCase().replace(/[\s\-_·:：,，.。/\\|、（）()\[\]【】"'“”‘’!！?？]+/g, '')
}

/**
 * 建卡 Fast-Path 准入守卫：防止同名重复建卡、同会话刚完成卡片追问重复建卡、以及单会话卡片无限制爆炸。
 * - forceNew:true 时跳过守卫，允许强制新建；
 * - 返回 null 表示允许正常新建；返回 { kind, card, ... } 表示命中收敛复用。
 */
export function findConvergentCardForCreate(draft, input = {}, { sessionId = null, now = nowMs() } = {}) {
  if (!draft || !Array.isArray(draft.cards) || input.forceNew === true) return null
  const boardId = cleanText(input.boardId, 120) || DEFAULT_BOARD_ID
  const titleKey = normalizeTitleForDuplicate(input.title)
  const targetSessionId = cleanText(input.sessionId, LIMITS.sessionId) || cleanText(sessionId, LIMITS.sessionId) || null
  const inputProject = cleanText(input.project, LIMITS.boardName)
  const inputCwd = cleanText(input.cwd, 1000)

  const boardCards = draft.cards.filter(card => card.boardId === boardId && !card.archived)

  if (titleKey.length >= 2) {
    // 1) 同名未完成卡片去重复用（同会话 或 同目录/同项目）
    const duplicateOpen = boardCards.find(card => {
      if (isTerminalCardStatus(card.status)) return false
      if (normalizeTitleForDuplicate(card.title) !== titleKey) return false
      const sameSession = Boolean(targetSessionId && (card.sessionIds || []).includes(targetSessionId))
      const sameCwd = Boolean(inputCwd && card.cwd && inputCwd === card.cwd)
      const sameProject = Boolean(inputProject && card.project && inputProject === card.project)
      const bothUnscoped = !targetSessionId && !inputCwd && !inputProject && !(card.sessionIds || []).length && !card.cwd && !card.project
      return sameSession || sameCwd || sameProject || bothUnscoped
    })
    if (duplicateOpen) return { kind: 'duplicate_open', card: duplicateOpen }

    // 2) 同会话 24 小时内刚完成的同名卡片：追问/返工自动重开原卡
    if (targetSessionId) {
      const recentDone = boardCards.find(card => {
        if (card.status !== 'done') return false
        if (!(card.sessionIds || []).includes(targetSessionId)) return false
        if (normalizeTitleForDuplicate(card.title) !== titleKey) return false
        const finishedAt = card.completedAt ?? card.updatedAt ?? 0
        return now - finishedAt <= 86_400_000
      })
      if (recentDone) return { kind: 'reopen_recent_done', card: recentDone }
    }
  }

  // 3) 单会话未收口卡片硬上限保护（≥8 张未收口且未显式指定 parentCardId 时，自动收敛为主卡 checklist）
  if (targetSessionId && input.parentCardId === undefined) {
    const bound = boardCards.filter(card => (card.sessionIds || []).includes(targetSessionId))
    const running = bound.filter(card => card.status === 'running')
    const open = bound.filter(card => card.status === 'running' || card.status === 'backlog')
    if (open.length >= 8) {
      const primary = running[0] || open[0]
      if (primary && (primary.checklists || []).length < LIMITS.checklists) {
        return {
          kind: 'wip_cap_checklist',
          card: primary,
          openCount: open.length,
          runningCount: running.length,
        }
      }
    }
  }
  return null
}

/** 疑似重复卡的最小标题长度（规范化后）。 */
const DUPLICATE_MIN_TITLE = 8

/**
 * 收敛巡检（只读，不写 store）：产出陈旧待办、已完成未归档、疑似重复、会话多开、
 * 无执行目录卡片与人话建议，供 agent 判断该收口/合并/归档哪些卡。
 * @param {object} data 数据快照（store.read/snapshot 的 data）
 * @param {{boardId?: string, staleDays?: number, limit?: number, now?: number}} [options]
 */
export function reviewBoard(data, { boardId, staleDays = 7, limit = 20, now = nowMs() } = {}) {
  const board = requireBoard(data, boardId)
  const day = 86_400_000
  const safeDays = integer(staleDays, 7, 1, 365)
  const safeLimit = integer(limit, 20, 1, 100)
  const cards = (data.cards || []).filter(card => card.boardId === board.id && !card.archived)
  const ageDays = at => Math.max(0, Math.floor((now - integer(at, now, 0)) / day))

  const staleBacklog = cards
    .filter(card => card.status === 'backlog' && now - card.updatedAt > safeDays * day)
    .sort((left, right) => left.updatedAt - right.updatedAt)
  const staleSamples = staleBacklog.slice(0, safeLimit).map(card => ({
    id: card.id,
    title: card.title,
    ...(card.project ? { project: card.project } : {}),
    ageDays: ageDays(card.updatedAt),
    sessionCount: (card.sessionIds || []).length,
  }))

  const doneCards = cards.filter(card => card.status === 'done' || card.status === 'canceled')
  const doneAges = doneCards.map(card => ageDays(card.completedAt ?? card.updatedAt)).sort((left, right) => right - left)
  const doneNotArchived = {
    count: doneCards.length,
    oldestAgeDays: doneAges[0] ?? 0,
    sample: doneCards
      .slice()
      .sort((left, right) => (left.completedAt ?? left.updatedAt) - (right.completedAt ?? right.updatedAt))
      .slice(0, safeLimit)
      .map(card => ({ id: card.id, title: card.title, ageDays: ageDays(card.completedAt ?? card.updatedAt) })),
  }

  // 疑似重复：同看板、未归档、标题规范化后互为前缀/相等，较短者 ≥8 字；同 project/cwd 的组优先。
  const entries = cards
    .map(card => ({ card, key: normalizeTitleForDuplicate(card.title) }))
    .filter(entry => entry.key.length >= DUPLICATE_MIN_TITLE)
  const used = new Set()
  const groups = []
  for (let index = 0; index < entries.length; index += 1) {
    const left = entries[index]
    if (used.has(left.card.id)) continue
    const members = [left]
    for (let scan = index + 1; scan < entries.length; scan += 1) {
      const right = entries[scan]
      if (used.has(right.card.id)) continue
      const shorter = left.key.length <= right.key.length ? left.key : right.key
      const longer = shorter === left.key ? right.key : left.key
      if (!longer.startsWith(shorter)) continue
      members.push(right)
    }
    if (members.length < 2) continue
    for (const member of members) used.add(member.card.id)
    const sameProject = members.every(member => (member.card.project || '') === (members[0].card.project || ''))
    const sameCwd = members.every(member => (member.card.cwd || '') === (members[0].card.cwd || ''))
    groups.push({
      cardIds: members.map(member => member.card.id),
      titles: members.map(member => member.card.title),
      reason: sameProject && sameCwd ? '标题高度相似（同项目/同目录）' : sameProject ? '标题高度相似（同项目）' : sameCwd ? '标题高度相似（同目录）' : '标题高度相似',
    })
  }
  const duplicateCandidates = groups
    .sort((left, right) => {
      const weight = group => (group.reason.includes('同项目') ? 1 : 0) + (group.reason.includes('同目录') ? 1 : 0)
      return weight(right) - weight(left) || right.cardIds.length - left.cardIds.length
    })
    .slice(0, safeLimit)

  const runningBySession = new Map()
  for (const card of cards) {
    if (card.status !== 'running') continue
    for (const sessionId of card.sessionIds || []) {
      const list = runningBySession.get(sessionId) || []
      list.push({ id: card.id, title: card.title })
      runningBySession.set(sessionId, list)
    }
  }
  const sessionWip = [...runningBySession.entries()]
    .filter(([, runningCards]) => runningCards.length > 1)
    .map(([sessionId, runningCards]) => ({ sessionId, count: runningCards.length, runningCards }))
    .sort((left, right) => right.count - left.count)
    .slice(0, safeLimit)

  const orphanCards = cards.filter(card => !cleanText(card.cwd, 1000))
  const orphans = {
    count: orphanCards.length,
    sample: orphanCards.slice(0, safeLimit).map(card => ({ id: card.id, title: card.title, status: card.status })),
  }

  const suggestions = []
  if (staleBacklog.length) suggestions.push(`有 ${staleBacklog.length} 张待办超过 ${safeDays} 天没更新，建议归档、拆分或降低优先级`)
  if (doneNotArchived.count) suggestions.push(`有 ${doneNotArchived.count} 张已完成卡片未归档（最久 ${doneNotArchived.oldestAgeDays} 天），可用 kanban_archive_cards 批量归档`)
  if (duplicateCandidates.length) suggestions.push(`发现 ${duplicateCandidates.length} 组标题高度相似的卡片，确认是同一交付物后用 kanban_merge_cards 合并`)
  if (sessionWip.length) suggestions.push(`${sessionWip.length} 个会话同时挂着多张进行中卡片，建议先收口再开新卡`)
  if (orphans.count) suggestions.push(`有 ${orphans.count} 张卡片没有执行目录（cwd），建议补充目录或归档`)
  if (!suggestions.length) suggestions.push('看板状态健康：没有明显的陈旧、重复或堆积卡片')
  return {
    ok: true,
    boardId: board.id,
    boardName: board.name,
    generatedAt: now,
    staleDays: safeDays,
    staleBacklog: staleSamples,
    staleBacklogTotal: staleBacklog.length,
    doneNotArchived,
    duplicateCandidates,
    sessionWip,
    orphans,
    suggestions,
  }
}

// ---------------- 种子数据 ----------------

function demoActivity(cardId, type, actor, text, at, data) {
  return {
    id: newActivityId(), cardId, type, actor: normalizeActor(actor), text: cleanText(text, LIMITS.activityText), at,
    ...(data ? { data } : {}),
  }
}

/** 默认看板 + 演示卡片；覆盖 running/needs_you/blocked/failed/done/backlog 各形态。 */
export function createSeed(mode = 'demo', now = nowMs()) {
  const board = newBoard({ id: DEFAULT_BOARD_ID, name: 'DSH 看板', description: '以卡片为控制面、以 DSH 会话为执行面的任务看板', now })
  const meta = { createdAt: now - 4 * 3600_000, updatedAt: now, revision: 1, seededAt: now, lastActor: { kind: 'system', name: 'system' } }
  if (mode !== 'demo') return { schemaVersion: SCHEMA_VERSION, boards: [board], cards: [], activities: [], meta }
  const agent = { kind: 'agent', name: 'DSH Agent' }
  const user = { kind: 'user', name: '你' }
  const minute = 60_000
  const cardId = newCardId
  const runningId = cardId()
  const approveId = cardId()
  const blockedId = cardId()
  const doneId = cardId()
  const backlogId = cardId()
  const failedId = cardId()
  const multiId = cardId()
  const reviewId = cardId()
  // 多问题审批示例：第 1 题单选、第 2 题多选、第 3 题单选。
  const reviewQuestions = [
    {
      id: newQuestionId(), header: '发布窗口', question: '选择本次发布窗口', multiSelect: false,
      options: [
        { id: 'today', label: '今天 22:00', description: '低峰期发布', tone: 'primary' },
        { id: 'tomorrow', label: '明天 10:00', description: '留出修复时间' },
        { id: 'hold', label: '暂缓发布', tone: 'danger' },
      ],
    },
    {
      id: newQuestionId(), header: '发布检查', question: '本次发布要带哪些检查项？', multiSelect: true,
      options: [
        { id: 'unit-test', label: '单元测试', description: 'npm test 全绿' },
        { id: 'build', label: '构建', description: 'web/dist 构建通过' },
        { id: 'device', label: '真实设备', description: '真机验证' },
        { id: 'docs', label: '文档', description: 'README 与契约同步' },
      ],
    },
    {
      id: newQuestionId(), header: '回滚方案', question: '回滚方案是否已就绪？', multiSelect: false,
      options: [
        { id: 'ready', label: '已就绪', description: '演练过回滚', tone: 'primary' },
        { id: 'no', label: '未就绪', tone: 'danger' },
      ],
    },
  ]
  const cards = [
    {
      id: runningId, boardId: board.id, title: '实现看板卡片与会话绑定',
      summary: '把卡片主会话的选择、发送、回写串起来，保证 UI 与 DSH 会话一致',
      currentAction: '正在实现 lib/routes.js 的 SSE 广播与同源校验',
      status: 'running', priority: 'high', labels: ['mvp', 'server', '示例'], project: 'dsh-kanban',
      agent: { name: 'DSH Agent' },
      progress: { step: 3, total: 5, percent: 60, text: '服务端 API 与工具' },
      sessionIds: [],
      checklists: [
        { id: newChecklistId(), text: '读数据模型与 HTTP 契约', done: true },
        { id: newChecklistId(), text: '实现 store 与 domain', done: true },
        { id: newChecklistId(), text: '实现 routes 与 SSE', done: true },
        { id: newChecklistId(), text: '补齐测试并跑通冒烟', done: false },
      ],
      approvals: [], artifacts: [], metadata: { toolCalls: 18, searches: 3, elapsedMs: 190_000 },
      order: 1, version: 4, createdAt: now - 180 * minute, updatedAt: now - 6 * minute, startedAt: now - 170 * minute,
    },
    {
      id: approveId, boardId: board.id, title: '确认演示数据的默认看板命名',
      summary: '默认看板叫「DSH 看板」还是「我的看板」，会影响首次启动体验',
      status: 'needs_you', priority: 'urgent', labels: ['design', 'decision', '示例'], project: 'dsh-kanban',
      agent: { name: 'DSH Agent' },
      sessionIds: [],
      checklists: [], artifacts: [], metadata: { toolCalls: 6, searches: 1 },
      approvals: [{
        id: newApprovalId(),
        title: '默认看板采用哪个名称？',
        detail: '首次启动（data.json 不存在）时会创建默认看板。名称只在初始化时写入，之后可在设置里重命名。选「DSH 看板」与插件名保持一致，便于识别；选「我的看板」更像个人工作台。',
        multiSelect: false,
        options: [
          { id: 'dsh', label: 'DSH 看板', description: '与插件名一致，推荐', tone: 'primary' },
          { id: 'mine', label: '我的看板', description: '更个人化的命名', tone: 'ghost' },
        ],
        status: 'pending', requestedBy: agent, requestedAt: now - 32 * minute,
      }],
      order: 2, version: 3, createdAt: now - 150 * minute, updatedAt: now - 32 * minute, startedAt: now - 150 * minute,
    },
    {
      id: blockedId, boardId: board.id, title: '接入 DSH 客户端桥发送消息',
      summary: '示例：演示「受阻」状态（对应能力已在 v0.2.1 完成）',
      currentAction: '示例：等待上游接口确认（演示受阻状态）',
      status: 'blocked', priority: 'high', labels: ['client', 'blocked', '示例'], project: 'dsh-kanban',
      agent: { name: 'DSH Agent' }, sessionIds: [],
      checklists: [], artifacts: [], metadata: { toolCalls: 9, searches: 2 },
      order: 3, version: 2, createdAt: now - 140 * minute, updatedAt: now - 40 * minute, startedAt: now - 128 * minute,
    },
    {
      id: failedId, boardId: board.id, title: '首版拖拽排序动画',
      summary: '尝试用 FLIP 动画做拖拽回弹，卡片多时掉帧，首版放弃',
      currentAction: '已停止：2000 张卡片时动画掉到 24fps',
      status: 'failed', priority: 'low', labels: ['ui', 'failed', '示例'], project: 'dsh-kanban',
      agent: { name: 'DSH Agent' }, sessionIds: [],
      checklists: [], artifacts: [], metadata: { toolCalls: 4, searches: 0 },
      order: 4, version: 2, createdAt: now - 120 * minute, updatedAt: now - 70 * minute,
    },
    {
      id: doneId, boardId: board.id, title: '搭建插件骨架与开发服务器',
      summary: 'package.json、cordis.patch.yml、dev-server 与测试脚手架就绪',
      result: '插件骨架完成：cordis.patch.yml 可安装，node scripts/dev-server.mjs 可在 4599 独立启动，npm test 离线可跑。',
      status: 'done', priority: 'medium', labels: ['mvp', 'server', '示例'], project: 'dsh-kanban',
      agent: { name: 'DSH Agent' }, sessionIds: [],
      checklists: [], artifacts: [], metadata: { toolCalls: 12, searches: 1, elapsedMs: 65_000 },
      order: 5, version: 3, createdAt: now - 110 * minute, updatedAt: now - 62 * minute, startedAt: now - 110 * minute, completedAt: now - 62 * minute,
    },
    {
      id: backlogId, boardId: board.id, title: '为卡片增加按项目筛选',
      summary: '看板顶部加项目下拉；列表视图按项目分组',
      status: 'backlog', priority: 'medium', labels: ['ui', 'nice-to-have', '示例'], project: 'dsh-kanban',
      checklists: [], artifacts: [], metadata: { toolCalls: 0, searches: 0 },
      order: 6, version: 1, createdAt: now - 90 * minute, updatedAt: now - 90 * minute,
    },
    {
      id: multiId, boardId: board.id, title: '发布前要带哪些检查？',
      summary: '多选审批示例：勾选本次发布前必须通过的检查项，可以多选',
      status: 'needs_you', priority: 'high', labels: ['release', 'decision', '示例'], project: 'dsh-kanban',
      agent: { name: 'DSH Agent' }, sessionIds: [],
      checklists: [], artifacts: [], metadata: { toolCalls: 7, searches: 2 },
      approvals: [{
        id: newApprovalId(),
        title: '发布前要带哪些检查？',
        detail: '勾选本次发布前必须通过的检查项（可多选）。未勾选项会被记录为本次不覆盖，请确认剩余风险可接受。',
        multiSelect: true,
        options: [
          { id: 'unit-test', label: '单元测试', description: 'npm test 全绿', tone: 'primary' },
          { id: 'build', label: '构建', description: 'web/dist 构建通过' },
          { id: 'device', label: '真实设备', description: '在真机/真实浏览器验证', tone: 'primary' },
          { id: 'docs', label: '文档', description: 'README 与契约同步更新' },
        ],
        status: 'pending', requestedBy: agent, requestedAt: now - 20 * minute,
      }],
      order: 7, version: 2, createdAt: now - 100 * minute, updatedAt: now - 20 * minute, startedAt: now - 100 * minute,
    },
    {
      id: reviewId, boardId: board.id, title: '上线评审：发布窗口与检查项',
      summary: '多问题审批示例：3 道题分别单选发布窗口、多选检查项、单选回滚方案',
      status: 'needs_you', priority: 'urgent', labels: ['release', 'review', '示例'], project: 'dsh-kanban',
      agent: { name: 'DSH Agent' }, sessionIds: [],
      checklists: [], artifacts: [], metadata: { toolCalls: 5, searches: 2 },
      approvals: [{
        id: newApprovalId(),
        title: '发布窗口：选择本次发布窗口',
        detail: '请逐题选择本次发布方案；未确认的项会阻塞发布。',
        multiSelect: false,
        options: reviewQuestions[0].options,
        questions: reviewQuestions,
        status: 'pending', requestedBy: agent, requestedAt: now - 15 * minute,
      }],
      order: 8, version: 2, createdAt: now - 95 * minute, updatedAt: now - 15 * minute, startedAt: now - 95 * minute,
    },
  ]
  const activities = [
    demoActivity(runningId, 'created', user, '创建了卡片「实现看板卡片与会话绑定」', now - 180 * minute),
    demoActivity(runningId, 'status', agent, '把状态改为「进行中」', now - 170 * minute, { from: 'backlog', to: 'running' }),
    demoActivity(runningId, 'progress', agent, '读完数据模型与 HTTP 契约，开始实现 store', now - 150 * minute),
    demoActivity(runningId, 'progress', user, '你确认了执行方向，agent 继续推进', now - 145 * minute, { action: 'confirm' }),
    demoActivity(runningId, 'progress', agent, 'store 与 domain 完成，开始写 routes 与 SSE', now - 40 * minute),
    demoActivity(runningId, 'progress', agent, '正在实现 lib/routes.js 的 SSE 广播与同源校验', now - 6 * minute),
    demoActivity(approveId, 'created', agent, '创建了卡片「确认演示数据的默认看板命名」', now - 150 * minute),
    demoActivity(approveId, 'approval_requested', agent, '请求确认：「默认看板采用哪个名称？」', now - 32 * minute),
    demoActivity(blockedId, 'created', agent, '创建了卡片「接入 DSH 客户端桥发送消息」', now - 140 * minute),
    demoActivity(blockedId, 'status', agent, '被阻塞：当前 DSH 版本缺少可用的 sessions 创建接口', now - 40 * minute, { from: 'running', to: 'blocked' }),
    demoActivity(failedId, 'created', agent, '创建了卡片「首版拖拽排序动画」', now - 120 * minute),
    demoActivity(failedId, 'error', agent, '在 60fps 目标下掉到 24fps，首版放弃', now - 70 * minute),
    demoActivity(doneId, 'created', agent, '创建了卡片「搭建插件骨架与开发服务器」', now - 110 * minute),
    demoActivity(doneId, 'result', agent, '插件骨架完成，dev-server 可在 4599 独立启动', now - 62 * minute),
    demoActivity(backlogId, 'created', user, '创建了卡片「为卡片增加按项目筛选」', now - 90 * minute),
    demoActivity(multiId, 'created', agent, '创建了卡片「发布前要带哪些检查？」', now - 100 * minute),
    demoActivity(multiId, 'approval_requested', agent, '请求确认（多选）：「发布前要带哪些检查？」', now - 20 * minute),
    demoActivity(reviewId, 'created', agent, '创建了卡片「上线评审：发布窗口与检查项」', now - 95 * minute),
    demoActivity(reviewId, 'approval_requested', agent, '请求确认（3 题）：「发布窗口：选择本次发布窗口」', now - 15 * minute),
  ].sort((a, b) => a.at - b.at)
  board.cardOrder = {
    backlog: [backlogId],
    running: [runningId],
    needs_you: [approveId, multiId, reviewId, blockedId, failedId],
    done: [doneId],
  }
  return { schemaVersion: SCHEMA_VERSION, boards: [board], cards, activities, meta }
}

/** POST /seed：demo=覆盖为演示数据；empty=清空卡片保留看板；reset=重建默认看板（保留 revision 单调）。 */
export function applySeedMode(draft, mode, now = nowMs()) {
  if (!['demo', 'empty', 'reset'].includes(mode)) throw new DomainError('BAD_REQUEST', '未知的 seed 模式')
  const revision = draft.meta?.revision ?? 0
  const createdAt = draft.meta?.createdAt ?? now
  const system = defaultActor('system')
  const before = {
    cards: draft.cards.length,
    approvals: draft.cards.reduce((sum, card) => sum + (Array.isArray(card.approvals) ? card.approvals.length : 0), 0),
    pending: draft.cards.reduce((sum, card) => sum + (Array.isArray(card.approvals) ? card.approvals.filter(approval => approval.status === 'pending').length : 0), 0),
    activities: draft.activities.length,
  }
  // 数据替换前先把等待中的审批正式收口（归档卡上的 pending 在归档时已收口，不重复记）。
  for (const card of draft.cards) {
    if (card.archived) continue
    if ((card.approvals || []).some(approval => approval.status === 'pending')) {
      closePendingApprovals(draft, card, { reason: 'data_reset', actor: system, now })
    }
  }
  pushDecision(draft, { type: 'data_reset', at: now, actor: system, mode, before })
  if (mode === 'empty') {
    draft.cards = []
    draft.activities = []
    if (!draft.boards.some(board => board.id === DEFAULT_BOARD_ID)) {
      draft.boards.unshift(newBoard({ id: DEFAULT_BOARD_ID, name: 'DSH 看板', now }))
    }
    for (const board of draft.boards) { board.cardOrder = emptyCardOrder(); board.updatedAt = now }
  } else {
    const seed = createSeed(mode === 'demo' ? 'demo' : 'empty', now)
    draft.boards = seed.boards
    // createSeed 的原始卡片可能缺少 approvals/checklists 等数组：先规范化再落库，避免首个生命周期内写审批 500。
    draft.cards = seed.cards.map(card => normalizeCard(card, { boardId: card.boardId, now }))
    draft.activities = seed.activities
  }
  // 重新播种的演示数据里也有 pending 审批：补请求事件，避免后续提交时出现没有请求的「孤儿」resolved。
  if (mode === 'demo') {
    for (const card of draft.cards) {
      for (const approval of card.approvals || []) {
        if (approval.status !== 'pending') continue
        const sessionId = decisionSessionId(card, approval)
        pushDecision(draft, {
          type: 'approval_requested',
          at: approval.requestedAt,
          boardId: card.boardId,
          cardId: card.id,
          approvalId: approval.id,
          actor: approval.requestedBy,
          ...(sessionId ? { sessionId } : {}),
          card: decisionCardContext(card),
          approval: normalizeApprovalSnapshot(approval),
        })
      }
    }
  }
  draft.meta = { createdAt, updatedAt: now, revision, seededAt: now, lastActor: defaultActor('system') }
  if (Array.isArray(draft.outbox)) delete draft.outbox
  return draft
}

// ---------------- Transactional Outbox & Watchdog（v0.27.0 Super-Agent Runtime） ----------------

function normalizeOutboxTarget(raw) {
  const src = isObject(raw) ? raw : {}
  const sessionId = cleanText(src.sessionId, LIMITS.sessionId)
  const workspaceId = cleanText(src.workspaceId, LIMITS.sessionId)
  const cwd = cleanText(src.cwd, 1000)
  const harness = cleanText(src.harness, 40)
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(harness ? { harness } : {}),
  }
}

function normalizeOutboxEntry(raw, fallbackNow = nowMs()) {
  if (!isObject(raw)) return null
  const seq = integer(raw.seq, 0, 1)
  if (!seq) return null
  const idempotencyKey = cleanText(raw.idempotencyKey, LIMITS.outboxIdempotencyKey)
  const cardId = cleanText(raw.cardId, 40)
  const prompt = cleanText(raw.prompt, LIMITS.outboxPrompt)
  if (!idempotencyKey || !isCardId(cardId) || !prompt) return null
  const expectedGeneration = Math.max(1, integer(raw.expectedGeneration, 1, 1))
  const kind = OUTBOX_KINDS.includes(raw.kind) ? raw.kind : 'wake'
  const mode = raw.mode === 'steer' ? 'steer' : 'queue'
  const status = OUTBOX_STATUSES.includes(raw.status) ? raw.status : 'pending'
  const createdAt = integer(raw.createdAt, fallbackNow, 0)
  const updatedAt = integer(raw.updatedAt, createdAt, 0)
  const notBefore = integer(raw.notBefore, createdAt, 0)
  const attempts = integer(raw.attempts, 0, 0)
  const leaseOwner = cleanText(raw.leaseOwner, 120)
  const leaseUntil = raw.leaseUntil !== undefined ? integer(raw.leaseUntil, 0, 0) : undefined
  const lastError = cleanText(raw.lastError, 300)
  return {
    seq,
    idempotencyKey,
    cardId,
    expectedGeneration,
    kind,
    target: normalizeOutboxTarget(raw.target),
    prompt,
    mode,
    status,
    attempts,
    notBefore,
    createdAt,
    updatedAt,
    ...(leaseOwner ? { leaseOwner } : {}),
    ...(leaseUntil !== undefined ? { leaseUntil } : {}),
    ...(lastError ? { lastError } : {}),
  }
}

export function normalizeOutbox(rawList, fallbackNow = nowMs()) {
  if (!Array.isArray(rawList)) return []
  return rawList
    .map(item => normalizeOutboxEntry(item, fallbackNow))
    .filter(Boolean)
    .sort((a, b) => a.seq - b.seq)
    .slice(-LIMITS.outbox)
}

function ensureOutboxArray(draft) {
  if (!Array.isArray(draft.outbox)) draft.outbox = []
  return draft.outbox
}

function nextOutboxSeq(draft) {
  const list = ensureOutboxArray(draft)
  const maxInList = list.reduce((max, item) => Math.max(max, integer(item.seq, 0, 0)), 0)
  const currentSeq = Math.max(maxInList, integer(draft.meta?.outboxSeq, 0, 0))
  const next = currentSeq + 1
  if (isObject(draft.meta)) draft.meta.outboxSeq = next
  return next
}

function trimOutbox(draft) {
  if (!Array.isArray(draft.outbox) || draft.outbox.length <= LIMITS.outbox) return
  const excess = draft.outbox.length - LIMITS.outbox
  const terminalStatuses = new Set(['acked', 'failed', 'expired'])
  const dropSeqs = new Set()
  for (const item of draft.outbox) {
    if (dropSeqs.size >= excess) break
    if (terminalStatuses.has(item.status)) dropSeqs.add(item.seq)
  }
  if (dropSeqs.size < excess) {
    for (const item of draft.outbox) {
      if (dropSeqs.size >= excess) break
      dropSeqs.add(item.seq)
    }
  }
  draft.outbox = draft.outbox.filter(item => !dropSeqs.has(item.seq))
}

/** 当前待派发（pending 或租约已过期）的 Outbox 指令数。 */
export function pendingOutboxCount(draft, now = nowMs()) {
  if (!Array.isArray(draft?.outbox)) return 0
  return draft.outbox.filter(entry => (
    entry.status === 'pending'
    || (entry.status === 'leased' && integer(entry.leaseUntil, 0, 0) <= now)
  )).length
}

/**
 * 幂等入队一条会话派发指令（Transactional Outbox）：
 * - 按 idempotencyKey 去重（已存在未过期的同 key 条目直接返回 duplicate: true）；
 * - 校验 expectedGeneration === card.runtime.generation（Fencing Token 守卫）。
 */
export function enqueueOutbox(draft, input, { now = nowMs() } = {}) {
  if (!isObject(input)) throw new DomainError('BAD_REQUEST', 'outbox 入参必须是对象')
  const cardId = requiredText(input.cardId, 40, 'BAD_REQUEST', 'cardId 不能为空')
  const idempotencyKey = requiredText(input.idempotencyKey, LIMITS.outboxIdempotencyKey, 'BAD_REQUEST', 'idempotencyKey 不能为空')
  const prompt = requiredText(input.prompt, LIMITS.outboxPrompt, 'BAD_REQUEST', 'prompt 不能为空')
  const card = findCard(draft, cardId)
  if (!card) return { enqueued: false, duplicate: false, reason: 'card_not_found', entry: null }

  const runtime = ensureCardRuntime(card)
  const expectedGeneration = input.expectedGeneration !== undefined
    ? integer(input.expectedGeneration, runtime.generation, 1)
    : runtime.generation
  if (expectedGeneration !== runtime.generation) {
    return {
      enqueued: false,
      duplicate: false,
      reason: 'generation_mismatch',
      currentGeneration: runtime.generation,
      entry: null,
    }
  }

  const outbox = ensureOutboxArray(draft)
  const existing = outbox.find(item => item.idempotencyKey === idempotencyKey && item.status !== 'expired')
  if (existing) {
    return { enqueued: false, duplicate: true, reason: 'duplicate', entry: existing }
  }

  const seq = nextOutboxSeq(draft)
  const entry = {
    seq,
    idempotencyKey,
    cardId: card.id,
    expectedGeneration,
    kind: OUTBOX_KINDS.includes(input.kind) ? input.kind : 'wake',
    target: normalizeOutboxTarget({
      sessionId: input.target?.sessionId ?? mainSessionId(card) ?? undefined,
      workspaceId: input.target?.workspaceId ?? card.workspaceId ?? undefined,
      cwd: input.target?.cwd ?? card.cwd ?? undefined,
      harness: input.target?.harness ?? card.agent?.harness ?? undefined,
    }),
    prompt,
    mode: input.mode === 'steer' ? 'steer' : 'queue',
    status: 'pending',
    attempts: 0,
    notBefore: input.notBefore !== undefined ? integer(input.notBefore, now, 0) : now,
    createdAt: now,
    updatedAt: now,
  }
  outbox.push(entry)
  trimOutbox(draft)
  touchMeta(draft, defaultActor('system'), now)
  return { enqueued: true, duplicate: false, entry }
}

/**
 * 租约拉取待执行的 Outbox 指令：
 * - 仅返回 notBefore <= now 的 pending（或已过租约期的 leased）条目；
 * - 若目标卡片已归档、状态不再匹配或 generation 已推进（expectedGeneration !== card.runtime.generation），
 *   自动将该条目标记为 expired，绝不向会话补发过期指令（Invariant 4: Generation Fencing）。
 */
export function leaseOutbox(draft, { owner = 'client-default', harness, limit = 5, leaseMs = 15_000, now = nowMs() } = {}) {
  if (!Array.isArray(draft.outbox) || !draft.outbox.length) return { entries: [], expired: [] }
  const maxItems = Math.max(1, Math.min(50, integer(limit, 5, 1, 50)))
  const duration = Math.max(1000, Math.min(300_000, integer(leaseMs, 15_000, 1000, 300_000)))
  const leaseHolder = cleanText(owner, 120) || 'client-default'
  const filterHarness = cleanText(harness, 40)
  const entries = []
  const expired = []

  for (const entry of draft.outbox) {
    const isAvailable = entry.status === 'pending'
      || (entry.status === 'leased' && integer(entry.leaseUntil, 0, 0) <= now)
    if (!isAvailable) continue

    const card = findCard(draft, entry.cardId)
    const currentGen = card ? ensureCardRuntime(card).generation : -1
    // retry 允许卡片当前处于 failed（自动瞬时失败待恢复）或 running；其余自动动作要求卡片处于 running
    const validStatus = card && (
      entry.kind === 'retry'
        ? (card.status === 'running' || card.status === 'failed')
        : entry.kind === 'approval'
          ? !TERMINAL_STATUSES.has(card.status)
          : card.status === 'running'
    )
    if (!card || currentGen !== entry.expectedGeneration || !validStatus) {
      entry.status = 'expired'
      entry.updatedAt = now
      delete entry.leaseOwner
      delete entry.leaseUntil
      expired.push(entry)
      continue
    }

    const entryHarness = entry.target?.harness || card.agent?.harness || 'dsh'
    if (filterHarness && entryHarness !== filterHarness) continue

    if (entry.notBefore > now) continue
    if (entries.length >= maxItems) continue

    // 若入队时尚未绑定主会话、租约时刻卡片已有主会话，则补齐目标会话 ID
    if (!entry.target.sessionId && mainSessionId(card)) {
      entry.target.sessionId = mainSessionId(card)
    }
    if (!entry.target.harness && card.agent?.harness) {
      entry.target.harness = card.agent.harness
    }
    entry.status = 'leased'
    entry.leaseOwner = leaseHolder
    entry.leaseUntil = now + duration
    entry.attempts = integer(entry.attempts, 0, 0) + 1
    entry.updatedAt = now
    entries.push(entry)
  }

  if (entries.length || expired.length) {
    touchMeta(draft, defaultActor('system'), now)
  }
  return { entries, expired }
}

/**
 * 确认（ACK）或标记失败一条 Outbox 指令：
 * - 若客户端派发时补建了新会话（sessionId），且卡片尚未绑定该会话，则在同一事务内绑定到卡片且不破坏当前 generation；
 * - 若卡片 generation 已变更，则标记为 expired。
 */
export function ackOutbox(draft, seq, { owner, ok = true, sessionId, error, now = nowMs() } = {}) {
  const targetSeq = integer(seq, 0, 1)
  const entry = Array.isArray(draft.outbox) ? draft.outbox.find(item => item.seq === targetSeq) : null
  if (!entry) throw new DomainError('OUTBOX_NOT_FOUND', `Outbox 条目不存在：${String(seq)}`, 404)
  if (entry.status === 'acked') return { entry, idempotent: true, card: findCard(draft, entry.cardId) || null }

  const card = findCard(draft, entry.cardId)
  if (!card || ensureCardRuntime(card).generation !== entry.expectedGeneration) {
    entry.status = 'expired'
    entry.updatedAt = now
    delete entry.leaseOwner
    delete entry.leaseUntil
    touchMeta(draft, defaultActor('system'), now)
    return { entry, expired: true, card: card || null }
  }

  void owner
  delete entry.leaseOwner
  delete entry.leaseUntil
  entry.updatedAt = now

  if (ok !== false) {
    entry.status = 'acked'
    const resolvedSessionId = cleanText(sessionId, LIMITS.sessionId)
    if (resolvedSessionId && !(card.sessionIds || []).includes(resolvedSessionId)) {
      card.sessionIds = [resolvedSessionId, ...(card.sessionIds || []).filter(id => id !== resolvedSessionId)].slice(0, LIMITS.sessionIds)
      pushActivity(draft, card, {
        type: 'session_linked',
        actor: defaultActor('system'),
        text: 'Outbox 自动派发并绑定了新会话',
        data: { sessionId: resolvedSessionId, action: 'link', primary: true, source: 'outbox' },
        at: now,
      })
      touchCard(card, now)
    }
    const activeSessionId = resolvedSessionId || mainSessionId(card) || entry.target?.sessionId
    if (activeSessionId) {
      const runtime = ensureCardRuntime(card)
      runtime.turnWatermark = {
        ...(runtime.turnWatermark || {}),
        sessionId: activeSessionId,
        turn: integer(runtime.turnWatermark?.turn, 0, 0),
        phase: 'running',
        at: now,
      }
    }
  } else {
    entry.status = 'failed'
    entry.lastError = cleanText(error, 300) || '派发失败'
  }

  touchMeta(draft, defaultActor('system'), now)
  return { entry, expired: false, card }
}

/** 记录或更新主会话的轮次水位（供 Watchdog 静默停滞检测使用）。 */
export function recordSessionTurnWatermark(draft, { sessionId, turn, phase = 'idle', code, at = nowMs() } = {}) {
  const session = cleanText(sessionId, LIMITS.sessionId)
  const turnNum = integer(turn, 0, 0)
  if (!session || turnNum < 1) return { cards: [] }
  const normalizedPhase = ['running', 'idle', 'error'].includes(phase) ? phase : 'idle'
  const cards = []
  for (const card of cardsByMainSession(draft, session)) {
    if (card.status !== 'running' && card.status !== 'failed') continue
    const runtime = ensureCardRuntime(card)
    runtime.turnWatermark = {
      ...(runtime.turnWatermark || {}),
      sessionId: session,
      turn: turnNum,
      phase: normalizedPhase,
      at: integer(at, nowMs(), 0),
      ...(cleanText(code, 64) ? { code: cleanText(code, 64) } : {}),
    }
    cards.push(card)
  }
  return { cards }
}

export function buildWatchdogNudgePrompt(card) {
  const todo = Array.isArray(card.checklists)
    ? card.checklists.filter(item => !item.done).map(item => `- [ ] ${item.text}`).join('\n')
    : ''
  return cleanText([
    `【看板·Watchdog 收敛提醒】卡片「${card.title}」（ID: ${card.id}）当前仍处于「进行中」，但主会话本轮已结束。`,
    todo ? `未完成检查项：\n${todo}` : '',
    '请根据当前真实进展立即收口：',
    '1. 若任务已完成，请调用 kanban_complete_card 填写总结并标记完成；',
    '2. 若遇到阻塞或需要人工拍板，请调用 kanban_request_approval 发起确认；',
    '3. 若仍需继续执行下一步，请继续执行并用 kanban_update_card 更新进度。',
  ].filter(Boolean).join('\n'), LIMITS.outboxPrompt)
}

export function buildWatchdogRetryPrompt(card, { attempt, maxRetries, code } = {}) {
  return cleanText([
    `【看板·Watchdog 自动重试（${attempt}/${maxRetries}）】卡片「${card.title}」（ID: ${card.id}）上一轮会话因瞬时异常（${code || 'TRANSPORT'}）中断。`,
    card.currentAction ? `中断前动作：${card.currentAction}` : '',
    '请从断点继续执行当前卡片任务，完成后调用 kanban_complete_card 收口。',
  ].filter(Boolean).join('\n'), LIMITS.outboxPrompt)
}

export function buildWatchdogWaitResumePrompt(card, waitCondition) {
  return cleanText([
    `【看板·等待条件已就绪】卡片「${card.title}」（ID: ${card.id}）的等待条件已满足${waitCondition?.reason ? `（${waitCondition.reason}）` : ''}。`,
    card.currentAction ? `当前待办：${card.currentAction}` : '',
    '请继续推进本卡后续步骤，完成后调用 kanban_complete_card 收口。',
  ].filter(Boolean).join('\n'), LIMITS.outboxPrompt)
}

export function buildRestartResumePrompt(card) {
  return cleanText([
    `【看板·宿主重启断点续跑】卡片「${card.title}」（ID: ${card.id}）上一轮推理因 DSH 宿主重启中断。`,
    card.currentAction ? `重启前动作：${card.currentAction}` : '',
    '请先检查当前工作区与检查项进度，从断点继续完成剩余任务，完成后调用 kanban_complete_card 收口。',
  ].filter(Boolean).join('\n'), LIMITS.outboxPrompt)
}

/**
 * 宿主进程启动时的断流恢复（解决 DSH 重启打断 running 卡片后水位卡在 `phase: "running"` 无法恢复的问题）：
 * 识别所有 `status === 'running'`、无待决审批、无未到期时间窗口、且持久化水位 `phase === 'running'` 早于本次进程启动时刻 `bootedAt` 的卡片，
 * 将其水位修正并入队 Outbox 续跑指令（不消耗单代静默催办预算 `nudgesUsed`）。
 */
export function recoverInterruptedRunningCards(draft, {
  bootedAt = nowMs(),
  activeSessionIds = [],
  now = nowMs(),
} = {}) {
  const recovered = []
  if (!draft || !Array.isArray(draft.cards) || !getAutoAdvanceEnabled(draft)) {
    return { recovered }
  }
  const activeSet = new Set((Array.isArray(activeSessionIds) ? activeSessionIds : []).map(String))
  const actor = defaultActor('system')

  for (const card of draft.cards) {
    if (!card || card.archived || card.status !== 'running' || pendingApproval(card)) continue
    const waitCond = card.runtime?.waitCondition
    if (waitCond && waitCond.kind === 'time' && typeof waitCond.notBefore === 'number' && now < waitCond.notBefore) {
      continue
    }
    const wm = card.runtime?.turnWatermark
    if (!wm || wm.phase !== 'running') continue
    const wmAt = Number(wm.at) || 0
    if (wmAt <= 0 || wmAt >= bootedAt) continue

    const primarySess = mainSessionId(card)
    if (primarySess && activeSet.has(primarySess)) continue
    if (!primarySess && !card.cwd && !card.workspaceId) continue

    const runtime = ensureCardRuntime(card)
    const resumeTurn = Math.max(1, Number(wm.turn) || 1)
    runtime.turnWatermark = {
      ...wm,
      ...(primarySess ? { sessionId: primarySess } : {}),
      turn: resumeTurn,
      phase: 'idle',
      at: now,
      lastHandledTurn: resumeTurn,
    }
    pushActivity(draft, card, {
      type: 'progress',
      actor,
      text: '检测到宿主重启中断了上一轮推理，已自动入队断点续跑',
      data: {
        kind: 'watchdog_restart_resume',
        ...(primarySess ? { sessionId: primarySess } : {}),
        bootedAt,
      },
      at: now,
    })
    enqueueOutbox(draft, {
      idempotencyKey: `restart-resume:${card.id}:gen:${runtime.generation}:boot:${bootedAt}`,
      cardId: card.id,
      expectedGeneration: runtime.generation,
      kind: 'restart_resume',
      target: {
        ...(primarySess ? { sessionId: primarySess } : {}),
        ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
        ...(card.cwd ? { cwd: card.cwd } : {}),
      },
      prompt: buildRestartResumePrompt(card),
      mode: 'queue',
      notBefore: now,
    }, { now })
    touchCard(card, now)
    recovered.push(card)
  }

  if (recovered.length) {
    touchMeta(draft, actor, now)
  }
  return { recovered }
}

/**
 * Watchdog 核心巡检状态机（纯函数，在 store.update 事务内执行）：
 * 1) 瞬时错误自动退避重试（TRANSPORT / ETIMEDOUT / RATE_LIMIT 等）：最多重试 maxRetries(2) 次（+15s, +60s），耗尽后熔断保持 failed；
 * 2) 结构化等待条件唤醒（waitCondition.kind === 'time' 且 now >= notBefore）：清除等待条件并入队恢复指令；
 * 3) 静默停滞检测（running 且无待决审批/等待条件，主会话 turn/end(completed) 后超过 graceMs(30s) 仍未收口）：
 *    - nudgesUsed < maxNudges(1) 时发送 1 次收敛提醒（nudge）；
 *    - nudgesUsed >= maxNudges(1) 时自动熔断转为 blocked（进入「待你确认」列），严禁无限循环催促。
 */
export function evaluateWatchdog(draft, {
  now = nowMs(),
  watermarks,
  graceMs = 30_000,
  retryDelaysMs = [15_000, 60_000],
  maxNudges = 1,
  maxRetries = 2,
  maxConcurrentRunning = 3,
} = {}) {
  const actor = defaultActor('system')
  const nudged = []
  const stalled = []
  const retried = []
  const resumed = []
  const reopened = []
  const started = []
  const reconciled = []

  const getExternalWatermark = sessionId => {
    if (!sessionId || !watermarks) return null
    if (watermarks instanceof Map) return watermarks.get(sessionId) || null
    if (isObject(watermarks)) return watermarks[sessionId] || null
    return null
  }

  const autoAdvance = getAutoAdvanceEnabled(draft)
  const byId = new Map((draft.cards || []).map(item => [item.id, item]))
  let runningCount = (draft.cards || []).filter(item => !item.archived && item.status === 'running').length
  const busySessions = new Set(
    (draft.cards || [])
      .filter(item => !item.archived && item.status === 'running')
      .map(item => mainSessionId(item))
      .filter(Boolean),
  )

  for (const card of draft.cards || []) {
    if (card.archived) continue

    // 0A) 巡检拦截：若卡片处于 done 但仍有未完成的 checklist 项（且未经显式 forceComplete），自动退回 backlog 继续跟进
    if (card.status === 'done') {
      const openItems = openChecklistItems(card)
      if (openItems.length > 0) {
        const wasForced = (draft.activities || []).some(
          act => act.cardId === card.id && act.data?.forceComplete === true,
        )
        if (!wasForced) {
          const sample = openItems.slice(0, 2).map(item => item.text).join('；')
          changeStatus(draft, card, 'backlog', {
            actor,
            now,
            text: `Watchdog 巡检拦截：卡片仍有 ${openItems.length} 项检查清单未完成（${sample}），已自动退回「待办」继续跟进`,
            data: { reason: 'watchdog_incomplete_checklists', openCount: openItems.length },
          })
          card.currentAction = cleanText(
            `待完成剩余 ${openItems.length} 项检查清单：${sample}`,
            LIMITS.currentAction,
          )
          touchCard(card, now)
          reopened.push(card)
        }
      }
      continue
    }

    // 全局「自动推进（Autopilot）」关闭时，仅保留上方 0A 数据完整性守卫，暂停一切自动唤醒、点火、退避重试与静默催办
    if (!autoAdvance) continue

    // 1) 结构化时间窗口等待唤醒（waitCondition.kind === 'time'）
    const waitCond = card.runtime?.waitCondition
    if (waitCond && waitCond.kind === 'time' && waitCond.notBefore !== undefined) {
      if (now >= waitCond.notBefore) {
        const runtime = ensureCardRuntime(card)
        delete runtime.waitCondition
        if (card.status === 'blocked' || card.status === 'backlog') {
          changeStatus(draft, card, 'running', {
            actor,
            now,
            text: `等待时间窗口已到${waitCond.reason ? `（${waitCond.reason}）` : ''}，Watchdog 自动恢复到「进行中」`,
            data: { reason: WATCHDOG_WAIT_READY, notBefore: waitCond.notBefore },
          })
          runningCount += 1
          if (mainSessionId(card)) busySessions.add(mainSessionId(card))
        }
        const activeRuntime = ensureCardRuntime(card)
        activeRuntime.budget.nudgesUsed = 0
        activeRuntime.budget.lastAutoActionAt = now
        pushActivity(draft, card, {
          type: 'progress',
          actor,
          text: `等待条件已就绪${waitCond.reason ? `：${waitCond.reason}` : ''}，已自动唤醒会话继续执行`,
          data: {
            kind: WATCHDOG_WAIT_READY,
            notBefore: waitCond.notBefore,
            ...(waitCond.reason ? { reason: waitCond.reason } : {}),
          },
          at: now,
        })
        enqueueOutbox(draft, {
          idempotencyKey: `wait:${card.id}:gen:${activeRuntime.generation}:${waitCond.notBefore}`,
          cardId: card.id,
          expectedGeneration: activeRuntime.generation,
          kind: 'wait_resume',
          target: {
            ...(mainSessionId(card) ? { sessionId: mainSessionId(card) } : {}),
            ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
            ...(card.cwd ? { cwd: card.cwd } : {}),
          },
          prompt: buildWatchdogWaitResumePrompt(card, waitCond),
          mode: 'queue',
          notBefore: now,
        }, { now })
        touchCard(card, now)
        resumed.push(card)
        continue
      }
      // 尚未到达 notBefore：跳过后续自动调度与静默停滞催促
      continue
    }

    // 1B) 待办/受阻卡自动推进调度（Auto-Start）：当前置依赖全部完成（或无前置依赖）且开启 autoStart 时，受控并发自动启动。
    // 吸收 dsh-superagent-prototype WorkerSlots 设计：人类显式跟进/唤醒（priorityWake === 'person'）额外享 +1 优先槽位，不被新排队任务饿死。
    if ((card.status === 'backlog' || card.status === 'blocked') && !pendingApproval(card)) {
      const deps = Array.isArray(card.dependsOn) ? card.dependsOn.map(id => byId.get(id)) : []
      const depsReady = deps.every(dep => dep && TERMINAL_STATUSES.has(dep.status))
      const isPersonWake = card.runtime?.priorityWake === 'person' || card.priorityWake === 'person'
      const slotLimit = maxConcurrentRunning + (isPersonWake ? 1 : 0)
      if (depsReady && (card.autoStart === true || isPersonWake)) {
        const primarySess = mainSessionId(card)
        const sessionBusy = primarySess ? busySessions.has(primarySess) : false
        if (!sessionBusy && runningCount < slotLimit) {
          if (deps.length > 0 && !card.handoff) {
            const synthesized = synthesizeUpstreamHandoff(card, deps, { now, actor })
            if (synthesized) card.handoff = synthesized
          }
          changeStatus(draft, card, 'running', {
            actor,
            now,
            text: isPersonWake
              ? '人类跟进优先槽位唤醒：从「待办/受阻」恢复进入「进行中」'
              : 'Watchdog 自动接力：前置条件已就绪，从「待办」自动启动进入「进行中」',
            data: { reason: isPersonWake ? 'person_priority_wake' : 'watchdog_auto_start' },
          })
          const activeRuntime = ensureCardRuntime(card)
          delete activeRuntime.priorityWake
          delete card.priorityWake
          enqueueOutbox(draft, {
            idempotencyKey: `wake:${card.id}:gen:${activeRuntime.generation}`,
            cardId: card.id,
            expectedGeneration: activeRuntime.generation,
            kind: 'wake',
            target: {
              ...(primarySess ? { sessionId: primarySess } : {}),
              ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
              ...(card.cwd ? { cwd: card.cwd } : {}),
            },
            prompt: buildCardWakePrompt(card),
            mode: 'queue',
            notBefore: now,
          }, { now })
          runningCount += 1
          if (primarySess) busySessions.add(primarySess)
          touchCard(card, now)
          started.push(card)
          continue
        }
      }
    }

    // 2) 瞬时传输/限流错误自动退避重试
    if (card.status === 'failed') {
      const lastStatus = latestStatusActivity(draft, card.id)
      if (lastStatus?.data?.reason === SESSION_TURN_FAILURE) {
        let latestFailure = null
        for (let i = draft.activities.length - 1; i >= 0; i -= 1) {
          const act = draft.activities[i]
          if (act.cardId === card.id && act.type === 'error' && act.data?.kind === SESSION_TURN_FAILURE) {
            latestFailure = act
            break
          }
        }
        if (latestFailure && isTransientTurnError(latestFailure.data?.code, latestFailure.data?.message)) {
          const runtime = ensureCardRuntime(card)
          const errorTurn = integer(latestFailure.data?.turn, 1, 1)
          const errorCode = cleanText(latestFailure.data?.code, 64) || 'TRANSPORT'
          const sessionId = cleanText(latestFailure.data?.sessionId, LIMITS.sessionId) || mainSessionId(card)
          if (runtime.turnWatermark?.lastRetryTurn !== errorTurn) {
            if (runtime.budget.retriesUsed < maxRetries) {
              runtime.budget.retriesUsed += 1
              runtime.budget.lastAutoActionAt = now
              const attempt = runtime.budget.retriesUsed
              const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 15_000
              runtime.turnWatermark = {
                ...(runtime.turnWatermark || {}),
                ...(sessionId ? { sessionId } : {}),
                turn: errorTurn,
                phase: 'error',
                at: latestFailure.at || now,
                code: errorCode,
                lastRetryTurn: errorTurn,
              }
              pushActivity(draft, card, {
                type: 'progress',
                actor,
                text: `Watchdog 检测到瞬时错误（${errorCode}），已排入第 ${attempt}/${maxRetries} 次退避重试（${Math.round(delayMs / 1000)}s 后执行）`,
                data: {
                  kind: WATCHDOG_RETRY,
                  ...(sessionId ? { sessionId } : {}),
                  turn: errorTurn,
                  code: errorCode,
                  attempt,
                  maxRetries,
                  delayMs,
                  notBefore: now + delayMs,
                },
                at: now,
              })
              enqueueOutbox(draft, {
                idempotencyKey: `retry:${card.id}:gen:${runtime.generation}:turn:${errorTurn}:attempt:${attempt}`,
                cardId: card.id,
                expectedGeneration: runtime.generation,
                kind: 'retry',
                target: {
                  ...(sessionId ? { sessionId } : {}),
                  ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
                  ...(card.cwd ? { cwd: card.cwd } : {}),
                },
                prompt: buildWatchdogRetryPrompt(card, { attempt, maxRetries, code: errorCode }),
                mode: 'queue',
                notBefore: now + delayMs,
              }, { now })
              touchCard(card, now)
              retried.push(card)
            } else if (runtime.turnWatermark?.lastRetryExhaustedTurn !== errorTurn) {
              runtime.turnWatermark = {
                ...(runtime.turnWatermark || {}),
                ...(sessionId ? { sessionId } : {}),
                turn: errorTurn,
                phase: 'error',
                at: latestFailure.at || now,
                code: errorCode,
                lastRetryTurn: errorTurn,
                lastRetryExhaustedTurn: errorTurn,
              }
              pushActivity(draft, card, {
                type: 'error',
                actor,
                text: `瞬时错误自动重试已达上限（${runtime.budget.retriesUsed}/${maxRetries} 次），Watchdog 停止重试并保持「失败」待人工介入`,
                data: {
                  kind: WATCHDOG_STALLED,
                  reason: 'max_retries_exceeded',
                  ...(sessionId ? { sessionId } : {}),
                  turn: errorTurn,
                  code: errorCode,
                  retriesUsed: runtime.budget.retriesUsed,
                },
                at: now,
              })
              touchCard(card, now)
              stalled.push(card)
            }
          }
        }
      }
      continue
    }

    // 3) 静默停滞检测与单次 Nudge / 自动熔断（仅针对处于 running 且无 pending 审批的卡片）
    if (card.status !== 'running') continue
    if (pendingApproval(card)) continue
    const sessionId = mainSessionId(card)
    if (!sessionId) continue

    const extWm = getExternalWatermark(sessionId)
    const storedWm = card.runtime?.turnWatermark
    const watermark = extWm && (!storedWm || integer(extWm.at, 0, 0) >= integer(storedWm.at, 0, 0))
      ? extWm
      : storedWm
    if (!watermark || watermark.phase !== 'idle') continue
    const wmTurn = integer(watermark.turn, 0, 0)
    const wmAt = integer(watermark.at, 0, 0)
    if (wmTurn < 1 || wmAt <= 0) continue
    // 仅处理卡片进入 running 之后完成的轮次，避免拿卡片启动前的历史轮次误判
    if (card.startedAt && wmAt < card.startedAt) continue
    if (now - wmAt < graceMs) continue

    const runtime = ensureCardRuntime(card)
    if (runtime.turnWatermark?.lastHandledTurn === wmTurn) continue

    if (runtime.budget.nudgesUsed < maxNudges) {
      runtime.budget.nudgesUsed += 1
      runtime.budget.lastAutoActionAt = now
      const attempt = runtime.budget.nudgesUsed
      runtime.turnWatermark = {
        ...(runtime.turnWatermark || {}),
        sessionId,
        turn: wmTurn,
        phase: 'idle',
        at: wmAt,
        lastHandledTurn: wmTurn,
      }
      pushActivity(draft, card, {
        type: 'progress',
        actor,
        text: `Watchdog 检测到会话第 ${wmTurn} 轮已结束但卡片仍在进行中，已发送收敛提醒（${attempt}/${maxNudges}）`,
        data: {
          kind: WATCHDOG_NUDGE,
          sessionId,
          turn: wmTurn,
          attempt,
          maxNudges,
        },
        at: now,
      })
      enqueueOutbox(draft, {
        idempotencyKey: `nudge:${card.id}:gen:${runtime.generation}:attempt:${attempt}`,
        cardId: card.id,
        expectedGeneration: runtime.generation,
        kind: 'nudge',
        target: {
          sessionId,
          ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
          ...(card.cwd ? { cwd: card.cwd } : {}),
        },
        prompt: buildWatchdogNudgePrompt(card),
        mode: 'queue',
        notBefore: now,
      }, { now })
      touchCard(card, now)
      nudged.push(card)
    } else {
      runtime.turnWatermark = {
        ...(runtime.turnWatermark || {}),
        sessionId,
        turn: wmTurn,
        phase: 'idle',
        at: wmAt,
        lastHandledTurn: wmTurn,
      }
      runtime.budget.lastAutoActionAt = now
      pushActivity(draft, card, {
        type: 'error',
        actor,
        text: `会话第 ${wmTurn} 轮结束后仍未收口卡片（已提醒 ${runtime.budget.nudgesUsed} 次），Watchdog 自动熔断`,
        data: {
          kind: WATCHDOG_STALLED,
          reason: 'silent_stall_circuit_breaker',
          sessionId,
          turn: wmTurn,
          nudgesUsed: runtime.budget.nudgesUsed,
        },
        at: now,
      })
      changeStatus(draft, card, 'blocked', {
        actor,
        now,
        text: '会话连续结束未收口卡片，Watchdog 自动熔断为「受阻」（待你确认）',
        data: {
          reason: WATCHDOG_STALLED,
          sessionId,
          turn: wmTurn,
          nudgesUsed: runtime.budget.nudgesUsed,
        },
      })
      touchCard(card, now)
      stalled.push(card)
    }
  }

  if (nudged.length || stalled.length || retried.length || resumed.length || reopened.length || started.length || reconciled.length) {
    touchMeta(draft, actor, now)
  }
  return { nudged, stalled, retried, resumed, reopened, started, reconciled }
}
