import { describe, expect, it } from 'vitest';
import type { Activity } from '../types';
import {
  applyPage,
  mergeActivityPages,
  needsInitialFeed,
  visibleActivities,
  EMPTY_FEED,
} from './activities';

function activity(id: string, at: number): Activity {
  return { id, cardId: 'card-a', type: 'progress', actor: { kind: 'agent', name: 'DSH Agent' }, text: id, at };
}

describe('mergeActivityPages', () => {
  it('按 id 去重并按时间倒序', () => {
    const merged = mergeActivityPages([activity('a', 100), activity('b', 200)], [activity('b', 200), activity('c', 300)]);
    expect(merged.map((item) => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('reset 时丢弃旧数据', () => {
    const merged = mergeActivityPages([activity('a', 100)], [activity('c', 300)], { reset: true });
    expect(merged.map((item) => item.id)).toEqual(['c']);
  });
});

describe('applyPage', () => {
  it('合并分页并保留 hasMore/nextBefore', () => {
    const feed = applyPage({ ...EMPTY_FEED, items: [activity('b', 200)] }, {
      activities: [activity('a', 100), activity('c', 300)],
      hasMore: true,
      nextBefore: 'a',
    });
    expect(feed.items.map((item) => item.id)).toEqual(['c', 'b', 'a']);
    expect(feed.hasMore).toBe(true);
    expect(feed.nextBefore).toBe('a');
    expect(feed.loading).toBe(false);
  });

  it('没有 hasMore 的老服务端视为到底', () => {
    const feed = applyPage(EMPTY_FEED, { activities: [activity('a', 1)], hasMore: false });
    expect(feed.hasMore).toBe(false);
  });
});

describe('needsInitialFeed / visibleActivities', () => {
  it('空 feed 需要首屏拉取', () => {
    expect(needsInitialFeed(undefined)).toBe(true);
    expect(needsInitialFeed(EMPTY_FEED)).toBe(true);
    expect(needsInitialFeed({ ...EMPTY_FEED, items: [activity('a', 1)] })).toBe(false);
  });

  it('按可见条数截取最近节点', () => {
    const feed = { ...EMPTY_FEED, items: [activity('a', 3), activity('b', 2), activity('c', 1)] };
    expect(visibleActivities(feed, 3).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(visibleActivities(feed, 2).map((item) => item.id)).toEqual(['a', 'b']);
  });
});
