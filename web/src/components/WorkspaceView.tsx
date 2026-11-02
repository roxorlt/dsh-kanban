/**
 * 「工作区」视图（v0.18，docs/contracts/02-http-api.md §12/§13/§14 / 06 §4.7/§4.8）。
 *
 * 按仓库分块展示工作副本（分支、Phase A 状态、卡片预览、最近提交、清理）：
 * - 仓库标题栏整行可展开/收起；「未指定」块同样可收起；
 * - 每个仓库内：主工作副本固定第一、活跃工作副本按优先级排序、空闲工作副本收进默认收起的子分组；
 * - 顶部可切换卡片范围（只看当前筛选 / 显示全部，持久化）；
 * - 底部可收起「回收站（N）」：恢复 / 彻底删除（v0.18）；
 * - 清理（Phase B）两段式确认 + 软删除；运行中会话所在工作副本禁止清理（客户端安全层）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Card, GitTrashEntry, SessionRow } from '../types';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { I18nKey, Lang, Translate } from '../i18n';
import { STATUS_TONE } from '../lib/status';
import { copyText } from '../lib/clipboard';
import { IconChevronDown, IconCopy } from './Icons';
import { shortenPath } from '../lib/forkGraph';
import { formatDateTime } from '../lib/time';
import {
  cleanupErrorNeedsLossConfirm,
  cleanupErrorReason,
  countBoundSessions,
  evaluateWorktreeCleanup,
  formatLastCommitRelative,
  formatWorktreeLabel,
  groupCardsByWorktree,
  previewWorkspaceCards,
  pruneErrorReason,
  selectWorkspaceCards,
  sortRepoGroups,
  splitRepoWorktrees,
  trashErrorReason,
  worktreeStatusBadges,
} from '../lib/useWorkspaces';
import type {
  SessionAttribution,
  WorkspaceCardScope,
  WorkspaceRepoGroup,
  WorkspaceWorktreeGroup,
  WorkspacesController,
  WorktreeCleanupCheck,
  WorktreeStatusBadge,
} from '../lib/useWorkspaces';
import { CleanupWorktreeDialog } from './CleanupWorktreeDialog';
import type { CleanupConfirmOptions, CleanupOutcome, CleanupTarget } from './CleanupWorktreeDialog';
import { ConfirmDialog } from './ConfirmDialog';

interface WorkspaceViewProps {
  /** 当前筛选后的卡片（scope=filtered 时用于分组） */
  cards: Card[];
  /** 全部未归档卡片（scope=all 与清理占用判定用） */
  allCards: Card[];
  workspaces: WorkspacesController;
  /** v0.21.0 #14：休眠会话执行目录，用于 cwd 兜底归属（缺省=不兜底） */
  sessions?: SessionRow[];
  /** 运行中会话的 cwd（客户端清理安全层；服务端不知道会话 cwd） */
  runningSessionCwds?: string[];
  /** 相对时间基准（App 的 15s 时钟）；缺省 Date.now() */
  now?: number;
  /** 点击 mini 卡片打开详情（App 的 actions.onOpenDetail） */
  onOpenCard: (cardId: string) => void;
  /** v0.21.0 #16：卡片行「重新绑定目录」入口（只在「未指定」块提供） */
  onRebindCard?: (card: Card) => void;
  /** 操作结果 toast（App 的 actions.onNotify） */
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void;
}

const COLLAPSED_REPOS_STORAGE_KEY = 'dsh-kanban.workspaces.collapsed';
const UNASSIGNED_COLLAPSED_STORAGE_KEY = 'dsh-kanban.workspaces.unassigned-collapsed';
const TRASH_COLLAPSED_STORAGE_KEY = 'dsh-kanban.workspaces.trash-collapsed';
const SCOPE_STORAGE_KEY = 'dsh-kanban.workspaces.scope';

/** 服务端每仓库最多返回 12 个工作副本；被截断时给出提示（契约 §12 v0.20）。 */
const WORKTREE_DISPLAY_LIMIT = 12;

/** 缺省会话列表（保持引用稳定，避免分组 memo 失效）。 */
const NO_SESSIONS: SessionRow[] = [];

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

// ---------------------------------------------------------------- 本地存储

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

function readTrashCollapsed(): boolean {
  try {
    return localStorage.getItem(TRASH_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function storeTrashCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(TRASH_COLLAPSED_STORAGE_KEY, '1');
    else localStorage.removeItem(TRASH_COLLAPSED_STORAGE_KEY);
  } catch {
    // 忽略
  }
}

function readWorkspaceScope(): WorkspaceCardScope {
  try {
    return localStorage.getItem(SCOPE_STORAGE_KEY) === 'filtered' ? 'filtered' : 'all';
  } catch {
    return 'all';
  }
}

function storeWorkspaceScope(scope: WorkspaceCardScope): void {
  try {
    localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // 忽略
  }
}

// ---------------------------------------------------------------- 错误文案

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

/** 回收站操作失败错误码 → 人话文案（契约 §14：RESTORE_PATH_EXISTS / RESTORE_SHA_MISSING 等）。 */
function trashErrorMessage(error: unknown, t: Translate): string {
  switch (trashErrorReason(error)) {
    case 'RESTORE_PATH_EXISTS':
      return t('workspace.trashErrorPathExists');
    case 'RESTORE_SHA_MISSING':
      return t('workspace.trashErrorShaMissing');
    case 'NOT_FOUND':
      return t('workspace.trashErrorNotFound');
    case 'BAD_REQUEST':
      return t('workspace.trashErrorBadRequest');
    case 'RESTORE_FAILED':
      return t('workspace.trashErrorRestoreFailed');
    case 'TRASH_DELETE_FAILED':
      return t('workspace.trashErrorDeleteFailed');
    default:
      return t('workspace.trashErrorUnknown', {
        message: error instanceof Error ? error.message : String(error),
      });
  }
}

/** prune 失败错误码 → 人话文案（契约 §15）。 */
function pruneErrorMessage(error: unknown, t: Translate): string {
  switch (pruneErrorReason(error)) {
    case 'NOT_FOUND':
      return t('workspace.pruneErrorNotFound');
    case 'BAD_REQUEST':
      return t('workspace.pruneErrorBadRequest');
    case 'PRUNE_FAILED':
      return t('workspace.pruneErrorFailed');
    default:
      return t('workspace.pruneErrorUnknown', {
        message: error instanceof Error ? error.message : String(error),
      });
  }
}

/** 回收站条目展示名：仓库名 / 工作副本名。 */
function trashEntryName(entry: GitTrashEntry): string {
  return `${entry.repoName} / ${entry.worktreeName}`;
}

// ---------------------------------------------------------------- 子组件

interface MiniCardListProps {
  cards: Card[];
  onOpenCard: (cardId: string) => void;
  emptyLabel?: string;
  /** v0.21.0 #14：cardId → attribution，命中的卡片在标题后加「按会话归属」小标签 */
  sessionAttributed?: ReadonlyMap<string, SessionAttribution>;
  /** v0.21.0 #16：提供时每张卡片行尾出现「重新绑定目录」小按钮 */
  onRebind?: (card: Card) => void;
}

/** 关联卡片 mini 列表：状态点 + 标题（单行省略），默认最多 5 张，可展开全部。 */
function MiniCardList({ cards, onOpenCard, emptyLabel, sessionAttributed, onRebind }: MiniCardListProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!cards.length) {
    return <p className="kb-workspace__no-cards">{emptyLabel ?? t('workspace.noCards')}</p>;
  }
  const { visible, hiddenCount } = previewWorkspaceCards(cards);
  const shown = expanded ? cards : visible;
  return (
    <div className="kb-workspace__card-wrap">
      <ul className="kb-workspace__cards">
        {shown.map((card) => {
          const attribution = sessionAttributed?.get(card.id);
          return (
            <li className="kb-workspace__card-row" key={card.id}>
              <button
                type="button"
                className="kb-workspace__card"
                title={card.title}
                aria-label={t('workspace.openCard', { title: card.title })}
                onClick={() => onOpenCard(card.id)}
              >
                <span className={`kb-dot kb-dot--${STATUS_TONE[card.status]}`} aria-hidden="true" />
                <span className="kb-workspace__card-title">{card.title}</span>
                {attribution ? (
                  <span
                    className="kb-tag kb-workspace__session-tag"
                    title={t('workspace.sessionAttributionTitle', { cwd: attribution.sessionCwd })}
                  >
                    {t('workspace.sessionAttribution')}
                  </span>
                ) : null}
              </button>
              {onRebind ? (
                <button
                  type="button"
                  className="kb-btn kb-btn--sm kb-btn--ghost kb-workspace__rebind"
                  title={t('workspace.rebindCwdTitle', { title: card.title })}
                  aria-label={t('workspace.rebindCwdTitle', { title: card.title })}
                  onClick={() => onRebind(card)}
                >
                  {t('workspace.rebindCwd')}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="kb-workspace__more-cards"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('workspace.collapseCards') : t('workspace.moreCards', { count: hiddenCount })}
        </button>
      ) : null}
    </div>
  );
}

interface CleanupControlProps {
  check: WorktreeCleanupCheck;
  /** v0.20：目录已不存在（prunable）时改为「清理失效记录」，不做软删除清理 */
  prunable: boolean;
  onCleanup: () => void;
  onPrune: () => void;
}

/** 清理按钮 + 不可清理原因 / 可安全清理提示；prunable 时显示「清理失效记录」。 */
function CleanupControl({ check, prunable, onCleanup, onPrune }: CleanupControlProps) {
  const { t } = useI18n();
  if (prunable) {
    return (
      <span className="kb-workspace__cleanup">
        <button
          type="button"
          className="kb-btn kb-btn--sm kb-btn--outline kb-workspace__prune-btn"
          title={t('workspace.prune')}
          aria-label={t('workspace.prune')}
          onClick={onPrune}
        >
          {t('workspace.prune')}
        </button>
      </span>
    );
  }
  const reason =
    check.blocked === 'locked'
      ? t('workspace.cleanupBlockedLocked')
      : check.blocked === 'main'
        ? t('workspace.cleanupBlockedMain')
        : check.blocked === 'session'
          ? t('workspace.cleanupBlockedSession')
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
        onClick={onCleanup}
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
  /** 清理判定用的占用卡片（来自全部未归档卡片，不受筛选范围影响） */
  occupancyCards: Card[];
  runningSessionCwds: string[];
  /** v0.21.0 #14：cardId → 按会话归属记录（工作副本行只显示标签，不提供重新绑定） */
  sessionAttributed: ReadonlyMap<string, SessionAttribution>;
  now: number;
  onOpenCard: (cardId: string) => void;
  onCleanup: (worktree: WorkspaceWorktreeGroup) => void;
  onPrune: (worktree: WorkspaceWorktreeGroup) => void;
  onCopy: (text: string, kind: 'path' | 'branch') => void;
}

/** 单个工作副本行：文件夹图标 + 分支/状态徽标 + 最近提交 + 卡片预览 + 清理/复制按钮。 */
function WorktreeRow({
  repo,
  worktree,
  occupancyCards,
  runningSessionCwds,
  sessionAttributed,
  now,
  onOpenCard,
  onCleanup,
  onPrune,
  onCopy,
}: WorktreeRowProps) {
  const { t, lang } = useI18n();
  const branch = worktree.branch ?? t('workspace.detached');
  const sessionCount = countBoundSessions(worktree.cards);
  const badges = worktreeStatusBadges(worktree);
  const check = evaluateWorktreeCleanup(
    { ...worktree, cards: occupancyCards },
    { sessionCwds: runningSessionCwds },
  );
  const lastCommit = formatLastCommitRelative(worktree.lastCommitAt, now, lang as Lang);
  const lastCommitTitle =
    worktree.lastCommitAt && lastCommit ? formatDateTime(Date.parse(worktree.lastCommitAt), lang as Lang) : undefined;
  return (
    <li className={`kb-workspace__worktree${worktree.isCurrent ? ' kb-workspace__worktree--current' : ''}`}>
      <span className="kb-workspace__folder" aria-hidden="true" />
      <div className="kb-workspace__wt-main">
        <div className="kb-workspace__wt-head">
          <code className="kb-workspace__branch" title={branch}>
            {branch}
          </code>
          {worktree.branch ? (
            <button
              type="button"
              className="kb-workspace__copy kb-workspace__copy--branch"
              title={t('workspace.copyBranch')}
              aria-label={t('workspace.copyBranch')}
              onClick={() => onCopy(worktree.branch ?? '', 'branch')}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconCopy />
              </span>
            </button>
          ) : null}
          {worktree.isMain ? <span className="kb-tag">{t('workspace.mainWorktree')}</span> : null}
          {worktree.isCurrent ? <span className="kb-tag kb-tag--current">{t('workspace.current')}</span> : null}
          {worktree.locked ? <span className="kb-tag kb-workspace__tag--warn">{t('workspace.locked')}</span> : null}
          {worktree.prunable ? (
            <span className="kb-tag kb-workspace__tag--danger">{t('workspace.prunable')}</span>
          ) : null}
          {badges.map((badge) => (
            <span className={`kb-tag${badgeClass(badge)}`} key={`${badge.kind}:${badge.key}`}>
              {t(badge.key as I18nKey, badge.params)}
            </span>
          ))}
        </div>
        <div className="kb-workspace__wt-meta">
          <span className="kb-workspace__path-line">
            <span className="kb-workspace__path" title={worktree.path}>
              {formatWorktreeLabel(repo, worktree)}
            </span>
            <button
              type="button"
              className="kb-workspace__copy kb-workspace__copy--path"
              title={t('workspace.copyPath')}
              aria-label={t('workspace.copyPath')}
              onClick={() => onCopy(worktree.path, 'path')}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconCopy />
              </span>
              <span className="kb-workspace__copy-text">{t('workspace.copyPath')}</span>
            </button>
          </span>
          <span className="kb-workspace__card-count">{t('workspace.cardCount', { count: worktree.cards.length })}</span>
          {sessionCount > 0 ? (
            <span className="kb-workspace__sessions">{t('workspace.sessions', { count: sessionCount })}</span>
          ) : null}
          {lastCommit ? (
            <span className="kb-workspace__last-commit" title={lastCommitTitle}>
              {lastCommit}
            </span>
          ) : null}
        </div>
      </div>
      <MiniCardList cards={worktree.cards} onOpenCard={onOpenCard} sessionAttributed={sessionAttributed} />
      <CleanupControl
        check={check}
        prunable={worktree.prunable === true}
        onCleanup={() => onCleanup(worktree)}
        onPrune={() => onPrune(worktree)}
      />
    </li>
  );
}

interface RepoSectionProps {
  repo: WorkspaceRepoGroup;
  occupancyByPath: Map<string, Card[]>;
  runningSessionCwds: string[];
  sessionAttributed: ReadonlyMap<string, SessionAttribution>;
  now: number;
  onOpenCard: (cardId: string) => void;
  onCleanup: (worktree: WorkspaceWorktreeGroup) => void;
  onPrune: (worktree: WorkspaceWorktreeGroup) => void;
  onCopy: (text: string, kind: 'path' | 'branch') => void;
  collapsed: boolean;
  onToggle: (root: string) => void;
  idleExpanded: boolean;
  onToggleIdle: (root: string) => void;
}

/** 一个仓库一块：整行可点的仓库标题栏 + 主/活跃工作副本 + 空闲工作副本子分组。 */
function RepoSection({
  repo,
  occupancyByPath,
  runningSessionCwds,
  sessionAttributed,
  now,
  onOpenCard,
  onCleanup,
  onPrune,
  onCopy,
  collapsed,
  onToggle,
  idleExpanded,
  onToggleIdle,
}: RepoSectionProps) {
  const { t } = useI18n();
  const panelId = `kb-workspace-panel-${encodeURIComponent(repo.root)}`;
  const idlePanelId = `${panelId}-idle`;
  const split = splitRepoWorktrees(repo.worktrees);
  const truncated = repo.truncatedWorktrees ?? 0;
  const limit = WORKTREE_DISPLAY_LIMIT;
  const renderRow = (worktree: WorkspaceWorktreeGroup) => (
    <WorktreeRow
      key={worktree.path}
      repo={repo}
      worktree={worktree}
      occupancyCards={occupancyByPath.get(worktree.path) ?? worktree.cards}
      runningSessionCwds={runningSessionCwds}
      sessionAttributed={sessionAttributed}
      now={now}
      onOpenCard={onOpenCard}
      onCleanup={onCleanup}
      onPrune={onPrune}
      onCopy={onCopy}
    />
  );
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
        {truncated > 0 ? (
          <span className="kb-workspace__truncated" title={t('workspace.truncatedTitle', { limit })}>
            {t('workspace.truncated', { count: truncated })}
          </span>
        ) : null}
      </button>
      {collapsed ? (
        <p className="kb-workspace__repo-collapsed-hint">
          {t('workspace.repoCollapsed', { count: repo.worktrees.length })}
        </p>
      ) : (
        <div id={panelId}>
          <ul className="kb-workspace__worktrees">
            {split.main.map(renderRow)}
            {split.active.map(renderRow)}
          </ul>
          {split.idle.length ? (
            <>
              <button
                type="button"
                className="kb-workspace__idle-head"
                aria-expanded={idleExpanded}
                aria-controls={idlePanelId}
                onClick={() => onToggleIdle(repo.root)}
              >
                <span
                  className={`kb-workspace__repo-chevron${idleExpanded ? ' kb-workspace__repo-chevron--open' : ''}`}
                  aria-hidden="true"
                >
                  <IconChevronDown />
                </span>
                {t('workspace.idleWorktrees', { count: split.idle.length })}
              </button>
              {idleExpanded ? (
                <ul className="kb-workspace__worktrees kb-workspace__worktrees--idle" id={idlePanelId}>
                  {split.idle.map(renderRow)}
                </ul>
              ) : null}
            </>
          ) : null}
          {truncated > 0 ? (
            <p className="kb-workspace__truncated-foot">
              {t('workspace.truncatedFooter', { count: truncated, limit })}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

interface UnassignedSectionProps {
  cards: Card[];
  onOpenCard: (cardId: string) => void;
  /** v0.21.0 #16：卡片行尾「重新绑定目录」入口 */
  onRebind?: (card: Card) => void;
  collapsed: boolean;
  onToggle: () => void;
}

/** 「未指定」块：无 cwd / 不可用 / 没匹配到工作副本的卡片；整行可点收起/展开。 */
function UnassignedSection({ cards, onOpenCard, onRebind, collapsed, onToggle }: UnassignedSectionProps) {
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
          <MiniCardList cards={cards} onOpenCard={onOpenCard} onRebind={onRebind} />
        </div>
      )}
    </section>
  );
}

interface TrashSectionProps {
  entries: GitTrashEntry[];
  collapsed: boolean;
  busy: boolean;
  error: string | null;
  now: number;
  onToggle: () => void;
  onRestore: (entry: GitTrashEntry) => void;
  onPurge: (entry: GitTrashEntry) => void;
}

/** 回收站区块：可收起；每条可恢复 / 彻底删除；显示删除时间与可恢复性。 */
function TrashSection({ entries, collapsed, busy, error, now, onToggle, onRestore, onPurge }: TrashSectionProps) {
  const { t, lang } = useI18n();
  const panelId = 'kb-workspace-panel-trash';
  return (
    <section className="kb-workspace__repo kb-workspace__repo--trash" aria-label={t('workspace.trashTitle', { count: entries.length })}>
      <button
        type="button"
        className="kb-workspace__repo-head"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span
          className={`kb-workspace__repo-chevron${collapsed ? '' : ' kb-workspace__repo-chevron--open'}`}
          aria-hidden="true"
        >
          <IconChevronDown />
        </span>
        <span className="kb-workspace__repo-name" role="heading" aria-level={2}>
          {t('workspace.trashTitle', { count: entries.length })}
        </span>
        <span className="kb-workspace__repo-meta">{t('workspace.trashCountMeta', { count: entries.length })}</span>
      </button>
      {collapsed ? (
        <p className="kb-workspace__repo-collapsed-hint">
          {t('workspace.trashCollapsed', { count: entries.length })}
        </p>
      ) : (
        <div id={panelId}>
          <p className="kb-workspace__hint">{t('workspace.trashHint', { days: 7 })}</p>
          <ul className="kb-workspace__trash-list">
            {entries.map((entry) => {
              const deletedAt = formatLastCommitRelative(entry.trashedAt, now, lang as Lang);
              return (
                <li className="kb-workspace__trash-item" key={entry.id}>
                  <div className="kb-workspace__trash-main">
                    <span className="kb-workspace__trash-name" title={entry.worktreePath}>
                      {trashEntryName(entry)}
                    </span>
                    <span className="kb-workspace__trash-meta">
                      {entry.branch ? <code className="kb-workspace__trash-branch">{entry.branch}</code> : null}
                      {deletedAt ? <span>{t('workspace.trashDeletedAt', { time: deletedAt })}</span> : null}
                      <span className={`kb-tag${entry.restorable ? '' : ' kb-workspace__tag--warn'}`}>
                        {entry.restorable ? t('workspace.trashRestorable') : t('workspace.trashNotRestorable')}
                      </span>
                    </span>
                  </div>
                  <div className="kb-workspace__trash-actions">
                    <button
                      type="button"
                      className="kb-btn kb-btn--sm kb-btn--outline"
                      disabled={!entry.restorable || busy}
                      onClick={() => onRestore(entry)}
                    >
                      {t('workspace.trashRestore')}
                    </button>
                    <button
                      type="button"
                      className="kb-btn kb-btn--sm kb-btn--ghost kb-workspace__trash-purge"
                      disabled={busy}
                      onClick={() => onPurge(entry)}
                    >
                      {t('workspace.trashPurge')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {error ? (
        <p className="kb-workspace__trash-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface TrashActionState {
  kind: 'restore' | 'purge';
  entry: GitTrashEntry;
}

// ---------------------------------------------------------------- 主视图

/** 「工作区」视图：摘要（含范围切换）+ 按仓库分块 + 未指定块 + 回收站 + 清理对话框。 */
export function WorkspaceView({
  cards,
  allCards,
  workspaces,
  sessions,
  runningSessionCwds = [],
  now,
  onOpenCard,
  onRebindCard,
  onNotify,
}: WorkspaceViewProps) {
  const { t } = useI18n();
  const nowValue = now ?? Date.now();
  const sessionRows = sessions ?? NO_SESSIONS;
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(readCollapsedRepos);
  const [unassignedCollapsed, setUnassignedCollapsed] = useState<boolean>(readUnassignedCollapsed);
  const [idleExpandedRepos, setIdleExpandedRepos] = useState<Set<string>>(() => new Set());
  const [scope, setScope] = useState<WorkspaceCardScope>(readWorkspaceScope);
  const [cleanupTarget, setCleanupTarget] = useState<CleanupTarget | null>(null);
  const [pruneTarget, setPruneTarget] = useState<{ repo: WorkspaceRepoGroup; worktree: WorkspaceWorktreeGroup } | null>(null);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [trashEntries, setTrashEntries] = useState<GitTrashEntry[]>([]);
  const [trashCollapsed, setTrashCollapsed] = useState<boolean>(readTrashCollapsed);
  const [trashAction, setTrashAction] = useState<TrashActionState | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);

  const toggleRepo = useCallback((root: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      storeCollapsedRepos(next);
      return next;
    });
  }, []);

  const toggleIdle = useCallback((root: string) => {
    setIdleExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
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

  const toggleTrash = useCallback(() => {
    setTrashCollapsed((previous) => {
      const next = !previous;
      storeTrashCollapsed(next);
      return next;
    });
  }, []);

  const changeScope = useCallback((next: WorkspaceCardScope) => {
    setScope(next);
    storeWorkspaceScope(next);
  }, []);

  const refreshTrash = useCallback(async (): Promise<void> => {
    try {
      const entries = await api.getGitTrash();
      setTrashEntries(entries);
      setTrashError(null);
    } catch {
      // 回收站读取失败静默（不阻塞工作区视图）
    }
  }, []);

  useEffect(() => {
    void refreshTrash();
  }, [refreshTrash]);

  const scopeCards = useMemo(() => selectWorkspaceCards(scope, cards, allCards), [scope, cards, allCards]);
  const displayGroups = useMemo(
    () => groupCardsByWorktree(scopeCards, workspaces.repos, { sessions: sessionRows }),
    [scopeCards, workspaces.repos, sessionRows],
  );
  const allGroups = useMemo(
    () => groupCardsByWorktree(allCards, workspaces.repos, { sessions: sessionRows }),
    [allCards, workspaces.repos, sessionRows],
  );
  /** v0.21.0 #14：展示中的卡片 → 按会话归属记录（工作副本行显示「按会话归属」标签） */
  const attributionByCardId = useMemo(() => {
    const map = new Map<string, SessionAttribution>();
    for (const attribution of displayGroups.sessionAttributed) map.set(attribution.cardId, attribution);
    return map;
  }, [displayGroups.sessionAttributed]);
  const displayRepos = useMemo(() => sortRepoGroups(displayGroups.repos), [displayGroups.repos]);
  const occupancyByPath = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const repo of allGroups.repos) {
      for (const worktree of repo.worktrees) map.set(worktree.path, worktree.cards);
    }
    return map;
  }, [allGroups.repos]);

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
        void refreshTrash();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: cleanupErrorMessage(error, t),
          lossRequired: cleanupErrorNeedsLossConfirm(error),
        };
      }
    },
    [cleanupTarget, onNotify, refreshTrash, t, workspaces],
  );

  const handleCopy = useCallback(
    async (text: string, kind: 'path' | 'branch'): Promise<void> => {
      const ok = await copyText(text);
      if (ok) {
        onNotify?.(t(kind === 'path' ? 'workspace.copiedPath' : 'workspace.copiedBranch'), 'success');
      } else {
        onNotify?.(t('workspace.copyFailed', { message: t('workspace.copyUnavailable') }), 'error');
      }
    },
    [onNotify, t],
  );

  const handlePruneConfirm = useCallback(async (): Promise<void> => {
    if (!pruneTarget || pruneBusy) return;
    setPruneBusy(true);
    try {
      const result = await api.pruneGitWorktrees(pruneTarget.repo.root);
      setPruneTarget(null);
      onNotify?.(result.removed ? t('workspace.pruneDone') : t('workspace.pruneNoop'), 'success');
      workspaces.reload();
    } catch (error) {
      setPruneTarget(null);
      onNotify?.(pruneErrorMessage(error, t), 'error');
    } finally {
      setPruneBusy(false);
    }
  }, [onNotify, pruneBusy, pruneTarget, t, workspaces]);

  const handleTrashConfirm = useCallback(async (): Promise<void> => {
    if (!trashAction || trashBusy) return;
    const { kind, entry } = trashAction;
    setTrashBusy(true);
    setTrashError(null);
    try {
      if (kind === 'restore') {
        await api.restoreGitTrash(entry.id);
        onNotify?.(t('workspace.trashRestoreDone', { name: trashEntryName(entry) }), 'success');
      } else {
        await api.purgeGitTrash(entry.id);
        onNotify?.(t('workspace.trashPurgeDone', { name: trashEntryName(entry) }), 'success');
      }
      setTrashAction(null);
      await refreshTrash();
      workspaces.reload();
    } catch (error) {
      setTrashError(trashErrorMessage(error, t));
      setTrashAction(null);
    } finally {
      setTrashBusy(false);
    }
  }, [onNotify, refreshTrash, t, trashAction, trashBusy, workspaces]);

  if (workspaces.disabled) {
    return (
      <div className="kb-workspace" role="region" aria-label={t('app.viewWorkspaces')}>
        <p className="kb-workspace__empty">{t('workspace.disabled')}</p>
      </div>
    );
  }
  if (!allCards.length) {
    return (
      <div className="kb-workspace" role="region" aria-label={t('app.viewWorkspaces')}>
        <p className="kb-workspace__empty">{t('workspace.empty')}</p>
      </div>
    );
  }
  if (!workspaces.loaded && !workspaces.repos.length) {
    return (
      <div className="kb-workspace" role="region" aria-label={t('app.viewWorkspaces')}>
        <p className="kb-workspace__empty">{t('common.loading')}</p>
      </div>
    );
  }

  const summary = t('workspace.summary', {
    repos: displayRepos.length,
    worktrees: displayGroups.worktreeCount,
    running: displayGroups.runningCount,
  });
  const trashVisible = trashEntries.length > 0 || trashError !== null;
  const trashDialog = trashAction ? (
    <ConfirmDialog
      title={trashAction.kind === 'restore' ? t('workspace.trashRestoreTitle') : t('workspace.trashPurgeTitle')}
      message={
        trashAction.kind === 'restore'
          ? t('workspace.trashRestoreMessage', {
              name: trashEntryName(trashAction.entry),
              path: trashAction.entry.worktreePath,
            })
          : t('workspace.trashPurgeMessage', { name: trashEntryName(trashAction.entry) })
      }
      confirmLabel={
        trashAction.kind === 'restore' ? t('workspace.trashRestoreConfirm') : t('workspace.trashPurgeConfirm')
      }
      busy={trashBusy}
      danger={trashAction.kind === 'purge'}
      onConfirm={() => void handleTrashConfirm()}
      onClose={() => {
        if (!trashBusy) setTrashAction(null);
      }}
    />
  ) : null;

  return (
    <div className="kb-workspace" role="region" aria-label={t('app.viewWorkspaces')}>
      <header className="kb-workspace__summary">
        <span className="kb-workspace__summary-text">{summary}</span>
        <div className="kb-workspace__scope" role="group" aria-label={t('workspace.scopeLabel')}>
          <button
            type="button"
            className={`kb-workspace__scope-btn${scope === 'filtered' ? ' kb-workspace__scope-btn--on' : ''}`}
            aria-pressed={scope === 'filtered'}
            onClick={() => changeScope('filtered')}
          >
            {t('workspace.scopeFiltered')}
          </button>
          <button
            type="button"
            className={`kb-workspace__scope-btn${scope === 'all' ? ' kb-workspace__scope-btn--on' : ''}`}
            aria-pressed={scope === 'all'}
            onClick={() => changeScope('all')}
          >
            {t('workspace.scopeAll')}
          </button>
        </div>
      </header>
      {scopeCards.length === 0 ? <p className="kb-workspace__empty">{t('workspace.emptyFiltered')}</p> : null}
      {!displayRepos.length && scopeCards.length > 0 ? (
        <p className="kb-workspace__hint">{t('workspace.noReposHint')}</p>
      ) : null}
      {displayRepos.map((repo) => (
        <RepoSection
          key={repo.root}
          repo={repo}
          occupancyByPath={occupancyByPath}
          runningSessionCwds={runningSessionCwds}
          sessionAttributed={attributionByCardId}
          now={nowValue}
          onOpenCard={onOpenCard}
          onCleanup={(worktree) => setCleanupTarget({ repo, worktree })}
          onPrune={(worktree) => setPruneTarget({ repo, worktree })}
          onCopy={(text, kind) => void handleCopy(text, kind)}
          collapsed={collapsedRepos.has(repo.root)}
          onToggle={toggleRepo}
          idleExpanded={idleExpandedRepos.has(repo.root)}
          onToggleIdle={toggleIdle}
        />
      ))}
      {displayGroups.unassigned.length ? (
        <UnassignedSection
          cards={displayGroups.unassigned}
          onOpenCard={onOpenCard}
          onRebind={onRebindCard}
          collapsed={unassignedCollapsed}
          onToggle={toggleUnassigned}
        />
      ) : null}
      {trashVisible ? (
        <TrashSection
          entries={trashEntries}
          collapsed={trashCollapsed}
          busy={trashBusy}
          error={trashError}
          now={nowValue}
          onToggle={toggleTrash}
          onRestore={(entry) => setTrashAction({ kind: 'restore', entry })}
          onPurge={(entry) => setTrashAction({ kind: 'purge', entry })}
        />
      ) : null}
      {pruneTarget ? (
        <ConfirmDialog
          title={t('workspace.pruneTitle')}
          message={t('workspace.pruneMessage')}
          confirmLabel={t('workspace.pruneConfirm')}
          busy={pruneBusy}
          danger={false}
          onConfirm={() => void handlePruneConfirm()}
          onClose={() => {
            if (!pruneBusy) setPruneTarget(null);
          }}
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
      {trashDialog}
    </div>
  );
}
