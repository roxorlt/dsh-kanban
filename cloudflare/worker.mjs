// ============================================================================
// dsh-kanban 云端持久化（C2/3）——Cloudflare Worker 控制面
// ----------------------------------------------------------------------------
// 契约：docs/contracts/08-cloud-sync.md（C1 冻结）
// 协议层：lib/cloud-sync-protocol.js（脱敏 / diff / 乐观锁 / 游标 / 入站信封）
// Schema：cloudflare/migrations/0001_kanban_sync.sql
//
// 边界（Local-First）：
//   - 本 Worker **只**做两件事：(a) 看板状态的脱敏增量镜像（只读副本）；
//     (b) 合盖休眠期间的入站事件暂存队列。它永不发起业务状态变更，也从不
//     接触代码仓 / worktree / 进程 / 会话等本地执行面资源。
//   - 鉴权：状态面（/v1/sync/*、/v1/inbox/*）全部要求 Bearer（常量时间比较，
//     未配置 CLOUD_SYNC_TOKEN 时 fail-closed 503）；ingress 面按来源签名校验。
//   - 日志：只记 id/seq/provider/status/revision 等元数据，绝不打印请求体、
//     令牌或签名头（契约 §9.5）。
//
// 端点：
//   GET  /v1/sync/pull       拉取 (since, until] revision 窗口的镜像增量（键集游标分页）
//   POST /v1/sync/push       推送脱敏增量（同一 D1 batch 内 upsert → tombstone → CAS）
//   POST /v1/ingress/:provider  Webhook 暂存入口（github/feishu/dingtalk/wecom/onebot/weixin/generic）
//   POST /v1/inbox/claim     领取待回放事件（写租约）
//   POST /v1/inbox/ack       回执消费结果（acked / retry 退避 / dead）
//   POST /v1/mcp（别名 /mcp） 远程 Streamable HTTP MCP（Bearer 鉴权；读工具直查 D1，写工具入队回放）
//
// 测试：test/cloud-worker.test.mjs & test/cloud-mcp.test.mjs（node:sqlite 内存库模拟 D1）。
// ============================================================================

import { createHash, createHmac } from 'node:crypto'
import {
  assertCloudMcpAuthorized,
  buildCloudMcpIngressPayload,
  handleCloudMcpJsonRpc,
} from '../lib/cloud-mcp.js'
import {
  CLOUD_INGRESS_PROVIDERS,
  CLOUD_PROTOCOL_VERSION,
  CLOUD_SYNC_LIMITS,
  CloudSyncError,
  assertProtocolVersion,
  assertValidDelta,
  constantTimeEqual,
  countDelta,
  detectRevisionConflict,
  encodeSyncCursor,
  nextCloudRevision,
  nextIngressAttempt,
  normalizeIngressEnvelope,
  normalizePullRequest,
  parseBearerToken,
  planPush,
  toCloudActivity,
  toCloudBoard,
  toCloudCard,
  toErrorResponse,
  verifyBearer,
} from '../lib/cloud-sync-protocol.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/** 卡片 7 态（与本地 01-data-model 及 D1 CHECK 约束一致）。 */
const CARD_STATUSES = new Set(['backlog', 'running', 'needs_you', 'blocked', 'failed', 'done', 'canceled'])
/** 时间线 actor 三类（与 D1 CHECK 约束一致）。 */
const ACTOR_KINDS = new Set(['user', 'agent', 'system'])

/** pull 镜像实体（tombstones 单独查询，键集为 (revision, entity, entity_id)）。 */
const PULL_ENTITY_TABLES = Object.freeze([
  { kind: 'board', bucket: 'boards', table: 'boards', rank: '1' },
  { kind: 'card', bucket: 'cards', table: 'cards', rank: '2' },
  { kind: 'activity', bucket: 'activities', table: 'activities', rank: '3' },
])

/** push / pull 的实体分组与 tombstone entity 名称。 */
const BUCKET_ENTITY = Object.freeze({ boards: 'board', cards: 'card', activities: 'activity' })
const ENTITY_TABLE = Object.freeze({ board: 'boards', card: 'cards', activity: 'activities' })

/** Webhook 加签时间戳允许偏差（1 小时），防重放（钉钉 / 飞书共用）。 */
const WEBHOOK_MAX_SKEW_MS = 60 * 60 * 1000
/** ack 单次允许的结果条数上限（一次 claim 20 条，留出多批次合并余量）。 */
const ACK_MAX_RESULTS = 200
/** ack 回查 `WHERE id IN (...)` 的单条语句 id 数（D1 单查询绑定参数上限 100，留余量）。 */
const ACK_SELECT_CHUNK = 90
/** DELETE ... WHERE id IN (...) 单条语句的 id 数（D1 单查询绑定参数上限 100，留余量）。 */
const DELETE_IN_CHUNK = 90
/** 多行墓碑 INSERT 单条语句的行数（每行 5 个绑定参数；取 18 行=90 参数，给 D1 上限留余量）。 */
const TOMBSTONE_ROW_CHUNK = 18
/**
 * 多行 upsert 每条语句的行数：受 D1「单查询 ≤100 绑定参数」约束，
 * boards 10 列×9=90、cards 16 列×6=96、activities 11 列×9=99。
 * 多行化后 200 实体 push 的 SQL 语句数从 ~201 降到 ~35（C2 复核 M2）。
 */
const UPSERT_CHUNK_ROWS = Object.freeze({ boards: 9, cards: 6, activities: 9 })
/** 实体 id 上限：pull 游标 id 上限 256（含 2 字符类别前缀），push 入口先行拦截。 */
const ENTITY_ID_MAX_LENGTH = 200
/** pull 游标 id 的实体类别前缀（1=board 2=card 3=activity 4=tombstone）。 */
const CURSOR_KEY_PATTERN = /^[1-4]:/

// ---------------------------------------------------------------------------
// SQL（D1 = SQLite；所有语句只用匿名 ? 参数，便于 C1 协议层与内存 D1 共用语义）
// ---------------------------------------------------------------------------

const BOARD_UPSERT_HEAD = `INSERT INTO boards
  (id, name, description, card_order, archived, created_at, updated_at, revision, payload, synced_at)`
const BOARD_UPSERT_TAIL = `ON CONFLICT (id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    card_order = excluded.card_order,
    archived = excluded.archived,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    revision = excluded.revision,
    payload = excluded.payload,
    synced_at = excluded.synced_at`

const CARD_UPSERT_HEAD = `INSERT INTO cards
  (id, board_id, title, status, priority, project, external_ref, parent_card_id,
   version, archived, created_at, updated_at, completed_at, revision, payload, synced_at)`
const CARD_UPSERT_TAIL = `ON CONFLICT (id) DO UPDATE SET
    board_id = excluded.board_id,
    title = excluded.title,
    status = excluded.status,
    priority = excluded.priority,
    project = excluded.project,
    external_ref = excluded.external_ref,
    parent_card_id = excluded.parent_card_id,
    version = excluded.version,
    archived = excluded.archived,
    updated_at = excluded.updated_at,
    completed_at = excluded.completed_at,
    revision = excluded.revision,
    payload = excluded.payload,
    synced_at = excluded.synced_at
  WHERE excluded.version >= cards.version`

const ACTIVITY_UPSERT_HEAD = `INSERT INTO activities
  (id, card_id, board_id, type, actor_kind, actor_name, text, at, revision, payload, synced_at)`
const ACTIVITY_UPSERT_TAIL = `ON CONFLICT (id) DO UPDATE SET
    card_id = excluded.card_id,
    board_id = excluded.board_id,
    type = excluded.type,
    actor_kind = excluded.actor_kind,
    actor_name = excluded.actor_name,
    text = excluded.text,
    at = excluded.at,
    revision = excluded.revision,
    payload = excluded.payload,
    synced_at = excluded.synced_at`

const TOMBSTONE_MULTI_HEAD = `INSERT INTO tombstones
  (entity, entity_id, board_id, deleted_at, revision)`
const TOMBSTONE_MULTI_TAIL = `ON CONFLICT (entity, entity_id) DO UPDATE SET
    board_id = excluded.board_id,
    deleted_at = excluded.deleted_at,
    revision = excluded.revision`

const PUSH_CAS_SQL = `UPDATE sync_meta
  SET revision = ?,
      last_push_id = ?,
      last_push_at = ?,
      last_push_revision = ?,
      last_client_id = ?,
      updated_at = ?
  WHERE id = 1 AND revision = ?`

const INGRESS_INSERT_SQL = `INSERT INTO ingress_inbox
  (id, provider, event_type, delivery_id, dedupe_key, headers, payload, payload_bytes,
   status, attempts, max_attempts, next_attempt_at, received_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?)
  ON CONFLICT (dedupe_key) DO NOTHING`

const CLAIM_SELECT_SQL = `SELECT seq, id, provider, event_type, delivery_id, headers, payload,
       payload_bytes, attempts, max_attempts, received_at, expires_at
  FROM ingress_inbox
  WHERE expires_at > ?
    AND ((status = 'pending' AND next_attempt_at <= ?)
      OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?))
  ORDER BY seq ASC
  LIMIT ?`

const CLAIM_UPDATE_SQL = `UPDATE ingress_inbox
  SET status = 'leased', lease_token = ?, lease_expires_at = ?
  WHERE seq = ?
    AND expires_at > ?
    AND ((status = 'pending' AND next_attempt_at <= ?)
      OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?))`

const ACK_ACKED_SQL = `UPDATE ingress_inbox
  SET status = 'acked', acked_at = ?, lease_token = NULL, lease_expires_at = NULL, last_error = NULL
  WHERE id = ? AND status IN ('pending', 'leased')`

const ACK_RETRY_SQL = `UPDATE ingress_inbox
  SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?,
      lease_token = NULL, lease_expires_at = NULL
  WHERE id = ? AND status IN ('pending', 'leased')`

const ACK_DEAD_SQL = `UPDATE ingress_inbox
  SET status = 'dead', last_error = ?, lease_token = NULL, lease_expires_at = NULL
  WHERE id = ? AND status IN ('pending', 'leased')`

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function badRequest(message, details) {
  return new CloudSyncError('BAD_REQUEST', message, { details })
}

function forbidden(message) {
  return new CloudSyncError('FORBIDDEN', message, { status: 403 })
}

function unavailable(message) {
  return new CloudSyncError('UNAVAILABLE', message, { status: 503 })
}

function notFound(message) {
  return new CloudSyncError('NOT_FOUND', message, { status: 404 })
}

function methodNotAllowed(method, allowed) {
  return new CloudSyncError('METHOD_NOT_ALLOWED', `不支持 ${method} 方法（允许：${allowed}）`, {
    status: 405,
    details: { allowed },
  })
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toInt(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

function byteLength(text) {
  return new TextEncoder().encode(String(text)).length
}

/** 生成 n 行 × columns 列的 `(?, ?, …), (?, ?, …)` 占位符（多行 upsert 用）。 */
function multiRowValues(rows, columns) {
  const tuple = `(${Array.from({ length: columns }, () => '?').join(', ')})`
  return Array.from({ length: Math.max(0, rows) }, () => tuple).join(', ')
}

function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : []
  const step = Math.max(1, Math.trunc(size))
  const chunks = []
  for (let index = 0; index < list.length; index += step) chunks.push(list.slice(index, index + step))
  return chunks
}

function nowOf(options) {
  const value = options?.now
  if (typeof value === 'function') return toInt(value(), Date.now())
  if (Number.isFinite(value)) return toInt(value)
  return Date.now()
}

function newRequestId() {
  try {
    return `req-${crypto.randomUUID()}`
  } catch {
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

function jsonResponse(body, { status = 200, requestId, extraHeaders } = {}) {
  const headers = { ...JSON_HEADERS, ...(extraHeaders ?? {}) }
  if (requestId) headers['x-request-id'] = String(requestId)
  return new Response(JSON.stringify(body), { status, headers })
}

/** 结构化日志：默认静默，只有 env.LOG_LEVEL=info/debug 才输出（且绝不含请求体）。 */
/** 给任意响应补 `x-request-id` 头（成功/失败统一，便于与 Cloudflare 日志对账）。 */
function withRequestId(response, requestId) {
  if (!response || response.headers.has('x-request-id')) return response
  const headers = new Headers(response.headers)
  headers.set('x-request-id', String(requestId))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function logEvent(env, level, event, fields = {}) {
  const configured = cleanString(env?.LOG_LEVEL).toLowerCase()
  const order = { debug: 10, info: 20, warn: 30, error: 40 }
  if ((order[level] ?? 20) < (order[configured] ?? 100)) return
  try {
    console.log(JSON.stringify({ event, level, ...fields }))
  } catch {
    // 日志失败绝不影响请求
  }
}

function requireDb(env) {
  if (!env || !env.DB || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function') {
    throw unavailable('D1 绑定 DB 未配置或不可用（检查 wrangler.toml 的 [[d1_databases]] 与迁移）')
  }
  return env.DB
}

/**
 * D1 调用统一出口：把 D1/SQLite 层异常归一为 503 UNAVAILABLE（契约 §10：D1 不可用
 * 属可退避的瞬时故障），原始异常挂在 `cause` 上仅供 debug 日志排查，不返回给客户端。
 */
function d1(promise) {
  return Promise.resolve(promise).catch(error => {
    if (error instanceof CloudSyncError) throw error
    const wrapped = unavailable('D1 不可用或查询失败，请退避后重试')
    wrapped.cause = error
    throw wrapped
  })
}

/** Bearer 鉴权：verifyBearer 内含 fail-closed（未配置 CLOUD_SYNC_TOKEN → 503）。 */
function requireAuthorized(request, env) {
  const result = verifyBearer(request.headers.get('authorization'), env?.CLOUD_SYNC_TOKEN)
  if (!result.ok) throw new CloudSyncError(result.code, result.message, { status: result.status })
}

/** 读取纯文本请求体并做字节上限检查（先看 Content-Length，再校验实际长度）。 */
async function readTextBody(request, { maxBytes, code = 'PAYLOAD_TOO_LARGE' } = {}) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CloudSyncError(code, `请求体 ${declared}B 超过上限 ${maxBytes}B`, {
      details: { maxBytes, declaredBytes: declared },
    })
  }
  const text = await request.text()
  const bytes = byteLength(text)
  if (bytes > maxBytes) {
    throw new CloudSyncError(code, `请求体 ${bytes}B 超过上限 ${maxBytes}B`, {
      details: { maxBytes, payloadBytes: bytes },
    })
  }
  return text
}

function parseJsonBody(text, { code = 'BAD_REQUEST', label = '请求体' } = {}) {
  if (!text.trim()) throw new CloudSyncError(code, `${label}不能为空`)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CloudSyncError(code, `${label}不是合法 JSON`)
  }
  return parsed
}

function requireJsonObject(text, { code = 'BAD_REQUEST', label = '请求体' } = {}) {
  const parsed = parseJsonBody(text, { code, label })
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CloudSyncError(code, `${label}必须是 JSON 对象`)
  }
  return parsed
}

function emptyApplied() {
  return {
    boards: { upserted: 0, deleted: 0 },
    cards: { upserted: 0, deleted: 0 },
    activities: { upserted: 0, deleted: 0 },
  }
}

function changedCount(result) {
  const changes = result?.meta?.changes
  return Number.isFinite(Number(changes)) ? Number(changes) : 0
}

function rowsOf(result) {
  return Array.isArray(result?.results) ? result.results : []
}

async function readSyncMeta(db) {
  const row = await d1(db.prepare(
    'SELECT revision, epoch, last_push_id, last_push_revision FROM sync_meta WHERE id = 1',
  ).first())
  if (!row) {
    throw unavailable('sync_meta 未初始化：请先执行 wrangler d1 migrations apply dsh-kanban-sync --remote')
  }
  return {
    revision: toInt(row.revision),
    epoch: cleanString(row.epoch),
    lastPushId: row.last_push_id == null ? '' : String(row.last_push_id),
    lastPushRevision: row.last_push_revision == null ? null : toInt(row.last_push_revision),
  }
}

// ---------------------------------------------------------------------------
// 一、GET /v1/sync/pull —— revision 窗口 + 键集游标分页
// ---------------------------------------------------------------------------

/**
 * 构造一次 pull 的 4 条键集分页查询（boards/cards/activities 各一条 + tombstones 一条），
 * 由 D1 batch 一次执行，保证同一 until 窗口内的一致性快照。
 *
 * 排序语义（C2 实现约定，已回写契约 §6.2）：跨实体按 `revision → 实体类别 → id`
 * 升序；游标 id 带类别前缀（`1:board-id`、`2:card-id`、`3:ev-id`、`4:entity:entity-id`），
 * 因此单个 cursor 即可表达「四类实体共同推进到哪一行」，客户端无需理解分类游标。
 */
function buildPullStatements(db, params) {
  const fetchLimit = params.limit + 1 // 多取一行用于判断 hasMore
  const hasCursor = Boolean(params.cursorId)
  const statements = []
  for (const spec of PULL_ENTITY_TABLES) {
    const prefix = `'${spec.rank}:'`
    const sql = hasCursor
      ? `SELECT revision, id, payload FROM ${spec.table}
         WHERE revision > ? AND revision <= ?
           AND (revision > ? OR (revision = ? AND (${prefix} || id) > ?))
         ORDER BY revision, id LIMIT ?`
      : `SELECT revision, id, payload FROM ${spec.table}
         WHERE revision > ? AND revision <= ?
         ORDER BY revision, id LIMIT ?`
    const bindings = hasCursor
      ? [params.since, params.until, params.cursorRevision, params.cursorRevision, params.cursorId, fetchLimit]
      : [params.since, params.until, fetchLimit]
    statements.push(db.prepare(sql).bind(...bindings))
  }
  const tombstoneSql = hasCursor
    ? `SELECT revision, entity, entity_id, board_id, deleted_at FROM tombstones
       WHERE revision > ? AND revision <= ?
         AND (revision > ? OR (revision = ? AND ('4:' || entity || ':' || entity_id) > ?))
       ORDER BY revision, entity, entity_id LIMIT ?`
    : `SELECT revision, entity, entity_id, board_id, deleted_at FROM tombstones
       WHERE revision > ? AND revision <= ?
       ORDER BY revision, entity, entity_id LIMIT ?`
  statements.push(
    db.prepare(tombstoneSql).bind(
      ...(hasCursor
        ? [params.since, params.until, params.cursorRevision, params.cursorRevision, params.cursorId, fetchLimit]
        : [params.since, params.until, fetchLimit]),
    ),
  )
  return statements
}

function parsePayloadRow(row, bucket) {
  const raw = row?.payload
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 落到下方统一报错（不会静默丢数据）
    }
  }
  throw new CloudSyncError('INTERNAL', `D1 中的 ${bucket} payload 不是合法 JSON 对象，请检查写入路径`)
}

/** 合并 4 个结果集、排序、截断到 limit，并计算下一页游标。 */
function mergePullRows(rowSets, params) {
  const merged = []
  PULL_ENTITY_TABLES.forEach((spec, index) => {
    for (const row of rowSets[index] ?? []) {
      const revision = toInt(row.revision)
      merged.push({
        revision,
        key: `${spec.rank}:${String(row.id)}`,
        bucket: spec.bucket,
        value: parsePayloadRow(row, spec.bucket),
      })
    }
  })
  for (const row of rowSets[PULL_ENTITY_TABLES.length] ?? []) {
    const revision = toInt(row.revision)
    const entity = cleanString(row.entity)
    const entityId = cleanString(row.entity_id)
    merged.push({
      revision,
      key: `4:${entity}:${entityId}`,
      bucket: 'tombstones',
      value: {
        entity,
        entityId,
        boardId: row.board_id == null ? null : String(row.board_id),
        deletedAt: toInt(row.deleted_at),
        revision,
      },
    })
  }
  merged.sort((left, right) => (left.revision - right.revision) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  const hasMore = merged.length > params.limit
  const page = merged.slice(0, params.limit)
  const pageResult = { boards: [], cards: [], activities: [], tombstones: [] }
  for (const entry of page) pageResult[entry.bucket].push(entry.value)
  const last = page[page.length - 1]
  const cursor = hasMore && last ? encodeSyncCursor({ revision: last.revision, id: last.key }) : null
  return { ...pageResult, hasMore, cursor }
}

async function handlePull(request, env, url, options) {
  requireAuthorized(request, env)
  const db = requireDb(env)
  const meta = await readSyncMeta(db)
  const params = normalizePullRequest({
    since: url.searchParams.get('since'),
    until: url.searchParams.get('until'),
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit'),
    serverRevision: meta.revision,
  })
  if (params.cursorId && !CURSOR_KEY_PATTERN.test(params.cursorId)) {
    throw badRequest('游标格式非法（缺少实体类别前缀）')
  }
  const statements = buildPullStatements(db, params)
  const results = await d1(db.batch(statements))
  const page = mergePullRows(results.map(rowsOf), params)
  const body = {
    ok: true,
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    epoch: meta.epoch,
    since: params.since,
    until: params.until,
    revision: meta.revision,
    boards: page.boards,
    cards: page.cards,
    activities: page.activities,
    tombstones: page.tombstones,
    hasMore: page.hasMore,
    cursors: {},
  }
  if (page.cursor) {
    // 兼容契约 §6.2 的 cursors 分组字段；C2 实现为单一全局键集游标，各键同值。
    body.cursor = page.cursor
    for (const spec of PULL_ENTITY_TABLES) body.cursors[spec.bucket] = page.cursor
    body.cursors.tombstones = page.cursor
  }
  return jsonResponse(body)
}

// ---------------------------------------------------------------------------
// 二、POST /v1/sync/push —— 脱敏增量 + revision CAS（严格按契约 §5.2 顺序）
// ---------------------------------------------------------------------------

/** 可空 id 列归一：把 `null`/`undefined`/`'null'`/`'undefined'` 统一成 SQL NULL。 */
function nullableId(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text === 'null' || text === 'undefined') return null
  return text
}

function boardHotRow(board, revision, syncedAt) {
  const entity = asObject(board)
  const cardOrder = asObject(entity.cardOrder)
  const normalizedOrder = {}
  for (const [column, ids] of Object.entries(cardOrder)) {
    if (Array.isArray(ids)) normalizedOrder[column] = ids.filter(id => typeof id === 'string')
  }
  return [
    cleanString(entity.id),
    cleanString(entity.name),
    typeof entity.description === 'string' && entity.description ? entity.description : null,
    JSON.stringify(normalizedOrder),
    entity.archived === true ? 1 : 0,
    toInt(entity.createdAt),
    toInt(entity.updatedAt),
    revision,
    JSON.stringify(entity),
    syncedAt,
  ]
}

function cardHotRow(card, revision, syncedAt) {
  const entity = asObject(card)
  const id = cleanString(entity.id)
  const status = typeof entity.status === 'string' ? entity.status : ''
  if (!CARD_STATUSES.has(status)) {
    throw badRequest(`卡片 ${id || '(空 id)'} 的 status 非法：${status || '(空)'}`, { allowed: [...CARD_STATUSES] })
  }
  const version = Number.isInteger(entity.version) && entity.version >= 1 ? entity.version : 1
  return [
    id,
    cleanString(entity.boardId),
    typeof entity.title === 'string' ? entity.title : '',
    status,
    cleanString(entity.priority) || 'none',
    nullableId(entity.project),
    nullableId(entity.externalRef),
    nullableId(entity.parentCardId),
    version,
    entity.archived === true ? 1 : 0,
    toInt(entity.createdAt),
    toInt(entity.updatedAt),
    Number.isFinite(Number(entity.completedAt)) ? toInt(entity.completedAt) : null,
    revision,
    JSON.stringify(entity),
    syncedAt,
  ]
}

function activityHotRow(activity, revision, syncedAt) {
  const entity = asObject(activity)
  const id = cleanString(entity.id)
  const cardId = cleanString(entity.cardId)
  if (!cardId) throw badRequest(`时间线节点 ${id || '(空 id)'} 缺少 cardId`)
  const actor = asObject(entity.actor)
  const actorKind = ACTOR_KINDS.has(actor.kind) ? actor.kind : 'system'
  return [
    id,
    cardId,
    nullableId(activity.boardId),
    cleanString(entity.type) || 'progress',
    actorKind,
    typeof actor.name === 'string' && actor.name ? actor.name : null,
    typeof entity.text === 'string' ? entity.text : '',
    toInt(entity.at),
    revision,
    JSON.stringify(entity),
    syncedAt,
  ]
}

/**
 * 实体 id 长度守卫：pull 游标的 id 上限是 256 字符（含 2 字符类别前缀），
 * 若允许超长 id 入库，一旦它落在一页末尾，该窗口的 pull 会永久 400（C2 复核 m5）。
 */
function assertEntityIdLengths(delta) {
  for (const bucket of ['boards', 'cards', 'activities']) {
    for (const item of delta[bucket]?.upserts ?? []) {
      if (item.id.length > ENTITY_ID_MAX_LENGTH) {
        throw badRequest(`${bucket}.upserts 的 id 超长（${item.id.length} > ${ENTITY_ID_MAX_LENGTH} 字符）`)
      }
    }
    for (const id of delta[bucket]?.deletes ?? []) {
      if (id.length > ENTITY_ID_MAX_LENGTH) {
        throw badRequest(`${bucket}.deletes 的 id 超长（${id.length} > ${ENTITY_ID_MAX_LENGTH} 字符）`)
      }
    }
  }
}

/** push 冲突统一错误（409），details 同时给出 serverRevision / expectedBaseRevision / epoch。 */
function pushConflictError(code, meta, { baseRevision, serverRevision, expectedBaseRevision, resetRequired }) {
  const mismatch = code === 'SYNC_EPOCH_MISMATCH'
  const message = mismatch
    ? '云端 epoch 已变化（D1 被重建），请以本地全量快照做 reset 推送'
    : 'baseRevision 与云端 revision 不一致，请先 GET /v1/sync/pull 追平后重算增量'
  return new CloudSyncError(code, message, {
    details: {
      baseRevision,
      serverRevision,
      expectedBaseRevision,
      epoch: meta.epoch,
      resetRequired: Boolean(resetRequired),
    },
  })
}

/**
 * 构造一次 push 的 D1 batch 语句（同一 batch = 一个事务）：
 *   reset 清空（可选）→ boards upsert → cards upsert → activities upsert
 *   → 各实体 delete + 墓碑 → 最后一条 CAS 提交（原子闸门）。
 * layout 记录每条语句归属的 applied 计数分组（null = 不计入）。
 */
function buildPushStatements({ db, delta, revision, now, reset, baseRevision, pushId, clientId }) {
  const entries = []
  const add = (sql, params, group, op) => entries.push({ sql, params, group, op })

  if (reset) {
    for (const table of ['boards', 'cards', 'activities', 'tombstones']) {
      // reset 清空不计入 applied（它是重建语义，不是增量删除）；保留 sync_meta 与 ingress_inbox
      add(`DELETE FROM ${table}`, [], null, 'reset')
    }
  }
  // 纵深防御：即使 C3 漏做脱敏，也在云端用同一套白名单投影函数再投影一次，
  // 保证本地执行面字段（cwd/workspaceId/sessionIds/runtime…）永远进不了 D1。
  // 同时按 UPSERT_CHUNK_ROWS 合并成多行 INSERT，压低单批 SQL 语句数（D1 限额友好）。
  for (const chunk of chunkArray(delta.boards?.upserts ?? [], UPSERT_CHUNK_ROWS.boards)) {
    add(
      `${BOARD_UPSERT_HEAD} VALUES ${multiRowValues(chunk.length, 10)} ${BOARD_UPSERT_TAIL}`,
      chunk.flatMap(board => boardHotRow(toCloudBoard(board), revision, now)),
      'boards',
      'upserted',
    )
  }
  for (const chunk of chunkArray(delta.cards?.upserts ?? [], UPSERT_CHUNK_ROWS.cards)) {
    add(
      `${CARD_UPSERT_HEAD} VALUES ${multiRowValues(chunk.length, 16)} ${CARD_UPSERT_TAIL}`,
      chunk.flatMap(card => cardHotRow(toCloudCard(card), revision, now)),
      'cards',
      'upserted',
    )
  }
  for (const chunk of chunkArray(delta.activities?.upserts ?? [], UPSERT_CHUNK_ROWS.activities)) {
    add(
      `${ACTIVITY_UPSERT_HEAD} VALUES ${multiRowValues(chunk.length, 11)} ${ACTIVITY_UPSERT_TAIL}`,
      chunk.flatMap(activity => activityHotRow(toCloudActivity(activity), revision, now)),
      'activities',
      'upserted',
    )
  }
  for (const bucket of ['boards', 'cards', 'activities']) {
    const entity = BUCKET_ENTITY[bucket]
    const table = ENTITY_TABLE[entity]
    const ids = (delta[bucket]?.deletes ?? []).map(cleanString).filter(Boolean)
    if (ids.length === 0) continue
    // 合并多行语句：200 个删除 → 2 条 DELETE + 10 条多行墓碑，而不是 400 条单行语句，
    // 既满足契约「upsert → 删除 + 墓碑 → CAS」顺序，又压低 D1 batch 的语句数。
    for (const chunk of chunkArray(ids, DELETE_IN_CHUNK)) {
      add(
        `DELETE FROM ${table} WHERE id IN (${chunk.map(() => '?').join(', ')})`,
        chunk,
        bucket,
        'deleted',
      )
    }
    for (const chunk of chunkArray(ids, TOMBSTONE_ROW_CHUNK)) {
      const values = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')
      add(
        `${TOMBSTONE_MULTI_HEAD} VALUES ${values} ${TOMBSTONE_MULTI_TAIL}`,
        chunk.flatMap(id => [entity, id, null, now, revision]),
        null,
        'tombstone',
      )
    }
  }
  add(PUSH_CAS_SQL, [revision, pushId, now, revision, clientId, now, baseRevision], null, 'cas')
  return {
    add,
    entries,
    statements: entries.map(entry => db.prepare(entry.sql).bind(...entry.params)),
  }
}

async function handlePush(request, env, options) {
  requireAuthorized(request, env)
  const db = requireDb(env)
  const text = await readTextBody(request, { maxBytes: CLOUD_SYNC_LIMITS.pushBytes })
  const body = requireJsonObject(text)
  assertProtocolVersion(body.protocolVersion)

  const clientId = cleanString(body.clientId)
  if (!clientId) throw badRequest('clientId 必填（1~80 字符）')
  if (clientId.length > 80) throw badRequest('clientId 超长（上限 80 字符）')
  const pushId = cleanString(body.pushId)
  if (!pushId) throw badRequest('pushId 必填（幂等键，重试必须复用）')
  if (pushId.length > 256) throw badRequest('pushId 超长（上限 256 字符）')
  if (typeof body.baseRevision !== 'number') throw badRequest('baseRevision 必须是 ≥0 的整数（JSON number）')
  const baseRevision = body.baseRevision
  if (!Number.isInteger(baseRevision) || baseRevision < 0) throw badRequest('baseRevision 必须是 ≥0 的整数')
  const epoch = cleanString(body.epoch)
  if (epoch && epoch.length > 64) throw badRequest('epoch 超长（上限 64 字符）')
  const reset = body.reset === true

  assertValidDelta(body.delta)
  assertEntityIdLengths(body.delta)
  const counts = countDelta(body.delta)
  const meta = await readSyncMeta(db)

  // 契约 §5.2 第 2 步：epoch 校验先于一切写操作（空 delta 也不例外，避免掩盖云端重建）
  if (epoch && epoch !== meta.epoch) {
    throw pushConflictError('SYNC_EPOCH_MISMATCH', meta, {
      baseRevision,
      serverRevision: meta.revision,
      expectedBaseRevision: baseRevision,
      resetRequired: true,
    })
  }
  const plan = planPush({
    baseRevision,
    serverRevision: meta.revision,
    epoch,
    serverEpoch: meta.epoch,
    delta: body.delta,
    pushId,
    lastPushId: meta.lastPushId,
    lastPushRevision: meta.lastPushRevision,
  })

  if (plan.action === 'duplicate') {
    return jsonResponse({
      ok: true,
      status: 'duplicate',
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      epoch: meta.epoch,
      baseRevision,
      revision: plan.revision,
      pushId,
      applied: emptyApplied(),
    })
  }
  if (plan.action === 'conflict') {
    throw pushConflictError(plan.code, meta, {
      baseRevision,
      serverRevision: plan.serverRevision,
      expectedBaseRevision: plan.expectedBaseRevision,
      resetRequired: plan.code === 'SYNC_EPOCH_MISMATCH',
    })
  }
  let newRevision
  if (plan.action === 'noop') {
    // 空 delta 也校验 baseRevision（避免客户端在云端已前进时误以为追平）
    if (baseRevision !== meta.revision) {
      throw pushConflictError('REVISION_CONFLICT', meta, {
        baseRevision,
        serverRevision: meta.revision,
        expectedBaseRevision: baseRevision,
      })
    }
    if (!reset) {
      return jsonResponse({
        ok: true,
        status: 'noop',
        protocolVersion: CLOUD_PROTOCOL_VERSION,
        epoch: meta.epoch,
        baseRevision,
        revision: plan.revision,
        pushId,
        applied: emptyApplied(),
      })
    }
    // reset:true + 空 delta：清空镜像本身是一次真实写入，必须分配 revision 才能被 pull 观察到
    newRevision = nextCloudRevision(meta.revision)
  } else {
    newRevision = plan.revision
  }

  const now = nowOf(options)
  const built = buildPushStatements({
    db,
    delta: body.delta,
    revision: newRevision,
    now,
    reset,
    baseRevision,
    pushId,
    clientId,
  })
  const results = await d1(db.batch(built.statements))

  // CAS 是 batch 最后一条；changes=0 表示并发写者抢先（单写者假设外的异常）
  const casResult = results[results.length - 1]
  if (changedCount(casResult) !== 1) {
    throw new CloudSyncError('REVISION_CONFLICT', '并发写入：revision CAS 未命中，请 pull 后重试', {
      details: { serverRevision: null, expectedBaseRevision: baseRevision },
    })
  }
  const applied = emptyApplied()
  built.entries.forEach((entry, index) => {
    if (!entry.group) return
    applied[entry.group][entry.op] += changedCount(results[index])
  })
  logEvent(env, 'info', 'cloud_push_applied', {
    revision: newRevision,
    clientId,
    pushId,
    entities: counts.total,
    reset,
  })
  return jsonResponse({
    ok: true,
    status: 'applied',
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    epoch: meta.epoch,
    baseRevision,
    revision: newRevision,
    pushId,
    reset,
    applied,
  })
}

// ---------------------------------------------------------------------------
// 三、POST /v1/ingress/:provider —— Webhook 暂存入口（按来源验签，不走 Bearer）
// ---------------------------------------------------------------------------

function verifyGithubIngress({ request, env, rawText }) {
  const secret = cleanString(env.GITHUB_WEBHOOK_SECRET)
  if (!secret) throw unavailable('未配置 GITHUB_WEBHOOK_SECRET，GitHub 入站已关闭（fail-closed）')
  const provided = cleanString(request.headers.get('x-hub-signature-256')).toLowerCase()
  if (!provided.startsWith('sha256=')) throw forbidden('GitHub Webhook 缺少合法的 X-Hub-Signature-256')
  const expected = `sha256=${createHmac('sha256', secret).update(rawText, 'utf8').digest('hex')}`
  if (!constantTimeEqual(provided, expected)) throw forbidden('GitHub Webhook 签名校验失败')
}

function verifyFeishuIngress({ request, env, rawText, parsed, now }) {
  const verificationToken = cleanString(env.FEISHU_VERIFICATION_TOKEN)
  const encryptKey = cleanString(env.FEISHU_ENCRYPT_KEY)
  if (!verificationToken && !encryptKey) {
    throw unavailable('未配置 FEISHU_VERIFICATION_TOKEN / FEISHU_ENCRYPT_KEY，飞书入站已关闭（fail-closed）')
  }
  const challenge = typeof parsed.challenge === 'string' ? parsed.challenge : ''
  const isChallenge = String(parsed.type || '').toLowerCase() === 'url_verification'
    || (Boolean(challenge) && typeof parsed.token === 'string')
  if (isChallenge) {
    // URL 验证：必须在 3s 内秒回 challenge，且不落库
    if (!verificationToken) {
      throw unavailable('未配置 FEISHU_VERIFICATION_TOKEN，无法校验飞书 challenge（fail-closed）')
    }
    const token = cleanString(parsed.token)
    if (!token || !constantTimeEqual(token, verificationToken)) throw forbidden('飞书 challenge token 校验失败')
    if (!challenge) throw badRequest('飞书 URL 验证请求缺少 challenge 字段')
    return { challenge }
  }
  if (parsed.encrypt !== undefined) {
    throw new CloudSyncError(
      'UNSUPPORTED_MEDIA_TYPE',
      '飞书加密事件（body.encrypt）暂不支持：请在飞书后台关闭 Encrypt Key，或由 C3 扩展解密后再回放',
    )
  }
  if (verificationToken) {
    const token = cleanString(parsed.token) || cleanString(parsed?.header?.token)
    if (!token || !constantTimeEqual(token, verificationToken)) throw forbidden('飞书事件 token 校验失败')
  }
  if (encryptKey) {
    const timestamp = cleanString(request.headers.get('x-lark-request-timestamp'))
    const nonce = cleanString(request.headers.get('x-lark-request-nonce'))
    const signature = cleanString(request.headers.get('x-lark-signature')).toLowerCase()
    const numeric = Number(timestamp)
    const timestampMs = Number.isFinite(numeric) ? (numeric > 1e12 ? numeric : numeric * 1000) : NaN
    if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > WEBHOOK_MAX_SKEW_MS) {
      throw forbidden('飞书事件时间戳缺失或超出允许窗口（±1h），疑似重放')
    }
    const expected = createHash('sha256').update(`${timestamp}${nonce}${encryptKey}${rawText}`, 'utf8').digest('hex')
    if (!signature || !constantTimeEqual(signature, expected)) throw forbidden('飞书事件签名（X-Lark-Signature）校验失败')
  }
  return null
}

function verifyDingtalkIngress({ request, env, parsed, now }) {
  const signSecret = cleanString(env.DINGTALK_SIGN_SECRET)
  const accessToken = cleanString(env.DINGTALK_ACCESS_TOKEN)
  if (!signSecret && !accessToken) {
    throw unavailable('未配置 DINGTALK_SIGN_SECRET / DINGTALK_ACCESS_TOKEN，钉钉入站已关闭（fail-closed）')
  }
  if (signSecret) {
    const timestamp = cleanString(request.headers.get('timestamp')) || cleanString(request.headers.get('x-dingtalk-timestamp'))
    const sign = cleanString(request.headers.get('sign')) || cleanString(request.headers.get('x-dingtalk-sign'))
    if (!timestamp || !sign) throw forbidden('钉钉 Webhook 缺少 timestamp/sign 加签头')
    const numeric = Number(timestamp)
    const timestampMs = Number.isFinite(numeric) ? (numeric > 1e12 ? numeric : numeric * 1000) : NaN
    if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > WEBHOOK_MAX_SKEW_MS) {
      throw forbidden('钉钉 Webhook 时间戳超出允许窗口（±1h），疑似重放')
    }
    const expected = createHmac('sha256', signSecret).update(`${timestamp}\n${signSecret}`, 'utf8').digest('base64')
    if (!constantTimeEqual(sign, expected)) throw forbidden('钉钉 Webhook 加签校验失败')
    return null
  }
  const provided = cleanString(parsed.token) || cleanString(parsed?.header?.token)
    || cleanString(request.headers.get('x-dingtalk-token'))
  if (!provided || !constantTimeEqual(provided, accessToken)) throw forbidden('钉钉 access_token 校验失败')
  return null
}

function verifyGenericIngress({ request, env }) {
  const expected = cleanString(env.INGRESS_GENERIC_TOKEN)
  if (!expected) {
    throw unavailable('未配置 INGRESS_GENERIC_TOKEN，generic/wecom/onebot/weixin 入站已关闭（fail-closed）')
  }
  const provided = cleanString(request.headers.get('x-kanban-ingress-token'))
    || parseBearerToken(request.headers.get('authorization'))
    || ''
  if (!provided || !constantTimeEqual(provided, expected)) throw forbidden('入站共享 token 校验失败')
  return null
}

/** 按来源分发验签；飞书 challenge 返回 {challenge}（调用方秒回，不入库）。 */
function verifyIngressSource({ provider, request, env, rawText, parsed, now }) {
  switch (provider) {
    case 'github':
      return verifyGithubIngress({ request, env, rawText })
    case 'feishu':
      return verifyFeishuIngress({ request, env, rawText, parsed, now })
    case 'dingtalk':
      return verifyDingtalkIngress({ request, env, parsed, now })
    default:
      return verifyGenericIngress({ request, env })
  }
}

/**
 * 入站信封使用的请求头视图：
 * - github/feishu/dingtalk 有各自的投递 id 头（x-github-delivery / x-request-id / x-dingtalk-*）；
 * - generic/wecom/onebot/weixin 的上游网关/反代常把 `x-request-id` 复用为链路追踪 id，
 *   若拿它当 delivery id，会把不同事件静默判重丢弃（C2 复核 m6）。这里对 generic 系去掉该头，
 *   让去重退化为「provider + 事件类型 + 原始体」的 sha256。
 */
const FIRST_PARTY_DELIVERY_PROVIDERS = new Set(['github', 'feishu', 'dingtalk'])

function ingressEnvelopeHeaders(request, provider) {
  if (FIRST_PARTY_DELIVERY_PROVIDERS.has(provider)) return request.headers
  const headers = new Headers(request.headers)
  headers.delete('x-request-id')
  return headers
}

/** 飞书 v2 事件类型在 header.event_type（协议层 detectEventType 未覆盖，这里显式提示）。 */
function ingressEventTypeHint(provider, parsed) {
  if (provider !== 'feishu') return ''
  return cleanString(parsed?.header?.event_type)
}

async function handleIngress(request, env, providerInput, options) {
  const provider = cleanString(providerInput).toLowerCase()
  if (!CLOUD_INGRESS_PROVIDERS.includes(provider)) {
    throw badRequest(`不支持的入站来源：${provider || '(空)'}`, { supported: CLOUD_INGRESS_PROVIDERS })
  }
  const db = requireDb(env)
  const rawText = await readTextBody(request, {
    maxBytes: CLOUD_SYNC_LIMITS.ingressPayloadBytes,
    code: 'PAYLOAD_TOO_LARGE',
  })
  const parsed = requireJsonObject(rawText, {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    label: '入站请求体（只接受 JSON 对象）',
  })
  const now = nowOf(options)
  const verification = verifyIngressSource({ provider, request, env, rawText, parsed, now })
  if (verification?.challenge !== undefined) {
    // 飞书 URL 验证：原样返回 challenge（飞书要求顶层字段，不能再包 ok 信封）
    return jsonResponse({ challenge: verification.challenge })
  }

  const eventTypeHint = ingressEventTypeHint(provider, parsed)
  const envelope = normalizeIngressEnvelope({
    provider,
    headers: ingressEnvelopeHeaders(request, provider),
    payload: rawText,
    now,
    ...(eventTypeHint ? { eventType: eventTypeHint } : {}),
  })
  const insert = db.prepare(INGRESS_INSERT_SQL).bind(
    envelope.id,
    envelope.provider,
    envelope.eventType || null,
    envelope.deliveryId || null,
    envelope.dedupeKey,
    JSON.stringify(envelope.headers),
    envelope.payload,
    envelope.payloadBytes,
    CLOUD_SYNC_LIMITS.ingressMaxAttempts,
    envelope.receivedAt,
    envelope.expiresAt,
  )
  const select = db.prepare(
    'SELECT seq, id, status, received_at FROM ingress_inbox WHERE dedupe_key = ?',
  ).bind(envelope.dedupeKey)
  const [insertResult, selectResult] = await d1(db.batch([insert, select]))
  const row = rowsOf(selectResult)[0]
  if (!row) throw new CloudSyncError('INTERNAL', '入站事件入队后未能读取记录（请检查 D1 可用性）')
  const duplicate = changedCount(insertResult) === 0
  logEvent(env, 'info', 'cloud_ingress_enqueued', {
    provider: envelope.provider,
    id: String(row.id),
    seq: toInt(row.seq),
    duplicate,
  })
  return jsonResponse(
    {
      ok: true,
      id: String(row.id),
      seq: toInt(row.seq),
      provider: envelope.provider,
      status: String(row.status),
      receivedAt: toInt(row.received_at),
      duplicate,
    },
    { status: 202 },
  )
}

// ---------------------------------------------------------------------------
// 四、POST /v1/inbox/claim —— 领取待回放事件（写租约，崩溃后自动可重领）
// ---------------------------------------------------------------------------

async function handleClaim(request, env, options) {
  requireAuthorized(request, env)
  const db = requireDb(env)
  const text = await readTextBody(request, { maxBytes: 64 * 1024 })
  const body = text.trim() ? requireJsonObject(text) : {}
  const consumerId = cleanString(body.consumerId).slice(0, 80)
  const limit = clampInt(body.limit, CLOUD_SYNC_LIMITS.ingressBatch, 1, CLOUD_SYNC_LIMITS.ingressBatch)
  const leaseSeconds = clampInt(body.leaseSeconds, 120, 30, 900)
  const now = nowOf(options)
  const leaseExpiresAt = now + leaseSeconds * 1000

  const candidates = rowsOf(await d1(db.prepare(CLAIM_SELECT_SQL).bind(now, now, now, limit).all()))
  if (candidates.length === 0) {
    return jsonResponse({
      ok: true,
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      items: [],
      consumerId,
      limit,
      leaseSeconds,
    })
  }
  const statements = []
  const leases = []
  for (const row of candidates) {
    const leaseToken = `lease-${newRequestId().slice(4)}`
    leases.push({ row, leaseToken, leaseExpiresAt })
    statements.push(
      db.prepare(CLAIM_UPDATE_SQL).bind(leaseToken, leaseExpiresAt, toInt(row.seq), now, now, now),
    )
  }
  const results = await d1(db.batch(statements))
  const items = []
  leases.forEach((entry, index) => {
    if (changedCount(results[index]) !== 1) return // 竞争失败（已被其他消费者领走）
    const row = entry.row
    let headers = {}
    try {
      const parsed = JSON.parse(String(row.headers ?? '{}'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed
    } catch {
      headers = {}
    }
    items.push({
      seq: toInt(row.seq),
      id: String(row.id),
      provider: String(row.provider),
      eventType: row.event_type == null ? '' : String(row.event_type),
      deliveryId: row.delivery_id == null ? '' : String(row.delivery_id),
      headers,
      payload: String(row.payload ?? ''),
      attempts: toInt(row.attempts),
      maxAttempts: toInt(row.max_attempts, CLOUD_SYNC_LIMITS.ingressMaxAttempts),
      receivedAt: toInt(row.received_at),
      expiresAt: toInt(row.expires_at),
      leaseToken: entry.leaseToken,
      leaseExpiresAt: entry.leaseExpiresAt,
    })
  })
  logEvent(env, 'info', 'cloud_inbox_claimed', { consumerId, count: items.length })
  return jsonResponse({
    ok: true,
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    items,
    consumerId,
    limit,
    leaseSeconds,
  })
}

// ---------------------------------------------------------------------------
// 五、POST /v1/inbox/ack —— 消费回执（acked / retry 退避 / dead）
// ---------------------------------------------------------------------------

async function handleAck(request, env, options) {
  requireAuthorized(request, env)
  const db = requireDb(env)
  const text = await readTextBody(request, { maxBytes: 256 * 1024 })
  const body = requireJsonObject(text)
  const consumerId = cleanString(body.consumerId).slice(0, 80)
  if (!Array.isArray(body.results)) throw badRequest('results 必须是数组')
  if (body.results.length > ACK_MAX_RESULTS) {
    throw badRequest(`results 条数 ${body.results.length} 超过上限 ${ACK_MAX_RESULTS}`)
  }
  const now = nowOf(options)
  const acked = []
  const retried = []
  const dead = []
  const missing = []
  const ignored = []

  // 同一 id 重复出现时以最后一条为准（避免批量更新互相覆盖）
  const deduped = new Map()
  for (const result of body.results) {
    const id = cleanString(result?.id)
    if (!id) throw badRequest('results[].id 必须是非空字符串')
    const outcome = cleanString(result?.outcome).toLowerCase()
    if (!['acked', 'retry', 'dead'].includes(outcome)) {
      throw badRequest(`results[].outcome 非法：${outcome || '(空)'}（允许 acked/retry/dead）`)
    }
    deduped.set(id, {
      id,
      outcome,
      error: cleanString(result?.error).slice(0, 500),
      // 可选租约校验：C3 可把 claim 返回的 leaseToken 原样带回，防止其他消费者误 ack
      leaseToken: cleanString(result?.leaseToken).slice(0, 200),
    })
  }
  const ids = [...deduped.keys()]
  if (ids.length === 0) {
    return jsonResponse({
      ok: true,
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      acked,
      retried,
      dead,
      missing,
      ignored,
      consumerId,
    })
  }

  // 分块回查：D1 单查询绑定参数上限 100，ACK_MAX_RESULTS=200 时分两块（C2 复核 M1）
  const rows = []
  for (const chunk of chunkArray(ids, ACK_SELECT_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ')
    rows.push(...rowsOf(await d1(db.prepare(
      `SELECT id, status, attempts, max_attempts, lease_token FROM ingress_inbox WHERE id IN (${placeholders})`,
    ).bind(...chunk).all())))
  }
  const byId = new Map(rows.map(row => [String(row.id), row]))
  const statements = []
  const targets = []
  for (const result of deduped.values()) {
    const row = byId.get(result.id)
    if (!row) {
      missing.push(result.id)
      continue
    }
    // 状态机守卫：acked / dead 是终态，迟到的 ACK 不得把它们复活成 pending（C2 复核 m4）
    if (!['pending', 'leased'].includes(String(row.status))) {
      ignored.push(result.id)
      continue
    }
    // 可选租约守卫：客户端带回 leaseToken 时校验，防止非租约持有者误 ack（C2 复核 R1）
    if (result.leaseToken && row.lease_token && String(row.lease_token) !== result.leaseToken) {
      ignored.push(result.id)
      continue
    }
    if (result.outcome === 'acked') {
      statements.push(db.prepare(ACK_ACKED_SQL).bind(now, result.id))
      targets.push({ id: result.id, group: 'acked' })
      continue
    }
    if (result.outcome === 'dead') {
      statements.push(db.prepare(ACK_DEAD_SQL).bind(result.error || '本地判定不可重试（dead）', result.id))
      targets.push({ id: result.id, group: 'dead' })
      continue
    }
    const transition = nextIngressAttempt(
      { attempts: toInt(row.attempts), maxAttempts: toInt(row.max_attempts, CLOUD_SYNC_LIMITS.ingressMaxAttempts) },
      { now, error: result.error || '本地消费失败，退避重试' },
    )
    statements.push(
      db.prepare(ACK_RETRY_SQL).bind(
        transition.status,
        transition.attempts,
        transition.nextAttemptAt,
        transition.lastError ?? null,
        result.id,
      ),
    )
    targets.push({ id: result.id, group: transition.status === 'dead' ? 'dead' : 'retried' })
  }
  // 更新语句分批提交（每批 ≤50 条），与 push 一样对 D1 单批语句数限额友好；
  // 每批独立成功即可，客户端重发 ACK 依幂等/终态守卫安全。
  for (const chunk of chunkArray(statements, 50)) {
    await d1(db.batch(chunk))
  }
  for (const target of targets) {
    if (target.group === 'acked') acked.push(target.id)
    else if (target.group === 'dead') dead.push(target.id)
    else retried.push(target.id)
  }
  logEvent(env, 'info', 'cloud_inbox_acked', {
    consumerId,
    acked: acked.length,
    retried: retried.length,
    dead: dead.length,
    missing: missing.length,
    ignored: ignored.length,
  })
  return jsonResponse({
    ok: true,
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    acked,
    retried,
    dead,
    missing,
    ignored,
    consumerId,
  })
}

// ---------------------------------------------------------------------------
// 五（续）、POST /v1/mcp —— 远程 Streamable HTTP MCP 控制面（只读直连 D1 + 写入队回放）
// ---------------------------------------------------------------------------

async function handleMcp(request, env, options) {
  // 鉴权必须在方法检查前执行：未配置令牌时一律 503，缺/错 Bearer 一律 401（绝不泄漏端点能力）
  assertCloudMcpAuthorized(request, env)
  const method = String(request.method || 'GET').toUpperCase()
  if (method === 'DELETE') {
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  }
  if (method !== 'POST') {
    throw methodNotAllowed(method, 'POST, DELETE')
  }

  const db = requireDb(env)
  const rawText = await readTextBody(request, {
    maxBytes: CLOUD_SYNC_LIMITS.ingressPayloadBytes,
    code: 'PAYLOAD_TOO_LARGE',
  })

  let parsedBody
  try {
    parsedBody = rawText.trim() ? JSON.parse(rawText) : null
  } catch {
    return jsonResponse(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 200 },
    )
  }
  if (parsedBody === null) {
    return jsonResponse(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
      { status: 200 },
    )
  }

  const now = nowOf(options)
  const agentName = cleanString(request.headers.get('x-kanban-agent')).slice(0, 80) || 'Cloud MCP Agent'
  const harness = cleanString(request.headers.get('x-kanban-harness')).slice(0, 40) || 'cloud-mcp'
  const agentUrl = cleanString(request.headers.get('x-kanban-agent-url')).slice(0, 800) || undefined
  const idempotencyHeader = cleanString(request.headers.get('x-kanban-mcp-call-id')).slice(0, 160)
  let writeCallIndex = 0

  const enqueueWrite = async ({
    tool,
    args,
    preferredCardId,
    agentName: callAgentName,
    harness: callHarness,
    agentUrl: callAgentUrl,
    now: callNow,
  }) => {
    writeCallIndex += 1
    const suppliedCallId = idempotencyHeader
      ? (writeCallIndex === 1 ? idempotencyHeader : `${idempotencyHeader}-${writeCallIndex}`)
      : ''
    const { mcpCallId, payload: envelopePayload } = buildCloudMcpIngressPayload({
      tool,
      args,
      preferredCardId,
      agentName: callAgentName || agentName,
      harness: callHarness || harness,
      ...(callAgentUrl || agentUrl ? { agentUrl: callAgentUrl || agentUrl } : {}),
      ...(suppliedCallId ? { mcpCallId: suppliedCallId } : {}),
      now: callNow ?? now,
    })
    const envelope = normalizeIngressEnvelope({
      provider: 'generic',
      headers: {},
      payload: JSON.stringify(envelopePayload),
      eventType: 'mcp_tool_call',
      deliveryId: mcpCallId,
      now: callNow ?? now,
    })
    const insert = db.prepare(INGRESS_INSERT_SQL).bind(
      envelope.id,
      envelope.provider,
      envelope.eventType || null,
      envelope.deliveryId || null,
      envelope.dedupeKey,
      JSON.stringify(envelope.headers),
      envelope.payload,
      envelope.payloadBytes,
      CLOUD_SYNC_LIMITS.ingressMaxAttempts,
      envelope.receivedAt,
      envelope.expiresAt,
    )
    const select = db.prepare(
      'SELECT seq, id, status, received_at FROM ingress_inbox WHERE dedupe_key = ?',
    ).bind(envelope.dedupeKey)
    const [insertResult, selectResult] = await d1(db.batch([insert, select]))
    const row = rowsOf(selectResult)[0]
    if (!row) throw new CloudSyncError('INTERNAL', 'MCP 写事件入队后未能读取记录（请检查 D1 可用性）')
    const duplicate = changedCount(insertResult) === 0
    logEvent(env, 'info', 'cloud_mcp_write_enqueued', {
      tool,
      id: String(row.id),
      seq: toInt(row.seq),
      duplicate,
    })
    return {
      id: String(row.id),
      seq: toInt(row.seq),
      duplicate,
      receivedAt: toInt(row.received_at),
    }
  }

  const rpcResponse = await handleCloudMcpJsonRpc(parsedBody, {
    db,
    enqueueWrite,
    now,
    agentName,
    harness,
    agentUrl,
  })
  if (rpcResponse === null) {
    return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } })
  }
  return jsonResponse(rpcResponse, { status: 200 })
}

// ---------------------------------------------------------------------------
// 六、Cron 清理（契约 §3.9 / 迁移文件头注释）
// ---------------------------------------------------------------------------

/**
 * 每小时清理：
 *   - ingress_inbox：acked 超 7 天、过 expires_at 的条目；
 *   - outbox：delivered/expired 超 3 天；
 *   - activities：镜像只保留最近 90 天；
 *   - tombstones：只保留最近 2000 个 revision 窗口。
 * 返回各表删除行数（观测用）。
 */
export async function runCleanup(env, { now = Date.now() } = {}) {
  const db = requireDb(env)
  const currentTime = toInt(now, Date.now())
  const statements = [
    db.prepare("DELETE FROM ingress_inbox WHERE status = 'acked' AND acked_at IS NOT NULL AND acked_at < ?")
      .bind(currentTime - 7 * 24 * 60 * 60 * 1000),
    db.prepare('DELETE FROM ingress_inbox WHERE expires_at < ?').bind(currentTime),
    db.prepare("DELETE FROM outbox WHERE state IN ('delivered', 'expired') AND updated_at < ?")
      .bind(currentTime - 3 * 24 * 60 * 60 * 1000),
    db.prepare('DELETE FROM tombstones WHERE revision <= (SELECT revision FROM sync_meta WHERE id = 1) - ?')
      .bind(2000),
    db.prepare('DELETE FROM activities WHERE at < ?').bind(currentTime - 90 * 24 * 60 * 60 * 1000),
  ]
  const results = await d1(db.batch(statements))
  return {
    deleted: {
      ingressAcked: changedCount(results[0]),
      ingressExpired: changedCount(results[1]),
      outbox: changedCount(results[2]),
      tombstones: changedCount(results[3]),
      activities: changedCount(results[4]),
    },
  }
}

// ---------------------------------------------------------------------------
// 七、路由与 Worker 入口
// ---------------------------------------------------------------------------

/**
 * 请求入口（可测试）：返回 Response，不抛异常（所有错误统一错误信封 + requestId）。
 * options.now 可注入固定时钟（租约/退避/过期测试用）；生产不传。
 */
export async function handleRequest(request, env = {}, options = {}) {
  const requestId = options.requestId || newRequestId()
  const method = String(request.method || 'GET').toUpperCase()
  let path = '/'
  try {
    const url = new URL(request.url)
    path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === '/v1/mcp' || path === '/mcp') {
      return withRequestId(await handleMcp(request, env, options), requestId)
    }
    if (path === '/v1/sync/pull') {
      if (method !== 'GET') throw methodNotAllowed(method, 'GET')
      return withRequestId(await handlePull(request, env, url, options), requestId)
    }
    if (path === '/v1/sync/push') {
      if (method !== 'POST') throw methodNotAllowed(method, 'POST')
      return withRequestId(await handlePush(request, env, options), requestId)
    }
    if (path === '/v1/ingress' || path.startsWith('/v1/ingress/')) {
      if (method !== 'POST') throw methodNotAllowed(method, 'POST')
      let provider
      try {
        provider = decodeURIComponent(path.slice('/v1/ingress'.length).replace(/^\//, ''))
      } catch {
        throw badRequest('入站来源路径编码非法')
      }
      return withRequestId(await handleIngress(request, env, provider, options), requestId)
    }
    if (path === '/v1/inbox/claim') {
      if (method !== 'POST') throw methodNotAllowed(method, 'POST')
      return withRequestId(await handleClaim(request, env, options), requestId)
    }
    if (path === '/v1/inbox/ack') {
      if (method !== 'POST') throw methodNotAllowed(method, 'POST')
      return withRequestId(await handleAck(request, env, options), requestId)
    }
    throw notFound(`未知路由：${method} ${path}`)
  } catch (error) {
    const body = toErrorResponse(error, { requestId })
    body.protocolVersion = CLOUD_PROTOCOL_VERSION
    const status = error instanceof CloudSyncError ? error.status : 500
    if (status >= 500) {
      logEvent(env, 'error', 'cloud_request_failed', {
        path,
        method,
        code: error instanceof CloudSyncError ? error.code : 'INTERNAL',
      })
      // 仅 debug 级别输出原始异常（含堆栈）到 Worker 日志，响应体永远不带堆栈
      if (cleanString(env?.LOG_LEVEL).toLowerCase() === 'debug') {
        console.error('[cloud-worker]', path, error, error?.cause ?? '')
      }
    }
    const extraHeaders = status === 405 && error instanceof CloudSyncError && error.details?.allowed
      ? { allow: String(error.details.allowed) }
      : undefined
    return jsonResponse(body, { status, requestId, extraHeaders })
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx?.waitUntil ? { waitUntil: ctx.waitUntil.bind(ctx) } : {})
  },
  async scheduled(event, env, ctx) {
    const task = runCleanup(env, { now: Date.now() })
    if (ctx?.waitUntil) ctx.waitUntil(task)
    else await task
  },
}
