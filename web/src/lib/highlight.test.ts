import { describe, expect, it, vi } from 'vitest';
import { cardIdForSession, consumeHighlightSession } from './highlight';
import type { Card } from '../types';

const base = {
  id: 'card-a', title: 'a', summary: '', status: 'backlog', priority: 'none', labels: [], sessionIds: [],
} satisfies Partial<Card>;

describe('return highlight', () => {
  it('finds the card bound to the opened session', () => {
    const cards = [
      { ...base, id: 'card-a', sessionIds: ['s-1'] } as unknown as Card,
      { ...base, id: 'card-b', sessionIds: ['s-2'] } as unknown as Card,
    ];
    expect(cardIdForSession(cards, 's-2')).toBe('card-b');
    expect(cardIdForSession(cards, 's-none')).toBeNull();
    expect(cardIdForSession(cards, null)).toBeNull();
  });

  it('consumes the session key once', () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    vi.stubGlobal('sessionStorage', fake);
    fake.setItem('dsh-kanban:return-highlight-session', 's-1');
    expect(consumeHighlightSession()).toBe('s-1');
    expect(consumeHighlightSession()).toBeNull();
    vi.unstubAllGlobals();
  });
});
