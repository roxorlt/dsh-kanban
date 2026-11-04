// session-binding.js：建卡时会话/目录补全（planCreate 纯解析）与宿主新建会话（prepareCreate）的单元测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionBinding, currentSession, planCreate, SESSION_MODES } from '../lib/session-binding.js'

const AGENT = { id: 'agent-1', session: { id: 'session-current', header: { cwd: '/repo/kanban' } } }

/** 假 workspaceRegistry：get 按 id 查、resolveByPath 按路径前缀解析（未注册路径抛错，模拟宿主行为）。 */
function createFakeRegistry({ workspaces = [], calls = [] } = {}) {
  const list = workspaces.map(workspace => ({ ...workspace }))
  return {
    calls,
    list: () => list.map(workspace => ({ ...workspace, sessionIds: [] })),
    archivedSessionIds: [],
    get(id) {
      calls.push(['get', id])
      return list.find(workspace => workspace.id === id)
    },
    resolveByPath(path) {
      calls.push(['resolveByPath', path])
      const found = list
        .filter(workspace => path === workspace.path || path.startsWith(workspace.path + '/'))
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (!found) {
        const error = new Error(`路径未注册：${path}`)
        error.name = 'WorkspacePathNotFoundError'
        throw error
      }
      return found
    },
  }
}

/** 假 sessionController：记录 create/rename 调用，可配置失败。 */
function createFakeController({ sessionId = 'session-new-1', failCreate = false, failRename = false } = {}) {
  const calls = []
  return {
    calls,
    async create(request) {
      calls.push(['create', request])
      if (failCreate) throw new Error('create failed')
      return { sessionId }
    },
    async rename(request) {
      calls.push(['rename', request])
      if (failRename) throw new Error('rename failed')
    },
  }
}

const kanbanRegistry = () => createFakeRegistry({ workspaces: [{ id: 'ws-1', path: '/repo/kanban' }] })

test('currentSession：只认 agent.session，取不到时返回 null（旧行为）', () => {
  assert.deepEqual(currentSession(AGENT), { sessionId: 'session-current', cwd: '/repo/kanban' })
  assert.deepEqual(currentSession({ id: 'agent-only' }), null)
  assert.deepEqual(currentSession(null), null)
  assert.deepEqual(currentSession({ session: { id: 's-2' } }), { sessionId: 's-2' })
  // session.id 缺失时退回 agent.id
  assert.deepEqual(currentSession({ id: 'agent-fallback', session: { header: { cwd: '/x' } } }), { sessionId: 'agent-fallback', cwd: '/x' })
  assert.deepEqual(currentSession({ session: { header: { cwd: '/x' } } }), null)
})

test('planCreate reuse 默认：自动绑定当前会话并补全工作区/目录', async () => {
  const plan = await planCreate({ args: { title: '卡片' }, agent: AGENT, registry: kanbanRegistry() })
  assert.equal(plan.binding.mode, 'reuse')
  assert.equal(plan.binding.sessionId, 'session-current')
  assert.equal(plan.binding.created, false)
  assert.equal(plan.binding.source, 'agent')
  assert.equal(plan.binding.workspaceId, 'ws-1')
  assert.equal(plan.binding.cwd, '/repo/kanban')
  assert.equal(plan.input.sessionId, 'session-current')
  assert.equal(plan.input.workspaceId, 'ws-1')
  assert.equal(plan.input.cwd, '/repo/kanban')
  assert.equal(plan.input.sessionMode, undefined)
  assert.equal(plan.createRequest, null)
  assert.equal(plan.renameTitle, '卡片')
  assert.deepEqual(plan.warnings, [])
})

test('planCreate reuse：没有会话上下文时不自动补全（单测/dev/旧宿主保持旧行为）', async () => {
  const plan = await planCreate({ args: { title: '卡片' }, agent: { id: 'agent-only' }, registry: kanbanRegistry() })
  assert.equal(plan.binding.mode, 'reuse')
  assert.equal(plan.binding.sessionId, null)
  assert.equal(plan.binding.source, null)
  assert.equal(plan.input.sessionId, undefined)
  assert.equal(plan.input.cwd, undefined)
  assert.equal(plan.input.workspaceId, undefined)
  assert.equal(plan.createRequest, null)
  assert.deepEqual(plan.warnings, [])
})

test('planCreate 显式 sessionId：source=explicit，显式优先不新建会话', async () => {
  const plan = await planCreate({
    args: { title: '卡片', sessionId: 'session-explicit', sessionMode: 'new' },
    agent: AGENT, registry: kanbanRegistry(), hasController: true,
  })
  assert.equal(plan.binding.mode, 'new')
  assert.equal(plan.binding.sessionId, 'session-explicit')
  assert.equal(plan.binding.source, 'explicit')
  assert.equal(plan.binding.created, false)
  assert.equal(plan.binding.workspaceId, 'ws-1')
  assert.equal(plan.input.sessionId, 'session-explicit')
  assert.equal(plan.createRequest, null)
  assert.ok(plan.warnings.some(item => /未新建会话/.test(item)))
})

test('planCreate new：显式 workspaceId 作为新会话目标（create 传 workspaceId）', async () => {
  const plan = await planCreate({
    args: { title: '卡片', sessionMode: 'new', workspaceId: 'ws-1' },
    agent: AGENT, registry: kanbanRegistry(), hasController: true,
  })
  assert.equal(plan.binding.mode, 'new')
  assert.equal(plan.binding.sessionId, null)
  assert.equal(plan.binding.created, false)
  assert.equal(plan.binding.workspaceId, 'ws-1')
  assert.equal(plan.binding.cwd, '/repo/kanban')
  assert.equal(plan.input.sessionId, undefined)
  assert.deepEqual(plan.createRequest, { workspaceId: 'ws-1' })
  assert.deepEqual(plan.warnings, [])
})

test('planCreate new：显式子目录 cwd 解析出工作区，卡片保留子目录、会话 attach 到工作区', async () => {
  const plan = await planCreate({
    args: { title: '卡片', sessionMode: 'new', cwd: '/repo/kanban/sub' },
    agent: AGENT, registry: kanbanRegistry(), hasController: true,
  })
  assert.equal(plan.binding.workspaceId, 'ws-1')
  assert.equal(plan.binding.cwd, '/repo/kanban/sub')
  assert.equal(plan.input.cwd, '/repo/kanban/sub')
  assert.deepEqual(plan.createRequest, { workspaceId: 'ws-1' })
})

test('planCreate new：解析不到工作区但 cwd 是合法绝对目录 → 用 cwd 建会话', async () => {
  const plan = await planCreate({
    args: { title: '卡片', sessionMode: 'new', cwd: '/tmp/scratch' },
    agent: AGENT, registry: kanbanRegistry(), hasController: true,
  })
  assert.equal(plan.binding.workspaceId, null)
  assert.equal(plan.binding.cwd, '/tmp/scratch')
  assert.deepEqual(plan.createRequest, { cwd: '/tmp/scratch' })
})

test('planCreate new：旧宿主没有 sessionController → 只补全目录并 warning 手动新建', async () => {
  const plan = await planCreate({ args: { title: '卡片', sessionMode: 'new' }, agent: AGENT, registry: kanbanRegistry(), hasController: false })
  assert.equal(plan.binding.sessionId, null)
  assert.equal(plan.binding.created, false)
  assert.equal(plan.binding.cwd, '/repo/kanban')
  assert.equal(plan.binding.workspaceId, 'ws-1')
  assert.equal(plan.createRequest, null)
  assert.ok(plan.warnings.some(item => /不支持自动新建会话/.test(item)))
  assert.ok(plan.warnings.some(item => /手动新建会话/.test(item)))
})

test('planCreate new：既没有工作区也没有目录 → 不建会话并 warning', async () => {
  const plan = await planCreate({ args: { title: '卡片', sessionMode: 'new' }, agent: { id: 'agent-only' }, registry: kanbanRegistry(), hasController: true })
  assert.equal(plan.binding.cwd, null)
  assert.equal(plan.binding.workspaceId, null)
  assert.equal(plan.createRequest, null)
  assert.ok(plan.warnings.some(item => /没有可用的工作区或目录/.test(item)))
})

test('planCreate none：不绑定会话，但仍补全 cwd/workspaceId', async () => {
  const plan = await planCreate({ args: { title: '卡片', sessionMode: 'none' }, agent: AGENT, registry: kanbanRegistry() })
  assert.equal(plan.binding.mode, 'none')
  assert.equal(plan.binding.sessionId, null)
  assert.equal(plan.binding.source, null)
  assert.equal(plan.input.sessionId, undefined)
  assert.equal(plan.input.cwd, '/repo/kanban')
  assert.equal(plan.input.workspaceId, 'ws-1')
  assert.equal(plan.createRequest, null)
  assert.deepEqual(plan.warnings, [])
})

test('planCreate：显式 workspaceId 查询不到 → 丢弃并 warning，回退到目录解析', async () => {
  const plan = await planCreate({ args: { title: '卡片', workspaceId: 'ws-missing' }, agent: AGENT, registry: kanbanRegistry() })
  assert.ok(plan.warnings.some(item => /workspaceId「ws-missing」不存在/.test(item)))
  assert.equal(plan.input.workspaceId, 'ws-1') // 回退用当前会话目录解析出的工作区
  assert.equal(plan.binding.workspaceId, 'ws-1')
})

test('planCreate：显式参数不被覆盖（sessionId/workspaceId/cwd 原样保留）', async () => {
  const plan = await planCreate({
    args: { title: '卡片', sessionId: 'session-explicit', workspaceId: 'ws-1', cwd: '/repo/kanban/sub' },
    agent: AGENT, registry: kanbanRegistry(),
  })
  assert.equal(plan.input.sessionId, 'session-explicit')
  assert.equal(plan.input.workspaceId, 'ws-1')
  assert.equal(plan.input.cwd, '/repo/kanban/sub')
  assert.equal(plan.binding.cwd, '/repo/kanban/sub')
  assert.equal(plan.binding.source, 'explicit')
})

test('planCreate reuse：显式 cwd 与当前会话目录不一致 → 提示改用 sessionMode:new', async () => {
  const registry = createFakeRegistry({ workspaces: [{ id: 'ws-1', path: '/repo/kanban' }, { id: 'ws-2', path: '/repo/other' }] })
  const plan = await planCreate({ args: { title: '卡片', cwd: '/repo/other' }, agent: AGENT, registry })
  assert.equal(plan.binding.cwd, '/repo/other')
  assert.equal(plan.binding.workspaceId, 'ws-2')
  assert.ok(plan.warnings.some(item => /sessionMode:'new'/.test(item)))
})

test('planCreate：非法相对 cwd 丢弃并 warning', async () => {
  const plan = await planCreate({ args: { title: '卡片', cwd: 'relative/dir' }, agent: AGENT, registry: kanbanRegistry() })
  assert.ok(plan.warnings.some(item => /不是绝对路径/.test(item)))
  assert.equal(plan.input.cwd, '/repo/kanban') // 回退当前会话目录
  assert.equal(plan.binding.cwd, '/repo/kanban')
})

test('planCreate：agent.session 有 id 无 cwd 时只补会话、不补目录', async () => {
  const plan = await planCreate({ args: { title: '卡片' }, agent: { id: 'agent-2', session: { id: 'session-no-cwd' } }, registry: kanbanRegistry() })
  assert.equal(plan.binding.sessionId, 'session-no-cwd')
  assert.equal(plan.binding.cwd, null)
  assert.equal(plan.input.workspaceId, undefined)
  assert.equal(plan.createRequest, null)
})

test('prepareCreate：new 模式真实新建会话并绑定，标题设为卡片标题', async () => {
  const registry = kanbanRegistry()
  const controller = createFakeController()
  const binding = createSessionBinding({ getWorkspaceRegistry: () => registry, getSessionController: () => controller })
  const prepared = await binding.prepareCreate({ args: { title: '新会话卡', sessionMode: 'new', cwd: '/repo/kanban/sub' }, agent: AGENT })
  assert.equal(prepared.binding.sessionId, 'session-new-1')
  assert.equal(prepared.binding.created, true)
  assert.equal(prepared.binding.source, 'agent')
  assert.equal(prepared.binding.cwd, '/repo/kanban/sub')
  assert.equal(prepared.binding.workspaceId, 'ws-1')
  assert.equal(prepared.input.sessionId, 'session-new-1')
  assert.equal(prepared.input.cwd, '/repo/kanban/sub')
  assert.deepEqual(prepared.warnings, [])
  assert.deepEqual(controller.calls[0], ['create', { workspaceId: 'ws-1' }])
  assert.deepEqual(controller.calls[1], ['rename', { sessionId: 'session-new-1', title: '新会话卡' }])
})

test('prepareCreate：rename 失败不影响绑定', async () => {
  const controller = createFakeController({ failRename: true })
  const logs = []
  const binding = createSessionBinding({
    getWorkspaceRegistry: () => kanbanRegistry(),
    getSessionController: () => controller,
    logger: { warn: message => logs.push(message) },
  })
  const prepared = await binding.prepareCreate({ args: { title: '新会话卡', sessionMode: 'new' }, agent: AGENT })
  assert.equal(prepared.binding.sessionId, 'session-new-1')
  assert.equal(prepared.binding.created, true)
  assert.deepEqual(prepared.warnings, [])
  assert.ok(logs.some(message => /设置标题失败/.test(message)))
})

test('prepareCreate：create 失败降级为 warning，不绑定但保留已解析目录/工作区', async () => {
  const controller = createFakeController({ failCreate: true })
  const logs = []
  const binding = createSessionBinding({
    getWorkspaceRegistry: () => kanbanRegistry(),
    getSessionController: () => controller,
    logger: { warn: message => logs.push(message) },
  })
  const prepared = await binding.prepareCreate({ args: { title: '卡片', sessionMode: 'new' }, agent: AGENT })
  assert.equal(prepared.binding.sessionId, null)
  assert.equal(prepared.binding.created, false)
  assert.equal(prepared.binding.source, null)
  assert.equal(prepared.binding.cwd, '/repo/kanban')
  assert.equal(prepared.binding.workspaceId, 'ws-1')
  assert.equal(prepared.input.sessionId, undefined)
  assert.ok(prepared.warnings.some(item => /新建会话失败/.test(item)))
  assert.ok(logs.some(message => /新建会话失败/.test(message)))
})

test('prepareCreate：precheck 抛错 → 直接失败且不建会话（防孤儿）', async () => {
  const controller = createFakeController()
  const binding = createSessionBinding({ getWorkspaceRegistry: () => kanbanRegistry(), getSessionController: () => controller })
  await assert.rejects(
    () => binding.prepareCreate({
      args: { title: '卡片', sessionMode: 'new' },
      agent: AGENT,
      precheck: () => { throw new Error('board missing') },
    }),
    /board missing/,
  )
  assert.equal(controller.calls.length, 0)
})

test('prepareCreate：宿主不支持 sessionController 时降级不报错', async () => {
  const binding = createSessionBinding({ getWorkspaceRegistry: () => kanbanRegistry(), getSessionController: () => null })
  assert.equal(binding.available(), false)
  const prepared = await binding.prepareCreate({ args: { title: '卡片', sessionMode: 'new' }, agent: AGENT })
  assert.equal(prepared.binding.sessionId, null)
  assert.equal(prepared.binding.cwd, '/repo/kanban')
  assert.ok(prepared.warnings.some(item => /不支持自动新建会话/.test(item)))
})

test('available() 反映懒注入的 sessionController（旧宿主 → 新宿主切换）', async () => {
  let controller = null
  const binding = createSessionBinding({ getSessionController: () => controller })
  assert.equal(binding.available(), false)
  controller = createFakeController()
  assert.equal(binding.available(), true)
  // 取到会话上下文时 reuse 不依赖 registry 也能绑定
  const prepared = await binding.prepareCreate({ args: { title: '卡片' }, agent: AGENT })
  assert.equal(prepared.binding.sessionId, 'session-current')
})

test('常量：SESSION_MODES 与默认 mode', async () => {
  assert.deepEqual(SESSION_MODES, ['reuse', 'new', 'none'])
  const plan = await planCreate({ args: { title: '卡片' }, agent: { id: 'agent-only' } })
  assert.equal(plan.binding.mode, 'reuse')
  const unknown = await planCreate({ args: { title: '卡片', sessionMode: 'unknown' }, agent: { id: 'agent-only' } })
  assert.equal(unknown.binding.mode, 'reuse')
})

test('planCreate：registry.get 抛错时无法校验，保留显式 workspaceId', async () => {
  const registry = {
    get() { throw new Error('registry down') },
    resolveByPath() { throw new Error('registry down') },
  }
  const plan = await planCreate({ args: { title: '卡片', workspaceId: 'ws-external' }, agent: AGENT, registry })
  assert.equal(plan.input.workspaceId, 'ws-external')
  assert.equal(plan.binding.workspaceId, 'ws-external')
  assert.deepEqual(plan.warnings, [])
})

test('planCreate：工作区路径尾斜杠归一化', async () => {
  const registry = createFakeRegistry({ workspaces: [{ id: 'ws-1', path: '/repo/kanban/' }] })
  const plan = await planCreate({ args: { title: '卡片', workspaceId: 'ws-1' }, agent: AGENT, registry })
  assert.equal(plan.workspaceId, undefined)
  assert.equal(plan.binding.workspaceId, 'ws-1')
  assert.equal(plan.binding.cwd, '/repo/kanban')
  assert.equal(plan.input.workspaceId, 'ws-1')
})

test('currentSession 扩展：支持从 exec.session / exec.sessionId / agent.sessionId 提取会话', () => {
  assert.deepEqual(
    currentSession({ id: 'a1' }, { session: { id: 's-exec', header: { cwd: '/repo/exec' } } }),
    { sessionId: 's-exec', cwd: '/repo/exec' },
  )
  assert.deepEqual(
    currentSession({ sessionId: 's-agent-direct', cwd: '/repo/direct' }),
    { sessionId: 's-agent-direct', cwd: '/repo/direct' },
  )
  assert.deepEqual(
    currentSession({ id: 'a1' }, { sessionId: 's-exec-id', cwd: '/repo/exec2' }),
    { sessionId: 's-exec-id', cwd: '/repo/exec2' },
  )
})

test('prepareCreate：reuse 模式下若无当前会话但提供了 workspaceId/cwd 且有 controller，自动 fallback 新建会话', async () => {
  const registry = kanbanRegistry()
  const controller = createFakeController({ sessionId: 'session-fallback-new' })
  const binding = createSessionBinding({ getWorkspaceRegistry: () => registry, getSessionController: () => controller })
  const prepared = await binding.prepareCreate({
    args: { title: '兜底新建会话卡', cwd: '/repo/kanban' },
    agent: { id: 'agent-only' },
  })
  assert.equal(prepared.binding.sessionId, 'session-fallback-new')
  assert.equal(prepared.binding.created, true)
  assert.equal(prepared.input.sessionId, 'session-fallback-new')
  assert.deepEqual(controller.calls[0], ['create', { workspaceId: 'ws-1' }])
})
