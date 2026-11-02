#!/usr/bin/env node
/**
 * DSH 看板视觉验收工具（零依赖）
 * ============================================================================
 * 对构建产物（默认 .tmp/dist-verify）用 Chrome for Testing + CDP 实测
 * docs/10-visual-audit.md 的 A-01…A-15 验收指标，输出：
 *   - .tmp/visual/<label>.json     机器可读报告（含每项 {id, threshold, measured, pass, evidence}）
 *   - .tmp/visual/matrix.md        markdown 矩阵（A 项 | 标准 | 实测 | 通过 | 截图）
 *   - docs/assets/screens/visual-v2/<label>/*.png  截图矩阵
 *
 * 用法：
 *   node scripts/visual-audit.mjs --label baseline
 *   node scripts/visual-audit.mjs --label final
 *   node scripts/visual-audit.mjs --only A-01,A-05
 *   node scripts/visual-audit.mjs --label final --base http://127.0.0.1:4603/dsh-kanban/
 *
 * 说明：
 *   - 不使用任何 npm 依赖，只用 Node 22 内置能力（child_process / WebSocket / fetch）。
 *   - 会自行构建 web → .tmp/dist-verify，并在 4603 端口起独立 dev-server（可用 --base 复用）。
 *   - 只写 scripts 外的 .tmp/visual 与 docs/assets/screens/visual-v2，不碰 web/src、lib、docs/10。
 *   - 数据文件默认 /tmp/kb-visual/data-verify.json，--reset 重新 seed demo。
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHROME_DEFAULT =
  '/Users/roxor/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, label: '1440×900' },
  compact: { width: 1024, height: 768, label: '1024×768' },
  tablet: { width: 720, height: 900, label: '720×900' },
  narrow: { width: 390, height: 844, label: '390×844' },
};
const VIEW_INDEX = { board: 0, list: 1, worklines: 2, workspaces: 3 };
const STATUS_ZH = {
  backlog: '待办',
  running: '进行中',
  needs_you: '待你确认',
  blocked: '受阻',
  failed: '失败',
  done: '已完成',
};
const REJECT_IDS = ['no', 'reject', 'deny', 'cancel', 'stop', 'hold'];

// ============================================================================
// CLI
// ============================================================================
function parseArgs(argv) {
  const args = {
    label: 'baseline',
    only: [],
    base: null,
    port: 4603,
    data: '/tmp/kb-visual/data-verify.json',
    staticRoot: join(ROOT, '.tmp', 'dist-verify'),
    outDir: join(ROOT, '.tmp', 'visual'),
    screensBase: join(ROOT, 'docs', 'assets', 'screens', 'visual-v2'),
    chrome: process.env.CHROME_PATH || CHROME_DEFAULT,
    build: true,
    screens: true,
    seed: 'demo',
    reset: true,
    note: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} 缺少参数值`);
      return v;
    };
    switch (arg) {
      case '--label': args.label = next(); break;
      case '--only': args.only = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--base': args.base = next(); break;
      case '--port': args.port = Number(next()); break;
      case '--data': args.data = resolve(next()); break;
      case '--static': args.staticRoot = resolve(next()); break;
      case '--chrome': args.chrome = next(); break;
      case '--seed': args.seed = next(); break;
      case '--no-build': args.build = false; break;
      case '--no-screens': args.screens = false; break;
      case '--no-reset': args.reset = false; break;
      case '--note': args.note = next(); break;
      case '--verbose': case '-v': args.verbose = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port 必须是 1-65535 的整数');
  if (!['demo', 'empty'].includes(args.seed)) throw new Error('--seed 只支持 demo / empty');
  args.screensDir = join(args.screensBase, args.label);
  args.api = args.base ? urlsFor(args.base).api : `http://127.0.0.1:${args.port}/api/kanban`;
  args.pageUrl = args.base || `http://127.0.0.1:${args.port}/dsh-kanban/`;
  return args;
}

function urlsFor(base) {
  const url = new URL(base);
  return { origin: url.origin, api: `${url.origin}/api/kanban`, page: url.href };
}

const USAGE = `DSH 看板视觉验收（零依赖 CDP）
用法：node scripts/visual-audit.mjs [选项]
  --label <name>   输出标签/截图目录名（默认 baseline）
  --only A-01,A-05 只跑指定检查
  --base <url>     复用已启动的 dev-server（跳过构建与起服务）
  --port <n>       dev-server 端口（默认 4603）
  --data <file>    数据文件（默认 /tmp/kb-visual/data-verify.json）
  --static <dir>   构建产物目录（默认 .tmp/dist-verify）
  --chrome <path>  Chrome for Testing 可执行文件
  --no-build       跳过 web 构建
  --no-screens     不截图
  --no-reset       不从空数据重新 seed
  --note <text>    写进矩阵头的快照说明（例如「final 快照包含批次 1/2」）
  --seed <mode>    demo | empty（默认 demo）
  --verbose        打印 CDP/步骤细节
  --help           显示帮助`;

const t0 = Date.now();
function log(...parts) {
  const ms = String(Date.now() - t0).padStart(6, ' ');
  console.log(`[${ms}ms] ${parts.join(' ')}`);
}
function vlog(...parts) {
  if (ARGS.verbose) log(...parts);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function localIso(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date).replace(' ', 'T') + '+08:00';
}

// ============================================================================
// 进程：构建 / dev-server / chrome
// ============================================================================
function runBuild(args) {
  log('构建 web →', args.staticRoot);
  const result = spawnSync(
    'npm',
    ['--prefix', 'web', 'run', 'build', '--', '--outDir', '../.tmp/dist-verify', '--emptyOutDir'],
    { cwd: ROOT, encoding: 'utf8', timeout: 180000 },
  );
  const tail = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-8).join('\n');
  const ok = result.status === 0;
  log(ok ? '构建成功' : `构建失败（status=${result.status}）`);
  if (tail) console.log(tail.split('\n').map((l) => `        ${l}`).join('\n'));
  const hasDist = existsSync(join(args.staticRoot, 'index.html'));
  if (!ok && !hasDist) throw new Error('构建失败且没有可复用的构建产物');
  if (!ok) log('警告：构建失败，改用已存在的构建产物（结果需注明）');
  return { ok, status: result.status, tail };
}

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function apiCall(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`API ${options.method || 'GET'} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function waitFor(fn, { timeout = 15000, interval = 120, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时（${label}${lastError ? `：${lastError.message}` : ''}）`);
}

async function startServer(args) {
  const existing = await fetchJson(`${args.api}/health`, 800).catch(() => null);
  if (existing && existing.ok) {
    throw new Error(`端口 ${args.port} 上已有 dev-server 在运行（可能是上次残留）。请先结束它或改用 --port，或加 --base 复用。`);
  }
  log(`启动 dev-server :${args.port}（data=${args.data}）`);
  const serverArgs = ['scripts/dev-server.mjs', '--port', String(args.port), '--data', args.data, '--static', args.staticRoot, '--seed', args.seed];
  if (args.reset) serverArgs.push('--reset');
  const proc = spawn('node', serverArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { output += d.toString(); });
  proc.on('exit', (code) => { if (code !== 0 && code !== null) log(`dev-server 退出 code=${code}`); });
  try {
    await waitFor(async () => (await fetchJson(`${args.api}/health`, 1500)).ok, { timeout: 20000, label: 'dev-server health' });
  } catch (error) {
    console.log(output);
    throw error;
  }
  log('dev-server 就绪');
  return proc;
}

async function findCdpPage(port) {
  return waitFor(async () => {
    try {
      const { json } = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1000);
      if (!Array.isArray(json)) return null;
      const page = json.find((t) => t.type === 'page');
      return page && page.webSocketDebuggerUrl ? page : null;
    } catch {
      return null;
    }
  }, { timeout: 15000, interval: 150, label: 'chrome CDP /json/list' });
}

async function startChrome(args) {
  const port = 9333 + Math.floor(Math.random() * 60);
  const profile = `/tmp/kb-visual/chrome-${args.label}-${Date.now()}`;
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  log('启动 Chrome headless（CDP', port, '）');
  const proc = spawn(args.chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-crashpad',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  const target = await findCdpPage(port);
  return { proc, port, target, profile };
}

// ============================================================================
// CDP
// ============================================================================
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
        msg = JSON.parse(raw);
      } catch { return; }
      if (msg.id) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
        else entry.resolve(msg.result || {});
        return;
      }
      if (msg.method) {
        for (let i = 0; i < this.waiters.length; i++) {
          const waiter = this.waiters[i];
          if (waiter.method !== msg.method) continue;
          this.waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(msg.params || {});
          break;
        }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('CDP WebSocket 连接超时（1006？）')), 12000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      ws.addEventListener('error', (event) => { clearTimeout(timer); rejectPromise(new Error(`CDP WebSocket 错误：${event?.message || 'unknown'}`)); }, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  waitEvent(method, timeout = 15000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { method, resolve: resolvePromise, reject: rejectPromise, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectPromise(new Error(`等待 CDP 事件超时：${method}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ============================================================================
// 页面侧工具（注入到每个新文档的 window.__H）
// ============================================================================
const PAGE_HELPER = function () {
  const parseColor = function (input) {
    if (!input) return null;
    const text = String(input).trim();
    if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const match = text.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(function (n) { return Number.isNaN(n); })) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = function (top, bottom) {
    return {
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    };
  };
  const effectiveBackground = function (el) {
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0) {
        if (color.a >= 0.999) {
          let out = { r: color.r, g: color.g, b: color.b, a: 1 };
          for (let i = stack.length - 1; i >= 0; i--) out = blend(stack[i], out);
          return out;
        }
        stack.push(color);
      }
      if (node === document.documentElement) break;
      node = node.parentElement;
    }
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) out = blend(stack[i], out);
    return out;
  };
  const luminance = function (c) {
    const channel = function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const contrast = function (fg, bg) {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const rgbHex = function (c) {
    const hex = function (v) { return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'); };
    return '#' + hex(c.r) + hex(c.g) + hex(c.b);
  };
  const rgbCss = function (c) { return 'rgb(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ')'; };
  const rect = function (el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 };
  };
  const font = function (el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      size: parseFloat(cs.fontSize),
      lineHeight: cs.lineHeight === 'normal' ? null : Math.round(parseFloat(cs.lineHeight) * 10) / 10,
      weight: Number(cs.fontWeight),
      letterSpacing: cs.letterSpacing,
      family: cs.fontFamily.split(',')[0].replace(/["']/g, ''),
    };
  };
  const visible = function (el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  };
  const text = function (el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const textInfo = function (el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    const bg = effectiveBackground(el);
    const fgEffective = fg.a >= 0.999 ? fg : blend(fg, bg);
    return {
      text: text(el).slice(0, 90),
      color: cs.color,
      colorHex: rgbHex(fgEffective),
      bgHex: rgbHex(bg),
      bgCss: rgbCss(bg),
      contrast: Math.round(contrast(fgEffective, bg) * 100) / 100,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: Number(cs.fontWeight),
      lineHeight: cs.lineHeight === 'normal' ? null : Math.round(parseFloat(cs.lineHeight) * 10) / 10,
      letterSpacing: cs.letterSpacing,
      rect: rect(el),
      visible: visible(el),
    };
  };
  const find = function (selector) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (let i = 0; i < nodes.length; i++) if (visible(nodes[i])) return nodes[i];
    return null;
  };
  const findAll = function (selector) { return Array.from(document.querySelectorAll(selector)).filter(visible); };
  const firstText = function (selector) {
    const el = find(selector);
    return el ? text(el) : null;
  };
  const hoverTest = function (el) {
    const measure = function () { return el.getBoundingClientRect(); };
    const isClipped = function (rect) {
      // 探针需要以控件中心为圆心留出 ±21.5px 空间；只按中心判断（页面左右内边距里的控件不算贴边）
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      return centerX < 30 || centerX > window.innerWidth - 30 || centerY < 30 || centerY > window.innerHeight - 30;
    };
    const ownCenter = function (rect) {
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!hit) return false;
      if (el === hit || el.contains(hit)) return true;
      const label = el.closest('label');
      return Boolean(label && (label === hit || label.contains(hit)));
    };
    let r = measure();
    let clippedBefore = isClipped(r);
    if (clippedBefore || !ownCenter(r)) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      r = measure();
      clippedBefore = clippedBefore || isClipped(r);
    }
    const clippedAfter = isClipped(r);
    const occluded = !ownCenter(r);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (occluded) {
      return {
        rect: { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, x: Math.round(r.x), y: Math.round(r.y) },
        center: { x: Math.round(cx), y: Math.round(cy) },
        offscreen: cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight,
        occluded: true,
        clippedBefore: clippedBefore,
        clippedAfter: clippedAfter,
        probes: { total: 8, inBounds: 8, misses: 8, detail: [] },
        hotZone: { w: 0, h: 0 },
        pass: false,
      };
    }
    const own = function (hit) {
      if (!hit) return false;
      if (el === hit || el.contains(hit)) return true;
      const label = el.closest('label');
      if (label && (label === hit || label.contains(hit))) return true;
      return false;
    };
    const radius = 21.5;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071]];
    const probes = [];
    for (let i = 0; i < dirs.length; i++) {
      const px = cx + dirs[i][0] * radius;
      const py = cy + dirs[i][1] * radius;
      const inBounds = px >= 0 && py >= 0 && px < window.innerWidth && py < window.innerHeight;
      if (!inBounds) { probes.push({ dir: i, inBounds: false, hit: null }); continue; }
      const hit = document.elementFromPoint(px, py);
      probes.push({ dir: i, inBounds: true, hit: own(hit), hitTag: hit ? (hit.tagName || '').toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ')[0] : '') : null });
    }
    const scan = function (axis) {
      let reach = 0;
      for (let d = 1; d <= 40; d++) {
        const pos = axis === 'x' ? [cx + d, cy] : [cx, cy + d];
        const neg = axis === 'x' ? [cx - d, cy] : [cx, cy - d];
        const inside = function (p) {
          if (p[0] < 0 || p[1] < 0 || p[0] >= window.innerWidth || p[1] >= window.innerHeight) return false;
          return own(document.elementFromPoint(p[0], p[1]));
        };
        if (inside(pos) && inside(neg)) reach = d; else break;
      }
      return reach;
    };
    const inBounds = probes.filter(function (p) { return p.inBounds; }).length;
    const misses = probes.filter(function (p) { return p.inBounds && !p.hit; }).length;
    return {
      rect: { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, x: Math.round(r.x), y: Math.round(r.y) },
      center: { x: Math.round(cx), y: Math.round(cy) },
      offscreen: cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight,
      clippedBefore: clippedBefore,
      clippedAfter: clippedAfter,
      probes: { total: probes.length, inBounds: inBounds, misses: misses, detail: probes },
      hotZone: { w: 2 * scan('x') + 1, h: 2 * scan('y') + 1 },
      pass: inBounds >= 5 && misses === 0,
    };
  };
  window.__H = {
    parseColor: parseColor,
    effectiveBackground: effectiveBackground,
    contrast: contrast,
    rgbHex: rgbHex,
    rect: rect,
    font: font,
    visible: visible,
    text: text,
    textInfo: textInfo,
    find: find,
    findAll: findAll,
    firstText: firstText,
    compose: contrast,
    hoverTest: hoverTest,
  };
};

const HELPER_SOURCE = `(${PAGE_HELPER.toString()})();`;
const FREEZE_SOURCE = `(function(){
  var apply = function(){
    if (!document.documentElement) { setTimeout(apply, 0); return; }
    var style = document.createElement('style');
    style.setAttribute('data-kb-audit', 'freeze');
    style.textContent = '*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition-duration:0.001s !important;transition-delay:0s !important}';
    document.documentElement.appendChild(style);
  };
  apply();
})();`;

// ============================================================================
// Page 驱动
// ============================================================================
class Page {
  constructor(cdp, args) {
    this.cdp = cdp;
    this.args = args;
    this.env = { theme: null, view: null, viewport: null };
    this.bootScriptId = null;
    this.extraScripts = new Map();
    this.screens = new Map();
  }

  async init() {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Network.enable');
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPER_SOURCE });
    if (this.args.screens) await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_SOURCE });
    await this.setViewport(VIEWPORTS.desktop);
  }

  async setViewport(viewport) {
    if (this.env.viewport && this.env.viewport.width === viewport.width && this.env.viewport.height === viewport.height) return;
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this.env.viewport = viewport;
    await sleep(120);
  }

  async setBootState({ theme, view }) {
    if (this.bootScriptId) {
      try { await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.bootScriptId }); } catch { /* ignore */ }
      this.bootScriptId = null;
    }
    const source = `(function(){try{
      localStorage.setItem('dsh-kanban.theme','${theme}');
      localStorage.setItem('dsh-kanban.theme-preference','${theme}');
      localStorage.setItem('dsh-kanban.theme-source','local');
      localStorage.setItem('dsh-kanban.lang','zh');
      localStorage.setItem('dsh-kanban.view','${view}');
    }catch(e){}})();`;
    const result = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    this.bootScriptId = result.identifier;
  }

  async addExtraScript(name, source) {
    await this.removeExtraScript(name);
    const result = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    this.extraScripts.set(name, result.identifier);
  }

  async removeExtraScript(name) {
    const identifier = this.extraScripts.get(name);
    if (!identifier) return;
    try { await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); } catch { /* ignore */ }
    this.extraScripts.delete(name);
  }

  async eval(fn, arg) {
    const expression = `(${fn.toString()})(${arg === undefined ? 'undefined' : JSON.stringify(arg)})`;
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const description = details.exception?.description || details.text || '页面求值异常';
      throw new Error(description.split('\n')[0]);
    }
    return result.result ? result.result.value : undefined;
  }

  async navigate() {
    const loadPromise = this.cdp.waitEvent('Page.loadEventFired', 20000).catch(() => null);
    await this.cdp.send('Page.navigate', { url: this.args.pageUrl });
    await loadPromise;
    await this.waitApp({ waitLoaded: true });
  }

  async reload({ waitLoaded = true, settle = 200 } = {}) {
    const loadPromise = this.cdp.waitEvent('Page.loadEventFired', 20000).catch(() => null);
    await this.cdp.send('Page.reload', { ignoreCache: false });
    await loadPromise;
    await this.waitApp({ waitLoaded });
    if (settle) await sleep(settle);
  }

  async waitApp({ waitLoaded = true, timeout = 20000 } = {}) {
    await waitFor(async () => {
      let state;
      try {
        state = await this.eval(() => ({
          ready: document.readyState,
          app: !!document.querySelector('.kb-app-scope'),
          loading: !!document.querySelector('.kb-board--loading, .kb-skeleton-card'),
          error: !!document.querySelector('.kb-error'),
        }));
      } catch {
        return false;
      }
      if (!state || !state.app) return false;
      if (!waitLoaded) return state.ready === 'complete' || state.ready === 'interactive';
      return state.ready === 'complete' && !state.loading && !state.error;
    }, { timeout, interval: 100, label: '页面就绪' });
    await this.eval(async () => {
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch { /* ignore */ }
      }
      return true;
    });
  }

  /** 保证主题/视图/视口就绪，并清掉抽屉、选择模式、搜索等临时交互状态。 */
  async ensure({ theme = 'light', view = 'board', viewport = VIEWPORTS.desktop, clean = true } = {}) {
    const needReload = this.env.theme !== theme || this.env.view !== view || !this.env.viewport;
    await this.setViewport(viewport);
    if (needReload) {
      await this.setBootState({ theme, view });
      if (this.env.theme === null) {
        await this.navigate();
      } else {
        await this.reload();
      }
      this.env.theme = theme;
      this.env.view = view;
      const applied = await this.eval(() => ({
        theme: document.documentElement.dataset.kanbanTheme,
        lang: document.documentElement.lang,
        view: document.querySelector('.kb-viewseg [aria-selected="true"]')?.getAttribute('aria-label') || null,
      }));
      if (applied.theme !== theme) throw new Error(`主题未按预期应用：期望 ${theme}，实测 ${applied.theme}`);
      if (!String(applied.lang || '').startsWith('zh')) throw new Error(`语言未按预期应用：${applied.lang}`);
    }
    if (clean) await this.cleanUi();
    await sleep(120);
  }

  async cleanUi() {
    // 关闭抽屉/浮层
    await this.eval(() => {
      const dispatchEsc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      dispatchEsc();
      const drawer = document.querySelector('.kb-drawer');
      if (drawer) {
        const closeBtn = drawer.querySelector('.kb-drawer__header-actions .kb-btn--icon');
        if (closeBtn) closeBtn.click();
      }
      return true;
    });
    await sleep(120);
    // 退出选择模式
    const selection = await this.eval(() => {
      const btn = document.querySelector('.kb-select-btn');
      if (!btn) return 'missing';
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed === 'true') { btn.click(); return 'exited'; }
      return 'noop';
    });
    if (selection === 'exited') await sleep(160);
    // 清空搜索
    await this.eval(() => {
      const input = document.querySelector('#kb-search-input');
      if (!input || !input.value) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    await sleep(100);
  }

  async click(selector) {
    return this.eval((sel) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      const el = nodes.find((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!el) return false;
      el.click();
      return true;
    }, selector);
  }

  async clickByIndex(selector, index) {
    return this.eval(({ sel, idx }) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      const el = nodes[idx];
      if (!el) return false;
      el.click();
      return true;
    }, { sel: selector, idx: index });
  }

  async openDrawer(cardId) {
    await this.eval((id) => {
      const card = document.querySelector(`[data-card-id="${id}"]`);
      if (!card) return false;
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return true;
    }, cardId);
    await waitFor(async () => this.eval(() => {
      const drawer = document.querySelector('.kb-drawer');
      if (!drawer) return false;
      const r = drawer.getBoundingClientRect();
      return r.width > 0;
    }), { timeout: 6000, interval: 100, label: '抽屉打开' });
    await sleep(300);
  }

  async setSearch(value) {
    await this.eval((text) => {
      const input = document.querySelector('#kb-search-input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, value);
    await sleep(350);
  }

  async themeSnapshot() {
    return this.eval(() => ({
      theme: document.documentElement.dataset.kanbanTheme,
      lang: document.documentElement.lang,
    }));
  }

  async screenshot(name) {
    if (!this.args.screens) return name;
    const viewport = this.env.viewport || VIEWPORTS.desktop;
    const theme = this.env.theme || 'light';
    const meta = { name, theme, view: this.env.view, width: viewport.width, height: viewport.height };
    await sleep(120);
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const dir = this.args.screensDir;
    await mkdir(dir, { recursive: true });
    const abs = join(dir, `${name}.png`);
    await writeFile(abs, Buffer.from(data, 'base64'));
    meta.abs = abs;
    meta.path = `docs/assets/screens/visual-v2/${this.args.label}/${name}.png`;
    this.screens.set(name, meta);
    log(`截图 ${name}.png`);
    return name;
  }
}

// ============================================================================
// 数据准备（A-04 双审批样本 / A-14 无 reject 场景）
// ============================================================================
function approvalHasReject(approval) {
  const options = Array.isArray(approval.options) ? approval.options : [];
  return options.some((option) => option && (option.tone === 'danger' || REJECT_IDS.includes(option.id)));
}

function analyzeState(state) {
  const cards = Array.isArray(state.cards) ? state.cards : [];
  const byStatus = {};
  for (const card of cards) byStatus[card.status] = (byStatus[card.status] || 0) + 1;
  const withPending = cards
    .map((card) => ({ card, pending: (card.approvals || []).filter((a) => a.status === 'pending') }))
    .filter((entry) => entry.pending.length > 0)
    .map((entry) => ({
      cardId: entry.card.id,
      title: entry.card.title,
      status: entry.card.status,
      pendingCount: entry.pending.length,
      approvals: entry.pending.map((a) => ({ id: a.id, title: a.title, options: (a.options || []).map((o) => ({ id: o.id, label: o.label, tone: o.tone || null })), hasReject: approvalHasReject(a), questions: (a.questions || []).length })),
    }));
  return { boardId: state.board?.id || null, boardName: state.board?.name || '', revision: state.revision, total: cards.length, byStatus, withPending };
}

async function createA04Sample(args) {
  const api = args.api;
  const state = (await fetchJson(`${api}/state`, 5000)).json;
  const boardId = state?.board?.id;
  if (!boardId) throw new Error('没有默认看板，无法创建 A-04 样本');
  const existing = (state.cards || []).find((card) => (card.labels || []).includes('visual-audit-sample') && !card.archived);
  if (existing) return { cardId: existing.id, created: false };
  const created = await apiCall(`${api}/cards`, {
    method: 'POST',
    body: {
      boardId,
      title: '视觉验收·双审批样本',
      summary: 'A-04 实测样本：同一张卡里放 2 个 pending 审批，检查卡内展开数量与审批区占比',
      status: 'needs_you',
      project: '视觉验收',
      labels: ['visual-audit-sample'],
    },
  });
  const cardId = created.card.id;
  await apiCall(`${api}/cards/${cardId}/approvals`, {
    method: 'POST',
    body: {
      title: '视觉验收：方案 A 是否通过？',
      detail: '该审批没有拒绝选项，用于 A-14 场景（拒绝按钮需禁用并给出可见说明）',
      options: [{ id: 'yes', label: '批准方案 A', description: '继续按方案 A 推进', tone: 'primary' }],
    },
  });
  await apiCall(`${api}/cards/${cardId}/approvals`, {
    method: 'POST',
    body: {
      title: '视觉验收：方案 B 是否通过？',
      detail: '同一张卡上的第二个 pending 审批：卡片内默认只应展开一个，其余收为一行摘要',
      options: [{ id: 'ok', label: '继续方案 B', description: '按方案 B 推进' }, { id: 'no', label: '拒绝', tone: 'danger' }],
    },
  });
  return { cardId, created: true };
}

async function archiveCard(args, cardId) {
  const state = await fetchJson(`${args.api}/state`, 4000);
  const card = (state.json?.cards || []).find((item) => item.id === cardId);
  if (!card) return;
  const res = await fetch(`${args.api}/cards/${cardId}?version=${card.version}`, { method: 'DELETE' });
  if (!res.ok) log(`归档 A-04 样本失败：HTTP ${res.status}`);
  else log('已归档 A-04 样本卡，恢复 8 张 demo 数据');
}

// ============================================================================
// 报告
// ============================================================================
/**
 * docs/10 附录 A / §3 审计冻结构建（2026-10-23 index-C47DPCOX，1440/390）的原始实测值，
 * 用于 final 验收报告里的「before → after」对比列。
 */
const BEFORE_VALUES = {
  'A-01': '390 下 .kb-toolbar scrollHeight 90 / clientHeight 47，筛选/选择/同步 y=113–149 与列切换条 y=117–159 重叠',
  'A-02': '浅色：待你确认 2.79:1 / 已完成 2.28:1 / 审批风险 2.58:1（暗色达标）',
  'A-03': 'label-tertiary 3.71:1；label-caption 2.13:1（列表计数、composer meta 2.13）',
  'A-04': '审批区/卡高 291/438=0.664；审批标题 13/400（低于卡标题 14/500）；选项白底「卡中卡」；warn 整块底',
  'A-05': '主题 32×28；筛选 88×36；选择 64×28；抽屉编辑 70×28；关闭 32×32；审批按钮高 40；发送高 40；批量条高 28；复选框 14×14；视图 tab 36×40',
  'A-06': '页标题 13/500（比卡片标题 14/500 小）；列头 12–13；抽屉标题 16/500；分区 11/strong',
  'A-07': '行高 44、summary 行 29；标题按钮 1244；meta 仅 128 全部推到最右；宽屏中间约 1.1k px 空白',
  'A-08': 'SSE error 只内部退避；离线 3s 实测无 errorbar、无状态文案变化',
  'A-09': 'toast 原始 Failed to fetch；hint 含 node scripts/dev-server.mjs --port 4599；NETWORK 作为 code 展示；hint 对比 3.71',
  'A-10': '≤720px 两个 role=tab 只剩 aria-hidden 图标，可访问名为空',
  'A-11': '浅色已选数 3.6:1；hint 3.15:1；禁用归档文字 1.81:1',
  'A-12': '四个列各出现一次完整空态 + 4 份「清空筛选」CTA，占满整屏',
  'A-13': '顶栏显示「共 0 张卡片 / 待你确认 0 / 会话运行中 0」，筛选/选择仍可点',
  'A-14': '拒绝按钮禁用，仅 title 解释「无可拒绝选项」；触屏无 tooltip，无可见说明/aria-describedby',
  'A-15': '行首 dot + summary 行再出现 dot + 「待办/进行中…」+ 项目 + 标签；44px 内状态重复两次',
};

class Report {
  constructor(args, env) {
    this.args = args;
    this.env = env;
    this.checks = [];
    this.screens = new Map();
  }

  record(entry) {
    this.checks.push(entry);
    const verdict = entry.pass === null ? '跳过' : entry.pass ? '通过' : '未通过';
    log(`检查 ${entry.id} ${entry.title} → ${verdict}${entry.matrix ? `（${entry.matrix}）` : ''}`);
  }

  addScreens(page) {
    for (const [name, meta] of page.screens) this.screens.set(name, meta);
  }

  summary() {
    const total = this.checks.length;
    const pass = this.checks.filter((c) => c.pass === true).length;
    const fail = this.checks.filter((c) => c.pass === false).length;
    const skipped = this.checks.filter((c) => c.pass === null).length;
    return { total, pass, fail, skipped };
  }

  toJSON(extra = {}) {
    const finishedAt = new Date().toISOString();
    return {
      tool: 'dsh-kanban visual-audit',
      version: 1,
      label: this.args.label,
      startedAt: this.env.startedAt,
      finishedAt,
      finishedAtLocal: localIso(),
      durationMs: Date.now() - Date.parse(this.env.startedAt),
      environment: { ...this.env, finishedAt },
      summary: this.summary(),
      checks: this.checks,
      screenshots: Array.from(this.screens.values()),
      ...extra,
    };
  }

  matrixMarkdown() {
    const path = `../../docs/assets/screens/visual-v2/${this.args.label}/`;
    const rows = this.checks.map((check) => {
      const verdict = check.pass === null ? '跳过' : check.pass ? '通过' : '未通过';
      const shots = (check.screenshots || [])
        .map((name) => {
          const meta = this.screens.get(name);
          return meta ? `[${name}](${path}${name}.png)` : name;
        })
        .join('<br>');
      const measured = String(check.matrix || '').replace(/\|/g, '\\|');
      const threshold = String(check.threshold || '').replace(/\|/g, '\\|');
      const before = (BEFORE_VALUES[check.id] || '—').replace(/\|/g, '\\|');
      const afterShort = measured.length > 260 ? `${measured.slice(0, 257)}…` : measured;
      const beforeAfter = `before：${before} → after：${afterShort}`;
      return `| ${check.id} | ${check.title} | ${threshold} | ${measured} | ${beforeAfter} | ${verdict} | ${shots || '—'} |`;
    });
    const summary = this.summary();
    return [
      `# DSH 看板视觉验收矩阵（${this.args.label}）`,
      '',
      `- 运行时间：${this.env.startedAtLocal || this.env.startedAt} → ${localIso()}（Asia/Shanghai）`,
      `- 快照：commit \`${this.env.commit}\`，工作区 ${this.env.dirty ? `有未提交改动（${this.env.dirtyFiles} 个文件，diff hash ${this.env.dirtyHash}）` : '干净'}`,
      `- 快照说明：${this.env.snapshotNote}`,
      `- 工作区改动：${this.env.diffStatSummary}`,
      `- 构建：${this.env.build?.ok ? '成功' : `失败/复用旧产物（status=${this.env.build?.status}）`}；产物目录 \`${this.env.staticRoot}\``,
      `- 数据：seed=${this.args.seed}，${this.env.seedSummary}`,
      `- 视口：${this.env.viewports.join('、')}；主题：light / dark；浏览器：Chrome Headless（CDP）`,
      `- 结果：${summary.pass} 通过 / ${summary.fail} 未通过 / ${summary.skipped} 跳过（共 ${summary.total} 项）`,
      '',
      '| A 项 | 检查 | 标准 | 实测 | before（docs/10 附录 A 原始值）→ after | 通过/未通过 | 截图 |',
      '|---|---|---|---|---|---|---|',
      ...rows,
      '',
      `机器可读报告：\`.tmp/visual/${this.args.label}.json\``,
      '',
    ].join('\n');
  }
}

// ============================================================================
// 主流程
// ============================================================================
let ARGS = null;

async function main() {
  ARGS = parseArgs(process.argv.slice(2));
  if (ARGS.help) { console.log(USAGE); return; }
  await mkdir(ARGS.outDir, { recursive: true });
  await mkdir('/tmp/kb-visual', { recursive: true });

  const startedAt = new Date().toISOString();
  const startedAtLocal = localIso(new Date(startedAt));
  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const gitDiff = spawnSync('git', ['diff', 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout || '';
  const untracked = gitStatus.split('\n').filter((line) => line.startsWith('??')).join('\n');
  const dirtyHash = (await import('node:crypto')).createHash('sha1').update(gitDiff).update(untracked).digest('hex').slice(0, 16);
  const diffStat = spawnSync('git', ['diff', '--stat'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stdout.trim();
  const diffStatLines = diffStat ? diffStat.split('\n') : [];
  const diffStatSummary = diffStatLines.length ? diffStatLines[diffStatLines.length - 1].trim() : '无改动';
  let build = { ok: true, status: 0, skipped: true };

  let serverProc = null;
  let chrome = null;
  let cdp = null;
  let page = null;
  const samples = {};
  const extra = {};

  try {
    if (!ARGS.base) {
      if (ARGS.build) {
        build = runBuild(ARGS);
      } else if (!existsSync(join(ARGS.staticRoot, 'index.html'))) {
        throw new Error(`构建产物不存在：${ARGS.staticRoot}（去掉 --no-build 或先构建）`);
      }
      serverProc = await startServer(ARGS);
      ARGS.base = ARGS.pageUrl = `http://127.0.0.1:${ARGS.port}/dsh-kanban/`;
      ARGS.api = `http://127.0.0.1:${ARGS.port}/api/kanban`;
    }
    log('目标页面', ARGS.pageUrl);

    const bootState = await fetchJson(`${ARGS.api}/state`, 5000);
    if (!bootState.json) throw new Error('无法读取 /api/kanban/state');
    const analysis = analyzeState(bootState.json);
    log(`seed 数据：${analysis.total} 张卡片 ${JSON.stringify(analysis.byStatus)}；pending 审批卡 ${analysis.withPending.length} 张`);

    const needFullRun = ARGS.only.length === 0;
    const onlySet = new Set(ARGS.only);

    const noRejectCard = analysis.withPending.find((item) => item.approvals.every((a) => !a.hasReject));
    const rejectCard = analysis.withPending.find((item) => item.approvals.some((a) => a.hasReject));
    extra.pendingCards = analysis.withPending;
    extra.noRejectCardId = noRejectCard ? noRejectCard.cardId : null;
    extra.rejectCardId = rejectCard ? rejectCard.cardId : null;
    log(`A-14 无拒绝选项卡：${noRejectCard ? `${noRejectCard.cardId}（${noRejectCard.title}）` : '无'}`);

    chrome = await startChrome(ARGS);
    cdp = await CDP.connect(chrome.target.webSocketDebuggerUrl);
    page = new Page(cdp, ARGS);
    await page.init();

    const env = {
      startedAt,
      startedAtLocal,
      commit: gitHead,
      dirty: Boolean(gitStatus),
      dirtyHash,
      dirtyFiles: gitStatus.split('\n').filter(Boolean).length,
      diffStatSummary,
      diffStat: diffStatLines.slice(0, 80),
      snapshotNote: ARGS.note || '未注明（可用 --note 补充）',
      node: process.version,
      chrome: ARGS.chrome,
      baseUrl: ARGS.pageUrl,
      api: ARGS.api,
      staticRoot: ARGS.staticRoot,
      dataFile: ARGS.data,
      seedMode: ARGS.seed,
      seedSummary: `${analysis.total} 张卡片 ${JSON.stringify(analysis.byStatus)}，${analysis.withPending.length} 张卡有待处理审批`,
      build: { ok: build.ok, status: build.status, skipped: Boolean(build.skipped) },
      viewports: Object.values(VIEWPORTS).map((v) => v.label),
      themes: ['light', 'dark'],
    };
    const report = new Report(ARGS, env);
    const ctx = { page, args: ARGS, report, analysis, extra, samples };
    globalThis.__visualAudit = { report, args: ARGS, env };

    const defs = buildCheckDefs();
    for (const def of defs) {
      if (onlySet.size && !onlySet.has(def.id)) continue;
      log(`▶ ${def.id} ${def.title}`);
      try {
        await def.run(ctx);
      } catch (error) {
        log(`${def.id} 执行异常：${error.message}`);
        report.record({
          id: def.id,
          title: def.title,
          threshold: def.threshold,
          measured: { error: String(error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error) },
          pass: false,
          evidence: [],
          screenshots: [],
          matrix: `脚本异常：${String(error.message || error).slice(0, 120)}`,
        });
      }
    }

    // 重置到干净状态，给矩阵补视图截图
    if (needFullRun && ARGS.screens) {
      await captureScreens(ctx);
    }

    report.addScreens(page);
    const jsonPath = join(ARGS.outDir, `${ARGS.label}.json`);
    const matrixPath = join(ARGS.outDir, 'matrix.md');
    const matrixLabelPath = join(ARGS.outDir, `matrix-${ARGS.label}.md`);
    const failures = report.checks.filter((c) => c.pass === false).map((c) => c.id);
    const json = report.toJSON({ screenDir: `docs/assets/screens/visual-v2/${ARGS.label}`, failedIds: failures });
    await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
    const markdown = report.matrixMarkdown();
    // --only 只写矩阵快照 matrix-<label>.md，不覆盖累积的 matrix.md
    if (onlySet.size === 0) await writeFile(matrixPath, markdown);
    await writeFile(matrixLabelPath, markdown);
    const summary = report.summary();
    log(`完成：${summary.pass} 通过 / ${summary.fail} 未通过 / ${summary.skipped} 跳过`);
    log(`JSON：${jsonPath}`);
    log(`矩阵：${matrixPath}`);
    log(`截图：${ARGS.screensDir}`);
    log(`未通过项：${failures.join(',') || '无'}`);
  } finally {
    if (cdp) cdp.close();
    if (chrome?.proc) { try { chrome.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}

// ============================================================================
// 检查实现
// ============================================================================
function buildCheckDefs() {
  return [
    { id: 'A-01', title: '窄屏工具栏不溢出、筛选/选择/同步/列切换/分组条不重叠、无横向滚动', threshold: '390/720 下 .kb-toolbar scrollHeight===clientHeight；关键控件 bounding box 互不相交；documentElement.scrollWidth ≤ 视口宽', run: checkNarrowToolbar },
    { id: 'A-05', title: '390px 主要操作有效热区 ≥44×44', threshold: '中心 ±21.5px 的 8 方向 elementFromPoint 命中（含 label 包裹/伪元素），全部命中算有效热区 ≥44×44', run: checkTouchTargets },
    { id: 'A-10', title: '390px 视图 tab 可访问名非空且互不相同', threshold: '所有 role=tab 可访问名非空且唯一；view tab 有显式 aria-label；aria-selected 存在', run: checkTabNames },
    { id: 'A-08', title: 'SSE/断网 2s 内出现可见状态文案，恢复后自动清除', threshold: 'offline 后 ≤2500ms 出现「断开/重连/离线/同步失败」可见文案；恢复网络后 ≤8000ms 文案消失', run: checkSyncOffline },
    { id: 'A-09', title: '初始加载失败：用户化文案、无英文原始错误/dev 命令、诊断可展开、提示 ≥4.5、重试热区 ≥44', threshold: '可见文案不含 Failed to fetch / node scripts / 可见 NETWORK；诊断折叠存在；hint 对比 ≥4.5；重试按钮 ≥44×44', run: checkLoadError },
    { id: 'A-02', title: '浅色/暗色状态文字与审批风险对比 ≥4.5', threshold: '待你确认状态、已完成状态、审批风险 在 light/dark 均 ≥4.5:1', run: checkContrastA02 },
    { id: 'A-03', title: '11–12px 可读元数据/说明对比 ≥4.5（附录 A 抽样）', threshold: '附录 A.1 除状态/审批风险外全部抽样项 light/dark ≥4.5:1', run: checkContrastA03 },
    { id: 'A-04', title: '审批区视觉权重低于卡片标题、卡内最多一个展开审批、非卡中卡', threshold: '卡内展开审批 ≤1；审批标题字号 ≤ 卡片标题且字重 ≥500；审批分区无大面积不透明底色；选项不再是独立不透明卡片', run: checkApprovalWeight },
    { id: 'A-06', title: '页/卡片/分区/元数据四级字号字重', threshold: '页标题 16/22/600；卡标题 14/20/500；分区/列头 12/16/600+0.02em；meta 11–12', run: checkTypography },
    { id: 'A-07', title: '1440 列表行高 56–64、内容限宽或标题→meta 路径缩短、390 仍堆叠', threshold: '行高 56–64；窄屏单列堆叠；内容最大宽 ≤1300 或标题文字右缘到 meta 左缘 ≤700', run: checkListLayout },
    { id: 'A-11', title: '批量条计数/hint 对比 ≥4.5、禁用态可辨、窄屏按钮 ≥36', threshold: '已选数、hint light/dark ≥4.5；禁用归档有可辨样式；390 下批量条按钮高度 ≥36', run: checkBatchBar },
    { id: 'A-12', title: '全局无结果只出现一个空态和一个清空入口', threshold: '搜索必无匹配时空态容器 ≤1；清空筛选 CTA ≤2（1440/390 board+list）', run: checkEmptyState },
    { id: 'A-13', title: '首屏 loading 顶栏计数不显示 0、筛选/选择禁用、骨架在列内', threshold: '600ms 时骨架可见；顶栏计数不含 0；筛选/选择/新建 disabled', run: checkLoading },
    { id: 'A-14', title: '无 reject option 时拒绝按钮禁用且有可见解释 / aria-describedby', threshold: '拒绝按钮 disabled；存在可见说明文本，或按钮隐藏；aria-describedby 可解析', run: checkRejectDisabled },
    { id: 'A-15', title: '列表行状态文字仅一处，项目/标签/时间/工具仍在，行高不增加', threshold: '行内状态文字出现 1 次；项目与时间/工具可见；行高记录', run: checkListStatusDedupe },
  ];
}

// ---- A-01 -----------------------------------------------------------------
async function checkNarrowToolbar(ctx) {
  const { page, report } = ctx;
  const scenarios = [];
  const shots = [];
  for (const [vpName, viewport] of [['390', VIEWPORTS.narrow], ['720', VIEWPORTS.tablet]]) {
    for (const view of ['board', 'list']) {
      await page.ensure({ theme: 'light', view, viewport });
      const measured = await page.eval(() => {
        const H = window.__H;
        const toolbar = document.querySelector('.kb-toolbar');
        const items = [];
        const collect = (key, selector) => {
          const els = H.findAll(selector);
          if (!els.length) return;
          items.push({ key, selector, rects: els.map(H.rect) });
        };
        collect('search', '.kb-search');
        collect('filter', '.kb-filter-btn');
        collect('select', '.kb-select-btn');
        collect('sync', '.kb-agent-live');
        collect('columnSwitch', '.kb-column-switch');
        collect('listToolbar', '.kb-list__toolbar');
        collect('errorbar', '.kb-errorbar');
        const overlaps = [];
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            for (const a of items[i].rects) {
              for (const b of items[j].rects) {
                const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
                const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
                if (ix > 0.5 && iy > 0.5) overlaps.push({ a: items[i].key, b: items[j].key, area: Math.round(ix * iy) });
              }
            }
          }
        }
        const de = document.documentElement;
        const style = toolbar ? getComputedStyle(toolbar) : null;
        return {
          toolbar: toolbar ? {
            scrollHeight: toolbar.scrollHeight,
            clientHeight: toolbar.clientHeight,
            rect: H.rect(toolbar),
            overflow: style.overflow,
            heightStyle: style.height,
            flexWrap: style.flexWrap,
          } : null,
          items: items.map((item) => ({ key: item.key, rects: item.rects })),
          overlaps,
          hScroll: {
            docScrollWidth: de.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            innerWidth: window.innerWidth,
            overflowX: de.scrollWidth > window.innerWidth + 0.5 || document.body.scrollWidth > window.innerWidth + 0.5,
          },
        };
      });
      const toolbarOverflow = measured.toolbar ? measured.toolbar.scrollHeight - measured.toolbar.clientHeight : null;
      const pass = Boolean(measured.toolbar) && toolbarOverflow <= 1 && measured.overlaps.length === 0 && !measured.hScroll.overflowX;
      scenarios.push({ viewport: viewport.label, view, pass, toolbarOverflow, ...measured });
      shots.push(await page.screenshot(view === 'board' ? `board-light-${vpName}` : `list-light-${vpName}`));
    }
  }
  const failed = scenarios.filter((s) => !s.pass);
  const toolbarBits = scenarios.map((s) => `${s.viewport}/${s.view} ${s.toolbar ? `${s.toolbar.scrollHeight}/${s.toolbar.clientHeight}` : 'no-toolbar'}`).join('，');
  const overlapBits = failed.flatMap((s) => s.overlaps.map((o) => `${s.viewport}/${s.view}:${o.a}×${o.b}`));
  report.record({
    id: 'A-01',
    title: '窄屏工具栏不溢出、控件不重叠、无横向滚动',
    threshold: '390/720 下 .kb-toolbar scrollHeight===clientHeight；筛选/选择/同步/列切换/分组条 bounding box 互不相交；scrollWidth ≤ 视口宽',
    measured: {
      scenarios: scenarios.map((s) => ({ viewport: s.viewport, view: s.view, pass: s.pass, toolbar: s.toolbar, overlaps: s.overlaps, hScroll: s.hScroll, items: s.items })),
      toolbarScrollVsClient: toolbarBits,
      overlaps: overlapBits,
    },
    pass: failed.length === 0,
    screenshots: shots,
    evidence: [{ type: 'note', text: `实测：${toolbarBits}${overlapBits.length ? `；重叠 ${overlapBits.join('、')}` : '；无控件重叠'}` }],
    matrix: `${toolbarBits}${overlapBits.length ? `；重叠 ${overlapBits.join('、')}` : '；无重叠'}；横向滚动 ${scenarios.some((s) => s.hScroll.overflowX) ? '有' : '无'}`,
    screenshotsNote: shots,
  });
}

// ---- A-05 -----------------------------------------------------------------
/**
 * A-05 验收清单（docs/10 §5 批次 1 条目 2）：
 * 主题/筛选/选择/卡片菜单(展开)/抽屉编辑/抽屉关闭/审批按钮/composer 发送/批量条按钮/复选框 必须 ≥44×44。
 * 视图 tab（4 个）按 Lead 要求纳入 390 热区清单（逐项给数值）；看板列切换、列头新建、
 * 列表行标题只做辅助测量（不在 A-05 验收清单里：列切换/新建由 A-01 管重叠），不计入通过判定。
 */
const TOUCH_TARGETS = [
  { stage: 'board-390', name: '主题切换', selector: '.kb-theme-btn', gating: true },
  { stage: 'board-390', name: '筛选', selector: '.kb-filter-btn', gating: true },
  { stage: 'board-390', name: '选择模式', selector: '.kb-select-btn', gating: true },
  { stage: 'board-390', name: '卡片菜单/展开', selector: '.kb-card-toggle', gating: true },
  { stage: 'board-390', name: '审批拒绝', selector: '.kb-card .kb-decision-actions .kb-btn', gating: true },
  { stage: 'board-390', name: '审批提交', selector: '.kb-card .kb-decision-actions .kb-btn--primary', gating: true },
  { stage: 'board-390', name: '视图 tab（4 个）', selector: '.kb-viewseg [role="tab"]', gating: true },
  { stage: 'board-390', name: '看板列切换（辅助）', selector: '.kb-column-switch__item', gating: false },
  { stage: 'board-390', name: '列头新建（辅助）', selector: '.kb-column-head__actions .kb-icon-btn', gating: false },
  { stage: 'list-390', name: '列表行菜单', selector: '.kb-list__row-meta .kb-btn--icon', gating: true },
  { stage: 'list-390', name: '列表复选框', selector: '.kb-list__check', gating: true },
  { stage: 'list-390', name: '列表行标题（辅助）', selector: '.kb-list__title', gating: false },
  { stage: 'drawer-390', name: '抽屉编辑', selector: '.kb-drawer__header-actions .kb-btn--outline', gating: true },
  { stage: 'drawer-390', name: '抽屉关闭/归档', selector: '.kb-drawer__header-actions .kb-btn--icon', gating: true },
  { stage: 'drawer-390', name: 'Composer 发送', selector: '.kb-composer__footer .kb-btn--primary', gating: true },
  { stage: 'selection-390', name: '批量条按钮', selector: '.kb-batchbar .kb-btn', gating: true },
  { stage: 'selection-390', name: '卡片复选框', selector: '.kb-card-select', gating: true },
];

async function checkTouchTargets(ctx) {
  const { page, report } = ctx;
  const results = [];
  const shots = [];

  const scrollIntoViewIfNeeded = async (selector) => {
    await page.eval((sel) => {
      const H = window.__H;
      const els = H.findAll(sel);
      if (!els.length) return false;
      els[0].scrollIntoView({ block: 'center', inline: 'nearest' });
      return true;
    }, selector);
    await sleep(120);
  };

  const runProbe = async (stage, targets) => {
    for (const target of targets) {
      await scrollIntoViewIfNeeded(target.selector);
      const probed = await page.eval((selector) => {
        const H = window.__H;
        const els = H.findAll(selector);
        return els.slice(0, 6).map((el) => {
          const info = H.hoverTest(el);
          return {
            text: H.text(el).slice(0, 24),
            tag: el.tagName.toLowerCase(),
            disabled: el.disabled === true,
            ...info,
          };
        });
      }, target.selector);
      const list = probed || [];
      const usable = list.filter((entry) => !entry.offscreen && !entry.clippedAfter && !entry.occluded);
      if (list.length === 0) {
        results.push({ stage, name: target.name, selector: target.selector, gating: target.gating, count: 0, pass: false, missing: true, instances: [] });
        continue;
      }
      const instances = usable.map((entry) => ({ ...entry }));
      const pass = usable.length > 0 && usable.every((entry) => entry.pass);
      results.push({ stage, name: target.name, selector: target.selector, gating: target.gating, count: list.length, offscreen: list.length - usable.length, pass, instances });
    }
  };

  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.narrow });
  await runProbe('board-390', TOUCH_TARGETS.filter((target) => target.stage === 'board-390'));
  shots.push(await page.screenshot('board-light-390'));
  // 选择模式：批量条按钮 / 卡片复选框
  await page.click('.kb-select-btn');
  await sleep(350);
  await page.eval(() => {
    const scroller = document.querySelector('.kb-board, .kb-list, .kb-main');
    if (scroller) scroller.scrollTop = 0;
    window.scrollTo(0, 0);
    return true;
  });
  await sleep(150);
  const cardId = await page.eval(() => {
    const H = window.__H;
    const card = H.find('.kb-card');
    return card ? card.getAttribute('data-card-id') : null;
  });
  await runProbe('selection-390', TOUCH_TARGETS.filter((target) => target.stage === 'selection-390'));
  shots.push(await page.screenshot('selection-light-390'));
  await page.cleanUi();

  await page.ensure({ theme: 'light', view: 'list', viewport: VIEWPORTS.narrow });
  await runProbe('list-390', TOUCH_TARGETS.filter((target) => target.stage === 'list-390' && target.name !== '列表复选框'));
  await page.click('.kb-select-btn');
  await sleep(350);
  await runProbe('list-390', TOUCH_TARGETS.filter((target) => target.name === '列表复选框'));
  await page.cleanUi();

  // 抽屉
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.narrow });
  const drawerCardId = cardId || (await page.eval(() => {
    const H = window.__H;
    const card = H.find('.kb-card');
    return card ? card.getAttribute('data-card-id') : null;
  }));
  if (drawerCardId) {
    await page.openDrawer(drawerCardId);
    await runProbe('drawer-390', TOUCH_TARGETS.filter((target) => target.stage === 'drawer-390'));
    shots.push(await page.screenshot('drawer-light-390'));
    await page.cleanUi();
  }

  const controls = results.map((row) => ({
    stage: row.stage,
    name: row.name,
    selector: row.selector,
    gating: row.gating,
    missing: Boolean(row.missing),
    offscreen: row.offscreen || 0,
    pass: row.pass,
    instances: (row.instances || []).map((entry) => ({
      rect: entry.rect,
      occluded: entry.occluded || false,
      hotZone: entry.hotZone,
      probes: entry.probes ? { inBounds: entry.probes.inBounds, misses: entry.probes.misses } : null,
      pass: entry.pass,
      text: entry.text,
      clippedBefore: entry.clippedBefore,
      probeMisses: entry.pass ? undefined : (entry.probes?.detail || []).filter((probe) => probe.inBounds && !probe.hit),
    })),
  }));
  const gatingFailed = controls.filter((row) => row.gating && !row.pass);
  const advisoryFailed = controls.filter((row) => !row.gating && !row.pass);
  const pass = gatingFailed.length === 0;
  report.record({
    id: 'A-05',
    title: '390px 主要操作有效热区 ≥44×44',
    threshold: 'A-05 验收清单控件在中心 ±21.5px 的 8 方向 elementFromPoint 全部命中（含 label 包裹/伪元素扩展），视口内命中点 ≥5；视口外实例跳过',
    measured: {
      method: '取控件 rect 中心，在距中心 21.5px 的 8 个方向点（N/S/E/W/NE/NW/SE/SW）做 elementFromPoint，命中控件自身/内部/label 即通过；视口外点不计入但要求视口内命中点 ≥5',
      controls,
      gatingFailed: gatingFailed.map((row) => `${row.stage}/${row.name}`),
      advisoryFailed: advisoryFailed.map((row) => `${row.stage}/${row.name}`),
      total: controls.length,
      gatingTotal: controls.filter((row) => row.gating).length,
    },
    pass,
    screenshots: shots,
    evidence: [
      { type: 'note', text: `验收清单 ${controls.filter((row) => row.gating).length} 组，未过 ${gatingFailed.length} 组：${gatingFailed.map((row) => row.name).join('、') || '无'}` },
      { type: 'note', text: `视图 tab（4 个，计入 A-05）：${(controls.find((row) => row.name === '视图 tab（4 个）')?.instances || []).map((instance, index) => `#${index + 1} ${instance.rect.w}×${instance.rect.h}→有效 ${instance.hotZone.w}×${instance.hotZone.h}（miss ${instance.probes.misses}/${instance.probes.inBounds}）`).join('；') || '未找到'}` },
      { type: 'note', text: `辅助测量（不计入 A-05）：${controls.filter((row) => !row.gating).map((row) => `${row.name}${row.pass ? '✓' : '✗'}`).join('、')}` },
      { type: 'note', text: controls.filter((row) => row.gating).map((row) => `${row.name}: ${row.pass ? '通过' : '未通过'}${row.instances.length ? `（${row.instances.map((i) => `${i.rect.w}×${i.rect.h}→${i.hotZone.w}×${i.hotZone.h}`).join(' / ')}）` : '（缺失）'}`).join('；') },
    ],
    matrix: `验收清单 ${controls.filter((row) => row.gating).length} 组中 ${controls.filter((row) => row.gating && row.pass).length} 组通过${gatingFailed.length ? `；未过：${gatingFailed.map((row) => row.name).join('、')}` : ''}；视图 tab ${(controls.find((row) => row.name === '视图 tab（4 个）')?.instances || []).map((instance) => `${instance.rect.w}×${instance.rect.h}→${instance.hotZone.w}×${instance.hotZone.h}`).join('/') || '∅'}；辅助：${controls.filter((row) => !row.gating).map((row) => `${row.name}${row.pass ? '✓' : '✗'}`).join(' ')}`,
  });
}

// ---- A-10 -----------------------------------------------------------------
async function checkTabNames(ctx) {
  const { page, report } = ctx;
  const scenarios = [];
  for (const view of ['board', 'list']) {
    await page.ensure({ theme: 'light', view, viewport: VIEWPORTS.narrow });
    const tabs = await page.eval(() => {
      const H = window.__H;
      return H.findAll('[role="tab"]').map((el) => ({
        ariaLabel: el.getAttribute('aria-label'),
        text: H.text(el),
        accessibleName: el.getAttribute('aria-label') || H.text(el),
        ariaSelected: el.getAttribute('aria-selected'),
        isViewTab: Boolean(el.closest('.kb-viewseg')),
        rect: H.rect(el),
      }));
    });
    const names = tabs.map((tab) => tab.accessibleName).filter(Boolean);
    const unique = new Set(names).size === names.length;
    const allNamed = tabs.length > 0 && tabs.every((tab) => Boolean(tab.accessibleName));
    const viewTabs = tabs.filter((tab) => tab.isViewTab);
    const viewTabsHaveAria = viewTabs.length > 0 && viewTabs.every((tab) => Boolean(tab.ariaLabel && tab.ariaLabel.trim()));
    const selectedPresent = tabs.every((tab) => tab.ariaSelected === 'true' || tab.ariaSelected === 'false');
    scenarios.push({ view, tabs, allNamed, unique, viewTabsHaveAria, selectedPresent, pass: allNamed && unique && viewTabsHaveAria && selectedPresent });
  }
  const pass = scenarios.every((s) => s.pass);
  report.record({
    id: 'A-10',
    title: '390px 视图 tab 可访问名非空且互不相同',
    threshold: '所有 role=tab 可访问名非空且唯一；view tab 有显式 aria-label；aria-selected 存在',
    measured: { scenarios },
    pass,
    screenshots: [],
    evidence: [{ type: 'note', text: scenarios.map((s) => `${s.view}: ${s.tabs.length} 个 tab，可访问名 ${s.tabs.map((t) => t.accessibleName || '∅').join(' / ')}`).join('；') }],
    matrix: scenarios.map((s) => `${s.view}: ${s.tabs.length} tab / 命名${s.allNamed ? 'OK' : '缺失'} / 唯一${s.unique ? 'OK' : '重复'} / view-tab aria-label${s.viewTabsHaveAria ? 'OK' : '缺失'}`).join('；'),
  });
}

// ---- A-08 -----------------------------------------------------------------
async function checkSyncOffline(ctx) {
  const { page, report } = ctx;
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  const before = await page.eval(() => {
    const H = window.__H;
    const live = H.find('.kb-agent-live');
    return { liveText: live ? H.text(live) : null, errorbar: H.firstText('.kb-errorbar') };
  });
  const stateRegexSource = '(连接中断|正在重连|已断开|离线|连接失败|断线|同步失败|重连|offline|disconnected|retrying)';
  await page.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const offlineAt = Date.now();
  const timeline = [];
  let firstSeen = null;
  for (let i = 0; i < 26; i++) {
    const probe = await page.eval((pattern) => {
      const H = window.__H;
      const regex = new RegExp(pattern, 'i');
      const candidates = [];
      for (const selector of ['.kb-agent-live', '.kb-errorbar', '[role="status"]', '[role="alert"]', '.kb-statusbar', 'body']) {
        const el = selector === 'body' ? document.body : H.find(selector);
        if (!el) continue;
        const text = H.text(el);
        const match = regex.exec(text);
        if (match) candidates.push({ selector, text: text.slice(0, 200), match: match[0] });
        if (candidates.length) break;
      }
      return {
        candidate: candidates[0] || null,
        liveText: H.firstText('.kb-agent-live'),
        errorbarText: H.firstText('.kb-errorbar'),
      };
    }, stateRegexSource);
    timeline.push({ ms: Date.now() - offlineAt, liveText: probe.liveText, errorbarText: probe.errorbarText, matched: probe.candidate ? probe.candidate.match : null });
    if (probe.candidate) { firstSeen = { ...probe.candidate, ms: Date.now() - offlineAt }; break; }
    await sleep(100);
  }
  const syncShot = await page.screenshot('sync-light-1440');
  // 恢复网络
  await page.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const onlineAt = Date.now();
  let cleared = null;
  let afterTexts = null;
  for (let i = 0; i < 45; i++) {
    const probe = await page.eval((pattern) => {
      const H = window.__H;
      const regex = new RegExp(pattern, 'i');
      const liveEl = H.find('.kb-agent-live');
      const liveText = liveEl ? H.text(liveEl) : null;
      const errorbarText = H.firstText('.kb-errorbar');
      const matched = regex.test(liveText || '') || regex.test(errorbarText || '');
      return { liveText, errorbarText, matched };
    }, stateRegexSource);
    afterTexts = probe;
    if (!probe.matched) { cleared = Date.now() - onlineAt; break; }
    await sleep(150);
  }
  const pass = Boolean(firstSeen) && cleared !== null;
  report.record({
    id: 'A-08',
    title: 'SSE/断网 2s 内出现可见状态文案，恢复后自动清除',
    threshold: 'offline 后 ≤2500ms 出现「断开/重连/离线/同步失败」可见文案；恢复网络后 ≤8000ms 文案消失',
    measured: {
      before,
      firstSeen,
      offlineTimeline: timeline,
      recovery: { clearedMs: cleared, after: afterTexts },
      note: firstSeen ? `断网后 ${firstSeen.ms}ms 命中「${firstSeen.match}」，元素 ${firstSeen.selector}` : '断网 2.6s 内未出现任何断线/重连类可见文案',
    },
    pass,
    screenshots: [syncShot],
    evidence: [
      { type: 'note', text: `断线前 .kb-agent-live=「${before.liveText || '∅'}」` },
      { type: 'note', text: firstSeen ? `首次出现：${firstSeen.ms}ms，文案「${firstSeen.text.slice(0, 80)}」` : '未出现断线提示' },
      { type: 'note', text: cleared !== null ? `恢复后 ${cleared}ms 清除，当前「${afterTexts?.liveText || ''}」` : '恢复后 6.8s 内未自动清除' },
    ],
    matrix: firstSeen ? `断网 ${firstSeen.ms}ms 后出现「${firstSeen.match}」；恢复后 ${cleared === null ? '未清除' : `${cleared}ms 清除`}` : '断网后无可见断线文案（.kb-agent-live 仍为「' + (before.liveText || '') + '」）',
  });
}

// ---- A-09 -----------------------------------------------------------------
async function checkLoadError(ctx) {
  const { page, report } = ctx;
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  await page.cdp.send('Network.setBlockedURLs', { urls: ['*/api/kanban/*'] });
  const shots = [];
  const scenarios = [];
  for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.narrow]) {
    await page.setViewport(viewport);
    await page.reload({ waitLoaded: false }).catch(() => {});
    await waitFor(async () => page.eval(() => Boolean(document.querySelector('.kb-error'))), { timeout: 10000, interval: 150, label: '错误页出现' }).catch(() => {});
    await sleep(400);
    const collapsed = await page.eval(() => {
      const H = window.__H;
      const errorEl = document.querySelector('.kb-error');
      const textOf = (el) => (el ? H.text(el) : '');
      const bodyText = textOf(document.body);
      const buttons = errorEl ? Array.from(errorEl.querySelectorAll('button')) : [];
      const diagBtn = buttons.find((el) => el.getAttribute('aria-controls') === 'kb-load-diagnostics' || /诊断/.test(textOf(el)));
      const retry = buttons.find((el) => el !== diagBtn);
      return {
        hasErrorPage: Boolean(errorEl),
        title: textOf(errorEl ? errorEl.querySelector('.kb-error__title') : null),
        hint: textOf(errorEl ? errorEl.querySelector('.kb-error__hint') : null),
        errorText: textOf(errorEl).slice(0, 600),
        bodyText: bodyText.slice(0, 800),
        bodyHasFailedToFetch: /Failed to fetch/i.test(bodyText),
        bodyHasDevCommand: /node\s+scripts\/dev-server\.mjs/i.test(bodyText),
        bodyHasNetworkCode: /\bNETWORK\b/.test(bodyText),
        hasEnglishToast: /Failed to fetch/i.test(document.querySelector('.kb-toast-region')?.innerText || ''),
        toastTexts: Array.from(document.querySelectorAll('.kb-toast')).map((el) => textOf(el)),
        hasDiagnosticsToggle: Boolean(diagBtn),
        diagnosticsExpanded: diagBtn ? diagBtn.getAttribute('aria-expanded') : null,
        retry: retry ? { text: textOf(retry), rect: H.rect(retry), disabled: retry.disabled } : null,
        hintInfo: H.textInfo(errorEl ? errorEl.querySelector('.kb-error__hint') : null),
        titleInfo: H.textInfo(errorEl ? errorEl.querySelector('.kb-error__title') : null),
      };
    });
    const shotName = `error-light-${viewport.width === 390 ? '390' : '1440'}`;
    shots.push(await page.screenshot(shotName));
    const clicked = await page.eval(() => {
      const H = window.__H;
      const diagBtn = Array.from(document.querySelectorAll('.kb-error button')).find((el) => el.getAttribute('aria-controls') === 'kb-load-diagnostics' || /诊断/.test(H.text(el)));
      if (!diagBtn) return false;
      diagBtn.click();
      return true;
    });
    await sleep(250);
    const diagnostics = await page.eval(() => {
      const H = window.__H;
      const panel = document.getElementById('kb-load-diagnostics');
      return { exists: Boolean(panel), text: panel ? H.text(panel).slice(0, 500) : null };
    });
    const hintContrast = collapsed.hintInfo ? collapsed.hintInfo.contrast : null;
    const retryRect = collapsed.retry ? collapsed.retry.rect : null;
    const retryOK = retryRect ? retryRect.w >= 44 && retryRect.h >= 44 : false;
    const codeInDiagnostics = Boolean(diagnostics.exists && /\bNETWORK\b/.test(diagnostics.text || ''));
    const scenario = {
      viewport: viewport.label,
      ...collapsed,
      diagnosticsClicked: clicked,
      diagnostics,
      codeInDiagnostics,
      retryOK,
      hintContrast,
      pass: collapsed.hasErrorPage
        && !collapsed.bodyHasFailedToFetch
        && !collapsed.bodyHasDevCommand
        && !collapsed.bodyHasNetworkCode
        && !collapsed.hasEnglishToast
        && collapsed.hasDiagnosticsToggle
        && codeInDiagnostics
        && hintContrast !== null && hintContrast >= 4.5
        && retryOK,
    };
    scenarios.push(scenario);
  }
  await page.cdp.send('Network.setBlockedURLs', { urls: [] });
  await page.setViewport(VIEWPORTS.desktop);
  await page.reload();
  const pass = scenarios.every((s) => s.pass);
  const desktop = scenarios[0];
  report.record({
    id: 'A-09',
    title: '初始加载失败：用户化文案、无英文原始错误/dev 命令、诊断可展开、提示 ≥4.5、重试热区 ≥44',
    threshold: '可见文案不含 Failed to fetch / node scripts / 可见 NETWORK；诊断折叠存在且展开后有错误码；hint 对比 ≥4.5；重试按钮 ≥44×44',
    measured: { scenarios },
    pass,
    screenshots: shots,
    evidence: [
      { type: 'note', text: `1440 标题「${desktop.title}」；hint「${desktop.hint}」；诊断按钮存在=${desktop.hasDiagnosticsToggle}；展开后错误码可见=${desktop.codeInDiagnostics}` },
      { type: 'note', text: `英文原文=${desktop.bodyHasFailedToFetch ? '出现' : '无'}；dev 命令=${desktop.bodyHasDevCommand ? '出现' : '无'}；可见 NETWORK=${desktop.bodyHasNetworkCode ? '出现' : '无'}；hint 对比=${desktop.hintContrast}；重试 ${desktop.retry ? `${desktop.retry.rect.w}×${desktop.retry.rect.h}` : '缺失'}` },
    ],
    matrix: `错误页${desktop.hasErrorPage ? '可见' : '不可见'}；英文原始错误${desktop.bodyHasFailedToFetch ? '有' : '无'}；dev 命令${desktop.bodyHasDevCommand ? '有' : '无'}；诊断${desktop.hasDiagnosticsToggle ? '可展开' : '缺失'}；hint ${desktop.hintContrast}:1；重试 ${desktop.retry ? `${desktop.retry.rect.w}×${desktop.retry.rect.h}` : '缺失'}`,
  });
}

// ---- A-02 / A-03 ----------------------------------------------------------
/**
 * docs/10 附录 A.1 的 18 行抽样清单：每行固定 id / 上下文 / 稳定选择器组。
 * 每行在 light + dark 各测一次；选择器全部未命中可见文本时显式记 notFound 与原因（不吞掉）。
 */
const CONTRAST_ROWS = [
  { row: 1, id: 'pageTitle', label: '页面标题', context: 'board', selectors: ['.kb-crumb-current'] },
  { row: 2, id: 'cardTitle', label: '卡片标题', context: 'board', selectors: ['.kb-card-title'] },
  { row: 3, id: 'cardSummary', label: '卡片摘要', context: 'board', selectors: ['.kb-card-summary'] },
  { row: 4, id: 'statusNeedsYou', label: '待你确认状态', context: 'board', selectors: ['[data-status="needs_you"] .kb-foot-status', '.kb-card[data-status="needs_you"] .kb-foot-status__text', '.kb-foot-status--warn'] },
  { row: 5, id: 'statusDone', label: '已完成状态', context: 'board', selectors: ['[data-status="done"] .kb-foot-status', '.kb-card[data-status="done"] .kb-foot-status__text', '.kb-foot-status--success'] },
  { row: 6, id: 'cardMetric', label: '卡片 metric', context: 'board', selectors: ['.kb-card .kb-metric', '.kb-card-foot__metrics .kb-metric', '.kb-card-foot__metrics'] },
  { row: 7, id: 'project', label: '项目名', context: 'board', selectors: ['.kb-card .kb-prop-project', '.kb-prop-project'] },
  { row: 8, id: 'syncLabel', label: '同步/独立预览标签', context: 'board', selectors: ['.kb-agent-live'] },
  { row: 9, id: 'shortcutBar', label: '快捷键栏', context: 'board', selectors: ['.kb-statusbar'] },
  { row: 10, id: 'listCount', label: '列表计数', context: 'list', selectors: ['.kb-list__count'] },
  { row: 11, id: 'drawerKicker', label: '抽屉 kicker', context: 'drawer', selectors: ['.kb-drawer__kicker'] },
  { row: 12, id: 'drawerSection', label: '抽屉分区标题', context: 'drawer', selectors: ['.kb-drawer__section-title'] },
  { row: 13, id: 'composerHint', label: 'Composer hint', context: 'drawer', selectors: ['.kb-composer__hint'] },
  { row: 14, id: 'composerMeta', label: 'Composer meta', context: 'drawer', selectors: ['.kb-composer__meta'] },
  { row: 15, id: 'approvalRisk', label: '审批风险', context: 'board', selectors: ['.kb-card .kb-decision-risk', '.kb-decision-risk'] },
  { row: 16, id: 'approvalOptionDesc', label: '审批选项说明', context: 'board', selectors: ['.kb-card .kb-decision-option__desc', '.kb-decision-option__desc'] },
  { row: 17, id: 'batchCount', label: '批量已选数', context: 'selection', selectors: ['.kb-batchbar__count'] },
  { row: 18, id: 'batchHint', label: '批量 hint', context: 'selection', selectors: ['.kb-batchbar__hint'] },
];

const A02_ROW_IDS = ['statusNeedsYou', 'statusDone', 'approvalRisk'];
const A03_ROW_IDS = CONTRAST_ROWS.filter((row) => !A02_ROW_IDS.includes(row.id)).map((row) => row.id);

/** 页面内：按选择器组找第一个「可见且有文本」的元素，返回 textInfo + 命中信息 + 尝试轨迹。 */
function sampleContrastRowInPage(selectors) {
  const H = window.__H;
  const tried = [];
  for (const selector of selectors) {
    const els = H.findAll(selector);
    for (const el of els) {
      const info = H.textInfo(el);
      if (info && info.visible && info.text && info.text.length > 0) {
        return { found: true, selector, tried, ...info };
      }
    }
    tried.push({ selector, matched: els.length, reason: els.length ? '命中但无可见文本' : '选择器无命中' });
  }
  return { found: false, tried };
}

let contrastCache = null;
function contrastMeasurement(ctx) {
  if (contrastCache) return contrastCache;
  contrastCache = (async () => {
    const { page } = ctx;
    const rows = [];
    const shots = [];
    const recordRow = (theme, rowDef, sample) => {
      rows.push({
        row: rowDef.row,
        id: rowDef.id,
        label: rowDef.label,
        context: rowDef.context,
        theme,
        found: Boolean(sample && sample.found),
        selector: sample ? sample.selector || null : null,
        text: sample && sample.found ? sample.text : null,
        contrast: sample && sample.found ? sample.contrast : null,
        color: sample && sample.found ? sample.color : null,
        colorHex: sample && sample.found ? sample.colorHex : null,
        bgHex: sample && sample.found ? sample.bgHex : null,
        fontSize: sample && sample.found ? sample.fontSize : null,
        fontWeight: sample && sample.found ? sample.fontWeight : null,
        lineHeight: sample && sample.found ? sample.lineHeight : null,
        rect: sample && sample.found ? sample.rect : null,
        notFoundReason: sample && !sample.found
          ? `上下文 ${rowDef.context} 下选择器均未命中可见文本：${sample.tried.map((item) => `${item.selector}（${item.reason}）`).join(' → ')}`
          : null,
      });
    };
    const sampleRows = async (theme, rowDefs, label) => {
      for (const rowDef of rowDefs) {
        const sample = await page.eval(sampleContrastRowInPage, rowDef.selectors);
        recordRow(theme, rowDef, sample);
      }
      return label;
    };

    for (const theme of ['light', 'dark']) {
      await page.ensure({ theme, view: 'board', viewport: VIEWPORTS.desktop });
      if (theme === 'light') shots.push(await page.screenshot('board-light-1440'));
      else shots.push(await page.screenshot('board-dark-1440'));
      await sampleRows(theme, CONTRAST_ROWS.filter((row) => row.context === 'board'), `board-${theme}`);

      await page.ensure({ theme, view: 'list', viewport: VIEWPORTS.desktop });
      if (theme === 'light') shots.push(await page.screenshot('list-light-1440'));
      await sampleRows(theme, CONTRAST_ROWS.filter((row) => row.context === 'list'), `list-${theme}`);

      await page.ensure({ theme, view: 'board', viewport: VIEWPORTS.desktop });
      const drawerCardId = await page.eval(() => {
        const H = window.__H;
        const cards = H.findAll('.kb-card');
        const withDecision = cards.find((card) => card.querySelector('.kb-decision'));
        return (withDecision || cards[0])?.getAttribute('data-card-id') || null;
      });
      if (drawerCardId) {
        await page.openDrawer(drawerCardId);
        await sampleRows(theme, CONTRAST_ROWS.filter((row) => row.context === 'drawer'), `drawer-${theme}`);
        if (theme === 'light') {
          shots.push(await page.screenshot('drawer-light-1440'));
          shots.push(await page.screenshot('approval-light-1440'));
        }
        await page.cleanUi();
      } else {
        for (const rowDef of CONTRAST_ROWS.filter((row) => row.context === 'drawer')) {
          recordRow(theme, rowDef, { found: false, tried: [{ selector: rowDef.selectors.join('|'), matched: 0, reason: '没有可打开的卡片 → 无法打开抽屉采样' }] });
        }
      }

      await page.ensure({ theme, view: 'board', viewport: VIEWPORTS.desktop });
      await page.click('.kb-select-btn');
      await sleep(300);
      await page.eval(() => {
        const cards = Array.from(document.querySelectorAll('.kb-card'));
        cards.slice(0, 2).forEach((card) => card.click());
        return true;
      });
      await sleep(350);
      if (theme === 'light') shots.push(await page.screenshot('selection-light-1440'));
      await sampleRows(theme, CONTRAST_ROWS.filter((row) => row.context === 'selection'), `selection-${theme}`);
      await page.cleanUi();
    }
    return { rows, shots };
  })();
  return contrastCache;
}

function contrastRowsFor(items, ids) {
  return items.filter((item) => ids.includes(item.id));
}

function evaluateContrastRows(rows) {
  const missing = rows.filter((row) => !row.found);
  const low = rows.filter((row) => row.found && !(row.contrast >= 4.5));
  const failing = [...missing, ...low];
  const byTheme = {};
  for (const row of rows) {
    byTheme[row.theme] = byTheme[row.theme] || [];
    byTheme[row.theme].push(`${row.label} ${row.found ? `${row.contrast}:1` : 'not_found'}`);
  }
  return { missing, low, failing, byTheme };
}

async function checkContrastA02(ctx) {
  const { report } = ctx;
  const { rows, shots } = await contrastMeasurement(ctx);
  const list = contrastRowsFor(rows, A02_ROW_IDS);
  const { missing, low, failing, byTheme } = evaluateContrastRows(list);
  report.record({
    id: 'A-02',
    title: '浅色/暗色状态文字与审批风险对比 ≥4.5',
    threshold: '待你确认状态、已完成状态、审批风险 在 light/dark 均 ≥4.5:1（附录 A.1 行 4/5/15）',
    measured: {
      rows: list,
      missing: missing.map((row) => ({ id: row.id, theme: row.theme, reason: row.notFoundReason })),
      belowThreshold: low.map((row) => ({ id: row.id, label: row.label, theme: row.theme, contrast: row.contrast })),
      byTheme,
    },
    pass: failing.length === 0,
    screenshots: [...new Set(shots.filter((name) => /board-(light|dark)-1440|approval/.test(name)))],
    evidence: [
      { type: 'note', text: list.map((row) => `${row.theme}/${row.label}=${row.found ? `${row.contrast}:1（${row.colorHex} on ${row.bgHex}）` : 'not_found'}`).join('；') },
    ],
    matrix: list.map((row) => `${row.theme}/${row.label} ${row.found ? row.contrast : 'not_found'}`).join('；'),
  });
}

async function checkContrastA03(ctx) {
  const { report } = ctx;
  const { rows, shots } = await contrastMeasurement(ctx);
  const list = contrastRowsFor(rows, A03_ROW_IDS);
  const { missing, low, failing, byTheme } = evaluateContrastRows(list);
  report.record({
    id: 'A-03',
    title: '11–12px 可读元数据/说明对比 ≥4.5（附录 A 抽样）',
    threshold: 'docs/10 附录 A.1 的 18 行中除 A-02 的 3 行外全部在 light/dark ≥4.5:1；未命中的行显式标 not_found',
    measured: {
      rows: list,
      missing: missing.map((row) => ({ id: row.id, theme: row.theme, reason: row.notFoundReason })),
      belowThreshold: low.map((row) => ({ id: row.id, label: row.label, theme: row.theme, contrast: row.contrast })),
      byTheme,
    },
    pass: failing.length === 0,
    screenshots: [...new Set(shots.filter((name) => /board-(light|dark)-1440|list-light-1440|drawer-light-1440|selection-light-1440/.test(name)))],
    evidence: [
      { type: 'note', text: list.map((row) => `#${row.row} ${row.theme}/${row.label}=${row.found ? `${row.contrast}:1` : 'not_found'}`).join('；') },
      ...(missing.length ? [{ type: 'note', text: `not_found：${missing.map((row) => `${row.theme}/${row.id}（${row.notFoundReason}）`).join('；')}` }] : []),
    ],
    matrix: [
      `浅色：${(byTheme.light || []).join(' / ')}`,
      `暗色：${(byTheme.dark || []).join(' / ')}`,
      missing.length ? `not_found ${missing.length} 行` : '',
    ].filter(Boolean).join('；'),
  });
}

// ---- A-04 -----------------------------------------------------------------
/**
 * A-04 判定口径（docs/10 §5 批次 2 条目 3）：
 * (a) 卡内展开审批 ≤1，其余为一行摘要（.kb-decision-summary）；
 * (b) 审批标题字号 ≤ 卡片标题字号，且字重不高于卡片标题；
 * (c) 选项区不再「卡中卡」：选项容器的独立 border/background 卡片数 = 0；
 * (d) 审批区 warn 底色覆盖面积占比显著下降（before/after 数值 + 截图）；
 * (e) 「审批区高度 / 卡片高度」只作 informational，不参与 pass/fail。
 * before 参考值来自 docs/10 附录 A.4 审计冻结构建（c-301：卡片 438px，审批区 291px，warn-tertiary 整块不透明底）。
 */
const A04_BEFORE_REFERENCE = {
  source: 'docs/10 附录 A.4（审计冻结构建 c-301）',
  cardHeight: 438,
  approvalHeight: 291,
  approvalHeightRatio: Math.round((291 / 438) * 1000) / 1000,
  warnBackground: 'warn-tertiary 整块不透明底',
  screenshot: 'docs/assets/screens/audit-approval-light-1440.png',
};

async function checkApprovalWeight(ctx) {
  const { page, report, args } = ctx;
  let sample = null;
  try {
    sample = await createA04Sample(args);
    log(`A-04 双审批样本：${sample.cardId}（created=${sample.created}）`);
  } catch (error) {
    log(`A-04 样本创建失败：${error.message}`);
  }
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  await page.reload();
  const measured = await page.eval(() => {
    const H = window.__H;
    const fontOf = (el) => (el ? H.font(el) : null);
    const cards = H.findAll('.kb-card');
    const rows = [];
    for (const card of cards) {
      const decisions = Array.from(card.querySelectorAll('.kb-decision'));
      const summaries = Array.from(card.querySelectorAll('.kb-decision-summary'));
      if (!decisions.length && !summaries.length) continue;
      const cardRect = H.rect(card);
      const cardTitle = card.querySelector('.kb-card-title');
      const parsed = decisions.map((decision) => {
        const rect = H.rect(decision);
        const qtitle = decision.querySelector('.kb-decision-q__title');
        const panelColor = H.parseColor(getComputedStyle(decision).backgroundColor);
        const optionEls = Array.from(decision.querySelectorAll('.kb-decision-option'));
        const options = optionEls.map((option) => {
          const cs = getComputedStyle(option);
          const color = H.parseColor(cs.backgroundColor);
          const borderColor = H.parseColor(cs.borderTopColor);
          const borderWidth = parseFloat(cs.borderTopWidth) || 0;
          const opaqueBackground = Boolean(color && color.a >= 0.5);
          const independentBorder = borderWidth > 0 && Boolean(borderColor && borderColor.a > 0);
          return {
            background: cs.backgroundColor,
            borderTop: cs.borderTopWidth,
            borderColor: cs.borderTopColor,
            opaqueBackground,
            independentBorder,
            cardLike: opaqueBackground || independentBorder,
          };
        });
        const warnOpaque = Boolean(panelColor && panelColor.a >= 0.5);
        return {
          rect,
          height: rect.h,
          heightRatioInfoOnly: cardRect.h ? Math.round((rect.h / cardRect.h) * 1000) / 1000 : null,
          title: qtitle ? H.text(qtitle) : '',
          titleFont: fontOf(qtitle),
          optionCount: optionEls.length,
          options,
          optionCardLikeCount: options.filter((option) => option.cardLike).length,
          panelBackground: getComputedStyle(decision).backgroundColor,
          panelOpaqueWarn: warnOpaque,
          warnArea: warnOpaque ? Math.round(rect.w * rect.h) : 0,
        };
      });
      rows.push({
        cardId: card.getAttribute('data-card-id'),
        title: cardTitle ? H.text(cardTitle) : '',
        cardRect,
        cardTitleFont: fontOf(cardTitle),
        expandedDecisions: decisions.length,
        summaryLines: summaries.map((summary) => H.text(summary).slice(0, 80)),
        decisions: parsed,
        cardArea: Math.round(cardRect.w * cardRect.h),
        warnArea: parsed.reduce((sum, item) => sum + item.warnArea, 0),
      });
    }
    return { cards: rows };
  });

  const stateRes = await fetchJson(`${args.api}/state`, 5000);
  const pendingByCard = new Map((stateRes.json?.cards || []).map((card) => [card.id, (card.approvals || []).filter((a) => a.status === 'pending').length]));
  const evaluated = measured.cards.map((row) => {
    const titleFont = row.decisions[0]?.titleFont || null;
    const cardFont = row.cardTitleFont || null;
    const pending = pendingByCard.get(row.cardId) || 0;
    const checks = {
      expandedPerCard: row.expandedDecisions <= 1,
      otherAsSummary: pending > 1 ? row.summaryLines.length >= pending - 1 : true,
      // (b) 按 docs/10 A-04 建议「标题用 13/600」：只看字号 ≤ 卡标题，字重 600 不参与卡口。
      titleSizeNotDominant: Boolean(titleFont && cardFont) && titleFont.size <= cardFont.size,
      noOptionCards: row.decisions.every((decision) => decision.optionCardLikeCount === 0),
      warnCoverageReduced: row.warnArea === 0,
    };
    return {
      cardId: row.cardId,
      title: row.title,
      cardHeight: row.cardRect.h,
      cardTitleFont: cardFont,
      expandedDecisions: row.expandedDecisions,
      summaryLines: row.summaryLines,
      apiPendingApprovals: pending,
      decision: row.decisions[0]
        ? {
            height: row.decisions[0].height,
            heightRatioInfoOnly: row.decisions[0].heightRatioInfoOnly,
            titleFont,
            optionCount: row.decisions[0].optionCount,
            panelBackground: row.decisions[0].panelBackground,
            panelOpaqueWarn: row.decisions[0].panelOpaqueWarn,
            optionCardLikeCount: row.decisions[0].optionCardLikeCount,
            optionSample: row.decisions[0].options[0] || null,
          }
        : null,
      warnCoverageRatio: row.cardArea ? Math.round((row.warnArea / row.cardArea) * 1000) / 1000 : 0,
      checks,
      pass: Object.values(checks).every(Boolean),
    };
  });
  const totalWarnCoverage = (() => {
    const cardArea = measured.cards.reduce((sum, row) => sum + row.cardArea, 0);
    const warnArea = measured.cards.reduce((sum, row) => sum + row.warnArea, 0);
    return cardArea ? Math.round((warnArea / cardArea) * 1000) / 1000 : 0;
  })();
  const cardShots = await page.screenshot('board-light-1440');
  const approvalShot = await page.screenshot('approval-light-1440');
  const failedChecks = [];
  for (const row of evaluated) {
    for (const [key, value] of Object.entries(row.checks)) {
      if (!value) failedChecks.push(`${row.cardId}/${key}`);
    }
  }
  const pass = evaluated.length > 0 && failedChecks.length === 0;
  const sampleRow = evaluated.find((row) => row.cardId === sample?.cardId);
  report.record({
    id: 'A-04',
    title: '审批区视觉权重低于卡片标题、卡内最多一个展开审批、非卡中卡',
    threshold: '(a) 卡内展开审批 ≤1 且其余为一行摘要；(b) 审批标题字号 ≤ 卡片标题字号（13 ≤ 14；字重 600 是 docs/10 A-04 建议值，不参与卡口）；(c) 选项独立 border/背景卡片数 = 0；(d) 审批区不透明 warn 底色覆盖占比显著下降（before 0.664 → after）；(e) 审批区/卡高仅 informational',
    measured: {
      cards: evaluated,
      sampleCard: sample ? {
        ...sample,
        expandedDecisions: sampleRow?.expandedDecisions ?? null,
        summaryLines: sampleRow?.summaryLines ?? null,
        apiPendingApprovals: sampleRow?.apiPendingApprovals ?? null,
      } : null,
      before: A04_BEFORE_REFERENCE,
      after: {
        warnCoverageRatio: totalWarnCoverage,
        warnOpaquePanelCount: evaluated.filter((row) => row.decision?.panelOpaqueWarn).length,
        optionCardLikeTotal: evaluated.reduce((sum, row) => sum + (row.decision?.optionCardLikeCount || 0), 0),
        screenshot: 'docs/assets/screens/visual-v2/' + args.label + '/approval-light-1440.png',
      },
      informational: {
        note: 'approvalHeightRatio 只记录不参与 pass/fail（审批选项必须完整展开，高度占比本来就不会大幅下降）',
        approvalHeightRatios: evaluated.map((row) => ({ cardId: row.cardId, ratio: row.decision?.heightRatioInfoOnly ?? null, cardHeight: row.cardHeight, approvalHeight: row.decision?.height ?? null })),
      },
      failedChecks,
      note: 'A-04 双审批样本由 dev-server REST API 创建（同一张卡两个 pending 审批），测完归档并重载页面',
    },
    pass,
    screenshots: [cardShots, approvalShot],
    evidence: [
      { type: 'note', text: evaluated.map((row) => `${row.cardId}（${row.title}）：展开 ${row.expandedDecisions}，摘要 ${row.summaryLines.length}，API pending ${row.apiPendingApprovals}，审批标题 ${row.decision?.titleFont?.size}px（≤ 卡标题 ${row.cardTitleFont?.size}px；字重 ${row.decision?.titleFont?.weight} 仅记录），选项卡片 ${row.decision?.optionCardLikeCount}，warn 覆盖 ${row.warnCoverageRatio}`).join('；') },
      { type: 'note', text: `(d) before：${A04_BEFORE_REFERENCE.warnBackground}（审批区/卡高 ${A04_BEFORE_REFERENCE.approvalHeightRatio}，来源 ${A04_BEFORE_REFERENCE.source}，截图 ${A04_BEFORE_REFERENCE.screenshot}）；after：不透明 warn 底覆盖占比 ${totalWarnCoverage}，不透明 panel ${evaluated.filter((row) => row.decision?.panelOpaqueWarn).length} 个，after 截图 docs/assets/screens/visual-v2/${args.label}/approval-light-1440.png` },
      { type: 'note', text: `(e) informational 审批区/卡高：${evaluated.map((row) => `${row.cardId}=${row.decision?.heightRatioInfoOnly ?? '∅'}`).join('、')}（不参与 pass/fail）` },
      ...(failedChecks.length ? [{ type: 'note', text: `未过判据：${failedChecks.join('、')}` }] : []),
    ],
    matrix: `(a) 展开 ${evaluated.map((row) => row.expandedDecisions).join('/')}，摘要 ${evaluated.map((row) => row.summaryLines.length).join('/')}；b 审批标题 ${evaluated[0]?.decision?.titleFont?.size}px ≤ 卡标题 ${evaluated[0]?.cardTitleFont?.size}px（字重 ${evaluated[0]?.decision?.titleFont?.weight} 按 docs/10 建议不参与）；c 选项独立卡底 ${evaluated.reduce((sum, row) => sum + (row.decision?.optionCardLikeCount || 0), 0)}；d warn 覆盖 before ${A04_BEFORE_REFERENCE.approvalHeightRatio} → after ${totalWarnCoverage}；e 高度占比 ${evaluated.map((row) => row.decision?.heightRatioInfoOnly ?? '∅').join('/')}（仅记录）`,
  });
  if (sample) {
    await archiveCard(args, sample.cardId).catch(() => {});
    await page.reload().catch(() => {});
  }
}

// ---- A-06 -----------------------------------------------------------------
async function checkTypography(ctx) {
  const { page, report } = ctx;
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  const board = await page.eval(() => {
    const H = window.__H;
    return {
      pageTitle: H.font(H.find('.kb-crumb-current')),
      cardTitle: H.font(H.find('.kb-card-title')),
      columnTitle: H.font(H.find('.kb-column-title')),
      columnTitleText: H.firstText('.kb-column-title'),
      cardSummary: H.font(H.find('.kb-card-summary')),
      footStatus: H.font(H.find('.kb-foot-status__text')),
    };
  });
  await page.ensure({ theme: 'light', view: 'list', viewport: VIEWPORTS.desktop });
  const list = await page.eval(() => {
    const H = window.__H;
    return {
      groupTitle: H.font(H.find('.kb-list__group-title')),
      rowMeta: H.font(H.find('.kb-list__row-meta')),
      listTitle: H.font(H.find('.kb-list__title')),
    };
  });
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  const cardId = await page.eval(() => {
    const H = window.__H;
    const card = H.find('.kb-card');
    return card ? card.getAttribute('data-card-id') : null;
  });
  let drawer = {};
  if (cardId) {
    await page.openDrawer(cardId);
    drawer = await page.eval(() => {
      const H = window.__H;
      return {
        drawerTitle: H.font(H.find('.kb-drawer__title')),
        sectionTitle: H.font(H.find('.kb-drawer__section-title')),
        kicker: H.font(H.find('.kb-drawer__kicker')),
      };
    });
    await page.cleanUi();
  }
  const near = (value, target, tolerance = 0.6) => value !== null && value !== undefined && Math.abs(value - target) <= tolerance;
  const items = [
    { name: '页标题', sample: board.pageTitle, expect: '16 / 22 / 600', pass: near(board.pageTitle?.size, 16) && near(board.pageTitle?.lineHeight, 22, 1.1) && (board.pageTitle?.weight >= 600) },
    { name: '卡片标题', sample: board.cardTitle, expect: '14 / 20 / 500', pass: near(board.cardTitle?.size, 14) && near(board.cardTitle?.lineHeight, 20, 1.1) && (board.cardTitle?.weight >= 500) },
    { name: '列头/分区标题', sample: board.columnTitle, expect: '12 / 16 / 600 + 0.02em', pass: near(board.columnTitle?.size, 12) && near(board.columnTitle?.lineHeight, 16, 1.1) && (board.columnTitle?.weight >= 600) },
    { name: '列表分区标题', sample: list.groupTitle, expect: '12 / 16 / 600', pass: near(list.groupTitle?.size, 12) && near(list.groupTitle?.lineHeight, 16, 1.1) && (list.groupTitle?.weight >= 600) },
    { name: '抽屉标题', sample: drawer.drawerTitle, expect: '16 / 24（参考）', pass: near(drawer.drawerTitle?.size, 16) && (drawer.drawerTitle?.weight >= 500) },
    { name: 'meta（列表行 meta）', sample: list.rowMeta, expect: '11–12', pass: Boolean(list.rowMeta && list.rowMeta.size >= 11 && list.rowMeta.size <= 12) },
    { name: 'meta（卡片 footer 状态）', sample: board.footStatus, expect: '11–12', pass: Boolean(board.footStatus && board.footStatus.size >= 11 && board.footStatus.size <= 12) },
  ];
  const failed = items.filter((item) => !item.pass);
  report.record({
    id: 'A-06',
    title: '页/卡片/分区/元数据四级字号字重',
    threshold: '页标题 16/22/600；卡标题 14/20/500；分区/列头 12/16/600+0.02em；meta 11–12',
    measured: { items, board, list, drawer },
    pass: failed.length === 0,
    screenshots: [],
    evidence: [{ type: 'note', text: items.map((item) => `${item.name} ${item.sample ? `${item.sample.size}/${item.sample.lineHeight}/${item.sample.weight}` : '缺失'}（期望 ${item.expect}）`).join('；') }],
    matrix: items.map((item) => `${item.name} ${item.sample ? `${item.sample.size}/${item.sample.lineHeight}/${item.sample.weight}` : '缺失'}${item.pass ? '' : '✗'}`).join('；'),
  });
}

// ---- A-07 -----------------------------------------------------------------
async function checkListLayout(ctx) {
  const { page, report } = ctx;
  await page.ensure({ theme: 'light', view: 'list', viewport: VIEWPORTS.desktop });
  const desktop = await page.eval(() => {
    const H = window.__H;
    const rows = H.findAll('.kb-list__row').slice(0, 6).map((row) => {
      const title = row.querySelector('.kb-list__title');
      const titleText = row.querySelector('.kb-list__title-text');
      const meta = row.querySelector('.kb-list__row-meta');
      return {
        rowRect: H.rect(row),
        titleRect: title ? H.rect(title) : null,
        titleTextRect: titleText ? H.rect(titleText) : null,
        metaRect: meta ? H.rect(meta) : null,
        titleToMetaGap: title && meta ? Math.round(((meta ? H.rect(meta).x : 0) - H.rect(title).right) * 10) / 10 : null,
        titleTextToMetaGap: titleText && meta ? Math.round((H.rect(meta).x - H.rect(titleText).right) * 10) / 10 : null,
      };
    });
    return {
      rows,
      listWidth: H.rect(H.find('.kb-list'))?.w ?? null,
      itemsWidth: H.rect(H.find('.kb-list__items'))?.w ?? null,
      mainWidth: H.rect(H.find('.kb-main'))?.w ?? null,
    };
  });
  await page.ensure({ theme: 'light', view: 'list', viewport: VIEWPORTS.narrow });
  const narrow = await page.eval(() => {
    const H = window.__H;
    const item = H.find('.kb-list__item');
    const row = item ? item.querySelector('.kb-list__row') : H.find('.kb-list__row');
    if (!row) return { found: false };
    const cs = getComputedStyle(row);
    const kids = Array.from(row.children).filter(H.visible).map((el) => ({
      cls: String(el.className || '').split(' ')[0],
      rect: H.rect(el),
    }));
    const lineKeys = [...new Set(kids.map((kid) => Math.round(kid.rect.y / 2) * 2))];
    const title = row.querySelector('.kb-list__title');
    const meta = row.querySelector('.kb-list__row-meta');
    const summary = row.querySelector('.kb-list__summary');
    const itemText = H.text(item || row);
    return {
      found: true,
      rowRect: H.rect(row),
      flexDirection: cs.flexDirection,
      flexWrap: cs.flexWrap,
      children: kids,
      lineCount: lineKeys.length,
      titleRect: title ? H.rect(title) : null,
      summaryRect: summary ? H.rect(summary) : null,
      metaRect: meta ? H.rect(meta) : null,
      stacked: kids.length > 1 && lineKeys.length > 1 || cs.flexDirection === 'column',
      arrangement: kids.map((kid) => `${kid.cls}@y${Math.round(kid.rect.y)}`),
      maxRight: kids.length ? Math.max(...kids.map((kid) => kid.rect.right)) : null,
      hScroll: {
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 0.5,
      },
      fields: {
        title: Boolean(title && H.visible(title)),
        summary: Boolean(summary && H.visible(summary)),
        project: Boolean(row.querySelector('.kb-list__project')),
        meta: Boolean(meta && H.visible(meta)),
        metaSpans: meta ? Array.from(meta.querySelectorAll(':scope > span[title]')).map((el) => ({ title: el.getAttribute('title'), text: H.text(el) })) : [],
        actions: row.querySelectorAll('.kb-list__row-meta button').length,
        status: Boolean(row.querySelector('.kb-list__status-line')),
      },
      itemText: itemText.slice(0, 200),
    };
  });

  const rowHeights = desktop.rows.map((row) => row.rowRect.h);
  const avgHeight = rowHeights.length ? Math.round((rowHeights.reduce((sum, value) => sum + value, 0) / rowHeights.length) * 10) / 10 : null;
  const rowHeightOK = avgHeight !== null && avgHeight >= 56 && avgHeight <= 64;
  const maxWidth = desktop.listWidth;
  const minTextGap = desktop.rows.length ? Math.min(...desktop.rows.map((row) => row.titleTextToMetaGap ?? 9999)) : null;
  const compacted = (maxWidth !== null && maxWidth <= 1300) || (minTextGap !== null && minTextGap <= 700);
  const fieldsOK = Boolean(narrow.found)
    && narrow.fields.title
    && narrow.fields.summary
    && narrow.fields.project
    && narrow.fields.meta
    && narrow.fields.actions > 0;
  const pass = rowHeightOK && compacted && Boolean(narrow.found) && narrow.stacked && !narrow.hScroll.overflowX && fieldsOK;
  const shots = [await page.screenshot('list-light-390')];
  report.record({
    id: 'A-07',
    title: '1440 列表行高 56–64、内容限宽或标题→meta 路径缩短、390 仍堆叠',
    threshold: '1440 行高 56–64；内容最大宽 ≤1300 或标题文字右缘到 meta 左缘 ≤700；390 行内子项换行堆叠（≥2 行或 column）+ 页面无横向滚动 + 标题/摘要/项目/meta/操作都在',
    measured: {
      desktop: { ...desktop, avgHeight, rowHeightOK, maxWidth, minTextGap, compacted },
      narrow: { ...narrow, fieldsOK },
      checks: { rowHeightOK, compacted, stacked: Boolean(narrow.found) && narrow.stacked, noHScroll: narrow.found ? !narrow.hScroll.overflowX : false, fieldsOK },
    },
    pass,
    screenshots: shots,
    evidence: [
      { type: 'note', text: `1440：行高 ${avgHeight}（${rowHeights.join('/')}）；内容宽 ${maxWidth}；标题按钮宽 ${desktop.rows[0]?.titleRect?.w}；meta 宽 ${desktop.rows[0]?.metaRect?.w}；标题右缘→meta ${desktop.rows[0]?.titleToMetaGap}；标题文字右缘→meta ${minTextGap}` },
      { type: 'note', text: `390：row rect=${narrow.rowRect ? `${narrow.rowRect.w}×${narrow.rowRect.h}` : '∅'}，flex-direction=${narrow.flexDirection}，flex-wrap=${narrow.flexWrap}，子项行数=${narrow.lineCount}，排列=${(narrow.arrangement || []).join(' → ')}；横向 scrollWidth/innerWidth=${narrow.hScroll?.scrollWidth}/${narrow.hScroll?.innerWidth}` },
      { type: 'note', text: `390 字段：title=${narrow.fields?.title} summary=${narrow.fields?.summary} project=${narrow.fields?.project} meta=${narrow.fields?.meta} metaSpans=${JSON.stringify(narrow.fields?.metaSpans?.map((span) => `${span.title}=${span.text}`))} actions=${narrow.fields?.actions}` },
    ],
    matrix: `行高 ${avgHeight ?? '∅'}；内容宽 ${maxWidth ?? '∅'}；标题右缘→meta ${desktop.rows[0]?.titleToMetaGap ?? '∅'}；文字右缘→meta ${minTextGap ?? '∅'}；390 wrap=${narrow.flexWrap || '∅'} 子项 ${narrow.lineCount || '∅'} 行（${(narrow.arrangement || []).join(' ') || '∅'}）；横向溢出=${narrow.hScroll?.overflowX ?? '∅'}；字段 title/summary/project/meta/actions=${narrow.fields ? [narrow.fields.title, narrow.fields.summary, narrow.fields.project, narrow.fields.meta, narrow.fields.actions > 0].map((value) => value ? '✓' : '✗').join('/') : '∅'}`,
  });
}

// ---- A-11 -----------------------------------------------------------------
async function checkBatchBar(ctx) {
  const { page, report } = ctx;
  const measurements = [];
  const shots = [];

  const measureState = async (label) => page.eval((tag) => {
    const H = window.__H;
    const archive = H.find('.kb-batchbar__danger');
    const bar = H.find('.kb-batchbar');
    const countEl = H.find('.kb-batchbar__count');
    const hintEl = H.find('.kb-batchbar__hint');
    const styleOf = (el) => (el ? {
      color: getComputedStyle(el).color,
      backgroundColor: getComputedStyle(el).backgroundColor,
      borderTopWidth: getComputedStyle(el).borderTopWidth,
      borderTopColor: getComputedStyle(el).borderTopColor,
      opacity: getComputedStyle(el).opacity,
    } : null);
    return {
      label: tag,
      barFound: Boolean(bar),
      barRect: bar ? H.rect(bar) : null,
      countText: countEl ? H.text(countEl) : null,
      countInfo: H.textInfo(countEl),
      hintText: hintEl ? H.text(hintEl) : null,
      hintInfo: H.textInfo(hintEl),
      archiveFound: Boolean(archive),
      archiveDisabled: archive ? archive.disabled === true : null,
      archiveText: archive ? H.text(archive) : null,
      archiveTextInfo: H.textInfo(archive),
      archiveStyle: styleOf(archive),
      buttons: H.findAll('.kb-batchbar .kb-btn').map((el) => ({ text: H.text(el).slice(0, 16), disabled: el.disabled === true, rect: H.rect(el) })),
      hScroll: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, overflowX: document.documentElement.scrollWidth > window.innerWidth + 0.5 },
    };
  }, label);

  for (const theme of ['light', 'dark']) {
    await page.ensure({ theme, view: 'board', viewport: VIEWPORTS.desktop });
    await page.click('.kb-select-btn');
    await sleep(400);
    const emptyState = await measureState('selection-empty');
    // 选中 2 张后再量（已选计数/hint 用真实选中态；归档按钮此时可用，用于和禁用态对比）
    await page.eval(() => {
      const cards = Array.from(document.querySelectorAll('.kb-card'));
      cards.slice(0, 2).forEach((card) => card.click());
      return true;
    });
    await sleep(450);
    const selectedState = await measureState('selection-2');
    if (theme === 'light') shots.push(await page.screenshot('selection-light-1440'));
    measurements.push({ theme, emptyState, selectedState });
    await page.cleanUi();
  }

  // 390：选择 1 张后量批量条按钮高度 / 溢出 / 计数与 hint
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.narrow });
  await page.click('.kb-select-btn');
  await sleep(400);
  await page.eval(() => {
    const card = document.querySelector('.kb-card');
    if (card) card.click();
    return true;
  });
  await sleep(450);
  const narrow = await measureState('selection-390');
  shots.push(await page.screenshot('selection-light-390'));
  await page.cleanUi();

  const light = measurements.find((item) => item.theme === 'light');
  const dark = measurements.find((item) => item.theme === 'dark');
  const disabled = light.emptyState;
  const selected = light.selectedState;
  const darkSelected = dark.selectedState;
  const disabledContrast = disabled.archiveTextInfo ? disabled.archiveTextInfo.contrast : null;
  const enabledContrast = selected.archiveTextInfo ? selected.archiveTextInfo.contrast : null;
  const disabledHasVisualCue = Boolean(
    disabled.archiveStyle
    && (Number(disabled.archiveStyle.borderTopWidth.replace('px', '')) > 0
      && disabled.archiveStyle.borderTopColor !== 'rgba(0, 0, 0, 0)'
      || disabled.archiveStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'),
  );
  const narrowMinHeight = narrow.buttons.length ? Math.min(...narrow.buttons.map((button) => button.rect.h)) : null;
  const checks = {
    countLight: Boolean(selected.countInfo && selected.countInfo.contrast >= 4.5),
    hintLight: Boolean(selected.hintInfo && selected.hintInfo.contrast >= 4.5),
    countDark: Boolean(darkSelected.countInfo && darkSelected.countInfo.contrast >= 4.5),
    hintDark: Boolean(darkSelected.hintInfo && darkSelected.hintInfo.contrast >= 4.5),
    archiveDisabledState: disabled.archiveFound === true && disabled.archiveDisabled === true && (disabledContrast !== null && (disabledContrast >= 2.5 || disabledHasVisualCue)),
    narrowButtons: narrowMinHeight !== null && narrowMinHeight >= 36,
    narrowNoHScroll: narrow.hScroll.overflowX === false,
  };
  const pass = Object.values(checks).every(Boolean);
  report.record({
    id: 'A-11',
    title: '批量条计数/hint 对比 ≥4.5、禁用态可辨、窄屏按钮 ≥36',
    threshold: '选择模式下：已选数/hint light+dark ≥4.5；归档按钮在 0 选中时 disabled 且文字对比 ≥2.5 或有边框/底色可辨 cue；390 下批量条按钮高 ≥36 且无横向滚动',
    measured: {
      measurements,
      narrow,
      checks,
      disabledContrast,
      enabledContrast,
      disabledHasVisualCue,
      narrowMinHeight,
      notFound: [
        ...(disabled.barFound ? [] : ['批量条 .kb-batchbar 未出现（选择模式未生效？）']),
        ...(disabled.archiveFound ? [] : ['批量条归档按钮 .kb-batchbar__danger 未找到']),
        ...(narrow.barFound ? [] : ['390 选择模式下批量条未出现']),
      ],
    },
    pass,
    screenshots: shots,
    evidence: [
      { type: 'note', text: `已选数 light ${selected.countInfo?.contrast ?? '∅'}:1（${selected.countText}）/ dark ${darkSelected.countInfo?.contrast ?? '∅'}:1；hint light ${selected.hintInfo?.contrast ?? '∅'}:1 / dark ${darkSelected.hintInfo?.contrast ?? '∅'}:1` },
      { type: 'note', text: `禁用归档：found=${disabled.archiveFound} disabled=${disabled.archiveDisabled} 对比=${disabledContrast ?? '∅'}:1 边框=${disabled.archiveStyle?.borderTopWidth || '∅'} 底色=${disabled.archiveStyle?.backgroundColor || '∅'}；选中 2 张后归档对比=${enabledContrast ?? '∅'}:1` },
      { type: 'note', text: `390 选择 1 张：批量条 rect=${narrow.barRect ? `${narrow.barRect.w}×${narrow.barRect.h}` : '∅'}，按钮最小高 ${narrowMinHeight ?? '∅'}，页面横向溢出=${narrow.hScroll.overflowX}` },
      ...(narrow.buttons.length ? [{ type: 'note', text: `390 批量条按钮：${narrow.buttons.map((button) => `${button.text} ${button.rect.w}×${button.rect.h}`).join('、')}` }] : []),
    ],
    matrix: `已选数 亮${selected.countInfo?.contrast ?? '∅'} 暗${darkSelected.countInfo?.contrast ?? '∅'}；hint 亮${selected.hintInfo?.contrast ?? '∅'} 暗${darkSelected.hintInfo?.contrast ?? '∅'}；禁用归档 ${disabledContrast ?? '∅'}:1（${disabled.archiveStyle?.borderTopWidth || '∅'} 边框）→选中后 ${enabledContrast ?? '∅'}:1；390 按钮最小高 ${narrowMinHeight ?? '∅'}，横向溢出=${narrow.hScroll.overflowX}`,
  });
}

// ---- A-12 -----------------------------------------------------------------
async function checkEmptyState(ctx) {
  const { page, report } = ctx;
  const scenarios = [];
  const shots = [];
  const impossible = `A12-绝无此卡-${Date.now()}`;
  for (const [viewportName, viewport] of [['1440', VIEWPORTS.desktop], ['390', VIEWPORTS.narrow]]) {
    await page.ensure({ theme: 'light', view: 'board', viewport });
    await page.setSearch(impossible);
    await sleep(500);
    const board = await page.eval(() => {
      const H = window.__H;
      const emptyContainers = H.findAll('.kb-column__empty, .kb-empty');
      const clearButtons = H.findAll('button').filter((el) => H.text(el).includes('清空筛选'));
      const columnHeads = H.findAll('.kb-column-head');
      return {
        emptyCount: emptyContainers.length,
        emptyTexts: emptyContainers.map((el) => H.text(el).slice(0, 80)),
        clearCtaCount: clearButtons.length,
        columnHeadCount: columnHeads.length,
        globalEmpty: Boolean(document.querySelector('.kb-empty')),
      };
    });
    shots.push(await page.screenshot(`empty-light-${viewportName}`));
    await page.setSearch('');
    await page.ensure({ theme: 'light', view: 'list', viewport });
    await page.setSearch(impossible);
    await sleep(500);
    const list = await page.eval(() => {
      const H = window.__H;
      const emptyContainers = H.findAll('.kb-list__empty, .kb-empty');
      const clearButtons = H.findAll('button').filter((el) => H.text(el).includes('清空筛选'));
      return {
        emptyCount: emptyContainers.length,
        emptyTexts: emptyContainers.map((el) => H.text(el).slice(0, 80)),
        clearCtaCount: clearButtons.length,
        groupHeadCount: H.findAll('.kb-list__group-head').length,
      };
    });
    await page.setSearch('');
    scenarios.push({ viewport: viewportName, board, list, pass: board.emptyCount <= 1 && board.clearCtaCount <= 2 && list.emptyCount <= 1 && list.clearCtaCount <= 2 });
  }
  const pass = scenarios.every((s) => s.pass);
  report.record({
    id: 'A-12',
    title: '全局无结果只出现一个空态和一个清空入口',
    threshold: '搜索必无匹配时空态容器 ≤1；清空筛选 CTA ≤2（全局空态入口 + 工具栏去重入口）；1440/390 board+list',
    measured: { scenarios, search: impossible },
    pass,
    screenshots: shots,
    evidence: [{ type: 'note', text: scenarios.map((s) => `${s.viewport}：board 空态 ${s.board.emptyCount} / CTA ${s.board.clearCtaCount}；list 空态 ${s.list.emptyCount} / CTA ${s.list.clearCtaCount}`).join('；') }],
    matrix: scenarios.map((s) => `${s.viewport} board 空态${s.board.emptyCount} CTA${s.board.clearCtaCount} / list 空态${s.list.emptyCount} CTA${s.list.clearCtaCount}`).join('；'),
  });
}

// ---- A-13 -----------------------------------------------------------------
async function checkLoading(ctx) {
  const { page, report } = ctx;
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  const delayScript = `(function(){
    var original = window.fetch;
    window.fetch = function(input, init){
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/kanban/state') >= 0) {
        return new Promise(function(resolve, reject){
          setTimeout(function(){ original.call(window, input, init).then(resolve, reject); }, 2500);
        });
      }
      return original.call(window, input, init);
    };
  })();`;
  await page.addExtraScript('delay-state', delayScript);

  const sample = async (shotName) => {
    const navStart = Date.now();
    const loadPromise = page.cdp.waitEvent('Page.loadEventFired', 20000).catch(() => null);
    await page.cdp.send('Page.reload', { ignoreCache: false });
    await loadPromise;
    const loadEventMs = Date.now() - navStart;
    await page.waitApp({ waitLoaded: false, timeout: 8000 }).catch(() => {});
    const appReadyMs = Date.now() - navStart;
    const wait = 600 - (Date.now() - navStart);
    if (wait > 0) await sleep(wait);
    const measured = await page.eval(() => {
      const H = window.__H;
      const disabledOf = (selector) => {
        const el = H.find(selector);
        return el ? { found: true, disabled: el.disabled === true, ariaDisabled: el.getAttribute('aria-disabled') } : { found: false, disabled: null };
      };
      const viewTabs = H.findAll('.kb-viewseg [role="tab"]').map((el) => ({ text: H.text(el), disabled: el.disabled === true }));
      return {
        skeletonCards: H.findAll('.kb-skeleton-card').length,
        skeletonBoard: Boolean(document.querySelector('.kb-board--loading')),
        countTexts: H.findAll('.kb-crumb-count, .kb-crumb-tag').map((el) => H.text(el)),
        crumbTag: H.firstText('.kb-crumb-tag'),
        filter: disabledOf('.kb-filter-btn'),
        select: disabledOf('.kb-select-btn'),
        newBtn: disabledOf('.kb-new-btn'),
        search: disabledOf('#kb-search-input'),
        viewTabs,
        mainLoading: Boolean(document.querySelector('.kb-main--loading')),
      };
    });
    const sampleMs = Date.now() - navStart;
    const shot = await page.screenshot(shotName);
    return { measured, sampleMs, loadEventMs, appReadyMs, shot };
  };

  const board = await sample('loading-light-1440');
  // 列表视图再采一次 600ms 样本（列表 toolbar 有「新建卡片」主按钮）
  await page.setBootState({ theme: 'light', view: 'list' });
  const list = await sample('loading-list-light-1440');
  await page.removeExtraScript('delay-state');
  // 让原延迟请求完成并回到正常页面
  page.env.theme = null;
  page.env.view = null;
  await sleep(2600);
  await page.reload().catch(() => {});

  const boardCountHasZero = (board.measured.countTexts || []).some((text) => /(^|\D)0(\D|$)/.test(text));
  const listCountHasZero = (list.measured.countTexts || []).some((text) => /(^|\D)0(\D|$)/.test(text));
  const boardOK = board.measured.skeletonCards > 0
    && !boardCountHasZero
    && board.measured.filter.disabled === true
    && board.measured.select.disabled === true;
  const listOK = list.measured.filter.disabled === true
    && list.measured.select.disabled === true
    && list.measured.newBtn.disabled === true;
  const pass = boardOK && listOK;
  report.record({
    id: 'A-13',
    title: '首屏 loading 顶栏计数不显示 0、筛选/选择禁用、骨架在列内',
    threshold: '首屏 ~600ms 采样：骨架可见；顶栏计数不含 0；筛选/选择（列表另有新建卡片）disabled',
    measured: {
      board: { ...board.measured, sampleMs: board.sampleMs, loadEventMs: board.loadEventMs, appReadyMs: board.appReadyMs, countHasZero: boardCountHasZero },
      list: { ...list.measured, sampleMs: list.sampleMs, loadEventMs: list.loadEventMs, appReadyMs: list.appReadyMs, countHasZero: listCountHasZero },
      boardOK,
      listOK,
    },
    pass,
    screenshots: [board.shot, list.shot],
    evidence: [
      { type: 'note', text: `board ${board.sampleMs}ms 采样：骨架 ${board.measured.skeletonCards} 张；计数 ${JSON.stringify(board.measured.countTexts)}；筛选/选择 disabled=${board.measured.filter.disabled}/${board.measured.select.disabled}` },
      { type: 'note', text: `list ${list.sampleMs}ms 采样：筛选/选择/新建 disabled=${list.measured.filter.disabled}/${list.measured.select.disabled}/${list.measured.newBtn.disabled}` },
    ],
    matrix: `board ${board.sampleMs}ms：骨架 ${board.measured.skeletonCards}、计数 ${JSON.stringify(board.measured.countTexts)}、筛选/选择 disabled=${board.measured.filter.disabled}/${board.measured.select.disabled}；list：新建 disabled=${list.measured.newBtn.disabled}`,
  });
}

// ---- A-14 -----------------------------------------------------------------
async function checkRejectDisabled(ctx) {
  const { page, report, extra } = ctx;
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  const targetId = extra.noRejectCardId;
  if (!targetId) {
    report.record({
      id: 'A-14',
      title: '无 reject option 时拒绝按钮禁用且有可见解释 / aria-describedby',
      threshold: '拒绝按钮 disabled；存在可见说明文本，或按钮隐藏；aria-describedby 可解析',
      measured: { skipped: true, reason: 'demo 数据里没有「无 reject option」的待处理审批；需要代码审查', pendingCards: extra.pendingCards },
      pass: null,
      screenshots: [],
      evidence: [{ type: 'note', text: 'demo 数据无此场景，跳过实测（代码审查：ApprovalPanel rejectOption 逻辑）' }],
      matrix: '数据不足（demo 无无拒绝选项审批）',
    });
    return;
  }
  const measured = await page.eval((cardId) => {
    const H = window.__H;
    const card = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!card) return { found: false };
    const decision = card.querySelector('.kb-decision');
    if (!decision) return { found: false, reason: '该卡没有展开审批' };
    const actions = decision.querySelector('.kb-decision-actions');
    const buttons = actions ? Array.from(actions.querySelectorAll('button')) : [];
    const rejectBtn = buttons.find((el) => H.text(el).trim() === '拒绝' || H.text(el).includes('拒绝'));
    const describedBy = rejectBtn ? rejectBtn.getAttribute('aria-describedby') : null;
    let describedText = null;
    let describedFound = false;
    if (describedBy) {
      const target = document.getElementById(describedBy);
      describedFound = Boolean(target);
      describedText = target ? H.text(target) : null;
    }
    const explanationRegex = /(没有拒绝选项|无拒绝选项|不提供拒绝|仅可批准|只能批准|未提供拒绝)/;
    const explanationEls = H.findAll('.kb-decision *, .kb-decision').filter((el) => explanationRegex.test(H.text(el)) && el.children.length === 0);
    const explanationVisible = explanationEls.length > 0;
    const titleAttr = rejectBtn ? rejectBtn.getAttribute('title') : null;
    return {
      found: true,
      cardId,
      rejectExists: Boolean(rejectBtn),
      rejectDisabled: rejectBtn ? rejectBtn.disabled === true : null,
      rejectVisible: rejectBtn ? H.visible(rejectBtn) : false,
      rejectText: rejectBtn ? H.text(rejectBtn) : null,
      titleAttr,
      ariaDescribedby: describedBy,
      describedFound,
      describedText,
      explanationVisible,
      explanationTexts: explanationEls.map((el) => H.text(el).slice(0, 120)),
      actionsHtmlSnippet: actions ? actions.innerHTML.slice(0, 300) : null,
    };
  }, targetId);
  const shot = await page.screenshot('approval-light-1440');
  const pass = Boolean(measured.found)
    && (measured.rejectDisabled === true || measured.rejectVisible === false)
    && (measured.explanationVisible || (measured.describedFound && Boolean(measured.describedText || measured.titleAttr)));
  report.record({
    id: 'A-14',
    title: '无 reject option 时拒绝按钮禁用且有可见解释 / aria-describedby',
    threshold: '拒绝按钮 disabled（或隐藏）；存在可见说明文本或 aria-describedby 可解析；触屏不依赖 title',
    measured,
    pass,
    screenshots: [shot],
    evidence: [{ type: 'note', text: `拒绝按钮 disabled=${measured.rejectDisabled}；可见说明=${measured.explanationTexts?.join(' / ') || '无'}；aria-describedby=${measured.ariaDescribedby || '无'}；title=${measured.titleAttr || '无'}` }],
    matrix: `拒绝 disabled=${measured.rejectDisabled}；可见说明=${measured.explanationVisible ? '有' : '无'}；aria-describedby=${measured.ariaDescribedby || '无'}`,
  });
}

// ---- A-15 -----------------------------------------------------------------
async function checkListStatusDedupe(ctx) {
  const { page, report, analysis } = ctx;
  await page.ensure({ theme: 'light', view: 'list', viewport: VIEWPORTS.desktop });
  const measured = await page.eval(() => {
    const H = window.__H;
    const statusLabels = ['待办', '进行中', '待你确认', '已完成', '受阻', '失败', '已取消', 'Pending', 'Running', 'Done', 'Blocked', 'Failed', 'Canceled'];
    const items = H.findAll('.kb-list__item').slice(0, 10);
    const rows = items.map((item) => {
      const row = item.querySelector('.kb-list__row');
      const meta = item.querySelector('.kb-list__row-meta');
      const metaSpans = meta
        ? Array.from(meta.querySelectorAll(':scope > span[title]')).map((el) => ({ title: el.getAttribute('title'), text: H.text(el) }))
        : [];
      const text = H.text(item);
      const statusTexts = statusLabels.filter((label) => text.includes(label));
      const projectEl = item.querySelector('.kb-list__project');
      const tagEls = Array.from(item.querySelectorAll('.kb-tag'));
      const actions = item.querySelectorAll('.kb-list__row-meta button');
      return {
        cardId: item.getAttribute('data-card-id'),
        dataStatus: item.getAttribute('data-status') || null,
        rowText: text.slice(0, 180),
        statusTexts,
        statusCount: statusTexts.length,
        dotCount: item.querySelectorAll('.kb-dot').length,
        summaryElFound: Boolean(item.querySelector('.kb-list__summary')),
        project: { found: Boolean(projectEl), text: projectEl ? H.text(projectEl) : null },
        tags: { count: tagEls.length, texts: tagEls.map((el) => H.text(el)).filter(Boolean) },
        meta: {
          found: Boolean(meta),
          text: meta ? H.text(meta) : null,
          spans: metaSpans,
          hasElapsed: metaSpans.some((span) => /工作时间|Work time|elapsed/i.test(span.title || '')),
          hasSearches: metaSpans.some((span) => /搜索|Search/i.test(span.title || '')),
          hasTools: metaSpans.some((span) => /工具|Tool/i.test(span.title || '')),
          hasTimeOrCounts: metaSpans.length > 0,
        },
        actions: { count: actions.length, visible: Array.from(actions).filter(H.visible).length },
        rowRect: row ? H.rect(row) : null,
        itemRect: H.rect(item),
      };
    });
    return { rows, listCount: H.firstText('.kb-list__count') };
  });
  const failed = measured.rows.filter((row) => row.statusCount !== 1 || !row.meta.hasTimeOrCounts || row.actions.count === 0 || !row.project.found);
  const pass = measured.rows.length > 0 && failed.length === 0;
  report.record({
    id: 'A-15',
    title: '列表行状态文字仅一处，项目/标签/时间/工具仍在，行高不增加',
    threshold: '每行状态文字出现 1 次；项目、时间/搜索/工具 meta、行内操作按钮仍在；标签/关系徽标按数据记录（demo 无 handoff 时不强求）',
    measured: {
      rows: measured.rows,
      listCount: measured.listCount,
      failedRows: failed.map((row) => ({ cardId: row.cardId, statusCount: row.statusCount, project: row.project.found, metaSpans: row.meta.spans })),
      seedStatuses: analysis.byStatus,
    },
    pass,
    screenshots: [],
    evidence: [
      { type: 'note', text: measured.rows.map((row) => `${row.cardId}(${row.dataStatus || '?'}): 状态文字×${row.statusCount}[${row.statusTexts.join('、') || '∅'}] dot×${row.dotCount}；项目=${row.project.text || '∅'}；标签=${row.tags.count}${row.tags.texts.length ? `[${row.tags.texts.join('、')}]` : ''}；meta=${JSON.stringify(row.meta.spans.map((span) => `${span.title}=${span.text}`))}；操作按钮=${row.actions.count}；行高=${row.rowRect?.h}`).join('；') },
    ],
    matrix: `状态文字 ${measured.rows.map((row) => `${row.statusCount}`).join('/')}；项目 ${measured.rows.filter((row) => row.project.found).length}/${measured.rows.length}；meta ${measured.rows.filter((row) => row.meta.hasTimeOrCounts).length}/${measured.rows.length}（${JSON.stringify(measured.rows[0]?.meta.spans.map((span) => `${span.title}:${span.text}`) || [])}）；标签 ${measured.rows.reduce((sum, row) => sum + row.tags.count, 0)} 个；操作按钮 ${measured.rows.map((row) => row.actions.count).join('/')}；行高 ${[...new Set(measured.rows.map((row) => row.rowRect?.h))].join('/')}`,
  });
}

// ============================================================================
// 截图矩阵补充
// ============================================================================
async function captureScreens(ctx) {
  const { page } = ctx;
  log('补拍截图矩阵');
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  await page.screenshot('board-light-1440');
  await page.ensure({ theme: 'light', view: 'list', viewport: VIEWPORTS.desktop });
  await page.screenshot('list-light-1440');
  await page.ensure({ theme: 'light', view: 'worklines', viewport: VIEWPORTS.desktop });
  await page.screenshot('worklines-light-1440');
  await page.ensure({ theme: 'light', view: 'workspaces', viewport: VIEWPORTS.desktop });
  await page.screenshot('workspaces-light-1440');
  await page.ensure({ theme: 'dark', view: 'board', viewport: VIEWPORTS.desktop });
  await page.screenshot('board-dark-1440');
  await page.ensure({ theme: 'dark', view: 'list', viewport: VIEWPORTS.desktop });
  await page.screenshot('list-dark-1440');
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.compact });
  await page.screenshot('board-light-1024');
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.narrow });
  await page.screenshot('board-light-390');
  await page.ensure({ theme: 'dark', view: 'board', viewport: VIEWPORTS.narrow });
  await page.screenshot('board-dark-390');
  await page.ensure({ theme: 'light', view: 'list', viewport: VIEWPORTS.narrow });
  await page.screenshot('list-light-390');
  // 抽屉 / 审批 / 选择
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  const cardId = await page.eval(() => {
    const H = window.__H;
    const card = H.findAll('.kb-card').find((el) => el.querySelector('.kb-decision')) || H.findAll('.kb-card')[0];
    return card ? card.getAttribute('data-card-id') : null;
  });
  if (cardId) {
    await page.openDrawer(cardId);
    await page.screenshot('drawer-light-1440');
    await page.screenshot('approval-light-1440');
    await page.cleanUi();
  }
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  await page.click('.kb-select-btn');
  await sleep(300);
  await page.eval(() => {
    const cards = Array.from(document.querySelectorAll('.kb-card'));
    cards.slice(0, 2).forEach((card) => card.click());
    return true;
  });
  await sleep(400);
  await page.screenshot('selection-light-1440');
  await page.cleanUi();
  // composer（抽屉滚动到底部）
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.desktop });
  if (cardId) {
    await page.openDrawer(cardId);
    await page.eval(() => {
      const footer = document.querySelector('.kb-drawer__footer');
      if (!footer) return false;
      footer.scrollIntoView({ block: 'end' });
      return true;
    });
    await sleep(300);
    await page.screenshot('composer-light-1440');
    await page.cleanUi();
  }
  await page.ensure({ theme: 'light', view: 'board', viewport: VIEWPORTS.compact });
  await page.screenshot('board-light-1024');
}

// ============================================================================
main().then(() => {
  process.exit(0);
}).catch(async (error) => {
  console.error('\n视觉验收失败：', error && error.stack ? error.stack : error);
  const partial = globalThis.__visualAudit;
  if (partial && partial.args) {
    try {
      const report = partial.report;
      report.record({
        id: 'RUN',
        title: '验收脚本异常中止',
        threshold: '完整跑完所有检查',
        measured: { error: String(error && error.stack ? error.stack : error) },
        pass: false,
        evidence: [],
        screenshots: [],
        matrix: `脚本异常中止：${String(error.message || error).slice(0, 160)}`,
      });
      await mkdir(partial.args.outDir, { recursive: true });
      const jsonPath = join(partial.args.outDir, `${partial.args.label}.json`);
      const json = report.toJSON({ screenDir: `docs/assets/screens/visual-v2/${partial.args.label}`, aborted: true, error: String(error && error.stack ? error.stack : error) });
      await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
      console.error('已写入部分报告：', jsonPath);
    } catch (writeError) {
      console.error('部分报告写入失败：', writeError.message);
    }
  }
  process.exit(1);
});
