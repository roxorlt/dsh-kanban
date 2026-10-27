/**
 * 卡片会话归档/恢复的纯判定逻辑（docs/11-session-archive-linkage.md §4 / §12）。
 *
 * 服务端是最终裁决者（R1–R7 与活动写入同事务）；这里的预检只用于：
 * - 决定详情里是否渲染「归档会话」按钮、禁用原因；
 * - 「已完成列批量归档」dry-run 前的本地预览与跳过原因；
 * - 卡片完成后的轻提示判断。
 *
 * 判定必须与服务端一致：触发卡 done/canceled（R1）、会话绑定在该卡（R2）、
 * 反向扫描所有未归档绑定卡都完成（R4）、会话不在运行集合（R5）、
 * 无待确认项（R6）、宿主提供可逆归档能力（R7）。
 * 不碰 HTTP / React，便于单测。
 */
import type { Card, SessionActivityEntry, SessionActivityKind, SessionRow, Status } from '../types';
import type { NativePendingItem } from './nativeInbox';

/** 归档被阻止的原因类别（按 UI 展示顺序）。 */
export type SessionArchiveBlockerKind = 'card' | 'running' | 'pending' | 'host';

export interface SessionArchiveBlocker {
  kind: SessionArchiveBlockerKind;
  /** kind === 'card' 时：仍未完成的绑定卡片（含触发卡本身） */
  cards?: Card[];
}

export interface SessionArchiveReadinessInput {
  /** 触发卡 */
  card: Card;
  sessionId: string;
  /** 用于反向依赖扫描的全部卡片（已加载的看板卡片即可） */
  cards: readonly Card[];
  archivedSessionIds: ReadonlySet<string>;
  runningSessionIds: ReadonlySet<string>;
  pendingSessionIds: ReadonlySet<string>;
  /** 宿主是否提供可逆归档（GET /sessions/archive 的 available，R7） */
  available: boolean;
}

export interface SessionArchiveReadiness {
  /** 会话当前已在宿主归档集合中（R3） */
  archived: boolean;
  /** 触发卡本身是否处于终态 done/canceled（R1） */
  cardTerminal: boolean;
  /** 是否可以归档（!archived && 卡片可归档 && blockers 为空） */
  archivable: boolean;
  /** 阻止归档的原因；空数组即可归档 */
  blockers: SessionArchiveBlocker[];
  /** 反面依赖里仍未完成的绑定卡片（blockers 中 card 一类的数据） */
  blockingCards: Card[];
}

/** 卡片状态是否为终态（完成/取消）。 */
export function isTerminalCardStatus(status: Status): boolean {
  return status === 'done' || status === 'canceled';
}

/**
 * 从卡片视角判定某个绑定会话能否归档。
 * 规则与服务端一致；卡片已被归档（archived=true）时不可再作为触发卡。
 */
export function sessionArchiveReadiness(input: SessionArchiveReadinessInput): SessionArchiveReadiness {
  const { card, sessionId, cards, archivedSessionIds, runningSessionIds, pendingSessionIds, available } = input;
  const archived = archivedSessionIds.has(sessionId);
  const cardTerminal = isTerminalCardStatus(card.status) && !card.archived;

  // 反向依赖（R4）：所有未归档且绑定该会话的卡片都必须是终态。
  const seen = new Set<string>();
  const blockingCards: Card[] = [];
  for (const candidate of cards) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    if (candidate.archived) continue;
    if (!candidate.sessionIds?.includes(sessionId)) continue;
    if (isTerminalCardStatus(candidate.status)) continue;
    blockingCards.push(candidate);
  }
  // 传入的 cards 可能不含触发卡（如局部列表），R1 仍然要生效。
  if (!seen.has(card.id)) {
    if (!card.archived && !isTerminalCardStatus(card.status)) blockingCards.unshift(card);
    else if (!cardTerminal) blockingCards.unshift(card);
  }

  const blockers: SessionArchiveBlocker[] = [];
  if (!cardTerminal || blockingCards.length > 0) {
    const cardsForBlocker = cardTerminal
      ? blockingCards
      : [card, ...blockingCards.filter((item) => item.id !== card.id)];
    blockers.push({ kind: 'card', cards: cardsForBlocker });
  }
  if (runningSessionIds.has(sessionId)) blockers.push({ kind: 'running' });
  if (pendingSessionIds.has(sessionId)) blockers.push({ kind: 'pending' });
  if (!available) blockers.push({ kind: 'host' });

  return {
    archived,
    cardTerminal,
    archivable: !archived && cardTerminal && blockers.length === 0,
    blockers,
    blockingCards,
  };
}

/** UI 展示用的阻止原因摘要（翻译交给 i18n 层）。 */
export interface SessionArchiveBlockSummary {
  kind: SessionArchiveBlockerKind;
  /** kind === 'card' 时未完成卡片数量 */
  count?: number;
  /** kind === 'card' 时未完成卡片标题 */
  titles?: string[];
}

/** 取第一条阻止原因，供按钮禁用说明使用。 */
export function summarizeSessionArchiveBlocker(
  blockers: readonly SessionArchiveBlocker[],
): SessionArchiveBlockSummary | null {
  const first = blockers[0];
  if (!first) return null;
  if (first.kind === 'card') {
    const cards = first.cards ?? [];
    return { kind: 'card', count: cards.length, titles: cards.map((card) => card.title) };
  }
  return { kind: first.kind };
}

// ---------------------------------------------------------------- 批量预览

export interface SessionArchiveBatchArchivable {
  sessionId: string;
  /** 代表卡（最早出现的终态绑定卡） */
  cardId: string;
}

export interface SessionArchiveBatchSkipped {
  sessionId: string;
  cardId: string;
  /** 第一条原因类别（含服务端额外的 archived/missing/failed） */
  kind: SessionArchiveSkipKind;
  /** 未完成的绑定卡片（kind === 'card' 时） */
  blockingCards: Array<Pick<Card, 'id' | 'title' | 'status'>>;
}

export interface SessionArchiveBatchPreview {
  archivable: SessionArchiveBatchArchivable[];
  skipped: SessionArchiveBatchSkipped[];
}

export interface DoneBatchPreviewInput {
  cards: readonly Card[];
  archivedSessionIds: ReadonlySet<string>;
  runningSessionIds: ReadonlySet<string>;
  pendingSessionIds: ReadonlySet<string>;
  available: boolean;
}

/**
 * 「已完成列批量归档」的前端预览：扫描所有 done/canceled 且未归档的卡片，
 * 按会话去重后逐个套用与服务端一致的判定（dry-run 结果应以服务端返回为准）。
 */
export function doneBatchPreview(input: DoneBatchPreviewInput): SessionArchiveBatchPreview {
  const { cards, archivedSessionIds, runningSessionIds, pendingSessionIds, available } = input;
  const representatives = new Map<string, Card>();
  for (const card of cards) {
    if (card.archived || !isTerminalCardStatus(card.status)) continue;
    for (const sessionId of card.sessionIds ?? []) {
      if (!sessionId) continue;
      if (!representatives.has(sessionId)) representatives.set(sessionId, card);
    }
  }

  const archivable: SessionArchiveBatchArchivable[] = [];
  const skipped: SessionArchiveBatchSkipped[] = [];
  for (const [sessionId, card] of representatives) {
    // 服务端 dryRun 把已归档会话归入 skipped.reason='already_archived'
    if (archivedSessionIds.has(sessionId)) {
      skipped.push({ sessionId, cardId: card.id, kind: 'archived', blockingCards: [] });
      continue;
    }
    const readiness = sessionArchiveReadiness({
      card,
      sessionId,
      cards,
      archivedSessionIds,
      runningSessionIds,
      pendingSessionIds,
      available,
    });
    if (readiness.archivable) {
      archivable.push({ sessionId, cardId: card.id });
      continue;
    }
    skipped.push({
      sessionId,
      cardId: card.id,
      kind: readiness.blockers[0]?.kind ?? 'card',
      blockingCards: readiness.blockingCards.map(({ id, title, status }) => ({ id, title, status })),
    });
  }
  return { archivable, skipped };
}

// ---------------------------------------------------------------- 集合派生

/** 从会话列表派生运行中的会话 id 集合（R5 预检）。 */
export function deriveRunningSessionIds(sessions: readonly Pick<SessionRow, 'id' | 'running'>[]): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) if (session.running) ids.add(session.id);
  return ids;
}

/** 从原生待确认收件派生有待确认项的会话 id 集合（R6 预检）。 */
export function derivePendingSessionIds(items: readonly Pick<NativePendingItem, 'sessionId'>[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) if (item.sessionId) ids.add(item.sessionId);
  return ids;
}

/** 归一化宿主/接口返回的会话 id 列表（过滤非法值并去重）。 */
export function normalizeSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------- 错误详情解析

const ACTIVITY_KINDS: ReadonlySet<string> = new Set<SessionActivityKind>(['turn', 'job', 'subagent', 'schedule']);

/** 解析 SESSION_ACTIVE 错误里的 activity 清单（容忍缺失/脏数据）。 */
export function parseSessionActivity(value: unknown): SessionActivityEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: SessionActivityEntry[] = [];
  for (const raw of value.slice(0, 16)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as { kind?: unknown; items?: unknown };
    if (typeof record.kind !== 'string' || !ACTIVITY_KINDS.has(record.kind)) continue;
    const items = Array.isArray(record.items)
      ? record.items
          .filter((item): item is { id: string; label?: string } => Boolean(item) && typeof (item as { id?: unknown }).id === 'string')
          .slice(0, 20)
          .map((item) => ({
            id: item.id,
            ...(typeof item.label === 'string' && item.label ? { label: item.label } : {}),
          }))
      : [];
    entries.push({ kind: record.kind as SessionActivityKind, ...(items.length ? { items } : {}) });
  }
  return entries;
}

/** SESSION_BUSY_CARDS 里的卡片摘要（status 为服务端原样字符串，可能是未知状态）。 */
export interface SessionArchiveBlockingCard {
  id: string;
  title: string;
  status: string;
}

/** 解析 SESSION_BUSY_CARDS 错误里的 blockingCards 清单。 */
export function parseBlockingCards(value: unknown): SessionArchiveBlockingCard[] {
  if (!Array.isArray(value)) return [];
  const cards: SessionArchiveBlockingCard[] = [];
  for (const raw of value.slice(0, 50)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as { id?: unknown; title?: unknown; status?: unknown };
    if (typeof record.id !== 'string' || !record.id) continue;
    cards.push({
      id: record.id,
      title: typeof record.title === 'string' && record.title ? record.title : record.id,
      status: typeof record.status === 'string' ? record.status : 'unknown',
    });
  }
  return cards;
}

/**
 * 批量 dryRun 的跳过原因类别：归档阻止原因 + 服务端额外原因
 * （already_archived / missing / failed，见服务端 archive-batch 契约）。
 */
export type SessionArchiveSkipKind = SessionArchiveBlockerKind | 'archived' | 'missing' | 'failed' | 'other';

/** 服务端 skipped.reason 归一化成本地原因类别（兼容错误码/中英文本）。 */
export function normalizeSkipReason(reason: string): SessionArchiveSkipKind {
  const text = reason.toLowerCase();
  if (/already[-_ ]?archiv/.test(text)) return 'archived';
  if (/busy[-_ ]?cards|blocking[-_ ]?cards|card|not[-_ ]?done|未完成|卡片/.test(text)) return 'card';
  if (/active|running|in[-_ ]?progress|运行/.test(text)) return 'running';
  if (/pending|confirm|待确认|待处理/.test(text)) return 'pending';
  if (/missing|not[-_ ]?found|deleted|不存在|已删除/.test(text)) return 'missing';
  if (/unavailable|unsupported|not[-_ ]?supported|host|version|不支持|不可用|版本/.test(text)) return 'host';
  if (/failed|error|失败/.test(text)) return 'failed';
  return 'other';
}

/** 把卡片/会话标题拼成一句可读文案（超过 max 条时截断并给出总数）。 */
export function formatTitleList(titles: readonly string[], lang: 'zh' | 'en', max = 3): string {
  const list = titles.filter((title) => title.length > 0);
  if (!list.length) return '';
  const separator = lang === 'zh' ? '、' : ', ';
  if (list.length <= max) return list.join(separator);
  const shown = list.slice(0, max).join(separator);
  return lang === 'zh' ? `${shown} 等 ${list.length} 项` : `${shown} +${list.length - max} more`;
}

// ---------------------------------------------------------------- 活动摘要

export interface SessionActivityGroup {
  kind: SessionActivityKind;
  count: number;
  labels: string[];
}

/**
 * 汇总「停止并归档」确认框里的工作清单：
 * turn 一项一回合计 1；job/subagent/schedule 按 items 数计；无 items 时按 1 计。
 */
export function summarizeSessionActivity(entries: readonly SessionActivityEntry[]): SessionActivityGroup[] {
  const groups: SessionActivityGroup[] = [];
  for (const entry of entries) {
    const items = entry.items ?? [];
    const count = items.length || 1;
    groups.push({
      kind: entry.kind,
      count,
      labels: items.map((item) => item.label ?? item.id).filter((label) => label.length > 0),
    });
  }
  return groups;
}
