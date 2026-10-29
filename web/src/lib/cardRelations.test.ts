import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import {
  buildCardRelationIndex,
  childCardsOf,
  describeChildren,
  describeDepends,
  extractOpenChildren,
  isClosedStatus,
  isCompleteBlockedError,
  isDependencyReady,
  mergedTargetOf,
  normalizeOpenChildren,
  parentCardOf,
} from './cardRelations';

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

describe('buildCardRelationIndex', () => {
  it('按 parentCardId 建 childrenByParent，只收未归档子卡', () => {
    const index = buildCardRelationIndex([
      makeCard({ id: 'parent' }),
      makeCard({ id: 'child-a', parentCardId: 'parent', status: 'running' }),
      makeCard({ id: 'child-b', parentCardId: 'parent', status: 'done' }),
      makeCard({ id: 'archived-child', parentCardId: 'parent', archived: true }),
    ]);
    expect(index.childrenByParent.get('parent')?.map((card) => card.id)).toEqual(['child-a', 'child-b']);
  });

  it('按 dependsOn 反查 dependentByDep（去重、跳过自身与非法值）', () => {
    const index = buildCardRelationIndex([
      makeCard({ id: 'dep-a' }),
      makeCard({ id: 'dep-b' }),
      makeCard({
        id: 'waiter',
        dependsOn: ['dep-a', 'dep-a', 'dep-b', 'waiter', 42 as unknown as string],
      }),
    ]);
    expect(index.dependentByDep.get('dep-a')?.map((card) => card.id)).toEqual(['waiter']);
    expect(index.dependentByDep.get('dep-b')?.map((card) => card.id)).toEqual(['waiter']);
    expect(index.dependentByDep.get('waiter')).toBeUndefined();
  });

  it('重复 id 只保留第一张', () => {
    const index = buildCardRelationIndex([
      makeCard({ id: 'dup', title: '第一张' }),
      makeCard({ id: 'dup', title: '第二张' }),
    ]);
    expect(index.cardsById.size).toBe(1);
    expect(index.cardsById.get('dup')?.title).toBe('第一张');
  });

  it('缺失/非数组输入返回空索引，不崩溃', () => {
    expect(buildCardRelationIndex(undefined).cardsById.size).toBe(0);
    expect(buildCardRelationIndex(null).childrenByParent.size).toBe(0);
    // 脏卡片（没有 id / 不是对象）被跳过
    const index = buildCardRelationIndex([{} as Card, makeCard({ id: 'ok' })]);
    expect(index.cardsById.has('ok')).toBe(true);
    expect(index.cardsById.size).toBe(1);
  });
});

describe('describeChildren', () => {
  const cards = [
    makeCard({ id: 'parent' }),
    makeCard({ id: 'c1', parentCardId: 'parent', status: 'done' }),
    makeCard({ id: 'c2', parentCardId: 'parent', status: 'canceled' }),
    makeCard({ id: 'c3', parentCardId: 'parent', status: 'running' }),
    makeCard({ id: 'c4', parentCardId: 'parent', status: 'needs_you' }),
    makeCard({ id: 'unrelated' }),
  ];
  const index = buildCardRelationIndex(cards);

  it('统计 total/done/open（done 含 canceled），并给出明细', () => {
    const summary = describeChildren(cards[0], index);
    expect(summary.total).toBe(4);
    expect(summary.done).toBe(2);
    expect(summary.open).toBe(2);
    expect(summary.items.map((item) => `${item.id}:${item.status}`)).toEqual([
      'c1:done',
      'c2:canceled',
      'c3:running',
      'c4:needs_you',
    ]);
  });

  it('没有子卡或卡片缺失时返回空汇总', () => {
    expect(describeChildren(makeCard({ id: 'unrelated' }), index)).toEqual({
      total: 0,
      done: 0,
      open: 0,
      items: [],
    });
    expect(describeChildren(undefined, index).total).toBe(0);
    expect(describeChildren(cards[0], undefined).total).toBe(0);
  });

  it('父子链成环（a→b→a）时不递归、不崩溃，只按直接子卡统计', () => {
    const cyclic = buildCardRelationIndex([
      makeCard({ id: 'a', parentCardId: 'b' }),
      makeCard({ id: 'b', parentCardId: 'a' }),
    ]);
    expect(describeChildren({ id: 'a' }, cyclic).items.map((item) => item.id)).toEqual(['b']);
    expect(describeChildren({ id: 'b' }, cyclic).items.map((item) => item.id)).toEqual(['a']);
    expect(childCardsOf({ id: 'missing' }, cyclic)).toEqual([]);
  });

  it('自引用 parentCardId 不会把自己当子卡', () => {
    const selfIndex = buildCardRelationIndex([makeCard({ id: 'self', parentCardId: 'self' })]);
    expect(childCardsOf({ id: 'self' }, selfIndex)).toEqual([]);
    expect(describeChildren({ id: 'self' }, selfIndex).total).toBe(0);
  });
});

describe('describeDepends / isDependencyReady', () => {
  const cards = [
    makeCard({ id: 'd1', status: 'done' }),
    makeCard({ id: 'd2', status: 'canceled' }),
    makeCard({ id: 'd3', status: 'running' }),
    makeCard({ id: 'waiter', dependsOn: ['d1', 'd3'] }),
  ];
  const index = buildCardRelationIndex(cards);
  const byId = index.cardsById;

  it('列出依赖卡状态与 ready（done/canceled 为已就绪）', () => {
    const items = describeDepends(cards[3], byId);
    expect(items).toEqual([
      { id: 'd1', title: 'd1', status: 'done', ready: true, missing: false },
      { id: 'd3', title: 'd3', status: 'running', ready: false, missing: false },
    ]);
  });

  it('依赖卡缺失（如已归档）时保留一行：status=null、ready=false', () => {
    const items = describeDepends({ id: 'waiter', dependsOn: ['gone'] }, byId);
    expect(items).toEqual([{ id: 'gone', title: 'gone', status: null, ready: false, missing: true }]);
  });

  it('全部依赖收口才就绪；无依赖视为就绪；自引用跳过', () => {
    expect(isDependencyReady({ id: 'x', dependsOn: ['d1', 'd2'] }, byId)).toBe(true);
    expect(isDependencyReady({ id: 'x', dependsOn: ['d1', 'd3'] }, byId)).toBe(false);
    expect(isDependencyReady({ id: 'x', dependsOn: ['gone'] }, byId)).toBe(false);
    expect(isDependencyReady({ id: 'x' }, byId)).toBe(true);
    expect(isDependencyReady({ id: 'x', dependsOn: ['x'] }, byId)).toBe(true);
    expect(describeDepends({ id: 'x', dependsOn: ['x'] }, byId)).toEqual([]);
    expect(describeDepends({ id: 'x' }, byId)).toEqual([]);
  });
});

describe('parentCardOf / mergedTargetOf', () => {
  const parent = makeCard({ id: 'parent', title: '父卡标题' });
  const target = makeCard({ id: 'target', title: '合并目标' });
  const byId = buildCardRelationIndex([parent, target]).cardsById;

  it('取父卡与合并去向；自引用/缺失返回 null', () => {
    expect(parentCardOf({ id: 'child', parentCardId: 'parent' }, byId)?.title).toBe('父卡标题');
    expect(parentCardOf({ id: 'child', parentCardId: 'child' }, byId)).toBeNull();
    expect(parentCardOf({ id: 'child', parentCardId: 'missing' }, byId)).toBeNull();
    expect(parentCardOf({ id: 'child' }, byId)).toBeNull();
    expect(mergedTargetOf({ id: 'source', mergedInto: 'target' }, byId)?.title).toBe('合并目标');
    expect(mergedTargetOf({ id: 'source' }, byId)).toBeNull();
  });
});

describe('完成拦截（CARD_HAS_OPEN_CHILDREN）', () => {
  it('归一化 openChildren：跳过脏数据、标题回落 id', () => {
    expect(
      normalizeOpenChildren([
        { id: 'card-a', title: '子卡 A', status: 'running' },
        { id: 'card-b' },
        { title: '没有 id' },
        null,
        'oops',
      ]),
    ).toEqual([
      { id: 'card-a', title: '子卡 A', status: 'running' },
      { id: 'card-b', title: 'card-b', status: 'unknown' },
    ]);
    expect(normalizeOpenChildren(undefined)).toEqual([]);
  });

  it('兼容顶层 openChildren / extra.openChildren / 字符串 id 数组', () => {
    expect(extractOpenChildren({ openChildren: [{ id: 'a', title: 'A', status: 'running' }] })).toHaveLength(1);
    expect(
      extractOpenChildren({ extra: { openChildren: [{ id: 'b', title: 'B', status: 'needs_you' }] } })[0]?.id,
    ).toBe('b');
    expect(extractOpenChildren({ data: { openChildren: ['card-z'] } })[0]).toEqual({
      id: 'card-z',
      title: 'card-z',
      status: 'unknown',
    });
    expect(extractOpenChildren(undefined)).toEqual([]);
    expect(extractOpenChildren('nope')).toEqual([]);
  });

  it('CARD_HAS_OPEN_CHILDREN / 409+openChildren 判定为完成拦截，其它错误不算', () => {
    expect(isCompleteBlockedError({ code: 'CARD_HAS_OPEN_CHILDREN', status: 409 })).toBe(true);
    expect(
      isCompleteBlockedError({
        code: 'CONFLICT',
        status: 409,
        details: { openChildren: [{ id: 'a' }] },
      }),
    ).toBe(true);
    expect(isCompleteBlockedError({ code: 'VERSION_CONFLICT', status: 409, details: {} })).toBe(false);
    expect(isCompleteBlockedError({ code: 'CARD_HAS_OPEN_CHILDREN', status: 409 })).toBe(true);
    expect(isCompleteBlockedError(new Error('boom'))).toBe(false);
    expect(isCompleteBlockedError(undefined)).toBe(false);
  });

  it('isClosedStatus 只认 done/canceled', () => {
    expect(isClosedStatus('done')).toBe(true);
    expect(isClosedStatus('canceled')).toBe(true);
    expect(isClosedStatus('running')).toBe(false);
    expect(isClosedStatus(null)).toBe(false);
    expect(isClosedStatus(undefined)).toBe(false);
  });
});
