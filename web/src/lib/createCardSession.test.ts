import { describe, expect, it, vi } from 'vitest';
import {
  setupNewCardSession,
  validateNewCardSession,
} from './createCardSession';
import type { NewCardSessionDeps, NewCardSessionPlan } from './createCardSession';

function plan(overrides: Partial<NewCardSessionPlan> = {}): NewCardSessionPlan {
  return {
    kind: 'new',
    workspaceId: 'ws-kanban',
    cwd: '/Users/dev/projects/dsh-kanban',
    title: '新卡片',
    start: true,
    prompt: '【看板·开始推进】「新卡片」\n摘要\n请按 manage-kanban 技能推进这张卡片…',
    ...overrides,
  };
}

function deps() {
  const calls: string[] = [];
  const base: NewCardSessionDeps = {
    createSession: vi.fn(async (input) => {
      calls.push(`create:${input.workspaceId}:${input.cwd}`);
      return { sessionId: 'session-created' };
    }),
    ensureSession: vi.fn(async (input) => {
      calls.push(`ensure:${input.workspaceId}:${input.cwd}`);
      return { sessionId: 'session-ensured' };
    }),
    promptSession: vi.fn(async (sessionId) => {
      calls.push(`prompt:${sessionId}`);
    }),
    bindSession: vi.fn(async (sessionId) => {
      calls.push(`bind:${sessionId}`);
    }),
  };
  return { calls, deps: base };
}

describe('新建卡片会话选择校验', () => {
  it('进行中必须选择会话；其它状态可选暂不关联', () => {
    expect(validateNewCardSession({ running: true, kind: 'none', embedded: true })).toBe('running-needs-session');
    expect(validateNewCardSession({ running: true, kind: 'new', embedded: true })).toBeNull();
    expect(validateNewCardSession({ running: true, kind: 'existing', embedded: true })).toBeNull();
    expect(validateNewCardSession({ running: false, kind: 'none', embedded: true })).toBeNull();
    expect(validateNewCardSession({ running: true, kind: 'none', embedded: false })).toBeNull();
  });
});

describe('新建卡片会话编排', () => {
  it('进行中 + 新建会话：ensure → bind（不发 create/prompt）', async () => {
    const { calls, deps: d } = deps();
    const result = await setupNewCardSession(plan(), d);
    expect(result).toEqual({ status: 'created', sessionId: 'session-ensured' });
    expect(calls).toEqual(['ensure:ws-kanban:/Users/dev/projects/dsh-kanban', 'bind:session-ensured']);
    expect(d.createSession).not.toHaveBeenCalled();
    expect(d.promptSession).not.toHaveBeenCalled();
  });

  it('进行中 + 已有会话：只 prompt 发启动提示', async () => {
    const { calls, deps: d } = deps();
    const result = await setupNewCardSession(plan({ kind: 'existing', sessionId: 'session-old' }), d);
    expect(result).toEqual({ status: 'existing', sessionId: 'session-old' });
    expect(calls).toEqual(['prompt:session-old']);
    expect(d.bindSession).not.toHaveBeenCalled();
  });

  it('非进行中 + 新建会话：create → bind（不发 prompt）', async () => {
    const { calls, deps: d } = deps();
    const result = await setupNewCardSession(plan({ start: false }), d);
    expect(result).toEqual({ status: 'created', sessionId: 'session-created' });
    expect(calls).toEqual(['create:ws-kanban:/Users/dev/projects/dsh-kanban', 'bind:session-created']);
    expect(d.ensureSession).not.toHaveBeenCalled();
    expect(d.promptSession).not.toHaveBeenCalled();
  });

  it('非进行中 + 已有会话：不 prompt，直接返回（绑定由建卡 sessionId 完成）', async () => {
    const { calls, deps: d } = deps();
    const result = await setupNewCardSession(plan({ kind: 'existing', sessionId: 'session-old', start: false }), d);
    expect(result).toEqual({ status: 'existing', sessionId: 'session-old' });
    expect(calls).toEqual([]);
  });

  it('暂不关联：无副作用', async () => {
    const { calls, deps: d } = deps();
    expect(await setupNewCardSession(plan({ kind: 'none' }), d)).toEqual({ status: 'none' });
    expect(calls).toEqual([]);
  });

  it('会话失败返回 failed（卡片由调用方保留并提示补建）', async () => {
    const { calls, deps: d } = deps();
    d.bindSession = vi.fn(async () => {
      calls.push('bind');
      throw new Error('bind failed');
    });
    const result = await setupNewCardSession(plan(), d);
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ error: expect.any(Error) });
    expect(calls).toEqual(['ensure:ws-kanban:/Users/dev/projects/dsh-kanban', 'bind']);
  });

  it('已有会话启动提示失败也返回 failed', async () => {
    const { deps: d } = deps();
    d.promptSession = vi.fn(async () => {
      throw new Error('prompt rejected');
    });
    const result = await setupNewCardSession(plan({ kind: 'existing', sessionId: 'session-old' }), d);
    expect(result.status).toBe('failed');
  });
});
