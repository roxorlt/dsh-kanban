/** 批量选择模式的选择集（纯函数，便于单测）。 */
export type SelectionState = ReadonlySet<string>;

export const EMPTY_SELECTION: SelectionState = new Set<string>();

export function isSelected(selection: SelectionState, cardId: string): boolean {
  return selection.has(cardId);
}

export function selectionCount(selection: SelectionState): number {
  return selection.size;
}

/** 已选 id（按加入顺序，供 batch API 使用）。 */
export function selectedIds(selection: SelectionState): string[] {
  return [...selection];
}

export function toggleSelection(selection: SelectionState, cardId: string): SelectionState {
  const next = new Set(selection);
  if (next.has(cardId)) next.delete(cardId);
  else next.add(cardId);
  return next;
}

/** 全选当前视图：与已有选择取并集（跨视图保留）。 */
export function selectAll(selection: SelectionState, cardIds: readonly string[]): SelectionState {
  const next = new Set(selection);
  for (const id of cardIds) next.add(id);
  return next;
}

/** 取消当前视图内的选择（保留视图外的选择）。 */
export function deselectAll(selection: SelectionState, cardIds: readonly string[]): SelectionState {
  if (!cardIds.length) return selection;
  const next = new Set(selection);
  let changed = false;
  for (const id of cardIds) {
    if (next.delete(id)) changed = true;
  }
  return changed ? next : selection;
}

export function clearSelection(): SelectionState {
  return EMPTY_SELECTION;
}

export function allSelected(selection: SelectionState, cardIds: readonly string[]): boolean {
  return cardIds.length > 0 && cardIds.every((id) => selection.has(id));
}

/** 刷新/归档后过滤掉已不存在的 id；未变化时返回原引用避免多余渲染。 */
export function pruneSelection(selection: SelectionState, existingIds: Iterable<string>): SelectionState {
  const existing = new Set(existingIds);
  let changed = false;
  const next = new Set<string>();
  for (const id of selection) {
    if (existing.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selection;
}
