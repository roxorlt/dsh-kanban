import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, normalizeCard } from './api';

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

describe('normalizeCard 关系字段（v0.22）', () => {
  it('合法字段保留并去空白/去重', () => {
    const card = normalizeCard({
      id: 'card-a',
      parentCardId: ' card-parent ',
      dependsOn: ['card-x', 'card-x', ' card-y ', '', 1 as unknown as string],
      mergedInto: ' card-target ',
    });
    expect(card.parentCardId).toBe('card-parent');
    expect(card.dependsOn).toEqual(['card-x', 'card-y']);
    expect(card.mergedInto).toBe('card-target');
  });

  it('旧服务端没有关系字段时保持 undefined（UI 不渲染关系区块）', () => {
    const card = normalizeCard({ id: 'card-b' });
    expect(card.parentCardId).toBeUndefined();
    expect(card.dependsOn).toBeUndefined();
    expect(card.mergedInto).toBeUndefined();
  });

  it('脏形态（非字符串/非数组）被丢弃，不崩溃', () => {
    const card = normalizeCard({
      id: 'card-c',
      parentCardId: 42 as unknown as string,
      dependsOn: 'card-x' as unknown as string[],
      mergedInto: '' as string,
    });
    expect(card.parentCardId).toBeUndefined();
    expect(card.dependsOn).toBeUndefined();
    expect(card.mergedInto).toBeUndefined();
  });
});

describe('api.moveCard 完成拦截', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forceComplete=true 写进 POST /move 请求体', async () => {
    const calls = stubFetch({ ok: true, card: { id: 'card-a', status: 'done' }, revision: 3 });
    await api.moveCard('card-a', 'done', { version: 2, forceComplete: true });
    expect(calls[0]?.url).toBe('/api/kanban/cards/card-a/move');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ column: 'done', version: 2, forceComplete: true });
  });

  it('未传 forceComplete 时不带该字段（普通移动请求形态不变）', async () => {
    const calls = stubFetch({ ok: true, card: { id: 'card-a', status: 'running' }, revision: 3 });
    await api.moveCard('card-a', 'running', { version: 2 });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ column: 'running', version: 2 });
  });
});

describe('api.updateCard 完成拦截', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forceComplete 与 changes/version 同级', async () => {
    const calls = stubFetch({ ok: true, card: { id: 'card-a', status: 'done' }, revision: 4 });
    await api.updateCard('card-a', 2, { status: 'done' }, { forceComplete: true });
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      version: 2,
      changes: { status: 'done' },
      forceComplete: true,
    });
  });

  it('旧调用（只传三个参数）请求体不带 forceComplete', async () => {
    const calls = stubFetch({ ok: true, card: { id: 'card-a' }, revision: 4 });
    await api.updateCard('card-a', 2, { title: '新标题' });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ version: 2, changes: { title: '新标题' } });
  });
});

describe('api 归档箱（v0.22）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GET /archive 兼容 cards / archived 两种字段名并归一化卡片', async () => {
    const calls = stubFetch({
      ok: true,
      cards: [{ id: 'card-old', title: '旧卡', status: 'done', archived: true, archivedAt: 10 }],
      revision: 5,
    });
    const cards = await api.getArchivedCards();
    expect(calls[0]?.url).toBe('/api/kanban/archive?limit=200');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe('旧卡');
    expect(cards[0]?.labels).toEqual([]);
    expect(cards[0]?.dependsOn).toBeUndefined();
  });

  it('响应没有卡片数组时返回空列表（不崩溃）', async () => {
    stubFetch({ ok: true, revision: 5 });
    expect(await api.getArchivedCards()).toEqual([]);
  });

  it('POST /cards/:id/unarchive 无 body 字段且返回归一化卡片', async () => {
    const calls = stubFetch({ ok: true, card: { id: 'card-old', status: 'backlog' }, revision: 6 });
    const result = await api.unarchiveCard('card-old');
    expect(calls[0]?.url).toBe('/api/kanban/cards/card-old/unarchive');
    expect(calls[0]?.init.method).toBe('POST');
    expect(result.card.status).toBe('backlog');
    expect(result.revision).toBe(6);
  });
});
