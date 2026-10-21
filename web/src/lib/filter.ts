import type { Card } from '../types';

export interface CardFilters {
  query: string;
  project: string | null;
  label: string | null;
}

export const EMPTY_FILTERS: CardFilters = { query: '', project: null, label: null };

export function hasActiveFilters(filters: CardFilters): boolean {
  return filters.query.trim().length > 0 || filters.project !== null || filters.label !== null;
}

/**
 * 搜索（标题/摘要/项目/标签）+ 项目筛选 + 标签筛选，全部 AND 组合、大小写不敏感。
 * 空字符串 filters 视为不筛选。
 */
export function filterCards(cards: readonly Card[], filters: CardFilters): Card[] {
  const query = filters.query.trim().toLowerCase();
  return cards.filter((card) => {
    if (card.archived) return false;
    if (filters.project !== null && (card.project ?? '') !== filters.project) return false;
    if (filters.label !== null && !card.labels.includes(filters.label)) return false;
    if (!query) return true;
    const haystacks = [card.title, card.summary, card.project ?? '', ...card.labels];
    return haystacks.some((text) => text.toLowerCase().includes(query));
  });
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

export function extractProjects(cards: readonly Card[]): string[] {
  return uniqueSorted(cards.filter((c) => !c.archived).map((c) => c.project ?? ''));
}

export function extractLabels(cards: readonly Card[]): string[] {
  const labels: string[] = [];
  for (const card of cards) {
    if (card.archived) continue;
    labels.push(...card.labels);
  }
  return uniqueSorted(labels);
}
