/**
 * 详情抽屉「工作线」区块（docs/contracts/06-git-context.md §5，v0.14.1 人话版）。
 *
 * 结构：标题 → 一句话人话总结 → 关键事实表（在哪条工作线 / 和主线比 / 和线上比 / 工作副本）
 * → 「提交图」折叠区（Fork 风格多泳道图 + 多工作树列表，默认收起）。
 *
 * 数据来自 `git.graph`（v0.14）：缺失（旧服务端）、不可用、或没有任何提交时整块返回 null，
 * 静默隐藏（不回退 v0.13 的两泳道示意）。
 */
import { useMemo, useState } from 'react';
import type { Card, GitBase, GitWorktree, SessionRow } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { buildForkGraph, shortenPath, shouldShowWorktreeCounts } from '../lib/forkGraph';
import { buildWorklineSummary } from '../lib/worklineSummary';
import type { WorklineSummary } from '../lib/worklineSummary';
import { useCardGit } from '../lib/useCardGit';
import { IconChevronDown } from './Icons';
import { AheadBehind, ForkGraph } from './ForkGraph';

interface GitBranchSectionProps {
  card: Card;
  sessions: SessionRow[];
}

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

/** 「和主线比」的一句话。 */
function mainSentence(summary: WorklineSummary, t: Translate): string {
  switch (summary.mainRelation) {
    case 'main':
      return t('git.summaryOnMain', { branch: summary.branch ?? '' });
    case 'same':
      return t('git.summaryMainSame');
    case 'merged':
      return summary.behindMain > 0
        ? t('git.summaryMergedBehind', { count: summary.behindMain })
        : t('git.summaryMerged');
    case 'behind-only':
      return t('git.summaryBehindOnly', { count: summary.behindMain });
    case 'ahead-only':
      return t('git.summaryAheadOnly', { count: summary.aheadMain });
    case 'ahead-behind':
      return t('git.summaryAheadBehind', { count: summary.aheadMain, behind: summary.behindMain });
  }
}

/** 与线上（upstream）关系的一句话。 */
function remoteSentence(summary: WorklineSummary, t: Translate): string {
  switch (summary.remoteRelation) {
    case 'no-upstream':
      return t('git.summaryNoUpstream');
    case 'synced':
      return t('git.summarySynced');
    case 'ahead':
      return t('git.summaryUpstreamAhead', { count: summary.aheadUpstream });
    case 'behind':
      return t('git.summaryUpstreamBehind', { count: summary.behindUpstream });
    case 'diverged':
      return t('git.summaryUpstreamDiverged', { ahead: summary.aheadUpstream, behind: summary.behindUpstream });
  }
}

/** 整段总结：位置 + 和主线 + 和线上，都是完整句子直接拼接。 */
function summaryText(summary: WorklineSummary, t: Translate): string {
  if (summary.position === 'detached') return t('git.summaryDetached');
  if (summary.position === 'main') {
    return t('git.summaryOnMain', { branch: summary.branch ?? '' }) + remoteSentence(summary, t);
  }
  return t('git.summaryFeature', { branch: summary.branch ?? '' }) + mainSentence(summary, t) + remoteSentence(summary, t);
}

/** 事实表的「和主线比」短语。 */
function mainFact(summary: WorklineSummary, t: Translate): string {
  if (summary.position === 'main') return t('git.factOnMain');
  switch (summary.mainRelation) {
    case 'same':
      return t('git.factSame');
    case 'merged':
      return t('git.factMerged');
    case 'behind-only':
      return t('git.factBehind', { count: summary.behindMain });
    case 'ahead-only':
      return t('git.factAhead', { count: summary.aheadMain });
    case 'ahead-behind':
      return `${t('git.factAhead', { count: summary.aheadMain })} · ${t('git.factBehind', { count: summary.behindMain })}`;
    default:
      return t('git.factOnMain');
  }
}

/** 事实表的「和线上比」短语。 */
function remoteFact(summary: WorklineSummary, t: Translate): string {
  switch (summary.remoteRelation) {
    case 'no-upstream':
      return t('git.factRemoteNoUpstream');
    case 'synced':
      return t('git.factRemoteSynced');
    case 'ahead':
      return t('git.factRemoteAhead', { count: summary.aheadUpstream });
    case 'behind':
      return t('git.factRemoteBehind', { count: summary.behindUpstream });
    case 'diverged':
      return t('git.factRemoteDiverged', { ahead: summary.aheadUpstream, behind: summary.behindUpstream });
  }
}

interface GitWorktreesProps {
  worktrees: GitWorktree[];
  truncated: number;
  /** 参照物：base.kind==='main' 时主工作树行是自比，隐藏 0/0 计数 */
  base: GitBase | null;
}

/** 多工作树列表（折叠区内，给需要看其它工作副本的人）。 */
function GitWorktrees({ worktrees, truncated, base }: GitWorktreesProps) {
  const { t } = useI18n();
  return (
    <div className="kb-git__worktrees">
      <ul className="kb-git__worktree-list" aria-label={t('git.worktreesLabel')}>
        {worktrees.map((worktree) => {
          const hasCounts = worktree.aheadOfBase !== null || worktree.behindOfBase !== null;
          return (
            <li
              className={`kb-git__worktree${worktree.isCurrent ? ' kb-git__worktree--current' : ''}`}
              key={worktree.path}
            >
              <span className="kb-git__worktree-main">
                <code className="kb-git__worktree-branch" title={worktree.branch ?? worktree.sha}>
                  {worktree.branch ?? t('git.head')}
                </code>
                {worktree.detached ? <span className="kb-git__tag">{t('git.detached')}</span> : null}
                {worktree.isMain ? <span className="kb-git__tag">{t('git.mainWorktree')}</span> : null}
                {worktree.isCurrent ? (
                  <span className="kb-git__tag kb-git__tag--current">{t('git.current')}</span>
                ) : null}
                {hasCounts && shouldShowWorktreeCounts(worktree, base) ? (
                  <AheadBehind ahead={worktree.aheadOfBase ?? 0} behind={worktree.behindOfBase ?? 0} />
                ) : null}
              </span>
              <span className="kb-git__worktree-path" title={worktree.path}>
                {shortenPath(worktree.path)}
              </span>
            </li>
          );
        })}
      </ul>
      {truncated > 0 ? <p className="kb-git__fork-more">{t('git.moreWorktrees', { count: truncated })}</p> : null}
    </div>
  );
}

/**
 * 「工作线」区块：非技术用户先看人话总结与事实表，提交图折叠为进阶。
 * 数据不可用 / 读取失败 / 旧服务端无 graph 时返回 null（整块静默隐藏）。
 */
export function GitBranchSection({ card, sessions }: GitBranchSectionProps) {
  const { t } = useI18n();
  const [graphOpen, setGraphOpen] = useState(false);
  const { git } = useCardGit(card, sessions);
  const layout = useMemo(
    () => (git && git.available && git.graph ? buildForkGraph(git.graph) : null),
    [git],
  );
  const summary = useMemo(
    () => (git && git.available && git.graph ? buildWorklineSummary(git) : null),
    [git],
  );
  const worktreeBranches = useMemo(() => {
    const branches = new Set<string>();
    if (!git || !git.available) return branches;
    for (const worktree of git.worktrees) {
      if (worktree.branch) branches.add(worktree.branch);
    }
    return branches;
  }, [git]);
  if (!git || !git.available || !layout || !summary || layout.rows.length === 0) return null;

  return (
    <section className="kb-drawer__section kb-git">
      <h3 className="kb-drawer__section-title" title={summaryText(summary, t)}>
        {t('git.title')}
      </h3>
      <dl className="kb-git__facts">
        <div className="kb-git__fact">
          <dt>{t('git.factBranch')}</dt>
          <dd>
            <code className="kb-git__fact-code" title={summary.branch ?? undefined}>
              {summary.branch ?? t('git.detached')}
            </code>
          </dd>
        </div>
        <div className="kb-git__fact">
          <dt>{t('git.factMain')}</dt>
          <dd>{mainFact(summary, t)}</dd>
        </div>
        <div className="kb-git__fact">
          <dt>{t('git.factRemote')}</dt>
          <dd>{remoteFact(summary, t)}</dd>
        </div>
        <div className="kb-git__fact">
          <dt>{t('git.factWorktree')}</dt>
          <dd>
            <code className="kb-git__fact-code" title={summary.worktreePath}>
              {summary.isWorktree ? shortenPath(summary.worktreePath) : t('git.factWorktreeMain')}
            </code>
          </dd>
        </div>
      </dl>
      <button
        type="button"
        className="kb-git__toggle"
        aria-expanded={graphOpen}
        onClick={() => setGraphOpen((open) => !open)}
      >
        <span className="kb-icon kb-git__toggle-icon" aria-hidden="true">
          <IconChevronDown />
        </span>
        <span>{t('git.graphToggle')}</span>
        <span className="kb-git__toggle-meta">{t('git.graphToggleMeta', { count: summary.commitCount })}</span>
      </button>
      {graphOpen ? (
        <div className="kb-git__advanced">
          <ForkGraph layout={layout} worktreeBranches={worktreeBranches} />
          {git.worktrees.length > 1 ? (
            <GitWorktrees worktrees={git.worktrees} truncated={git.worktreesTruncated ?? 0} base={git.base} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
