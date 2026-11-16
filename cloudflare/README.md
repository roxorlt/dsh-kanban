# dsh-kanban 云端控制面（C2/3）：Cloudflare Worker + D1 部署指引

> 契约： [`docs/contracts/08-cloud-sync.md`](../docs/contracts/08-cloud-sync.md)（C1 冻结）
> 协议层： [`lib/cloud-sync-protocol.js`](../lib/cloud-sync-protocol.js)（C1，C2/C3 共用）
> Schema： [`migrations/0001_kanban_sync.sql`](migrations/0001_kanban_sync.sql)
> 单测： [`test/cloud-worker.test.mjs`](../test/cloud-worker.test.mjs)（68 例，内存 SQLite 模拟 D1）

## 1. 它是什么 / 不是什么

**只做两件事**（Local-First，业务项目绝不上云）：

| 能力 | 说明 |
| --- | --- |
| 状态镜像（只读） | 本地看板把**脱敏后**的 boards/cards/activities 增量 push 到 D1；云端只能 pull 查看与灾备参照，**永不产生业务状态变更** |
| 入站暂存（24x7） | Mac 合盖休眠时，钉钉/飞书/企微/OneBot/微信桥/GitHub 的 Webhook 先由 Worker 验签并写 `ingress_inbox`、立即 202；唤醒后本地 claim → 回放 → ack，零丢失 |

**不做**：不跑代码/量化、不存代码仓与 worktree、不存 DSH 会话 ID、不做双向合并、不做多租户、不托管看板 UI、不镜像 `decisions.jsonl`。

```
本地 Mac（权威写者）                    Cloudflare（只读镜像 + 入站暂存）
┌──────────────────┐   push 脱敏增量   ┌─────────────────────────────┐
│ data.json / SSE  │ ───────────────►  │ Worker（Bearer 鉴权）        │
│ C3 云同步守护器   │ ◄───────────────  │  ├─ /v1/sync/pull|push       │
└────────┬─────────┘   pull 增量       │  ├─ /v1/ingress/:provider    │
         │ claim → 本地 /api/kanban/ingress → ack                        │
         │                              │  └─ D1: 镜像表 + ingress_inbox│
   IM/GitHub Webhook ──────────────────►│     验签 → 202 → 暂存         │
└──────────────────┘                    └─────────────────────────────┘
```

## 2. 产物清单

| 文件 | 作用 |
| --- | --- |
| `worker.mjs` | Worker 入口：`GET /v1/sync/pull`、`POST /v1/sync/push`、`POST /v1/ingress/:provider`、`POST /v1/inbox/claim`、`POST /v1/inbox/ack`、Cron 清理；直接 import `../lib/cloud-sync-protocol.js`（不手写第二套脱敏/Bearer） |
| `wrangler.toml` | D1 绑定、Cron Trigger、nodejs_compat 配置模板（`database_id` 需替换） |
| `migrations/0001_kanban_sync.sql` | C1 冻结的 D1 Schema（幂等 DDL） |
| `.dev.vars.example` | 本地 `wrangler dev` 的密钥模板（复制为 `.dev.vars`，已被 .gitignore 忽略） |
| `../test/cloud-worker.test.mjs` | 端到端单测（68 例）：node:sqlite 内存库实现 D1 兼容层，执行真实迁移 SQL |

## 3. 首次部署（推荐一键脚本，约 1 分钟）

前置：Node ≥ 22、Cloudflare 账号（免费计划即可）。

```bash
cd "/path/to/dsh-kanban"
npm run cloud:setup
```

`npm run cloud:setup` 会自动完成全部步骤（且**绝不修改 Git 跟踪文件 `cloudflare/wrangler.toml`**，而是生成已加入 `.gitignore` 的私有 `cloudflare/wrangler.local.toml`）：
1. 检查 Cloudflare 登录态（未登录自动拉起浏览器一次性 OAuth 授权）；
2. 查找或创建私有 D1 数据库 `dsh-kanban-sync` 并幂等执行表迁移；
3. 部署 Worker（含 `/v1/mcp` 远程 MCP 控制面）；
4. 生成 256-bit 随机 `CLOUD_SYNC_TOKEN` 上传至 Worker Secret，并以 `0600` 权限写入 `~/.dsh-kanban/cloud-config.json`；
5. 当场将本机现有 `~/.dsh-kanban/data.json` 卡片同步至 D1、热通知本机运行中的 DSH 守护器，并做 `/v1/mcp` 端到端冒烟验证后输出可直接填入 MCP 客户端的域名与凭据。

<details>
<summary>展开查看底层分步手工命令（等价参考）</summary>

```bash
cd "/path/to/dsh kanban"

# 1) 建库（个人默认用免费额度）
npx wrangler d1 create dsh-kanban-sync
#    → 把输出里的 database_id 填进 cloudflare/wrangler.local.toml（复制自 wrangler.toml 并替换 <REPLACE_WITH_D1_DATABASE_ID>）
#    → 同一段输出里的 database_name 如与模板不同，也一并改掉

# 2) 应用迁移（读取 wrangler.toml 的 migrations_dir）
npx wrangler d1 migrations apply dsh-kanban-sync --remote --config cloudflare/wrangler.toml

# 3) 状态面令牌（随机 32+ 字节；同一值写进本地 ~/.dsh-kanban/cloud-config.json）
openssl rand -hex 32
npx wrangler secret put CLOUD_SYNC_TOKEN --config cloudflare/wrangler.toml

# 4) 按需配置各 Webhook 来源密钥（不配置 = 该来源 fail-closed 503，不会被伪造请求塞队列）
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config cloudflare/wrangler.toml
npx wrangler secret put FEISHU_VERIFICATION_TOKEN --config cloudflare/wrangler.toml
npx wrangler secret put DINGTALK_SIGN_SECRET --config cloudflare/wrangler.toml
npx wrangler secret put INGRESS_GENERIC_TOKEN --config cloudflare/wrangler.toml
# 可选：FEISHU_ENCRYPT_KEY / DINGTALK_ACCESS_TOKEN / LOG_LEVEL=info

# 5) 部署（wrangler.toml 的 [vars] 已设 LOG_LEVEL="info"；只记元数据，不含请求体/令牌）
npx wrangler deploy --config cloudflare/wrangler.toml
#    → 记下 https://dsh-kanban-sync.<account>.workers.dev

# 6) 本地配置（C3 读取；权限必须 0600）
mkdir -p ~/.dsh-kanban && chmod 700 ~/.dsh-kanban
cat > ~/.dsh-kanban/cloud-config.json <<'JSON'
{
  "version": 1,
  "enabled": true,
  "workerUrl": "https://dsh-kanban-sync.<account>.workers.dev",
  "token": "<与 CLOUD_SYNC_TOKEN 相同的随机串>",
  "clientId": "macbook-pro",
  "sync":    { "enabled": true, "pushDebounceMs": 2000, "pullIntervalMs": 30000 },
  "ingress": { "enabled": true, "claimIntervalMs": 30000, "batchSize": 20, "leaseSeconds": 120 }
}
JSON
chmod 600 ~/.dsh-kanban/cloud-config.json

# 7) 冒烟（见 §5）
```

> 部署完成后验证 D1 是否就绪：`wrangler d1 execute dsh-kanban-sync --remote --config cloudflare/wrangler.local.toml --command "SELECT id, epoch, revision FROM sync_meta"`，应有一行 `id=1`、16 位 hex epoch、revision=0。

</details>

### 3.1 本地开发（wrangler dev，不碰线上 D1）

```bash
cp cloudflare/.dev.vars.example cloudflare/.dev.vars   # 填入本地测试令牌，勿提交
npx wrangler d1 migrations apply dsh-kanban-sync --local --config cloudflare/wrangler.toml
npx wrangler dev --config cloudflare/wrangler.toml      # 默认 http://127.0.0.1:8787
BASE=http://127.0.0.1:8787 TOKEN=<.dev.vars 里的 CLOUD_SYNC_TOKEN>   # 供 §5 冒烟使用
```

## 4. 运行配置

### 4.1 Worker secrets（`wrangler secret put`）

| 名称 | 必填 | 用途 | 未配置时行为 |
| --- | --- | --- | --- |
| `CLOUD_SYNC_TOKEN` | **是** | 状态面 Bearer 令牌（常量时间比较） | 状态面所有接口 `503 UNAVAILABLE`（fail-closed） |
| `MCP_BEARER_TOKEN` | 否 | `/v1/mcp` 远程 MCP 独立 Bearer 令牌（配置后与 `CLOUD_SYNC_TOKEN` 隔离，随时单独轮换） | 默认回退复用 `CLOUD_SYNC_TOKEN`；两者皆空则 `/v1/mcp` `503` |
| `GITHUB_WEBHOOK_SECRET` | 按需 | GitHub Webhook HMAC-SHA256 验签 | GitHub ingress `503` |
| `FEISHU_VERIFICATION_TOKEN` | 按需 | 飞书 challenge/事件 token 校验 | 飞书 ingress `503` |
| `FEISHU_ENCRYPT_KEY` | 按需 | 飞书事件 `X-Lark-Signature` 校验（sha256(ts+nonce+key+body)） | 不启用签名校验（若同时无 token 则 `503`） |
| `DINGTALK_SIGN_SECRET` | 按需 | 钉钉加签（HMAC-SHA256(timestamp+"\n"+secret)，base64） | 改用 `DINGTALK_ACCESS_TOKEN`；都没有则 `503` |
| `DINGTALK_ACCESS_TOKEN` | 按需 | 钉钉机器人 access_token 校验（body.token） | 同上 |
| `INGRESS_GENERIC_TOKEN` | 按需 | generic/wecom/onebot/weixin 共享 token（头 `x-kanban-ingress-token` 或 `Authorization: Bearer`） | 这些来源 `503` |
| `LOG_LEVEL` | 否 | `debug/info/warn/error`；模板默认 `info`，只记元数据（revision/provider/id/seq/count），不记请求体与令牌 | 删掉该行则完全静默 |

### 4.2 `wrangler.toml` 可调项

- `[triggers].crons`：默认每小时第 17 分清理；可改 `"0 * * * *"`。
- `[d1_databases].database_id`：**必须**替换。
- `compatibility_date` / `compatibility_flags=["nodejs_compat"]`：`worker.mjs` 依赖 `node:crypto` 与 `Buffer`，请勿删除 nodejs_compat。
- `workers_dev = true`：个人部署用 workers.dev 即可；自定义域名可加 `routes`。

## 5. 冒烟命令（部署后逐条验证）

```bash
BASE=https://dsh-kanban-sync.<account>.workers.dev
TOKEN=$(jq -r .token ~/.dsh-kanban/cloud-config.json)

# 1) 未带令牌 → 401 {"ok":false,"error":{"code":"UNAUTHORIZED"}}
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/sync/pull"

# 2) 空库 pull → 200 {"ok":true,"revision":0,...}
curl -s "$BASE/v1/sync/pull?since=0" -H "Authorization: Bearer $TOKEN" | jq .

# 3) 空增量 push → 200 status=noop（不分配 revision）
curl -s -X POST "$BASE/v1/sync/push" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"clientId":"smoke","pushId":"push-smoke-0001","baseRevision":0,
       "delta":{"boards":{"upserts":[],"deletes":[]},"cards":{"upserts":[],"deletes":[]},
                "activities":{"upserts":[],"deletes":[]}}}' | jq .

# 4) 推送一条真实增量（payload 建议由 lib/cloud-sync-protocol.js 的 toCloudBoard/toCloudCard 生成）
curl -s -X POST "$BASE/v1/sync/push" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"clientId":"smoke","pushId":"push-smoke-0002","baseRevision":0,
       "delta":{"boards":{"upserts":[{"id":"board-default","name":"主看板","cardOrder":{},"createdAt":1,"updatedAt":2}],"deletes":[]},
                "cards":{"upserts":[],"deletes":[]},"activities":{"upserts":[],"deletes":[]}}}' | jq .

# 5) pull 应看到 board-default，revision=1
curl -s "$BASE/v1/sync/pull?since=0" -H "Authorization: Bearer $TOKEN" | jq .boards

# 6) GitHub Webhook 模拟（已配 GITHUB_WEBHOOK_SECRET；签名必须与该 secret 匹配，否则 403）
BODY='{"zen":"Keep it logically awesome."}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')
curl -s -X POST "$BASE/v1/ingress/github" \
  -H 'content-type: application/json' -H 'x-github-event: ping' \
  -H 'x-github-delivery: smoke-1' -H "x-hub-signature-256: sha256=$SIG" -d "$BODY" | jq .
#    → 202 {"ok":true,"id":"in-…","seq":1,...}（本地休眠也会入队）

# 7) 飞书 URL 验证（配置后台「请求地址」时飞书会打过来；token 与 FEISHU_VERIFICATION_TOKEN 一致）
curl -s -X POST "$BASE/v1/ingress/feishu" -H 'content-type: application/json' \
  -d '{"type":"url_verification","challenge":"smoke-challenge","token":"<FEISHU_VERIFICATION_TOKEN>"}' | jq .
#    → 200 {"challenge":"smoke-challenge"}

# 8) claim → 本地回放 → ack（C3 的循环；手工验证时直接 ack）
curl -s -X POST "$BASE/v1/inbox/claim" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"consumerId":"smoke","limit":20,"leaseSeconds":120}' | jq .
curl -s -X POST "$BASE/v1/inbox/ack" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"consumerId":"smoke","results":[{"id":"in-…","outcome":"acked"}]}' | jq .

# 9) 远程 Streamable HTTP MCP 冒烟（云端 AI Agent 如 Antigravity / Claude / Cursor 直连）
curl -s -X POST "$BASE/v1/mcp" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kanban_boards","arguments":{}}}' | jq .
```

## 6. API 摘要

所有响应 `content-type: application/json; charset=utf-8`、`cache-control: no-store`；错误统一信封
`{"ok":false,"error":{"code","message","details?},"requestId"}`，成功 `{"ok":true,...}`，均带 `protocolVersion:1`。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/sync/pull?since&until&limit&cursor` | Bearer | revision 窗口 `(since, until]` 增量；键集游标分页；`hasMore/cursor/cursors` |
| POST | `/v1/sync/push` | Bearer | `{protocolVersion,clientId,pushId,baseRevision,epoch?,reset?,delta}` → `applied/duplicate/noop` 或 `409` |
| POST | `/v1/ingress/:provider` | 来源验签 | `github/feishu/dingtalk/wecom/onebot/weixin/generic`；202 秒回，飞书 challenge 直通 200 |
| POST | `/v1/inbox/claim` | Bearer | `{consumerId,limit≤20,leaseSeconds∈[30,900]}` → 带租约 items（按 seq 升序） |
| POST | `/v1/inbox/ack` | Bearer | `{consumerId,results:[{id,outcome:acked\|retry\|dead,error?}]}`；`results ≤200`（服务端按 90 id/查询分块回查，规避 D1 单查询 ≤100 绑定参数上限） |
| POST / DELETE | `/v1/mcp`（别名 `/mcp`） | Bearer（`MCP_BEARER_TOKEN` 或 `CLOUD_SYNC_TOKEN`） | MCP Streamable HTTP（`2025-03-26` / `2024-11-05`）：4 个只读工具直查 D1（Mac 合盖也可读），8 个写工具在边缘校验剥离后入 `ingress_inbox` 由本地回放（**无需 D1 结构迁移**） |

补充语义（C2 复核后加固）：
- 同步面（pull/push/claim/ack）成功响应与错误信封都带 `protocolVersion:1`，所有响应带 `x-request-id` 头；ingress 回执保持来源平台最小字段（飞书 challenge 只回 `{challenge}`）。
- `ack` 响应含 `{acked, retried, dead, missing, ignored}`：`ignored` 表示条目已是 `acked/dead` 终态、迟到的 ACK 被拒绝（不会复活重放）；`missing` 表示未知 id。
- `ack` 的 `results[]` 可**可选**带回 claim 拿到的 `leaseToken`；带回时服务端校验租约持有者，不匹配计入 `ignored`（不带则只做状态守卫，兼容契约最小字段）。
- 严格按「每 invocation 查询数」计费的免费计划下，单次 ACK 200 条的更新语句可能接近上限；正常 C3 每批 ≤20 条，远低于阈值，批量运维 ack 建议分批。
- `push` 的实体 id 上限 200 字符（否则 pull 游标可能超限）；超限返回 400。
- `reset:true` + 空 delta 也会清空镜像并分配 revision（「清空」本身是写操作），返回 `status:"applied"`。
- 空 delta 仍校验 `epoch` 与 `baseRevision`（不匹配返回 409），只有二者一致才返回 `noop`。

### 6.1 pull 游标实现说明（C2 回写契约 §6.2）

一次 pull 在 `until` 冻结窗口内，按 `revision → 实体类别（board < card < activity < tombstone）→ id` 升序返回；
`cursor` 是不透明串（`encodeSyncCursor({revision,id})`，id 带类别前缀），客户端**只需原样回传**。
`hasMore=true` 时响应里 `cursors` 的四个实体键同值，等价于同一个 `cursor`。
`hasMore=false` 时没有 `cursor`。全部分页读完后把 `since` 推进到 `until`。服务端会校验游标 id 必须带
实体类别前缀（`1:`board / `2:`card / `3:`activity / `4:`tombstone），伪造或旧格式游标返回 400。

### 6.2 错误码

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | delta/游标/provider/参数非法 |
| 400 | `UNSUPPORTED_PROTOCOL_VERSION` | protocolVersion ≠ 1 |
| 401 | `UNAUTHORIZED` | 缺/错 Bearer |
| 403 | `FORBIDDEN` | 入站签名/token 校验失败（含 GitHub 签名错误） |
| 404 | `NOT_FOUND` | 未知路由 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不匹配（`error.details.allowed` 给出允许方法） |
| 409 | `REVISION_CONFLICT` | `baseRevision` 落后：先 pull 追平再重试 |
| 409 | `SYNC_EPOCH_MISMATCH` | D1 被重建：本地以 `reset:true` 全量重推 |
| 413 | `PAYLOAD_TOO_LARGE` | push > 256 KiB / 入站 > 128 KiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 入站体不是 JSON 对象；飞书加密事件 |
| 500 | `INTERNAL` | 未预期异常（响应不含堆栈） |
| 503 | `UNAVAILABLE` | 未配置令牌/来源密钥、D1 未初始化（fail-closed） |

## 7. 运维

### 7.1 Cron 清理（每小时，`scheduled` 入口）

| 数据 | 保留策略 |
| --- | --- |
| `ingress_inbox` | acked 超 7 天、过 `expires_at`（默认 7 天）删除；待消费/失败保留 |
| `outbox` | delivered/expired 超 3 天删除（C2 未启用生产 outbox，表已就绪） |
| `activities` | 镜像只保留最近 90 天 |
| `tombstones` | 只保留最近 2000 个 revision 窗口 |

### 7.2 观测与告警建议

- `LOG_LEVEL=info` 时日志只含 `event` 与元数据（`provider/id/seq/revision/count`），不含请求体、令牌、签名头。
- 关注：`ingress_inbox` pending 数 > 100 或最老条目 > 30min（本地守护器没跑）；`dead` 数 > 0；最近 push 时间 > 10min；5xx 比例。
- Cloudflare 控制台 → Workers → Logs / D1 指标；免费额度以控制台为准（个人量级足够）。

### 7.3 备份 / 恢复 / 轮换

```bash
# 备份（镜像可丢；入站队列非空时建议导出）
npx wrangler d1 export dsh-kanban-sync --remote --output backup-$(date +%F).sql --config cloudflare/wrangler.toml

# 恢复：重建库 → apply migrations → 导回 → 本地 reset 全量重推
# 轮换令牌：secret 换成新值 → 改 ~/.dsh-kanban/cloud-config.json 的 token → 重启插件（旧值立即失效）
npx wrangler secret put CLOUD_SYNC_TOKEN --config cloudflare/wrangler.toml
```

## 8. 已知限制与设计决策（C2）

1. **入站只接受 JSON 对象**：本地回放走 `/api/kanban/ingress` 的 JSON 契约；非 JSON 的 Webhook 在边缘 415，不入队（避免唤醒后本地解析失败）。
2. **飞书加密事件不支持**：`body.encrypt` 需要 AES 解密，C2 在边缘直接 415 并提示关闭 Encrypt Key。飞书 URL 验证与明文事件（token / X-Lark-Signature 校验）已支持。
3. **云侧 `outbox` 未启用**：契约 §8.8 允许最小实现只用 `ingress_inbox`；表与清理逻辑已就绪，后续如需「云端主动通知/唤醒」再启用。
4. **单 Bearer、单写者**：一个部署 = 一条个人令牌、一个本地守护器；多客户端并发 push 会被 revision CAS 拒绝并退化为一次 409 重试。
5. **无 CORS**：只有本地守护器/curl 调用，浏览器跨域未开放（契约 §9.5）。
6. **push 的纵深防御**：Worker 在写 D1 前会用 C1 的 `toCloudBoard/toCloudCard/toCloudActivity` 再投影一次，即使 C3 漏脱敏，`cwd/workspaceId/sessionIds/runtime/outbox` 等执行面字段也进不了 D1。
7. **Wrangler 打包**：`worker.mjs` 以相对路径 import `../lib/cloud-sync-protocol.js`。若使用的 Wrangler 版本拒绝打包项目根之外的模块，可在仓库根执行 `npx wrangler deploy --config cloudflare/wrangler.toml`（config 根不变，esbuild 仍按相对路径解析）或把 `lib/cloud-sync-protocol.js` 纳入部署目录——但**不要**复制粘贴出第二套脱敏实现。
8. **HTTP 返回码与上游平台**：GitHub/飞书/钉钉只要求 2xx；签名失败统一 403（契约 §10），不会把错误细节回显给来源方。
9. **单次 push 的 SQL 语句数（M2 已加固）**：契约上限 200 实体/次。C2 已把 upsert、删除与墓碑都合并成多行语句（受 D1「单查询 ≤100 绑定参数」约束）：200 张卡 push ≈ 34 条 upsert + 1 条 CAS，200 个删除 ≈ 15 条 + 1 条 CAS，最坏整批 ≤ 50 条 SQL（改动前约 201 条）。即便如此，D1 单次调用可执行的查询数/批次上限仍以控制台与 [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 为准；若免费计划下遇到上限，C3 可把 `chunkDelta(delta, maxEntities)` 的 `maxEntities` 调小（如 50）串行推送——每片独立分配 revision，语义不变。
10. **generic 系的 `x-request-id` 不参与去重**：只有 github/feishu/dingtalk 使用各自的投递 id 头；generic/wecom/onebot/weixin 若带 `x-request-id` 会被忽略，去重退化为「provider + 事件类型 + 原始体」哈希，避免上游网关复用追踪 id 时把不同事件误判重丢弃。若某来源确有稳定投递 id，请在 JSON body 里放 `deliveryId` 字段（协议层会读取），或扩展专用头。
11. **ACK 批量上限 200 条**：超过 200 条请分批 ack；服务端按 100 条/查询分块回查，不会触发 D1 绑定参数上限。正常 C3 每批 ≤20 条，远低于上限。
12. **`card.metadata` 的 C1 口径遗留**：C1 的 `toCloudCard` 对 `metadata` 只做深度文本清洗、不整体丢弃 `sessionId/workspaceId` 等键（与契约 §7.5「DSH 会话 ID 不上云」存在口径张力）。C2 的纵深防御会剥离 `cwd/workspaceId/sessionIds/runtime/outbox/externalThreadId` 等卡片顶层字段，但 `metadata` 内嵌会话标识需 C1 后续补 drop-keys 规则；当前 `data.json` 的卡片 metadata 由本地写入方自行避免放入会话 ID。

## 9. 交接 C3（本地云同步守护器）要点（C3 已完成）

> **C3 已交付**：[`lib/cloud-sync-client.js`](../lib/cloud-sync-client.js) 已接入插件（`lib/index.js` / `lib/routes.js`），
> 未配置 `cloud-config.json` 时零网络静默降级；本地状态接口 `GET /api/kanban/cloud/status`；
> 端到端验收见 [`test/cloud-sync-client.test.mjs`](../test/cloud-sync-client.test.mjs)（离线暂存 IM → 唤醒自动回放建卡 → ACK → 双端镜像一致）。
> 完整实施口径与契约回写见 [`docs/contracts/08-cloud-sync.md`](../docs/contracts/08-cloud-sync.md) §11.5；以下为 C2 → C3 的原始交接清单。

1. 读 `~/.dsh-kanban/cloud-config.json`（`normalizeCloudConfig` + `0600` 权限校验；C3 实现为 `readCloudConfig`，缺失/关闭/非法均静默降级）。
2. 状态推送：`toCloudSnapshot` → `diffCloudSnapshots` → `chunkDelta(200)` → **串行** `POST /v1/sync/push`（`hashPushId` 复用重试；`revision` 作为下一片 `baseRevision`）。服务端已把单批语句数压到 ≤50，但若免费计划实测仍受限，可把分片调小到 50（语义不变）。
3. 处理响应：`applied/duplicate` 更新 `baseRevision`；`noop` 仅刷新节流；`409 REVISION_CONFLICT` → pull 追平 → 重算 delta → 重试；`409 SYNC_EPOCH_MISMATCH` → 本地全量快照 `reset:true` 重推（**reset 请求不能携带旧 epoch**——Worker 的 epoch 校验先于一切写操作，C3 实现口径见契约 §11.5.5）；`401` 停止并提示修配置；`413` 二分后重推；`429/5xx/网络错误` 指数退避。
4. 入站循环：`POST /v1/inbox/claim` → 对每条 `buildLocalIngressRequest(item)` → `POST http://127.0.0.1:<port>/api/kanban/ingress` → `POST /v1/inbox/ack`（本地 2xx=acked；本地 4xx=dead；本地 5xx/网络=retry；「已处理过」类 4xx 按 acked）。ACK 响应中的 `ignored` 表示条目已是终态（可安全忽略），`missing` 表示云端已无该条（可忽略）。
5. 云端对象**永不写回本地权威状态**；pull 只用于核对/灾备重建（`pullResponseToDelta` + `applyDeltaToCloudSnapshot`）。
6. 本地看板在云端不可达时必须零影响（只记日志 + 退避重试）。
7. 本地看板地址发现：读 `<dataDir>/runtime-endpoint.json` 的 `origin`（看板服务自动写入），缺失回退 `http://127.0.0.1:4599`；不新增配置字段。

## 10. 单测与自检

```bash
# C2 专项（68 例：鉴权/错误信封/push CAS/幂等/窗口分页/墓碑/四来源验签/去重/租约/退避/dead/零丢失回放/Cron 清理/端到端）
node --test test/cloud-worker.test.mjs

# C3 专项（25 例：静默降级/防抖 push/revision 与 epoch 自愈/401 暂停/退避/413 二分/pull 分页/唤醒探测/端到端离线回放）
node --test test/cloud-sync-client.test.mjs

# 全仓回归
npm test
```

测试使用 `node:sqlite`（Node ≥ 22.13；更低版本该文件自动 skip），在内存库上执行**真实迁移 SQL**，因此同时验证 D1 SQL 可执行性与迁移幂等性。C2 与 C3 共用 `test/cloud-worker-harness.mjs` 的内存 D1 测试底座（C3 端到端测试另起真实本地看板 HTTP 服务）。另含针对独立复核意见的回归用例：ACK 101 条分块回查（M1）、多行 upsert 的 D1 语句数上限与逐行版本守卫（M2）、reset+空 delta、空 delta 冲突检测、ACK 终态守卫、超长 id 拦截、generic `x-request-id` 误判重、`protocolVersion`/`x-request-id` 响应字段。
