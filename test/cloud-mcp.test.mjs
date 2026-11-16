// cloud-mcp.test.mjs：Cloudflare Worker + D1 远程 Streamable HTTP MCP 端到端测试。
//
// 覆盖重点：
// 1. 安全与开源隔离：未配令牌 fail-closed 503、缺/错 Bearer 全方法 401、MCP_BEARER_TOKEN 与 CLOUD_SYNC_TOKEN 权限隔离；
// 2. Streamable HTTP 协议合规：initialize 协商、notifications/initialized 202 空体、GET 405 Allow 头、DELETE 204、JSON-RPC 批处理；
// 3. Mac 合盖离线期间 D1 只读工具 7x24 直查（boards / cards / card / review_board / dryRun），且绝不泄露本地 cwd / sessionIds；
// 4. 离线写入入队 + 确定性预分配 cardId 连续串联操作 + 执行面字段双重剥离 + Mac 唤醒按序回放并同步回 D1 + 幂等防重。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCard, requestApproval } from '../lib/domain.js'
import { handleRequest } from '../cloudflare/worker.mjs'
import { createCloudSyncClient } from '../lib/cloud-sync-client.js'
import {
  buildInitialCloudConfig,
  extractD1Uuid,
  extractWorkerUrl,
  renderLocalWranglerToml,
} from '../scripts/setup-cloud.mjs'
import { HAS_SQLITE, TOKEN, callWorker, makeWorkerEnv } from './cloud-worker-harness.mjs'
import { api, startServer, testStore } from './helpers.mjs'

const it = HAS_SQLITE ? test : test.skip

const WORKER_URL = 'https://worker.test'
const FAST_TIMING = {
  pushDebounceMs: 20,
  pullIntervalMs: 60_000,
  claimIntervalMs: 60_000,
  retryBaseMs: 20,
  retryMaxMs: 160,
  requestTimeoutMs: 3000,
  localRequestTimeoutMs: 3000,
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} }
}

async function writeCloudConfig(dir, token = TOKEN) {
  const config = {
    version: 1,
    enabled: true,
    workerUrl: WORKER_URL,
    token,
    clientId: 'macbook-mcp-e2e',
    sync: { enabled: true, pushDebounceMs: 2000, pullIntervalMs: 30000 },
    ingress: { enabled: true, claimIntervalMs: 30000, batchSize: 20, leaseSeconds: 120 },
  }
  await writeFile(join(dir, 'cloud-config.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
  return config
}

function createWorkerCloud(env) {
  const state = { online: true, env }
  const fetchImpl = async (url, init = {}) => {
    if (!state.online) throw new TypeError('fetch failed: macbook asleep')
    return handleRequest(new Request(String(url), init), state.env, { now: Date.now() })
  }
  return { state, fetchImpl }
}

async function callMcpRpc(env, body, { token = TOKEN, path = '/v1/mcp', headers = {}, now = Date.now() } = {}) {
  return callWorker(env, path, {
    method: 'POST',
    token,
    headers: {
      'x-kanban-agent': 'Antigravity',
      'x-kanban-harness': 'antigravity',
      ...headers,
    },
    body,
    now,
  })
}

async function callMcpTool(env, name, args = {}, options = {}) {
  const res = await callMcpRpc(env, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }, options)
  assert.equal(res.status, 200)
  assert.equal(res.json?.jsonrpc, '2.0')
  assert.ok(!res.json?.error, `unexpected JSON-RPC error: ${JSON.stringify(res.json?.error)}`)
  const text = res.json?.result?.content?.[0]?.text
  assert.equal(typeof text, 'string')
  return {
    rpc: res.json,
    isError: Boolean(res.json?.result?.isError),
    payload: JSON.parse(text),
  }
}

it('安全与开源隔离：未配令牌 fail-closed 503、缺/错令牌全方法 401、独立 MCP_BEARER_TOKEN 权限隔离', async () => {
  // 1) 未配置任何令牌：一律 503 fail-closed
  const unconfigured = makeWorkerEnv({ CLOUD_SYNC_TOKEN: '', MCP_BEARER_TOKEN: '' })
  const r503 = await callWorker(unconfigured, '/v1/mcp', {
    method: 'POST',
    token: 'any-token',
    body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  })
  assert.equal(r503.status, 503)
  assert.equal(r503.json?.error?.code, 'UNAVAILABLE')
  unconfigured.DB.close()

  // 2) 缺令牌 / 错令牌：POST / GET / DELETE 全部在方法分派前拦截返回 401（绝不泄露端点状态）
  const env = makeWorkerEnv()
  for (const method of ['POST', 'GET', 'DELETE']) {
    const noAuth = await callWorker(env, '/v1/mcp', { method, token: null })
    assert.equal(noAuth.status, 401, `${method} without token must be 401`)
    assert.equal(noAuth.json?.error?.code, 'UNAUTHORIZED')

    const wrongAuth = await callWorker(env, '/mcp', { method, token: 'outsider-guessed-token' })
    assert.equal(wrongAuth.status, 401, `${method} with wrong token must be 401`)
  }
  env.DB.close()

  // 3) 配置独立 MCP_BEARER_TOKEN 时：/v1/mcp 只认 MCP_BEARER_TOKEN，与 CLOUD_SYNC_TOKEN 隔离
  const isolated = makeWorkerEnv({ MCP_BEARER_TOKEN: 'dedicated-mcp-secret-999' })
  const syncOnMcp = await callMcpRpc(isolated, { jsonrpc: '2.0', id: 1, method: 'ping' }, { token: TOKEN })
  assert.equal(syncOnMcp.status, 401)

  const mcpOk = await callMcpRpc(
    isolated,
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { token: 'dedicated-mcp-secret-999', path: '/mcp' },
  )
  assert.equal(mcpOk.status, 200)
  assert.deepEqual(mcpOk.json, { jsonrpc: '2.0', id: 1, result: {} })

  // 原有同步面仍只接受 CLOUD_SYNC_TOKEN，不接受 MCP_BEARER_TOKEN
  const mcpOnPull = await callWorker(isolated, '/v1/sync/pull?since=0', { token: 'dedicated-mcp-secret-999' })
  assert.equal(mcpOnPull.status, 401)
  const syncOnPull = await callWorker(isolated, '/v1/sync/pull?since=0', { token: TOKEN })
  assert.equal(syncOnPull.status, 200)
  isolated.DB.close()
})

it('Streamable HTTP 协议合规：initialize 协商、notification 202 空体、GET 405 Allow、DELETE 204、批处理', async () => {
  const env = makeWorkerEnv()

  // initialize 版本协商（已知版本原样返回，未知版本回退 2025-03-26）
  const initRes = await callMcpRpc(env, {
    jsonrpc: '2.0',
    id: 'init-1',
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', clientInfo: { name: 'antigravity', version: '1.0' } },
  })
  assert.equal(initRes.status, 200)
  assert.equal(initRes.json.result.protocolVersion, '2025-03-26')
  assert.equal(initRes.json.result.serverInfo.name, 'dsh-kanban-cloud-mcp')

  const fallbackInit = await callMcpRpc(env, {
    jsonrpc: '2.0',
    id: 'init-2',
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  })
  assert.equal(fallbackInit.json.result.protocolVersion, '2025-03-26')

  // notifications/initialized（无 id）→ 202 Accepted 空响应体
  const notifRes = await callMcpRpc(env, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })
  assert.equal(notifRes.status, 202)
  assert.equal(notifRes.text, '')

  // GET /v1/mcp → 405 + Allow: POST, DELETE
  const getRes = await callWorker(env, '/v1/mcp', { method: 'GET', token: TOKEN })
  assert.equal(getRes.status, 405)
  assert.equal(getRes.headers.get('allow'), 'POST, DELETE')

  // DELETE /v1/mcp → 204 No Content
  const delRes = await callWorker(env, '/v1/mcp', { method: 'DELETE', token: TOKEN })
  assert.equal(delRes.status, 204)
  assert.equal(delRes.text, '')

  // 非法 JSON → JSON-RPC Parse error (-32700)
  const badJson = await callWorker(env, '/v1/mcp', {
    method: 'POST',
    token: TOKEN,
    headers: { 'content-type': 'application/json' },
    rawBody: '{broken-json',
  })
  assert.equal(badJson.status, 200)
  assert.equal(badJson.json.error.code, -32700)

  // tools/list + ping 批处理（混入 notification 时只返回有 id 的结果）
  const batchRes = await callMcpRpc(env, [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 10, method: 'tools/list' },
    { jsonrpc: '2.0', id: 11, method: 'resources/list' },
  ])
  assert.equal(batchRes.status, 200)
  assert.equal(Array.isArray(batchRes.json), true)
  assert.equal(batchRes.json.length, 2)
  const toolNames = batchRes.json[0].result.tools.map(item => item.name)
  assert.equal(toolNames.length, 12)
  assert.ok(toolNames.includes('kanban_cards'))
  assert.ok(toolNames.includes('kanban_create_card'))
  env.DB.close()
})

it('Mac 合盖休眠期间：云端 MCP 只读工具 7x24 直查 D1 镜像，且严格剥离本地执行面隐私字段', async t => {
  const env = makeWorkerEnv()
  t.after(() => env.DB.close())

  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  await writeCloudConfig(dir)
  const server = await startServer(t, { store })
  const cloud = createWorkerCloud(env)
  const syncClient = createCloudSyncClient({
    store,
    dataDir: dir,
    fetchImpl: cloud.fetchImpl,
    logger: quietLogger(),
    timing: FAST_TIMING,
  })
  syncClient.setLocalOrigin(server.url)
  await syncClient.start()
  t.after(() => syncClient.stop())

  // 在本地看板创建两张示例项目卡片（含敏感本机路径 cwd / workspaceId / sessionIds 及父子依赖、审批）
  let parentId = ''
  let childId = ''
  await store.update(draft => {
    const p = createCard(draft, {
      title: '归档服务上线验收',
      summary: '推进归档修复包独立验收与部署',
      status: 'needs_you',
      priority: 'urgent',
      project: 'acme-web',
      labels: ['storage', 'ops'],
      cwd: '/Users/alice/projects/acme-web',
      workspaceId: 'ws-private-macbook',
      sessionId: 'sess-private-001',
    })
    requestApproval(draft, p.card.id, {
      title: '是否在维护窗口执行归档组件验收部署？',
      options: ['立即排期', '延后一天'],
    })
    const c = createCard(draft, {
      title: '生产服务切换只读数据源',
      summary: '维护窗口更新环境配置切换实时只读数据源',
      status: 'backlog',
      priority: 'high',
      project: 'acme-web',
      parentCardId: p.card.id,
      dependsOn: [p.card.id],
      cwd: '/Users/alice/projects/acme-web',
      sessionId: 'sess-private-002',
    })
    createCard(draft, {
      title: '无关项目杂项',
      status: 'backlog',
      project: 'other-proj',
    })
    parentId = p.card.id
    childId = c.card.id
  })

  await syncClient.syncNow()

  // 模拟本地 MacBook 合盖断网休眠！
  await syncClient.stop()
  cloud.state.online = false

  // 云端 Agent 通过 /v1/mcp 依然可以毫秒级读取看板与项目卡片详情
  const boards = await callMcpTool(env, 'kanban_boards')
  assert.equal(boards.payload.ok, true)
  assert.equal(boards.payload.source, 'cloud-d1')
  assert.equal(boards.payload.boards[0].counts.total, 3)

  const projectCards = await callMcpTool(env, 'kanban_cards', { project: 'ACME-WEB' })
  assert.equal(projectCards.payload.total, 2)
  assert.deepEqual(
    new Set(projectCards.payload.cards.map(c => c.id)),
    new Set([parentId, childId]),
  )

  const detail = await callMcpTool(env, 'kanban_card', { cardId: parentId })
  assert.equal(detail.payload.ok, true)
  assert.equal(detail.payload.card.title, '归档服务上线验收')
  assert.equal(detail.payload.pendingApproval.title, '是否在维护窗口执行归档组件验收部署？')
  assert.equal(detail.payload.children.length, 1)
  assert.equal(detail.payload.children[0].id, childId)

  // 验证本机敏感执行面字段绝不出现在 MCP 返回体与 D1 库中
  const serialized = JSON.stringify(detail.payload)
  assert.equal(serialized.includes('ws-private-macbook'), false)
  assert.equal(serialized.includes('sess-private-001'), false)
  assert.equal(detail.payload.card.cwd, undefined)
  assert.deepEqual(detail.payload.card.sessionIds, [])

  const childDetail = await callMcpTool(env, 'kanban_card', { cardId: childId })
  assert.equal(childDetail.payload.dependsOnCards[0].id, parentId)

  // kanban_review_board：云端自动屏蔽因 cwd 脱敏产生的假阳性 orphans
  const review = await callMcpTool(env, 'kanban_review_board', {})
  assert.equal(review.payload.ok, true)
  assert.equal(review.payload.orphans.count, 0)
  assert.equal(review.payload.orphans.cloudRedacted, true)
  assert.equal(review.payload.staleBacklogTotal, 0)

  // dryRun 预览在离线期间也可直接运行，不入队写操作
  const mergePreview = await callMcpTool(env, 'kanban_merge_cards', {
    sourceCardId: childId,
    targetCardId: parentId,
    dryRun: true,
  })
  assert.equal(mergePreview.payload.dryRun, true)
  assert.equal(mergePreview.payload.source.id, childId)

  const archivePreview = await callMcpTool(env, 'kanban_archive_cards', {
    cardIds: [childId, parentId],
    dryRun: true,
  })
  assert.equal(archivePreview.payload.dryRun, true)
  assert.deepEqual(archivePreview.payload.wouldArchive.map(item => item.id), [childId, parentId])
  assert.equal(env.DB.all('SELECT id FROM ingress_inbox').length, 0)
})

it('端到端闭环：Mac 离线期间云端 MCP 串联建卡/移列/更新/记进度/完成 → 唤醒按序回放 → 同步回 D1 + 幂等防重', async t => {
  const env = makeWorkerEnv()
  t.after(() => env.DB.close())

  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  await writeCloudConfig(dir)
  const server = await startServer(t, { store })
  const cloud = createWorkerCloud(env)

  // 1) Mac 尚未上线（模拟合盖状态），云端 Agent 直接通过 /v1/mcp 连续发起 5 个写操作
  const created = await callMcpTool(env, 'kanban_create_card', {
    title: '整理阶段一正式回放验收清单',
    summary: '核对核心模块端到端回放覆盖率指标',
    priority: 'high',
    project: 'acme-web',
    labels: ['stage1', 'qa'],
    // 故意混入本地执行面字段，验证边缘立即剥离且本地回放绝不注入
    cwd: '/etc/shadow',
    workspaceId: 'ws-injected',
    sessionId: 'sess-injected',
  })
  assert.equal(created.payload.ok, true)
  assert.equal(created.payload.queued, true)
  const cardId = created.payload.cardId
  assert.match(cardId, /^card-[0-9a-f]{8}$/)
  assert.deepEqual(created.payload.strippedFields.sort(), ['cwd', 'sessionId', 'workspaceId'])

  // 立即用预分配的 cardId 串联后续操作（此时 D1 cards 表中尚无该卡！）
  const moved = await callMcpTool(env, 'kanban_move_card', {
    cardId,
    status: 'running',
    text: 'Remote Agent 开始核对覆盖率指标',
  })
  assert.equal(moved.payload.queued, true)

  const updated = await callMcpTool(env, 'kanban_update_card', {
    cardId,
    currentAction: '生成覆盖率对比表',
    progress: { current: 1, total: 1, text: '核对完成' },
    checklists: [{ text: '核对回放 manifest', done: true }],
    artifacts: [
      {
        kind: 'link',
        label: 'Release PR #42',
        url: 'https://github.com/example/acme-web/pull/42',
        path: '/Users/alice/secret-local-file.txt',
      },
    ],
  })
  assert.equal(updated.payload.queued, true)

  const noted = await callMcpTool(env, 'kanban_add_activity', {
    cardId,
    type: 'progress',
    text: '已完成回放基线核查',
    metadata: { searches: 3 },
  })
  assert.equal(noted.payload.queued, true)

  const completed = await callMcpTool(env, 'kanban_complete_card', {
    cardId,
    result: '回放核查清单已整理完毕',
  })
  assert.equal(completed.payload.queued, true)

  // D1 镜像在本地回放前保持未改动（严守单写者），但只读工具能看到 pendingCloudWrites=5
  assert.equal(env.DB.all('SELECT id FROM cards').length, 0)
  const beforeWakeBoards = await callMcpTool(env, 'kanban_boards')
  assert.equal(beforeWakeBoards.payload.pendingCloudWrites, 5)

  // 请求级幂等头测试：相同 x-kanban-mcp-call-id 重试不会重复入队
  const retryHeaderOpts = { headers: { 'x-kanban-mcp-call-id': 'idem-req-001' } }
  const firstIdem = await callMcpTool(env, 'kanban_add_activity', {
    cardId,
    type: 'comment',
    text: '幂等备注只落一条',
  }, retryHeaderOpts)
  const secondIdem = await callMcpTool(env, 'kanban_add_activity', {
    cardId,
    type: 'comment',
    text: '幂等备注只落一条',
  }, retryHeaderOpts)
  assert.equal(firstIdem.payload.duplicate, false)
  assert.equal(secondIdem.payload.duplicate, true)
  assert.equal(firstIdem.payload.inboxId, secondIdem.payload.inboxId)

  // 2) MacBook 开盖唤醒：启动 C3 守护器，自动 claim 队列 → 按 seq 升序回放进本地 data.json → push 回 D1
  const syncClient = createCloudSyncClient({
    store,
    dataDir: dir,
    fetchImpl: cloud.fetchImpl,
    localFetchImpl: (...args) => globalThis.fetch(...args),
    logger: quietLogger(),
    timing: FAST_TIMING,
  })
  syncClient.setLocalOrigin(server.url)
  await syncClient.start()
  t.after(() => syncClient.stop())

  await syncClient.claimInboxNow()
  await syncClient.claimInboxNow()

  // 校验本地权威状态
  const localSnap = await store.read()
  const localCard = localSnap.cards.find(c => c.id === cardId)
  assert.ok(localCard, `本地应以预分配的确定性 cardId 创建卡片 (cards=${JSON.stringify(localSnap.cards.map(c => c.id))})`)
  assert.equal(localCard.status, 'done')
  assert.equal(localCard.result, '回放核查清单已整理完毕')
  assert.equal(localCard.project, 'acme-web')
  assert.equal(localCard.cwd, undefined, '被剥离的 cwd 绝不能写入本地 data.json')
  assert.equal(localCard.workspaceId, undefined)
  assert.deepEqual(localCard.sessionIds, [])
  assert.equal(localCard.artifacts.length, 1)
  assert.equal(localCard.artifacts[0].path, undefined, 'artifact.path 必须被剥离')
  assert.equal(localCard.metadata.searches, 3)
  assert.ok(localCard.metadata.toolCalls >= 5)

  // 本地增量同步回 D1 后，云端 MCP 读取到最终 done 状态，且 pendingCloudWrites 归零
  await syncClient.syncNow()
  await syncClient.syncNow()
  const syncedDetail = await callMcpTool(env, 'kanban_card', { cardId })
  assert.equal(syncedDetail.payload.ok, true, JSON.stringify(syncedDetail.payload))
  assert.equal(syncedDetail.payload.card.status, 'done')
  assert.equal(syncedDetail.payload.card.result, '回放核查清单已整理完毕')
  assert.equal(syncedDetail.payload.pendingCloudWrites, 0)

  // 3) 本地入站回放幂等：即使因网络抖动重复投递同一条 mcpCallId，也不会重复改卡或追加第二条活动
  const snapBeforeDup = await store.read()
  const actCountBefore = snapBeforeDup.activities.filter(a => a.cardId === cardId).length
  const sampleMcpAct = snapBeforeDup.activities.find(a => a.cardId === cardId && a.data?.mcpCallId)
  assert.ok(sampleMcpAct?.data?.mcpCallId)

  const dupReplay = await api(server, '/api/kanban/ingress', {
    method: 'POST',
    body: {
      kind: 'mcp_tool_call',
      mcpCallId: sampleMcpAct.data.mcpCallId,
      tool: 'kanban_add_activity',
      arguments: { cardId, type: 'comment', text: '不应该重复写入' },
      actor: { kind: 'agent', name: 'Antigravity' },
    },
  })
  assert.equal(dupReplay.status, 200)
  assert.equal(dupReplay.json?.duplicate, true)
  const snapAfterDup = await store.read()
  assert.equal(snapAfterDup.activities.filter(a => a.cardId === cardId).length, actCountBefore)
})

it('覆盖请求审批、卡片合并与归档/恢复写工具回放及参数校验错误回显', async t => {
  const env = makeWorkerEnv()
  t.after(() => env.DB.close())

  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  await writeCloudConfig(dir)
  const server = await startServer(t, { store })
  const cloud = createWorkerCloud(env)
  const syncClient = createCloudSyncClient({
    store,
    dataDir: dir,
    fetchImpl: cloud.fetchImpl,
    localFetchImpl: (...args) => globalThis.fetch(...args),
    logger: quietLogger(),
    timing: FAST_TIMING,
  })
  syncClient.setLocalOrigin(server.url)
  await syncClient.start()
  t.after(() => syncClient.stop())
  // 等首次 startup claim/push 收敛
  await syncClient.claimInboxNow()
  await syncClient.syncNow()

  // 非法参数在边缘直接返回 isError: true，不污染 ingress_inbox
  const badCreate = await callMcpTool(env, 'kanban_create_card', { title: '   ' })
  assert.equal(badCreate.isError, true)
  assert.equal(badCreate.payload.ok, false)
  assert.equal(badCreate.payload.error.code, 'BAD_REQUEST')
  assert.equal(env.DB.all('SELECT id FROM ingress_inbox').length, 0)

  const c1 = (await callMcpTool(env, 'kanban_create_card', { title: '重复子卡', project: 'acme-web' })).payload.cardId
  const c2 = (await callMcpTool(env, 'kanban_create_card', { title: '保留主卡', project: 'acme-web' })).payload.cardId
  await callMcpTool(env, 'kanban_merge_cards', { sourceCardId: c1, targetCardId: c2 })
  const reqApproval = await callMcpTool(env, 'kanban_request_approval', {
    cardId: c2,
    title: '确认合并结果无误？',
    options: ['确认', '退回'],
  })
  assert.equal(reqApproval.isError, false)

  await syncClient.claimInboxNow()
  await syncClient.syncNow()

  const mergedTarget = await callMcpTool(env, 'kanban_card', { cardId: c2 })
  assert.equal(mergedTarget.payload.ok, true, JSON.stringify(mergedTarget.payload))
  assert.equal(mergedTarget.payload.card.status, 'needs_you')
  assert.equal(mergedTarget.payload.pendingApproval.title, '确认合并结果无误？')

  // 归档再恢复
  await callMcpTool(env, 'kanban_archive_cards', { cardIds: [c2], reason: '阶段收尾归档' })
  await syncClient.claimInboxNow()
  assert.equal((await store.read()).cards.find(c => c.id === c2).archived, true)

  await callMcpTool(env, 'kanban_archive_cards', { cardIds: [c2], restore: true })
  await syncClient.claimInboxNow()
  assert.equal((await store.read()).cards.find(c => c.id === c2).archived, false)
})

it('一键配置辅助与热重载：setup-cloud 纯函数安全渲染 + /api/kanban/cloud/reload 零重启激活同步', async t => {
  const sampleUuid = '12345678-9abc-4def-8123-456789abcdef'
  const rendered = renderLocalWranglerToml(
    'name = "dsh-kanban-sync"\ndatabase_name = "dsh-kanban-sync"\ndatabase_id = "<REPLACE_WITH_D1_DATABASE_ID>"\n',
    sampleUuid,
  )
  assert.equal(rendered.includes(sampleUuid), true)
  assert.equal(rendered.includes('<REPLACE_WITH_D1_DATABASE_ID>'), false)

  assert.equal(
    extractD1Uuid(JSON.stringify([{ name: 'other', uuid: '00000000-0000-0000-0000-000000000000' }, { name: 'dsh-kanban-sync', uuid: sampleUuid }])),
    sampleUuid,
  )
  assert.equal(
    extractD1Uuid(`Created DB!\ndatabase_id = "${sampleUuid}"\n`),
    sampleUuid,
  )
  assert.equal(
    extractWorkerUrl('Uploaded dsh-kanban-sync\n  https://dsh-kanban-sync.demo-acct.workers.dev\nCurrent Version ID: abc'),
    'https://dsh-kanban-sync.demo-acct.workers.dev',
  )
  const cfg = buildInitialCloudConfig({
    workerUrl: 'https://dsh-kanban-sync.demo-acct.workers.dev/',
    token: TOKEN,
    clientId: 'My MacBook.local',
  })
  assert.equal(cfg.workerUrl, 'https://dsh-kanban-sync.demo-acct.workers.dev')
  assert.equal(cfg.clientId, 'My-MacBook.local')

  // 验证未配置 cloud-config.json 启动后，写入配置并 POST /api/kanban/cloud/reload 即可零重启激活同步并能在 /v1/mcp 读到
  const env = makeWorkerEnv()
  t.after(() => env.DB.close())

  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  await store.update(draft => createCard(draft, { title: '热重载前已存在的本地卡片', project: 'acme-api' }))

  const cloud = createWorkerCloud(env)
  const syncClient = createCloudSyncClient({
    store,
    dataDir: dir,
    fetchImpl: cloud.fetchImpl,
    localFetchImpl: (...args) => globalThis.fetch(...args),
    logger: quietLogger(),
    timing: FAST_TIMING,
  })
  const server = await startServer(t, { store, cloudSync: syncClient })
  syncClient.setLocalOrigin(server.url)
  await syncClient.start()
  t.after(() => syncClient.stop())
  assert.equal(syncClient.status().enabled, false)

  await writeCloudConfig(dir)
  const reloadRes = await api(server, '/api/kanban/cloud/reload', { method: 'POST', body: {} })
  assert.equal(reloadRes.status, 200)
  assert.equal(reloadRes.json.cloud.enabled, true)

  await syncClient.syncNow()
  const cardsRes = await callMcpTool(env, 'kanban_cards', { project: 'acme-api' })
  assert.equal(cardsRes.payload.total, 1)
  assert.equal(cardsRes.payload.cards[0].title, '热重载前已存在的本地卡片')
})

