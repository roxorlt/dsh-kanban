import type { Card, ColumnId, Status } from '../types';

/** 四个语义列，顺序即 UI 顺序。与契约 COLUMN_OF_STATUS 唯一权威一致。 */
export const COLUMNS: readonly ColumnId[] = ['backlog', 'running', 'needs_you', 'done'] as const;

export const COLUMN_OF_STATUS: Record<Status, ColumnId> = {
  backlog: 'backlog',
  running: 'running',
  needs_you: 'needs_you',
  blocked: 'needs_you',
  failed: 'needs_you',
  done: 'done',
  canceled: 'done',
};

/** 用户把卡片拖到某列时写入的代表 status。 */
export const STATUS_OF_COLUMN: Record<ColumnId, Status> = {
  backlog: 'backlog',
  running: 'running',
  needs_you: 'needs_you',
  done: 'done',
};

/** 状态点/徽标的语义色调，映射到 CSS 类与令牌。 */
export type StatusTone = 'tertiary' | 'business' | 'warn' | 'success' | 'error';

export const STATUS_TONE: Record<Status, StatusTone> = {
  backlog: 'tertiary',
  running: 'business',
  needs_you: 'warn',
  blocked: 'error',
  failed: 'error',
  done: 'success',
  canceled: 'tertiary',
};

/** 卡片是否有警示（blocked/failed 归入待你确认列并警示）。 */
export function isWarningStatus(status: Status): boolean {
  return status === 'blocked' || status === 'failed';
}

/** 是否在运行/活动状态（用于工作时间实时走表）。 */
export function isActiveStatus(status: Status): boolean {
  return status === 'running' || status === 'blocked';
}

export function isPendingApproval(card: Card): boolean {
  return card.approvals.some((a) => a.status === 'pending');
}
