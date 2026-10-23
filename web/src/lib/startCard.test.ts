import { describe, expect, it, vi } from 'vitest';
import type { Card } from '../types';
import {
  buildStartPrompt,
  canStartCard,
  shouldPromptStartAfterReply,
  startCardFlow,
} from './startCard';
import type { StartCardDeps } from './startCard';

const AGENT = { kind: 'agent' as const, name: 'DSH Agent' };

function backlogCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-backlog',
    boardId: 'board-default',
    title: '列表视图批量操作',
    summary: '多选卡片后批量移动 / 归档',
    currentAction: '等待排期',
    status: 'backlog',
    priority: 'medium',
    labels: [],
    sessionIds: [],
    checklists: [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0, elapsedMs: 0 },
    order: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    agent: AGENT,
    ...overrides,
  };
}

function deps(overrides: Partial<StartCardDeps> = {}) {
  const calls: string[] = [];
  const base: StartCardDeps = {
    embedded: true,
    moveToRunning: vi.fn(async () => {
      calls.push('move');
    }),
    rollbackToBacklog: vi.fn(async () => {
      calls.push('rollback');
    }),
    ensureSession: vi.fn(async () => {
      calls.push('ensure');
      return { sessionId: 'session-new', created: true };
    }),
    bindSession: vi.fn(async () => {
      calls.push('bind');
    }),
  };
  return { calls, deps: { ...base, ...overrides } as StartCardDeps };
}

describe('开始推进：适用条件与提示文本', () => {
  it('只有未归档的待办卡可开始', () => {
    expect(canStartCard({ status: 'backlog' })).toBe(true);
    expect(canStartCard({ status: 'running' })).toBe(false);
    expect(canStartCard({ status: 'backlog', archived: true })).toBe(false);
  });

  it('启动提示格式与 summary/currentAction 回退', () => {
    expect(buildStartPrompt(backlogCard())).toBe(
      '【看板·开始推进】「列表视图批量操作」\n' +
        '多选卡片后批量移动 / 归档\n' +
        '请用 kanban_* 工具推进这张卡片（如有 manage-kanban 技能，按技能流程执行）：先确认目标与验收标准，按里程碑更新卡片进展；需要决策时用 kanban_request_approval。',
    );
    expect(buildStartPrompt(backlogCard({ summary: '', currentAction: '等待排期' }))).toContain(
      '\n等待排期\n',
    );
    expect(buildStartPrompt(backlogCard({ summary: '', currentAction: '' }))).toContain(
      '「列表视图批量操作」\n\n请用 kanban_* 工具',
    );
  });

  it('带交接摘要时在启动提示末尾追加摘要与后续', () => {
    const withHandoff = backlogCard({
      handoff: {
        summary: '已完成表单主流程，剩余会话建议排序。',
        nextSteps: '补单测并跑 Playwright。',
        sessionId: 'session-old',
        at: 123,
        by: AGENT,
      },
    });
    const prompt = buildStartPrompt(withHandoff);
    expect(prompt).toContain('\n【交接摘要】\n已完成表单主流程，剩余会话建议排序。\n后续：补单测并跑 Playwright。');
    expect(prompt.indexOf('【交接摘要】')).toBeGreaterThan(prompt.indexOf('kanban_request_approval'));
    // 无 handoff 不出现摘要块
    expect(buildStartPrompt(backlogCard())).not.toContain('【交接摘要】');
    // 只有 summary 时没有「后续」
    expect(
      buildStartPrompt(backlogCard({ handoff: { summary: '仅摘要', at: 1 } })),
    ).toContain('\n【交接摘要】\n仅摘要');
    expect(
      buildStartPrompt(backlogCard({ handoff: { summary: '仅摘要', at: 1 } })),
    ).not.toContain('后续：');
    // blank summary 不追加
    expect(
      buildStartPrompt(backlogCard({ handoff: { summary: '   ', at: 1 } })),
    ).not.toContain('【交接摘要】');
  });

  it('待办卡回复后提示开始推进，其他状态不提示', () => {
    expect(shouldPromptStartAfterReply('backlog')).toBe(true);
    expect(shouldPromptStartAfterReply('running')).toBe(false);
    expect(shouldPromptStartAfterReply('needs_you')).toBe(false);
    expect(shouldPromptStartAfterReply('done')).toBe(false);
  });
});

describe('开始推进：编排顺序与回滚', () => {
  it('嵌入模式成功：move → session.ensure → bind（新会话）', async () => {
    const { calls, deps: d } = deps();
    const result = await startCardFlow(backlogCard(), d);
    expect(result.status).toBe('started');
    expect(calls).toEqual(['move', 'ensure', 'bind']);
    expect(d.bindSession).toHaveBeenCalledWith('session-new');
  });

  it('已有主会话：只 ensure，不再绑定', async () => {
    const { calls, deps: d } = deps({
      ensureSession: vi.fn(async () => {
        calls.push('ensure');
        return { sessionId: 'session-existing', created: false };
      }),
    });
    await startCardFlow(backlogCard({ sessionIds: ['session-existing'] }), d);
    expect(calls).toEqual(['move', 'ensure']);
    expect(d.bindSession).not.toHaveBeenCalled();
  });

  it('独立预览：只移动并发中性提示，不调 ensure', async () => {
    const { calls, deps: d } = deps({ embedded: false });
    const result = await startCardFlow(backlogCard(), d);
    expect(result.status).toBe('moved-standalone');
    expect(calls).toEqual(['move']);
    expect(d.ensureSession).not.toHaveBeenCalled();
  });

  it('会话发送失败：回滚到待办，不绑定', async () => {
    const { calls, deps: d } = deps({
      ensureSession: vi.fn(async () => {
        calls.push('ensure');
        throw new Error('session.ensure failed');
      }),
    });
    const result = await startCardFlow(backlogCard(), d);
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ stage: 'session' });
    expect(calls).toEqual(['move', 'ensure', 'rollback']);
    expect(d.bindSession).not.toHaveBeenCalled();
  });

  it('绑定失败也会回滚', async () => {
    const { calls, deps: d } = deps({
      bindSession: vi.fn(async () => {
        calls.push('bind');
        throw new Error('bind failed');
      }),
    });
    const result = await startCardFlow(backlogCard(), d);
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ stage: 'session' });
    expect(calls).toEqual(['move', 'ensure', 'bind', 'rollback']);
  });

  it('移动失败：不发送会话、不回滚（卡片保持待办）', async () => {
    const { calls, deps: d } = deps({
      moveToRunning: vi.fn(async () => {
        calls.push('move');
        throw new Error('move failed');
      }),
    });
    const result = await startCardFlow(backlogCard(), d);
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ stage: 'move' });
    expect(calls).toEqual(['move']);
    expect(d.ensureSession).not.toHaveBeenCalled();
    expect(d.rollbackToBacklog).not.toHaveBeenCalled();
  });

  it('非待办卡直接跳过，无副作用', async () => {
    const { calls, deps: d } = deps();
    const result = await startCardFlow(backlogCard({ status: 'running' }), d);
    expect(result.status).toBe('skipped');
    expect(calls).toEqual([]);
  });
});
