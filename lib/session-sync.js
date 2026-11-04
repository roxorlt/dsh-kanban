// 会话运行失败同步（v0.9.6）。
// 监听宿主 session/event 的 turn/end：会话某一轮以失败结束时，把失败写回卡片时间线；
// 卡片处于「进行中」时自动置为「失败」（进「待你确认」列），之后同一会话下一轮正常完成
// 自动解除失败标记回「进行中」。只同步卡片主会话（第一个绑定会话），不碰其它会话。
// 判定口径与 DSH 聊天界面的「本轮运行失败」一致：error / aborted(signed-out) / interrupted。
import {
  cardsByMainSession,
  isSettledCard,
  recordSessionTurnFailure,
  recordSessionTurnMetrics,
  recordSessionTurnRecovered,
  recordSessionTurnStart,
} from './domain.js'

const SEARCH_TOOL_PATTERN = /search|grep|find|web|browser|fetch/i

function isSearchToolName(name) {
  return typeof name === 'string' && SEARCH_TOOL_PATTERN.test(name)
}

function extractUsageTokens(data) {
  const usage = (data && typeof data === 'object' ? (data.usage || data.reason?.usage || data.metrics) : null) || {}
  const tokensIn = Number(usage.inputTokens ?? usage.promptTokens ?? usage.tokensIn ?? 0)
  const tokensOut = Number(usage.outputTokens ?? usage.completionTokens ?? usage.tokensOut ?? 0)
  return {
    tokensIn: Number.isFinite(tokensIn) && tokensIn > 0 ? Math.floor(tokensIn) : 0,
    tokensOut: Number.isFinite(tokensOut) && tokensOut > 0 ? Math.floor(tokensOut) : 0,
  }
}

/** 只保留事件里的必要字段，避免把宿主对象/大 payload 带进数据文件。 */
export function turnFailureOf(reason) {
  if (!reason || typeof reason !== 'object') return null
  if (reason.kind === 'error') {
    const error = reason.error && typeof reason.error === 'object' ? reason.error : {}
    const message = typeof error.message === 'string' && error.message.trim() ? error.message.trim() : '未知错误'
    return {
      reasonKind: 'error',
      message,
      ...(typeof error.code === 'string' && error.code.trim() ? { code: error.code.trim() } : {}),
    }
  }
  if (reason.kind === 'interrupted') {
    return { reasonKind: 'interrupted', message: 'DSH 进程在本轮结束前退出', code: 'INTERRUPTED' }
  }
  if (reason.kind === 'aborted' && reason.reason && reason.reason.kind === 'hook' && reason.reason.reason === 'deepseek-account/signed-out') {
    return { reasonKind: 'aborted', message: '已退出 DeepSeek 账号，本轮中止', code: 'ACCOUNT_SIGNED_OUT' }
  }
  return null
}

function normalizeTurn(value) {
  const turn = Number(value)
  return Number.isInteger(turn) && turn >= 1 ? turn : null
}

/**
 * 生成 session/event 监听器：只在 turn/end 且与某卡片主会话相关时才写 store。
 * 返回 async handler；任何异常都吞掉并记日志，绝不向宿主事件派发抛错。
 */
export function createSessionTurnSync({ store, logger, watchdog, onSessionTurnStart } = {}) {
  const warn = message => { try { logger?.warn?.(`[dsh-kanban] ${message}`) } catch {} }
  const info = message => { try { logger?.info?.(`[dsh-kanban] ${message}`) } catch {} }
  if (!store || typeof store.update !== 'function' || typeof store.read !== 'function') return async () => {}

  // 按会话维护本轮计量累加器（M3 会话事件自动填充卡片计量）
  const turnStats = new Map()

  return async function handleSessionEvent(session, event) {
    try {
      if (!event || typeof event.type !== 'string') return
      const sessionId = session && session.id
      if (typeof sessionId !== 'string' || !sessionId) return
      const at = Number.isFinite(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : Date.now()

      if (event.type === 'tool/call' || event.type === 'tool_call' || event.type === 'tool/start') {
        const current = turnStats.get(sessionId) || { startedAt: 0, toolCalls: 0, searches: 0 }
        current.toolCalls += 1
        const toolName = event.data?.name || event.data?.toolName || event.data?.tool?.name || ''
        if (isSearchToolName(toolName)) current.searches += 1
        turnStats.set(sessionId, current)
        return
      }

      if (event.type !== 'turn/end' && event.type !== 'turn/start') return

      if (event.type === 'turn/start') {
        turnStats.set(sessionId, { startedAt: at, toolCalls: 0, searches: 0 })
        if (typeof onSessionTurnStart === 'function') {
          try { await onSessionTurnStart(session, event) } catch {}
        }
        if (watchdog && typeof watchdog.handleSessionEvent === 'function') {
          await watchdog.handleSessionEvent(session, event)
        }
        const cached = typeof store.peek === 'function' ? store.peek() : null
        const snapshot = cached || await store.read()
        if (!snapshot) return
        const relevant = cardsByMainSession(snapshot, sessionId)
        if (!relevant.length) return
        const hasBacklog = relevant.some(card => card.status === 'backlog')
        const hasOpen = relevant.some(card => !isSettledCard(card))
        const hasDoneToReopen = !hasOpen && relevant.some(card => card.status === 'done')
        if (!hasBacklog && !hasDoneToReopen) return
        const turn = normalizeTurn(event.data && event.data.turn)
        const { result } = await store.update(draft => recordSessionTurnStart(draft, {
          sessionId,
          ...(turn !== null ? { turn } : {}),
          ...(Number.isInteger(event.seq) ? { seq: event.seq } : {}),
          at,
        }))
        const cards = result && Array.isArray(result.cards) ? result.cards : []
        if (cards.length) info(`会话 ${sessionId} 开始运行，已自动推进 ${cards.length} 张卡片到「进行中」`)
        return
      }

      const stats = turnStats.get(sessionId)
      turnStats.delete(sessionId)
      const reason = event.data ? event.data.reason : undefined
      const failure = turnFailureOf(reason)
      const recovered = !failure && reason !== undefined && reason !== null && typeof reason === 'object' && reason.kind === 'completed'
      if (!failure && !recovered) return
      const turn = normalizeTurn(event.data && event.data.turn)
      if (turn === null) return

      const elapsedMs = stats?.startedAt && at > stats.startedAt ? Math.max(0, Math.floor(at - stats.startedAt)) : 0
      const toolCalls = stats?.toolCalls || 0
      const searches = stats?.searches || 0
      const { tokensIn, tokensOut } = extractUsageTokens(event.data)
      const hasMetrics = toolCalls > 0 || searches > 0 || elapsedMs > 0 || tokensIn > 0 || tokensOut > 0

      // 先看缓存快照，避免与该会话无关（或无需改状态）的 turn/end 触发无意义的全量写盘。
      const cached = typeof store.peek === 'function' ? store.peek() : null
      const snapshot = cached || await store.read()
      if (!snapshot) return
      const relevant = cardsByMainSession(snapshot, sessionId)
      if (!relevant.length) return

      const needsStatusSync = !recovered || relevant.some(card => card.status === 'failed')
      const needsMetricsSync = hasMetrics && relevant.some(card => card.status === 'running')

      if (needsStatusSync || needsMetricsSync) {
        const input = {
          sessionId,
          turn,
          at,
          ...(Number.isInteger(event.seq) ? { seq: event.seq } : {}),
          ...(failure || {}),
        }
        const { result } = await store.update(draft => {
          const statusRes = needsStatusSync
            ? (failure ? recordSessionTurnFailure(draft, input) : recordSessionTurnRecovered(draft, input))
            : { cards: [], activities: [] }
          if (needsMetricsSync) {
            recordSessionTurnMetrics(draft, {
              sessionId,
              turn,
              toolCalls,
              searches,
              elapsedMs,
              tokensIn,
              tokensOut,
              at,
            })
          }
          return statusRes
        })
        const cards = result && Array.isArray(result.cards) ? result.cards : []
        if (cards.length) info(`会话 ${sessionId} 第 ${turn} 轮${failure ? '失败' : '完成'}，已同步 ${cards.length} 张卡片`)
      }

      if (watchdog && typeof watchdog.handleSessionEvent === 'function') {
        await watchdog.handleSessionEvent(session, event)
      }
    } catch (error) {
      warn(`会话运行状态同步失败：${error && error.message ? error.message : error}`)
    }
  }
}

/**
 * 把监听器挂到宿主事件上（插件卸载时由 Cordis fiber 自动摘除）。
 * global：session/event 由会话所属上下文派发，插件需要跨上下文接收；
 * 与 DSH 自身 api-session-controller 的订阅方式一致。
 */
export function registerSessionTurnSync(ctx, options = {}) {
  if (!ctx || typeof ctx.on !== 'function') return () => {}
  const handle = createSessionTurnSync(options)
  return ctx.on('session/event', handle, { global: true })
}
