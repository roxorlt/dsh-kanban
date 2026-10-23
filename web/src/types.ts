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
  | 'checklist'
  | 'artifact'
  | 'result'
  | 'error'
  | 'ack'
  | 'archived'
  | 'handoff';
export type ArtifactKind = 'file' | 'link' | 'report' | 'commit' | 'image';

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

export interface ApprovalOption {
  id: string;
  label: string;
  description?: string;
  tone?: 'primary' | 'danger' | 'ghost';
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
