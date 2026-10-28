/**
 * 卡片「工作线」徽标的批量状态 hook（docs/contracts/02-http-api.md §11）。
 *
 * - 输入看板卡片列表：只取未归档、有 cwd 的卡片，cwd 去重；
 * - debounce 400ms 后按批（每批 ≤32）请求 `POST /git/summaries`；
 * - 模块内按 cwd 缓存 15s（与详情抽屉的 4s 缓存独立，避免 N 张卡 N 次 git 探测）；
 * - 每 20s 刷新一次；`document.hidden` 时暂停，重新可见时补一次；
 * - 返回 `Record<cwd, WorklineStatus | null>`：null = 探测失败/不可用（徽标显示灰色未知），
 *   key 不存在 = 还没探测完、卡片没有 cwd、或目录根本不是 git 仓库（徽标不渲染）。
 *   契约 §5：非 git 仓库不显示；其余探测失败才显示灰色「工作线未知」。失败静默，不阻塞看板。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Card, GitSummary } from '../types';
import { buildWorklineStatus } from './worklineSummary';
import type { WorklineStatus } from './worklineSummary';

/** 模块缓存 TTL（契约 §4.6：前端按仓库聚合、TTL 15s）。 */
export const WORKLINE_CACHE_TTL_MS = 15_000;
/** 卡片/cwd 变化后的批量请求 debounce。 */
export const WORKLINE_DEBOUNCE_MS = 400;
/** 可见状态下的刷新间隔。 */
export const WORKLINE_REFRESH_MS = 20_000;
/** 单次请求的目录上限（契约 §11：1–32 个，超出分批）。 */
export const WORKLINE_BATCH_SIZE = 32;

/** cwd → 工作线状态；null 表示已探测但不可用/失败。 */
export type WorklineStatusMap = Record<string, WorklineStatus | null>;

/** 缓存值：hidden = 不是 git 仓库/无工作线（徽标不显示，避免反复探测）。 */
type WorklineCachedStatus = WorklineStatus | null | 'hidden';

interface WorklineCacheEntry {
  at: number;
  status: WorklineCachedStatus;
}

const cache = new Map<string, WorklineCacheEntry>();

function cacheRead(cwd: string): WorklineCachedStatus | undefined {
  const hit = cache.get(cwd);
  if (!hit) return undefined;
  if (Date.now() - hit.at > WORKLINE_CACHE_TTL_MS) {
    cache.delete(cwd);
    return undefined;
  }
  return hit.status;
}

function cacheWrite(cwd: string, status: WorklineCachedStatus): void {
  cache.set(cwd, { at: Date.now(), status });
}

/** 清空模块缓存（调试/测试用；正常展示依赖 TTL 自然过期）。 */
export function clearWorklineCache(): void {
  cache.clear();
}

/** 从卡片列表收集需要探测的 cwd：未归档、有 cwd、去重（保持出现顺序）。 */
export function collectWorklineCwds(cards: readonly Card[]): string[] {
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

/** 按每批 ≤32 个切分目录（服务端 body 限制 1–32）。 */
export function chunkWorklineDirs(dirs: readonly string[], size = WORKLINE_BATCH_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < dirs.length; index += size) {
    chunks.push(dirs.slice(index, index + size));
  }
  return chunks;
}

/**
 * Git 摘要 → 工作线状态。
 * 返回 undefined = 没有工作线可言（非 git 仓库 / 无 cwd）→ 徽标不显示；
 * 返回 null = 其余探测失败（missing/timeout/error/forbidden）→ 徽标显示灰色「工作线未知」。
 */
export function worklineStatusFromSummary(summary: GitSummary): WorklineStatus | null | undefined {
  if (!summary.available) {
    return summary.reason === 'not_git' || summary.reason === 'no_cwd' ? undefined : null;
  }
  return buildWorklineStatus({
    branch: summary.branch,
    detached: summary.detached,
    mainBranch: summary.mainBranch,
    base: summary.base,
    upstream: summary.upstream,
  });
}

/**
 * 批量加载卡片 cwd 的工作线状态。
 * @param cards 当前视图的卡片（内部只保留未归档且有 cwd 的）
 */
export function useWorklineStatuses(cards: readonly Card[]): WorklineStatusMap {
  const cwds = useMemo(() => collectWorklineCwds(cards), [cards]);
  // cwd 列表内容不变（卡片对象频繁更新）时不要重启 debounce/刷新定时器
  const cwdKey = cwds.join('\u0000');
  const cwdsRef = useRef(cwds);
  cwdsRef.current = cwds;
  const [statuses, setStatuses] = useState<WorklineStatusMap>({});

  useEffect(() => {
    // 没有需要探测的 cwd 时不建定时器（卡片后续出现会因 cwdKey 变化重跑）
    if (!cwdKey) return undefined;
    let disposed = false;
    let debounceTimer: number | null = null;

    const merge = (next: WorklineStatusMap): void => {
      if (disposed || Object.keys(next).length === 0) return;
      setStatuses((previous) => ({ ...previous, ...next }));
    };

    const refresh = async (): Promise<void> => {
      const dirs = cwdsRef.current;
      if (!dirs.length) return;
      // 先复用未过期的缓存，只请求缺失/过期的目录
      const pending: string[] = [];
      const cachedNow: WorklineStatusMap = {};
      for (const dir of dirs) {
        const cached = cacheRead(dir);
        if (cached === undefined) pending.push(dir);
        else if (cached !== 'hidden') cachedNow[dir] = cached;
      }
      merge(cachedNow);
      for (const batch of chunkWorklineDirs(pending)) {
        try {
          const summaries = await api.getGitSummaries(batch);
          if (disposed) return;
          const next: WorklineStatusMap = {};
          for (const dir of batch) {
            const summary = summaries[dir];
            const status = summary ? worklineStatusFromSummary(summary) : null;
            if (status === undefined) {
              // 非 git 仓库 / 无工作线：缓存为 hidden，徽标不显示
              cacheWrite(dir, 'hidden');
            } else {
              cacheWrite(dir, status);
              next[dir] = status;
            }
          }
          merge(next);
        } catch {
          if (disposed) return;
          // 请求失败：本次按未知处理，不写缓存（下一轮重试）；不打扰用户
          const next: WorklineStatusMap = {};
          for (const dir of batch) next[dir] = null;
          merge(next);
        }
      }
    };

    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      if (!disposed) void refresh();
    }, WORKLINE_DEBOUNCE_MS);

    const interval = window.setInterval(() => {
      if (document.hidden) return; // 页面不可见时暂停
      void refresh();
    }, WORKLINE_REFRESH_MS);

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

  return statuses;
}
