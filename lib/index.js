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
  DomainError, appendSessionArchiveActivity, autoArchiveCandidates, autoArchiveCompleted, batchSessionArchivePlan,
  dismissStalePendingApprovals, getSuperAgentSessionId, hasStalePendingApprovals, setSuperAgentSessionId,
} from './domain.js'
import { composeSuperAgentPrompt, handleIngressEvent, loadRouterRules } from './im-gateway.js'
import { createImAutoNotifier, createImLocalBridgeServer, loadImConfig } from './im-notifier.js'
import { createWeixinChannel, loadWeixinCredentials } from './weixin-channel.js'
import { createCc2imBridge } from './cc2im-bridge.js'
import { createSessionArchive } from './session-archive.js'
import { createWorkspaceBackfill } from './workspace-backfill.js'
import { createSessionBinding } from './session-binding.js'
import { registerSessionTurnSync } from './session-sync.js'
import { createWatchdog } from './watchdog.js'
import { createCloudSyncClient } from './cloud-sync-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const PKG_VERSION = (() => { try { return require('../package.json').version || '0.1.0' } catch { return '0.1.0' } })()

export const name = 'dsh-kanban'
export const inject = ['webServer', 'tools']

/**
 * 构建外部 IM → 常驻「★ Super Agent」真实推理回合桥接器：
 * - 自动解析或新建 `superAgentSessionId`，挂载最新双层路由提示词；
 * - 通过 `sessionController.prompt` 发起真实 Agent 回合（让模型自主调用 `kanban_cards` / `kanban_card` / `kanban_create_card` 等工具）；
 * - 监听 `session/event` 精准关联本次 `requestId` 所在的 `turn`，采集 `assistant/message` 并在 `turn/end` 返回最终文本答复；
 * - 宿主离线、未登录或超时则平滑返回 `{ ok: false }`，交由调用方回退本地确定性简报。
 */
export function createSuperAgentTurnRunner({
  ctx,
  store,
  getSessionController,
  getWorkspaceRegistry,
  sessionArchive,
  decorateSession,
  timeoutMs = 75_000,
  logger,
} = {}) {
  let serialQueue = Promise.resolve()

  async function runSingleTurn({
    text,
    provider = 'weixin',
    externalThreadId = '',
  } = {}) {
    const rawText = typeof text === 'string' ? text.trim() : ''
    if (!rawText) return { ok: false, reason: 'empty_text' }

    const controller = typeof getSessionController === 'function' ? getSessionController() : null
    if (!controller || typeof controller.prompt !== 'function' || !ctx || typeof ctx.on !== 'function') {
      return { ok: false, reason: 'controller_unavailable' }
    }

    const snap = await store.read()
    let sessionId = getSuperAgentSessionId(snap)
    if (sessionId && sessionArchive && typeof sessionArchive.setArchived === 'function') {
      try { await sessionArchive.setArchived(sessionId, false) } catch {}
    }

    let resolved = sessionId && typeof controller.resolveAgent === 'function'
      ? await controller.resolveAgent(sessionId).catch(() => null)
      : null

    if (!sessionId || (resolved && typeof resolved === 'object' && 'error' in resolved)) {
      if (typeof controller.create !== 'function') {
        return { ok: false, reason: 'session_create_unavailable' }
      }
      let createReq = { cwd: homedir() }
      const registry = typeof getWorkspaceRegistry === 'function' ? getWorkspaceRegistry() : null
      if (registry && typeof registry.list === 'function') {
        try {
          const list = await registry.list()
          if (Array.isArray(list) && list[0]?.id) {
            createReq = { workspaceId: list[0].id }
          }
        } catch {}
      }
      const created = await controller.create(createReq)
      sessionId = created?.sessionId || null
      if (!sessionId) return { ok: false, reason: 'session_create_empty' }
      await store.update(draft => setSuperAgentSessionId(draft, sessionId, {
        actor: { kind: 'system', name: 'im-gateway' },
      }))
      if (typeof controller.resolveAgent === 'function') {
        resolved = await controller.resolveAgent(sessionId).catch(() => null)
      }
    }

    if (typeof decorateSession === 'function') {
      try { await decorateSession(sessionId, resolved?.agent || null) } catch {}
    }

    const requestId = `im-${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const promptBody = [
      `【来自外部 IM（${provider}${externalThreadId ? ` · ${externalThreadId}` : ''}）的用户消息】`,
      rawText,
      '',
      '处理与回复要求：',
      '- 若询问看板卡片、进行中进展、卡点或待确认事项，务必先调用 `kanban_cards`（必要时对相关活跃卡片调用 `kanban_card` 查看 `currentAction`、`approvals`、`runtime`、`activities`、`dependsOn` 与 `checklists`），给出每张卡片的具体进展与卡点，不要只列卡片名称；',
      '- 若属于新建任务或推进指令，按规则调用 `kanban_create_card`（携带 `externalThreadId`）或 `kanban_update_card` 执行；',
      '- 你的回复将直接发回手机 IM，请用简洁清晰的纯文本要点作答（不使用 Markdown 表格）。',
    ].join('\n')

    const ac = new AbortController()
    return new Promise(resolveTurn => {
      let settled = false
      let openTurn = null
      let matchedTurn = null
      let toolCalls = 0
      let latestAssistantText = ''
      let offEvent = null
      let timer = null

      const finish = outcome => {
        if (settled) return
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (typeof offEvent === 'function') {
          try { offEvent() } catch {}
          offEvent = null
        }
        resolveTurn(outcome)
      }

      timer = setTimeout(() => {
        try { ac.abort() } catch {}
        finish({ ok: false, sessionId, reason: 'timeout' })
      }, timeoutMs)
      timer.unref?.()

      offEvent = ctx.on('session/event', (session, event) => {
        try {
          if (!session || session.id !== sessionId || !event || typeof event.type !== 'string') return
          if (event.type === 'turn/start' || event.type === 'step/start') {
            if (event.data?.turn !== undefined) openTurn = event.data.turn
            return
          }
          if (event.type === 'user/message') {
            const rpcId = event.data?.source?.rpcId || event.data?.message?.source?.rpcId
            if (rpcId === requestId) {
              matchedTurn = event.data?.turn ?? openTurn ?? true
            }
            return
          }
          if (matchedTurn === null) return

          if (event.type === 'tool/call' || event.type === 'tool_call' || event.type === 'tool/start') {
            toolCalls += 1
            return
          }
          if (event.type === 'assistant/message') {
            if (matchedTurn === true || event.data?.turn === undefined || event.data?.turn === matchedTurn) {
              const blocks = event.data?.message?.content ?? event.data?.content ?? []
              const texts = (Array.isArray(blocks) ? blocks : [])
                .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text.trim())
                .filter(Boolean)
              if (texts.length) {
                latestAssistantText = texts.join('\n\n')
              }
            }
            return
          }
          if (event.type === 'turn/end') {
            if (matchedTurn === true || event.data?.turn === undefined || event.data?.turn === matchedTurn) {
              const kind = event.data?.reason?.kind || 'completed'
              if ((kind === 'completed' || kind === 'max-tokens') && latestAssistantText.trim()) {
                finish({
                  ok: true,
                  sessionId,
                  turn: event.data?.turn ?? null,
                  toolCalls,
                  replyText: latestAssistantText.trim(),
                })
              } else {
                finish({
                  ok: false,
                  sessionId,
                  reason: kind,
                  error: event.data?.reason?.error?.message || '',
                })
              }
            }
          }
        } catch (err) {
          try { logger?.warn?.(`[dsh-kanban] Super Agent IM 事件采集异常：${err?.message || err}`) } catch {}
        }
      }, { global: true })

      Promise.resolve(controller.prompt({
        sessionId,
        requestId,
        mode: 'queue',
        content: [{ type: 'text', text: promptBody }],
      }, ac.signal)).catch(err => {
        finish({
          ok: false,
          sessionId,
          reason: 'prompt_rejected',
          error: err?.message || String(err),
        })
      })
    })
  }

  return {
    ask(input) {
      const next = serialQueue.then(() => runSingleTurn(input), () => runSingleTurn(input))
      serialQueue = next.then(() => {}, () => {})
      return next
    },
  }
}

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir ? resolve(String(config.dataDir)) : join(homedir(), '.dsh-kanban')
  const seedMode = config.seed === 'empty' ? 'empty' : 'demo'
  const staticRoot = config.staticRoot ? resolve(String(config.staticRoot)) : join(__dirname, '..', 'web', 'dist')

  // autoArchiveDays：默认 3（天）；0 或非法值=关闭。仅归档 done/canceled 且 completedAt 超过 N 天的卡片，以及已合并（mergedInto）的卡片。
  const configuredDays = Number(config.autoArchiveDays)
  const autoArchiveDays = config.autoArchiveDays === undefined
    ? 3
    : Number.isFinite(configuredDays) && configuredDays > 0 ? Math.floor(configuredDays) : 0

  // autoArchiveSessionsDays：默认 7（天）；0 或非法值=关闭。仅归档「已完成/取消超过 N 天」卡片绑定的会话。
  const configuredSessionDays = Number(config.autoArchiveSessionsDays)
  const autoArchiveSessionsDays = config.autoArchiveSessionsDays === undefined
    ? 7
    : Number.isFinite(configuredSessionDays) && configuredSessionDays > 0 ? Math.floor(configuredSessionDays) : 0

  // 宿主会话能力懒注入：
  // - workspaceRegistry：DSH 0.2.x 提供，会话归档 + 建卡时解析工作区用；
  // - sessionController：DSH 0.2.1+ 提供，建卡 sessionMode:"new" 时真建会话用；旧宿主没有该服务时
  //   inject 回调不触发、refs 保持 null，建卡自动降级为「只补全目录/工作区 + warnings」。
  // v0.22.1：启动时回填工作区（把有 cwd、缺 workspaceId 的旧卡按注册表补齐）；config.workspaceBackfill=false 可关。
  let backfill = null
  let backfillTimer = null
  let backfillRetries = 0
  async function runBackfill() {
    if (!backfill) return
    const result = await backfill.runOnce()
    if (result && result.skipped === 'registry-unavailable' && backfillRetries < 5) {
      backfillRetries += 1
      backfillTimer = setTimeout(() => { backfillTimer = null; runBackfill() }, 2000)
      backfillTimer.unref?.()
    }
  }
  const refs = { workspaceRegistry: null, sessionController: null }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], (workspaceCtx) => workspaceCtx.effect(() => {
      refs.workspaceRegistry = workspaceCtx.workspaceRegistry
      queueMicrotask(() => { runBackfill() })
      return () => { refs.workspaceRegistry = null }
    }, 'dsh-kanban: workspace registry ref'))
    ctx.inject(['sessionController'], (sessionCtx) => sessionCtx.effect(() => {
      refs.sessionController = sessionCtx.sessionController
      return () => { refs.sessionController = null }
    }, 'dsh-kanban: session controller ref'))
  } else {
    // 测试/极简上下文没有 inject：同步探测服务；拿不到则对应能力按不可用处理。
    const readService = name => {
      try { return typeof ctx.get === 'function' ? ctx.get(name) ?? null : null } catch { return null }
    }
    refs.workspaceRegistry = readService('workspaceRegistry')
    refs.sessionController = readService('sessionController')
  }
  const sessionArchive = createSessionArchive({ getRegistry: () => refs.workspaceRegistry, logger: ctx.logger })
  const sessionBinding = createSessionBinding({
    getWorkspaceRegistry: () => refs.workspaceRegistry,
    getSessionController: () => refs.sessionController,
    logger: ctx.logger,
  })

  const store = createStore({ dataDir, seedMode, logger: ctx.logger })
  // 启动时工作区回填（v0.22.1）：只回填未归档、有 cwd 缺 workspaceId 的卡；幂等、静默、可配置关闭。
  if (config.workspaceBackfill !== false) {
    backfill = createWorkspaceBackfill({ store, getRegistry: () => refs.workspaceRegistry, logger: ctx.logger })
    ctx.effect(() => () => { if (backfillTimer) clearTimeout(backfillTimer) })
  }

  // 常驻「★ Super Agent」会话装饰器（吸收 dsh-superagent-prototype/src/app/sessions.ts）：
  // 1) 调用 sessionController.rename 将会话标题固定为「★ Super Agent」；
  // 2) 通过 agent.ctx.systemPrompt.section 动态挂载最新双层路由提示词与热加载规则，不污染用户聊天历史。
  const superPromptDisposers = new Map()
  async function decorateSuperAgentSession(sessionId, agentOverride = null) {
    if (!sessionId) return false
    if (refs.sessionController && typeof refs.sessionController.rename === 'function') {
      try { await refs.sessionController.rename({ sessionId, title: '★ Super Agent' }) } catch {}
    }
    let agent = agentOverride
    if (!agent && typeof refs.sessionController?.resolveAgent === 'function') {
      try {
        const resolved = await refs.sessionController.resolveAgent(sessionId)
        if (resolved && typeof resolved === 'object' && !('error' in resolved)) {
          agent = resolved.agent || null
        }
      } catch {}
    }
    if (!agent && typeof refs.sessionController?.getAgent === 'function') {
      try { agent = refs.sessionController.getAgent(sessionId) } catch {}
    }
    const sectionFn = agent?.ctx?.systemPrompt?.section
    if (typeof sectionFn === 'function') {
      try {
        const prevDispose = superPromptDisposers.get(sessionId)
        if (typeof prevDispose === 'function') prevDispose()
        const dispose = sectionFn.call(agent.ctx.systemPrompt, {
          name: 'dsh-kanban-super-agent',
          order: 9999,
          interpolate: false,
          text: composeSuperAgentPrompt(loadRouterRules(dataDir)),
        })
        if (typeof dispose === 'function') superPromptDisposers.set(sessionId, dispose)
        return true
      } catch {}
    }
    return false
  }
  ctx.effect(() => () => {
    for (const dispose of superPromptDisposers.values()) {
      try { dispose() } catch {}
    }
    superPromptDisposers.clear()
  })

  if (typeof ctx.on === 'function') {
    const offAgentCreated = ctx.on('agent/created', async payload => {
      try {
        const agent = payload?.agent || payload
        const sid = agent?.session?.id || agent?.id
        if (!sid) return
        const snap = store.peek() || await store.read()
        if (getSuperAgentSessionId(snap) === sid) {
          await decorateSuperAgentSession(sid, agent)
        }
      } catch {}
    }, { global: true })
    if (typeof offAgentCreated === 'function') {
      ctx.effect(() => offAgentCreated)
    }
  }

  const superAgentRunner = createSuperAgentTurnRunner({
    ctx,
    store,
    getSessionController: () => refs.sessionController,
    getWorkspaceRegistry: () => refs.workspaceRegistry,
    sessionArchive,
    decorateSession: decorateSuperAgentSession,
    logger: ctx.logger,
  })

  // 多端 IM 通道桥接（<dataDir>/im-config.json）：原生腾讯 iLink 微信通道 + 兼容 cc2im + 状态变更自动出站通知
  const initialImConfig = loadImConfig(dataDir)
  const hasWeixinCreds = Boolean(loadWeixinCredentials(dataDir, initialImConfig.weixin?.credentialsPath))
  const weixinEnabled = config.weixin !== false && (initialImConfig.weixin?.enabled || hasWeixinCreds)
  const weixinChannel = config.weixin !== false
    ? createWeixinChannel({
      store,
      dataDir,
      enabled: weixinEnabled,
      pollEnabled: initialImConfig.weixin?.pollEnabled !== false,
      allowedUsers: initialImConfig.weixin?.allowedUsers,
      defaultUserId: initialImConfig.weixin?.defaultUserId,
      credentialsPath: initialImConfig.weixin?.credentialsPath,
      contextPath: initialImConfig.weixin?.contextPath,
      askAgent: superAgentRunner.ask,
      logger: ctx.logger,
    })
    : null
  if (weixinChannel && weixinEnabled) {
    weixinChannel.start()
  }
  if (weixinChannel) {
    ctx.effect(() => () => { weixinChannel.stop() })
  }

  const cc2imBridge = (config.cc2im !== false && initialImConfig.cc2im?.enabled)
    ? createCc2imBridge({
      store,
      dataDir,
      socketPath: initialImConfig.cc2im.socketPath,
      webUrl: initialImConfig.cc2im.webUrl,
      agentId: initialImConfig.cc2im.agentId || 'kanban',
      defaultUserId: initialImConfig.cc2im.defaultUserId,
      askAgent: superAgentRunner.ask,
      logger: ctx.logger,
    }).start()
    : null
  if (cc2imBridge) {
    ctx.effect(() => () => { cc2imBridge.stop() })
  }

  if (config.imAutoNotify !== false) {
    const imNotifier = createImAutoNotifier({
      store,
      dataDir,
      weixinChannel,
      cc2imBridge,
      logger: ctx.logger,
    })
    ctx.effect(() => () => { imNotifier.dispose() })
  }

  // 云同步守护器（C3，可选）：读取 <dataDir>/cloud-config.json（默认 ~/.dsh-kanban/cloud-config.json）。
  // - 未配置 / enabled:false / 配置非法：start() 直接静默返回，不建定时器、不发任何网络请求；
  // - 配置就绪：防抖增量推送 + 定时兜底 + 休眠期入站 claim/回放/ACK（契约 08-cloud-sync.md）。
  // 仓库内不落任何个人令牌；关闭可用 config.cloudSync=false 或 cloud-config.json 的 enabled:false。
  async function replayIngressInProcess(request = {}) {
    try {
      const raw = typeof request.body === 'string' ? request.body.trim() : ''
      if (!raw) {
        return { status: 400, body: { ok: false, error: { code: 'BAD_JSON', message: '请求体为空' } } }
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { status: 400, body: { ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } } }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 400, body: { ok: false, error: { code: 'BAD_JSON', message: '请求体必须是 JSON 对象' } } }
      }
      if (typeof parsed.challenge === 'string' && parsed.challenge) {
        return { status: 200, body: { ok: true, challenge: parsed.challenge } }
      }
      const githubEvent = typeof request.headers?.['x-github-event'] === 'string'
        ? request.headers['x-github-event'].trim()
        : undefined
      const now = Date.now()
      const { result, revision } = await store.update(draft => (
        handleIngressEvent(draft, parsed, { now, githubEvent, dataDir: store.dataDir })
      ))
      return { status: 200, body: { ok: true, ...result, revision } }
    } catch (error) {
      if (error instanceof DomainError) {
        const status = error.status || 400
        return {
          status,
          body: { ok: false, error: { code: error.code, message: error.message }, ...(error.extra || {}) },
        }
      }
      return {
        status: 500,
        body: { ok: false, error: { code: error?.code || 'INTERNAL', message: error?.message || '本地入站回放内部错误' } },
        error: error?.message || '本地入站回放内部错误',
      }
    }
  }

  const cloudSyncEnabled = config.cloudSync !== false && config.cloudSync?.enabled !== false
  const cloudSyncOptions = config.cloudSync && typeof config.cloudSync === 'object' ? config.cloudSync : {}
  const cloudSync = cloudSyncEnabled
    ? createCloudSyncClient({ store, dataDir, logger: ctx.logger, localIngress: replayIngressInProcess, ...cloudSyncOptions })
    : null

  const { routes, close } = createRoutes({
    store,
    staticRoot,
    version: PKG_VERSION,
    logger: ctx.logger,
    sessionArchive,
    sessionBinding,
    weixinChannel,
    cc2imBridge,
    cloudSync,
    onSuperAgentSession: sid => decorateSuperAgentSession(sid),
  })

  // 路由：每条注册都交给 ctx.effect 管理，插件卸载时自动摘除。
  for (const route of routes) ctx.effect(() => ctx.webServer.register(route))
  // 固定本机回环 IM 桥接监听（默认 127.0.0.1:4599）：防止宿主每次重启更换随机端口导致钉钉卡片按钮失联，同时兼容旧版 `/?cardId=...` 链接。
  const defaultDataDir = join(homedir(), '.dsh-kanban')
  const shouldEnableImLocalBridge = config.imLocalPort !== false && (
    Number.isInteger(config.imLocalPort)
      ? config.imLocalPort >= 0
      : dataDir === defaultDataDir
  )
  if (shouldEnableImLocalBridge) {
    ctx.effect(() => {
      const bridge = createImLocalBridgeServer({
        routes,
        port: Number.isInteger(config.imLocalPort) ? config.imLocalPort : 4599,
        host: typeof config.imLocalHost === 'string' && config.imLocalHost.trim() ? config.imLocalHost.trim() : '127.0.0.1',
        dataDir,
        logger: ctx.logger,
      })
      return () => { void bridge.close() }
    })
  }
  // 工具：保持固定名字，避免 agent 已学到的工作流失效。sessionBinding 负责建卡时的会话/目录补全。
  for (const tool of createTools({ store, sessionBinding })) {
    ctx.effect(() => {
      const dispose = ctx.tools.register(tool)
      return typeof dispose === 'function' ? dispose : () => {}
    })
  }
  // 云同步守护器随之启停（未配置时 start() 立即静默返回，不产生定时器/网络）。
  if (cloudSync) ctx.effect(() => {
    void cloudSync.start()
    return () => { void cloudSync.stop() }
  })
  // SSE 连接、订阅与心跳在插件卸载时关闭。
  ctx.effect(() => () => { close().catch(() => {}) })

  // 会话运行失败同步（v0.11.0）+ Super-Agent Watchdog（v0.27.0）：
  // 监听宿主 session/event 的 turn/start 与 turn/end，同步状态并驱动静默停滞收敛与瞬时错误退避重试。
  // 宿主没有 session/event（旧版）时监听器不会触发，不影响其它能力；sessionFailureSync:false 可关闭。
  let activeWatchdog = null
  if (config.sessionFailureSync !== false) {
    try {
      const watchdog = config.watchdog !== false
        ? createWatchdog({ store, logger: ctx.logger })
        : null
      activeWatchdog = watchdog
      if (watchdog) {
        const watchdogTimer = setInterval(() => { void watchdog.tick() }, 15_000)
        watchdogTimer.unref?.()
        ctx.effect(() => () => {
          clearInterval(watchdogTimer)
          watchdog.dispose()
        })
      }
      registerSessionTurnSync(ctx, {
        store,
        logger: ctx.logger,
        watchdog,
        onSessionTurnStart: async session => {
          const sid = session?.id
          if (!sid) return
          const snap = store.peek?.() || await store.read()
          if (getSuperAgentSessionId(snap) === sid) {
            await decorateSuperAgentSession(sid, session?.agent || null)
          }
        },
      })
    } catch (error) {
      try { ctx.logger?.warn?.(`[dsh-kanban] 会话运行失败同步未启用：${error.message}`) } catch {}
    }
  }

  // 提前加载/种子；失败不阻塞插件启动，后续请求会返回带原因的错误。
  store.ready().then(
    async () => {
      runBackfill()
      if (activeWatchdog) {
        await activeWatchdog.recoverInterruptedRuns().catch(() => {})
        void activeWatchdog.tick()
      }
      try {
        const snap = await store.read()
        const superSid = getSuperAgentSessionId(snap)
        if (superSid) void decorateSuperAgentSession(superSid)
      } catch {}
      try { ctx.logger?.info?.(`[dsh-kanban] 数据目录：${store.dataDir}`) } catch {}
    },
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
