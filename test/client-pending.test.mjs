// lib/client.js 的 iframe 桥：原生待确认收件（契约 docs/contracts/04-native-inbox.md）的父页面半边。
// 用 vm 在 Node 里加载真实客户端文件（它只调用 window.__ModuleLoader__.load({id, factory})），
// fake 出 DSH 客户端环境：浏览器全局、React、cordis ctx 与 uiSession 投影。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ORIGIN = 'http://127.0.0.1:64545'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  throw new Error('等待超时：条件在 ' + timeoutMs + 'ms 内没有满足')
}

// ---- 浏览器全局替身 ----
function makeElement(overrides = {}) {
  return {
    dataset: {},
    attributes: {},
    style: {},
    hasAttribute: () => false,
    getAttribute: () => null,
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    remove() {},
    ...overrides,
  }
}

const fakeReact = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
  useRef(initialValue) {
    // 看板面板的 iframe ref 在测试里直接指向假 iframe，让 bridge.attach 生效。
    return { current: initialValue === null || initialValue === undefined ? activeFrame : initialValue }
  },
  useEffect(effect) {
    const cleanup = effect()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    return () => {}
  },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
}

let activeFrame = null
let effectCleanups = []

function fakeRequire(id) {
  if (id === 'react') return fakeReact
  if (id === 'react/jsx-runtime') {
    return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: 'Fragment' }
  }
  throw new Error('测试没有为 require("' + id + '") 准备替身')
}

// ---- uiSession / sessions 替身 ----
function makeUiSession() {
  const state = { snapshot: new Map() }
  const listeners = new Set()
  return {
    service: {
      sessionStatus: {
        getSnapshot: () => state.snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    },
    listeners,
    setSnapshot(snapshot) { state.snapshot = snapshot instanceof Map ? snapshot : new Map(snapshot || []) },
    notify() { for (const listener of [...listeners]) listener() },
  }
}

function makeSessions(rows = []) {
  const ids = []
  const byId = {}
  for (const row of rows) {
    const id = row.id ?? row.sessionId
    ids.push(id)
    byId[id] = {
      id,
      displayTitle: row.title ?? row.displayTitle,
      running: Boolean(row.running),
      updatedAt: 0,
    }
  }
  const snapshot = { ids, byId, phase: 'ready', current: null }
  return {
    service: {
      list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      refresh: async () => {},
    },
    snapshot,
  }
}

// ---- 每个用例一套独立环境 ----
function createEnvironment({ uiSession = makeUiSession(), sessions = makeSessions() } = {}) {
  const messages = []
  const listeners = new Map()
  const iframe = { contentWindow: { postMessage(message) { messages.push(message) } } }
  const registrations = []
  const windowStub = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    __ModuleLoader__: { load(definition) { capturedDefinition = definition } },
    __DSH_KANBAN__: undefined,
  }
  const documentStub = {
    body: makeElement(),
    documentElement: makeElement(),
    head: { appendChild() {} },
    getElementById: () => null,
    querySelector: () => null,
    createElement: (tagName) => makeElement({ tagName, id: '', textContent: '' }),
  }
  return {
    messages,
    listeners,
    iframe,
    registrations,
    window: windowStub,
    document: documentStub,
    uiSession,
    sessions,
    pendingMessages() { return messages.filter((message) => message?.type === 'kanban:pending') },
    lastPending() {
      const pending = this.pendingMessages()
      return pending[pending.length - 1]
    },
    responses(requestId) {
      return messages.filter((message) => message?.type === 'kanban:response' && message.requestId === requestId)
    },
    dispatch(data, overrides = {}) {
      const event = {
        origin: overrides.origin ?? ORIGIN,
        source: overrides.source ?? iframe.contentWindow,
        data,
      }
      for (const listener of [...(listeners.get('message') ?? [])]) listener(event)
    },
  }
}

function installGlobals(env) {
  const setGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  setGlobal('window', env.window)
  setGlobal('document', env.document)
  setGlobal('location', { origin: ORIGIN })
  setGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  setGlobal('requestAnimationFrame', () => 1)
  setGlobal('cancelAnimationFrame', () => {})
  setGlobal('MutationObserver', class { observe() {} disconnect() {} })
  setGlobal('sessionStorage', { getItem: () => null, setItem() {} })
}

function createFakeContext(env) {
  const disposers = []
  const ctx = {
    effect(effect) {
      const disposer = effect()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    inject(services, callback) {
      // 模拟旧版宿主：没有 uiSession 服务时 inject 不回调，父页面也就不推送待确认。
      if (services.includes('uiSession') && !env.uiSession) return () => {}
      callback(ctx)
      return () => {}
    },
    slots: {
      inject(_name, register) { register() },
      register(config, component) { env.registrations.push({ config, component }); return () => {} },
    },
    locale: { register() { return () => {} } },
    layout: { selectPanel() {} },
    sessions: env.sessions.service,
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    uiWorkspace: { openSession() {} },
    theme: { getTheme: () => ({ id: 'light' }), setTheme() {} },
    uiSession: env.uiSession ? env.uiSession.service : undefined,
  }
  ctx.dispose = () => {
    for (const disposer of disposers.reverse()) {
      try { disposer() } catch { /* 清理失败不影响断言 */ }
    }
  }
  return ctx
}

function mountPanel(env) {
  const registered = env.registrations.find((entry) => entry.config?.name === 'main' && entry.config?.key === 'kanban')
  assert.ok(registered, '看板面板应注册到 main 插槽')
  activeFrame = env.iframe
  effectCleanups = []
  registered.component({})
  activeFrame = null
  const cleanups = effectCleanups
  effectCleanups = []
  return {
    cleanup() {
      for (const cleanup of cleanups.reverse()) {
        try { cleanup() } catch { /* 卸载失败不影响断言 */ }
      }
    },
  }
}

function setup(t, options = {}) {
  const env = createEnvironment(options)
  installGlobals(env)
  const ctx = createFakeContext(env)
  clientModule.apply(ctx)
  let panel = null
  t.after(() => {
    panel?.cleanup()
    ctx.dispose()
  })
  panel = mountPanel(env)
  return env
}

/** 执行 action 后等一次新的 kanban:pending 推送（250ms 节流，最后一次必发）。 */
async function nextPendingPush(env, action) {
  const before = env.pendingMessages().length
  action()
  return waitFor(() => {
    const pending = env.pendingMessages()
    return pending.length > before ? pending[pending.length - 1] : null
  })
}

function requestMessage({ requestId, method, params }) {
  return { version: 1, type: 'kanban:request', requestId, method, params }
}

async function responseFor(env, requestId) {
  return waitFor(() => {
    const responses = env.responses(requestId)
    return responses.length ? responses[responses.length - 1] : null
  })
}

// ---- 宿主对象替身 ----
function makeApproval({
  sessionId = 's1',
  key = 'approval:1',
  toolName = 'bash',
  callId,
  reason,
  displayReason,
  answerable = true,
  answerError,
} = {}) {
  const calls = []
  const pending = {
    sessionId,
    kind: 'approval',
    key,
    toolName,
    ...(callId === undefined ? {} : { callId }),
    ...(reason === undefined ? {} : { reason }),
    ...(displayReason === undefined ? {} : { displayReason }),
    get answerable() { return answerable },
    async answer(outcome) {
      calls.push(outcome)
      if (answerError) throw answerError
    },
  }
  return { pending, calls }
}

function makeQuestion({
  sessionId = 's1',
  kind = 'question',
  key = 'question:s1:call-1',
  questions = [{ id: 'q1', question: '要继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
  callId,
  dismissal = 'hide',
  state = 'open',
  channel = 'waterfall',
  closed = false,
  countdown,
  review,
  answerError,
  dismissError,
} = {}) {
  const calls = { answers: [], dismissed: 0 }
  const subscribers = new Set()
  const control = {
    snap: {
      state,
      waitState: state === 'continued' ? 'continued' : 'counting',
      channel,
      closed,
      ...(countdown === undefined ? {} : { countdown }),
    },
  }
  const pending = {
    sessionId,
    kind,
    key,
    questions,
    dismissal,
    ...(callId === undefined ? {} : { callId }),
    ...(review === undefined ? {} : { review }),
    snapshot() { return control.snap },
    subscribe(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    async answer(payload) {
      calls.answers.push(payload)
      if (answerError) throw answerError
    },
    async dismiss() {
      calls.dismissed += 1
      if (dismissError) throw dismissError
    },
  }
  return { pending, calls, control, subscribers, tick: () => { for (const listener of [...subscribers]) listener() } }
}

// ================= 启动真实客户端文件 =================
// 全局替身需要在加载/执行 lib/client.js 前就位（它只调用 window.__ModuleLoader__.load）。
const ORIGINAL_GLOBALS = new Map()
for (const name of [
  'window', 'document', 'location', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'sessionStorage',
]) {
  ORIGINAL_GLOBALS.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
}

let capturedDefinition = null
const baseEnvironment = createEnvironment()
installGlobals(baseEnvironment)
const source = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
vm.runInThisContext(source, { filename: join(ROOT, 'lib', 'client.js') })
assert.ok(capturedDefinition, 'lib/client.js 应通过 window.__ModuleLoader__.load 注册模块')
const clientModule = capturedDefinition.factory(fakeRequire)
const diagnostics = baseEnvironment.window.__DSH_KANBAN__

after(() => {
  for (const [name, descriptor] of ORIGINAL_GLOBALS) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

// ================= 推送：attach / ready =================
test('面板 attach 时推送 host/theme/sessions 与空的待确认快照', (t) => {
  const env = setup(t)
  const types = env.messages.map((message) => message?.type)
  for (const type of ['kanban:host', 'kanban:theme', 'kanban:sessions']) {
    assert.ok(types.includes(type), 'attach 后应有 ' + type + ' 推送，实际：' + types.join(','))
  }
  const pending = env.lastPending()
  assert.ok(pending, 'attach 后应推送 kanban:pending（空数组 = 宿主支持但没有待确认）')
  assert.equal(pending.version, 1)
  assert.deepEqual(pending.items, [])
  assert.equal(typeof pending.at, 'number')
  assert.equal(diagnostics.pendingCount, 0)
  assert.deepEqual(diagnostics.errors, [], '桥接不应记录错误：' + JSON.stringify(diagnostics.errors))
})

test('页面 kanban:ready 时补推一次待确认快照', (t) => {
  const env = setup(t)
  const before = env.pendingMessages().length
  env.dispatch({ version: 1, type: 'kanban:ready' })
  assert.equal(env.pendingMessages().length, before + 1)
})

// ================= 推送：审批 =================
test('审批项：answerable 的审批带原因/展示文案与会话标题，不可答项被过滤', async (t) => {
  const env = setup(t, {
    sessions: makeSessions([
      { id: 's1', title: '审批会话', running: true },
      { id: 's2', title: '第二个会话', running: false },
    ]),
  })
  const approval = makeApproval({
    sessionId: 's1',
    key: 'approval:1',
    toolName: 'bash',
    callId: 'call-7',
    reason: 'escalate sandbox to workspace-write: 需要写入网络配置',
    displayReason: { zh: '申请放宽到 workspace-write', en: 'Request workspace-write' },
  })
  const blocked = makeApproval({ sessionId: 's2', key: 'approval:2', answerable: false })

  const pending = await nextPendingPush(env, () => {
    env.uiSession.setSnapshot(new Map([
      ['s1', { running: true, pendingInteraction: approval.pending, completionUnread: false }],
      ['s2', { running: false, pendingInteraction: blocked.pending, completionUnread: false }],
    ]))
    env.uiSession.notify()
  })
  assert.equal(pending.items.length, 1, 'answerable=false 的审批不应出现')
  const item = pending.items[0]
  assert.equal(item.kind, 'approval')
  assert.equal(item.sessionId, 's1')
  assert.equal(item.key, 'approval:1')
  assert.equal(item.toolName, 'bash')
  assert.equal(item.callId, 'call-7')
  assert.equal(item.reason, 'escalate sandbox to workspace-write: 需要写入网络配置')
  assert.deepEqual(item.displayReason, { zh: '申请放宽到 workspace-write', en: 'Request workspace-write' })
  assert.equal(item.sessionTitle, '审批会话')
  assert.equal(item.sessionRunning, true)
  assert.equal(typeof item.observedAt, 'number')
  assert.equal(diagnostics.pendingCount, 1)

  // observedAt 首次观测后保持不变（用于稳定排序）。
  const observedAt = item.observedAt
  const next = await nextPendingPush(env, () => env.uiSession.notify())
  assert.equal(next.items[0].observedAt, observedAt)
})

test('排序：审批 → 计划审批 → 提问，同组按 observedAt/key 升序', async (t) => {
  const env = setup(t, {
    sessions: makeSessions([
      { id: 's1', title: '一' },
      { id: 's2', title: '二' },
      { id: 's3', title: '三' },
    ]),
  })
  const approval = makeApproval({ sessionId: 's1', key: 'approval:1' })
  const plan = makeQuestion({
    sessionId: 's2',
    kind: 'plan-review',
    key: 'question:s2:call-2',
    callId: 'call-2',
    questions: [{
      id: 'p1',
      question: '执行计划？',
      options: [{ label: '同意' }, { label: '修改' }],
      intent: { kind: 'plan-review', approve: '同意' },
      detail: '# 计划',
    }],
  })
  const question = makeQuestion({ sessionId: 's3', kind: 'question', key: 'question:s3:call-3', callId: 'call-3' })

  const pending = await nextPendingPush(env, () => {
    env.uiSession.setSnapshot(new Map([
      ['s1', { pendingInteraction: approval.pending }],
      ['s2', { pendingInteraction: plan.pending }],
      ['s3', { pendingInteraction: question.pending }],
    ]))
    env.uiSession.notify()
  })
  assert.deepEqual(pending.items.map((item) => item.kind), ['approval', 'plan-review', 'question'])
  assert.deepEqual(pending.items.map((item) => item.sessionId), ['s1', 's2', 's3'])
})

// ================= 推送：提问 =================
test('提问项：questions 原样透传（含 intent/detail），排除 review 与 closed，倒计时推送重推', async (t) => {
  const env = setup(t, { sessions: makeSessions([{ id: 's1', title: '计划会话', running: true }]) })
  const questions = [{
    id: 'q1',
    question: '要按计划执行吗？',
    header: '计划审批',
    options: [{ label: '同意并执行' }, { label: '要求修改', description: '回到输入框继续聊' }],
    multiSelect: false,
    intent: { kind: 'plan-review', approve: '同意并执行', callId: 'call-9' },
    detail: '# 计划\n\n- 第一步',
  }]
  const planned = makeQuestion({
    sessionId: 's1',
    kind: 'plan-review',
    key: 'question:s1:call-9',
    callId: 'call-9',
    questions,
    dismissal: 'hide',
    state: 'open',
    channel: 'waterfall',
    countdown: { remainingMs: 60000, running: true },
  })
  const reviewed = makeQuestion({ sessionId: 's1', kind: 'question', key: 'question:s1:call-10', callId: 'call-10', review: { answers: [] } })
  const closed = makeQuestion({ sessionId: 's1', kind: 'question', key: 'question:s1:call-11', callId: 'call-11', closed: true })

  let pending = await nextPendingPush(env, () => {
    env.uiSession.setSnapshot(new Map([['s1', { running: true, pendingInteraction: planned.pending }]]))
    env.uiSession.notify()
  })
  assert.equal(pending.items.length, 1)
  let item = pending.items[0]
  assert.equal(item.kind, 'plan-review')
  assert.equal(item.sessionId, 's1')
  assert.equal(item.key, 'question:s1:call-9')
  assert.equal(item.callId, 'call-9')
  assert.deepEqual(item.questions, questions)
  assert.deepEqual(item.questions[0].intent, { kind: 'plan-review', approve: '同意并执行', callId: 'call-9' })
  assert.equal(item.questions[0].detail, '# 计划\n\n- 第一步')
  assert.equal(item.state, 'open')
  assert.equal(item.channel, 'waterfall')
  assert.deepEqual(item.countdown, { remainingMs: 60000, running: true })
  assert.equal(item.dismissal, 'hide')
  assert.equal(item.sessionTitle, '计划会话')
  assert.equal(planned.subscribers.size, 1, '应订阅提问对象自身的倒计时 publish')

  // 提问对象 tick（倒计时每秒 publish）→ 节流后重推新快照。
  planned.control.snap = { ...planned.control.snap, countdown: { remainingMs: 59000, running: true } }
  pending = await nextPendingPush(env, () => planned.tick())
  item = pending.items[0]
  assert.deepEqual(item.countdown, { remainingMs: 59000, running: true })

  // 已结算的只读回放卡片（review !== undefined）不镜像。
  pending = await nextPendingPush(env, () => {
    env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: reviewed.pending }]]))
    env.uiSession.notify()
  })
  assert.deepEqual(pending.items, [])
  assert.equal(planned.subscribers.size, 0, '对象消失后应取消倒计时订阅')

  // snapshot().closed === true 的提问不镜像。
  pending = await nextPendingPush(env, () => {
    env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: closed.pending }]]))
    env.uiSession.notify()
  })
  assert.deepEqual(pending.items, [])
})

// ================= 请求：审批作答 =================
test('pending.answerApproval：透传 outcome 并回复 {ok:true}', async (t) => {
  const env = setup(t)
  const approval = makeApproval({ sessionId: 's1', key: 'approval:1' })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: approval.pending }]]))
  env.dispatch(requestMessage({
    requestId: 'r1',
    method: 'pending.answerApproval',
    params: { sessionId: 's1', key: 'approval:1', outcome: 'allowed-once' },
  }))
  const response = await responseFor(env, 'r1')
  assert.equal(response.ok, true)
  assert.deepEqual(response.data, { ok: true })
  assert.deepEqual(approval.calls, ['allowed-once'])
})

test('pending.answerApproval：找不到 → PENDING_NOT_FOUND，不可答 → PENDING_UNANSWERABLE，宿主抛错 → PENDING_ANSWER_FAILED', async (t) => {
  const env = setup(t)

  env.dispatch(requestMessage({
    requestId: 'r2',
    method: 'pending.answerApproval',
    params: { sessionId: 's1', key: 'approval:1', outcome: 'rejected' },
  }))
  let response = await responseFor(env, 'r2')
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'PENDING_NOT_FOUND')

  const blocked = makeApproval({ sessionId: 's1', key: 'approval:2', answerable: false })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: blocked.pending }]]))
  env.dispatch(requestMessage({
    requestId: 'r3',
    method: 'pending.answerApproval',
    params: { sessionId: 's1', key: 'approval:2', outcome: 'rejected' },
  }))
  response = await responseFor(env, 'r3')
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'PENDING_UNANSWERABLE')
  assert.deepEqual(blocked.calls, [])

  const failing = makeApproval({
    sessionId: 's1',
    key: 'approval:3',
    answerError: new Error('宿主拒绝了这次审批：请求已撤回'),
  })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: failing.pending }]]))
  env.dispatch(requestMessage({
    requestId: 'r4',
    method: 'pending.answerApproval',
    params: { sessionId: 's1', key: 'approval:3', outcome: 'rejected' },
  }))
  response = await responseFor(env, 'r4')
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'PENDING_ANSWER_FAILED')
  assert.equal(response.error.message, '宿主拒绝了这次审批：请求已撤回')
})

// ================= 请求：提问作答 =================
test('pending.answerQuestion：合法 answers 原样透传并回复 {ok:true}', async (t) => {
  const env = setup(t)
  const question = makeQuestion({ sessionId: 's1', key: 'question:s1:call-1', callId: 'call-1' })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: question.pending }]]))
  const answers = [
    { id: 'q1', selected: ['继续'], custom: '记得先备份' },
    { id: 'q2', selected: [] },
  ]
  env.dispatch(requestMessage({
    requestId: 'r5',
    method: 'pending.answerQuestion',
    params: { sessionId: 's1', key: 'question:s1:call-1', answers },
  }))
  const response = await responseFor(env, 'r5')
  assert.equal(response.ok, true)
  assert.deepEqual(response.data, { ok: true })
  assert.deepEqual(question.calls.answers, [{ answers }])
})

test('pending.answerQuestion：参数非法 → BAD_REQUEST，channel=none/closed → PENDING_UNANSWERABLE', async (t) => {
  const env = setup(t)
  const question = makeQuestion({ sessionId: 's1', key: 'question:s1:call-1', callId: 'call-1' })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: question.pending }]]))

  const badRequests = [
    { requestId: 'r6', answers: [] },
    { requestId: 'r7', answers: [{ selected: ['继续'] }] },
    { requestId: 'r8', answers: [{ id: 'q1', selected: '继续' }] },
    { requestId: 'r9', answers: [{ id: 'q1', selected: ['继续'], custom: 42 }] },
  ]
  for (const { requestId, answers } of badRequests) {
    env.dispatch(requestMessage({
      requestId,
      method: 'pending.answerQuestion',
      params: { sessionId: 's1', key: 'question:s1:call-1', answers },
    }))
    const response = await responseFor(env, requestId)
    assert.equal(response.ok, false, requestId + ' 应被拒绝')
    assert.equal(response.error.code, 'BAD_REQUEST', requestId + ' 的 code')
  }
  assert.deepEqual(question.calls.answers, [], '参数非法时不应调用宿主 answer')

  for (const [requestId, snap] of [
    ['r10', { state: 'open', channel: 'none', closed: false }],
    ['r11', { state: 'open', channel: 'waterfall', closed: true }],
  ]) {
    question.control.snap = snap
    env.dispatch(requestMessage({
      requestId,
      method: 'pending.answerQuestion',
      params: { sessionId: 's1', key: 'question:s1:call-1', answers: [{ id: 'q1', selected: ['继续'] }] },
    }))
    const response = await responseFor(env, requestId)
    assert.equal(response.ok, false, requestId + ' 应被拒绝')
    assert.equal(response.error.code, 'PENDING_UNANSWERABLE', requestId + ' 的 code')
  }
  assert.deepEqual(question.calls.answers, [], '不可答时不应调用宿主 answer')
})

// ================= 请求：关闭 =================
test('pending.dismiss：调用宿主 dismiss() 并回复 {ok:true}', async (t) => {
  const env = setup(t)
  const question = makeQuestion({ sessionId: 's1', key: 'question:s1:call-1', callId: 'call-1', dismissal: 'cancel' })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: question.pending }]]))
  env.dispatch(requestMessage({
    requestId: 'r12',
    method: 'pending.dismiss',
    params: { sessionId: 's1', key: 'question:s1:call-1' },
  }))
  const response = await responseFor(env, 'r12')
  assert.equal(response.ok, true)
  assert.deepEqual(response.data, { ok: true })
  assert.equal(question.calls.dismissed, 1)
})

test('pending.dismiss：找不到 → PENDING_NOT_FOUND，宿主抛错 → PENDING_ANSWER_FAILED', async (t) => {
  const env = setup(t)
  env.dispatch(requestMessage({
    requestId: 'r13',
    method: 'pending.dismiss',
    params: { sessionId: 's1', key: 'question:s1:nope' },
  }))
  let response = await responseFor(env, 'r13')
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'PENDING_NOT_FOUND')

  const failing = makeQuestion({
    sessionId: 's1',
    key: 'question:s1:call-1',
    callId: 'call-1',
    dismissError: new Error('没有可取消的请求通道'),
  })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: failing.pending }]]))
  env.dispatch(requestMessage({
    requestId: 'r14',
    method: 'pending.dismiss',
    params: { sessionId: 's1', key: 'question:s1:call-1' },
  }))
  response = await responseFor(env, 'r14')
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'PENDING_ANSWER_FAILED')
  assert.equal(response.error.message, '没有可取消的请求通道')
})

// ================= 定位与安全 =================
test('sessionId / key / kind 不匹配时不会触碰宿主对象', async (t) => {
  const env = setup(t)
  const approval = makeApproval({ sessionId: 's1', key: 'approval:1' })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: approval.pending }]]))

  const mismatches = [
    { requestId: 'm1', method: 'pending.answerApproval', params: { sessionId: 's2', key: 'approval:1', outcome: 'rejected' } },
    { requestId: 'm2', method: 'pending.answerApproval', params: { sessionId: 's1', key: 'approval:9', outcome: 'rejected' } },
    { requestId: 'm3', method: 'pending.answerQuestion', params: { sessionId: 's1', key: 'approval:1', answers: [{ id: 'q1', selected: [] }] } },
    { requestId: 'm4', method: 'pending.dismiss', params: { sessionId: 's1', key: 'bad-key' } },
  ]
  for (const { requestId, method, params } of mismatches) {
    env.dispatch(requestMessage({ requestId, method, params }))
    const response = await responseFor(env, requestId)
    assert.equal(response.ok, false, requestId + ' 应失败')
    assert.equal(response.error.code, 'PENDING_NOT_FOUND', requestId + ' 的 code')
  }
  assert.deepEqual(approval.calls, [], '不匹配时不应调用宿主 answer')
})

test('不同源或非 iframe 来源的消息被忽略', async (t) => {
  const env = setup(t)
  const approval = makeApproval({ sessionId: 's1', key: 'approval:1' })
  env.uiSession.setSnapshot(new Map([['s1', { pendingInteraction: approval.pending }]]))
  const message = requestMessage({
    requestId: 'sec1',
    method: 'pending.answerApproval',
    params: { sessionId: 's1', key: 'approval:1', outcome: 'allowed-once' },
  })

  env.dispatch(message, { origin: 'http://evil.example' })
  env.dispatch(message, { source: {} })
  await sleep(40)
  assert.equal(env.responses('sec1').length, 0, '异源/非 iframe 的消息不应得到响应')
  assert.deepEqual(approval.calls, [])

  env.dispatch(message)
  const response = await responseFor(env, 'sec1')
  assert.equal(response.ok, true)
  assert.deepEqual(approval.calls, ['allowed-once'])
})

// ================= 降级：旧版宿主没有 uiSession =================
test('宿主没有 uiSession 服务时不推送 kanban:pending（iframe 保持 pendingSupport=false）', (t) => {
  const env = setup(t, { uiSession: null })
  const types = env.messages.map((message) => message?.type)
  assert.ok(types.includes('kanban:host'))
  assert.ok(types.includes('kanban:sessions'))
  assert.equal(env.pendingMessages().length, 0, '不支持时不应推送 kanban:pending')
  assert.equal(diagnostics.pendingCount, 0)
})
