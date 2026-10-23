import { describe, expect, it } from 'vitest';
import type { Approval, Card } from '../types';
import {
  approvalMoveTarget,
  approvalOutcomeColumn,
  selectedApprovalOptions,
} from './approvalOutcome';

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'ap-00000001',
    title: '可以收尾了吗？',
    detail: '',
    multiSelect: false,
    options: [
      { id: 'finish', label: '确认完成', tone: 'primary', outcome: 'done' },
      { id: 'keep', label: '继续处理' },
    ],
    status: 'pending',
    requestedBy: { kind: 'agent', name: 'DSH Agent' },
    requestedAt: 1,
    ...overrides,
  };
}

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-00000001',
    boardId: 'board-default',
    title: '卡片',
    summary: '',
    status: 'needs_you',
    priority: 'none',
    labels: [],
    sessionIds: [],
    checklists: [],
    approvals: [approval()],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0 },
    order: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Card;
}

describe('审批提交后的落列：selectedApprovalOptions / approvalOutcomeColumn', () => {
  it('单题：按提交顺序取选项对象', () => {
    expect(selectedApprovalOptions(approval(), { optionIds: ['keep', 'finish'] }).map((option) => option.id)).toEqual([
      'keep',
      'finish',
    ]);
    expect(selectedApprovalOptions(approval(), { optionIds: ['missing'] })).toEqual([]);
  });

  it('多题：按题序展开 answers', () => {
    const multi = approval({
      questions: [
        { id: 'q-1', question: 'Q1', options: [{ id: 'a', label: 'A' }] },
        { id: 'q-2', question: 'Q2', options: [{ id: 'b', label: 'B', outcome: 'backlog' }] },
      ],
      options: [{ id: 'a', label: 'A' }],
    });
    const submission = {
      optionIds: ['a', 'b'],
      answers: [
        { questionId: 'q-1', optionIds: ['a'] },
        { questionId: 'q-2', optionIds: ['b'] },
      ],
    };
    expect(selectedApprovalOptions(multi, submission).map((option) => option.id)).toEqual(['a', 'b']);
    expect(approvalOutcomeColumn(multi, submission, 'approve')).toBe('backlog');
  });

  it('声明 outcome 优先；未声明时批准回进行中、驳回回待办', () => {
    expect(approvalOutcomeColumn(approval(), { optionIds: ['finish'] }, 'approve')).toBe('done');
    expect(approvalOutcomeColumn(approval(), { optionIds: ['keep'] }, 'approve')).toBe('running');
    expect(approvalOutcomeColumn(approval(), { optionIds: ['keep'] }, 'reject')).toBe('backlog');
    // 兼容旧审批：没有 outcome 字段
    const legacy = approval({ options: [{ id: 'yes', label: '批准' }, { id: 'no', label: '拒绝', tone: 'danger' }] });
    expect(approvalOutcomeColumn(legacy, { optionIds: ['no'] }, 'reject')).toBe('backlog');
    expect(approvalOutcomeColumn(legacy, { optionIds: ['yes'] }, 'approve')).toBe('running');
  });

  it('声明了 outcome 的驳回项以声明为准；多个声明取提交顺序里的第一个', () => {
    const close = approval({ options: [{ id: 'close', label: '结束并收尾', tone: 'danger', outcome: 'done' }] });
    expect(approvalOutcomeColumn(close, { optionIds: ['close'] }, 'reject')).toBe('done');
    const picky = approval({
      multiSelect: true,
      options: [
        { id: 'a', label: 'A', outcome: 'backlog' },
        { id: 'b', label: 'B', outcome: 'done' },
      ],
    });
    expect(approvalOutcomeColumn(picky, { optionIds: ['b', 'a'] }, 'approve')).toBe('done');
    // 非法去向兜底：批准回进行中
    const broken = approval({ options: [{ id: 'x', label: 'X', outcome: 'canceled' as never }] });
    expect(approvalOutcomeColumn(broken, { optionIds: ['x'] }, 'approve')).toBe('running');
  });
});

describe('审批提交瞬间的乐观移列目标：approvalMoveTarget', () => {
  it('待你确认列 + 唯一待处理审批 → 按 outcome 或决定语义落列', () => {
    expect(approvalMoveTarget(card(), approval(), { optionIds: ['finish'] }, 'approve')).toBe('done');
    expect(approvalMoveTarget(card(), approval(), { optionIds: ['keep'] }, 'approve')).toBe('running');
    expect(approvalMoveTarget(card(), approval(), { optionIds: ['keep'] }, 'reject')).toBe('backlog');
  });

  it('还有其它待处理审批时不移动，等最后一条提交', () => {
    const other = approval({ id: 'ap-00000002', title: '另一个审批' });
    const target = card({ approvals: [approval(), other] });
    expect(approvalMoveTarget(target, approval(), { optionIds: ['finish'] }, 'approve')).toBeNull();
  });

  it('卡片不在 needs_you（受阻/失败/已拖走）或已归档时不移动', () => {
    expect(approvalMoveTarget(card({ status: 'running' }), approval(), { optionIds: ['finish'] }, 'approve')).toBeNull();
    expect(approvalMoveTarget(card({ status: 'blocked' }), approval(), { optionIds: ['finish'] }, 'approve')).toBeNull();
    expect(approvalMoveTarget(card({ status: 'failed' }), approval(), { optionIds: ['finish'] }, 'approve')).toBeNull();
    expect(approvalMoveTarget(card({ archived: true }), approval(), { optionIds: ['finish'] }, 'approve')).toBeNull();
  });
});
