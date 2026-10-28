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
| GET | `/api/kanban/cards/:id/git?cwd=` | 卡片执行目录的 git 上下文（只读派生，不落库），见 §10 → `{ok, git, revision}`；不可用时仍是 200 + `git.available:false` |
| POST | `/api/kanban/git/summaries` | 批量 git 摘要（卡片徽标用，轻量无 graph/提交列表），见 §11 → `{ok, summaries, revision}` |
| GET | `/api/kanban/cards/:id/activities?limit=&before=` | 单卡时间线（倒序，默认 30，上限 100）。`before` 为上一页最后一条 activity id，用于「加载更早」；返回 `{ok, activities, hasMore, nextBefore}`。`/state` 不内嵌全量时间线 |
| POST | `/api/kanban/cards/:id/comments` | `{text, actor?}` → `{ok, activity, card, revision}`（UI 提交后由客户端桥把同一文本发到主会话） |
| POST | `/api/kanban/cards/:id/approvals` | 二选一：单题 `{title, detail, options[], multiSelect?, sessionId?}`；多题 `{questions:[{header?,question,multiSelect?,options[]}], detail?, sessionId?}` → `{ok, approval, card, revision}`；卡片 status→`needs_you`；多题时每题独立单选/多选。选项可带 `outcome: 'running'\|'backlog'\|'done'` 声明「选中后卡片进哪一列」（v0.9.5），非法值 400 |
| POST | `/api/kanban/cards/:id/approvals/:approvalId/resolve` | 单题：`{optionIds: string[], comment?}`；多题：`{answers:[{questionId, optionIds[], custom?}], comment?}`（也兼容旧的 `{optionId}`）→ `{ok, approval, card, revision}`；多题必须逐题作答，每题「至少 1 个选项」或「custom ≤600 字」（单选两者互斥，多选可共存）；判定：所有所选 option 均为 danger/no/reject/deny/cancel 且无任何 custom → `rejected`，否则 `approved`。**提交即改列（v0.9.5）**：卡片在 `needs_you` 且无其它 pending 审批时，同事务按所选选项 `outcome` 迁移（未声明时批准→`running`、驳回→`backlog`），并追加 `status` 活动；仍有 pending / `blocked` / `failed` / 已归档 / 不在 `needs_you` 则不变。UI 收到结果后把逐题答案文本发到主会话 |
| POST | `/api/kanban/cards/:id/session` | `{sessionId, title?}` 绑定会话并置顶为主会话 → `{ok, card, revision, activity, linked, primaryChanged, primarySessionId}`。**v0.12 主会话切换语义**：会话未绑定 → 新绑定，写 `session_linked`（已有主会话时文案带「设为主会话」，`data.previousSessionId` 记录旧主会话）；已绑定但不是主会话 → 设为主会话，写 `session_primary`（`linked=false`、`primaryChanged=true`，文案「主会话切换为「title」」）；已是主会话 → 幂等空操作（`activity=null`、`primaryChanged=false`，不写时间线）。`title` 仅进时间线文案 |
| DELETE | `/api/kanban/cards/:id/session/:sessionId` | 解绑 → `{ok, card, revision}` |
| POST | `/api/kanban/cards/:id/ack` | 用户已读/已看审批 → `{ok, revision}`，清未读红点 |
| POST | `/api/kanban/cards/batch` | `{action:'archive'|'move', cardIds: string[]（1..200）, column?}` → `{ok, cards, revision}`；`archive` 批量归档（写 `archived` 活动）；`move` 批量移到目标列（代表 status + cardOrder 头部）；跳过已归档/不存在卡片；单次上限 200 |
| POST | `/api/kanban/seed` | `{mode:'demo'|'empty'|'reset'}`：`demo` 覆盖演示数据；`empty` 清空卡片保留看板；`reset` 重建默认看板。危险操作，UI 设置里二次确认；revision 保持单调不重置 → `{ok, revision}` |
| GET | `/api/kanban/decisions` | 决策日志列表（倒序，只读），见 §4 → `{ok, decisions, hasMore, nextBefore, total, filtered, waiting, revision}` |
| GET | `/api/kanban/decisions/meta` | 决策日志状态，见 §4.2 → `{ok, logVersion, file, exists, sizeBytes, entries, skippedLines, byType, waiting, firstAt?, lastAt?, initializedAt?, revision}` |
| GET | `/api/kanban/decisions/export` | 原样导出 `decisions.jsonl`（NDJSON 附件），见 §4.3 |
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
- v0.4 起 `summary` 上限由 240 提升到 **600** 字（工具 schema、HTTP 校验、Web 表单一致）；超长仍按旧规则截断而不是报错。
- v0.9.0 起 Web 端新建/编辑表单、筛选与列表分组不再发送或展示 `priority` / `labels`；服务端与 `kanban_*` 工具仍接受并返回这两个字段，旧数据与旧调用方兼容。
- `status` 变化自动写 Activity（`status` 类型），并同步 `startedAt`（首次 running）与 `completedAt`（done/canceled）。
- `actor` 只用于时间线展示，默认 `{kind:'user', name:'你'}`；工具调用时由工具传 agent actor。
- `VERSION_CONFLICT` 返回 `{ok:false, error:{code:'VERSION_CONFLICT'}, card}`（最新卡片）便于 UI 合并。

## 4. 决策日志接口（v0.10）

只读；文件位置、事件模型与字段定义见 `05-decision-log.md`。三条路由均为 `GET`（`HEAD` 同样可用），写方法返回 405。

### 4.1 `GET /decisions`

query 参数（全部可选）：

| 参数 | 说明 |
| --- | --- |
| `limit` | 每页条数，默认 50，上限 200；非正整数 → 400 |
| `before` | 上一页最后一条事件的 `id`；游标不存在 → 400 |
| `type` | 逗号分隔的事件类型（`approval_requested` / `approval_resolved` / `approval_unresolved` / `log_initialized` / `data_reset`）；未知类型 → 400 |
| `state` | `waiting` / `resolved` / `unresolved`，只匹配 `approval_requested` 条目；其它值 → 400 |
| `cardId` / `boardId` / `approvalId` | 按 ID 过滤；格式不合法 → 400 |
| `since` / `until` | epoch 毫秒，含边界；非数字 → 400 |
| `source` | `live` / `backfill`；其它值 → 400 |

响应：

```json
{
  "ok": true,
  "decisions": [],
  "hasMore": true,
  "nextBefore": "dec-93a12ef341f0",
  "total": 26,
  "filtered": 3,
  "waiting": 1,
  "revision": 254
}
```

- `decisions[]` 倒序（`at` 降序，同刻按 `seq` 降序）；`approval_requested` 条目附带派生字段 `state`、`closedAt?`、`decision?`、`unresolvedReason?`，定义见 05 契约 §5。
- `total` 是日志总条数，`filtered` 是筛选命中数，`waiting` 是整份日志里仍在等待的审批数（不受筛选影响，用于「有多少待确认」）。
- 分页：把本页 `nextBefore` 作为下一次的 `before`；`hasMore=false` 时 `nextBefore=null`。

### 4.2 `GET /decisions/meta`

返回 `{ok, logVersion, file, exists, sizeBytes, entries, skippedLines, byType, waiting, firstAt?, lastAt?, initializedAt?, revision}`：`logVersion` 是事件格式版本（当前 1）；`firstAt` / `lastAt` 取事件真实时间，`initializedAt` 为回填标记时间；坏行只计入 `skippedLines`，不删除、不覆盖。

### 4.3 `GET /decisions/export`

原样返回 `decisions.jsonl` 的字节（不做规范化、不排序、不补字段）：

- `content-type: application/x-ndjson; charset=utf-8`
- `content-disposition: attachment; filename="decisions-YYYYMMDD.jsonl"`
- `cache-control: no-store`、`x-content-type-options: nosniff`；`HEAD` 返回同样的头、无 body。

### 4.4 错误

- 非法 `type` / `state` / `source` / `since` / `until` / `cardId` / `boardId` / `approvalId` / `before` → `400 BAD_REQUEST`；
- 决策日志未启用（嵌入/测试场景）→ `404 NOT_FOUND`；
- 日志读写失败 → `500 INTERNAL`（服务端日志含 `DECISION_LOG_IO`；写失败时对应的 `data.json` 操作不提交）；
- 未知子路径 → 404，非 `GET`/`HEAD` → 405。

## 5. move 规则

- `column` ∈ `backlog|running|needs_you|done`；代表 status 映射见数据模型契约。
- 先校验 `version`（给了才校验），再从旧列 cardOrder 移除、插入新列 `beforeId/afterId` 位置（都没有则插入头部）。
- 写 Activity：`status`，文本示例：`把卡片移到「进行中」`。
- 若通过 move 进入 `needs_you` 但没有 pending approval，允许，但 UI 提示"缺少待确认项"。

## 6. SSE

```
event: change
data: {"revision":42,"at":1760000000000}
```
- 连接建立时先发一条当前 revision。
- 客户端收到与本地 revision 不同即 debounce 150ms 调 `/state`。
- 断线指数退避重连（1s→2s→4s→…→30s），页面隐藏时暂停。

## 7. 同源与安全

- 校验 `origin`（若有）与请求 `host` 同源；`sec-fetch-site` 只允许 `same-origin` / `none`。
- 不提供任何跨域 CORS 头。
- 路径 ID 必须匹配 `^(board|card|ap|ev|art|ck)-[a-f0-9]{6,8}$`（board-default 例外）。
- 文本字段做长度截断与控制字符过滤；`url` 只允许 `http(s):` 与相对路径。
- 静态资源路由需防路径穿越（只服务插件 `web/dist` 根内文件，拒绝 `..`、绝对路径、符号链接逃逸）；SPA fallback 时若 index.html 没有 `<base>`，注入 `<base href="/dsh-kanban/">`，保证深链下相对资源不 404。

## 8. 开发用独立服务器

`scripts/dev-server.mjs`（不依赖 DSH）：
```
node scripts/dev-server.mjs --port 4599 --data /tmp/kanban-dev.json
```
- 挂载同一套 handler + 静态资源 + demo 种子，供 Web UI 开发与截图验证。
- 与插件路由共用 `lib/routes.js`，不得复制业务逻辑。

## 9. 会话归档接口（v0.11 增量）

依赖 DSH 0.2.x `workspaceRegistry` 的可逆归档能力（`archiveSession` + `unarchiveSession`）。宿主不满足时全部返回 `501 SESSION_ARCHIVE_UNAVAILABLE`，`available=false`，UI 隐藏入口。

### 9.1 GET /sessions/archive

- 200：`{ ok:true, available:boolean, archivedSessionIds:string[] }`（宿主归档集合的当前快照）。
- 无宿主 / 旧宿主：`available:false`，`archivedSessionIds:[]`。

### 9.2 POST /cards/:cardId/sessions/:sessionId/archive

- body：`{ stopActivity?: boolean }`（缺省/`false` 时宿主会拒绝仍在运行的会话；`true` 仅用于用户二次确认「停止并归档」后）。
- 预检（服务端）：卡片必须绑定该会话；卡片状态必须 `done|canceled`；所有未归档且绑定该会话的卡片都必须 `done|canceled`。
- 200：`{ ok:true, card, activity, revision, archivedSessionIds:string[] }`，并写一条 `session_archived` 活动。
- 错误：
  - `409 CARD_NOT_DONE`：触发卡未完成/取消；
  - `409 SESSION_NOT_BOUND`：会话未绑定在该卡；
  - `409 SESSION_BUSY_CARDS` + 顶层 `blockingCards:[{id,title,status}]`：共享会话仍有未完成卡片；
  - `409 SESSION_ACTIVE` + 顶层 `activity:[{kind,items?}]`：宿主报告会话仍在运行（turn / job / subagent / schedule）；可带 `stopActivity:true` 重试；
  - `404 SESSION_NOT_FOUND`：会话已被删除；
  - `501 SESSION_ARCHIVE_UNAVAILABLE`：宿主无（可逆）归档能力；
  - `500 SESSION_ARCHIVE_FAILED`：宿主归档失败。

### 9.3 POST /cards/:cardId/sessions/:sessionId/unarchive

- body：`{}`（可选 `actor`）。
- 200：`{ ok:true, card, activity, revision, archivedSessionIds }`，写一条 `session_unarchived` 活动。
- 幂等：会话本来未归档时宿主不写、服务端仍返回 200。
- 错误：`409 SESSION_NOT_BOUND` / `501 SESSION_ARCHIVE_UNAVAILABLE` / `500 SESSION_ARCHIVE_FAILED`。

### 9.4 POST /sessions/archive-batch

- body：`{ scope:'done', cardIds?:string[], dryRun?:boolean }`（`scope` 缺省 `done`；`cardIds` 限定参与判定的已完成卡片，用于「已完成列」批量；省略=全部 done/canceled 卡片，用于历史数据一次性处理）。
- dryRun=true：只返回计划，不调用宿主：
  `{ ok:true, dryRun:true, available, archivable:[{sessionId,cardId,cardIds}], skipped:[{sessionId,cardId,cardIds,reason,blockingCards?}], archivedSessionIds, revision }`
  - `reason`: `already_archived` | `blocking_cards`。
- dryRun=false：逐会话调用宿主归档；运行中/已删除/失败回填到 skipped：
  `{ ok:true, dryRun:false, available, archivable, skipped, archivedSessionIds, revision }`
  - 执行阶段 `reason`: `running`（附 `activity`）| `missing` | `failed`（附 `message`）。
- 成功归档的会话会给代表卡写 `session_archived` 活动（同一事务）。
- 无宿主：dryRun 仍可返回计划（`available:false`）；执行时逐项失败，UI 依据 `available` 隐藏入口。

## 10. 卡片 Git 上下文（v0.13 增量）

完整字段定义见 `docs/contracts/06-git-context.md`（本文件只登记路由与错误语义）。

- `GET /api/kanban/cards/:cardId/git?cwd=<绝对路径>`
- `cwd` 可选：前端可传卡片主会话的当前执行目录（宿主用 worktree 执行任务时用），服务端校验「与 `card.cwd` 同一仓库、且候选是 linked worktree」后才会采用，其余情况静默回退到 `card.cwd`。
- 200：`{ ok:true, revision, git }`；`git.available:false` 表示「无 cwd / 目录不存在 / 非 git 仓库 / 空仓库 / 超时 / git 错误」，前端静默隐藏区块，**不要按错误处理**。
- **v0.14 起** `git.graph` 为 Fork 风格多分支提交图数据（refs / commits / truncated / refsTruncated / maxCommits / maxRefs），字段语义见 `06-git-context.md` §4.5；旧服务端没有该字段时前端整块隐藏。
- 404 `CARD_NOT_FOUND`；405（非 GET/HEAD）。
- 只读：不写仓库、不写 `data.json`；每条 git 命令 2s 超时、整次采集 4s 兜底；同源校验与其它接口一致。

## 11. 批量 Git 摘要（v0.15 增量，卡片「工作线」徽标用）

详情抽屉用 `GET /cards/:id/git`（重接口，含 graph）。看板/列表的卡片徽标需要**轻量批量**数据，避免 N 张卡 N 次 git 探测。

- `POST /api/kanban/git/summaries`
- body：`{ "dirs": ["/绝对路径", ...] }`，1–32 个，允许重复（服务端去重）。
- 安全边界：`dirs` 里的目录必须**原样（trim 后）等于看板上某张未归档卡片的 `cwd`**（前端回传卡片 `cwd` 原文；服务端缓存 key 用 realpath）；不在允许集合里的目录返回该项 `available:false, reason:"forbidden"`，不报 400（批量容错）。非法 body（非数组 / 0 个 / >32 / 非字符串）→ 400 `BAD_REQUEST`。
- 200：`{ ok:true, revision, summaries: { "<请求里的 dir 原文>": GitSummary } }`，按请求原文做 key（客户端可直接映射回卡片）。
- `GitSummary`：
  ```jsonc
  { "available": true, "dir": "/real/path", "branch": "feat/x", "detached": false,
    "mainBranch": "main",
    "base": { "kind": "main", "ahead": 3, "behind": 1 },   // kind: main | upstream
    "upstream": { "ref": "origin/feat/x", "ahead": 1, "behind": 0 },  // 无则 null
    "isWorktree": true, "worktreePath": "/repo/.worktrees/feat-x" }
  ```
  不可用：`{ "available": false, "reason": "no_cwd" | "missing" | "not_git" | "no_commits" | "timeout" | "error" | "forbidden" }`。
- 性能与缓存：不做 graph / 提交列表采集（每条 6–8 条只读命令）；服务端按 realpath **缓存 10s / 最多 128 条**；前端可按仓库聚合、TTL 15s 复用。
