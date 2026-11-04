import type { Activity, Approval, ApprovalOption, Card, ColumnId, SessionRow } from '../types';
import type { ActivityFeed } from '../lib/activities';
import type { CardPlacement } from '../lib/grouping';
import type { CardRelationIndex } from '../lib/cardRelations';
import type { ApprovalDecision, ApprovalSubmission } from './ApprovalPanel';

/** 拖拽落点（与 lib/grouping 的落点计算共用同一类型）。 */
export type Placement = CardPlacement;

/** 卡片相关的共享视图状态（Board / List / Drawer 共用）。 */
export interface CardViewShared {
  now: number;
  sessions: SessionRow[];
  expandedIds: ReadonlySet<string>;
  resolvingApprovalId: string | null;
  activeCardId: string | null;
  /** 按卡片缓存的分页时间线 */
  feeds: Record<string, ActivityFeed>;
  /** 拉取某卡片更早的时间线 */
  loadEarlier: (cardId: string) => void;
  /** v0.22 父子卡/依赖关系索引（全量未归档卡片算出，看板/列表徽标共用） */
  relations: CardRelationIndex;
}

/** 卡片动作回调（App 统一实现，视图只负责触发）。 */
export interface CardActionHandlers {
  onToggleExpanded: (cardId: string) => void;
  onOpenDetail: (cardId: string) => void;
  onEdit: (card: Card) => void;
  onArchive: (card: Card) => void;
  onReopen: (card: Card) => void;
  onMove: (cardId: string, column: ColumnId, placement?: Placement) => void;
  onStartCard: (card: Card) => void;
  onResolveApproval: (
    card: Card,
    approval: Approval,
    submission: ApprovalSubmission,
    comment: string,
    decision: ApprovalDecision,
  ) => void;
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void;
  onReply: (card: Card, text: string) => Promise<{ ok: boolean; error?: string }>;
  onRetry: (card: Card) => void;
  onSessionClick: (card: Card) => void;
  onToggleAutoStart?: (card: Card, next: boolean) => void;
}

export type { Activity, ApprovalOption };
