// Super-Agent 原生独立微信通道适配器（腾讯 iLink Bot HTTP/JSON 长轮询协议，零外部 npm 依赖）：
// 参考 cc2im (src/plugins/weixin/* + @pinixai/weixin-bot) 的微信连接实现，将 dsh-kanban 直接与个人微信打通：
// 1) 扫码登录：`GET /ilink/bot/get_bot_qrcode?bot_type=3` + `GET /ilink/bot/get_qrcode_status`；
// 2) 入站长轮询：`POST /ilink/bot/getupdates`（40s 长轮询，收到用户文本/语音转写后缓存 `context_token` 并交由 `handleIngressEvent` 路由到看板）；
// 3) 出站直推：`POST /ilink/bot/sendmessage`（自动按 2000 字自然边界分片，携带缓存的 `context_token` 下发消息）；
// 4) 凭证与上下文严格隔离在用户数据目录 `<dataDir>/weixin/{credentials.json,context.json}`（0600 权限），绝不进入代码仓。

import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { classifySuperAgentIntent, formatImNotification, handleIngressEvent } from './im-gateway.js'

export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_CHANNEL_VERSION = '1.0.0'
export const WEIXIN_SESSION_EXPIRED_ERRCODE = -14
export const WEIXIN_MAX_CHUNK_CHARS = 2000

const INITIAL_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 30_000
const SESSION_PAUSE_MS = 60_000

function ensureTrailingSlash(url) {
  const base = String(url || DEFAULT_WEIXIN_BASE_URL).trim() || DEFAULT_WEIXIN_BASE_URL
  return base.endsWith('/') ? base : `${base}/`
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

export function buildWeixinHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  }
  if (token && String(token).trim()) {
    headers.Authorization = `Bearer ${String(token).trim()}`
  }
  return headers
}

// ---------------- 凭证与 Context Token 本地安全存储（0600） ----------------

export function weixinCredentialsPath(dataDir, customPath) {
  if (customPath) return customPath
  return dataDir ? join(dataDir, 'weixin', 'credentials.json') : null
}

export function weixinContextPath(dataDir, customPath) {
  if (customPath) return customPath
  return dataDir ? join(dataDir, 'weixin', 'context.json') : null
}

export function loadWeixinCredentials(dataDir, customPath) {
  const file = weixinCredentialsPath(dataDir, customPath)
  if (!file || !existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw?.token || !raw?.accountId) return null
    return {
      token: String(raw.token),
      baseUrl: String(raw.baseUrl || DEFAULT_WEIXIN_BASE_URL),
      accountId: String(raw.accountId),
      userId: String(raw.userId || ''),
      savedAt: raw.savedAt || null,
    }
  } catch {
    return null
  }
}

export function saveWeixinCredentials(dataDir, creds, customPath) {
  const file = weixinCredentialsPath(dataDir, customPath)
  if (!file) throw new Error('缺少 dataDir，无法保存微信凭证')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const normalized = {
    token: String(creds.token || ''),
    baseUrl: String(creds.baseUrl || DEFAULT_WEIXIN_BASE_URL),
    accountId: String(creds.accountId || ''),
    userId: String(creds.userId || ''),
    savedAt: creds.savedAt || new Date().toISOString(),
  }
  writeFileSync(file, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return normalized
}

export function loadWeixinContext(dataDir, customPath) {
  const file = weixinContextPath(dataDir, customPath)
  if (!file || !existsSync(file)) {
    return { tokens: {}, syncBuf: '' }
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    // 兼容两种存储形态：
    // 1) { tokens: { [userId]: token }, syncBuf: "..." }
    // 2) cc2im 平面字典 { [userId]: token }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.tokens && typeof raw.tokens === 'object') {
        return {
          tokens: { ...raw.tokens },
          syncBuf: typeof raw.syncBuf === 'string' ? raw.syncBuf : '',
        }
      }
      const flatTokens = {}
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && v) flatTokens[k] = v
      }
      return { tokens: flatTokens, syncBuf: '' }
    }
  } catch {}
  return { tokens: {}, syncBuf: '' }
}

export function saveWeixinContext(dataDir, state, customPath) {
  const file = weixinContextPath(dataDir, customPath)
  if (!file) return
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const payload = {
    tokens: state?.tokens && typeof state.tokens === 'object' ? state.tokens : {},
    syncBuf: typeof state?.syncBuf === 'string' ? state.syncBuf : '',
    updatedAt: Date.now(),
  }
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

// ---------------- 长文本自然分片（对齐 cc2im chunker） ----------------

export function splitWeixinChunks(text, maxChars = WEIXIN_MAX_CHUNK_CHARS) {
  const src = String(text || '')
  if (src.length <= maxChars) return [src]

  const chunks = []
  let remaining = src
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars)
    let splitIdx = slice.lastIndexOf('\n\n')
    if (splitIdx <= 0) splitIdx = slice.lastIndexOf('\n')
    if (splitIdx <= 0) splitIdx = slice.lastIndexOf(' ')
    if (splitIdx <= 0) splitIdx = maxChars
    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '')
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

export function formatWeixinChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length <= 1) return chunks || []
  const total = chunks.length
  return chunks.map((chunk, i) => `${chunk}\n\n(${i + 1}/${total})`)
}

// ---------------- 腾讯 iLink Bot 底层 HTTP API ----------------

export async function fetchWeixinQrCode({
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  botType = '3',
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, ensureTrailingSlash(baseUrl))
  const res = await fetchImpl(url.toString(), { method: 'GET' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`获取微信二维码失败：HTTP ${res.status} ${body}`)
  }
  const data = await res.json()
  return {
    qrcode: data.qrcode || '',
    qrcodeUrl: data.qrcode_img_content || '',
  }
}

export async function pollWeixinQrStatus(qrcode, {
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  timeoutMs = 35_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, ensureTrailingSlash(baseUrl))
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`轮询微信扫码状态失败：HTTP ${res.status} ${body}`)
    }
    const data = await res.json()
    return {
      status: data.status || 'wait',
      botToken: data.bot_token || undefined,
      accountId: data.ilink_bot_id || undefined,
      baseUrl: data.baseurl || baseUrl,
      userId: data.ilink_user_id || undefined,
    }
  } catch (error) {
    clearTimeout(timer)
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'wait' }
    }
    throw error
  }
}

async function postWeixinApi({
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  endpoint,
  bodyObj,
  token,
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch,
}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const url = new URL(endpoint, ensureTrailingSlash(baseUrl))
    const body = JSON.stringify({
      ...bodyObj,
      base_info: { channel_version: WEIXIN_CHANNEL_VERSION },
    })
    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: buildWeixinHeaders(token),
      body,
      signal: controller.signal,
    })
    clearTimeout(timer)
    const rawText = await res.text()
    if (!res.ok) {
      throw new Error(`${endpoint} HTTP ${res.status}: ${rawText}`)
    }
    return rawText ? JSON.parse(rawText) : {}
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
}

export async function weixinGetUpdates({
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  token,
  getUpdatesBuf = '',
  timeoutMs = 40_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    return await postWeixinApi({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      bodyObj: { get_updates_buf: getUpdatesBuf },
      token,
      timeoutMs,
      fetchImpl,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
    }
    throw error
  }
}

export async function weixinSendSingleMessage({
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  token,
  toUserId,
  text,
  contextToken,
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!token) throw new Error('微信 bot_token 为空，无法发送消息')
  if (!toUserId) throw new Error('微信目标 toUserId 为空')
  if (!contextToken) throw new Error('缺少微信会话 context_token（需用户先向机器人发过消息）')

  const clientId = crypto.randomUUID()
  const resp = await postWeixinApi({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    bodyObj: {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: text ? [{ type: 1, text_item: { text } }] : undefined,
      },
    },
    token,
    timeoutMs,
    fetchImpl,
  })
  const ok = (resp.ret === undefined || resp.ret === 0) && (resp.errcode === undefined || resp.errcode === 0)
  return { ok, clientId, response: resp }
}

export async function weixinSendMessage({
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  token,
  toUserId,
  text,
  contextToken,
  maxChunkChars = WEIXIN_MAX_CHUNK_CHARS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const chunks = formatWeixinChunks(splitWeixinChunks(text, maxChunkChars))
  const receipts = []
  for (const chunk of chunks) {
    const sent = await weixinSendSingleMessage({
      baseUrl,
      token,
      toUserId,
      text: chunk,
      contextToken,
      fetchImpl,
    })
    receipts.push(sent)
    if (!sent.ok) {
      return { ok: false, chunks: chunks.length, receipts, response: sent.response }
    }
  }
  return {
    ok: true,
    chunks: chunks.length,
    clientId: receipts[receipts.length - 1]?.clientId || null,
    receipts,
  }
}

export function extractWeixinInboundMessage(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.message_type !== 1) return null // 仅处理 USER 消息（1 = USER, 2 = BOT）
  const fromUserId = String(raw.from_user_id || '').trim()
  if (!fromUserId) return null

  let text = ''
  const items = Array.isArray(raw.item_list) ? raw.item_list : []
  for (const item of items) {
    if (item?.type === 1 && item.text_item?.text != null) {
      const content = String(item.text_item.text)
      const ref = item.ref_msg
      if (ref && ref.message_item?.type === 1 && ref.message_item.text_item?.text) {
        const parts = []
        if (ref.title) parts.push(ref.title)
        parts.push(ref.message_item.text_item.text)
        text = `[引用: ${parts.join(' | ')}]\n${content}`
      } else {
        text = content
      }
      break
    }
    if (item?.type === 3 && item.voice_item?.text) {
      text = String(item.voice_item.text)
      break
    }
  }

  return {
    id: String(raw.message_id ?? raw.seq ?? `${fromUserId}:${raw.create_time_ms || Date.now()}`),
    userId: fromUserId,
    text: text.trim(),
    contextToken: typeof raw.context_token === 'string' ? raw.context_token : '',
    timestampMs: Number(raw.create_time_ms) || Date.now(),
  }
}

// ---------------- 看板原生独立微信通道实例 ----------------

/** 将模型输出的轻量 Markdown 净化为适合个人微信阅读的纯文本排版。 */
export function formatWeixinPlainReply(raw = '') {
  return String(raw || '')
    .replace(/^#{1,6}\s+(.+)$/gm, '【$1】')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function createWeixinChannel({
  store,
  dataDir,
  enabled = false,
  pollEnabled = true,
  allowedUsers = [],
  defaultUserId = '',
  credentialsPath,
  contextPath,
  fetchImpl = globalThis.fetch,
  askAgent,
  logger,
} = {}) {
  let running = false
  let loopPromise = null
  let stopController = null
  let sessionExpired = false
  let lastError = null
  let lastInboundAt = null
  let lastOutboundAt = null
  let inboundCount = 0
  let outboundCount = 0
  let activeQrSession = null

  const seenIds = new Set()
  const seenQueue = []
  const allowedSet = new Set((Array.isArray(allowedUsers) ? allowedUsers : []).filter(Boolean))

  function rememberMessageId(id) {
    if (!id) return false
    if (seenIds.has(id)) return true
    seenIds.add(id)
    seenQueue.push(id)
    if (seenQueue.length > 250) {
      const oldest = seenQueue.shift()
      if (oldest) seenIds.delete(oldest)
    }
    return false
  }

  function getCredentials() {
    return loadWeixinCredentials(dataDir, credentialsPath)
  }

  function getContextState() {
    return loadWeixinContext(dataDir, contextPath)
  }

  function resolveTargetUserId(explicitUserId, creds, ctxState) {
    if (explicitUserId && String(explicitUserId).trim()) return String(explicitUserId).trim()
    if (defaultUserId && String(defaultUserId).trim()) return String(defaultUserId).trim()
    if (creds?.userId && ctxState?.tokens?.[creds.userId]) return creds.userId
    const knownUsers = Object.keys(ctxState?.tokens || {})
    return knownUsers[0] || creds?.userId || ''
  }

  async function sendText(toUserId, text) {
    const creds = getCredentials()
    if (!creds?.token) {
      return {
        ok: false,
        code: 'WEIXIN_NOT_LOGGED_IN',
        error: '微信通道尚未扫码登录（请运行 `node bin/kanban-weixin-login.mjs` 或调用 `/api/kanban/im/weixin/qr` 扫码绑定）',
      }
    }
    const ctxState = getContextState()
    const targetUser = resolveTargetUserId(toUserId, creds, ctxState)
    if (!targetUser) {
      return {
        ok: false,
        code: 'WEIXIN_NO_TARGET_USER',
        error: '尚未指定微信接收人 userId（请先在微信向机器人发送一条消息以激活上下文）',
      }
    }
    const contextToken = ctxState.tokens?.[targetUser]
    if (!contextToken) {
      return {
        ok: false,
        code: 'WEIXIN_NO_CONTEXT_TOKEN',
        userId: targetUser,
        error: `缺少微信用户 ${targetUser} 的 context_token（请先在微信向机器人发送任意一条消息激活对话）`,
      }
    }
    try {
      const sent = await weixinSendMessage({
        baseUrl: creds.baseUrl,
        token: creds.token,
        toUserId: targetUser,
        text,
        contextToken,
        fetchImpl,
      })
      if (sent.ok) {
        lastOutboundAt = Date.now()
        outboundCount += 1
      } else {
        lastError = `sendmessage failed: ${JSON.stringify(sent.response || {})}`
      }
      return {
        ok: sent.ok,
        userId: targetUser,
        accountId: creds.accountId,
        chunks: sent.chunks,
        clientId: sent.clientId,
        ...(sent.ok ? {} : { error: lastError, response: sent.response }),
      }
    } catch (error) {
      lastError = error?.message || String(error)
      return {
        ok: false,
        userId: targetUser,
        error: lastError,
      }
    }
  }

  async function sendNotification(event = {}, { userId, format = 'card' } = {}) {
    const formatted = formatImNotification(event, {
      provider: 'weixin',
      format,
    })
    const res = await sendText(userId, formatted.text)
    return {
      ...res,
      provider: 'weixin',
      template: formatted.template,
      text: formatted.text,
    }
  }

  async function handleRawUpdateMessage(rawMsg) {
    const parsed = extractWeixinInboundMessage(rawMsg)
    if (!parsed) return { handled: false, reason: 'ignored_message_type' }
    if (rememberMessageId(parsed.id)) return { handled: false, reason: 'duplicate' }
    if (allowedSet.size > 0 && !allowedSet.has(parsed.userId)) {
      return { handled: false, reason: 'user_not_allowed', userId: parsed.userId }
    }

    // 持久化最新 context_token，供回复及后续异步看板通知使用
    if (parsed.contextToken) {
      const ctxState = getContextState()
      ctxState.tokens[parsed.userId] = parsed.contextToken
      // 默认使用独立 contextPath（不反向覆盖外部只读共享路径，除非写入的是看板自有目录）
      saveWeixinContext(dataDir, ctxState)
    }

    if (!parsed.text) return { handled: false, reason: 'empty_text', userId: parsed.userId }
    lastInboundAt = Date.now()
    inboundCount += 1

    if (!store || typeof store.update !== 'function') {
      return { handled: false, reason: 'no_store' }
    }

    const externalThreadId = `weixin:${parsed.userId}`
    const snapshot = (typeof store.peek === 'function' ? store.peek() : null) || await store.read()
    const preDecision = classifySuperAgentIntent(snapshot, {
      provider: 'weixin',
      externalThreadId,
      text: parsed.text,
    }, { dataDir })

    // 非明确审批指令（查板、卡点分析、通用问答、自然语言派活等）优先交由常驻 ★ Super Agent 会话执行真实工具调用与推理
    if (preDecision.route !== 'approval_reply' && typeof askAgent === 'function') {
      try {
        const agentOutcome = await askAgent({
          provider: 'weixin',
          userId: parsed.userId,
          externalThreadId,
          text: parsed.text,
          decision: preDecision,
        })
        if (agentOutcome?.ok && agentOutcome.replyText) {
          const cleanReply = formatWeixinPlainReply(agentOutcome.replyText)
          const replySent = cleanReply ? await sendText(parsed.userId, cleanReply) : null
          return {
            handled: true,
            userId: parsed.userId,
            route: 'super_agent',
            decisionRoute: preDecision.route,
            sessionId: agentOutcome.sessionId || null,
            toolCalls: agentOutcome.toolCalls || 0,
            cardId: null,
            replyText: cleanReply,
            replySent,
          }
        }
      } catch (agentErr) {
        try { logger?.warn?.(`[dsh-kanban:weixin] Super Agent 推理回退本地网关：${agentErr?.message || agentErr}`) } catch {}
      }
    }

    const { result } = await store.update(draft => handleIngressEvent(draft, {
      provider: 'weixin',
      externalThreadId,
      senderName: '微信用户',
      text: parsed.text,
    }, { dataDir }))

    let replySent = null
    if (result?.replyText) {
      replySent = await sendText(parsed.userId, result.replyText)
    }
    return {
      handled: true,
      userId: parsed.userId,
      route: result?.decision?.route || result?.kind || 'unknown',
      cardId: result?.card?.id || null,
      replyText: result?.replyText || '',
      replySent,
    }
  }

  async function runPollLoop(signal) {
    let backoffMs = INITIAL_BACKOFF_MS
    while (running && !signal.aborted) {
      const creds = getCredentials()
      if (!creds?.token || !pollEnabled) {
        await sleepWithSignal(5000, signal)
        continue
      }
      const ctxState = getContextState()
      try {
        const pollStartedAt = Date.now()
        const resp = await weixinGetUpdates({
          baseUrl: creds.baseUrl,
          token: creds.token,
          getUpdatesBuf: ctxState.syncBuf || '',
          timeoutMs: 38_000,
          fetchImpl,
        })

        const isApiErr = (typeof resp.ret === 'number' && resp.ret !== 0)
          || (typeof resp.errcode === 'number' && resp.errcode !== 0)
        if (isApiErr) {
          const code = resp.errcode ?? resp.ret
          lastError = `getupdates errcode=${code} errmsg=${resp.errmsg || ''}`
          if (code === WEIXIN_SESSION_EXPIRED_ERRCODE) {
            sessionExpired = true
            try { logger?.warn?.('[dsh-kanban:weixin] 微信会话已过期（-14），暂停轮询 60s，请重新扫码登录') } catch {}
            await sleepWithSignal(SESSION_PAUSE_MS, signal)
            continue
          }
          await sleepWithSignal(backoffMs, signal)
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
          continue
        }

        sessionExpired = false
        backoffMs = INITIAL_BACKOFF_MS

        if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf && resp.get_updates_buf !== ctxState.syncBuf) {
          const latestCtx = getContextState()
          latestCtx.syncBuf = resp.get_updates_buf
          saveWeixinContext(dataDir, latestCtx)
        }

        const msgs = Array.isArray(resp.msgs) ? resp.msgs : []
        for (const rawMsg of msgs) {
          if (signal.aborted || !running) break
          try {
            await handleRawUpdateMessage(rawMsg)
          } catch (msgErr) {
            lastError = msgErr?.message || String(msgErr)
            try { logger?.warn?.(`[dsh-kanban:weixin] 处理入站消息异常：${lastError}`) } catch {}
          }
        }
        // 防紧循环保护：若远端异常秒回空包（或单测同步 mock），至少让出 250ms 避免占满事件循环
        const elapsed = Date.now() - pollStartedAt
        if (msgs.length === 0 && elapsed < 250 && running && !signal.aborted) {
          await sleepWithSignal(250 - elapsed, signal)
        }
      } catch (error) {
        if (signal.aborted || !running) break
        lastError = error?.message || String(error)
        await sleepWithSignal(backoffMs, signal)
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      }
    }
  }

  async function startQrLogin({ baseUrl = DEFAULT_WEIXIN_BASE_URL } = {}) {
    const qr = await fetchWeixinQrCode({ baseUrl, fetchImpl })
    activeQrSession = {
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcodeUrl,
      baseUrl,
      createdAt: Date.now(),
      status: 'wait',
    }
    return activeQrSession
  }

  async function checkQrLogin(qrcode) {
    const targetQr = qrcode || activeQrSession?.qrcode
    if (!targetQr) {
      throw new Error('当前没有进行中的微信扫码会话，请先请求生成二维码')
    }
    const baseUrl = activeQrSession?.baseUrl || DEFAULT_WEIXIN_BASE_URL
    const polled = await pollWeixinQrStatus(targetQr, { baseUrl, timeoutMs: 12_000, fetchImpl })
    if (activeQrSession && activeQrSession.qrcode === targetQr) {
      activeQrSession.status = polled.status
    }
    if (polled.status === 'confirmed' && polled.botToken && polled.accountId) {
      const saved = saveWeixinCredentials(dataDir, {
        token: polled.botToken,
        baseUrl: polled.baseUrl || baseUrl,
        accountId: polled.accountId,
        userId: polled.userId || '',
      }, credentialsPath)
      enabled = true
      sessionExpired = false
      lastError = null
      activeQrSession = null
      if (!running && pollEnabled) {
        start()
      }
      return {
        status: 'confirmed',
        loggedIn: true,
        accountId: saved.accountId,
        userId: saved.userId,
        baseUrl: saved.baseUrl,
      }
    }
    return {
      status: polled.status,
      loggedIn: false,
      qrcode: targetQr,
      qrcodeUrl: activeQrSession?.qrcodeUrl || undefined,
    }
  }

  function start() {
    if (running) return api
    running = true
    stopController = new AbortController()
    if (pollEnabled) {
      loopPromise = runPollLoop(stopController.signal).catch(() => {})
    }
    return api
  }

  function stop() {
    running = false
    if (stopController) {
      try { stopController.abort() } catch {}
      stopController = null
    }
    void loopPromise
  }

  function status() {
    const creds = getCredentials()
    const ctxState = getContextState()
    const contextUsers = Object.keys(ctxState.tokens || {})
    return {
      enabled: Boolean(enabled),
      running,
      pollEnabled: Boolean(pollEnabled),
      loggedIn: Boolean(creds?.token),
      sessionExpired,
      accountId: creds?.accountId || null,
      userId: creds?.userId || null,
      defaultUserId: resolveTargetUserId('', creds, ctxState) || null,
      contextUserCount: contextUsers.length,
      inboundCount,
      outboundCount,
      lastInboundAt,
      lastOutboundAt,
      lastError,
      activeQr: activeQrSession
        ? {
          qrcode: activeQrSession.qrcode,
          status: activeQrSession.status,
          createdAt: activeQrSession.createdAt,
          qrcodeUrl: activeQrSession.qrcodeUrl,
        }
        : null,
    }
  }

  function setEnabled(nextEnabled, nextPollEnabled = pollEnabled) {
    enabled = Boolean(nextEnabled)
    pollEnabled = Boolean(nextPollEnabled)
    if (enabled && pollEnabled && getCredentials()?.token) {
      if (!running) start()
    } else if (!enabled && running) {
      stop()
    }
    return status()
  }

  function logout() {
    stop()
    enabled = false
    sessionExpired = false
    lastError = null
    activeQrSession = null
    const credFile = weixinCredentialsPath(dataDir, credentialsPath)
    if (credFile && existsSync(credFile)) {
      try { rmSync(credFile, { force: true }) } catch {}
    }
    return status()
  }

  const api = {
    start,
    stop,
    status,
    setEnabled,
    logout,
    startQrLogin,
    checkQrLogin,
    sendText,
    sendNotification,
    handleRawUpdateMessage,
  }
  return api
}

function sleepWithSignal(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
