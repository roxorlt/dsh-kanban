// 测试公共工具：临时目录、独立 HTTP 服务、SSE 读取。全部离线，不碰 ~/.dsh-kanban。
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { createStore } from '../lib/store.js'
import { createRoutes } from '../lib/routes.js'

export async function tempDir(t, prefix = 'dsh-kanban-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export async function testStore(t, options = {}) {
  const dir = options.dir || await tempDir(t)
  const store = createStore({ dataDir: dir, seedMode: options.seedMode || 'demo', forceNew: true })
  t.after(() => store.close())
  return { store, dir }
}

export async function startServer(t, { store, staticRoot } = {}) {
  await store.ready()
  const routes = createRoutes({ store, staticRoot, version: '0.0.0-test' })
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      let best
      for (const route of routes.routes) {
        if (route.kind === 'exact' && url.pathname === route.path) { best = route; break }
        if (route.kind === 'prefix' && (url.pathname === route.path || url.pathname.startsWith(route.path + '/'))) {
          if (!best || route.path.length > best.path.length) best = route
        }
      }
      if (!best) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
      await best.handler(req, res)
    } catch (error) {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error') }
      console.error('test server error', error)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(async () => {
    await routes.close()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  })
  return { url: `http://127.0.0.1:${port}`, port, routes }
}

export async function api(server, path, { method = 'GET', body, headers = {}, rawBody } = {}) {
  const init = { method, headers: { ...headers } }
  if (rawBody !== undefined) { init.body = rawBody } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = init.headers['content-type'] || 'application/json'
  }
  const response = await fetch(server.url + path, init)
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: response.status, headers: response.headers, text, json }
}

/** 原样发送 URL（绕过 fetch/URL 的路径规范化），用于路径穿越测试。 */
export function rawRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 打开 SSE 连接并按事件读取。 */
export async function openSse(url) {
  const controller = new AbortController()
  const response = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let closed = false
  async function nextEvent(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = { event: 'message', data: undefined }
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event.event = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            try { event.data = JSON.parse(raw) } catch { event.data = raw }
          }
        }
        return event
      }
      if (closed) throw new Error('SSE 连接已关闭')
      const remain = deadline - Date.now()
      if (remain <= 0) throw new Error('等待 SSE 事件超时')
      const read = reader.read()
      const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('等待 SSE 事件超时')), remain).unref?.())
      let result
      try { result = await Promise.race([read, timer]) } catch (error) { controller.abort(); throw error }
      if (result.done) { closed = true; throw new Error('SSE 连接已关闭') }
      buffer += decoder.decode(result.value, { stream: true })
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    nextEvent,
    async close() { controller.abort(); try { await reader.cancel() } catch {} },
  }
}

export async function writeStaticFixture(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}
