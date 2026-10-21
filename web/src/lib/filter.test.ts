import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { EMPTY_FILTERS, extractLabels, extractProjects, filterCards, hasActiveFilters } from './filter';

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

const cards = [
  makeCard({ id: 'a', title: '实现 SSE 重连', summary: '退避 1s→30s', project: 'dsh-kanban', labels: ['ui', 'realtime'] }),
  makeCard({ id: 'b', title: '迁移 users 表', summary: 'Postgres 17', project: 'backend', labels: ['db'] }),
  makeCard({ id: 'c', title: '无关卡片', summary: '', project: 'dsh-kanban', labels: ['ui'] }),
  makeCard({ id: 'd', title: '已归档', archived: true, project: 'dsh-kanban', labels: ['ui'] }),
];

describe('filterCards', () => {
  it('无筛选时返回全部未归档卡片', () => {
    expect(filterCards(cards, EMPTY_FILTERS).map((card) => card.id)).toEqual(['a', 'b', 'c']);
  });

  it('搜索命中标题（大小写不敏感）', () => {
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: 'sse' }).map((card) => card.id)).toEqual(['a']);
  });

  it('搜索命中摘要、项目、标签', () => {
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: 'postgres' }).map((card) => card.id)).toEqual(['b']);
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: 'backend' }).map((card) => card.id)).toEqual(['b']);
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: 'REALTIME' }).map((card) => card.id)).toEqual(['a']);
  });

  it('项目 + 标签筛选是 AND 关系', () => {
    expect(filterCards(cards, { query: '', project: 'dsh-kanban', label: 'ui' }).map((card) => card.id)).toEqual([
      'a',
      'c',
    ]);
    expect(filterCards(cards, { query: '', project: 'backend', label: 'ui' })).toEqual([]);
  });

  it('query 首尾空白不影响匹配', () => {
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: '  迁移  ' }).map((card) => card.id)).toEqual(['b']);
  });
});

describe('筛选项提取', () => {
  it('项目去重排序且忽略归档', () => {
    expect(extractProjects(cards)).toEqual(['backend', 'dsh-kanban']);
  });

  it('标签去重排序且忽略归档', () => {
    expect(extractLabels(cards)).toEqual(['db', 'realtime', 'ui']);
  });

  it('hasActiveFilters', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, query: ' ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, label: 'ui' })).toBe(true);
  });
});
