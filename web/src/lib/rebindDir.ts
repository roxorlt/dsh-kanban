/**
 * 卡片「重新绑定工作目录」的纯逻辑（v0.21.0 #16）。
 *
 * 场景：工作副本被清理后旧卡片的 `cwd` 指向已不存在的目录，卡片掉进「未指定」块
 * 或者详情里显示失效。这里负责：
 * 1. 从「卡片绑定会话的执行目录 + 已有工作区探测结果」里生成候选目录（`buildRebindCandidates`）；
 * 2. 判断卡片当前 cwd 的状态（`cardCwdState`）；
 * 3. 为重新绑定操作生成时间线留痕文案（`formatRebindComment`）。
 *
 * 全部是不依赖 DOM / React 的纯函数，方便单测；文案统一由调用方传入的 `t` 本地化。
 */
import type { Translate } from '../i18n';
import type { Card, GitWorkspaceRepo, GitWorkspaceUnavailable, SessionRow } from '../types';

/** 一个可重新绑定的候选目录（顺序即候选顺序）。 */
export interface RebindCandidate {
  path: string;
  /** 主文案（已按 t 本地化） */
  label: string;
  /** 次级说明（分支名 / 会话目录等，可为空） */
  detail?: string;
  kind: 'main' | 'worktree' | 'session';
  /** path === 卡片当前 cwd */
  isCurrent: boolean;
}

export interface RebindCandidateInput {
  repos: readonly GitWorkspaceRepo[];
  sessions: readonly SessionRow[];
  card: Pick<Card, 'cwd' | 'sessionIds'>;
  t: Translate;
}

/** 卡片 cwd 状态：无 cwd = 'missing'；cwd 已被探测为不存在 = 'invalid'；否则 'ok'。 */
export type CardCwdState = 'ok' | 'missing' | 'invalid';

/** 去掉首尾空白；非字符串一律视为空（服务端字段可能缺失）。 */
function trimPath(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 生成候选目录（契约 §3）：
 * 1. 卡片绑定会话的执行目录，按 `sessionIds` 顺序（未知会话 / 没有 cwd 的会话跳过）；
 * 2. 每个仓库的主工作副本；
 * 3. 每个仓库的 linked worktree（排除 `prunable` 的失效记录）。
 *
 * 按 path 去重（先出现者胜），跳过空串；`isCurrent` 标记该候选是否就是卡片当前 cwd。
 */
export function buildRebindCandidates({
  repos,
  sessions,
  card,
  t,
}: RebindCandidateInput): RebindCandidate[] {
  const candidates: RebindCandidate[] = [];
  const seen = new Set<string>();
  const currentCwd = trimPath(card.cwd);

  const add = (path: string, label: string, detail: string | undefined, kind: RebindCandidate['kind']): void => {
    const trimmed = trimPath(path);
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    const candidate: RebindCandidate = { path: trimmed, label, kind, isCurrent: trimmed === currentCwd };
    if (detail) candidate.detail = detail;
    candidates.push(candidate);
  };

  // 1) 绑定会话的执行目录（按 sessionIds 顺序，同一会话只出现一次）
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  for (const sessionId of card.sessionIds) {
    const session = sessionById.get(sessionId);
    if (!session) continue;
    const cwd = trimPath(session.cwd);
    if (!cwd) continue;
    add(
      cwd,
      t('rebind.sessionCandidate', { title: session.title || session.id }),
      t('rebind.sessionDetail', { path: cwd }),
      'session',
    );
  }

  // 2) + 3) 按仓库顺序：主工作副本在前，linked worktree 在后
  for (const repo of repos) {
    const worktrees = repo.worktrees.filter((worktree) => worktree.prunable !== true);
    for (const worktree of worktrees) {
      if (!worktree.isMain) continue;
      add(
        worktree.path,
        t('rebind.mainWorktree', { repo: repo.name }),
        worktree.branch ?? repo.mainBranch ?? undefined,
        'main',
      );
    }
    for (const worktree of worktrees) {
      if (worktree.isMain) continue;
      add(worktree.path, worktree.branch ?? t('workspace.detached'), repo.name, 'worktree');
    }
  }

  return candidates;
}

/**
 * 卡片 cwd 状态（契约 §3）：没有 cwd（含空串）= 'missing'；
 * 在 `workspaces.unavailable` 里且 `reason === 'missing'`（目录已不存在）= 'invalid'；其余 'ok'。
 */
export function cardCwdState(
  card: Pick<Card, 'cwd'>,
  unavailable: readonly GitWorkspaceUnavailable[],
): CardCwdState {
  const cwd = trimPath(card.cwd);
  if (!cwd) return 'missing';
  for (const entry of unavailable) {
    if (entry.reason !== 'missing') continue;
    if (trimPath(entry.dir) === cwd) return 'invalid';
  }
  return 'ok';
}

/** 重新绑定的时间线留痕文案：有旧目录用 moved，否则 set。 */
export function formatRebindComment(t: Translate, oldCwd: string | undefined, newCwd: string): string {
  const oldPath = trimPath(oldCwd);
  if (oldPath) return t('rebind.commentMoved', { old: oldPath, new: newCwd });
  return t('rebind.commentSet', { new: newCwd });
}
