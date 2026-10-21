// HTTP 层：全部 REST 路由 + SSE + 同源/JSON/大小校验 + 静态资源。
// createRoutes() 返回可直接挂到 DSH webServer 或纯 node http 的 handler 列表，
// 业务状态迁移全部委托给 domain.js，保证 REST 与 agent 工具语义一致。
import { DomainError } from './domain.js'
import {
  DEFAULT_BOARD_ID, LIMITS, SCHEMA_VERSION, addComment, applySeedMode, archiveCard, ackCard,
  cleanText, countsFor, createCard, linkSession, moveCard, newBoard, orderedCards,
  patchCard, requestApproval, requireBoard, requireCard, resolveApproval, touchMeta, unlinkSession,
} from './domain.js'
import { createStaticHandler } from './static.js'

export const API_PREFIX = '/api/kanban'
export const STATIC_PREFIX = '/dsh-kanban'
export const BODY_LIMIT = 256 * 1024
export const HEARTBEAT_MS = 15_000

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

const hasBody = req => req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) > 0

function sendJson(req, res, status, value) {
  if (res.headersSent || res.destroyed) return
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': body.length })
  res.end(req.method === 'HEAD' ? undefined : body)
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
  if (code === 'STORE_SCHEMA_NEWER' || code === 'STORE_CORRUPT' || code === 'STORE_IO' || code === 'STORE_CLOSED') {
    try { logger?.warn?.(`[dsh-kanban] ${error.message}`) } catch {}
    return sendError(req, res, 'INTERNAL', error.message, 500)
  }
  try { logger?.error?.(error) } catch {}
  return sendError(req, res, 'INTERNAL', '服务端内部错误，请查看 DSH 日志', 500)
}

export function createRoutes({ store, staticRoot, version = '0.1.0', logger } = {}) {
  if (!store) throw new Error('createRoutes 需要 store')
  const clients = new Set()
  let heartbeat = null
  const staticHandler = createStaticHandler({ root: staticRoot, prefix: STATIC_PREFIX })

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
    const { result, revision } = await store.update(draft => {
      const created = createCard(draft, body, { actor: body.actor, now: Date.now() })
      return { card: created.card }
    })
    sendJson(req, res, 200, { ok: true, card: result.card, revision })
  }

  async function patchCardRoute(req, res, cardId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => {
      const card = requireCard(draft, cardId)
      requireVersion(card, body, req.url ? new URL(req.url, 'http://localhost') : undefined)
      return patchCard(draft, cardId, body.changes, { actor: body.actor, now: Date.now() })
    })
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
        text: body.reason, actor: body.actor, now: Date.now(),
      })
    })
    sendJson(req, res, 200, { ok: true, card: result.card, revision })
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
      sessionId: body.sessionId, actor: body.actor, now: Date.now(),
    }))
    sendJson(req, res, 200, { ok: true, approval: result.approval, card: result.card, revision })
  }

  async function resolveApprovalRoute(req, res, cardId, approvalId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => resolveApproval(draft, cardId, approvalId, {
      optionIds: body.optionIds, optionId: body.optionId, comment: body.comment, actor: body.actor, now: Date.now(),
    }))
    sendJson(req, res, 200, { ok: true, approval: result.approval, card: result.card, revision })
  }

  async function linkSessionRoute(req, res, cardId) {
    const body = await readJsonBody(req)
    const { result, revision } = await store.update(draft => linkSession(draft, cardId, {
      sessionId: body.sessionId, title: body.title, actor: body.actor, now: Date.now(),
    }))
    sendJson(req, res, 200, { ok: true, card: result.card, revision })
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
    if (head === 'state') {
      if (!isGet) return methodNotAllowed(req, res, 'GET')
      return getState(req, res, url)
    }
    if (head === 'events') return handleEvents(req, res)
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
      if (second === 'move' && parts.length === 3) {
        if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
        return moveCardRoute(req, res, first)
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

  async function apiHandler(req, res) {
    if (!isSameOrigin(req)) return sendError(req, res, 'FORBIDDEN_ORIGIN', '仅接受 DSH 同源请求', 403)
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      return sendError(req, res, 'BAD_REQUEST', '无效的请求地址', 400)
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
