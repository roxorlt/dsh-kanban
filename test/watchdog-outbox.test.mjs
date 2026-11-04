// Super-Agent Runtime Batch 1：Transactional Outbox + Watchdog 状态机与五大形式化不变量故障注入测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ackOutbox,
  batchSessionArchivePlan,
  createCard,
  createSeed,
  enqueueOutbox,
  ensureCardRuntime,
  evaluateWatchdog,
  getSuperAgentSessionId,
  leaseOutbox,
  linkSession,
  moveCard,
  normalizeStore,
  patchCard,
  recordSessionTurnWatermark,
  requestApproval,
  sessionArchivePlan,
  setSuperAgentSessionId,
} from '../lib/domain.js'
import {
  classifySuperAgentIntent,
  formatImNotification,
  handleIngressEvent,
  signDingtalkWebhook,
  signFeishuWebhook,
} from '../lib/im-gateway.js'
import { handleMcpJsonRpc } from '../lib/mcp-server.js'
import { sendWebhookNotification } from '../lib/im-notifier.js'
import { createCc2imBridge } from '../lib/cc2im-bridge.js'
import { createStore } from '../lib/store.js'
import { createWatchdog } from '../lib/watchdog.js'
import { createSessionTurnSync } from '../lib/session-sync.js'
import { createTools } from '../lib/tools.js'
import { createRoutes } from '../lib/routes.js'
import net from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { tempDir } from './helpers.mjs'

function emptyDraft(now = 1_700_000_000_000) {
  return normalizeStore(createSeed('empty', now), now)
}

test('Invariant 1 (Idempotent Outbox Dispatch)：相同 idempotencyKey 严格幂等去重，租约超时可重领，ack 自动绑定新会话', () => {
  const t0 = 1_700_000_000_000
  const draft = emptyDraft(t0)
  const { card } = createCard(draft, {
    title: 'Outbox 幂等验证卡',
    status: 'running',
    cwd: '/tmp/outbox-demo',
  }, { now: t0 })

  const gen = ensureCardRuntime(card).generation
  const first = enqueueOutbox(draft, {
    idempotencyKey: `wake:${card.id}:gen:${gen}`,
    kind: 'wake',
    cardId: card.id,
    expectedGeneration: gen,
    target: { cwd: '/tmp/outbox-demo' },
    prompt: '唤醒执行任务',
  }, { now: t0 + 10 })
  assert.equal(first.enqueued, true)
  assert.equal(first.duplicate, false)
  assert.equal(draft.outbox.length, 1)

  // 重复入队同一 idempotencyKey：返回已有条目，队列长度保持 1
  const duplicate = enqueueOutbox(draft, {
    idempotencyKey: `wake:${card.id}:gen:${gen}`,
    kind: 'wake',
    cardId: card.id,
    expectedGeneration: gen,
    target: { cwd: '/tmp/outbox-demo' },
    prompt: '重复入队不应新增',
  }, { now: t0 + 20 })
  assert.equal(duplicate.enqueued, false)
  assert.equal(duplicate.duplicate, true)
  assert.equal(draft.outbox.length, 1)

  // 第一次 lease：拿到 1 条 leased
  const lease1 = leaseOutbox(draft, { limit: 5, leaseMs: 30_000, now: t0 + 100 })
  assert.equal(lease1.entries.length, 1)
  assert.equal(lease1.entries[0].status, 'leased')
  assert.equal(lease1.entries[0].attempts, 1)

  // 租约未过期前再次 lease：拿到 0 条（防多标签页/并发双发）
  const lease2 = leaseOutbox(draft, { limit: 5, leaseMs: 30_000, now: t0 + 5_000 })
  assert.equal(lease2.entries.length, 0)

  // 租约过期后再次 lease：可重新认领，attempts=2
  const lease3 = leaseOutbox(draft, { limit: 5, leaseMs: 30_000, now: t0 + 35_000 })
  assert.equal(lease3.entries.length, 1)
  assert.equal(lease3.entries[0].attempts, 2)

  // ACK 成功并回传新建的 sessionId：条目置 acked，卡片自动补绑主会话且不破坏当前 generation
  const acked = ackOutbox(draft, first.entry.seq, {
    ok: true,
    sessionId: 'session-created-by-outbox',
    now: t0 + 35_500,
  })
  assert.equal(acked.entry.status, 'acked')
  assert.deepEqual(card.sessionIds, ['session-created-by-outbox'])
  assert.equal(card.runtime.generation, gen)

  // 重复 ACK 幂等
  const ackedAgain = ackOutbox(draft, first.entry.seq, {
    ok: true,
    sessionId: 'session-created-by-outbox',
    now: t0 + 36_000,
  })
  assert.equal(ackedAgain.idempotent, true)
})

test('Invariant 2 (Bounded Termination on Silent Stall)：turn/end(completed) 未收口 -> 30s 内不催办 -> 满 30s 催办 1 次 -> 再停滞熔断到 blocked 且不再无限催办', () => {
  const t0 = 1_700_000_000_000
  const draft = emptyDraft(t0)
  const { card } = createCard(draft, {
    title: '静默停滞熔断测试卡',
    status: 'running',
    sessionId: 'session-stall-1',
  }, { now: t0 })
  patchCard(draft, card.id, {
    checklists: [
      { id: 'c1', text: '编写核心逻辑', done: true },
      { id: 'c2', text: '补充单测并收口', done: false },
    ],
  }, { now: t0 + 100 })

  // Turn 1 正常结束，但 Agent 忘了调 completeCard 或 requestApproval
  recordSessionTurnWatermark(draft, {
    sessionId: 'session-stall-1',
    turn: 1,
    phase: 'idle',
    at: t0 + 1_000,
  })

  // Grace 窗口内（+15s < 30s）：不产生任何催办
  const early = evaluateWatchdog(draft, { now: t0 + 16_000, graceMs: 30_000, maxNudges: 1 })
  assert.equal(early.nudged.length, 0)
  assert.equal(early.stalled.length, 0)
  assert.equal((draft.outbox || []).length, 0)

  // 超过 30s Grace（+32s）：触发第 1 次催办，nudgesUsed = 1，入队 1 条 nudge
  const nudgeTick = evaluateWatchdog(draft, { now: t0 + 32_000, graceMs: 30_000, maxNudges: 1 })
  assert.deepEqual(nudgeTick.nudged.map(item => item.id), [card.id])
  assert.equal(card.runtime.budget.nudgesUsed, 1)
  assert.equal(draft.outbox.length, 1)
  assert.equal(draft.outbox[0].kind, 'nudge')
  assert.match(draft.outbox[0].prompt, /补充单测并收口/)

  // 同一 turn=1 周期内后续 tick 绝不重复催办或提前熔断
  const sameTurnTick = evaluateWatchdog(draft, { now: t0 + 50_000, graceMs: 30_000, maxNudges: 1 })
  assert.equal(sameTurnTick.nudged.length, 0)
  assert.equal(sameTurnTick.stalled.length, 0)
  assert.equal(draft.outbox.length, 1)

  // Agent 被催办后跑了 Turn 2 并再次静默结束（仍未收口）
  recordSessionTurnWatermark(draft, {
    sessionId: 'session-stall-1',
    turn: 2,
    phase: 'running',
    at: t0 + 55_000,
  })
  recordSessionTurnWatermark(draft, {
    sessionId: 'session-stall-1',
    turn: 2,
    phase: 'idle',
    at: t0 + 60_000,
  })

  // Turn 2 结束满 30s（+91s）：因 nudgesUsed(1) >= maxNudges(1)，Watchdog 触发熔断降级到 blocked（待你确认列）
  const circuitBreakTick = evaluateWatchdog(draft, { now: t0 + 91_000, graceMs: 30_000, maxNudges: 1 })
  assert.deepEqual(circuitBreakTick.stalled.map(item => item.id), [card.id])
  assert.equal(card.status, 'blocked')
  assert.equal(draft.outbox.filter(item => item.kind === 'nudge').length, 1)

  // 熔断后无论再过多久 tick，都不会再产生任何催办
  const afterBreakTick = evaluateWatchdog(draft, { now: t0 + 200_000, graceMs: 30_000, maxNudges: 1 })
  assert.equal(afterBreakTick.nudged.length, 0)
  assert.equal(afterBreakTick.stalled.length, 0)
})

test('Invariant 3 (Bounded Backoff Retry on TRANSPORT)：瞬态错误按 15s/60s 退避重试 2 次，第 3 次熔断停在 failed；非瞬态错误 0 次重试', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  await store.ready()
  let now = 1_700_000_000_000
  const watchdog = createWatchdog({ store, nowFn: () => now, autoSchedule: false })
  const handleSessionEvent = createSessionTurnSync({ store, watchdog })

  let transientCardId = ''
  let fatalCardId = ''
  await store.update(draft => {
    transientCardId = createCard(draft, {
      title: 'TRANSPORT 退避重试卡',
      status: 'running',
      sessionId: 'session-transport',
    }, { now }).card.id
    fatalCardId = createCard(draft, {
      title: '非瞬态错误卡',
      status: 'running',
      sessionId: 'session-fatal',
    }, { now }).card.id
    return null
  })

  // 1) 非瞬态错误（ACCOUNT_SIGNED_OUT）：置 failed，Watchdog 绝不排期自动重试
  now += 1_000
  await handleSessionEvent({ id: 'session-fatal' }, {
    type: 'turn/end',
    seq: 1,
    time: now,
    data: { turn: 1, reason: { kind: 'error', error: { code: 'ACCOUNT_SIGNED_OUT', message: '账号已退出' } } },
  })
  let snapshot = await store.read()
  const fatalCard = snapshot.cards.find(item => item.id === fatalCardId)
  assert.equal(fatalCard.status, 'failed')
  assert.equal((snapshot.outbox || []).filter(item => item.cardId === fatalCardId).length, 0)

  // 2) 瞬态错误第 1 次（Turn 1 TRANSPORT）：自动排入 +15s 退避重试 Outbox，retriesUsed = 1
  now += 1_000
  const fail1At = now
  await handleSessionEvent({ id: 'session-transport' }, {
    type: 'turn/end',
    seq: 1,
    time: fail1At,
    data: { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'stream disconnected' } } },
  })
  snapshot = await store.read()
  let tCard = snapshot.cards.find(item => item.id === transientCardId)
  assert.equal(tCard.status, 'failed')
  assert.equal(tCard.runtime.budget.retriesUsed, 1)
  assert.equal(snapshot.outbox.length, 1)
  assert.equal(snapshot.outbox[0].kind, 'retry')
  assert.equal(snapshot.outbox[0].notBefore, fail1At + 15_000)

  // +10s 时未到退避窗口：leaseOutbox 不返回该条目
  await store.update(draft => {
    const earlyLease = leaseOutbox(draft, { now: fail1At + 10_000 })
    assert.equal(earlyLease.entries.length, 0)
    return null
  })

  // +15s 到达退避窗口：leaseOutbox 返回第 1 条 retry 并 ACK
  await store.update(draft => {
    const readyLease = leaseOutbox(draft, { now: fail1At + 15_000 })
    assert.equal(readyLease.entries.length, 1)
    ackOutbox(draft, readyLease.entries[0].seq, { ok: true, now: fail1At + 15_100 })
    return null
  })

  // 3) 瞬态错误第 2 次（Turn 2 TRANSPORT）：自动排入 +60s 退避重试，retriesUsed = 2
  now = fail1At + 20_000
  const fail2At = now
  await handleSessionEvent({ id: 'session-transport' }, {
    type: 'turn/end',
    seq: 2,
    time: fail2At,
    data: { turn: 2, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'connection reset' } } },
  })
  snapshot = await store.read()
  tCard = snapshot.cards.find(item => item.id === transientCardId)
  assert.equal(tCard.status, 'failed')
  assert.equal(tCard.runtime.budget.retriesUsed, 2)
  const retryEntries = snapshot.outbox.filter(item => item.kind === 'retry')
  assert.equal(retryEntries.length, 2)
  assert.equal(retryEntries[1].notBefore, fail2At + 60_000)

  // 4) 瞬态错误第 3 次（Turn 3 TRANSPORT）：retriesUsed 已达上限 2，触发熔断保持 failed，不再入队第 3 条 retry
  now = fail2At + 65_000
  await handleSessionEvent({ id: 'session-transport' }, {
    type: 'turn/end',
    seq: 3,
    time: now,
    data: { turn: 3, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'still down' } } },
  })
  snapshot = await store.read()
  tCard = snapshot.cards.find(item => item.id === transientCardId)
  assert.equal(tCard.status, 'failed')
  assert.equal(tCard.runtime.budget.retriesUsed, 2)
  assert.equal(snapshot.outbox.filter(item => item.kind === 'retry').length, 2)
  const exhaustedEvent = snapshot.activities.find(
    item => item.cardId === transientCardId && item.data?.reason === 'max_retries_exceeded',
  )
  assert.ok(exhaustedEvent, '应记录退避重试达上限熔断节点')

  await store.close()
})


test('Invariant 4 (Generation Fencing)：卡片状态跃迁或换绑主会话时 generation 自增，旧代次的 pending/leased Outbox 条目一律自动失效', () => {
  const t0 = 1_700_000_000_000
  const draft = emptyDraft(t0)
  const { card } = createCard(draft, {
    title: 'Generation 栅栏验证卡',
    status: 'running',
    sessionId: 'session-gen-1',
  }, { now: t0 })

  const gen1 = ensureCardRuntime(card).generation
  assert.equal(gen1, 1)

  // 在 gen=1 下入队两条消息，其中第 1 条已被 lease，第 2 条仍为 pending
  const e1 = enqueueOutbox(draft, {
    idempotencyKey: `nudge:${card.id}:gen:${gen1}:1`,
    kind: 'nudge',
    cardId: card.id,
    expectedGeneration: gen1,
    target: { sessionId: 'session-gen-1' },
    prompt: '旧代次催办 1',
  }, { now: t0 + 10 })
  const e2 = enqueueOutbox(draft, {
    idempotencyKey: `nudge:${card.id}:gen:${gen1}:2`,
    kind: 'nudge',
    cardId: card.id,
    expectedGeneration: gen1,
    target: { sessionId: 'session-gen-1' },
    prompt: '旧代次催办 2',
  }, { now: t0 + 20 })

  const leased = leaseOutbox(draft, { limit: 1, leaseMs: 30_000, now: t0 + 50 })
  assert.equal(leased.entries.length, 1)
  assert.equal(leased.entries[0].seq, e1.entry.seq)

  // 卡片发起审批进入 needs_you：generation 跃迁为 2，且旧代次未发出的 pending 条目立即失效
  requestApproval(draft, card.id, {
    title: '请确认架构方案',
    options: ['继续推进', '暂停'],
  }, { now: t0 + 100 })
  assert.equal(card.runtime.generation, 2)
  assert.equal(e2.entry.status, 'expired')

  // 试图用旧代次 expectedGeneration=1 入队：直接拒绝
  const staleEnqueue = enqueueOutbox(draft, {
    idempotencyKey: `nudge:${card.id}:gen:${gen1}:3`,
    kind: 'nudge',
    cardId: card.id,
    expectedGeneration: gen1,
    target: { sessionId: 'session-gen-1' },
    prompt: '迟到的旧代次入队',
  }, { now: t0 + 150 })
  assert.equal(staleEnqueue.enqueued, false)
  assert.equal(staleEnqueue.reason, 'generation_mismatch')

  // 之前已被客户端 lease 的 e1 在 generation 变化后回传 ACK：被标记为 expired，不会污染新代次
  const staleAck = ackOutbox(draft, e1.entry.seq, {
    ok: true,
    sessionId: 'session-stale-created',
    now: t0 + 200,
  })
  assert.equal(staleAck.expired, true)
  assert.equal(e1.entry.status, 'expired')
  assert.deepEqual(card.sessionIds, ['session-gen-1'])

  // 换绑主会话也会使 generation 递增
  moveCard(draft, card.id, { status: 'running', now: t0 + 300 })
  const genBeforeLink = card.runtime.generation
  linkSession(draft, card.id, { sessionId: 'session-gen-2', now: t0 + 400 })
  assert.equal(card.runtime.generation, genBeforeLink + 1)
})

test('Invariant 5 (Upstream-to-Downstream Handoff Injection & WaitCondition Wakeup)：前置依赖完成自动合成 handoff 注入下游并入队唤醒；时间窗口到达前压制催办、到期自动唤醒', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  await store.ready()
  const tools = createTools({ store })
  const callTool = async (name, args) => JSON.parse(await tools.find(item => item.name === name).execute(args, { agent: { id: 'agent-test' } }))

  // 1) 用工具创建上游卡 A 与下游卡 B（status: 'blocked', dependsOn: [A], autoStart: true）
  const createdA = await callTool('kanban_create_card', {
    title: '上游：生成数据库 Schema',
    status: 'running',
    cwd: '/workspace/db-project',
    sessionId: 'session-up-a',
    forceNew: true,
  })
  assert.equal(createdA.ok, true)
  const cardAId = createdA.card.id

  const createdB = await callTool('kanban_create_card', {
    title: '下游：基于 Schema 生成 API 路由',
    summary: '实现 CRUD 接口并通过集成测试',
    status: 'blocked',
    dependsOn: [cardAId],
    autoStart: true,
    forceNew: true,
  })
  assert.equal(createdB.ok, true)
  const cardBId = createdB.card.id
  assert.equal(createdB.card.status, 'blocked')
  assert.equal(createdB.card.autoStart, true)

  // 给上游卡 A 写入 artifacts 并调用 kanban_complete_card 收口
  await callTool('kanban_update_card', {
    cardId: cardAId,
    artifacts: [{ kind: 'file', label: 'schema.sql', path: '/workspace/db-project/schema.sql' }],
  })
  const completedA = await callTool('kanban_complete_card', {
    cardId: cardAId,
    result: '已完成 users 与 orders 表结构定义并落盘 schema.sql',
  })
  assert.equal(completedA.ok, true)

  // 验证下游卡 B：
  // - 状态自动从 blocked 升为 running
  // - 自动继承上游 cwd（/workspace/db-project）
  // - card.handoff 自动合成了上游卡 A 的结果与产物路径
  // - Outbox 自动入队了一条包含上游交付物上下文的 wake 消息
  let snapshot = await store.read()
  const cardB = snapshot.cards.find(item => item.id === cardBId)
  assert.equal(cardB.status, 'running')
  assert.equal(cardB.cwd, '/workspace/db-project')
  assert.ok(cardB.handoff, '应自动合成上游交接摘要 handoff')
  assert.match(cardB.handoff.summary, /已完成 users 与 orders 表结构定义/)
  assert.match(cardB.handoff.summary, /schema\.sql/)
  assert.equal(snapshot.outbox.length, 1)
  assert.equal(snapshot.outbox[0].kind, 'wake')
  assert.equal(snapshot.outbox[0].cardId, cardBId)
  assert.match(snapshot.outbox[0].prompt, /schema\.sql/)

  // 2) 验证显式 waitCondition：压制静默停滞催办，并在到达 notBefore 时自动入队唤醒
  const waitUntil = Date.now() + 120_000
  const updatedWait = await callTool('kanban_update_card', {
    cardId: cardBId,
    waitCondition: { kind: 'time', notBefore: waitUntil, reason: '等待 CI 镜像构建完成' },
  })
  assert.equal(updatedWait.ok, true)
  assert.equal(updatedWait.card.runtime.waitCondition.notBefore, waitUntil)

  // 即使会话完成了 turn 且过了 60s（仍在 waitUntil 之前），Watchdog 也不会发静默催办
  await store.update(draft => {
    const target = draft.cards.find(item => item.id === cardBId)
    target.sessionIds = ['session-down-b']
    recordSessionTurnWatermark(draft, {
      sessionId: 'session-down-b',
      turn: 1,
      phase: 'idle',
      at: waitUntil - 90_000,
    })
    const beforeWait = evaluateWatchdog(draft, { now: waitUntil - 10_000, graceMs: 30_000 })
    assert.equal(beforeWait.nudged.length, 0)
    assert.equal(beforeWait.resumed.length, 0)

    // 到达 waitUntil：自动清除 waitCondition 并入队 wait_resume 唤醒消息
    const atWait = evaluateWatchdog(draft, { now: waitUntil + 1_000, graceMs: 30_000 })
    assert.deepEqual(atWait.resumed.map(item => item.id), [cardBId])
    assert.equal(target.runtime.waitCondition, undefined)
    return null
  })

  snapshot = await store.read()
  const waitWakeEntry = snapshot.outbox.find(item => item.kind === 'wait_resume' && item.cardId === cardBId)
  assert.ok(waitWakeEntry, '到达等待窗口后应入队 wait_resume 消息')
  assert.match(waitWakeEntry.prompt, /等待 CI 镜像构建完成/)

  await store.close()
})


test('REST Outbox 路由契约：GET /api/kanban/outbox、POST /api/kanban/outbox/lease 与 POST /api/kanban/outbox/:seq/ack 端到端闭环', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  await store.ready()
  const { routes, close } = createRoutes({ store })
  const apiHandler = routes[0].handler

  async function callApi(method, path, body) {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : Buffer.alloc(0)
    const req = Readable.from(payload.length ? [payload] : [])
    req.method = method
    req.url = path
    req.headers = {
      host: 'localhost',
      ...(payload.length ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
    }
    req.socket = { encrypted: false }
    let statusCode = 200
    let chunks = []
    const res = {
      headersSent: false,
      destroyed: false,
      writeHead(code) { statusCode = code; this.headersSent = true },
      end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) },
    }
    await apiHandler(req, res)
    return { status: statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  }

  let cardId = ''
  await store.update(draft => {
    const { card } = createCard(draft, { title: 'REST Outbox 测试卡', status: 'running', cwd: '/tmp/rest-outbox' })
    cardId = card.id
    const gen = ensureCardRuntime(card).generation
    enqueueOutbox(draft, {
      idempotencyKey: `wake:${card.id}:gen:${gen}`,
      cardId: card.id,
      expectedGeneration: gen,
      kind: 'wake',
      prompt: 'REST 唤醒测试',
    })
    return null
  })

  const listed = await callApi('GET', '/api/kanban/outbox')
  assert.equal(listed.status, 200)
  assert.equal(listed.data.ok, true)
  assert.equal(listed.data.pendingCount, 1)
  assert.equal(listed.data.entries.length, 1)

  const leased = await callApi('POST', '/api/kanban/outbox/lease', { limit: 2, leaseMs: 20_000 })
  assert.equal(leased.status, 200)
  assert.equal(leased.data.ok, true)
  assert.equal(leased.data.entries.length, 1)
  const seq = leased.data.entries[0].seq

  const acked = await callApi('POST', `/api/kanban/outbox/${seq}/ack`, {
    ok: true,
    sessionId: 'session-bound-via-rest-ack',
  })
  assert.equal(acked.status, 200)
  assert.equal(acked.data.ok, true)
  assert.equal(acked.data.entry.status, 'acked')
  assert.deepEqual(acked.data.card.sessionIds, ['session-bound-via-rest-ack'])

  await close()
  await store.close()
})


test('Invariant 6 (Checklist Completion Guard & Backlog Auto-Start Scheduling)：未完成 checklist 严禁通过工具置为 done，历史脏 done 卡由 Watchdog 自动回退 backlog，开启 autoStart 的就绪待办卡由 Watchdog 自动拉起', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  await store.ready()
  const tools = createTools({ store })
  const callTool = async (name, args) => JSON.parse(await tools.find(item => item.name === name).execute(args, { agent: { id: 'agent-test' } }))

  // 1) 创建含未完成 checklist 的进行中卡片，验证 kanban_complete_card 默认拦截（CARD_HAS_OPEN_CHECKLISTS）
  const created = await callTool('kanban_create_card', {
    title: '工作区体验改进（21 项建议）',
    status: 'running',
    sessionId: 'session-checklist-guard',
    checklists: [
      { id: 'ck-1', text: 'Phase C 清理', done: true },
      { id: 'ck-2', text: 'P2 磁盘占用（待排期）', done: false },
    ],
    forceNew: true,
  })
  assert.equal(created.ok, true)
  const cardId = created.card.id

  const rejected = await callTool('kanban_complete_card', {
    cardId,
    result: '本批先收口，剩余待排期',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'CARD_HAS_OPEN_CHECKLISTS')

  // 2) 模拟历史遗留脏数据（done 状态但仍有未完成 checklist），验证 Watchdog 自动回退到 backlog
  await store.update(draft => {
    const target = draft.cards.find(item => item.id === cardId)
    target.status = 'done'
    const report = evaluateWatchdog(draft, { now: 1_700_000_100_000 })
    assert.deepEqual(report.reopened.map(item => item.id), [cardId])
    assert.equal(target.status, 'backlog')
    assert.match(target.currentAction, /P2 磁盘占用/)
    return null
  })

  // 3) 创建无前置依赖但开启 autoStart: true 的待办卡片，验证 Watchdog 自动拉起为 running 并入队 wake Outbox
  const readyBacklog = await callTool('kanban_create_card', {
    title: '开启自动接力的无依赖待办卡',
    status: 'backlog',
    cwd: '/workspace/auto-start-demo',
    autoStart: true,
    forceNew: true,
  })
  assert.equal(readyBacklog.ok, true)
  const autoCardId = readyBacklog.card.id

  await store.update(draft => {
    const report = evaluateWatchdog(draft, { now: 1_700_000_200_000 })
    assert.deepEqual(report.started.map(item => item.id), [autoCardId])
    const autoCard = draft.cards.find(item => item.id === autoCardId)
    assert.equal(autoCard.status, 'running')
    const wakeEntry = draft.outbox.find(item => item.cardId === autoCardId && item.kind === 'wake')
    assert.ok(wakeEntry, 'Watchdog 自动拉起待办卡时应入队 wake Outbox 消息')
    return null
  })

  await store.close()
})

test('Super-Agent 常驻入口会话保护 + 双层意图路由器（闲聊直回 vs 看板查询 vs 审批回复 vs 线程直通 vs 任务派发）', () => {
  const t0 = 1_700_000_000_000
  const draft = emptyDraft(t0)

  // 1) 常驻 Super-Agent 会话不可归档保护
  setSuperAgentSessionId(draft, 'session-super-agent-main', { now: t0 })
  assert.equal(getSuperAgentSessionId(draft), 'session-super-agent-main')

  const { card: doneCard } = createCard(draft, {
    title: '由常驻会话发起的完成卡',
    status: 'done',
    sessionId: 'session-super-agent-main',
  }, { now: t0 })

  assert.throws(
    () => sessionArchivePlan(draft, { cardId: doneCard.id, sessionId: 'session-super-agent-main' }),
    err => err.code === 'SUPER_AGENT_PROTECTED',
  )

  const batchPlan = batchSessionArchivePlan(draft)
  assert.equal(batchPlan.archivable.length, 0)
  assert.equal(batchPlan.skipped[0]?.reason, 'super_agent_protected')

  // 2) 双层意图路由：闲聊直回
  const chatIntent = classifySuperAgentIntent(draft, { text: '你好！请问什么是量子纠缠？' })
  assert.equal(chatIntent.route, 'direct_reply')
  assert.equal(chatIntent.shouldUseKanban, false)

  // 3) 看板查询
  const queryIntent = classifySuperAgentIntent(draft, { text: '帮我看下看板里有哪些进行中和待确认的卡片' })
  assert.equal(queryIntent.route, 'board_query')
  assert.equal(queryIntent.shouldUseKanban, true)

  // 4) 工程任务派发（带多步 checklist 抽取）
  const taskIntent = classifySuperAgentIntent(draft, {
    text: '帮我实现飞书与钉钉出站消息模板：\n- 支持飞书 interactive 卡片与 HMAC 签名\n- 支持钉钉 actionCard 与 URL 签名',
  })
  assert.equal(taskIntent.route, 'task_dispatch')
  assert.equal(taskIntent.shouldUseKanban, true)
  assert.equal(taskIntent.suggestedCard.checklists.length, 2)

  // 5) Thread 订阅直通与显式审批指令
  const { card: approvalCard } = createCard(draft, {
    title: '上线灰度确认',
    status: 'running',
    externalThreadId: 'feishu:thread:oc_123',
    sessionId: 'session-worker-1',
  }, { now: t0 + 10 })
  requestApproval(draft, approvalCard.id, {
    title: '是否开启新批次灰度？',
    options: [
      { id: 'yes', label: '立即开启', tone: 'primary' },
      { id: 'no', label: '暂缓', tone: 'danger' },
    ],
  }, { now: t0 + 20 })

  const threadApproval = classifySuperAgentIntent(draft, {
    text: '立即开启',
    externalThreadId: 'feishu:thread:oc_123',
  })
  assert.equal(threadApproval.route, 'approval_reply')
  assert.equal(threadApproval.cardId, approvalCard.id)
  assert.equal(threadApproval.optionId, 'yes')
})

test('多端 IM 消息模板引擎（飞书 / 钉钉 / 企微 / OneBot / Generic）+ 入站网关（GitHub Issue Webhook & Poller / 飞书卡片交互回调）', () => {
  const t0 = 1_700_000_000_000
  const draft = emptyDraft(t0)

  // 1) GitHub Issue Webhook 入站幂等建卡 + 评论唤醒 + 关闭收口
  const opened = handleIngressEvent(draft, {
    action: 'opened',
    repository: { full_name: 'acme/dsh-kanban' },
    issue: {
      number: 42,
      title: '支持 MCP Server 与多端 IM 桥',
      body: '让外部 Agent 也能通过 MCP 访问看板。',
      labels: [{ name: 'enhancement' }],
      user: { login: 'alice' },
    },
    cwd: '/workspace/dsh-kanban',
  }, { now: t0, githubEvent: 'issues' })
  assert.equal(opened.kind, 'github_issue_created')
  assert.equal(opened.card.externalRef, 'github:acme/dsh-kanban#42')

  const commented = handleIngressEvent(draft, {
    action: 'created',
    repository: { full_name: 'acme/dsh-kanban' },
    issue: { number: 42, title: '支持 MCP Server 与多端 IM 桥' },
    comment: { id: 9001, body: '请同时补充 stdio 与 HTTP 两种传输方式。' },
    sender: { login: 'alice' },
  }, { now: t0 + 1000, githubEvent: 'issue_comment' })
  assert.equal(commented.kind, 'github_issue_comment')
  assert.equal(commented.card.id, opened.card.id)
  assert.ok(draft.outbox.some(item => item.cardId === opened.card.id && item.kind === 'wake'))

  // 2) 入口 1 通过入口 5（定时任务轮询 `gh issue list`）批量幂等对账
  const pollSync = handleIngressEvent(draft, {
    repo: 'acme/dsh-kanban',
    githubIssues: [
      { number: 42, title: '支持 MCP Server 与多端 IM 桥（已更新）', state: 'closed' },
      { number: 43, title: '新增飞书卡片签名校验', state: 'open', labels: ['im'] },
    ],
  }, { now: t0 + 2000 })
  assert.equal(pollSync.kind, 'github_poll_sync')
  assert.equal(pollSync.closed.length, 1)
  assert.equal(pollSync.created.length, 1)
  assert.equal(opened.card.status, 'done')

  // 3) 飞书 / 钉钉 / 企微 / OneBot 出站多模板与签名
  const pollCard = pollSync.created[0]
  const { approval } = requestApproval(draft, pollCard.id, {
    title: '选择飞书通知模式',
    options: [
      { id: 'interactive', label: '交互卡片', tone: 'primary' },
      { id: 'text', label: '纯文本', tone: 'neutral' },
    ],
  }, { now: t0 + 3000 })

  const feishuCard = formatImNotification(
    { template: 'approval_requested', card: pollCard, approval },
    { provider: 'feishu', format: 'card', secret: 'feishu-secret', timestamp: 1700000000 },
  )
  assert.equal(feishuCard.msg_type, 'interactive')
  assert.equal(typeof feishuCard.sign, 'string')
  assert.equal(feishuCard.sign, signFeishuWebhook('feishu-secret', 1700000000).sign)
  assert.equal(feishuCard.card.header.template, 'orange')
  assert.ok(feishuCard.card.elements.some(el => el.tag === 'action'))

  const feishuLight = formatImNotification(
    { template: 'approval_requested', card: pollCard, approval },
    { provider: 'feishu', format: 'text' },
  )
  assert.equal(feishuLight.msg_type, 'text')
  assert.ok(feishuLight.content.text.length <= 100, 'IM 极简文本通知应严格 ≤100 字')

  const dingCard = formatImNotification(
    { template: 'approval_requested', card: pollCard, approval },
    { provider: 'dingtalk', format: 'card', secret: 'ding-secret', timestamp: 1700000000000 },
  )
  assert.equal(dingCard.msgtype, 'actionCard')
  assert.equal(dingCard.actionCard.btns.length, 3)
  assert.equal(dingCard.actionCard.btns[2].title, '在 DSH 看板中查看')
  assert.equal(dingCard._dingtalkQuery.sign, signDingtalkWebhook('ding-secret', 1700000000000).sign)

  const wecomCard = formatImNotification(
    { template: 'card_completed', card: opened.card },
    { provider: 'wecom', format: 'card' },
  )
  assert.equal(wecomCard.msgtype, 'template_card')
  assert.equal(wecomCard.template_card.card_type, 'text_notice')

  const onebotMsg = formatImNotification(
    { template: 'card_blocked', card: pollCard, reason: '等待上游凭证' },
    { provider: 'onebot', onebotTarget: { groupId: 123456 } },
  )
  assert.equal(onebotMsg.action, 'send_msg')
  assert.equal(onebotMsg.params.message_type, 'group')

  // 4) 飞书交互卡片按钮点击回调直接完成审批
  const callbackRes = handleIngressEvent(draft, {
    provider: 'feishu',
    operator: { name: '飞书审批人' },
    action: {
      value: {
        action: 'resolve_approval',
        cardId: pollCard.id,
        approvalId: approval.id,
        optionId: 'interactive',
      },
    },
  }, { now: t0 + 4000 })
  assert.equal(callbackRes.kind, 'approval_resolved')
  assert.equal(callbackRes.card.status, 'running')
})

test('M3 会话事件自动填充卡片计量 + MCP JSON-RPC 2.0 跨 Harness 闭环', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  await store.ready()

  // 1) MCP initialize + tools/list + tools/call 建卡（指定 harness: claude-code）
  const initRes = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  })
  assert.equal(initRes.result.serverInfo.name, 'dsh-kanban-mcp')

  const listRes = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  })
  assert.equal(listRes.result.tools.length, 20)
  assert.ok(listRes.result.tools.some(tool => tool.name === 'kanban_autopilot'))

  const createRes = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'kanban_create_card',
      arguments: {
        title: 'Claude Code 跨 Harness 协作卡',
        status: 'backlog',
        autoStart: true,
        cwd: '/workspace/claude-worker',
        sessionId: 'session-claude-01',
        forceNew: true,
      },
    },
  }, { harness: 'claude-code', agentName: 'Claude Code' })
  const createdPayload = JSON.parse(createRes.result.content[0].text)
  assert.equal(createdPayload.ok, true)
  const cardId = createdPayload.card.id

  // 更新卡片 agent.harness 为 claude-code，并由 Watchdog 自动拉起入队 Outbox
  await store.update(draft => {
    patchCard(draft, cardId, { agent: { name: 'Claude Code', harness: 'claude-code' } })
    evaluateWatchdog(draft, { now: 1_700_000_500_000 })
    return null
  })

  // 验证 MCP kanban_outbox_lease 支持按 harness 过滤
  const wrongHarnessLease = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'kanban_outbox_lease',
      arguments: { owner: 'codex-1', harness: 'codex' },
    },
  })
  assert.equal(JSON.parse(wrongHarnessLease.result.content[0].text).entries.length, 0)

  const rightHarnessLease = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'kanban_outbox_lease',
      arguments: { owner: 'claude-1', harness: 'claude-code' },
    },
  })
  const leasedEntries = JSON.parse(rightHarnessLease.result.content[0].text).entries
  assert.equal(leasedEntries.length, 1)
  assert.equal(leasedEntries[0].target.harness, 'claude-code')

  // 2) 验证 M3 会话事件自动累加 toolCalls / searches / elapsedMs / tokensIn / tokensOut
  const syncHandler = createSessionTurnSync({ store })
  await syncHandler({ id: 'session-claude-01' }, { type: 'turn/start', time: 1_700_000_600_000, data: { turn: 1 } })
  await syncHandler({ id: 'session-claude-01' }, { type: 'tool/call', time: 1_700_000_601_000, data: { name: 'grep_search' } })
  await syncHandler({ id: 'session-claude-01' }, { type: 'tool/call', time: 1_700_000_602_000, data: { name: 'edit_file' } })
  await syncHandler({ id: 'session-claude-01' }, {
    type: 'turn/end',
    time: 1_700_000_605_500,
    data: {
      turn: 1,
      reason: { kind: 'completed' },
      usage: { inputTokens: 1200, outputTokens: 450 },
    },
  })

  const snapAfterTurn = await store.read()
  const meteredCard = snapAfterTurn.cards.find(c => c.id === cardId)
  assert.equal(meteredCard.metadata.searches, 1)
  assert.equal(meteredCard.metadata.elapsedMs, 5500)
  assert.equal(meteredCard.metadata.tokensIn, 1200)
  assert.equal(meteredCard.metadata.tokensOut, 450)
  assert.ok(meteredCard.metadata.toolCalls >= 2)

  await store.close()
})

test('解耦可扩展路由管道（router.js）：支持 MCP 零代码写入规则、observe 灰度试运行模式与 auto 自动派发、Worker handback 回退总控', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, forceNew: true })
  await store.ready()

  // 1) 通过 MCP `kanban_router_rules` 先添加一条 observe（灰度试运行）规则
  const upsertObserve = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'kanban_router_rules',
      arguments: {
        action: 'upsert',
        rule: {
          id: 'stream-rule',
          name: '流式引擎自动归档与派发',
          mode: 'observe',
          priority: 200,
          match: { keywords: ['stream-engine', '压测'] },
          action: {
            route: 'task_dispatch',
            cardDefaults: {
              project: 'stream-engine',
              cwd: '/workspace/stream-engine',
              priority: 'p1',
              labels: ['perf'],
              autoStart: true,
            },
          },
        },
      },
    },
  })
  assert.equal(JSON.parse(upsertObserve.result.content[0].text).ok, true)

  // observe 模式下：简短询问不会强行改成建卡，但 decision.observations 会记录灰度命中结果
  const observedRoute = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'kanban_route_intent',
      arguments: { text: 'stream-engine 今天 压测 怎么样？' },
    },
  })
  const observedDecision = JSON.parse(observedRoute.result.content[0].text).decision
  assert.equal(observedDecision.route, 'direct_reply')
  assert.equal(observedDecision.observations?.[0]?.ruleId, 'stream-rule')
  assert.equal(observedDecision.observations?.[0]?.wouldRoute, 'task_dispatch')

  // 2) 将规则切换为 mode: 'auto'，再次路由自动命中并补齐 project / cwd / labels
  await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'kanban_router_rules',
      arguments: {
        action: 'upsert',
        rule: {
          id: 'stream-rule',
          name: '流式引擎自动归档与派发',
          mode: 'auto',
          priority: 200,
          match: { keywords: ['stream-engine', '压测'] },
          action: {
            route: 'task_dispatch',
            cardDefaults: {
              project: 'stream-engine',
              cwd: '/workspace/stream-engine',
              priority: 'p1',
              labels: ['perf'],
              autoStart: true,
            },
          },
        },
      },
    },
  })

  let routedCard = null
  await store.update(draft => {
    setSuperAgentSessionId(draft, 'session-super-coord')
    const res = handleIngressEvent(draft, {
      provider: 'dingtalk',
      text: 'stream-engine 跑一下 压测 10x 离线回放基准',
    }, { dataDir: dir })
    routedCard = res.card
    return null
  })
  assert.ok(routedCard)
  assert.equal(routedCard.project, 'stream-engine')
  assert.equal(routedCard.cwd, '/workspace/stream-engine')
  assert.equal(routedCard.priority, 'high')
  assert.equal(routedCard.runtime?.priorityWake, 'person')

  // 3) Worker 调用 `kanban_handback_card` 越界回退给常驻总控会话
  const handbackRes = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: {
      name: 'kanban_handback_card',
      arguments: {
        cardId: routedCard.id,
        reason: '用户追加要求改造边缘网关鉴权，超出回放基准卡范围',
        suggestedFollowupTitle: '边缘网关鉴权适配',
      },
    },
  })
  const hb = JSON.parse(handbackRes.result.content[0].text)
  assert.equal(hb.ok, true)
  assert.equal(hb.superAgentSessionId, 'session-super-coord')
  const snap = await store.read()
  assert.ok(snap.outbox.some(e => e.target?.sessionId === 'session-super-coord' && /Handback/.test(e.prompt)))

  await store.close()
})

test('钉钉自定义关键词（superAgent）全 5 类模板注入与出站 errcode=0 校验 + 跨进程 store 磁盘热感知 + 人工抢占 +1 并发槽位', async t => {
  const dirA = await tempDir(t)
  const storeA = createStore({ dataDir: dirA, seedMode: 'empty', forceNew: true })
  await storeA.ready()

  // 1) 校验全部 5 种模板在钉钉自定义关键词 `superAgent` 下均携带关键词并通过模拟钉钉网关校验
  const sampleCard = {
    id: 'card-ab12cd34',
    title: '钉钉五类卡片全量联通测试',
    project: 'dsh-kanban',
    status: 'needs_you',
    currentAction: '等待确认安全关键词注入',
    result: '五类模板全部验证通过',
    approvals: [
      {
        id: 'ap-01',
        status: 'pending',
        title: '是否启用自动通知？',
        options: [
          { id: 'yes', label: '启用', tone: 'primary' },
          { id: 'no', label: '暂不启用', tone: 'danger' },
        ],
      },
    ],
  }
  const templates = [
    { template: 'approval_requested', format: 'card', expectedMsgType: 'actionCard' },
    { template: 'card_blocked', format: 'card', expectedMsgType: 'actionCard' },
    { template: 'card_completed', format: 'card', expectedMsgType: 'actionCard' },
    { template: 'daily_digest', format: 'markdown', expectedMsgType: 'markdown', counts: { running: 2, needs_you: 1, backlog: 3, done: 5 }, highlights: ['C1 云端持久化'] },
    { template: 'light_text', format: 'text', expectedMsgType: 'text', text: '这是一条用于校验自定义关键词截断保护的超长极简通知'.repeat(4) },
  ]

  for (const item of templates) {
    const sent = await sendWebhookNotification(
      { ...item, card: sampleCard },
      { id: 'ding-bot', provider: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=mock', keyword: 'superAgent' },
      {
        fetchImpl: async (_url, init) => {
          const bodyStr = init.body
          const hasKeyword = bodyStr.includes('superAgent')
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify(hasKeyword ? { errcode: 0, errmsg: 'ok' } : { errcode: 310000, errmsg: 'keywords not in content' })
            },
          }
        },
      },
    )
    assert.equal(sent.ok, true, `模板 ${item.template} 应通过钉钉关键词校验`)
    assert.equal(sent.msgtype, item.expectedMsgType)
  }

  // 2) 校验跨进程 Store 磁盘变更热感知 + Watchdog Step 0A / Step 1B (+1 人工抢占槽位)
  const storeB = createStore({ dataDir: dirA, seedMode: 'empty', forceNew: true })
  await storeB.ready()

  // 在进程 B 写入：3 张普通 running 卡占满默认 3 槽位 + 1 张人工抢占待办卡（priorityWake: 'person'）+ 1 张脏 done 卡
  let priorityCardId = ''
  let dirtyDoneId = ''
  await storeB.update(draft => {
    for (let i = 1; i <= 3; i += 1) {
      createCard(draft, { title: `后台运行卡 ${i}`, status: 'running', sessionId: `sess-bg-${i}` })
    }
    const p = createCard(draft, { title: '用户微信紧急派单', status: 'backlog', autoStart: true, cwd: '/tmp/urgent' }).card
    ensureCardRuntime(p).priorityWake = 'person'
    priorityCardId = p.id

    const d = createCard(draft, {
      title: '脏完成卡',
      status: 'running',
      checklists: [{ id: 'ck-open', text: '未勾选项', done: false }],
    }).card
    d.status = 'done'
    dirtyDoneId = d.id
    return null
  })

  // 进程 A 的 Watchdog 执行 tick()：自动检测到进程 B 落盘的更新，回退脏 done 卡并利用 +1 优先槽位拉起用户紧急卡！
  const watchdogA = createWatchdog({ store: storeA, autoSchedule: false })
  const tickRes = await watchdogA.tick()
  assert.equal(tickRes.reopened.length, 1)
  assert.equal(tickRes.started.length, 1)
  const latestA = await storeA.read()
  assert.equal(latestA.cards.find(c => c.id === dirtyDoneId)?.status, 'backlog')
  assert.equal(latestA.cards.find(c => c.id === priorityCardId)?.status, 'running')

  watchdogA.dispose()
  await storeB.close()
  await storeA.close()
})

test('cc2im 微信通道 Spoke 桥接（ndjson 双工流协议）：自动注册、剥离 [weixin uid] 前缀路由建卡/查板并回推 reply', async t => {
  const dir = await tempDir(t)
  const store = createStore({ dataDir: dir, seedMode: 'empty', forceNew: true })
  await store.ready()

  const { EventEmitter } = await import('node:events')
  const hubReceived = []
  let fakeClient = null

  function mockConnect() {
    const sock = new EventEmitter()
    sock.destroyed = false
    sock.write = chunk => {
      for (const line of String(chunk).split('\n').map(s => s.trim()).filter(Boolean)) {
        hubReceived.push(JSON.parse(line))
      }
      return true
    }
    sock.destroy = () => {
      sock.destroyed = true
      sock.emit('close')
    }
    fakeClient = sock
    queueMicrotask(() => sock.emit('connect'))
    return sock
  }

  const bridge = createCc2imBridge({
    store,
    dataDir: dir,
    webUrl: '',
    agentId: 'kanban',
    heartbeatMs: 60_000,
    connectFn: mockConnect,
  }).start()
  t.after(() => bridge.stop())

  const wait = async pred => {
    for (let i = 0; i < 60; i += 1) {
      if (pred()) return
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error('timeout waiting for cc2im frame')
  }
  await wait(() => hubReceived.some(f => f.type === 'register' && f.agentId === 'kanban'))

  // 模拟微信用户发来任务消息
  fakeClient.emit('data', Buffer.from(JSON.stringify({
    type: 'message',
    userId: 'wx_user_001@im.wechat',
    text: '[weixin wx_user_001@im.wechat] 帮我排查网关连接池超时问题\n- 录制采样帧\n- 输出诊断报告',
  }) + '\n'))

  await wait(() => hubReceived.some(f => f.type === 'reply' && f.userId === 'wx_user_001@im.wechat'))
  const replyFrame = hubReceived.find(f => f.type === 'reply')
  assert.match(replyFrame.text, /已纳入看板待办/)

  const snap = await store.read()
  assert.equal(snap.cards.length, 1)
  assert.equal(snap.cards[0].externalThreadId, 'weixin:wx_user_001@im.wechat')
  assert.equal(snap.cards[0].checklists.length, 2)

  // 继续模拟微信端发送「看板」查询，验证 board_query 汇总不报错并实时回推统计
  fakeClient.emit('data', Buffer.from(JSON.stringify({
    type: 'message',
    userId: 'wx_user_001@im.wechat',
    text: '[weixin wx_user_001@im.wechat] 汇总一下看板',
  }) + '\n'))
  // 注意：上一条消息绑定了 externalThreadId，这里用另一位微信用户模拟纯全局查板
  fakeClient.emit('data', Buffer.from(JSON.stringify({
    type: 'message',
    userId: 'wx_user_002@im.wechat',
    text: '[weixin wx_user_002@im.wechat] 看板',
  }) + '\n'))
  await wait(() => hubReceived.some(f => f.type === 'reply' && f.userId === 'wx_user_002@im.wechat'))
  const queryReply = hubReceived.find(f => f.type === 'reply' && f.userId === 'wx_user_002@im.wechat')
  assert.match(queryReply.text, /Super-Agent 看板简报/)
  assert.match(queryReply.text, /待办 1/)

  await store.close()
})



