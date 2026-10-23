import type { Card } from '../types';

/** 客户端插件在「返回看板」气泡点击时写入被打开的 sessionId；看板读取一次后立即清除。 */
const HIGHLIGHT_SESSION_KEY = 'dsh-kanban:return-highlight-session';

export function consumeHighlightSession(): string | null {
  try {
    const value = sessionStorage.getItem(HIGHLIGHT_SESSION_KEY);
    if (value) sessionStorage.removeItem(HIGHLIGHT_SESSION_KEY);
    return value;
  } catch {
    return null;
  }
}

/** 兼容多卡共享同一会话的情况：优先返回当前可见的第一张，否则任意一张。 */
export function cardIdForSession(cards: Card[], sessionId: string | null): string | null {
  if (!sessionId) return null;
  const hit = cards.find((card) => card.sessionIds.includes(sessionId));
  return hit?.id ?? null;
}
