/**
 * 「工作区」视图（v0.16，docs/contracts/02-http-api.md §12 / 06 §4.7）。
 *
 * 按仓库分块展示：仓库名 + 根路径 + 工作副本/卡片数 → 每个工作副本一行
 * （分支、主工作树/当前/未保存改动徽标、相对主线、路径、关联卡片 mini 列表、会话数）
 * → 未归属卡片（无 cwd / 不可用 / 没匹配到工作副本）放「未指定」块。
 *
 * 纯只读：唯一交互是点击卡片 mini 项打开详情抽屉；数据由 useWorkspaces + groupCardsByWorktree 提供。
 */
import { useCallback, useMemo, useState } from 'react';
import type { Card } from '../types';
import { useI18n } from '../i18n';
import type { Translate } from '../i18n';
import { STATUS_TONE } from '../lib/status';
import { IconChevronDown } from './Icons';
import { shortenPath } from '../lib/forkGraph';
import { countBoundSessions, groupCardsByWorktree } from '../lib/useWorkspaces';
import type { WorkspaceRepoGroup, WorkspaceWorktreeGroup, WorkspacesState } from '../lib/useWorkspaces';

interface WorkspaceViewProps {
  cards: Card[];
  workspaces: WorkspacesState;
  /** 点击 mini 卡片打开详情（App 的 actions.onOpenDetail） */
  onOpenCard: (cardId: string) => void;
}

/** 工作副本相对主线的短语：无 mainBranch / 无法计算时不显示。 */
function relationText(
  worktree: WorkspaceWorktreeGroup,
  mainBranch: string | null,
  t: Translate,
): string | null {
  if (!mainBranch) return null;
  const ahead = Math.max(0, worktree.aheadOfBase ?? 0);
  const behind = Math.max(0, worktree.behindOfBase ?? 0);
  if (ahead > 0 && behind > 0) return t('workspace.aheadBehind', { ahead, behind });
  if (ahead > 0) return t('workspace.ahead', { count: ahead });
  if (behind > 0) return t('workspace.behind', { count: behind });
  return t('workspace.sameAsMain');
}

/** 工作副本展示路径：主工作副本用仓库名；子工作副本用相对仓库根的路径；兜底取末两段。 */
function worktreeLabel(repo: WorkspaceRepoGroup, worktree: WorkspaceWorktreeGroup): string {
  const root = repo.root.replace(/\/+$/, '');
  const path = worktree.path.replace(/\/+$/, '');
  if (path === root) return repo.name;
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return shortenPath(worktree.path);
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

interface WorktreeRowProps {
  repo: WorkspaceRepoGroup;
  worktree: WorkspaceWorktreeGroup;
  onOpenCard: (cardId: string) => void;
}

/** 单个工作副本行：文件夹图标 + 分支/徽标/相对主线 + 路径/会话数 + 卡片 mini 列表。 */
function WorktreeRow({ repo, worktree, onOpenCard }: WorktreeRowProps) {
  const { t } = useI18n();
  const branch = worktree.branch ?? t('workspace.detached');
  const relation = relationText(worktree, repo.mainBranch, t);
  const sessionCount = countBoundSessions(worktree.cards);
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
          {worktree.dirty ? (
            <span className="kb-tag kb-workspace__tag--dirty">{t('workspace.dirty')}</span>
          ) : (
            <span className="kb-tag">{t('workspace.clean')}</span>
          )}
          {relation ? <span className="kb-workspace__relation">{relation}</span> : null}
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
    </li>
  );
}

interface RepoSectionProps {
  repo: WorkspaceRepoGroup;
  onOpenCard: (cardId: string) => void;
  collapsed: boolean;
  onToggle: (root: string) => void;
}

/** 一个仓库一块：可展开/收起的仓库头 + 该仓库所有工作副本。 */
function RepoSection({ repo, onOpenCard, collapsed, onToggle }: RepoSectionProps) {
  const { t } = useI18n();
  const panelId = `kb-workspace-panel-${encodeURIComponent(repo.root)}`;
  return (
    <section className={`kb-workspace__repo${collapsed ? ' kb-workspace__repo--collapsed' : ''}`} aria-label={repo.name}>
      <header className="kb-workspace__repo-head">
        <button
          type="button"
          className="kb-workspace__repo-toggle"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          aria-label={t(collapsed ? 'workspace.expandRepo' : 'workspace.collapseRepo', { name: repo.name })}
          title={t(collapsed ? 'workspace.expandRepo' : 'workspace.collapseRepo', { name: repo.name })}
          onClick={() => onToggle(repo.root)}
        >
          <span className={`kb-workspace__repo-chevron${collapsed ? '' : ' kb-workspace__repo-chevron--open'}`} aria-hidden="true">
            <IconChevronDown />
          </span>
        </button>
        <h2 className="kb-workspace__repo-name" title={repo.root}>
          {repo.name}
        </h2>
        <span className="kb-workspace__repo-path" title={repo.root}>
          {shortenPath(repo.root, 3)}
        </span>
        <span className="kb-workspace__repo-meta">
          {t('workspace.repoMeta', { worktrees: repo.worktrees.length, cards: repo.cardCount })}
        </span>
      </header>
      {collapsed ? (
        <p className="kb-workspace__repo-collapsed-hint">
          {t('workspace.repoCollapsed', { count: repo.worktrees.length })}
        </p>
      ) : (
        <ul className="kb-workspace__worktrees" id={panelId}>
          {repo.worktrees.map((worktree) => (
            <WorktreeRow key={worktree.path} repo={repo} worktree={worktree} onOpenCard={onOpenCard} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface UnassignedSectionProps {
  cards: Card[];
  onOpenCard: (cardId: string) => void;
}

/** 「未指定」块：无 cwd / 不可用 / 没匹配到工作副本的卡片。 */
function UnassignedSection({ cards, onOpenCard }: UnassignedSectionProps) {
  const { t } = useI18n();
  return (
    <section className="kb-workspace__repo kb-workspace__repo--unassigned" aria-label={t('workspace.unassigned')}>
      <header className="kb-workspace__repo-head">
        <h2 className="kb-workspace__repo-name">{t('workspace.unassigned')}</h2>
        <span className="kb-workspace__repo-meta">{t('workspace.cardCount', { count: cards.length })}</span>
      </header>
      <p className="kb-workspace__hint">{t('workspace.unassignedHint')}</p>
      <MiniCardList cards={cards} onOpenCard={onOpenCard} />
    </section>
  );
}

const COLLAPSED_REPOS_STORAGE_KEY = 'dsh-kanban.workspaces.collapsed';

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

/** 「工作区」视图：顶部摘要 + 按仓库分块 + 未归属块。只读（点击卡片打开详情）。 */
export function WorkspaceView({ cards, workspaces, onOpenCard }: WorkspaceViewProps) {
  const { t } = useI18n();
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(readCollapsedRepos);
  const toggleRepo = useCallback((root: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      storeCollapsedRepos(next);
      return next;
    });
  }, []);
  const groups = useMemo(
    () => groupCardsByWorktree(cards, workspaces.repos),
    [cards, workspaces.repos],
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
          collapsed={collapsedRepos.has(repo.root)}
          onToggle={toggleRepo}
        />
      ))}
      {groups.unassigned.length ? (
        <UnassignedSection cards={groups.unassigned} onOpenCard={onOpenCard} />
      ) : null}
    </div>
  );
}
