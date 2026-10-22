import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  allSelected,
  clearSelection,
  deselectAll,
  isSelected,
  pruneSelection,
  selectAll,
  selectedIds,
  selectionCount,
  toggleSelection,
} from './selection';

describe('批量选择 reducer', () => {
  it('toggle 加入/移除，不修改原集合', () => {
    const first = toggleSelection(EMPTY_SELECTION, 'card-a');
    expect([...first]).toEqual(['card-a']);
    expect(isSelected(first, 'card-a')).toBe(true);
    const second = toggleSelection(first, 'card-b');
    expect(selectedIds(second)).toEqual(['card-a', 'card-b']);
    expect(isSelected(first, 'card-b')).toBe(false);
    const removed = toggleSelection(second, 'card-a');
    expect(selectedIds(removed)).toEqual(['card-b']);
    expect(selectionCount(second)).toBe(2);
  });

  it('selectAll 与已有选择取并集并去重', () => {
    const base = toggleSelection(EMPTY_SELECTION, 'outside');
    const next = selectAll(base, ['card-a', 'card-b', 'card-a']);
    expect(selectedIds(next).sort()).toEqual(['card-a', 'card-b', 'outside']);
    expect(allSelected(next, ['card-a', 'card-b'])).toBe(true);
    expect(allSelected(next, ['card-a', 'card-c'])).toBe(false);
    expect(allSelected(next, [])).toBe(false);
  });

  it('deselectAll 只移除视图内 id，保留视图外选择', () => {
    const selection = selectAll(EMPTY_SELECTION, ['a', 'b', 'outside']);
    const next = deselectAll(selection, ['a', 'b', 'missing']);
    expect(selectedIds(next).sort()).toEqual(['outside']);
    expect(deselectAll(next, ['a'])).toBe(next);
  });

  it('clear 返回空集合', () => {
    const selection = selectAll(EMPTY_SELECTION, ['a', 'b']);
    expect(selectionCount(clearSelection())).toBe(0);
    expect(selectionCount(selection)).toBe(2);
  });

  it('prune 过滤已不存在/已归档的 id，未变化时返回原引用', () => {
    const selection = selectAll(EMPTY_SELECTION, ['a', 'b', 'c']);
    const pruned = pruneSelection(selection, ['a', 'c']);
    expect(selectedIds(pruned).sort()).toEqual(['a', 'c']);
    expect(pruneSelection(pruned, ['a', 'c', 'd'])).toBe(pruned);
    expect(selectionCount(pruneSelection(pruned, []))).toBe(0);
  });
});
