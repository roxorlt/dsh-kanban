import type { Card, ColumnId } from '../types';
import { COLUMNS, COLUMN_OF_STATUS } from './status';

export type ColumnGroups = Record<ColumnId, Card[]>;

const emptyGroups = (): ColumnGroups => ({ backlog: [], running: [], needs_you: [], done: [] });

/**
 * 把卡片按契约映射分到四列，并保持列内顺序：
 * 1) 在 board.cardOrder[column] 里的卡片按数组顺序；
 * 2) 不在数组里的卡片追加在后面，按 updatedAt 倒序兜底；
 * 3) 归档卡片一律不出现。
 */
export function groupCardsByColumn(
  cards: readonly Card[],
  cardOrder?: Partial<Record<ColumnId, readonly string[]>>,
): ColumnGroups {
  const groups = emptyGroups();
  const orderIndex = new Map<string, number>();
  if (cardOrder) {
    for (const column of COLUMNS) {
      const ids = cardOrder[column] ?? [];
      ids.forEach((id, index) => orderIndex.set(`${column}:${id}`, index));
    }
  }

  for (const card of cards) {
    if (card.archived) continue;
    groups[COLUMN_OF_STATUS[card.status]].push(card);
  }

  for (const column of COLUMNS) {
    groups[column].sort((a, b) => {
      const ai = orderIndex.get(`${column}:${a.id}`);
      const bi = orderIndex.get(`${column}:${b.id}`);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return a.order - b.order;
    });
  }

  return groups;
}

export function countByColumn(cards: readonly Card[]): Record<ColumnId, number> {
  const counts: Record<ColumnId, number> = { backlog: 0, running: 0, needs_you: 0, done: 0 };
  for (const card of cards) {
    if (card.archived) continue;
    counts[COLUMN_OF_STATUS[card.status]] += 1;
  }
  return counts;
}

/** 某列列表去掉指定卡片后的 id 顺序（拖拽计算 beforeId/afterId 用）。 */
export function columnIds(groups: ColumnGroups, column: ColumnId): string[] {
  return groups[column].map((c) => c.id);
}

/** 计算拖放目标位置：placement 为 `'end'` 或目标卡片 id；返回 move 接口的 beforeId/afterId。 */
export function dropTarget(
  ids: readonly string[],
  draggedId: string,
  targetId: string | null,
): { beforeId?: string; afterId?: string } {
  const rest = ids.filter((id) => id !== draggedId);
  if (targetId === null) {
    const last = rest[rest.length - 1];
    return last ? { beforeId: last } : {};
  }
  const index = rest.indexOf(targetId);
  if (index === -1) {
    const last = rest[rest.length - 1];
    return last ? { beforeId: last } : {};
  }
  const prev = rest[index - 1];
  return prev ? { afterId: prev } : {};
}
