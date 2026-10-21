#!/usr/bin/env node
// dsh-kanban 独立开发服务器：不依赖 DSH，直接复用 lib/routes.js 的同一套 handler。
// 用法：node scripts/dev-server.mjs [--port 4599] [--data /tmp/dsh-kanban-dev/data.json] [--reset]
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { unlink } from 'node:fs/promises'
import { createStore } from '../lib/store.js'
import { createRoutes } from '../lib/routes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const VERSION = (() => { try { return require('../package.json').version || '0.1.0' } catch { return '0.1.0' } })()
const DEFAULT_DATA = '/tmp/dsh-kanban-dev/data.json'

function parseArgs(argv) {
  const args = { port: 4599, host: '127.0.0.1', data: DEFAULT_DATA, reset: false, seed: 'demo', staticRoot: join(__dirname, '..', 'web', 'dist'), help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`${arg} 缺少参数值`)
      return value
    }
    switch (arg) {
      case '--port': case '-p': args.port = Number(next()); break
      case '--host': args.host = next(); break
      case '--data': args.data = next(); break
      case '--static': args.staticRoot = resolve(next()); break
      case '--seed': args.seed = next(); break
      case '--reset': args.reset = true; break
      case '--help': case '-h': args.help = true; break
      default: throw new Error(`未知参数：${arg}`)
    }
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('--port 必须是 0-65535 的整数')
  if (!['demo', 'empty'].includes(args.seed)) throw new Error('--seed 只支持 demo / empty')
  return args
}

function usage() {
  return [
    'dsh-kanban 开发服务器（不依赖 DSH）',
    '',
    '用法：node scripts/dev-server.mjs [选项]',
    '',
    '  --port, -p <n>   监听端口，默认 4599；0 表示随机端口',
    '  --host <host>    监听地址，默认 127.0.0.1',
    `  --data <file>    数据文件，默认 ${DEFAULT_DATA}`,
    '  --seed <mode>    种子模式 demo|empty，默认 demo',
    '  --reset          启动前删除数据文件（重新生成演示数据）',
    '  --static <dir>   前端产物目录，默认 web/dist',
    '  --help, -h       显示帮助',
  ].join('\n')
}

function matchRoute(routes, pathname) {
  let best
  for (const route of routes) {
    if (route.kind === 'exact') {
      if (pathname === route.path) return route
      continue
    }
    if (pathname === route.path || pathname.startsWith(route.path + '/')) {
      if (!best || route.path.length > best.path.length) best = route
    }
  }
  return best
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(`参数错误：${error.message}\n\n${usage()}`)
    process.exit(2)
  }
  if (args.help) { console.log(usage()); return }

  const dataFile = resolve(args.data)
  if (args.reset) {
    const dir = dirname(dataFile)
    await unlink(dataFile).catch(error => { if (error.code !== 'ENOENT') throw error })
    console.log(`[reset] 已删除 ${dataFile}`)
    void dir
  }

  const store = createStore({ dataDir: dirname(dataFile), file: dataFile, seedMode: args.seed })
  try {
    await store.ready()
  } catch (error) {
    console.error(`数据加载失败：${error.message}`)
    process.exit(1)
  }
  const routes = createRoutes({ store, staticRoot: args.staticRoot, version: VERSION, logger: console })
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname === '/' || url.pathname === '') {
        res.writeHead(302, { location: '/dsh-kanban/' })
        res.end()
        return
      }
      const route = matchRoute(routes.routes, url.pathname)
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      await route.handler(req, res)
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      }
      console.error('[request error]', error?.message || error)
    }
  })
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') console.error(`端口 ${args.port} 已被占用，换一个 --port`)
    else console.error('[server error]', error?.message || error)
    process.exit(1)
  })
  server.listen(args.port, args.host, () => {
    const port = server.address().port
    console.log('')
    console.log(`DSH 看板开发服务器已启动（数据：${dataFile}）`)
    console.log(`  看板 UI： http://${args.host}:${port}/dsh-kanban/`)
    console.log(`  API 自检：http://${args.host}:${port}/api/kanban/health`)
    console.log(`  SSE：    http://${args.host}:${port}/api/kanban/events`)
    console.log('')
  })

  let closing = false
  const shutdown = async signal => {
    if (closing) return
    closing = true
    console.log(`\n收到 ${signal}，正在关闭…`)
    const force = setTimeout(() => process.exit(1), 3000)
    force.unref?.()
    try {
      await routes.close()
      await new Promise(done => server.close(done))
      await store.close()
    } catch {}
    clearTimeout(force)
    process.exit(0)
  }
  process.on('SIGINT', () => { shutdown('SIGINT') })
  process.on('SIGTERM', () => { shutdown('SIGTERM') })
}

main().catch(error => {
  console.error('开发服务器启动失败：', error?.stack || error)
  process.exit(1)
})
