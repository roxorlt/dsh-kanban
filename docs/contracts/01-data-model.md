# dsh-kanban 数据模型契约 v0.1（冻结）

> 本文件是服务端、Web UI、客户端插件三方共同遵守的契约。改动必须先在 issues / 文档里更新"冻结"标记。
> 存储位置：`~/.dsh-kanban/data.json`（可用插件 config `dataDir` 覆盖）。原子写 + 进程内串行队列。

## 1. 核心概念

| 概念 | 说明 |
| --- | --- |
| Board 看板 | 一个看板对应一个工作面上的一组事项。首版默认一个看板，可扩展多看板。 |
| Card 卡片 | 最小工作单元。一张卡片 = 一个意图 / 一个 todo / 一个可验收的交付。卡片可绑定 0..n 个 DSH 会话。 |
| Session 绑定 | DSH 会话是执行线程。卡片的主会话（sessionIds[0]）是"当前执行会话"，回复、打开会话、进度回写都走它。 |
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
  summary: string;               // 一句话摘要（折叠态第二行），≤ 240 字
  currentAction?: string;        // 当前动作（"正在读 diff 并写评审意见"），≤ 160 字
  result?: string;               // 完成结果（done 后展示），≤ 600 字
  status: Status;
  priority: Priority;
  labels: string[];              // ≤ 12 个，每个 ≤ 24 字
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
  optionIds: string[];           // 单选长度 1
  labels: string[];
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
  status: 'pending' | 'approved' | 'rejected' | 'dismissed';
  requestedBy: Actor;
  requestedAt: number;
  resolvedBy?: Actor;
  resolvedAt?: number;
  resolution?: {
    optionIds: string[];         // 拍平后的全部所选 option id（兼容旧 UI）
    labels: string[];
    answers?: ApprovalAnswer[];  // v0.3：逐题答案
    comment?: string;
  };
  sessionId?: string;
}

interface ApprovalOption {
  id: string;                    // "yes" | "no" | 自定义
  label: string;
  description?: string;
  tone?: 'primary' | 'danger' | 'ghost';  // 渲染建议
}

interface Activity {
  id: string;                    // "ev-" + 8 hex
  cardId: string;
  type:
    | 'created' | 'status' | 'progress' | 'comment' | 'approval_requested'
    | 'approval_resolved' | 'session_linked' | 'checklist' | 'artifact'
    | 'result' | 'error' | 'ack';
  actor: Actor;
  text: string;                  // 展示文本，≤ 400 字
  at: number;
  data?: Record<string, unknown>;
}

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

约束：
- `cards[].version` 单调递增；PATCH/DELETE/move 必须带 `version`（UI）或强制 `force:true`（工具可省略）。
- 每次写入 `meta.revision += 1`，SSE 广播 `{revision}`，UI 收到后 150ms 合并刷新。
- 卡片上限 2000；单卡 activities 保留最近 300 条；approvals 保留最近 20 条。
- 时间戳全部 epoch ms，服务端生成，客户端不传时间。
- 所有字符串 trim；超长截断而不是报错（工具返回提示）。

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
