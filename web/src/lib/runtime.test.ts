import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import {
  collectBoardHygieneCandidates,
  describeCardRuntime,
  shouldShowHygieneNudge,
} from './runtime';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: overrides.id ?? 'card_1',
    boardId: 'default',
    title: overrides.title ?? '测试卡片',
    summary: '',
    status: overrides.status ?? 'backlog',
    priority: overrides.priority ?? 'medium',
    labels: overrides.labels ?? [],
    sessionIds: overrides.sessionIds ?? [],
    approvals: [],
    checklists: [],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0 },
    createdAt: 1000,
    updatedAt: overrides.updatedAt ?? 1000,
    archived: overrides.archived ?? false,
    order: overrides.order ?? 1,
    version: 1,
    ...overrides,
  };
}

describe('describeCardRuntime', () => {
  it('identifies autoStart, upstream handoff, wait condition, and watchdog states', () => {
    const now = 100_000;
    const card = makeCard({
      status: 'running',
      sessionIds: ['sess_1'],
      autoStart: true,
      handoff: {
        summary: '上游接力摘要：\n- 契约卡片：已完成',
        at: 90_000,
      },
      runtime: {
        generation: 3,
        budget: { nudgesUsed: 1, retriesUsed: 0, lastAutoActionAt: 95_000 },
        waitCondition: {
          kind: 'time',
          notBefore: 160_000,
          reason: '等待 CI',
        },
      },
    });
    const info = describeCardRuntime(card, now);
    expect(info.autoStart).toBe(true);
    expect(info.isUpstreamHandoff).toBe(true);
    expect(info.generation).toBe(3);
    expect(info.nudgesUsed).toBe(1);
    expect(info.watchdogState).toBe('nudged');
    expect(info.waitActive).toEqual({
      notBefore: 160_000,
      remainingMs: 60_000,
      reason: '等待 CI',
    });
  });

  it('reports stalled and retry_exhausted when blocked or failed', () => {
    const stalled = describeCardRuntime(
      makeCard({
        status: 'blocked',
        runtime: { generation: 2, budget: { nudgesUsed: 1, retriesUsed: 0, lastAutoActionAt: 90_000 } },
      }),
      100_000,
    );
    expect(stalled.watchdogState).toBe('stalled');

    const exhausted = describeCardRuntime(
      makeCard({
        status: 'failed',
        runtime: { generation: 2, budget: { nudgesUsed: 0, retriesUsed: 2, lastAutoActionAt: 90_000 } },
      }),
      100_000,
    );
    expect(exhausted.watchdogState).toBe('retry_exhausted');
  });
});

describe('collectBoardHygieneCandidates & shouldShowHygieneNudge', () => {
  it('collects merged cards and stale done cards older than 3 days', () => {
    const now = 10 * 86_400_000;
    const cards: Card[] = [
      makeCard({ id: 'c_active', status: 'running', updatedAt: now - 1000 }),
      makeCard({ id: 'c_merged', status: 'backlog', mergedInto: 'c_active', updatedAt: now - 1000 }),
      makeCard({ id: 'c_old_done', status: 'done', completedAt: now - 4 * 86_400_000, updatedAt: now - 4 * 86_400_000 }),
      makeCard({ id: 'c_fresh_done', status: 'done', completedAt: now - 1000, updatedAt: now - 1000 }),
    ];

    const plan = collectBoardHygieneCandidates(cards, now, 3);
    expect(plan.mergedCount).toBe(1);
    expect(plan.staleDoneCount).toBe(1);
    expect(plan.archivableIds).toEqual(['c_merged', 'c_old_done']);
    expect(shouldShowHygieneNudge(plan.archivableIds.length, null, now)).toBe(true);
    expect(shouldShowHygieneNudge(plan.archivableIds.length, now - 1000, now)).toBe(false);
  });
});
