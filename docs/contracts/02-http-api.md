# dsh-kanban HTTP API 契约 v0.1（冻结）

服务端插件在 DSH `webServer` 上注册路由，统一前缀 `/api/kanban`。同源、JSON-only、loopback 姿态。
所有响应 `content-type: application/json; charset=utf-8`，`cache-control: no-store`。

## 1. 通用约定

- 成功：`{ "ok": true, ...payload }`
- 失败：`{ "ok": false, "error": { "code": "CARD_NOT_FOUND", "message": "中文可展示文案" } }`，HTTP 状态码 4xx/5xx。
- 错误码：`BAD_REQUEST` `BAD_JSON` `TOO_LARGE` `BOARD_NOT_FOUND` `CARD_NOT_FOUND` `APPROVAL_NOT_FOUND` `VERSION_CONFLICT` `FORBIDDEN_ORIGIN` `CONFLICT` `NOT_FOUND` `INTERNAL`。
- 请求体上限 256 KiB；只接受 `content-type: application/json`（SSE / GET 除外）；校验 `origin`、`sec-fetch-site`（同源 only）。
- 所有写接口返回 `{ ok, revision, card? , board? }`，`revision` 是全局单调 revision。
- 列表与详情一律返回完整 `Card`（前端自己裁切），避免多套投影。

## 2. 路由

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/kanban/health` | `{ok:true, version, schemaVersion, dataDir, revision}` |
| GET | `/api/kanban/state?boardId=` | 看板快照：`{ok, boards:[{id,name,counts}], board, cards, revision, serverTime}`；缺省 boardId 取第一个看板 |
| GET | `/api/kanban/boards` | `{ok, boards}`（完整） |
| POST | `/api/kanban/boards` | `{name, description?}` → `{ok, board}` |
| PATCH | `/api/kanban/boards/:id` | `{name?, description?}` → `{ok, board}` |
| DELETE | `/api/kanban/boards/:id` | 仅允许删除非默认看板且为空 → `{ok}` |
| POST | `/api/kanban/cards` | 建卡，见 §3 → `{ok, card, revision}` |
| PATCH | `/api/kanban/cards/:id` | 改卡，见 §3，必须带 `version`（工具强制除外）→ `{ok, card, revision}` |
| DELETE | `/api/kanban/cards/:id` | 归档（`archived:true`）→ `{ok, revision}` |
| POST | `/api/kanban/cards/:id/move` | `{column, version?, beforeId?, afterId?}` → `{ok, card, revision}`；设置对应代表 status 并更新 cardOrder |
| GET | `/api/kanban/cards/:id/activities?limit=` | 单卡时间线（倒序，默认 50，上限 300）→ `{ok, activities}`；`/state` 不内嵌全量时间线，UI 展开卡片时按需拉取 |
| POST | `/api/kanban/cards/:id/comments` | `{text, actor?}` → `{ok, activity, card, revision}`（UI 提交后由客户端桥把同一文本发到主会话） |
| POST | `/api/kanban/cards/:id/approvals` | `{title, detail, options[], sessionId?}` → `{ok, approval, card, revision}`；卡片 status→`needs_you` |
| POST | `/api/kanban/cards/:id/approvals/:approvalId/resolve` | `{optionId, comment?}` → `{ok, approval, card, revision}`；判定：`option.tone==='danger'` 或 `optionId ∈ {no,reject,deny,cancel}` → `rejected`，否则 `approved`；解决后卡片仍留在 `needs_you`，由 agent 或用户决定回到 `running`/`done`；UI 随后把决定文本发到主会话 |
| POST | `/api/kanban/cards/:id/session` | `{sessionId, title?}` 绑定主会话（去重、置顶）→ `{ok, card, revision}` |
| DELETE | `/api/kanban/cards/:id/session/:sessionId` | 解绑 → `{ok, card, revision}` |
| POST | `/api/kanban/cards/:id/ack` | 用户已读/已看审批 → `{ok, revision}`，清未读红点 |
| POST | `/api/kanban/seed` | `{mode:'demo'|'empty'|'reset'}`：`demo` 覆盖演示数据；`empty` 清空卡片保留看板；`reset` 重建默认看板。危险操作，UI 设置里二次确认；revision 保持单调不重置 → `{ok, revision}` |
| GET | `/api/kanban/events` | SSE：`event: change\ndata: {"revision":N,"at":ms}\n\n`，每 15s 心跳 `event: ping` |
| GET | `/api/kanban/asset/*` | **不实现**；静态资源由插件独立路由 `/dsh-kanban/*` 提供（见架构文档） |

## 3. 卡片字段白名单

创建（POST /cards）：
```json
{
  "boardId": "board-default",
  "title": "实现卡片与会话绑定",
  "summary": "把卡片主会话的选择、发送、回写串起来",
  "status": "backlog",
  "priority": "medium",
  "labels": ["mvp"],
  "project": "dsh-kanban",
  "workspaceId": "...", "cwd": "/Users/roxor/Desktop/dsh/dsh kanban",
  "sessionId": "session-...",
  "agent": {"name": "DSH Agent"},
  "summaryOnly": false
}
```
更新（PATCH /cards/:id）：
```json
{
  "version": 3,
  "changes": {
    "title": "...", "summary": "...", "currentAction": "...", "result": "...",
    "status": "running", "priority": "high", "labels": ["..."],
    "project": "...", "workspaceId": "...", "cwd": "...",
    "agent": {"name": "..."}, "progress": {"step": 2, "total": 4, "text": "..."},
    "checklists": [{"text": "读 schema", "done": true}],
    "artifacts": [{"kind": "link", "label": "PR #12", "url": "..."}],
    "metadata": {"toolCalls": 12, "searches": 3, "elapsedMs": 238000},
    "order": 10
  },
  "actor": {"kind": "agent", "name": "DSH Agent"}
}
```
- 服务端忽略未知字段；`sessionIds` / `approvals` 不走 PATCH，走专用接口。
- `status` 变化自动写 Activity（`status` 类型），并同步 `startedAt`（首次 running）与 `completedAt`（done/canceled）。
- `actor` 只用于时间线展示，默认 `{kind:'user', name:'你'}`；工具调用时由工具传 agent actor。
- `VERSION_CONFLICT` 返回 `{ok:false, error:{code:'VERSION_CONFLICT'}, card}`（最新卡片）便于 UI 合并。

## 4. move 规则

- `column` ∈ `backlog|running|needs_you|done`；代表 status 映射见数据模型契约。
- 先校验 `version`（给了才校验），再从旧列 cardOrder 移除、插入新列 `beforeId/afterId` 位置（都没有则插入头部）。
- 写 Activity：`status`，文本示例：`把卡片移到「进行中」`。
- 若通过 move 进入 `needs_you` 但没有 pending approval，允许，但 UI 提示"缺少待确认项"。

## 5. SSE

```
event: change
data: {"revision":42,"at":1760000000000}
```
- 连接建立时先发一条当前 revision。
- 客户端收到与本地 revision 不同即 debounce 150ms 调 `/state`。
- 断线指数退避重连（1s→2s→4s→…→30s），页面隐藏时暂停。

## 6. 同源与安全

- 校验 `origin`（若有）与请求 `host` 同源；`sec-fetch-site` 只允许 `same-origin` / `none`。
- 不提供任何跨域 CORS 头。
- 路径 ID 必须匹配 `^(board|card|ap|ev|art|ck)-[a-f0-9]{6,8}$`（board-default 例外）。
- 文本字段做长度截断与控制字符过滤；`url` 只允许 `http(s):` 与相对路径。
- 静态资源路由需防路径穿越（只服务插件 `web/dist` 根内文件，拒绝 `..`、绝对路径、符号链接逃逸）；SPA fallback 时若 index.html 没有 `<base>`，注入 `<base href="/dsh-kanban/">`，保证深链下相对资源不 404。

## 7. 开发用独立服务器

`scripts/dev-server.mjs`（不依赖 DSH）：
```
node scripts/dev-server.mjs --port 4599 --data /tmp/kanban-dev.json
```
- 挂载同一套 handler + 静态资源 + demo 种子，供 Web UI 开发与截图验证。
- 与插件路由共用 `lib/routes.js`，不得复制业务逻辑。
