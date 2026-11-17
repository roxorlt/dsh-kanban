import type { SessionRow } from '../types';

/** 外部 Agent 跟进卡片时的虚拟回复/审批目标（只写看板并云端同步，不唤醒本地 DSH 会话）。 */
export const EXTERNAL_REPLY_TARGET = '__external__';

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
 * - 若当前由外部 Agent（Carbon / Codex 等）跟进，默认目标为 `EXTERNAL_REPLY_TARGET`（云端看板同步），
 *   历史关联的本地 DSH 会话排在后面供用户显式选择，避免回复/审批误打进旧本地会话；
 * - 当前目标已不在候选列表（解绑 / 切卡）时回退到默认目标。
 */
export function replyTargetOptions(
  sessionIds: readonly string[],
  sessions: readonly SessionRow[],
  externalOption?: { label: string } | null,
): ReplyTargetOption[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const localOptions = sessionIds.map((id, index) => {
    const row = byId.get(id);
    return {
      id,
      title: row?.title?.trim() ? row.title : id,
      running: row?.running ?? false,
      primary: externalOption ? false : index === 0,
    };
  });
  if (!externalOption) return localOptions;
  return [
    {
      id: EXTERNAL_REPLY_TARGET,
      title: externalOption.label,
      running: false,
      primary: false,
    },
    ...localOptions,
  ];
}

export function resolveReplyTarget(
  sessionIds: readonly string[],
  current: string | null | undefined,
  isExternal = false,
): string | null {
  if (isExternal) {
    if (current === EXTERNAL_REPLY_TARGET) return EXTERNAL_REPLY_TARGET;
    if (current && sessionIds.includes(current)) return current;
    return EXTERNAL_REPLY_TARGET;
  }
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
