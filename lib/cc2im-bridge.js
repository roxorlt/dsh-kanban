// 本地 cc2im（微信 iLink Bot / 飞书 / Web 统一 Hub）原生 Spoke 桥接器：
//
// 工作原理（零侵入 cc2im 源码）：
// 1. 若 cc2im Web Monitor (`http://127.0.0.1:3721`) 在线且尚未注册 `kanban` Agent，
//    自动通过 `POST /api/onboard` 注册 `{ name: "kanban", cwd: dataDir, autoStart: false, startNow: false }`，
//    使微信端发送 `@kanban ...`（或设为默认路由）时，cc2im Router 能识别 `kanban` 而无需拉起任何 Claude Code 进程；
// 2. 通过 Unix Domain Socket 连接 `~/.cc2im/hub.sock`（换行分隔 JSON 协议）：
//    - 发送 `{"type":"register","agentId":"kanban"}\n`（不传 pid，防止 Hub 误杀 DSH 宿主进程）；
//    - 每 15s 发送 `{"type":"heartbeat","agentId":"kanban"}\n`（Hub 超时阈值为 45s）；
//    - 收到 `{"type":"message","userId":"...","text":"[weixin xxx] ..."}` 时：
//      剥离 `[channel uid] ` 前缀 → 走 `handleIngressEvent` 意图路由/建卡/查板/审批拍板 →
//      通过 `{"type":"reply","agentId":"kanban","userId":"...","text":"..."}\n` 实时回推给微信/Web 用户！
//    - 出站通知调用 `sendWechatText(text, userId)` 时，同样经由 `hub.sock` 发送 `reply` 帧直达微信。

import net from 'node:net'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { classifySuperAgentIntent, handleIngressEvent } from './im-gateway.js'
import { formatWeixinPlainReply } from './weixin-channel.js'

const CHANNEL_PREFIX_RE = /^\[([a-z0-9_-]+)\s+([^\]]+)\]\s*/i

/**
 * 从 `~/.cc2im/weixin-context*.json` 自动发现已知微信用户 ID（用于默认出站接收人兜底）。
 */
export function discoverKnownWechatUserIds(cc2imDir = join(homedir(), '.cc2im')) {
  if (!cc2imDir || !existsSync(cc2imDir)) return []
  const users = []
  try {
    const files = readdirSync(cc2imDir)
      .filter(name => name.startsWith('weixin-context') && name.endsWith('.json'))
      .sort((a, b) => (a === 'weixin-context.json' ? -1 : b === 'weixin-context.json' ? 1 : a.localeCompare(b)))
    for (const name of files) {
      try {
        const obj = JSON.parse(readFileSync(join(cc2imDir, name), 'utf8'))
        for (const uid of Object.keys(obj || {})) {
          if (uid && !users.includes(uid)) users.push(uid)
        }
      } catch {}
    }
  } catch {}
  return users
}

export function stripCc2imPrefix(rawText = '') {
  const str = String(rawText || '')
  const m = str.match(CHANNEL_PREFIX_RE)
  if (!m) return { channel: 'weixin', senderId: '', text: str.trim() }
  return {
    channel: m[1].toLowerCase(),
    senderId: m[2],
    text: str.slice(m[0].length).trim(),
  }
}

export function createCc2imBridge({
  store,
  dataDir,
  socketPath = join(homedir(), '.cc2im', 'hub.sock'),
  webUrl = 'http://127.0.0.1:3721',
  agentId = 'kanban',
  defaultUserId,
  heartbeatMs = 15_000,
  reconnectMs = 3_000,
  fetchImpl = globalThis.fetch,
  connectFn,
  onInboundReply,
  askAgent,
  logger,
} = {}) {
  let socket = null
  let connected = false
  let stopped = false
  let heartbeatTimer = null
  let reconnectTimer = null
  let buffer = ''
  let lastUserId = defaultUserId || null
  let onboarded = false
  const stats = {
    inboundCount: 0,
    outboundCount: 0,
    lastInboundAt: 0,
    lastOutboundAt: 0,
    lastError: null,
  }

  function sendFrame(frame) {
    if (!socket || socket.destroyed || !connected) return false
    try {
      socket.write(JSON.stringify(frame) + '\n')
      return true
    } catch (err) {
      stats.lastError = err?.message || String(err)
      return false
    }
  }

  /**
   * 确保 cc2im Hub 的 Router 认识 `@kanban`（不启动 Claude Code 子进程）。
   */
  async function ensureOnboarded() {
    if (onboarded || !webUrl || typeof fetchImpl !== 'function') return false
    const base = webUrl.replace(/\/$/, '')
    try {
      const listRes = await fetchImpl(`${base}/api/agents`).catch(() => null)
      if (!listRes || !listRes.ok) return false
      const listData = await listRes.json().catch(() => null)
      const exists = Array.isArray(listData?.agents) && listData.agents.some(a => a && a.name === agentId)
      if (exists) {
        onboarded = true
        return true
      }
      const onboardRes = await fetchImpl(`${base}/api/onboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: agentId,
          cwd: dataDir || join(homedir(), '.dsh-kanban'),
          autoStart: false,
          startNow: false,
        }),
      }).catch(() => null)
      if (onboardRes && onboardRes.ok) {
        onboarded = true
        return true
      }
    } catch (err) {
      stats.lastError = err?.message || String(err)
    }
    return false
  }

  async function handleHubFrame(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'shutdown') {
      return
    }
    if (msg.type !== 'message') return

    const userId = typeof msg.userId === 'string' && msg.userId ? msg.userId : (lastUserId || 'unknown')
    if (userId && !userId.startsWith('web-')) {
      lastUserId = userId
    } else if (!lastUserId) {
      lastUserId = userId
    }

    const parsed = stripCc2imPrefix(msg.text || '')
    stats.inboundCount += 1
    stats.lastInboundAt = Date.now()

    if (!store) return
    try {
      const provider = parsed.channel === 'web' ? 'weixin' : (parsed.channel || 'weixin')
      const externalThreadId = `weixin:${userId}`
      let result = null
      let replyText = ''

      const snapshot = (typeof store.peek === 'function' ? store.peek() : null) || await store.read()
      const preDecision = classifySuperAgentIntent(snapshot, {
        provider,
        externalThreadId,
        text: parsed.text,
      }, { dataDir })

      if (preDecision.route !== 'approval_reply' && typeof askAgent === 'function') {
        try {
          const agentOutcome = await askAgent({
            provider,
            userId,
            externalThreadId,
            text: parsed.text,
            decision: preDecision,
          })
          if (agentOutcome?.ok && agentOutcome.replyText) {
            replyText = formatWeixinPlainReply(agentOutcome.replyText)
            result = { kind: 'super_agent', decision: preDecision, sessionId: agentOutcome.sessionId, replyText }
          }
        } catch {}
      }

      if (!replyText) {
        const updated = await store.update(draft => handleIngressEvent(draft, {
          provider,
          text: parsed.text,
          externalThreadId,
          senderName: parsed.channel === 'web' ? 'cc2im Web' : `微信用户(${userId.slice(0, 8)})`,
        }, {
          now: Date.now(),
          dataDir,
        }))
        result = updated.result
        replyText = result?.replyText
          || result?.reply?.text?.content
          || result?.reply?.text
          || '已收到并处理。'
      }

      const sent = sendFrame({
        type: 'reply',
        agentId,
        userId,
        text: replyText,
      })
      if (sent) {
        stats.outboundCount += 1
        stats.lastOutboundAt = Date.now()
      }
      if (typeof onInboundReply === 'function') {
        try { onInboundReply({ userId, inboundText: parsed.text, replyText, result }) } catch {}
      }
    } catch (err) {
      stats.lastError = err?.message || String(err)
      sendFrame({
        type: 'reply',
        agentId,
        userId,
        text: `⚠️ 看板处理消息出错：${err?.message || String(err)}`,
      })
    }
  }

  function clearTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectMs)
    reconnectTimer.unref?.()
  }

  function connect() {
    if (stopped || connected || socket) return
    if (!connectFn && (!socketPath || !existsSync(socketPath))) {
      scheduleReconnect()
      return
    }

    void ensureOnboarded()

    const client = typeof connectFn === 'function' ? connectFn(socketPath) : net.createConnection(socketPath)
    socket = client
    buffer = ''

    client.on('connect', () => {
      if (stopped) {
        client.destroy()
        return
      }
      connected = true
      sendFrame({ type: 'register', agentId })
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = setInterval(() => {
        sendFrame({ type: 'heartbeat', agentId })
      }, heartbeatMs)
      heartbeatTimer.unref?.()
      try { logger?.info?.(`[dsh-kanban] 已连接本地 cc2im 微信 Hub (${socketPath})，spoke=@${agentId}`) } catch {}
    })

    client.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const frame = JSON.parse(line)
          void handleHubFrame(frame)
        } catch {}
      }
    })

    client.on('error', err => {
      stats.lastError = err?.message || String(err)
    })

    client.on('close', () => {
      connected = false
      socket = null
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      scheduleReconnect()
    })
  }

  function resolveTargetUserId(explicitUserId) {
    if (typeof explicitUserId === 'string' && explicitUserId.trim()) return explicitUserId.trim()
    if (lastUserId) return lastUserId
    if (defaultUserId) return defaultUserId
    const cc2imDir = socketPath ? dirname(socketPath) : join(homedir(), '.cc2im')
    const discovered = discoverKnownWechatUserIds(cc2imDir)
    return discovered[0] || null
  }

  /**
   * 主动向微信用户发送文本消息（通过 cc2im `hub.sock` `reply` 帧）。
   * 注：微信 iLink Bot 协议要求该用户近期在当前微信通道实例有过入站会话以缓存 `_contextToken`；
   * 若 Hub 尚未缓存该用户的 `_contextToken`，帧仍会送达 Hub，待用户在微信发一条 `@kanban 看板` 即自动激活双向会话。
   */
  async function sendWechatText(text, explicitUserId) {
    const targetUserId = resolveTargetUserId(explicitUserId)
    if (!targetUserId) {
      return { ok: false, reason: 'missing_wechat_user_id', error: '尚未发现可用的微信 userId，请先在微信发送 @kanban 看板' }
    }
    if (!connected) {
      connect()
      await new Promise(r => setTimeout(r, 150))
    }
    if (!connected) {
      return { ok: false, reason: 'hub_not_connected', socketPath, userId: targetUserId }
    }
    const sent = sendFrame({
      type: 'reply',
      agentId,
      userId: targetUserId,
      text: String(text || ''),
    })
    if (sent) {
      stats.outboundCount += 1
      stats.lastOutboundAt = Date.now()
    }
    return {
      ok: sent,
      userId: targetUserId,
      agentId,
      socketPath,
    }
  }

  function start() {
    stopped = false
    connect()
    return api
  }

  function stop() {
    stopped = true
    clearTimers()
    connected = false
    if (socket) {
      try { socket.destroy() } catch {}
      socket = null
    }
  }

  const api = {
    start,
    stop,
    ensureOnboarded,
    sendWechatText,
    isConnected: () => connected,
    status() {
      const cc2imDir = socketPath ? dirname(socketPath) : join(homedir(), '.cc2im')
      return {
        connected,
        onboarded,
        agentId,
        socketPath,
        socketExists: Boolean(socketPath && existsSync(socketPath)),
        webUrl,
        lastUserId,
        knownWechatUsers: discoverKnownWechatUserIds(cc2imDir),
        stats: { ...stats },
      }
    },
  }

  return api
}
