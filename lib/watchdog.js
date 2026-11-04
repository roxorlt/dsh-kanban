// Super-Agent Watchdog 巡检器（v0.27.0）：
// 1) 监听宿主 session/event 维护主会话轮次水位（turn/start → running，turn/end(completed) → idle，turn/end(error) → error）；
// 2) 只在存在待处理项（静默停滞已过 graceMs、瞬时错误待退避重试、时间窗口 waitCondition 已到期）时才进入 store.update 落盘；
// 3) 严格遵守有界预算（单代最多 1 次 Nudge 后熔断为 blocked；瞬时错误最多 2 次退避重试 [+15s, +60s] 后停止重试）。
import {
  SESSION_TURN_FAILURE, cardsByMainSession, evaluateWatchdog, getAutoAdvanceEnabled, isTerminalCardStatus,
  isTransientTurnError, mainSessionId, openChecklistItems, pendingApproval, recoverInterruptedRunningCards,
} from './domain.js'
import { turnFailureOf } from './session-sync.js'

function normalizeTurn(value) {
  const turn = Number(value)
  return Number.isInteger(turn) && turn >= 1 ? turn : null
}

function latestStatusReason(snapshot, cardId) {
  const activities = Array.isArray(snapshot?.activities) ? snapshot.activities : []
  for (let i = activities.length - 1; i >= 0; i -= 1) {
    const act = activities[i]
    if (act.cardId === cardId && act.type === 'status') return act.data?.reason || null
  }
  return null
}

function latestTurnFailureActivity(snapshot, cardId) {
  const activities = Array.isArray(snapshot?.activities) ? snapshot.activities : []
  for (let i = activities.length - 1; i >= 0; i -= 1) {
    const act = activities[i]
    if (act.cardId === cardId && act.type === 'error' && act.data?.kind === SESSION_TURN_FAILURE) return act
  }
  return null
}

/**
 * 只读预检：判断当前快照是否有需要 Watchdog 落盘处理的卡片，避免空转写盘。
 */
export function needsWatchdogAction(snapshot, {
  now = Date.now(),
  watermarks,
  graceMs = 30_000,
  maxRetries = 2,
  maxConcurrentRunning = 3,
} = {}) {
  if (!snapshot || !Array.isArray(snapshot.cards)) return false
  const getExternalWatermark = sessionId => {
    if (!sessionId || !watermarks) return null
    if (watermarks instanceof Map) return watermarks.get(sessionId) || null
    if (typeof watermarks === 'object') return watermarks[sessionId] || null
    return null
  }

  const autoAdvance = getAutoAdvanceEnabled(snapshot)
  const byId = new Map(snapshot.cards.filter(Boolean).map(item => [item.id, item]))
  const runningCount = snapshot.cards.filter(item => item && !item.archived && item.status === 'running').length
  const busySessions = new Set(
    snapshot.cards
      .filter(item => item && !item.archived && item.status === 'running')
      .map(item => mainSessionId(item))
      .filter(Boolean),
  )

  for (const card of snapshot.cards) {
    if (!card || card.archived) continue

    // 0A) done 卡片仍存在未完成 checklist（且无显式 forceComplete 记录）→ 需退回 backlog
    if (card.status === 'done') {
      const openItems = openChecklistItems(card)
      if (openItems.length > 0) {
        const wasForced = (snapshot.activities || []).some(
          act => act && act.cardId === card.id && act.data?.forceComplete === true,
        )
        if (!wasForced) return true
      }
      continue
    }

    if (!autoAdvance) continue

    // 1) 结构化时间窗口到期
    const waitCond = card.runtime?.waitCondition
    if (waitCond && waitCond.kind === 'time' && typeof waitCond.notBefore === 'number') {
      if (now >= waitCond.notBefore) return true
      continue
    }

    // 1B) 待办/受阻卡开启了 autoStart（或人类优先唤醒）且前置依赖已全部收口、并发槽位可用
    if ((card.status === 'backlog' || card.status === 'blocked') && !pendingApproval(card)) {
      const deps = Array.isArray(card.dependsOn) ? card.dependsOn.map(id => byId.get(id)) : []
      const depsReady = deps.every(dep => dep && isTerminalCardStatus(dep.status))
      const isPersonWake = card.runtime?.priorityWake === 'person' || card.priorityWake === 'person'
      const slotLimit = maxConcurrentRunning + (isPersonWake ? 1 : 0)
      if (depsReady && (card.autoStart === true || isPersonWake)) {
        const primarySess = mainSessionId(card)
        const sessionBusy = primarySess ? busySessions.has(primarySess) : false
        if (!sessionBusy && runningCount < slotLimit) return true
      }
      continue
    }

    // 2) 瞬时错误待排入重试或待写耗尽熔断
    if (card.status === 'failed' && latestStatusReason(snapshot, card.id) === SESSION_TURN_FAILURE) {
      const latestFailure = latestTurnFailureActivity(snapshot, card.id)
      if (latestFailure && isTransientTurnError(latestFailure.data?.code, latestFailure.data?.message)) {
        const errorTurn = Number(latestFailure.data?.turn) || 1
        const lastRetryTurn = card.runtime?.turnWatermark?.lastRetryTurn
        const retriesUsed = card.runtime?.budget?.retriesUsed ?? 0
        const lastExhausted = card.runtime?.turnWatermark?.lastRetryExhaustedTurn
        if (lastRetryTurn !== errorTurn && (retriesUsed < maxRetries || lastExhausted !== errorTurn)) {
          return true
        }
      }
      continue
    }

    // 3) 静默停滞已过 graceMs
    if (card.status !== 'running' || pendingApproval(card)) continue
    const sessionId = mainSessionId(card)
    if (!sessionId) continue
    const extWm = getExternalWatermark(sessionId)
    const storedWm = card.runtime?.turnWatermark
    const watermark = extWm && (!storedWm || Number(extWm.at || 0) >= Number(storedWm.at || 0))
      ? extWm
      : storedWm
    if (!watermark || watermark.phase !== 'idle') continue
    const wmTurn = Number(watermark.turn) || 0
    const wmAt = Number(watermark.at) || 0
    if (wmTurn < 1 || wmAt <= 0) continue
    if (card.startedAt && wmAt < card.startedAt) continue
    if (now - wmAt < graceMs) continue
    if (card.runtime?.turnWatermark?.lastHandledTurn === wmTurn) continue
    return true
  }
  return false
}

export function createWatchdog({
  store,
  logger,
  graceMs = 30_000,
  retryDelaysMs = [15_000, 60_000],
  maxNudges = 1,
  maxRetries = 2,
  maxConcurrentRunning = 3,
  nowFn = Date.now,
  autoSchedule = true,
} = {}) {
  const warn = message => { try { logger?.warn?.(`[dsh-kanban:watchdog] ${message}`) } catch {} }
  const info = message => { try { logger?.info?.(`[dsh-kanban:watchdog] ${message}`) } catch {} }
  const bootedAt = nowFn()
  const watermarks = new Map()
  const graceTimers = new Set()

  function clearGraceTimers() {
    for (const timer of graceTimers) clearTimeout(timer)
    graceTimers.clear()
  }

  async function tick(customNow) {
    if (!store || typeof store.update !== 'function' || typeof store.read !== 'function') {
      return { nudged: [], stalled: [], retried: [], resumed: [], reopened: [], started: [] }
    }
    try {
      const now = Number.isFinite(customNow) ? customNow : nowFn()
      const snapshot = await store.read()
      if (!needsWatchdogAction(snapshot, { now, watermarks, graceMs, maxRetries, maxConcurrentRunning })) {
        return { nudged: [], stalled: [], retried: [], resumed: [], reopened: [], started: [] }
      }
      const { result } = await store.update(draft => evaluateWatchdog(draft, {
        now,
        watermarks,
        graceMs,
        retryDelaysMs,
        maxNudges,
        maxRetries,
        maxConcurrentRunning,
      }))
      if (
        result.nudged.length || result.stalled.length || result.retried.length
        || result.resumed.length || result.reopened.length || result.started.length
      ) {
        info(
          `巡检完成：started=${result.started.length} reopened=${result.reopened.length} nudged=${result.nudged.length} stalled=${result.stalled.length} retried=${result.retried.length} resumed=${result.resumed.length}`,
        )
      }
      return result
    } catch (error) {
      warn(`巡检失败：${error?.message || error}`)
      return { nudged: [], stalled: [], retried: [], resumed: [], reopened: [], started: [] }
    }
  }

  function scheduleDelayedTick(delayMs) {
    if (!autoSchedule || !(delayMs > 0)) return
    const timer = setTimeout(() => {
      graceTimers.delete(timer)
      void tick()
    }, delayMs)
    timer.unref?.()
    graceTimers.add(timer)
  }

  async function handleSessionEvent(session, event) {
    try {
      if (!event || (event.type !== 'turn/start' && event.type !== 'turn/end')) return
      const sessionId = session && typeof session.id === 'string' ? session.id.trim() : ''
      if (!sessionId) return
      const at = Number.isFinite(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : nowFn()
      const turn = normalizeTurn(event.data?.turn) || 1

      if (event.type === 'turn/start') {
        watermarks.set(sessionId, { sessionId, turn, phase: 'running', at })
        return
      }

      const reason = event.data?.reason
      const failure = turnFailureOf(reason)
      const completed = !failure && reason && typeof reason === 'object' && reason.kind === 'completed'

      if (completed) {
        watermarks.set(sessionId, { sessionId, turn, phase: 'idle', at })
        const cached = typeof store?.peek === 'function' ? store.peek() : null
        const snapshot = cached || (typeof store?.read === 'function' ? await store.read() : null)
        if (snapshot && cardsByMainSession(snapshot, sessionId).some(card => card.status === 'running')) {
          scheduleDelayedTick(graceMs + 50)
        }
        return
      }

      if (failure && isTransientTurnError(failure.code, failure.message)) {
        watermarks.set(sessionId, {
          sessionId,
          turn,
          phase: 'error',
          at,
          ...(failure.code ? { code: failure.code } : {}),
        })
        await tick(at)
      }
    } catch (error) {
      warn(`处理会话事件失败：${error?.message || error}`)
    }
  }

  async function recoverInterruptedRuns({ activeSessionIds = [], customBootedAt } = {}) {
    if (!store || typeof store.update !== 'function' || typeof store.read !== 'function') {
      return { recovered: [] }
    }
    try {
      const effectiveBoot = Number.isFinite(customBootedAt) ? customBootedAt : bootedAt
      const snap = await store.read()
      if (!getAutoAdvanceEnabled(snap)) return { recovered: [] }
      const hasCandidate = (snap.cards || []).some(c => (
        c && !c.archived && c.status === 'running' && !pendingApproval(c)
        && c.runtime?.turnWatermark?.phase === 'running'
        && Number(c.runtime?.turnWatermark?.at || 0) > 0
        && Number(c.runtime?.turnWatermark?.at || 0) < effectiveBoot
      ))
      if (!hasCandidate) return { recovered: [] }
      const { result } = await store.update(draft => recoverInterruptedRunningCards(draft, {
        bootedAt: effectiveBoot,
        activeSessionIds,
        now: nowFn(),
      }))
      if (result.recovered.length) {
        info(`检测到宿主重启断流，已为 ${result.recovered.length} 张进行中卡片入队断点续跑`)
      }
      return result
    } catch (error) {
      warn(`恢复重启断流卡片失败：${error?.message || error}`)
      return { recovered: [] }
    }
  }

  return {
    bootedAt,
    watermarks,
    tick,
    recoverInterruptedRuns,
    handleSessionEvent,
    dispose() {
      clearGraceTimers()
      watermarks.clear()
    },
  }
}

export function registerWatchdog(ctx, options = {}) {
  const watchdog = createWatchdog(options)
  if (!ctx) return watchdog
  const tickIntervalMs = Number.isFinite(Number(options.tickIntervalMs)) && Number(options.tickIntervalMs) > 0
    ? Number(options.tickIntervalMs)
    : 15_000
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => watchdog.handleSessionEvent(session, event), { global: true })
  }
  if (typeof ctx.effect === 'function' && options.autoSchedule !== false) {
    ctx.effect(() => {
      const timer = setInterval(() => { void watchdog.tick() }, tickIntervalMs)
      timer.unref?.()
      return () => {
        clearInterval(timer)
        watchdog.dispose()
      }
    })
  }
  return watchdog
}
