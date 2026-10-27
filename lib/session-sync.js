// 会话运行失败同步（v0.9.6）。
// 监听宿主 session/event 的 turn/end：会话某一轮以失败结束时，把失败写回卡片时间线；
// 卡片处于「进行中」时自动置为「失败」（进「待你确认」列），之后同一会话下一轮正常完成
// 自动解除失败标记回「进行中」。只同步卡片主会话（第一个绑定会话），不碰其它会话。
// 判定口径与 DSH 聊天界面的「本轮运行失败」一致：error / aborted(signed-out) / interrupted。
import { cardsByMainSession, recordSessionTurnFailure, recordSessionTurnRecovered } from './domain.js'

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
export function createSessionTurnSync({ store, logger } = {}) {
  const warn = message => { try { logger?.warn?.(`[dsh-kanban] ${message}`) } catch {} }
  const info = message => { try { logger?.info?.(`[dsh-kanban] ${message}`) } catch {} }
  if (!store || typeof store.update !== 'function' || typeof store.read !== 'function') return async () => {}

  return async function handleSessionEvent(session, event) {
    try {
      if (!event || event.type !== 'turn/end') return
      const sessionId = session && session.id
      if (typeof sessionId !== 'string' || !sessionId) return
      const reason = event.data ? event.data.reason : undefined
      const failure = turnFailureOf(reason)
      const recovered = !failure && reason !== undefined && reason !== null && typeof reason === 'object' && reason.kind === 'completed'
      if (!failure && !recovered) return
      const turn = normalizeTurn(event.data && event.data.turn)
      if (turn === null) return

      // 先看缓存快照，避免与该会话无关（或无需改状态）的 turn/end 触发无意义的全量写盘。
      const cached = typeof store.peek === 'function' ? store.peek() : null
      const snapshot = cached || await store.read()
      if (!snapshot) return
      const relevant = cardsByMainSession(snapshot, sessionId)
      if (!relevant.length) return
      // 恢复只在仍有「失败」卡时才需要写盘（手工置失败的卡由 domain 再排除）。
      if (recovered && !relevant.some(card => card.status === 'failed')) return

      const input = {
        sessionId,
        turn,
        at: Number.isFinite(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : Date.now(),
        ...(Number.isInteger(event.seq) ? { seq: event.seq } : {}),
        ...(failure || {}),
      }
      const { result } = await store.update(draft => (
        failure ? recordSessionTurnFailure(draft, input) : recordSessionTurnRecovered(draft, input)
      ))
      const cards = result && Array.isArray(result.cards) ? result.cards : []
      if (cards.length) info(`会话 ${sessionId} 第 ${turn} 轮${failure ? '失败' : '完成'}，已同步 ${cards.length} 张卡片`)
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
