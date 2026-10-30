// 启动时回填工作区（v0.22.1）：把「有执行目录 cwd、缺 workspaceId」的未归档卡片，
// 按宿主 workspace 注册表的 canonical 路径精确匹配补齐。约束：
// - 只回填未归档卡片；已有 workspaceId 的卡不覆盖；
// - 只认 resolveByPath（canonical 精确匹配），worktree/子目录等解析不到的卡跳过（避免张冠李戴）；
// - 静默幂等：成功跑过一次就不再跑，不写时间线节点（只写插件日志）；
// - 注册表尚未注入时返回 skipped='registry-unavailable'，调用方可稍后重试。
import { LIMITS, cleanText, touchCard } from './domain.js'

export function createWorkspaceBackfill({ store, getRegistry, logger } = {}) {
  if (!store) throw new Error('createWorkspaceBackfill 需要 store')
  let done = false
  let running = null
  const warn = message => { try { logger?.warn?.(`[dsh-kanban] ${message}`) } catch {} }
  const info = message => { try { logger?.info?.(`[dsh-kanban] ${message}`) } catch {} }

  function registry() {
    try {
      const value = typeof getRegistry === 'function' ? getRegistry() : null
      return value && typeof value.resolveByPath === 'function' ? value : null
    } catch {
      return null
    }
  }

  /** 执行一次回填；返回 {updated, skipped?}。并发调用共享同一个 promise。 */
  function runOnce() {
    if (done) return Promise.resolve({ updated: 0, skipped: 'already-run' })
    if (running) return running
    running = (async () => {
      const host = registry()
      if (!host) return { updated: 0, skipped: 'registry-unavailable' }
      const data = await store.read()
      const targets = data.cards.filter(card => !card.archived && cleanText(card.cwd, 1000) && !cleanText(card.workspaceId, LIMITS.sessionId))
      if (!targets.length) { done = true; return { updated: 0 } }
      const byCard = new Map()
      for (const card of targets) {
        try {
          const workspace = await host.resolveByPath(card.cwd)
          const workspaceId = cleanText(workspace && workspace.id, LIMITS.sessionId)
          if (workspaceId) byCard.set(card.id, workspaceId)
        } catch { /* 目录不存在或未注册：跳过该卡 */ }
      }
      if (!byCard.size) { done = true; return { updated: 0 } }
      const { result } = await store.update(draft => {
        const now = Date.now()
        let updated = 0
        for (const card of draft.cards) {
          if (card.archived || !cleanText(card.cwd, 1000) || cleanText(card.workspaceId, LIMITS.sessionId)) continue
          const workspaceId = byCard.get(card.id)
          if (!workspaceId) continue
          card.workspaceId = workspaceId
          touchCard(card, now)
          updated++
        }
        return { updated }
      })
      done = true
      if (result.updated > 0) info(`启动时已为 ${result.updated} 张卡片回填工作区`)
      return { updated: result.updated }
    })().catch(error => {
      warn(`工作区回填失败：${error?.message || error}`)
      return { updated: 0, error: String(error?.message || error) }
    }).finally(() => { running = null })
    return running
  }

  return { runOnce }
}
