// DSH Kanban 插件入口：webServer 路由 + agent 工具 + 数据目录种子。
// 注意：webServer 的 prefix 路由会匹配 path 自身与 path/<anything>，
// 因此这里只注册两条前缀路由（API / 静态资源），重复注册会抛错。
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createStore } from './store.js'
import { createRoutes } from './routes.js'
import { createTools } from './tools.js'
import {
  appendSessionArchiveActivity, autoArchiveCandidates, autoArchiveCompleted, batchSessionArchivePlan,
  dismissStalePendingApprovals, hasStalePendingApprovals,
} from './domain.js'
import { createSessionArchive } from './session-archive.js'
import { registerSessionTurnSync } from './session-sync.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const PKG_VERSION = (() => { try { return require('../package.json').version || '0.1.0' } catch { return '0.1.0' } })()

export const name = 'dsh-kanban'
export const inject = ['webServer', 'tools']

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir ? resolve(String(config.dataDir)) : join(homedir(), '.dsh-kanban')
  const seedMode = config.seed === 'empty' ? 'empty' : 'demo'
  const staticRoot = config.staticRoot ? resolve(String(config.staticRoot)) : join(__dirname, '..', 'web', 'dist')

  // autoArchiveDays：默认 30（天）；0 或非法值=关闭。仅归档 done/canceled 且 completedAt 超过 N 天的卡片。
  const configuredDays = Number(config.autoArchiveDays)
  const autoArchiveDays = config.autoArchiveDays === undefined
    ? 30
    : Number.isFinite(configuredDays) && configuredDays > 0 ? Math.floor(configuredDays) : 0

  // autoArchiveSessionsDays：默认 7（天）；0 或非法值=关闭。仅归档「已完成/取消超过 N 天」卡片绑定的会话。
  const configuredSessionDays = Number(config.autoArchiveSessionsDays)
  const autoArchiveSessionsDays = config.autoArchiveSessionsDays === undefined
    ? 7
    : Number.isFinite(configuredSessionDays) && configuredSessionDays > 0 ? Math.floor(configuredSessionDays) : 0

  // 宿主会话归档能力：workspaceRegistry 由 DSH 0.2.x 提供，旧宿主/纯 dev-server 不存在 → 适配器 available()=false。
  const refs = { workspaceRegistry: null }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], (workspaceCtx) => workspaceCtx.effect(() => {
      refs.workspaceRegistry = workspaceCtx.workspaceRegistry
      return () => { refs.workspaceRegistry = null }
    }, 'dsh-kanban: workspace registry ref'))
  } else {
    // 测试/极简上下文没有 inject：同步探测服务；拿不到则归档能力按不可用处理。
    try { refs.workspaceRegistry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') ?? null : null } catch { refs.workspaceRegistry = null }
  }
  const sessionArchive = createSessionArchive({ getRegistry: () => refs.workspaceRegistry, logger: ctx.logger })

  const store = createStore({ dataDir, seedMode, logger: ctx.logger })
  const { routes, close } = createRoutes({
    store, staticRoot, version: PKG_VERSION, logger: ctx.logger, sessionArchive,
  })

  // 路由：每条注册都交给 ctx.effect 管理，插件卸载时自动摘除。
  for (const route of routes) ctx.effect(() => ctx.webServer.register(route))
  // 工具：保持固定名字，避免 agent 已学到的工作流失效。
  for (const tool of createTools({ store })) {
    ctx.effect(() => {
      const dispose = ctx.tools.register(tool)
      return typeof dispose === 'function' ? dispose : () => {}
    })
  }
  // SSE 连接、订阅与心跳在插件卸载时关闭。
  ctx.effect(() => () => { close().catch(() => {}) })

  // 会话运行失败同步（v0.11.0）：监听宿主 session/event 的 turn/end，把失败/恢复写回卡片。
  // 宿主没有 session/event（旧版）时监听器不会触发，不影响其它能力；sessionFailureSync:false 可关闭。
  if (config.sessionFailureSync !== false) {
    try {
      registerSessionTurnSync(ctx, { store, logger: ctx.logger })
    } catch (error) {
      try { ctx.logger?.warn?.(`[dsh-kanban] 会话运行失败同步未启用：${error.message}`) } catch {}
    }
  }

  // 提前加载/种子；失败不阻塞插件启动，后续请求会返回带原因的错误。
  store.ready().then(
    () => { try { ctx.logger?.info?.(`[dsh-kanban] 数据目录：${store.dataDir}`) } catch {} },
    error => { try { ctx.logger?.warn?.(`[dsh-kanban] 数据加载失败：${error.message}`) } catch {} },
  )

  // 决策日志（v0.10）：首次启用时回填历史审批事件；并把历史遗留的 pending 审批同步收口。
  // 回填 + 迁移放在同一个 store.update 事务里：store 队列天然串行，启动窗口内的 live 写不会与回填交错。
  const decisionReady = (async () => {
    if (!store.decisionLog) return null
    try {
      await store.ready()
      const data = await store.read()
      const [initialized, hasStale] = [await store.decisionLog.isInitialized(), hasStalePendingApprovals(data)]
      if (initialized && !hasStale) return { created: false, entries: 0, staleClosed: 0 }
      const { result } = await store.update(draft => (async () => {
        // 回填先写 decisions.jsonl（日志领先 data.json）；迁移只改草稿、不重复记事件，最后随同一笔 data.json 落盘。
        const backfill = await store.decisionLog.initializeFromSnapshot(draft)
        const staleClosed = dismissStalePendingApprovals(draft)
        return { ...backfill, staleClosed }
      })())
      if (result.created) ctx.logger?.info?.(`[dsh-kanban] 决策日志已回填 ${result.entries} 条事件：${store.decisionLog.file}`)
      if (result.staleClosed > 0) ctx.logger?.info?.(`[dsh-kanban] 已同步关闭 ${result.staleClosed} 条历史遗留的待确认审批`)
      return result
    } catch (error) {
      try { ctx.logger?.warn?.(`[dsh-kanban] 决策日志初始化失败：${error.message}`) } catch {}
      return null
    }
  })()

  // 已完成自动归档：store 与决策日志就绪后立即跑一次，之后每小时一次；卸载时清理定时器。
  // 放在决策日志回填之后，保证归档关闭的 pending 审批也能被日志记录。
  if (autoArchiveDays > 0) {
    const runAutoArchive = async () => {
      try {
        const snapshot = await store.read()
        if (!autoArchiveCandidates(snapshot.cards, { days: autoArchiveDays }).length) return 0
        const { result: count, revision } = await store.update(draft => autoArchiveCompleted(draft, { days: autoArchiveDays }))
        if (count > 0) ctx.logger?.info?.(`[dsh-kanban] 自动归档了 ${count} 张已完成卡片（超过 ${autoArchiveDays} 天），revision=${revision}`)
        return count
      } catch (error) {
        try { ctx.logger?.warn?.(`[dsh-kanban] 自动归档失败：${error.message}`) } catch {}
        return 0
      }
    }
    decisionReady.then(runAutoArchive, () => {})
    const timer = setInterval(runAutoArchive, 60 * 60 * 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
  }

  // 已完成卡片的会话自动归档（v0.11）：卡片 done/canceled 超过 N 天后，若会话可逆能力可用且
  // 所有绑定卡都已收口，则自动归档；运行中/待确认由宿主活动检查拒绝，仅跳过。放在决策日志/卡片自动归档之后。
  if (autoArchiveSessionsDays > 0) {
    const runAutoArchiveSessions = async () => {
      try {
        if (!sessionArchive.available()) return 0
        const snapshot = await store.read()
        const now = Date.now()
        const cutoff = now - autoArchiveSessionsDays * 24 * 60 * 60 * 1000
        const plan = batchSessionArchivePlan(snapshot, {
          archivedSessionIds: sessionArchive.archivedSessionIds(),
          completedBefore: cutoff,
        })
        if (!plan.archivable.length) return 0
        const archived = []
        for (const entry of plan.archivable) {
          try { await sessionArchive.archive(entry.sessionId); archived.push(entry) } catch { /* 运行中/待确认/已删除：下次再试或由用户处理 */ }
        }
        if (!archived.length) return 0
        await store.update(draft => {
          for (const entry of archived) {
            appendSessionArchiveActivity(draft, entry.cardId, {
              sessionId: entry.sessionId, auto: true, autoDays: autoArchiveSessionsDays,
              actor: { kind: 'system', name: 'system' }, now,
            })
          }
          return { count: archived.length }
        })
        try { ctx.logger?.info?.(`[dsh-kanban] 自动归档了 ${archived.length} 个已完成超过 ${autoArchiveSessionsDays} 天的卡片会话`) } catch {}
        return archived.length
      } catch (error) {
        try { ctx.logger?.warn?.(`[dsh-kanban] 会话自动归档失败：${error.message}`) } catch {}
        return 0
      }
    }
    decisionReady.then(runAutoArchiveSessions, () => {})
    const timer = setInterval(runAutoArchiveSessions, 60 * 60 * 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
  }
}
