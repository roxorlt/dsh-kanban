import { describe, expect, it } from 'vitest';
import type { Approval } from '../types';
import {
  APPROVAL_CUSTOM_OPTION_ID,
  allAnswersAreReject,
  approvalQuestions,
  buildApprovalAnswers,
  createApprovalDraft,
  emptyApprovalDraftValue,
  flattenAnswers,
  formatApprovalSessionText,
  isCustomPicked,
  isDraftValueAnswered,
  isMultiQuestionApproval,
  pickedOptionIds,
  resolvedAnswerGroups,
  toggleApprovalDraftOption,
  updateApprovalDraftCustom,
  validateApprovalDraft,
} from './approvalQuestions';
import { normalizeApproval } from '../api';

const AGENT = { kind: 'agent' as const, name: 'DSH Agent' };

function multiApproval(): Approval {
  return {
    id: 'ap-55ee66ff',
    title: '需要你确认：v0.2 发布前检查',
    detail: '共 3 个问题，答完后统一提交。',
    options: [],
    questions: [
      {
        id: 'q-aa1001',
        header: '发布渠道',
        question: '同步到哪些渠道？',
        multiSelect: true,
        options: [
          { id: 'metrics', label: '同步到 #metrics' },
          { id: 'weekly', label: '同步到周报文档' },
          { id: 'team', label: '同步给项目组' },
        ],
      },
      {
        id: 'q-aa1002',
        header: '公告',
        question: '是否同时发布公告？',
        options: [
          { id: 'announce', label: '发布公告' },
          { id: 'skip-announce', label: '暂不发布' },
        ],
      },
      {
        id: 'q-aa1003',
        header: '风险窗口',
        question: '接受 14:30–14:45 的锁表窗口吗？',
        options: [
          { id: 'accept-window', label: '接受本窗口' },
          { id: 'defer-window', label: '推迟到下一窗口', tone: 'danger' },
        ],
      },
    ],
    status: 'pending',
    requestedBy: AGENT,
    requestedAt: 0,
    sessionId: 'session-91c2d3',
  };
}

function singleApproval(): Approval {
  return {
    id: 'ap-11aa22bb',
    title: '是否把迁移脚本跑到生产？',
    detail: '',
    options: [
      { id: 'yes', label: '批准，跑生产', tone: 'primary' },
      { id: 'no', label: '先不跑', tone: 'danger' },
    ],
    status: 'pending',
    requestedBy: AGENT,
    requestedAt: 0,
  };
}

/** 把「题目 id → 选择」的简易写法转成完整草稿。 */
function draftFrom(values: Record<string, { optionIds?: string[]; custom?: string }>): ReturnType<typeof createApprovalDraft> {
  const draft = createApprovalDraft(multiApproval());
  for (const [questionId, value] of Object.entries(values)) {
    draft[questionId] = { optionIds: value.optionIds ?? [], custom: value.custom ?? '' };
  }
  return draft;
}

describe('多问题审批：题目与校验', () => {
  it('单题把 title/options 合成一题，多题原样返回', () => {
    expect(isMultiQuestionApproval(singleApproval())).toBe(false);
    const single = approvalQuestions(singleApproval());
    expect(single).toHaveLength(1);
    expect(single[0]?.question).toBe('是否把迁移脚本跑到生产？');
    expect(single[0]?.options.map((option) => option.id)).toEqual(['yes', 'no']);
    expect(isMultiQuestionApproval(multiApproval())).toBe(true);
    // v0.3：只有 1 题但带 questions[] 时也走逐题 UI
    expect(
      isMultiQuestionApproval({ ...multiApproval(), questions: multiApproval().questions?.slice(0, 1) }),
    ).toBe(true);
    expect(approvalQuestions(multiApproval()).map((question) => question.id)).toEqual([
      'q-aa1001',
      'q-aa1002',
      'q-aa1003',
    ]);
  });

  it('逐题校验返回第一个缺题的 index', () => {
    const approval = multiApproval();
    expect(validateApprovalDraft(approval, draftFrom({}))).toEqual({
      ok: false,
      issue: { index: 0, kind: 'missing' },
    });
    expect(
      validateApprovalDraft(
        approval,
        draftFrom({
          'q-aa1001': { optionIds: ['metrics'] },
          'q-aa1002': { optionIds: [] },
          'q-aa1003': { optionIds: ['accept-window'] },
        }),
      ),
    ).toEqual({ ok: false, issue: { index: 1, kind: 'missing' } });
    expect(
      validateApprovalDraft(
        approval,
        draftFrom({
          'q-aa1001': { optionIds: ['metrics', 'weekly'] },
          'q-aa1002': { optionIds: ['announce'] },
          'q-aa1003': { optionIds: ['accept-window'] },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('自定义回答计入作答；选了「其他」但没填内容时单独报 custom-empty', () => {
    const approval = multiApproval();
    const customFilled = draftFrom({
      'q-aa1001': { optionIds: [APPROVAL_CUSTOM_OPTION_ID], custom: '同步到飞书群' },
      'q-aa1002': { optionIds: ['announce'] },
      'q-aa1003': { optionIds: [APPROVAL_CUSTOM_OPTION_ID], custom: '下周一窗口' },
    });
    expect(validateApprovalDraft(approval, customFilled)).toEqual({ ok: true });

    const customEmpty = draftFrom({
      'q-aa1001': { optionIds: [APPROVAL_CUSTOM_OPTION_ID], custom: '  ' },
      'q-aa1002': { optionIds: ['announce'] },
      'q-aa1003': { optionIds: ['accept-window'] },
    });
    expect(validateApprovalDraft(approval, customEmpty)).toEqual({
      ok: false,
      issue: { index: 0, kind: 'custom-empty' },
    });
    // 多选可以「已选选项 + 其他」；没填文本仍算未完成
    const multiCustomEmpty = draftFrom({
      'q-aa1001': { optionIds: ['metrics', APPROVAL_CUSTOM_OPTION_ID], custom: '' },
      'q-aa1002': { optionIds: ['announce'] },
      'q-aa1003': { optionIds: ['accept-window'] },
    });
    expect(validateApprovalDraft(approval, multiCustomEmpty)).toEqual({
      ok: false,
      issue: { index: 0, kind: 'custom-empty' },
    });
  });

  it('单选与「其他」互斥；多选可与真实选项共存', () => {
    const singleDraft = emptyApprovalDraftValue();
    const pickedCustom = toggleApprovalDraftOption(singleDraft, APPROVAL_CUSTOM_OPTION_ID, false);
    const typed = updateApprovalDraftCustom(pickedCustom, '下周再说');
    expect(isCustomPicked(typed)).toBe(true);
    expect(isDraftValueAnswered(typed)).toBe(true);
    // 单选改成真实选项：自定义草稿被清空，避免看不见的残留
    const backToReal = toggleApprovalDraftOption(typed, 'announce', false);
    expect(backToReal).toEqual({ optionIds: ['announce'], custom: '' });
    // 再切回「其他」也不会带回旧文本
    expect(toggleApprovalDraftOption(backToReal, APPROVAL_CUSTOM_OPTION_ID, false)).toEqual({
      optionIds: [APPROVAL_CUSTOM_OPTION_ID],
      custom: '',
    });

    let multiDraft = emptyApprovalDraftValue();
    multiDraft = toggleApprovalDraftOption(multiDraft, 'metrics', true);
    multiDraft = toggleApprovalDraftOption(multiDraft, APPROVAL_CUSTOM_OPTION_ID, true);
    multiDraft = updateApprovalDraftCustom(multiDraft, '同步到飞书群');
    expect(pickedOptionIds(multiDraft)).toEqual(['metrics']);
    expect(isDraftValueAnswered(multiDraft)).toBe(true);
    // 取消勾选真实选项后自定义文本仍保留，但「其他」仍在选中态
    multiDraft = toggleApprovalDraftOption(multiDraft, 'metrics', true);
    expect(multiDraft).toEqual({ optionIds: [APPROVAL_CUSTOM_OPTION_ID], custom: '同步到飞书群' });
  });

  it('answers 序列化保持题目顺序与 labels，自定义文本写入 custom', () => {
    const approval = multiApproval();
    const answers = buildApprovalAnswers(approval, {
      'q-aa1001': { optionIds: ['metrics', 'weekly'], custom: '' },
      'q-aa1002': { optionIds: [APPROVAL_CUSTOM_OPTION_ID], custom: '发一封全员邮件' },
      'q-aa1003': { optionIds: ['accept-window'], custom: '' },
    });
    expect(answers).toEqual([
      { questionId: 'q-aa1001', optionIds: ['metrics', 'weekly'], labels: ['同步到 #metrics', '同步到周报文档'] },
      { questionId: 'q-aa1002', optionIds: [], labels: [], custom: '发一封全员邮件' },
      { questionId: 'q-aa1003', optionIds: ['accept-window'], labels: ['接受本窗口'] },
    ]);
    expect(flattenAnswers(answers)).toEqual({
      optionIds: ['metrics', 'weekly', 'accept-window'],
      labels: ['同步到 #metrics', '同步到周报文档', '接受本窗口'],
    });
    // 多选自定义：已选 labels + custom 同时保留
    expect(
      buildApprovalAnswers(approval, {
        'q-aa1001': { optionIds: ['metrics', APPROVAL_CUSTOM_OPTION_ID], custom: '再加飞书群' },
        'q-aa1002': { optionIds: ['announce'], custom: '' },
        'q-aa1003': { optionIds: ['accept-window'], custom: '' },
      })[0],
    ).toEqual({
      questionId: 'q-aa1001',
      optionIds: ['metrics'],
      labels: ['同步到 #metrics'],
      custom: '再加飞书群',
    });
  });

  it('全会话文本按「- header：labels」拼接，自定义回答带前缀，备注附加在末尾', () => {
    const approval = multiApproval();
    const answers = buildApprovalAnswers(approval, {
      'q-aa1001': { optionIds: ['metrics', 'weekly'], custom: '' },
      'q-aa1002': { optionIds: [APPROVAL_CUSTOM_OPTION_ID], custom: '发一封全员邮件' },
      'q-aa1003': { optionIds: ['accept-window'], custom: '' },
    });
    expect(formatApprovalSessionText(approval, answers, '', 'approve')).toBe(
      '【看板·审批】已提交「需要你确认：v0.2 发布前检查」：\n' +
        '- 发布渠道：同步到 #metrics、同步到周报文档\n' +
        '- 公告：自定义：发一封全员邮件\n' +
        '- 风险窗口：接受本窗口',
    );
    // 自定义 + 真实选项：两个片段用「；」分隔
    const mixed = buildApprovalAnswers(approval, {
      'q-aa1001': { optionIds: ['metrics', APPROVAL_CUSTOM_OPTION_ID], custom: '再加飞书群' },
      'q-aa1002': { optionIds: ['announce'], custom: '' },
      'q-aa1003': { optionIds: ['accept-window'], custom: '' },
    });
    expect(formatApprovalSessionText(approval, mixed, '按计划执行', 'approve')).toContain(
      '- 发布渠道：同步到 #metrics；自定义：再加飞书群\n',
    );
    expect(formatApprovalSessionText(approval, mixed, '按计划执行', 'approve')).toContain('\n备注：按计划执行');
  });

  it('单题文本兼容旧格式与 optionIds 反查 labels', () => {
    expect(formatApprovalSessionText(singleApproval(), undefined, '', 'approve', ['yes'])).toBe(
      '【看板·审批】已批准「是否把迁移脚本跑到生产？」：批准，跑生产',
    );
    expect(formatApprovalSessionText(singleApproval(), undefined, '先等窗口', 'reject', ['no'])).toBe(
      '【看板·审批】已拒绝「是否把迁移脚本跑到生产？」：先不跑\n备注：先等窗口',
    );
  });

  it('所选选项全部是 danger 时判定为拒绝；自定义回答不算拒绝', () => {
    const approval = multiApproval();
    const rejectAnswers = buildApprovalAnswers(approval, {
      'q-aa1001': { optionIds: ['team'], custom: '' },
      'q-aa1002': { optionIds: ['skip-announce'], custom: '' },
      'q-aa1003': { optionIds: ['defer-window'], custom: '' },
    });
    // Q1/Q2 的选项并非 danger 语义，因此整体不判定为拒绝
    expect(allAnswersAreReject(approval, rejectAnswers)).toBe(false);

    const dangerOnly: Approval = {
      ...multiApproval(),
      questions: [
        {
          id: 'q-d1',
          header: '风险窗口',
          question: '接受本窗口吗？',
          options: [
            { id: 'accept-window', label: '接受本窗口', tone: 'primary' },
            { id: 'defer-window', label: '推迟到下一窗口', tone: 'danger' },
          ],
        },
        {
          id: 'q-d2',
          header: '公告',
          question: '发布公告吗？',
          options: [
            { id: 'announce', label: '发布公告', tone: 'primary' },
            { id: 'skip-announce', label: '暂不发布', tone: 'danger' },
          ],
        },
      ],
    };
    const allDanger = buildApprovalAnswers(dangerOnly, {
      'q-d1': { optionIds: ['defer-window'], custom: '' },
      'q-d2': { optionIds: ['skip-announce'], custom: '' },
    });
    expect(allAnswersAreReject(dangerOnly, allDanger)).toBe(true);
    const mixed = buildApprovalAnswers(dangerOnly, {
      'q-d1': { optionIds: ['defer-window'], custom: '' },
      'q-d2': { optionIds: ['announce'], custom: '' },
    });
    expect(allAnswersAreReject(dangerOnly, mixed)).toBe(false);
    // 自定义回答 = 用户给第三种方案，不算拒绝
    const withCustom = buildApprovalAnswers(dangerOnly, {
      'q-d1': { optionIds: ['defer-window'], custom: '' },
      'q-d2': { optionIds: [APPROVAL_CUSTOM_OPTION_ID], custom: '发公告但延长窗口' },
    });
    expect(allAnswersAreReject(dangerOnly, withCustom)).toBe(false);
  });
});

describe('已解决态逐题展示（兼容旧 resolution）', () => {
  it('v0.3 resolution.answers 按题展示 labels', () => {
    const approval: Approval = {
      ...multiApproval(),
      status: 'approved',
      resolution: {
        optionIds: ['metrics', 'announce', 'accept-window'],
        labels: ['同步到 #metrics', '发布公告', '接受本窗口'],
        answers: [
          { questionId: 'q-aa1001', optionIds: ['metrics'], labels: ['同步到 #metrics'] },
          { questionId: 'q-aa1002', optionIds: ['announce'], labels: ['发布公告'] },
          { questionId: 'q-aa1003', optionIds: ['accept-window'], labels: ['接受本窗口'] },
        ],
      },
    };
    expect(resolvedAnswerGroups(approval).map((group) => group.labels)).toEqual([
      ['同步到 #metrics'],
      ['发布公告'],
      ['接受本窗口'],
    ]);
    expect(resolvedAnswerGroups(approval).map((group) => group.custom)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('v0.4 自定义回答透出 custom 字段（单选自定义时 labels 为空）', () => {
    const approval: Approval = {
      ...multiApproval(),
      status: 'approved',
      resolution: {
        optionIds: ['metrics'],
        labels: ['同步到 #metrics'],
        answers: [
          { questionId: 'q-aa1001', optionIds: ['metrics'], labels: ['同步到 #metrics'] },
          { questionId: 'q-aa1002', optionIds: [], labels: [], custom: '发一封全员邮件' },
          { questionId: 'q-aa1003', optionIds: ['accept-window'], labels: ['接受本窗口'] },
        ],
      },
    };
    const groups = resolvedAnswerGroups(approval);
    expect(groups[1]).toMatchObject({ labels: [], custom: '发一封全员邮件' });
  });

  it('旧数据只有拍平 optionIds 时按题目归属反查', () => {
    const approval: Approval = {
      ...multiApproval(),
      status: 'approved',
      resolution: {
        optionIds: ['metrics', 'weekly', 'announce', 'defer-window'],
        labels: ['同步到 #metrics', '同步到周报文档', '发布公告', '推迟到下一窗口'],
      },
    };
    const groups = resolvedAnswerGroups(approval);
    expect(groups.map((group) => group.labels)).toEqual([
      ['同步到 #metrics', '同步到周报文档'],
      ['发布公告'],
      ['推迟到下一窗口'],
    ]);
  });

  it('单题旧 resolution 直接展示拍平 labels', () => {
    const approval: Approval = {
      ...singleApproval(),
      status: 'approved',
      resolution: { optionIds: ['yes'], labels: ['批准，跑生产'] },
    };
    expect(resolvedAnswerGroups(approval)[0]?.labels).toEqual(['批准，跑生产']);
  });
});

describe('normalizeApproval 兼容 questions/answers/custom', () => {
  it('补默认字段并透传 questions/answers', () => {
    const raw = normalizeApproval({
      ...multiApproval(),
      status: 'approved',
      resolution: {
        optionIds: ['metrics'],
        labels: ['同步到 #metrics'],
        answers: [{ questionId: 'q-aa1001', optionIds: ['metrics'], labels: ['同步到 #metrics'] }],
      },
    } as Approval);
    expect(raw.questions).toHaveLength(3);
    expect(raw.questions?.[0]?.multiSelect).toBe(true);
    expect(raw.resolution?.answers?.[0]?.questionId).toBe('q-aa1001');
    expect(raw.resolution?.optionIds).toEqual(['metrics']);
  });

  it('v0.4 answers.custom 原样保留（空串丢弃）', () => {
    const raw = normalizeApproval({
      ...multiApproval(),
      status: 'approved',
      resolution: {
        optionIds: [],
        labels: [],
        answers: [
          { questionId: 'q-aa1001', optionIds: [], labels: [], custom: '同步到飞书群' },
          { questionId: 'q-aa1002', optionIds: ['announce'], labels: ['发布公告'], custom: '  ' },
        ],
      },
    } as Approval);
    expect(raw.resolution?.answers?.[0]?.custom).toBe('同步到飞书群');
    expect(raw.resolution?.answers?.[1]?.custom).toBeUndefined();
  });
});
