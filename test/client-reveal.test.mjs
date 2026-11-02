// lib/client.js 的 iframe 桥：工作副本「在 Finder 中打开」（契约 docs/contracts/03-client-bridge.md §8）
// 的父页面半边。用 vm 在 Node 里加载真实客户端文件（它只调用 window.__ModuleLoader__.load({id, factory})），
// fake 出 DSH 客户端环境：浏览器全局、React、cordis ctx 与 client Remote。
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

let activeFrame = null
let effectCleanups = []

const fakeReact = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
  useRef(initialValue) {
    if (initialValue === null || initialValue === undefined) return { current: activeFrame }
    return { current: initialValue }
  },
  useEffect(effect) {
    const cleanup = effect()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    return () => {}
  },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
}

function fakeRequire(id) {
  if (id === 'react') return fakeReact
  if (id === 'react/jsx-runtime') {
    return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: 'Fragment' }
  }
  throw new Error('测试没有为 require("' + id + '") 准备替身')
}

// ---- 宿主对象替身 ----
/** 假的 DSH client Remote：只实现契约 03 §8 用到的 session 方法。 */
function makeRemote({ available = true, openResult, openError } = {}) {
  const calls = { canOpen: 0, open: [] }
  const session = {
    async canOpenWorkspacePath() {
      calls.canOpen += 1
      // Client Remote 的真实形状是 {ok,value}；旧宿主若直返布尔也接受。
      return available === 'raw' ? true : { ok: true, value: available }
    },
    async openWorkspacePath(request) {
      calls.open.push(request)
      if (openError) throw openError
      return openResult ?? { ok: true, value: { opened: true } }
    },
  }
  return { service: { session }, calls }
}

// ---- 每个用例一套独立环境 ----
function createEnvironment({ remote = makeRemote() } = {}) {
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
  return {
    messages,
    listeners,
    iframe,
    registrations,
    remote,
    window: windowStub,
    document: {
      body: makeElement(),
      documentElement: makeElement(),
      head: { appendChild() {} },
      getElementById: () => null,
      querySelector: () => null,
      createElement: (tagName) => makeElement({ tagName, id: '', textContent: '' }),
    },
    responses(requestId) {
      return messages.filter((message) => message?.type === 'kanban:response' && message.requestId === requestId)
    },
    dispatch(data, overrides = {}) {
      const event = { origin: overrides.origin ?? ORIGIN, source: overrides.source ?? iframe.contentWindow, data }
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
      // 模拟旧版宿主：没有 remote 服务时 inject 不回调（看板能力探测即返回 false）。
      if (services.includes('remote') && !env.remote) return () => {}
      callback(ctx)
      return () => {}
    },
    slots: {
      inject(_name, register) { register() },
      register(config, component) { env.registrations.push({ config, component }); return () => {} },
    },
    locale: { register() { return () => {} } },
    layout: { selectPanel() {} },
    sessions: {
      list: { getSnapshot: () => ({ ids: [], byId: {}, current: null }), subscribe: () => () => {} },
      refresh: async () => {},
    },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    uiWorkspace: { openSession() {} },
    theme: { getTheme: () => ({ id: 'light' }), setTheme() {} },
    remote: env.remote ? env.remote.service : undefined,
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
  // 进入嵌入模式（客户端只在 embedded 时允许发起桥请求）。
  env.dispatch({ version: 1, type: 'kanban:host', locale: 'zh', insets: { top: 0, leading: 0 } })
  return env
}

function requestMessage({ requestId, method, params }) {
  return { version: 1, type: 'kanban:request', requestId, method, ...(params === undefined ? {} : { params }) }
}

async function responseFor(env, requestId) {
  return waitFor(() => {
    const responses = env.responses(requestId)
    return responses.length ? responses[responses.length - 1] : null
  })
}

async function call(env, method, params) {
  const requestId = 'req-' + Math.random().toString(16).slice(2)
  env.dispatch(requestMessage({ requestId, method, params }))
  return responseFor(env, requestId)
}

// ================= 启动真实客户端文件 =================
const ORIGINAL_GLOBALS = new Map()
for (const name of [
  'window', 'document', 'location', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'sessionStorage',
]) {
  ORIGINAL_GLOBALS.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
}

let capturedDefinition = null
installGlobals(createEnvironment())
const source = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
vm.runInThisContext(source, { filename: join(ROOT, 'lib', 'client.js') })
assert.ok(capturedDefinition, 'lib/client.js 应通过 window.__ModuleLoader__.load 注册模块')
const clientModule = capturedDefinition.factory(fakeRequire)

after(() => {
  for (const [name, descriptor] of ORIGINAL_GLOBALS) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

// ================= 能力探测 =================
test('host.capabilities：宿主支持时返回 revealPath=true', async (t) => {
  const env = setup(t)
  const response = await call(env, 'host.capabilities')
  assert.equal(response.ok, true, JSON.stringify(response))
  assert.deepEqual(response.data, { revealPath: true })
  assert.equal(env.remote.calls.canOpen, 1)
})

test('host.capabilities：旧版宿主没有 remote 服务时返回 revealPath=false（不报错）', async (t) => {
  const env = setup(t, { remote: null })
  const response = await call(env, 'host.capabilities')
  assert.equal(response.ok, true, JSON.stringify(response))
  assert.deepEqual(response.data, { revealPath: false })
})

test('host.capabilities：桌面不可用（canOpenWorkspacePath=false）时返回 false', async (t) => {
  const env = setup(t, { remote: makeRemote({ available: false }) })
  const response = await call(env, 'host.capabilities')
  assert.deepEqual(response.data, { revealPath: false })
})

test('host.capabilities：旧宿主直接返回布尔 true 也按支持处理', async (t) => {
  const env = setup(t, { remote: makeRemote({ available: 'raw' }) })
  const response = await call(env, 'host.capabilities')
  assert.deepEqual(response.data, { revealPath: true })
})

test('host.capabilities：能力成功结果有缓存（30s 内不重复探测）', async (t) => {
  const env = setup(t)
  await call(env, 'host.capabilities')
  await call(env, 'host.capabilities')
  assert.equal(env.remote.calls.canOpen, 1)
})

// ================= 在 Finder 中打开 =================
test('host.revealPath：调用宿主 openWorkspacePath({path, action:"reveal"})', async (t) => {
  const env = setup(t)
  const path = '/Users/roxor/Desktop/dsh/dsh kanban'
  const response = await call(env, 'host.revealPath', { path })
  assert.equal(response.ok, true, JSON.stringify(response))
  assert.deepEqual(response.data, { ok: true })
  assert.deepEqual(env.remote.calls.open, [{ path, action: 'reveal' }])
})

test('host.revealPath：Windows 盘符绝对路径同样接受', async (t) => {
  const env = setup(t)
  const response = await call(env, 'host.revealPath', { path: 'C:\\work\\repo-wt' })
  assert.equal(response.ok, true, JSON.stringify(response))
  assert.deepEqual(env.remote.calls.open, [{ path: 'C:\\work\\repo-wt', action: 'reveal' }])
})

test('host.revealPath：旧版宿主没有 remote 时返回 REVEAL_UNAVAILABLE 且不发起调用', async (t) => {
  const env = setup(t, { remote: null })
  const response = await call(env, 'host.revealPath', { path: '/tmp/wt' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'REVEAL_UNAVAILABLE')
})

test('host.revealPath：桌面不可用时返回 REVEAL_UNAVAILABLE 且不发起打开', async (t) => {
  const env = setup(t, { remote: makeRemote({ available: false }) })
  const response = await call(env, 'host.revealPath', { path: '/tmp/wt' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'REVEAL_UNAVAILABLE')
  assert.deepEqual(env.remote.calls.open, [])
})

test('host.revealPath：权限边界拒绝相对路径 / 含 .. / 空值 / 非字符串', async (t) => {
  const env = setup(t)
  for (const params of [
    { path: 'tmp/wt' },
    { path: '' },
    { path: '/tmp/../etc' },
    { path: '/tmp/\u0000wt' },
    { path: 42 },
    {},
  ]) {
    const response = await call(env, 'host.revealPath', params)
    assert.equal(response.ok, false, JSON.stringify(params))
    assert.equal(response.error.code, 'REVEAL_BAD_PATH', JSON.stringify(params))
  }
  assert.deepEqual(env.remote.calls.open, [])
})

test('host.revealPath：宿主拒绝（RemoteResult ok:false）→ REVEAL_FAILED 带上宿主原因', async (t) => {
  const env = setup(t, {
    remote: makeRemote({ openResult: { ok: false, error: { code: 'gateway/bad-request', message: 'Path has no verified Host path' } } }),
  })
  const response = await call(env, 'host.revealPath', { path: '/tmp/wt' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'REVEAL_FAILED')
  assert.match(response.error.message, /Path has no verified Host path/)
})

test('host.revealPath：宿主抛错 → REVEAL_FAILED', async (t) => {
  const env = setup(t, { remote: makeRemote({ openError: new Error('spawn open failed') }) })
  const response = await call(env, 'host.revealPath', { path: '/tmp/wt' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'REVEAL_FAILED')
  assert.match(response.error.message, /spawn open failed/)
})

// ================= 通道约束仍然生效 =================
test('host.revealPath：异源消息不触发任何宿主调用', async (t) => {
  const env = setup(t)
  env.dispatch(
    requestMessage({ requestId: 'evil', method: 'host.revealPath', params: { path: '/tmp/wt' } }),
    { origin: 'http://evil.example' },
  )
  await sleep(40)
  assert.equal(env.responses('evil').length, 0)
  assert.deepEqual(env.remote.calls.open, [])
})

test('host.revealPath：未知方法仍返回 UNKNOWN_METHOD（不改旧协议行为）', async (t) => {
  const env = setup(t)
  const response = await call(env, 'host.nope', {})
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'UNKNOWN_METHOD')
})
