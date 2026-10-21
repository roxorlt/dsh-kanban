import { describe, expect, it } from 'vitest';
import type { Approval } from '../types';
import { normalizeApproval } from '../api';

function baseApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'ap-1',
    title: '测试审批',
    detail: '',
    multiSelect: false,
    options: [
      { id: 'yes', label: '批准', tone: 'primary' },
      { id: 'no', label: '拒绝', tone: 'danger' },
    ],
    status: 'pending',
    requestedBy: { kind: 'agent', name: 'DSH Agent' },
    requestedAt: 0,
    ...overrides,
  };
}

describe('normalizeApproval（新旧 resolution 兼容）', () => {
  it('新契约 {optionIds, labels} 原样保留', () => {
    const approval = normalizeApproval(
      baseApproval({
        status: 'approved',
        multiSelect: true,
        resolution: { optionIds: ['yes'], labels: ['批准'], comment: '可以' },
      }),
    );
    expect(approval.resolution?.optionIds).toEqual(['yes']);
    expect(approval.resolution?.labels).toEqual(['批准']);
    expect(approval.multiSelect).toBe(true);
  });

  it('旧契约 {optionId, label} 转成数组形态', () => {
    const legacy = baseApproval({
      status: 'rejected',
      resolution: { optionId: 'no', label: '拒绝' } as unknown as Approval['resolution'],
    });
    const approval = normalizeApproval(legacy);
    expect(approval.resolution?.optionIds).toEqual(['no']);
    expect(approval.resolution?.labels).toEqual(['拒绝']);
  });

  it('缺 multiSelect 时默认 false', () => {
    const approval = normalizeApproval(baseApproval({ multiSelect: undefined }));
    expect(approval.multiSelect).toBe(false);
  });
});
