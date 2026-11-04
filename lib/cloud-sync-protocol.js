// 云端持久化（C1/3）——本地 ⇄ Cloudflare 的同步协议层（纯函数，无 I/O）。
//
// 定位：本地 Store（Local Execution Plane）与云端 Worker + D1（Cloud State & Ingress
// Plane）之间的**唯一协议实现**，供 C2（Worker 网关）与 C3（本地云同步守护器）共用。
// 本模块刻意不读写文件、不发网络请求、不依赖 DSH 宿主，只做四件事：
//
//   1. 脱敏：把本地 Store 投影成可上云的快照（字段白名单 + 路径/密钥清洗 + 执行面
//      字段剥离），本地权威数据永远不会被云端写回；
//   2. 增量：对两份脱敏快照做实体级 diff（upsert / delete），支持分片与回放；
//   3. 乐观锁：基于云端全局 revision 的 CAS 冲突检测、push 计划与幂等 pushId；
//   4. 入站：Bearer 常量时间校验、Webhook 入站信封（去重/白名单头/TTL）、本地回放
//      请求构造、失败退避，以及 cloud-config.json 的校验与安全描述。
//
// 契约：docs/contracts/08-cloud-sync.md；云侧表结构：cloudflare/migrations/0001_kanban_sync.sql。
//
// 约定：所有导出函数对入参不做原地修改（pure），非法入参抛 CloudSyncError。

import { createHash, timingSafeEqual } from 'node:crypto'

/** 协议版本：请求/响应必须携带，服务端只接受当前版本。 */
export const CLOUD_PROTOCOL_VERSION = 1

/** 云侧持久化实体类型（与 D1 表一一对应）。 */
export const CLOUD_ENTITY_KINDS = Object.freeze(['board', 'card', 'activity'])

/** 实体类型 → delta/pull 分组键（activity 的复数是 activities，不能简单拼接 s）。 */
export const CLOUD_ENTITY_BUCKETS = Object.freeze({
  board: 'boards',
  card: 'cards',
  activity: 'activities',
})

function bucketOf(kind) {
  return CLOUD_ENTITY_BUCKETS[kind]
}

/** 允许接入的 Webhook 来源（与本地 im-gateway 的 IM_PROVIDERS 对齐，另加 github）。 */
export const CLOUD_INGRESS_PROVIDERS = Object.freeze([
  'github', 'feishu', 'dingtalk', 'wecom', 'onebot', 'weixin', 'generic',
])

/** 协议层硬限制。C2/C3 实现必须遵守；超限由对应端返回明确错误码。 */
export const CLOUD_SYNC_LIMITS = Object.freeze({
  /** 单次 push 的 upsert + delete 实体总数上限（超过需先 chunkDelta 分片）。 */
  pushEntities: 200,
  /** 单次 push 请求体字节上限（256 KiB）。 */
  pushBytes: 256 * 1024,
  /** 单次 pull 每类实体返回行数上限（默认与最大同值）。 */
  pullEntities: 200,
  /** 单张卡片在云端保留的时间线节点上限（与本地 LIMITS.activitiesPerCard 对齐）。 */
  activitiesPerCard: 300,
  /** Webhook 原始请求体字节上限（128 KiB）；超限在边缘直接 413，不入队。 */
  ingressPayloadBytes: 128 * 1024,
  /** 单次 claim 的入站事件条数上限。 */
  ingressBatch: 20,
  /** 入站事件默认保留 7 天，过期未消费由 Cron 清理。 */
  ingressTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** 单个入站事件最大投递尝试次数，超过置 dead 等人工处理。 */
  ingressMaxAttempts: 20,
  /** 入站消费租约默认 120 秒；租约到期后条目可被重新 claim。 */
  ingressLeaseMs: 120 * 1000,
  /** 单条 HTTP 请求头值保留长度上限。 */
  headerValueBytes: 512,
})

/** 错误码 → 建议 HTTP 状态码（C2 用它组装统一错误响应）。 */
export const CLOUD_ERROR_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  REVISION_CONFLICT: 409,
  SYNC_EPOCH_MISMATCH: 409,
  UNSUPPORTED_PROTOCOL_VERSION: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  /** 本地 cloud-config.json 非法（不产生 HTTP 请求，沿用 500 语义）。 */
  BAD_CONFIG: 500,
})

/** 可上云的卡片字段白名单（其余字段一律按本地执行面字段剥离，见 CLOUD_LOCAL_ONLY_CARD_FIELDS）。 */
export const CLOUD_CARD_FIELDS = Object.freeze([
  'id', 'boardId', 'title', 'summary', 'currentAction', 'result', 'status', 'priority',
  'labels', 'project', 'externalRef', 'parentCardId', 'dependsOn', 'mergedInto',
  'agent', 'progress', 'checklists', 'approvals', 'artifacts', 'handoff', 'metadata',
  'order', 'version', 'archived', 'archivedAt', 'createdAt', 'updatedAt', 'startedAt', 'completedAt',
])

/**
 * 明确剥离的本地执行面字段：
 * - cwd / workspaceId / sessionIds / runtime：暴露本机目录结构与 DSH 会话，云端不需要；
 * - outbox / autoStart：本地调度语义，云端不参与执行；
 * - externalThreadId：IM 线程标识，属于本地通知链路。
 * 随卡片一起出现的 approvals[].sessionId、handoff.sessionId、agent.id 也一并剥离。
 */
export const CLOUD_LOCAL_ONLY_CARD_FIELDS = Object.freeze([
  'cwd', 'workspaceId', 'sessionIds', 'runtime', 'outbox', 'autoStart', 'externalThreadId',
])

/** 时间线 data 中整体丢弃的本地标识键（不是脱敏成 ~，而是直接不出现）。 */
export const CLOUD_ACTIVITY_DATA_DROP_KEYS = Object.freeze([
  'sessionId', 'sessionIds', 'workspaceId', 'cwd', 'dataDir', 'superAgentSessionId',
  'leaseToken', 'inboxId', 'clientId',
])

/** 入站事件落库时允许保留的请求头白名单（小写）。 */
export const CLOUD_INGRESS_HEADER_ALLOWLIST = Object.freeze([
  'content-type',
  'user-agent',
  'x-github-event',
  'x-github-delivery',
  'x-github-hook-id',
  'x-request-id',
  'x-feishu-request-id',
  'x-feishu-request-timestamp',
  'x-dingtalk-delivery-id',
  'x-dingtalk-event-id',
])

/** 本地 cloud-config.json 文件名（位于 <dataDir>，默认 ~/.dsh-kanban/，权限 0600）。 */
export const CLOUD_CONFIG_FILE_NAME = 'cloud-config.json'

const TOKEN_MIN_LENGTH = 16
const CLIENT_ID_MAX = 80
const CURSOR_MAX_LENGTH = 512

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/** 协议层统一错误：code 与 CLOUD_ERROR_STATUS 对齐；details 会并入错误响应。 */
export class CloudSyncError extends Error {
  constructor(code = 'BAD_REQUEST', message = '云端同步协议错误', { status, details } = {}) {
    super(message)
    this.name = 'CloudSyncError'
    this.code = code
    this.status = Number.isInteger(status) ? status : (CLOUD_ERROR_STATUS[code] ?? 400)
    this.details = details && typeof details === 'object' ? details : undefined
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}

/** 把任意异常规范化为 Worker 响应体（未知异常退化为 INTERNAL，不泄露堆栈）。 */
export function toErrorResponse(error, { requestId } = {}) {
  const normalized = error instanceof CloudSyncError
    ? error
    : new CloudSyncError('INTERNAL', '云端同步内部错误')
  const body = normalized.toJSON()
  if (requestId) body.requestId = String(requestId)
  return body
}

function badRequest(message, details) {
  return new CloudSyncError('BAD_REQUEST', message, { details })
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function nonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return fallback
  return Math.floor(numeric)
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// 1. 脱敏：文本清洗、路径归一、深度脱敏
// ---------------------------------------------------------------------------

const URL_SECRET_QUERY = /([?&](?:access_token|token|key|secret|sign|signature|api_key|client_secret)=)([^&\s"'#]+)/gi
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]{16,}\b/g
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|passwd|secret)\b(\s*[:=]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})/gi
const POSIX_HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g
const WINDOWS_HOME_PATH = /[A-Za-z]:\\Users\\[^\\\s"']+/g
const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|sign|signature)$/i

/**
 * 文本脱敏：清洗密钥、URL 查询凭据与用户目录前缀，输出确定性结果（同输入同输出）。
 * 用于卡片标题/摘要/时间线文本等自由文本；不会因清洗失败抛错。
 */
export function redactText(value) {
  if (typeof value !== 'string' || !value) return typeof value === 'string' ? value : ''
  return value
    .replace(URL_SECRET_QUERY, '$1****')
    .replace(BEARER_TOKEN, 'Bearer ****')
    .replace(SK_TOKEN, 'sk-****')
    .replace(GITHUB_TOKEN, 'gh-****')
    .replace(SLACK_TOKEN, 'xox-****')
    .replace(AWS_ACCESS_KEY, 'AKIA****')
    .replace(JWT_TOKEN, 'eyJ****')
    .replace(SECRET_ASSIGNMENT, '$1$2$3****')
    .replace(POSIX_HOME_PATH, '~')
    .replace(WINDOWS_HOME_PATH, '~')
}

/**
 * 路径归一：把 home 目录替换为 `~`（跨平台），其余部分保留，便于云端仍能看懂
 * 「工作副本在哪个仓」而不泄露本机用户名。非字符串原样返回。
 */
export function redactPath(value, { homeDir } = {}) {
  if (typeof value !== 'string' || !value) return typeof value === 'string' ? value : ''
  let text = typeof homeDir === 'string' && homeDir ? value.split(homeDir).join('~') : value
  text = text.replace(POSIX_HOME_PATH, '~').replace(WINDOWS_HOME_PATH, '~')
  return redactText(text)
}

/**
 * 深度脱敏任意 JSON 值：字符串走 redactText，敏感键直接替换为 `****`，
 * 数组/普通对象递归（最多 8 层，防异常深结构打爆栈）。用于 activity.data、
 * metadata、handoff 等结构未知的附加字段。
 */
export function redactDeep(value, { depth = 0, maxDepth = 8 } = {}) {
  if (depth > maxDepth) return '«truncated»'
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.getTime()
  if (Array.isArray(value)) return value.map(item => redactDeep(item, { depth: depth + 1, maxDepth }))
  if (!value || typeof value !== 'object') return undefined
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (SENSITIVE_KEY.test(key) && typeof item === 'string') { output[key] = '****'; continue }
    output[key] = redactDeep(item, { depth: depth + 1, maxDepth })
  }
  return output
}

function redactActor(actor) {
  const source = asObject(actor)
  const output = {}
  if (typeof source.kind === 'string') output.kind = source.kind
  if (typeof source.name === 'string') output.name = redactText(source.name)
  return output
}

function redactApproval(approval) {
  const source = asObject(approval)
  const output = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'sessionId') continue
    if (key === 'requestedBy' || key === 'resolvedBy') { output[key] = redactActor(value); continue }
    output[key] = redactDeep(value)
  }
  return output
}

function redactArtifact(artifact) {
  const source = asObject(artifact)
  const output = redactDeep(source)
  if (typeof source.path === 'string') output.path = redactPath(source.path)
  if (typeof source.url === 'string') output.url = redactText(source.url)
  return output
}

function redactHandoff(handoff) {
  const source = asObject(handoff)
  const output = redactDeep(source)
  delete output.sessionId
  delete output.by
  return output
}

/** 时间线 data：先整体丢弃本地标识键，再对剩余结构深度脱敏。 */
export function sanitizeActivityData(data) {
  if (!data || typeof data !== 'object') return undefined
  const cleaned = {}
  for (const [key, value] of Object.entries(asObject(data))) {
    if (CLOUD_ACTIVITY_DATA_DROP_KEYS.includes(key)) continue
    if (value === undefined) continue
    cleaned[key] = value
  }
  if (!Object.keys(cleaned).length) return undefined
  // 整体过一次深度脱敏：路径归一 + 敏感键（token/secret…）替换为 ****。
  return redactDeep(cleaned)
}

/**
 * 看板 → 云端镜像对象。看板本身没有执行面字段，只需文本脱敏。
 */
export function toCloudBoard(board) {
  const source = asObject(board)
  const output = {
    id: cleanString(source.id),
    name: redactText(cleanString(source.name)),
    cardOrder: {},
    createdAt: nonNegativeInteger(source.createdAt),
    updatedAt: nonNegativeInteger(source.updatedAt),
  }
  if (typeof source.description === 'string' && source.description) {
    output.description = redactText(source.description)
  }
  const cardOrder = asObject(source.cardOrder)
  for (const [column, ids] of Object.entries(cardOrder)) {
    if (Array.isArray(ids)) output.cardOrder[column] = ids.filter(id => typeof id === 'string')
  }
  return output
}

/**
 * 卡片 → 云端镜像对象：白名单取字段 + 文本/路径/结构脱敏 + 执行面字段剥离。
 * 返回新对象，不修改入参。
 */
export function toCloudCard(card) {
  const source = asObject(card)
  const output = {}
  for (const field of CLOUD_CARD_FIELDS) {
    if (!(field in source)) continue
    const value = source[field]
    if (value === undefined) continue
    switch (field) {
      case 'title':
      case 'summary':
      case 'currentAction':
      case 'result':
        output[field] = redactText(typeof value === 'string' ? value : '')
        break
      case 'project':
      case 'externalRef':
      case 'mergedInto':
      case 'parentCardId':
      case 'boardId':
      case 'id':
        output[field] = typeof value === 'string' ? value : String(value)
        break
      case 'labels':
        output.labels = asArray(value).map(label => redactText(String(label)))
        break
      case 'dependsOn':
        output.dependsOn = asArray(value).filter(id => typeof id === 'string')
        break
      case 'agent': {
        const agent = asObject(value)
        if (typeof agent.name === 'string' && agent.name) output.agent = { name: redactText(agent.name) }
        break
      }
      case 'progress':
        output.progress = redactDeep(value)
        break
      case 'checklists':
        output.checklists = asArray(value).map(item => {
          const entry = asObject(item)
          return {
            ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
            text: redactText(typeof entry.text === 'string' ? entry.text : ''),
            done: entry.done === true,
          }
        })
        break
      case 'approvals':
        output.approvals = asArray(value).map(redactApproval)
        break
      case 'artifacts':
        output.artifacts = asArray(value).map(redactArtifact)
        break
      case 'handoff':
        output.handoff = redactHandoff(value)
        break
      case 'metadata':
        output.metadata = redactDeep(value)
        break
      default:
        output[field] = redactDeep(value)
    }
  }
  return output
}

/** 时间线节点 → 云端镜像对象：actor 只保留展示信息，data 剥离本地标识。 */
export function toCloudActivity(activity) {
  const source = asObject(activity)
  const output = {
    id: cleanString(source.id),
    cardId: cleanString(source.cardId),
    type: cleanString(source.type) || 'progress',
    actor: redactActor(source.actor),
    text: redactText(typeof source.text === 'string' ? source.text : ''),
    at: nonNegativeInteger(source.at),
  }
  const data = sanitizeActivityData(source.data)
  if (data) output.data = data
  return output
}

function sortById(list) {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function sortActivities(list) {
  return [...list].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 本地 Store → 可上云的脱敏快照。
 * - 只取 boards / cards / activities 与 meta.revision（本地版本号，仅用于比较与日志）；
 * - 本地 outbox（agent 唤醒指令队列）与 meta 中的本地会话信息一律不带；
 * - 输出排序稳定（boards/cards 按 id、activities 按 at+id），便于 diff 与测试。
 */
export function toCloudSnapshot(store) {
  const source = asObject(store)
  const meta = asObject(source.meta)
  return {
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    revision: nonNegativeInteger(meta.revision),
    boards: sortById(asArray(source.boards).filter(item => item && typeof item === 'object').map(toCloudBoard)),
    cards: sortById(asArray(source.cards).filter(item => item && typeof item === 'object').map(toCloudCard)),
    activities: sortActivities(asArray(source.activities).filter(item => item && typeof item === 'object').map(toCloudActivity)),
  }
}

/** 空云端快照（C3 冷启动、以及 C2/C3 单测构建假云端时的起点）。 */
export function emptyCloudSnapshot(revision = 0) {
  return {
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    revision: nonNegativeInteger(revision),
    boards: [],
    cards: [],
    activities: [],
  }
}

// ---------------------------------------------------------------------------
// 2. 增量：稳定序列化、实体级 diff、分片、回放
// ---------------------------------------------------------------------------

/** 稳定序列化：对象键递归排序，用于实体内容比较与 pushId 计算。 */
export function stableStringify(value) {
  const seen = new WeakSet()
  const encode = input => {
    if (input === null) return 'null'
    const type = typeof input
    if (type === 'number') return Number.isFinite(input) ? String(input) : 'null'
    if (type === 'boolean') return input ? 'true' : 'false'
    if (type === 'string') return JSON.stringify(input)
    if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined
    if (Array.isArray(input)) {
      const items = input.map(item => encode(item) ?? 'null')
      return `[${items.join(',')}]`
    }
    if (type === 'object') {
      if (seen.has(input)) throw badRequest('快照包含循环引用，无法序列化')
      seen.add(input)
      const entries = []
      for (const key of Object.keys(input).sort()) {
        const encoded = encode(input[key])
        if (encoded === undefined) continue
        entries.push(`${JSON.stringify(key)}:${encoded}`)
      }
      seen.delete(input)
      return `{${entries.join(',')}}`
    }
    return undefined
  }
  return encode(value) ?? 'null'
}

function diffCollection(beforeList, afterList) {
  const before = new Map()
  for (const item of asArray(beforeList)) {
    if (item && typeof item.id === 'string') before.set(item.id, item)
  }
  const after = new Map()
  for (const item of asArray(afterList)) {
    if (item && typeof item.id === 'string') after.set(item.id, item)
  }
  const upserts = []
  for (const [id, item] of after) {
    const previous = before.get(id)
    if (!previous || stableStringify(previous) !== stableStringify(item)) upserts.push(item)
  }
  const deletes = []
  for (const id of before.keys()) {
    if (!after.has(id)) deletes.push(id)
  }
  upserts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  deletes.sort()
  return { upserts, deletes }
}

/**
 * 计算两份云端快照之间的增量（before 是上次成功推送后的镜像，after 是本次脱敏快照）。
 * 返回结构即 push 请求里的 delta：
 *   { boards: {upserts, deletes}, cards: {...}, activities: {...} }
 * 快照顶层 revision 不参与实体比较（本地 revision 每次写入都变，实体才是同步单位）。
 */
export function diffCloudSnapshots(before, after) {
  const left = asObject(before)
  const right = asObject(after)
  return {
    boards: diffCollection(left.boards, right.boards),
    cards: diffCollection(left.cards, right.cards),
    activities: diffCollection(left.activities, right.activities),
  }
}

/** 增量是否为空（无任何 upsert/delete）。 */
export function isEmptyDelta(delta) {
  return CLOUD_ENTITY_KINDS.every(kind => {
    const group = asObject(asObject(delta)[bucketOf(kind)])
    return asArray(group.upserts).length === 0 && asArray(group.deletes).length === 0
  })
}

/** 统计增量规模：按实体给 upserts/deletes，并给 total（用于日志、分片与限流）。 */
export function countDelta(delta) {
  const source = asObject(delta)
  const counts = { total: 0 }
  for (const kind of CLOUD_ENTITY_KINDS) {
    const bucket = bucketOf(kind)
    const group = asObject(source[bucket])
    const upserts = asArray(group.upserts).length
    const deletes = asArray(group.deletes).length
    counts[bucket] = { upserts, deletes }
    counts.total += upserts + deletes
  }
  return counts
}

function assertDeltaGroup(delta, kind) {
  const bucket = bucketOf(kind)
  const group = asObject(delta)[bucket]
  if (group === undefined) return
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw badRequest(`delta.${bucket} 必须是对象（含 upserts/deletes）`)
  }
  if (group.upserts !== undefined && !Array.isArray(group.upserts)) {
    throw badRequest(`delta.${bucket}.upserts 必须是数组`)
  }
  if (group.deletes !== undefined && !Array.isArray(group.deletes)) {
    throw badRequest(`delta.${bucket}.deletes 必须是数组`)
  }
  const ids = new Set()
  for (const item of asArray(group.upserts)) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
      throw badRequest(`delta.${bucket}.upserts 的每一项都必须带非空字符串 id`)
    }
    if (ids.has(item.id)) throw badRequest(`delta.${bucket}.upserts 存在重复 id：${item.id}`)
    ids.add(item.id)
  }
  const deleteSeen = new Set()
  for (const id of asArray(group.deletes)) {
    if (typeof id !== 'string' || !id) throw badRequest(`delta.${bucket}.deletes 必须是非空字符串 id`)
    if (deleteSeen.has(id)) throw badRequest(`delta.${bucket}.deletes 存在重复 id：${id}`)
    if (ids.has(id)) throw badRequest(`delta.${bucket} 同一 id 不能同时出现在 upserts 与 deletes：${id}`)
    deleteSeen.add(id)
  }
}

/**
 * 校验 delta 结构（C2 在写库前调用；C3 在 push 前调用）。
 * 默认按 pushEntities 上限校验，需整包发送时可显式放宽（不推荐）。
 */
export function assertValidDelta(delta, { maxEntities = CLOUD_SYNC_LIMITS.pushEntities } = {}) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
    throw badRequest('delta 必须是对象')
  }
  const known = new Set(CLOUD_ENTITY_KINDS.map(bucketOf))
  for (const key of Object.keys(delta)) {
    if (!known.has(key)) throw badRequest(`delta 包含未知实体分组：${key}`)
  }
  for (const kind of CLOUD_ENTITY_KINDS) assertDeltaGroup(delta, kind)
  const counts = countDelta(delta)
  if (counts.total > maxEntities) {
    throw badRequest(`delta 实体数 ${counts.total} 超过单次上限 ${maxEntities}，请先分片`, {
      total: counts.total,
      maxEntities,
    })
  }
  return counts
}

/**
 * 增量分片：按「boards → cards → activities」顺序切分为若干 delta，每片实体数 ≤ maxEntities。
 * 空增量返回 []。注意：分片后每片是**独立的一次 push**（各自分配 revision），
 * C3 必须串行推送并在每片成功后更新 baseRevision（见契约 §6.6）。
 */
export function chunkDelta(delta, maxEntities = CLOUD_SYNC_LIMITS.pushEntities) {
  const limit = Math.max(1, nonNegativeInteger(maxEntities, CLOUD_SYNC_LIMITS.pushEntities) || CLOUD_SYNC_LIMITS.pushEntities)
  const source = asObject(delta)
  const chunks = []
  let current = { boards: { upserts: [], deletes: [] }, cards: { upserts: [], deletes: [] }, activities: { upserts: [], deletes: [] } }
  let used = 0
  const flush = () => {
    if (used === 0) return
    chunks.push(current)
    current = { boards: { upserts: [], deletes: [] }, cards: { upserts: [], deletes: [] }, activities: { upserts: [], deletes: [] } }
    used = 0
  }
  for (const kind of CLOUD_ENTITY_KINDS) {
    const bucket = bucketOf(kind)
    const group = asObject(source[bucket])
    for (const item of asArray(group.upserts)) {
      if (used >= limit) flush()
      current[bucket].upserts.push(item)
      used += 1
    }
    for (const id of asArray(group.deletes)) {
      if (used >= limit) flush()
      current[bucket].deletes.push(id)
      used += 1
    }
  }
  flush()
  return chunks
}

/**
 * 把 pull 响应（增量窗口）转换为本地可应用的 delta。
 * pull 返回的 tombstones 行形如 {entity, entityId, deletedAt, revision}。
 */
export function pullResponseToDelta(response) {
  const source = asObject(response)
  const delta = {
    boards: { upserts: asArray(source.boards), deletes: [] },
    cards: { upserts: asArray(source.cards), deletes: [] },
    activities: { upserts: asArray(source.activities), deletes: [] },
  }
  for (const row of asArray(source.tombstones)) {
    const tombstone = asObject(row)
    const bucket = kindToBucket(tombstone.entity)
    if (!bucket) continue
    const id = cleanString(tombstone.entityId ?? tombstone.entity_id ?? tombstone.id)
    if (id) delta[bucket].deletes.push(id)
  }
  return delta
}

function kindToBucket(entity) {
  if (entity === 'board') return 'boards'
  if (entity === 'card') return 'cards'
  if (entity === 'activity') return 'activities'
  return null
}

/**
 * 把 delta 应用到一份云端快照（本地假云端、单测、离线回放使用；C2 不落 payload 时
 * 只写 D1 行，不要用本函数）。返回新快照，不修改入参。
 */
export function applyDeltaToCloudSnapshot(snapshot, delta, { revision } = {}) {
  const current = asObject(snapshot)
  const source = asObject(delta)
  const nextRevision = revision !== undefined
    ? nonNegativeInteger(revision)
    : nonNegativeInteger(current.revision)
  const applyKind = (kind, list) => {
    const group = asObject(source[bucketOf(kind)])
    const deletes = new Set(asArray(group.deletes))
    const merged = new Map()
    for (const item of asArray(list)) {
      if (item && typeof item.id === 'string' && !deletes.has(item.id)) merged.set(item.id, item)
    }
    for (const item of asArray(group.upserts)) {
      if (item && typeof item.id === 'string') merged.set(item.id, item)
    }
    return [...merged.values()]
  }
  return {
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    revision: nextRevision,
    boards: sortById(applyKind('board', current.boards)),
    cards: sortById(applyKind('card', current.cards)),
    activities: sortActivities(applyKind('activity', current.activities)),
  }
}

// ---------------------------------------------------------------------------
// 3. 乐观锁：revision 窗口、冲突检测、push 计划、幂等 pushId
// ---------------------------------------------------------------------------

/** 服务端下一次 push 应分配的 revision（= 当前 revision + 1）。 */
export function nextCloudRevision(serverRevision) {
  return nonNegativeInteger(serverRevision) + 1
}

/**
 * revision 冲突检测（C2 在 push 入口调用，C3 在收到 409 后重试前调用）。
 * 返回 { conflict, code?, serverRevision, expectedBaseRevision, retryable }。
 * 判定顺序：协议/纪元不匹配优先于普通 revision 冲突（纪元不一致必须全量重建）。
 */
export function detectRevisionConflict({ baseRevision, serverRevision, epoch, serverEpoch } = {}) {
  const server = nonNegativeInteger(serverRevision)
  if (serverEpoch && epoch && String(epoch) !== String(serverEpoch)) {
    return {
      conflict: true,
      code: 'SYNC_EPOCH_MISMATCH',
      serverRevision: server,
      expectedBaseRevision: nonNegativeInteger(baseRevision, -1),
      retryable: true,
      hint: '云端已被重建（epoch 变化），请以本地全量快照 reset 推送',
    }
  }
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    return {
      conflict: true,
      code: 'BAD_REQUEST',
      serverRevision: server,
      expectedBaseRevision: -1,
      retryable: false,
      hint: 'baseRevision 必须是 ≥ 0 的整数',
    }
  }
  if (baseRevision !== server) {
    return {
      conflict: true,
      code: 'REVISION_CONFLICT',
      serverRevision: server,
      expectedBaseRevision: baseRevision,
      retryable: true,
      hint: '先 GET /v1/sync/pull 追平 serverRevision，再重算 delta 重试',
    }
  }
  return { conflict: false, serverRevision: server, expectedBaseRevision: baseRevision, retryable: true }
}

/**
 * 生成一次 push 的确定性幂等键：同客户端 + 同基准 revision + 同 delta → 同 pushId。
 * 网络重试可以原样复用；C2 据此对「已提交但响应丢失」的请求直接返回 duplicate。
 */
export function hashPushId({ clientId, baseRevision, delta } = {}) {
  const canonical = stableStringify({
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    clientId: cleanString(clientId) || 'unknown',
    baseRevision: nonNegativeInteger(baseRevision),
    delta: asObject(delta),
  })
  return `push-${sha256Hex(canonical).slice(0, 32)}`
}

/**
 * push 决策（C2 的纯函数内核）：
 *   noop      —— 空 delta，不写库、不分配 revision；
 *   duplicate —— pushId 与 sync_meta.last_push_id 相同，说明上一轮已提交（响应丢失的重试）；
 *   conflict  —— 纪元或 revision 冲突，返回 code 与 serverRevision；
 *   apply     —— 可以提交，revision = serverRevision + 1。
 */
export function planPush({
  baseRevision, serverRevision, epoch, serverEpoch, delta, pushId, lastPushId, lastPushRevision,
} = {}) {
  const server = nonNegativeInteger(serverRevision)
  if (pushId && lastPushId && String(pushId) === String(lastPushId)) {
    return { action: 'duplicate', revision: nonNegativeInteger(lastPushRevision, server), serverRevision: server }
  }
  if (isEmptyDelta(delta)) {
    return { action: 'noop', revision: server, serverRevision: server }
  }
  const conflict = detectRevisionConflict({ baseRevision, serverRevision: server, epoch, serverEpoch })
  if (conflict.conflict) {
    return {
      action: 'conflict',
      code: conflict.code,
      hint: conflict.hint,
      retryable: conflict.retryable,
      serverRevision: server,
      expectedBaseRevision: conflict.expectedBaseRevision,
    }
  }
  return { action: 'apply', revision: server + 1, serverRevision: server }
}

// ---------------------------------------------------------------------------
// 4. pull 窗口与游标
// ---------------------------------------------------------------------------

function base64urlEncode(text) {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function base64urlDecode(text) {
  return Buffer.from(text, 'base64url').toString('utf8')
}

/** 编码 pull 游标：{revision, id} → 不透明字符串（客户端不得解析，只原样回传）。 */
export function encodeSyncCursor({ revision, id } = {}) {
  const payload = { r: nonNegativeInteger(revision), i: cleanString(id) }
  if (!payload.i) throw badRequest('游标缺少实体 id')
  if (payload.i.length > 256) throw badRequest('游标实体 id 超长（上限 256 字符）')
  return base64urlEncode(JSON.stringify(payload))
}

/** 解码 pull 游标；非法游标抛 BAD_REQUEST（C2 直接返回 400，不猜测客户端意图）。 */
export function decodeSyncCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null
  if (typeof cursor !== 'string' || cursor.length > CURSOR_MAX_LENGTH) {
    throw badRequest('游标格式非法')
  }
  let parsed
  try {
    parsed = JSON.parse(base64urlDecode(cursor))
  } catch {
    throw badRequest('游标无法解码')
  }
  const revision = Number(parsed?.r)
  const id = typeof parsed?.i === 'string' ? parsed.i : ''
  if (!Number.isInteger(revision) || revision < 0 || !id) throw badRequest('游标内容非法')
  return { revision, id }
}

/**
 * 规范化 pull 请求参数（C2 用它构造 SQL 参数，C3 用它驱动分页）：
 * - since 缺省 0（全量快照）；until 缺省取当前 serverRevision，一旦给出就作为
 *   **冻结窗口的上界**，客户端在分页结束前不得改变它（否则可能漏行/重复行）；
 * - cursor 与 (since, until] 窗口配合，按 (revision, id) 键集分页；
 * - limit 默认与上限均为 pullEntities。
 * 返回 { since, until, limit, cursorRevision, cursorId }，SQL 形如：
 *   WHERE revision > :since AND revision <= :until
 *     AND (revision > :cursorRevision OR (revision = :cursorRevision AND id > :cursorId))
 *   ORDER BY revision, id LIMIT :limit
 */
export function normalizePullRequest({ since, until, cursor, limit, serverRevision } = {}) {
  const server = nonNegativeInteger(serverRevision)
  const start = nonNegativeInteger(since)
  if (start > server) throw badRequest(`since=${start} 超过服务端 revision=${server}`)
  let end = until === undefined || until === null || until === '' ? server : nonNegativeInteger(until, -1)
  if (end < 0) throw badRequest('until 必须是非负整数')
  if (end > server) end = server
  if (end < start) throw badRequest('until 不能小于 since')
  let pageSize = nonNegativeInteger(limit, CLOUD_SYNC_LIMITS.pullEntities)
  if (pageSize < 1) pageSize = CLOUD_SYNC_LIMITS.pullEntities
  pageSize = Math.min(pageSize, CLOUD_SYNC_LIMITS.pullEntities)
  const decoded = decodeSyncCursor(cursor)
  if (decoded && decoded.revision < start) throw badRequest('游标 revision 不能小于 since')
  return {
    since: start,
    until: end,
    limit: pageSize,
    cursorRevision: decoded ? decoded.revision : start,
    cursorId: decoded ? decoded.id : '',
  }
}

// ---------------------------------------------------------------------------
// 5. 鉴权：Bearer 解析与常量时间校验
// ---------------------------------------------------------------------------

/** 解析 `Authorization: Bearer <token>`；不符合格式返回 null（不抛错）。 */
export function parseBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null
  const match = /^\s*Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/i.exec(headerValue)
  return match ? match[1] : null
}

/** 常量时间字符串比较（先 sha256 归一长度，避免长度差异泄漏与 timingSafeEqual 限制）。 */
export function constantTimeEqual(left, right) {
  const a = createHash('sha256').update(String(left ?? ''), 'utf8').digest()
  const b = createHash('sha256').update(String(right ?? ''), 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * 校验请求的 Bearer 令牌（C2 在 /v1/sync/*、/v1/inbox/* 入口调用）。
 * 返回 {ok:true} 或 {ok:false, code, status, message}；服务端未配置令牌时 fail-closed。
 */
export function verifyBearer(headerValue, expectedToken) {
  if (typeof expectedToken !== 'string' || !expectedToken) {
    return {
      ok: false,
      code: 'UNAVAILABLE',
      status: CLOUD_ERROR_STATUS.UNAVAILABLE,
      message: '服务端未配置 CLOUD_SYNC_TOKEN，拒绝服务（fail-closed）',
    }
  }
  const token = parseBearerToken(headerValue)
  if (!token) {
    return {
      ok: false,
      code: 'UNAUTHORIZED',
      status: CLOUD_ERROR_STATUS.UNAUTHORIZED,
      message: '缺少 Authorization: Bearer <token>',
    }
  }
  if (!constantTimeEqual(token, expectedToken)) {
    return {
      ok: false,
      code: 'UNAUTHORIZED',
      status: CLOUD_ERROR_STATUS.UNAUTHORIZED,
      message: 'Bearer 令牌不匹配',
    }
  }
  return { ok: true }
}

/** 与 verifyBearer 配套的抛错版；成功返回 undefined。 */
export function assertAuthorized(headerValue, expectedToken) {
  const result = verifyBearer(headerValue, expectedToken)
  if (!result.ok) throw new CloudSyncError(result.code, result.message, { status: result.status })
}

// ---------------------------------------------------------------------------
// 6. 入站：Webhook 信封、去重、白名单头、本地回放请求、退避
// ---------------------------------------------------------------------------

function normalizeProvider(provider) {
  const value = cleanString(provider).toLowerCase()
  return CLOUD_INGRESS_PROVIDERS.includes(value) ? value : ''
}

function readHeader(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : ''
  }
  const source = asObject(headers)
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
    return typeof value === 'string' ? value : ''
  }
  return ''
}

/**
 * 入站请求头白名单过滤：只保留回放/排障需要的头，Authorization / Cookie /
 * 签名头等敏感头一律不落库（签名已在边缘校验完成）。
 */
export function filterIngressHeaders(headers) {
  const output = {}
  const allow = new Set(CLOUD_INGRESS_HEADER_ALLOWLIST)
  const visit = (key, value) => {
    const name = String(key || '').toLowerCase()
    if (!allow.has(name)) return
    const text = Array.isArray(value) ? value.join(',') : String(value ?? '')
    if (!text || text.length > CLOUD_SYNC_LIMITS.headerValueBytes) return
    output[name] = text
  }
  if (headers && typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    headers.forEach((value, key) => visit(key, value))
    return output
  }
  for (const [key, value] of Object.entries(asObject(headers))) visit(key, value)
  return output
}

function detectEventType(provider, headers, payload) {
  const githubEvent = readHeader(headers, 'x-github-event')
  if (githubEvent) return githubEvent
  const event = asObject(payload.event)
  if (typeof event.type === 'string' && event.type) return event.type
  if (typeof payload.event_type === 'string' && payload.event_type) return payload.event_type
  if (provider === 'generic' && typeof payload.type === 'string') return payload.type
  return ''
}

function detectDeliveryId(provider, headers, payload) {
  const candidates = [
    readHeader(headers, 'x-github-delivery'),
    readHeader(headers, 'x-dingtalk-delivery-id'),
    readHeader(headers, 'x-dingtalk-event-id'),
    readHeader(headers, 'x-request-id'),
  ]
  for (const candidate of candidates) if (candidate) return candidate
  const header = asObject(payload.header)
  if (typeof header.event_id === 'string' && header.event_id) return header.event_id
  const body = asObject(payload)
  if (typeof body.deliveryId === 'string' && body.deliveryId) return body.deliveryId
  return ''
}

/**
 * 去重键：优先用 provider 的投递 id（webhook 重试同 id）；
 * 缺失时退化为「provider + 事件类型 + 原始体」的哈希（同体重复投递视为同一条）。
 */
export function ingressDedupeKey({ provider, deliveryId, eventType, payloadText } = {}) {
  const normalizedProvider = normalizeProvider(provider) || 'generic'
  const delivery = cleanString(deliveryId)
  if (delivery) return `${normalizedProvider}:delivery:${delivery.slice(0, 200)}`
  const digest = sha256Hex(`${normalizedProvider}\n${cleanString(eventType)}\n${String(payloadText ?? '')}`).slice(0, 32)
  return `${normalizedProvider}:body:${digest}`
}

/** 入站事件 id：去重键的确定性哈希（同一 Webhook 重投不会产生第二条）。 */
export function makeIngressId(dedupeKey) {
  return `in-${sha256Hex(String(dedupeKey ?? '')).slice(0, 16)}`
}

/**
 * 构造待落库的入站信封（C2 的 /v1/ingress/:provider 内核）：
 * - provider 白名单校验；请求体必须是 JSON（回放要能原样 POST 给本地 /api/kanban/ingress）；
 * - 超过 ingressPayloadBytes 直接 PAYLOAD_TOO_LARGE，不入队；
 * - 计算 id / dedupeKey / 过期时间，headers 走白名单。
 * 返回的 payload 为**原始请求体文本**，不做脱敏（零丢失回放）。
 */
export function normalizeIngressEnvelope({
  provider,
  headers,
  payload,
  eventType,
  deliveryId,
  now = Date.now(),
  ttlMs = CLOUD_SYNC_LIMITS.ingressTtlMs,
  maxBytes = CLOUD_SYNC_LIMITS.ingressPayloadBytes,
} = {}) {
  const normalizedProvider = normalizeProvider(provider)
  if (!normalizedProvider) {
    throw new CloudSyncError('BAD_REQUEST', `不支持的入站来源：${provider || '(空)'}`, {
      details: { supported: CLOUD_INGRESS_PROVIDERS },
    })
  }
  const payloadText = typeof payload === 'string'
    ? payload
    : (payload === undefined ? '' : JSON.stringify(payload))
  if (!payloadText) throw badRequest('入站请求体不能为空')
  const payloadBytes = Buffer.byteLength(payloadText, 'utf8')
  if (payloadBytes > maxBytes) {
    throw new CloudSyncError('PAYLOAD_TOO_LARGE', `入站请求体 ${payloadBytes}B 超过上限 ${maxBytes}B`, {
      details: { payloadBytes, maxBytes },
    })
  }
  let parsed
  try {
    parsed = JSON.parse(payloadText)
  } catch {
    throw new CloudSyncError('UNSUPPORTED_MEDIA_TYPE', '入站请求体不是合法 JSON（当前只回放 JSON Webhook）')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CloudSyncError('UNSUPPORTED_MEDIA_TYPE', '入站请求体必须是 JSON 对象')
  }
  const filteredHeaders = filterIngressHeaders(headers)
  const resolvedEventType = cleanString(eventType) || detectEventType(normalizedProvider, headers, parsed)
  const resolvedDeliveryId = cleanString(deliveryId) || detectDeliveryId(normalizedProvider, headers, parsed)
  const dedupeKey = ingressDedupeKey({
    provider: normalizedProvider,
    deliveryId: resolvedDeliveryId,
    eventType: resolvedEventType,
    payloadText,
  })
  const receivedAt = nonNegativeInteger(now, Date.now())
  return {
    id: makeIngressId(dedupeKey),
    provider: normalizedProvider,
    eventType: resolvedEventType,
    deliveryId: resolvedDeliveryId,
    dedupeKey,
    headers: filteredHeaders,
    payload: payloadText,
    payloadBytes,
    status: 'pending',
    attempts: 0,
    receivedAt,
    expiresAt: receivedAt + nonNegativeInteger(ttlMs, CLOUD_SYNC_LIMITS.ingressTtlMs),
  }
}

/**
 * 把入站信封转换为本地消费请求：POST /api/kanban/ingress。
 * GitHub 事件需要把 `x-github-event` 原样带给本地路由（本地按它分派 issues/issue_comment）。
 */
export function buildLocalIngressRequest(envelope) {
  const source = asObject(envelope)
  const headers = { 'content-type': 'application/json; charset=utf-8' }
  const githubEvent = readHeader(source.headers, 'x-github-event')
  if (githubEvent) headers['x-github-event'] = githubEvent
  const deliveryId = readHeader(source.headers, 'x-github-delivery') || cleanString(source.deliveryId)
  if (source.id) headers['x-kanban-ingress-id'] = String(source.id)
  else if (deliveryId) headers['x-kanban-ingress-id'] = deliveryId
  return {
    method: 'POST',
    path: '/api/kanban/ingress',
    headers,
    body: typeof source.payload === 'string' ? source.payload : JSON.stringify(source.payload ?? {}),
    inboxId: cleanString(source.id),
    provider: cleanString(source.provider),
    eventType: cleanString(source.eventType),
  }
}

/** 入站失败退避：attempts=0 → 1s，指数增长，上限 5 分钟（确定性；C3 可自带抖动）。 */
export function ingressBackoffMs(attempts, { baseMs = 1000, maxMs = 5 * 60 * 1000 } = {}) {
  const exponent = Math.min(20, Math.max(0, nonNegativeInteger(attempts)))
  const base = nonNegativeInteger(baseMs, 1000) || 1000
  const cap = nonNegativeInteger(maxMs, 5 * 60 * 1000) || 5 * 60 * 1000
  return Math.min(cap, base * 2 ** exponent)
}

/**
 * 计算一次消费失败后的入站状态迁移：返回 { status, attempts, nextAttemptAt, retryable }。
 * attempts 达到 maxAttempts 时置 dead（不再自动重试，等人工/告警）。
 */
export function nextIngressAttempt(envelope, { now = Date.now(), error } = {}) {
  const source = asObject(envelope)
  const attempts = nonNegativeInteger(source.attempts) + 1
  const maxAttempts = Math.max(1, nonNegativeInteger(source.maxAttempts, CLOUD_SYNC_LIMITS.ingressMaxAttempts) || CLOUD_SYNC_LIMITS.ingressMaxAttempts)
  if (attempts >= maxAttempts) {
    return { status: 'dead', attempts, nextAttemptAt: 0, retryable: false, ...(error ? { lastError: String(error).slice(0, 500) } : {}) }
  }
  return {
    status: 'pending',
    attempts,
    nextAttemptAt: nonNegativeInteger(now, Date.now()) + ingressBackoffMs(attempts),
    retryable: true,
    ...(error ? { lastError: String(error).slice(0, 500) } : {}),
  }
}

/** 入站条目是否已过期（过期条目不回放，Cron 清理）。 */
export function isIngressExpired(envelope, now = Date.now()) {
  const expiresAt = nonNegativeInteger(asObject(envelope).expiresAt)
  return expiresAt > 0 && nonNegativeInteger(now, Date.now()) >= expiresAt
}

// ---------------------------------------------------------------------------
// 7. cloud-config.json 校验与安全描述
// ---------------------------------------------------------------------------

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

/**
 * 校验并规范化本地 cloud-config.json（位于 <dataDir>/cloud-config.json，权限 0600）：
 *   {
 *     version: 1,
 *     enabled: true,
 *     workerUrl: "https://dsh-kanban-sync.<account>.workers.dev",
 *     token: "<与 Worker secret CLOUD_SYNC_TOKEN 相同>",
 *     clientId: "macbook-pro",
 *     sync:    { enabled: true, pushDebounceMs: 2000, pullIntervalMs: 30000 },
 *     ingress: { enabled: true, claimIntervalMs: 30000, batchSize: 20, leaseSeconds: 120 }
 *   }
 * 规则：启用时 token 必填（≥16 字符）；workerUrl 必须 https（仅本机回环允许 http）；
 * 令牌不写入日志——需要打印配置时用 describeCloudConfig。
 */
export function normalizeCloudConfig(raw) {
  const source = asObject(raw)
  const enabled = source.enabled !== false
  const clientId = cleanString(source.clientId) || 'local-mac'
  if (clientId.length > CLIENT_ID_MAX) throw new CloudSyncError('BAD_CONFIG', `clientId 超过 ${CLIENT_ID_MAX} 字符`)
  const workerUrlRaw = cleanString(source.workerUrl).replace(/\/+$/, '')
  const token = cleanString(source.token)
  let workerUrl = ''
  if (workerUrlRaw) {
    let parsed
    try {
      parsed = new URL(workerUrlRaw)
    } catch {
      throw new CloudSyncError('BAD_CONFIG', 'workerUrl 不是合法 URL')
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
      throw new CloudSyncError('BAD_CONFIG', 'workerUrl 必须使用 https（本机回环调试除外）')
    }
    workerUrl = workerUrlRaw
  }
  if (enabled) {
    if (!workerUrl) throw new CloudSyncError('BAD_CONFIG', '启用云同步时必须配置 workerUrl')
    if (!token) throw new CloudSyncError('BAD_CONFIG', '启用云同步时必须配置 token（Bearer 令牌）')
    if (token.length < TOKEN_MIN_LENGTH) {
      throw new CloudSyncError('BAD_CONFIG', `token 至少 ${TOKEN_MIN_LENGTH} 字符（建议随机 32+ 字节）`)
    }
  }
  const sync = asObject(source.sync)
  const ingress = asObject(source.ingress)
  const config = {
    version: 1,
    enabled,
    workerUrl,
    token,
    clientId,
    sync: {
      enabled: sync.enabled !== false,
      pushDebounceMs: clampInteger(sync.pushDebounceMs, 2000, 200, 60_000),
      pullIntervalMs: clampInteger(sync.pullIntervalMs, 30_000, 5_000, 600_000),
    },
    ingress: {
      enabled: ingress.enabled !== false,
      claimIntervalMs: clampInteger(ingress.claimIntervalMs, 30_000, 5_000, 600_000),
      batchSize: clampInteger(ingress.batchSize, 20, 1, CLOUD_SYNC_LIMITS.ingressBatch),
      leaseSeconds: clampInteger(ingress.leaseSeconds, 120, 30, 900),
    },
  }
  return config
}

/** 令牌脱敏展示：abcd****wxyz（长度 < 12 时整体 ****）。 */
export function maskToken(token) {
  const text = typeof token === 'string' ? token : ''
  if (!text) return ''
  if (text.length < 12) return '****'
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

/** 配置的安全描述（可直接打日志）：令牌只保留首尾各 4 位。 */
export function describeCloudConfig(config) {
  const source = asObject(config)
  return {
    enabled: source.enabled === true,
    workerUrl: cleanString(source.workerUrl),
    clientId: cleanString(source.clientId),
    token: maskToken(source.token),
    sync: redactDeep(asObject(source.sync)),
    ingress: redactDeep(asObject(source.ingress)),
  }
}

// ---------------------------------------------------------------------------
// 8. 通用校验辅助
// ---------------------------------------------------------------------------

/** 校验请求/响应携带的 protocolVersion；缺省视为当前版本（兼容手工 curl 调试）。 */
export function assertProtocolVersion(value) {
  if (value === undefined || value === null || value === '') return CLOUD_PROTOCOL_VERSION
  if (Number(value) !== CLOUD_PROTOCOL_VERSION) {
    throw new CloudSyncError(
      'UNSUPPORTED_PROTOCOL_VERSION',
      `不支持的协议版本：${value}（当前为 ${CLOUD_PROTOCOL_VERSION}）`,
      { details: { supported: CLOUD_PROTOCOL_VERSION } },
    )
  }
  return CLOUD_PROTOCOL_VERSION
}
