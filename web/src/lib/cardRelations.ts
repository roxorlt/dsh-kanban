/**
 * 父子卡 / 依赖关系 + 完成拦截（409）的纯逻辑（v0.22.0）。
 *
 * 数据来源：服务端 cards 数组里每张卡片可选带 `parentCardId` / `dependsOn` / `mergedInto`，
 * 父子与依赖反查全部在客户端用「全量未归档卡片」计算，不新增接口。
 * 旧服务端 / 旧数据没有这些字段时，所有函数返回空值、不抛错（UI 自然不渲染）。
 *
 * 这里只放纯函数，不依赖 React / DOM，便于单测。
 */
import type { Card, Status } from '../types';

/** 子卡 / 依赖行的最小展示信息。 */
export interface RelationCardRef {
  id: string;
  title: string;
  status: Status;
}

/** 子卡汇总：done = 已收口（done / canceled），open = 未收口（与服务端「完成拦截」口径一致）。 */
export interface ChildrenSummary {
  total: number;
  done: number;
  open: number;
  items: RelationCardRef[];
}

/** 依赖行：ready = 依赖卡已收口；依赖卡不在当前数据里（已归档/被删）时 status=null、ready=false。 */
export interface DependSummary {
  id: string;
  title: string;
  status: Status | null;
  ready: boolean;
  /** 依赖卡不在当前卡片数据里（已归档或被删），title 用 id 兜底 */
  missing: boolean;
}

/** 完成拦截里服务端回传的「未收口子卡」。 */
export interface OpenChildRef {
  id: string;
  title: string;
  status: string;
}

export interface CardRelationIndex {
  /** 全部卡片（含归档，若传入）按 id 索引；重复 id 以先出现的为准 */
  cardsById: Map<string, Card>;
  /** 未归档卡片按 parentCardId 分组 */
  childrenByParent: Map<string, Card[]>;
  /** 未归档卡片按 dependsOn 反查：依赖卡 id → 依赖它的卡片 */
  dependentByDep: Map<string, Card[]>;
}

/** 已收口状态（与服务端「未收口」= 不在 done/canceled 的口径一致）。 */
const CLOSED_STATUSES: ReadonlySet<Status> = new Set<Status>(['done', 'canceled']);

/** 子卡 / 依赖展示条数上限：脏数据把数组撑爆时也不会渲染成百上千行。 */
export const MAX_RELATION_ITEMS = 50;

export function isClosedStatus(status: Status | null | undefined): boolean {
  return status != null && CLOSED_STATUSES.has(status);
}

/** 标题兜底：空标题回落到 id，避免渲染空行。 */
export function relationTitle(card: Pick<Card, 'title'> | undefined, fallbackId: string): string {
  const title = typeof card?.title === 'string' ? card.title.trim() : '';
  return title || fallbackId;
}

const EMPTY_INDEX: CardRelationIndex = {
  cardsById: new Map(),
  childrenByParent: new Map(),
  dependentByDep: new Map(),
};

/**
 * 建关系索引：
 * - 重复 id 只保留第一张（避免同一张卡在子卡列表里出现两次）；
 * - 子卡 / 依赖反查只看未归档卡片（服务端的直接子卡、依赖唤醒也都只算未归档卡）；
 * - 自引用（parentCardId === 自身 id、dependsOn 含自身）直接跳过，不报错。
 */
export function buildCardRelationIndex(cards: readonly Card[] | null | undefined): CardRelationIndex {
  if (!Array.isArray(cards)) return EMPTY_INDEX;
  const cardsById = new Map<string, Card>();
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;
    if (typeof card.id !== 'string' || !card.id) continue;
    if (!cardsById.has(card.id)) cardsById.set(card.id, card);
  }

  const childrenByParent = new Map<string, Card[]>();
  const dependentByDep = new Map<string, Card[]>();
  for (const card of cardsById.values()) {
    if (card.archived === true) continue;
    const parentId = typeof card.parentCardId === 'string' ? card.parentCardId.trim() : '';
    if (parentId && parentId !== card.id) {
      const list = childrenByParent.get(parentId);
      if (list) list.push(card);
      else childrenByParent.set(parentId, [card]);
    }
    const dependsOn = Array.isArray(card.dependsOn) ? card.dependsOn : [];
    const seen = new Set<string>();
    for (const raw of dependsOn) {
      if (typeof raw !== 'string') continue;
      const depId = raw.trim();
      if (!depId || depId === card.id || seen.has(depId)) continue;
      seen.add(depId);
      const dependents = dependentByDep.get(depId);
      if (dependents) dependents.push(card);
      else dependentByDep.set(depId, [card]);
    }
  }

  return { cardsById, childrenByParent, dependentByDep };
}

/** 卡片自己的直接未归档子卡（无则空数组）。 */
export function childCardsOf(
  card: Pick<Card, 'id'> | null | undefined,
  index: CardRelationIndex | null | undefined,
): Card[] {
  if (!card || typeof card.id !== 'string' || !index) return [];
  return index.childrenByParent.get(card.id) ?? [];
}

/** 子卡汇总：total / 已收口 done / 未收口 open + 明细。 */
export function describeChildren(
  card: Pick<Card, 'id'> | null | undefined,
  index: CardRelationIndex | null | undefined,
): ChildrenSummary {
  const all = childCardsOf(card, index);
  // 统计口径用全量子卡（徽标数字不能因为明细截断而变小），明细最多渲染 MAX_RELATION_ITEMS 条
  const done = all.filter((child) => isClosedStatus(child.status)).length;
  const items: RelationCardRef[] = all.slice(0, MAX_RELATION_ITEMS).map((child) => ({
    id: child.id,
    title: relationTitle(child, child.id),
    status: child.status,
  }));
  return { total: all.length, done, open: all.length - done, items };
}

/**
 * 卡片的前置依赖明细（去重、跳过自引用/非法值）。
 * 依赖卡不在当前数据里（例如已归档）时保留一行：status=null、ready=false、missing=true。
 */
export function describeDepends(
  card: Pick<Card, 'id' | 'dependsOn'> | null | undefined,
  cardsById: ReadonlyMap<string, Card> | null | undefined,
): DependSummary[] {
  if (!card || !Array.isArray(card.dependsOn) || !cardsById) return [];
  const seen = new Set<string>();
  const items: DependSummary[] = [];
  for (const raw of card.dependsOn.slice(0, MAX_RELATION_ITEMS)) {
    if (typeof raw !== 'string') continue;
    const depId = raw.trim();
    if (!depId || depId === card.id || seen.has(depId)) continue;
    seen.add(depId);
    const target = cardsById.get(depId);
    if (!target) {
      items.push({ id: depId, title: depId, status: null, ready: false, missing: true });
      continue;
    }
    items.push({
      id: depId,
      title: relationTitle(target, depId),
      status: target.status,
      ready: isClosedStatus(target.status),
      missing: false,
    });
  }
  return items;
}

/**
 * 依赖是否全部就绪：没有 dependsOn 视为就绪；有任一条依赖缺失或未收口即未就绪。
 * 与 describeDepends 的 ready 口径一致。
 */
export function isDependencyReady(
  card: Pick<Card, 'id' | 'dependsOn'> | null | undefined,
  cardsById: ReadonlyMap<string, Card> | null | undefined,
): boolean {
  if (!card || !Array.isArray(card.dependsOn) || card.dependsOn.length === 0) return true;
  if (!cardsById) return false;
  for (const raw of card.dependsOn) {
    if (typeof raw !== 'string') return false;
    const depId = raw.trim();
    if (!depId || depId === card.id) continue;
    const target = cardsById.get(depId);
    if (!target || !isClosedStatus(target.status)) return false;
  }
  return true;
}

/** 父卡对象；自引用/缺失时返回 null。 */
export function parentCardOf(
  card: Pick<Card, 'id' | 'parentCardId'> | null | undefined,
  cardsById: ReadonlyMap<string, Card> | null | undefined,
): Card | null {
  if (!card || !cardsById) return null;
  const parentId = typeof card.parentCardId === 'string' ? card.parentCardId.trim() : '';
  if (!parentId || parentId === card.id) return null;
  return cardsById.get(parentId) ?? null;
}

/** 合并去向卡对象（仅归档源卡有 mergedInto）；缺失时返回 null。 */
export function mergedTargetOf(
  card: Pick<Card, 'id' | 'mergedInto'> | null | undefined,
  cardsById: ReadonlyMap<string, Card> | null | undefined,
): Card | null {
  if (!card || !cardsById) return null;
  const targetId = typeof card.mergedInto === 'string' ? card.mergedInto.trim() : '';
  if (!targetId || targetId === card.id) return null;
  return cardsById.get(targetId) ?? null;
}

// ------------------------------------------------------------ 完成拦截（409 CARD_HAS_OPEN_CHILDREN）

function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** 归一化服务端回传的 openChildren（脏数据逐条跳过，最多 50 条）。 */
export function normalizeOpenChildren(value: unknown): OpenChildRef[] {
  if (!Array.isArray(value)) return [];
  const items: OpenChildRef[] = [];
  for (const raw of value.slice(0, MAX_RELATION_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as { id?: unknown; title?: unknown; status?: unknown };
    if (typeof record.id !== 'string' || !record.id) continue;
    items.push({
      id: record.id,
      title: textOf(record.title, record.id),
      status: textOf(record.status, 'unknown'),
    });
  }
  return items;
}

/**
 * 从错误响应里取「未收口子卡」清单。
 * 契约写的是 error.extra.openChildren；兼容顶层 openChildren / data.openChildren，
 * 也兼容旧形态的字符串数组（只给 id）。
 */
export function extractOpenChildren(details: unknown): OpenChildRef[] {
  if (!details || typeof details !== 'object') return [];
  const record = details as Record<string, unknown>;
  const candidates: unknown[] = [
    record.openChildren,
    (record.extra as Record<string, unknown> | undefined)?.openChildren,
    (record.data as Record<string, unknown> | undefined)?.openChildren,
    (record.error as Record<string, unknown> | undefined)?.openChildren,
  ];
  for (const candidate of candidates) {
    const items = normalizeOpenChildren(candidate);
    if (items.length) return items;
    // 旧/简写形态：['card-aaaa', 'card-bbbb']
    if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === 'string')) {
      const ids = normalizeOpenChildren(candidate.map((id) => ({ id })));
      if (ids.length) return ids;
    }
  }
  return [];
}

/**
 * 是否「完成被未收口子卡拦截」：错误码为 CARD_HAS_OPEN_CHILDREN，
 * 或者 409 + 带 openChildren（兼容服务端没透传 code 的情况）。
 * 入参是 unknown，配合 KanbanApiError 的 code/status/details 字段即可，不需要 import api 层。
 */
export function isCompleteBlockedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; status?: unknown; details?: unknown };
  if (record.code === 'CARD_HAS_OPEN_CHILDREN') return true;
  if (record.status === 409 && extractOpenChildren(record.details).length > 0) return true;
  return false;
}
