// dsh-kanban-spike —— 服务端半边
//
// 职责（与客户端半边 lib/client.js 配对）：
//   1. ctx.webServer.register：为 iframe 页面、静态资源、JSON API、SSE 推送注册路由；
//   2. ctx.tools.register：注册 agent 工具，让真实模型会话能读写看板卡片；
//   3. 内存卡片仓库是 UI 与 agent 工具共享的唯一事实源（spike 用内存，生产应换持久化）。
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_FILE = join(__dirname, "page.html");
const STATIC_ROOT = join(__dirname, "web-dist");
const API_PREFIX = "/api/kanban-spike";
const STATIC_PREFIX = "/kanban-spike-static";
const PAGE_PATH = "/kanban-spike";

export const name = "dsh-kanban-spike";
export const inject = ["webServer", "tools"];

// ---------------------------------------------------------------------------
// 内存卡片仓库 + SSE 订阅者
// ---------------------------------------------------------------------------
let cardSeq = 0;
const cards = [
  { id: "card-1", title: "侧栏入口 + main keyed 面板", column: "doing", source: "seed" },
  { id: "card-2", title: "同源 iframe + 主题令牌桥", column: "doing", source: "seed" },
  { id: "card-3", title: "iframe → 父页面 → session.prompt", column: "todo", source: "seed" },
];

function publicCard(card) {
  return { ...card };
}

function addCard({ title, column = "todo", source = "api" }) {
  const cleanTitle = typeof title === "string" ? title.trim().slice(0, 200) : "";
  if (!cleanTitle) throw new Error("卡片标题不能为空");
  const allowed = ["todo", "doing", "done"];
  const cleanColumn = allowed.includes(column) ? column : "todo";
  const card = {
    id: `card-${++cardSeq + 100}`,
    title: cleanTitle,
    column: cleanColumn,
    source,
    createdAt: Date.now(),
  };
  cards.push(card);
  broadcast({ type: "cards", count: cards.length, card: publicCard(card) });
  return card;
}

// ---------------------------------------------------------------------------
// SSE：把 agent 工具的写入实时推给 iframe（轮询是兜底，见 web-dist/app.js）
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcast(payload) {
  const frame = `event: kanban\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

/** 读请求体，超过上限直接 413。 */
async function readJsonBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { status: 400 });
  }
}

/**
 * 同源/主机校验：我们挂在 /api 前缀之下，路径比 client-connection 的 /api 更长，
 * 因此不会经过官方 /api 的 cookie 认证与 Host/Origin 防区。自定义路由必须自己补。
 * 浏览器同源 POST 会带 Origin，缺失 Origin 的请求只可能是本机非浏览器调用（curl 等）。
 */
function requestRejection(req) {
  const host = req.headers.host;
  if (!host) return 403;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return 403;
  if (req.headers["sec-fetch-site"] === "cross-site") return 403;
  return undefined;
}

// ---------------------------------------------------------------------------
// 静态资源 handler（最小但完整：MIME + 缓存 + 路径穿越防护，未知路径 404）
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "method not allowed");
    return;
  }
  // 用原始 req.url 而不是 WHATWG URL 的 pathname：URL 解析会把 %2e%2e 规范化掉，
  // 让路径穿越防护失去可判断的原始输入。这里先校验原始前缀，再解码相对路径。
  const rawPath = (req.url ?? "/").split("?")[0];
  if (!rawPath.startsWith(STATIC_PREFIX)) {
    sendText(res, 404, "not found");
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(rawPath.slice(STATIC_PREFIX.length));
  } catch {
    sendText(res, 400, "bad path");
    return;
  }
  relative = relative.replace(/^\/+/, "");
  // 路径穿越防护：先 normalize，再要求结果仍在 STATIC_ROOT 内。
  const target = normalize(join(STATIC_ROOT, relative));
  if (target !== STATIC_ROOT && !target.startsWith(STATIC_ROOT + sep)) {
    sendText(res, 403, "forbidden");
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
      "content-length": body.length,
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    sendText(res, 404, "not found");
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
function registerRoutes(ctx) {
  // iframe 页面：exact 路由，优先于 frontend-static 的 fallback 座位，不抢它的 seat。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: PAGE_PATH,
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendText(res, 405, "method not allowed");
          return;
        }
        try {
          const html = await readFile(PAGE_FILE, "utf8");
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(req.method === "HEAD" ? undefined : html);
        } catch (error) {
          sendText(res, 500, `page.html 不可用: ${String(error?.message ?? error)}`);
        }
      },
    }),
  );

  // 静态资源：prefix 路由 + 自建 handler。
  ctx.effect(() =>
    ctx.webServer.register({ kind: "prefix", path: STATIC_PREFIX, handler: serveStatic }),
  );

  // JSON API + SSE：prefix 比 /api 更长，按“最长前缀优先”命中本插件。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: API_PREFIX,
      handler: async (req, res) => {
        const rejection = requestRejection(req);
        if (rejection !== undefined) {
          sendText(res, rejection, rejection === 401 ? "unauthorized" : "forbidden");
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const route = url.pathname.slice(API_PREFIX.length);
        try {
          if (route === "/state" && req.method === "GET") {
            sendJson(res, 200, {
              ok: true,
              plugin: name,
              pid: process.pid,
              cwd: process.cwd(),
              count: cards.length,
              cards: cards.map(publicCard),
              serverTime: Date.now(),
            });
            return;
          }
          if (route === "/cards" && req.method === "POST") {
            const body = await readJsonBody(req);
            const card = addCard({ title: body.title, column: body.column, source: "api" });
            sendJson(res, 201, { ok: true, card: publicCard(card), count: cards.length });
            return;
          }
          if (route === "/events" && req.method === "GET") {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            });
            res.write(`event: hello\ndata: ${JSON.stringify({ type: "hello", count: cards.length })}\n\n`);
            sseClients.add(res);
            const keepAlive = setInterval(() => {
              try {
                res.write(": keep-alive\n\n");
              } catch {
                clearInterval(keepAlive);
                sseClients.delete(res);
              }
            }, 15000);
            req.on("close", () => {
              clearInterval(keepAlive);
              sseClients.delete(res);
            });
            return;
          }
          sendJson(res, 404, { ok: false, error: `未知路由 ${req.method} ${url.pathname}` });
        } catch (error) {
          sendJson(res, error?.status ?? 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// agent 工具：真实模型会话可读写同一份卡片
// ---------------------------------------------------------------------------
function registerTools(ctx) {
  ctx.tools.register({
    name: "kanban_spike_cards",
    description:
      "只读查看 DSH Kanban spike 看板当前的所有卡片及数量。需要确认看板上有什么任务时使用；不修改看板。",
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: { type: "string" },
      render(_args, value) {
        return [{ type: "text", text: String(value) }];
      },
    },
    async execute() {
      return JSON.stringify({ ok: true, count: cards.length, cards: cards.map(publicCard) });
    },
  });

  ctx.tools.register({
    name: "kanban_spike_add_card",
    description:
      "在 DSH Kanban spike 看板上新增一张卡片（写入后侧栏看板 iframe 会通过 SSE/轮询看到数量变化）。用户要求往看板加任务时使用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "卡片标题，1-200 字符" },
        column: {
          type: "string",
          enum: ["todo", "doing", "done"],
          description: "所在列，默认 todo",
        },
      },
      required: ["title"],
    },
    output: {
      schema: { type: "string" },
      render(_args, value) {
        return [{ type: "text", text: String(value) }];
      },
    },
    async execute(args) {
      const card = addCard({ title: args.title, column: args.column, source: "agent-tool" });
      return JSON.stringify({ ok: true, card: publicCard(card), count: cards.length });
    },
  });
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
export function apply(ctx) {
  registerRoutes(ctx);
  registerTools(ctx);
  ctx.effect(() => {
    // 让 /api/kanban-spike/state 的 cwd 与 profile 启动目录一致（浏览器父页面用不到时忽略）。
    return () => {
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
    };
  });
}
