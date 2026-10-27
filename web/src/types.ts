/**
 * dsh-kanban 数据模型 —— 与 docs/contracts/01-data-model.md 对齐（冻结契约 v0.1）。
 * 只做类型声明与常量，不放业务逻辑。
 */

export type Status = 'backlog' | 'running' | 'needs_you' | 'blocked' | 'failed' | 'done' | 'canceled';
export type ColumnId = 'backlog' | 'running' | 'needs_you' | 'done';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type ActorKind = 'user' | 'agent' | 'system';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'dismissed';
export type ActivityType =
  | 'created'
  | 'status'
  | 'progress'
  | 'comment'
  | 'approval_requested'
  | 'approval_resolved'
  | 'session_linked'
  | 'session_primary'
  | 'checklist'
  | 'artifact'
  | 'result'
  | 'error'
  | 'ack'
  | 'archived'
  | 'handoff'
  | 'session_archived'
  | 'session_unarchived';
export type ArtifactKind = 'file' | 'link' | 'report' | 'commit' | 'image';

/**
 * 宿主会话活动（docs/11-session-archive-linkage.md §12.2，`workspace/session-activity`）。
 * 归档运行中会话时，服务端把宿主返回的活动清单原样带回给 UI 做「停止并归档」确认。
 */
export type SessionActivityKind = 'turn' | 'job' | 'subagent' | 'schedule';

export interface SessionActivityItem {
  id: string;
  label?: string;
}

export interface SessionActivityEntry {
  kind: SessionActivityKind;
  items?: SessionActivityItem[];
}

export interface Actor {
  kind: ActorKind;
  name: string;
  id?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/** 审批选项声明的提交去向（设计文档 outcome 枚举；不含 needs_you）。 */
export type ApprovalOutcome = 'running' | 'backlog' | 'done';

export interface ApprovalOption {
  id: string;
  label: string;
  description?: string;
  tone?: 'primary' | 'danger' | 'ghost';
  /** 提交该项后卡片立即进入的列；不填＝批准回「进行中」、驳回回「待办」（v0.9.5） */
  outcome?: ApprovalOutcome;
}

export interface ApprovalQuestion {
  id: string;
  /** 题组标题（对齐 DSH ask_user_question.header），可空 */
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: ApprovalOption[];
}

export interface ApprovalAnswer {
  questionId: string;
  optionIds: string[];
  labels: string[];
  /** v0.4 自定义回答：用户选中「其他（自行填写）」时填的文本，≤600 字 */
  custom?: string;
}

export interface ApprovalResolution {
  /** 拍平后的全部所选 option id（兼容旧 UI / 单题） */
  optionIds: string[];
  labels: string[];
  /** v0.3：逐题答案 */
  answers?: ApprovalAnswer[];
  comment?: string;
  /** 兼容更旧服务端返回的 {optionId,label} 形态（normalizeApproval 会转换） */
  optionId?: string;
  label?: string;
}

export interface Handoff {
  /** 交接摘要，≤400 字 */
  summary: string;
  /** 后续动作，≤600 字 */
  nextSteps?: string;
  /** 来源会话（可选） */
  sessionId?: string;
  /** 服务端写入时间 */
  at: number;
  /** 写入者 */
  by?: Actor;
}

export interface Approval {
  id: string;
  /** 单题摘要标题；多题时由服务端或第一题派生 */
  title: string;
  detail: string;
  /** 默认 false=单选；true=多选复选框 */
  multiSelect?: boolean;
  /** 单题兼容字段 */
  options: ApprovalOption[];
  /** v0.3 多问题（存在时优先渲染 questions） */
  questions?: ApprovalQuestion[];
  status: ApprovalStatus;
  requestedBy: Actor;
  requestedAt: number;
  resolvedBy?: Actor;
  resolvedAt?: number;
  resolution?: ApprovalResolution;
  sessionId?: string;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  label: string;
  url?: string;
  path?: string;
}

export interface Progress {
  step: number;
  total?: number;
  percent?: number;
  text?: string;
}

export interface CardMeta {
  toolCalls: number;
  searches: number;
  elapsedMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface Card {
  id: string;
  boardId: string;
  title: string;
  summary: string;
  currentAction?: string;
  result?: string;
  status: Status;
  priority: Priority;
  labels: string[];
  project?: string;
  workspaceId?: string;
  cwd?: string;
  sessionIds: string[];
  agent?: { name: string; id?: string };
  progress?: Progress;
  checklists: ChecklistItem[];
  approvals: Approval[];
  artifacts: Artifact[];
  metadata: CardMeta;
  order: number;
  version: number;
  archived?: boolean;
  /** 归档时间（v1.1 batch archive 写入） */
  archivedAt?: number;
  /** v0.8 交接摘要：新会话启动提示会拼接 */
  handoff?: Handoff;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface Board {
  id: string;
  name: string;
  description?: string;
  cardOrder: Record<ColumnId, string[]>;
  createdAt: number;
  updatedAt: number;
}

export interface BoardSummary {
  id: string;
  name: string;
  counts?: Partial<Record<ColumnId, number>>;
}

export interface Activity {
  id: string;
  cardId: string;
  type: ActivityType;
  actor: Actor;
  text: string;
  at: number;
  data?: Record<string, unknown>;
}

export interface SessionRow {
  id: string;
  title: string;
  running: boolean;
  updatedAt: number;
  workspaceId?: string;
  /** DSH 会话工作目录；用于新建卡片/建会话时的建议与回填。 */
  cwd?: string;
}

/** DSH 左侧工作区（一个目录 + 该目录下的会话）。 */
export interface WorkspaceRow {
  workspaceId: string;
  title: string;
  path: string;
  sessionIds: string[];
  updatedAt?: number;
}

export interface HostInfo {
  locale: 'zh' | 'en';
  themeMode: 'light' | 'dark';
  dshVersion?: string;
  panelVisible: boolean;
}

/** GET /api/kanban/cards/:id/activities 的分页响应 */
export interface ActivityPage {
  activities: Activity[];
  hasMore: boolean;
  nextBefore?: string;
}

/** GET /api/kanban/state 的 payload（去掉 ok） */
export interface KanbanState {
  boards: BoardSummary[];
  board: Board;
  cards: Card[];
  revision: number;
  serverTime: number;
  activities?: Activity[];
}

// ------------------------------------------------ 卡片 Git 上下文（docs/contracts/06-git-context.md）
// 只读派生信息：GET /api/kanban/cards/:cardId/git 的 `git` 对象；不写 data.json、不改卡片字段。

/** `available:false` 的原因；前端对全部原因都静默隐藏区块。 */
export type GitUnavailableReason = 'no_cwd' | 'missing' | 'not_git' | 'no_commits' | 'timeout' | 'error';

/** refs 徽标来源：HEAD / 当前分支 / 参照分支（主分支）/ 远端跟踪分支。 */
export type GitRefKind = 'head' | 'branch' | 'base' | 'upstream';

export interface GitRepo {
  /** 主工作树目录名 */
  name: string;
  /** 主工作树根目录（worktree list 里 isMain 的那项） */
  root: string;
  /** .git 目录；linked worktree 下是主仓库的 common dir */
  commonDir: string;
}

export interface GitCurrent {
  /** 采集目录所在工作树根 */
  worktree: string;
  /** true = linked worktree（非主工作树） */
  isWorktree: boolean;
  isMainWorktree: boolean;
  /** detached HEAD 时为 null */
  branch: string | null;
  detached: boolean;
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  /** 毫秒时间戳 */
  committedAt: number;
}

/** 当前分支的跟踪分支；无 upstream 时为 null。 */
export interface GitUpstream {
  /** upstream 完整短名，如 origin/feat/x */
  ref: string;
  remote: string;
  /** 远端侧分支名 */
  branch: string;
  ahead: number;
  behind: number;
}

/** 泳道 0 的参照物（主分支 / upstream），探测不到主分支时为 null。 */
export interface GitBase {
  kind: 'main' | 'upstream';
  /** 泳道 0 展示标签 */
  label: string;
  /** 主分支名 */
  branch: string;
  /** 主分支的远端同名引用；不存在时 null */
  remoteRef: string | null;
  /** current 相对参照物领先 */
  ahead: number;
  /** current 相对参照物落后 */
  behind: number;
  /** 探测不到比较对象时为 null（图退化为单泳道） */
  mergeBase: { sha: string; shortSha: string } | null;
  /** 主分支相对 remoteRef 领先；remoteRef 为 null 时 null */
  remoteAhead: number | null;
  remoteBehind: number | null;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  detached: boolean;
  sha: string;
  shortSha: string;
  /** worktree list 的第一项 / 路径等于主工作树根 */
  isMain: boolean;
  /** 是否本次采集目录所在工作树 */
  isCurrent: boolean;
  /** 相对 base 参照物；无法计算时 null */
  aheadOfBase: number | null;
  behindOfBase: number | null;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  /** 毫秒时间戳 */
  committedAt: number;
}

/** 泳道图行内徽标；同一 sha 的多个 ref 由前端合并到同一行。 */
export interface GitRef {
  name: string;
  sha: string;
  shortSha: string;
  kind: GitRefKind;
}

export interface GitCommits {
  /** current 领先参照物的提交（新 → 旧） */
  ahead: GitCommit[];
  /** current 落后参照物的提交（新 → 旧） */
  behind: GitCommit[];
  /** 从 mergeBase 开始向旧（含 mergeBase 本身） */
  shared: GitCommit[];
}

// ------------------------------------------------ 多分支提交图（v0.14 graph）
// 契约 §4.5 / §5：refs 顺序即泳道种子优先级，commits 为 --date-order（父提交永远在孩子之后）。

/** graph.refs 引用类型：HEAD 伪引用 / 本地分支 / 远端引用。 */
export type GitGraphRefKind = 'head' | 'branch' | 'remote';

/** 多分支图的一条引用；数组顺序 = 前端泳道种子顺序。 */
export interface GitGraphRef {
  /** 展示名：HEAD / 分支名 / origin/xxx */
  name: string;
  kind: GitGraphRefKind;
  sha: string;
  shortSha: string;
  /** HEAD 伪引用 = 当前分支名；本地分支 = 分支名；远端引用为 null */
  branch?: string | null;
  /** 本地分支：是否当前分支 */
  isCurrent?: boolean;
  /** 本地分支：upstream 短名（无则 null） */
  upstream?: string | null;
  /** 本地分支相对 upstream 领先/落后；HEAD / remote / 无 upstream 为 null */
  ahead?: number | null;
  behind?: number | null;
}

/** 多分支图的一条提交（--date-order：父提交永远出现在孩子之后）。 */
export interface GitGraphCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  /** 毫秒时间戳 */
  committedAt: number;
  /** 父提交 sha（合并提交有多个） */
  parents: string[];
}

/** 多分支提交图数据（`git.graph`）；旧服务端没有该字段。 */
export interface GitGraphData {
  refs: GitGraphRef[];
  /** 超出 maxRefs 未返回的引用数 */
  refsTruncated?: number;
  commits: GitGraphCommit[];
  /** 引用范围内总提交数 − 返回条数 */
  truncated: number;
  maxCommits?: number;
  maxRefs?: number;
}

/** 服务端单次采集上限（前端展示上限另计：12 行） */
export interface GitLimits {
  ahead: number;
  behind: number;
  shared: number;
  worktrees: number;
}

export interface GitContextAvailable {
  available: true;
  /** 可用时恒为 null */
  reason: null;
  /** 可选调试信息，不进入正式 UI 文案 */
  message?: string | null;
  /** 实际采集目录（realpath） */
  dir: string;
  /** 传入的 ?cwd=（未传则 null；未采用时也返回原值） */
  requestedDir?: string | null;
  repo: GitRepo;
  current: GitCurrent;
  upstream: GitUpstream | null;
  base: GitBase | null;
  worktrees: GitWorktree[];
  /** 超过上限时省略的工作树数量 */
  worktreesTruncated?: number;
  /** v0.14 Fork 风格多分支提交图数据；旧服务端无此字段（前端整块隐藏） */
  graph?: GitGraphData;
  /** v0.13 legacy 两泳道数据：保留给旧前端 */
  commits: GitCommits;
  refs: GitRef[];
  limits: GitLimits;
  fetchedAt?: number;
  durationMs?: number;
}

/** 卡片无 cwd / 目录不存在 / 非 git 仓库 / 旧服务端 404 等：UI 静默隐藏区块。 */
export interface GitContextUnavailable {
  available: false;
  reason: GitUnavailableReason;
  message?: string | null;
  requestedDir?: string | null;
  fetchedAt?: number;
  durationMs?: number;
}

export type GitContext = GitContextAvailable | GitContextUnavailable;
