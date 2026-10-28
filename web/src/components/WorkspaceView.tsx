/**
 * 「工作区」视图（v0.17，docs/contracts/02-http-api.md §12/§13 / 06 §4.7/§4.8）。
 *
 * 按仓库分块展示：仓库标题栏整行可点（展开/收起，状态持久化）→ 每个工作副本一行：
 * 分支、Phase A 状态（合并 / 远端 / 改动）、路径、卡片 mini 列表、会话数、清理按钮；
 * 「未指定」块同样可展开/收起。清理（Phase B）走两段式确认对话框 + 软删除接口。
 *
 * 数据由 useWorkspaces + groupCardsByWorktree 提供；写操作仅「清理工作副本」。
 */
import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../types';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { I18nKey, Translate } from '../i18n';
import { STATUS_TONE } from '../lib/status';
import { IconChevronDown } from './Icons';
import { shortenPath } from '../lib/forkGraph';
import {
  cleanupErrorNeedsLossConfirm,
  cleanupErrorReason,
  countBoundSessions,
  evaluateWorktreeCleanup,
  groupCardsByWorktree,
  worktreeStatusBadges,
} from '../lib/useWorkspaces';
import type {
  WorktreeStatusBadge,
  WorkspaceRepoGroup,
  WorkspaceWorktreeGroup,
  WorkspacesController,
} from '../lib/useWorkspaces';
import { CleanupWorktreeDialog } from './CleanupWorktreeDialog';
import type { CleanupConfirmOptions, CleanupOutcome, CleanupTarget } from './CleanupWorktreeDialog';

interface WorkspaceViewProps {
  cards: Card[];
  workspaces: WorkspacesController;
  /** 点击 mini 卡片打开详情（App 的 actions.onOpenDetail） */
  onOpenCard: (cardId: string) => void;
  /** 清理成功后的 toast（App 的 actions.onNotify） */
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void;
}

/** 工作副本展示路径：主工作副本用仓库名；子工作副本用相对仓库根的路径；兜底取末两段。 */
function worktreeLabel(repo: WorkspaceRepoGroup, worktree: WorkspaceWorktreeGroup): string {
  const root = repo.root.replace(/\/+$/, '');
  const path = worktree.path.replace(/\/+$/, '');
  if (path === root) return repo.name;
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return shortenPath(worktree.path);
}

/** Phase A 状态徽标的色调：合并/改动给状态色，远端多数保持中性。 */
function badgeClass(badge: WorktreeStatusBadge): string {
  if (badge.kind === 'merge') {
    return badge.key === 'workspace.mergedIntoMain' ? ' kb-workspace__tag--success' : ' kb-workspace__tag--warn';
  }
  if (badge.kind === 'changes') {
    return badge.key === 'workspace.clean' ? '' : ' kb-workspace__tag--dirty';
  }
  if (badge.kind === 'remote') {
    return badge.key === 'workspace.remoteSynced' || badge.key === 'workspace.remoteNone'
      ? ''
      : ' kb-workspace__tag--warn';
  }
  return '';
}

interface MiniCardListProps {
  cards: Card[];
  onOpenCard: (cardId: string) => void;
  emptyLabel?: string;
}

/** 关联卡片 mini 列表：状态点 + 标题（单行省略），点击打开详情。 */
function MiniCardList({ cards, onOpenCard, emptyLabel }: MiniCardListProps) {
  const { t } = useI18n();
  if (!cards.length) {
    return <p className="kb-workspace__no-cards">{emptyLabel ?? t('workspace.noCards')}</p>;
  }
  return (
    <ul className="kb-workspace__cards">
      {cards.map((card) => (
        <li key={card.id}>
          <button
            type="button"
            className="kb-workspace__card"
            title={card.title}
            aria-label={t('workspace.openCard', { title: card.title })}
            onClick={() => onOpenCard(card.id)}
          >
            <span className={`kb-dot kb-dot--${STATUS_TONE[card.status]}`} aria-hidden="true" />
            <span className="kb-workspace__card-title">{card.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface CleanupControlProps {
  worktree: WorkspaceWorktreeGroup;
  onCleanup: (worktree: WorkspaceWorktreeGroup) => void;
}

/** 清理按钮 + 不可清理原因 / 可安全清理提示。 */
function CleanupControl({ worktree, onCleanup }: CleanupControlProps) {
  const { t } = useI18n();
  const check = evaluateWorktreeCleanup(worktree);
  const reason =
    check.blocked === 'main'
      ? t('workspace.cleanupBlockedMain')
      : check.blocked === 'running'
          ? t('workspace.cleanupBlockedRunning')
          : check.blocked === 'in-use'
            ? t('workspace.cleanupBlockedInUse', { count: check.cardCount })
            : null;
  return (
    <span className="kb-workspace__cleanup">
      {check.safe ? <span className="kb-workspace__cleanup-safe">{t('workspace.cleanupSafe')}</span> : null}
      <button
        type="button"
        className="kb-btn kb-btn--sm kb-btn--ghost kb-workspace__cleanup-btn"
        disabled={!check.canCleanup}
        title={reason ?? t('workspace.cleanup')}
        aria-label={reason ?? t('workspace.cleanup')}
        onClick={() => onCleanup(worktree)}
      >
        {t('workspace.cleanup')}
      </button>
      {reason ? <span className="kb-workspace__cleanup-blocked">{reason}</span> : null}
    </span>
  );
}

interface WorktreeRowProps {
  repo: WorkspaceRepoGroup;
  worktree: WorkspaceWorktreeGroup;
  onOpenCard: (cardId: string) => void;
  onCleanup: (worktree: WorkspaceWorktreeGroup) => void;
}

/** 单个工作副本行：文件夹图标 + 分支/状态徽标 + 路径/会话数 + 卡片 mini 列表 + 清理按钮。 */
function WorktreeRow({ repo, worktree, onOpenCard, onCleanup }: WorktreeRowProps) {
  const { t } = useI18n();
  const branch = worktree.branch ?? t('workspace.detached');
  const sessionCount = countBoundSessions(worktree.cards);
  const badges = worktreeStatusBadges(worktree);
  return (
    <li className={`kb-workspace__worktree${worktree.isCurrent ? ' kb-workspace__worktree--current' : ''}`}>
      <span className="kb-workspace__folder" aria-hidden="true" />
      <div className="kb-workspace__wt-main">
        <div className="kb-workspace__wt-head">
          <code className="kb-workspace__branch" title={branch}>
            {branch}
          </code>
          {worktree.isMain ? <span className="kb-tag">{t('workspace.mainWorktree')}</span> : null}
          {worktree.isCurrent ? <span className="kb-tag kb-tag--current">{t('workspace.current')}</span> : null}
          {badges.map((badge) => (
            <span className={`kb-tag${badgeClass(badge)}`} key={`${badge.kind}:${badge.key}`}>
              {t(badge.key as I18nKey, badge.params)}
            </span>
          ))}
        </div>
        <div className="kb-workspace__wt-meta">
          <span className="kb-workspace__path" title={worktree.path}>
            {worktreeLabel(repo, worktree)}
          </span>
          <span className="kb-workspace__card-count">{t('workspace.cardCount', { count: worktree.cards.length })}</span>
          {sessionCount > 0 ? (
            <span className="kb-workspace__sessions">{t('workspace.sessions', { count: sessionCount })}</span>
          ) : null}
        </div>
      </div>
      <MiniCardList cards={worktree.cards} onOpenCard={onOpenCard} />
      <CleanupControl worktree={worktree} onCleanup={onCleanup} />
    </li>
  );
}

interface RepoSectionProps {
  repo: WorkspaceRepoGroup;
  onOpenCard: (cardId: string) => void;
  onCleanup: (worktree: WorkspaceWorktreeGroup) => void;
  collapsed: boolean;
  onToggle: (root: string) => void;
}

/** 一个仓库一块：整行可点的仓库标题栏 + 该仓库所有工作副本。 */
function RepoSection({ repo, onOpenCard, onCleanup, collapsed, onToggle }: RepoSectionProps) {
  const { t } = useI18n();
  const panelId = `kb-workspace-panel-${encodeURIComponent(repo.root)}`;
  return (
    <section className={`kb-workspace__repo${collapsed ? ' kb-workspace__repo--collapsed' : ''}`} aria-label={repo.name}>
      <button
        type="button"
        className="kb-workspace__repo-head"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        aria-label={t(collapsed ? 'workspace.expandRepo' : 'workspace.collapseRepo', { name: repo.name })}
        title={t(collapsed ? 'workspace.expandRepo' : 'workspace.collapseRepo', { name: repo.name })}
        onClick={() => onToggle(repo.root)}
      >
        <span
          className={`kb-workspace__repo-chevron${collapsed ? '' : ' kb-workspace__repo-chevron--open'}`}
          aria-hidden="true"
        >
          <IconChevronDown />
        </span>
        <span className="kb-workspace__repo-name" role="heading" aria-level={2} title={repo.root}>
          {repo.name}
        </span>
        <span className="kb-workspace__repo-path" title={repo.root}>
          {shortenPath(repo.root, 3)}
        </span>
        <span className="kb-workspace__repo-meta">
          {t('workspace.repoMeta', { worktrees: repo.worktrees.length, cards: repo.cardCount })}
        </span>
      </button>
      {collapsed ? (
        <p className="kb-workspace__repo-collapsed-hint">
          {t('workspace.repoCollapsed', { count: repo.worktrees.length })}
        </p>
      ) : (
        <ul className="kb-workspace__worktrees" id={panelId}>
          {repo.worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.path}
              repo={repo}
              worktree={worktree}
              onOpenCard={onOpenCard}
              onCleanup={onCleanup}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface UnassignedSectionProps {
  cards: Card[];
  onOpenCard: (cardId: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}

/** 「未指定」块：无 cwd / 不可用 / 没匹配到工作副本的卡片；整行可点收起/展开。 */
function UnassignedSection({ cards, onOpenCard, collapsed, onToggle }: UnassignedSectionProps) {
  const { t } = useI18n();
  const panelId = 'kb-workspace-panel-unassigned';
  const name = t('workspace.unassigned');
  return (
    <section
      className={`kb-workspace__repo kb-workspace__repo--unassigned${collapsed ? ' kb-workspace__repo--collapsed' : ''}`}
      aria-label={name}
    >
      <button
        type="button"
        className="kb-workspace__repo-head"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        aria-label={t(collapsed ? 'workspace.expandRepo' : 'workspace.collapseRepo', { name })}
        title={t(collapsed ? 'workspace.expandRepo' : 'workspace.collapseRepo', { name })}
        onClick={onToggle}
      >
        <span
          className={`kb-workspace__repo-chevron${collapsed ? '' : ' kb-workspace__repo-chevron--open'}`}
          aria-hidden="true"
        >
          <IconChevronDown />
        </span>
        <span className="kb-workspace__repo-name" role="heading" aria-level={2}>
          {name}
        </span>
        <span className="kb-workspace__repo-meta">{t('workspace.cardCount', { count: cards.length })}</span>
      </button>
      {collapsed ? (
        <p className="kb-workspace__repo-collapsed-hint">
          {t('workspace.unassignedCollapsed', { count: cards.length })}
        </p>
      ) : (
        <div id={panelId}>
          <p className="kb-workspace__hint">{t('workspace.unassignedHint')}</p>
          <MiniCardList cards={cards} onOpenCard={onOpenCard} />
        </div>
      )}
    </section>
  );
}

const COLLAPSED_REPOS_STORAGE_KEY = 'dsh-kanban.workspaces.collapsed';
const UNASSIGNED_COLLAPSED_STORAGE_KEY = 'dsh-kanban.workspaces.unassigned-collapsed';

/** 读取记住的「已收起仓库」（localStorage 不可用时静默返回空）。 */
function readCollapsedRepos(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_REPOS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function storeCollapsedRepos(roots: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_REPOS_STORAGE_KEY, JSON.stringify([...roots]));
  } catch {
    // 隐私模式/配额满：忽略，本次会话内仍可收起
  }
}

function readUnassignedCollapsed(): boolean {
  try {
    return localStorage.getItem(UNASSIGNED_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function storeUnassignedCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(UNASSIGNED_COLLAPSED_STORAGE_KEY, '1');
    else localStorage.removeItem(UNASSIGNED_COLLAPSED_STORAGE_KEY);
  } catch {
    // 忽略
  }
}

/** 清理失败错误码 → 人话文案。 */
function cleanupErrorMessage(error: unknown, t: Translate): string {
  switch (cleanupErrorReason(error)) {
    case 'WORKTREE_MAIN':
      return t('workspace.cleanupErrorMain');
    case 'WORKTREE_IN_USE':
      return t('workspace.cleanupErrorInUse');
    case 'WORKTREE_DIRTY':
      return t('workspace.cleanupErrorDirty');
    case 'WORKTREE_UNMERGED':
      return t('workspace.cleanupErrorUnmerged');
    case 'BRANCH_MAIN':
      return t('workspace.cleanupErrorBranchMain');
    case 'BRANCH_IN_USE':
      return t('workspace.cleanupErrorBranchInUse');
    case 'TRASH_MOVE_FAILED':
      return t('workspace.cleanupErrorTrash');
    case 'WORKTREE_PRUNE_FAILED':
      return t('workspace.cleanupErrorPrune');
    case 'BRANCH_DELETE_FAILED':
      return t('workspace.cleanupErrorBranchDelete');
    case 'NOT_FOUND':
      return t('workspace.cleanupErrorNotFound');
    default:
      return t('workspace.cleanupErrorUnknown', {
        message: error instanceof Error ? error.message : String(error),
      });
  }
}

/** 「工作区」视图：顶部摘要 + 按仓库分块 + 未归属块 + 清理对话框。 */
export function WorkspaceView({ cards, workspaces, onOpenCard, onNotify }: WorkspaceViewProps) {
  const { t } = useI18n();
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(readCollapsedRepos);
  const [unassignedCollapsed, setUnassignedCollapsed] = useState<boolean>(readUnassignedCollapsed);
  const [cleanupTarget, setCleanupTarget] = useState<CleanupTarget | null>(null);

  const toggleRepo = useCallback((root: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      storeCollapsedRepos(next);
      return next;
    });
  }, []);

  const toggleUnassigned = useCallback(() => {
    setUnassignedCollapsed((previous) => {
      const next = !previous;
      storeUnassignedCollapsed(next);
      return next;
    });
  }, []);

  const groups = useMemo(() => groupCardsByWorktree(cards, workspaces.repos), [cards, workspaces.repos]);

  const handleCleanupConfirm = useCallback(
    async (options: CleanupConfirmOptions): Promise<CleanupOutcome> => {
      if (!cleanupTarget) return { ok: false };
      const { repo, worktree } = cleanupTarget;
      try {
        const result = await api.cleanupWorktree({
          repoRoot: repo.root,
          worktreePath: worktree.path,
          deleteBranch: options.deleteBranch,
          confirmLoss: options.confirmLoss,
        });
        const message =
          result.branchDeleted && result.branchName
            ? t('workspace.cleanupDoneBranch', {
                branch: result.branchName,
                days: result.trashRetentionDays,
              })
            : t('workspace.cleanupDone', { days: result.trashRetentionDays });
        setCleanupTarget(null);
        onNotify?.(message, 'success');
        workspaces.reload();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: cleanupErrorMessage(error, t),
          lossRequired: cleanupErrorNeedsLossConfirm(error),
        };
      }
    },
    [cleanupTarget, onNotify, t, workspaces],
  );

  if (workspaces.disabled) {
    return (
      <div className="kb-workspace" role="region" aria-label={t('app.viewWorkspaces')}>
        <p className="kb-workspace__empty">{t('workspace.disabled')}</p>
      </div>
    );
  }
  if (!cards.length) {
    return (
      <div className="kb-workspace" role="region" aria-label={t('app.viewWorkspaces')}>
        <p className="kb-workspace__empty">{t('workspace.empty')}</p>
      </div>
    );
  }
  if (!workspaces.loaded && !groups.repos.length) {
    return (
      <div className="kb-workspace" role="region" aria-label={t('app.viewWorkspaces')}>
        <p className="kb-workspace__empty">{t('common.loading')}</p>
      </div>
    );
  }

  const summary = t('workspace.summary', {
    repos: groups.repos.length,
    worktrees: groups.worktreeCount,
    running: groups.runningCount,
  });
  return (
    <div className="kb-workspace" role="region" aria-label={t('app.viewWorkspaces')}>
      <header className="kb-workspace__summary">{summary}</header>
      {!groups.repos.length ? <p className="kb-workspace__hint">{t('workspace.noReposHint')}</p> : null}
      {groups.repos.map((repo) => (
        <RepoSection
          key={repo.root}
          repo={repo}
          onOpenCard={onOpenCard}
          onCleanup={(worktree) => setCleanupTarget({ repo, worktree })}
          collapsed={collapsedRepos.has(repo.root)}
          onToggle={toggleRepo}
        />
      ))}
      {groups.unassigned.length ? (
        <UnassignedSection
          cards={groups.unassigned}
          onOpenCard={onOpenCard}
          collapsed={unassignedCollapsed}
          onToggle={toggleUnassigned}
        />
      ) : null}
      {cleanupTarget ? (
        <CleanupWorktreeDialog
          key={cleanupTarget.worktree.path}
          target={cleanupTarget}
          onConfirm={handleCleanupConfirm}
          onClose={() => setCleanupTarget(null)}
        />
      ) : null}
    </div>
  );
}
