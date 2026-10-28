/**
 * 「工作区」视图的数据 hook（docs/contracts/02-http-api.md §12 / 06 §4.7）。
 *
 * - 输入看板卡片：只取未归档、有 cwd 的卡片，cwd 去重；
 * - debounce 400ms 后按批（每批 ≤32）请求 `POST /git/workspaces`，把按仓库聚合的工作副本结果合起来；
 * - 模块缓存 15s（key = 目录集合），20s 可见时刷新、页面隐藏暂停、卸载清理；
 * - 请求失败静默保留已有数据（不阻塞视图）；`disabled` 原样透传，由视图显示不可用文案。
 *
 * 同时导出纯 util（分组 / 去重 / 会话计数）供单测，不依赖 DOM。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Card, GitWorkspaceRepo, GitWorkspacesResult, GitWorkspaceUnavailable, GitWorkspaceWorktree } from '../types';

/** 模块缓存 TTL（与服务端 realpath 缓存 8s 互补）。 */
export const WORKSPACES_CACHE_TTL_MS = 15_000;
/** 卡片/cwd 变化后的批量请求 debounce。 */
export const WORKSPACES_DEBOUNCE_MS = 400;
/** 可见状态下的刷新间隔。 */
export const WORKSPACES_REFRESH_MS = 20_000;
/** 单次请求的目录上限（契约 §12：1–32 个，超出分批）。 */
export const WORKSPACES_BATCH_SIZE = 32;

export interface WorkspacesState {
  repos: GitWorkspaceRepo[];
  unavailable: GitWorkspaceUnavailable[];
  /** 服务端关闭 git 功能（可选兜底字段） */
  disabled: boolean;
  /** 至少完成过一次请求（失败也算），用于区分「读取中」与「确实为空」 */
  loaded: boolean;
}

export const EMPTY_WORKSPACES: WorkspacesState = {
  repos: [],
  unavailable: [],
  disabled: false,
  loaded: false,
};

interface WorkspacesCacheEntry {
  at: number;
  value: GitWorkspacesResult;
}

const cache = new Map<string, WorkspacesCacheEntry>();

function cacheKeyFor(dirs: readonly string[]): string {
  return [...dirs].sort().join('\u0000');
}

function cacheRead(key: string): GitWorkspacesResult | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > WORKSPACES_CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheWrite(key: string, value: GitWorkspacesResult): void {
  cache.set(key, { at: Date.now(), value });
}

/** 清空模块缓存（调试/测试用）。 */
export function clearWorkspacesCache(): void {
  cache.clear();
}

/** 从卡片列表收集需要探测的 cwd：未归档、有 cwd、去重（保持出现顺序）。 */
export function collectWorkspaceCwds(cards: readonly Card[]): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const card of cards) {
    if (card.archived) continue;
    const cwd = card.cwd?.trim();
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    dirs.push(cwd);
  }
  return dirs;
}

/** 按每批 ≤32 个切分目录（契约 §12 body 限制 1–32）。 */
export function chunkWorkspaceDirs(dirs: readonly string[], size = WORKSPACES_BATCH_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < dirs.length; index += size) {
    chunks.push(dirs.slice(index, index + size));
  }
  return chunks;
}

/** 合并多批请求结果：仓库按 root 去重、工作副本按 path 去重、不可用项拼接。 */
export function mergeWorkspaceResults(results: readonly GitWorkspacesResult[]): GitWorkspacesResult {
  const repos = new Map<string, GitWorkspaceRepo>();
  const unavailable: GitWorkspaceUnavailable[] = [];
  let disabled = false;
  for (const result of results) {
    disabled = disabled || result.disabled === true;
    for (const repo of result.repos) {
      const existing = repos.get(repo.root);
      if (!existing) {
        repos.set(repo.root, { ...repo, worktrees: [...repo.worktrees] });
        continue;
      }
      const seen = new Set(existing.worktrees.map((worktree) => worktree.path));
      for (const worktree of repo.worktrees) {
        if (!seen.has(worktree.path)) existing.worktrees.push(worktree);
      }
    }
    unavailable.push(...result.unavailable);
  }
  return { repos: [...repos.values()], unavailable, disabled };
}

/** 关联卡片绑定的会话数（去重：同一个会话可能被多张卡绑定）。 */
export function countBoundSessions(cards: readonly Card[]): number {
  const ids = new Set<string>();
  for (const card of cards) {
    for (const sessionId of card.sessionIds) ids.add(sessionId);
  }
  return ids.size;
}

export interface WorkspaceWorktreeGroup extends GitWorkspaceWorktree {
  /** 落在该工作副本（cwd 最长前缀匹配）的卡片 */
  cards: Card[];
}

export interface WorkspaceRepoGroup extends Omit<GitWorkspaceRepo, 'worktrees'> {
  worktrees: WorkspaceWorktreeGroup[];
  /** 该仓库下的卡片数 */
  cardCount: number;
}

export interface WorkspaceGroups {
  repos: WorkspaceRepoGroup[];
  /** 无 cwd / 不可用 / 没匹配到任何工作副本的卡片 */
  unassigned: Card[];
  /** 所有仓库的工作副本总数 */
  worktreeCount: number;
  cardCount: number;
  /** 进行中（status=running）的卡片数 */
  runningCount: number;
}

/** 去掉末尾 `/`，用于最长前缀匹配（避免 `/repo/` 与 `/repo` 匹配不上）。 */
function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/** cwd 是否等于该工作副本路径或位于其下。 */
function cwdInsideWorktree(cwd: string, worktreePath: string): boolean {
  const root = trimTrailingSlash(worktreePath);
  if (!root) return false;
  return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * 把卡片按 cwd 归到「最长前缀匹配」的工作副本（契约 §12/§4.7）。
 * 没有 cwd、cwd 不在任何已探测工作副本下的卡片进 unassigned。
 */
export function groupCardsByWorktree(
  cards: readonly Card[],
  repos: readonly GitWorkspaceRepo[],
): WorkspaceGroups {
  const repoGroups: WorkspaceRepoGroup[] = repos.map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((worktree) => ({ ...worktree, cards: [] as Card[] })),
    cardCount: 0,
  }));

  const flat: { worktree: WorkspaceWorktreeGroup; repo: WorkspaceRepoGroup }[] = [];
  /** 服务端给的 dir → 工作副本精确映射（解决 /tmp ↔ realpath 前缀不一致） */
  const byDir = new Map<string, { worktree: WorkspaceWorktreeGroup; repo: WorkspaceRepoGroup }>();
  for (const repo of repoGroups) {
    for (const worktree of repo.worktrees) {
      const entry = { worktree, repo };
      flat.push(entry);
      for (const dir of worktree.dirs ?? []) {
        if (typeof dir === 'string' && dir.trim()) byDir.set(dir.trim(), entry);
      }
    }
  }

  const unassigned: Card[] = [];
  for (const card of cards) {
    const cwd = card.cwd?.trim();
    if (!cwd) {
      unassigned.push(card);
      continue;
    }
    let matched: { worktree: WorkspaceWorktreeGroup; repo: WorkspaceRepoGroup } | null = byDir.get(cwd) ?? null;
    let matchedLength = matched ? trimTrailingSlash(matched.worktree.path).length : -1;
    if (!matched) {
      for (const entry of flat) {
        const path = trimTrailingSlash(entry.worktree.path);
        if (!cwdInsideWorktree(cwd, entry.worktree.path)) continue;
        if (path.length > matchedLength) {
          matched = entry;
          matchedLength = path.length;
        }
      }
    }
    if (!matched) {
      unassigned.push(card);
      continue;
    }
    matched.worktree.cards.push(card);
    matched.repo.cardCount += 1;
  }

  return {
    repos: repoGroups,
    unassigned,
    worktreeCount: flat.length,
    cardCount: cards.length,
    runningCount: cards.filter((card) => card.status === 'running').length,
  };
}

/**
 * 加载「工作区」视图数据。失败静默（保留已有结果），不阻塞视图。
 * @param cards 当前视图的卡片（内部只保留未归档且有 cwd 的）
 */
export function useWorkspaces(cards: readonly Card[]): WorkspacesState {
  const cwds = useMemo(() => collectWorkspaceCwds(cards), [cards]);
  const cwdKey = cwds.join('\u0000');
  const cwdsRef = useRef(cwds);
  cwdsRef.current = cwds;
  const [state, setState] = useState<WorkspacesState>(EMPTY_WORKSPACES);

  useEffect(() => {
    let disposed = false;
    let debounceTimer: number | null = null;
    const dirs = cwdsRef.current;
    if (!dirs.length) {
      setState({ repos: [], unavailable: [], disabled: false, loaded: true });
      return undefined;
    }

    const refresh = async (): Promise<void> => {
      const currentDirs = cwdsRef.current;
      if (!currentDirs.length) return;
      const key = cacheKeyFor(currentDirs);
      const cached = cacheRead(key);
      if (cached) {
        setState({
          repos: cached.repos,
          unavailable: cached.unavailable,
          disabled: cached.disabled === true,
          loaded: true,
        });
        return;
      }
      const results: GitWorkspacesResult[] = [];
      for (const batch of chunkWorkspaceDirs(currentDirs)) {
        try {
          results.push(await api.getGitWorkspaces(batch));
          if (disposed) return;
        } catch {
          // 某一批失败：保留其它批结果（若有），不弹错误；下次刷新重试
          if (disposed) return;
          break;
        }
      }
      if (disposed) return;
      if (!results.length) {
        setState((previous) => (previous.loaded ? previous : { ...EMPTY_WORKSPACES, loaded: true }));
        return;
      }
      const merged = mergeWorkspaceResults(results);
      cacheWrite(key, merged);
      setState({
        repos: merged.repos,
        unavailable: merged.unavailable,
        disabled: merged.disabled === true,
        loaded: true,
      });
    };

    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      if (!disposed) void refresh();
    }, WORKSPACES_DEBOUNCE_MS);

    const interval = window.setInterval(() => {
      if (document.hidden) return; // 页面不可见时暂停
      void refresh();
    }, WORKSPACES_REFRESH_MS);

    const onVisibilityChange = (): void => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [cwdKey]);

  return state;
}
