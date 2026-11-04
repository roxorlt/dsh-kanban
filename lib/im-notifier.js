// 多端 IM 出站发送器与看板状态变更自动通知守护器：
// - 配置存放在用户本机 `<dataDir>/im-config.json`（默认 `~/.dsh-kanban/im-config.json`），与代码仓库完全解耦；
// - 支持钉钉（含自定义关键词如 `superAgent` 与加签 `SEC...`）、飞书（含签名）、企微、OneBot、通用 Webhook 及本地 cc2im 微信桥；
// - 自动监听看板卡片进入 `needs_you`（待拍板）、`blocked`（受阻熔断）、`done`（交付完成）并推送摘要通知。

import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { formatImNotification } from './im-gateway.js'

const DEFAULT_EVENTS = ['approval_requested', 'card_blocked', 'card_completed', 'daily_digest', 'light_text']

export function imConfigPath(dataDir) {
  return dataDir ? join(dataDir, 'im-config.json') : null
}

export function runtimeEndpointPath(dataDir) {
  return dataDir ? join(dataDir, 'runtime-endpoint.json') : null
}

function readRuntimeEndpointObject(dataDir) {
  const file = runtimeEndpointPath(dataDir)
  if (!file || !existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function loadRuntimeOrigin(dataDir, fallback = 'http://127.0.0.1:4599') {
  const raw = readRuntimeEndpointObject(dataDir)
  if (typeof raw?.origin === 'string' && /^https?:\/\//i.test(raw.origin.trim())) {
    return raw.origin.trim().replace(/\/+$/, '')
  }
  return fallback
}

export function saveRuntimeOrigin(dataDir, origin) {
  const file = runtimeEndpointPath(dataDir)
  if (!file || typeof origin !== 'string' || !/^https?:\/\//i.test(origin.trim())) return null
  const cleaned = origin.trim().replace(/\/+$/, '')
  try {
    const prev = readRuntimeEndpointObject(dataDir)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      ...prev,
      origin: cleaned,
      updatedAt: Date.now(),
    }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    return cleaned
  } catch {
    return null
  }
}

export function loadImBridgeOrigin(dataDir, fallback = '') {
  const raw = readRuntimeEndpointObject(dataDir)
  if (typeof raw?.bridgeOrigin === 'string' && /^https?:\/\//i.test(raw.bridgeOrigin.trim())) {
    return raw.bridgeOrigin.trim().replace(/\/+$/, '')
  }
  return fallback
}

export function saveImBridgeOrigin(dataDir, bridgeOrigin) {
  const file = runtimeEndpointPath(dataDir)
  if (!file) return null
  const prev = readRuntimeEndpointObject(dataDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (!bridgeOrigin) {
      const next = { ...prev, updatedAt: Date.now() }
      delete next.bridgeOrigin
      writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      return null
    }
    if (typeof bridgeOrigin !== 'string' || !/^https?:\/\//i.test(bridgeOrigin.trim())) return null
    const cleaned = bridgeOrigin.trim().replace(/\/+$/, '')
    writeFileSync(file, JSON.stringify({
      ...prev,
      bridgeOrigin: cleaned,
      updatedAt: Date.now(),
    }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    return cleaned
  } catch {
    return null
  }
}

/**
 * 在本机回环地址（默认 `127.0.0.1:4599`）启动轻量固定端口 IM 桥接监听：
 * - 解决 DSH Desktop（Electron）每次重启分配随机高端口导致历史钉钉消息按钮失联的问题；
 * - 兼容旧版钉钉消息里的 `http://127.0.0.1:4599/?cardId=...` 链接，自动转发至 `/api/kanban/im/open`；
 * - 复用同一进程内的 `/api/kanban` 与 `/dsh-kanban` 处理器，端口占用（如 dev-server 已监听）时静默降级不抛错。
 */
export function createImLocalBridgeServer({
  routes = [],
  port = 4599,
  host = '127.0.0.1',
  dataDir,
  logger,
} = {}) {
  const apiRoute = routes.find(r => r.path === '/api/kanban')
  const staticRoute = routes.find(r => r.path === '/dsh-kanban')
  let listeningOrigin = ''

  const server = createServer(async (req, res) => {
    req._isImLocalBridge = true
    let parsed
    try {
      parsed = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Bad Request')
      return
    }

    const pathname = parsed.pathname
    // 兼容历史钉钉卡片中的 `http://127.0.0.1:4599/?cardId=card-xxx` 根路径链接
    if (pathname === '/' && (req.method === 'GET' || req.method === 'HEAD') && apiRoute) {
      req.url = `/api/kanban/im/open${parsed.search || ''}`
      await apiRoute.handler(req, res)
      return
    }
    if (apiRoute && (pathname === '/api/kanban' || pathname.startsWith('/api/kanban/'))) {
      await apiRoute.handler(req, res)
      return
    }
    if (staticRoute && (pathname === '/dsh-kanban' || pathname.startsWith('/dsh-kanban/'))) {
      await staticRoute.handler(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  })

  const ready = new Promise(resolveReady => {
    server.once('error', err => {
      if (err?.code === 'EADDRINUSE') {
        try { logger?.info?.(`[dsh-kanban] 本地 IM 固定桥接端口 ${host}:${port} 已被占用，复用现有监听`) } catch {}
      } else {
        try { logger?.warn?.(`[dsh-kanban] 本地 IM 固定桥接监听未启用 (${host}:${port}): ${err?.message || err}`) } catch {}
      }
      resolveReady(null)
    })
    server.listen(port, host, () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      listeningOrigin = `http://${host}:${actualPort}`
      if (dataDir) saveImBridgeOrigin(dataDir, listeningOrigin)
      try { logger?.info?.(`[dsh-kanban] 本地 IM 固定桥接已就绪：${listeningOrigin}`) } catch {}
      resolveReady(listeningOrigin)
    })
  })
  server.unref?.()

  return {
    server,
    ready,
    origin: () => listeningOrigin,
    close() {
      return new Promise(resolveClose => {
        if (!server.listening) {
          resolveClose()
          return
        }
        server.close(() => {
          resolveClose()
        })
      })
    },
  }
}

export function loadImConfig(dataDir) {
  const file = imConfigPath(dataDir)
  if (!file || !existsSync(file)) {
    return { targets: [], weixin: { enabled: false }, cc2im: { enabled: false }, actionSecret: '' }
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const targets = Array.isArray(raw?.targets) ? raw.targets : []
    const weixin = raw?.weixin && typeof raw.weixin === 'object' ? raw.weixin : { enabled: false }
    const cc2im = raw?.cc2im && typeof raw.cc2im === 'object' ? raw.cc2im : { enabled: false }
    const actionSecret = typeof raw?.actionSecret === 'string' ? raw.actionSecret : ''
    return {
      targets: targets.filter(t => t && typeof t === 'object'),
      weixin,
      cc2im,
      actionSecret,
    }
  } catch {
    return { targets: [], weixin: { enabled: false }, cc2im: { enabled: false }, actionSecret: '' }
  }
}

export function saveImConfig(dataDir, config = {}) {
  const file = imConfigPath(dataDir)
  if (!file) throw new Error('缺少 dataDir，无法保存 im-config.json')
  mkdirSync(dirname(file), { recursive: true })
  const existing = loadImConfig(dataDir)
  const actionSecret = (typeof config.actionSecret === 'string' && config.actionSecret.trim())
    ? config.actionSecret.trim()
    : (existing.actionSecret || crypto.randomBytes(32).toString('hex'))
  const normalized = {
    version: 1,
    updatedAt: Date.now(),
    actionSecret,
    targets: Array.isArray(config.targets) ? config.targets : existing.targets,
    weixin: config.weixin && typeof config.weixin === 'object'
      ? config.weixin
      : (existing.weixin || { enabled: false }),
    cc2im: config.cc2im && typeof config.cc2im === 'object'
      ? config.cc2im
      : (existing.cc2im || { enabled: false }),
  }
  writeFileSync(file, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return normalized
}

/** 读取或首次自动生成本机专属的 IM 交互按钮签名密钥（存于 `<dataDir>/im-config.json`，0600 权限）。 */
export function ensureImActionSecret(dataDir) {
  if (!dataDir) return ''
  const loaded = loadImConfig(dataDir)
  if (loaded.actionSecret && loaded.actionSecret.length >= 32) {
    return loaded.actionSecret
  }
  const saved = saveImConfig(dataDir, loaded)
  return saved.actionSecret
}

function maskUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return ''
  try {
    const u = new URL(rawUrl)
    for (const key of ['access_token', 'key', 'token', 'secret', 'sign']) {
      if (u.searchParams.has(key)) {
        const v = u.searchParams.get(key) || ''
        u.searchParams.set(key, v.length > 8 ? `${v.slice(0, 4)}****${v.slice(-4)}` : '****')
      }
    }
    return u.toString()
  } catch {
    return '***'
  }
}

export function sanitizeImConfig(config = {}) {
  return {
    hasActionSecret: Boolean(config.actionSecret),
    targets: (Array.isArray(config.targets) ? config.targets : []).map(t => ({
      id: t.id || t.provider || 'target',
      name: t.name || t.id || t.provider || 'IM Target',
      provider: t.provider || 'generic',
      enabled: t.enabled !== false,
      urlMasked: maskUrl(t.url),
      boardUrl: t.boardUrl || undefined,
      hasKeyword: Boolean(t.keyword),
      keyword: t.keyword || undefined,
      hasSecret: Boolean(t.secret),
      format: t.format || 'card',
      events: Array.isArray(t.events) ? t.events : DEFAULT_EVENTS,
    })),
    weixin: config.weixin
      ? {
        enabled: Boolean(config.weixin.enabled),
        pollEnabled: config.weixin.pollEnabled !== false,
        hasDefaultUser: Boolean(config.weixin.defaultUserId),
        events: Array.isArray(config.weixin.events) ? config.weixin.events : DEFAULT_EVENTS,
      }
      : { enabled: false, events: DEFAULT_EVENTS },
    cc2im: config.cc2im
      ? {
        enabled: Boolean(config.cc2im.enabled),
        agentId: config.cc2im.agentId || 'kanban',
        socketPath: config.cc2im.socketPath || '',
        webUrl: config.cc2im.webUrl || 'http://127.0.0.1:3721',
        hasDefaultUser: Boolean(config.cc2im.defaultUserId),
      }
      : { enabled: false },
  }
}

/**
 * 向单个 Webhook 目标真实发送通知并校验平台业务状态码（如钉钉 errcode === 0、飞书 code === 0）。
 */
export async function sendWebhookNotification(event = {}, target = {}, {
  fetchImpl = globalThis.fetch,
  dataDir,
  actionSecret,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境不支持 fetch')
  }
  if (!target || typeof target.url !== 'string' || !target.url.trim()) {
    throw new Error('Webhook 目标缺少有效的 url')
  }

  const provider = target.provider || 'generic'
  const format = event.format || target.format || 'card'
  const bridgeOrigin = loadImBridgeOrigin(dataDir, '')
  const discoveredOrigin = loadRuntimeOrigin(dataDir, '')
  const configuredBoardUrl = (target.boardUrl && !/^http:\/\/(127\.0\.0\.1|localhost):4599\/?$/i.test(String(target.boardUrl).trim()))
    ? target.boardUrl
    : ''
  const effectiveBoardUrl = event.boardUrl || configuredBoardUrl || bridgeOrigin || discoveredOrigin || target.boardUrl || 'http://127.0.0.1:4599'
  const effectiveActionSecret = actionSecret || target.actionSecret || (dataDir ? ensureImActionSecret(dataDir) : '')
  const formatted = formatImNotification(event, {
    provider,
    format,
    boardUrl: effectiveBoardUrl,
    secret: target.secret,
    actionSecret: effectiveActionSecret,
    keyword: target.keyword,
    timestamp: event.timestamp,
    onebotTarget: target.onebotTarget,
  })

  const bodyObj = { ...formatted }
  let finalUrl = target.url.trim()
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    ...(target.headers && typeof target.headers === 'object' ? target.headers : {}),
  }

  if (bodyObj._dingtalkQuery) {
    const { timestamp, sign } = bodyObj._dingtalkQuery
    delete bodyObj._dingtalkQuery
    const sep = finalUrl.includes('?') ? '&' : '?'
    finalUrl = `${finalUrl}${sep}timestamp=${encodeURIComponent(timestamp)}&sign=${ sign }`
  }

  if (provider === 'generic' && bodyObj.signature && typeof bodyObj.signature === 'object') {
    headers['x-kanban-timestamp'] = String(bodyObj.signature.timestamp || '')
    headers['x-kanban-signature'] = String(bodyObj.signature.signature || '')
  }

  const res = await fetchImpl(finalUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
  })

  const rawText = await res.text()
  let parsed = null
  try { parsed = JSON.parse(rawText) } catch { parsed = { raw: rawText } }

  let platformOk = res.ok
  if (platformOk && parsed && typeof parsed === 'object') {
    if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) platformOk = false
    if (typeof parsed.code === 'number' && parsed.code !== 0) platformOk = false
    if (typeof parsed.StatusCode === 'number' && parsed.StatusCode !== 0) platformOk = false
  }

  return {
    ok: platformOk,
    targetId: target.id || provider,
    provider,
    format,
    msgtype: bodyObj.msgtype || bodyObj.msg_type || bodyObj.action || 'json',
    httpStatus: res.status,
    response: parsed,
    payload: bodyObj,
  }
}

/**
 * 统一分发事件到已启用或指定的 Webhook 目标及 cc2im 微信通道。
 */
export async function dispatchImNotification(event = {}, {
  dataDir,
  config,
  targetId,
  target,
  weixinChannel,
  cc2imBridge,
  fetchImpl,
} = {}) {
  const results = []
  const loaded = config || loadImConfig(dataDir)
  const actionSecret = loaded.actionSecret || (dataDir ? ensureImActionSecret(dataDir) : '')
  if (target && target.url) {
    results.push(await sendWebhookNotification(event, target, { fetchImpl, dataDir, actionSecret }))
    return { ok: results.every(r => r.ok), results }
  }

  const template = event.template || 'light_text'
  const matchedTargets = (loaded.targets || []).filter(t => {
    if (targetId) return (t.id || t.provider) === targetId
    if (t.enabled === false) return false
    const allowed = Array.isArray(t.events) ? t.events : DEFAULT_EVENTS
    return allowed.includes(template) || allowed.includes('*')
  })

  for (const item of matchedTargets) {
    try {
      results.push(await sendWebhookNotification(event, item, { fetchImpl, dataDir, actionSecret }))
    } catch (error) {
      results.push({
        ok: false,
        targetId: item.id || item.provider || 'webhook',
        provider: item.provider || 'generic',
        error: error?.message || String(error),
      })
    }
  }

  if (weixinChannel && (!targetId || targetId === 'weixin')) {
    const wxCfg = loaded.weixin || {}
    const allowed = Array.isArray(wxCfg.events) ? wxCfg.events : DEFAULT_EVENTS
    const wxEnabled = wxCfg.enabled !== false && Boolean(wxCfg.enabled || weixinChannel.status?.()?.enabled)
    if ((targetId === 'weixin' || wxEnabled) && (targetId === 'weixin' || allowed.includes(template) || allowed.includes('*'))) {
      const wxRes = await weixinChannel.sendNotification(event, {
        userId: event.userId || wxCfg.defaultUserId,
        format: event.format || 'card',
      })
      results.push({
        targetId: 'weixin',
        provider: 'weixin',
        ...wxRes,
      })
    }
  }

  if (cc2imBridge && (!targetId || targetId === 'cc2im')) {
    const ccCfg = loaded.cc2im || {}
    const allowed = Array.isArray(ccCfg.events) ? ccCfg.events : DEFAULT_EVENTS
    if ((targetId === 'cc2im' || ccCfg.enabled) && (allowed.includes(template) || allowed.includes('*'))) {
      const wxFormatted = formatImNotification(event, {
        provider: 'weixin',
        format: event.format || 'card',
      })
      const wxRes = await cc2imBridge.sendWechatText(wxFormatted.text, event.userId || ccCfg.defaultUserId)
      results.push({
        ok: wxRes.ok,
        targetId: 'cc2im-weixin',
        provider: 'weixin',
        ...wxRes,
      })
    }
  }

  return {
    ok: results.length > 0 && results.every(r => r.ok),
    results,
  }
}

/**
 * 订阅看板 Store 变更：当未归档卡片新进入 `needs_you`、`blocked`、`done` 时自动推送 IM 通知。
 */
export function createImAutoNotifier({ store, dataDir, weixinChannel, cc2imBridge, fetchImpl, logger } = {}) {
  let initialized = false
  const prevState = new Map()
  let runningPromise = null
  let pendingRescan = false

  function snapshotMap(cards = []) {
    const map = new Map()
    for (const card of cards) {
      if (!card || card.archived) continue
      const pendingId = (card.approvals || []).find(a => a.status === 'pending')?.id || null
      map.set(card.id, { status: card.status, pendingId })
    }
    return map
  }

  async function runScanOnce() {
    try {
      const data = await store.read()
      const cards = Array.isArray(data.cards) ? data.cards : []
      if (!initialized) {
        for (const [id, st] of snapshotMap(cards)) prevState.set(id, st)
        initialized = true
        return
      }

      const cfg = loadImConfig(dataDir)
      const wxStatus = weixinChannel?.status?.()
      const hasActiveChannel = (cfg.targets || []).some(t => t.enabled !== false && t.url)
        || (cfg.weixin?.enabled !== false && Boolean(cfg.weixin?.enabled || wxStatus?.enabled) && Boolean(wxStatus?.loggedIn))
        || (cfg.cc2im?.enabled && cc2imBridge?.isConnected?.())
      const nextMap = snapshotMap(cards)

      for (const card of cards) {
        if (!card || card.archived) continue
        const prev = prevState.get(card.id)
        const curr = nextMap.get(card.id)
        if (!curr) continue

        if (hasActiveChannel) {
          let event = null
          if (curr.status === 'needs_you' && (!prev || prev.status !== 'needs_you' || prev.pendingId !== curr.pendingId)) {
            event = { template: 'approval_requested', card }
          } else if (curr.status === 'blocked' && (!prev || prev.status !== 'blocked')) {
            event = { template: 'card_blocked', card }
          } else if (curr.status === 'done' && prev && prev.status !== 'done') {
            event = { template: 'card_completed', card }
          }

          if (event) {
            // 若卡片来源于特定微信线程（`weixin:<uid>`），优先回推同一微信用户
            if (typeof card.externalThreadId === 'string' && card.externalThreadId.startsWith('weixin:')) {
              event.userId = card.externalThreadId.slice('weixin:'.length)
            }
            await dispatchImNotification(event, { dataDir, config: cfg, weixinChannel, cc2imBridge, fetchImpl }).catch(err => {
              try { logger?.warn?.(`[dsh-kanban] IM 自动通知发送失败 (${card.id}): ${err?.message || err}`) } catch {}
            })
          }
        }
      }

      prevState.clear()
      for (const [id, st] of nextMap) prevState.set(id, st)
    } catch (err) {
      try { logger?.warn?.(`[dsh-kanban] IM 状态扫描异常: ${err?.message || err}`) } catch {}
    }
  }

  function checkTransitions() {
    if (runningPromise) {
      pendingRescan = true
      return runningPromise.then(async () => {
        if (!pendingRescan) return
        pendingRescan = false
        return checkTransitions()
      })
    }
    runningPromise = runScanOnce().finally(() => {
      runningPromise = null
    })
    return runningPromise
  }

  // 启动时初始化基线快照，避免把存量卡片当成新事件刷屏
  void checkTransitions()
  const unsubscribe = store.subscribe(() => { void checkTransitions() })

  return {
    checkTransitions,
    dispose() {
      unsubscribe()
      prevState.clear()
    },
  }
}
