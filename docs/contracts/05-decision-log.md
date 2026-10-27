# dsh-kanban 决策日志契约 v0.10（冻结）

> 本文件定义「决策日志」——把看板里正式审批（Approval）从请求到结果的原始数据，以只追加事件流持久化的契约。
> 顶层目的：日后可据此做抽象总结，或让 agent 依据这些原始数据协助处理「待确认」事项。本轮只负责**保存原始数据**，不做总结与自动处理。
> 与 `01-data-model.md` 的关系：`data.json` 的卡片内嵌 `approvals[]` 仍是运行时状态；决策日志是独立的、更长久的原始事件副本，不受卡片裁剪与数据重置影响。

## 1. 范围

记录（正式审批，用户已确认范围）：

| 事件 | 触发 |
| --- | --- |
| `approval_requested` | 创建审批（agent / 用户请求确认），一条审批一次 |
| `approval_resolved` | 用户提交审批（单题 / 多题、选项 / 自定义回答、批准 / 驳回） |
| `approval_unresolved` | 审批未提交就永久关闭：卡片归档、卡片离开「待你确认」、单卡 20 条审批上限裁剪、seed 重置 |
| `log_initialized` | 首次启动回填完成标记（不是审批事件，用于解释日志起点） |
| `data_reset` | `POST /seed` 导致数据替换（不是审批事件，用于解释数据断点） |

不记录（本轮明确排除）：受阻 / 失败卡片、手动拖入「待你确认」列、agent 自行决策、普通状态变化、已读 ack、评论。这些在 `data.json` 的活动流里仍有，但不进决策日志。

## 2. 文件与写入语义

- 路径：`<dataDir>/decisions.jsonl`（默认 `~/.dsh-kanban/decisions.jsonl`，跟随插件 `dataDir` 配置），权限 `0600`，目录不存在时创建。
- 格式：一行一个 JSON 对象，UTF-8，`\n` 结尾；**只追加，不修改、不删除、不设条数上限**。
- 写入时机：在同一个 `store.update()` 事务里，先 append 日志（fsync），再原子写 `data.json`。因此：
  - 日志可能**领先**于数据文件（数据写失败时，日志里会留下一条未完成操作的记录）——这是有意的「宁可多记、不可少记」。若同一操作被重试，日志里可能追加同一条审批的第二次收口事件（同 `requestId`，以最后写入者为准）；对账/去重留给分析侧，读取接口只做事件重放。
  - 日志写失败会中止本次操作（`DECISION_LOG_IO`），`data.json` 不提交，避免静默丢数据。
- 损坏容忍：读取时逐行 `JSON.parse`，坏行跳过但**不删除**；`skippedLines` 暴露在 meta 中。单进程写入假设与 `data.json` 相同（同一 dataDir 不要起两个实例）。
- 迁移/回填：以 `log_initialized` 标记判断是否已初始化。文件不存在 / 为空 / 没有该标记时，从 `data.json` 现有 `approvals[]` + `approval_*` 活动一次性回填，并以 `log_initialized` 收尾；已有标记则不重复回填。若文件里先有了实时事件（启动瞬间先发生写操作）或上次回填在写标记前中断，重启会补一次回填，历史事件追加在文件末尾——读取按 `at` 排序，不受文件顺序影响；回填会按确定性 `id` 跳过文件里已存在的事件，避免同一审批出现两条同 id 记录。
- 恢复：删除 `decisions.jsonl` 后重启会按当前 `data.json` 重新回填（只回填当时仍保留在卡片里的审批；已裁剪的历史无法恢复）。

## 3. 通用字段

```ts
interface DecisionEntryBase {
  v: 1;                       // 事件格式版本
  seq: number;                // 文件内序号，从 1 递增（回填后继续）
  id: string;                 // "dec-" + 12 hex
  type: DecisionType;
  at: number;                 // epoch ms
  source: 'live' | 'backfill';
  revision?: number;          // 写入时的 data.json revision（live 有，backfill 无）
}

type DecisionType =
  | 'approval_requested' | 'approval_resolved' | 'approval_unresolved'
  | 'log_initialized' | 'data_reset';

interface Actor { kind: 'user' | 'agent' | 'system'; name: string; id?: string }

/** 事件发生时刻的卡片上下文快照（不受后续卡片修改影响） */
interface DecisionCardContext {
  title: string;
  summary: string;
  status: Status;             // 事件发生时的卡片状态
  project?: string;
  cwd?: string;
  workspaceId?: string;
  currentAction?: string;
}
```

审批事件的 `id` 由 `cardId + approvalId + kind` 确定性派生（sha1 前 12 位 hex），kind ∈ `requested | resolved | unresolved`：

- 同一条审批的 `approval_resolved` / `approval_unresolved` 通过 `requestId` 指向 `approval_requested` 的 `id`；
- 确定性 id 让在线写入与回填对同一条审批得到相同的 id，重复回填也不会产生歧义。

`sessionId`：在线事件优先用审批声明的会话，缺省取卡片主会话；回填事件只保留审批当时声明的 `sessionId`，不从卡片当前绑定推断。

## 4. 事件定义

### 4.1 approval_requested

```ts
interface ApprovalRequestedEntry extends DecisionEntryBase {
  type: 'approval_requested';
  boardId: string;
  cardId: string;
  approvalId: string;
  actor: Actor;                 // requestedBy
  sessionId?: string;           // 审批声明的会话；缺省取卡片主会话
  card: DecisionCardContext;    // 请求前的卡片状态
  approval: {                   // 完整请求快照（题目与选项原文）
    title: string;              // ≤160
    detail: string;             // ≤1200
    multiSelect: boolean;       // 单题多选或第一题多选
    options: ApprovalOption[];  // 单题选项（多题时＝第一题选项，兼容字段）
    questions?: ApprovalQuestion[];  // 多题审批的完整题目
  };
  degraded?: true;              // 回填自 activities、原始审批已被裁剪
  rawText?: string;             // degraded 时的原始活动文案（≤400）
  evidence?: { activityId: string };
}
```

快照是**请求时刻**的原文：之后即使卡片被编辑、审批被裁剪、`data.json` 被重置，这条记录也不变。

### 4.2 approval_resolved

```ts
interface ApprovalResolvedEntry extends DecisionEntryBase {
  type: 'approval_resolved';
  boardId: string;
  cardId: string;
  approvalId: string;
  requestId: string;            // 对应 approval_requested.id
  actor: Actor;                 // resolvedBy（用户；兼容回填时的 system）
  sessionId?: string;
  card: DecisionCardContext;    // 提交时刻、卡片移列前的状态
  decision: 'approved' | 'rejected' | 'dismissed';
  resolution: {
    optionIds: string[];
    labels: string[];
    answers?: ApprovalAnswer[]; // 逐题答案，含 custom
    comment?: string;
  };
  waitedMs: number;             // resolvedAt - requestedAt，≥0
  outcomeColumn?: 'running' | 'backlog' | 'done';  // 提交后卡片实际迁入的列（未迁移则无）
  degraded?: true;
  rawText?: string;
  evidence?: { activityId: string };
}
```

`waitedMs` 用于日后分析等待时长；`outcomeColumn` 表示这次决定落地后卡片的去向，便于分析「选了什么 → 后续怎样」。

### 4.3 approval_unresolved

```ts
interface ApprovalUnresolvedEntry extends DecisionEntryBase {
  type: 'approval_unresolved';
  boardId: string;
  cardId: string;
  approvalId: string;
  requestId: string;
  actor: Actor;                 // 关闭者：归档者 / system
  sessionId?: string;
  card: DecisionCardContext;
  reason: 'archived' | 'left_needs_you' | 'trimmed' | 'data_reset';
  waitedMs: number;
}
```

`reason` 含义：

| reason | 含义 |
| --- | --- |
| `archived` | 卡片被归档，未提交的审批随归档关闭（`approval.status` 同时改为 `dismissed`，写 `resolvedAt` / `resolvedBy`） |
| `left_needs_you` | 卡片被移出「待你确认」列（含批量移动 / 完成 / 状态变更），未提交的审批关闭（同上改为 `dismissed`） |
| `trimmed` | 单卡 20 条审批上限裁剪时被丢掉（旧记录已在日志里，这里补一条关闭事实） |
| `data_reset` | `POST /seed`（demo/empty/reset）替换数据前，尚未提交的审批被关闭 |

### 4.4 log_initialized / data_reset（标记事件）

```ts
interface LogInitializedEntry extends DecisionEntryBase {
  type: 'log_initialized';
  source: 'backfill';
  counts: { cards: number; approvals: number; requested: number; resolved: number; pending: number; activities: number; entries: number };
}

interface DataResetEntry extends DecisionEntryBase {
  type: 'data_reset';
  source: 'live';
  actor: Actor;                 // system
  mode: 'demo' | 'empty' | 'reset';
  before: { cards: number; approvals: number; pending: number; activities: number };
}
```

标记事件没有 `boardId` / `cardId`。`log_initialized` 写在回填批次的最后一行，`at` 为回填完成时刻，表示日志起点与回填规模；`data_reset` 标记旧数据结束，与触发它的未决事件同一批写入。若 seed 模式为 `demo`，新演示数据的 `approval_requested` 事件会追加在 `data_reset` 之后（文件顺序不代表 `at` 顺序，读取按 `at` 排序）。

> 注：`seq` 以写入顺序递增（回填批次的 seq 在回填时分配），`at` 是事件真实时间；分析时以 `at` 为准，`seq` 只用于文件内定位与分页。坏行被跳过时，新事件的 `seq` 会取历史最大值之后，保证原始文件里不重号。

## 5. 派生状态（读取时计算，不写回文件）

`approval_requested` 在列表接口中附带派生字段：

```ts
state: 'waiting' | 'resolved' | 'unresolved';
closedAt?: number;        // resolved/unresolved 的 at
decision?: 'approved' | 'rejected' | 'dismissed';   // state=resolved 时
unresolvedReason?: string; // state=unresolved 时的关闭原因（archived / left_needs_you / trimmed / data_reset）
```

- `waiting`：没有对应的 `approval_resolved` / `approval_unresolved`，即**正在等你做的选择**；
- `resolved`：有 `approval_resolved`；
- `unresolved`：有 `approval_unresolved`。

> 日志是事件流，不存快照状态；状态在每次读取时由事件重放得出。`data.json` 若被重置，日志中的 `waiting` 只表示「当时在等，日志里没有关闭记录」，不代表现在仍待处理。`waiting` 按唯一 `id` 计数。若同一请求同时存在 `resolved` 与 `unresolved`（历史遗留审批后来才被提交），以**最后写入**的关闭事件为准。

## 6. HTTP 接口（前缀 `/api/kanban`）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/decisions` | 列表（倒序）：`limit`（默认 50，1–200）、`before`（上一页最后一条 id）、`type`（逗号分隔）、`state`（仅匹配 requested 条目）、`cardId`、`boardId`、`approvalId`、`since`、`until`（epoch ms）、`source`（live/backfill） → `{ok, decisions, hasMore, nextBefore, total, filtered, waiting, revision}` |
| GET | `/decisions/meta` | `{ok, logVersion, file, exists, sizeBytes, entries, skippedLines, byType, waiting, firstAt, lastAt, initializedAt, revision}` |
| GET | `/decisions/export` | 原样返回 `decisions.jsonl` 的**字节**（不转码，invalid UTF-8 不替换；排进写队列后读取，拿到完整快照；`application/x-ndjson`，`content-disposition: attachment`） |

错误沿用 `02-http-api.md` 的通用约定：非法 `type` / `state` / 时间 / id → `BAD_REQUEST`。

响应字段语义：`total` 是日志总条数（不受筛选影响）；`filtered` 是本次筛选命中数；`waiting` 是整份日志中仍在等待的请求数（同样不受筛选影响）。`before` 必须是**当前筛选结果里**的一条事件 id，否则 `BAD_REQUEST`。

## 7. 与既有行为的关系

- `Approval.status` 新增**实际使用** `dismissed`：卡片归档或离开「待你确认」列时，未提交审批置为 `dismissed` 并写 `resolvedAt` / `resolvedBy`（`resolution` 不伪造）。旧数据中遗留的 `dismissed` 照常渲染（Web 已有「已忽略」文案）。
- 卡片 20 条审批上限、300 条时间线上限、`/seed` 覆盖行为都不变；决策日志在它们之外保留原始副本。
- 归档卡片、已完成卡片的历史审批在回填时同样入日志；回填在插件 `apply()` 里 `store.ready()` 之后执行一次，不阻塞启动。
- 回填事件（`source: "backfill"`）的 `card` 快照是**回填时刻**的卡片状态（历史状态无法完全还原）；`degraded: true` 的事件来自剩余活动记录，缺少的标题/选项细节以空值或 `rawText` 表示，分析时请按 `degraded` 区分置信度。
- 历史遗留的 pending 审批（旧版本把卡片移出「待你确认」或归档、但没有关闭审批）：回填时先记录未决事件，再把 `data.json` 中的该审批静默置为 `dismissed`（写 `resolvedAt` / `resolvedBy`，不再重复记事件），让数据与日志一致；该同步幂等，每次启动只在检测到遗留时执行一次。**回填与同步在同一个 `store.update` 事务内完成**（store 写队列串行，启动窗口内的 live 写不会与之交错）；回填是「收口感知」的：日志里已有某请求的 `resolved`/`unresolved` 时不再补第二条收口。
- `POST /seed` 的 `demo` 模式会重建演示卡片（其中自带 pending 审批）：实现会为这些审批补写 `approval_requested` 事件（`source: "live"`，`at` 为审批的 `requestedAt`），避免后续提交时出现找不到请求的「孤儿」`approval_resolved`。`empty` / `reset` 不产生新审批。

## 8. Agent 工具 `kanban_decisions`

只读查询（`lib/tools.js`）：参数 `cardId?` / `boardId?` / `type?` / `state?` / `limit?` / `before?` / `since?` / `until?`，返回与 `GET /decisions` 相同的 `decisions / hasMore / nextBefore / total / filtered / waiting`，并附原始文件路径 `file` 与一句只读提示 `hint`。工具只读，不写、不替用户决策。
