import { describe, expect, it } from 'vitest';
import type { Card, SessionActivityEntry } from '../types';
import type { NativePendingItem } from './nativeInbox';
import {
  derivePendingSessionIds,
  deriveRunningSessionIds,
  doneBatchPreview,
  formatTitleList,
  isTerminalCardStatus,
  normalizeSessionIdList,
  normalizeSkipReason,
  parseBlockingCards,
  parseSessionActivity,
  sessionArchiveReadiness,
  summarizeSessionActivity,
  summarizeSessionArchiveBlocker,
} from './sessionArchive';

function card(overrides: Partial<Card> & { id: string }): Card {
  return {
    boardId: 'board-default',
    title: overrides.title ?? overrides.id,
    summary: '',
    status: 'done',
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
  } as Card;
}

const NO_IDS: ReadonlySet<string> = new Set();

function readiness(
  overrides: Partial<Parameters<typeof sessionArchiveReadiness>[0]> & {
    card: Card;
    sessionId: string;
    cards: Card[];
  },
) {
  return sessionArchiveReadiness({
    archivedSessionIds: NO_IDS,
    runningSessionIds: NO_IDS,
    pendingSessionIds: NO_IDS,
    available: true,
    ...overrides,
  });
}

describe('isTerminalCardStatus', () => {
  it('done / canceled 为终态，其余不是', () => {
    expect(isTerminalCardStatus('done')).toBe(true);
    expect(isTerminalCardStatus('canceled')).toBe(true);
    for (const status of ['backlog', 'running', 'needs_you', 'blocked', 'failed'] as const) {
      expect(isTerminalCardStatus(status)).toBe(false);
    }
  });
});

describe('sessionArchiveReadiness', () => {
  it('完成卡绑定空闲会话且无其它卡 → 可归档', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'] });
    const result = readiness({ card: target, sessionId: 's1', cards: [target] });
    expect(result.archived).toBe(false);
    expect(result.cardTerminal).toBe(true);
    expect(result.archivable).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.blockingCards).toEqual([]);
  });

  it('canceled 卡同样可归档', () => {
    const target = card({ id: 'card-a', status: 'canceled', sessionIds: ['s1'] });
    expect(readiness({ card: target, sessionId: 's1', cards: [target] }).archivable).toBe(true);
  });

  it('反向依赖：同一会话还有未完成卡片 → 阻止并列出卡片', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'] });
    const other = card({ id: 'card-b', status: 'running', sessionIds: ['s1'] });
    const result = readiness({ card: target, sessionId: 's1', cards: [target, other] });
    expect(result.archivable).toBe(false);
    expect(result.blockers[0]?.kind).toBe('card');
    expect(result.blockingCards.map((item) => item.id)).toEqual(['card-b']);
    expect(summarizeSessionArchiveBlocker(result.blockers)).toEqual({
      kind: 'card',
      count: 1,
      titles: ['card-b'],
    });
  });

  it('反向依赖只看未归档卡片：已归档卡即使未完成也不阻止', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'] });
    const archivedCard = card({ id: 'card-b', status: 'running', sessionIds: ['s1'], archived: true });
    expect(readiness({ card: target, sessionId: 's1', cards: [target, archivedCard] }).archivable).toBe(true);
  });

  it('其它卡片绑定了别的会话不影响判定', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'] });
    const other = card({ id: 'card-b', status: 'backlog', sessionIds: ['s2'] });
    expect(readiness({ card: target, sessionId: 's1', cards: [target, other] }).archivable).toBe(true);
  });

  it('触发卡未完成（running）→ 不可归档，blocker 带上触发卡', () => {
    const target = card({ id: 'card-a', status: 'running', sessionIds: ['s1'] });
    const result = readiness({ card: target, sessionId: 's1', cards: [target] });
    expect(result.cardTerminal).toBe(false);
    expect(result.archivable).toBe(false);
    expect(result.blockers[0]).toEqual({ kind: 'card', cards: [target] });
  });

  it('cards 不含触发卡时 R1 仍然生效', () => {
    const target = card({ id: 'card-a', status: 'blocked', sessionIds: ['s1'] });
    const result = readiness({ card: target, sessionId: 's1', cards: [] });
    expect(result.archivable).toBe(false);
    expect(result.blockers[0]?.kind).toBe('card');
  });

  it('会话在运行集合中 → 阻止（running）', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'] });
    const result = readiness({
      card: target,
      sessionId: 's1',
      cards: [target],
      runningSessionIds: new Set(['s1']),
    });
    expect(result.archivable).toBe(false);
    expect(result.blockers.map((item) => item.kind)).toEqual(['running']);
  });

  it('会话有待确认项 → 阻止（pending）', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'] });
    const result = readiness({
      card: target,
      sessionId: 's1',
      cards: [target],
      pendingSessionIds: new Set(['s1']),
    });
    expect(result.blockers.map((item) => item.kind)).toEqual(['pending']);
  });

  it('宿主不支持可逆归档 → 阻止（host）', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'] });
    const result = readiness({ card: target, sessionId: 's1', cards: [target], available: false });
    expect(result.archivable).toBe(false);
    expect(result.blockers.map((item) => item.kind)).toEqual(['host']);
  });

  it('已归档会话 → archived=true 且不可再归档', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'] });
    const result = readiness({
      card: target,
      sessionId: 's1',
      cards: [target],
      archivedSessionIds: new Set(['s1']),
    });
    expect(result.archived).toBe(true);
    expect(result.archivable).toBe(false);
  });

  it('多种阻止原因按 card → running → pending → host 排序', () => {
    const target = card({ id: 'card-a', status: 'running', sessionIds: ['s1'] });
    const result = readiness({
      card: target,
      sessionId: 's1',
      cards: [target],
      runningSessionIds: new Set(['s1']),
      pendingSessionIds: new Set(['s1']),
      available: false,
    });
    expect(result.blockers.map((item) => item.kind)).toEqual(['card', 'running', 'pending', 'host']);
  });

  it('卡片已归档时不能作为触发卡', () => {
    const target = card({ id: 'card-a', sessionIds: ['s1'], archived: true });
    const result = readiness({ card: target, sessionId: 's1', cards: [target] });
    expect(result.cardTerminal).toBe(false);
    expect(result.archivable).toBe(false);
  });
});

describe('summarizeSessionArchiveBlocker', () => {
  it('空数组返回 null', () => {
    expect(summarizeSessionArchiveBlocker([])).toBeNull();
  });

  it('非 card 原因只返回类别', () => {
    expect(summarizeSessionArchiveBlocker([{ kind: 'running' }])).toEqual({ kind: 'running' });
  });
});

describe('doneBatchPreview', () => {
  it('按会话去重，多个终态卡共享会话只出现一次', () => {
    const a = card({ id: 'card-a', sessionIds: ['s1'] });
    const b = card({ id: 'card-b', sessionIds: ['s1', 's2'] });
    const preview = doneBatchPreview({
      cards: [a, b],
      archivedSessionIds: NO_IDS,
      runningSessionIds: NO_IDS,
      pendingSessionIds: NO_IDS,
      available: true,
    });
    expect(preview.archivable).toEqual([
      { sessionId: 's1', cardId: 'card-a' },
      { sessionId: 's2', cardId: 'card-b' },
    ]);
    expect(preview.skipped).toEqual([]);
  });

  it('已归档会话进入 skipped(already_archived)，未完成任务卡上的会话不成为候选', () => {
    const a = card({ id: 'card-a', sessionIds: ['s1', 's2'] });
    const running = card({ id: 'card-b', status: 'running', sessionIds: ['s3'] });
    const preview = doneBatchPreview({
      cards: [a, running],
      archivedSessionIds: new Set(['s2']),
      runningSessionIds: NO_IDS,
      pendingSessionIds: NO_IDS,
      available: true,
    });
    expect(preview.archivable).toEqual([{ sessionId: 's1', cardId: 'card-a' }]);
    expect(preview.skipped).toEqual([
      { sessionId: 's2', cardId: 'card-a', kind: 'archived', blockingCards: [] },
    ]);
  });

  it('有未完成反向依赖的会话进入 skipped 并给出 kind/cards', () => {
    const done = card({ id: 'card-a', sessionIds: ['s1'] });
    const running = card({ id: 'card-b', status: 'running', sessionIds: ['s1'] });
    const preview = doneBatchPreview({
      cards: [done, running],
      archivedSessionIds: NO_IDS,
      runningSessionIds: NO_IDS,
      pendingSessionIds: NO_IDS,
      available: true,
    });
    expect(preview.archivable).toEqual([]);
    expect(preview.skipped).toHaveLength(1);
    expect(preview.skipped[0]).toMatchObject({
      sessionId: 's1',
      cardId: 'card-a',
      kind: 'card',
      blockingCards: [{ id: 'card-b', title: 'card-b', status: 'running' }],
    });
  });

  it('运行中 / 待确认 / 宿主不支持分别产生 skipped', () => {
    const a = card({ id: 'card-a', sessionIds: ['s1'] });
    const b = card({ id: 'card-b', sessionIds: ['s2'] });
    const c = card({ id: 'card-c', sessionIds: ['s3'] });
    const preview = doneBatchPreview({
      cards: [a, b, c],
      archivedSessionIds: NO_IDS,
      runningSessionIds: new Set(['s1']),
      pendingSessionIds: new Set(['s2']),
      available: false,
    });
    expect(preview.archivable).toEqual([]);
    expect(preview.skipped.map((item) => item.kind)).toEqual(['running', 'pending', 'host']);
    // available=false 让每个会话都追加 host；第一条原因按 running → pending → host 排序。
    expect(preview.skipped.map((item) => item.sessionId)).toEqual(['s1', 's2', 's3']);
  });

  it('卡片已归档时不参与候选', () => {
    const a = card({ id: 'card-a', sessionIds: ['s1'], archived: true });
    const preview = doneBatchPreview({
      cards: [a],
      archivedSessionIds: NO_IDS,
      runningSessionIds: NO_IDS,
      pendingSessionIds: NO_IDS,
      available: true,
    });
    expect(preview.archivable).toEqual([]);
    expect(preview.skipped).toEqual([]);
  });

  it('宿主 available=false 时全部 skipped 为 host', () => {
    const a = card({ id: 'card-a', sessionIds: ['s1'] });
    const preview = doneBatchPreview({
      cards: [a],
      archivedSessionIds: NO_IDS,
      runningSessionIds: NO_IDS,
      pendingSessionIds: NO_IDS,
      available: false,
    });
    expect(preview.skipped).toEqual([
      { sessionId: 's1', cardId: 'card-a', kind: 'host', blockingCards: [] },
    ]);
  });
});

describe('集合派生', () => {
  it('deriveRunningSessionIds 只收 running', () => {
    const ids = deriveRunningSessionIds([
      { id: 's1', running: true },
      { id: 's2', running: false },
    ]);
    expect([...ids]).toEqual(['s1']);
  });

  it('derivePendingSessionIds 收所有待确认项会话并去重', () => {
    const items = [
      { sessionId: 's1' },
      { sessionId: 's1' },
      { sessionId: 's2' },
    ] as Pick<NativePendingItem, 'sessionId'>[];
    expect([...derivePendingSessionIds(items)].sort()).toEqual(['s1', 's2']);
  });

  it('normalizeSessionIdList 过滤非字符串/空值并去重', () => {
    expect(normalizeSessionIdList([' a ', 'a', '', 42, null, 'b'])).toEqual(['a', 'b']);
    expect(normalizeSessionIdList(undefined)).toEqual([]);
    expect(normalizeSessionIdList('a')).toEqual([]);
  });
});

describe('错误详情解析', () => {
  it('parseSessionActivity 只保留合法 kind 并归一化 items', () => {
    const activity = parseSessionActivity([
      { kind: 'turn' },
      { kind: 'job', items: [{ id: 'j1', label: '构建' }, { id: 2 }] },
      { kind: 'subagent', items: [{ id: 'a1' }] },
      { kind: 'schedule', items: [] },
      { kind: 'unknown' },
      null,
      'x',
    ]);
    expect(activity).toEqual([
      { kind: 'turn' },
      { kind: 'job', items: [{ id: 'j1', label: '构建' }] },
      { kind: 'subagent', items: [{ id: 'a1' }] },
      { kind: 'schedule' },
    ]);
  });

  it('parseSessionActivity 对非数组返回空', () => {
    expect(parseSessionActivity(undefined)).toEqual([]);
    expect(parseSessionActivity({ activity: [] })).toEqual([]);
  });

  it('parseBlockingCards 归一化缺省标题', () => {
    expect(parseBlockingCards([{ id: 'card-a', title: 'A', status: 'running' }, { id: 'card-b' }, { title: 'x' }])).toEqual([
      { id: 'card-a', title: 'A', status: 'running' },
      { id: 'card-b', title: 'card-b', status: 'unknown' },
    ]);
  });

  it('normalizeSkipReason 兼容错误码与中英文案', () => {
    expect(normalizeSkipReason('SESSION_BUSY_CARDS')).toBe('card');
    expect(normalizeSkipReason('blocking_cards')).toBe('card');
    expect(normalizeSkipReason('还有未完成卡片')).toBe('card');
    expect(normalizeSkipReason('SESSION_ACTIVE')).toBe('running');
    expect(normalizeSkipReason('running')).toBe('running');
    expect(normalizeSkipReason('会话运行中')).toBe('running');
    expect(normalizeSkipReason('SESSION_ACTIVE_PENDING')).toBe('running');
    expect(normalizeSkipReason('pending')).toBe('pending');
    expect(normalizeSkipReason('有待确认')).toBe('pending');
    expect(normalizeSkipReason('SESSION_ARCHIVE_UNAVAILABLE')).toBe('host');
    expect(normalizeSkipReason('宿主不支持')).toBe('host');
    expect(normalizeSkipReason('already_archived')).toBe('archived');
    expect(normalizeSkipReason('missing')).toBe('missing');
    expect(normalizeSkipReason('会话不存在')).toBe('missing');
    expect(normalizeSkipReason('failed')).toBe('failed');
    expect(normalizeSkipReason('归档失败')).toBe('failed');
    expect(normalizeSkipReason('whatever')).toBe('other');
  });
});

describe('formatTitleList', () => {
  it('中文用顿号，英文用逗号，空标题过滤', () => {
    expect(formatTitleList(['A', 'B'], 'zh')).toBe('A、B');
    expect(formatTitleList(['A', 'B'], 'en')).toBe('A, B');
    expect(formatTitleList(['', 'B'], 'zh')).toBe('B');
    expect(formatTitleList([], 'zh')).toBe('');
  });

  it('超过上限时截断并给出总数', () => {
    expect(formatTitleList(['A', 'B', 'C', 'D', 'E'], 'zh')).toBe('A、B、C 等 5 项');
    expect(formatTitleList(['A', 'B', 'C', 'D'], 'en')).toBe('A, B, C +1 more');
    expect(formatTitleList(['A', 'B', 'C', 'D'], 'zh', 2)).toBe('A、B 等 4 项');
  });
});

describe('summarizeSessionActivity', () => {
  it('turn 计 1，job/subagent/schedule 按 items 计数', () => {
    const activity: SessionActivityEntry[] = [
      { kind: 'turn' },
      { kind: 'job', items: [{ id: 'j1', label: '构建' }, { id: 'j2', label: '测试' }] },
      { kind: 'schedule' },
    ];
    expect(summarizeSessionActivity(activity)).toEqual([
      { kind: 'turn', count: 1, labels: [] },
      { kind: 'job', count: 2, labels: ['构建', '测试'] },
      { kind: 'schedule', count: 1, labels: [] },
    ]);
  });
});
