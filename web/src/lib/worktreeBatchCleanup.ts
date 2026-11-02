/**
 * 「批量清理」候选与视图内提醒的纯逻辑（v0.25.0 ⑯/⑱，docs/contracts/02-http-api.md §13 / 06 §4.8）。
 *
 * - 候选 = 工作区里「安全可清理」的工作副本：非主工作副本、未锁定、目录未失效（prunable 用
 *   「清理失效记录」）、已并入主线、干净、没有未完成卡片 / 运行中会话占用——判定与单条清理
 *   `evaluateWorktreeCleanup` 完全同源，批量只是把安全项挑出来逐项执行；
 * - 执行复用单条清理接口（服务端会再校验一次），因此每一笔都天然带 ③ 的卡片时间线留痕；
 * - 视图内提醒（⑱）：24 小时内可关闭，到期后再次出现（不弹窗、不打断）。
 */
import { evaluateWorktreeCleanup } from './useWorkspaces';
import type {
  CleanupErrorReason,
  WorkspaceRepoGroup,
  WorkspaceWorktreeGroup,
  WorktreeCleanupCheck,
} from './useWorkspaces';
import type { I18nKey } from '../i18n';

/** 关闭「可清理」提醒后多久再次出现（⑱「定期提醒」，24 小时）。 */
export const CLEANUP_NUDGE_DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

export interface BatchCleanupCandidate {
  repo: WorkspaceRepoGroup;
  worktree: WorkspaceWorktreeGroup;
  check: WorktreeCleanupCheck;
}

export interface BatchCleanupCandidateOptions {
  /** 运行中会话的 cwd（客户端清理安全层；服务端不知道会话 cwd） */
  sessionCwds?: readonly string[];
}

/**
 * 挑出「批量清理」的安全候选（保持传入仓库/工作副本顺序，便于按仓库分组展示）。
 * 主工作副本与 prunable（目录已不存在）不在批量范围内：前者永远不能清理，
 * 后者走「清理失效记录」而不是软删除。
 */
export function collectBatchCleanupCandidates(
  repos: readonly WorkspaceRepoGroup[],
  options: BatchCleanupCandidateOptions = {},
): BatchCleanupCandidate[] {
  const sessionCwds = options.sessionCwds ?? [];
  const candidates: BatchCleanupCandidate[] = [];
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      if (worktree.isMain || worktree.prunable === true) continue;
      const check = evaluateWorktreeCleanup(worktree, { sessionCwds });
      if (check.safe) candidates.push({ repo, worktree, check });
    }
  }
  return candidates;
}

/** 按仓库分组（对话框展示用；保持候选顺序）。 */
export function groupBatchCleanupCandidates(
  candidates: readonly BatchCleanupCandidate[],
): { repo: WorkspaceRepoGroup; items: BatchCleanupCandidate[] }[] {
  const groups = new Map<string, { repo: WorkspaceRepoGroup; items: BatchCleanupCandidate[] }>();
  for (const candidate of candidates) {
    const key = candidate.repo.root;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(candidate);
      continue;
    }
    groups.set(key, { repo: candidate.repo, items: [candidate] });
  }
  return [...groups.values()];
}

export interface CleanupNudgeInput {
  /** 当前安全候选数 */
  count: number;
  /** 上次关闭提醒的时间（ms）；缺省/null 表示没关过 */
  dismissedAt?: number | null;
  /** 当前时间（ms），缺省 Date.now() */
  now?: number;
}

/**
 * 视图内「有 N 个工作副本可安全清理」提醒是否显示：
 * 没有安全项 → 不显示；关闭过 → 24 小时内不显示，到期后再次出现（定期提醒）。
 */
export function shouldShowCleanupNudge({ count, dismissedAt, now = Date.now() }: CleanupNudgeInput): boolean {
  if (!Number.isFinite(count) || count <= 0) return false;
  if (!Number.isFinite(dismissedAt) || (dismissedAt ?? 0) <= 0) return true;
  return now - (dismissedAt as number) >= CLEANUP_NUDGE_DISMISS_TTL_MS;
}

/** 批量清理逐项失败原因 → 人话文案 key（复用单条清理的错误文案）。 */
export function batchCleanupFailureKey(reason: CleanupErrorReason): I18nKey {
  switch (reason) {
    case 'WORKTREE_MAIN':
      return 'workspace.cleanupErrorMain';
    case 'WORKTREE_IN_USE':
      return 'workspace.cleanupErrorInUse';
    case 'WORKTREE_DIRTY':
      return 'workspace.cleanupErrorDirty';
    case 'WORKTREE_UNMERGED':
      return 'workspace.cleanupErrorUnmerged';
    case 'BRANCH_MAIN':
      return 'workspace.cleanupErrorBranchMain';
    case 'BRANCH_IN_USE':
      return 'workspace.cleanupErrorBranchInUse';
    case 'TRASH_MOVE_FAILED':
      return 'workspace.cleanupErrorTrash';
    case 'WORKTREE_PRUNE_FAILED':
      return 'workspace.cleanupErrorPrune';
    case 'BRANCH_DELETE_FAILED':
      return 'workspace.cleanupErrorBranchDelete';
    case 'NOT_FOUND':
      return 'workspace.cleanupErrorNotFound';
    default:
      return 'workspace.cleanupErrorUnknown';
  }
}
