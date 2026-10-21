import type { Activity, ActivityPage } from '../types';

/** 展开卡默认显示的最近节点数 */
export const CARD_TIMELINE_PREVIEW = 3;
/** 每次「加载更早」在客户端追加的条数 */
export const CARD_TIMELINE_STEP = 5;
/** 详情抽屉首屏拉取条数 */
export const DRAWER_TIMELINE_PAGE = 20;
/** 详情抽屉每次「加载更早」拉取条数 */
export const DRAWER_TIMELINE_STEP = 20;

export interface ActivityFeed {
  items: Activity[];
  hasMore: boolean;
  nextBefore?: string;
  loading: boolean;
  error?: string;
}

export const EMPTY_FEED: ActivityFeed = { items: [], hasMore: false, loading: false };

/** 合并分页结果：按 id 去重、按时间倒序；reset 时丢弃旧数据。 */
export function mergeActivityPages(
  current: readonly Activity[],
  incoming: readonly Activity[],
  options: { reset?: boolean } = {},
): Activity[] {
  const map = new Map<string, Activity>();
  const base = options.reset ? [] : current;
  for (const activity of base) map.set(activity.id, activity);
  for (const activity of incoming) map.set(activity.id, activity);
  return [...map.values()].sort((a, b) => {
    if (b.at !== a.at) return b.at - a.at;
    return a.id.localeCompare(b.id);
  });
}

/** 把接口分页响应合并进现有 feed（兼容没有 hasMore 的老服务端）。 */
export function applyPage(feed: ActivityFeed, page: ActivityPage, options: { reset?: boolean } = {}): ActivityFeed {
  const items = mergeActivityPages(feed.items, page.activities, options);
  const hasMore = page.hasMore ?? false;
  const nextBefore = page.nextBefore ?? items[items.length - 1]?.id;
  return {
    items,
    hasMore,
    ...(hasMore && nextBefore ? { nextBefore } : {}),
    loading: false,
    ...(feed.error && options.reset ? { error: feed.error } : {}),
  };
}

/** 卡片展开时是否需要首屏拉取。 */
export function needsInitialFeed(feed: ActivityFeed | undefined): boolean {
  return !feed || (!feed.loading && feed.items.length === 0 && !feed.error);
}

/** 按可见条数截取时间线（加载更早只影响可见条数）。 */
export function visibleActivities(feed: ActivityFeed | undefined, visibleCount: number): Activity[] {
  return (feed?.items ?? []).slice(0, Math.max(0, visibleCount));
}
