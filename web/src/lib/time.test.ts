import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { elapsedMs, formatDateTime, formatDuration, formatRelative } from './time';

function makeCard(overrides: Partial<Card> & { id: string }): Card {
  return {
    boardId: 'board-default',
    title: overrides.id,
    summary: '',
    status: 'running',
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

describe('formatDuration', () => {
  it('中文按 分/秒 展示', () => {
    expect(formatDuration(0, 'zh')).toBe('0 秒');
    expect(formatDuration(6 * 60_000 + 48_000, 'zh')).toBe('6 分 48 秒');
    expect(formatDuration(2 * 3600_000 + 5 * 60_000, 'zh')).toBe('2 小时 5 分');
  });

  it('英文用 6m 48s 形式', () => {
    expect(formatDuration(6 * 60_000 + 48_000, 'en')).toBe('6m 48s');
    expect(formatDuration(45_000, 'en')).toBe('45s');
    expect(formatDuration(3 * 3600_000, 'en')).toBe('3h 0m');
  });

  it('小于 1 秒给出可读文案', () => {
    expect(formatDuration(400, 'en')).toBe('<1s');
    expect(formatDuration(400, 'zh')).toBe('不到 1 秒');
  });
});

describe('elapsedMs', () => {
  it('优先使用 metadata.elapsedMs', () => {
    const card = makeCard({ id: 'a', metadata: { toolCalls: 0, searches: 0, elapsedMs: 1234 }, startedAt: 0 });
    expect(elapsedMs(card, 999_999)).toBe(1234);
  });

  it('运行中卡片按 now 计算', () => {
    const card = makeCard({ id: 'a', startedAt: 1_000 });
    expect(elapsedMs(card, 61_000)).toBe(60_000);
  });

  it('已完成卡片以 completedAt 封顶', () => {
    const card = makeCard({ id: 'a', status: 'done', startedAt: 1_000, completedAt: 31_000, updatedAt: 99_000 });
    expect(elapsedMs(card, 200_000)).toBe(30_000);
  });

  it('没有 startedAt 时返回 0', () => {
    expect(elapsedMs(makeCard({ id: 'a' }), 10_000)).toBe(0);
  });
});

describe('formatRelative', () => {
  const now = 10 * 3600_000;
  it('分钟 / 小时 / 天', () => {
    expect(formatRelative(now - 30_000, now, 'zh')).toBe('刚刚');
    expect(formatRelative(now - 5 * 60_000, now, 'zh')).toBe('5 分钟前');
    expect(formatRelative(now - 3 * 3600_000, now, 'zh')).toBe('3 小时前');
    expect(formatRelative(now - 2 * 86400_000, now, 'zh')).toBe('2 天前');
    expect(formatRelative(now - 5 * 60_000, now, 'en')).toBe('5m ago');
  });
});

describe('formatDateTime', () => {
  it('固定 YYYY-MM-DD HH:mm 形态', () => {
    const at = new Date(2026, 9, 21, 8, 48).getTime();
    expect(formatDateTime(at)).toBe('2026-10-21 08:48');
  });
});
