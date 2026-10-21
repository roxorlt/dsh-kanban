import type { Card } from '../types';
import { isActiveStatus } from './status';

export type Lang = 'zh' | 'en';

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * 工作时间：优先用服务端 metadata.elapsedMs；否则从 startedAt 计算，
 * 运行中卡片按 `now` 走表，已结束卡片到 completedAt 封顶。
 */
export function elapsedMs(card: Card, now: number = Date.now()): number {
  if (typeof card.metadata.elapsedMs === 'number') return Math.max(0, card.metadata.elapsedMs);
  if (typeof card.startedAt !== 'number') return 0;
  const end = isActiveStatus(card.status) ? now : (card.completedAt ?? card.updatedAt ?? now);
  return Math.max(0, end - card.startedAt);
}

/** 紧凑时长：en "6m 48s"，zh "6 分 48 秒"。小于 1s 显示 <1s / 不到 1 秒。 */
export function formatDuration(ms: number, lang: Lang = 'zh'): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (ms > 0 && totalSeconds === 0) return lang === 'zh' ? '不到 1 秒' : '<1s';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (lang === 'zh') {
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
    return `${seconds} 秒`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** 相对时间：刚刚/3 分钟前/2 小时前/3 天前，超过 7 天给日期。 */
export function formatRelative(at: number, now: number = Date.now(), lang: Lang = 'zh'): string {
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return lang === 'zh' ? '刚刚' : 'just now';
  if (diff < hour) {
    const m = Math.floor(diff / minute);
    return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`;
  }
  if (diff < day) {
    const h = Math.floor(diff / hour);
    return lang === 'zh' ? `${h} 小时前` : `${h}h ago`;
  }
  if (diff < 7 * day) {
    const d = Math.floor(diff / day);
    return lang === 'zh' ? `${d} 天前` : `${d}d ago`;
  }
  return formatDateTime(at, lang);
}

/** 本地日期时间：2026-10-21 08:48。 */
export function formatDateTime(at: number, _lang: Lang = 'zh'): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

/** 短日期：10-21。 */
export function formatShortDate(at: number): string {
  const date = new Date(at);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
