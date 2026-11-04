/**
 * Super-Agent Runtime 与看板收敛巡检纯函数（v0.27.0）：
 * - describeCardRuntime：从卡片提取 Auto-Start、Watchdog 巡检/催办/退避重试/停滞熔断、等待条件与上游交接状态；
 * - collectBoardHygieneCandidates：识别已完成/已取消超期卡片与已合并卡片，供顶部收敛横幅一键归档。
 */
import type { Card } from '../types';

export type WatchdogVisualState =
  | 'idle'
  | 'guarding'
  | 'nudged'
  | 'stalled'
  | 'retrying'
  | 'retry_exhausted';

export interface CardWaitVisual {
  notBefore: number;
  remainingMs: number;
  reason?: string;
}

export interface CardRuntimeSummary {
  autoStart: boolean;
  isUpstreamHandoff: boolean;
  waitActive: CardWaitVisual | null;
  watchdogState: WatchdogVisualState;
  generation: number;
  nudgesUsed: number;
  retriesUsed: number;
}

export function describeCardRuntime(card: Card, now: number): CardRuntimeSummary {
  const autoStart = card.autoStart === true;
  const isUpstreamHandoff = Boolean(
    card.handoff?.summary?.startsWith('【前置完成】') ||
      card.handoff?.summary?.startsWith('上游接力摘要'),
  );
  const generation = Math.max(1, card.runtime?.generation ?? 1);
  const nudgesUsed = Math.max(0, card.runtime?.budget?.nudgesUsed ?? 0);
  const retriesUsed = Math.max(0, card.runtime?.budget?.retriesUsed ?? 0);

  const waitCond = card.runtime?.waitCondition;
  const waitActive: CardWaitVisual | null =
    waitCond && waitCond.kind === 'time' && typeof waitCond.notBefore === 'number' && waitCond.notBefore > now
      ? {
          notBefore: waitCond.notBefore,
          remainingMs: Math.max(0, waitCond.notBefore - now),
          ...(waitCond.reason ? { reason: waitCond.reason } : {}),
        }
      : null;

  let watchdogState: WatchdogVisualState = 'idle';
  if (card.status === 'blocked' && nudgesUsed >= 1) {
    watchdogState = 'stalled';
  } else if (card.status === 'running' && nudgesUsed >= 1) {
    watchdogState = 'nudged';
  } else if (card.status === 'failed' && retriesUsed >= 2) {
    watchdogState = 'retry_exhausted';
  } else if (card.status === 'failed' && retriesUsed >= 1) {
    watchdogState = 'retrying';
  } else if (card.status === 'running' && card.sessionIds.length > 0 && !waitActive) {
    watchdogState = 'guarding';
  }

  return {
    autoStart,
    isUpstreamHandoff,
    waitActive,
    watchdogState,
    generation,
    nudgesUsed,
    retriesUsed,
  };
}

export interface BoardHygienePlan {
  /** 可一键归档的历史完成/取消/已合并卡片 ID 列表 */
  archivableIds: string[];
  /** 已完成超过 staleDays 天的卡片数 */
  staleDoneCount: number;
  /** 已合并（mergedInto）但未归档的卡片数 */
  mergedCount: number;
  /** 当前未归档的 done/canceled 总数 */
  totalSettled: number;
  staleDays: number;
}

const DAY_MS = 86_400_000;
const HYGIENE_DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 扫描当前看板可一键收敛归档的卡片：
 * 1) 所有带 mergedInto 的未归档源卡；
 * 2) 已完成（done）或已取消（canceled）且距今超过 staleDays（默认 3 天）的卡片；
 * 3) 若未满 3 天但已完成列堆积超过 8 张，则把最旧的多余已完成卡（保留最近 5 张）纳入建议归档集。
 */
export function collectBoardHygieneCandidates(
  cards: readonly Card[],
  now: number,
  staleDays = 3,
): BoardHygienePlan {
  const cutoff = now - staleDays * DAY_MS;
  const unarchived = cards.filter((card) => !card.archived);
  const settled = unarchived
    .filter((card) => card.status === 'done' || card.status === 'canceled')
    .sort((a, b) => (b.completedAt ?? b.updatedAt ?? 0) - (a.completedAt ?? a.updatedAt ?? 0));

  const archivableSet = new Set<string>();
  let staleDoneCount = 0;
  let mergedCount = 0;

  for (const card of unarchived) {
    if (card.mergedInto) {
      archivableSet.add(card.id);
      mergedCount += 1;
    }
  }

  for (const card of settled) {
    const settledAt = card.completedAt ?? card.updatedAt ?? card.createdAt ?? 0;
    if (settledAt > 0 && settledAt <= cutoff) {
      if (!archivableSet.has(card.id)) staleDoneCount += 1;
      archivableSet.add(card.id);
    }
  }

  // 若已完成列堆积超过 8 张，把排在第 5 张之后的旧完成卡也加入可归档集合
  if (settled.length > 8) {
    for (const card of settled.slice(5)) {
      if (!archivableSet.has(card.id)) {
        staleDoneCount += 1;
        archivableSet.add(card.id);
      }
    }
  }

  return {
    archivableIds: [...archivableSet],
    staleDoneCount,
    mergedCount,
    totalSettled: settled.length,
    staleDays,
  };
}

export function shouldShowHygieneNudge(
  candidateCount: number,
  dismissedAt: number | null,
  now: number,
): boolean {
  if (candidateCount <= 0) return false;
  if (dismissedAt !== null && Number.isFinite(dismissedAt) && now - dismissedAt < HYGIENE_DISMISS_TTL_MS) {
    return false;
  }
  return true;
}
