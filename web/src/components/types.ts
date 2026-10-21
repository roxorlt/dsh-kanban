import type { Activity, Approval, ApprovalOption, Card, ColumnId, SessionRow } from '../types';
import type { ApprovalDecision } from './ApprovalPanel';

export interface Placement {
  beforeId?: string;
  afterId?: string;
}

/** 卡片相关的共享视图状态（Board / List / Drawer 共用）。 */
export interface CardViewShared {
  now: number;
  activitiesByCard: Record<string, Activity[]>;
  sessions: SessionRow[];
  expandedIds: ReadonlySet<string>;
  resolvingApprovalId: string | null;
  activeCardId: string | null;
}

/** 卡片动作回调（App 统一实现，视图只负责触发）。 */
export interface CardActionHandlers {
  onToggleExpanded: (cardId: string) => void;
  onOpenDetail: (cardId: string) => void;
  onEdit: (card: Card) => void;
  onArchive: (card: Card) => void;
  onMove: (cardId: string, column: ColumnId, placement?: Placement) => void;
  onResolveApproval: (
    card: Card,
    approval: Approval,
    option: ApprovalOption,
    comment: string,
    decision: ApprovalDecision,
  ) => void;
  /** 卡片内联回复：写入 comments 后再经桥同步到会话。 */
  onReply: (card: Card, text: string) => Promise<{ ok: boolean; error?: string }>;
  /** 失败卡片重试：重新排入「进行中」。 */
  onRetry: (card: Card) => void;
  /** 点会话入口：有会话则打开，否则打开详情。 */
  onSessionClick: (card: Card) => void;
}
