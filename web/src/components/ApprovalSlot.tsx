import { usePresenceValue } from '../lib/usePresence';
import { ApprovalPanel } from './ApprovalPanel';
import type { ApprovalDecision, ApprovalSubmission } from './ApprovalPanel';
import type { Approval } from '../types';

/** 离场时长：与 styles/base.css 的 --kb-dur-exit 同源（docs/11-motion.md §6.3）。 */
const APPROVAL_EXIT_MS = 140;

interface ApprovalSlotProps {
  /** 待处理审批；提交成功后服务端刷新会让它变 null —— 这里要把它淡出而不是硬消失。 */
  approval: Approval | null;
  busy: boolean;
  now: number;
  /** 详情抽屉内放宽展示；卡片内限高滚动 */
  inDrawer?: boolean;
  onResolve: (
    approval: Approval,
    submission: ApprovalSubmission,
    comment: string,
    decision: ApprovalDecision,
  ) => void;
  /** 逐题校验失败时提示（toast） */
  onValidationError?: (message: string) => void;
  /** 覆盖离场时长（毫秒），默认 140ms。 */
  exitMs?: number;
}

/**
 * 审批区块的「带离场」外壳（docs/11-motion.md §6.3「审批提交反馈」）。
 *
 * 提交成功后审批消失，若直接条件渲染卸载就没有反馈；这里用 usePresence 保留 140ms，
 * 期间挂 `.kb-approval-slot--leaving` 只做 opacity/2px 位移的淡出，并吃掉指针事件。
 * reduced-motion 下保留 120ms 纯 opacity 淡变（B 级，见 base.css 末尾例外清单）。
 */
export function ApprovalSlot({
  approval,
  busy,
  now,
  inDrawer = false,
  onResolve,
  onValidationError,
  exitMs = APPROVAL_EXIT_MS,
}: ApprovalSlotProps) {
  const { mounted, leaving, value } = usePresenceValue(Boolean(approval), approval, exitMs, {
    keepInReducedMotion: true,
  });
  if (!mounted || !value) return null;
  return (
    <div className={`kb-approval-slot${leaving ? ' kb-approval-slot--leaving' : ''}`}>
      <ApprovalPanel
        approval={value}
        busy={busy || leaving}
        now={now}
        inDrawer={inDrawer}
        onResolve={onResolve}
        onValidationError={onValidationError}
      />
    </div>
  );
}
