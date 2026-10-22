import type { Card, Status } from '../types';

/** 只有待办卡可以「开始推进」。 */
export function canStartCard(card: Pick<Card, 'status' | 'archived'>): boolean {
  return card.status === 'backlog' && card.archived !== true;
}

/** 待办卡回复成功后提醒用户可手动开始推进（不自动改状态）。 */
export function shouldPromptStartAfterReply(status: Status): boolean {
  return status === 'backlog';
}

/** 启动提示全文（发送到主会话）。 */
export function buildStartPrompt(
  card: Pick<Card, 'title' | 'summary' | 'currentAction'>,
): string {
  const body = card.summary.trim() || card.currentAction?.trim() || '';
  return [
    `【看板·开始推进】「${card.title}」`,
    body,
    '请用 kanban_* 工具推进这张卡片（如有 manage-kanban 技能，按技能流程执行）：先确认目标与验收标准，按里程碑更新卡片进展；需要决策时用 kanban_request_approval。',
  ].join('\n');
}

export interface StartCardDeps {
  embedded: boolean;
  /** 乐观更新已由调用方完成，这里只发 POST move */
  moveToRunning: () => Promise<void>;
  /** 会话发送/绑定失败时把卡片移回待办 */
  rollbackToBacklog: () => Promise<void>;
  ensureSession: (text: string) => Promise<{ sessionId?: string; created?: boolean }>;
  bindSession: (sessionId: string) => Promise<void>;
}

export type StartCardStage = 'move' | 'session';

export type StartCardResult =
  | { status: 'started'; sessionId?: string }
  | { status: 'moved-standalone' }
  | { status: 'skipped' }
  | { status: 'failed'; stage: StartCardStage; error: unknown };

/**
 * 「开始推进」编排：
 * 1) 待办 → 进行中（POST move，活动由服务端记录）；
 * 2) 独立预览：只移动，返回 moved-standalone；
 * 3) 嵌入：session.ensure（无会话时宿主创建）→ 新 sessionId 绑定到卡片；
 * 4) 任一步失败：回滚到待办并返回 failed（阶段区分 move / session）。
 */
export async function startCardFlow(card: Card, deps: StartCardDeps): Promise<StartCardResult> {
  if (!canStartCard(card)) return { status: 'skipped' };
  try {
    await deps.moveToRunning();
  } catch (error) {
    return { status: 'failed', stage: 'move', error };
  }
  if (!deps.embedded) return { status: 'moved-standalone' };
  try {
    const session = await deps.ensureSession(buildStartPrompt(card));
    if (session.sessionId && !card.sessionIds.includes(session.sessionId)) {
      await deps.bindSession(session.sessionId);
    }
    return { status: 'started', ...(session.sessionId ? { sessionId: session.sessionId } : {}) };
  } catch (error) {
    try {
      await deps.rollbackToBacklog();
    } catch {
      /* 回滚失败由上层 refresh 兜底 */
    }
    return { status: 'failed', stage: 'session', error };
  }
}
