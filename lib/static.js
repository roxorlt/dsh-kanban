// 静态资源：把插件自己的 Web UI（web/dist）挂在 /dsh-kanban/ 下。
// web/dist 可能尚未构建（开发早期），此时返回一页占位说明而不是 404。
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, posix, relative, sep } from 'node:path'

export const DEFAULT_PREFIX = '/dsh-kanban'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'self'",
  'cross-origin-resource-policy': 'same-origin',
}

export function placeholderPage({ reason } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 看板 · 前端尚未构建</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    background: Canvas; color: CanvasText; }
  main { max-width: 560px; padding: 40px 32px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p, li { color: color-mix(in srgb, CanvasText 72%, Canvas); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    background: color-mix(in srgb, CanvasText 8%, Canvas); padding: 2px 6px; border-radius: 5px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #f5a524; margin-right: 8px; vertical-align: middle; }
</style></head>
<body><main>
  <h1><span class="dot"></span>DSH 看板 UI 还没有构建</h1>
  <p>服务端 API 已经就绪，但 <code>web/dist</code> 不存在或缺少 <code>index.html</code>。${reason ? `（${reason}）` : ''}</p>
  <ol>
    <li>在插件根目录执行 <code>npm run build</code>（或 <code>npm --prefix web run build</code>）</li>
    <li>刷新本页；开发期可另开 <code>node scripts/dev-server.mjs --port 4599</code> 联调 API</li>
  </ol>
  <p>接口自检：<code>GET /api/kanban/health</code> 应返回 <code>{"ok":true}</code>。</p>
</main></body></html>`
}

function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, ...headers })
  res.end(body)
}

async function readInsideRoot(root, relativePath) {
  // 进入文件系统前先在字符串层拒绝穿越；realpath 再挡一次符号链接逃逸。
  const normalized = posix.normalize('/' + relativePath).replace(/^\/+/, '')
  if (!normalized || normalized.split('/').some(segment => segment === '..' || segment === '.')) return null
  const candidate = join(root, normalized)
  const inside = relative(root, candidate)
  if (!inside || inside.startsWith('..') || inside.includes(`..${sep}`)) return null
  let target
  try { target = await realpath(candidate) } catch { return null }
  const realRoot = await realpath(root)
  const realInside = relative(realRoot, target)
  if (!realInside || realInside.startsWith('..') || realInside.includes(`..${sep}`)) return null
  const info = await stat(target)
  return info.isFile() ? { path: target, size: info.size, mtimeMs: info.mtimeMs } : null
}

/** 返回可挂在 prefix '/dsh-kanban' 上的静态资源 handler。 */
export function createStaticHandler({ root, prefix = DEFAULT_PREFIX } = {}) {
  async function serve(req, res, file) {
    const ext = extname(file.path).toLowerCase()
    // Vite 产物都放在 assets/ 下且文件名带 hash，可长期强缓存；index.html 永远 no-store。
    const asset = String(req.url || '').includes('/assets/')
    const headers = {
      ...BASE_HEADERS,
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': file.size,
      'cache-control': ext === '.html' ? 'no-store' : asset ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag: `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`,
    }
    if (req.headers['if-none-match'] === headers.etag) { res.writeHead(304, headers); res.end(); return }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    const stream = createReadStream(file.path)
    stream.on('error', () => { if (!res.writableEnded) res.destroy() })
    stream.pipe(res)
  }

  async function sendHtml(req, res, html) {
    const body = Buffer.from(html, 'utf8')
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': MIME['.html'], 'content-length': body.length, 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function serveIndex(req, res, note) {
    if (!root) return sendHtml(req, res, placeholderPage({ reason: note }))
    const file = await readInsideRoot(root, 'index.html')
    if (!file) return sendHtml(req, res, placeholderPage({ reason: note }))
    // SPA fallback 可能落在 /dsh-kanban/board/x 这类深层路径；构建产物用相对 base 时
    // 相对资源会解析到错误目录，这里补一个绝对 base（已有 <base> 则不重复注入）。
    let html = await readFile(file.path, 'utf8')
    if (!/<base[\s>]/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${prefix}/">`)
    await sendHtml(req, res, html)
  }

  return async function staticHandler(req, res) {
    let url
    try { url = new URL(req.url || '/', 'http://localhost') } catch { sendText(res, 400, 'bad request'); return }
    let pathname = url.pathname
    if (pathname === prefix) {
      res.writeHead(302, { ...BASE_HEADERS, location: prefix + '/' + (url.search || '') })
      res.end()
      return
    }
    if (!pathname.startsWith(prefix + '/')) { sendText(res, 404, 'not found'); return }
    let rest
    try { rest = decodeURIComponent(pathname.slice(prefix.length + 1)) } catch { sendText(res, 400, 'bad path'); return }
    if (rest.includes('\0')) { sendText(res, 400, 'bad path'); return }
    if (rest.split('/').some(segment => segment === '.' || segment === '..')) { sendText(res, 404, 'not found'); return }
    if (!['GET', 'HEAD'].includes(req.method)) {
      sendText(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
      return
    }
    if (!root) { await serveIndex(req, res, '插件未配置静态根'); return }
    if (rest === '' || rest === '/') { await serveIndex(req, res); return }
    const file = await readInsideRoot(root, rest)
    if (file) { await serve(req, res, file); return }
    // 目录请求（不带尾斜杠）→ 尝试目录内 index.html
    const index = await readInsideRoot(root, rest.replace(/\/+$/, '') + '/index.html')
    if (index) { await serve(req, res, index); return }
    // SPA fallback：无扩展名的前端路由交回 index.html；带扩展名视为缺失资源
    if (!extname(rest)) { await serveIndex(req, res, 'SPA fallback'); return }
    sendText(res, 404, 'not found')
  }
}
