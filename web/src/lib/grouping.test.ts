import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { countByColumn, dropTarget, groupCardsByColumn } from './grouping';

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

describe('dropTarget', () => {
  it('拖到某卡片上时返回它前一个卡片作为 afterId', () => {
    expect(dropTarget(['a', 'b', 'c'], 'c', 'b')).toEqual({ afterId: 'a' });
    expect(dropTarget(['a', 'b', 'c'], 'a', 'b')).toEqual({});
  });

  it('拖到列表末尾返回最后一个卡片作为 beforeId', () => {
    expect(dropTarget(['a', 'b'], 'x', null)).toEqual({ beforeId: 'b' });
    expect(dropTarget([], 'x', null)).toEqual({});
  });
});
