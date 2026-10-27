import { afterEach, describe, expect, it, vi } from 'vitest';
import { KanbanApiError, api } from './api';

interface StubbedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(response: unknown, options: { status?: number } = {}): StubbedCall[] {
  const calls: StubbedCall[] = [];
  const status = options.status ?? 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => response,
      } as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('api.getSessionArchiveState', () => {
  it('GET /sessions/archive，缺省 available=false 并归一化集合', async () => {
    const calls = stubFetch({ ok: true, archivedSessionIds: ['s1', ' s2 ', 42] });
    const state = await api.getSessionArchiveState();
    expect(calls[0]?.url).toBe('/api/kanban/sessions/archive');
    expect(calls[0]?.init.method).toBeUndefined();
    expect(state).toEqual({ available: false, archivedSessionIds: ['s1', 's2'] });
  });

  it('available=true 原样透出', async () => {
    stubFetch({ ok: true, available: true, archivedSessionIds: [] });
    await expect(api.getSessionArchiveState()).resolves.toEqual({ available: true, archivedSessionIds: [] });
  });
});

describe('api.archiveCardSession', () => {
  it('POST 归档接口，默认不带 stopActivity', async () => {
    const calls = stubFetch({
      ok: true,
      card: { id: 'card-a', title: 'A', sessionIds: ['s1'] },
      revision: 12,
      archivedSessionIds: ['s1'],
    });
    const result = await api.archiveCardSession('card-a', 'sess 1');
    expect(calls[0]?.url).toBe('/api/kanban/cards/card-a/sessions/sess%201/archive');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
    expect(result.revision).toBe(12);
    expect(result.archivedSessionIds).toEqual(['s1']);
    // normalizeCard 补齐缺省字段
    expect(result.card.labels).toEqual([]);
  });

  it('stopActivity=true 时带上字段，并透出 warning', async () => {
    const calls = stubFetch({
      ok: true,
      card: { id: 'card-a' },
      revision: 3,
      archivedSessionIds: ['s1', 's2'],
      warning: '活动写入失败',
    });
    const result = await api.archiveCardSession('card-a', 's1', { stopActivity: true });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ stopActivity: true });
    expect(result.warning).toBe('活动写入失败');
    expect(result.archivedSessionIds).toEqual(['s1', 's2']);
  });
});

describe('api.unarchiveCardSession', () => {
  it('POST 恢复接口并归一化返回', async () => {
    const calls = stubFetch({ ok: true, card: { id: 'card-a' }, revision: 4, archivedSessionIds: [] });
    const result = await api.unarchiveCardSession('card-a', 's1');
    expect(calls[0]?.url).toBe('/api/kanban/cards/card-a/sessions/s1/unarchive');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
    expect(result.revision).toBe(4);
    expect(result.archivedSessionIds).toEqual([]);
  });
});

describe('api.archiveSessionsBatch', () => {
  it('dryRun 请求 scope=done 并透出 archivable/skipped', async () => {
    const calls = stubFetch({
      ok: true,
      dryRun: true,
      archivable: [{ sessionId: 's1', cardId: 'card-a' }],
      skipped: [
        {
          sessionId: 's2',
          reason: 'SESSION_BUSY_CARDS',
          blockingCards: [{ id: 'card-b', title: 'B', status: 'running' }],
        },
      ],
      archivedSessionIds: ['s9'],
    });
    const result = await api.archiveSessionsBatch({ scope: 'done', dryRun: true });
    expect(calls[0]?.url).toBe('/api/kanban/sessions/archive-batch');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ scope: 'done', dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.archivable).toEqual([{ sessionId: 's1', cardId: 'card-a', cardIds: ['card-a'] }]);
    expect(result.skipped[0]?.reason).toBe('SESSION_BUSY_CARDS');
    expect(result.archivedSessionIds).toEqual(['s9']);
  });

  it('执行时带 cardIds 与 dryRun=false 的省略语义', async () => {
    const calls = stubFetch({
      ok: true,
      dryRun: false,
      archivable: [],
      skipped: [],
      archivedSessionIds: [],
      revision: 5,
    });
    await api.archiveSessionsBatch({ scope: 'done', cardIds: new Set(['card-a', 'card-b']), dryRun: false });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ scope: 'done', cardIds: ['card-a', 'card-b'] });
  });

  it('缺省数组安全兜底', async () => {
    stubFetch({ ok: true });
    const result = await api.archiveSessionsBatch({ scope: 'done' });
    expect(result).toMatchObject({
      dryRun: false,
      archivable: [],
      skipped: [],
      archivedSessionIds: [],
    });
  });
});

describe('归档接口错误详情', () => {
  it('SESSION_ACTIVE 409 保留 activity 清单', async () => {
    stubFetch(
      {
        ok: false,
        error: { code: 'SESSION_ACTIVE', message: '会话仍在运行' },
        activity: [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'j1', label: '构建' }] }],
      },
      { status: 409 },
    );
    const error = await api.archiveCardSession('card-a', 's1').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(KanbanApiError);
    const apiError = error as KanbanApiError;
    expect(apiError.code).toBe('SESSION_ACTIVE');
    expect(apiError.status).toBe(409);
    expect(apiError.details.activity).toEqual([{ kind: 'turn' }, { kind: 'job', items: [{ id: 'j1', label: '构建' }] }]);
  });

  it('SESSION_BUSY_CARDS 409 保留 blockingCards', async () => {
    stubFetch(
      {
        ok: false,
        error: { code: 'SESSION_BUSY_CARDS', message: '还有未完成卡片' },
        blockingCards: [{ id: 'card-b', title: 'B', status: 'running' }],
      },
      { status: 409 },
    );
    const error = (await api.archiveCardSession('card-a', 's1').catch((value: unknown) => value)) as KanbanApiError;
    expect(error.code).toBe('SESSION_BUSY_CARDS');
    expect(error.details.blockingCards).toEqual([{ id: 'card-b', title: 'B', status: 'running' }]);
  });

  it('SESSION_ARCHIVE_UNAVAILABLE 501 可识别', async () => {
    stubFetch(
      { ok: false, error: { code: 'SESSION_ARCHIVE_UNAVAILABLE', message: '不支持' } },
      { status: 501 },
    );
    const error = (await api.unarchiveCardSession('card-a', 's1').catch((value: unknown) => value)) as KanbanApiError;
    expect(error).toBeInstanceOf(KanbanApiError);
    expect(error.code).toBe('SESSION_ARCHIVE_UNAVAILABLE');
    expect(error.status).toBe(501);
  });

  it('VERSION_CONFLICT 仍通过 details.card 暴露最新卡片', async () => {
    stubFetch(
      {
        ok: false,
        error: { code: 'VERSION_CONFLICT', message: '冲突' },
        card: { id: 'card-a', title: 'A', version: 9 },
      },
      { status: 409 },
    );
    const error = (await api.archiveCardSession('card-a', 's1').catch((value: unknown) => value)) as KanbanApiError;
    expect(error.card?.version).toBe(9);
  });
});
