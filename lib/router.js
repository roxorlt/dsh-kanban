// 解耦的可扩展双层意图路由引擎（Stage Pipeline + 声明式 JSON 热加载规则 + Observe 灰度模式）：
//
// 设计原则：
// 1. 路由判定与传输层（飞书/钉钉/微信 cc2im/宿主常驻会话）完全解耦；
// 2. 支持三层渐进式扩展（从最易用到最灵活）：
//    - 方式 A（零代码对话式扩展，最易用）：直接对 Super Agent 或任意 MCP 客户端说「加一条路由规则…」，调用 `kanban_router_rules` 工具写入；
//    - 方式 B（声明式配置文件热加载）：编辑 `<dataDir>/router-rules.json`（按文件 mtime 自动热重载，无需重启宿主，且与代码仓库隔离）；
//    - 方式 C（编程式 Stage 插件）：通过 `createIntentRouter({ customStages })` 插入自定义异步/同步分类阶段。
// 3. 吸收官方 `dsh-superagent-prototype` 的 Policy Gate `mode: 'auto' | 'observe' | 'off'` 机制：
//    新规则可先设为 `observe`（试运行观察模式，只记录 `decision.observations` 不拦截原路由），验证无误后再切 `auto`。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ROUTER_MODES = ['auto', 'observe', 'off']
export const ROUTE_KINDS = ['direct_reply', 'board_query', 'approval_reply', 'task_followup', 'task_dispatch', 'custom_skill']

/**
 * 默认基础引导提示词；当存在自定义规则时，`composeSuperAgentPrompt(rules)` 会把生效中的规则摘要动态拼入系统段。
 */
export const SUPER_AGENT_BOOTSTRAP_PROMPT = [
  '你是常驻在宿主 DSH 左侧的「★ Super Agent」总控入口（不可归档、始终待命）。',
  '收到用户的每一条消息时，请先执行【双层意图路由判断】：',
  '',
  '1. 【直通闲聊/通用问答（Direct Reply）】：',
  '   - 若消息属于日常寒暄、概念解释、简短翻译、一次性算术/语法问答，且不涉及具体代码库改动、长耗时调研或多步交付，请直接在当前会话简洁回复，不要创建看板卡片。',
  '',
  '2. 【看板查询/审批拍板（Board Query / Approval）】：',
  '   - 若用户询问当前任务进展、进行中的卡片、具体卡点、待确认事项或对某张卡片拍板，务必调用 `kanban_boards` / `kanban_cards`（必要时对重点卡片继续调用 `kanban_card` 检查 `currentAction`、`approvals`、`runtime`、`activities`、`dependsOn` 与 `checklists`），给出具体进展与卡点结论，严禁只罗列裸卡片标题。',
  '',
  '3. 【看板纳管与派发（Kanban Task Dispatch）】：',
  '   - 若消息属于需要读写代码、排查问题、跑验收、多步调研或跨轮次跟进的任务：',
  '     a) 先调用 `kanban_cards` 检查是否已有同主题活跃卡片（若有则调用 `kanban_update_card` / `kanban_add_activity` 追加工单上下文）；',
  '     b) 若为新任务，调用 `kanban_create_card` 建卡（填写清晰的 `title`、`summary`、`checklists`，若需后台自动接力可设 `autoStart: true`，多卡串联用 `dependsOn`），优先用 `sessionMode: "new"` 派发独立 Worker 会话执行，保持当前总控入口轻量不阻塞（切勿在总控会话执行长耗时命令或 sleep）。',
  '     c) 若 Worker 执行后发现追问超出原卡片范围，引导回退（handback）由总控决定续跑或另立新卡。',
].join('\n')

const CHITCHAT_PATTERNS = [
  /^(你好|嗨|哈喽|早上好|下午好|晚上好|在吗|hi|hello|hey|ping|谢谢|多谢|感谢|再见|拜拜)[!！~～。.?？\s]*$/i,
  /^(什么是|解释一下|科普一下|为什么说|给我讲个|讲个笑话|翻译成|用一句话)/i,
]

const BOARD_QUERY_PATTERNS = [
  /^\/kanban\s+(status|list|board|digest|summary)\b/i,
  /(看板|待办|进行中|待确认|待我确认|有哪些卡|哪些任务|任务进度|当前卡片|汇总一下看板|有什么卡点|卡在哪)/i,
]

const APPROVAL_COMMAND_REGEX = /^(?:\/approve|\/resolve|批准|同意|确认|拒绝|驳回)\s+(card-[a-z0-9_-]{4,24})(?:\s+([^\s]+))?(?:\s+(.*))?$/i

const TASK_VERB_PATTERNS = [
  /(实现|开发|修复|排查|定位|重构|优化|部署|编写|新增|添加|修改|升级|迁移|测试|验收|回放|构建|抓取|跑一下|建卡|创建卡片|列个计划|拆解)/i,
  /\b(fix|implement|refactor|debug|deploy|build|test|create\s+card|issue|pr|bug|feature)\b/i,
  /([a-z0-9_-]+\/[a-z0-9_.-]+\.(?:js|ts|tsx|py|rs|go|md|json))|(`[^`]+`)/i,
]

// 按路径缓存 `<dataDir>/router-rules.json`（比较 mtimeMs + size 实现零开销热加载）
const rulesCache = new Map()

function cleanStr(value, maxLen = 500) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLen)
}

export function routerRulesPath(dataDir) {
  return dataDir ? join(dataDir, 'router-rules.json') : null
}

/**
 * 规范化单条声明式路由规则。
 */
export function normalizeRouterRule(raw = {}, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  const id = cleanStr(raw.id || `rule-${index + 1}`, 64).replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (!id) return null
  const mode = ROUTER_MODES.includes(raw.mode) ? raw.mode : (raw.enabled === false ? 'off' : 'auto')
  const enabled = raw.enabled !== false && mode !== 'off'
  const priority = Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 100

  const rawMatch = raw.match && typeof raw.match === 'object' ? raw.match : {}
  const prefixes = Array.isArray(rawMatch.prefixes)
    ? rawMatch.prefixes.map(s => cleanStr(s, 80)).filter(Boolean)
    : []
  const keywords = Array.isArray(rawMatch.keywords)
    ? rawMatch.keywords.map(s => cleanStr(s, 80)).filter(Boolean)
    : []
  const channels = Array.isArray(rawMatch.channels)
    ? rawMatch.channels.map(s => cleanStr(s, 40).toLowerCase()).filter(Boolean)
    : []
  const regex = typeof rawMatch.regex === 'string' && rawMatch.regex.trim() ? rawMatch.regex.trim().slice(0, 300) : undefined

  const rawAction = raw.action && typeof raw.action === 'object' ? raw.action : {}
  const route = ROUTE_KINDS.includes(rawAction.route) ? rawAction.route : 'task_dispatch'
  const rawDefaults = rawAction.cardDefaults && typeof rawAction.cardDefaults === 'object' ? rawAction.cardDefaults : {}
  const PRIORITY_ALIASES = { p0: 'urgent', p1: 'high', p2: 'medium', p3: 'low' }
  const rawPrio = cleanStr(rawDefaults.priority || '', 24).toLowerCase()
  const normalizedPriority = PRIORITY_ALIASES[rawPrio] || (['urgent', 'high', 'medium', 'low'].includes(rawPrio) ? rawPrio : '')
  const cardDefaults = {
    ...(rawDefaults.project ? { project: cleanStr(rawDefaults.project, 80) } : {}),
    ...(rawDefaults.cwd ? { cwd: cleanStr(rawDefaults.cwd, 500) } : {}),
    ...(rawDefaults.workspaceId ? { workspaceId: cleanStr(rawDefaults.workspaceId, 120) } : {}),
    ...(normalizedPriority ? { priority: normalizedPriority } : {}),
    ...(Array.isArray(rawDefaults.labels)
      ? { labels: rawDefaults.labels.map(s => cleanStr(s, 32)).filter(Boolean).slice(0, 8) }
      : {}),
    ...(typeof rawDefaults.autoStart === 'boolean' ? { autoStart: rawDefaults.autoStart } : {}),
    ...(rawDefaults.harness ? { harness: cleanStr(rawDefaults.harness, 40) } : {}),
  }

  return {
    id,
    name: cleanStr(raw.name || id, 120),
    description: cleanStr(raw.description || '', 300) || undefined,
    enabled,
    mode,
    priority,
    match: {
      ...(prefixes.length ? { prefixes } : {}),
      ...(keywords.length ? { keywords } : {}),
      ...(channels.length ? { channels } : {}),
      ...(regex ? { regex } : {}),
    },
    action: {
      route,
      ...(rawAction.skill ? { skill: cleanStr(rawAction.skill, 80) } : {}),
      ...(rawAction.instruction ? { instruction: cleanStr(rawAction.instruction, 500) } : {}),
      ...(Object.keys(cardDefaults).length ? { cardDefaults } : {}),
    },
  }
}

/**
 * 从 `<dataDir>/router-rules.json` 热加载声明式路由规则（文件不存在时返回空数组）。
 */
export function loadRouterRules(dataDir) {
  const file = routerRulesPath(dataDir)
  if (!file || !existsSync(file)) return []
  try {
    const st = statSync(file)
    const sig = `${st.mtimeMs}:${st.size}`
    const cached = rulesCache.get(file)
    if (cached && cached.sig === sig) return cached.rules
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rules) ? parsed.rules : [])
    const normalized = list
      .map((item, idx) => normalizeRouterRule(item, idx))
      .filter(Boolean)
      .sort((a, b) => b.priority - a.priority)
    rulesCache.set(file, { sig, rules: normalized })
    return normalized
  } catch {
    return []
  }
}

/**
 * 保存声明式路由规则到 `<dataDir>/router-rules.json` 并立即刷新缓存。
 */
export function saveRouterRules(dataDir, rules = []) {
  const file = routerRulesPath(dataDir)
  if (!file) throw new Error('缺少 dataDir，无法保存 router-rules.json')
  const normalized = (Array.isArray(rules) ? rules : [])
    .map((item, idx) => normalizeRouterRule(item, idx))
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority)
  mkdirSync(dirname(file), { recursive: true })
  const payload = JSON.stringify({ version: 1, updatedAt: Date.now(), rules: normalized }, null, 2) + '\n'
  writeFileSync(file, payload, 'utf8')
  try {
    const st = statSync(file)
    rulesCache.set(file, { sig: `${st.mtimeMs}:${st.size}`, rules: normalized })
  } catch {
    rulesCache.delete(file)
  }
  return normalized
}

/**
 * 动态合成常驻 Super Agent 会话的 systemPrompt 段（含当前生效的自定义路由规则表）。
 */
export function composeSuperAgentPrompt(rules = []) {
  const active = (Array.isArray(rules) ? rules : []).filter(r => r && r.enabled && r.mode !== 'off')
  if (!active.length) return SUPER_AGENT_BOOTSTRAP_PROMPT
  const ruleLines = active.map(r => {
    const conds = []
    if (r.match?.prefixes?.length) conds.push(`前缀 [${r.match.prefixes.join(', ')}]`)
    if (r.match?.keywords?.length) conds.push(`关键词 [${r.match.keywords.join(', ')}]`)
    if (r.match?.regex) conds.push(`正则 /${r.match.regex}/`)
    if (r.match?.channels?.length) conds.push(`渠道 [${r.match.channels.join(', ')}]`)
    const defaults = r.action?.cardDefaults ? JSON.stringify(r.action.cardDefaults) : ''
    const modeTag = r.mode === 'observe' ? '（灰度观察 observe）' : ''
    return `- [${r.id}] ${r.name}${modeTag}：当命中 ${conds.join(' 且 ') || '任意'} → 路由 \`${r.action?.route}\`${defaults ? `，默认卡片属性 ${defaults}` : ''}${r.action?.instruction ? `；指引：${r.action.instruction}` : ''}`
  })
  return [
    SUPER_AGENT_BOOTSTRAP_PROMPT,
    '',
    '4. 【当前生效的自定义路由规则（来自 router-rules.json 热加载）】：',
    ...ruleLines,
  ].join('\n')
}

function extractSuggestedCard(raw, cardDefaults = {}) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const firstLine = (lines[0] || '').replace(/^(?:\/[a-z0-9_-]+\s+|@[a-z0-9_-]+\s+)?(请|帮我|麻烦|我们需要|需要|能否|可以)?\s*/i, '')
  const suggestedTitle = cleanStr(firstLine, 80) || '新建 Super-Agent 任务'
  const bulletLines = lines.slice(1)
    .map(l => l.replace(/^[-*•\d.)、\s]+/, '').trim())
    .filter(l => l.length >= 2 && l.length <= 180)
    .slice(0, 8)
  return {
    title: suggestedTitle,
    summary: cleanStr(raw, 600),
    checklists: bulletLines,
    autoStart: cardDefaults.autoStart !== undefined ? cardDefaults.autoStart : true,
    ...(cardDefaults.project ? { project: cardDefaults.project } : {}),
    ...(cardDefaults.cwd ? { cwd: cardDefaults.cwd } : {}),
    ...(cardDefaults.workspaceId ? { workspaceId: cardDefaults.workspaceId } : {}),
    ...(cardDefaults.priority ? { priority: cardDefaults.priority } : {}),
    ...(Array.isArray(cardDefaults.labels) && cardDefaults.labels.length ? { labels: cardDefaults.labels } : {}),
    ...(cardDefaults.harness ? { harness: cardDefaults.harness } : {}),
  }
}

function matchRule(rule, { raw, lower, channel }) {
  if (!rule || !rule.enabled || rule.mode === 'off') return false
  const m = rule.match || {}
  const hasAnyCondition = Boolean(
    (m.prefixes && m.prefixes.length)
    || (m.keywords && m.keywords.length)
    || (m.channels && m.channels.length)
    || m.regex,
  )
  if (!hasAnyCondition) return false

  if (m.channels && m.channels.length) {
    const ch = String(channel || '').toLowerCase()
    if (!ch || !m.channels.includes(ch)) return false
  }
  if (m.prefixes && m.prefixes.length) {
    const hit = m.prefixes.some(p => lower.startsWith(p.toLowerCase()))
    if (!hit) return false
  }
  if (m.keywords && m.keywords.length) {
    const hit = m.keywords.some(k => lower.includes(k.toLowerCase()))
    if (!hit) return false
  }
  if (m.regex) {
    try {
      const re = new RegExp(m.regex, 'i')
      if (!re.test(raw)) return false
    } catch {
      return false
    }
  }
  return true
}

function buildRuleDecision(rule, raw) {
  const route = rule.action?.route || 'task_dispatch'
  const defaults = rule.action?.cardDefaults || {}
  const shouldUseKanban = route !== 'direct_reply'
  const recommendedTools = route === 'board_query'
    ? ['kanban_boards', 'kanban_cards']
    : route === 'direct_reply'
      ? []
      : ['kanban_create_card', 'kanban_update_card', 'kanban_complete_card']

  return {
    route,
    confidence: 0.96,
    reason: `custom_rule:${rule.id}`,
    matchedRule: {
      id: rule.id,
      name: rule.name,
      mode: rule.mode,
      ...(rule.action?.skill ? { skill: rule.action.skill } : {}),
      ...(rule.action?.instruction ? { instruction: rule.action.instruction } : {}),
    },
    shouldUseKanban,
    ...(route === 'task_dispatch' || route === 'custom_skill'
      ? { suggestedCard: extractSuggestedCard(raw, defaults) }
      : {}),
    recommendedTools,
  }
}

/**
 * 创建可插拔的 Stage Pipeline 路由器实例。
 */
export function createIntentRouter({ customStages = [], getRules } = {}) {
  const builtinStages = [
    {
      name: 'approval_command',
      priority: 1000,
      evaluate(ctx) {
        const approvalMatch = ctx.raw.match(APPROVAL_COMMAND_REGEX)
        if (!approvalMatch) return null
        const targetCardId = approvalMatch[1]
        const optionToken = approvalMatch[2] || ''
        const comment = approvalMatch[3] || ''
        const card = ctx.cards.find(c => c.id === targetCardId)
        const pending = (card?.approvals || []).find(a => a.status === 'pending')
        const isRejectWord = /^(拒绝|驳回|reject|no)$/i.test(ctx.raw.split(/\s+/)[0])
        const resolvedOptionId = optionToken
          || (isRejectWord
            ? (pending?.options?.find(o => o.tone === 'danger' || /no|reject|cancel/i.test(o.id))?.id || pending?.options?.[pending.options.length - 1]?.id)
            : pending?.options?.[0]?.id)
        return {
          route: 'approval_reply',
          confidence: 0.98,
          reason: 'explicit_approval_command',
          shouldUseKanban: true,
          cardId: targetCardId,
          approvalId: pending?.id || null,
          optionId: resolvedOptionId || null,
          comment: comment || undefined,
          recommendedTools: ['kanban_resolve_approval'],
        }
      },
    },
    {
      name: 'thread_subscription',
      priority: 900,
      evaluate(ctx) {
        const mentionedCardId = ctx.cardId || (ctx.raw.match(/\b(card-[a-z0-9]{6,16})\b/i)?.[1] ?? null)
        const isPersonalDmThread = /^(?:weixin|wx-user|cc2im):/i.test(String(ctx.externalThreadId || ''))
        const boundCard = (mentionedCardId && ctx.cards.find(c => c.id === mentionedCardId))
          || (ctx.externalThreadId && ctx.cards.find(c => c.externalThreadId === ctx.externalThreadId && c.status !== 'done' && c.status !== 'canceled'))
          || (ctx.externalRef && ctx.cards.find(c => c.externalRef === ctx.externalRef))
        if (!boundCard) return null

        const pending = (boundCard.approvals || []).find(a => a.status === 'pending')
        if (pending && boundCard.status === 'needs_you') {
          const options = pending.options || []
          const numMatch = ctx.raw.match(/^([1-9])\s*$/)
          const numOpt = numMatch ? options[Number(numMatch[1]) - 1] : null
          const matchedOpt = numOpt || options.find(
            opt => opt.id.toLowerCase() === ctx.lower || opt.label === ctx.raw || ctx.raw.includes(opt.label),
          )
          if (matchedOpt) {
            return {
              route: 'approval_reply',
              confidence: 0.95,
              reason: 'thread_approval_option_match',
              shouldUseKanban: true,
              cardId: boundCard.id,
              approvalId: pending.id,
              optionId: matchedOpt.id,
              recommendedTools: ['kanban_resolve_approval'],
            }
          }
        }
        // 个人微信 1v1 私聊没有子话题（Thread）隔离：未显式点名 card-xxx 且未命中待确认审批时，不把新提问/新任务吞进旧卡
        if (isPersonalDmThread && !mentionedCardId) return null

        return {
          route: 'task_followup',
          confidence: 0.94,
          reason: 'thread_subscription_passthrough',
          shouldUseKanban: true,
          cardId: boundCard.id,
          cardTitle: boundCard.title,
          recommendedTools: ['kanban_update_card', 'kanban_add_comment'],
        }
      },
    },
    {
      name: 'custom_rules',
      priority: 800,
      evaluate(ctx) {
        const rules = typeof getRules === 'function' ? (getRules(ctx) || []) : (ctx.rules || [])
        for (const rawRule of rules) {
          const rule = rawRule?.match ? rawRule : normalizeRouterRule(rawRule)
          if (!rule || !matchRule(rule, ctx)) continue
          const candidate = buildRuleDecision(rule, ctx.raw)
          if (rule.mode === 'observe') {
            ctx.observations.push({
              ruleId: rule.id,
              ruleName: rule.name,
              wouldRoute: candidate.route,
              cardDefaults: rule.action?.cardDefaults || null,
            })
            continue
          }
          return candidate
        }
        return null
      },
    },
    {
      name: 'board_query',
      priority: 600,
      evaluate(ctx) {
        if (BOARD_QUERY_PATTERNS.some(re => re.test(ctx.raw)) && !TASK_VERB_PATTERNS.some(re => re.test(ctx.raw))) {
          return {
            route: 'board_query',
            confidence: 0.9,
            reason: 'board_status_query',
            shouldUseKanban: true,
            recommendedTools: ['kanban_boards', 'kanban_cards'],
          }
        }
        return null
      },
    },
    {
      name: 'chitchat_fastpath',
      priority: 400,
      evaluate(ctx) {
        const isShortConversational = ctx.raw.length <= 45 && !TASK_VERB_PATTERNS.some(re => re.test(ctx.raw))
        if (CHITCHAT_PATTERNS.some(re => re.test(ctx.raw)) || (isShortConversational && !ctx.raw.includes('\n'))) {
          return {
            route: 'direct_reply',
            confidence: 0.9,
            reason: 'chitchat_or_general_qa',
            shouldUseKanban: false,
            recommendedTools: [],
          }
        }
        return null
      },
    },
    {
      name: 'task_heuristic',
      priority: 100,
      evaluate(ctx) {
        const hasTaskSignal = TASK_VERB_PATTERNS.some(re => re.test(ctx.raw))
        return {
          route: 'task_dispatch',
          confidence: hasTaskSignal ? 0.88 : 0.68,
          reason: hasTaskSignal ? 'actionable_task_detected' : 'long_message_semantic_fallback',
          ...(hasTaskSignal ? {} : { needsLlmConfirm: true }),
          shouldUseKanban: true,
          suggestedCard: extractSuggestedCard(ctx.raw),
          recommendedTools: ['kanban_create_card', 'kanban_update_card', 'kanban_complete_card'],
        }
      },
    },
  ]

  const stages = [...builtinStages, ...customStages]
    .filter(s => s && typeof s.evaluate === 'function')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  return {
    stages: stages.map(s => ({ name: s.name || 'custom', priority: s.priority ?? 0 })),
    classify(draft, input = {}, options = {}) {
      const raw = cleanStr(input.text, 4000)
      if (!raw) {
        return {
          route: 'direct_reply',
          confidence: 1,
          reason: 'empty_message',
          shouldUseKanban: false,
          recommendedTools: [],
        }
      }
      const rules = Array.isArray(options.rules)
        ? options.rules
        : (options.dataDir ? loadRouterRules(options.dataDir) : [])
      const ctx = {
        draft,
        cards: Array.isArray(draft?.cards) ? draft.cards.filter(c => !c.archived) : [],
        raw,
        lower: raw.toLowerCase(),
        externalThreadId: input.externalThreadId,
        externalRef: input.externalRef,
        cardId: input.cardId,
        channel: input.provider || input.channel || '',
        rules,
        observations: [],
      }

      for (const stage of stages) {
        const decision = stage.evaluate(ctx)
        if (decision) {
          return {
            ...decision,
            stage: stage.name || 'custom',
            ...(ctx.observations.length ? { observations: ctx.observations } : {}),
          }
        }
      }

      return {
        route: 'direct_reply',
        confidence: 0.5,
        reason: 'fallback_direct_reply',
        shouldUseKanban: false,
        recommendedTools: [],
        ...(ctx.observations.length ? { observations: ctx.observations } : {}),
      }
    },
  }
}

const defaultRouter = createIntentRouter()

/**
 * 兼容函数入口：支持传入 `options = { rules, dataDir }` 执行声明式热加载规则匹配。
 */
export function classifySuperAgentIntent(draft, input = {}, options = {}) {
  return defaultRouter.classify(draft, input, options)
}
