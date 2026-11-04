// cloud-sync-client.test.mjs（C3/3）：本地云同步守护器的单测 + 端到端验收。
//
// 测试策略：
// - 云端用 **真实的 cloudflare/worker.mjs + 真实迁移 SQL + 内存 D1**（test/cloud-worker-harness.mjs），
//   不手写第二套「假云端」，因此端到端链路（push CAS / pull 分页 / claim / ack / 去重）全部走真实实现；
// - 本地看板用 test/helpers.mjs 起的真实 HTTP 服务（/api/kanban/ingress 走真实 handleIngressEvent）；
// - 全部离线、不碰 ~/.dsh-kanban；时序用 `timing` 覆盖压到毫秒级，测试结束显式 stop 守护器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCard } from '../lib/domain.js'
import { handleRequest } from '../cloudflare/worker.mjs'
import {
  CLOUD_SYNC_DEFAULT_TIMING,
  classifyLocalIngressResponse,
  cloudConfigPath,
  cloudRetryDelay,
  createCloudSyncClient,
  readCloudConfig,
} from '../lib/cloud-sync-client.js'
import {
  applyDeltaToCloudSnapshot,
  emptyCloudSnapshot,
  pullResponseToDelta,
  toCloudSnapshot,
} from '../lib/cloud-sync-protocol.js'
import {
  DINGTALK_SIGN_SECRET,
  HAS_SQLITE,
  MemoryD1,
  MIGRATION_SQL,
  callWorker,
  makeWorkerEnv,
} from './cloud-worker-harness.mjs'
import { api, startServer, testStore } from './helpers.mjs'

const it = HAS_SQLITE ? test : test.skip

const WORKER_URL = 'https://worker.test'
const CLIENT_TOKEN = 'c3-test-token-0123456789abcdef'
const CLIENT_ID = 'mac-c3-test'
const FAST_TIMING = {
  pushDebounceMs: 20,
  pullIntervalMs: 120,
  claimIntervalMs: 120,
  retryBaseMs: 20,
  retryMaxMs: 160,
  requestTimeoutMs: 3000,
  localRequestTimeoutMs: 3000,
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} }
}

async function writeCloudConfig(dir, overrides = {}) {
  const config = {
    version: 1,
    enabled: true,
    workerUrl: WORKER_URL,
    token: CLIENT_TOKEN,
    clientId: CLIENT_ID,
    sync: { enabled: true, pushDebounceMs: 2000, pullIntervalMs: 30000 },
    ingress: { enabled: true, claimIntervalMs: 30000, batchSize: 20, leaseSeconds: 120 },
    ...overrides,
  }
  await writeFile(join(dir, 'cloud-config.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
  return config
}

/**
 * 包装真实 Worker：state.online 模拟断网，state.intercept 可在请求到达 Worker 前注入响应，
 * state.calls 记录每次云端请求（url/method/body/status），用于断言请求次数与冲突路径。
 */
function createWorkerCloud(env) {
  const state = { online: true, env, calls: [], intercept: null }
  const fetchImpl = async (url, init = {}) => {
    const entry = { url: String(url), method: init.method || 'GET', body: init.body, status: 0 }
    state.calls.push(entry)
    if (!state.online) {
      const error = new TypeError('fetch failed: simulated offline')
      throw error
    }
    if (typeof state.intercept === 'function') {
      const injected = state.intercept(entry, state)
      if (injected) {
        entry.status = Number(injected.status) || 0
        return injected
      }
    }
    const response = await handleRequest(new Request(String(url), init), state.env, { now: Date.now() })
    entry.status = response.status
    return response
  }
  return { state, fetchImpl }
}

function clientFor(store, dir, cloud, overrides = {}) {
  const { fetchImpl, localFetchImpl, timing, ...rest } = overrides
  return createCloudSyncClient({
    store,
    dataDir: dir,
    fetchImpl: fetchImpl || cloud.fetchImpl,
    localFetchImpl: localFetchImpl || ((...args) => globalThis.fetch(...args)),
    logger: quietLogger(),
    timing: { ...FAST_TIMING, ...(timing || {}) },
    ...rest,
  })
}

async function waitFor(predicate, { timeout = 5000, interval = 20, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  let lastError = null
  for (;;) {
    try {
      if (await predicate()) return true
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor 超时：${label}${lastError ? `（最后一次错误：${lastError.message}）` : ''}`)
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

function cardRows(env) {
  return env.DB.all('SELECT id, title, status, version, revision, payload FROM cards ORDER BY id')
}

function ingressRows(env) {
  return env.DB.all('SELECT id, provider, status, attempts, last_error FROM ingress_inbox ORDER BY seq')
}

/** 通过 Worker 的 pull 端点重建「云端镜像」（分页循环走真实协议）。 */
async function pullCloudSnapshot(env, token = CLIENT_TOKEN) {
  let since = 0
  let until = null
  let cursor = ''
  let snapshot = emptyCloudSnapshot()
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ since: String(since), limit: '200' })
    if (until !== null) query.set('until', String(until))
    if (cursor) query.set('cursor', cursor)
    const result = await callWorker(env, `/v1/sync/pull?${query.toString()}`, { token, now: Date.now() })
    assert.equal(result.status, 200, result.text)
    until = result.json.until
    snapshot = applyDeltaToCloudSnapshot(snapshot, pullResponseToDelta(result.json), { revision: until })
    if (!result.json.hasMore) return snapshot
    cursor = result.json.cursor || result.json.cursors?.cards || ''
    assert.ok(cursor, 'hasMore=true 时必须返回游标')
  }
  throw new Error('pull 分页超过 100 页')
}

async function createLocalCard(store, title, overrides = {}) {
  const { result } = await store.update(draft => ({
    card: createCard(draft, { title, status: 'backlog', autoStart: false, ...overrides }, { now: Date.now() }).card,
  }))
  return result.card
}

function dingtalkSignedHeaders(text) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const sign = createHmac('sha256', DINGTALK_SIGN_SECRET).update(`${timestamp}\n${DINGTALK_SIGN_SECRET}`, 'utf8').digest('base64')
  return { timestamp, sign, 'content-type': 'application/json', 'x-test-body-hash': createHash('sha256').update(text).digest('hex').slice(0, 8) }
}

// ===========================================================================
// 一、纯函数单测
// ===========================================================================

it('cloudRetryDelay：指数增长、封顶、抖动范围可验证', () => {
  const noJitter = { random: () => 0.5 }
  const delays = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cloudRetryDelay(n, { baseMs: 1000, maxMs: 60000, ...noJitter }))
  assert.deepEqual(delays.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 32000])
  assert.equal(delays[6], 60000)
  assert.equal(delays[7], 60000)
  // ±20% 抖动：random=0 → 0.8x，random=1 → 1.2x（不越过上限）
  assert.equal(cloudRetryDelay(1, { baseMs: 1000, maxMs: 60000, random: () => 0 }), 800)
  assert.equal(cloudRetryDelay(1, { baseMs: 1000, maxMs: 60000, random: () => 1 }), 1200)
  assert.equal(cloudRetryDelay(9, { baseMs: 1000, maxMs: 60000, random: () => 1 }), 60000)
  // 非法输入不抛错
  assert.ok(cloudRetryDelay(0, { baseMs: 10, maxMs: 100, random: () => 0.5 }) >= 1)
  assert.equal(cloudRetryDelay(1, { baseMs: 10, maxMs: 100, random: () => 0.5 }), 10)
})

it('classifyLocalIngressResponse：2xx=acked、已处理类 4xx=acked、其它 4xx=dead、5xx/网络=retry', () => {
  assert.deepEqual(classifyLocalIngressResponse({ status: 200, body: { ok: true } }), { outcome: 'acked' })
  assert.deepEqual(classifyLocalIngressResponse({ status: 409, body: { ok: false, error: { code: 'CONFLICT' } } }), {
    outcome: 'acked',
    note: '本地已处理过（CONFLICT）',
  })
  assert.equal(classifyLocalIngressResponse({ status: 404, body: { ok: false, error: { code: 'CARD_NOT_FOUND' } } }).outcome, 'acked')
  const dead = classifyLocalIngressResponse({ status: 400, body: { ok: false, error: { code: 'BAD_REQUEST', message: '坏载荷' } } })
  assert.equal(dead.outcome, 'dead')
  assert.match(dead.error, /坏载荷/)
  assert.equal(classifyLocalIngressResponse({ status: 502, body: undefined }).outcome, 'retry')
  assert.equal(classifyLocalIngressResponse({ status: 0, error: '本地看板不可达：boom' }).outcome, 'retry')
  // 非 JSON 的 404（例如 origin 指到别的服务）不能被当作「已处理」，按 dead 收口避免无限重试
  assert.equal(classifyLocalIngressResponse({ status: 404, body: undefined }).outcome, 'dead')
})

it('readCloudConfig：缺失/关闭/权限不安全/非法 JSON/合法 五态与 0600 校验', async t => {
  const { dir } = await testStore(t, { seedMode: 'empty' })
  const file = cloudConfigPath(dir)
  assert.equal(file, join(dir, 'cloud-config.json'))
  assert.deepEqual(readCloudConfig(dir), { status: 'missing', file })

  await writeFile(file, JSON.stringify({ version: 1, enabled: false }), { mode: 0o600 })
  const disabled = readCloudConfig(dir)
  assert.equal(disabled.status, 'disabled')
  assert.equal(disabled.config.enabled, false)

  await writeFile(file, '{ not json', { mode: 0o600 })
  const broken = readCloudConfig(dir)
  assert.equal(broken.status, 'invalid')
  assert.equal(broken.error.code, 'BAD_CONFIG')

  await writeFile(file, JSON.stringify({ version: 1, enabled: true, workerUrl: WORKER_URL, token: CLIENT_TOKEN, clientId: CLIENT_ID }), { mode: 0o600 })
  const ready = readCloudConfig(dir)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.config.clientId, CLIENT_ID)
  assert.equal(typeof readCloudConfig(dir, { logger: quietLogger() }), 'object')

  // 权限不安全：group/other 位非 0 时 fail-closed（令牌可能被同机其它用户读取）
  await chmod(file, 0o644)
  const insecure = readCloudConfig(dir, { logger: quietLogger() })
  assert.equal(insecure.status, 'invalid')
  assert.match(insecure.error.message, /0600/)

  // 非 JSON 对象（数组）也会被 normalizeCloudConfig 归一为默认值 → enabled 默认 true，但缺 token 报 BAD_CONFIG
  await chmod(file, 0o600)
  await writeFile(file, '[]', { mode: 0o600 })
  const arrayConfig = readCloudConfig(dir)
  assert.equal(arrayConfig.status, 'invalid')
  assert.equal(arrayConfig.error.code, 'BAD_CONFIG')
})

// ===========================================================================
// 二、静默降级：未配置 / 已关闭时零网络
// ===========================================================================

it('未配置 cloud-config.json：start() 静默返回、零网络、状态接口 enabled:false', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const calls = []
  const client = createCloudSyncClient({
    store,
    dataDir: dir,
    logger: quietLogger(),
    fetchImpl: async url => { calls.push(url); throw new Error('未配置时不应发起任何网络请求') },
    localFetchImpl: async url => { calls.push(url); throw new Error('未配置时不应发起本地回放') },
    timing: FAST_TIMING,
  })
  const server = await startServer(t, { store, cloudSync: client })
  await client.start()
  await new Promise(resolve => setTimeout(resolve, 150))
  const status = client.status()
  assert.equal(status.enabled, false)
  assert.equal(status.configured, false)
  assert.equal(status.running, false)
  assert.equal(status.configStatus, 'missing')
  assert.equal(calls.length, 0)

  const http = await api(server, '/api/kanban/cloud/status')
  assert.equal(http.status, 200)
  assert.equal(http.json.ok, true)
  assert.equal(http.json.cloud.enabled, false)
  assert.equal(http.json.cloud.configStatus, 'missing')
  assert.equal(typeof http.json.revision, 'number')
  await client.stop()
})

it('enabled:false / config.cloudSync=false：零网络且状态接口可读', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  let calls = 0
  const makeClient = () => createCloudSyncClient({
    store,
    dataDir: dir,
    logger: quietLogger(),
    fetchImpl: async () => { calls += 1; throw new Error('不应联网') },
    timing: FAST_TIMING,
  })
  // 1) 文件存在但显式关闭
  await writeCloudConfig(dir, { enabled: false, workerUrl: undefined, token: undefined })
  const disabledClient = makeClient()
  const server = await startServer(t, { store, cloudSync: disabledClient })
  await disabledClient.start()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(disabledClient.status().enabled, false)
  assert.equal(disabledClient.status().configStatus, 'disabled')
  const http = await api(server, '/api/kanban/cloud/status')
  assert.equal(http.json.cloud.enabled, false)
  assert.equal(http.json.cloud.configStatus, 'disabled')
  await disabledClient.stop()

  // 2) 配置合法但宿主侧关闭（cloudSync:false 时不传 client，这里验证客户端的 enabled 门闩）
  const cfg = await writeCloudConfig(dir)
  assert.equal(cfg.enabled, true)
  const client = makeClient()
  await client.stop() // 未 start 直接 stop 也必须安全
  assert.equal(client.status().running, false)
  assert.equal(client.status().configStatus, 'missing') // 未 start 不读文件（零 I/O）
  assert.equal(calls, 0)
})

// ===========================================================================
// 三、端到端验收：离线暂存 IM 任务 → 恢复自动消费建卡 → 双端一致
// ===========================================================================

it('端到端：本地离线期间云端暂存 IM 任务 → 恢复自动消费建卡 → 状态双端一致', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud)
  t.after(() => client.stop())

  // 本地看板服务（真实 HTTP）；守护器从 runtime-endpoint.json 发现本地地址
  const server = await startServer(t, { store, cloudSync: client })
  await writeFile(join(dir, 'runtime-endpoint.json'), JSON.stringify({ origin: server.url, updatedAt: Date.now() }), { mode: 0o600 })

  await client.start()
  // 初始同步：空看板的默认 board 上云
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始 push 完成' })
  assert.equal(cardRows(env).length, 0)

  // 1) 模拟合盖断网 + 本地又新增一张卡（推送会失败并进入退避）
  cloud.state.online = false
  const offlineCard = await createLocalCard(store, '本地离线新增卡片')
  await waitFor(() => client.status().sync.consecutiveFailures > 0, { label: '离线 push 失败进入退避' })
  assert.equal(cardRows(env).some(row => row.id === offlineCard.id), false, '离线期间云端不应有新卡')

  // 2) 断网期间 IM Webhook 打到云端：Worker 验签后秒回 202 并暂存在 ingress_inbox
  const imText = '请修复云端同步断网重连回放问题'
  const ingress = await callWorker(env, '/v1/ingress/dingtalk', {
    method: 'POST',
    token: null,
    headers: dingtalkSignedHeaders(imText),
    body: { provider: 'dingtalk', text: imText, senderName: '测试用户', autoStart: false },
    now: Date.now(),
  })
  assert.equal(ingress.status, 202, ingress.text)
  assert.equal(ingressRows(env).filter(row => row.status === 'pending').length, 1)
  assert.equal(ingressRows(env).length, 1)

  // 3) 恢复在线 + 唤醒：守护器应自动 claim → 本地回放建卡 → ACK
  cloud.state.online = true
  client.handleWake('test-wake')
  await waitFor(() => ingressRows(env).every(row => row.status === 'acked'), { label: '入站回放并 ACK' })
  const localCards = (await store.read()).cards
  const replayed = localCards.find(card => card.title.includes('云端同步断网重连'))
  assert.ok(replayed, '本地应从云端暂存事件建卡')
  assert.equal(replayed.status, 'backlog')
  assert.notEqual(replayed.autoStart, true)

  // 4) 状态双端一致：本地增量（离线卡 + 回放卡）全部推上云
  await waitFor(async () => {
    const cloudCards = cardRows(env)
    const local = (await store.read()).cards
    return local.length === 2 && cloudCards.length === 2 && local.every(card => cloudCards.some(row => row.id === card.id))
  }, { label: '本地卡片全部同步上云' })
  await client.syncNow()
  const localSnapshot = toCloudSnapshot(await store.read())
  const cloudSnapshot = await pullCloudSnapshot(env)
  assert.deepEqual(cloudSnapshot.boards, localSnapshot.boards)
  assert.deepEqual(cloudSnapshot.cards, localSnapshot.cards)
  assert.deepEqual(cloudSnapshot.activities, localSnapshot.activities)

  // 5) 守护器状态与本地状态接口
  const status = client.status()
  assert.equal(status.enabled, true)
  assert.equal(status.paused, false)
  assert.equal(status.ingress.acked, 1)
  assert.ok(status.baseRevision >= 2)
  assert.equal(status.sync.lastError, null)

  const http = await api(server, '/api/kanban/cloud/status')
  assert.equal(http.status, 200)
  assert.equal(http.json.ok, true)
  assert.equal(http.json.cloud.enabled, true)
  assert.equal(http.json.cloud.baseRevision, status.baseRevision)
  assert.equal(http.json.cloud.ingress.acked, 1)
  // 状态接口不得泄漏令牌明文（只允许 describeCloudConfig 的掩码）
  assert.equal(JSON.stringify(http.json).includes(CLIENT_TOKEN), false)
  await client.stop()
})

// ===========================================================================
// 四、故障自愈与边界
// ===========================================================================

it('push 409 REVISION_CONFLICT：pull 追平后重算增量重试，本地权威状态不被云端覆盖', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud)
  t.after(() => client.stop())
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })

  // 模拟单写者假设外的另一个写者：直接用真实 Worker 把云端推进到 revision 2
  const localBoard = toCloudSnapshot(await store.read()).boards[0]
  const otherPush = await callWorker(env, '/v1/sync/push', {
    method: 'POST',
    token: CLIENT_TOKEN,
    body: {
      protocolVersion: 1,
      clientId: 'other-client',
      pushId: 'push-other-writer-1',
      baseRevision: 1,
      reset: false,
      delta: {
        boards: { upserts: [{ ...localBoard, name: `${localBoard.name}（其他写者改名）` }], deletes: [] },
        cards: { upserts: [], deletes: [] },
        activities: { upserts: [], deletes: [] },
      },
    },
    now: Date.now(),
  })
  assert.equal(otherPush.status, 200, otherPush.text)
  assert.equal(otherPush.json.status, 'applied')

  const localBoardName = (await store.read()).boards[0].name
  const card = await createLocalCard(store, '冲突自愈卡片')
  await waitFor(async () => {
    const snapshot = await pullCloudSnapshot(env)
    return snapshot.cards.some(item => item.id === card.id)
  }, { label: '冲突自愈后增量上云' })

  // 关键：云端被其他写者改过的 board 被本地权威状态重算覆盖，本地状态未被云端污染
  const cloudSnapshot = await pullCloudSnapshot(env)
  assert.equal(cloudSnapshot.boards[0].name, localBoardName)
  const localData = await store.read()
  assert.equal(localData.boards[0].name, localBoardName)
  assert.ok(localData.cards.some(item => item.id === card.id))
  assert.ok(client.status().baseRevision >= 3)
  assert.equal(client.status().sync.lastError, null)
  // 确实走了「push 409 → pull → 重试」路径
  assert.ok(cloud.state.calls.some(entry => entry.url.includes('/v1/sync/push') && entry.status === 409), '应发生一次 409 revision 冲突')
  assert.ok(cloud.state.calls.some(entry => entry.url.includes('/v1/sync/pull')), '冲突后应 pull 追平')
  await client.stop()
})

it('云端 epoch 变化（D1 重建）：discover → 本地全量 reset 推送自愈', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env1 = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env1)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud)
  t.after(() => client.stop())
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })
  assert.equal(typeof client.status().epoch, 'string')
  assert.ok(client.status().epoch.length >= 8)
  const oldEpoch = client.status().epoch

  // 云端 D1 被重建（新库、新 epoch，revision 从 0 开始）
  cloud.state.env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const card = await createLocalCard(store, 'epoch 重建后的卡片')
  await waitFor(async () => {
    const snapshot = await pullCloudSnapshot(cloud.state.env)
    return snapshot.cards.some(item => item.id === card.id)
  }, { label: 'reset 推送后云端重建镜像' })

  const status = client.status()
  assert.ok(cloud.state.calls.some(entry => entry.url.includes('/v1/sync/push') && entry.status === 409), '应先撞上 SYNC_EPOCH_MISMATCH')
  assert.equal(status.sync.lastPushStatus, 'reset')
  const newEpoch = cloud.state.env.DB.one('SELECT epoch FROM sync_meta WHERE id = 1').epoch
  assert.equal(status.epoch, newEpoch)
  assert.notEqual(status.epoch, oldEpoch)
  const snapshot = await pullCloudSnapshot(cloud.state.env)
  assert.equal(snapshot.boards.length, 1)
  assert.ok(snapshot.cards.some(item => item.id === card.id))
  await client.stop()
})

it('401 鉴权失败：停止重试（不再产生网络请求），状态标记 paused', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud)
  t.after(() => client.stop())
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })

  let injected = false
  cloud.state.intercept = entry => {
    if (injected || !entry.url.includes('/v1/sync/push')) return undefined
    injected = true
    return new Response(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Bearer 令牌不匹配' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  await createLocalCard(store, '触发 401 的卡片')
  await waitFor(() => client.status().paused === true, { label: '401 后进入 paused' })
  const callsAfterPause = cloud.state.calls.length
  const phase = client.status().phase
  assert.equal(client.status().pauseReason, 'unauthorized')
  assert.equal(phase, 'paused')
  // 等待几个定时器周期：paused 后必须完全静默（零网络）
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(cloud.state.calls.length, callsAfterPause, 'paused 后不应再发起任何云端请求')
  await client.stop()
})

it('网络错误退避：失败次数累加、退避时长指数增长，恢复后自动追平', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud, { timing: { ...FAST_TIMING, retryBaseMs: 40, retryMaxMs: 400 } })
  t.after(() => client.stop())
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })

  cloud.state.online = false
  await createLocalCard(store, '离线退避卡片')
  await waitFor(() => client.status().sync.consecutiveFailures >= 1, { label: '第一次失败' })
  const firstDelay = client.status().sync.nextRetryAt - Date.now()
  await waitFor(() => client.status().sync.consecutiveFailures >= 2, { label: '第二次失败' })
  const secondDelay = client.status().sync.nextRetryAt - Date.now()
  assert.ok(secondDelay > firstDelay, `退避应增长：${firstDelay}ms → ${secondDelay}ms`)
  assert.equal(client.status().phase, 'backoff')

  cloud.state.online = true
  await waitFor(async () => {
    const snapshot = await pullCloudSnapshot(env)
    return snapshot.cards.some(item => item.title === '离线退避卡片')
  }, { label: '恢复后自动追平' })
  assert.equal(client.status().sync.consecutiveFailures, 0)
  assert.equal(client.status().sync.nextRetryAt, 0)
  await client.stop()
})

it('push 413：按实体二分后串行重推（语义不变）', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud)
  t.after(() => client.stop())
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })

  // 一次本地事务里加两张卡：delta 至少 2 个实体，第一次 push 注入 413
  const { result } = await store.update(draft => {
    const first = createCard(draft, { title: '413 分片卡 A', status: 'backlog', autoStart: false }, { now: Date.now() }).card
    const second = createCard(draft, { title: '413 分片卡 B', status: 'backlog', autoStart: false }, { now: Date.now() }).card
    return { ids: [first.id, second.id] }
  })
  let rejected = false
  cloud.state.intercept = entry => {
    if (rejected || !entry.url.includes('/v1/sync/push')) return undefined
    rejected = true
    return new Response(JSON.stringify({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'push 体积超限' } }), {
      status: 413,
      headers: { 'content-type': 'application/json' },
    })
  }
  await waitFor(async () => {
    const snapshot = await pullCloudSnapshot(env)
    return result.ids.every(id => snapshot.cards.some(item => item.id === id))
  }, { label: '413 二分后两张卡都上云' })
  const pushes = cloud.state.calls.filter(entry => entry.url.includes('/v1/sync/push'))
  assert.ok(pushes.length >= 3, `应包含 1 次被拒 + ≥2 次分片重推，实际 ${pushes.length}`)
  await client.stop()
})

it('pull 分页：>200 实体冷启动镜像重建（多页 + 冻结窗口），新客户端增量正确', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud)
  t.after(() => client.stop())

  // 205 张卡 + 默认 board：push 至少分 2 片（200 实体上限），云端 revision ≥ 2
  await store.update(draft => {
    for (let index = 0; index < 205; index++) {
      createCard(draft, { title: `分页测试卡片 ${index}`, status: 'backlog', autoStart: false }, { now: Date.now() }).card
    }
    return null
  })
  await client.start()
  await waitFor(() => client.status().baseRevision >= 2, { timeout: 8000, label: '分片 push 完成' })
  assert.equal(cardRows(env).length, 205)
  const firstBaseRevision = client.status().baseRevision
  await client.stop()

  // 第二个客户端冷启动：pull 必须分页（每页 200）重建完整镜像
  const second = clientFor(store, dir, cloud, { timing: { ...FAST_TIMING, pullIntervalMs: 60000, claimIntervalMs: 60000 } })
  t.after(() => second.stop())
  const pullCallsBefore = cloud.state.calls.filter(entry => entry.url.includes('/v1/sync/pull')).length
  await second.start()
  await waitFor(() => second.status().running && second.status().baseRevision >= firstBaseRevision, { timeout: 8000, label: '第二客户端冷启动 pull' })
  const pullCalls = cloud.state.calls.filter(entry => entry.url.includes('/v1/sync/pull'))
  assert.ok(pullCalls.length - pullCallsBefore >= 2, `冷启动 pull 应分页（实际 ${pullCalls.length - pullCallsBefore} 次）`)

  // 冷启动后镜像完整：新增一张卡能增量上云（不重复全量）
  const extra = await createLocalCard(store, '分页后增量卡片')
  await waitFor(async () => {
    const snapshot = await pullCloudSnapshot(env)
    return snapshot.cards.some(item => item.id === extra.id)
  }, { timeout: 8000, label: '冷启动后增量同步' })
  assert.equal(cardRows(env).length, 206)
  assert.equal(second.status().sync.lastError, null)
  await second.stop()
})

it('Store 变更防抖：连续多次写入合并为一次 push', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud, { timing: { ...FAST_TIMING, pushDebounceMs: 120 } })
  t.after(() => client.stop())
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })
  const pushesBefore = cloud.state.calls.filter(entry => entry.url.includes('/v1/sync/push')).length

  await createLocalCard(store, '防抖卡片 A')
  await createLocalCard(store, '防抖卡片 B')
  await waitFor(async () => cardRows(env).length === 2, { label: '防抖后的增量上云' })
  await new Promise(resolve => setTimeout(resolve, 200))
  const pushesAfter = cloud.state.calls.filter(entry => entry.url.includes('/v1/sync/push')).length
  assert.equal(pushesAfter - pushesBefore, 1, '两次本地写入应合并为一次 push')
  await client.stop()
})

it('唤醒探测：定时器间隔明显拉长时立即拉取入站并同步（handleWake/timer-gap）', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  let fakeNow = Date.now()
  const client = clientFor(store, dir, cloud, {
    now: () => fakeNow,
    timing: { ...FAST_TIMING, pullIntervalMs: 25, claimIntervalMs: 25 },
  })
  t.after(() => client.stop())
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })

  // 模拟合盖休眠：时钟一次性跳过 60s，下一次定时器触发时应判定为唤醒
  fakeNow += 60_000
  await waitFor(() => client.status().lastWakeReason === 'timer-gap', { timeout: 3000, label: 'timer-gap 唤醒' })
  assert.ok(client.status().lastWakeAt >= fakeNow)
  // 手动唤醒接口同样清空退避并立即触发对齐
  fakeNow += 1000
  assert.equal(client.handleWake('manual-test').ok, true)
  assert.equal(client.status().lastWakeReason, 'manual-test')
  await client.stop()
})

it('状态接口：lazy client 未 start 时也可安全查询（不读文件、不联网）', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  await writeCloudConfig(dir)
  const client = createCloudSyncClient({ store, dataDir: dir, logger: quietLogger(), timing: FAST_TIMING })
  const server = await startServer(t, { store, cloudSync: client })
  const http = await api(server, '/api/kanban/cloud/status')
  assert.equal(http.status, 200)
  assert.equal(http.json.ok, true)
  assert.equal(http.json.cloud.running, false)
  assert.equal(http.json.cloud.configStatus, 'missing')
  assert.equal(http.json.cloud.baseRevision, 0)
  assert.equal(http.json.cloud.sync.lastPushAt, 0)
  await client.stop()
  // 默认时序常量与契约一致（2s 防抖 / 30s 轮询 / 1s 退避基数 / 60s 上限）
  assert.equal(CLOUD_SYNC_DEFAULT_TIMING.pushDebounceMs, 2000)
  assert.equal(CLOUD_SYNC_DEFAULT_TIMING.pullIntervalMs, 30000)
  assert.equal(CLOUD_SYNC_DEFAULT_TIMING.claimIntervalMs, 30000)
  assert.equal(CLOUD_SYNC_DEFAULT_TIMING.retryBaseMs, 1000)
  assert.equal(CLOUD_SYNC_DEFAULT_TIMING.retryMaxMs, 60000)
})

it('cloud-config.json 可分别关闭状态镜像/入站回放（sync.enabled / ingress.enabled）', async t => {
  // 1) sync.enabled:false → 本地变更不推送；ingress 仍正常工作
  const first = await testStore(t, { seedMode: 'empty' })
  const env1 = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud1 = createWorkerCloud(env1)
  await writeCloudConfig(first.dir, { sync: { enabled: false, pushDebounceMs: 2000, pullIntervalMs: 30000 } })
  const syncOff = clientFor(first.store, first.dir, cloud1)
  t.after(() => syncOff.stop())
  const server1 = await startServer(t, { store: first.store, cloudSync: syncOff })
  await writeFile(join(first.dir, 'runtime-endpoint.json'), JSON.stringify({ origin: server1.url }), { mode: 0o600 })
  await syncOff.start()
  await createLocalCard(first.store, 'sync-disabled 卡片')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(cloud1.state.calls.filter(entry => entry.url.includes('/v1/sync/')).length, 0, 'sync.enabled:false 时不得推送状态')

  const imText = '请修复 sync 关闭时入站仍可回放的问题'
  const ingress1 = await callWorker(env1, '/v1/ingress/dingtalk', {
    method: 'POST', token: null, headers: dingtalkSignedHeaders(imText),
    body: { provider: 'dingtalk', text: imText, senderName: '测试用户', autoStart: false }, now: Date.now(),
  })
  assert.equal(ingress1.status, 202, ingress1.text)
  syncOff.handleWake('ingress-only')
  await waitFor(() => ingressRows(env1).every(row => row.status === 'acked'), { label: '仅 ingress 模式下回放并 ACK' })
  const created = (await first.store.read()).cards.find(card => card.title.includes('sync 关闭时入站仍可回放'))
  assert.ok(created, 'ingress 仍应回放建卡')
  await syncOff.stop()

  // 2) ingress.enabled:false → 不 claim（事件留在云端 pending），状态镜像照常推送
  const second = await testStore(t, { seedMode: 'empty' })
  const env2 = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud2 = createWorkerCloud(env2)
  await writeCloudConfig(second.dir, { ingress: { enabled: false, claimIntervalMs: 30000, batchSize: 20, leaseSeconds: 120 } })
  const ingressOff = clientFor(second.store, second.dir, cloud2)
  t.after(() => ingressOff.stop())
  await ingressOff.start()
  await waitFor(() => ingressOff.status().baseRevision >= 1, { label: 'ingress 关闭时状态镜像仍工作' })
  const ingress2 = await callWorker(env2, '/v1/ingress/dingtalk', {
    method: 'POST', token: null, headers: dingtalkSignedHeaders('请修复 ingress 关闭场景'),
    body: { provider: 'dingtalk', text: '请修复 ingress 关闭场景', senderName: '测试用户' }, now: Date.now(),
  })
  assert.equal(ingress2.status, 202, ingress2.text)
  ingressOff.handleWake('no-ingress')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(cloud2.state.calls.filter(entry => entry.url.includes('/v1/inbox/claim')).length, 0, 'ingress.enabled:false 时不得 claim')
  assert.equal(ingressRows(env2)[0].status, 'pending')
  await ingressOff.stop()
})

it('ACK 网络失败补发：本地已消费不重复回放（租约期内先补 ACK 再 claim）', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud)
  t.after(() => client.stop())
  const server = await startServer(t, { store, cloudSync: client })
  await writeFile(join(dir, 'runtime-endpoint.json'), JSON.stringify({ origin: server.url }), { mode: 0o600 })
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })

  // 第一次 ACK 注入 500：本地已经建卡成功，但 ACK 丢失 → 触发内存补发，而不是重新 claim 消费
  let failedOnce = false
  cloud.state.intercept = entry => {
    if (failedOnce || !entry.url.includes('/v1/inbox/ack')) return undefined
    failedOnce = true
    return new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: '注入 ACK 失败' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
  const imText = '请修复 ACK 补发重复建卡问题'
  const ingress = await callWorker(env, '/v1/ingress/dingtalk', {
    method: 'POST', token: null, headers: dingtalkSignedHeaders(imText),
    body: { provider: 'dingtalk', text: imText, senderName: '测试用户', autoStart: false }, now: Date.now(),
  })
  assert.equal(ingress.status, 202, ingress.text)
  client.handleWake('ack-retry')
  await waitFor(() => ingressRows(env).every(row => row.status === 'acked'), { timeout: 6000, label: 'ACK 补发成功' })

  const cards = (await store.read()).cards.filter(card => card.title.includes('ACK 补发重复建卡'))
  assert.equal(cards.length, 1, 'ACK 失败重试不得重复建卡（不得重复回放）')
  assert.equal(client.status().ingress.acked, 1)
  assert.ok(cloud.state.calls.filter(entry => entry.url.includes('/v1/inbox/ack')).length >= 2, '应发生一次失败 + 一次补发')
  await client.stop()
})

it('stop() 幂等：停止后零网络、定时器与订阅全部释放，重复 stop 安全', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const env = makeWorkerEnv({ CLOUD_SYNC_TOKEN: CLIENT_TOKEN })
  const cloud = createWorkerCloud(env)
  await writeCloudConfig(dir)
  const client = clientFor(store, dir, cloud)
  await client.start()
  await waitFor(() => client.status().baseRevision >= 1, { label: '初始同步完成' })
  await client.stop()
  assert.equal(client.status().running, false)
  assert.equal(client.status().phase, 'stopped')
  const callsAtStop = cloud.state.calls.length

  // 停止后本地写变更、等待超过所有定时器周期：不得再有任何网络请求
  await createLocalCard(store, '停止后新增卡片')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(cloud.state.calls.length, callsAtStop, 'stop 后不应再发起云端请求')
  // 幂等：重复 stop 不抛错、状态不抖
  await client.stop()
  assert.equal(client.status().phase, 'stopped')
  // 停止后 start() 不再重启（生命周期终态）
  await client.start()
  assert.equal(client.status().running, false)
})

it('本地回放地址安全护栏：只接受回环 origin（防入站载荷被外发）', async t => {
  const { store, dir } = await testStore(t, { seedMode: 'empty' })
  const client = createCloudSyncClient({
    store,
    dataDir: dir,
    logger: quietLogger(),
    localOrigin: 'http://evil.example.com',
    fetchImpl: async () => { throw new Error('不应联网') },
    timing: FAST_TIMING,
  })
  assert.ok(client.resolveLocalOrigin().startsWith('http://127.0.0.1'), '非回环 localOrigin 应被忽略')
  assert.equal(client.setLocalOrigin('http://evil.example.com'), '')
  assert.equal(client.setLocalOrigin('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234')
  await client.stop()
})

// 保证 MemoryD1/MIGRATION_SQL 在本文件被引用（node:sqlite 不可用时 skip 提示更明确）
it('内存 D1 迁移可重复执行（C3 测试云端底座自检）', () => {
  if (!HAS_SQLITE) return
  const db = new MemoryD1(MIGRATION_SQL)
  db.exec(MIGRATION_SQL)
  const row = db.one('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ?', 'table')
  assert.ok(Number(row.n) >= 7)
  db.close()
})
