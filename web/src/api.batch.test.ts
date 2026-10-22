import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchCards } from './api';

function stubFetch(response: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => response,
      } as Response;
    }),
  );
  return calls;
}

describe('api.batchCards', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('archive 发 action+cardIds，不带 column', async () => {
    const calls = stubFetch({
      ok: true,
      cards: [{ id: 'card-a', title: 'A', archived: true, archivedAt: 1 }],
      revision: 7,
    });
    const result = await batchCards('archive', ['card-a', 'card-b']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/kanban/cards/batch');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'archive', cardIds: ['card-a', 'card-b'] });
    expect(result.revision).toBe(7);
    expect(result.cards[0]?.archived).toBe(true);
    // normalizeCard 补齐缺失数组字段
    expect(result.cards[0]?.labels).toEqual([]);
    expect(result.cards[0]?.sessionIds).toEqual([]);
  });

  it('move 带 column，cardIds 转普通数组', async () => {
    const calls = stubFetch({ ok: true, cards: [{ id: 'card-a', status: 'running' }], revision: 8 });
    const ids = new Set(['card-a']);
    await batchCards('move', [...ids], 'running');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({ action: 'move', cardIds: ['card-a'], column: 'running' });
  });

  it('服务端返回空 cards 时安全兜底', async () => {
    stubFetch({ ok: true, revision: 9 });
    const result = await batchCards('archive', ['card-a']);
    expect(result.cards).toEqual([]);
  });
});
