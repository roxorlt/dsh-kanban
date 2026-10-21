#!/usr/bin/env node
/**
 * 本地 mock 看板服务（仅开发/截图用，不进构建产物）。
 *
 * 在 builder-server 的 scripts/dev-server.mjs 就绪前，用契约里的 JSON 形状
 * 起一个同构的内存服务，供 Vite 代理 /api 联调：
 *
 *   node web/dev/mock-api.mjs --port 4599
 *   npm --prefix web run dev        # 另一个终端
 *
 * 已实现：state / cards CRUD / move / comments / approvals resolve /
 * session 绑定 / seed / SSE。数据放内存，重启即重置。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number(argValue('--port', '4599'));
const NOW = () => Date.now();

const hex = (n) => Math.random().toString(16).slice(2, 2 + n);
const id = (prefix, n = 8) => `${prefix}-${hex(n)}`;

function actor(kind, name) {
  return { kind, name };
}
const USER = actor('user', '你');
const AGENT = actor('agent', 'DSH Agent');

// ------------------------------------------------------------------ 数据

let revision = 7;

const board = {
  id: 'board-default',
  name: 'DSH 看板',
  description: '以卡片为控制面、以 DSH 会话为执行面的任务看板',
  cardOrder: { backlog: [], running: [], needs_you: [], done: [] },
  createdAt: NOW() - 3 * 86400_000,
  updatedAt: NOW(),
};

const activities = [];

function activity(cardId, type, text, at, extra = {}) {
  const item = {
    id: id('ev'),
    cardId,
    type,
    actor: type === 'comment' ? USER : AGENT,
    text,
    at,
    ...(Object.keys(extra).length ? { data: extra } : {}),
  };
  activities.push(item);
  return item;
}

function checklistItem(text, done) {
  return { id: id('ck', 6), text, done };
}

function makeCard(overrides) {
  const t = NOW();
  const base = {
    id: id('card'),
    boardId: board.id,
    title: '未命名卡片',
    summary: '',
    status: 'backlog',
    priority: 'none',
    labels: [],
    project: 'dsh-kanban',
    sessionIds: [],
    checklists: [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0, elapsedMs: 0 },
    order: 0,
    version: 1,
    createdAt: t - 3600_000,
    updatedAt: t,
  };
  return { ...base, ...overrides };
}

const minutesAgo = (m) => NOW() - m * 60_000;

const cards = [];

// 1) running
const cardRunning = makeCard({
  id: 'card-1a2b3c4d',
  title: '实现卡片与会话绑定',
  summary: '把卡片主会话的选择、回复、回写串起来，让看板能直接驱动 DSH 会话执行。',
  currentAction: '正在接 bridge.session.ensure，处理无主会话时用卡片 cwd 新建',
  status: 'running',
  priority: 'high',
  labels: ['mvp', 'ui', 'bridge'],
  project: 'dsh-kanban',
  cwd: '/Users/roxor/Desktop/dsh/dsh kanban',
  sessionIds: ['session-7f3a91'],
  agent: { name: 'DSH Agent' },
  progress: { step: 2, total: 4, percent: 50, text: '桥接层' },
  checklists: [
    checklistItem('读契约 03-client-bridge', true),
    checklistItem('会话选择器', true),
    checklistItem('无会话时 cwd 新建', false),
    checklistItem('失败降级复制', false),
  ],
  metadata: { toolCalls: 21, searches: 12, elapsedMs: 6 * 60_000 + 48_000 },
  startedAt: minutesAgo(9),
  createdAt: minutesAgo(40),
  updatedAt: minutesAgo(1),
});
cards.push(cardRunning);
activity(cardRunning.id, 'created', '创建卡片', minutesAgo(40));
activity(cardRunning.id, 'status', '把卡片移到「进行中」', minutesAgo(38), { status: 'running' });
activity(cardRunning.id, 'progress', '开始读 client-bridge 契约', minutesAgo(31), { percent: 20 });
activity(cardRunning.id, 'session_linked', '绑定主会话 session-7f3a91', minutesAgo(29));
activity(cardRunning.id, 'comment', '这里要注意：session.ensure 要带 cwd，否则新会话不在工程目录', minutesAgo(16));
activity(cardRunning.id, 'progress', '会话选择器完成，开始写无会话降级', minutesAgo(6), { percent: 50 });

// 2) needs_you with pending approval
const approvalPending = {
  id: 'ap-11aa22bb',
  title: '是否把迁移脚本跑到生产？',
  detail:
    'staging 上 dry run 通过，影响 1,318 行、耗时约 40s。生产执行会短暂锁表（预计 <2s），期间写入会排队。若失败，回滚脚本已就绪。',
  options: [
    { id: 'yes', label: '批准，跑生产', description: '立刻执行迁移，失败自动回滚', tone: 'primary' },
    { id: 'no', label: '先不跑', description: '保持现状，等下一次窗口', tone: 'danger' },
  ],
  status: 'pending',
  requestedBy: AGENT,
  requestedAt: minutesAgo(2),
  sessionId: 'session-7f3a91',
};
const cardApproval = makeCard({
  id: 'card-2b3c4d5e',
  title: '拆分 users 表并跑迁移',
  summary: '把 users 拆成 accounts / profiles 两张表，按 Postgres 17 的方式重建索引，先 staging 后生产。',
  status: 'needs_you',
  priority: 'urgent',
  labels: ['db', 'migration'],
  project: 'dsh-kanban',
  sessionIds: ['session-7f3a91'],
  agent: { name: 'DSH Agent' },
  approvals: [approvalPending],
  metadata: { toolCalls: 14, searches: 9, elapsedMs: 12 * 60_000 + 4_000 },
  startedAt: minutesAgo(22),
  createdAt: minutesAgo(50),
  updatedAt: minutesAgo(2),
});
cards.push(cardApproval);
activity(cardApproval.id, 'status', '把卡片移到「待你确认」', minutesAgo(2), { status: 'needs_you' });
activity(cardApproval.id, 'approval_requested', '请求确认：是否把迁移脚本跑到生产？', minutesAgo(2), {
  title: approvalPending.title,
});
activity(cardApproval.id, 'progress', 'dry run on staging 通过', minutesAgo(4), { percent: 100 });
activity(cardApproval.id, 'created', '创建卡片', minutesAgo(50));

// 3) blocked
const cardBlocked = makeCard({
  id: 'card-3c4d5e6f',
  title: '对齐 SSE 断线退避参数',
  summary: '服务端心跳 15s，客户端退避 1s→30s；需要确认页面隐藏时是否保持连接。',
  currentAction: '等待确认：页面隐藏（DSH 面板切走）时是否暂停 SSE',
  status: 'blocked',
  priority: 'medium',
  labels: ['realtime'],
  project: 'dsh-kanban',
  sessionIds: ['session-91c2d3'],
  agent: { name: 'DSH Agent' },
  metadata: { toolCalls: 6, searches: 2, elapsedMs: 1 * 60_000 + 19_000 },
  startedAt: minutesAgo(13),
  createdAt: minutesAgo(35),
  updatedAt: minutesAgo(5),
});
cards.push(cardBlocked);
activity(cardBlocked.id, 'status', '状态改为受阻：等待确认', minutesAgo(5), { status: 'blocked' });
activity(cardBlocked.id, 'created', '创建卡片', minutesAgo(35));

// 4) failed
const cardFailed = makeCard({
  id: 'card-4d5e6f7a',
  title: '跑通 demo 种子脚本',
  summary: '一次性写入 6 张示例卡片，覆盖 running / needs_you / blocked / failed / done / backlog。',
  currentAction: '脚本在第 4 张卡上报 ENOENT：data 目录不存在',
  status: 'failed',
  priority: 'low',
  labels: ['seed', 'dev'],
  project: 'dsh-kanban',
  metadata: { toolCalls: 3, searches: 0, elapsedMs: 8_000 },
  createdAt: minutesAgo(60),
  updatedAt: minutesAgo(20),
});
cards.push(cardFailed);
activity(cardFailed.id, 'error', '脚本失败：ENOENT ~/.dsh-kanban/data.json', minutesAgo(20));
activity(cardFailed.id, 'created', '创建卡片', minutesAgo(60));

// 5) done with result
const cardDone = makeCard({
  id: 'card-5e6f7a8b',
  title: '看板脚手架与令牌兜底',
  summary: 'Vite + React + TS 工程、DSH 令牌 fallback、Board/List 切换与骨架屏。',
  status: 'done',
  priority: 'medium',
  labels: ['ui', 'scaffold'],
  project: 'dsh-kanban',
  sessionIds: ['session-7f3a91'],
  agent: { name: 'DSH Agent' },
  result: '已完成：web/ 工程可构建，亮暗两套令牌兜底，看板与列表视图可用，构建产物 132 KB gzip。',
  artifacts: [
    { id: 'art-a1b2c3', kind: 'commit', label: 'feat(web): kanban shell', url: 'https://example.com/commit/1' },
    { id: 'art-d4e5f6', kind: 'file', label: 'web/dist/index.html', path: 'web/dist/index.html' },
  ],
  metadata: { toolCalls: 17, searches: 3, elapsedMs: 4 * 60_000 + 12_000 },
  startedAt: minutesAgo(58),
  completedAt: minutesAgo(31),
  createdAt: minutesAgo(70),
  updatedAt: minutesAgo(31),
});
cards.push(cardDone);
activity(cardDone.id, 'result', '已完成脚手架与令牌兜底', minutesAgo(31));
activity(cardDone.id, 'status', '把卡片移到「已完成」', minutesAgo(31), { status: 'done' });

// 6) backlog
const cardBacklog = makeCard({
  id: 'card-6f7a8b9c',
  title: '列表视图批量操作',
  summary: '多选卡片后批量移动 / 归档；首版先做勾选与全选当前列。',
  status: 'backlog',
  priority: 'low',
  labels: ['ui', 'backlog'],
  project: 'dsh-kanban',
  metadata: { toolCalls: 0, searches: 0, elapsedMs: 0 },
  order: 1,
  createdAt: minutesAgo(80),
  updatedAt: minutesAgo(78),
});
cards.push(cardBacklog);
activity(cardBacklog.id, 'created', '创建卡片', minutesAgo(80));

// 7) running #2
const cardRunning2 = makeCard({
  id: 'card-7a8b9c0d',
  title: '审批区交互与键盘可达',
  summary: '批准/拒绝、备注、方案单选，全部可 Tab 到达；Esc 关抽屉。',
  status: 'running',
  priority: 'high',
  labels: ['a11y', 'ui'],
  project: 'dsh-kanban',
  sessionIds: ['session-91c2d3'],
  agent: { name: 'DSH Agent' },
  checklists: [checklistItem('方案单选组', true), checklistItem('键盘 Tab 顺序', false)],
  metadata: { toolCalls: 9, searches: 5, elapsedMs: 2 * 60_000 + 31_000 },
  startedAt: minutesAgo(7),
  createdAt: minutesAgo(30),
  updatedAt: minutesAgo(2),
});
cards.push(cardRunning2);
activity(cardRunning2.id, 'progress', '开始写审批单选组', minutesAgo(4), { percent: 35 });
activity(cardRunning2.id, 'created', '创建卡片', minutesAgo(30));

board.cardOrder = {
  backlog: [cardBacklog.id],
  running: [cardRunning.id, cardRunning2.id],
  needs_you: [cardApproval.id, cardBlocked.id, cardFailed.id],
  done: [cardDone.id],
};

const sessions = [
  { id: 'session-7f3a91', title: '看板 Web UI 实现', running: true, updatedAt: NOW() - 60_000 },
  { id: 'session-91c2d3', title: '实时刷新与审批交互', running: false, updatedAt: NOW() - 600_000 },
];

const sseClients = new Set();

function broadcast() {
  revision += 1;
  board.updatedAt = NOW();
  const payload = `event: change\ndata: ${JSON.stringify({ revision, at: NOW() })}\n\n`;
  for (const client of sseClients) client.write(payload);
  return revision;
}

function touchCard(card) {
  card.version += 1;
  card.updatedAt = NOW();
}

function ensureCard(idValue) {
  return cards.find((card) => card.id === idValue);
}

function cardOrderRemove(cardId) {
  for (const key of Object.keys(board.cardOrder)) {
    board.cardOrder[key] = board.cardOrder[key].filter((value) => value !== cardId);
  }
}

function columnOfStatus(status) {
  if (status === 'backlog') return 'backlog';
  if (status === 'running') return 'running';
  if (status === 'done' || status === 'canceled') return 'done';
  return 'needs_you';
}

const STATUS_OF_COLUMN = { backlog: 'backlog', running: 'running', needs_you: 'needs_you', done: 'done' };

// ------------------------------------------------------------------ HTTP

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error('TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serveStatic(res, pathname) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('web/dist 还不存在：先运行 npm --prefix web run build');
    return;
  }
  let relative = pathname.replace(/^\/dsh-kanban/, '');
  if (relative === '/' || relative === '') relative = '/index.html';
  const target = path.join(DIST, relative);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(DIST + path.sep) && resolved !== path.join(DIST, 'index.html')) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    const index = path.join(DIST, 'index.html');
    const body = fs.readFileSync(index);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    if (!pathname.startsWith('/api/kanban')) {
      if (req.method === 'GET') return serveStatic(res, pathname);
      res.writeHead(405);
      return res.end();
    }

    const route = pathname.slice('/api/kanban'.length) || '/';

    if (req.method === 'GET' && route === '/health') {
      return json(res, 200, {
        ok: true,
        version: '0.1.0-mock',
        schemaVersion: 1,
        dataDir: '/tmp/kanban-mock.json',
        revision,
      });
    }

    if (req.method === 'GET' && route === '/state') {
      const boardId = url.searchParams.get('boardId') ?? board.id;
      if (boardId !== board.id) return fail(res, 404, 'BOARD_NOT_FOUND', '看板不存在');
      return json(res, 200, {
        ok: true,
        boards: [
          {
            id: board.id,
            name: board.name,
            counts: {
              backlog: board.cardOrder.backlog.length + cards.filter((c) => !board.cardOrder.backlog.includes(c.id) && columnOfStatus(c.status) === 'backlog' && !c.archived).length,
              running: board.cardOrder.running.length,
              needs_you: board.cardOrder.needs_you.length,
              done: board.cardOrder.done.length,
            },
          },
        ],
        board,
        cards: cards.filter((card) => !card.archived),
        activities,
        revision,
        serverTime: NOW(),
      });
    }

    if (req.method === 'GET' && route === '/boards') {
      return json(res, 200, { ok: true, boards: [board] });
    }

    if (req.method === 'POST' && route === '/cards') {
      const body = await readBody(req);
      if (!body.title || !String(body.title).trim()) return fail(res, 400, 'BAD_REQUEST', '标题必填');
      const card = makeCard({
        title: String(body.title).trim().slice(0, 120),
        summary: String(body.summary ?? '').slice(0, 240),
        status: body.status ?? 'backlog',
        priority: body.priority ?? 'none',
        labels: Array.isArray(body.labels) ? body.labels.slice(0, 12) : [],
        project: body.project,
        workspaceId: body.workspaceId,
        cwd: body.cwd,
        sessionIds: body.sessionId ? [body.sessionId] : [],
        agent: body.agent,
        createdAt: NOW(),
        updatedAt: NOW(),
      });
      cards.push(card);
      activity(card.id, 'created', '创建卡片', NOW());
      const column = columnOfStatus(card.status);
      cardOrderRemove(card.id);
      board.cardOrder[column].unshift(card.id);
      const nextRevision = broadcast();
      return json(res, 200, { ok: true, card, revision: nextRevision });
    }

    const cardActivitiesMatch = route.match(/^\/cards\/([^/]+)\/activities$/);
    if (req.method === 'GET' && cardActivitiesMatch) {
      const card = ensureCard(decodeURIComponent(cardActivitiesMatch[1]));
      if (!card) return fail(res, 404, 'CARD_NOT_FOUND', '卡片不存在');
      const list = activities
        .filter((item) => item.cardId === card.id)
        .sort((a, b) => b.at - a.at)
        .slice(0, 300);
      return json(res, 200, { ok: true, activities: list, revision });
    }

    const cardMoveMatch = route.match(/^\/cards\/([^/]+)\/move$/);
    if (req.method === 'POST' && cardMoveMatch) {
      const card = ensureCard(decodeURIComponent(cardMoveMatch[1]));
      if (!card) return fail(res, 404, 'CARD_NOT_FOUND', '卡片不存在');
      const body = await readBody(req);
      if (!['backlog', 'running', 'needs_you', 'done'].includes(body.column)) {
        return fail(res, 400, 'BAD_REQUEST', 'column 不合法');
      }
      if (typeof body.version === 'number' && body.version !== card.version) {
        return json(res, 409, { ok: false, error: { code: 'VERSION_CONFLICT', message: '版本冲突' }, card });
      }
      card.status = STATUS_OF_COLUMN[body.column];
      touchCard(card);
      cardOrderRemove(card.id);
      const order = board.cardOrder[body.column];
      let index = 0;
      if (body.beforeId) {
        const found = order.indexOf(body.beforeId);
        index = found >= 0 ? found : 0;
      } else if (body.afterId) {
        const found = order.indexOf(body.afterId);
        index = found >= 0 ? found + 1 : 0;
      }
      order.splice(index, 0, card.id);
      const label = { backlog: '待办', running: '进行中', needs_you: '待你确认', done: '已完成' }[body.column];
      activity(card.id, 'status', `把卡片移到「${label}」`, NOW(), { status: card.status });
      const nextRevision = broadcast();
      return json(res, 200, { ok: true, card, revision: nextRevision });
    }

    const cardCommentMatch = route.match(/^\/cards\/([^/]+)\/comments$/);
    if (req.method === 'POST' && cardCommentMatch) {
      const card = ensureCard(decodeURIComponent(cardCommentMatch[1]));
      if (!card) return fail(res, 404, 'CARD_NOT_FOUND', '卡片不存在');
      const body = await readBody(req);
      const text = String(body.text ?? '').trim().slice(0, 400);
      if (!text) return fail(res, 400, 'BAD_REQUEST', '内容不能为空');
      const item = activity(card.id, 'comment', text, NOW());
      card.metadata.toolCalls += 0;
      touchCard(card);
      const nextRevision = broadcast();
      return json(res, 200, { ok: true, activity: item, card, revision: nextRevision });
    }

    const resolveMatch = route.match(/^\/cards\/([^/]+)\/approvals\/([^/]+)\/resolve$/);
    if (req.method === 'POST' && resolveMatch) {
      const card = ensureCard(decodeURIComponent(resolveMatch[1]));
      const approvalId = decodeURIComponent(resolveMatch[2]);
      if (!card) return fail(res, 404, 'CARD_NOT_FOUND', '卡片不存在');
      const approval = card.approvals.find((item) => item.id === approvalId);
      if (!approval) return fail(res, 404, 'APPROVAL_NOT_FOUND', '审批不存在');
      const body = await readBody(req);
      const option = approval.options.find((item) => item.id === body.optionId);
      if (!option) return fail(res, 400, 'BAD_REQUEST', 'optionId 不合法');
      approval.status = option.tone === 'danger' || option.id === 'no' ? 'rejected' : 'approved';
      approval.resolvedAt = NOW();
      approval.resolvedBy = USER;
      approval.resolution = { optionId: option.id, label: option.label, comment: body.comment };
      card.status = 'running';
      touchCard(card);
      activity(card.id, 'approval_resolved', `${approval.status === 'approved' ? '已批准' : '已拒绝'}：${option.label}`, NOW());
      const nextRevision = broadcast();
      return json(res, 200, { ok: true, approval, card, revision: nextRevision });
    }

    const sessionMatch = route.match(/^\/cards\/([^/]+)\/session$/);
    if (req.method === 'POST' && sessionMatch) {
      const card = ensureCard(decodeURIComponent(sessionMatch[1]));
      if (!card) return fail(res, 404, 'CARD_NOT_FOUND', '卡片不存在');
      const body = await readBody(req);
      if (!body.sessionId) return fail(res, 400, 'BAD_REQUEST', 'sessionId 必填');
      card.sessionIds = [body.sessionId, ...card.sessionIds.filter((value) => value !== body.sessionId)];
      touchCard(card);
      activity(card.id, 'session_linked', `绑定会话 ${body.sessionId}`, NOW());
      return json(res, 200, { ok: true, card, revision: broadcast() });
    }

    const unbindMatch = route.match(/^\/cards\/([^/]+)\/session\/([^/]+)$/);
    if (req.method === 'DELETE' && unbindMatch) {
      const card = ensureCard(decodeURIComponent(unbindMatch[1]));
      if (!card) return fail(res, 404, 'CARD_NOT_FOUND', '卡片不存在');
      const sessionId = decodeURIComponent(unbindMatch[2]);
      card.sessionIds = card.sessionIds.filter((value) => value !== sessionId);
      touchCard(card);
      return json(res, 200, { ok: true, card, revision: broadcast() });
    }

    const ackMatch = route.match(/^\/cards\/([^/]+)\/ack$/);
    if (req.method === 'POST' && ackMatch) {
      const card = ensureCard(decodeURIComponent(ackMatch[1]));
      if (!card) return fail(res, 404, 'CARD_NOT_FOUND', '卡片不存在');
      activity(card.id, 'ack', '用户已读', NOW());
      return json(res, 200, { ok: true, revision: broadcast() });
    }

    const cardMatch = route.match(/^\/cards\/([^/]+)$/);
    if (cardMatch) {
      const card = ensureCard(decodeURIComponent(cardMatch[1]));
      if (!card) return fail(res, 404, 'CARD_NOT_FOUND', '卡片不存在');
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if (typeof body.version === 'number' && body.version !== card.version) {
          return json(res, 409, { ok: false, error: { code: 'VERSION_CONFLICT', message: '版本冲突' }, card });
        }
        const changes = body.changes ?? {};
        for (const key of ['title', 'summary', 'currentAction', 'result', 'status', 'priority', 'labels', 'project', 'workspaceId', 'cwd', 'agent', 'progress', 'checklists', 'artifacts', 'metadata', 'order']) {
          if (changes[key] !== undefined) card[key] = changes[key];
        }
        if (changes.status) {
          activity(card.id, 'status', `状态改为 ${changes.status}`, NOW(), { status: changes.status });
          cardOrderRemove(card.id);
          board.cardOrder[columnOfStatus(card.status)].unshift(card.id);
        }
        touchCard(card);
        return json(res, 200, { ok: true, card, revision: broadcast() });
      }
      if (req.method === 'DELETE') {
        card.archived = true;
        touchCard(card);
        cardOrderRemove(card.id);
        return json(res, 200, { ok: true, revision: broadcast() });
      }
    }

    if (req.method === 'POST' && route === '/seed') {
      // mock 里只支持重置回 demo 状态（需要重启进程）
      return json(res, 200, { ok: true, revision: broadcast() });
    }

    if (req.method === 'GET' && route === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      res.write(`event: change\ndata: ${JSON.stringify({ revision, at: NOW() })}\n\n`);
      sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(`event: ping\ndata: {"at":${NOW()}}\n\n`);
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return undefined;
    }

    return fail(res, 404, 'BAD_REQUEST', `未知路由 ${req.method} ${route}`);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INTERNAL';
    if (code === 'BAD_JSON' || code === 'TOO_LARGE') return fail(res, 400, code, '请求体不合法');
    console.error(error);
    return fail(res, 500, 'INTERNAL', 'mock 服务内部错误');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-api] http://127.0.0.1:${PORT}  revision=${revision} cards=${cards.length}`);
  if (fs.existsSync(DIST)) console.log(`[mock-api] serving web/dist at /dsh-kanban/ (and /)`);
  else console.log('[mock-api] web/dist 不存在，仅提供 /api（先 npm --prefix web run build）');
});
