import type { SessionRow } from '../types';

/** 回复/审批目标下拉的一行（主会话排第一位）。 */
export interface ReplyTargetOption {
  id: string;
  title: string;
  running: boolean;
  primary: boolean;
}

/**
 * 多会话的目标会话（M2）：
 * - 默认目标是主会话（card.sessionIds[0]，主会话排在第一位）；
 * - 目标只在卡片绑定的会话里选，宿主会话列表可能缺少标题，退回用 id 展示；
 * - 当前目标已不在绑定列表（解绑 / 切卡）时回退到主会话。
 */
export function replyTargetOptions(
  sessionIds: readonly string[],
  sessions: readonly SessionRow[],
): ReplyTargetOption[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return sessionIds.map((id, index) => {
    const row = byId.get(id);
    return {
      id,
      title: row?.title?.trim() ? row.title : id,
      running: row?.running ?? false,
      primary: index === 0,
    };
  });
}

export function resolveReplyTarget(
  sessionIds: readonly string[],
  current: string | null | undefined,
): string | null {
  if (current && sessionIds.includes(current)) return current;
  return sessionIds[0] ?? null;
}

/**
 * 设为主会话后默认目标的跟随规则（设计规范 §7.5）：
 * 当前目标就是旧主会话（或还没选过）时跟随到新主会话；用户手动选过别的会话则保持不变。
 */
export function nextTargetAfterPrimaryChange(
  current: string | null | undefined,
  previousPrimary: string | null | undefined,
  nextPrimary: string | null | undefined,
): string | null {
  if (!nextPrimary) return current ?? null;
  if (!current) return nextPrimary;
  return current === previousPrimary ? nextPrimary : current;
}
