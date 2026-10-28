/**
 * 详情抽屉「分支 / 工作树」区块（docs/contracts/06-git-context.md §5）。
 *
 * 结构：标题 → chips（当前分支 / 工作树 / 远端跟踪 / 游离 HEAD）→ Fork 风格多泳道提交图
 * → 多工作树列表（>1 时）。
 *
 * 数据来自 `git.graph`（v0.14）：缺失（旧服务端）、不可用、或没有任何提交时整块返回 null，
 * 静默隐藏（不回退 v0.13 的两泳道示意）。
 */
import { useMemo } from 'react';
import type { Card, GitBase, GitCurrent, GitUpstream, GitWorktree, SessionRow } from '../types';
import { useI18n } from '../i18n';
import { buildForkGraph, shortenPath, shouldShowWorktreeCounts } from '../lib/forkGraph';
import { pathBasename } from '../lib/suggestions';
import { useCardGit } from '../lib/useCardGit';
import { AheadBehind, ForkGraph } from './ForkGraph';

interface GitBranchSectionProps {
  card: Card;
  sessions: SessionRow[];
}

/** chips：当前分支（等宽）/ 工作树 / 远端跟踪（↑↓ 相对 upstream）/ 游离 HEAD 提示。 */
function GitChips({ current, upstream }: { current: GitCurrent; upstream: GitUpstream | null }) {
  const { t } = useI18n();
  const worktreeName = current.isWorktree
    ? pathBasename(current.worktree) || shortenPath(current.worktree)
    : t('git.mainWorktree');
  return (
    <div className="kb-git__chips">
      <span className="kb-git__chip">
        <span className="kb-git__chip-label">{t('git.branch')}</span>
        <code className="kb-git__chip-value" title={current.branch ?? undefined}>
          {current.branch ?? t('git.head')}
        </code>
        {current.detached ? <span className="kb-git__chip-note">{t('git.detached')}</span> : null}
      </span>
      <span className="kb-git__chip">
        <span className="kb-git__chip-label">{t('git.worktree')}</span>
        <code className="kb-git__chip-value" title={current.worktree}>
          {worktreeName}
        </code>
      </span>
      {upstream ? (
        <span className="kb-git__chip">
          <span className="kb-git__chip-label">{t('git.upstream')}</span>
          <code className="kb-git__chip-value" title={upstream.ref}>
            {upstream.ref}
          </code>
          <AheadBehind ahead={upstream.ahead} behind={upstream.behind} />
        </span>
      ) : (
        <span className="kb-git__chip kb-git__chip--muted">
          <span className="kb-git__chip-label">{t('git.upstream')}</span>
          <span className="kb-git__chip-note">{t('git.noUpstream')}</span>
        </span>
      )}
    </div>
  );
}

interface GitWorktreesProps {
  worktrees: GitWorktree[];
  truncated: number;
  /** 参照物：base.kind==='main' 时主工作树行是自比，隐藏 0/0 计数 */
  base: GitBase | null;
}

/** 多工作树列表：分支、主工作树/当前徽标、相对主分支 ↑↓、路径末两段（title 全文）。 */
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
 * 「分支 / 工作树」区块：数据不可用 / 读取失败 / 旧服务端无 graph 时返回 null（整块静默隐藏）。
 * 读取中同样不占位（git 探测通常 <150ms，避免骨架闪烁）。
 */
export function GitBranchSection({ card, sessions }: GitBranchSectionProps) {
  const { t } = useI18n();
  const { git } = useCardGit(card, sessions);
  const layout = useMemo(
    () => (git && git.available && git.graph ? buildForkGraph(git.graph) : null),
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
  if (!git || !git.available || !layout || layout.rows.length === 0) return null;
  return (
    <section className="kb-drawer__section kb-git">
      <h3 className="kb-drawer__section-title">{t('git.title')}</h3>
      <GitChips current={git.current} upstream={git.upstream} />
      <ForkGraph layout={layout} worktreeBranches={worktreeBranches} />
      {git.worktrees.length > 1 ? (
        <GitWorktrees worktrees={git.worktrees} truncated={git.worktreesTruncated ?? 0} base={git.base} />
      ) : null}
    </section>
  );
}
