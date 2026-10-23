import type { Card } from '../types';

export interface CardFilters {
  query: string;
  project: string | null;
}

export const EMPTY_FILTERS: CardFilters = { query: '', project: null };

export function hasActiveFilters(filters: CardFilters): boolean {
  return filters.query.trim().length > 0 || filters.project !== null;
}

/**
 * 搜索（标题/摘要/项目）+ 项目筛选，全部 AND 组合、大小写不敏感。
 * 空字符串 filters 视为不筛选。
 * 注：v0.9.0 起卡片优先级/标签从界面隐藏（API 与数据保留），因此搜索不再匹配标签。
 */
export function filterCards(cards: readonly Card[], filters: CardFilters): Card[] {
  const query = filters.query.trim().toLowerCase();
  return cards.filter((card) => {
    if (card.archived) return false;
    if (filters.project !== null && (card.project ?? '') !== filters.project) return false;
    if (!query) return true;
    const haystacks = [card.title, card.summary, card.project ?? ''];
    return haystacks.some((text) => text.toLowerCase().includes(query));
  });
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

export function extractProjects(cards: readonly Card[]): string[] {
  return uniqueSorted(cards.filter((c) => !c.archived).map((c) => c.project ?? ''));
}
