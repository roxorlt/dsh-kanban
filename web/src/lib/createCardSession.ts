/** 新建卡片时的会话选择与后续操作（纯编排，App 提供桥/API 依赖）。 */
export type NewCardSessionKind = 'none' | 'new' | 'existing';

export interface NewCardSessionPlan {
  kind: NewCardSessionKind;
  sessionId?: string;
  workspaceId?: string;
  cwd?: string;
  title: string;
  /** true=进行中：需要发启动提示 */
  start: boolean;
  prompt: string;
}

export interface NewCardSessionDeps {
  createSession: (input: { workspaceId?: string; cwd?: string; title: string }) => Promise<{ sessionId: string }>;
  ensureSession: (input: { workspaceId?: string; cwd?: string; text: string }) => Promise<{ sessionId: string }>;
  promptSession: (sessionId: string, text: string) => Promise<void>;
  bindSession: (sessionId: string) => Promise<void>;
}

export type NewCardSessionResult =
  | { status: 'none' }
  | { status: 'existing'; sessionId: string }
  | { status: 'created'; sessionId: string }
  | { status: 'failed'; error: unknown };

/** 进行中卡片必须选择「新建会话」或「已有会话」。 */
export function validateNewCardSession(input: {
  running: boolean;
  kind: NewCardSessionKind;
  embedded: boolean;
}): 'running-needs-session' | null {
  if (!input.embedded) return null;
  if (input.running && input.kind === 'none') return 'running-needs-session';
  return null;
}

/**
 * 建卡后的会话编排：
 * - existing + start：session.prompt 发启动提示（会话已通过建卡 sessionId 绑定）；
 * - new + start：session.ensure 创建（宿主可续接）→ bindSession；
 * - new + 非 start：session.create → bindSession（不发提示）；
 * - none：不动。
 * 任何失败返回 failed（调用方保留已创建卡片并提示补建）。
 */
export async function setupNewCardSession(
  plan: NewCardSessionPlan,
  deps: NewCardSessionDeps,
): Promise<NewCardSessionResult> {
  if (plan.kind === 'none') return { status: 'none' };
  try {
    if (plan.kind === 'existing') {
      if (!plan.sessionId) return { status: 'failed', error: new Error('missing sessionId') };
      if (plan.start) await deps.promptSession(plan.sessionId, plan.prompt);
      return { status: 'existing', sessionId: plan.sessionId };
    }
    if (plan.start) {
      const ensured = await deps.ensureSession({
        ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
        ...(plan.cwd ? { cwd: plan.cwd } : {}),
        text: plan.prompt,
      });
      await deps.bindSession(ensured.sessionId);
      return { status: 'created', sessionId: ensured.sessionId };
    }
    const created = await deps.createSession({
      ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      title: plan.title,
    });
    await deps.bindSession(created.sessionId);
    return { status: 'created', sessionId: created.sessionId };
  } catch (error) {
    return { status: 'failed', error };
  }
}
