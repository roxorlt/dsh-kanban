# dsh-kanban 数据模型契约 v0.1（冻结）

> 本文件是服务端、Web UI、客户端插件三方共同遵守的契约。改动必须先在 issues / 文档里更新"冻结"标记。
> 存储位置：`~/.dsh-kanban/data.json`（可用插件 config `dataDir` 覆盖）。原子写 + 进程内串行队列。
> v0.10 起同目录另有独立文件 `decisions.jsonl`（决策日志，只追加事件流），不并入 `data.json`，见 §3.aa 与 `05-decision-log.md`。

## 1. 核心概念

| 概念 | 说明 |
| --- | --- |
| Board 看板 | 一个看板对应一个工作面上的一组事项。首版默认一个看板，可扩展多看板。 |
| Card 卡片 | 最小工作单元。一张卡片 = 一个意图 / 一个 todo / 一个可验收的交付。卡片可绑定 0..n 个 DSH 会话。 |
| Session 绑定 | DSH 会话是执行线程。卡片的主会话（sessionIds[0]）是"当前执行会话"，回复、审批决定、打开会话、进度回写都走它。绑定即置顶；把已绑定会话重新绑定到首位 = **设为主会话**（v0.12），写入 `session_primary` 节点；已是主会话再绑定为幂等空操作（不写节点）。 |
| Activity 节点 | 卡片时间线上的一条重要节点（状态变化 / 进展 / 评论 / 审批 / 会话绑定 / 产物）。 |
| Approval 审批 | 需要人决策的待定项：批准/拒绝/多方案选择。卡片进入"待你确认"列，由人解决。 |
| Checklist 清单 | 卡片内的子步骤（agent 可勾选），用于展示计划与完成度。 |

## 2. 状态与列

```ts
type Status = 'backlog' | 'running' | 'needs_you' | 'blocked' | 'failed' | 'done' | 'canceled';
type ColumnId = 'backlog' | 'running' | 'needs_you' | 'done';
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

// 列是固定的四个语义桶，status 是更细的语义；列与 status 的映射是唯一权威：
const COLUMN_OF_STATUS: Record<Status, ColumnId> = {
  backlog: 'backlog',
  running: 'running',
  needs_you: 'needs_you',
  blocked: 'needs_you',   // 受阻需要人看一眼
  failed: 'needs_you',    // 失败需要人决策
  done: 'done',
  canceled: 'done',       // 已完成列内再区分
};
```

- agent 通过工具移动卡片时写 `status`；用户拖拽到某列时写该列的代表 status：`backlog→backlog`、`running→running`、`needs_you→needs_you`、`done→done`。
- `blocked` / `failed` 卡片显示在"待你确认"列，并带警示样式与原因；解决后 agent 改回 `running` 或 `done`。
- **审批提交即改列（v0.9.5）**：当卡片 `status=needs_you` 且不存在其它 `pending` 审批时，`resolve` 会在同一事务内立即迁移卡片：
  1. 所选选项声明了 `outcome` → 进入该列（`running` / `backlog` / `done`，多选取提交顺序里第一个声明值；多题按题序）；
  2. 未声明时：批准（非全 danger）→ `running`，驳回（所选全为 danger/no/reject/deny/cancel）→ `backlog`；
  3. 迁移写入 `status` 活动并以评论者身份进时间线。
  仍有其它 `pending` 审批、卡片已归档、或卡片不在 `needs_you`（`blocked`/`failed`、被人工拖到别的列）时保持原状态，等人处理。
- **会话运行失败同步（v0.11）**：绑定主会话（`sessionIds[0]`）的会话某一轮以失败结束时，看板自动回写：
  1. 时间线追加 `error` 节点（轮次、原因、错误码）；
  2. 卡片 `status=running` → 自动置 `failed`（进「待你确认」列）；其它状态只记节点、不改状态；
  3. 同一卡片同一会话同一轮只记一次；归档卡片与旁支会话跳过；
  4. 之后同一会话下一轮正常完成 → 自动回到 `running`，失败节点保留；手工置为 `failed` 的卡片不自动恢复。
- 列内顺序由 `Board.cardOrder[columnId]: string[]` 决定；不在数组里的卡片按 `updatedAt desc` 兜底。

## 3. 实体定义

```ts
interface Board {
  id: string;                    // "board-" + 8 hex
  name: string;
  description?: string;
  cardOrder: Record<ColumnId, string[]>;   // 列内顺序
  createdAt: number;             // epoch ms
  updatedAt: number;
}

interface Card {
  id: string;                    // "card-" + 8 hex
  boardId: string;
  title: string;                 // 标题，≤ 120 字
  summary: string;               // 摘要（折叠卡只显示前两行），≤ 600 字（v0.4 由 240 提升）
  currentAction?: string;        // 当前动作（"正在读 diff 并写评审意见"），≤ 160 字
  result?: string;               // 完成结果（done 后展示），≤ 600 字
  status: Status;
  priority: Priority;            // v0.9.0 起 Web UI 隐藏，API 与数据保留
  labels: string[];              // ≤ 12 个，每个 ≤ 24 字；v0.9.0 起 Web UI 隐藏，API 与数据保留
  project?: string;              // 项目名（展示用），如 "dsh-kanban"
  workspaceId?: string;          // DSH workspace id（可选）
  cwd?: string;                  // 绝对路径（创建会话时用）
  sessionIds: string[];          // 主会话在前；≤ 8
  agent?: { name: string; id?: string };    // 执行 agent 展示名
  progress?: { step: number; total?: number; percent?: number; text?: string };
  checklists: ChecklistItem[];
  approvals: Approval[];         // 内嵌，便于原子更新；只保留最近 20 条
  artifacts: Artifact[];
  metadata: {
    toolCalls: number;           // agent 工具调用计数（卡片维度）
    searches: number;            // 搜索/检索调用计数
    elapsedMs?: number;          // 卡片工作时间（可被工具更新；未填时 UI 用 startedAt 计算）
    tokensIn?: number;
    tokensOut?: number;
  };
  order: number;                 // 兜底排序，越小越靠前
  version: number;               // 乐观锁，每次服务端写 +1
  archived?: boolean;
  archivedAt?: number;           // 归档时间；自动/手动归档都会写
  handoff?: Handoff;             // v0.8：交接摘要；新会话启动时拼入提示
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

interface ChecklistItem {
  id: string;                    // "ck-" + 6 hex
  text: string;                  // ≤ 160 字
  done: boolean;
}

interface ApprovalQuestion {
  id: string;                    // "q-" + 6 hex
  header?: string;               // 题组标题，≤ 40 字（对齐 DSH ask_user_question.header）
  question: string;              // 题目，≤ 240 字
  multiSelect?: boolean;         // 默认 false=单选
  options: ApprovalOption[];     // 1..8 个
}

interface ApprovalAnswer {
  questionId: string;
  optionIds: string[];           // 单选长度 1；自定义回答时为空数组
  labels: string[];
  custom?: string;               // v0.4：自定义回答（UI 内置「其他（自行填写）」），≤ 600 字
}

interface Approval {
  id: string;                    // "ap-" + 8 hex
  // —— 单题兼容字段（v0.2 及以前）——
  title: string;                 // "是否把迁移脚本跑到生产？"
  detail: string;                // 影响、风险、上下文，≤ 1200 字
  multiSelect?: boolean;
  options: ApprovalOption[];     // 1..8 个；卡片内必须完整展示所有选项与说明，不折叠
  // —— v0.3 多问题（存在时优先渲染 questions，title/detail/options 仍保留作摘要与兼容）——
  questions?: ApprovalQuestion[]; // 1..6 题；每题独立单选/多选
  // v0.10 起 dismissed 由「归档 / 离开待你确认 / 20 条裁剪 / seed 重置」实际写入：
  // 同时写 resolvedAt / resolvedBy，不伪造 resolution；每一条另记 approval_unresolved 事件。
  status: 'pending' | 'approved' | 'rejected' | 'dismissed';
  requestedBy: Actor;
  requestedAt: number;
  resolvedBy?: Actor;
  resolvedAt?: number;
  resolution?: {
    optionIds: string[];         // 拍平后的全部所选 option id（兼容旧 UI）
    labels: string[];
    answers?: ApprovalAnswer[];  // v0.3：逐题答案；v0.4 起每题可带 custom
    comment?: string;
  };
  sessionId?: string;
}

interface ApprovalOption {
  id: string;                    // "yes" | "no" | 自定义
  label: string;
  description?: string;
  tone?: 'primary' | 'danger' | 'ghost';  // 渲染建议
  outcome?: 'running' | 'backlog' | 'done';  // v0.9.5：提交该项后卡片立即进入的列；不填＝批准回进行中、驳回回待办
}

interface Handoff {
  summary: string;               // 交接摘要，≤400 字；会话归档/暂停/交接时写入
  nextSteps?: string;            // 后续动作，≤600 字
  sessionId?: string;            // 来源会话（可选）
  at: number;                    // 服务端写入时间
  by?: Actor;                    // 写入者（agent/user）
}

interface Activity {
  id: string;                    // "ev-" + 8 hex
  cardId: string;
  type:
    | 'created' | 'status' | 'progress' | 'comment' | 'approval_requested'
    | 'approval_resolved' | 'session_linked' | 'session_primary'
    | 'session_archived' | 'session_unarchived'
    | 'checklist' | 'artifact' | 'result' | 'error' | 'ack' | 'archived' | 'handoff';
  // v0.11：session_archived / session_unarchived 的 data 固定为
  // { sessionId: string; auto?: true; autoDays?: number }，文本由服务端生成；
  // auto=true 表示插件自动归档策略写入（区别于用户手动操作）。
  actor: Actor;
  text: string;                  // 展示文本，≤ 400 字
  at: number;
  data?: Record<string, unknown>;
}
```

活动 `data` 约定（会话相关，v0.12）：

```ts
// session_linked（新绑定；绑定即置顶为主会话）
{ sessionId: string; action: 'link'; primary: true; previousSessionId?: string }
// session_primary（设为主会话；仅当目标已绑定且不是当前主会话）
{ sessionId: string; action: 'primary'; previousSessionId: string | null }
// 解绑沿用 session_linked + action:'unlink'
{ sessionId: string; action: 'unlink' }

interface Artifact {
  id: string;                    // "art-" + 6 hex
  kind: 'file' | 'link' | 'report' | 'commit' | 'image';
  label: string;
  url?: string;
  path?: string;
}

interface Actor {
  kind: 'user' | 'agent' | 'system';
  name: string;                  // "你" / "DSH Agent" / "system"
  id?: string;                   // agent id 或 user id
}
```

顶层存储：

```ts
interface StoreFile {
  schemaVersion: 1;
  boards: Board[];
  cards: Card[];                 // 所有看板的卡片平铺；按 boardId 过滤
  activities: Activity[];        // 全量时间线（按 cardId 索引），单卡最多回放 300 条
  meta: { createdAt: number; updatedAt: number; revision: number; seededAt?: number; lastActor?: Actor };
}
```

> v0.10 起另有独立文件 `<dataDir>/decisions.jsonl`（默认 `~/.dsh-kanban/decisions.jsonl`）：决策日志的只追加事件流，与 `data.json` 同目录但不并入、不随卡片裁剪或 `POST /seed` 重置，见 §3.aa。

## 3.x 自动归档配置（v1.1）

插件 config：

```yaml
- id: kanban
  config:
    autoArchiveDays: 30     # 默认 30；0 或非法值 = 关闭
```

规则：
- 仅归档 `status === 'done' | 'canceled'` 且 `completedAt <= now - days*86400000` 的卡片；
- 写入 `archived: true`、`archivedAt`、`updatedAt`，追加 `type: 'archived'` 活动（actor=`system`，文本「自动归档：已完成超过 N 天」）；
- 不删除数据，可通过归档查询恢复；启动时立即执行一次，之后每小时执行一次；
- 手动归档（单卡/批量）同样写 `archivedAt` 与 `archived` 活动。

## 3.y 交接摘要（handoff，v0.8）

- 写入：`PATCH /api/kanban/cards/:id` 的 `changes.handoff`（工具 `kanban_update_card` 同名字段）：
  `{ summary: string（≤400，必填）, nextSteps?: string（≤600）, sessionId?: string（≤160） }`。
- 服务端补 `at`（epoch ms）与 `by`（actor）；`handoff: null` 清除；写入时追加 `type:'handoff'` 活动「更新了交接摘要」。
- 用途：会话归档/暂停或 agent 交接时记录上下文；卡片详情展示；从卡片启动/续接新会话时，启动提示拼接：
  `【交接摘要】\n{summary}\n后续：{nextSteps}`。
- 限制：不改变卡片状态；不自动清空；每次覆盖写（保留活动历史）。

## 3.z 多题审批的自定义回答（v0.4）

- 每题作答二选一：选中至少 1 个选项（`optionIds`），或填写自定义回答（`custom`，≤600 字）。
- 单选题目：选项与 `custom` 互斥（同时给 → `BAD_REQUEST`）；多选题目可同时给选项与 `custom`。
- 校验：`answers` 必须覆盖全部题目，且每题满足上述条件；否则 `BAD_REQUEST`。
- 判定：所有题目选中的选项都是拒绝语义（danger / no / reject / deny / cancel 等）**且没有任何 custom** 时 `rejected`，否则 `approved`；只有自定义回答的多题审批一律 `approved`。
- `resolution.optionIds/labels` 只拍平真实选项；自定义回答只存在于 `resolution.answers[].custom`，不伪造 option id。
- 自定义回答是界面内置入口（「其他（自行填写）」），服务端不需要在 `questions[].options` 里定义它。

约束：
- `cards[].version` 单调递增；PATCH/DELETE/move 必须带 `version`（UI）或强制 `force:true`（工具可省略）。
- 每次写入 `meta.revision += 1`，SSE 广播 `{revision}`，UI 收到后 150ms 合并刷新。
- 卡片上限 2000；单卡 activities 保留最近 300 条；approvals 保留最近 20 条。
- 时间戳全部 epoch ms，服务端生成，客户端不传时间。
- 所有字符串 trim；超长截断而不是报错（工具返回提示）。

## 3.aa 决策日志（v0.10）

- 正式审批（`Approval`）的请求 / 提交 / 未提交关闭，以只追加事件流写入 `<dataDir>/decisions.jsonl`（默认 `~/.dsh-kanban/decisions.jsonl`，权限 `0600`）：一行一个 JSON 事件，不修改、不删除、无条数上限，不并入 `data.json`。
- 写入顺序：同一次 `store.update()` 事务内先 append 日志（`fsync`）再原子写 `data.json`；日志可能领先数据（多记一条未完成操作的记录），不会少记；日志写失败会中止本次操作（`DECISION_LOG_IO`），`data.json` 不提交。
- 事件：`approval_requested`（请求快照：题目 / 选项 / 卡片上下文 / 会话）、`approval_resolved`（决定、选项与自定义回答、`waitedMs`、提交后落列 `outcomeColumn`）、`approval_unresolved`（`reason` 为 `archived` / `left_needs_you` / `trimmed` / `data_reset`），以及标记事件 `log_initialized`（回填完成）/ `data_reset`（`POST /seed` 断点）。只记正式审批；受阻 / 失败卡、手动移列、agent 自行决策不入日志。
- 派生状态：`waiting` / `resolved` / `unresolved` 在读取时由事件重放得出，不写回文件。
- 回填：以 `log_initialized` 标记判断是否已初始化；首次启用从 `data.json` 的 `approvals[]` 与相关活动一次性回填并以标记收尾，已有标记则跳过（标记缺失时会补一次，历史事件追加在文件末尾，读取按 `at` 排序；回填按确定性 id 去重）。历史遗留的 pending 审批（归档卡 / 不在待你确认列）与回填在同一个 `store.update` 事务内被静默置为 `dismissed`（回填「收口感知」，不重复记事件），与日志一致。
- 读取：`GET /api/kanban/decisions`、`/decisions/meta`、`/decisions/export` 与只读工具 `kanban_decisions`，参数与响应见 `05-decision-log.md` §6 / §8。
- 字段与完整语义以 `05-decision-log.md` 为准（冻结）；本节只说明它与 `data.json` 的关系。

## 3.ab 会话运行失败同步（v0.11）

宿主事件：插件监听 `session/event`，只看 `turn/end`（判定口径与 DSH 聊天界面「本轮运行失败」一致）：

| `reason.kind` | 是否失败 | 写入的 `reason` 字段 | 默认文案 / code |
| --- | --- | --- | --- |
| `error` | 是 | `error` | 宿主 `error.message` / `error.code`（如 `TRANSPORT`） |
| `interrupted` | 是 | `interrupted` | 「DSH 进程在本轮结束前退出」/ `INTERRUPTED` |
| `aborted`（`reason.kind=hook` 且 `reason.reason=deepseek-account/signed-out`） | 是 | `aborted` | 「已退出 DeepSeek 账号，本轮中止」/ `ACCOUNT_SIGNED_OUT` |
| `completed` | 否（用于恢复） | — | 失败标记自动解除 |
| 其它（用户停止等） | 否 | — | 不写 |

时间线节点（`Activity.data`）：

```ts
// 失败节点：type='error'，actor=system
{ kind: 'session_turn_failure', sessionId: string, turn: number, seq?: number,
  reason: 'error' | 'interrupted' | 'aborted', code?: string, message: string }

// 恢复节点：type='progress'，actor=system
{ kind: 'session_turn_recovered', sessionId: string, turn: number, seq?: number }
```

规则：
- 只同步卡片主会话（`sessionIds[0]`）；已归档卡片、旁支会话不参与。
- 失败节点去重键：卡片 + `sessionId` + `turn`。
- 自动状态迁移只发生在 `status=running`（→ `failed`）与自动失败后的恢复（`failed` → `running`）；`needs_you`/`blocked`/`done`/`canceled`/`backlog` 只记节点。
- 恢复只撤销本功能写入的失败状态：卡片最近一条 `status` 节点必须带 `data.reason='session_turn_failure'`；人工置为失败的卡片不自动恢复。
- 插件 config `sessionFailureSync: false` 可整体关闭；宿主无 `session/event` 时监听器不触发（旧版 DSH 不受影响）。

## 4. 卡片摘要的"五层信息"（设计契约）

| 层级 | 字段 | 出现位置 |
| --- | --- | --- |
| 一句话摘要 | `summary` | 折叠卡第二行 |
| 当前动作 | `currentAction` | 折叠卡第三行 / 运行中标识行 |
| 最近节点 | 最新 Activity（progress/status） | 展开卡与详情时间线首条 |
| 结果 | `result` | done 卡片、详情"结果"区块 |
| 待决策 | 第一个 `status==='pending'` 的 Approval | 待你确认卡片的审批区、列表行徽标 |

## 5. 默认看板与种子数据

首次启动（data.json 不存在）创建默认看板 `board-default`，名 "DSH 看板"，并按 `seedMode` 写入示例卡片（`config.seed: 'demo' | 'empty'`，默认 `demo`；`scripts/dev-server.mjs` 用 demo）。
示例卡片至少覆盖：running 1 张（带 currentAction/progress/checklist/时间线）、needs_you 1 张（pending approval，两种选项）、blocked 或 failed 1 张、done 1 张（带 result）、backlog 1 张。示例卡片的 `project` 用本仓库名 `dsh-kanban`。
