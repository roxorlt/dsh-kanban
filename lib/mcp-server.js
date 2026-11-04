// DSH Kanban 标准 MCP (Model Context Protocol) Server：
// 将看板作为跨 Agent / 跨 Harness（DSH、Claude Code、Codex、Cursor、Antigravity 等）的公共任务控制面与 Outbox 调度总线。
// 同时支持：
// 1) HTTP JSON-RPC 端点（POST /api/kanban/mcp）
// 2) 标准 stdio JSON-RPC 进程（node bin/kanban-mcp.mjs）
import readline from 'node:readline'
import {
  ackOutbox, addComment, defaultActor, enqueueOutbox,
  getAutoAdvanceEnabled, getSuperAgentSessionId, leaseOutbox, requireCard, setAutoAdvanceEnabled,
} from './domain.js'
import {
  classifySuperAgentIntent, loadRouterRules, normalizeRouterRule, saveRouterRules,
} from './im-gateway.js'
import { createTools } from './tools.js'

export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const MCP_SERVER_INFO = {
  name: 'dsh-kanban-mcp',
  version: '0.28.0',
}

function buildExtraMcpTools(store) {
  return [
    {
      name: 'kanban_outbox_lease',
      description: '【跨 Harness 公共执行器】按租约拉取待执行的看板 Outbox 任务（支持按 harness 过滤，如 dsh / claude-code / codex / cursor / antigravity）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          owner: { type: 'string', maxLength: 120, description: '消费方实例标识（如 claude-worker-1）' },
          harness: { type: 'string', maxLength: 40, description: '仅拉取指定 harness 的任务（可选）' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
          leaseMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 30000 },
        },
      },
      async execute(args = {}) {
        const { result, revision } = await store.update(draft => leaseOutbox(draft, {
          owner: args.owner || 'mcp-worker',
          harness: args.harness,
          limit: args.limit,
          leaseMs: args.leaseMs,
        }))
        return JSON.stringify({ ok: true, ...result, revision })
      },
    },
    {
      name: 'kanban_outbox_ack',
      description: '【跨 Harness 公共执行器】确认（ACK）或回报失败一条 Outbox 任务，可选回填外部 Agent 的 sessionId。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'integer', minimum: 1, description: 'Outbox 条目序号 seq' },
          owner: { type: 'string', maxLength: 120 },
          ok: { type: 'boolean', default: true },
          sessionId: { type: 'string', maxLength: 160, description: '外部 Agent 会话 ID（可选，自动绑定到卡片）' },
          error: { type: 'string', maxLength: 300 },
        },
        required: ['seq'],
      },
      async execute(args = {}) {
        const { result, revision } = await store.update(draft => ackOutbox(draft, args.seq, {
          owner: args.owner || 'mcp-worker',
          ok: args.ok !== false,
          sessionId: args.sessionId,
          error: args.error,
        }))
        return JSON.stringify({ ok: true, ...result, revision })
      },
    },
    {
      name: 'kanban_route_intent',
      description: '【Super-Agent 双层意图路由】判断入站消息属于闲聊问答（direct_reply）、看板查询（board_query）、审批回复（approval_reply）、线程追问（task_followup）还是工程任务建卡派发（task_dispatch）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', maxLength: 4000, description: '用户输入文本' },
          externalThreadId: { type: 'string', maxLength: 200 },
          externalRef: { type: 'string', maxLength: 200 },
          cardId: { type: 'string', maxLength: 40 },
          provider: { type: 'string', maxLength: 40 },
        },
        required: ['text'],
      },
      async execute(args = {}) {
        const snapshot = await store.read()
        const decision = classifySuperAgentIntent(snapshot, args, { dataDir: store.dataDir })
        return JSON.stringify({ ok: true, decision })
      },
    },
    {
      name: 'kanban_router_rules',
      description: '【零代码扩展 Super-Agent 路由规则】列出（list）、新增/更新（upsert，支持 observe 灰度观察或 auto 自动生效）或删除（remove）声明式意图路由规则，持久化于当前用户 `<dataDir>/router-rules.json` 并立即热加载。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'upsert', 'remove'], default: 'list' },
          ruleId: { type: 'string', maxLength: 64, description: 'remove 时指定要删除的规则 ID' },
          rule: {
            type: 'object',
            description: 'upsert 时传入的规则定义：{ id, name, mode: "auto"|"observe"|"off", priority, match: { prefixes, keywords, regex, channels }, action: { route, instruction, cardDefaults: { project, cwd, priority, labels, autoStart, harness } } }',
          },
        },
      },
      async execute(args = {}) {
        const action = args.action || 'list'
        const current = loadRouterRules(store.dataDir)
        if (action === 'list') {
          return JSON.stringify({ ok: true, dataDir: store.dataDir, rules: current })
        }
        if (action === 'remove') {
          const next = current.filter(r => r.id !== args.ruleId)
          const saved = saveRouterRules(store.dataDir, next)
          return JSON.stringify({ ok: true, removed: args.ruleId, rules: saved })
        }
        if (action === 'upsert') {
          const normalized = normalizeRouterRule(args.rule || {}, current.length)
          if (!normalized) {
            return JSON.stringify({ ok: false, error: { code: 'BAD_RULE', message: 'rule 格式不合法' } })
          }
          const idx = current.findIndex(r => r.id === normalized.id)
          const next = [...current]
          if (idx >= 0) next[idx] = normalized
          else next.push(normalized)
          const saved = saveRouterRules(store.dataDir, next)
          return JSON.stringify({ ok: true, upserted: normalized, rules: saved })
        }
        return JSON.stringify({ ok: false, error: { code: 'BAD_ACTION', message: `未知 action: ${action}` } })
      },
    },
    {
      name: 'kanban_handback_card',
      description: '【Worker 越界回退总控（Handback）】当 Worker 发现用户后续需求超出当前卡片验收边界时，记录 handback 说明并唤醒 ★ Super Agent 总控会话决定拆新卡或扩界。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardId: { type: 'string', maxLength: 40 },
          reason: { type: 'string', maxLength: 600, description: '超出当前卡片边界的原因与上下文' },
          suggestedFollowupTitle: { type: 'string', maxLength: 160, description: '建议派生的后续新卡标题（可选）' },
        },
        required: ['cardId', 'reason'],
      },
      async execute(args = {}, exec = {}) {
        const now = Date.now()
        const actor = defaultActor('agent', exec?.agent?.name || 'Worker Agent')
        const { result, revision } = await store.update(draft => {
          const card = requireCard(draft, args.cardId)
          const { activity } = addComment(draft, card.id, {
            text: `【Worker Handback 回退总控】${args.reason}${args.suggestedFollowupTitle ? `（建议派生新卡：${args.suggestedFollowupTitle}）` : ''}`,
            actor,
            now,
          })
          const superSess = getSuperAgentSessionId(draft)
          if (superSess) {
            enqueueOutbox(draft, {
              idempotencyKey: `handback:${card.id}:${activity.id}`,
              cardId: card.id,
              expectedGeneration: card.runtime?.generation ?? 1,
              kind: 'wake',
              target: { sessionId: superSess },
              prompt: `【看板·Worker Handback】卡片「${card.title}」（${card.id}）回报越界请求：\n${args.reason}${args.suggestedFollowupTitle ? `\n建议新卡标题：${args.suggestedFollowupTitle}` : ''}\n请评估是否调用 kanban_create_card 派生后续依赖卡片。`,
              mode: 'queue',
              notBefore: now,
            }, { now })
          }
          return { cardId: card.id, superAgentSessionId: superSess }
        })
        return JSON.stringify({ ok: true, ...result, revision })
      },
    },
    {
      name: 'kanban_autopilot',
      description: '【全局自动推进总开关（Autopilot）】读取或设置看板全局自动推进开关（enabled: true/false）。关闭后暂停所有待办自动点火、依赖完成自动接力、Watchdog 静默催办与自动退避重试，同时保留单卡原有的 autoStart 配置。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: {
            type: 'boolean',
            description: '可选：传入 true 开启全局自动推进，传入 false 暂停全局自动推进；省略则只读取当前状态。',
          },
        },
      },
      async execute(args = {}, exec = {}) {
        if (typeof args.enabled !== 'boolean') {
          const snapshot = await store.read()
          return JSON.stringify({
            ok: true,
            autoAdvanceEnabled: getAutoAdvanceEnabled(snapshot),
            revision: snapshot.meta?.revision ?? 0,
          })
        }
        const actor = defaultActor('agent', exec?.agent?.name || 'MCP Agent')
        const { result, revision } = await store.update(draft => (
          setAutoAdvanceEnabled(draft, args.enabled, { actor })
        ))
        return JSON.stringify({
          ok: true,
          autoAdvanceEnabled: result.enabled,
          revision,
        })
      },
    },
  ]
}

export function createMcpToolRegistry(store, { sessionBinding } = {}) {
  const baseTools = createTools({ store, sessionBinding })
  const extraTools = buildExtraMcpTools(store)
  const allTools = [...baseTools, ...extraTools]
  const byName = new Map(allTools.map(tool => [tool.name, tool]))
  return {
    list() {
      return allTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input?.schema || tool.parameters || { type: 'object', properties: {} },
      }))
    },
    get(name) {
      return byName.get(name) || null
    },
  }
}

/**
 * 处理单条 JSON-RPC 2.0 MCP 请求：
 * - 若为 notification（无 id），返回 null；
 * - 若为标准 method 调用，返回 `{ jsonrpc: '2.0', id, result | error }`。
 */
export async function handleMcpJsonRpc(store, message, { registry, agentName = 'MCP Agent', harness = 'mcp' } = {}) {
  if (!message || typeof message !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    }
  }

  const toolRegistry = registry || createMcpToolRegistry(store)
  const { id, method, params } = message

  // Notification (no id)
  if (id === undefined) {
    return null
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: MCP_SERVER_INFO,
        },
      }
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} }
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: toolRegistry.list(),
        },
      }
    }

    if (method === 'tools/call') {
      const toolName = params?.name
      const toolArgs = (params?.arguments && typeof params.arguments === 'object') ? params.arguments : {}
      const tool = toolRegistry.get(toolName)
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${String(toolName)}` },
        }
      }
      const rawOutput = await tool.execute(toolArgs, {
        agent: { id: `${harness}:${agentName}`, name: agentName },
      })
      let parsed = null
      try { parsed = JSON.parse(rawOutput) } catch {}
      const isError = parsed && parsed.ok === false
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput),
            },
          ],
          ...(isError ? { isError: true } : {}),
        },
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error?.message || 'Internal MCP server error',
      },
    }
  }
}

/**
 * 启动基于 stdio（换行分隔 JSON-RPC）的 MCP Server，供 Claude Code / Codex / Cursor / Antigravity 直接挂载。
 */
export function startMcpStdioServer({
  store,
  input = process.stdin,
  output = process.stdout,
  agentName = process.env.KANBAN_AGENT_NAME || 'External MCP Agent',
  harness = process.env.KANBAN_HARNESS || 'mcp',
} = {}) {
  const registry = createMcpToolRegistry(store)
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  rl.on('line', async line => {
    const trimmed = line.trim()
    if (!trimmed) return
    let payload
    try {
      payload = JSON.parse(trimmed)
    } catch {
      output.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }) + '\n')
      return
    }
    const response = await handleMcpJsonRpc(store, payload, { registry, agentName, harness })
    if (response) {
      output.write(JSON.stringify(response) + '\n')
    }
  })

  return {
    close() {
      rl.close()
    },
  }
}
