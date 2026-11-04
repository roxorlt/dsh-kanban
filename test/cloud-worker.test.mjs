// cloud-worker.test.mjs（C2/3）：Cloudflare Worker 控制面的端到端测试。
//
// 测试策略：**不 mock SQL**。用 node:sqlite 的内存库实现一个 D1 兼容层
// （prepare/bind/all/first/run/batch + 事务），在 setUp 时执行真实的
// cloudflare/migrations/0001_kanban_sync.sql，然后把该 D1 兼容层注入 env.DB。
// 因此本文件同时验证：Worker 路由/鉴权/协议行为、写的 SQL 在 SQLite 中可执行、
// 迁移 SQL 可重复执行、以及入站队列的租约/退避/零丢失回放语义。
//
// 依赖：Node >= 22.13（node:sqlite 无需 flag；更低版本本文件会整体 skip）。
// 时钟：所有用例注入固定 now（options.now），租约/退避/过期断言完全确定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import workerDefault, { handleRequest, runCleanup } from '../cloudflare/worker.mjs'
// 内存 D1 与测试常量抽到 test/cloud-worker-harness.mjs，与 C3 端到端测试共用，
// 保证两侧验证的是同一套 Worker/SQL/迁移行为（C2 卡验收时该文件内联，C3 抽取复用）。
import {
  DINGTALK_ACCESS_TOKEN, DINGTALK_SIGN_SECRET, FEISHU_ENCRYPT_KEY, FEISHU_TOKEN,
  GENERIC_TOKEN, GITHUB_SECRET, HAS_SQLITE, MIGRATION_SQL, MemoryD1, TOKEN,
  makeWorkerEnv as makeEnv,
} from './cloud-worker-harness.mjs'
import {
  CLOUD_PROTOCOL_VERSION,
  CLOUD_SYNC_LIMITS,
  applyDeltaToCloudSnapshot,
  diffCloudSnapshots,
  emptyCloudSnapshot,
  encodeSyncCursor,
  hashPushId,
  pullResponseToDelta,
  toCloudActivity,
  toCloudBoard,
  toCloudCard,
  toCloudSnapshot,
} from '../lib/cloud-sync-protocol.js'

const it = HAS_SQLITE ? test : test.skip

// ---------------------------------------------------------------------------
// 固定数据与助手
// ---------------------------------------------------------------------------

const NOW = 1_790_000_000_000 // 固定时钟：2026-09-21 左右
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** 调用 Worker 路由：自动设置 Bearer（token=null 时不设置）、解析 JSON。 */
async function call(env, path, { method = 'GET', token = TOKEN, headers = {}, body, rawBody, now = NOW } = {}) {
  const init = { method, headers: { ...headers } }
  if (token !== null) init.headers.authorization = `Bearer ${token}`
  if (rawBody !== undefined) {
    init.body = rawBody
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = init.headers['content-type'] || 'application/json'
  }
  const response = await handleRequest(new Request(`https://worker.test${path}`, init), env, { now })
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: response.status, headers: response.headers, text, json }
}

function sqlOne(env, sql, ...params) { return env.DB.one(sql, ...params) }
function sqlAll(env, sql, ...params) { return env.DB.all(sql, ...params) }
function rowCount(env, table, where = '', params = []) {
  const row = sqlOne(env, `SELECT COUNT(*) AS n FROM ${table} ${where}`, ...params)
  return Number(row?.n ?? 0)
}

function assertError(result, status, code) {
  assert.equal(result.status, status, `期望 HTTP ${status}，实际 ${result.status}：${result.text}`)
  assert.equal(result.json?.ok, false)
  assert.equal(result.json?.error?.code, code)
  assert.equal(typeof result.json?.requestId, 'string')
}

function boardFixture(id = 'board-default', overrides = {}) {
  return {
    id,
    name: '主看板',
    cardOrder: { backlog: [], running: [] },
    createdAt: NOW - 5_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  }
}

function cardFixture(id, overrides = {}) {
  return {
    id,
    boardId: 'board-default',
    title: `卡片 ${id}`,
    status: 'backlog',
    priority: 'none',
    version: 1,
    archived: false,
    createdAt: NOW - 5_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  }
}

function activityFixture(id, cardId, overrides = {}) {
  return {
    id,
    cardId,
    type: 'progress',
    actor: { kind: 'agent', name: 'DSH' },
    text: `事件 ${id}`,
    at: NOW - 2_000,
    ...overrides,
  }
}

function makeDelta({
  boardUpserts = [], cardUpserts = [], activityUpserts = [],
  boardDeletes = [], cardDeletes = [], activityDeletes = [],
} = {}) {
  return {
    boards: { upserts: boardUpserts, deletes: boardDeletes },
    cards: { upserts: cardUpserts, deletes: cardDeletes },
    activities: { upserts: activityUpserts, deletes: activityDeletes },
  }
}

let autoPushSeq = 0
function nextPushId() {
  autoPushSeq += 1
  return `push-${String(autoPushSeq).padStart(32, '0')}`
}

async function push(env, delta, options = {}) {
  const payload = {
    protocolVersion: options.protocolVersion ?? 1,
    clientId: options.clientId ?? 'c2-test-client',
    pushId: options.pushId ?? nextPushId(),
    baseRevision: options.baseRevision ?? 0,
    delta,
  }
  if (options.epoch !== undefined) payload.epoch = options.epoch
  if (options.reset !== undefined) payload.reset = options.reset
  return call(env, '/v1/sync/push', { method: 'POST', body: payload, now: options.now ?? NOW })
}

/** 推送一份「看板 + 卡片 + 时间线」的最小增量，返回响应。 */
function pushSeed(env, options = {}) {
  return push(env, makeDelta({
    boardUpserts: [boardFixture()],
    cardUpserts: [cardFixture('card-00000001', { status: 'running', priority: 'high', version: 3 })],
    activityUpserts: [activityFixture('ev-00000001', 'card-00000001')],
  }), options)
}

function hmacGithub(raw, secret = GITHUB_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`
}

function githubIngress(env, bodyObject, options = {}) {
  const raw = JSON.stringify(bodyObject)
  return call(env, '/v1/ingress/github', {
    method: 'POST',
    token: null,
    headers: {
      'content-type': 'application/json',
      'x-github-event': options.event ?? 'issues',
      'x-github-delivery': options.delivery ?? 'delivery-0001',
      'x-hub-signature-256': options.signature ?? hmacGithub(raw, options.secret ?? GITHUB_SECRET),
      ...(options.headers ?? {}),
    },
    rawBody: raw,
    now: options.now ?? NOW,
  })
}

function dingtalkIngress(env, bodyObject, options = {}) {
  const raw = JSON.stringify(bodyObject)
  const timestamp = String(Math.floor((options.timestampMs ?? NOW) / 1000))
  const secret = options.secret ?? DINGTALK_SIGN_SECRET
  const sign = options.sign ?? createHmac('sha256', secret).update(`${timestamp}\n${secret}`, 'utf8').digest('base64')
  return call(env, '/v1/ingress/dingtalk', {
    method: 'POST',
    token: null,
    headers: { 'content-type': 'application/json', timestamp, sign, ...(options.headers ?? {}) },
    rawBody: raw,
    now: options.now ?? NOW,
  })
}

function genericIngress(env, bodyObject, options = {}) {
  return call(env, '/v1/ingress/generic', {
    method: 'POST',
    token: null,
    headers: {
      'content-type': 'application/json',
      ...(options.token === null ? {} : { 'x-kanban-ingress-token': options.token ?? GENERIC_TOKEN }),
      ...(options.headers ?? {}),
    },
    rawBody: typeof bodyObject === 'string' ? bodyObject : JSON.stringify(bodyObject),
    now: options.now ?? NOW,
  })
}

function feishuIngress(env, bodyObject, options = {}) {
  const raw = JSON.stringify(bodyObject)
  return call(env, '/v1/ingress/feishu', {
    method: 'POST',
    token: null,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    rawBody: raw,
    now: options.now ?? NOW,
  })
}

function claim(env, options = {}) {
  return call(env, '/v1/inbox/claim', {
    method: 'POST',
    body: {
      consumerId: options.consumerId ?? 'c2-macbook',
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.leaseSeconds !== undefined ? { leaseSeconds: options.leaseSeconds } : {}),
    },
    now: options.now ?? NOW,
  })
}

function ack(env, results, options = {}) {
  return call(env, '/v1/inbox/ack', {
    method: 'POST',
    body: { consumerId: options.consumerId ?? 'c2-macbook', results },
    now: options.now ?? NOW,
  })
}

function pull(env, query = '') {
  return call(env, `/v1/sync/pull${query}`)
}

// ===========================================================================
// 一、迁移与鉴权 / 错误信封
// ===========================================================================

it('迁移 SQL 可在 SQLite 执行且重复执行幂等（epoch 不变）', () => {
  const db = new MemoryD1(MIGRATION_SQL)
  try {
    const before = db.one('SELECT epoch, revision FROM sync_meta WHERE id = 1')
    assert.match(String(before.epoch), /^[0-9a-f]{16}$/)
    assert.equal(Number(before.revision), 0)
    db.exec(MIGRATION_SQL) // 重复执行不应报错、不应改变 epoch
    const after = db.one('SELECT epoch, revision FROM sync_meta WHERE id = 1')
    assert.equal(String(after.epoch), String(before.epoch))
    assert.equal(Number(after.revision), 0)
    for (const table of ['boards', 'cards', 'activities', 'tombstones', 'outbox', 'ingress_inbox']) {
      assert.equal(Number(db.one(`SELECT COUNT(*) AS n FROM ${table}`).n), 0)
    }
  } finally {
    db.close()
  }
})

it('状态面四个端点未带 Bearer 一律 401（统一错误信封 + requestId + 不泄漏数据）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  for (const [path, method] of [
    ['/v1/sync/pull', 'GET'],
    ['/v1/sync/push', 'POST'],
    ['/v1/inbox/claim', 'POST'],
    ['/v1/inbox/ack', 'POST'],
  ]) {
    const result = await call(env, path, { method, token: null, body: method === 'POST' ? {} : undefined })
    assertError(result, 401, 'UNAUTHORIZED')
    assert.ok(!result.text.includes(TOKEN))
    assert.equal(result.json.boards, undefined)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.match(String(result.headers.get('content-type')), /application\/json/)
  }
})

it('Bearer 令牌错误一律 401（不区分「不存在/错误」）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const wrong = await call(env, '/v1/sync/pull', { token: 'wrong-token-0123456789abcdef' })
  assertError(wrong, 401, 'UNAUTHORIZED')
  assert.ok(!wrong.text.includes(TOKEN))
  const malformed = await call(env, '/v1/sync/pull', { token: null, headers: { authorization: 'Basic abc' } })
  assertError(malformed, 401, 'UNAUTHORIZED')
})

it('未配置 CLOUD_SYNC_TOKEN 时状态面 fail-closed 503，绝不放行', async t => {
  const env = makeEnv({ CLOUD_SYNC_TOKEN: undefined })
  t.after(() => env.DB.close())
  for (const [path, method] of [
    ['/v1/sync/pull', 'GET'],
    ['/v1/sync/push', 'POST'],
    ['/v1/inbox/claim', 'POST'],
    ['/v1/inbox/ack', 'POST'],
  ]) {
    const result = await call(env, path, { method, body: method === 'POST' ? {} : undefined })
    assertError(result, 503, 'UNAVAILABLE')
    assert.match(String(result.json.error.message), /CLOUD_SYNC_TOKEN/)
  }
})

it('未知路由 404、方法不匹配 405、ingress 方法限制', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const notFound = await call(env, '/v1/nope')
  assertError(notFound, 404, 'NOT_FOUND')
  const wrongMethod = await call(env, '/v1/sync/pull', { method: 'POST', body: {} })
  assertError(wrongMethod, 405, 'METHOD_NOT_ALLOWED')
  assert.equal(wrongMethod.json.error.details.allowed, 'GET')
  const ingressGet = await call(env, '/v1/ingress/github')
  assertError(ingressGet, 405, 'METHOD_NOT_ALLOWED')
})

it('D1 故障 → 503 UNAVAILABLE（可退避的瞬时故障，且不泄漏内部错误）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const broken = makeEnv()
  t.after(() => broken.DB.close())
  broken.DB.batch = async () => { throw new Error('D1_ERROR: internal storage failure') }
  const pullResult = await call(broken, '/v1/sync/pull')
  assertError(pullResult, 503, 'UNAVAILABLE')
  assert.ok(!pullResult.text.includes('D1_ERROR'))
  const pushResult = await push(broken, makeDelta({ cardUpserts: [cardFixture('card-d1')] }))
  assertError(pushResult, 503, 'UNAVAILABLE')
})

it('Worker 默认导出提供 fetch/scheduled 入口', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  assert.equal(typeof workerDefault.fetch, 'function')
  assert.equal(typeof workerDefault.scheduled, 'function')
  const response = await workerDefault.fetch(new Request('https://worker.test/v1/sync/pull', {
    headers: { authorization: `Bearer ${TOKEN}` },
  }), env, {})
  assert.equal(response.status, 200)
  const scheduled = await workerDefault.scheduled({}, env, {})
  assert.equal(scheduled, undefined)
})

// ===========================================================================
// 二、push：CAS / 幂等 / 校验 / 复位 / 版本防回退 / 脱敏纵深防御
// ===========================================================================

it('全量 push applied：revision=1、epoch 16 位、applied 计数与热点列落库正确', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const board = boardFixture('board-default', { cardOrder: { backlog: ['card-00000001'], running: [] } })
  const card = cardFixture('card-00000001', {
    status: 'running', priority: 'high', project: 'dsh-kanban',
    externalRef: 'github:o/r#1', parentCardId: null, version: 3,
  })
  const activity = activityFixture('ev-00000001', 'card-00000001')
  const result = await push(env, makeDelta({
    boardUpserts: [board], cardUpserts: [card], activityUpserts: [activity],
  }), { pushId: 'push-first-0001' })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.status, 'applied')
  assert.equal(result.json.protocolVersion, CLOUD_PROTOCOL_VERSION)
  assert.equal(result.json.baseRevision, 0)
  assert.equal(result.json.revision, 1)
  assert.equal(result.json.pushId, 'push-first-0001')
  assert.match(String(result.json.epoch), /^[0-9a-f]{16}$/)
  assert.deepEqual(result.json.applied, {
    boards: { upserted: 1, deleted: 0 },
    cards: { upserted: 1, deleted: 0 },
    activities: { upserted: 1, deleted: 0 },
  })

  const meta = sqlOne(env, 'SELECT revision, epoch, last_push_id, last_push_revision, last_client_id FROM sync_meta WHERE id = 1')
  assert.equal(Number(meta.revision), 1)
  assert.equal(String(meta.last_push_id), 'push-first-0001')
  assert.equal(Number(meta.last_push_revision), 1)
  assert.equal(String(meta.last_client_id), 'c2-test-client')
  assert.equal(String(meta.epoch), result.json.epoch)

  const boardRow = sqlOne(env, 'SELECT * FROM boards WHERE id = ?', 'board-default')
  assert.equal(boardRow.name, '主看板')
  assert.deepEqual(JSON.parse(boardRow.card_order), { backlog: ['card-00000001'], running: [] })
  assert.equal(Number(boardRow.revision), 1)
  assert.deepEqual(JSON.parse(boardRow.payload), toCloudBoard(board))

  const cardRow = sqlOne(env, 'SELECT * FROM cards WHERE id = ?', 'card-00000001')
  assert.equal(cardRow.board_id, 'board-default')
  assert.equal(cardRow.title, '卡片 card-00000001')
  assert.equal(cardRow.status, 'running')
  assert.equal(cardRow.priority, 'high')
  assert.equal(cardRow.project, 'dsh-kanban')
  assert.equal(cardRow.external_ref, 'github:o/r#1')
  assert.equal(cardRow.parent_card_id, null)
  assert.equal(Number(cardRow.version), 3)
  assert.equal(Number(cardRow.archived), 0)
  assert.equal(Number(cardRow.revision), 1)
  assert.deepEqual(JSON.parse(cardRow.payload), toCloudCard(card))

  const activityRow = sqlOne(env, 'SELECT * FROM activities WHERE id = ?', 'ev-00000001')
  assert.equal(activityRow.card_id, 'card-00000001')
  assert.equal(activityRow.actor_kind, 'agent')
  assert.equal(activityRow.actor_name, 'DSH')
  assert.equal(activityRow.type, 'progress')
  assert.equal(Number(activityRow.at), activity.at)
  assert.deepEqual(JSON.parse(activityRow.payload), toCloudActivity(activity))
})

it('push 幂等：同一 pushId 重试返回 duplicate 且绝不重复写库（即使 delta 变了）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env, { pushId: 'push-idempotent-0001' })
  const changed = makeDelta({
    boardUpserts: [boardFixture()],
    cardUpserts: [cardFixture('card-00000001', { title: '不应覆盖', version: 9 })],
    activityUpserts: [activityFixture('ev-00000001', 'card-00000001')],
  })
  const retry = await push(env, changed, { pushId: 'push-idempotent-0001', baseRevision: 1 })
  assert.equal(retry.status, 200)
  assert.equal(retry.json.status, 'duplicate')
  assert.equal(retry.json.revision, 1)
  assert.deepEqual(retry.json.applied, {
    boards: { upserted: 0, deleted: 0 },
    cards: { upserted: 0, deleted: 0 },
    activities: { upserted: 0, deleted: 0 },
  })
  const cardRow = sqlOne(env, 'SELECT title, version, revision FROM cards WHERE id = ?', 'card-00000001')
  assert.equal(cardRow.title, '卡片 card-00000001')
  assert.equal(Number(cardRow.version), 3)
  assert.equal(Number(cardRow.revision), 1)
  assert.equal(Number(sqlOne(env, 'SELECT revision FROM sync_meta WHERE id = 1').revision), 1)
})

it('空增量 push 返回 noop，不分配 revision（避免版本空转）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const noop = await push(env, makeDelta(), { baseRevision: 1 })
  assert.equal(noop.status, 200)
  assert.equal(noop.json.status, 'noop')
  assert.equal(noop.json.revision, 1)
  assert.equal(Number(sqlOne(env, 'SELECT revision FROM sync_meta WHERE id = 1').revision), 1)
})

it('epoch 不匹配 → 409 SYNC_EPOCH_MISMATCH（客户端应全量 reset）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const result = await push(env, makeDelta({ cardUpserts: [cardFixture('card-00000001')] }), {
    epoch: 'deadbeefdeadbeef',
  })
  assertError(result, 409, 'SYNC_EPOCH_MISMATCH')
  assert.equal(result.json.error.details.resetRequired, true)
  assert.equal(Number(sqlOne(env, 'SELECT revision FROM sync_meta WHERE id = 1').revision), 0)
  assert.equal(rowCount(env, 'cards'), 0)
})

it('baseRevision 落后 → 409 REVISION_CONFLICT，且不写库', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const result = await push(env, makeDelta({ cardUpserts: [cardFixture('card-00000002')] }), { baseRevision: 0 })
  assertError(result, 409, 'REVISION_CONFLICT')
  assert.equal(result.json.error.details.serverRevision, 1)
  assert.equal(rowCount(env, 'cards', 'WHERE id = ?', ['card-00000002']), 0)
})

it('delta 结构非法一律 400（未知分组/重复 id/同 id 双向/缺 id）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const cases = [
    { ...makeDelta(), notes: { upserts: [], deletes: [] } },
    makeDelta({ cardUpserts: [cardFixture('card-1'), cardFixture('card-1')] }),
    makeDelta({ cardUpserts: [cardFixture('card-1')], cardDeletes: ['card-1'] }),
    makeDelta({ cardUpserts: [{ boardId: 'board-default', status: 'backlog' }] }),
    makeDelta({ cardDeletes: ['card-1', 'card-1'] }),
  ]
  for (const delta of cases) {
    const result = await push(env, delta)
    assertError(result, 400, 'BAD_REQUEST')
  }
  assert.equal(rowCount(env, 'cards'), 0)
})

it('单次 push 实体数超过 200 → 400（要求客户端先 chunkDelta 分片）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const deletes = Array.from({ length: CLOUD_SYNC_LIMITS.pushEntities + 1 }, (_, index) => `card-missing-${index}`)
  const result = await push(env, makeDelta({ cardDeletes: deletes }))
  assertError(result, 400, 'BAD_REQUEST')
  assert.match(String(result.json.error.message), /上限/)
})

it('push 请求体超过 256 KiB → 413 PAYLOAD_TOO_LARGE', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const huge = 'x'.repeat(300 * 1024)
  const result = await push(env, makeDelta({
    cardUpserts: [cardFixture('card-huge', { title: huge })],
  }))
  assertError(result, 413, 'PAYLOAD_TOO_LARGE')
  assert.equal(rowCount(env, 'cards'), 0)
})

it('protocolVersion 非 1 → 400 UNSUPPORTED_PROTOCOL_VERSION', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const result = await push(env, makeDelta(), { protocolVersion: 2 })
  assertError(result, 400, 'UNSUPPORTED_PROTOCOL_VERSION')
})

it('必填字段缺失/类型非法 → 400（clientId/pushId/baseRevision）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const base = { protocolVersion: 1, clientId: 'c2-test-client', pushId: 'p-1', baseRevision: 0, delta: makeDelta() }
  const variants = [
    { ...base, clientId: '' },
    { ...base, clientId: 'c'.repeat(81) },
    { ...base, pushId: '' },
    { ...base, baseRevision: -1 },
    { ...base, baseRevision: 'abc' },
    { ...base, baseRevision: 1.5 },
    { ...base, baseRevision: '0' },
    { ...base, delta: null },
  ]
  for (const body of variants) {
    const result = await call(env, '/v1/sync/push', { method: 'POST', body })
    assertError(result, 400, 'BAD_REQUEST')
  }
})

it('卡片 status 非法 / 时间线缺 cardId → 400（在写库前拦下，避免 D1 CHECK 变 500）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const badStatus = await push(env, makeDelta({ cardUpserts: [cardFixture('card-1', { status: 'weird' })] }))
  assertError(badStatus, 400, 'BAD_REQUEST')
  const badActivity = await push(env, makeDelta({
    activityUpserts: [activityFixture('ev-1', '')],
  }))
  assertError(badActivity, 400, 'BAD_REQUEST')
  assert.equal(rowCount(env, 'cards'), 0)
  assert.equal(rowCount(env, 'activities'), 0)
})

it('卡片 version 防回退：旧版本 upsert 不覆盖新版本行（WHERE excluded.version >= cards.version）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await push(env, makeDelta({ cardUpserts: [cardFixture('card-00000001', { title: '新版', version: 2 })] }), {
    pushId: 'push-version-1',
  })
  const stale = await push(env, makeDelta({
    cardUpserts: [cardFixture('card-00000001', { title: '旧版覆盖尝试', version: 1 })],
  }), { baseRevision: 1, pushId: 'push-version-2' })
  assert.equal(stale.status, 200)
  assert.equal(stale.json.revision, 2)
  assert.equal(stale.json.applied.cards.upserted, 0)
  const cardRow = sqlOne(env, 'SELECT title, version, revision FROM cards WHERE id = ?', 'card-00000001')
  assert.equal(cardRow.title, '新版')
  assert.equal(Number(cardRow.version), 2)
  assert.equal(Number(cardRow.revision), 1)
  const window = await pull(env, '?since=1&until=2')
  assert.deepEqual(window.json.cards, [])
})

it('push 删除：墓碑写入 + 镜像行删除 + 增量窗口可见', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const result = await push(env, makeDelta({
    boardDeletes: ['board-default'],
    cardDeletes: ['card-00000001'],
    activityDeletes: ['ev-00000001'],
  }), { baseRevision: 1 })
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.applied, {
    boards: { upserted: 0, deleted: 1 },
    cards: { upserted: 0, deleted: 1 },
    activities: { upserted: 0, deleted: 1 },
  })
  assert.equal(rowCount(env, 'boards'), 0)
  assert.equal(rowCount(env, 'cards'), 0)
  assert.equal(rowCount(env, 'activities'), 0)
  const tombstones = sqlAll(env, 'SELECT entity, entity_id, deleted_at, revision FROM tombstones ORDER BY entity, entity_id')
  assert.deepEqual(tombstones.map(row => [row.entity, row.entity_id, Number(row.revision)]), [
    ['activity', 'ev-00000001', 2],
    ['board', 'board-default', 2],
    ['card', 'card-00000001', 2],
  ])
  assert.ok(tombstones.every(row => Number(row.deleted_at) === NOW))

  const window = await pull(env, '?since=1&until=2')
  assert.equal(window.json.tombstones.length, 3)
  assert.deepEqual(window.json.tombstones.map(row => row.entityId).sort(), ['board-default', 'card-00000001', 'ev-00000001'])
  assert.ok(window.json.tombstones.every(row => row.revision === 2 && row.deletedAt === NOW))
})

it('批量删除/墓碑合并成多行语句：120 张卡一次删除全部落库且墓碑齐备', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const cards = Array.from({ length: 120 }, (_, index) => cardFixture(`card-bulk-${String(index).padStart(3, '0')}`))
  const seeded = await push(env, makeDelta({ cardUpserts: cards }))
  assert.equal(seeded.status, 200)
  assert.equal(seeded.json.applied.cards.upserted, 120)
  const removed = await push(env, makeDelta({
    cardDeletes: cards.map(card => card.id),
  }), { baseRevision: 1 })
  assert.equal(removed.status, 200)
  assert.equal(removed.json.applied.cards.deleted, 120)
  assert.equal(rowCount(env, 'cards'), 0)
  assert.equal(rowCount(env, 'tombstones', 'WHERE entity = ?', ['card']), 120)
  const window = await pull(env, '?since=1&until=2&limit=200')
  assert.equal(window.json.tombstones.length, 120)
  assert.equal(window.json.hasMore, false)
})

it('reset:true 全量重建：清空镜像表、保留 sync_meta 与 ingress_inbox、revision 继续递增', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const epochBefore = String(sqlOne(env, 'SELECT epoch FROM sync_meta WHERE id = 1').epoch)
  const ingress = await genericIngress(env, { type: 'wake', at: NOW })
  assert.equal(ingress.status, 202)

  const reset = await push(env, makeDelta({
    boardUpserts: [boardFixture('board-new')],
    cardUpserts: [cardFixture('card-new', { boardId: 'board-new' })],
  }), { baseRevision: 1, reset: true })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.status, 'applied')
  assert.equal(reset.json.revision, 2)
  assert.equal(reset.json.reset, true)
  assert.equal(rowCount(env, 'boards'), 1)
  assert.equal(rowCount(env, 'boards', 'WHERE id = ?', ['board-new']), 1)
  assert.equal(rowCount(env, 'cards'), 1)
  assert.equal(rowCount(env, 'activities'), 0)
  assert.equal(rowCount(env, 'tombstones'), 0)
  assert.equal(rowCount(env, 'ingress_inbox'), 1, 'reset 不得清空入站队列')
  const meta = sqlOne(env, 'SELECT epoch, revision FROM sync_meta WHERE id = 1')
  assert.equal(String(meta.epoch), epochBefore)
  assert.equal(Number(meta.revision), 2)

  const all = await pull(env, '?since=0')
  assert.deepEqual(all.json.boards.map(board => board.id), ['board-new'])
  assert.deepEqual(all.json.cards.map(card => card.id), ['card-new'])
  assert.deepEqual(all.json.activities, [])
})

it('纵深防御：push 载荷即使含本地执行面字段/密钥，云端也只落白名单脱敏投影', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const dirtyCard = {
    ...cardFixture('card-dirty'),
    title: '连接 /Users/alice/proj 使用 sk-abcdefghijklmnop1234567890',
    cwd: '/Users/alice/workspace/dsh-kanban',
    workspaceId: 'ws-secret',
    sessionIds: ['session-secret'],
    runtime: { pid: 4242 },
    outbox: [{ id: 'o-1' }],
    autoStart: true,
    externalThreadId: 'dingtalk:secret-thread',
    arbitrarySecret: 'should-not-leak',
  }
  const result = await push(env, makeDelta({ cardUpserts: [dirtyCard] }))
  assert.equal(result.status, 200)
  const row = sqlOne(env, 'SELECT title, payload FROM cards WHERE id = ?', 'card-dirty')
  assert.equal(row.title, '连接 ~/proj 使用 sk-****')
  const stored = JSON.parse(row.payload)
  for (const forbidden of ['cwd', 'workspaceId', 'sessionIds', 'runtime', 'outbox', 'autoStart', 'externalThreadId', 'arbitrarySecret']) {
    assert.equal(Object.hasOwn(stored, forbidden), false, `不允许上云的字段泄漏：${forbidden}`)
  }
  assert.equal(stored.title, '连接 ~/proj 使用 sk-****')
  assert.equal(rowCount(env, 'cards'), 1)
})

// ===========================================================================
// 三、pull：窗口 / 键集游标分页 / 冻结窗口 / 墓碑
// ===========================================================================

it('空库 pull：revision=0、epoch 存在、四类实体为空、hasMore=false', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const result = await pull(env, '?since=0')
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.protocolVersion, CLOUD_PROTOCOL_VERSION)
  assert.equal(result.json.revision, 0)
  assert.equal(result.json.since, 0)
  assert.equal(result.json.until, 0)
  assert.match(String(result.json.epoch), /^[0-9a-f]{16}$/)
  assert.deepEqual(result.json.boards, [])
  assert.deepEqual(result.json.cards, [])
  assert.deepEqual(result.json.activities, [])
  assert.deepEqual(result.json.tombstones, [])
  assert.equal(result.json.hasMore, false)
  assert.deepEqual(result.json.cursors, {})
})

it('pull revision 窗口：since 不含、until 含、超界 until 被夹紧', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await push(env, makeDelta({ cardUpserts: [cardFixture('card-r1')] }), { pushId: 'push-window-1' })
  await push(env, makeDelta({ cardUpserts: [cardFixture('card-r2')] }), {
    baseRevision: 1, pushId: 'push-window-2',
  })
  const first = await pull(env, '?since=0&until=1')
  assert.deepEqual(first.json.cards.map(card => card.id), ['card-r1'])
  assert.equal(first.json.until, 1)
  assert.equal(first.json.revision, 2)

  const second = await pull(env, '?since=1&until=2')
  assert.deepEqual(second.json.cards.map(card => card.id), ['card-r2'])

  const clamped = await pull(env, '?since=0&until=999')
  assert.equal(clamped.json.until, 2)
  assert.deepEqual(clamped.json.cards.map(card => card.id), ['card-r1', 'card-r2'])
})

it('pull since 超过服务端 revision → 400 BAD_REQUEST', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const result = await pull(env, '?since=5')
  assertError(result, 400, 'BAD_REQUEST')
})

it('pull 键集游标分页：limit=2 翻完 5 张卡，无重复无遗漏', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const cards = Array.from({ length: 5 }, (_, index) => cardFixture(`card-page-${index + 1}`))
  await push(env, makeDelta({ cardUpserts: cards }))
  const ids = []
  let cursor = null
  let pages = 0
  do {
    const query = cursor
      ? `?since=0&until=1&limit=2&cursor=${encodeURIComponent(cursor)}`
      : '?since=0&until=1&limit=2'
    const page = await pull(env, query)
    assert.equal(page.status, 200)
    pages += 1
    for (const card of page.json.cards) ids.push(card.id)
    cursor = page.json.hasMore ? page.json.cursor : null
    if (page.json.hasMore) {
      assert.ok(cursor)
      assert.equal(Object.keys(page.json.cursors).length, 4)
      assert.ok(Object.values(page.json.cursors).every(value => value === cursor))
    }
    assert.ok(pages <= 10, '分页不应死循环')
  } while (cursor)
  assert.equal(pages, 3)
  assert.deepEqual(ids, ['card-page-1', 'card-page-2', 'card-page-3', 'card-page-4', 'card-page-5'])
})

it('pull 冻结窗口：分页期间的新 push 不会漏进旧 until 窗口', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const cards = Array.from({ length: 3 }, (_, index) => cardFixture(`card-freeze-${index + 1}`))
  await push(env, makeDelta({ cardUpserts: cards }), { pushId: 'push-freeze-1' })
  const page1 = await pull(env, '?since=0&until=1&limit=2')
  assert.equal(page1.json.cards.length, 2)
  assert.equal(page1.json.hasMore, true)

  // 分页途中本地又推了一版（云端 revision 2）——旧窗口 until=1 必须冻结
  await push(env, makeDelta({ cardUpserts: [cardFixture('card-freeze-4')] }), {
    baseRevision: 1, pushId: 'push-freeze-2',
  })
  const page2 = await pull(env, `?since=0&until=1&limit=2&cursor=${encodeURIComponent(page1.json.cursor)}`)
  assert.deepEqual(page2.json.cards.map(card => card.id), ['card-freeze-3'])
  assert.equal(page2.json.hasMore, false)
  assert.equal(page2.json.until, 1)

  const nextWindow = await pull(env, '?since=1&until=2')
  assert.deepEqual(nextWindow.json.cards.map(card => card.id), ['card-freeze-4'])
})

it('reset:true + 空 delta 也能清空云端镜像（清空是写操作，仍分配 revision）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const reset = await push(env, makeDelta(), { baseRevision: 1, reset: true, pushId: 'push-reset-empty' })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.status, 'applied')
  assert.equal(reset.json.reset, true)
  assert.equal(reset.json.revision, 2)
  assert.deepEqual(reset.json.applied, {
    boards: { upserted: 0, deleted: 0 },
    cards: { upserted: 0, deleted: 0 },
    activities: { upserted: 0, deleted: 0 },
  })
  assert.equal(rowCount(env, 'boards'), 0)
  assert.equal(rowCount(env, 'cards'), 0)
  assert.equal(rowCount(env, 'activities'), 0)
  assert.equal(Number(sqlOne(env, 'SELECT revision FROM sync_meta WHERE id = 1').revision), 2)
  const all = await pull(env, '?since=0')
  assert.deepEqual(all.json.boards, [])
  assert.equal(all.json.revision, 2)
})

it('空 delta 不再掩盖冲突：错误 epoch / 落后 baseRevision 都返回 409', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const wrongEpoch = await push(env, makeDelta(), { baseRevision: 1, epoch: 'deadbeefdeadbeef' })
  assertError(wrongEpoch, 409, 'SYNC_EPOCH_MISMATCH')
  const staleBase = await push(env, makeDelta(), { baseRevision: 0 })
  assertError(staleBase, 409, 'REVISION_CONFLICT')
  // 正常空增量仍是 noop
  const noop = await push(env, makeDelta(), { baseRevision: 1 })
  assert.equal(noop.status, 200)
  assert.equal(noop.json.status, 'noop')
})

it('M2：多行 upsert 把单批 SQL 语句数压到安全范围（200 卡 ≈ 35 条、200 删 ≈ 14 条）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const cards = Array.from({ length: 200 }, (_, index) => cardFixture(`card-many-${String(index).padStart(3, '0')}`))
  const pushed = await push(env, makeDelta({ cardUpserts: cards }))
  assert.equal(pushed.status, 200)
  assert.equal(pushed.json.applied.cards.upserted, 200)
  assert.ok(env.DB.lastBatchSize <= 40, `200 卡 push 的 batch 语句数应 ≤40，实际 ${env.DB.lastBatchSize}`)
  const removed = await push(env, makeDelta({ cardDeletes: cards.map(card => card.id) }), { baseRevision: 1 })
  assert.equal(removed.json.applied.cards.deleted, 200)
  assert.ok(env.DB.lastBatchSize <= 20, `200 删 push 的 batch 语句数应 ≤20，实际 ${env.DB.lastBatchSize}`)
  assert.equal(rowCount(env, 'tombstones'), 200)
})

it('多行 upsert 的逐行版本守卫：同批中旧版本被跳过、新实体照常写入', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await push(env, makeDelta({
    cardUpserts: [cardFixture('card-guard-a', { title: '新版', version: 5 })],
  }), { pushId: 'push-multirow-1' })
  const batch = await push(env, makeDelta({
    cardUpserts: [
      cardFixture('card-guard-a', { title: '旧版覆盖尝试', version: 1 }),
      cardFixture('card-guard-b', { title: '新卡', version: 1 }),
    ],
  }), { baseRevision: 1, pushId: 'push-multirow-2' })
  assert.equal(batch.status, 200)
  assert.equal(batch.json.applied.cards.upserted, 1, '只有新实体真正写入')
  const rows = sqlAll(env, 'SELECT id, title, version FROM cards ORDER BY id')
  assert.deepEqual(rows.map(row => [String(row.id), row.title, Number(row.version)]), [
    ['card-guard-a', '新版', 5],
    ['card-guard-b', '新卡', 1],
  ])
})

it('push 拦截超长实体 id（>200 字符），避免 pull 游标在页边界永久 400', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const longId = `card-${'l'.repeat(300)}`
  const upsertLong = await push(env, makeDelta({ cardUpserts: [cardFixture(longId)] }))
  assertError(upsertLong, 400, 'BAD_REQUEST')
  const deleteLong = await push(env, makeDelta({ cardDeletes: [longId] }))
  assertError(deleteLong, 400, 'BAD_REQUEST')
  assert.equal(rowCount(env, 'cards'), 0)
  // 边界内（200 字符）允许
  const boundaryId = `card-${'b'.repeat(195)}`
  const ok = await push(env, makeDelta({ cardUpserts: [cardFixture(boundaryId)] }))
  assert.equal(ok.status, 200)
  assert.equal(ok.json.applied.cards.upserted, 1)
})

it('pull 墓碑分页：键集按 (revision, entity, entity_id) 推进', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await push(env, makeDelta({
    activityUpserts: ['ev-00000001', 'ev-00000002', 'ev-00000003'].map(id => activityFixture(id, 'card-00000001')),
    cardUpserts: [cardFixture('card-00000001')],
  }))
  await push(env, makeDelta({ activityDeletes: ['ev-00000001', 'ev-00000002', 'ev-00000003'] }), { baseRevision: 1 })
  const page1 = await pull(env, '?since=1&until=2&limit=2')
  assert.equal(page1.json.tombstones.length, 2)
  assert.equal(page1.json.hasMore, true)
  const page2 = await pull(env, `?since=1&until=2&limit=2&cursor=${encodeURIComponent(page1.json.cursor)}`)
  assert.equal(page2.json.tombstones.length, 1)
  assert.equal(page2.json.hasMore, false)
  const ids = [...page1.json.tombstones, ...page2.json.tombstones].map(row => row.entityId)
  assert.deepEqual(ids.sort(), ['ev-00000001', 'ev-00000002', 'ev-00000003'])
})

it('非法游标 → 400 BAD_REQUEST', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const result = await pull(env, '?since=0&cursor=not-a-cursor')
  assertError(result, 400, 'BAD_REQUEST')
})

it('pull 全程只读：不改变 revision / 镜像内容', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const before = sqlOne(env, 'SELECT revision, last_push_id, updated_at FROM sync_meta WHERE id = 1')
  const pull1 = await pull(env, '?since=0')
  const pull2 = await pull(env, '?since=0')
  assert.deepEqual(pull1.json.cards, pull2.json.cards)
  assert.equal(pull1.json.revision, pull2.json.revision)
  const after = sqlOne(env, 'SELECT revision, last_push_id, updated_at FROM sync_meta WHERE id = 1')
  assert.equal(Number(after.revision), Number(before.revision))
  assert.equal(String(after.last_push_id), String(before.last_push_id))
  assert.equal(Number(after.updated_at), Number(before.updated_at))
})

it('pull 返回的是脱敏镜像对象（payload 原样还原，缺失字段不补造）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const card = cardFixture('card-mirror', {
    labels: ['云', 'C2'],
    progress: { step: 1, total: 3, percent: 33, text: '写 Worker' },
    agent: { name: 'DSH', id: 'agent-hidden' },
  })
  await push(env, makeDelta({ cardUpserts: [card] }))
  const result = await pull(env, '?since=0')
  const mirrored = result.json.cards[0]
  assert.deepEqual(mirrored, toCloudCard(card))
  assert.equal(Object.hasOwn(mirrored, 'agent'), true)
  assert.equal(Object.hasOwn(mirrored.agent, 'id'), false)
  assert.equal(Object.hasOwn(mirrored, 'summary'), false)
})

// ===========================================================================
// 四、ingress：GitHub / 飞书 / 钉钉 / generic 验签与去重
// ===========================================================================

it('GitHub ingress：合法签名 → 202，落库原始体 + 白名单头（敏感头不落库）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const body = { action: 'opened', issue: { number: 42 } }
  const result = await githubIngress(env, body, {
    delivery: 'delivery-42',
    event: 'issues',
    headers: { authorization: 'Bearer must-not-be-stored', cookie: 'session=secret' },
  })
  assert.equal(result.status, 202)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.provider, 'github')
  assert.equal(result.json.duplicate, false)
  assert.match(String(result.json.id), /^in-[0-9a-f]{16}$/)
  assert.equal(result.json.seq, 1)

  const row = sqlOne(env, 'SELECT * FROM ingress_inbox WHERE id = ?', result.json.id)
  assert.equal(row.provider, 'github')
  assert.equal(row.event_type, 'issues')
  assert.equal(row.delivery_id, 'delivery-42')
  assert.equal(row.payload, JSON.stringify(body))
  assert.equal(Number(row.payload_bytes), Buffer.byteLength(JSON.stringify(body)))
  assert.equal(row.status, 'pending')
  assert.equal(Number(row.attempts), 0)
  assert.equal(Number(row.max_attempts), CLOUD_SYNC_LIMITS.ingressMaxAttempts)
  assert.equal(Number(row.expires_at), NOW + CLOUD_SYNC_LIMITS.ingressTtlMs)
  const storedHeaders = JSON.parse(row.headers)
  assert.equal(storedHeaders['x-github-event'], 'issues')
  assert.equal(storedHeaders['x-github-delivery'], 'delivery-42')
  assert.equal(Object.hasOwn(storedHeaders, 'authorization'), false)
  assert.equal(Object.hasOwn(storedHeaders, 'cookie'), false)
  assert.equal(Object.hasOwn(storedHeaders, 'x-hub-signature-256'), false)
})

it('GitHub ingress：签名错误/缺失 → 403，且不入队', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const bad = await githubIngress(env, { action: 'opened' }, {
    delivery: 'delivery-bad',
    signature: hmacGithub('tampered-body'),
  })
  assertError(bad, 403, 'FORBIDDEN')
  const missing = await githubIngress(env, { action: 'opened' }, { delivery: 'delivery-missing', signature: '' })
  assertError(missing, 403, 'FORBIDDEN')
  assert.equal(rowCount(env, 'ingress_inbox'), 0)
})

it('GitHub ingress：未配置 secret → fail-closed 503', async t => {
  const env = makeEnv({ GITHUB_WEBHOOK_SECRET: undefined })
  t.after(() => env.DB.close())
  const result = await githubIngress(env, { zen: 'hi' }, { delivery: 'delivery-nosecret' })
  assertError(result, 503, 'UNAVAILABLE')
  assert.equal(rowCount(env, 'ingress_inbox'), 0)
})

it('GitHub ingress 去重：同一 X-GitHub-Delivery 重投只入队一次（duplicate=true 且幂等 id）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const first = await githubIngress(env, { action: 'opened' }, { delivery: 'delivery-dup' })
  const second = await githubIngress(env, { action: 'edited' }, { delivery: 'delivery-dup' })
  assert.equal(first.status, 202)
  assert.equal(second.status, 202)
  assert.equal(second.json.duplicate, true)
  assert.equal(second.json.id, first.json.id)
  assert.equal(second.json.seq, first.json.seq)
  assert.equal(rowCount(env, 'ingress_inbox'), 1)
  const row = sqlOne(env, 'SELECT payload FROM ingress_inbox WHERE id = ?', first.json.id)
  assert.equal(row.payload, JSON.stringify({ action: 'opened' }), '重复投递不得覆盖首条 payload')
})

it('飞书 URL 验证：challenge 秒回且不落库（顶层 challenge 字段，无 ok 信封）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const result = await feishuIngress(env, { type: 'url_verification', challenge: 'challenge-abc', token: FEISHU_TOKEN })
  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { challenge: 'challenge-abc' })
  assert.equal(rowCount(env, 'ingress_inbox'), 0)
})

it('飞书 URL 验证：token 错误 → 403；未配置校验 token → 503', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const wrong = await feishuIngress(env, { type: 'url_verification', challenge: 'x', token: 'wrong' })
  assertError(wrong, 403, 'FORBIDDEN')
  const unconfigured = makeEnv({ FEISHU_VERIFICATION_TOKEN: undefined })
  t.after(() => unconfigured.DB.close())
  const unavailable = await feishuIngress(unconfigured, { type: 'url_verification', challenge: 'x', token: 'any' })
  assertError(unavailable, 503, 'UNAVAILABLE')
})

it('飞书事件：token 校验通过 → 202；token 错误 → 403；加密事件 → 415', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const ok = await feishuIngress(env, {
    token: FEISHU_TOKEN,
    event: { type: 'im.message.receive_v1' },
  }, { headers: { 'x-request-id': 'feishu-req-1' } })
  assert.equal(ok.status, 202)
  const row = sqlOne(env, 'SELECT provider, event_type, delivery_id FROM ingress_inbox WHERE id = ?', ok.json.id)
  assert.equal(row.provider, 'feishu')
  assert.equal(row.event_type, 'im.message.receive_v1')
  assert.equal(row.delivery_id, 'feishu-req-1')

  const bad = await feishuIngress(env, { token: 'wrong', event: { type: 'x' } })
  assertError(bad, 403, 'FORBIDDEN')

  const encrypted = await feishuIngress(env, { encrypt: 'cipher-text' })
  assertError(encrypted, 415, 'UNSUPPORTED_MEDIA_TYPE')
})

it('飞书事件 v2（header.token / header.event_id）同样识别与去重', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const body = {
    header: { token: FEISHU_TOKEN, event_id: 'evt-2', event_type: 'im.message.receive_v1' },
    event: {},
  }
  const first = await feishuIngress(env, body)
  const second = await feishuIngress(env, body)
  assert.equal(first.status, 202)
  assert.equal(second.status, 202)
  assert.equal(second.json.duplicate, true)
  assert.equal(second.json.id, first.json.id)
  const row = sqlOne(env, 'SELECT delivery_id, event_type FROM ingress_inbox WHERE id = ?', first.json.id)
  assert.equal(row.delivery_id, 'evt-2')
  assert.equal(row.event_type, 'im.message.receive_v1', '飞书 v2 header.event_type 应入库')
})

it('飞书签名模式（FEISHU_ENCRYPT_KEY）：X-Lark-Signature 校验', async t => {
  const env = makeEnv({ FEISHU_VERIFICATION_TOKEN: undefined, FEISHU_ENCRYPT_KEY: FEISHU_ENCRYPT_KEY })
  t.after(() => env.DB.close())
  const body = { event: { type: 'im.message.receive_v1' } }
  const raw = JSON.stringify(body)
  const timestamp = '1790000000'
  const nonce = 'nonce-1'
  const signature = createHash('sha256').update(`${timestamp}${nonce}${FEISHU_ENCRYPT_KEY}${raw}`).digest('hex')
  const ok = await feishuIngress(env, body, {
    headers: {
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature,
    },
  })
  assert.equal(ok.status, 202)
  const tampered = await feishuIngress(env, body, {
    headers: {
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': 'deadbeef',
    },
  })
  assertError(tampered, 403, 'FORBIDDEN')
  const missing = await feishuIngress(env, body)
  assertError(missing, 403, 'FORBIDDEN')
  // 时间戳过期（±1h 防重放）
  const staleTimestamp = String(Math.floor((NOW - 2 * 60 * 60 * 1000) / 1000))
  const staleSignature = createHash('sha256').update(`${staleTimestamp}${nonce}${FEISHU_ENCRYPT_KEY}${raw}`).digest('hex')
  const stale = await feishuIngress(env, body, {
    headers: {
      'x-lark-request-timestamp': staleTimestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': staleSignature,
    },
  })
  assertError(stale, 403, 'FORBIDDEN')
})

it('钉钉加签：合法 timestamp/sign → 202；签名错误/缺头/超时间窗口 → 403', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const ok = await dingtalkIngress(env, { event: { type: 'chat_update' } })
  assert.equal(ok.status, 202)
  assert.equal(ok.json.provider, 'dingtalk')

  const badSign = await dingtalkIngress(env, { event: { type: 'x' } }, { sign: 'invalid-sign' })
  assertError(badSign, 403, 'FORBIDDEN')

  const missing = await call(env, '/v1/ingress/dingtalk', {
    method: 'POST', token: null,
    headers: { 'content-type': 'application/json' },
    rawBody: JSON.stringify({ event: { type: 'x' } }),
  })
  assertError(missing, 403, 'FORBIDDEN')

  const stale = await dingtalkIngress(env, { event: { type: 'x' } }, { timestampMs: NOW - 2 * HOUR })
  assertError(stale, 403, 'FORBIDDEN')
})

it('钉钉 access_token 模式（未配加签 secret 时按 body.token 校验）', async t => {
  const env = makeEnv({ DINGTALK_SIGN_SECRET: undefined, DINGTALK_ACCESS_TOKEN: DINGTALK_ACCESS_TOKEN })
  t.after(() => env.DB.close())
  const ok = await call(env, '/v1/ingress/dingtalk', {
    method: 'POST', token: null,
    headers: { 'content-type': 'application/json' },
    rawBody: JSON.stringify({ token: DINGTALK_ACCESS_TOKEN, event: { type: 'x' } }),
  })
  assert.equal(ok.status, 202)
  const bad = await call(env, '/v1/ingress/dingtalk', {
    method: 'POST', token: null,
    headers: { 'content-type': 'application/json' },
    rawBody: JSON.stringify({ token: 'wrong-token', event: { type: 'x' } }),
  })
  assertError(bad, 403, 'FORBIDDEN')
})

it('generic 来源：自定义头或 Bearer 共享 token 均可；错误/未配置 fail-closed', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const viaHeader = await genericIngress(env, { type: 'quick_button', action: 'approve' })
  assert.equal(viaHeader.status, 202)
  const viaBearer = await call(env, '/v1/ingress/generic', {
    method: 'POST', token: null,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GENERIC_TOKEN}` },
    rawBody: JSON.stringify({ type: 'quick_button', action: 'reject' }),
  })
  assert.equal(viaBearer.status, 202)
  const wrong = await genericIngress(env, { type: 'x' }, { token: 'wrong' })
  assertError(wrong, 403, 'FORBIDDEN')
  const unconfigured = makeEnv({ INGRESS_GENERIC_TOKEN: undefined })
  t.after(() => unconfigured.DB.close())
  const noSecret = await genericIngress(unconfigured, { type: 'x' })
  assertError(noSecret, 503, 'UNAVAILABLE')
})

it('未支持的 provider → 400；非法 JSON / JSON 数组 / 空体 → 415', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const unsupported = await call(env, '/v1/ingress/telegram', {
    method: 'POST', token: null,
    headers: { 'content-type': 'application/json', 'x-kanban-ingress-token': GENERIC_TOKEN },
    rawBody: '{}',
  })
  assertError(unsupported, 400, 'BAD_REQUEST')

  for (const rawBody of ['not-json', '[1,2,3]', '', '"just-a-string"']) {
    const result = await call(env, '/v1/ingress/generic', {
      method: 'POST', token: null,
      headers: { 'content-type': 'application/json', 'x-kanban-ingress-token': GENERIC_TOKEN },
      rawBody,
    })
    assertError(result, 415, 'UNSUPPORTED_MEDIA_TYPE')
  }
  assert.equal(rowCount(env, 'ingress_inbox'), 0)
})

it('入站请求体超过 128 KiB → 413，且不入队', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const raw = JSON.stringify({ type: 'huge', blob: 'x'.repeat(129 * 1024) })
  const result = await call(env, '/v1/ingress/generic', {
    method: 'POST', token: null,
    headers: { 'content-type': 'application/json', 'x-kanban-ingress-token': GENERIC_TOKEN },
    rawBody: raw,
  })
  assertError(result, 413, 'PAYLOAD_TOO_LARGE')
  assert.equal(rowCount(env, 'ingress_inbox'), 0)
})

it('generic 系不把 x-request-id 当投递 id：同头不同体必须各自入队（防静默丢弃）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const first = await genericIngress(env, { type: 'event-a' }, { headers: { 'x-request-id': 'trace-reused-1' } })
  const second = await genericIngress(env, { type: 'event-b' }, { headers: { 'x-request-id': 'trace-reused-1' } })
  assert.equal(first.status, 202)
  assert.equal(second.status, 202)
  assert.equal(second.json.duplicate, false, '不同事件体不得被 x-request-id 误判重')
  assert.notEqual(second.json.id, first.json.id)
  assert.equal(rowCount(env, 'ingress_inbox'), 2)

  // 飞书仍以 x-request-id 作为投递 id 去重（第一方来源语义）
  const feishuA = await feishuIngress(env, { token: FEISHU_TOKEN, event: { type: 'a' } }, {
    headers: { 'x-request-id': 'feishu-delivery-1' },
  })
  const feishuB = await feishuIngress(env, { token: FEISHU_TOKEN, event: { type: 'b' } }, {
    headers: { 'x-request-id': 'feishu-delivery-1' },
  })
  assert.equal(feishuA.status, 202)
  assert.equal(feishuB.json.duplicate, true)
  assert.equal(feishuB.json.id, feishuA.json.id)
})

it('无投递 id 时按「provider + 事件类型 + 原始体」哈希去重（同体重投 = duplicate）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const first = await genericIngress(env, { type: 'ping', at: 1 })
  const second = await genericIngress(env, { type: 'ping', at: 1 })
  const different = await genericIngress(env, { type: 'ping', at: 2 })
  assert.equal(first.status, 202)
  assert.equal(second.json.duplicate, true)
  assert.equal(second.json.id, first.json.id)
  assert.notEqual(different.json.id, first.json.id)
  assert.equal(rowCount(env, 'ingress_inbox'), 2)
})

// ===========================================================================
// 五、inbox claim / ack：租约、退避、dead、幂等
// ===========================================================================

it('claim 空队列返回 items=[]；limit/leaseSeconds 越界被夹紧', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const empty = await claim(env, { limit: 999, leaseSeconds: 99999 })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.items, [])
  assert.equal(empty.json.limit, CLOUD_SYNC_LIMITS.ingressBatch)
  assert.equal(empty.json.leaseSeconds, 900)

  await genericIngress(env, { type: 'clamp-1' })
  const clamped = await claim(env, { limit: 0, leaseSeconds: 1 })
  assert.equal(clamped.json.limit, 1)
  assert.equal(clamped.json.leaseSeconds, 30)
  assert.equal(clamped.json.items.length, 1)
  const row = sqlOne(env, 'SELECT lease_expires_at FROM ingress_inbox WHERE id = ?', clamped.json.items[0].id)
  assert.equal(Number(row.lease_expires_at), NOW + 30_000)
})

it('claim 按 seq 升序、写租约、同租约内不重复下发；ack 后不再回放', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  for (const index of [1, 2, 3]) await genericIngress(env, { type: 'ordered', index })
  const first = await claim(env, { limit: 2 })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json.items.map(item => item.seq), [1, 2])
  assert.ok(first.json.items.every(item => /^lease-/.test(item.leaseToken)))
  assert.ok(first.json.items.every(item => item.leaseExpiresAt === NOW + 120_000))

  const second = await claim(env, { limit: 2 })
  assert.deepEqual(second.json.items.map(item => item.seq), [3], '已租出的条目不得重复下发')

  const ackResult = await ack(env, first.json.items.map(item => ({ id: item.id, outcome: 'acked' })))
  assert.equal(ackResult.status, 200)
  assert.deepEqual(ackResult.json.acked.sort(), first.json.items.map(item => item.id).sort())
  for (const item of first.json.items) {
    const row = sqlOne(env, 'SELECT status, acked_at, lease_token FROM ingress_inbox WHERE id = ?', item.id)
    assert.equal(row.status, 'acked')
    assert.equal(Number(row.acked_at), NOW)
    assert.equal(row.lease_token, null)
  }
  // 第三件也消费掉后队列应彻底清空
  const third = await ack(env, [{ id: second.json.items[0].id, outcome: 'acked' }])
  assert.deepEqual(third.json.acked, [second.json.items[0].id])
  assert.deepEqual((await claim(env, { limit: 20 })).json.items, [])
})

it('租约到期后条目自动可被重新 claim（模拟本地崩溃/断网，attempts 不增加）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await genericIngress(env, { type: 'crash-recovery' })
  const first = await claim(env, { limit: 1, leaseSeconds: 60 })
  assert.equal(first.json.items.length, 1)
  const sameLease = await claim(env, { limit: 1, leaseSeconds: 60, now: NOW + 59_000 })
  assert.deepEqual(sameLease.json.items, [], '租约未到期不得重新下发')
  const afterExpiry = await claim(env, { limit: 1, leaseSeconds: 60, now: NOW + 61_000 })
  assert.equal(afterExpiry.json.items.length, 1)
  assert.equal(afterExpiry.json.items[0].id, first.json.items[0].id)
  assert.notEqual(afterExpiry.json.items[0].leaseToken, first.json.items[0].leaseToken, '重新领取应换新租约')
  assert.equal(afterExpiry.json.items[0].attempts, 0, 'claim 本身不增加 attempts')
})

it('ack retry：attempts+1、指数退避重排、退避期内不重发、到期后重发', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await genericIngress(env, { type: 'retry-me' })
  const claimed = await claim(env, { limit: 1 })
  const id = claimed.json.items[0].id
  const retry = await ack(env, [{ id, outcome: 'retry', error: '本地 502' }])
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.json.retried, [id])

  const row = sqlOne(env, 'SELECT status, attempts, next_attempt_at, last_error FROM ingress_inbox WHERE id = ?', id)
  assert.equal(row.status, 'pending')
  assert.equal(Number(row.attempts), 1)
  assert.equal(Number(row.next_attempt_at), NOW + 2_000)
  assert.equal(row.last_error, '本地 502')

  assert.deepEqual((await claim(env, { limit: 1 })).json.items, [], '退避未到期前不应重发')
  const again = await claim(env, { limit: 1, now: NOW + 2_000 })
  assert.equal(again.json.items.length, 1)
  assert.equal(again.json.items[0].id, id)
})

it('ack retry 达到 max_attempts → 置 dead（不再回放）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await genericIngress(env, { type: 'dead-by-attempts' })
  const claimed = await claim(env, { limit: 1 })
  const id = claimed.json.items[0].id
  env.DB.exec(`UPDATE ingress_inbox SET attempts = 19, max_attempts = 20 WHERE id = '${id}'`)
  const retry = await ack(env, [{ id, outcome: 'retry', error: '最后一次' }])
  assert.deepEqual(retry.json.dead, [id])
  const row = sqlOne(env, 'SELECT status, attempts FROM ingress_inbox WHERE id = ?', id)
  assert.equal(row.status, 'dead')
  assert.equal(Number(row.attempts), 20)
  assert.deepEqual((await claim(env, { limit: 5, now: NOW + DAY })).json.items, [], 'dead 条目永不回放')
})

it('ack 终态守卫：dead 不可被迟到 ACK 复活；重复 ack 不报错且计入 ignored', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await genericIngress(env, { type: 'dead-explicit' })
  const claimed = await claim(env, { limit: 1 })
  const id = claimed.json.items[0].id
  const dead = await ack(env, [{ id, outcome: 'dead', error: '载荷不合法（本地 400）' }])
  assert.deepEqual(dead.json.dead, [id])
  assert.equal(sqlOne(env, 'SELECT status FROM ingress_inbox WHERE id = ?', id).status, 'dead')

  // 迟到的 acked/retry 不得把 dead 复活（契约 §8.6 没有「复活」边）
  const repeatAck = await ack(env, [{ id, outcome: 'acked' }])
  assert.deepEqual(repeatAck.json.ignored, [id])
  assert.deepEqual(repeatAck.json.acked, [])
  assert.equal(sqlOne(env, 'SELECT status FROM ingress_inbox WHERE id = ?', id).status, 'dead')
  const repeatRetry = await ack(env, [{ id, outcome: 'retry' }])
  assert.deepEqual(repeatRetry.json.ignored, [id])
  assert.equal(sqlOne(env, 'SELECT status FROM ingress_inbox WHERE id = ?', id).status, 'dead')
  assert.deepEqual((await claim(env, { limit: 5, now: NOW + DAY })).json.items, [], 'dead 永不回放')

  // 已 acked 的迟到 retry 同样不得复活
  await genericIngress(env, { type: 'acked-explicit' })
  const claimed2 = await claim(env, { limit: 1 })
  const id2 = claimed2.json.items[0].id
  await ack(env, [{ id: id2, outcome: 'acked' }])
  const lateRetry = await ack(env, [{ id: id2, outcome: 'retry' }])
  assert.deepEqual(lateRetry.json.ignored, [id2])
  assert.equal(sqlOne(env, 'SELECT status FROM ingress_inbox WHERE id = ?', id2).status, 'acked')
})

it('ack 可选租约守卫：带回错误 leaseToken 被忽略，正确 leaseToken 正常 acked', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await genericIngress(env, { type: 'lease-guard' })
  const claimed = await claim(env, { limit: 1 })
  const item = claimed.json.items[0]
  const wrong = await ack(env, [{ id: item.id, outcome: 'acked', leaseToken: 'lease-wrong-token' }])
  assert.deepEqual(wrong.json.ignored, [item.id])
  assert.equal(sqlOne(env, 'SELECT status FROM ingress_inbox WHERE id = ?', item.id).status, 'leased')
  const ok = await ack(env, [{ id: item.id, outcome: 'acked', leaseToken: item.leaseToken }])
  assert.deepEqual(ok.json.acked, [item.id])
  assert.equal(sqlOne(env, 'SELECT status FROM ingress_inbox WHERE id = ?', item.id).status, 'acked')
})

it('ack 未知 id → missing；非法 outcome / results 非数组 / id 为空 → 400', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const missing = await ack(env, [{ id: 'in-not-exists', outcome: 'acked' }])
  assert.equal(missing.status, 200)
  assert.deepEqual(missing.json.missing, ['in-not-exists'])

  const badOutcome = await ack(env, [{ id: 'in-x', outcome: 'explode' }])
  assertError(badOutcome, 400, 'BAD_REQUEST')
  const notArray = await call(env, '/v1/inbox/ack', {
    method: 'POST', body: { consumerId: 'c2', results: 'nope' },
  })
  assertError(notArray, 400, 'BAD_REQUEST')
  const emptyId = await ack(env, [{ id: '', outcome: 'acked' }])
  assertError(emptyId, 400, 'BAD_REQUEST')
})

// ===========================================================================
// 六、零丢失回放 / 端到端 / Cron 清理
// ===========================================================================

it('休眠期零丢失：多种来源积压 → 唤醒后分批 claim+ack 全部消费且顺序稳定', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())

  // Mac 合盖休眠：Worker 24x7 接收，本地不 claim
  const enqueued = []
  for (let index = 1; index <= 4; index += 1) {
    const result = await githubIngress(env, { action: 'opened', number: index }, { delivery: `delivery-sleep-${index}` })
    assert.equal(result.status, 202)
    enqueued.push(result.json.id)
  }
  for (let index = 1; index <= 2; index += 1) {
    const result = await dingtalkIngress(env, { event: { type: 'approval_instance', index } })
    assert.equal(result.status, 202)
    enqueued.push(result.json.id)
  }
  for (let index = 1; index <= 2; index += 1) {
    const result = await genericIngress(env, { type: 'quick_button', index })
    assert.equal(result.status, 202)
    enqueued.push(result.json.id)
  }
  // Webhook 重投（同一 GitHub delivery）不得产生重复事件
  const duplicate = await githubIngress(env, { action: 'opened', number: 1 }, { delivery: 'delivery-sleep-1' })
  assert.equal(duplicate.json.duplicate, true)
  assert.equal(rowCount(env, 'ingress_inbox'), enqueued.length)

  // 唤醒后：循环 claim（batch=3）→ 模拟本地回放成功 → ack
  const consumed = []
  let rounds = 0
  for (;;) {
    rounds += 1
    assert.ok(rounds <= 10, 'claim 循环不应死循环')
    const claimed = await claim(env, { limit: 3 })
    if (claimed.json.items.length === 0) break
    const seqs = claimed.json.items.map(item => item.seq)
    assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right), '同一批内按 seq 升序')
    for (const item of claimed.json.items) {
      assert.ok(item.payload.length > 0, '回放的原始 payload 必须非空')
      consumed.push(item.id)
    }
    const acked = await ack(env, claimed.json.items.map(item => ({ id: item.id, outcome: 'acked' })))
    assert.equal(acked.status, 200)
  }
  assert.deepEqual(consumed.sort(), [...enqueued].sort(), '零丢失：入队集合 = 消费集合')
  assert.equal(rowCount(env, 'ingress_inbox', "WHERE status IN ('pending', 'leased')"), 0)
  assert.equal(rowCount(env, 'ingress_inbox', "WHERE status = 'acked'"), enqueued.length)
})

it('端到端（C1 协议层 + C2 Worker）：本地快照 → push → pull 还原镜像一致', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())

  const localStore = {
    meta: { revision: 1 },
    boards: [{
      id: 'board-default',
      name: '主看板',
      description: '本地权威',
      cardOrder: { backlog: ['card-00000002'], running: ['card-00000001'] },
      createdAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
    }],
    cards: [{
      id: 'card-00000001',
      boardId: 'board-default',
      title: '写 Worker',
      summary: '基于 C1 协议',
      status: 'running',
      priority: 'high',
      version: 4,
      labels: ['cloud'],
      createdAt: NOW - 9_000,
      updatedAt: NOW - 1_000,
      cwd: '/Users/alice/workspace/dsh-kanban',
      workspaceId: 'ws-local',
      sessionIds: ['session-local'],
    }, {
      id: 'card-00000002',
      boardId: 'board-default',
      title: '待办卡',
      status: 'backlog',
      version: 1,
      createdAt: NOW - 8_000,
      updatedAt: NOW - 2_000,
    }],
    activities: [{
      id: 'ev-00000001',
      cardId: 'card-00000001',
      type: 'progress',
      actor: { kind: 'agent', name: 'DSH', id: 'actor-local' },
      text: '开始实现',
      at: NOW - 3_000,
      data: { sessionId: 'session-local', cwd: '/Users/alice/workspace/dsh-kanban/proj' },
    }],
  }

  let mirror = emptyCloudSnapshot()
  let snapshot = toCloudSnapshot(localStore)
  let delta = diffCloudSnapshots(mirror, snapshot)
  const firstPushId = hashPushId({ clientId: 'c2-e2e', baseRevision: 0, delta })
  const pushed = await push(env, delta, { clientId: 'c2-e2e', pushId: firstPushId, baseRevision: 0 })
  assert.equal(pushed.json.status, 'applied')
  assert.equal(pushed.json.revision, 1)

  // 拉回镜像（模拟 C3 冷启动/灾备核对）：pull → pullResponseToDelta → apply
  const pulled = await pull(env, '?since=0')
  assert.equal(pulled.status, 200)
  assert.equal(pulled.json.revision, 1)
  const deltaFromPull = pullResponseToDelta(pulled.json)
  // 先喂给「假云端」镜像核对 C1 协议层与 C2 返回格式完全兼容
  mirror = applyDeltaToCloudSnapshot(mirror, deltaFromPull, { revision: pulled.json.revision })
  assert.equal(mirror.boards.length, snapshot.boards.length)
  assert.equal(mirror.cards.length, snapshot.cards.length)
  assert.equal(mirror.activities.length, snapshot.activities.length)
  assert.equal(mirror.revision, 1)

  // 本地再改一次 → 第二次增量 push（C3 的常规路径）
  localStore.cards[1].status = 'done'
  localStore.cards[1].version = 2
  localStore.cards[1].completedAt = NOW - 500
  localStore.meta.revision = 2
  snapshot = toCloudSnapshot(localStore)
  delta = diffCloudSnapshots(mirror, snapshot)
  assert.equal(delta.cards.upserts.length, 1)
  assert.equal(delta.cards.upserts[0].id, 'card-00000002')
  const secondPushId = hashPushId({ clientId: 'c2-e2e', baseRevision: 1, delta })
  const pushed2 = await push(env, delta, { clientId: 'c2-e2e', pushId: secondPushId, baseRevision: 1 })
  assert.equal(pushed2.json.status, 'applied')
  assert.equal(pushed2.json.revision, 2)

  const window = await pull(env, '?since=1&until=2')
  assert.equal(window.json.cards.length, 1)
  assert.equal(window.json.cards[0].id, 'card-00000002')
  assert.equal(window.json.cards[0].status, 'done')
  // 执行面字段绝不上云
  assert.equal(Object.hasOwn(window.json.cards[0], 'cwd'), false)
  assert.equal(Object.hasOwn(window.json.activities ?? {}, 'data'), false)
})

it('M1：ACK 单次 101 条（>100 绑定参数）分块回查后全部置 acked', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const ids = []
  for (let index = 1; index <= 101; index += 1) {
    const result = await genericIngress(env, { type: 'batch-ack', index })
    assert.equal(result.status, 202)
    ids.push(result.json.id)
  }
  const result = await ack(env, ids.map(id => ({ id, outcome: 'acked' })))
  assert.equal(result.status, 200)
  assert.equal(result.json.acked.length, 101)
  assert.equal(rowCount(env, 'ingress_inbox', "WHERE status = 'acked'"), 101)
})

it('claim/ack/错误响应统一携带 protocolVersion，所有响应带 x-request-id 头', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await genericIngress(env, { type: 'version-check' })
  const claimResult = await claim(env, { limit: 1 })
  assert.equal(claimResult.json.protocolVersion, CLOUD_PROTOCOL_VERSION)
  const id = claimResult.json.items[0].id
  const ackResult = await ack(env, [{ id, outcome: 'acked' }])
  assert.equal(ackResult.json.protocolVersion, CLOUD_PROTOCOL_VERSION)
  const errorResult = await pull(env, '?since=999')
  assert.equal(errorResult.status, 400)
  assert.equal(errorResult.json.protocolVersion, CLOUD_PROTOCOL_VERSION)
  for (const response of [claimResult, ackResult, errorResult]) {
    assert.match(String(response.headers.get('x-request-id')), /^req-/)
  }
})

it('非法游标（缺少实体类别前缀）→ 400', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  await pushSeed(env)
  const forged = encodeSyncCursor({ revision: 1, id: 'card-x' })
  const result = await pull(env, `?since=0&cursor=${encodeURIComponent(forged)}`)
  assertError(result, 400, 'BAD_REQUEST')
})

it('Cron 清理：过期 acked / 过期入站 / 旧 outbox / 90 天前时间线 / 旧墓碑被清，新数据保留', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())

  // 1) 入站：acked 超 7 天、过期未消费、新鲜 pending、新鲜 acked
  const oldAcked = await genericIngress(env, { type: 'old-acked' })
  await ack(env, [{ id: oldAcked.json.id, outcome: 'acked' }], { now: NOW - 8 * DAY })
  const expired = await genericIngress(env, { type: 'expired' }, { now: NOW - 8 * DAY })
  assert.equal(expired.status, 202)
  const freshPending = await genericIngress(env, { type: 'fresh-pending' })
  const freshAcked = await genericIngress(env, { type: 'fresh-acked' })
  await ack(env, [{ id: freshAcked.json.id, outcome: 'acked' }], { now: NOW })

  // 2) 时间线：91 天前 vs 新鲜（push 会写 activities.at）
  await push(env, makeDelta({
    activityUpserts: [
      activityFixture('ev-old', 'card-00000001', { at: NOW - 91 * DAY }),
      activityFixture('ev-fresh', 'card-00000001', { at: NOW - DAY }),
    ],
  }))
  // 3) 墓碑：只保留最近 2000 revision 窗口
  env.DB.exec('UPDATE sync_meta SET revision = 2500 WHERE id = 1')
  env.DB.exec(`INSERT INTO tombstones (entity, entity_id, revision) VALUES ('card', 'card-old', 500), ('card', 'card-newer', 501)`)
  // 4) outbox：delivered 超 3 天 vs 新鲜
  env.DB.exec(`INSERT INTO outbox (idempotency_key, kind, payload, state, created_at, updated_at) VALUES
    ('k-old', 'state_changed', '{}', 'delivered', 1, ${NOW - 4 * DAY}),
    ('k-fresh', 'state_changed', '{}', 'delivered', 1, ${NOW})`)

  const result = await runCleanup(env, { now: NOW })
  assert.deepEqual(result.deleted, {
    ingressAcked: 1,
    ingressExpired: 1,
    outbox: 1,
    tombstones: 1,
    activities: 1,
  })
  assert.equal(rowCount(env, 'ingress_inbox'), 2)
  assert.deepEqual(
    sqlAll(env, 'SELECT id FROM ingress_inbox ORDER BY seq').map(row => String(row.id)).length,
    2,
  )
  assert.equal(rowCount(env, 'activities'), 1)
  assert.equal(sqlOne(env, 'SELECT id FROM activities').id, 'ev-fresh')
  assert.equal(rowCount(env, 'tombstones'), 1)
  assert.equal(sqlOne(env, 'SELECT entity_id FROM tombstones').entity_id, 'card-newer')
  assert.equal(rowCount(env, 'outbox'), 1)
  assert.equal(sqlOne(env, 'SELECT idempotency_key FROM outbox').idempotency_key, 'k-fresh')
})

it('Cron 清理在空库上幂等（全 0，不报错）', async t => {
  const env = makeEnv()
  t.after(() => env.DB.close())
  const result = await runCleanup(env, { now: NOW })
  assert.deepEqual(result.deleted, {
    ingressAcked: 0,
    ingressExpired: 0,
    outbox: 0,
    tombstones: 0,
    activities: 0,
  })
  const again = await runCleanup(env, { now: NOW })
  assert.deepEqual(again.deleted, result.deleted)
})
