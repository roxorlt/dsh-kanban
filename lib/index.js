// DSH Kanban 插件入口：webServer 路由 + agent 工具 + 数据目录种子。
// 注意：webServer 的 prefix 路由会匹配 path 自身与 path/<anything>，
// 因此这里只注册两条前缀路由（API / 静态资源），重复注册会抛错。
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createStore } from './store.js'
import { createRoutes } from './routes.js'
import { createTools } from './tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const PKG_VERSION = (() => { try { return require('../package.json').version || '0.1.0' } catch { return '0.1.0' } })()

export const name = 'dsh-kanban'
export const inject = ['webServer', 'tools']

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir ? resolve(String(config.dataDir)) : join(homedir(), '.dsh-kanban')
  const seedMode = config.seed === 'empty' ? 'empty' : 'demo'
  const staticRoot = config.staticRoot ? resolve(String(config.staticRoot)) : join(__dirname, '..', 'web', 'dist')

  const store = createStore({ dataDir, seedMode, logger: ctx.logger })
  const { routes, close } = createRoutes({ store, staticRoot, version: PKG_VERSION, logger: ctx.logger })

  // 路由：每条注册都交给 ctx.effect 管理，插件卸载时自动摘除。
  for (const route of routes) ctx.effect(() => ctx.webServer.register(route))
  // 工具：保持固定名字，避免 agent 已学到的工作流失效。
  for (const tool of createTools({ store })) {
    ctx.effect(() => {
      const dispose = ctx.tools.register(tool)
      return typeof dispose === 'function' ? dispose : () => {}
    })
  }
  // SSE 连接、订阅与心跳在插件卸载时关闭。
  ctx.effect(() => () => { close().catch(() => {}) })

  // 提前加载/种子；失败不阻塞插件启动，后续请求会返回带原因的错误。
  store.ready().then(
    () => { try { ctx.logger?.info?.(`[dsh-kanban] 数据目录：${store.dataDir}`) } catch {} },
    error => { try { ctx.logger?.warn?.(`[dsh-kanban] 数据加载失败：${error.message}`) } catch {} },
  )
}
