import type { Approval, ApprovalAnswer, ApprovalOption, ApprovalQuestion } from '../types';

const REJECT_IDS = ['no', 'reject', 'deny', 'cancel', 'stop', 'hold'];

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

export type ApprovalSelection = Record<string, string[]>;

export interface ApprovalValidation {
  ok: boolean;
  missingIndex: number | null;
}

/** 逐题校验：每题至少 1 项。 */
export function validateApprovalSelection(
  approval: Approval,
  selection: ApprovalSelection,
): ApprovalValidation {
  const questions = approvalQuestions(approval);
  const missingIndex = questions.findIndex((question) => (selection[question.id] ?? []).length === 0);
  return { ok: missingIndex === -1, missingIndex: missingIndex === -1 ? null : missingIndex };
}

/** 选中项 → 契约里的 answers[]，顺序与题目顺序一致。 */
export function buildApprovalAnswers(approval: Approval, selection: ApprovalSelection): ApprovalAnswer[] {
  return approvalQuestions(approval).map((question) => {
    const optionIds = selection[question.id] ?? [];
    return {
      questionId: question.id,
      optionIds,
      labels: optionIds.map(
        (optionId) => question.options.find((option) => option.id === optionId)?.label ?? optionId,
      ),
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

/** 所有题目的选择是否都是拒绝/停止语义（用于“驳回”类提示，服务端最终判定为准）。 */
export function allAnswersAreReject(approval: Approval, answers: ApprovalAnswer[]): boolean {
  const questions = approvalQuestions(approval);
  const selected = questions.flatMap((question, index) => {
    const ids = answers[index]?.optionIds ?? [];
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
      return `- ${label}：${answer.labels.join('、') || '（未选）'}`;
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
}

/**
 * 已解决态逐题展示：
 * 1) 优先 resolution.answers（v0.3）；
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
      return { question, labels: answer?.labels ?? [] };
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
