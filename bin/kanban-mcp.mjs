#!/usr/bin/env node
// DSH Kanban 独立 stdio MCP Server 入口：
// 供 Claude Code / Codex / Cursor / Antigravity 等外部 Agent/Harness 直接通过 stdio 挂载运行者本机的看板数据。
// 数据完全与代码解耦：默认读写运行者本机的 ~/.dsh-kanban（可通过 --data-dir 或 DSH_KANBAN_DIR 指定任意独立目录）。
// 用法：node bin/kanban-mcp.mjs [--data-dir ~/.dsh-kanban] [--harness claude-code] [--agent-name "Claude Worker"]
import os from 'node:os'
import path from 'node:path'
import { startMcpStdioServer } from '../lib/mcp-server.js'
import { createStore } from '../lib/store.js'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write([
    'dsh-kanban MCP stdio server',
    '',
    'Usage:',
    '  kanban-mcp [--data-dir <dir>] [--harness <name>] [--agent-name <label>]',
    '',
    'Environment variables:',
    '  DSH_KANBAN_DIR     Kanban state directory (defaults to ~/.dsh-kanban on the runner machine)',
    '  KANBAN_HARNESS     Harness identifier (e.g. claude-code, codex, cursor, antigravity)',
    '  KANBAN_AGENT_NAME  Display name recorded in card activities',
    '',
  ].join('\n'))
  process.exit(0)
}

function parseArg(flag, fallback) {
  const idx = process.argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return fallback
}

const dataDir = parseArg('--data-dir', process.env.DSH_KANBAN_DIR || path.join(os.homedir(), '.dsh-kanban'))
const harness = parseArg('--harness', process.env.KANBAN_HARNESS || 'mcp')
const agentName = parseArg('--agent-name', process.env.KANBAN_AGENT_NAME || `${harness} Agent`)

const store = createStore({ dataDir })
await store.ready()

startMcpStdioServer({
  store,
  harness,
  agentName,
})
