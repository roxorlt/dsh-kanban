// 建卡时的会话/目录补全与自动新建会话（v0.20.1）。
// 设计约束：
// - 宿主服务（workspaceRegistry / sessionController）全部懒读取，旧宿主没有 sessionController 时
//   降级为「只补全目录/工作区 + warnings 提示手动新建会话」，绝不让建卡整体失败；
// - planCreate 只做解析计算（不建会话、不写 store），便于单测；createSessionBinding 才执行宿主调用；
// - 不覆盖显式传入的 sessionId/workspaceId/cwd；解析不到的显式 workspaceId 丢弃并写 warning。
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { LIMITS, cleanText } from './domain.js'

/** 建卡时的会话绑定方式：reuse=复用当前会话（默认）/ new=新建一个会话并绑定 / none=不绑定。 */
export const SESSION_MODES = ['reuse', 'new', 'none']
export const DEFAULT_SESSION_MODE = 'reuse'

/** 懒读宿主服务：getter 抛错或还没注入时按不可用处理，不影响建卡主流程。 */
function readService(getter) {
  try {
    const value = typeof getter === 'function' ? getter() : null
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export function normalizeSessionMode(value) {
  return SESSION_MODES.includes(value) ? value : DEFAULT_SESSION_MODE
}

/**
 * 从 exec.agent 里取当前会话上下文（会话 id + cwd）。
 * 宿主没给 agent.session（单测 / dev-server / 旧宿主）时返回 null，表示不自动补全、保持旧行为。
 */
export function currentSession(agent) {
  const session = agent && typeof agent === 'object' ? agent.session : null
  if (!session || typeof session !== 'object') return null
  const sessionId = cleanText(session.id, LIMITS.sessionId) || cleanText(agent.id, LIMITS.agentId)
  if (!sessionId) return null
  const cwd = cleanText(session.header && session.header.cwd, 1000)
  return { sessionId, ...(cwd ? { cwd } : {}) }
}

/** 规范化绝对路径（去掉结尾斜杠、折叠 . 与 ..）；解析失败时退回原串。 */
function normalizePath(value) {
  const text = cleanText(value, 1000)
  if (!text) return ''
  try {
    return resolvePath(text)
  } catch {
    return text
  }
}

function samePath(left, right) {
  const a = normalizePath(left)
  const b = normalizePath(right)
  return Boolean(a && b) && a === b
}

/** 宿主 workspace 实体 → 本插件需要的 { id, path }（字段缺失防御）。 */
function workspaceOf(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null
  const id = cleanText(raw.id, LIMITS.sessionId) || cleanText(fallbackId, LIMITS.sessionId)
  if (!id) return null
  const path = normalizePath(raw.path)
  return { id, ...(path ? { path } : {}) }
}

/**
 * 按 id 查工作区。三态：
 * - ok：registry 可用且查到了；
 * - unknown：registry 可用但 get 返回空（该 id 不存在 / 已删除）→ 调用方丢弃显式值；
 * - unavailable：没有 registry 或 get 不可用/报错 → 无法校验，保留显式值。
 */
async function lookupWorkspace(registry, id) {
  if (!registry || typeof registry.get !== 'function') return { state: 'unavailable' }
  try {
    const workspace = workspaceOf(await registry.get(id), id)
    return workspace ? { state: 'ok', workspace } : { state: 'unknown' }
  } catch {
    return { state: 'unavailable' }
  }
}

/** 按目录解析所属工作区；路径未注册 / canonical 路径不存在（resolveByPath 会 throw）时返回 null。 */
async function resolveWorkspaceByPath(registry, cwd) {
  if (!registry || typeof registry.resolveByPath !== 'function' || !cwd) return null
  try {
    return workspaceOf(await registry.resolveByPath(cwd))
  } catch {
    return null
  }
}

/**
 * 计算建卡时的会话/目录补全方案（纯解析，不建会话、不写 store）。
 *
 * @param {object} options
 * @param {object} [options.args] kanban_create_card 的入参（sessionMode/sessionId/workspaceId/cwd/title…）。
 * @param {object} [options.agent] exec.agent（ReactLoopAgent，可能带 .session）。
 * @param {object | null} [options.registry] 宿主 workspaceRegistry（已注入时）。
 * @param {boolean} [options.hasController] 宿主是否提供 sessionController（决定 new 能否真建会话）。
 * @returns {Promise<{input: object, binding: object, warnings: string[], createRequest: object | null, renameTitle: string}>}
 *   input 是补全后的建卡入参；binding 是返回给 agent 的绑定结果；createRequest 非空表示需要宿主新建会话。
 */
export async function planCreate({ args = {}, agent, registry = null, hasController = false } = {}) {
  const mode = normalizeSessionMode(args.sessionMode)
  const current = currentSession(agent)
  const warnings = []
  const input = { ...args }
  delete input.sessionMode
  const binding = { mode, sessionId: null, created: false, source: null, workspaceId: null, cwd: null }
  const finish = createRequest => {
    binding.workspaceId = cleanText(input.workspaceId, LIMITS.sessionId) || null
    binding.cwd = cleanText(input.cwd, 1000) || null
    return { input, binding, warnings, createRequest, renameTitle: cleanText(args.title, LIMITS.title) }
  }

  // 显式 cwd 必须是绝对路径：相对路径无法确定目标目录，丢弃并告警（不覆盖显式参数的说法只对合法值成立）。
  const explicitCwd = cleanText(args.cwd, 1000)
  if (explicitCwd && !isAbsolute(explicitCwd)) {
    warnings.push('显式 cwd 不是绝对路径，已忽略')
    delete input.cwd
  }
  const cwdHint = cleanText(input.cwd, 1000)

  // 1) 显式 sessionId：任何模式下都直接绑定（source=explicit），不新建会话。
  const explicitSessionId = cleanText(args.sessionId, LIMITS.sessionId)
  if (explicitSessionId) {
    binding.sessionId = explicitSessionId
    binding.source = 'explicit'
    if (mode === 'new') warnings.push('已显式指定 sessionId，未新建会话')
  } else if (mode === 'reuse' && current) {
    // 2) reuse（默认）：自动绑定当前 DSH 会话；取不到会话上下文时保持旧行为（不补全 sessionId）。
    binding.sessionId = current.sessionId
    binding.source = 'agent'
    input.sessionId = current.sessionId
  }

  // 3) 工作区解析：显式 workspaceId 优先；宿主有 registry 但查不到该 id 时丢弃并告警，再回退目录解析。
  const explicitWorkspaceId = cleanText(args.workspaceId, LIMITS.sessionId)
  const currentCwd = cleanText(current && current.cwd, 1000)
  let workspace = null
  if (explicitWorkspaceId) {
    const looked = await lookupWorkspace(registry, explicitWorkspaceId)
    if (looked.state === 'unknown') {
      warnings.push(`workspaceId「${explicitWorkspaceId}」不存在或已删除，已忽略`)
      delete input.workspaceId
    } else {
      workspace = looked.state === 'ok' ? looked.workspace : { id: explicitWorkspaceId }
    }
  }
  if (!workspace) {
    if (cwdHint) {
      // 显式目录优先解析工作区；解析不到就保持缺失，不回退到当前会话的工作区（避免 cwd 与 workspaceId 互相矛盾）。
      workspace = await resolveWorkspaceByPath(registry, cwdHint)
    } else if (currentCwd) {
      workspace = await resolveWorkspaceByPath(registry, currentCwd)
    }
  }

  // 4) 补全 cwd / workspaceId（显式值已存在时不覆盖）。
  // new 的新会话落在工作区根（或显式 cwd）；卡片 cwd 优先保留显式 cwd（子目录场景），否则用工作区路径。
  // reuse/none 的卡片执行目录跟当前会话一致；取不到会话目录时退回工作区路径。
  const completedCwd = mode === 'new'
    ? (cwdHint || (workspace && workspace.path) || (workspace ? '' : currentCwd))
    : (cwdHint || currentCwd || (workspace && workspace.path))
  if (!cleanText(input.cwd, 1000) && completedCwd) input.cwd = completedCwd
  if (!cleanText(input.workspaceId, LIMITS.sessionId) && workspace && workspace.id) input.workspaceId = workspace.id

  // 5) reuse 下显式 cwd 与当前会话目录不一致：只提示，不阻止（建卡仍按显式 cwd）。
  if (mode === 'reuse' && cwdHint && currentCwd && !samePath(cwdHint, currentCwd)) {
    warnings.push('显式 cwd 与当前会话目录不一致；如需在新目录开始，请用 sessionMode:\'new\'')
  }

  // 6) 新建会话：只有 new 且没有显式 sessionId 时才建；宿主不支持/无目标时只降级告警。
  // 目标优先级：解析出的工作区（显式 workspaceId → 显式 cwd → 当前会话目录）→ 合法绝对目录 → 告警。
  let createRequest = null
  if (mode === 'new' && !explicitSessionId) {
    const hasTarget = Boolean(workspace && workspace.id) || Boolean(cwdHint) || Boolean(currentCwd)
    if (!hasController) {
      warnings.push(hasTarget
        ? '当前 DSH 版本不支持自动新建会话，已填好目录/工作区，请在卡片里手动新建会话'
        : '当前 DSH 版本不支持自动新建会话，也没有可用的工作区或目录，请在卡片里手动新建会话')
    } else if (workspace && workspace.id) {
      createRequest = { workspaceId: workspace.id }
    } else if (cwdHint && isAbsolute(cwdHint)) {
      createRequest = { cwd: cwdHint }
    } else if (!cwdHint && currentCwd && isAbsolute(currentCwd)) {
      createRequest = { cwd: currentCwd }
    } else {
      warnings.push('没有可用的工作区或目录，未新建会话；请显式传 workspaceId 或 cwd，或稍后在卡片里手动新建会话')
    }
  }
  return finish(createRequest)
}

/**
 * 创建会话绑定适配器：
 * - planCreate 负责解析；prepareCreate 在需要时先跑建卡前置校验（防孤儿会话），再调宿主新建会话并改名；
 * - 宿主新建/改名失败只降级为 warning，卡片照常创建。
 *
 * @param {object} [options]
 * @param {() => object | null} [options.getWorkspaceRegistry] 返回宿主 workspaceRegistry（可能尚未注入）。
 * @param {() => object | null} [options.getSessionController] 返回宿主 sessionController（旧宿主可能没有）。
 * @param {object} [options.logger] 插件 logger。
 */
export function createSessionBinding({ getWorkspaceRegistry, getSessionController, logger } = {}) {
  const warn = message => { try { logger?.warn?.(`[dsh-kanban] ${message}`) } catch {} }
  const describe = error => (error && error.message) || String(error)

  /**
   * 生成建卡方案，必要时真实新建宿主会话。
   * @param {object} options
   * @param {object} [options.args] kanban_create_card 入参。
   * @param {object} [options.agent] exec.agent。
   * @param {() => Promise<void> | void} [options.precheck] 建卡前置校验；抛错表示直接失败且不建会话。
   * @returns {Promise<{input: object, binding: object, warnings: string[]}>}
   */
  async function prepareCreate({ args = {}, agent, precheck } = {}) {
    const registry = readService(getWorkspaceRegistry)
    const controller = readService(getSessionController)
    let plan
    try {
      plan = await planCreate({ args, agent, registry, hasController: Boolean(controller) })
    } catch (error) {
      warn(`建卡时会话绑定预检失败：${describe(error)}`)
      return {
        input: args,
        binding: { mode: normalizeSessionMode(args.sessionMode), sessionId: null, created: false, source: null, workspaceId: null, cwd: null },
        warnings: ['会话绑定预检失败，已按原参数建卡'],
      }
    }
    const warnings = [...plan.warnings]
    const binding = { ...plan.binding }
    const result = { input: plan.input, binding, warnings }
    if (!plan.createRequest || !controller) return result

    // 防孤儿会话：先读一次 store 校验 board 存在 / 卡片数未超限 / 标题非空；校验失败直接抛错。
    if (typeof precheck === 'function') await precheck()

    try {
      const created = await controller.create(plan.createRequest)
      const sessionId = cleanText(created && created.sessionId, LIMITS.sessionId)
      if (!sessionId) throw new Error('宿主未返回会话 ID')
      binding.sessionId = sessionId
      binding.created = true
      binding.source = 'agent'
      result.input = { ...result.input, sessionId }
      // 标题改成卡片标题是 best-effort：失败不影响绑定，也不影响建卡。
      if (plan.renameTitle) {
        try {
          await controller.rename({ sessionId, title: plan.renameTitle })
        } catch (error) {
          warn(`新会话 ${sessionId} 设置标题失败：${describe(error)}`)
        }
      }
    } catch (error) {
      warn(`新建会话失败，卡片按已解析的目录/工作区创建：${describe(error)}`)
      warnings.push('新建会话失败，已填好目录/工作区，请在卡片里手动新建会话')
    }
    return result
  }

  return {
    /** 当前宿主是否支持自动新建会话（sessionController 可用）。 */
    available: () => Boolean(readService(getSessionController)),
    prepareCreate,
  }
}
