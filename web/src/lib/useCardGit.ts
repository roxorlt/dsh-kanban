/**
 * 卡片 Git 上下文请求 hook（docs/contracts/06-git-context.md §1.1 / §6）。
 *
 * - 打开卡片（card.id 变化）时请求 `GET /cards/:id/git`；
 * - `?cwd=` 候选取「主会话（sessionIds[0]）的执行目录」，与卡片 cwd 不同时才传；
 *   卡片没有 cwd 时服务端必然返回 no_cwd，直接跳过请求；
 * - 模块内 LRU 缓存：key = cardId + 候选目录，TTL 4s、最多 20 条，抽屉开关不重复打服务端；
 * - 切卡 / 卸载后丢弃在途响应；读取失败（网络错误、旧服务端 404）一律返回 null，
 *   由组件整块静默隐藏，不弹错误打扰用户。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Card, GitContext, SessionRow } from '../types';

/** 缓存 TTL（契约 §6：4s）。 */
export const GIT_CACHE_TTL_MS = 4_000;
/** 缓存容量（契约 §6：最多 20 条）。 */
export const GIT_CACHE_MAX_ENTRIES = 20;

interface CacheEntry {
  value: GitContext;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(cardId: string, cardCwd: string, requestedCwd: string | null): string {
  return `${cardId}\u0000${cardCwd}\u0000${requestedCwd ?? ''}`;
}

function cacheRead(key: string): GitContext | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > GIT_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // LRU：命中后移到队尾
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheWrite(key: string, value: GitContext): void {
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  while (cache.size > GIT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** 清空模块缓存（调试用；正常展示依赖 TTL 自然过期）。 */
export function clearCardGitCache(): void {
  cache.clear();
}

/**
 * `?cwd=` 候选：卡片 cwd 是主仓库、而主会话已被切到同仓库 linked worktree 时，
 * 服务端据此采集工作树里的分支（契约 §1.1）。其余情况返回 null（用卡片 cwd）。
 */
export function resolveCandidateCwd(
  card: Pick<Card, 'cwd' | 'sessionIds'>,
  sessions: readonly SessionRow[],
): string | null {
  if (!card.cwd) return null;
  const primarySessionId = card.sessionIds[0];
  if (!primarySessionId) return null;
  const sessionCwd = sessions.find((session) => session.id === primarySessionId)?.cwd?.trim();
  if (!sessionCwd || sessionCwd === card.cwd.trim()) return null;
  return sessionCwd;
}

export interface CardGitState {
  /** null = 不可用 / 读取中 / 读取失败：区块静默隐藏（或按需显示骨架） */
  git: GitContext | null;
  loading: boolean;
}

interface InternalState extends CardGitState {
  key: string;
}

function initialState(enabled: boolean, key: string): InternalState {
  const cached = enabled ? cacheRead(key) : null;
  return { key, git: cached, loading: enabled && cached === null };
}

/**
 * 请求卡片 Git 上下文。
 * @param card 详情抽屉当前卡片
 * @param sessions 宿主会话列表（取主会话 cwd 作为 `?cwd=` 候选）
 */
export function useCardGit(card: Card, sessions: readonly SessionRow[]): CardGitState {
  const requestedCwd = resolveCandidateCwd(card, sessions);
  const key = cacheKey(card.id, card.cwd ?? '', requestedCwd);
  const enabled = Boolean(card.cwd);

  const [state, setState] = useState<InternalState>(() => initialState(enabled, key));

  // 切换卡片 / 候选目录变化时，本次渲染直接使用新 key 的派生值，避免闪上一张卡的图。
  const current: InternalState = state.key === key ? state : initialState(enabled, key);

  useEffect(() => {
    if (!enabled) return undefined;
    const cached = cacheRead(key);
    if (cached) {
      setState((previous) => (previous.key === key && previous.git === cached ? previous : { key, git: cached, loading: false }));
      return undefined;
    }
    let cancelled = false;
    setState((previous) =>
      previous.key === key && previous.git === null && previous.loading
        ? previous
        : { key, git: null, loading: true },
    );
    void api
      .getCardGit(card.id, requestedCwd ? { cwd: requestedCwd } : {})
      .then((git) => {
        if (cancelled) return;
        cacheWrite(key, git);
        setState({ key, git, loading: false });
      })
      .catch(() => {
        // 旧服务端 404 / 网络错误：静默隐藏，不显示错误。
        if (cancelled) return;
        setState({ key, git: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, card.id, requestedCwd]);

  return { git: current.git, loading: current.loading };
}
