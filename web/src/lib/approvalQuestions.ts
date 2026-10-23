import type { Approval, ApprovalAnswer, ApprovalOption, ApprovalQuestion } from '../types';

const REJECT_IDS = ['no', 'reject', 'deny', 'cancel', 'stop', 'hold'];

/**
 * 多题审批每道题末尾内置的「其他（自行填写）」选项。
 * 只存在于 Web 草稿里，不写进 `approval.questions[].options`，提交时转成 `custom` 文本。
 */
export const APPROVAL_CUSTOM_OPTION_ID = '__custom__';

/** 自定义回答长度上限，与服务端 `LIMITS.approvalAnswerCustom` 保持一致。 */
export const APPROVAL_CUSTOM_MAX = 600;

/** 选项语义是否“拒绝/停止”（与服务端判定保持一致）。 */
export function isRejectOption(option: ApprovalOption): boolean {
  return option.tone === 'danger' || REJECT_IDS.includes(option.id);
}

/** 是否走 questions[] UI（v0.3：只要带 questions 就逐题渲染；单题模式仅用于无 questions 的旧契约）。 */
export function isMultiQuestionApproval(approval: Approval): boolean {
  return Array.isArray(approval.questions) && approval.questions.length > 0;
}

/** 统一取题目：多问题时返回 questions；单题时把 title/options 合成一题。 */
export function approvalQuestions(approval: Approval): ApprovalQuestion[] {
  if (Array.isArray(approval.questions) && approval.questions.length) {
    return approval.questions.map((question, index) => ({
      ...question,
      id: question.id || `q-${index + 1}`,
      options: question.options ?? [],
      multiSelect: question.multiSelect === true,
    }));
  }
  return [
    {
      id: `q-${approval.id}`,
      header: '',
      question: approval.title,
      multiSelect: approval.multiSelect === true,
      options: approval.options ?? [],
    },
  ];
}

// ---------------------------------------------------------------- 逐题草稿

/** 单题草稿：已选 option id（含内置自定义项）+ 自定义文本。 */
export interface ApprovalDraftValue {
  optionIds: string[];
  custom: string;
}

/** 逐题草稿，按 question.id 存。 */
export type ApprovalDraft = Record<string, ApprovalDraftValue>;

export function emptyApprovalDraftValue(): ApprovalDraftValue {
  return { optionIds: [], custom: '' };
}

/** 由题目生成空草稿（进入面板 / 审批被替换时用）。 */
export function createApprovalDraft(approval: Approval): ApprovalDraft {
  const draft: ApprovalDraft = {};
  for (const question of approvalQuestions(approval)) draft[question.id] = emptyApprovalDraftValue();
  return draft;
}

/** 是否选中了内置「其他（自行填写）」。 */
export function isCustomPicked(value: ApprovalDraftValue): boolean {
  return value.optionIds.includes(APPROVAL_CUSTOM_OPTION_ID);
}

/** 去掉内置自定义项后的真实选项 id（提交给服务端的 optionIds）。 */
export function pickedOptionIds(value: ApprovalDraftValue): string[] {
  return value.optionIds.filter((id) => id !== APPROVAL_CUSTOM_OPTION_ID);
}

/** 单选：点选项即替换（自定义与真实选项互斥）；多选：勾选/取消。 */
export function toggleApprovalDraftOption(
  value: ApprovalDraftValue,
  optionId: string,
  multiSelect: boolean,
): ApprovalDraftValue {
  if (multiSelect) {
    const picked = value.optionIds.includes(optionId)
      ? value.optionIds.filter((id) => id !== optionId)
      : [...value.optionIds, optionId];
    return { ...value, optionIds: picked };
  }
  // 单选换成真实选项时丢弃自定义文本，避免草稿里留下看不见的内容
  return {
    optionIds: [optionId],
    custom: optionId === APPROVAL_CUSTOM_OPTION_ID ? value.custom : '',
  };
}

/** 输入自定义文本：只改文本，不自动勾选；勾选由「其他」选项控制。 */
export function updateApprovalDraftCustom(value: ApprovalDraftValue, custom: string): ApprovalDraftValue {
  return { ...value, custom };
}

/**
 * 单题是否已作答：
 * - 选了至少 1 个真实选项；
 * - 或选中「其他（自行填写）」且文本非空。
 */
export function isDraftValueAnswered(value: ApprovalDraftValue): boolean {
  if (pickedOptionIds(value).length > 0) return true;
  return isCustomPicked(value) && value.custom.trim() !== '';
}

export interface ApprovalDraftIssue {
  /** 0 基题目下标 */
  index: number;
  /** missing=没选任何东西；custom-empty=选了「其他」但没填内容 */
  kind: 'missing' | 'custom-empty';
}

export type ApprovalDraftValidation = { ok: true } | { ok: false; issue: ApprovalDraftIssue };

/** 逐题校验：返回第一个未完成题目的下标与原因。 */
export function validateApprovalDraft(approval: Approval, drafts: ApprovalDraft): ApprovalDraftValidation {
  const questions = approvalQuestions(approval);
  for (const [index, question] of questions.entries()) {
    const value = drafts[question.id] ?? emptyApprovalDraftValue();
    if (!isCustomPicked(value) && pickedOptionIds(value).length === 0) {
      return { ok: false, issue: { index, kind: 'missing' } };
    }
    if (isCustomPicked(value) && value.custom.trim() === '') {
      return { ok: false, issue: { index, kind: 'custom-empty' } };
    }
  }
  return { ok: true };
}

/** 选中项 → 契约里的 answers[]，顺序与题目顺序一致；自定义回答写入 custom。 */
export function buildApprovalAnswers(approval: Approval, drafts: ApprovalDraft): ApprovalAnswer[] {
  return approvalQuestions(approval).map((question) => {
    const value = drafts[question.id] ?? emptyApprovalDraftValue();
    const optionIds = pickedOptionIds(value);
    const custom = isCustomPicked(value) ? value.custom.trim() : '';
    return {
      questionId: question.id,
      optionIds,
      labels: optionIds.map(
        (optionId) => question.options.find((option) => option.id === optionId)?.label ?? optionId,
      ),
      ...(custom ? { custom } : {}),
    };
  });
}

/** 拍平后的 optionIds/labels（兼容旧 UI 与服务端存储）。 */
export function flattenAnswers(answers: ApprovalAnswer[]): { optionIds: string[]; labels: string[] } {
  return {
    optionIds: answers.flatMap((answer) => answer.optionIds),
    labels: answers.flatMap((answer) => answer.labels),
  };
}

/**
 * 所有题目的选择是否都是拒绝/停止语义（用于“驳回”类提示，服务端最终判定为准）。
 * 任何一题填了自定义回答都不算拒绝（自定义 = 用户给第三种方案）。
 */
export function allAnswersAreReject(approval: Approval, answers: ApprovalAnswer[]): boolean {
  if (answers.some((answer) => (answer.custom ?? '').trim() !== '')) return false;
  const questions = approvalQuestions(approval);
  const selected = questions.flatMap((question, index) => {
    const answer = answers.find((item) => item.questionId === question.id) ?? answers[index];
    const ids = answer?.optionIds ?? [];
    return ids.map((id) => question.options.find((option) => option.id === id)).filter(Boolean) as ApprovalOption[];
  });
  return selected.length > 0 && selected.every(isRejectOption);
}

/** 审批提交后发到会话的全文（多问题格式见任务/设计规范）。 */
export function formatApprovalSessionText(
  approval: Approval,
  answers: ApprovalAnswer[] | undefined,
  comment: string,
  decision: 'approve' | 'reject',
  optionIds: string[] = [],
): string {
  if (isMultiQuestionApproval(approval) && answers?.length) {
    const questions = approvalQuestions(approval);
    const lines = answers.map((answer, index) => {
      const question = questions[index];
      const label = question?.header?.trim() || question?.question || `Q${index + 1}`;
      const labelText = answer.labels.join('、');
      const customText = answer.custom?.trim() ? `自定义：${answer.custom.trim()}` : '';
      const value = [labelText, customText].filter(Boolean).join('；') || '（未选）';
      return `- ${label}：${value}`;
    });
    const note = comment ? `\n备注：${comment}` : '';
    return `【看板·审批】已提交「${approval.title}」：\n${lines.join('\n')}${note}`;
  }
  const header = decision === 'reject' ? '已拒绝' : '已批准';
  const labels =
    answers?.flatMap((answer) => answer.labels) ??
    approval.resolution?.labels ??
    optionIds.map((id) => approval.options.find((option) => option.id === id)?.label ?? id);
  const note = comment ? `\n备注：${comment}` : '';
  return `【看板·审批】${header}「${approval.title}」：${labels.join('、')}${note}`;
}

export interface ResolvedAnswerGroup {
  question: ApprovalQuestion;
  labels: string[];
  /** v0.4：该题的自定义回答 */
  custom?: string;
}

/**
 * 已解决态逐题展示：
 * 1) 优先 resolution.answers（v0.3 / v0.4 custom）；
 * 2) 否则用 resolution.optionIds/labels 按题目归属反查（兼容旧数据）；
 * 3) 再退化到拍平的 labels 单组展示。
 */
export function resolvedAnswerGroups(approval: Approval): ResolvedAnswerGroup[] {
  const questions = approvalQuestions(approval);
  const resolution = approval.resolution;
  if (!resolution) return [];
  if (Array.isArray(resolution.answers) && resolution.answers.length) {
    return questions.map((question, index) => {
      const answer =
        resolution.answers?.find((item) => item.questionId === question.id) ?? resolution.answers?.[index];
      return {
        question,
        labels: answer?.labels ?? [],
        ...(answer?.custom ? { custom: answer.custom } : {}),
      };
    });
  }
  const ids = Array.isArray(resolution.optionIds)
    ? resolution.optionIds
    : typeof resolution.optionId === 'string'
      ? [resolution.optionId]
      : [];
  const labels = Array.isArray(resolution.labels)
    ? resolution.labels
    : typeof resolution.label === 'string'
      ? [resolution.label]
      : [];
  if (questions.length > 1) {
    return questions.map((question, index) => {
      const picked = question.options.filter((option) => ids.includes(option.id));
      if (picked.length) return { question, labels: picked.map((option) => option.label) };
      // 没有 id 可用时按 labels 顺序尽力分配（旧数据兼容）
      return { question, labels: index === 0 && !ids.length ? labels : [] };
    });
  }
  return [{ question: questions[0]!, labels }];
}
