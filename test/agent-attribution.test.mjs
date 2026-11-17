// agent-attribution.test.mjs：宿主 DSH DeepSeek 与外部跨端 Harness（Carbon · Gemini / Codex 等）自动归属闭环单测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createCard,
  recordSessionTurnMetrics,
  recordSessionTurnStart,
  resolveAgentAttribution,
} from '../lib/domain.js'
import { toCloudCard } from '../lib/cloud-sync-protocol.js'
import { handleMcpJsonRpc } from '../lib/mcp-server.js'
import { createTools } from '../lib/tools.js'
import { handleRequest } from '../cloudflare/worker.mjs'
import { createCloudSyncClient } from '../lib/cloud-sync-client.js'
import { HAS_SQLITE, TOKEN, callWorker, makeWorkerEnv } from './cloud-worker-harness.mjs'
import { startServer, testStore } from './helpers.mjs'

function byName(tools) {
  return Object.fromEntries(tools.map(tool => [tool.name, tool]))
}

test('resolveAgentAttribution：统一区分 DSH 宿主 DeepSeek 与 Carbon / Codex 外部 Harness', () => {
  assert.deepEqual(
    resolveAgentAttribution({ id: 'agent-1' }, { defaultHarness: 'dsh' }),
    { name: 'DeepSeek', id: 'agent-1', harness: 'dsh' },
  )
  assert.deepEqual(
    resolveAgentAttribution({ name: 'DSH Agent' }),
    { name: 'DeepSeek', id: 'dsh:deepseek', harness: 'dsh' },
  )
  assert.deepEqual(
    resolveAgentAttribution({ name: 'Antigravity', harness: 'antigravity' }),
    { name: 'Carbon · Gemini', id: 'carbon:Carbon · Gemini', harness: 'carbon' },
  )
  assert.deepEqual(
    resolveAgentAttribution({ name: 'Carbon · Gemini', harness: 'carbon' }),
    { name: 'Carbon · Gemini', id: 'carbon:Carbon · Gemini', harness: 'carbon' },
  )
  assert.deepEqual(
    resolveAgentAttribution({ harness: 'codex' }),
    { name: 'Codex', id: 'codex:Codex', harness: 'codex' },
  )
})

test('DSH 宿主工具与会话生命周期：无需手传 agent 参数即自动归属 DeepSeek (dsh)', async t => {
  const { store } = await testStore(t, { seedMode: 'empty' })
  const tools = byName(createTools({ store }))
  const hostExec = { agent: { id: 'dsh-host-session' } }

  const created = JSON.parse(await tools.kanban_create_card.execute({
    title: '宿主任务自动归属',
    project: 'rQuant',
  }, hostExec))
  assert.equal(created.ok, true)
  assert.deepEqual(created.card.agent, {
    name: 'DeepSeek',
    id: 'dsh-host-session',
    harness: 'dsh',
  })

  // 列表摘要与关键字搜索同时暴露 agent 归属
  const listed = JSON.parse(await tools.kanban_cards.execute({ q: 'deepseek' }))
  assert.equal(listed.cards.length, 1)
  assert.deepEqual(listed.cards[0].agent, {
    name: 'DeepSeek',
    id: 'dsh-host-session',
    harness: 'dsh',
  })

  // 未填 agent 的手工卡片在绑定会话触发 turn/start 或 turn/end 计量时自动补齐宿主归属
  await store.update(draft => {
    const { card } = createCard(draft, {
      title: '手工建卡待宿主执行',
      sessionId: 'sess-host-1',
    })
    assert.equal(card.agent, undefined)
    recordSessionTurnStart(draft, { sessionId: 'sess-host-1' })
    assert.deepEqual(card.agent, {
      name: 'DeepSeek',
      id: 'dsh:deepseek',
      harness: 'dsh',
    })

    const { card: second } = createCard(draft, {
      title: '手工建卡计量回填',
      status: 'running',
      sessionId: 'sess-host-2',
    })
    recordSessionTurnMetrics(draft, { sessionId: 'sess-host-2', turn: 1, toolCalls: 2 })
    assert.deepEqual(second.agent, {
      name: 'DeepSeek',
      id: 'dsh:deepseek',
      harness: 'dsh',
    })
  })
})

test('本地 MCP 外部 Harness：自动写入 Carbon · Gemini，且旁路 comment 不篡改既有归属', async t => {
  const { store } = await testStore(t, { seedMode: 'empty' })

  const createRes = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'kanban_create_card',
      arguments: { title: 'Carbon 跨端推进卡片', project: 'rQuant L2' },
    },
  }, { agentName: 'Carbon · Gemini', harness: 'carbon' })
  const created = JSON.parse(createRes.result.content[0].text)
  assert.equal(created.ok, true)
  assert.deepEqual(created.card.agent, {
    name: 'Carbon · Gemini',
    id: 'carbon:Carbon · Gemini',
    harness: 'carbon',
  })

  // 另一 Agent 追加纯评论（comment）时保持 backfill 模式，不覆盖原执行归属
  await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'kanban_add_activity',
      arguments: {
        cardId: created.card.id,
        type: 'comment',
        text: '宿主巡检备注',
      },
    },
  }, { agentName: 'DeepSeek', harness: 'dsh' })

  const afterComment = (await store.read()).cards.find(card => card.id === created.card.id)
  assert.equal(afterComment.agent.name, 'Carbon · Gemini')
  assert.equal(afterComment.agent.harness, 'carbon')

  // 另一 Agent 实质接手推进（progress / move / complete）时归属更新为新执行方
  await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'kanban_move_card',
      arguments: { cardId: created.card.id, column: 'running', currentAction: 'Codex 接手压测' },
    },
  }, { agentName: 'Codex', harness: 'codex' })

  const afterHandover = (await store.read()).cards.find(card => card.id === created.card.id)
  assert.deepEqual(afterHandover.agent, {
    name: 'Codex',
    id: 'codex:Codex',
    harness: 'codex',
  })
})

test('toCloudCard：向 D1 镜像同步保留 agent.harness，同时继续剥离本地 agent.id', () => {
  const sanitized = toCloudCard({
    id: 'card-attr0001',
    boardId: 'board-default',
    title: 'Cloud 归属脱敏测试',
    summary: '',
    status: 'running',
    priority: 'high',
    labels: [],
    project: 'rQuant',
    cwd: '/Users/roxor/rquant',
    sessionIds: ['sess-secret'],
    agent: { name: 'Carbon · Gemini', id: 'carbon:local-pid-99', harness: 'carbon' },
    checklists: [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 3, searches: 1 },
    order: 1000,
    version: 2,
    createdAt: 100,
    updatedAt: 200,
  })
  assert.deepEqual(sanitized.agent, {
    name: 'Carbon · Gemini',
    harness: 'carbon',
  })
  assert.equal('id' in sanitized.agent, false)
})

const cloudIt = HAS_SQLITE ? test : test.skip

cloudIt('Cloud Remote MCP + C3 回放：x-kanban-agent / x-kanban-harness 自动归属并同步回 D1', async t => {
  const env = makeWorkerEnv()
  t.after(() => env.DB.close())

  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  await writeFile(join(dir, 'cloud-config.json'), JSON.stringify({
    version: 1,
    enabled: true,
    workerUrl: 'https://worker.test',
    token: TOKEN,
    clientId: 'mac-attr-e2e',
    sync: { enabled: true, pushDebounceMs: 20, pullIntervalMs: 60_000 },
    ingress: { enabled: true, claimIntervalMs: 60_000, batchSize: 20, leaseSeconds: 120 },
  }, null, 2), { mode: 0o600 })

  const server = await startServer(t, { store })

  const rpcRes = await callWorker(env, '/v1/mcp', {
    method: 'POST',
    token: TOKEN,
    headers: {
      'x-kanban-agent': 'Carbon · Gemini',
      'x-kanban-harness': 'carbon',
    },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'kanban_create_card',
        arguments: {
          title: '远程 Carbon 自动归属卡片',
          project: 'rQuant',
        },
      },
    },
  })
  assert.equal(rpcRes.status, 200)
  const queued = JSON.parse(rpcRes.json.result.content[0].text)
  assert.equal(queued.queued, true)

  const syncClient = createCloudSyncClient({
    store,
    dataDir: dir,
    fetchImpl: (url, init = {}) => handleRequest(new Request(String(url), init), env, { now: Date.now() }),
    localFetchImpl: (...args) => globalThis.fetch(...args),
    logger: { info() {}, warn() {}, error() {} },
    timing: {
      pushDebounceMs: 20,
      pullIntervalMs: 60_000,
      claimIntervalMs: 60_000,
      retryBaseMs: 20,
      retryMaxMs: 160,
      requestTimeoutMs: 3000,
      localRequestTimeoutMs: 3000,
    },
  })
  syncClient.setLocalOrigin(server.url)
  await syncClient.start()
  t.after(() => syncClient.stop())

  await syncClient.claimInboxNow()
  await syncClient.syncNow()

  // D1 远程查询：cardBrief 与 q 搜索均包含 Carbon · Gemini + harness=carbon，且无 id
  const queryRes = await callWorker(env, '/v1/mcp', {
    method: 'POST',
    token: TOKEN,
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'kanban_cards',
        arguments: { q: 'carbon' },
      },
    },
  })
  const queried = JSON.parse(queryRes.json.result.content[0].text)
  assert.equal(queried.cards.length, 1)
  assert.equal(queried.cards[0].id, queued.cardId)
  assert.deepEqual(queried.cards[0].agent, {
    name: 'Carbon · Gemini',
    harness: 'carbon',
  })
})
