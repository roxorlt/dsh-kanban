// 宿主库级验证（会话运行失败同步）：用真实 DSH 0.2.1 的 cordis + dsh-session 驱动插件。
// 把 dsh-kanban 服务端插件挂到真实 cordis 上、用真实 SessionStore 发出 turn/end，
// 断言卡片被自动置「失败」、同轮去重、下一轮完成后自动回「进行中」（失败记录保留）。
//
// 用法：
//   DSH_HOST_MODULES=/tmp/dsh021/dsh/node_modules node scripts/verify-session-sync.mjs
// 其中 DSH_HOST_MODULES 需指向从桌面宿主 app.asar 解包出的 dsh/node_modules：
//   node <解包脚本>  extract "dsh/node_modules/@deepseek-ai/" /tmp/dsh021   # asar 解包见 docs/06 §1.23
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const hostModules = process.env.DSH_HOST_MODULES
if (!hostModules) {
  console.error('缺少 DSH_HOST_MODULES（指向桌面宿主解包出的 dsh/node_modules）')
  process.exit(2)
}
const hostImport = relative => import(pathToFileURL(join(hostModules, relative)).href)

const { Context } = await hostImport('@deepseek-ai/cordis/lib/index.js')
const SessionStore = (await hostImport('@deepseek-ai/dsh-session/lib/index.js')).default
const kanban = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href)
const domain = await import(pathToFileURL(join(repoRoot, 'lib', 'domain.js')).href)

const SESSION_ID = 'session-verify-sync-0001'
const dir = mkdtempSync(join(tmpdir(), 'kb-verify-'))
const now = Date.now()

// 1) 预置数据：一张绑定主会话、进行中的卡片
const draft = domain.normalizeStore(domain.createSeed('empty', now), now)
const { card } = domain.createCard(draft, { title: '失败同步验证卡', status: 'running', sessionId: SESSION_ID }, { now })
writeFileSync(join(dir, 'data.json'), JSON.stringify(draft))

const root = new Context()
const fake = { routes: 0, tools: 0 }
root.plugin({
  name: 'fake-host-services',
  apply(ctx) {
    ctx.reflect.provide('webServer', { register() { fake.routes += 1; return () => {} } })
    ctx.reflect.provide('tools', { register() { fake.tools += 1; return () => {} } })
  },
})
root.plugin(SessionStore)
await new Promise(resolve => setTimeout(resolve, 50))
const sessions = root.reflect.get('sessions')
if (!sessions) throw new Error('真实 SessionStore 未挂载')
root.plugin(kanban, { dataDir: dir, seed: 'empty' })
await new Promise(resolve => setTimeout(resolve, 150))

// 2) 真实 SessionStore 建会话并发出 turn 事件
const session = sessions.create(SESSION_ID)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const readCard = () => JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).cards.find(item => item.id === card.id)
const waitCard = async predicate => {
  for (let i = 0; i < 100; i += 1) {
    const current = readCard()
    if (predicate(current)) return current
    await wait(20)
  }
  return readCard()
}

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`) }

session.append('turn/start', { turn: 1 })
session.append('turn/end', {
  turn: 1,
  reason: { kind: 'error', error: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } },
})
let current = await waitCard(c => c.status === 'failed')
check('失败后卡片自动置 failed', current.status === 'failed', `status=${current.status}`)
const dataFile = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'))
const errors = dataFile.activities.filter(a => a.cardId === card.id && a.type === 'error')
check('时间线写入 1 条 error 节点', errors.length === 1, `count=${errors.length}`)
check('error 节点带轮次/原因/错误码', errors[0]?.data?.kind === 'session_turn_failure' && errors[0]?.data?.turn === 1 && errors[0]?.data?.code === 'TRANSPORT', JSON.stringify(errors[0]?.data))

// 3) 同轮重复事件不重复记录
session.append('turn/end', {
  turn: 1,
  reason: { kind: 'error', error: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } },
})
await wait(120)
const afterDup = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).activities
check('同一轮只记一次（去重）', afterDup.filter(a => a.cardId === card.id && a.type === 'error').length === 1, `count=${afterDup.filter(a => a.cardId === card.id && a.type === 'error').length}`)

// 4) 下一轮正常完成 → 自动回进行中，失败记录保留
session.append('turn/start', { turn: 2 })
session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
current = await waitCard(c => c.status === 'running')
check('恢复后卡片自动回 running', current.status === 'running', `status=${current.status}`)
const recovered = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).activities
check('恢复节点写入且失败记录保留', recovered.some(a => a.cardId === card.id && a.data?.kind === 'session_turn_recovered') && recovered.filter(a => a.cardId === card.id && a.type === 'error').length === 1)

// 5) 工具/路由确实注册（插件真加载）
check('插件注册了 2 条路由与 11 个工具', fake.routes === 2 && fake.tools === 11, `routes=${fake.routes} tools=${fake.tools}`)

await new Promise(resolve => setTimeout(resolve, 100))
const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? '；失败项：' + failed.map(item => item.name).join('、') : ''}`)
try { root[Symbol.dispose]?.() } catch {}
rmSync(dir, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
