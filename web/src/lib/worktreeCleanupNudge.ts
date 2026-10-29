/**
 * v0.21.0 #15：卡片完成时的「工作副本可安全清理」提示判定（纯函数）。
 *
 * 卡片进入 done 且它所在的工作副本已并入主线、干净、没有未完成卡片 / 运行中会话占用时，
 * 给一条**可操作 toast**（「打开工作区」），不弹窗打断。
 *
 * 判定与「工作区」视图的清理按钮同源（`evaluateWorktreeCleanup`）：
 * - 终态卡片（done/canceled）不阻塞清理（v0.21.0 语义），所以刚完成的这张卡本身不算占用；
 * - 主工作副本、git locked、目录已失效（prunable）一律不提示；
 * - 只有 done 提示，canceled 不提示清理（取消的卡片代码是否要留由用户自己决定）。
 */
import type { Card, GitWorkspaceRepo } from '../types';
import { evaluateWorktreeCleanup, findWorktreeForCwd } from './useWorkspaces';

export interface CleanupNudgeResult {
  worktreePath: string;
  /** 工作副本展示名：主工作副本=仓库名；linked=相对仓库根路径；兜底末段 */
  label: string;
  branch: string | null;
}

export interface CleanupNudgeInput {
  card: Pick<Card, 'id' | 'cwd' | 'status'>;
  /** 全部未归档卡片（含刚完成的这张；终态卡片不阻塞清理） */
  cards: readonly Card[];
  repos: readonly GitWorkspaceRepo[];
  /** 运行中会话的执行目录（客户端清理安全层） */
  sessionCwds?: readonly string[];
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/** cwd 是否等于该目录或位于其下（末尾 `/` 归一化后的前缀判定）。 */
export function cwdInside(cwd: string, path: string): boolean {
  const root = trimTrailingSlash(path.trim());
  const dir = trimTrailingSlash(cwd.trim());
  if (!root || !dir) return false;
  return dir === root || dir.startsWith(`${root}/`);
}

/** 工作副本展示名（与工作区视图的工作副本行一致）。 */
export function worktreeDisplayName(
  repo: Pick<GitWorkspaceRepo, 'root' | 'name'>,
  worktreePath: string,
): string {
  const root = trimTrailingSlash(repo.root);
  const path = trimTrailingSlash(worktreePath);
  if (path === root) return repo.name;
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 卡片完成 → 可安全清理的工作副本提示；不满足条件返回 null（不打扰）。
 */
export function buildCleanupNudge(input: CleanupNudgeInput): CleanupNudgeResult | null {
  const { card, cards, repos, sessionCwds = [] } = input;
  if (card.status !== 'done') return null;
  const cwd = card.cwd?.trim();
  if (!cwd) return null;

  const found = findWorktreeForCwd(cwd, repos);
  if (!found) return null;
  const { repo, worktree } = found;
  if (worktree.isMain || worktree.locked === true || worktree.prunable === true) return null;

  const occupying = cards.filter(
    (item) => !item.archived && item.cwd?.trim() && cwdInside(item.cwd, worktree.path),
  );
  const check = evaluateWorktreeCleanup({ ...worktree, cards: occupying }, { sessionCwds });
  if (!check.safe) return null;

  return {
    worktreePath: worktree.path,
    label: worktreeDisplayName(repo, worktree.path),
    branch: worktree.branch ?? null,
  };
}
