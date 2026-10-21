import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { doneCardsOf, groupCardsForList, previewDone } from './listGroups';

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

const cards: Card[] = [
  makeCard({ id: 'a', status: 'running', project: 'alpha', priority: 'high', updatedAt: 30 }),
  makeCard({ id: 'b', status: 'backlog', project: 'beta', priority: 'urgent', updatedAt: 20 }),
  makeCard({ id: 'c', status: 'done', project: 'alpha', priority: 'low', updatedAt: 10 }),
  makeCard({ id: 'd', status: 'needs_you', project: undefined, priority: 'none', updatedAt: 40 }),
  makeCard({ id: 'e', status: 'done', project: 'beta', priority: 'medium', updatedAt: 50 }),
  makeCard({ id: 'f', status: 'done', archived: true, project: 'alpha' }),
];

describe('groupCardsForList', () => {
  it('状态分组保持四列顺序并忽略归档', () => {
    const groups = groupCardsForList(cards, 'status');
    expect(groups.map((group) => group.key)).toEqual([
      'status:backlog',
      'status:running',
      'status:needs_you',
      'status:done',
    ]);
    expect(groups.find((group) => group.key === 'status:done')?.count).toBe(2);
  });

  it('项目分组：项目名排序，无项目在最后', () => {
    const groups = groupCardsForList(cards, 'project');
    expect(groups.map((group) => group.label)).toEqual(['alpha', 'beta', '']);
    expect(groups[0]?.cards.map((card) => card.id)).toEqual(['a', 'c']);
  });

  it('优先级分组：紧急→高→中→低→无', () => {
    const groups = groupCardsForList(cards, 'priority');
    expect(groups.map((group) => group.key)).toEqual([
      'priority:urgent',
      'priority:high',
      'priority:medium',
      'priority:low',
      'priority:none',
    ]);
  });
});

describe('done 预览', () => {
  it('doneCardsOf 只取未归档的已完成/已取消卡片', () => {
    expect(doneCardsOf(cards).map((card) => card.id).sort()).toEqual(['c', 'e']);
  });

  it('previewDone 最多 5 张并返回剩余数量', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      makeCard({ id: `done-${index}`, status: 'done', updatedAt: index }),
    );
    const { visible, rest } = previewDone(many);
    expect(visible).toHaveLength(5);
    expect(rest).toBe(3);
  });
});
