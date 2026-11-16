# dsh-kanban 云同步契约（C1/3）：Local-First 状态镜像与 24x7 入站暂存

> **状态**：v0.2（C1 冻结 + C2/C3 已实施）｜**适用版本**：dsh-kanban v0.27 起（可选能力，默认关闭）
> **配套产物**：
> - 云侧 Schema：[`cloudflare/migrations/0001_kanban_sync.sql`](../../cloudflare/migrations/0001_kanban_sync.sql)
> - 协议层（纯函数，C2/C3 共用）：[`lib/cloud-sync-protocol.js`](../../lib/cloud-sync-protocol.js)
> - 本地守护器（C3）：[`lib/cloud-sync-client.js`](../../lib/cloud-sync-client.js)
> - Worker 网关（C2）：[`cloudflare/worker.mjs`](../../cloudflare/worker.mjs) / [`cloudflare/README.md`](../../cloudflare/README.md)
> - 单测：[`test/cloud-sync-protocol.test.mjs`](../../test/cloud-sync-protocol.test.mjs) / [`test/cloud-worker.test.mjs`](../../test/cloud-worker.test.mjs) / [`test/cloud-sync-client.test.mjs`](../../test/cloud-sync-client.test.mjs)
> **上游契约**：本地数据模型以 [`01-data-model.md`](01-data-model.md) 为准，HTTP 语义与错误信封以 [`02-http-api.md`](02-http-api.md) 为准。本文**不重复定义**本地实体字段，只定义「哪些字段以什么形态上云」以及云侧的表、接口与状态机。
> **下游卡片**：C2（Worker 网关 + 部署）、C3（本地同步守护器 + 端到端验收）均已完成；C2/C3 实施偏差已回写 §5.2、§6.2、§8.5 与 **§11.5**，与本文不一致时以回写章节为准。

---

## 1. 目标、边界与非目标

### 1.1 一句话

本地 Mac 持有**代码仓、Git Worktree、量化进程与全部写权限**；Cloudflare 只做两件事：
**(a) 看板状态的脱敏增量镜像**（只读副本，供异地/手机端查看与灾备参照）；
**(b) 合盖休眠期间的入站事件暂存队列**（IM 消息、快捷按钮点击、GitHub Webhook 先由云端秒回并暂存，唤醒后零丢失回放给本地消费）。

### 1.2 两平面的职责边界

| 能力 | 本地执行面（Local Execution Plane） | 云端状态/入站面（Cloud State & Ingress Plane） |
| --- | --- | --- |
| 看板状态写入（卡片/审批/时间线） | **唯一权威写者**（`~/.dsh-kanban/data.json`） | 只读镜像，**永不产生业务状态变更** |
| 代码仓、Worktree、进程、模型推理 | 全部在本地，100% 不上云 | 不接触 |
| 卡片 `cwd` / `workspaceId` / `sessionIds` / 运行时预算 | 本地保留并使用 | 协议层**剥离**，D1 中不存在 |
| IM / GitHub 入站事件 | 最终消费方（`handleIngressEvent` 建卡/审批/评论） | 先暂存 `ingress_inbox` 并秒回 2xx，本地在线后 claim/ack 回放 |
| 出站通知（IM 通知、唤醒指令） | 本地 `data.json.outbox`（agent 唤醒指令队列） | 不得混用；云侧 `outbox` 是 Worker→下游的投递队列（见 §9.4） |
| 鉴权与密钥 | `~/.dsh-kanban/cloud-config.json`（0600） | Worker secret `CLOUD_SYNC_TOKEN` 等 |
| 冲突裁决 | 本地权威（单写者） | 只做 revision CAS 与幂等重放 |

### 1.3 明确非目标（本期不做）

1. **不做云主机/云端执行**：不在 Worker、Durable Objects 或任意云函数里跑量化、跑代码、开 worktree。
2. **不做双向合并**：云端不是第二个写者，不存在字段级合并；冲突全部退化为「客户端 pull 后用本地权威状态重算 delta」。
3. **不把被管理项目的代码仓上云**：`dsh-kanban` 只镜像**看板控制面**（含卡片标题/摘要等脱敏文本）；被管理业务项目及未来管理的 coding/非 coding 项目仅作为卡片承载内容出现，其 `cwd`、worktree 路径、运行进程、日志均留在本地。
4. **不做多租户 / 多用户权限体系**：一个部署 = 一条个人 Bearer 令牌；多客户端写属于单写者假设外，见 §5.4。
5. **不镜像决策日志 `decisions.jsonl`**：它只追加、体积大、含审批上下文，留在本地（如需，另卡设计）。
6. **不镜像 Web 前端产物与静态资源**：Worker 不托管看板 UI（UI 仍在本地 127.0.0.1）。

---

## 2. 总体架构与数据流

### 2.1 架构图

```mermaid
%%{init: {"flowchart": {"curve": "linear", "htmlLabels": false, "nodeSpacing": 55, "rankSpacing": 75}}}%%
flowchart LR
  subgraph Local["本地执行面（Mac，权威）"]
    Store["data.json<br/>看板状态"]
    Server["看板服务<br/>REST + SSE"]
    Daemon["云同步守护器<br/>C3"]
    Ingest["本地入站路由<br/>/api/kanban/ingress"]
    Code["代码仓 / Worktree<br/>量化进程"]
  end
  subgraph Cloud["云端状态与入站面（Cloudflare）"]
    Worker["Sync Worker<br/>Bearer 鉴权"]
    D1[("D1 镜像库<br/>boards / cards / activities")]
    Inbox[("ingress_inbox<br/>暂存队列 + outbox")]
    Webhook["IM / GitHub<br/>Webhook 来源"]
  end
  Code --> Store
  Server <--> Store
  Daemon <--> Server
  Daemon -->|"push 脱敏增量"| Worker
  Worker -->|"pull / claim"| Daemon
  Worker <--> D1
  Webhook -->|"签名校验后入队"| Worker
  Worker --> Inbox
  Daemon -->|"回放 JSON"| Ingest
  Ingest --> Server
```

### 2.2 三条核心数据流

| # | 方向 | 触发 | 路径 | 失败/断网语义 |
| --- | --- | --- | --- | --- |
| S1 | 本地 → 云端 | Store 变更防抖（默认 2s）或定时（30s 兜底） | `toCloudSnapshot` → `diffCloudSnapshots` → `POST /v1/sync/push` | 本地不阻塞；未推送增量在下次 diff 中自然重算（本地权威 + 幂等 CAS） |
| S2 | 云端 → 本地（状态） | 冷启动 / 灾备恢复 / 本地数据重置后核对 | `GET /v1/sync/pull`（revision 窗口分页） | 只读核对用途；不写本地状态（本地仍权威） |
| S3 | 云端 → 本地（入站） | 本地在线且定时（默认每 30s）或网络恢复 | `POST /v1/inbox/claim` → 本地 `/api/kanban/ingress` → `POST /v1/inbox/ack` | 至少一次投递；失败退避重试，≤20 次后 dead 等人工处理 |

### 2.3 入站回放时序（休眠期零丢失）

```mermaid
%%{init: {"sequence": {"mirrorActors": false, "wrap": false}}}%%
sequenceDiagram
  autonumber
  participant W as IM / GitHub
  participant C as Cloudflare Worker
  participant L as 本地云同步守护器
  participant K as 本地看板服务
  W->>C: Webhook（签名头）
  C->>C: 校验签名 / 去重 / 落 ingress_inbox
  C-->>W: 202 {ok, id}（秒回，Mac 可休眠）
  L->>C: claim（Bearer，batchSize=20）
  C-->>L: items[带租约]
  L->>K: POST /api/kanban/ingress（原始 JSON）
  K-->>L: 200 {ok, revision}
  L->>C: ack（Bearer，ids）
  C->>C: status=acked（失败则退避重排）
  Note over L,C: 本地离线/崩溃时租约到期，条目自动可被重新 claim
```

---

## 3. 云侧数据模型（D1）

迁移文件：[`cloudflare/migrations/0001_kanban_sync.sql`](../../cloudflare/migrations/0001_kanban_sync.sql)。文件名与目录符合 Wrangler D1 migrations 约定：

```bash
# C2 部署时执行（示例）
wrangler d1 create dsh-kanban-sync
wrangler d1 migrations apply dsh-kanban-sync --migrations-dir cloudflare/migrations --remote
```

> 迁移脚本是**幂等 DDL**（`CREATE TABLE IF NOT EXISTS` / `INSERT ... ON CONFLICT DO NOTHING`），重复执行不改变 epoch；Wrangler 自己在 `d1_migrations` 表记录版本，本脚本不另建迁移表。

### 3.1 表清单

| 表 | 性质 | 作用 |
| --- | --- | --- |
| `sync_meta` | 辅助（单行） | 同步纪元 `epoch`、全局 `revision`、push 幂等回执 |
| `boards` | 必需 | 看板镜像 |
| `cards` | 必需 | 卡片镜像（热点列 + 脱敏 payload） |
| `activities` | 必需 | 时间线镜像 |
| `tombstones` | 辅助 | 删除墓碑（时间线裁剪、看板/卡片删除） |
| `outbox` | 必需 | Worker → 下游的可靠投递队列（与本地 `data.json.outbox` 无关） |
| `ingress_inbox` | 必需 | 休眠期入站事件暂存与回放 |

**双轨列设计**：每张镜像表 =「热点列（供 Worker 筛选/排序，不解析 JSON）+ `payload`（脱敏后的完整实体 JSON）」。这样本地新增字段不需要改 D1 表；C3 拉取后可原样还原对象。`payload` 的字段白名单由 `lib/cloud-sync-protocol.js` 的 `toCloudCard` / `toCloudBoard` / `toCloudActivity` 强制。

### 3.2 `sync_meta`（单行）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 恒为 1（`CHECK (id = 1)`） |
| `schema_version` | INTEGER | 云侧 schema 版本，当前 1 |
| `epoch` | TEXT | 16 位十六进制随机串，首次迁移生成；D1 重建/重置后必然变化 |
| `revision` | INTEGER | 全局单调递增 revision，每次成功 push +1 |
| `last_push_id` | TEXT | 上一次成功 push 的 `pushId`（幂等重放） |
| `last_push_at` / `last_push_revision` | INTEGER | 上一次 push 时间与分配到的 revision |
| `last_pull_at` / `last_client_id` | INTEGER / TEXT | 观测用 |
| `created_at` / `updated_at` | INTEGER | epoch ms |

### 3.3 `boards`

| 列 | 说明 |
| --- | --- |
| `id` TEXT PK | `board-xxxxxxxx` |
| `name` / `description` | 文本（已脱敏） |
| `card_order` TEXT | JSON：`{"backlog":[cardId…],"running":[…],"needs_you":[…],"done":[…]}` |
| `archived` INTEGER | 0/1 |
| `created_at` / `updated_at` / `synced_at` | epoch ms |
| `revision` INTEGER | 最后一次写入该行的 push revision |
| `payload` TEXT | 脱敏后的完整 Board JSON |

### 3.4 `cards`

| 列 | 说明 |
| --- | --- |
| `id` TEXT PK | `card-xxxxxxxx` |
| `board_id` | 所属看板 |
| `title` | 标题（脱敏） |
| `status` | 7 态之一（`CHECK` 约束，见 01-data-model §2） |
| `priority` / `project` / `external_ref` / `parent_card_id` | 热点筛选列 |
| `version` INTEGER | 本地乐观锁版本；行级防回退（`WHERE excluded.version >= cards.version`） |
| `archived` INTEGER | 归档标记（本地 DELETE 卡片=归档，不是硬删） |
| `created_at` / `updated_at` / `completed_at` | epoch ms |
| `revision` / `payload` / `synced_at` | 同上 |

### 3.5 `activities`

| 列 | 说明 |
| --- | --- |
| `id` TEXT PK | `ev-xxxxxxxx` |
| `card_id` / `board_id` | 归属 |
| `type` | 01-data-model 的 Activity 类型 |
| `actor_kind` / `actor_name` | 只保留展示需要的身份信息（actor.id 剥离） |
| `text` | 展示文本（脱敏） |
| `at` | epoch ms |
| `revision` / `payload` / `synced_at` | 同上；`payload` 含脱敏后的 `data` |

### 3.6 `tombstones`

`entity`(`board|card|activity`) + `entity_id` 复合主键，另有 `board_id`、`deleted_at`、`revision`。本地时间线被 `LIMITS.activitiesPerCard`（300）裁剪时，diff 会为消失的节点产出 `deletes`，Worker 写墓碑，下游客户端据此从镜像中删除。当前本地 `DELETE /cards/:id` 实际是归档，所以卡片墓碑主要作为未来硬删的预留能力。

### 3.7 `outbox`

见 §8.8。列：`seq`(自增 PK)、`idempotency_key`(UNIQUE)、`kind`、`target`(JSON)、`payload`、`state`(`pending|leased|delivered|failed|expired`)、`attempts`/`max_attempts`、`next_attempt_at`、`lease_token`/`lease_expires_at`、`last_error`、`created_at`/`updated_at`/`delivered_at`/`expires_at`。

### 3.8 `ingress_inbox`

见 §8。列：`seq`(自增到达序号)、`id`(UNIQUE)、`provider`、`event_type`、`delivery_id`、`dedupe_key`(UNIQUE)、`headers`(JSON，白名单)、`payload`(原始请求体文本)、`payload_bytes`、`status`(`pending|leased|acked|failed|dead`)、`attempts`/`max_attempts`、`next_attempt_at`、`lease_token`/`lease_expires_at`、`received_at`/`acked_at`、`last_error`、`expires_at`。

### 3.9 索引与保留策略

- 增量拉取索引：`(revision, id)`（boards/cards/activities/tombstones），保证 `revision` 窗口分页走索引。
- 看板视图索引：`cards(board_id, status, updated_at DESC)`、`cards(project)`、`cards(parent_card_id)`。
- 时间线：`activities(card_id, at, id)`、`activities(at DESC)`。
- 入站/投递：`(status, next_attempt_at, seq)`、`(status, seq)`、`expires_at`。
- 清理（C2 用 Cron Trigger 每小时执行，SQL 模板见迁移文件头注释）：
  - `ingress_inbox`：acked 超 7 天、过 `expires_at` 的条目删除；`outbox`：delivered/expired 超 3 天删除；
  - `activities`：镜像只保留最近 90 天（可丢），`tombstones` 保留最近 2000 个 revision 窗口。

---

## 4. 鉴权与密钥

### 4.1 Bearer 令牌（状态面所有接口）

- 请求头：`Authorization: Bearer <token>`；token 与 Worker secret `CLOUD_SYNC_TOKEN` 完全一致。
- Worker 端用**常量时间比较**（`assertAuthorized` / `verifyBearer`，先 sha256 归一长度再 `timingSafeEqual`），不得使用 `===` 直接比较。
- **fail-closed**：Worker 未配置 `CLOUD_SYNC_TOKEN` 时，状态面所有接口返回 `503 UNAVAILABLE`，而不是放行。
- 错误语义：

| 情形 | 响应 |
| --- | --- |
| 缺 `Authorization` 或格式不是 `Bearer <token>` | `401 UNAUTHORIZED` |
| token 不匹配 | `401 UNAUTHORIZED`（不区分「不存在/错误」，不泄露信息） |
| 服务端未配置 token | `503 UNAVAILABLE` |
| 仅 ingress Webhook 入口 | 不走 Bearer，改走各来源签名校验（§8.2） |

### 4.2 密钥与配置存放

- **仓库内零密钥**：token、webhook secret 一律不进 Git；C2 的本地开发用 `cloudflare/.dev.vars`（已在 `.gitignore` 范围内需自行确认），生产用 `wrangler secret put`。
- 本地配置：`~/.dsh-kanban/cloud-config.json`（`<dataDir>` 下，权限 `0600`），由 C3 读取；结构见附录 A，校验函数 `normalizeCloudConfig`（缺失/非法字段抛 `BAD_CONFIG`，日志用 `describeCloudConfig` 输出掩码令牌）。
- 轮换：`wrangler secret put CLOUD_SYNC_TOKEN` 后，改本地 config 的 `token` 并重启插件；旧 token 立即失效（单 token 设计，不做多 token 并存）。
- 日志：任何服务端/端侧日志都不得打印明文 token；入站请求的 `Authorization`/`Cookie`/签名头不落库（`filterIngressHeaders` 白名单）。

---

## 5. revision 与乐观锁

### 5.1 三层版本号，各司其职

| 版本 | 位置 | 递增时机 | 用途 |
| --- | --- | --- | --- |
| `cards[].version` | 本地 data.json | 每次卡片写入 +1（既有语义） | 本地 HTTP 乐观锁（01-data-model §3） |
| `meta.revision` | 本地 data.json | 每次 Store 写入 +1（既有语义） | 本地 SSE 广播；**不上云**，仅用于判断「本地是否变化」 |
| `sync_meta.revision` | D1 单行 | 每次成功 push +1 | 云端增量水位：pull 用 `(since, until]` 窗口；push 用 `baseRevision` CAS |

**关键点**：云端 revision 不是「实体版本」，而是**批次水位**——同一 push 写入的所有行共享同一个 revision。客户端只需记住「最后一次成功 push 的云端 revision」（`baseRevision`）与「上次推送后的本地快照」，即可算增量。

### 5.2 push 的 CAS 提交算法（C2 必须按此顺序）

1. 读 `sync_meta`：`serverRevision = revision`、`serverEpoch = epoch`；
2. 若请求带 `epoch` 且 ≠ `serverEpoch` → `409 SYNC_EPOCH_MISMATCH`（云端被重建，客户端应全量重建）；
3. 若请求 `pushId` == `last_push_id` → 直接 `200 {status:"duplicate", revision:last_push_revision}`（响应丢失的安全重放：CAS 与 upsert 在同一个 batch，提交即完整）；
4. `newRevision = serverRevision + 1`；
5. 同一个 `env.DB.batch()`（D1 保证 batch 为事务）按「board → card → activity → tombstone → CAS」顺序写入，所有行 `revision = newRevision`；
6. **最后一条**做 CAS 提交（原子闸门）：

```sql
UPDATE sync_meta
   SET revision = ?newRevision,
       last_push_id = ?pushId,
       last_push_at = ?now,
       last_push_revision = ?newRevision,
       last_client_id = ?clientId,
       updated_at = ?now
 WHERE id = 1 AND revision = ?baseRevision;
```

7. 检查该语句的 `meta.changes`：`1` → 200 `applied`；`0` → 并发写者抢先（单写者假设外的异常）→ 409 `REVISION_CONFLICT`，客户端 pull 后重算重试（幂等，可自愈）。
8. **空 delta 不分配 revision**，直接 200 `{status:"noop"}`，避免版本空转。

> **C2 实施回写（2026-11）**：C2 在 `planPush` 之前先做 epoch 校验（§5.2 第 2 步优先于空 delta 判定），
> 且空 delta 的 `noop` 仍校验 `baseRevision === 云端 revision`（否则 409 `REVISION_CONFLICT`），
> 这样「空增量期间云端 epoch 变化/被其他写者推进」不会被 noop 掩盖。
> 特例：`reset:true` + 空 delta 视为**一次真实写入**（清空镜像），必须分配 revision 并返回 `applied`，
> 否则客户端无法表达「用空快照清空云端旧镜像」（契约 §6.3 reset 语义）。

行级防回退（卡片）：

```sql
INSERT INTO cards (id, board_id, title, status, priority, project, external_ref,
                   parent_card_id, version, archived, created_at, updated_at,
                   completed_at, revision, payload, synced_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
ON CONFLICT (id) DO UPDATE SET
  board_id = excluded.board_id, title = excluded.title, status = excluded.status,
  priority = excluded.priority, project = excluded.project, external_ref = excluded.external_ref,
  parent_card_id = excluded.parent_card_id, version = excluded.version,
  archived = excluded.archived, updated_at = excluded.updated_at,
  completed_at = excluded.completed_at, revision = excluded.revision,
  payload = excluded.payload, synced_at = excluded.synced_at
WHERE excluded.version >= cards.version;
```

### 5.3 冲突处理矩阵（C3 客户端侧）

| 响应 | 含义 | 客户端动作 |
| --- | --- | --- |
| `200 applied` | 已提交 | 记录 `revision` 为新 `baseRevision`；本地快照更新为「已推送镜像」 |
| `200 noop` | 空增量 | 不更新镜像；仅刷新节流时间 |
| `200 duplicate` | 重试但上一轮已提交 | 同 applied：把 `baseRevision` 更新为响应 `revision` |
| `409 REVISION_CONFLICT` | `baseRevision` 落后于云端 | `GET /v1/sync/pull` 追平（见 §6.2）→ 用本地权威状态重算 delta → 重试；**绝不覆盖本地状态** |
| `409 SYNC_EPOCH_MISMATCH` | 云端重建（epoch 变化） | 丢弃本地「已推送镜像」，以本地当前全量快照做一次 `reset:true` 推送（见 §6.3） |
| `401` | 令牌错误 | 停止重试并提示用户修 `cloud-config.json` |
| `413 / 429 / 5xx / 网络错误` | 瞬时失败 | 指数退避（1s→60s，含抖动）重试；本地写入不受影响 |

### 5.4 单写者假设与多客户端

- 约定**同一时刻只有一个本地守护器**在 push（一台 Mac、一个插件实例）。多客户端写属于非目标；即便两个客户端并发 push，DTO 层面也只是行级 last-write-wins + 一次 409 重试，不会损坏数据，但可能丢一次更新。
- 所有重试必须复用同一个 `pushId`（`hashPushId({clientId, baseRevision, delta})` 生成）；只要 delta 不变，重试就是幂等的。

### 5.5 pull 窗口冻结

- 客户端首次请求 `GET /v1/sync/pull?since=<baseRevision>`，响应带 `until`（= 查询时的服务端 revision）。
- 后续分页必须**原样回传 `until` 与 `cursor`**；服务端只返回 `(since, until]` 内的行。这样分页期间的新写入不会造成漏行/重复行。
- 全部分页读完（`hasMore=false`）后，客户端把 `since` 推进到 `until`。

---

## 6. 增量同步协议

### 6.1 通用约定

- Base URL：本地 `cloud-config.json` 的 `workerUrl` + `/v1`（如 `https://dsh-kanban-sync.<account>.workers.dev/v1`）。
- 请求/响应均为 `application/json; charset=utf-8`，体积上限 256 KiB（`CLOUD_SYNC_LIMITS.pushBytes`）。
- 所有请求/响应携带 `protocolVersion: 1`（缺省视为 1，异版本 `400 UNSUPPORTED_PROTOCOL_VERSION`）。
- 错误信封（与本地 HTTP API 风格对齐）：

```json
{ "ok": false, "error": { "code": "REVISION_CONFLICT", "message": "…", "details": {} }, "requestId": "…" }
```

- 成功信封统一 `{"ok": true, …}`；`requestId` 用于 Cloudflare 日志定位。

### 6.2 `GET /v1/sync/pull` —— 拉取状态镜像增量

请求头：`Authorization: Bearer <token>`。

| Query | 必填 | 说明 |
| --- | --- | --- |
| `since` | 否 | 起始 revision（不含），默认 0（全量快照） |
| `until` | 否 | 窗口上界（含），缺省取服务端当前 revision；分页时原样回传 |
| `limit` | 否 | 每类实体每页行数，默认/上限 `200` |
| `cursor` | 否 | 不透明游标，由上一页响应给出；对应 SQL 键集 `(revision, id)` |

响应示例：

```json
{
  "ok": true,
  "protocolVersion": 1,
  "epoch": "8f3a1c2d5e6b7a90",
  "since": 12,
  "until": 18,
  "revision": 18,
  "boards": [],
  "cards": [{ "id": "card-aaaa0001", "boardId": "board-default", "title": "…", "version": 7 }],
  "activities": [],
  "tombstones": [{ "entity": "activity", "entityId": "ev-00009999", "deletedAt": 1790000000000, "revision": 16 }],
  "hasMore": true,
  "cursors": { "cards": "eyJyIjoxNSwiaSI6ImNhcmQtYWFhYTAwMDEifQ" }
}
```

分页 SQL（C2 实现）：

```sql
SELECT … FROM cards
 WHERE revision > :since AND revision <= :until
   AND (revision > :cursorRevision OR (revision = :cursorRevision AND id > :cursorId))
 ORDER BY revision, id
 LIMIT :limit;
```

说明：
- `cursors` 按实体分组；某类实体本页已取尽则不再返回其游标。`hasMore=true` 时客户端继续请求，直到 `hasMore=false`。
- `pull` 全程只读，不修改 `sync_meta`（除可选观测字段 `last_pull_at`）。
- 客户端将响应交给 `normalizePullRequest` / `pullResponseToDelta` / `applyDeltaToCloudSnapshot` 处理即可（协议层已覆盖窗口、游标与墓碑映射）。

> **C2 实施回写（2026-11，Worker 已实现）**：C2 采用**跨实体单一键集游标**——一次 pull 在同一 `until` 窗口内按
> `revision → 实体类别（board < card < activity < tombstone）→ id` 升序返回；`cursor` 仍是
> `encodeSyncCursor({revision, id})` 生成的不透明串（其中 `id` 带类别前缀，如 `2:card-xxxx`、`4:activity:ev-xxxx`），
> 客户端无需理解前缀、原样回传即可。`hasMore=true` 时响应中 `cursors` 的四个实体键同值（等价于同一个 `cursor`），
> 这样单个 `cursor` 查询参数即可表达四类实体的共同推进位置，不新增协议字段。
> 实现位置：`cloudflare/worker.mjs` 的 `buildPullStatements` / `mergePullRows`；覆盖用例见 `test/cloud-worker.test.mjs`。

### 6.3 `POST /v1/sync/push` —— 推送脱敏增量

请求体（字段名固定）：

```json
{
  "protocolVersion": 1,
  "clientId": "macbook-pro",
  "pushId": "push-3f2a…（32 位十六进制，hashPushId 生成）",
  "baseRevision": 12,
  "epoch": "8f3a1c2d5e6b7a90",
  "reset": false,
  "delta": {
    "boards":     { "upserts": [], "deletes": [] },
    "cards":      { "upserts": [], "deletes": [] },
    "activities": { "upserts": [], "deletes": [] }
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `clientId` | 是 | 本地配置的客户端标识（≤80 字符），写入 `sync_meta.last_client_id` |
| `pushId` | 是 | 幂等键；重试必须复用 |
| `baseRevision` | 是 | 客户端当前镜像的云端 revision（首次为 0） |
| `epoch` | 建议 | 客户端记录的上次响应 epoch；不匹配 → 409 全量重建 |
| `reset` | 否 | `true` 时 Worker 先清空镜像表（保留 `sync_meta` 与 `ingress_inbox`/`outbox`）再按全量 upsert，revision 继续递增；用于 `SYNC_EPOCH_MISMATCH` 后重建。`reset:true` 且 delta 为空时也会清空镜像并分配 revision（C2 实施回写） |
| `delta` | 是 | 见 §6.4；实体总数 ≤200，且 `assertValidDelta` 通过 |

响应：

```json
{ "ok": true, "status": "applied", "protocolVersion": 1, "epoch": "8f3a…", "baseRevision": 12,
  "revision": 13, "pushId": "push-3f2a…",
  "applied": { "boards": { "upserted": 0, "deleted": 0 },
               "cards": { "upserted": 1, "deleted": 0 },
               "activities": { "upserted": 2, "deleted": 1 } } }
```

`status` 取值：`applied`（已提交，`revision` = 新水位）、`duplicate`（pushId 已提交过，`revision` = 上次水位）、`noop`（空 delta，不分配 revision）。

### 6.4 delta 结构

- 实体按 `boards` / `cards` / `activities` 三组，每组 `{upserts: object[], deletes: string[]}`。
- `upserts` 的实体必须是**脱敏后的镜像对象**（§7），带 `id`；`deletes` 是实体 id 数组。
- 同一 id 不能同时出现在 upserts 与 deletes；同一数组内 id 不得重复（`assertValidDelta` 直接拒绝）。
- 写入顺序由 Worker 固定为 boards → cards → activities → tombstones；删除在 upsert 之后执行，保证同批「先建后删」不会误删。
- 分片：`chunkDelta(delta, 200)` 按实体顺序切片，每片一次独立 push（各自分配 revision）。C3 必须**串行**推送，每片成功后用响应 `revision` 作为下一片的 `baseRevision`。

### 6.5 端到端示例（curl）

```bash
TOKEN=$(jq -r .token ~/.dsh-kanban/cloud-config.json)
BASE=$(jq -r .workerUrl ~/.dsh-kanban/cloud-config.json)

# 1) 空库全量推送（首次同步）：payload 由 lib/cloud-sync-protocol.js 生成
curl -sS "$BASE/v1/sync/push" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d @push-001.json

# 2) 增量拉取（可反复用 cursor 翻页）
curl -sS "$BASE/v1/sync/pull?since=13&until=13" -H "Authorization: Bearer $TOKEN"

# 3) 领取入站事件并 ACK
curl -sS "$BASE/v1/inbox/claim" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"consumerId":"macbook-pro","limit":20,"leaseSeconds":120}'
curl -sS "$BASE/v1/inbox/ack" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"consumerId":"macbook-pro","results":[{"id":"in-…","outcome":"acked"}]}'
```

### 6.6 客户端推送状态机（C3）

```mermaid
%%{init: {"flowchart": {"curve": "linear", "htmlLabels": false, "nodeSpacing": 50, "rankSpacing": 60}}}%%
flowchart TB
  Idle["空闲"] -->|"Store 变更防抖 2s"| Diff["算增量 diff"]
  Diff -->|"空增量"| Idle
  Diff -->|"非空"| Push["push（带 baseRevision）"]
  Push -->|"200 applied/duplicate/noop"| Persist["更新本地镜像与 baseRevision"]
  Persist --> Idle
  Push -->|"409 revision"| Pull["pull 追平云端"]
  Pull --> Diff
  Push -->|"409 epoch"| Reset["全量 reset push"]
  Reset --> Persist
  Push -->|"网络/5xx/429"| Backoff["指数退避 1s→60s 抖动"]
  Backoff --> Push
```

节流与兜底（默认值，可在 `cloud-config.json` 调）：变更防抖 `pushDebounceMs=2000`；30s 定时兜底（`pullIntervalMs`）；单次 push 超时 10s；失败退避上限 60s。

### 6.7 大小限制汇总

| 限制 | 值 | 超限行为 |
| --- | --- | --- |
| push 实体总数 | 200 | `400 BAD_REQUEST`，客户端先 `chunkDelta` |
| push 请求体 | 256 KiB | `413 PAYLOAD_TOO_LARGE` |
| pull 每类每页行数 | 200（上限） | 服务端夹紧 |
| 入站请求体 | 128 KiB | 边缘 `413`，不入队 |
| 单条入站重试 | 20 次 | 置 `dead` 等待人工/告警 |
| 入站保留期 | 7 天 | 过期 Cron 清理 |
| 卡片时间线（云端） | 每卡最近 300 条 | 本地裁剪时由 diff 生成 delete + 墓碑 |
| 实体 id 长度 | 200 字符 | `400 BAD_REQUEST`（超长会破坏 pull 游标，C2 入口拦截） |
| ACK 单次结果条数 | 200 | `400 BAD_REQUEST`；服务端按 100 条/查询分块回查（D1 单查询绑定参数上限 100） |

---

## 7. 脱敏规则（严格白名单）

### 7.1 原则

1. **白名单而非黑名单**：云端对象由 `toCloudCard` / `toCloudBoard` / `toCloudActivity` 逐字段构造；本地新增字段默认**不上云**，必须显式加入 `CLOUD_CARD_FIELDS` 并补测。
2. **单向**：脱敏只发生在「本地 → 云端」方向，云端对象永不写回本地；`cwd` 等字段在云端不存在，也就无法被误恢复。
3. **确定性 + 幂等**：同一输入的脱敏结果稳定（不依赖当前时间/随机数），重复脱敏结果不变——这样 diff 才稳定、pushId 才可复用。
4. **纯函数**：协议层不读写文件/网络，便于单测穷举；C2/C3 只做 I/O 与编排。
5. **纵深防御**：C2 Worker 在写 D1 前会调用同一套 `toCloudBoard` / `toCloudCard` / `toCloudActivity` 对 upserts 再投影一次，即使 C3 漏做脱敏，`cwd` / `workspaceId` / `sessionIds` / `runtime` / `outbox` 等执行面字段也进不了 D1（复用同一实现，不引入第二套脱敏规则）。

### 7.2 卡片字段处理表

| 字段 | 上云形态 | 处理 |
| --- | --- | --- |
| `id` / `boardId` / `status` / `priority` / `version` / `order` / `parentCardId` / `dependsOn` / `mergedInto` | 原样 | 标识与关系字段 |
| `createdAt` / `updatedAt` / `startedAt` / `completedAt` / `archived` / `archivedAt` | 原样 | epoch ms / 布尔 |
| `title` / `summary` / `currentAction` / `result` | 文本清洗 | `redactText`（密钥、URL 凭据、home 路径） |
| `labels[]` | 文本清洗 | 同上 |
| `project` / `externalRef` | 原样 | 展示用；`externalRef` 形如 `github:owner/repo#42` |
| `agent` | `{name}` | 丢弃 `agent.id` |
| `progress` / `metadata` / `checklists` | 深度脱敏 | 文本清洗；checklist 保留 `id/text/done` |
| `approvals[]` | 深度脱敏 | 丢弃 `sessionId`、`requestedBy.id`、`resolvedBy.id`；保留题目/选项/结果/自定义回答（文本清洗） |
| `artifacts[]` | 深度脱敏 | `path` 走 `redactPath`（`/Users/<me>/…` → `~/…`）；`url` 文本清洗 |
| `handoff` | 深度脱敏 | 丢弃 `sessionId`、`by`；保留 `summary` / `nextSteps` / `at` |
| `cwd` / `workspaceId` / `sessionIds` / `runtime` / `outbox` / `autoStart` / `externalThreadId` | **剥离** | 本地执行面字段，见 `CLOUD_LOCAL_ONLY_CARD_FIELDS` |
| 其它任何字段 | **剥离** | 白名单外不出现 |

### 7.3 时间线节点处理

| 字段 | 处理 |
| --- | --- |
| `id` / `cardId` / `type` / `at` | 原样 |
| `actor` | 只保留 `{kind, name}`，丢弃 actor id |
| `text` | `redactText` |
| `data` | 先整体丢弃本地标识键（`sessionId` / `sessionIds` / `workspaceId` / `cwd` / `dataDir` / `superAgentSessionId` / `leaseToken` / `inboxId` / `clientId`），再深度脱敏；路径归一为 `~/…`，敏感键值替换为 `****` |

### 7.4 文本清洗规则（`redactText`）

| 类别 | 示例输入 | 输出 |
| --- | --- | --- |
| OpenAI/DeepSeek 风格 key | `sk-abcdefghijklmnop1234567890` | `sk-****` |
| GitHub token（PAT/OAuth/App） | `ghp_…` / `github_pat_…` | `gh-****` |
| Slack token | `xoxb-…` | `xox-****` |
| AWS Access Key | `AKIAIOSFODNN7EXAMPLE` | `AKIA****` |
| JWT | `eyJ….….…` | `eyJ****` |
| Bearer 头 | `Bearer abcdef…` | `Bearer ****` |
| URL 查询凭据 | `?access_token=…` / `?sign=…` / `?key=…` | `?access_token=****` |
| 赋值式密钥 | `password=…` / `token: …` / `secret=…` | `password=****` |
| 用户目录（macOS/Linux） | `/Users/alice/Desktop/dsh` | `~/Desktop/dsh` |
| 用户目录（Windows） | `C:\Users\alice\Desktop` | `~\Desktop` |

> 说明：`~` 只隐藏用户名，保留相对路径，便于云端仍能看懂「哪个仓/哪个工作副本」；这比整段删除更有用。若某路径本身包含敏感项目名，请把该项目名加入自定义脱敏词表（后续扩展点，本期不做）。

### 7.5 明确不上云的内容

- 代码仓内容、Git diff、worktree 绝对路径（路径文本会被归一为 `~`，但 worktree **文件**从不上云）。
- 量化进程、模型权重、日志文件、终端输出。
- DSH 会话 ID、工作区 ID、Super-Agent 会话 ID。
- 决策日志 `decisions.jsonl`。
- `cloud-config.json` / `im-config.json` 的令牌与 webhook secret。
- 入站事件的签名头、Authorization、Cookie、来源 IP（白名单头之外一律不入库）。

### 7.6 脱敏的验证方式

- 单测覆盖：密钥/URL/路径/敏感键/剥离字段/审批与交接/时间线 data/真实 seed 数据投影（`test/cloud-sync-protocol.test.mjs` 共 38 例）。
- 上线前人工抽检：`node -e` 用真实 `data.json` 调 `toCloudSnapshot`，人工浏览 `cards[].title/summary` 与 `activities[].text`，确认无个人敏感信息。

---

## 8. 入站暂存与零丢失回放

### 8.1 设计目标

Mac 合盖休眠时本地服务不可达。IM（钉钉/飞书/企微/微信 cc2im/OneBot）与 GitHub 的 Webhook 若直接指向本地会丢事件；指向 Cloudflare 后，Worker 24x7 接收、去重、持久化，Mac 唤醒后按顺序回放给本地 `handleIngressEvent`，保证「消息不丢、审批按钮点击不丢、GitHub Issue 不丢」。

### 8.2 `POST /v1/ingress/:provider` —— Webhook 暂存入口

- `provider` ∈ `github | feishu | dingtalk | wecom | onebot | weixin | generic`。
- **不走 Bearer**（Webhook 来源无法携带）；改为按来源校验：
  - GitHub：`X-Hub-Signature-256` HMAC-SHA256（secret 存 Worker secret `GITHUB_WEBHOOK_SECRET`），校验失败 `403 FORBIDDEN`（与 §10 错误码表一致；未配置 secret 时 `503 UNAVAILABLE`，fail-closed）；
  - 飞书：URL 验证 `challenge` 原样回 `200 {"challenge":…}`（不落库）；事件回调按 `token`/验签校验；
  - 钉钉：按加签（`timestamp` + `sign`）或机器人 access_token 校验；
  - 其它来源：`generic` 至少校验共享 token（自定义头），未配置时 C2 可显式关闭该来源。
- 请求体必须是 **JSON 对象**且 ≤128 KiB，否则 `415` / `413`（不入队，避免回放时本地解析失败）。
- 处理流程：校验 → 计算去重键 → `INSERT INTO ingress_inbox`（`dedupe_key` 唯一约束，重复投递直接命中已存在行）→ **立即返回 202**：`{"ok":true,"id":"in-…","seq":123}`。**不等待本地 Mac**。
- 顺序：以 `seq`（AUTOINCREMENT 到达序）为回放顺序，同一来源的连续事件保持到达顺序。

### 8.3 去重键

- 优先使用来源的投递 id：`github:delivery:<X-GitHub-Delivery>`、`dingtalk:delivery:<delivery-id>`、`feishu:delivery:<x-request-id>` 等；
- 缺失时退化为「provider + 事件类型 + 原始体」的 sha256：`<provider>:body:<hash>`；
- **generic 系（generic/wecom/onebot/weixin）不把通用 `x-request-id` 当投递 id**：该头常被上游网关/反代复用为链路追踪 id，若用于去重会把不同事件误判重丢弃；C2 对这几个来源剔除该头，只在 JSON body 显式提供 `deliveryId` 时才按投递 id 去重（github/feishu/dingtalk 仍用各自专用头）；
- 事件 id = `in-` + sha256(dedupeKey) 前 16 位（确定性，便于客户端幂等）；
- 语义：**至少一次投递 + 本地幂等消费**。Webhook 重试不会产生重复事件；若同一请求体被不同来源重发（例如 GitHub 重投但 delivery id 变了），会作为新事件入队，本地 `handleIngressEvent` 的既有幂等逻辑（如审批已 resolved、Issue 已存在）负责兜底。

### 8.4 `POST /v1/inbox/claim` —— 领取待回放事件（Bearer）

请求：`{"consumerId":"macbook-pro","limit":20,"leaseSeconds":120}`；`limit` 夹紧到 `[1,20]`，`leaseSeconds` 夹紧到 `[30,900]`。

响应：

```json
{ "ok": true, "items": [
  { "seq": 123, "id": "in-…", "provider": "github", "eventType": "issues",
    "deliveryId": "d-1", "headers": { "x-github-event": "issues" },
    "payload": "{\"action\":\"opened\",…}", "attempts": 0, "receivedAt": 179…,
    "leaseToken": "lease-…", "leaseExpiresAt": 179… }
] }
```

- 只领取 `status='pending' AND next_attempt_at <= now` 或**租约已过期**（`status='leased' AND lease_expires_at < now`）的条目，按 `seq` 升序；
- 领取即写 `status='leased'`、`lease_token`、`lease_expires_at`；同一租约内重复领取不会重复下发（客户端用完即 ack）；
- 本地崩溃/断网时租约到期，条目自动可被下一次 claim 重新领取（服务端不做「认领即消费」）。

### 8.5 本地回放与 `POST /v1/inbox/ack`（Bearer）

本地消费者（C3）对每个 item：

1. `buildLocalIngressRequest(item)` → `POST http://127.0.0.1:<看板端口>/api/kanban/ingress`，请求体为原始 payload 文本；GitHub 事件透传 `x-github-event`；
2. 本地返回 2xx → 视为成功；本地 4xx（业务性拒绝，如载荷不合法）→ 视为**不可重试失败**，直接 ack 为 `dead` 并记录原因，避免死循环；本地 5xx/网络错误 → 可重试失败；
3. 汇总结果调用 ACK：

```json
{ "consumerId": "macbook-pro",
  "results": [
    { "id": "in-…", "outcome": "acked" },
    { "id": "in-…", "outcome": "retry", "error": "本地 502" }
  ] }
```

响应：`{"ok":true,"acked":[…],"retried":[…],"dead":[…],"missing":[…],"ignored":[…]}`。

> **C2 实施回写（2026-11）**：`results` 单次上限 200 条（超限 `400`），服务端按 90 条/查询分块回查
> （D1 单查询最多 100 个绑定参数，取 90 留余量；更新语句按 50 条/batch 分批提交）。
> ACK 加状态机守卫：只有 `pending|leased` 的条目会被更新；已 `acked/dead` 的终态条目收到迟到 ACK 时
> 不做任何状态迁移，返回在 `ignored` 中（契约 §8.6 没有「复活」边）。
> `results[]` 可**可选**携带 claim 返回的 `leaseToken`，服务端校验租约持有者（不匹配计入 `ignored`）；
> 不带时仅做状态守卫。`missing` 表示 id 不存在，可安全忽略。

- `outcome=acked` → `status='acked'`, `acked_at=now`；
- `outcome=retry` → `attempts+1`，按 `ingressBackoffMs` 指数退避重排（首次 2s，4s、8s…上限 5min），达到 `max_attempts=20` 置 `dead`；
- `outcome=dead` → 直接置 `dead`（业务性不可重试）；
- 超过 `expires_at`（7 天）仍未消费的条目由 Cron 清理，不再回放。

### 8.6 ingress_inbox 状态机

```mermaid
%%{init: {"flowchart": {"curve": "linear", "htmlLabels": false, "nodeSpacing": 45, "rankSpacing": 55}}}%%
stateDiagram-v2
  [*] --> pending: Webhook 入队
  pending --> leased: claim 成功
  leased --> acked: 本地 2xx + ack
  leased --> pending: 失败退避重排
  leased --> dead: 达到上限或业务性失败
  pending --> dead: 达到 max_attempts
  acked --> [*]: 保留 7 天后清理
  dead --> [*]: 人工处理后清理
```

### 8.7 本地回放去重的双保险

- 云端：`dedupe_key` 唯一 + 事件 id 确定性；
- 本地：`handleIngressEvent` 既有幂等逻辑（审批按钮重复点击 → 已 resolved 返回冲突；GitHub Issue 重复事件 → 按 `externalRef` 找到既有卡片；飞书 challenge 直接回 challenge 不入库）；
- C3 在 ACK 前若本地返回「已处理过」类 4xx，应按 `acked` 处理（标记已消费），不要无限重试。

### 8.8 出站 `outbox`（与本地 outbox 的区别）

| | 本地 `data.json.outbox` | 云侧 `outbox` 表 |
| --- | --- | --- |
| 生产者 | 本地看板（watchdog / ingress 处理） | Cloudflare Worker（可选，C2 决定是否启用） |
| 消费者 | 本地 DSH 会话（agent 唤醒指令） | 本地守护器或下游通知（IM/邮件） |
| 状态机 | `pending/leased/acked/failed/expired` | `pending/leased/delivered/failed/expired` |
| 用途 | 唤醒/催促/审批回执 | 云→本地的可靠通知（如休眠期入站唤醒、状态变更推送） |

> 两者**不可混用**。C1 只定义云侧 `outbox` 表结构与投递语义（幂等键、租约、退避、过期），是否在 C2 启用由 C2 决定；最小可用实现可以只用 `ingress_inbox`。

---

## 9. 部署与运维（C2 参考）

### 9.1 首次部署清单

1. `wrangler d1 create dsh-kanban-sync` → 把 `database_id` 写入 `cloudflare/wrangler.toml`（C2 产物）；
2. `wrangler d1 migrations apply dsh-kanban-sync --migrations-dir cloudflare/migrations --remote`；
3. `wrangler secret put CLOUD_SYNC_TOKEN`（随机 32+ 字节；`openssl rand -hex 32`）；
4. 按需 `wrangler secret put GITHUB_WEBHOOK_SECRET` / 飞书、钉钉校验 secret；
5. `wrangler deploy`；
6. 本地写 `~/.dsh-kanban/cloud-config.json`（见附录 A，`chmod 600`）；
7. 用附录 B 的 curl 冒烟：push → pull → 查 `ingress_inbox`。

### 9.2 迁移与兼容

- 协议版本变更：新增 `protocolVersion` 值，Worker 对旧版本返回 `400` 并在日志标注；本地升级前先部署 Worker。
- Schema 变更：新增 `0002_*.sql`，只做加法（加列/加表/加索引），不做破坏性改名；`sync_meta.schema_version` 递增。
- Epoch：D1 库重建（删除后重建）会导致 `epoch` 变化，本地收到 `409 SYNC_EPOCH_MISMATCH` 后全量 reset，无需人工清数据。

### 9.3 备份与恢复

- 备份：`wrangler d1 export dsh-kanban-sync --remote --output backup-<date>.sql`（定期导出；镜像数据可丢，入站队列在非空时导出）。
- 恢复：重建库 → 执行 migration → `wrangler d1 execute … --file backup.sql`；本地以 `reset:true` 全量重推即可重建镜像。
- 注意：D1 镜像**不是**看板主数据，真正的灾备仍以本地 `data.json` 为主；本能力提供的是「异地只读视图 + 入站暂存」。

### 9.4 监控与告警（建议）

| 指标 | 阈值 | 动作 |
| --- | --- | --- |
| `ingress_inbox` pending 数 | > 100 或最老条目 > 30min | 提示本地守护器未运行 |
| `ingress_inbox` dead 数 | > 0 | 人工查看 `last_error` 后重置/丢弃 |
| 最近 push 时间 | > 10min（本地开启时） | 检查 Worker/网络/令牌 |
| 5xx 比例 | > 1% | 查 Worker 日志与 D1 配额 |
| D1 存储 | 接近免费额度 | 缩短 activities 保留期/清理队列 |

> 免费额度数字随 Cloudflare 政策变化，本契约不写死具体配额；以控制台为准，并在 README 标注「个人量级够用」。

### 9.5 安全注意事项

- Worker 只开 `/v1/*`，不托管静态资源；CORS 默认关闭（只有本地守护器调用，不需要浏览器跨域）。
- 状态面全部 Bearer；ingress 面只允许来源签名（或显式关闭）。
- 不记录请求体全文日志（可能含 IM 消息内容）；只记 `id/seq/provider/status/attempts`。
- token 泄露时立即 rotate；`reset:true` 之前先确认云端无他人数据（单租户默认无）。

---

## 10. 错误码表

| code | HTTP | 触发 | 客户端处理 |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 | 参数/结构非法（delta 形状、游标、provider 不支持） | 修正后重试；不自动重试 |
| `UNAUTHORIZED` | 401 | 缺 Bearer / token 不匹配 | 停止并提示修配置 |
| `FORBIDDEN` | 403 | 来源签名校验失败（ingress） | Webhook 侧重发/修 secret |
| `NOT_FOUND` | 404 | 未知路由（C2 路由层补充） | 检查 `workerUrl` 与协议版本 |
| `METHOD_NOT_ALLOWED` | 405 | 方法不匹配（C2 路由层补充，`details.allowed` 给出允许方法） | 修正请求方法 |
| `REVISION_CONFLICT` | 409 | `baseRevision` ≠ 云端 revision | pull 追平 → 重算 delta → 重试 |
| `SYNC_EPOCH_MISMATCH` | 409 | 客户端 epoch ≠ 云端 epoch | 全量 reset push |
| `UNSUPPORTED_PROTOCOL_VERSION` | 400 | `protocolVersion` 非 1 | 升级客户端/Worker |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 入站体非 JSON 对象 | 来源侧修正；不入队 |
| `PAYLOAD_TOO_LARGE` | 413 | push > 256 KiB / 入站 > 128 KiB | 分片或减小载荷 |
| `RATE_LIMITED` | 429 | 突发流量 | 指数退避 |
| `INTERNAL` | 500 | 未预期异常（响应不含堆栈） | 退避重试 |
| `UNAVAILABLE` | 503 | Worker 未配置 token / D1 不可用 | 停止或退避，提示检查部署 |
| `BAD_CONFIG` | — | 本地 `cloud-config.json` 非法（不产生请求） | 修配置后重启插件 |

---

## 11. 验收标准与下游交接

### 11.1 C1 验收（本卡）

- [x] `cloudflare/migrations/0001_kanban_sync.sql` 可在 SQLite 无错执行、重复执行幂等、含 5 张必需表 + 2 张辅助表与全部索引。
- [x] `lib/cloud-sync-protocol.js` 导出快照脱敏 / diff / revision 冲突 / Bearer / ingress 信封 / 配置校验等纯函数。
- [x] `test/cloud-sync-protocol.test.mjs` 38 例全绿；全仓 `npm test` 全绿。
- [x] 本文档冻结行为边界、表结构、鉴权、乐观锁、协议、脱敏、入站回放与错误码。

### 11.2 C2（Worker）实施清单（已由 C2 卡完成，产物在 `cloudflare/`）

- [x] `cloudflare/wrangler.toml` + `cloudflare/worker.mjs`：实现 §6.2 `/v1/sync/pull`、§6.3 `/v1/sync/push`（严格按 §5.2 CAS 顺序）、§8.2 `/v1/ingress/:provider`、§8.4 `/v1/inbox/claim`、§8.5 `/v1/inbox/ack`。
- [x] 直接复用 `lib/cloud-sync-protocol.js` 的 `verifyBearer` / `planPush` / `assertValidDelta` / `normalizeIngressEnvelope` / `normalizePullRequest` / `encodeSyncCursor` / `toCloud*`；未手写第二套脱敏。
- [x] 入站签名校验（GitHub HMAC / 飞书 token 与 `X-Lark-Signature` / 钉钉加签或 access_token / generic 共享 token）与飞书 challenge 直通。
- [x] D1 batch 写库 + revision CAS；Cron 清理（`scheduled`）；错误响应统一走 `toErrorResponse`。
- [x] 部署文档 + 冒烟 curl（[`cloudflare/README.md`](../../cloudflare/README.md)）+ 免费额度说明；端到端单测 [`test/cloud-worker.test.mjs`](../../test/cloud-worker.test.mjs)（内存 SQLite 模拟 D1，68 例）。
- [x] 独立复核（对抗性验证）后的加固：ACK 200 条分块回查（D1 绑定参数上限）、push 多行 upsert（单批 SQL ≤50 条）、
      reset+空 delta 语义、空 delta 的 epoch/revision 校验、ACK 终态守卫 + `ignored`、实体 id 200 字符上限、
      generic 系不把 `x-request-id` 当投递 id、claim/ack/错误响应补 `protocolVersion` 与 `x-request-id` 头。
- [ ] 云侧 `outbox` 生产启用（C2 决定暂不启用，表与清理逻辑已就绪，见 §8.8）。
- [ ] 飞书加密事件（`body.encrypt`）解密：当前在边缘 415 拒绝，需要时另卡实现。

### 11.3 C3（本地守护器）实施清单（已由 C3 卡完成，产物在 `lib/cloud-sync-client.js`）

- [x] 读取并校验 `~/.dsh-kanban/cloud-config.json`（`normalizeCloudConfig`；`0600` 权限检查；缺失/关闭/非法均静默降级且零网络，读取函数 `readCloudConfig`）。
- [x] Store 变更监听：`toCloudSnapshot` → `diffCloudSnapshots` → `chunkDelta` → 串行 push；维护 `baseRevision` 与已推送镜像（内存 + 启动时 pull 分页重建）。
- [x] 409/网络错误处理严格按 §5.3；`SYNC_EPOCH_MISMATCH` 走 `reset:true`（reset 请求不带旧 epoch，见 §11.5.5）。
- [x] 入站：claim → `buildLocalIngressRequest` → 本地 ingress → ACK；本地 2xx=acked、已处理类 4xx=acked、其它 4xx=dead、5xx/网络=retry（服务端 `nextIngressAttempt` 退避，20 次后 dead）。
- [x] 本地状态不因云端响应而改变（除「已推送镜像」缓存）；状态接口 `GET /api/kanban/cloud/status` 只读暴露同步/回放状态，令牌仅掩码。
- [x] 离线可运行：云端不可达时本地看板功能零影响（只记日志 + 指数退避），未配置 `cloud-config.json` 时不建定时器、不发任何网络请求。
- [x] 端到端验收（`test/cloud-sync-client.test.mjs` 25 例，真实 Worker + 真实迁移 SQL + 内存 D1 + 真实本地 HTTP 路由）：**本地离线期间云端暂存 IM 任务 → 本地恢复自动 claim/回放建卡 → ACK → 状态双端镜像一致**；另覆盖 409 revision 自愈、云端 D1 重建 reset 自愈、401 停止重试、退避增长、413 深度二分重推、>200 实体 pull 分页、防抖合并、唤醒探测、sync/ingress 子开关、ACK 丢失补发不重复回放、本地回放限回环与静默降级。

### 11.4 协议层导出索引（C2/C3 直接引用）

| 分组 | 函数 |
| --- | --- |
| 快照/脱敏 | `toCloudSnapshot` `toCloudBoard` `toCloudCard` `toCloudActivity` `redactText` `redactPath` `redactDeep` `sanitizeActivityData` |
| 增量 | `diffCloudSnapshots` `countDelta` `isEmptyDelta` `chunkDelta` `assertValidDelta` `applyDeltaToCloudSnapshot` `pullResponseToDelta` `stableStringify` |
| 乐观锁 | `detectRevisionConflict` `planPush` `nextCloudRevision` `hashPushId` |
| pull 分页 | `normalizePullRequest` `encodeSyncCursor` `decodeSyncCursor` |
| 鉴权 | `parseBearerToken` `constantTimeEqual` `verifyBearer` `assertAuthorized` |
| 入站 | `normalizeIngressEnvelope` `ingressDedupeKey` `makeIngressId` `filterIngressHeaders` `buildLocalIngressRequest` `ingressBackoffMs` `nextIngressAttempt` `isIngressExpired` |
| 配置/错误 | `normalizeCloudConfig` `maskToken` `describeCloudConfig` `CloudSyncError` `toErrorResponse` `assertProtocolVersion` |

> C3 守护器自身的可复用导出（不属于协议层）：`lib/cloud-sync-client.js` 的 `createCloudSyncClient` / `readCloudConfig` / `cloudConfigPath` / `cloudRetryDelay` / `classifyLocalIngressResponse` / `CLOUD_STATUS_PATH` / `CLOUD_SYNC_DEFAULT_TIMING`。

### 11.5 C3 实施回写（本地守护器，2026-11）

**产物与接线**

- `lib/cloud-sync-client.js`：`createCloudSyncClient`（push / pull / ingress 三条后台循环 + 状态机 + 退避调度）；构造零 I/O，只有 `start()` 在配置就绪后才建定时器与发请求。
- `lib/index.js`：插件启动时创建守护器并交给 `ctx.effect` 管理启停；`config.cloudSync:false` 可完全关闭，`config.cloudSync:{...}` 可覆盖客户端选项（测试/高级用法）。
- `lib/routes.js`：新增 `GET /api/kanban/cloud/status`（§11.5.9）；未挂载守护器时也返回 200 + `enabled:false`。
- 测试：`test/cloud-sync-client.test.mjs`（25 例，含端到端验收）+ `test/index.test.mjs`（+2 例挂载/静默降级）+ `test/cloud-worker-harness.mjs`（把 C2 的内存 D1 测试底座抽出共享，C2 单测同步改为复用，语义不变）。

**实施口径补全（本文其余章节未覆盖的部分）**

1. **配置读取三态静默降级**：`readCloudConfig` 返回 `missing | disabled | invalid | ready`；前三种状态**零定时器、零网络**，只记一条日志，状态接口可查原因。`invalid` 包括：JSON 非法、`normalizeCloudConfig` 校验失败、POSIX 下权限不是 `0600`（含 group/other 位即拒绝启用，避免令牌被同机其它用户读取）。配置只在 `start()` 读取一次，修改后需重启插件（与 §4.2 轮换说明一致）。
2. **本地看板地址发现（不新增配置字段）**：守护器读 `<dataDir>/runtime-endpoint.json` 的 `origin`（看板服务在客户端请求时自动写入），缺失时回退 `http://127.0.0.1:4599`；构造选项 `localOrigin` / `setLocalOrigin()` 可显式覆盖（测试与多实例场景）。本地回放仍走本地 HTTP 路由 `/api/kanban/ingress`（复用 `handleIngressEvent` 的业务幂等，不在守护器里二次实现建卡/审批逻辑）。
3. **冷启动顺序**：先 `GET /v1/sync/pull?since=0` 分页重建「已推送镜像」（冻结 `until` + 原样回传 `cursor`，硬上限 10000 页 ≈ 200 万实体，触顶报可诊断错误），再 diff 本地权威快照推送；pull 结果只进内存镜像，不写本地 `data.json`。
4. **push 响应语义**：只有 `applied` / `duplicate` 更新镜像与 `baseRevision`；`noop` 只刷新节流时间，**不覆盖**「上一次真正推送」的状态字段；`413 PAYLOAD_TOO_LARGE` 时按实体二分重推，最多 8 层（200 实体 → 100 → 50 → 25 → 13 → 7 → 4 → 2 → 1），每片独立分配 revision、串行推进 `baseRevision`，语义不变；拆到单实体仍超 256 KiB 时停止自动重试（`haltedCode=PAYLOAD_TOO_LARGE`，状态接口带可操作提示，等人工处理异常巨大的卡片/时间线字段）；`400/404` 等业务性错误不自动重试（等下一次本地变更或人工处理）。
5. **epoch 重建的 reset 细节（对 §5.2/§6.3 的必然推论）**：Worker 的 epoch 校验先于一切写操作，**带旧 epoch 的 reset 请求也会被 409 拒绝**。因此客户端收到 `SYNC_EPOCH_MISMATCH` 后，用 409 `details.serverRevision` 作为新 `baseRevision`，并且 reset 请求**不携带旧 epoch**；拿不到 `details` 时先 pull 一次（pull 不携带 epoch，可安全使用）再 reset。
6. **退避策略**：`429 / 5xx / 网络错误` 指数退避（1s→60s，±20% 抖动，纯函数 `cloudRetryDelay`）；`401` 立即停止重试并置 `paused`（状态接口暴露 `pauseReason:"unauthorized"`，提示修 `cloud-config.json` 后重启）；业务性错误不自动重试。
7. **唤醒/重连探测**：Node 定时器在合盖休眠期间不累积触发，唤醒后第一次 tick 的实际间隔会明显拉长。守护器在每次定时 tick 记录时刻，若实际间隔 > `2 × 配置间隔 + 5s` 即视为唤醒/重连：清空退避并立即 push + claim；也提供 `handleWake()` 供宿主/测试手动触发。启动时以启动时刻初始化该基准，避免「启动后、首次 tick 前休眠」漏判。
8. **入站消费结果映射**：本地 2xx → `acked`；本地 JSON 错误信封的 `CONFLICT / CARD_NOT_FOUND / APPROVAL_NOT_FOUND / NOT_FOUND / ALREADY_RESOLVED` → 按 `acked` 收口（§8.7「已处理过类 4xx」）；其它 4xx（含非 JSON 响应）→ `dead`；5xx/网络/超时 → `retry`。ACK 结果携带 claim 返回的 `leaseToken`（服务端租约守卫）。
9. **本地状态接口**：`GET /api/kanban/cloud/status`（与其它本地 API 同源，只读）返回：
   ```json
   { "ok": true, "revision": 1234,
     "cloud": { "enabled": true, "configured": true, "running": true, "paused": false, "phase": "idle",
                "configStatus": "ready", "config": { "workerUrl": "…", "clientId": "…", "token": "abcd****wxyz", "sync": {}, "ingress": {} },
                "baseRevision": 18, "epoch": "…", "lastSyncAt": 0, "lastWakeAt": 0,
                "sync": { "pending": false, "lastPushAt": 0, "lastPushStatus": "applied", "lastPushEntities": 2,
                          "lastPullAt": 0, "consecutiveFailures": 0, "nextRetryAt": 0, "lastError": null },
                "ingress": { "enabled": true, "lastClaimAt": 0, "lastClaimed": 0, "acked": 0, "retried": 0, "dead": 0,
                             "lastAckAt": 0, "lastAckIgnored": 0, "consecutiveFailures": 0, "nextRetryAt": 0, "lastError": null },
                "haltedCode": "" } }
   ```
   令牌只以 `describeCloudConfig` 掩码出现；未配置/已关闭时返回 `configStatus:"missing"|"disabled"` 与 `enabled:false`。
10. **零网络保证**：未配置 / `enabled:false` / 配置非法时，`start()` 只读一次配置文件即返回，不创建任何定时器；测试通过替换 `fetch` 计数断言 0 次外部请求（`test/index.test.mjs`）。
11. **测试底座复用**：C3 端到端测试不 mock SQL——使用真实 `cloudflare/worker.mjs` + 真实迁移 SQL + `node:sqlite` 内存 D1（与 C2 共用 `test/cloud-worker-harness.mjs`），本地看板起真实 HTTP 路由；因此「离线暂存 → 唤醒回放建卡 → ACK → 双端镜像一致」是端到端真实验证，而非桩验证。
12. **两个子开关的独立生效**：`sync.enabled:false` 只关闭状态镜像（不 pull/push、不建同步定时器），`ingress.enabled:false` 只关闭入站回放（不 claim），另一侧继续工作；两者都不影响本地看板。
13. **ACK 丢失的补发窗口**：本地消费成功但 `POST /v1/inbox/ack` 网络失败时，结果留在守护器内存，下一轮 claim **之前先补发 ACK**，避免租约到期后云端重发导致重复回放（IM 文本任务在本地业务层不是天然幂等的）；进程崩溃时该内存丢失，仍由「至少一次投递 + 本地幂等逻辑」兜底，属于契约 §8.7 的已知窗口。
14. **本地回放目标限回环**：`runtime-endpoint.json` 与 `localOrigin` 只接受 `http(s)://127.0.0.1 | localhost | ::1`，否则按「本地地址未知」重试——防止被篡改的端点文件把云端暂存的入站载荷（可能含 IM 消息内容）POST 到任意远端。
15. **stop 语义（守护器停止不拖住插件卸载）**：`stop()` 置停止标志后，claim 批次在**每一条之前**检查标志，不再为剩余条目新建本地回放请求；已消费（含被中断后判定为 retry）的结果仍补发一次 ACK，未消费条目保持租约、到期后由下一次启动重新 claim。停止时先给当前在途条目最多 `stopClaimGraceMs=2.5s` 收尾宽限，再中止在途 HTTP 请求；残留 ACK 补发最多等 `stopFlushAckMs=2s`，随后再次中止全部在途请求，保证进程/插件卸载时没有挂起连接。因此 `stop()` 既不会被 `20 × 请求超时` 拖住，也不会被云端 ACK 网络黑洞拖到单次请求超时。

---

## 12. 待定与后续卡

1. **入站来源 IP 与安全**：是否需要 IP 白名单/Cloudflare WAF（C2 评估）。
2. **多端只读视图**：手机端如何鉴权查看镜像（当前只有单 Bearer，浏览器跨域未开放）。
3. **云侧 outbox 是否启用**：若启用，通知模板与重试策略需单独评审。
4. **脱敏自定义词表**：路径中的项目名是否需要额外打码（本期只隐藏用户名）。
5. **决策日志镜像**：暂不做，若需要另卡设计（只追加、体积大）。

---

## 13. 远程 Streamable HTTP MCP 控制面（`/v1/mcp`）

为支持运行在远端容器/沙箱中的个人 AI Agent（如 Antigravity 远端会话、Claude / Cursor Remote MCP）在不穿透本地内网、且 MacBook 合盖休眠期间也能安全读写看板卡片，Worker 在同一套单写者契约之上暴露 MCP Streamable HTTP（`2025-06-18` / `2025-03-26` / `2024-11-05`）端点 `POST /v1/mcp`（别名 `POST /mcp`）：

1. **读写职责严格遵守单写者边界（零 D1 结构迁移）**：
   - **只读工具直查 D1 镜像**（`kanban_boards`、`kanban_cards`、`kanban_card`、`kanban_review_board`，以及 `kanban_merge_cards(dryRun:true)`、`kanban_archive_cards(dryRun:true)`）：即使本地 Mac 合盖休眠，云端 Agent 也可 7x24 秒级读取看板与卡片详情，响应额外附带 `pendingCloudWrites` 提示尚未被本地消费的离线写入条数。由于云端镜像已剥离 `cwd`，`kanban_review_board` 在云端自动屏蔽因缺 `cwd` 产生的假阳性 `orphans`。
   - **写入工具入队回放**（`kanban_create_card`、`kanban_update_card`、`kanban_move_card`、`kanban_add_activity`、`kanban_request_approval`、`kanban_complete_card`、`kanban_merge_cards`、`kanban_archive_cards`）：Worker **不直接修改** D1 的 `cards`/`boards`/`activities` 表，而是在边缘完成参数校验后以 `provider='generic', event_type='mcp_tool_call'` 写入既有 `ingress_inbox`。`kanban_create_card` 在边缘预分配确定性 `card-xxxxxxxx`（写入 `preferredCardId`），支持离线期连续串联 `create → move → update → complete`；待本地 Mac 在线后由 C3 守护器按 `seq` 升序 claim → 交由 `handleIngressEvent` 写入 `~/.dsh-kanban/data.json` → 再增量 push 回 D1，彻底杜绝双写冲突。
2. **开源与私有数据完全物理隔离**：
   - 代码仓（含开源发布后）仅包含通用代码与占位符 `database_id = "<REPLACE_WITH_D1_DATABASE_ID>"`，不含任何个人 Worker 域名、D1 数据库 ID 或密钥。
   - 每个部署者的数据仅存于其个人 Cloudflare 账号下的私有 D1 实例；`/v1/mcp` 在方法分发前强制执行常量时间 Bearer 校验（优先使用独立 Secret `MCP_BEARER_TOKEN`，未设置时回退 `CLOUD_SYNC_TOKEN`；两者均未配置时一律 `503 fail-closed`，缺/错令牌一律 `401`），外部第三方即使克隆开源仓库也无法连接或读取任何个人看板数据。
   - **双向执行面脱敏**：本地 → D1 方向由 `toCloudCard` 剥离 `cwd`、`workspaceId`、`sessionIds`、`runtime`；云端 MCP → 本地方向由 `sanitizeCloudMcpWriteArgs` 在 Worker 边缘与本地 `handleMcpToolIngress` 双重剥离 `cwd`、`workspaceId`、`sessionId(s)`、`sessionMode`、`waitCondition` 与 `artifact.path`，防止远端调用篡改本机目录或会话绑定。

---

## 附录 A：`~/.dsh-kanban/cloud-config.json` 示例

```json
{
  "version": 1,
  "enabled": true,
  "workerUrl": "https://dsh-kanban-sync.example.workers.dev",
  "token": "<与 Worker secret CLOUD_SYNC_TOKEN 相同，32+ 字节随机串>",
  "clientId": "macbook-pro",
  "sync": { "enabled": true, "pushDebounceMs": 2000, "pullIntervalMs": 30000 },
  "ingress": { "enabled": true, "claimIntervalMs": 30000, "batchSize": 20, "leaseSeconds": 120 }
}
```

- 文件权限必须 `0600`（`chmod 600 ~/.dsh-kanban/cloud-config.json`）。
- `enabled:false` 时 token/workerUrl 可为空；开启后两者必填，`workerUrl` 必须 `https`（`127.0.0.1/localhost` 调试例外）。
- 日志输出用 `describeCloudConfig`（令牌只显示 `abcd****wxyz`），禁止 `console.log(config)`。

## 附录 B：冒烟命令

```bash
BASE=$(jq -r .workerUrl ~/.dsh-kanban/cloud-config.json)
TOKEN=$(jq -r .token ~/.dsh-kanban/cloud-config.json)

# 未带令牌应为 401
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/sync/pull"

# 带令牌应为 200 + {ok:true, revision:0,…}
curl -s "$BASE/v1/sync/pull?since=0" -H "Authorization: Bearer $TOKEN" | jq .

# 模拟 GitHub Webhook（需 GITHUB_WEBHOOK_SECRET 已配置）
curl -s -X POST "$BASE/v1/ingress/github" \
  -H 'content-type: application/json' -H 'x-github-event: ping' \
  -d '{"zen":"Keep it logically awesome."}' | jq .
```

## 附录 C：单测覆盖点（`test/cloud-sync-protocol.test.mjs`）

1. 常量/白名单不变量；
2. 文本、路径、深度脱敏（含幂等与不可变）；
3. Board/Card/Activity 投影（执行面字段剥离、审批/交接/产物/时间线 data 处理、真实 seed 数据投影）；
4. 快照排序稳定与 revision 取值；
5. diff（新增/修改/删除/空增量/顶层 revision 无关）、delta 校验、分片、回放、端到端镜像一致；
6. revision 冲突检测、push 四态（noop/duplicate/conflict/apply）、pushId 确定性；
7. pull 窗口/游标编解码与边界；
8. Bearer 解析、常量时间比较、fail-closed；
9. 入站头白名单、去重键、信封、本地回放请求、退避与置 dead、过期；
10. `cloud-config.json` 校验、越界夹紧、令牌掩码；
11. 协议版本校验与统一错误响应。
