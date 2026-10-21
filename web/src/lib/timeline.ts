import type { Activity, Card, Status } from '../types';

/** 服务端没给 activities 时的兜底节点（只用卡片自身字段合成，不臆造内容）。 */
export function synthesizeActivities(card: Card): Activity[] {
  const list: Activity[] = [
    {
      id: `syn-created-${card.id}`,
      cardId: card.id,
      type: 'created',
      actor: { kind: 'system', name: 'system' },
      text: '',
      at: card.createdAt,
    },
  ];
  if (card.status !== 'backlog') {
    list.push({
      id: `syn-status-${card.id}`,
      cardId: card.id,
      type: 'status',
      actor: { kind: 'system', name: 'system' },
      text: '',
      at: card.updatedAt,
      data: { status: card.status },
    });
  }
  for (const approval of card.approvals) {
    list.push({
      id: `syn-ap-${approval.id}`,
      cardId: card.id,
      type: 'approval_requested',
      actor: approval.requestedBy,
      text: '',
      at: approval.requestedAt,
      data: { title: approval.title },
    });
    if (approval.resolvedAt) {
      list.push({
        id: `syn-apr-${approval.id}`,
        cardId: card.id,
        type: 'approval_resolved',
        actor: approval.resolvedBy ?? { kind: 'system', name: 'system' },
        text: approval.resolution?.label ?? '',
        at: approval.resolvedAt,
      });
    }
  }
  if (card.result) {
    list.push({
      id: `syn-result-${card.id}`,
      cardId: card.id,
      type: 'result',
      actor: { kind: 'agent', name: card.agent?.name ?? 'agent' },
      text: card.result,
      at: card.completedAt ?? card.updatedAt,
    });
  }
  return list.sort((a, b) => b.at - a.at);
}

export function sortActivitiesDesc(activities: readonly Activity[]): Activity[] {
  return [...activities].sort((a, b) => b.at - a.at);
}

/**
 * 卡片时间线：优先服务端 activities（按 cardId 过滤、倒序），
 * 服务端未提供时退回卡片字段合成的兜底节点。
 */
export function cardTimeline(card: Card, activities: readonly Activity[] | undefined): Activity[] {
  const own = activities?.filter((activity) => activity.cardId === card.id) ?? [];
  if (own.length) return sortActivitiesDesc(own);
  return synthesizeActivities(card);
}

export function timelinePreview(card: Card, activities: readonly Activity[] | undefined, limit = 3): Activity[] {
  return cardTimeline(card, activities).slice(0, limit);
}

/** 时间线节点的展示文本（本地化由组件层负责；这里给出状态/标题等结构化字段）。 */
export function activityStatus(activity: Activity): Status | null {
  const value = activity.data?.status;
  if (typeof value !== 'string') return null;
  const statuses: Status[] = ['backlog', 'running', 'needs_you', 'blocked', 'failed', 'done', 'canceled'];
  return statuses.includes(value as Status) ? (value as Status) : null;
}

export function activityTitle(activity: Activity): string | null {
  const value = activity.data?.title;
  return typeof value === 'string' && value ? value : null;
}
