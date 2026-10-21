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
  | 'ack';
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

export interface ApprovalResolution {
  /** 新契约：多选时长度可 >1；单选时长度为 1 */
  optionIds: string[];
  labels: string[];
  comment?: string;
  /** 兼容旧服务端返回的 {optionId,label} 形态（normalizeApproval 会转换） */
  optionId?: string;
  label?: string;
}

export interface Approval {
  id: string;
  title: string;
  detail: string;
  /** 默认 false=单选；true=多选复选框 */
  multiSelect?: boolean;
  options: ApprovalOption[];
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
