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

/** 某列列表去掉指定卡片后的 id 顺序（拖拽计算落点用）。 */
export function columnIds(groups: ColumnGroups, column: ColumnId): string[] {
  return groups[column].map((c) => c.id);
}

/** move 接口的落点：beforeId 插到该卡片前、afterId 插到该卡片后；空对象 = 插到列头。 */
export interface CardPlacement {
  beforeId?: string;
  afterId?: string;
}

export interface DropContext {
  /** 目标列的完整卡片 id 顺序（已完成列包含预览折叠掉的卡片）。 */
  ids: readonly string[];
  /** 被拖拽的卡片 id。 */
  draggedId: string;
  /** 松手时悬停的卡片 id；null = 列体空白区。 */
  targetId: string | null;
  /** 拖拽是否发生在同一列内。 */
  sameColumn: boolean;
  /** 目标列。 */
  column: ColumnId;
}

/**
 * 计算拖拽落点；返回 null 表示「放回原位」——不改变顺序、不请求后端。
 *
 * 判断顺序：
 * 1) 落在卡片自身（drag 起止同一位置）→ 放回原位，任何列都不请求；
 * 2) 落在某张卡片上：插到该卡片前；同列且结果位置与原来相同（拖回原处 / 拖到
 *    后一张卡）→ 放回原位；
 * 3) 同列 + 空白区：已完成列有预览折叠（只显示最近 5 张、其余在「查看全部」里），
 *    空白区没有明确的落点含义 → 一律放回原位，避免卡片被挤进折叠区；其他列卡片
 *    全部可见，空白区 = 列表末尾；
 * 4) 跨列 + 空白区：拖进「已完成」时插到列头（最近完成，预览一定可见）；其他列
 *    插到真正末尾（与末尾的落点提示线一致）。
 */
export function planCardDrop({ ids, draggedId, targetId, sameColumn, column }: DropContext): CardPlacement | null {
  const rest = ids.filter((id) => id !== draggedId);
  const last = rest[rest.length - 1];
  const currentIndex = ids.indexOf(draggedId);

  if (targetId === draggedId) return null;
  let placement: CardPlacement | null;
  if (targetId !== null && rest.includes(targetId)) {
    // 落在某张卡片上：插到它前面（等价于前一张卡的 afterId）。
    const targetIndex = rest.indexOf(targetId);
    placement = targetIndex === 0 ? {} : { afterId: rest[targetIndex - 1] };
  } else if (sameColumn) {
    // 同列落到空白区：已完成列放回原位，其他列落到末尾。
    placement = column === 'done' ? null : last ? { afterId: last } : null;
  } else {
    // 跨列放到空白区：已完成列放列头，其他列放末尾。
    placement = column === 'done' ? {} : last ? { afterId: last } : {};
  }

  if (placement === null) return null;
  if (sameColumn) {
    const afterId = placement.afterId;
    const nextIndex = afterId ? rest.indexOf(afterId) + 1 : 0;
    if (nextIndex === currentIndex) return null;
  }
  return placement;
}
