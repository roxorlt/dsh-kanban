// dsh-kanban 领域模型：状态/列映射、规范化、卡片变更原语、种子数据。
// 本模块不碰文件系统与 HTTP，路由层和 agent 工具共用这里的写操作，
// 保证 REST 与工具对同一状态迁移只有一份语义。
import { randomBytes } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const DEFAULT_BOARD_ID = 'board-default'

export const STATUSES = ['backlog', 'running', 'needs_you', 'blocked', 'failed', 'done', 'canceled']
export const COLUMNS = ['backlog', 'running', 'needs_you', 'done']
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent']
export const ARTIFACT_KINDS = ['file', 'link', 'report', 'commit', 'image']
export const APPROVAL_TONES = ['primary', 'danger', 'ghost']
export const ACTIVITY_TYPES = [
  'created', 'status', 'progress', 'comment', 'approval_requested', 'approval_resolved',
  'session_linked', 'checklist', 'artifact', 'result', 'error', 'ack', 'archived',
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
  title: 120, summary: 240, currentAction: 160, result: 600,
  labels: 12, label: 24,
  sessionId: 160, sessionIds: 8,
  progressText: 160,
  checklistText: 160, checklists: 50,
  artifactLabel: 120, artifactPath: 800, artifacts: 50,
  approvalTitle: 160, approvalDetail: 1200, approvalOption: 80, approvalOptions: 8, approvals: 20,
  approvalQuestion: 240, approvalQuestionHeader: 40, approvalQuestions: 6, approvalAnswers: 6,
  activityText: 400, activitiesPerCard: 300,
  cards: 2000, batchCards: 200,
  agentName: 80, agentId: 160,
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
  return { name, ...(id ? { id } : {}) }
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

export function normalizeMetadata(metadata) {
  const base = { toolCalls: 0, searches: 0 }
  if (!isObject(metadata)) return base
  for (const key of ['toolCalls', 'searches', 'elapsedMs', 'tokensIn', 'tokensOut']) {
    if (metadata[key] !== undefined) base[key] = integer(metadata[key], 0, 0)
  }
  return base
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
  const status = STATUSES.includes(card.status) ? card.status : 'backlog'
  const resolvedBoardId = isValidId(card.boardId) && card.boardId.startsWith('board-') ? card.boardId : boardId || DEFAULT_BOARD_ID
  const createdAt = integer(card.createdAt, now, 0)
  return {
    id: isValidId(card.id) && card.id.startsWith('card-') ? card.id : newCardId(),
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
    sessionIds: normalizeSessionIds(card.sessionIds),
    ...(normalizeAgent(card.agent) ? { agent: normalizeAgent(card.agent) } : {}),
    ...(card.progress !== undefined ? (() => { const p = normalizeProgress(card.progress); return p ? { progress: p } : {} })() : {}),
    checklists: normalizeChecklists(Array.isArray(card.checklists) ? card.checklists : []),
    approvals: (Array.isArray(card.approvals) ? card.approvals : []).map(normalizeStoredApproval).filter(Boolean).slice(-LIMITS.approvals),
    artifacts: normalizeArtifacts(Array.isArray(card.artifacts) ? card.artifacts : []),
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
  const options = list.map(normalizeOption).filter(Boolean).slice(0, LIMITS.approvalOptions)
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

// resolution 读取兼容：v0.3 {optionIds, labels, answers, comment}；v0.2 {optionIds, labels} 或 {optionId, label}。
function normalizeResolution(raw, options = [], questions = []) {
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
    return { questionId, optionIds, labels }
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

function normalizeOption(raw, index) {
  if (typeof raw === 'string') {
    const label = cleanText(raw, LIMITS.approvalOption)
    return label ? { id: 'option-' + (index + 1), label } : null
  }
  if (!isObject(raw)) return null
  const label = cleanText(raw.label, LIMITS.approvalOption)
  if (!label) return null
  const id = cleanText(raw.id, 40) || 'option-' + (index + 1)
  const description = cleanText(raw.description, 300)
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(APPROVAL_TONES.includes(raw.tone) ? { tone: raw.tone } : {}),
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
  return {
    schemaVersion: SCHEMA_VERSION,
    boards,
    cards,
    activities,
    meta: {
      createdAt: integer(meta.createdAt, fallbackNow, 0),
      updatedAt: integer(meta.updatedAt, fallbackNow, 0),
      revision: Math.max(0, integer(meta.revision, 0, 0)),
      ...(meta.seededAt !== undefined ? { seededAt: integer(meta.seededAt, fallbackNow, 0) } : {}),
      lastActor,
    },
  }
}

// ---------------- 查询与排序 ----------------

export function cardsOfBoard(draft, boardId, { includeArchived = false } = {}) {
  return draft.cards.filter(card => card.boardId === boardId && (includeArchived || !card.archived))
}

export function countsFor(cards, boardId) {
  const counts = { backlog: 0, running: 0, needs_you: 0, done: 0, total: 0 }
  for (const card of cards) {
    if (card.boardId !== boardId || card.archived) continue
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

export function findApproval(card, approvalId) {
  return (card.approvals || []).find(approval => approval.id === approvalId)
}

export function pendingApproval(card) {
  return (card.approvals || []).find(approval => approval.status === 'pending')
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

function applyStatusFields(card, status, now) {
  card.status = status
  if (status === 'running' && !card.startedAt) card.startedAt = now
  if (status === 'done' || status === 'canceled') card.completedAt = now
  else if (card.completedAt !== undefined) delete card.completedAt
}

/** 状态迁移的统一入口：同步 startedAt/completedAt、cardOrder 与 status Activity。 */
export function changeStatus(draft, card, status, { actor, now, text, data } = {}) {
  const from = card.status
  if (from === status) return null
  const board = findBoard(draft, card.boardId)
  applyStatusFields(card, status, now)
  if (board) moveInOrder(board, card, COLUMN_OF_STATUS[status])
  return pushActivity(draft, card, {
    type: 'status',
    actor,
    text: text || `把状态改为「${STATUS_LABELS[status]}」`,
    data: { from, to: status, ...(isObject(data) ? data : {}) },
    at: now,
  })
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
  const card = {
    id: newCardId(),
    boardId: board.id,
    title,
    summary: cleanText(input.summary, LIMITS.summary),
    status,
    priority: normalizePriority(input.priority),
    labels: normalizeLabels(input.labels),
    ...(cleanText(input.project, LIMITS.boardName) ? { project: cleanText(input.project, LIMITS.boardName) } : {}),
    ...(cleanText(input.workspaceId, LIMITS.sessionId) ? { workspaceId: cleanText(input.workspaceId, LIMITS.sessionId) } : {}),
    ...(cleanText(input.cwd, 1000) ? { cwd: cleanText(input.cwd, 1000) } : {}),
    sessionIds: sessionId ? [sessionId] : [],
    ...(normalizeAgent(input.agent) ? { agent: normalizeAgent(input.agent) } : {}),
    checklists: [],
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
export function patchCard(draft, cardId, changes, { actor = defaultActor('user'), now = nowMs() } = {}) {
  if (!isObject(changes)) throw new DomainError('BAD_REQUEST', 'changes 必须是对象')
  const card = requireCard(draft, cardId)
  const activities = []
  const board = findBoard(draft, card.boardId)
  let statusChanged = false
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
          const activity = changeStatus(draft, card, status, { actor, now })
          if (activity) activities.push(activity)
        }
        break
      }
      case 'priority': card.priority = normalizePriority(value); break
      case 'labels': card.labels = normalizeLabels(value); break
      case 'project': case 'workspaceId': case 'cwd': patchTextField(card, key, value, key === 'cwd' ? 1000 : LIMITS.boardName); break
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

export function moveCard(draft, cardId, { column, status, beforeId, afterId, text, actor = defaultActor('user'), now = nowMs() } = {}) {
  const card = requireCard(draft, cardId)
  const board = findBoard(draft, card.boardId)
  const targetColumn = column !== undefined ? normalizeColumn(column) : COLUMN_OF_STATUS[normalizeStatus(status)]
  const targetStatus = status !== undefined ? normalizeStatus(status) : STATUS_OF_COLUMN[targetColumn]
  const reason = cleanText(text, 200)
  const label = COLUMN_LABELS[targetColumn]
  applyStatusFields(card, targetStatus, now)
  moveInOrder(board, card, targetColumn, { beforeId: cleanText(beforeId, 40) || undefined, afterId: cleanText(afterId, 40) || undefined })
  const activity = pushActivity(draft, card, {
    type: 'status', actor,
    text: `把卡片移到「${label}」${reason ? '：' + reason : ''}`,
    data: { column: targetColumn, status: targetStatus, ...(reason ? { reason } : {}) },
    at: now,
  })
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
  card.approvals.push(approval)
  if (card.approvals.length > LIMITS.approvals) card.approvals = card.approvals.slice(-LIMITS.approvals)
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

function selectedIds(values, label) {
  const ids = []
  for (const value of Array.isArray(values) ? values : values !== undefined ? [values] : []) {
    const id = cleanText(value, 40)
    if (id && !ids.includes(id)) ids.push(id)
  }
  if (!ids.length) throw new DomainError('BAD_REQUEST', `${label}至少需要选择 1 个选项`)
  return ids
}

/**
 * 解决审批：多题用 answers[{questionId, optionIds[]}] 逐题作答；
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
      const ids = selectedIds(answer.optionIds !== undefined ? answer.optionIds : answer.optionId, `第 ${questionId} 题`)
      const picked = ids.map(id => {
        const option = question.options.find(item => item.id === id)
        if (!option) throw new DomainError('BAD_REQUEST', `题目 ${questionId} 中不存在选项：${id}`)
        return option
      })
      if (question.multiSelect !== true && picked.length !== 1) {
        throw new DomainError('BAD_REQUEST', `题目 ${questionId} 为单选，只能选择 1 个选项`)
      }
      answered.set(questionId, picked)
      selected.push(...picked)
    }
    const missing = questions.filter(question => !answered.has(question.id))
    if (missing.length) throw new DomainError('BAD_REQUEST', `还有 ${missing.length} 题未作答：${missing.map(question => question.id).join('、')}`)
    for (const question of questions) {
      const picked = answered.get(question.id)
      resolvedAnswers.push({ questionId: question.id, optionIds: picked.map(option => option.id), labels: picked.map(option => option.label) })
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
  const rejected = selected.every(isRejectOption)
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
  const activity = pushActivity(draft, card, {
    type: 'approval_resolved', actor,
    text: `${rejected ? '已拒绝' : '已批准'}「${approval.title}」${questions.length ? `（${questions.length} 题）` : ''}：${labelsFlat.join('、')}`,
    data: {
      approvalId: approval.id,
      optionIds: optionIdsFlat,
      ...(resolvedAnswers.length ? { questionIds: resolvedAnswers.map(answer => answer.questionId) } : {}),
      decision: approval.status,
    },
    at: now,
  })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, approval, activity }
}

export function linkSession(draft, cardId, { sessionId, title, actor = defaultActor('user'), now = nowMs() }) {
  const card = requireCard(draft, cardId)
  const session = requiredText(sessionId, LIMITS.sessionId, 'BAD_REQUEST', '会话 ID 不能为空')
  card.sessionIds = [session, ...(card.sessionIds || []).filter(id => id !== session)].slice(0, LIMITS.sessionIds)
  const activity = pushActivity(draft, card, {
    type: 'session_linked', actor,
    text: `关联了 DSH 会话${cleanText(title, 120) ? '「' + cleanText(title, 120) + '」' : ''}`,
    data: { sessionId: session, action: 'link' }, at: now,
  })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity }
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

export function ackCard(draft, cardId, { actor = defaultActor('user'), now = nowMs() } = {}) {
  const card = requireCard(draft, cardId)
  const activity = pushActivity(draft, card, { type: 'ack', actor, text: '已读卡片动态', at: now })
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activity }
}

export function completeCard(draft, cardId, { result, actor = defaultActor('agent'), now = nowMs() } = {}) {
  const card = requireCard(draft, cardId)
  const activities = []
  if (result !== undefined && result !== null) {
    const text = cleanText(result, LIMITS.result)
    if (text) card.result = text
  }
  const statusActivity = changeStatus(draft, card, 'done', { actor, now, text: '完成了卡片' })
  if (statusActivity) activities.push(statusActivity)
  activities.push(pushActivity(draft, card, {
    type: 'result', actor, text: card.result || '完成，无补充说明', data: { completedAt: now }, at: now,
  }))
  touchCard(card, now)
  touchMeta(draft, actor, now)
  return { card, activities }
}

export function archiveCard(draft, cardId, { actor = defaultActor('user'), now = nowMs(), reason, text } = {}) {
  const card = requireCard(draft, cardId)
  const board = findBoard(draft, card.boardId)
  card.archived = true
  card.archivedAt = now
  card.updatedAt = now
  if (board) {
    rebuildOrder(board)
    for (const column of COLUMNS) board.cardOrder[column] = board.cardOrder[column].filter(id => id !== card.id)
    board.updatedAt = now
  }
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

/** 批量归档：跳过不存在/已归档的卡片；返回已处理卡片与跳过明细。 */
export function batchArchive(draft, cardIds, { actor = defaultActor('user'), now = nowMs(), reason } = {}) {
  const ids = normalizeBatchCardIds(cardIds)
  const byId = new Map(draft.cards.map(card => [card.id, card]))
  const cards = []
  const skipped = []
  for (const id of ids) {
    const card = byId.get(id)
    if (!card) { skipped.push({ id, reason: 'not_found' }); continue }
    if (card.archived) { skipped.push({ id, reason: 'archived' }); continue }
    cards.push(archiveCard(draft, id, { actor, now, reason }).card)
  }
  return { cards, skipped }
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
    applyStatusFields(card, targetStatus, now)
    moveInOrder(board, card, targetColumn)
    pushActivity(draft, card, {
      type: 'status', actor, text: `把卡片移到「${COLUMN_LABELS[targetColumn]}」`,
      data: { column: targetColumn, status: targetStatus, batch: true }, at: now,
    })
    touchCard(card, now)
    board.updatedAt = now
    cards.push(card)
  }
  cards.sort((left, right) => ids.indexOf(left.id) - ids.indexOf(right.id))
  touchMeta(draft, actor, now)
  return { cards, skipped }
}

/** 自动归档候选：仅 done/canceled，且 completedAt 早于 now - days。 */
export function autoArchiveCandidates(cards, { days = 30, now = nowMs() } = {}) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  if (!safeDays) return []
  const cutoff = now - safeDays * 86_400_000
  return cards.filter(card => !card.archived
    && (card.status === 'done' || card.status === 'canceled')
    && Number.isFinite(card.completedAt)
    && card.completedAt <= cutoff)
}

/** 已完成自动归档；返回归档数量（供插件定时任务记录日志）。 */
export function autoArchiveCompleted(draft, { days = 30, now = nowMs() } = {}) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  if (!safeDays) return 0
  const candidates = autoArchiveCandidates(draft.cards, { days: safeDays, now })
  const system = defaultActor('system')
  for (const card of candidates) {
    archiveCard(draft, card.id, { actor: system, now, text: `自动归档：已完成超过 ${safeDays} 天` })
  }
  return candidates.length
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
    draft.cards = seed.cards
    draft.activities = seed.activities
  }
  draft.meta = { createdAt, updatedAt: now, revision, seededAt: now, lastActor: defaultActor('system') }
  return draft
}
