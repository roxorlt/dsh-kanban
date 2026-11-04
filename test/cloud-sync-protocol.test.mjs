// cloud-sync-protocol.js（C1/3）：脱敏快照 / 增量 diff / revision 乐观锁 / Bearer / 入站信封。
// 全部为纯函数测试：不写盘、不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSeed } from '../lib/domain.js'
import {
  CLOUD_ACTIVITY_DATA_DROP_KEYS,
  CLOUD_CARD_FIELDS,
  CLOUD_CONFIG_FILE_NAME,
  CLOUD_ENTITY_KINDS,
  CLOUD_ERROR_STATUS,
  CLOUD_INGRESS_PROVIDERS,
  CLOUD_LOCAL_ONLY_CARD_FIELDS,
  CLOUD_PROTOCOL_VERSION,
  CLOUD_SYNC_LIMITS,
  CloudSyncError,
  applyDeltaToCloudSnapshot,
  assertAuthorized,
  assertProtocolVersion,
  assertValidDelta,
  buildLocalIngressRequest,
  chunkDelta,
  constantTimeEqual,
  countDelta,
  decodeSyncCursor,
  describeCloudConfig,
  detectRevisionConflict,
  diffCloudSnapshots,
  emptyCloudSnapshot,
  encodeSyncCursor,
  filterIngressHeaders,
  hashPushId,
  ingressBackoffMs,
  ingressDedupeKey,
  isEmptyDelta,
  isIngressExpired,
  makeIngressId,
  maskToken,
  nextCloudRevision,
  nextIngressAttempt,
  normalizeCloudConfig,
  normalizeIngressEnvelope,
  normalizePullRequest,
  parseBearerToken,
  planPush,
  pullResponseToDelta,
  redactDeep,
  redactPath,
  redactText,
  sanitizeActivityData,
  stableStringify,
  toCloudActivity,
  toCloudBoard,
  toCloudCard,
  toCloudSnapshot,
  toErrorResponse,
  verifyBearer,
} from '../lib/cloud-sync-protocol.js'

const HOME = '/Users/roxor'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function card(overrides = {}) {
  return {
    id: 'card-aaaa0001',
    boardId: 'board-default',
    title: '实现云端同步：修 /Users/roxor/Desktop/dsh 的令牌 sk-abcdefghijklmnop1234567890',
    summary: '本地优先镜像，token: abcdefgh12345678 不落云端',
    currentAction: '正在写 diff',
    result: '已完成',
    status: 'running',
    priority: 'high',
    labels: ['cloud', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    project: 'dsh-kanban',
    externalRef: 'github:owner/repo#42',
    externalThreadId: 'feishu:chat:oc_local_thread',
    workspaceId: 'ws-9a95',
    cwd: `${HOME}/Desktop/dsh/dsh kanban`,
    sessionIds: ['session-1', 'session-2'],
    dependsOn: ['card-bbbb0002'],
    agent: { name: 'DSH Agent', id: 'agent-local-1' },
    progress: { step: 2, total: 4, text: '实现 diff' },
    checklists: [{ id: 'ck-1', text: '写契约', done: true }],
    approvals: [{
      id: 'ap-1',
      title: '是否上线？',
      detail: `影响 ${HOME}/Desktop/dsh 目录`,
      options: [{ id: 'yes', label: '上线', tone: 'primary' }],
      status: 'pending',
      requestedBy: { kind: 'agent', name: 'DSH Agent', id: 'agent-local-1' },
      requestedAt: 1100,
      sessionId: 'session-1',
    }],
    artifacts: [
      { id: 'art-1', kind: 'file', label: '报告', path: `${HOME}/Desktop/dsh/report.md` },
      { id: 'art-2', kind: 'link', label: '链接', url: 'https://example.com/a?token=abcdef123456' },
    ],
    handoff: {
      summary: '继续跑测试',
      nextSteps: 'npm test',
      sessionId: 'session-1',
      at: 1200,
      by: { kind: 'agent', name: 'DSH Agent', id: 'agent-local-1' },
    },
    metadata: { toolCalls: 3, searches: 1 },
    order: 1,
    version: 7,
    runtime: { generation: 2, budget: { nudgesUsed: 0 } },
    autoStart: true,
    archived: false,
    createdAt: 1000,
    updatedAt: 2000,
    startedAt: 1500,
    ...overrides,
  }
}

function board(overrides = {}) {
  return {
    id: 'board-default',
    name: 'DSH 看板',
    description: '个人看板',
    cardOrder: {
      backlog: ['card-cccc0003'],
      running: ['card-aaaa0001'],
      needs_you: [],
      done: ['card-dddd0004', 42],
    },
    createdAt: 900,
    updatedAt: 2000,
    ...overrides,
  }
}

function activity(overrides = {}) {
  return {
    id: 'ev-00000001',
    cardId: 'card-aaaa0001',
    type: 'progress',
    actor: { kind: 'agent', name: 'DSH Agent', id: 'agent-local-1' },
    text: `推进中，参考 ${HOME}/Desktop/dsh`,
    at: 1500,
    data: {
      kind: 'worktree_cleaned',
      sessionId: 'session-1',
      cwd: `${HOME}/Desktop/dsh`,
      repoRoot: `${HOME}/Desktop/dsh/dsh kanban`,
      worktreePath: `${HOME}/Desktop/dsh/.agents/worktrees/feat/x`,
      trashedTo: `${HOME}/.Trash/dsh-x`,
      branchName: 'feat/x',
      token: 'abcdefgh12345678',
    },
    ...overrides,
  }
}

function localStore(overrides = {}) {
  return {
    schemaVersion: 1,
    boards: [board()],
    cards: [card(), card({ id: 'card-dddd0004', title: '已完成卡', status: 'done' })],
    activities: [
      activity(),
      activity({ id: 'ev-00000002', type: 'status', text: '完成了卡片', at: 1600, data: undefined }),
    ],
    meta: { createdAt: 800, updatedAt: 2000, revision: 12 },
    outbox: [{ seq: 1, kind: 'wake', prompt: '本地唤醒指令不该上云' }],
    ...overrides,
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    return Object.freeze(value)
  }
  return value
}

// ---------------------------------------------------------------------------
// 0. 常量与契约不变量
// ---------------------------------------------------------------------------

test('协议常量：版本、实体、来源、错误码齐备', () => {
  assert.equal(CLOUD_PROTOCOL_VERSION, 1)
  assert.deepEqual(CLOUD_ENTITY_KINDS, ['board', 'card', 'activity'])
  assert.deepEqual(CLOUD_INGRESS_PROVIDERS, ['github', 'feishu', 'dingtalk', 'wecom', 'onebot', 'weixin', 'generic'])
  assert.equal(CLOUD_CONFIG_FILE_NAME, 'cloud-config.json')
  for (const code of [
    'BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'REVISION_CONFLICT', 'SYNC_EPOCH_MISMATCH',
    'UNSUPPORTED_PROTOCOL_VERSION', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED', 'INTERNAL', 'UNAVAILABLE', 'BAD_CONFIG',
  ]) {
    assert.equal(typeof CLOUD_ERROR_STATUS[code], 'number', code)
  }
  assert.equal(CLOUD_SYNC_LIMITS.pushEntities, 200)
  assert.equal(CLOUD_SYNC_LIMITS.activitiesPerCard, 300)
  assert.ok(Object.isFrozen(CLOUD_SYNC_LIMITS))
})

test('卡片白名单与本地执行面字段不重叠', () => {
  for (const field of CLOUD_LOCAL_ONLY_CARD_FIELDS) {
    assert.equal(CLOUD_CARD_FIELDS.includes(field), false, `本地字段 ${field} 不应出现在白名单`)
  }
})

// ---------------------------------------------------------------------------
// 1. 文本 / 路径 / 深度脱敏
// ---------------------------------------------------------------------------

test('redactText：密钥、URL 凭据、home 路径全部清洗', () => {
  assert.equal(redactText('sk-abcdefghijklmnop1234567890'), 'sk-****')
  assert.equal(redactText('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'gh-****')
  assert.equal(redactText('github_pat_11ABCDEFG0123456789_abcdefghijklmnop'), 'gh-****')
  assert.equal(redactText('xoxb-1234567890-abcdefghij'), 'xox-****')
  assert.equal(redactText('AKIAIOSFODNN7EXAMPLE'), 'AKIA****')
  assert.equal(redactText('Bearer abcdefgh12345678'), 'Bearer ****')
  assert.equal(
    redactText('回调 https://oapi.dingtalk.com/robot/send?access_token=abcdef1234567890 已发送'),
    '回调 https://oapi.dingtalk.com/robot/send?access_token=**** 已发送',
  )
  assert.equal(redactText('JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'), 'JWT eyJ****')
  assert.equal(redactText('password=supersecret123'), 'password=****')
  assert.equal(redactText(`路径 ${HOME}/Desktop/dsh 结束`), '路径 ~/Desktop/dsh 结束')
  assert.equal(redactText('C:\\Users\\roxor\\Desktop\\secret'), '~\\Desktop\\secret')
  // 普通中文不受影响
  assert.equal(redactText('普通中文摘要，没有密钥。'), '普通中文摘要，没有密钥。')
  // 幂等
  const sample = '令牌 sk-abcdefghijklmnop1234567890 在 /Users/roxor/a'
  assert.equal(redactText(redactText(sample)), redactText(sample))
  // 非字符串安全降级
  assert.equal(redactText(undefined), '')
  assert.equal(redactText(42), '')
})

test('redactPath：homeDir 优先替换，跨平台路径归一', () => {
  assert.equal(redactPath(`${HOME}/Desktop/dsh`, { homeDir: HOME }), '~/Desktop/dsh')
  assert.equal(redactPath('/Users/other/Desktop/x'), '~/Desktop/x')
  assert.equal(redactPath('/home/someone/code'), '~/code')
  assert.equal(redactPath('/tmp/keep'), '/tmp/keep')
  assert.equal(redactPath(undefined), '')
})

test('redactDeep：结构递归、敏感键替换、深度保护、不改入参', () => {
  const input = {
    token: 'abcdefgh1234',
    nested: { secret: 'x', list: [`${HOME}/a`, 1, null, true] },
    date: new Date(1700000000000),
  }
  const frozen = deepFreeze(input)
  const output = redactDeep(frozen)
  assert.equal(output.token, '****')
  assert.equal(output.nested.secret, '****')
  assert.deepEqual(output.nested.list, ['~/a', 1, null, true])
  assert.equal(output.date, 1700000000000)
  // 原对象未被修改（Date 实例仍在，未被替换/序列化）
  assert.equal(frozen.token, 'abcdefgh1234')
  assert.ok(frozen.date instanceof Date)
  assert.equal(frozen.date.getTime(), 1700000000000)

  let deep = '叶子'
  for (let i = 0; i < 12; i += 1) deep = { child: deep }
  assert.match(JSON.stringify(redactDeep(deep)), /truncated/)
})

test('sanitizeActivityData：本地标识键整体丢弃、路径归一、无内容返回 undefined', () => {
  const data = sanitizeActivityData({
    sessionId: 'session-1',
    sessionIds: ['session-2'],
    workspaceId: 'ws-1',
    cwd: `${HOME}/Desktop/dsh`,
    dataDir: `${HOME}/.dsh-kanban`,
    kind: 'worktree_cleaned',
    repoRoot: `${HOME}/Desktop/dsh/dsh kanban`,
    branchName: 'feat/x',
  })
  for (const key of ['sessionId', 'sessionIds', 'workspaceId', 'cwd', 'dataDir']) {
    assert.equal(key in data, false, key)
  }
  assert.equal(data.kind, 'worktree_cleaned')
  assert.equal(data.repoRoot, '~/Desktop/dsh/dsh kanban')
  assert.equal(data.branchName, 'feat/x')
  assert.equal(sanitizeActivityData(undefined), undefined)
  assert.equal(sanitizeActivityData(CLOUD_ACTIVITY_DATA_DROP_KEYS.reduce((acc, key) => ({ ...acc, [key]: 'x' }), {})), undefined)
})

// ---------------------------------------------------------------------------
// 2. 实体脱敏：Board / Card / Activity / Snapshot
// ---------------------------------------------------------------------------

test('toCloudBoard：保留顺序与时间戳，过滤非法列 id，描述脱敏', () => {
  const output = toCloudBoard(deepFreeze(board({ description: `${HOME}/secret` })))
  assert.equal(output.id, 'board-default')
  assert.equal(output.name, 'DSH 看板')
  assert.equal(output.description, '~/secret')
  assert.deepEqual(output.cardOrder.done, ['card-dddd0004'])
  assert.equal(output.createdAt, 900)
  assert.equal(output.updatedAt, 2000)
})

test('toCloudCard：执行面字段全部剥离，敏感文本/路径脱敏，入参不变', () => {
  const frozen = deepFreeze(clone(card()))
  const output = toCloudCard(frozen)

  for (const field of CLOUD_LOCAL_ONLY_CARD_FIELDS) {
    assert.equal(field in output, false, `不应上云：${field}`)
  }
  assert.equal(output.id, 'card-aaaa0001')
  assert.equal(output.boardId, 'board-default')
  assert.equal(output.status, 'running')
  assert.equal(output.version, 7)
  assert.equal(output.order, 1)
  assert.equal(output.archived, false)
  assert.equal(output.externalRef, 'github:owner/repo#42')
  assert.deepEqual(output.dependsOn, ['card-bbbb0002'])

  // 文本与标签
  assert.equal(output.title.includes('sk-****'), true)
  assert.equal(output.title.includes(redactText(HOME)), true)
  assert.equal(output.summary.includes('token: ****'), true)
  assert.deepEqual(output.labels, ['cloud', 'gh-****'])

  // agent 只保留展示名
  assert.deepEqual(output.agent, { name: 'DSH Agent' })

  // 产物路径与 URL
  assert.equal(output.artifacts[0].path, '~/Desktop/dsh/report.md')
  assert.equal(output.artifacts[1].url, 'https://example.com/a?token=****')

  // 审批：剥离 sessionId 与 actor id，保留可读内容
  assert.equal(output.approvals[0].sessionId, undefined)
  assert.equal(output.approvals[0].requestedBy.id, undefined)
  assert.equal(output.approvals[0].requestedBy.name, 'DSH Agent')
  assert.equal(output.approvals[0].detail, '影响 ~/Desktop/dsh 目录')

  // 交接摘要剥离会话与写入者
  assert.equal(output.handoff.summary, '继续跑测试')
  assert.equal(output.handoff.sessionId, undefined)
  assert.equal(output.handoff.by, undefined)

  // 纯数值/结构字段原样保留
  assert.deepEqual(output.progress, { step: 2, total: 4, text: '实现 diff' })
  assert.deepEqual(output.metadata, { toolCalls: 3, searches: 1 })
  assert.deepEqual(output.checklists, [{ id: 'ck-1', text: '写契约', done: true }])

  // 原对象未被修改
  assert.equal(frozen.cwd, `${HOME}/Desktop/dsh/dsh kanban`)
  assert.deepEqual(frozen.sessionIds, ['session-1', 'session-2'])
})

test('toCloudCard：未知自定义字段不泄漏（白名单之外的字段一律丢弃）', () => {
  const output = toCloudCard(card({ internalNotes: 'secret note', cwd: '/tmp/x' }))
  assert.equal('internalNotes' in output, false)
  assert.equal('cwd' in output, false)
})

test('toCloudActivity：actor 去 id、data 去本地标识、文本脱敏', () => {
  const frozen = deepFreeze(clone(activity()))
  const output = toCloudActivity(frozen)
  assert.equal(output.id, 'ev-00000001')
  assert.equal(output.cardId, 'card-aaaa0001')
  assert.equal(output.type, 'progress')
  assert.equal(output.at, 1500)
  assert.deepEqual(output.actor, { kind: 'agent', name: 'DSH Agent' })
  assert.equal(output.text, '推进中，参考 ~/Desktop/dsh')
  assert.equal(output.data.sessionId, undefined)
  assert.equal(output.data.cwd, undefined)
  assert.equal(output.data.repoRoot, '~/Desktop/dsh/dsh kanban')
  assert.equal(output.data.worktreePath, '~/Desktop/dsh/.agents/worktrees/feat/x')
  assert.equal(output.data.trashedTo, '~/.Trash/dsh-x')
  assert.equal(output.data.branchName, 'feat/x')
  assert.equal(output.data.token, '****')
  // data 全被丢弃时不输出 data 键
  assert.equal('data' in toCloudActivity(activity({ data: { sessionId: 'session-1' } })), false)
})

test('toCloudSnapshot：排序稳定、revision 取本地 meta、outbox 不上云、不改入参', () => {
  const input = localStore({
    boards: [board({ id: 'board-z' }), board()],
    activities: [
      activity({ id: 'ev-00000002', at: 1600 }),
      activity({ id: 'ev-00000001', at: 1500 }),
    ],
  })
  const frozen = deepFreeze(clone(input))
  const snapshot = toCloudSnapshot(frozen)
  assert.equal(snapshot.protocolVersion, CLOUD_PROTOCOL_VERSION)
  assert.equal(snapshot.revision, 12)
  assert.equal('outbox' in snapshot, false)
  assert.deepEqual(snapshot.boards.map(item => item.id), ['board-default', 'board-z'])
  assert.deepEqual(snapshot.activities.map(item => item.id), ['ev-00000001', 'ev-00000002'])
  // 幂等：再来一次结果一致（稳定序列化相同）
  assert.equal(stableStringify(toCloudSnapshot(input)), stableStringify(snapshot))
  // 真实数据形状（domain.createSeed）也能投影，且不含任何本地执行面字段
  const seed = createSeed('demo')
  const fromSeed = toCloudSnapshot(seed)
  assert.ok(fromSeed.cards.length > 0)
  for (const item of fromSeed.cards) {
    for (const field of CLOUD_LOCAL_ONLY_CARD_FIELDS) assert.equal(field in item, false, field)
  }
  assert.ok(fromSeed.activities.length > 0)
})

// ---------------------------------------------------------------------------
// 3. 增量 diff / 校验 / 分片 / 回放
// ---------------------------------------------------------------------------

test('stableStringify：键序无关、undefined 跳过、循环引用报错', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }))
  assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}')
  assert.equal(stableStringify({ arr: [1, 'x', null] }), '{"arr":[1,"x",null]}')
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => stableStringify(cyclic), error => error instanceof CloudSyncError && error.code === 'BAD_REQUEST')
})

test('diffCloudSnapshots：相同快照空增量；改卡=upsert；删卡=delete；顶层 revision 不参与比较', () => {
  const before = toCloudSnapshot(localStore())
  const same = { ...clone(before), revision: 99 }
  assert.equal(isEmptyDelta(diffCloudSnapshots(before, same)), true)

  const editedStore = localStore()
  editedStore.cards[0].title = '改了标题'
  const edited = toCloudSnapshot(editedStore)
  const editedDelta = diffCloudSnapshots(before, edited)
  assert.equal(isEmptyDelta(editedDelta), false)
  assert.equal(editedDelta.cards.upserts.length, 1)
  assert.equal(editedDelta.cards.upserts[0].title, '改了标题')
  assert.equal(editedDelta.cards.deletes.length, 0)
  assert.equal(countDelta(editedDelta).cards.upserts, 1)
  assert.equal(countDelta(editedDelta).total, 1)

  const removedStore = localStore({ cards: [localStore().cards[0]] })
  const removedDelta = diffCloudSnapshots(before, toCloudSnapshot(removedStore))
  assert.deepEqual(removedDelta.cards.deletes, ['card-dddd0004'])
  assert.equal(removedDelta.cards.upserts.length, 0)

  // 新卡 + 新看板
  const grownStore = localStore()
  grownStore.cards.push(card({ id: 'card-eeee0005', title: '新卡' }))
  grownStore.boards.push(board({ id: 'board-second' }))
  const grownDelta = diffCloudSnapshots(before, toCloudSnapshot(grownStore))
  assert.equal(grownDelta.cards.upserts.length, 1)
  assert.equal(grownDelta.boards.upserts.length, 1)
  assert.equal(assertValidDelta(grownDelta).total, 2)
})

test('assertValidDelta：结构非法/未知分组/重复 id/同 id 双向/超上限都报 BAD_REQUEST', () => {
  const ok = { boards: { upserts: [], deletes: [] }, cards: { upserts: [], deletes: [] }, activities: { upserts: [], deletes: [] } }
  assert.equal(assertValidDelta(ok).total, 0)

  const cases = [
    { delta: null },
    { delta: [] },
    { delta: { cards: { upserts: [] }, unknown: { upserts: [] } } },
    { delta: { cards: { upserts: [{ title: '缺 id' }] } } },
    { delta: { cards: { upserts: [{ id: 'card-1' }, { id: 'card-1' }] } } },
    { delta: { cards: { upserts: [{ id: 'card-1' }], deletes: ['card-1'] } } },
    { delta: { cards: { deletes: [42] } } },
    { delta: { cards: { upserts: 'nope' } } },
  ]
  for (const item of cases) {
    assert.throws(() => assertValidDelta(item.delta), error => (
      error instanceof CloudSyncError && error.code === 'BAD_REQUEST' && error.status === 400
    ))
  }
  const big = { cards: { upserts: [{ id: 'a' }, { id: 'b' }] } }
  assert.throws(() => assertValidDelta(big, { maxEntities: 1 }), error => error.code === 'BAD_REQUEST')
  assert.equal(assertValidDelta(big, { maxEntities: 10 }).total, 2)
})

test('chunkDelta：按 boards→cards→activities 顺序切片，空增量为空数组', () => {
  const delta = {
    boards: { upserts: [{ id: 'board-1' }, { id: 'board-2' }], deletes: [] },
    cards: { upserts: [{ id: 'card-1' }, { id: 'card-2' }], deletes: ['card-9'] },
    activities: { upserts: [{ id: 'ev-1' }, { id: 'ev-2' }], deletes: [] },
  }
  const chunks = chunkDelta(delta, 3)
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks.map(chunk => countDelta(chunk).total), [3, 3, 1])
  assert.deepEqual(chunks[0].boards.upserts.map(item => item.id), ['board-1', 'board-2'])
  assert.deepEqual(chunks[0].cards.upserts.map(item => item.id), ['card-1'])
  assert.deepEqual(chunks[1].cards.upserts.map(item => item.id), ['card-2'])
  assert.deepEqual(chunks[1].cards.deletes, ['card-9'])
  assert.deepEqual(chunks[1].activities.upserts.map(item => item.id), ['ev-1'])
  assert.deepEqual(chunks[2].activities.upserts.map(item => item.id), ['ev-2'])
  assert.deepEqual(chunkDelta({ boards: {}, cards: {}, activities: {} }, 5), [])
  // 非法上限回落到默认值
  const fallback = chunkDelta(delta, 0)
  assert.equal(fallback.length, 1)
  assert.equal(countDelta(fallback[0]).total, 7)
})

test('applyDeltaToCloudSnapshot：删除后插入、revision 更新、入参不变', () => {
  const snapshot = emptyCloudSnapshot(0)
  const delta = {
    boards: { upserts: [toCloudBoard(board())], deletes: [] },
    cards: { upserts: [toCloudCard(card()), toCloudCard(card({ id: 'card-dddd0004', status: 'done' }))], deletes: [] },
    activities: { upserts: [toCloudActivity(activity())], deletes: [] },
  }
  const applied = applyDeltaToCloudSnapshot(deepFreeze(clone(snapshot)), delta, { revision: 1 })
  assert.equal(applied.revision, 1)
  assert.equal(applied.cards.length, 2)
  assert.equal(applied.activities.length, 1)
  // 删除一张卡
  const removed = applyDeltaToCloudSnapshot(applied, { cards: { upserts: [], deletes: ['card-dddd0004'] } }, { revision: 2 })
  assert.deepEqual(removed.cards.map(item => item.id), ['card-aaaa0001'])
  assert.equal(removed.revision, 2)
  assert.equal(applied.cards.length, 2)
})

test('端到端：本地快照 → 空云端 → 增量下发 → 改本地 → 再增量，云端与本地镜像一致', () => {
  const storeV1 = localStore()
  const snapV1 = toCloudSnapshot(storeV1)
  const cloud0 = emptyCloudSnapshot(0)

  const deltaV1 = diffCloudSnapshots(cloud0, snapV1)
  assert.equal(isEmptyDelta(deltaV1), false)
  const cloud1 = applyDeltaToCloudSnapshot(cloud0, deltaV1, { revision: 1 })
  assert.deepEqual(stableStringify(cloud1.cards), stableStringify(snapV1.cards))
  assert.deepEqual(stableStringify(cloud1.boards), stableStringify(snapV1.boards))
  assert.deepEqual(stableStringify(cloud1.activities), stableStringify(snapV1.activities))

  const storeV2 = clone(storeV1)
  storeV2.cards[0].title = '重新命名'
  storeV2.cards.push(card({ id: 'card-ffff0006', title: '第三张卡' }))
  storeV2.activities.push(activity({ id: 'ev-00000003', at: 1700 }))
  const snapV2 = toCloudSnapshot(storeV2)
  const deltaV2 = diffCloudSnapshots(cloud1, snapV2)
  const cloud2 = applyDeltaToCloudSnapshot(cloud1, deltaV2, { revision: 2 })
  assert.deepEqual(stableStringify(cloud2.cards), stableStringify(snapV2.cards))
  assert.deepEqual(stableStringify(cloud2.activities), stableStringify(snapV2.activities))
  assert.equal(isEmptyDelta(diffCloudSnapshots(cloud2, snapV2)), true)
})

test('pullResponseToDelta：tombstones 按 entity 映射到 deletes，未知实体忽略', () => {
  const delta = pullResponseToDelta({
    boards: [{ id: 'board-1' }],
    cards: [{ id: 'card-1' }],
    activities: [],
    tombstones: [
      { entity: 'card', entityId: 'card-9', revision: 3 },
      { entity: 'activity', entity_id: 'ev-9', revision: 3 },
      { entity: 'board', id: 'board-9', revision: 3 },
      { entity: 'unknown', entityId: 'x', revision: 3 },
    ],
  })
  assert.deepEqual(delta.boards.deletes, ['board-9'])
  assert.deepEqual(delta.cards.deletes, ['card-9'])
  assert.deepEqual(delta.activities.deletes, ['ev-9'])
  assert.equal(assertValidDelta(delta).total, 5)
})

// ---------------------------------------------------------------------------
// 4. revision 乐观锁
// ---------------------------------------------------------------------------

test('detectRevisionConflict：一致通过、落后=可重试冲突、epoch 变化=全量重建', () => {
  assert.deepEqual(
    detectRevisionConflict({ baseRevision: 3, serverRevision: 3 }),
    { conflict: false, serverRevision: 3, expectedBaseRevision: 3, retryable: true },
  )

  const stale = detectRevisionConflict({ baseRevision: 2, serverRevision: 3 })
  assert.equal(stale.conflict, true)
  assert.equal(stale.code, 'REVISION_CONFLICT')
  assert.equal(stale.retryable, true)
  assert.equal(stale.expectedBaseRevision, 2)
  assert.equal(stale.serverRevision, 3)
  assert.match(stale.hint, /pull/)

  const epoch = detectRevisionConflict({ baseRevision: 3, serverRevision: 3, epoch: 'a', serverEpoch: 'b' })
  assert.equal(epoch.conflict, true)
  assert.equal(epoch.code, 'SYNC_EPOCH_MISMATCH')
  assert.equal(detectRevisionConflict({ baseRevision: 3, serverRevision: 3, epoch: 'a', serverEpoch: 'a' }).conflict, false)

  const invalid = detectRevisionConflict({ baseRevision: -1, serverRevision: 3 })
  assert.equal(invalid.code, 'BAD_REQUEST')
  assert.equal(invalid.retryable, false)
  assert.equal(nextCloudRevision(41), 42)
  assert.equal(nextCloudRevision(undefined), 1)
})

test('planPush：noop / duplicate / conflict / apply 四态与执行顺序', () => {
  const delta = { cards: { upserts: [{ id: 'card-1' }] } }
  assert.equal(planPush({ baseRevision: 3, serverRevision: 3, delta: {} }).action, 'noop')
  assert.equal(planPush({
    baseRevision: 1, serverRevision: 3, delta,
  }).action, 'conflict')
  assert.equal(planPush({
    baseRevision: 3, serverRevision: 3, delta,
  }).action, 'apply')
  assert.equal(planPush({
    baseRevision: 3, serverRevision: 3, delta,
  }).revision, 4)
  // duplicate 优先于冲突判定（响应丢失后的重试必须直接返回成功）
  const duplicate = planPush({
    baseRevision: 1, serverRevision: 3, delta, pushId: 'push-abc', lastPushId: 'push-abc', lastPushRevision: 4,
  })
  assert.deepEqual(duplicate, { action: 'duplicate', revision: 4, serverRevision: 3 })
  // 纪元不一致时即便 revision 相同也必须冲突
  const epochConflict = planPush({ baseRevision: 3, serverRevision: 3, delta, epoch: 'e1', serverEpoch: 'e2' })
  assert.equal(epochConflict.action, 'conflict')
  assert.equal(epochConflict.code, 'SYNC_EPOCH_MISMATCH')
  // 空 delta 时 pushId 命中仍是 duplicate（先判重放，避免客户端误判失败）
  assert.equal(planPush({ serverRevision: 1, delta: {}, pushId: 'p', lastPushId: 'p', lastPushRevision: 2 }).action, 'duplicate')
})

test('hashPushId：确定性 32 位十六进制，随 client/baseRevision/delta 变化', () => {
  const delta = { cards: { upserts: [{ id: 'card-1' }] } }
  const base = hashPushId({ clientId: 'mac', baseRevision: 3, delta })
  assert.match(base, /^push-[a-f0-9]{32}$/)
  assert.equal(hashPushId({ clientId: 'mac', baseRevision: 3, delta: clone(delta) }), base)
  assert.notEqual(hashPushId({ clientId: 'mac', baseRevision: 4, delta }), base)
  assert.notEqual(hashPushId({ clientId: 'pc', baseRevision: 3, delta }), base)
  assert.notEqual(hashPushId({ clientId: 'mac', baseRevision: 3, delta: { cards: { upserts: [{ id: 'card-2' }] } } }), base)
  assert.equal(hashPushId({}), hashPushId({}))
})

// ---------------------------------------------------------------------------
// 5. pull 窗口与游标
// ---------------------------------------------------------------------------

test('游标编解码：往返一致、非法游标报错', () => {
  const encoded = encodeSyncCursor({ revision: 7, id: 'card-aaaa0001' })
  assert.equal(typeof encoded, 'string')
  assert.deepEqual(decodeSyncCursor(encoded), { revision: 7, id: 'card-aaaa0001' })
  assert.equal(decodeSyncCursor(undefined), null)
  assert.equal(decodeSyncCursor(''), null)
  for (const bad of ['not-a-cursor', 'e30', Buffer.from(JSON.stringify({ r: -1, i: 'x' })).toString('base64url')]) {
    assert.throws(() => decodeSyncCursor(bad), error => error instanceof CloudSyncError && error.code === 'BAD_REQUEST')
  }
  assert.throws(() => encodeSyncCursor({ revision: 1, id: '' }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => encodeSyncCursor({ revision: 1, id: 'x'.repeat(600) }), error => error.code === 'BAD_REQUEST')
})

test('normalizePullRequest：默认全量窗口、until 冷冻、since/until 边界、limit 夹紧', () => {
  assert.deepEqual(
    normalizePullRequest({ serverRevision: 10 }),
    { since: 0, until: 10, limit: CLOUD_SYNC_LIMITS.pullEntities, cursorRevision: 0, cursorId: '' },
  )
  const window = normalizePullRequest({ since: 3, until: 999, serverRevision: 10 })
  assert.equal(window.until, 10)
  assert.equal(window.cursorRevision, 3)
  const withCursor = normalizePullRequest({
    since: 2,
    serverRevision: 10,
    cursor: encodeSyncCursor({ revision: 5, id: 'card-x' }),
    limit: 9999,
  })
  assert.equal(withCursor.cursorRevision, 5)
  assert.equal(withCursor.cursorId, 'card-x')
  assert.equal(withCursor.limit, CLOUD_SYNC_LIMITS.pullEntities)
  assert.equal(normalizePullRequest({ serverRevision: 10, limit: 0 }).limit, CLOUD_SYNC_LIMITS.pullEntities)
  assert.equal(normalizePullRequest({ serverRevision: 10, limit: 50 }).limit, 50)
  assert.throws(() => normalizePullRequest({ since: 11, serverRevision: 10 }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => normalizePullRequest({ since: 5, until: 3, serverRevision: 10 }), error => error.code === 'BAD_REQUEST')
  assert.throws(
    () => normalizePullRequest({ since: 6, cursor: encodeSyncCursor({ revision: 2, id: 'card-x' }), serverRevision: 10 }),
    error => error.code === 'BAD_REQUEST',
  )
})

// ---------------------------------------------------------------------------
// 6. Bearer 鉴权
// ---------------------------------------------------------------------------

test('parseBearerToken：大小写、空白、非法格式', () => {
  assert.equal(parseBearerToken('Bearer abc.def-123'), 'abc.def-123')
  assert.equal(parseBearerToken('  bearer   token123  '), 'token123')
  assert.equal(parseBearerToken('Basic abc'), null)
  assert.equal(parseBearerToken('Bearer'), null)
  assert.equal(parseBearerToken(''), null)
  assert.equal(parseBearerToken(undefined), null)
  assert.equal(parseBearerToken('Bearer a b'), null)
})

test('constantTimeEqual / verifyBearer：常量时间比较与 fail-closed', () => {
  assert.equal(constantTimeEqual('secret-token', 'secret-token'), true)
  assert.equal(constantTimeEqual('secret-token', 'secret-tokeN'), false)
  assert.equal(constantTimeEqual('short', 'a-much-longer-value'), false)

  assert.equal(verifyBearer('Bearer right-token', 'right-token').ok, true)
  assert.equal(verifyBearer('Bearer wrong-token', 'right-token').code, 'UNAUTHORIZED')
  assert.equal(verifyBearer(undefined, 'right-token').status, CLOUD_ERROR_STATUS.UNAUTHORIZED)
  // 服务端未配置令牌：fail-closed
  const misconfigured = verifyBearer('Bearer anything', '')
  assert.equal(misconfigured.ok, false)
  assert.equal(misconfigured.code, 'UNAVAILABLE')
  assert.equal(misconfigured.status, CLOUD_ERROR_STATUS.UNAVAILABLE)
  assert.equal(assertAuthorized('Bearer right-token', 'right-token'), undefined)
  assert.throws(
    () => assertAuthorized('Bearer nope', 'right-token'),
    error => error instanceof CloudSyncError && error.status === 401,
  )
  assert.throws(
    () => assertAuthorized('Bearer x', ''),
    error => error instanceof CloudSyncError && error.code === 'UNAVAILABLE' && error.status === 503,
  )
})

// ---------------------------------------------------------------------------
// 7. 入站：请求头白名单 / 去重 / 信封 / 回放请求 / 退避
// ---------------------------------------------------------------------------

test('filterIngressHeaders：只留白名单，敏感头与超长值丢弃，大小写归一', () => {
  const headers = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'issues',
    'X-GitHub-Delivery': 'delivery-1',
    'User-Agent': 'GitHub-Hookshot/abc',
    Authorization: 'Bearer secret',
    Cookie: 'a=b',
    'X-Hub-Signature-256': 'sha256=deadbeef',
    'X-Too-Long': 'x'.repeat(600),
  }
  const filtered = filterIngressHeaders(headers)
  assert.deepEqual(filtered, {
    'content-type': 'application/json',
    'x-github-event': 'issues',
    'x-github-delivery': 'delivery-1',
    'user-agent': 'GitHub-Hookshot/abc',
  })
  // 数组值 join；非白名单忽略
  assert.deepEqual(filterIngressHeaders({ 'X-Request-Id': ['a', 'b'], 'X-Nope': 'x' }), { 'x-request-id': 'a,b' })
  assert.deepEqual(filterIngressHeaders(undefined), {})
})

test('ingressDedupeKey / makeIngressId：投递 id 优先，缺失时按体哈希且确定性', () => {
  assert.equal(
    ingressDedupeKey({ provider: 'github', deliveryId: 'd-1', eventType: 'issues', payloadText: '{}' }),
    'github:delivery:d-1',
  )
  const byBodyA = ingressDedupeKey({ provider: 'feishu', eventType: 'im.message', payloadText: '{"a":1}' })
  const byBodyB = ingressDedupeKey({ provider: 'feishu', eventType: 'im.message', payloadText: '{"a":1}' })
  assert.equal(byBodyA, byBodyB)
  assert.match(byBodyA, /^feishu:body:[a-f0-9]{32}$/)
  assert.notEqual(byBodyA, ingressDedupeKey({ provider: 'dingtalk', eventType: 'im.message', payloadText: '{"a":1}' }))
  assert.notEqual(byBodyA, ingressDedupeKey({ provider: 'feishu', eventType: 'other', payloadText: '{"a":1}' }))

  const id = makeIngressId('github:delivery:d-1')
  assert.match(id, /^in-[a-f0-9]{16}$/)
  assert.equal(makeIngressId('github:delivery:d-1'), id)
  assert.notEqual(makeIngressId('github:delivery:d-2'), id)
})

test('normalizeIngressEnvelope：GitHub 信封字段、原始体保留、头白名单、TTL', () => {
  const rawBody = JSON.stringify({ action: 'opened', issue: { number: 7 } })
  const envelope = normalizeIngressEnvelope({
    provider: 'GitHub',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'delivery-1',
      Authorization: 'Bearer secret',
      'X-Hub-Signature-256': 'sha256=deadbeef',
    },
    payload: rawBody,
    now: 1000,
  })
  assert.equal(envelope.provider, 'github')
  assert.equal(envelope.eventType, 'issues')
  assert.equal(envelope.deliveryId, 'delivery-1')
  assert.equal(envelope.dedupeKey, 'github:delivery:delivery-1')
  assert.equal(envelope.id, makeIngressId('github:delivery:delivery-1'))
  assert.equal(envelope.payload, rawBody)
  assert.equal(envelope.payloadBytes, Buffer.byteLength(rawBody, 'utf8'))
  assert.equal(envelope.receivedAt, 1000)
  assert.equal(envelope.expiresAt, 1000 + CLOUD_SYNC_LIMITS.ingressTtlMs)
  assert.equal(envelope.status, 'pending')
  assert.equal(envelope.attempts, 0)
  assert.equal(envelope.headers.authorization, undefined)
  assert.equal(envelope.headers['x-hub-signature-256'], undefined)
  assert.equal(envelope.headers['x-github-event'], 'issues')
})

test('normalizeIngressEnvelope：对象入参自动序列化；飞书 challenge 可用', () => {
  const envelope = normalizeIngressEnvelope({
    provider: 'feishu',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-1' },
    payload: { challenge: 'abc', type: 'url_verification' },
    now: 5,
  })
  assert.equal(envelope.deliveryId, 'req-1')
  assert.equal(envelope.eventType, '')
  assert.deepEqual(JSON.parse(envelope.payload), { challenge: 'abc', type: 'url_verification' })
})

test('normalizeIngressEnvelope：非法来源/空体/非 JSON/数组/超限分别给错误码', () => {
  const base = { headers: { 'Content-Type': 'application/json' }, payload: '{"a":1}', now: 1 }
  assert.throws(() => normalizeIngressEnvelope({ ...base, provider: 'twitter' }), error => (
    error instanceof CloudSyncError && error.code === 'BAD_REQUEST' && error.status === 400
  ))
  assert.throws(() => normalizeIngressEnvelope({ ...base, provider: 'github', payload: '' }), error => error.code === 'BAD_REQUEST')
  assert.throws(() => normalizeIngressEnvelope({ ...base, provider: 'github', payload: 'not json' }), error => error.code === 'UNSUPPORTED_MEDIA_TYPE')
  assert.throws(() => normalizeIngressEnvelope({ ...base, provider: 'github', payload: '[1,2]' }), error => error.code === 'UNSUPPORTED_MEDIA_TYPE')
  assert.throws(
    () => normalizeIngressEnvelope({ ...base, provider: 'github', payload: '{"a":1}', maxBytes: 3 }),
    error => error instanceof CloudSyncError && error.code === 'PAYLOAD_TOO_LARGE' && error.status === 413,
  )
})

test('buildLocalIngressRequest：POST /api/kanban/ingress，GitHub 事件头透传', () => {
  const github = normalizeIngressEnvelope({
    provider: 'github',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'issue_comment', 'X-GitHub-Delivery': 'd-1' },
    payload: '{"action":"created"}',
    now: 1,
  })
  const request = buildLocalIngressRequest(github)
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/api/kanban/ingress')
  assert.equal(request.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(request.headers['x-github-event'], 'issue_comment')
  assert.equal(request.headers['x-kanban-ingress-id'], github.id)
  assert.equal(request.body, github.payload)
  assert.equal(request.inboxId, github.id)
  assert.equal(request.provider, 'github')

  const feishu = normalizeIngressEnvelope({
    provider: 'feishu', headers: { 'Content-Type': 'application/json' }, payload: '{"challenge":"x"}', now: 1,
  })
  const feishuRequest = buildLocalIngressRequest(feishu)
  assert.equal('x-github-event' in feishuRequest.headers, false)
  assert.equal(feishuRequest.headers['x-kanban-ingress-id'], feishu.id)
})

test('ingressBackoffMs / nextIngressAttempt / isIngressExpired：退避、置 dead、过期', () => {
  assert.equal(ingressBackoffMs(0), 1000)
  assert.equal(ingressBackoffMs(1), 2000)
  assert.equal(ingressBackoffMs(3), 8000)
  assert.equal(ingressBackoffMs(100), 5 * 60 * 1000)
  assert.equal(ingressBackoffMs(-5), 1000)

  const retry = nextIngressAttempt({ attempts: 0, maxAttempts: 20 }, { now: 1000, error: 'local 502' })
  assert.equal(retry.status, 'pending')
  assert.equal(retry.attempts, 1)
  assert.equal(retry.nextAttemptAt, 1000 + ingressBackoffMs(1))
  assert.equal(retry.retryable, true)
  assert.equal(retry.lastError, 'local 502')

  const dead = nextIngressAttempt({ attempts: 19, maxAttempts: 20 }, { now: 1000 })
  assert.equal(dead.status, 'dead')
  assert.equal(dead.attempts, 20)
  assert.equal(dead.retryable, false)
  assert.equal(dead.nextAttemptAt, 0)

  assert.equal(isIngressExpired({ expiresAt: 1000 }, 1000), true)
  assert.equal(isIngressExpired({ expiresAt: 1000 }, 999), false)
  assert.equal(isIngressExpired({ expiresAt: 0 }, 10_000), false)
})

// ---------------------------------------------------------------------------
// 8. cloud-config.json 校验与安全描述
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'a'.repeat(32)

test('normalizeCloudConfig：合法配置规范化与默认值', () => {
  const config = normalizeCloudConfig({
    enabled: true,
    workerUrl: 'https://dsh-kanban-sync.roxor.workers.dev/',
    token: VALID_TOKEN,
    clientId: 'macbook-roxor',
  })
  assert.equal(config.enabled, true)
  assert.equal(config.workerUrl, 'https://dsh-kanban-sync.roxor.workers.dev')
  assert.equal(config.token, VALID_TOKEN)
  assert.equal(config.clientId, 'macbook-roxor')
  assert.deepEqual(config.sync, { enabled: true, pushDebounceMs: 2000, pullIntervalMs: 30_000 })
  assert.deepEqual(config.ingress, { enabled: true, claimIntervalMs: 30_000, batchSize: 20, leaseSeconds: 120 })

  const loopback = normalizeCloudConfig({ enabled: true, workerUrl: 'http://127.0.0.1:8787', token: VALID_TOKEN })
  assert.equal(loopback.workerUrl, 'http://127.0.0.1:8787')

  const disabled = normalizeCloudConfig({ enabled: false })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.token, '')
  assert.equal(disabled.clientId, 'local-mac')
  assert.equal(disabled.sync.enabled, true)
})

test('normalizeCloudConfig：缺 token / 短 token / 非 https / 非法 URL / 超长 clientId 报 BAD_CONFIG', () => {
  const base = { enabled: true, workerUrl: 'https://x.workers.dev', token: VALID_TOKEN }
  const cases = [
    { ...base, token: '' },
    { ...base, token: 'short' },
    { ...base, workerUrl: '' },
    { ...base, workerUrl: 'http://example.com' },
    { ...base, workerUrl: 'not a url' },
    { ...base, clientId: 'c'.repeat(100) },
  ]
  for (const item of cases) {
    assert.throws(() => normalizeCloudConfig(item), error => (
      error instanceof CloudSyncError && error.code === 'BAD_CONFIG'
    ))
  }
})

test('normalizeCloudConfig：数值越界夹紧到安全区间', () => {
  const config = normalizeCloudConfig({
    enabled: true,
    workerUrl: 'https://x.workers.dev',
    token: VALID_TOKEN,
    sync: { pushDebounceMs: 5, pullIntervalMs: 999_999_999 },
    ingress: { batchSize: 999, leaseSeconds: 1, claimIntervalMs: 1 },
  })
  assert.equal(config.sync.pushDebounceMs, 200)
  assert.equal(config.sync.pullIntervalMs, 600_000)
  assert.equal(config.ingress.batchSize, CLOUD_SYNC_LIMITS.ingressBatch)
  assert.equal(config.ingress.leaseSeconds, 30)
  assert.equal(config.ingress.claimIntervalMs, 5000)
})

test('maskToken / describeCloudConfig：日志不会泄漏明文令牌', () => {
  assert.equal(maskToken(VALID_TOKEN), 'aaaa****aaaa')
  assert.equal(maskToken('short'), '****')
  assert.equal(maskToken(''), '')
  const config = normalizeCloudConfig({ enabled: true, workerUrl: 'https://x.workers.dev', token: VALID_TOKEN })
  const description = describeCloudConfig(config)
  assert.equal(JSON.stringify(description).includes(VALID_TOKEN), false)
  assert.equal(description.token, 'aaaa****aaaa')
  assert.equal(description.workerUrl, 'https://x.workers.dev')
})

// ---------------------------------------------------------------------------
// 9. 协议版本与统一错误响应
// ---------------------------------------------------------------------------

test('assertProtocolVersion：缺省=当前版本，异版本报 UNSUPPORTED_PROTOCOL_VERSION', () => {
  assert.equal(assertProtocolVersion(undefined), 1)
  assert.equal(assertProtocolVersion(1), 1)
  assert.throws(
    () => assertProtocolVersion(2),
    error => error instanceof CloudSyncError && error.code === 'UNSUPPORTED_PROTOCOL_VERSION' && error.status === 400,
  )
})

test('CloudSyncError / toErrorResponse：状态码映射、details 保留、未知异常不泄露细节', () => {
  const error = new CloudSyncError('REVISION_CONFLICT', '版本冲突', { details: { serverRevision: 9 } })
  assert.equal(error.status, 409)
  assert.deepEqual(error.toJSON(), {
    ok: false,
    error: { code: 'REVISION_CONFLICT', message: '版本冲突', details: { serverRevision: 9 } },
  })
  const response = toErrorResponse(error, { requestId: 'req-1' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'REVISION_CONFLICT')
  assert.equal(response.requestId, 'req-1')

  const unexpected = toErrorResponse(new Error('数据库连接串 postgres://secret'))
  assert.equal(unexpected.ok, false)
  assert.equal(unexpected.error.code, 'INTERNAL')
  assert.equal(JSON.stringify(unexpected).includes('postgres://secret'), false)
  assert.equal(new CloudSyncError('BAD_REQUEST', 'x').status, 400)
  assert.equal(new CloudSyncError('UNKNOWN_CODE', 'x').status, 400)
})
