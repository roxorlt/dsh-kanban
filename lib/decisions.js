// 决策日志：只追加的事件流（<dataDir>/decisions.jsonl），保存正式审批的请求 / 提交 / 未决关闭原始数据。
// 设计要点（见 docs/contracts/05-decision-log.md）：
// - 与 data.json 分离：data.json 每次全量重写且卡片内审批/时间线有上限，日志必须独立且只追加；
// - 写入顺序由 store.js 保证：同一个 update 事务里先 append 日志（fsync）再写 data.json，
//   日志可能领先于数据（多记一条），但不会少记；
// - 日志是「事件流」：不存状态，waiting / resolved / unresolved 在读取时由事件重放派生；
// - 容忍坏行：解析失败的行跳过但不删除、不覆盖；文件被手动删掉后重启会按当前 data.json 重新回填。
// 本模块不碰 HTTP，也不改 data.json；domain.js 只负责把决策事件塞进 draft.__decisions。
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  APPROVAL_OUTCOMES, COLUMN_OF_STATUS, DEFAULT_BOARD_ID, DomainError, LIMITS,
  cleanText, decisionCardContext, integer, isValidId, normalizeActor,
  normalizeApprovalSnapshot, normalizeDecisionCardContext, normalizeResolution, nowMs,
} from './domain.js'

export const DECISION_LOG_VERSION = 1
export const DECISION_FILE_NAME = 'decisions.jsonl'
export const DECISION_TYPES = ['approval_requested', 'approval_resolved', 'approval_unresolved', 'log_initialized', 'data_reset']
export const DECISION_SOURCES = ['live', 'backfill']
export const APPROVAL_DECISION_STATES = ['waiting', 'resolved', 'unresolved']
export const APPROVAL_DECISIONS = ['approved', 'rejected', 'dismissed']
export const UNRESOLVED_REASONS = ['archived', 'left_needs_you', 'trimmed', 'data_reset']
export const DECISION_LIST_LIMIT = 50
export const DECISION_LIST_MAX = 200

const REQUESTED = 'approval_requested'
const RESOLVED = 'approval_resolved'
const UNRESOLVED = 'approval_unresolved'
const LOG_INITIALIZED = 'log_initialized'
const APPROVAL_TYPES = [REQUESTED, RESOLVED, UNRESOLVED]
const DECISION_ID_RE = /^dec-[a-f0-9]{8,16}$/
const CARD_ID_RE = /^card-[a-f0-9]{6,8}$/
const APPROVAL_ID_RE = /^ap-[a-f0-9]{6,8}$/

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hexBytes = bytes => randomBytes(bytes).toString('hex')

export const newDecisionId = () => 'dec-' + hexBytes(6)

/** 审批事件 id 由 cardId + approvalId + kind 确定性派生（sha1 前 12 位 hex），让在线写入与回填对同一条审批得到同一个 id。 */
export function decisionIdFor(cardId, approvalId, kind) {
  const digest = createHash('sha1').update(`${cardId}\u0000${approvalId}\u0000${kind}`).digest('hex')
  return `dec-${digest.slice(0, 12)}`
}

function isDecisionId(value) {
  return typeof value === 'string' && DECISION_ID_RE.test(value)
}

function isCardId(value) {
  return typeof value === 'string' && CARD_ID_RE.test(value)
}

function isApprovalId(value) {
  return typeof value === 'string' && APPROVAL_ID_RE.test(value)
}

// ---------------- 事件规范化 ----------------

function normalizeCounts(raw, keys) {
  const source = isObject(raw) ? raw : {}
  const counts = {}
  for (const key of keys) counts[key] = integer(source[key], 0, 0)
  return counts
}

/** 宽松规范化一条决策事件；结构不可用时返回 null（读取旧/坏行时丢弃而不是让整份日志失败）。 */
export function normalizeDecisionEntry(raw) {
  if (!isObject(raw) || !DECISION_TYPES.includes(raw.type)) return null
  const type = raw.type
  const entry = {
    v: DECISION_LOG_VERSION,
    type,
    at: integer(raw.at, nowMs(), 0),
    source: DECISION_SOURCES.includes(raw.source) ? raw.source : 'live',
  }
  if (isDecisionId(raw.id)) entry.id = raw.id
  if (raw.seq !== undefined) entry.seq = integer(raw.seq, 0, 0)
  if (raw.revision !== undefined) entry.revision = integer(raw.revision, 0, 0)

  if (APPROVAL_TYPES.includes(type)) {
    if (!isCardId(raw.cardId) || !isApprovalId(raw.approvalId)) return null
    entry.boardId = cleanText(raw.boardId, 40) || DEFAULT_BOARD_ID
    entry.cardId = raw.cardId
    entry.approvalId = raw.approvalId
    entry.actor = normalizeActor(raw.actor, type === REQUESTED ? 'agent' : type === UNRESOLVED ? 'system' : 'user')
    const sessionId = cleanText(raw.sessionId, LIMITS.sessionId)
    if (sessionId) entry.sessionId = sessionId
    entry.card = normalizeDecisionCardContext(raw.card)
    if (raw.degraded === true) {
      entry.degraded = true
      const rawText = cleanText(raw.rawText, LIMITS.activityText)
      if (rawText) entry.rawText = rawText
      const activityId = cleanText(raw.evidence?.activityId, 40)
      if (activityId) entry.evidence = { activityId }
    }
    entry.id = entry.id && entry.id.startsWith('dec-') ? entry.id : decisionIdFor(entry.cardId, entry.approvalId, type === REQUESTED ? 'requested' : type === RESOLVED ? 'resolved' : 'unresolved')
    if (type === REQUESTED) {
      const snapshot = normalizeApprovalSnapshot(raw.approval)
      if (!snapshot && !entry.degraded) return null
      entry.approval = snapshot || { title: cleanText(raw.approval?.title, LIMITS.approvalTitle) || '（原始审批已裁剪）', detail: '', multiSelect: false, options: [] }
    } else {
      entry.requestId = isDecisionId(raw.requestId) ? raw.requestId : decisionIdFor(entry.cardId, entry.approvalId, 'requested')
      entry.waitedMs = integer(raw.waitedMs, 0, 0)
      if (type === RESOLVED) {
        if (!APPROVAL_DECISIONS.includes(raw.decision)) return null
        entry.decision = raw.decision
        entry.resolution = normalizeResolution(isObject(raw.resolution) ? raw.resolution : {}, [], [])
        if (APPROVAL_OUTCOMES.includes(raw.outcomeColumn)) entry.outcomeColumn = raw.outcomeColumn
      } else {
        if (!UNRESOLVED_REASONS.includes(raw.reason)) return null
        entry.reason = raw.reason
      }
    }
    return entry
  }

  if (type === LOG_INITIALIZED) {
    entry.id = entry.id || newDecisionId()
    entry.counts = normalizeCounts(raw.counts, ['cards', 'approvals', 'requested', 'resolved', 'pending', 'activities', 'entries'])
    return entry
  }

  // data_reset
  entry.id = entry.id || newDecisionId()
  if (!['demo', 'empty', 'reset'].includes(raw.mode)) return null
  entry.mode = raw.mode
  entry.actor = normalizeActor(raw.actor, 'system')
  entry.before = normalizeCounts(raw.before, ['cards', 'approvals', 'pending', 'activities'])
  return entry
}

// ---------------- 回填（data.json → 事件流） ----------------

function activityTitle(text) {
  const match = /「([^」]*)」/.exec(String(text || ''))
  return cleanText(match ? match[1] : '', LIMITS.approvalTitle)
}

function approvalRequestEntry(card, approval, { source = 'backfill', at = approval.requestedAt } = {}) {
  return {
    v: DECISION_LOG_VERSION,
    type: REQUESTED,
    at,
    source,
    boardId: card.boardId,
    cardId: card.id,
    approvalId: approval.id,
    actor: approval.requestedBy,
    ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
    card: decisionCardContext(card),
    approval: normalizeApprovalSnapshot(approval) || { title: approval.title || '', detail: '', multiSelect: false, options: [] },
  }
}

function approvalResolvedEntry(card, approval, { source = 'backfill', outcomeByCardAt } = {}) {
  const resolvedAt = approval.resolvedAt ?? approval.requestedAt ?? nowMs()
  const decision = APPROVAL_DECISIONS.includes(approval.status) ? approval.status : 'approved'
  const entry = {
    v: DECISION_LOG_VERSION,
    type: RESOLVED,
    at: resolvedAt,
    source,
    boardId: card.boardId,
    cardId: card.id,
    approvalId: approval.id,
    actor: approval.resolvedBy || { kind: 'user', name: '你' },
    ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
    card: decisionCardContext(card),
    decision,
    resolution: normalizeResolution(isObject(approval.resolution) ? approval.resolution : {}, [], []),
    waitedMs: Math.max(0, resolvedAt - integer(approval.requestedAt, resolvedAt, 0)),
  }
  const column = outcomeByCardAt?.get(`${card.id}:${resolvedAt}`)
  if (column) entry.outcomeColumn = column
  return entry
}

function approvalUnresolvedEntry(card, approval, { reason, at, actor, source = 'backfill' } = {}) {
  return {
    v: DECISION_LOG_VERSION,
    type: UNRESOLVED,
    at: at ?? nowMs(),
    source,
    boardId: card.boardId,
    cardId: card.id,
    approvalId: approval.id,
    actor: actor || { kind: 'system', name: 'system' },
    ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
    card: decisionCardContext(card),
    reason,
    waitedMs: Math.max(0, (at ?? nowMs()) - integer(approval.requestedAt, at ?? nowMs(), 0)),
  }
}

/** 回填时从 status 活动里捞出「审批提交后卡片进哪列」，匹配同卡同毫秒的 status 活动。 */
function collectApprovalOutcomes(activities) {
  const map = new Map()
  for (const activity of activities) {
    if (activity?.type !== 'status' || activity?.data?.reason !== 'approval_resolved') continue
    if (!isCardId(activity.cardId) || !COLUMN_OF_STATUS[activity.data?.to]) continue
    map.set(`${activity.cardId}:${activity.at}`, COLUMN_OF_STATUS[activity.data.to])
  }
  return map
}

/**
 * 从 data.json 快照回填决策事件（首次启用时调用一次）。
 * 覆盖：卡片内仍保留的 approvals（含已归档卡片）+ 因审批/时间线裁剪而只剩 activity 的审批（degraded）。
 */
export function buildBackfillEntries(snapshot, { now = nowMs() } = {}) {
  const cards = Array.isArray(snapshot?.cards) ? snapshot.cards.filter(card => isObject(card) && isCardId(card.id)) : []
  const activities = (Array.isArray(snapshot?.activities) ? snapshot.activities : []).filter(activity => isObject(activity) && isCardId(activity.cardId))
  const cardById = new Map(cards.map(card => [card.id, card]))
  const outcomeByCardAt = collectApprovalOutcomes(activities)
  const events = []
  const covered = new Set()
  const requestedAtByApproval = new Map()
  const requestedCount = { cards: cards.length, approvals: 0, requested: 0, resolved: 0, pending: 0, activities: activities.length }

  for (const card of cards) {
    for (const approval of Array.isArray(card.approvals) ? card.approvals : []) {
      if (!isObject(approval) || !isApprovalId(approval.id)) continue
      covered.add(`${card.id}:${approval.id}`)
      if (Number.isFinite(approval.requestedAt)) requestedAtByApproval.set(`${card.id}:${approval.id}`, approval.requestedAt)
      requestedCount.approvals += 1
      events.push(approvalRequestEntry(card, approval))
      if (approval.status === 'approved' || approval.status === 'rejected' || approval.status === 'dismissed') {
        requestedCount.resolved += 1
        events.push(approvalResolvedEntry(card, approval, { outcomeByCardAt }))
        continue
      }
      // 仍是 pending：归档卡 / 已不在「待你确认」列的历史遗留，补一条未决关闭。
      if (approval.status !== 'pending') continue
      requestedCount.pending += 1
      if (card.archived) {
        events.push(approvalUnresolvedEntry(card, approval, {
          reason: 'archived', at: card.archivedAt ?? approval.requestedAt, actor: { kind: 'system', name: 'system' },
        }))
      } else if (COLUMN_OF_STATUS[card.status] !== 'needs_you') {
        events.push(approvalUnresolvedEntry(card, approval, {
          reason: 'left_needs_you', at: card.updatedAt ?? approval.requestedAt, actor: { kind: 'system', name: 'system' },
        }))
      }
    }
  }

  // 只剩 activity 的审批（卡片内已被 20 条上限裁剪）：尽力恢复成 degraded 事件。
  const degradedRequests = new Set()
  const degradedResolved = new Set()
  for (const activity of activities) {
    if (activity.type !== REQUESTED && activity.type !== RESOLVED) continue
    const approvalId = cleanText(activity.data?.approvalId, 40)
    if (!isApprovalId(approvalId)) continue
    const key = `${activity.cardId}:${approvalId}`
    if (covered.has(key)) continue
    const card = cardById.get(activity.cardId)
    if (!card) continue
    if (activity.type === REQUESTED) {
      if (degradedRequests.has(key)) continue
      degradedRequests.add(key)
      requestedAtByApproval.set(key, activity.at)
      events.push({
        v: DECISION_LOG_VERSION,
        type: REQUESTED,
        at: activity.at,
        source: 'backfill',
        boardId: card.boardId,
        cardId: card.id,
        approvalId,
        actor: activity.actor,
        card: decisionCardContext(card),
        approval: { title: activityTitle(activity.text) || '（原始审批已裁剪）', detail: '', multiSelect: activity.data?.multiSelect === true, options: [] },
        degraded: true,
        rawText: cleanText(activity.text, LIMITS.activityText),
        evidence: { activityId: activity.id },
      })
      continue
    }
    if (degradedResolved.has(key)) continue
    degradedResolved.add(key)
    const requestedAt = requestedAtByApproval.get(key)
    events.push({
      v: DECISION_LOG_VERSION,
      type: RESOLVED,
      at: activity.at,
      source: 'backfill',
      boardId: card.boardId,
      cardId: card.id,
      approvalId,
      actor: activity.actor,
      card: decisionCardContext(card),
      decision: activity.data?.decision === 'rejected' ? 'rejected' : activity.data?.decision === 'dismissed' ? 'dismissed' : 'approved',
      resolution: normalizeResolution({
        optionIds: Array.isArray(activity.data?.optionIds) ? activity.data.optionIds : [],
        labels: [],
      }, [], []),
      waitedMs: Number.isFinite(requestedAt) ? Math.max(0, activity.at - requestedAt) : 0,
      degraded: true,
      rawText: cleanText(activity.text, LIMITS.activityText),
      evidence: { activityId: activity.id },
    })
  }

  const rank = { approval_requested: 0, approval_resolved: 1, approval_unresolved: 2 }
  events.sort((left, right) => left.at - right.at
    || (rank[left.type] ?? 3) - (rank[right.type] ?? 3)
    || String(left.approvalId).localeCompare(String(right.approvalId)))

  const marker = {
    v: DECISION_LOG_VERSION,
    type: LOG_INITIALIZED,
    at: now,
    source: 'backfill',
    counts: {
      cards: requestedCount.cards,
      approvals: requestedCount.approvals,
      requested: events.filter(entry => entry.type === REQUESTED).length,
      resolved: events.filter(entry => entry.type === RESOLVED).length,
      pending: requestedCount.pending,
      activities: requestedCount.activities,
      entries: events.length,
    },
  }
  return [...events, marker]
}

// ---------------- 日志对象 ----------------

function parseTypeFilter(value) {
  if (value === undefined || value === null || value === '') return null
  const list = (Array.isArray(value) ? value : String(value).split(',')).map(item => cleanText(item, 40)).filter(Boolean)
  for (const item of list) {
    if (!DECISION_TYPES.includes(item)) throw new DomainError('BAD_REQUEST', `未知的决策事件类型：${item}`)
  }
  return list.length ? list : null
}

function parseStateFilter(value) {
  if (value === undefined || value === null || value === '') return null
  const state = cleanText(value, 20)
  if (!APPROVAL_DECISION_STATES.includes(state)) throw new DomainError('BAD_REQUEST', `state 只能是 ${APPROVAL_DECISION_STATES.join(' / ')}`)
  return state
}

function parseSourceFilter(value) {
  if (value === undefined || value === null || value === '') return null
  const source = cleanText(value, 20)
  if (!DECISION_SOURCES.includes(source)) throw new DomainError('BAD_REQUEST', `source 只能是 ${DECISION_SOURCES.join(' / ')}`)
  return source
}

function parseTimeFilter(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new DomainError('BAD_REQUEST', `${label} 必须是 epoch 毫秒时间戳`)
  return Math.trunc(number)
}

function normalizeListLimit(value) {
  if (value === undefined || value === null || value === '') return DECISION_LIST_LIMIT
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) throw new DomainError('BAD_REQUEST', 'limit 必须是正整数')
  return Math.min(DECISION_LIST_MAX, Math.trunc(number))
}

/**
 * 决策日志读取对象。
 * 文件不存在即视为未初始化：append 前会按需创建目录与文件（0600）。
 */
export function createDecisionLog({ file, logger } = {}) {
  if (!file) throw new Error('createDecisionLog 需要 file')
  const target = resolve(String(file))
  let cache = null
  let loading = null
  let queue = Promise.resolve()
  let closed = false

  const warn = message => { try { logger?.warn?.(message) } catch {} }

  async function load() {
    let text
    try {
      text = await readFile(target, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw Object.assign(new Error(`读取决策日志失败：${error.message}`), { code: 'DECISION_LOG_IO', cause: error })
      cache = { entries: [], skippedLines: 0, nextSeq: 1 }
      return cache
    }
    const entries = []
    let skippedLines = 0
    let maxRawSeq = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let raw
      try { raw = JSON.parse(trimmed) } catch { skippedLines += 1; continue }
      if (Number.isInteger(raw?.seq) && raw.seq > maxRawSeq) maxRawSeq = raw.seq
      const entry = normalizeDecisionEntry(raw)
      if (!entry) { skippedLines += 1; continue }
      entries.push(entry)
    }
    // seq 以文件内位置为准（追加顺序），坏行消失后仍然连续；at 才是事件真实时间。
    // nextSeq 取「位置编号」与「原始文件里出现过的最大 seq」的较大者 +1，避免新事件与坏行/旧行重号。
    entries.forEach((entry, index) => { entry.seq = index + 1 })
    if (skippedLines) warn(`[dsh-kanban] 决策日志有 ${skippedLines} 行无法解析，已跳过（原文件保留）`)
    cache = { entries, skippedLines, nextSeq: Math.max(entries.length, maxRawSeq) + 1 }
    return cache
  }

  function ready() {
    if (cache) return Promise.resolve(cache)
    if (!loading) {
      loading = load().then(
        value => { cache = value; loading = null; return value },
        error => { loading = null; throw error },
      )
    }
    return loading
  }

  function enqueue(task) {
    const run = queue.then(task, task)
    queue = run.then(() => {}, () => {})
    return run
  }

  /** 规范化 + 编号 + 追加写盘；调用方需已持有写队列。 */
  async function writeEntries(rawEntries, { revision } = {}) {
    const current = await ready()
    const normalized = (Array.isArray(rawEntries) ? rawEntries : []).filter(Boolean).map(raw => {
      const entry = normalizeDecisionEntry(raw)
      if (!entry) throw Object.assign(new Error(`决策事件格式无效：${raw?.type ?? '(未知)'}`), { code: 'DECISION_LOG_INVALID' })
      return entry
    })
    if (!normalized.length) return []
    const startSeq = current.nextSeq || current.entries.length + 1
    normalized.forEach((entry, index) => {
      entry.seq = startSeq + index
      if (revision !== undefined) entry.revision = revision
    })
    const text = normalized.map(entry => JSON.stringify(entry) + '\n').join('')
    try {
      await mkdir(dirname(target), { recursive: true })
      const handle = await open(target, 'a', 0o600)
      try {
        // 已存在的文件不会被 open 的 mode 收紧：显式 chmod，保证日志始终 0600。
        await handle.chmod(0o600).catch(() => {})
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw Object.assign(new Error(`写入决策日志失败：${error.message}`), { code: 'DECISION_LOG_IO', cause: error })
    }
    current.entries.push(...normalized)
    current.nextSeq = startSeq + normalized.length
    return normalized
  }

  async function append(rawEntries, { revision } = {}) {
    const list = (Array.isArray(rawEntries) ? rawEntries : []).filter(Boolean)
    if (!list.length) return []
    return enqueue(async () => {
      if (closed) throw Object.assign(new Error('决策日志已关闭'), { code: 'DECISION_LOG_CLOSED' })
      return writeEntries(list, { revision })
    })
  }

  async function fileInfo() {
    try {
      const info = await stat(target)
      return { exists: true, sizeBytes: info.size }
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, sizeBytes: 0 }
      throw Object.assign(new Error(`读取决策日志状态失败：${error.message}`), { code: 'DECISION_LOG_IO', cause: error })
    }
  }

  function deriveClosed(cacheValue) {
    const closedByRequest = new Map()
    for (const entry of cacheValue.entries) {
      if (entry.type === RESOLVED || entry.type === UNRESOLVED) closedByRequest.set(entry.requestId, entry)
    }
    return closedByRequest
  }

  function requestState(entry, closedByRequest) {
    const closed = closedByRequest.get(entry.id)
    if (!closed) return 'waiting'
    return closed.type === RESOLVED ? 'resolved' : 'unresolved'
  }

  /** 是否已完成首次回填（存在 log_initialized 标记）。 */
  async function isInitialized() {
    const current = await ready()
    return current.entries.some(entry => entry.type === LOG_INITIALIZED)
  }

  /** 等待中的审批数：按唯一 requestId 计数（防御历史文件里可能存在的重复 id）。 */
  function countWaiting(entries, closedByRequest) {
    const waitingIds = new Set()
    for (const entry of entries) {
      if (entry.type === REQUESTED && !closedByRequest.has(entry.id)) waitingIds.add(entry.id)
    }
    return waitingIds.size
  }

  function enrich(entry, closedByRequest) {
    if (entry.type !== REQUESTED) return entry
    const closed = closedByRequest.get(entry.id)
    return {
      ...entry,
      state: requestState(entry, closedByRequest),
      ...(closed ? { closedAt: closed.at } : {}),
      ...(closed?.type === RESOLVED ? { decision: closed.decision } : {}),
      ...(closed?.type === UNRESOLVED ? { unresolvedReason: closed.reason } : {}),
    }
  }

  /** 倒序列表 + 筛选 + 游标分页；返回派生 state 与统计。 */
  async function list(params = {}) {
    const current = await ready()
    const limit = normalizeListLimit(params.limit)
    const types = parseTypeFilter(params.type)
    const state = parseStateFilter(params.state)
    const source = parseSourceFilter(params.source)
    const since = parseTimeFilter(params.since, 'since')
    const until = parseTimeFilter(params.until, 'until')
    const cardId = cleanText(params.cardId, 40)
    const boardId = cleanText(params.boardId, 40)
    const approvalId = cleanText(params.approvalId, 40)
    if (cardId && !isCardId(cardId)) throw new DomainError('BAD_REQUEST', 'cardId 格式不合法')
    if (boardId && !isValidId(boardId)) throw new DomainError('BAD_REQUEST', 'boardId 格式不合法')
    if (approvalId && !isApprovalId(approvalId)) throw new DomainError('BAD_REQUEST', 'approvalId 格式不合法')
    const closedByRequest = deriveClosed(current)
    const filtered = []
    for (const entry of current.entries) {
      if (types && !types.includes(entry.type)) continue
      if (source && entry.source !== source) continue
      if (cardId && entry.cardId !== cardId) continue
      if (boardId && entry.boardId !== boardId) continue
      if (approvalId && entry.approvalId !== approvalId) continue
      if (since !== undefined && entry.at < since) continue
      if (until !== undefined && entry.at > until) continue
      if (state) {
        if (entry.type !== REQUESTED || requestState(entry, closedByRequest) !== state) continue
      }
      filtered.push(entry)
    }
    filtered.sort((left, right) => right.at - left.at || right.seq - left.seq)
    let start = 0
    const before = cleanText(params.before, 40)
    if (before) {
      // 取最后一次出现的位置：即使历史文件有重复 id，游标也会继续前进，不会死循环。
      const index = filtered.findLastIndex(entry => entry.id === before)
      if (index < 0) throw new DomainError('BAD_REQUEST', 'before 游标不存在')
      start = index + 1
    }
    const page = filtered.slice(start, start + limit).map(entry => enrich(entry, closedByRequest))
    const hasMore = start + page.length < filtered.length
    const waiting = countWaiting(current.entries, closedByRequest)
    return {
      decisions: page,
      hasMore,
      nextBefore: hasMore && page.length ? page[page.length - 1].id : null,
      total: current.entries.length,
      filtered: filtered.length,
      waiting,
    }
  }

  async function stats() {
    const current = await ready()
    const info = await fileInfo()
    const byType = {}
    let firstAt
    let lastAt
    let initializedAt
    let waiting
    const closedByRequest = deriveClosed(current)
    for (const entry of current.entries) {
      byType[entry.type] = (byType[entry.type] || 0) + 1
      if (firstAt === undefined || entry.at < firstAt) firstAt = entry.at
      if (lastAt === undefined || entry.at > lastAt) lastAt = entry.at
      if (entry.type === LOG_INITIALIZED) initializedAt = entry.at
    }
    waiting = countWaiting(current.entries, closedByRequest)
    return {
      logVersion: DECISION_LOG_VERSION,
      file: target,
      exists: info.exists,
      sizeBytes: info.sizeBytes,
      entries: current.entries.length,
      skippedLines: current.skippedLines,
      byType,
      waiting,
      ...(firstAt !== undefined ? { firstAt } : {}),
      ...(lastAt !== undefined ? { lastAt } : {}),
      ...(initializedAt !== undefined ? { initializedAt } : {}),
    }
  }

  /**
   * 原样导出文件字节（不做规范化、不转 UTF-8 文本），并排进写队列之后读取：
   * 保证拿到的是一份完整快照，且 invalid UTF-8 的原始字节不会被替换成 U+FFFD。
   */
  async function exportBytes() {
    return enqueue(async () => {
      await ready()
      try {
        return await readFile(target)
      } catch (error) {
        if (error?.code === 'ENOENT') return Buffer.alloc(0)
        throw Object.assign(new Error(`导出决策日志失败：${error.message}`), { code: 'DECISION_LOG_IO', cause: error })
      }
    })
  }

  /** 文本形式的导出（测试/调试用）；HTTP 导出走 exportBytes 保证字节一致。 */
  async function exportText() {
    return (await exportBytes()).toString('utf8')
  }

  /**
   * 首次启用回填：以 `log_initialized` 标记判断是否已初始化（而不是仅看文件是否存在）。
   * - 文件不存在 / 为空 / 只有坏行 → 回填；
   * - 已有实时事件但还没标记（启动瞬间先来了写操作）→ 仍补一次回填，历史事件追加在末尾（读取按 at 排序）；
   * - 已有标记 → 不重复回填。
   */
  async function initializeFromSnapshot(snapshot, { now = nowMs() } = {}) {
    return enqueue(async () => {
      if (closed) throw Object.assign(new Error('决策日志已关闭'), { code: 'DECISION_LOG_CLOSED' })
      const current = await ready()
      if (current.entries.some(entry => entry.type === LOG_INITIALIZED)) return { created: false, entries: 0 }
      // 启动窗口可能已有实时事件：按确定性 id 跳过重复；
      // 同时做「收口感知」——某条审批在文件里已有 resolved/unresolved，就不再补第二条收口事件。
      const knownIds = new Set(current.entries.map(entry => entry.id).filter(Boolean))
      const closedRequests = new Set(current.entries
        .filter(entry => entry.type === RESOLVED || entry.type === UNRESOLVED)
        .map(entry => entry.requestId))
      const entries = buildBackfillEntries(snapshot, { now })
        .map(raw => normalizeDecisionEntry(raw))
        .filter(entry => {
          if (!entry) return false
          if (entry.type === LOG_INITIALIZED) return true
          if (knownIds.has(entry.id)) return false
          if ((entry.type === RESOLVED || entry.type === UNRESOLVED) && closedRequests.has(entry.requestId)) return false
          return true
        })
      const written = await writeEntries(entries)
      return { created: true, entries: written.length }
    })
  }

  async function close() {
    closed = true
    await queue.catch(() => {})
    cache = null
  }

  return {
    get file() { return target },
    get loaded() { return cache !== null },
    get entries() { return cache ? cache.entries.length : 0 },
    ready,
    append,
    list,
    stats,
    isInitialized,
    exportBytes,
    exportText,
    initializeFromSnapshot,
    close,
  }
}
