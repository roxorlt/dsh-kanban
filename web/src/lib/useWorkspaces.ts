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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { shortenPath } from './forkGraph';
import { isTerminalCardStatus } from './sessionArchive';
import { formatRelative } from './time';
import type { Lang } from './time';
import type {
  Card,
  GitWorkspaceRepo,
  GitWorkspacesResult,
  GitWorkspaceUnavailable,
  GitWorkspaceWorktree,
  SessionRow,
} from '../types';

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
  /** v0.21.0 #14：按会话 cwd 兜底归组的卡片（顺序与卡片遍历顺序一致） */
  sessionAttributed: SessionAttribution[];
}

/** 会话 cwd 兜底归属记录（v0.21.0 #14）。 */
export interface SessionAttribution {
  cardId: string;
  sessionId: string;
  /** 会话执行目录（原文，trim 后） */
  sessionCwd: string;
  /** 被归到的工作副本路径 */
  worktreePath: string;
}

/** groupCardsByWorktree 的可选项（v0.21.0 #14）。 */
export interface GroupCardsByWorktreeOptions {
  /** 会话列表；缺省=不按会话兜底（保持卡片 cwd 归属） */
  sessions?: readonly SessionRow[];
}

/** 去掉末尾 `/`，用于最长前缀匹配（避免 `/repo/` 与 `/repo` 匹配不上）。 */
function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/**
 * 工作副本展示名（「工作区」与「工作线」视图共用）：
 * 主工作副本用仓库名；子工作副本用相对仓库根的路径；兜底取缩短路径。
 */
export function formatWorktreeLabel(
  repo: { root: string; name: string },
  worktree: { path: string },
): string {
  const root = trimTrailingSlash(repo.root);
  const path = trimTrailingSlash(worktree.path);
  if (path === root) return repo.name;
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return shortenPath(worktree.path);
}

/** cwd 是否等于该工作副本路径或位于其下。 */
function cwdInsideWorktree(cwd: string, worktreePath: string): boolean {
  const root = trimTrailingSlash(worktreePath);
  if (!root) return false;
  return cwd === root || cwd.startsWith(`${root}/`);
}

/** cwd → 工作副本匹配表（byDir 精确映射 + flat 最长前缀扫描）。 */
interface WorktreeLookupEntry<R, W> {
  repo: R;
  worktree: W;
}

interface WorktreeLookup<R, W> {
  flat: WorktreeLookupEntry<R, W>[];
  byDir: Map<string, WorktreeLookupEntry<R, W>>;
}

/**
 * 建立 cwd 匹配表：服务端给的 `worktrees[].dirs` 原文精确映射优先，
 * 其次按工作副本路径最长前缀匹配（契约 §12/§4.7）。
 */
function buildWorktreeLookup<R extends { root: string }, W extends { path: string; dirs?: string[] }>(
  repos: readonly R[],
  worktreesOf: (repo: R) => readonly W[],
): WorktreeLookup<R, W> {
  const flat: WorktreeLookupEntry<R, W>[] = [];
  const byDir = new Map<string, WorktreeLookupEntry<R, W>>();
  for (const repo of repos) {
    for (const worktree of worktreesOf(repo)) {
      const entry = { repo, worktree };
      flat.push(entry);
      for (const dir of worktree.dirs ?? []) {
        if (typeof dir === 'string' && dir.trim()) byDir.set(dir.trim(), entry);
      }
    }
  }
  return { flat, byDir };
}

/** 在匹配表里查 cwd 归属的工作副本；找不到返回 null。 */
function lookupWorktree<R, W extends { path: string }>(
  lookup: WorktreeLookup<R, W>,
  cwd: string,
): WorktreeLookupEntry<R, W> | null {
  const exact = lookup.byDir.get(cwd);
  if (exact) return exact;
  let matched: WorktreeLookupEntry<R, W> | null = null;
  let matchedLength = -1;
  for (const entry of lookup.flat) {
    if (!cwdInsideWorktree(cwd, entry.worktree.path)) continue;
    const length = trimTrailingSlash(entry.worktree.path).length;
    if (length > matchedLength) {
      matched = entry;
      matchedLength = length;
    }
  }
  return matched;
}

/**
 * 找到 cwd 归属的工作副本（byDir 精确优先，其次最长前缀）；找不到返回 null。
 * v0.21.0 #14 起导出，供 #15 的清理提示复用（与工作区视图同源判定）。
 */
export function findWorktreeForCwd(
  cwd: string | undefined,
  repos: readonly GitWorkspaceRepo[],
): { repo: GitWorkspaceRepo; worktree: GitWorkspaceWorktree } | null {
  const dir = cwd?.trim();
  if (!dir) return null;
  return lookupWorktree(buildWorktreeLookup(repos, (repo) => repo.worktrees), dir);
}

/** 会话 cwd 兜底命中：卡片绑定的会话执行目录落在同仓库的 linked 工作副本里。 */
interface SessionWorktreeFallback {
  entry: WorktreeLookupEntry<WorkspaceRepoGroup, WorkspaceWorktreeGroup>;
  sessionId: string;
  sessionCwd: string;
}

/**
 * v0.21.0 #14：卡片 cwd 落在**主工作副本**时，按 `sessionIds` 顺序找第一个「有 cwd 的会话」，
 * 若该会话 cwd 落在**同仓库的 linked 工作副本**则改归到那里（契约 §1 步骤 2–4）。
 * 第一个有 cwd 的会话不满足条件时维持原归属（不继续找后面的会话）。
 */
function findSessionWorktree(
  card: Card,
  sessionById: ReadonlyMap<string, SessionRow>,
  lookup: WorktreeLookup<WorkspaceRepoGroup, WorkspaceWorktreeGroup>,
  repoRoot: string,
): SessionWorktreeFallback | null {
  for (const sessionId of card.sessionIds) {
    const sessionCwd = sessionById.get(sessionId)?.cwd?.trim();
    if (!sessionCwd) continue; // 没有 cwd 的会话不参与兜底
    const entry = lookupWorktree(lookup, sessionCwd);
    if (!entry || entry.repo.root !== repoRoot || entry.worktree.isMain) return null;
    return { entry, sessionId, sessionCwd };
  }
  return null;
}

/**
 * 把卡片按 cwd 归到「最长前缀匹配」的工作副本（契约 §12/§4.7）。
 * 没有 cwd、cwd 不在任何已探测工作副本下的卡片进 unassigned。
 *
 * v0.21.0 #14：卡片 cwd 落在主工作副本、但绑定会话执行目录在同仓库 linked 工作副本时，
 * 改归到该工作副本并记一条 `sessionAttributed`；卡片 cwd 已落在 linked 工作副本时 cwd 优先。
 * 没有 cwd 的卡片不做会话兜底（避免历史卡片大面积漂移）。
 */
export function groupCardsByWorktree(
  cards: readonly Card[],
  repos: readonly GitWorkspaceRepo[],
  options: GroupCardsByWorktreeOptions = {},
): WorkspaceGroups {
  const repoGroups: WorkspaceRepoGroup[] = repos.map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((worktree) => ({ ...worktree, cards: [] as Card[] })),
    cardCount: 0,
  }));

  const lookup = buildWorktreeLookup(repoGroups, (repo) => repo.worktrees);
  const sessionById = new Map<string, SessionRow>();
  for (const session of options.sessions ?? []) sessionById.set(session.id, session);
  const sessionAttributed: SessionAttribution[] = [];

  const unassigned: Card[] = [];
  for (const card of cards) {
    const cwd = card.cwd?.trim();
    if (!cwd) {
      unassigned.push(card);
      continue;
    }
    let matched = lookupWorktree(lookup, cwd);
    if (!matched) {
      unassigned.push(card);
      continue;
    }
    // 只有 cwd 落在主工作副本时才尝试会话兜底（卡片 cwd 已指到 linked 工作副本时以 cwd 为准）
    if (matched.worktree.isMain) {
      const fallback = findSessionWorktree(card, sessionById, lookup, matched.repo.root);
      if (fallback) {
        matched = fallback.entry;
        sessionAttributed.push({
          cardId: card.id,
          sessionId: fallback.sessionId,
          sessionCwd: fallback.sessionCwd,
          worktreePath: fallback.entry.worktree.path,
        });
      }
    }
    matched.worktree.cards.push(card);
    matched.repo.cardCount += 1;
  }

  return {
    repos: repoGroups,
    unassigned,
    worktreeCount: lookup.flat.length,
    cardCount: cards.length,
    runningCount: cards.filter((card) => card.status === 'running').length,
    sessionAttributed,
  };
}

/** 工作副本合并状态：unknown = 旧服务端/无法计算（UI 不显示，避免谎报）。 */
export type WorktreeMergeState = 'merged' | 'unmerged' | 'unknown';
/** 工作副本远端状态：unknown = 旧服务端没有该字段。 */
export type WorktreeRemoteState = 'no-upstream' | 'synced' | 'unpushed' | 'behind' | 'diverged' | 'unknown';
/** 工作副本改动状态。 */
export type WorktreeChangesState = 'modified' | 'untracked' | 'clean';

export interface WorktreeStatusInfo {
  merge: WorktreeMergeState;
  /** 未并入主线的处数（mergedIntoBase=false 时取 aheadOfBase，否则 0） */
  aheadMain: number;
  remote: WorktreeRemoteState;
  upstreamAhead: number;
  upstreamBehind: number;
  changes: WorktreeChangesState;
  modifiedCount: number;
  untrackedCount: number;
}

type WorktreeStatusInput = Pick<
  GitWorkspaceWorktree,
  'aheadOfBase' | 'mergedIntoBase' | 'upstream' | 'modifiedCount' | 'untrackedCount' | 'dirty'
>;

/**
 * Phase A 状态分类（契约 §12 v0.17 / 06 §4.8）：
 * 合并状态 / 远端状态 / 改动状态，组件按状态选 i18n 短语。
 * 旧服务端缺字段时按「unknown」处理（远端）或用 aheadOfBase / dirty 兼容推断（合并 / 改动）。
 */
export function worktreeStatusInfo(worktree: WorktreeStatusInput): WorktreeStatusInfo {
  const merge: WorktreeMergeState =
    worktree.mergedIntoBase === true
      ? 'merged'
      : worktree.mergedIntoBase === false
        ? 'unmerged'
        : worktree.mergedIntoBase === null
          ? 'unknown'
          : // 旧服务端兼容：用 aheadOfBase 推断
            worktree.aheadOfBase === null || worktree.aheadOfBase === undefined
            ? 'unknown'
            : worktree.aheadOfBase === 0
              ? 'merged'
              : 'unmerged';

  const aheadMain = Math.max(0, worktree.aheadOfBase ?? 0);
  const upstream = worktree.upstream;
  let remote: WorktreeRemoteState;
  if (upstream === undefined) remote = 'unknown';
  else if (upstream === null) remote = 'no-upstream';
  else if (upstream.ahead > 0 && upstream.behind > 0) remote = 'diverged';
  else if (upstream.ahead > 0) remote = 'unpushed';
  else if (upstream.behind > 0) remote = 'behind';
  else remote = 'synced';

  const modifiedCount = Math.max(0, worktree.modifiedCount ?? (worktree.dirty === true ? 1 : 0));
  const untrackedCount = Math.max(0, worktree.untrackedCount ?? 0);
  const changes: WorktreeChangesState =
    modifiedCount > 0 ? 'modified' : untrackedCount > 0 ? 'untracked' : 'clean';

  return {
    merge,
    aheadMain,
    remote,
    upstreamAhead: Math.max(0, upstream?.ahead ?? 0),
    upstreamBehind: Math.max(0, upstream?.behind ?? 0),
    changes,
    modifiedCount,
    untrackedCount,
  };
}

/** Phase A 状态短语（组件层直接 t(key, params)；测试用它验证状态 → 文案映射）。 */
export interface WorktreeStatusBadge {
  kind: 'merge' | 'remote' | 'changes';
  /** i18n key（workspace.*） */
  key: string;
  params?: Record<string, number>;
}

/**
 * 按 Phase A 分类生成行内状态短语列表（顺序：合并 → 远端 → 改动）。
 * unknown 状态不生成短语（不谎报）；diverged 会给出「没推送」+「线上落后」两条。
 */
export function worktreeStatusBadges(worktree: WorktreeStatusInput): WorktreeStatusBadge[] {
  const status = worktreeStatusInfo(worktree);
  const badges: WorktreeStatusBadge[] = [];
  if (status.merge === 'merged') badges.push({ kind: 'merge', key: 'workspace.mergedIntoMain' });
  else if (status.merge === 'unmerged') {
    badges.push({ kind: 'merge', key: 'workspace.notMerged', params: { count: Math.max(1, status.aheadMain) } });
  }

  switch (status.remote) {
    case 'no-upstream':
      badges.push({ kind: 'remote', key: 'workspace.remoteNone' });
      break;
    case 'synced':
      badges.push({ kind: 'remote', key: 'workspace.remoteSynced' });
      break;
    case 'unpushed':
      badges.push({ kind: 'remote', key: 'workspace.unpushed', params: { count: status.upstreamAhead } });
      break;
    case 'behind':
      badges.push({ kind: 'remote', key: 'workspace.remoteBehind', params: { count: status.upstreamBehind } });
      break;
    case 'diverged':
      badges.push({ kind: 'remote', key: 'workspace.unpushed', params: { count: status.upstreamAhead } });
      badges.push({ kind: 'remote', key: 'workspace.remoteBehind', params: { count: status.upstreamBehind } });
      break;
    default:
      break; // unknown：旧服务端没有远端信息，不显示
  }

  if (status.changes === 'modified') badges.push({ kind: 'changes', key: 'workspace.dirty' });
  else if (status.changes === 'untracked') badges.push({ kind: 'changes', key: 'workspace.untracked' });
  else badges.push({ kind: 'changes', key: 'workspace.clean' });

  return badges;
}

/** 清理按钮被禁用的原因（null = 可清理）。 */
export type WorktreeCleanupBlocked = 'locked' | 'main' | 'session' | 'running' | 'in-use' | null;

export interface WorktreeCleanupCheck {
  /** 是否可点「清理」（主工作副本 / 有会话或卡片占用时不可点） */
  canCleanup: boolean;
  blocked: WorktreeCleanupBlocked;
  cardCount: number;
  runningCardCount: number;
  /** cwd 落在该工作副本内的运行中会话数（客户端安全层；服务端不知道会话 cwd） */
  runningSessionCount: number;
  /** 安全可清理：可清理 && 已并入主线 && 干净（不弹第二层危险确认） */
  safe: boolean;
  /** 需要第二层危险确认：可清理但未合并或有未保存改动 */
  needsDangerConfirm: boolean;
}

type WorktreeCleanupInput = Pick<
  GitWorkspaceWorktree,
  'path' | 'isMain' | 'locked' | 'mergedIntoBase' | 'aheadOfBase' | 'modifiedCount' | 'untrackedCount' | 'dirty'
> & { cards: readonly Card[] };

export interface WorktreeCleanupOptions {
  /** 运行中会话的 cwd 列表（App 从 sessions 预计算；落在工作副本内则禁止清理） */
  sessionCwds?: readonly string[];
}

/** 收集运行中会话的 cwd（去重；只看 running 且有 cwd 的会话）。 */
export function collectRunningSessionCwds(
  sessions: readonly Pick<SessionRow, 'running' | 'cwd'>[],
): string[] {
  const seen = new Set<string>();
  const cwds: string[] = [];
  for (const session of sessions) {
    if (!session.running) continue;
    const cwd = session.cwd?.trim();
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    cwds.push(cwd);
  }
  return cwds;
}

/** cwd 是否落在工作副本内（同源前缀判定）。 */
function cwdInsidePath(cwd: string, path: string): boolean {
  const root = trimTrailingSlash(path);
  if (!root) return false;
  return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * 清理判定（纯函数，契约 §12/§13）：
 * 没被 git 锁定 + 非主工作副本 + 没有运行中会话 / 卡片在跑 + 没被未完成卡片占用 才允许清理；
 * 允许但「未并入主线 / 有改动」时需要第二层危险确认。
 * 阻塞原因优先级：已锁定 > 主工作副本 > 有会话在跑 > 有卡片在跑 > 有卡片占用。
 *
 * v0.21.0 #15：`done` / `canceled` 是终态，不再占用工作副本的清理判定；
 * `cardCount` / `runningCardCount` 都只统计未完成卡片（与服务端 §13 一致）。
 */
export function evaluateWorktreeCleanup(
  worktree: WorktreeCleanupInput,
  options: WorktreeCleanupOptions = {},
): WorktreeCleanupCheck {
  // 终态卡片不再占用工作副本（卡片完成后工作副本可能立刻变成可清理）
  const cards = worktree.cards.filter((card) => !isTerminalCardStatus(card.status));
  const runningCardCount = cards.filter((card) => card.status === 'running').length;
  const runningSessionCount = (options.sessionCwds ?? []).filter((cwd) =>
    cwdInsidePath(cwd.trim(), worktree.path),
  ).length;
  let blocked: WorktreeCleanupBlocked = null;
  if (worktree.locked === true) blocked = 'locked';
  else if (worktree.isMain) blocked = 'main';
  else if (runningSessionCount > 0) blocked = 'session';
  else if (runningCardCount > 0) blocked = 'running';
  else if (cards.length > 0) blocked = 'in-use';

  const status = worktreeStatusInfo(worktree);
  const canCleanup = blocked === null;
  const dirty = status.changes !== 'clean';
  const unmerged = status.merge === 'unmerged';
  return {
    canCleanup,
    blocked,
    cardCount: cards.length,
    runningCardCount,
    runningSessionCount,
    safe: canCleanup && !dirty && !unmerged,
    needsDangerConfirm: canCleanup && (dirty || unmerged),
  };
}

/** 清理接口错误码（契约 §13；前端兼容服务端把 code 放 error.code 或 details.reason 两种形态）。 */
export const CLEANUP_ERROR_CODES = [
  'WORKTREE_MAIN',
  'WORKTREE_IN_USE',
  'WORKTREE_DIRTY',
  'WORKTREE_UNMERGED',
  'BRANCH_MAIN',
  'BRANCH_IN_USE',
  'TRASH_MOVE_FAILED',
  'WORKTREE_PRUNE_FAILED',
  'BRANCH_DELETE_FAILED',
  'NOT_FOUND',
] as const;

export type CleanupErrorReason = (typeof CLEANUP_ERROR_CODES)[number] | 'unknown';

/**
 * 从任意错误对象里提取清理错误码（KanbanApiError 的 `code`、`details.reason`，或 body 里的 `reason`）。
 * 认不出时返回 'unknown'（UI 用兜底文案）。
 */
export function cleanupErrorReason(error: unknown): CleanupErrorReason {
  if (!error || typeof error !== 'object') return 'unknown';
  const record = error as { code?: unknown; reason?: unknown; details?: unknown };
  const details =
    record.details && typeof record.details === 'object'
      ? (record.details as { reason?: unknown; code?: unknown })
      : null;
  const candidates = [record.code, details?.reason, details?.code, record.reason];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    if ((CLEANUP_ERROR_CODES as readonly string[]).includes(candidate)) {
      return candidate as CleanupErrorReason;
    }
  }
  return 'unknown';
}

/** 这些错误表示服务端要求用户明确接受丢失风险（前端应升级到第二层危险确认）。 */
export function cleanupErrorNeedsLossConfirm(error: unknown): boolean {
  const reason = cleanupErrorReason(error);
  return reason === 'WORKTREE_DIRTY' || reason === 'WORKTREE_UNMERGED';
}

/** 通用错误码提取（KanbanApiError.code / details.reason / body.reason 三种形态）。 */
function extractErrorCode(error: unknown, codes: readonly string[]): string | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as { code?: unknown; reason?: unknown; details?: unknown };
  const details =
    record.details && typeof record.details === 'object'
      ? (record.details as { reason?: unknown; code?: unknown })
      : null;
  const candidates = [record.code, details?.reason, details?.code, record.reason];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && codes.includes(candidate)) return candidate;
  }
  return null;
}

/** 回收站接口错误码（契约 §14；兼容服务端 error.code 或 details.reason）。 */
export const TRASH_ERROR_CODES = [
  'RESTORE_PATH_EXISTS',
  'RESTORE_SHA_MISSING',
  'RESTORE_FAILED',
  'TRASH_DELETE_FAILED',
  'NOT_FOUND',
  'BAD_REQUEST',
] as const;

export type TrashErrorReason = (typeof TRASH_ERROR_CODES)[number] | 'unknown';

/** 从任意错误对象提取回收站错误码；认不出返回 'unknown'（UI 用兜底文案）。 */
export function trashErrorReason(error: unknown): TrashErrorReason {
  return (extractErrorCode(error, TRASH_ERROR_CODES) as TrashErrorReason | null) ?? 'unknown';
}

// ---------------------------------------------------------------- P1 排序

/** 工作副本排序：主工作副本固定第一，其余 running 卡片 > 有改动 > 有卡片 > 最近提交新→旧 > 分支名。 */
export function sortWorktreeGroups(
  worktrees: readonly WorkspaceWorktreeGroup[],
): WorkspaceWorktreeGroup[] {
  const rank = (worktree: WorkspaceWorktreeGroup): [number, number, number, number, number, string] => {
    const status = worktreeStatusInfo(worktree);
    const runningCards = worktree.cards.filter((card) => card.status === 'running').length;
    const dirty = status.changes !== 'clean' ? 1 : 0;
    const lastCommit = parseCommitTimestamp(worktree.lastCommitAt) ?? 0;
    return [worktree.isMain ? 0 : 1, -runningCards, -dirty, -worktree.cards.length, -lastCommit, worktree.branch ?? ''];
  };
  return [...worktrees].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < 5; index += 1) {
      const diff = (left[index] as number) - (right[index] as number);
      if (diff !== 0) return diff;
    }
    return left[5].localeCompare(right[5], 'zh-Hans-CN');
  });
}

/** 仓库块排序：有 running 卡片 > 有未保存改动 > 有卡片 > 名称。 */
export function sortRepoGroups(repos: readonly WorkspaceRepoGroup[]): WorkspaceRepoGroup[] {
  const rank = (repo: WorkspaceRepoGroup): [number, number, number, string] => {
    const runningCards = repo.worktrees.reduce(
      (total, worktree) => total + worktree.cards.filter((card) => card.status === 'running').length,
      0,
    );
    const dirty = repo.worktrees.some((worktree) => worktreeStatusInfo(worktree).changes !== 'clean');
    return [-runningCards, dirty ? 0 : 1, -repo.cardCount, repo.name];
  };
  return [...repos].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < 3; index += 1) {
      const diff = (left[index] as number) - (right[index] as number);
      if (diff !== 0) return diff;
    }
    return left[3].localeCompare(right[3], 'zh-Hans-CN');
  });
}

/** 每个仓库内的展示顺序：主工作副本 + 活跃工作副本 + 空闲工作副本（0 张卡片，主副本不算）。 */
export interface RepoWorktreeSplit {
  main: WorkspaceWorktreeGroup[];
  active: WorkspaceWorktreeGroup[];
  idle: WorkspaceWorktreeGroup[];
}

export function splitRepoWorktrees(worktrees: readonly WorkspaceWorktreeGroup[]): RepoWorktreeSplit {
  const sorted = sortWorktreeGroups(worktrees);
  return {
    main: sorted.filter((worktree) => worktree.isMain),
    active: sorted.filter((worktree) => !worktree.isMain && worktree.cards.length > 0),
    idle: sorted.filter((worktree) => !worktree.isMain && worktree.cards.length === 0),
  };
}

// ---------------------------------------------------------------- P1 卡片预览

/** 工作副本行内卡片预览上限（超出显示「还有 N 张」）。 */
export const WORKSPACE_CARD_PREVIEW_LIMIT = 5;

/** 卡片预览：默认只取前 N 张，返回被折叠的数量。 */
export function previewWorkspaceCards(
  cards: readonly Card[],
  limit = WORKSPACE_CARD_PREVIEW_LIMIT,
): { visible: Card[]; hiddenCount: number } {
  const safeLimit = Math.max(1, Math.floor(limit));
  if (cards.length <= safeLimit) return { visible: [...cards], hiddenCount: 0 };
  return { visible: cards.slice(0, safeLimit), hiddenCount: cards.length - safeLimit };
}

// ---------------------------------------------------------------- P1 筛选范围

/** 工作区卡片范围：只看当前筛选 / 显示全部（持久化在视图层）。 */
export type WorkspaceCardScope = 'filtered' | 'all';

/** 按范围选择分组用的卡片：filtered = 看板当前筛选结果，all = 全部未归档卡片。 */
export function selectWorkspaceCards(
  scope: WorkspaceCardScope,
  filteredCards: readonly Card[],
  allCards: readonly Card[],
): Card[] {
  return scope === 'filtered' ? [...filteredCards] : [...allCards];
}

// ---------------------------------------------------------------- P1 相对时间

/** 解析 ISO 时间字符串为毫秒；非法/缺失返回 null。 */
export function parseCommitTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 最近提交的相对时间（如「3 天前」）；无数据/非法时不显示（返回 null）。 */
export function formatLastCommitRelative(
  value: string | null | undefined,
  now: number = Date.now(),
  lang: Lang = 'zh',
): string | null {
  const at = parseCommitTimestamp(value);
  if (at === null) return null;
  return formatRelative(at, now, lang);
}

/** prune 接口错误码（契约 §15：PRUNE_FAILED / NOT_FOUND / BAD_REQUEST）。 */
export const PRUNE_ERROR_CODES = ['PRUNE_FAILED', 'NOT_FOUND', 'BAD_REQUEST'] as const;

export type PruneErrorReason = (typeof PRUNE_ERROR_CODES)[number] | 'unknown';

/** 从任意错误对象提取，认不出返回 'unknown'（UI 用兜底文案）。 */
export function pruneErrorReason(error: unknown): PruneErrorReason {
  return (extractErrorCode(error, PRUNE_ERROR_CODES) as PruneErrorReason | null) ?? 'unknown';
}

export interface WorkspacesController extends WorkspacesState {
  /** 手动刷新（清理成功等写操作后调用；会清掉当前目录集合的缓存并重新请求） */
  reload: () => void;
}

/**
 * 加载「工作区」视图数据。失败静默（保留已有结果），不阻塞视图。
 * @param cards 当前视图的卡片（内部只保留未归档且有 cwd 的）
 */
export function useWorkspaces(cards: readonly Card[]): WorkspacesController {
  const cwds = useMemo(() => collectWorkspaceCwds(cards), [cards]);
  const cwdKey = cwds.join('\u0000');
  const cwdsRef = useRef(cwds);
  cwdsRef.current = cwds;
  const [state, setState] = useState<WorkspacesState>(EMPTY_WORKSPACES);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => {
    const dirs = cwdsRef.current;
    if (dirs.length) cache.delete(cacheKeyFor(dirs));
    setReloadToken((token) => token + 1);
  }, []);

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
  }, [cwdKey, reloadToken]);

  return { ...state, reload };
}
