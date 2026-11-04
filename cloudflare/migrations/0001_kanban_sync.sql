-- ============================================================================
-- dsh-kanban 云端持久化（C1/3）——Cloudflare D1 同步镜像 Schema
-- ----------------------------------------------------------------------------
-- 契约：docs/contracts/08-cloud-sync.md（本文件的权威说明以契约为准）
-- 方言：Cloudflare D1（SQLite）。文件名遵循 Wrangler D1 migrations 约定，
--       由 `wrangler d1 migrations apply <DB> --migrations-dir cloudflare/migrations`
--       按文件名顺序执行；Wrangler 自己在 d1_migrations 表记录已执行版本，
--       本文件不重复维护迁移记录表，也不使用 PRAGMA / ATTACH / 事务语句。
--
-- 设计原则（Local-First）：
--   1. 本地 Mac（~/.dsh-kanban/data.json）是看板状态的唯一权威写者；云端只是
--      **只读镜像 + 入站暂存**，不产生任何业务状态变更，因此不存在双向合并。
--   2. 每张镜像表采用「热点列 + payload」双轨：热点列供 Worker 做筛选/排序/
--      JOIN（status、project、updated_at…），payload 保存**已脱敏**的完整实体
--      JSON（字段白名单见 lib/cloud-sync-protocol.js 的 toCloudCard 等）。
--      这样 C2 不必为本地新增字段改表；C3 拉取后可直接还原对象。
--   3. 每条镜像行带 `revision`：由 Worker 在每次 push 中分配（= baseRevision + 1），
--      同一批次写入的所有行共享同一个 revision。pull 用 revision 窗口
--      `(since, until]` 做增量，天然幂等、可重放。
--   4. ingress_inbox 与 outbox 是“投递队列”，语义见契约 §8/§9；它们与本地
--      data.json 里的 `outbox`（agent 唤醒指令队列）不是同一个东西，不可混用。
--
-- push 的 revision 分配算法（C2 必须按此顺序实现，保证原子性）：
--   1) 读 sync_meta：serverRevision = sync_meta.revision，serverEpoch = sync_meta.epoch；
--   2) 若请求带 epoch 且不匹配 → 409 SYNC_EPOCH_MISMATCH（客户端全量重建）；
--   3) 若请求 pushId 等于 sync_meta.last_push_id → 直接返回 duplicate
--      （上一轮已提交，响应丢失时安全重放；CAS 与 upsert 同 batch，故不会漏写）；
--   4) newRevision = serverRevision + 1；
--   5) 同一个 env.DB.batch() 内按「父后子、先写后删」顺序执行：
--        a. boards / cards / activities 的 upsert（revision 一律写 newRevision）；
--        b. tombstone 行（revision = newRevision）；
--        c. 最后一条语句做 CAS 提交：
--           UPDATE sync_meta
--              SET revision = ?newRevision, last_push_id = ?, last_push_at = ?,
--                  last_push_revision = ?newRevision, last_client_id = ?, updated_at = ?
--            WHERE id = 1 AND revision = ?baseRevision;
--   6) batch 返回后检查最后一条语句的 meta.changes：
--        = 1 → 提交成功，返回 200 applied；
--        = 0 → 并发写者抢先提交（单写者假设外的异常），返回 409 REVISION_CONFLICT；
--              本轮 upsert 与对方同 revision、行级 last-write-wins，幂等重试可自愈。
--   7) 空 delta 不分配 revision（返回 200 noop），避免无意义版本膨胀。
--
-- 保留与清理（建议由 Worker 的 Cron Trigger 每小时执行一次）：
--   DELETE FROM ingress_inbox WHERE status = 'acked' AND acked_at < :now - 604800000;
--   DELETE FROM ingress_inbox WHERE expires_at < :now;
--   DELETE FROM outbox        WHERE state IN ('delivered','expired') AND updated_at < :now - 259200000;
--   DELETE FROM tombstones    WHERE revision <= (SELECT revision FROM sync_meta WHERE id = 1) - 2000;
--   DELETE FROM activities WHERE at < :now - 7776000000;   -- 90 天前的时间线（镜像可丢）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) sync_meta：单行全局元数据（同步纪元 + 全局 revision + 幂等回执）
--    revision 只增不减；epoch 在首次 migrate 时用随机值生成，D1 库重建/重置后
--    必然变化，客户端据此发现「云端被重建」并走全量重建流程，避免静默错位。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version     INTEGER NOT NULL DEFAULT 1,
  epoch              TEXT    NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  last_push_id       TEXT,
  last_push_at       INTEGER,
  last_push_revision INTEGER,
  last_pull_at       INTEGER,
  last_client_id     TEXT,
  created_at         INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sync_meta (id, schema_version, epoch, revision, created_at, updated_at)
VALUES (
  1,
  1,
  lower(hex(randomblob(8))),
  0,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) boards：看板镜像（本地 Board 的一对一投影）
--    card_order 单独列出来，便于 Worker 不解析 payload 就能返回列内顺序；
--    payload 为脱敏后的完整 Board JSON（含 cardOrder/createdAt/updatedAt）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boards (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL DEFAULT '',
  description TEXT,
  card_order  TEXT    NOT NULL DEFAULT '{}',   -- JSON: {"backlog":[cardId...],...}
  archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 0,
  payload     TEXT    NOT NULL,                -- 脱敏后的完整 Board JSON
  synced_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_boards_revision   ON boards (revision, id);
CREATE INDEX IF NOT EXISTS idx_boards_updated_at ON boards (updated_at DESC);

-- ---------------------------------------------------------------------------
-- 3) cards：卡片镜像（本地 Card 的投影；热点列覆盖看板视图常用筛选）
--    本地卡片的 cwd / workspaceId / sessionIds / runtime / outbox 等执行面字段
--    在 payload 中已被协议层剥离（见 08-cloud-sync.md §7）。
--    version 是本地乐观锁版本，随卡片写入单调递增；Worker 用它做行级防回退
--    （upsert 时仅当 incoming.version >= cards.version 才覆盖）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  id             TEXT    PRIMARY KEY,
  board_id       TEXT    NOT NULL,
  title          TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'backlog'
                 CHECK (status IN ('backlog','running','needs_you','blocked','failed','done','canceled')),
  priority       TEXT    NOT NULL DEFAULT 'none',
  project        TEXT,
  external_ref   TEXT,
  parent_card_id TEXT,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived       INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0,
  completed_at   INTEGER,
  revision       INTEGER NOT NULL DEFAULT 0,
  payload        TEXT    NOT NULL,             -- 脱敏后的完整 Card JSON
  synced_at      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cards_board_status ON cards (board_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cards_revision     ON cards (revision, id);
CREATE INDEX IF NOT EXISTS idx_cards_updated_at   ON cards (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cards_project      ON cards (project) WHERE project IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_parent       ON cards (parent_card_id) WHERE parent_card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_external_ref ON cards (external_ref) WHERE external_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) activities：时间线镜像（按 cardId 回放；本地单卡只保留最近 300 条，
--    被裁剪的节点由增量 diff 生成 tombstone，云端据此清理，避免无限膨胀）。
--    payload 内的 data 字段已做路径/会话标识脱敏（见 08-cloud-sync.md §7）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
  id         TEXT    PRIMARY KEY,
  card_id    TEXT    NOT NULL,
  board_id   TEXT,
  type       TEXT    NOT NULL DEFAULT 'progress',
  actor_kind TEXT    NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('user', 'agent', 'system')),
  actor_name TEXT,
  text       TEXT    NOT NULL DEFAULT '',
  at         INTEGER NOT NULL DEFAULT 0,
  revision   INTEGER NOT NULL DEFAULT 0,
  payload    TEXT,                             -- 脱敏后的完整 Activity JSON（含 data）
  synced_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activities_card_at  ON activities (card_id, at, id);
CREATE INDEX IF NOT EXISTS idx_activities_revision ON activities (revision, id);
CREATE INDEX IF NOT EXISTS idx_activities_at       ON activities (at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_type     ON activities (type, at DESC);

-- ---------------------------------------------------------------------------
-- 5) tombstones：删除墓碑（增量同步的“负向事件”）
--    entity 取值 board / card / activity；本地裁剪时间线、删除看板、未来若引入
--    硬删卡片都会写墓碑。当前本地 DELETE 卡片实际是归档（archived=1 的 upsert），
--    因此墓碑主要服务于 activities 裁剪与未来扩展。
--    payload 不存原实体内容（脱敏后的墓碑只需 id + 时间）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tombstones (
  entity     TEXT    NOT NULL CHECK (entity IN ('board', 'card', 'activity')),
  entity_id  TEXT    NOT NULL,
  board_id   TEXT,
  deleted_at INTEGER NOT NULL DEFAULT 0,
  revision   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_tombstones_revision ON tombstones (revision);
CREATE INDEX IF NOT EXISTS idx_tombstones_board    ON tombstones (board_id) WHERE board_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6) outbox：Worker → 本地/下游的可靠下发队列（与本地 data.json.outbox 无关）
--    典型投递：休眠期入站唤醒通知、状态变更通知（IM/邮件）、审批结果回执。
--    语义：至多一次租约 + 至少一次投递，ack 后置 delivered；指数退避重试，
--    超过 max_attempts 置 failed；idempotency_key 由生产方生成，重复入队直接忽略。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT    NOT NULL UNIQUE,
  kind            TEXT    NOT NULL,            -- ingress_wake | state_changed | im_reply | ...
  target          TEXT,                        -- JSON: {clientId?, channel?, sessionId?}
  payload         TEXT    NOT NULL,            -- 已脱敏的投递内容（JSON 文本）
  state           TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'leased', 'delivered', 'failed', 'expired')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 10,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token     TEXT,
  lease_expires_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0,
  delivered_at    INTEGER,
  expires_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outbox_state_next ON outbox (state, next_attempt_at, seq);
CREATE INDEX IF NOT EXISTS idx_outbox_lease      ON outbox (lease_expires_at) WHERE lease_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_created    ON outbox (created_at DESC);

-- ---------------------------------------------------------------------------
-- 7) ingress_inbox：24x7 入站暂存队列（休眠期零丢失回放的核心表）
--    - 秒回 Webhook：Worker 校验来源后立即写本表并返回 202，不等本地 Mac；
--    - seq 是 AUTOINCREMENT 到达序号，本地按 seq 升序回放，保证同源事件顺序；
--    - payload 保存**原始请求体文本**（零丢失回放；D1 静态加密），不做脱敏，
--      但 headers 只保存白名单头（Authorization/Cookie/签名头一律不落库）；
--    - dedupe_key 唯一：同一 provider 的重复投递（webhook 重试）只入队一次；
--    - 本地回放成功后 /v1/inbox/ack 置 acked；失败累加 attempts 并按指数退避
--      重排 next_attempt_at，超过 max_attempts 置 dead 等待人工/告警处理；
--    - expires_at 默认 received_at + 7 天，过期未消费的条目由 Cron 清理。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingress_inbox (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT    NOT NULL UNIQUE,     -- "in-" + sha256(dedupe_key)[0:16]
  provider        TEXT    NOT NULL
                  CHECK (provider IN ('github', 'feishu', 'dingtalk', 'wecom', 'onebot', 'weixin', 'generic')),
  event_type      TEXT,
  delivery_id     TEXT,
  dedupe_key      TEXT    NOT NULL UNIQUE,
  headers         TEXT,                        -- JSON：白名单后的请求头
  payload         TEXT    NOT NULL,            -- 原始请求体（回放用，不脱敏）
  payload_bytes   INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'leased', 'acked', 'failed', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 20,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token     TEXT,
  lease_expires_at INTEGER,
  received_at     INTEGER NOT NULL DEFAULT 0,
  acked_at        INTEGER,
  last_error      TEXT,
  expires_at      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ingress_status_seq   ON ingress_inbox (status, seq);
CREATE INDEX IF NOT EXISTS idx_ingress_status_next  ON ingress_inbox (status, next_attempt_at, seq);
CREATE INDEX IF NOT EXISTS idx_ingress_received     ON ingress_inbox (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingress_provider     ON ingress_inbox (provider, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingress_expires      ON ingress_inbox (expires_at);
