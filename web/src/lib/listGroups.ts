import type { Card, ColumnId, Priority } from '../types';
import { COLUMNS, COLUMN_OF_STATUS } from './status';
import { groupCardsByColumn } from './grouping';

/** 列表视图分组维度：状态 / 项目 / 优先级。 */
export type ListGroupBy = 'status' | 'project' | 'priority';

export const LIST_GROUP_BY_OPTIONS: readonly ListGroupBy[] = ['status', 'project', 'priority'] as const;

/** 看板「已完成」列首屏展示条数 */
export const DONE_PREVIEW_LIMIT = 5;
/** 列表「已完成」分组首屏 / 每次加载更多条数 */
export const DONE_LIST_LIMIT = 5;

const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export interface ListGroup {
  key: string;
  /** 分组标题的 i18n key 或字面量（项目分组用项目名） */
  label: string;
  /** 仅状态分组有 column（用于色调/图标） */
  column?: ColumnId;
  cards: Card[];
  count: number;
}

const byUpdatedDesc = (a: Card, b: Card): number => b.updatedAt - a.updatedAt;

/**
 * 列表视图分组：
 * - status：沿用看板的 cardOrder 顺序，四列固定顺序；
 * - project：项目名字母序，「无项目」放最后；
 * - priority：紧急→高→中→低→无。
 * 归档卡片一律不出现。
 */
export function groupCardsForList(
  cards: readonly Card[],
  by: ListGroupBy,
  cardOrder?: Partial<Record<ColumnId, readonly string[]>>,
): ListGroup[] {
  const active = cards.filter((card) => !card.archived);
  if (by === 'status') {
    const groups = groupCardsByColumn(active, cardOrder);
    return COLUMNS.map((column) => ({
      key: `status:${column}`,
      label: `column.${column}`,
      column,
      cards: groups[column],
      count: groups[column].length,
    }));
  }

  if (by === 'priority') {
    const buckets = new Map<Priority, Card[]>();
    for (const card of active) {
      const bucket = buckets.get(card.priority) ?? [];
      bucket.push(card);
      buckets.set(card.priority, bucket);
    }
    return (Object.keys(PRIORITY_ORDER) as Priority[])
      .sort((a, b) => PRIORITY_ORDER[a] - PRIORITY_ORDER[b])
      .map((priority) => {
        const bucket = (buckets.get(priority) ?? []).sort(byUpdatedDesc);
        return {
          key: `priority:${priority}`,
          label: `priority.${priority}`,
          cards: bucket,
          count: bucket.length,
        };
      })
      .filter((group) => group.count > 0);
  }

  const buckets = new Map<string, Card[]>();
  for (const card of active) {
    const project = card.project?.trim() ?? '';
    const bucket = buckets.get(project) ?? [];
    bucket.push(card);
    buckets.set(project, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b, 'zh-Hans-CN');
    })
    .map(([project, bucket]) => ({
      key: `project:${project}`,
      label: project,
      cards: bucket.sort(byUpdatedDesc),
      count: bucket.length,
    }));
}

/** 状态分组里「已完成」列的卡片（含 canceled），供预览/加载更多使用。 */
export function doneCardsOf(cards: readonly Card[]): Card[] {
  return cards.filter((card) => !card.archived && COLUMN_OF_STATUS[card.status] === 'done');
}

/** 看板 done 列：最近 N 张 + 剩余数量。 */
export function previewDone(cards: readonly Card[], limit = DONE_PREVIEW_LIMIT): { visible: Card[]; rest: number } {
  const done = doneCardsOf(cards);
  return { visible: done.slice(0, limit), rest: Math.max(0, done.length - limit) };
}
