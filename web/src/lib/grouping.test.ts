import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { countByColumn, groupCardsByColumn, planCardDrop } from './grouping';

function makeCard(overrides: Partial<Card> & { id: string }): Card {
  return {
    boardId: 'board-default',
    title: overrides.id,
    summary: '',
    status: 'backlog',
    priority: 'none',
    labels: [],
    sessionIds: [],
    checklists: [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0 },
    order: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('groupCardsByColumn', () => {
  it('按契约把 blocked/failed 归入 needs_you，canceled 归入 done', () => {
    const groups = groupCardsByColumn([
      makeCard({ id: 'a', status: 'blocked' }),
      makeCard({ id: 'b', status: 'failed' }),
      makeCard({ id: 'c', status: 'canceled' }),
      makeCard({ id: 'd', status: 'running' }),
    ]);
    expect(groups.needs_you.map((card) => card.id)).toEqual(['a', 'b']);
    expect(groups.done.map((card) => card.id)).toEqual(['c']);
    expect(groups.running.map((card) => card.id)).toEqual(['d']);
  });

  it('列内顺序优先 cardOrder，未列出的卡片按 updatedAt 倒序兜底', () => {
    const cards = [
      makeCard({ id: 'old', status: 'backlog', updatedAt: 10 }),
      makeCard({ id: 'new', status: 'backlog', updatedAt: 30 }),
      makeCard({ id: 'mid', status: 'backlog', updatedAt: 20 }),
    ];
    const groups = groupCardsByColumn(cards, { backlog: ['mid', 'new'] });
    expect(groups.backlog.map((card) => card.id)).toEqual(['mid', 'new', 'old']);
  });

  it('忽略归档卡片', () => {
    const groups = groupCardsByColumn([
      makeCard({ id: 'archived', archived: true }),
      makeCard({ id: 'kept' }),
    ]);
    expect(groups.backlog.map((card) => card.id)).toEqual(['kept']);
  });

  it('空输入返回四个空列', () => {
    expect(groupCardsByColumn([])).toEqual({ backlog: [], running: [], needs_you: [], done: [] });
  });
});

describe('countByColumn', () => {
  it('统计四列数量并忽略归档', () => {
    const counts = countByColumn([
      makeCard({ id: '1', status: 'running' }),
      makeCard({ id: '2', status: 'needs_you' }),
      makeCard({ id: '3', status: 'blocked' }),
      makeCard({ id: '4', status: 'done' }),
      makeCard({ id: '5', status: 'backlog', archived: true }),
    ]);
    expect(counts).toEqual({ backlog: 0, running: 1, needs_you: 2, done: 1 });
  });
});

describe('planCardDrop', () => {
  type Context = Parameters<typeof planCardDrop>[0];
  const ctx = (over: Partial<Context>): Context => ({
    ids: ['a', 'b', 'c'],
    draggedId: 'b',
    targetId: null,
    sameColumn: true,
    column: 'backlog',
    ...over,
  });

  it('拖到某张卡片上：插到该卡片前（前一张卡作为 afterId）', () => {
    expect(planCardDrop(ctx({ sameColumn: false, draggedId: 'x', targetId: 'c' }))).toEqual({ afterId: 'b' });
    expect(planCardDrop(ctx({ sameColumn: false, draggedId: 'x', targetId: 'a' }))).toEqual({});
  });

  it('同列拖回原处 / 拖到后一张卡：放回原位（null，不请求）', () => {
    expect(planCardDrop(ctx({ draggedId: 'b', targetId: 'b' }))).toBeNull();
    expect(planCardDrop(ctx({ draggedId: 'b', targetId: 'c' }))).toBeNull();
    expect(planCardDrop(ctx({ draggedId: 'a', ids: ['a', 'b'], targetId: 'a' }))).toBeNull();
  });

  it('同列拖到前面的卡片：上移一位', () => {
    expect(planCardDrop(ctx({ draggedId: 'c', targetId: 'b' }))).toEqual({ afterId: 'a' });
    expect(planCardDrop(ctx({ draggedId: 'b', targetId: 'a' }))).toEqual({});
  });

  it('同列落到空白区：已完成列放回原位，其他列落到真正末尾', () => {
    expect(planCardDrop(ctx({ draggedId: 'b', targetId: null, column: 'done' }))).toBeNull();
    expect(planCardDrop(ctx({ draggedId: 'c', targetId: null, column: 'done' }))).toBeNull();
    expect(planCardDrop(ctx({ draggedId: 'b', targetId: null, column: 'backlog' }))).toEqual({ afterId: 'c' });
    // 已在末尾：落回原位，不请求
    expect(planCardDrop(ctx({ draggedId: 'c', targetId: null, column: 'running' }))).toBeNull();
    expect(planCardDrop(ctx({ ids: ['only'], draggedId: 'only', targetId: null, column: 'backlog' }))).toBeNull();
  });

  it('跨列落到空白区：已完成列插到列头（最近完成可见），其他列插到末尾', () => {
    expect(planCardDrop(ctx({ sameColumn: false, ids: ['a', 'b'], draggedId: 'x', column: 'done' }))).toEqual({});
    expect(planCardDrop(ctx({ sameColumn: false, ids: ['a', 'b'], draggedId: 'x', column: 'running' }))).toEqual({
      afterId: 'b',
    });
    expect(planCardDrop(ctx({ sameColumn: false, ids: [], draggedId: 'x', column: 'running' }))).toEqual({});
  });

  it('跨列拖到已完成列的某张卡片上：插到该卡片前', () => {
    expect(planCardDrop(ctx({ sameColumn: false, ids: ['a', 'b'], draggedId: 'x', targetId: 'b', column: 'done' }))).toEqual({
      afterId: 'a',
    });
  });

  it('目标卡片已不在列表（并发刷新）：按空白区规则兜底', () => {
    expect(
      planCardDrop(ctx({ sameColumn: false, ids: ['a', 'b'], draggedId: 'x', targetId: 'gone', column: 'running' })),
    ).toEqual({ afterId: 'b' });
    expect(planCardDrop(ctx({ ids: ['a', 'b'], draggedId: 'a', targetId: 'gone', column: 'done' }))).toBeNull();
  });
});
