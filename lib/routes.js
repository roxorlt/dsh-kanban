// HTTP 层：全部 REST 路由 + SSE + 同源/JSON/大小校验 + 静态资源。
// createRoutes() 返回可直接挂到 DSH webServer 或纯 node http 的 handler 列表，
// 业务状态迁移全部委托给 domain.js，保证 REST 与 agent 工具语义一致。
import { execFile } from 'node:child_process'
import { realpath as fileRealpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DomainError } from './domain.js'
import {
  DEFAULT_BOARD_ID, LIMITS, SCHEMA_VERSION, ackCard, ackOutbox, addComment, appendSessionArchiveActivity, applySeedMode, archiveCard,
  batchArchive, batchMove, batchSessionArchivePlan, cleanText, countsFor, createCard, defaultActor, enqueueOutbox,
  findCard, findCardAny, getAutoAdvanceEnabled, getSuperAgentSessionId, isTerminalCardStatus,
  leaseOutbox, linkSession, mainSessionId, moveCard, normalizeActor,
  newBoard, orderedCards, patchCard, pendingOutboxCount, pushActivity, requestApproval, requireBoard, requireCard, requireSessionBound,
  resolveApproval, sessionArchivePlan, setAutoAdvanceEnabled, setSuperAgentSessionId, touchCard, touchMeta, unarchiveCard, unlinkSession,
} from './domain.js'
import {
  IM_PROVIDERS, IM_TEMPLATE_TYPES, SUPER_AGENT_BOOTSTRAP_PROMPT,
  classifySuperAgentIntent, composeSuperAgentPrompt, formatImNotification, handleIngressEvent,
  loadRouterRules, saveRouterRules, verifyImActionQuery,
} from './im-gateway.js'
import {
  dispatchImNotification, ensureImActionSecret, loadImConfig, loadRuntimeOrigin,
  sanitizeImConfig, saveImConfig, saveRuntimeOrigin,
} from './im-notifier.js'
import { createMcpToolRegistry, handleMcpJsonRpc } from './mcp-server.js'
import { bindingActivity } from './session-binding.js'
import {
  TRASH_RETENTION_DAYS, cleanupWorktree, collectGitContext, collectGitSummary, collectGitWorkspaces,
  isPathInside, listTrashEntries, pruneWorktreeRecords, purgeTrashEntry, restoreTrashEntry,
} from './git.js'
import { createStaticHandler } from './static.js'

export const API_PREFIX = '/api/kanban'
export const STATIC_PREFIX = '/dsh-kanban'
export const BODY_LIMIT = 256 * 1024
export const HEARTBEAT_MS = 15_000
/** 批量 Git 接口（v0.15 §11 / v0.16 §12）：单次最多目录数。 */
export const GIT_BATCH_DIRS_MAX = 32
/** 兼容旧名（§11 批量摘要用）。 */
export const GIT_SUMMARY_DIRS_MAX = GIT_BATCH_DIRS_MAX
export const GIT_SUMMARY_CACHE_TTL_MS = 10_000
export const GIT_SUMMARY_CACHE_LIMIT = 128
/** 工作区地图缓存（v0.16 §12）：按仓库缓存 8s / 最多 64 条。 */
export const GIT_WORKSPACE_CACHE_TTL_MS = 8_000
export const GIT_WORKSPACE_CACHE_LIMIT = 64

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
}
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
}
const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
}

const hasBody = req => req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) > 0

function sendJson(req, res, status, value) {
  if (res.headersSent || res.destroyed) return
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': body.length })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function sendHtml(req, res, status, html) {
  if (res.headersSent || res.destroyed) return
  const body = Buffer.from(String(html), 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': body.length,
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sendError(req, res, code, message, status = 400, extra) {
  sendJson(req, res, status, { ok: false, error: { code, message }, ...(extra || {}) })
}

function methodNotAllowed(req, res, allow) {
  if (res.headersSent || res.destroyed) return
  const body = Buffer.from(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: '请求方法不支持' } }), 'utf8')
  res.writeHead(405, { ...JSON_HEADERS, allow, 'content-length': body.length })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function decodeSegment(segment) {
  try { return decodeURIComponent(segment) } catch { throw new DomainError('BAD_REQUEST', '路径编码不合法') }
}

function assertPathId(id, prefix, label) {
  const pattern = prefix === 'board' ? /^board-(?:default|[a-f0-9]{6,8})$/ : new RegExp(`^${prefix}-[a-f0-9]{6,8}$`)
  if (typeof id !== 'string' || !pattern.test(id)) throw new DomainError('BAD_REQUEST', `${label} ID 格式不合法`)
  return id
}

function isSameOrigin(req) {
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      const expected = new URL((req.socket?.encrypted ? 'https://' : 'http://') + req.headers.host).origin
      if (new URL(origin).origin !== origin || origin !== expected) return false
    } catch { return false }
  }
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}

async function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '')
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
    throw new DomainError('BAD_REQUEST', '需要 Content-Type: application/json', 415)
  }
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    throw new DomainError('TOO_LARGE', `请求体超过 ${Math.round(BODY_LIMIT / 1024)} KiB`, 413)
  }
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new DomainError('TOO_LARGE', `请求体超过 ${Math.round(BODY_LIMIT / 1024)} KiB`, 413)
    chunks.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) throw new DomainError('BAD_JSON', '请求体为空', 400)
  let value
  try { value = JSON.parse(text) } catch { throw new DomainError('BAD_JSON', '请求体不是合法 JSON', 400) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('BAD_JSON', '请求体必须是 JSON 对象', 400)
  return value
}

async function readOptionalBody(req) {
  return hasBody(req) ? readJsonBody(req) : {}
}

async function readJsonOrFormBody(req) {
  const type = String(req.headers['content-type'] || '')
  if (/^application\/x-www-form-urlencoded/i.test(type)) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > BODY_LIMIT) throw new DomainError('TOO_LARGE', `请求体超过 ${Math.round(BODY_LIMIT / 1024)} KiB`, 413)
      chunks.push(Buffer.from(chunk))
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const params = new URLSearchParams(text)
    const out = {}
    for (const [k, v] of params.entries()) out[k] = v
    return out
  }
  return readOptionalBody(req)
}

function versionOf(body, url) {
  if (Number.isInteger(body.version)) return body.version
  const query = url?.searchParams.get('version')
  const parsed = query === null ? NaN : Number(query)
  return Number.isInteger(parsed) ? parsed : undefined
}

function requireVersion(card, body, url) {
  if (body.force === true) return
  const version = versionOf(body, url)
  if (version === undefined) throw new DomainError('BAD_REQUEST', '缺少 version（乐观锁）；脚本调用可显式 force:true')
  if (version !== card.version) {
    throw new DomainError('VERSION_CONFLICT', '卡片已被更新，请刷新后重试', 409, { card: structuredClone(card) })
  }
}

/** 只校验已提供的 version（move 契约：version 可选）。 */
function checkVersionIfPresent(card, body) {
  if (body.force === true || body.version === undefined) return
  if (!Number.isInteger(body.version)) throw new DomainError('BAD_REQUEST', 'version 必须是整数')
  if (body.version !== card.version) {
    throw new DomainError('VERSION_CONFLICT', '卡片已被更新，请刷新后重试', 409, { card: structuredClone(card) })
  }
}

function handleError(req, res, error, logger) {
  if (res.headersSent || res.destroyed || res.writableEnded) return
  if (error instanceof DomainError) {
    const status = error.status || 400
    return sendError(req, res, error.code, error.message, status, error.extra)
  }
  const code = error?.code
  if (code === 'STORE_SCHEMA_NEWER' || code === 'STORE_CORRUPT' || code === 'STORE_IO' || code === 'STORE_CLOSED' || code === 'DECISION_LOG_IO') {
    try { logger?.warn?.(`[dsh-kanban] ${error.message}`) } catch {}
    return sendError(req, res, 'INTERNAL', error.message, 500)
  }
  try { logger?.error?.(error) } catch {}
  return sendError(req, res, 'INTERNAL', '服务端内部错误，请查看 DSH 日志', 500)
}

export function createRoutes({
  store, staticRoot, version = '0.1.0', logger, sessionArchive, sessionBinding,
  weixinChannel, cc2imBridge, onSuperAgentSession, activateHost,
  // 云同步守护器（C3，可选）：未配置 cloud-config.json 时为 null/不可用，
  // GET /api/kanban/cloud/status 静默返回 enabled:false，不产生任何网络行为。
  cloudSync,
  // 批量摘要 / 工作区地图的缓存 TTL 可注入（默认契约值；测试用来验证过期，不影响线上行为）
  gitSummaryCacheTtlMs = GIT_SUMMARY_CACHE_TTL_MS,
  gitWorkspaceCacheTtlMs = GIT_WORKSPACE_CACHE_TTL_MS,
  // 清理工作副本的回收站根目录可注入（默认 ~/.dsh-kanban/trash；测试用临时目录，不碰真实 ~）
  gitTrashRoot = join(homedir(), '.dsh-kanban', 'trash'),
} = {}) {
  if (!store) throw new Error('createRoutes 需要 store')
  const shouldActivateHost = activateHost !== undefined
    ? Boolean(activateHost)
    : (process.platform === 'darwin' && !process.env.NODE_TEST_CONTEXT)
  let lastSavedOrigin = loadRuntimeOrigin(store.dataDir, '')
  let focusSeq = 0
  let latestFocus = null
  // 宿主会话归档适配器（lib/session-archive.js）。缺省/旧宿主：可逆能力不可用，接口统一回 501。
  const archive = sessionArchive ?? {
    available: () => false,
    archivedSessionIds: () => [],
    archive: async () => { throw new DomainError('SESSION_ARCHIVE_UNAVAILABLE', '当前 DSH 版本不支持会话归档', 501) },
    unarchive: async () => { throw new DomainError('SESSION_ARCHIVE_UNAVAILABLE', '当前 DSH 版本不支持取消归档', 501) },
  }
  const clients = new Set()
  let heartbeat = null
  const staticHandler = createStaticHandler({ root: staticRoot, prefix: STATIC_PREFIX })
  // 批量摘要缓存：key = realpath，value = { at, value }（契约 02-http-api §11：10s / 最多 128 条）
  const gitSummaryCache = new Map()
  // 工作区地图缓存：key = 仓库 commonDir realpath，value = { at, repo }（契约 §12：8s / 最多 64 条）
  const gitWorkspaceCache = new Map()
  /** 供 lib/git.js 的 collectGitWorkspaces 读取的缓存适配器（未命中返回 undefined）。 */
  const workspaceCache = {
    get(key) {
      const hit = gitWorkspaceCache.get(key)
      if (!hit || Date.now() - hit.at >= gitWorkspaceCacheTtlMs) return undefined
      return hit.value
    },
    set(key, value) {
      gitWorkspaceCache.delete(key)
      gitWorkspaceCache.set(key, { at: Date.now(), value })
      while (gitWorkspaceCache.size > GIT_WORKSPACE_CACHE_LIMIT) {
        gitWorkspaceCache.delete(gitWorkspaceCache.keys().next().value)
      }
    },
  }

  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null } }
  const ensureHeartbeat = () => {
    if (heartbeat || !clients.size) return
    heartbeat = setInterval(() => {
      const at = Date.now()
      for (const res of [...clients]) {
        if (!sseSend(res, 'ping', { at })) clients.delete(res)
      }
      if (!clients.size) stopHeartbeat()
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }
  function sseSend(res, event, data) {
    if (res.writableEnded || res.destroyed) return false
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true } catch { return false }
  }
  function broadcast({ revision, at }) {
    for (const res of [...clients]) if (!sseSend(res, 'change', { revision, at })) clients.delete(res)
  }
  const unsubscribe = store.subscribe(broadcast)

  async function handleEvents(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, 'GET')
    const snapshot = await store.snapshot()
    res.writeHead(200, SSE_HEADERS)
    res.flushHeaders?.()
    if (req.method === 'HEAD') { res.end(); return }
    clients.add(res)
    ensureHeartbeat()
    sseSend(res, 'change', { revision: snapshot.revision, at: snapshot.at })
    const cleanup = () => {
      clients.delete(res)
      if (!clients.size) stopHeartbeat()
    }
    req.once('close', cleanup)
    res.once('close', cleanup)
    res.once('error', cleanup)
  }

  // ---------------- 读接口 ----------------

  async function getHealth(req, res) {
    const snapshot = await store.snapshot()
    sendJson(req, res, 200, {
      ok: true, version,
      schemaVersion: snapshot.data.schemaVersion ?? SCHEMA_VERSION,
      dataDir: store.dataDir,
      revision: snapshot.revision,
    })
  }

  /**
   * GET /api/kanban/cloud/status —— 云同步守护器只读状态（C3）。
   * 令牌只以 describeCloudConfig 的掩码形式出现；未配置/已关闭时返回 enabled:false，
   * 让前端/运维无需猜测「云同步是否开启、上次同步/回放结果、是否在退避」。
   */
  function getCloudStatus(req, res) {
    let cloud
    try {
      cloud = typeof cloudSync?.status === 'function'
        ? cloudSync.status()
        : {
            ok: true, enabled: false, configured: false, running: false,
            phase: 'idle', configStatus: 'not-configured',
            sync: null, ingress: null,
          }
    } catch (error) {
      try { logger?.warn?.(`[dsh-kanban] 读取云同步状态失败：${error?.message || error}`) } catch {}
      cloud = {
        ok: false, enabled: false, configured: false, running: false,
        phase: 'error', configStatus: 'error',
        sync: null, ingress: null,
      }
    }
    sendJson(req, res, 200, {
      ok: true,
      cloud,
      revision: store.revision,
    })
  }

  /**
   * POST /api/kanban/cloud/reload —— 热重载 `cloud-config.json` 并立即触发一次同步/入站拉取。
   * 供首次执行 `npm run cloud:setup` 或轮换令牌后唤醒本地已运行的 DSH 插件。
   */
  async function reloadCloudRoute(req, res) {
    if (typeof cloudSync?.reload !== 'function') {
      return getCloudStatus(req, res)
    }
    const cloud = await cloudSync.reload()
    sendJson(req, res, 200, {
      ok: true,
      cloud,
      revision: store.revision,
    })
  }

  function boardSummary(board, cards) {
    return {
      id: board.id,
      name: board.name,
      ...(board.description ? { description: board.description } : {}),
      cardOrder: board.cardOrder,
      counts: countsFor(cards, board.id),
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    }
  }

  async function getState(req, res, url) {
    const data = await store.read()
    const boardId = url.searchParams.get('boardId') || undefined
    if (boardId !== undefined) assertPathId(boardId, 'board', '看板')
    const board = boardId === undefined ? data.boards[0] : data.boards.find(item => item.id === boardId)
    if (!board) throw new DomainError('BOARD_NOT_FOUND', '看板不存在', 404)
    const cards = orderedCards(board, data.cards)
    sendJson(req, res, 200, {
      ok: true,
      boards: data.boards.map(item => boardSummary(item, data.cards)),
      board: boardSummary(board, data.cards),
      cards,
      autoAdvanceEnabled: getAutoAdvanceEnabled(data),
      revision: data.meta.revision,
      serverTime: Date.now(),
    })
  }

  async function getBoards(req, res) {
    const data = await store.read()
    sendJson(req, res, 200, {
      ok: true,
      boards: data.boards.map(board => boardSummary(board, data.cards)),
      revision: data.meta.revision,
    })
  }

  /**
   * 归档箱列表（v0.22.0）：只读，按 archivedAt 倒序（缺失时用 updatedAt），
   * 可选 boardId 过滤与 limit（默认 100、上限 200）。卡片保留 archived/archivedAt 字段。
   */
  async function getArchive(req, res, url) {
    const data = await store.read()
    const boardId = cleanText(url.searchParams.get('boardId'), 120) || undefined
    if (boardId !== undefined) assertPathId(boardId, 'board', '看板')
    const rawLimit = Number(url.searchParams.get('limit') ?? 100)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 100
    const cards = data.cards
      .filter(card => card.archived === true && (boardId === undefined || card.boardId === boardId))
      .sort((left, right) => (right.archivedAt ?? right.updatedAt) - (left.archivedAt ?? left.updatedAt) || right.updatedAt - left.updatedAt)
    sendJson(req, res, 200, {
      ok: true,
      cards: cards.slice(0, limit),
      total: cards.length,
      revision: data.meta.revision,
    })
  }

  async function getActivities(req, res, cardId, url) {
    const rawLimit = Number(url.searchParams.get('limit') ?? 30)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 30
    const before = cleanText(url.searchParams.get('before'), 40) || undefined
    const data = await store.read()
    requireCard(data, cardId)
    const all = data.activities
      .filter(activity => activity.cardId === cardId)
      .sort((a, b) => b.at - a.at)
    let start = 0
    if (before) {
      const index = all.findIndex(activity => activity.id === before)
      if (index < 0) throw new DomainError('BAD_REQUEST', 'before 游标不存在或已过期')
      start = index + 1
    }
    const activities = all.slice(start, start + limit)
    const hasMore = start + activities.length < all.length
    const nextBefore = hasMore && activities.length ? activities[activities.length - 1].id : null
    sendJson(req, res, 200, { ok: true, activities, hasMore, nextBefore, revision: data.meta.revision })
  }

  /**
   * 卡片 Git 上下文（契约 docs/contracts/06-git-context.md）：
   * 只读派生信息，不写 data.json；卡片无 cwd / 目录不可用 / 非 git 仓库等业务失败
   * 一律 200 + git.available:false，只有卡片不存在才 404。
   */
  async function getCardGit(req, res, cardId, url) {
    const data = await store.read()
    const card = requireCard(data, cardId)
    const requestedDir = cleanText(url.searchParams.get('cwd') ?? '', 2000) || null
    const git = await collectGitContext({ cwd: card.cwd, requestedDir })
    sendJson(req, res, 200, { ok: true, git, revision: data.meta.revision })
  }

  // ---------------- 批量 Git（v0.15 §11 摘要 / v0.16 §12 工作区地图） ----------------

  /** 读取并校验批量 dirs body（§11 / §12 同规则：1–32 个非空字符串）。 */
  async function readDirsBody(req) {
    const body = await readJsonBody(req)
    const dirs = body.dirs
    if (!Array.isArray(dirs) || dirs.length < 1 || dirs.length > GIT_BATCH_DIRS_MAX) {
      throw new DomainError('BAD_REQUEST', `dirs 需要是 1–${GIT_BATCH_DIRS_MAX} 个目录的数组`)
    }
    if (dirs.some(item => typeof item !== 'string' || item.trim() === '')) {
      throw new DomainError('BAD_REQUEST', 'dirs 的每一项都必须是非空字符串')
    }
    return dirs
  }

  /** 允许集合 = 未归档卡片的 cwd（trim 后原样相等）。 */
  function allowedCardDirs(data) {
    const allowed = new Set()
    for (const card of data.cards) {
      if (card.archived) continue
      if (typeof card.cwd === 'string' && card.cwd.trim()) allowed.add(card.cwd.trim())
    }
    return allowed
  }

  /**
   * 未归档卡片里 cwd 落在指定工作副本内的卡片（realpath 后按路径前缀判定；
   * realpath 失败时按 cwd 原文判定——清理后目录已不存在，仍能命中）。
   * 按 id 排序，保证留痕顺序与响应可重复。
   */
  async function collectCardsInsideWorktree(data, worktreePath) {
    const rows = []
    await Promise.all(data.cards
      .filter(card => !card.archived && typeof card.cwd === 'string' && card.cwd.trim())
      .map(async card => {
        const cwd = card.cwd.trim()
        const realCwd = await fileRealpath(cwd).catch(() => null)
        if (isPathInside(realCwd ?? cwd, worktreePath)) rows.push({ id: card.id, title: card.title })
      }))
    return rows.sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * ③（v0.25.0）清理成功后给相关卡片/时间线留痕（契约 02-http-api §13）：
   * 未归档且 cwd 落在被清理工作副本内的每张卡片写一条 progress 节点（已归档卡不写），
   * 让「目录已移入回收站、需要重新绑定工作目录」在时间线上可追溯。
   * 只写时间线、不改卡片 cwd；返回实际写入的卡片与新 revision。
   */
  async function recordWorktreeCleanupActivities({ actor, cleanup, cards }) {
    if (!cards.length) return { cards: [], revision: null }
    const ids = new Set(cards.map(card => card.id))
    const now = Date.now()
    const written = await store.update(draft => {
      const touched = []
      for (const card of draft.cards) {
        if (card.archived === true || !ids.has(card.id)) continue
        pushActivity(draft, card, {
          type: 'progress',
          actor,
          at: now,
          text: `工作副本已清理：${cleanup.worktreePath} 已移入回收站（保留 ${cleanup.trashRetentionDays} 天），可重新绑定工作目录`,
          data: {
            kind: 'worktree_cleaned',
            repoRoot: cleanup.repoRoot,
            worktreePath: cleanup.worktreePath,
            trashedTo: cleanup.trashedTo,
            trashRetentionDays: cleanup.trashRetentionDays,
            branchName: cleanup.branchName,
            branchDeleted: cleanup.branchDeleted,
          },
        })
        touchCard(card, now)
        touched.push({ id: card.id, title: card.title })
      }
      touchMeta(draft, actor, now)
      return { cards: touched }
    })
    return { cards: written.result.cards, revision: written.revision }
  }

  /** 缓存 key 用 realpath；目录不存在时返回 null（交给 collectGitSummary 回 missing，不进缓存）。 */
  async function summaryCacheKey(dir) {
    try { return await fileRealpath(dir) } catch { return null }
  }

  /** 单目录摘要 + 缓存（realpath 为 key，TTL 10s、最多 128 条，写入后按插入顺序淘汰最旧）。 */
  async function summaryForDir(dir) {
    const key = await summaryCacheKey(dir)
    if (key) {
      const hit = gitSummaryCache.get(key)
      if (hit && Date.now() - hit.at < gitSummaryCacheTtlMs) return hit.value
    }
    const value = await collectGitSummary(dir)
    if (key) {
      gitSummaryCache.delete(key)
      gitSummaryCache.set(key, { at: Date.now(), value })
      while (gitSummaryCache.size > GIT_SUMMARY_CACHE_LIMIT) {
        gitSummaryCache.delete(gitSummaryCache.keys().next().value)
      }
    }
    return value
  }

  /**
   * 卡片「工作线」徽标用的轻量批量接口（§11）：只允许未归档卡片的 cwd（trim 后原样相等），
   * 不在允许集合里的目录逐项回 reason:"forbidden"（批量容错，不 400）；
   * 按 dir 去重后并发采集，响应 key 用请求里的 dir 原文，客户端可直接映射回卡片。
   */
  async function gitSummariesRoute(req, res) {
    const dirs = await readDirsBody(req)
    const data = await store.read()
    const allowed = allowedCardDirs(data)
    const uniqueDirs = [...new Set(dirs.map(dir => dir.trim()))]
    const values = new Map()
    const forbidden = { available: false, reason: 'forbidden' }
    await Promise.all(uniqueDirs.map(async dir => {
      values.set(dir, allowed.has(dir) ? await summaryForDir(dir) : forbidden)
    }))
    const summaries = Object.fromEntries(dirs.map(dir => [dir, values.get(dir.trim())]))
    sendJson(req, res, 200, { ok: true, revision: data.meta.revision, summaries })
  }

  /**
   * 「工作区」视图用的批量接口（§12）：卡片 cwd → 按仓库聚合的工作副本地图。
   * 允许集合与 §11 相同；不在允许集合的目录进 unavailable（reason:"forbidden"），
   * 其余失败项由 collectGitWorkspaces 返回；服务端按仓库缓存 8s / 最多 64 条。
   */
  async function gitWorkspacesRoute(req, res) {
    const dirs = await readDirsBody(req)
    const data = await store.read()
    const allowed = allowedCardDirs(data)
    const uniqueDirs = [...new Set(dirs.map(dir => dir.trim()))]
    const allowedDirs = uniqueDirs.filter(dir => allowed.has(dir))
    const collected = await collectGitWorkspaces(allowedDirs, { cache: workspaceCache })
    const reasons = new Map()
    for (const item of collected.unavailable) reasons.set(item.dir, item.reason)
    for (const dir of uniqueDirs) if (!allowed.has(dir)) reasons.set(dir, 'forbidden')
    // unavailable 按请求顺序输出，前端可直接按 dir 映射
    const unavailable = uniqueDirs.filter(dir => reasons.has(dir)).map(dir => ({ dir, reason: reasons.get(dir) }))
    sendJson(req, res, 200, { ok: true, revision: data.meta.revision, repos: collected.repos, unavailable })
  }

  /**
   * 清理失效工作副本记录（v0.20 §15）：`git worktree prune`，只清「目录已被手动删除」的元数据，
   * 不动任何现存工作副本目录/分支。repoRoot 必须来自看板未归档卡片 cwd 推导出的仓库根。
   */
  async function gitWorktreePruneRoute(req, res) {
    const body = await readJsonBody(req)
    const repoRoot = typeof body.repoRoot === 'string' ? body.repoRoot.trim() : ''
    if (!repoRoot) throw new DomainError('BAD_REQUEST', 'repoRoot 必须是非空字符串')

    const data = await store.read()
    const allowed = allowedCardDirs(data)
    // 重新采集（不带 8s 缓存）：确认 repoRoot 属于看板卡片 cwd 推导出的仓库
    const collected = await collectGitWorkspaces([...allowed])
    const realRepoRoot = await fileRealpath(repoRoot).catch(() => null)
    const repo = collected.repos.find(item => item.root === (realRepoRoot ?? repoRoot))
    if (!repo) throw new DomainError('NOT_FOUND', '仓库不在由看板卡片 cwd 推导出的仓库列表里', 404)

    let result
    try {
      result = await pruneWorktreeRecords(repo.root)
    } catch (error) {
      if (error?.code === 'PRUNE_FAILED') throw new DomainError('PRUNE_FAILED', error.message, 500)
      throw error
    }
    // 失效记录清掉后，工作区地图缓存立即失效（避免前端仍看到 prunable 行）
    gitWorkspaceCache.delete(repo.commonDir)
    try {
      console.info(`[dsh-kanban] 清理失效工作副本记录：repo=${repo.root} removed=${result.removed}`)
    } catch {}
    sendJson(req, res, 200, {
      ok: true,
      revision: data.meta.revision,
      pruned: { repoRoot: repo.root, removed: result.removed },
    })
  }

  /**
   * 清理工作副本（v0.17 §13 / 06 §4.8）：软删除到 ~/.dsh-kanban/trash + git worktree prune + 可选删分支。
   * 校验顺序：body → 目标必须由看板未归档卡片 cwd 推导 → 主工作副本 → 主分支 → 未完成卡片占用 →
   * 脏（confirmLoss!==true）→ 未合并（confirmLoss!==true）→ 分支被其它工作副本占用。
   * 占用判定只数「未完成的未归档卡片」：done/canceled 是终态（v0.21.0 #15），不再阻塞清理；
   * 但 allowedCardDirs 仍包含它们的 cwd，保证已完成卡片的工作区地图仍可探测。
   */
  async function gitWorktreeCleanupRoute(req, res) {
    const body = await readJsonBody(req)
    const repoRoot = typeof body.repoRoot === 'string' ? body.repoRoot.trim() : ''
    const worktreePath = typeof body.worktreePath === 'string' ? body.worktreePath.trim() : ''
    if (!repoRoot || !worktreePath) {
      throw new DomainError('BAD_REQUEST', 'repoRoot / worktreePath 必须是非空字符串')
    }
    if (body.deleteBranch !== undefined && typeof body.deleteBranch !== 'boolean') {
      throw new DomainError('BAD_REQUEST', 'deleteBranch 必须是布尔值')
    }
    if (body.confirmLoss !== undefined && typeof body.confirmLoss !== 'boolean') {
      throw new DomainError('BAD_REQUEST', 'confirmLoss 必须是布尔值')
    }
    const deleteBranch = body.deleteBranch === true
    const confirmLoss = body.confirmLoss === true

    const data = await store.read()
    const allowed = allowedCardDirs(data)
    // 重新采集（不带 8s 缓存）：确保 locked / untracked / merged 等判定基于最新状态
    const collected = await collectGitWorkspaces([...allowed])
    const [realRepoRoot, realWorktreePath] = await Promise.all([
      fileRealpath(repoRoot).catch(() => null),
      fileRealpath(worktreePath).catch(() => null),
    ])
    const repo = collected.repos.find(item => item.root === (realRepoRoot ?? repoRoot))
    const targetPath = realWorktreePath ?? worktreePath
    const worktree = repo?.worktrees.find(item => item.path === targetPath)
    if (!repo || !worktree) {
      throw new DomainError('NOT_FOUND', '目标工作副本不在由看板卡片 cwd 推导出的仓库列表里', 404)
    }

    if (worktree.isMain) {
      throw new DomainError('WORKTREE_MAIN', '主工作副本不能清理', 400, { worktreePath: worktree.path })
    }
    if (deleteBranch && worktree.branch && repo.mainBranch && worktree.branch === repo.mainBranch) {
      throw new DomainError('BRANCH_MAIN', '不能删除主分支', 400, { branch: worktree.branch })
    }

    // 未完成的未归档卡片 cwd 落在该工作副本内 → 拒绝（realpath 后最长前缀）。
    // done/canceled 是终态（v0.21.0 #15）：不受此限制，但仍留在 allowedCardDirs 里供探测。
    const usage = await Promise.all(data.cards
      .filter(card => !card.archived && !isTerminalCardStatus(card.status)
        && typeof card.cwd === 'string' && card.cwd.trim())
      .map(async card => {
        const cwd = card.cwd.trim()
        const realCwd = await fileRealpath(cwd).catch(() => null)
        return isPathInside(realCwd ?? cwd, worktree.path) ? { id: card.id, title: card.title, cwd } : null
      }))
    const cards = usage.filter(Boolean)
    if (cards.length) {
      throw new DomainError('WORKTREE_IN_USE', `该工作副本仍被 ${cards.length} 张未完成卡片使用`, 409, {
        count: cards.length,
        cards: cards.slice(0, 5),
      })
    }

    const modifiedCount = worktree.modifiedCount ?? 0
    const untrackedCount = worktree.untrackedCount ?? 0
    if ((modifiedCount > 0 || untrackedCount > 0) && !confirmLoss) {
      throw new DomainError('WORKTREE_DIRTY', '工作副本有未保存改动或未跟踪文件，需要确认损失后才能清理', 409, {
        modifiedCount,
        untrackedCount,
      })
    }
    // mainBranch 探测不到时 mergedIntoBase 为 null，保守地按「未合并」处理
    if (worktree.mergedIntoBase !== true && !confirmLoss) {
      throw new DomainError('WORKTREE_UNMERGED', '工作副本还有未并入主线的提交，需要确认损失后才能清理', 409, {
        ahead: worktree.aheadOfBase,
      })
    }
    if (deleteBranch && worktree.branch) {
      const occupied = repo.worktrees.some(row => row.path !== worktree.path && row.branch === worktree.branch)
      if (occupied) throw new DomainError('BRANCH_IN_USE', '分支正被其它工作副本占用', 409, { branch: worktree.branch })
    }

    // ③（v0.25.0）：先记下 cwd 落在这个工作副本里的未归档卡片（含已完成卡片），
    // 清理成功后给它们的时间线留痕；目录移走后 realpath 会失效，必须在清理前采集。
    const affectedCards = await collectCardsInsideWorktree(data, worktree.path)

    let result
    try {
      result = await cleanupWorktree({
        repoRoot: repo.root,
        worktreePath: worktree.path,
        trashDir: gitTrashRoot,
        branchName: worktree.branch,
        sha: worktree.sha,
        mergedIntoBase: worktree.mergedIntoBase,
        deleteBranch,
        locked: worktree.locked === true,
      })
    } catch (error) {
      if (error?.code === 'NOT_FOUND') throw new DomainError('NOT_FOUND', error.message, 404)
      if (error?.code === 'TRASH_MOVE_FAILED' || error?.code === 'WORKTREE_MANIFEST_FAILED'
        || error?.code === 'WORKTREE_PRUNE_FAILED' || error?.code === 'BRANCH_DELETE_FAILED') {
        throw new DomainError(error.code, error.message, 500)
      }
      throw error
    }
    // 清理成功后让该仓库的工作区地图缓存立即失效，避免前端刷新后仍看到已移走的工作副本
    gitWorkspaceCache.delete(repo.commonDir)
    const cleanup = {
      repoRoot: repo.root,
      worktreePath: worktree.path,
      trashedTo: result.trashedTo,
      branchName: result.branchName,
      branchDeleted: result.branchDeleted,
      trashRetentionDays: result.trashRetentionDays ?? TRASH_RETENTION_DAYS,
    }
    // ③ 清理成功后给相关卡片写时间线留痕；留痕失败不回滚清理结果（只在日志里告警）
    let logged = { cards: [], revision: null }
    try {
      logged = await recordWorktreeCleanupActivities({ actor: normalizeActor(body.actor), cleanup, cards: affectedCards })
    } catch (error) {
      try { logger?.warn?.(`[dsh-kanban] 清理工作副本后写卡片时间线失败：${error?.message || error}`) } catch {}
    }
    // 审计（契约 §13：后续可接决策日志）
    try {
      console.info(`[dsh-kanban] 清理工作副本：repo=${repo.root} worktree=${worktree.path} → trash=${result.trashedTo} branch=${result.branchName ?? '-'} deleted=${result.branchDeleted} cards=${logged.cards.length}`)
    } catch {}
    sendJson(req, res, 200, {
      ok: true,
      revision: logged.revision ?? data.meta.revision,
      cleanup: { ...cleanup, affectedCards: logged.cards },
    })
  }

  // ---------------- 回收站（v0.18，契约 02-http-api §14） ----------------

  /** 校验回收站条目 id：非空字符串，不允许路径分隔符 / ..（防目录穿越）。 */
  function requireTrashId(value) {
    if (typeof value !== 'string') throw new DomainError('BAD_REQUEST', 'id 必须是非空字符串')
    const id = value.trim()
    if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\u0000')) {
      throw new DomainError('BAD_REQUEST', 'id 不能包含路径分隔符或 ..')
    }
    return id
  }

  /** 回收站列表：trash 根下带 manifest 的条目（按 trashedAt 倒序；旧条目 restorable:false）。 */
  async function getTrash(req, res) {
    const data = await store.read()
    const entries = await listTrashEntries(gitTrashRoot)
    sendJson(req, res, 200, { ok: true, revision: data.meta.revision, entries })
  }

  /** 恢复回收站条目：manifest 为唯一路径依据，git worktree add 后覆盖回工作区文件并删除条目。 */
  async function restoreTrashRoute(req, res) {
    const body = await readJsonBody(req)
    const id = requireTrashId(body.id)
    const data = await store.read()
    let restored
    try {
      restored = await restoreTrashEntry({ trashDir: gitTrashRoot, id })
      // 恢复出的工作副本要立刻出现在工作区地图里，避免 8s 缓存窗口
      gitWorkspaceCache.clear()
    } catch (error) {
      if (error?.code === 'BAD_REQUEST') throw new DomainError('BAD_REQUEST', error.message, 400)
      if (error?.code === 'NOT_FOUND') throw new DomainError('NOT_FOUND', error.message, 404)
      if (error?.code === 'RESTORE_PATH_EXISTS') throw new DomainError('RESTORE_PATH_EXISTS', error.message, 409)
      if (error?.code === 'RESTORE_SHA_MISSING') throw new DomainError('RESTORE_SHA_MISSING', error.message, 409)
      if (error?.code === 'RESTORE_FAILED') throw new DomainError('RESTORE_FAILED', error.message, 500)
      throw error
    }
    try {
      console.info(`[dsh-kanban] 恢复工作副本：trash=${id} → ${restored.worktreePath} branch=${restored.branch ?? '-'} branchRestored=${restored.branchRestored}`)
    } catch {}
    sendJson(req, res, 200, { ok: true, revision: data.meta.revision, restored })
  }

  /** 彻底删除回收站条目（不经过 7 天保留）；只允许 trash 根下带 manifest 的直接子目录。 */
  async function purgeTrashRoute(req, res, rawId) {
    const id = requireTrashId(rawId)
    const data = await store.read()
    let purged
    try {
      purged = await purgeTrashEntry({ trashDir: gitTrashRoot, id })
    } catch (error) {
      if (error?.code === 'BAD_REQUEST') throw new DomainError('BAD_REQUEST', error.message, 400)
      if (error?.code === 'NOT_FOUND') throw new DomainError('NOT_FOUND', error.message, 404)
      if (error?.code === 'TRASH_DELETE_FAILED') throw new DomainError('TRASH_DELETE_FAILED', error.message, 500)
      throw error
    }
    try { console.info(`[dsh-kanban] 彻底删除回收站条目：trash=${id}`) } catch {}
    sendJson(req, res, 200, { ok: true, revision: data.meta.revision, purged })
  }

  // ---------------- 决策日志（只读） ----------------

  const decisionLog = store.decisionLog || null

  function requireDecisionLog() {
    if (!decisionLog) throw new DomainError('NOT_FOUND', '决策日志未启用', 404)
    return decisionLog
  }

  async function getDecisions(req, res, url) {
    const log = requireDecisionLog()
    const result = await log.list({
      limit: url.searchParams.get('limit') ?? undefined,
      before: url.searchParams.get('before') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      source: url.searchParams.get('source') ?? undefined,
      cardId: url.searchParams.get('cardId') ?? undefined,
      boardId: url.searchParams.get('boardId') ?? undefined,
      approvalId: url.searchParams.get('approvalId') ?? undefined,
      since: url.searchParams.get('since') ?? undefined,
      until: url.searchParams.get('until') ?? undefined,
    })
    sendJson(req, res, 200, { ok: true, ...result, revision: store.revision })
  }

  async function getDecisionsMeta(req, res) {
    const log = requireDecisionLog()
    sendJson(req, res, 200, { ok: true, ...(await log.stats()), revision: store.revision })
  }

  async function getDecisionsExport(req, res) {
    const log = requireDecisionLog()
    const body = await log.exportBytes()
    if (res.headersSent || res.destroyed) return
    const filename = `decisions-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`
    res.writeHead(200, {
      ...NDJSON_HEADERS,
      'content-length': body.length,
      'content-disposition': `attachment; filename="${filename}"`,
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  // ---------------- 看板写接口 ----------------

  async function createBoardRoute(req, res) {
    const body = await readJsonBody(req)
    const name = cleanText(body.name, LIMITS.boardName)
    if (!name) throw new DomainError('BAD_REQUEST', '看板名称不能为空')
    const now = Date.now()
    const { result, revision } = await store.update(draft => {
      const board = newBoard({ name, description: body.description, now })
      draft.boards.push(board)
      touchMeta(draft, body.actor, now)
      return board
    })
    sendJson(req, res, 200, { ok: true, board: boardSummary(result, []), revision })
  }

  async function patchBoardRoute(req, res, boardId) {
    const body = await readJsonBody(req)
    const now = Date.now()
    const { result, revision } = await store.update(draft => {
      const board = requireBoard(draft, boardId)
      if (body.name !== undefined) {
        const name = cleanText(body.name, LIMITS.boardName)
        if (!name) throw new DomainError('BAD_REQUEST', '看板名称不能为空')
        board.name = name
      }
      if (body.description !== undefined) {
        const description = cleanText(body.description, LIMITS.boardDescription)
        if (description) board.description = description
        else delete board.description
      }
      board.updatedAt = now
      touchMeta(draft, body.actor, now)
      return boardSummary(board, draft.cards)
    })
    sendJson(req, res, 200, { ok: true, board: result, revision })
  }

  async function deleteBoardRoute(req, res, boardId) {
    const body = await readOptionalBody(req)
    void body
    const { revision } = await store.update(draft => {
      const board = requireBoard(draft, boardId)
      if (board.id === DEFAULT_BOARD_ID) throw new DomainError('CONFLICT', '默认看板不能删除', 409)
      const remaining = draft.cards.filter(card => card.boardId === board.id)
      if (remaining.length) throw new DomainError('CONFLICT', '看板中还有卡片，无法删除', 409)
      draft.boards = draft.boards.filter(item => item.id !== board.id)
      touchMeta(draft, undefined, Date.now())
      return null
    })
    sendJson(req, res, 200, { ok: true, revision })
  }

  // ---------------- 卡片写接口 ----------------

  async function createCardRoute(req, res) {
    const body = await readJsonBody(req)
    const shouldBind = Boolean(sessionBinding && body && typeof body === 'object' && body.sessionMode)
    const prepared = shouldBind
      ? await sessionBinding.prepareCreate({
        args: body,
        fallbackWorkspace: true,
        precheck: async () => { createCard(await store.read(), body) },
      })
      : { input: body, binding: null, warnings: [] }
    const { result, revision } = await store.update(draft => {
      const now = Date.now()
      const created = createCard(draft, prepared.input, { actor: body.actor, now })
      const linked = bindingActivity(prepared.binding)
      if (linked) {
        pushActivity(draft, created.card, {
          type: 'session_linked',
          actor: body.actor || { kind: 'user', name: '你' },
          text: linked.text,
          data: linked.data,
          at: now,
        })
      }
      return { card: created.card }
    })
    const payload = { ok: true, card: result.card, revision }
    if (prepared.binding) payload.binding = prepared.binding
    if (prepared.warnings?.length) payload.warnings = prepared.warnings
    sendJson(req, res, 200, payload)
  }

  async function patchCardRoute(req, res, cardId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => {
      const card = requireCard(draft, cardId)
      requireVersion(card, body, req.url ? new URL(req.url, 'http://localhost') : undefined)
      // forceComplete 只对「完成」生效：有未收口子卡时强完成并写审计节点（domain 负责）。
      return patchCard(draft, cardId, body.changes, {
        actor: body.actor, now: Date.now(), forceComplete: body.forceComplete === true,
      })
    })
    sendJson(req, res, 200, { ok: true, card: result.card, revision })
  }

  /** 恢复归档卡片（v0.22.0）：body 可选 actor；未归档 409、不存在 404。 */
  async function unarchiveCardRoute(req, res, cardId) {
    const body = await readOptionalBody(req)
    const { result, revision } = await store.update(draft => unarchiveCard(draft, cardId, { actor: body.actor, now: Date.now() }))
    sendJson(req, res, 200, { ok: true, card: result.card, revision })
  }

  async function deleteCardRoute(req, res, cardId, url) {
    const body = await readOptionalBody(req)
    const { result, revision } = await store.update(draft => {
      const card = requireCard(draft, cardId)
      requireVersion(card, body, url)
      return archiveCard(draft, cardId, { actor: body.actor, now: Date.now() })
    })
    sendJson(req, res, 200, { ok: true, card: result.card, revision })
  }

  async function moveCardRoute(req, res, cardId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => {
      const card = requireCard(draft, cardId)
      checkVersionIfPresent(card, body)
      return moveCard(draft, cardId, {
        column: body.column, beforeId: body.beforeId, afterId: body.afterId,
        text: body.reason, actor: body.actor, now: Date.now(), forceComplete: body.forceComplete === true,
      })
    })
    sendJson(req, res, 200, { ok: true, card: result.card, revision })
  }

  async function batchCardsRoute(req, res) {
    const body = await readJsonBody(req)
    const action = body.action
    if (action !== 'archive' && action !== 'move') throw new DomainError('BAD_REQUEST', "action 需要是 'archive' 或 'move'")
    if (action === 'move' && body.column === undefined) throw new DomainError('BAD_REQUEST', '批量移动需要提供 column')
    const now = Date.now()
    const { result, revision } = await store.update(draft => (action === 'archive'
      ? batchArchive(draft, body.cardIds, { actor: body.actor, now, reason: body.reason })
      : batchMove(draft, body.cardIds, body.column, { actor: body.actor, now })))
    sendJson(req, res, 200, { ok: true, cards: result.cards, skipped: result.skipped, revision })
  }

  async function commentRoute(req, res, cardId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => addComment(draft, cardId, { text: body.text, actor: body.actor, now: Date.now() }))
    sendJson(req, res, 200, { ok: true, activity: result.activity, card: result.card, revision })
  }

  async function createApprovalRoute(req, res, cardId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => requestApproval(draft, cardId, {
      title: body.title, detail: body.detail, options: body.options, multiSelect: body.multiSelect,
      questions: body.questions, sessionId: body.sessionId, actor: body.actor, now: Date.now(),
    }))
    sendJson(req, res, 200, { ok: true, approval: result.approval, card: result.card, revision })
  }

  async function resolveApprovalRoute(req, res, cardId, approvalId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => resolveApproval(draft, cardId, approvalId, {
      answers: body.answers, optionIds: body.optionIds, optionId: body.optionId, comment: body.comment,
      actor: body.actor, now: Date.now(),
    }))
    sendJson(req, res, 200, { ok: true, approval: result.approval, card: result.card, revision })
  }

  async function linkSessionRoute(req, res, cardId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => linkSession(draft, cardId, {
      sessionId: body.sessionId, title: body.title, actor: body.actor, now: Date.now(),
    }))
    // 重复绑定已是主会话时 activity 为 null（幂等，不写时间线）
    sendJson(req, res, 200, {
      ok: true,
      card: result.card,
      revision,
      activity: result.activity,
      linked: result.linked,
      primaryChanged: result.primaryChanged,
      primarySessionId: result.card.sessionIds[0] ?? null,
    })
  }

  async function unlinkSessionRoute(req, res, cardId, sessionId) {
    const body = await readOptionalBody(req)
    const { result, revision } = await store.update(draft => unlinkSession(draft, cardId, {
      sessionId, actor: body.actor, now: Date.now(),
    }))
    sendJson(req, res, 200, { ok: true, card: result.card, revision })
  }

  async function ackRoute(req, res, cardId) {
    const body = await readOptionalBody(req)
    const { result, revision } = await store.update(draft => ackCard(draft, cardId, { actor: body.actor, now: Date.now() }))
    sendJson(req, res, 200, { ok: true, revision, card: result.card })
  }

  async function seedRoute(req, res) {
    const body = await readJsonBody(req)
    const mode = body.mode
    if (!['demo', 'empty', 'reset'].includes(mode)) throw new DomainError('BAD_REQUEST', 'mode 需要是 demo / empty / reset')
    const now = Date.now()
    const { result, revision } = await store.update(draft => {
      applySeedMode(draft, mode, now)
      const board = draft.boards.find(item => item.id === DEFAULT_BOARD_ID) || draft.boards[0]
      return { board: boardSummary(board, draft.cards) }
    })
    sendJson(req, res, 200, { ok: true, revision, board: result.board })
  }

  // ---------------- 会话归档（宿主 workspaceRegistry，可逆） ----------------

  function getSessionArchiveState(req, res) {
    sendJson(req, res, 200, {
      ok: true,
      available: archive.available(),
      archivedSessionIds: archive.archivedSessionIds(),
    })
  }

  async function archiveSessionRoute(req, res, cardId, sessionId) {
    const body = await readOptionalBody(req)
    const snapshot = await store.read()
    sessionArchivePlan(snapshot, { cardId, sessionId })
    const archivedSessionIds = await archive.archive(sessionId, { stopActivity: body.stopActivity === true })
    const now = Date.now()
    const { result, revision } = await store.update(draft => {
      const updated = appendSessionArchiveActivity(draft, cardId, { sessionId, actor: body.actor, now })
      return { card: updated.card, activity: updated.activity }
    })
    sendJson(req, res, 200, {
      ok: true, card: result.card, activity: result.activity, revision, archivedSessionIds,
    })
  }

  async function unarchiveSessionRoute(req, res, cardId, sessionId) {
    const body = await readOptionalBody(req)
    const snapshot = await store.read()
    const card = requireCard(snapshot, cardId)
    requireSessionBound(card, sessionId)
    const archivedSessionIds = await archive.unarchive(sessionId)
    const now = Date.now()
    const { result, revision } = await store.update(draft => {
      const updated = appendSessionArchiveActivity(draft, cardId, { sessionId, unarchive: true, actor: body.actor, now })
      return { card: updated.card, activity: updated.activity }
    })
    sendJson(req, res, 200, {
      ok: true, card: result.card, activity: result.activity, revision, archivedSessionIds,
    })
  }

  /**
   * 批量归档（历史数据处理 / 已完成列批量）：
   * - dryRun 只返回计划（可归档/跳过及原因），不调用宿主；
   * - 执行阶段逐会话调用宿主，运行中/待确认/已删除分别回填 skipped 原因；
   * - 成功后给每个代表卡写一条 session_archived 活动（同一笔事务）。
   */
  async function archiveSessionsBatchRoute(req, res) {
    const body = await readOptionalBody(req)
    const scope = body.scope === undefined ? 'done' : body.scope
    if (scope !== 'done') throw new DomainError('BAD_REQUEST', "scope 只支持 'done'")
    if (body.cardIds !== undefined && !Array.isArray(body.cardIds)) throw new DomainError('BAD_REQUEST', 'cardIds 需要是数组')
    const cardIds = Array.isArray(body.cardIds) ? body.cardIds.map(String) : undefined
    const dryRun = body.dryRun === true
    const snapshot = await store.read()
    const plan = batchSessionArchivePlan(snapshot, {
      archivedSessionIds: archive.archivedSessionIds(),
      cardIds,
      completedBefore: Number.isFinite(Number(body.completedBefore)) ? Number(body.completedBefore) : undefined,
    })
    if (dryRun) {
      return sendJson(req, res, 200, {
        ok: true, dryRun: true, available: archive.available(),
        archivable: plan.archivable, skipped: plan.skipped,
        archivedSessionIds: archive.archivedSessionIds(), revision: snapshot.meta.revision,
      })
    }
    const archived = []
    const skipped = [...plan.skipped]
    for (const entry of plan.archivable) {
      try {
        await archive.archive(entry.sessionId)
        archived.push(entry)
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        skipped.push({
          ...entry,
          reason: error.code === 'SESSION_ACTIVE' ? 'running' : error.code === 'SESSION_NOT_FOUND' ? 'missing' : 'failed',
          ...(error.message ? { message: error.message } : {}),
          ...(error.extra?.activity ? { activity: error.extra.activity } : {}),
        })
      }
    }
    let revision = snapshot.meta.revision
    if (archived.length) {
      const now = Date.now()
      const written = await store.update(draft => {
        for (const entry of archived) {
          appendSessionArchiveActivity(draft, entry.cardId, { sessionId: entry.sessionId, actor: body.actor, now })
        }
        return { count: archived.length }
      })
      revision = written.revision
    }
    sendJson(req, res, 200, {
      ok: true, dryRun: false, available: archive.available(),
      archivable: archived, skipped,
      archivedSessionIds: archive.archivedSessionIds(), revision,
    })
  }

  // ---------------- Transactional Outbox（v0.27.0 后台会话派发队列） ----------------

  async function getOutboxRoute(req, res) {
    const data = await store.read()
    const now = Date.now()
    sendJson(req, res, 200, {
      ok: true,
      entries: data.outbox || [],
      pendingCount: pendingOutboxCount(data, now),
      revision: data.meta.revision,
    })
  }

  async function leaseOutboxRoute(req, res) {
    const body = await readOptionalBody(req)
    const now = Date.now()
    const clientFocusSeq = Number(body.lastFocusSeq || 0)
    const pendingFocus = (latestFocus && now - latestFocus.at < 30_000 && latestFocus.seq > clientFocusSeq)
      ? latestFocus
      : null
    const snapshot = await store.read()
    if (body.limit === 0 || !pendingOutboxCount(snapshot, now)) {
      return sendJson(req, res, 200, {
        ok: true,
        entries: [],
        expired: [],
        ...(pendingFocus ? { pendingFocus } : {}),
        revision: snapshot.meta.revision,
      })
    }
    const { result, revision } = await store.update(draft => leaseOutbox(draft, {
      owner: body.owner,
      harness: body.harness,
      limit: body.limit,
      leaseMs: body.leaseMs,
      now,
    }))
    sendJson(req, res, 200, {
      ok: true,
      entries: result.entries,
      expired: result.expired,
      ...(pendingFocus ? { pendingFocus } : {}),
      revision,
    })
  }

  async function ackOutboxRoute(req, res, rawSeq) {
    const seq = Number(rawSeq)
    if (!Number.isInteger(seq) || seq < 1) {
      throw new DomainError('BAD_REQUEST', 'outbox seq 必须是正整数', 400)
    }
    const body = await readOptionalBody(req)
    const now = Date.now()
    const { result, revision } = await store.update(draft => ackOutbox(draft, seq, {
      owner: body.owner,
      ok: body.ok !== false,
      sessionId: body.sessionId,
      error: body.error,
      now,
    }))
    sendJson(req, res, 200, {
      ok: true,
      entry: result.entry,
      expired: Boolean(result.expired),
      idempotent: Boolean(result.idempotent),
      card: result.card,
      revision,
    })
  }

  // ---------------- Super-Agent 入口会话、意图路由、IM/GitHub 网关、MCP ----------------

  const mcpRegistry = createMcpToolRegistry(store, { sessionBinding })
  const mcpStdioScriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kanban-mcp.mjs')

  function buildMcpStatusInfo(runtimeOrigin) {
    const base = (runtimeOrigin || 'http://127.0.0.1:4599').replace(/\/$/, '')
    return {
      httpEndpoint: `${base}${API_PREFIX}/mcp`,
      loopbackEndpoint: `http://127.0.0.1:4599${API_PREFIX}/mcp`,
      stdioScriptPath: mcpStdioScriptPath,
      dataDir: store.dataDir,
      toolCount: mcpRegistry.list().length,
    }
  }

  async function getSuperAgentRoute(req, res) {
    const data = await store.read()
    const rules = loadRouterRules(store.dataDir)
    sendJson(req, res, 200, {
      ok: true,
      sessionId: getSuperAgentSessionId(data),
      bootstrapPrompt: composeSuperAgentPrompt(rules),
      rulesCount: rules.length,
      revision: data.meta.revision,
    })
  }

  async function setSuperAgentRoute(req, res) {
    const body = await readOptionalBody(req)
    const now = Date.now()
    const actor = normalizeActor(body.actor, 'user')
    const { result, revision } = await store.update(draft => (
      setSuperAgentSessionId(draft, body.sessionId ?? null, { actor, now })
    ))
    // 若宿主持有 sessionArchive 能力，确保常驻 Super Agent 会话始终处于未归档待命态
    if (result.sessionId && sessionArchive && typeof sessionArchive.setArchived === 'function') {
      try { await sessionArchive.setArchived(result.sessionId, false) } catch {}
    }
    let decorated = false
    if (result.sessionId && typeof onSuperAgentSession === 'function') {
      try { decorated = Boolean(await onSuperAgentSession(result.sessionId)) } catch {}
    }
    const rules = loadRouterRules(store.dataDir)
    sendJson(req, res, 200, {
      ok: true,
      sessionId: result.sessionId,
      decorated,
      bootstrapPrompt: composeSuperAgentPrompt(rules),
      revision,
    })
  }

  async function getRouterRulesRoute(req, res) {
    const rules = loadRouterRules(store.dataDir)
    sendJson(req, res, 200, {
      ok: true,
      dataDir: store.dataDir,
      rules,
    })
  }

  async function putRouterRulesRoute(req, res) {
    const body = await readJsonBody(req)
    if (!Array.isArray(body.rules)) {
      throw new DomainError('BAD_REQUEST', 'rules 必须是规则数组')
    }
    const saved = saveRouterRules(store.dataDir, body.rules)
    const data = await store.read()
    const superSess = getSuperAgentSessionId(data)
    if (superSess && typeof onSuperAgentSession === 'function') {
      try { await onSuperAgentSession(superSess) } catch {}
    }
    sendJson(req, res, 200, {
      ok: true,
      dataDir: store.dataDir,
      rules: saved,
    })
  }

  async function routeSuperAgentIntentRoute(req, res) {
    const body = await readJsonBody(req)
    const snapshot = await store.read()
    const decision = classifySuperAgentIntent(snapshot, body, { dataDir: store.dataDir })
    sendJson(req, res, 200, {
      ok: true,
      decision,
      revision: snapshot.meta.revision,
    })
  }

  async function ingressRoute(req, res) {
    const body = await readJsonBody(req)
    const githubEvent = typeof req.headers?.['x-github-event'] === 'string'
      ? req.headers['x-github-event'].trim()
      : undefined
    if (typeof body.challenge === 'string' && body.challenge) {
      return sendJson(req, res, 200, { ok: true, challenge: body.challenge })
    }
    const now = Date.now()
    const { result, revision } = await store.update(draft => (
      handleIngressEvent(draft, body, { now, githubEvent, dataDir: store.dataDir })
    ))
    sendJson(req, res, 200, {
      ok: true,
      ...result,
      revision,
    })
  }

  function triggerHostFocus(cardId, { launchDesktop = false } = {}) {
    focusSeq += 1
    latestFocus = {
      seq: focusSeq,
      cardId: cardId || null,
      at: Date.now(),
    }
    for (const res of [...clients]) {
      if (!sseSend(res, 'focus', latestFocus)) clients.delete(res)
    }
    if (launchDesktop && shouldActivateHost) {
      try {
        execFile('open', ['-a', 'DeepSeek Harness'], () => {})
      } catch {}
    }
    return latestFocus
  }

  function renderImBridgePage({ title, badge, tone = 'info', heading, detail, webHref, deepLinkHref, autoSubmitJson }) {
    const badgeColor = tone === 'success'
      ? '#16a34a'
      : tone === 'error'
        ? '#dc2626'
        : tone === 'warn'
          ? '#d97706'
          : '#2563eb'
    const autoScript = autoSubmitJson
      ? `<script>
(function(){
  var payload = ${JSON.stringify(autoSubmitJson).replace(/</g, '\\u003c')};
  var statusEl = document.getElementById('im-act-status');
  var formEl = document.getElementById('im-act-form');
  if (!window.fetch || !statusEl) return;
  statusEl.textContent = '正在提交你的审批决策并唤醒会话…';
  fetch('${API_PREFIX}/im/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(r){ return r.json().then(function(d){ return { status: r.status, data: d }; }); })
    .then(function(res){
      if (res.data && res.data.ok) {
        if (formEl) formEl.style.display = 'none';
        var labels = (res.data.approval && res.data.approval.resolution && res.data.approval.resolution.labels) || [];
        var chosen = labels.join('、') || payload.optionId;
        statusEl.style.color = '#16a34a';
        statusEl.textContent = res.data.alreadyResolved
          ? ('ℹ️ 该确认项此前已处理（' + chosen + '），无需重复提交。')
          : ('✅ 已提交决策「' + chosen + '」，卡片已更新为「' + ((res.data.card && res.data.card.status) || 'running') + '」并唤醒 Agent 继续推进！');
      } else {
        statusEl.style.color = '#dc2626';
        statusEl.textContent = '提交未完成：' + ((res.data && res.data.error && res.data.error.message) || ('HTTP ' + res.status));
      }
    }).catch(function(err){
      statusEl.style.color = '#d97706';
      statusEl.textContent = '自动提交受阻，请点击下方按钮确认提交（' + (err && err.message ? err.message : 'network') + '）';
    });
})();
</script>`
      : ''
    const formBlock = autoSubmitJson
      ? `<form id="im-act-form" method="POST" action="${API_PREFIX}/im/act" style="margin-top:16px;">
  <input type="hidden" name="cardId" value="${escapeHtml(autoSubmitJson.cardId)}" />
  <input type="hidden" name="approvalId" value="${escapeHtml(autoSubmitJson.approvalId)}" />
  <input type="hidden" name="optionId" value="${escapeHtml(autoSubmitJson.optionId)}" />
  <input type="hidden" name="exp" value="${escapeHtml(autoSubmitJson.exp)}" />
  <input type="hidden" name="sig" value="${escapeHtml(autoSubmitJson.sig)}" />
  <button type="submit" class="btn btn-primary">确认提交：「${escapeHtml(autoSubmitJson.optionLabel || autoSubmitJson.optionId)}」</button>
</form>`
      : ''

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box; }
    .card { width: 100%; max-width: 520px; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 24px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06); }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #fff; background: ${badgeColor}; margin-bottom: 12px; }
    h1 { font-size: 18px; line-height: 1.4; margin: 0 0 10px; }
    p { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 12px; white-space: pre-wrap; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 9px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; text-decoration: none; border: 1px solid #cbd5e1; color: #1e293b; background: #fff; cursor: pointer; }
    .btn-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">${escapeHtml(badge)}</span>
    <h1>${escapeHtml(heading)}</h1>
    <p id="im-act-status">${escapeHtml(detail)}</p>
    ${formBlock}
    <div class="actions">
      ${webHref ? `<a class="btn btn-primary" href="${escapeHtml(webHref)}">在当前浏览器打开看板详情</a>` : ''}
      ${deepLinkHref ? `<a class="btn" href="${escapeHtml(deepLinkHref)}">拉起 DeepSeek Harness 桌面端</a>` : ''}
    </div>
  </main>
  ${autoScript}
</body>
</html>`
  }

  async function getAutopilotRoute(req, res) {
    const data = await store.read()
    sendJson(req, res, 200, {
      ok: true,
      autoAdvanceEnabled: getAutoAdvanceEnabled(data),
      revision: data.meta.revision,
    })
  }

  async function setAutopilotRoute(req, res) {
    const body = await readJsonBody(req)
    if (typeof body.enabled !== 'boolean') {
      throw new DomainError('BAD_REQUEST', 'enabled 必须是布尔值')
    }
    const now = Date.now()
    const actor = normalizeActor(body.actor, 'user')
    const { result, revision } = await store.update(draft => (
      setAutoAdvanceEnabled(draft, body.enabled, { actor, now })
    ))
    sendJson(req, res, 200, {
      ok: true,
      autoAdvanceEnabled: result.enabled,
      revision,
    })
  }

  function wantsJsonOnly(req, url) {
    if (url?.searchParams?.get('format') === 'json') return true
    const accept = String(req.headers.accept || '')
    return accept.includes('application/json') && !accept.includes('text/html')
  }

  async function imOpenRoute(req, res, url) {
    const rawCardId = cleanText(url.searchParams.get('cardId'), 64) || null
    const data = await store.read()
    const card = rawCardId ? findCardAny(data, rawCardId) : null
    const targetCardId = card ? card.id : rawCardId
    const focused = triggerHostFocus(targetCardId, { launchDesktop: req.method === 'GET' })
    const webHref = targetCardId
      ? `${STATIC_PREFIX}/?cardId=${encodeURIComponent(targetCardId)}`
      : `${STATIC_PREFIX}/`
    const deepLinkHref = targetCardId
      ? `dsh://kanban?cardId=${encodeURIComponent(targetCardId)}`
      : 'dsh://kanban'

    if (url.searchParams.get('redirect') === 'web') {
      res.writeHead(302, { location: webHref, 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (wantsJsonOnly(req, url)) {
      return sendJson(req, res, 200, {
        ok: true,
        focused,
        cardFound: Boolean(card),
        card: card ? { id: card.id, title: card.title, status: card.status, archived: Boolean(card.archived) } : null,
        webUrl: webHref,
        deepLink: deepLinkHref,
      })
    }

    const heading = card
      ? `${card.title}（${card.id}）`
      : (rawCardId ? `未找到卡片 ${rawCardId}` : '正在打开 DSH Super-Agent 看板')
    const detail = card
      ? `已向 DeepSeek Harness 桌面端发送定位指令（状态：${card.status}${card.archived ? ' · 已归档' : ''}）。\n若桌面端已在后台运行，将自动切到「看板」面板并展开该卡片详情；你也可以直接点击下方按钮在浏览器查看或拉起客户端。`
      : (rawCardId
        ? '该卡片可能已被删除或属于其他看板数据目录，你可打开看板查看当前全部卡片。'
        : '已通知 DeepSeek Harness 桌面端切到「看板」面板。')

    return sendHtml(req, res, card || !rawCardId ? 200 : 404, renderImBridgePage({
      title: `DSH 看板 · ${heading}`,
      badge: card ? '已同步至 DSH 桌面端' : (rawCardId ? '卡片未找到' : 'DSH 看板'),
      tone: card || !rawCardId ? 'info' : 'warn',
      heading,
      detail,
      webHref,
      deepLinkHref,
    }))
  }

  async function imActGetRoute(req, res, url) {
    const query = {
      cardId: url.searchParams.get('cardId') || '',
      approvalId: url.searchParams.get('approvalId') || '',
      optionId: url.searchParams.get('optionId') || '',
      exp: url.searchParams.get('exp') || '',
      sig: url.searchParams.get('sig') || '',
    }
    const secret = ensureImActionSecret(store.dataDir)
    const verified = verifyImActionQuery(query, secret, Date.now())
    const webHref = query.cardId
      ? `${STATIC_PREFIX}/?cardId=${encodeURIComponent(query.cardId)}`
      : `${STATIC_PREFIX}/`
    const deepLinkHref = query.cardId
      ? `dsh://kanban?cardId=${encodeURIComponent(query.cardId)}`
      : 'dsh://kanban'

    if (!verified.ok) {
      if (wantsJsonOnly(req, url)) {
        return sendError(req, res, verified.code, verified.message, verified.status)
      }
      return sendHtml(req, res, verified.status, renderImBridgePage({
        title: 'DSH 看板 · 审批链接无效',
        badge: verified.code === 'ACTION_EXPIRED' ? '链接已过期' : '签名无效',
        tone: 'error',
        heading: '无法执行该快捷审批链接',
        detail: verified.message,
        webHref,
        deepLinkHref,
      }))
    }

    // 关键安全边界：GET / HEAD 绝对只读，防止钉钉/微信/系统链接预览爬虫误触审批！
    const data = await store.read()
    const card = findCard(data, verified.cardId)
    const approval = card ? (card.approvals || []).find(a => a.id === verified.approvalId) : null
    if (!card || !approval) {
      if (wantsJsonOnly(req, url)) {
        return sendError(req, res, !card ? 'CARD_NOT_FOUND' : 'APPROVAL_NOT_FOUND', '卡片或审批项不存在', 404)
      }
      return sendHtml(req, res, 404, renderImBridgePage({
        title: 'DSH 看板 · 审批不存在',
        badge: '未找到',
        tone: 'warn',
        heading: !card ? `卡片不存在或已归档（${verified.cardId}）` : `未找到审批项（${verified.approvalId}）`,
        detail: '请前往 DSH 看板查看卡片最新状态。',
        webHref,
        deepLinkHref,
      }))
    }

    const opt = (approval.options || []).find(o => o.id === verified.optionId)
    const optLabel = opt?.label || verified.optionId

    if (approval.status === 'approved' || approval.status === 'rejected' || approval.status === 'resolved') {
      const resolvedLabels = (approval.resolution?.labels || []).join('、') || '已处理'
      if (wantsJsonOnly(req, url)) {
        return sendJson(req, res, 200, { ok: true, alreadyResolved: true, card, approval })
      }
      return sendHtml(req, res, 200, renderImBridgePage({
        title: `DSH 看板 · 已处理`,
        badge: '已处理（幂等）',
        tone: 'success',
        heading: `${card.title}`,
        detail: `该确认项「${approval.title}」此前已完成处理（决策：${resolvedLabels}），无需重复提交。`,
        webHref,
        deepLinkHref,
      }))
    }

    if (approval.status !== 'pending') {
      if (wantsJsonOnly(req, url)) {
        return sendError(req, res, 'APPROVAL_DISMISSED', '该确认项已关闭或失效', 409)
      }
      return sendHtml(req, res, 409, renderImBridgePage({
        title: 'DSH 看板 · 审批已关闭',
        badge: '已关闭',
        tone: 'warn',
        heading: `${card.title}`,
        detail: `确认项「${approval.title}」已关闭或卡片已离开待确认状态。`,
        webHref,
        deepLinkHref,
      }))
    }

    if (wantsJsonOnly(req, url)) {
      return sendJson(req, res, 200, {
        ok: true,
        readyToSubmit: true,
        cardId: card.id,
        approvalId: approval.id,
        optionId: verified.optionId,
        optionLabel: optLabel,
      })
    }

    return sendHtml(req, res, 200, renderImBridgePage({
      title: `DSH 看板 · 提交审批「${optLabel}」`,
      badge: '快捷审批确认',
      tone: 'info',
      heading: `${card.title}`,
      detail: `确认事项：${approval.title}\n所选决策：${optLabel}`,
      webHref,
      deepLinkHref,
      autoSubmitJson: {
        cardId: verified.cardId,
        approvalId: verified.approvalId,
        optionId: verified.optionId,
        exp: verified.exp,
        sig: query.sig,
        optionLabel: optLabel,
      },
    }))
  }

  async function imActPostRoute(req, res, url) {
    const body = await readJsonOrFormBody(req)
    const isFormSubmit = /^application\/x-www-form-urlencoded/i.test(String(req.headers['content-type'] || ''))
    const params = {
      cardId: body.cardId || url.searchParams.get('cardId') || '',
      approvalId: body.approvalId || url.searchParams.get('approvalId') || '',
      optionId: body.optionId || url.searchParams.get('optionId') || '',
      exp: body.exp || url.searchParams.get('exp') || '',
      sig: body.sig || url.searchParams.get('sig') || '',
    }
    const secret = ensureImActionSecret(store.dataDir)
    const verified = verifyImActionQuery(params, secret, Date.now())
    const webHref = params.cardId
      ? `${STATIC_PREFIX}/?cardId=${encodeURIComponent(params.cardId)}`
      : `${STATIC_PREFIX}/`
    const deepLinkHref = params.cardId
      ? `dsh://kanban?cardId=${encodeURIComponent(params.cardId)}`
      : 'dsh://kanban'

    if (!verified.ok) {
      if (isFormSubmit) {
        return sendHtml(req, res, verified.status, renderImBridgePage({
          title: 'DSH 看板 · 审批提交失败',
          badge: verified.code === 'ACTION_EXPIRED' ? '已过期' : '签名错误',
          tone: 'error',
          heading: '审批提交未通过安全校验',
          detail: verified.message,
          webHref,
          deepLinkHref,
        }))
      }
      return sendError(req, res, verified.code, verified.message, verified.status)
    }

    const now = Date.now()
    const { result, revision } = await store.update(draft => {
      const card = findCard(draft, verified.cardId)
      if (!card) throw new DomainError('CARD_NOT_FOUND', `卡片不存在或已归档：${verified.cardId}`, 404)
      const approval = (card.approvals || []).find(a => a.id === verified.approvalId)
      if (!approval) throw new DomainError('APPROVAL_NOT_FOUND', `审批不存在：${verified.approvalId}`, 404)
      if (approval.status === 'approved' || approval.status === 'rejected' || approval.status === 'resolved') {
        return { alreadyResolved: true, card, approval }
      }
      if (approval.status !== 'pending') {
        throw new DomainError('APPROVAL_DISMISSED', '该确认项已关闭，无法提交', 409)
      }
      const actor = defaultActor('user', '钉钉快捷审批')
      const resolved = resolveApproval(draft, card.id, approval.id, {
        optionId: verified.optionId,
        comment: body.comment,
        actor,
        now,
      })
      const primarySess = mainSessionId(resolved.card)
      if (primarySess || resolved.card.cwd || resolved.card.workspaceId) {
        enqueueOutbox(draft, {
          idempotencyKey: `im-approval:${resolved.card.id}:${approval.id}`,
          cardId: resolved.card.id,
          expectedGeneration: resolved.card.runtime?.generation ?? 1,
          kind: 'approval',
          target: {
            ...(primarySess ? { sessionId: primarySess } : {}),
            ...(resolved.card.workspaceId ? { workspaceId: resolved.card.workspaceId } : {}),
            ...(resolved.card.cwd ? { cwd: resolved.card.cwd } : {}),
          },
          prompt: `【看板·审批已提交】卡片「${resolved.card.title}」（${resolved.card.id}）的确认请求「${resolved.approval.title}」已由用户在 IM 拍板：${(resolved.approval.resolution?.labels || []).join('、') || verified.optionId}。请继续推进后续任务。`,
          mode: 'queue',
          notBefore: now,
        }, { now })
      }
      return { alreadyResolved: false, card: resolved.card, approval: resolved.approval }
    })

    triggerHostFocus(verified.cardId, { launchDesktop: false })

    if (isFormSubmit) {
      const chosen = (result.approval.resolution?.labels || []).join('、') || verified.optionId
      return sendHtml(req, res, 200, renderImBridgePage({
        title: 'DSH 看板 · 审批已提交',
        badge: result.alreadyResolved ? '已处理（幂等）' : '审批成功',
        tone: 'success',
        heading: `${result.card.title}`,
        detail: result.alreadyResolved
          ? `该确认项此前已处理（${chosen}），无需重复提交。`
          : `✅ 已提交决策「${chosen}」，卡片状态已更新为「${result.card.status}」并唤醒会话继续执行！`,
        webHref,
        deepLinkHref,
      }))
    }

    return sendJson(req, res, 200, {
      ok: true,
      alreadyResolved: result.alreadyResolved,
      card: result.card,
      approval: result.approval,
      revision,
    })
  }

  async function weixinQrStartRoute(req, res) {
    if (!weixinChannel) {
      throw new DomainError('WEIXIN_UNAVAILABLE', '当前看板实例未挂载原生微信通道适配器', 501)
    }
    const body = await readOptionalBody(req)
    const qr = await weixinChannel.startQrLogin({ baseUrl: body.baseUrl })
    sendJson(req, res, 200, { ok: true, ...qr })
  }

  async function weixinQrStatusRoute(req, res, url) {
    if (!weixinChannel) {
      throw new DomainError('WEIXIN_UNAVAILABLE', '当前看板实例未挂载原生微信通道适配器', 501)
    }
    const qrcode = cleanText(url.searchParams.get('qrcode'), 500) || undefined
    const status = await weixinChannel.checkQrLogin(qrcode)
    if (status.loggedIn) {
      const cfg = loadImConfig(store.dataDir)
      saveImConfig(store.dataDir, {
        ...cfg,
        weixin: {
          ...(cfg.weixin || {}),
          enabled: true,
          pollEnabled: true,
          ...(status.userId ? { defaultUserId: status.userId } : {}),
        },
      })
    }
    sendJson(req, res, 200, { ok: true, ...status })
  }

  async function webhookPreviewRoute(req, res) {
    const body = await readJsonBody(req)
    const payload = formatImNotification(body.event || body, {
      provider: body.provider || 'feishu',
      format: body.format || 'card',
      boardUrl: body.boardUrl || loadRuntimeOrigin(store.dataDir, 'http://127.0.0.1:4599'),
      secret: body.secret,
      actionSecret: body.actionSecret || (store.dataDir ? ensureImActionSecret(store.dataDir) : undefined),
      keyword: body.keyword,
      timestamp: body.timestamp,
      onebotTarget: body.onebotTarget,
    })
    sendJson(req, res, 200, {
      ok: true,
      provider: body.provider || 'feishu',
      supportedProviders: IM_PROVIDERS,
      supportedTemplates: IM_TEMPLATE_TYPES,
      payload,
    })
  }

  async function webhookSendRoute(req, res) {
    const body = await readJsonBody(req)
    const event = body.event && typeof body.event === 'object' ? body.event : body
    const sent = await dispatchImNotification(event, {
      dataDir: store.dataDir,
      targetId: body.targetId,
      target: body.target,
      weixinChannel,
      cc2imBridge,
    })
    sendJson(req, res, 200, {
      ok: sent.ok,
      results: sent.results,
    })
  }

  async function getImStatusRoute(req, res) {
    const cfg = loadImConfig(store.dataDir)
    const runtimeOrigin = loadRuntimeOrigin(store.dataDir, null)
    sendJson(req, res, 200, {
      ok: true,
      runtimeOrigin,
      config: sanitizeImConfig(cfg),
      weixinLive: weixinChannel ? weixinChannel.status() : null,
      cc2imLive: cc2imBridge ? cc2imBridge.status() : null,
      mcp: buildMcpStatusInfo(runtimeOrigin),
    })
  }

  async function weixinLogoutRoute(req, res) {
    const cfg = loadImConfig(store.dataDir)
    const wxLive = weixinChannel ? weixinChannel.logout() : null
    const saved = saveImConfig(store.dataDir, {
      ...cfg,
      weixin: {
        ...(cfg.weixin || {}),
        enabled: false,
      },
    })
    sendJson(req, res, 200, {
      ok: true,
      config: sanitizeImConfig(saved),
      weixinLive: wxLive,
    })
  }

  async function updateImConfigRoute(req, res) {
    const body = await readJsonBody(req)
    const cfg = loadImConfig(store.dataDir)
    let nextTargets = Array.isArray(cfg.targets) ? [...cfg.targets] : []
    let nextWeixin = { ...(cfg.weixin || { enabled: false }) }

    if (body.addTarget && typeof body.addTarget === 'object') {
      const raw = body.addTarget
      const rawUrl = cleanText(raw.url, 1024)
      if (!rawUrl || !/^https?:\/\//i.test(rawUrl) || rawUrl.includes('****')) {
        throw new DomainError('BAD_REQUEST', '请输入有效的 Webhook 地址（需以 http:// 或 https:// 开头）')
      }
      const provider = IM_PROVIDERS.includes(raw.provider) ? raw.provider : 'dingtalk'
      const id = cleanText(raw.id, 64) || `${provider}-${Date.now().toString(36)}`
      const name = cleanText(raw.name, 80) || `${provider.toUpperCase()} Webhook`
      const keyword = cleanText(raw.keyword, 64) || undefined
      const secret = cleanText(raw.secret, 256) || undefined
      const format = raw.format === 'text' ? 'text' : 'card'
      const baseEvents = Array.isArray(nextWeixin.events)
        ? nextWeixin.events
        : ['approval_requested', 'card_blocked', 'card_completed', 'daily_digest', 'light_text']
      const entry = {
        id,
        name,
        provider,
        enabled: raw.enabled !== false,
        url: rawUrl,
        ...(keyword ? { keyword } : {}),
        ...(secret ? { secret } : {}),
        format,
        events: Array.isArray(raw.events) ? raw.events : baseEvents,
      }
      const existingIdx = nextTargets.findIndex(t => (t.id || t.provider) === id)
      if (existingIdx >= 0) nextTargets[existingIdx] = entry
      else nextTargets.push(entry)
    }

    if (body.patchTarget && typeof body.patchTarget === 'object') {
      const patch = body.patchTarget
      const targetId = cleanText(patch.id, 64)
      const idx = nextTargets.findIndex(t => (t.id || t.provider) === targetId)
      if (idx === -1) throw new DomainError('NOT_FOUND', `未找到 IM 目标：${targetId}`, 404)
      const prev = nextTargets[idx]
      const next = { ...prev }
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      if (typeof patch.name === 'string' && patch.name.trim()) next.name = cleanText(patch.name, 80)
      if (typeof patch.keyword === 'string') {
        const kw = cleanText(patch.keyword, 64)
        if (kw) next.keyword = kw
        else delete next.keyword
      }
      if (typeof patch.url === 'string' && /^https?:\/\//i.test(patch.url.trim()) && !patch.url.includes('****')) {
        next.url = patch.url.trim()
      }
      if (typeof patch.secret === 'string' && patch.secret.trim()) {
        next.secret = cleanText(patch.secret, 256)
      }
      if (Array.isArray(patch.events)) {
        next.events = patch.events.filter(e => typeof e === 'string')
      }
      nextTargets[idx] = next
    }

    if (typeof body.removeTargetId === 'string' && body.removeTargetId.trim()) {
      const rmId = body.removeTargetId.trim()
      nextTargets = nextTargets.filter(t => (t.id || t.provider) !== rmId)
    }

    if (Array.isArray(body.events)) {
      const allowedSet = new Set(IM_TEMPLATE_TYPES)
      const cleanedEvents = [...new Set(body.events.filter(e => typeof e === 'string' && allowedSet.has(e)))]
      if (!cleanedEvents.includes('light_text')) cleanedEvents.push('light_text')
      nextWeixin.events = cleanedEvents
      nextTargets = nextTargets.map(t => ({ ...t, events: cleanedEvents }))
    }

    if (body.weixin && typeof body.weixin === 'object') {
      if (typeof body.weixin.enabled === 'boolean') nextWeixin.enabled = body.weixin.enabled
      if (typeof body.weixin.pollEnabled === 'boolean') nextWeixin.pollEnabled = body.weixin.pollEnabled
      if (weixinChannel && typeof weixinChannel.setEnabled === 'function') {
        weixinChannel.setEnabled(Boolean(nextWeixin.enabled), nextWeixin.pollEnabled !== false)
      }
    }

    const saved = saveImConfig(store.dataDir, {
      ...cfg,
      targets: nextTargets,
      weixin: nextWeixin,
    })
    sendJson(req, res, 200, {
      ok: true,
      config: sanitizeImConfig(saved),
      weixinLive: weixinChannel ? weixinChannel.status() : null,
      cc2imLive: cc2imBridge ? cc2imBridge.status() : null,
    })
  }

  async function mcpRoute(req, res) {
    const body = await readJsonBody(req)
    const harness = typeof req.headers?.['x-kanban-harness'] === 'string'
      ? req.headers['x-kanban-harness'].trim()
      : 'mcp'
    const agentName = typeof req.headers?.['x-kanban-agent'] === 'string'
      ? req.headers['x-kanban-agent'].trim()
      : 'MCP HTTP Agent'
    const agentUrl = typeof req.headers?.['x-kanban-agent-url'] === 'string'
      ? req.headers['x-kanban-agent-url'].trim()
      : undefined
    const response = await handleMcpJsonRpc(store, body, {
      registry: mcpRegistry,
      harness,
      agentName,
      agentUrl,
    })
    sendJson(req, res, 200, response || { jsonrpc: '2.0', id: null, result: { accepted: true } })
  }

  // ---------------- 分发 ----------------

  async function dispatch(req, res, url) {
    const parts = url.pathname.slice(API_PREFIX.length).split('/').filter(Boolean).map(decodeSegment)
    const method = req.method
    const isGet = method === 'GET' || method === 'HEAD'
    const [head, first, second, third, fourth] = parts

    if (!head) throw new DomainError('NOT_FOUND', '接口不存在', 404)

    if (head === 'health') {
      if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
      return getHealth(req, res)
    }
    if (head === 'cloud' && parts.length === 2 && first === 'status') {
      if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
      return getCloudStatus(req, res)
    }
    if (head === 'cloud' && parts.length === 2 && first === 'reload') {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return reloadCloudRoute(req, res)
    }
    if (head === 'state') {
      if (!isGet) return methodNotAllowed(req, res, 'GET')
      return getState(req, res, url)
    }
    if (head === 'events') return handleEvents(req, res)
    if (head === 'archive' && parts.length === 1) {
      // 归档箱列表（v0.22.0 只读）
      if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
      return getArchive(req, res, url)
    }
    if (head === 'decisions') {
      if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
      if (parts.length === 1) return getDecisions(req, res, url)
      if (parts.length === 2 && first === 'meta') return getDecisionsMeta(req, res)
      if (parts.length === 2 && first === 'export') return getDecisionsExport(req, res)
      throw new DomainError('NOT_FOUND', '接口不存在', 404)
    }
    if (head === 'sessions' && parts.length === 2 && first === 'archive') {
      if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
      return getSessionArchiveState(req, res)
    }
    if (head === 'sessions' && parts.length === 2 && first === 'archive-batch') {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return archiveSessionsBatchRoute(req, res)
    }
    if (head === 'outbox') {
      if (parts.length === 1) {
        if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
        return getOutboxRoute(req, res)
      }
      if (parts.length === 2 && first === 'lease') {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return leaseOutboxRoute(req, res)
      }
      if (parts.length === 3 && second === 'ack') {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return ackOutboxRoute(req, res, first)
      }
      throw new DomainError('NOT_FOUND', '接口不存在', 404)
    }
    if (head === 'autopilot' && parts.length === 1) {
      if (isGet) return getAutopilotRoute(req, res)
      if (method === 'POST' || method === 'PUT') return setAutopilotRoute(req, res)
      return methodNotAllowed(req, res, 'GET, POST, PUT')
    }
    if (head === 'super-agent') {
      if (parts.length === 1) {
        if (isGet) return getSuperAgentRoute(req, res)
        if (method === 'POST') return setSuperAgentRoute(req, res)
        return methodNotAllowed(req, res, 'GET, POST')
      }
      if (parts.length === 2 && first === 'route') {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return routeSuperAgentIntentRoute(req, res)
      }
      if (parts.length === 2 && first === 'rules') {
        if (isGet) return getRouterRulesRoute(req, res)
        if (method === 'PUT' || method === 'POST') return putRouterRulesRoute(req, res)
        return methodNotAllowed(req, res, 'GET, PUT, POST')
      }
      throw new DomainError('NOT_FOUND', '接口不存在', 404)
    }
    if (head === 'ingress' && parts.length === 1) {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return ingressRoute(req, res)
    }
    if (head === 'webhooks' && parts.length === 2 && first === 'preview') {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return webhookPreviewRoute(req, res)
    }
    if (head === 'webhooks' && parts.length === 2 && first === 'send') {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return webhookSendRoute(req, res)
    }
    if (head === 'im') {
      if (parts.length === 2 && first === 'status') {
        if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
        return getImStatusRoute(req, res)
      }
      if (parts.length === 2 && first === 'config') {
        if (method === 'PUT' || method === 'POST') return updateImConfigRoute(req, res)
        return methodNotAllowed(req, res, 'PUT, POST')
      }
      if (parts.length === 2 && first === 'open') {
        if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
        return imOpenRoute(req, res, url)
      }
      if (parts.length === 2 && first === 'act') {
        if (isGet) return imActGetRoute(req, res, url)
        if (method === 'POST') return imActPostRoute(req, res, url)
        return methodNotAllowed(req, res, 'GET, HEAD, POST')
      }
      if (parts.length === 3 && first === 'weixin' && second === 'qr') {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return weixinQrStartRoute(req, res)
      }
      if (parts.length === 3 && first === 'weixin' && second === 'qr-status') {
        if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
        return weixinQrStatusRoute(req, res, url)
      }
      if (parts.length === 3 && first === 'weixin' && second === 'logout') {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return weixinLogoutRoute(req, res)
      }
      throw new DomainError('NOT_FOUND', '接口不存在', 404)
    }
    if (head === 'mcp' && parts.length === 1) {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return mcpRoute(req, res)
    }
    if (head === 'git' && parts.length === 2 && first === 'summaries') {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return gitSummariesRoute(req, res)
    }
    if (head === 'git' && parts.length === 2 && first === 'workspaces') {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return gitWorkspacesRoute(req, res)
    }
    if (head === 'git' && parts.length === 3 && first === 'worktrees' && second === 'cleanup') {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return gitWorktreeCleanupRoute(req, res)
    }
    if (head === 'git' && parts.length === 3 && first === 'worktrees' && second === 'prune') {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return gitWorktreePruneRoute(req, res)
    }
    if (head === 'git' && first === 'trash') {
      if (parts.length === 2) {
        if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
        return getTrash(req, res)
      }
      if (parts.length === 3) {
        const id = second
        if (method === 'POST') {
          if (id !== 'restore') return methodNotAllowed(req, res, 'DELETE')
          return restoreTrashRoute(req, res)
        }
        if (method === 'DELETE') return purgeTrashRoute(req, res, id)
        return methodNotAllowed(req, res, id === 'restore' ? 'POST' : 'DELETE')
      }
      throw new DomainError('NOT_FOUND', '接口不存在', 404)
    }
    if (head === 'boards' && parts.length === 1) {
      if (isGet) return getBoards(req, res)
      if (method === 'POST') return createBoardRoute(req, res)
      return methodNotAllowed(req, res, 'GET, POST')
    }
    if (head === 'boards' && parts.length === 2) {
      assertPathId(first, 'board', '看板')
      if (method === 'PATCH') return patchBoardRoute(req, res, first)
      if (method === 'DELETE') return deleteBoardRoute(req, res, first)
      return methodNotAllowed(req, res, 'PATCH, DELETE')
    }
    if (head === 'cards' && parts.length === 1) {
      if (method === 'POST') return createCardRoute(req, res)
      return methodNotAllowed(req, res, 'POST')
    }
    if (head === 'cards' && first === 'batch' && parts.length === 2) {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return batchCardsRoute(req, res)
    }
    if (head === 'cards' && first) {
      assertPathId(first, 'card', '卡片')
      if (!second) {
        if (method === 'PATCH') return patchCardRoute(req, res, first)
        if (method === 'DELETE') return deleteCardRoute(req, res, first, url)
        return methodNotAllowed(req, res, 'PATCH, DELETE')
      }
      if (second === 'activities' && parts.length === 3) {
        if (!isGet) return methodNotAllowed(req, res, 'GET')
        return getActivities(req, res, first, url)
      }
      if (second === 'git' && parts.length === 3) {
        if (!isGet) return methodNotAllowed(req, res, 'GET, HEAD')
        return getCardGit(req, res, first, url)
      }
      if (second === 'move' && parts.length === 3) {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return moveCardRoute(req, res, first)
      }
      if (second === 'unarchive' && parts.length === 3) {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return unarchiveCardRoute(req, res, first)
      }
      if (second === 'comments' && parts.length === 3) {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return commentRoute(req, res, first)
      }
      if (second === 'ack' && parts.length === 3) {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return ackRoute(req, res, first)
      }
      if (second === 'approvals') {
        if (parts.length === 3) {
          if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
          return createApprovalRoute(req, res, first)
        }
        if (parts.length === 5 && fourth === 'resolve') {
          assertPathId(third, 'ap', '审批')
          if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
          return resolveApprovalRoute(req, res, first, third)
        }
      }
      if (second === 'sessions' && parts.length === 5 && (fourth === 'archive' || fourth === 'unarchive')) {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return fourth === 'archive'
          ? archiveSessionRoute(req, res, first, third)
          : unarchiveSessionRoute(req, res, first, third)
      }
      if (second === 'session') {
        if (parts.length === 3) {
          if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
          return linkSessionRoute(req, res, first)
        }
        if (parts.length === 4) {
          if (method !== 'DELETE') return methodNotAllowed(req, res, 'DELETE')
          return unlinkSessionRoute(req, res, first, third)
        }
      }
    }
    if (head === 'seed' && parts.length === 1) {
      if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
      return seedRoute(req, res)
    }
    throw new DomainError('NOT_FOUND', '接口不存在', 404)
  }

  function captureLocalRuntimeOrigin(req) {
    if (req._isImLocalBridge) return
    const rawHost = String(req.headers.host || '').trim()
    if (!/^(127\.0\.0\.1|localhost):\d{2,5}$/i.test(rawHost)) return
    const proto = req.socket?.encrypted ? 'https://' : 'http://'
    const origin = `${proto}${rawHost}`
    if (origin !== lastSavedOrigin && store.dataDir) {
      lastSavedOrigin = origin
      saveRuntimeOrigin(store.dataDir, origin)
    }
  }

  function isExternalImBridgeRoute(pathname, method) {
    if (pathname === `${API_PREFIX}/im/open` && (method === 'GET' || method === 'HEAD')) return true
    if (pathname === `${API_PREFIX}/im/act` && (method === 'GET' || method === 'HEAD' || method === 'POST')) return true
    return false
  }

  async function apiHandler(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      return sendError(req, res, 'BAD_REQUEST', '无效的请求地址', 400)
    }
    captureLocalRuntimeOrigin(req)
    if (!isExternalImBridgeRoute(url.pathname, req.method) && !isSameOrigin(req)) {
      return sendError(req, res, 'FORBIDDEN_ORIGIN', '仅接受 DSH 同源请求', 403)
    }
    try {
      await dispatch(req, res, url)
    } catch (error) {
      if (error?.code === 'ECONNRESET' || res.destroyed) return
      handleError(req, res, error, logger)
    }
  }

  async function staticRoute(req, res) {
    try {
      await staticHandler(req, res)
    } catch (error) {
      try { logger?.warn?.(`[dsh-kanban] 静态资源异常：${error?.message || error}`) } catch {}
      if (!res.headersSent && !res.destroyed) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('internal error') }
    }
  }

  async function close() {
    unsubscribe()
    stopHeartbeat()
    for (const res of [...clients]) { try { res.end() } catch {} }
    clients.clear()
  }

  return {
    routes: [
      { kind: 'prefix', path: API_PREFIX, handler: apiHandler },
      { kind: 'prefix', path: STATIC_PREFIX, handler: staticRoute },
    ],
    notify: broadcast,
    close,
    clients,
  }
}
