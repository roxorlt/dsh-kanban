import type { Approval, ApprovalOption, Card, ColumnId } from '../types';

/** 审批选项声明的提交去向（与设计文档 outcome 枚举一致：不含 needs_you）。 */
export type ApprovalOutcome = 'running' | 'backlog' | 'done';

const OUTCOMES: readonly ApprovalOutcome[] = ['running', 'backlog', 'done'] as const;

/** 提交审批时 UI 侧已知的选择（与 ApprovalPanel 的 ApprovalSubmission 结构对齐，避免 lib 反向依赖组件）。 */
export interface ApprovalSubmissionLike {
  optionIds: readonly string[];
  answers?: readonly { questionId: string; optionIds: readonly string[] }[];
}

/** App 里审批决定的语义（与 ApprovalPanel 的 ApprovalDecision 对齐）。 */
export type ApprovalDecisionLike = 'approve' | 'reject';

/** 把提交内容展开成「按题序、按勾选顺序」的所选选项。 */
export function selectedApprovalOptions(
  approval: Approval,
  submission: ApprovalSubmissionLike,
): ApprovalOption[] {
  if (approval.questions?.length) {
    const picked: ApprovalOption[] = [];
    for (const question of approval.questions) {
      const answer = submission.answers?.find((item) => item.questionId === question.id);
      for (const optionId of answer?.optionIds ?? []) {
        const option = question.options.find((item) => item.id === optionId);
        if (option) picked.push(option);
      }
    }
    return picked;
  }
  return submission.optionIds
    .map((optionId) => approval.options.find((item) => item.id === optionId))
    .filter((option): option is ApprovalOption => Boolean(option));
}

/**
 * 审批提交后卡片落到的列：选中选项声明了 outcome 就用它；
 * 未声明时批准回「进行中」、驳回回「待办」（对齐设计文档 §2.5）。
 */
export function approvalOutcomeColumn(
  approval: Approval,
  submission: ApprovalSubmissionLike,
  decision: ApprovalDecisionLike,
): ColumnId {
  const declared = selectedApprovalOptions(approval, submission).find(
    (option): option is ApprovalOption & { outcome: ApprovalOutcome } =>
      Boolean(option.outcome) && OUTCOMES.includes(option.outcome as ApprovalOutcome),
  );
  if (declared) return declared.outcome;
  return decision === 'reject' ? 'backlog' : 'running';
}

/**
 * 提交审批瞬间卡片应乐观移动到的列；null 表示不移动：
 * - 卡片不在 `needs_you`（如受阻/失败、已被拖走）= 保持原状态等人处理；
 * - 还有其它待处理审批 = 先留在原列，等最后一条提交；
 * - 已归档 = 不动。
 */
export function approvalMoveTarget(
  card: Pick<Card, 'status' | 'archived' | 'approvals'>,
  approval: Pick<Approval, 'id' | 'options' | 'questions'>,
  submission: ApprovalSubmissionLike,
  decision: ApprovalDecisionLike,
): ColumnId | null {
  if (card.archived === true) return null;
  if (card.status !== 'needs_you') return null;
  if (card.approvals.some((item) => item.id !== approval.id && item.status === 'pending')) return null;
  return approvalOutcomeColumn(approval as Approval, submission, decision);
}
