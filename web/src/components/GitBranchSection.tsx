/**
 * 详情抽屉「分支 / 工作树」区块（docs/contracts/06-git-context.md §5）。
 *
 * - 顶部 chips：当前分支（等宽）、工作树、远端跟踪 ↑↓ / 未关联远端、主分支关系 ↑↓；
 * - 两泳道提交图（泳道 0 = 参照分支灰、泳道 1 = 当前分支业务蓝），分叉点画汇合线，
 *   HEAD 提交点加一圈高亮；每行 = refs 徽标 + subject 单行省略 + 短 sha；
 * - 超过 12 行只展示前 12 行，末尾给「还有 N 个提交」；
 * - 多工作树时在图下列表，当前工作树高亮；
 * - 数据不可用 / 读取失败 / 旧服务端 404 时整块返回 null（静默隐藏，不报错）。
 */
import { Fragment, useMemo } from 'react';
import type { Card, GitBase, GitCurrent, GitUpstream, GitWorktree, SessionRow } from '../types';
import { useI18n } from '../i18n';
import { buildGitGraph, shortenPath, shouldShowWorktreeCounts } from '../lib/gitGraph';
import type { GitGraphModel, GitGraphRow, GitLaneId } from '../lib/gitGraph';
import { pathBasename } from '../lib/suggestions';
import { useCardGit } from '../lib/useCardGit';

interface GitBranchSectionProps {
  card: Card;
  sessions: SessionRow[];
}

/** SVG 行高 / 泳道坐标：与抽屉 CSS 里 .kb-git__cell 的尺寸保持一致。 */
const ROW_HEIGHT = 20;
const DOT_Y = 10;
const LANE_X: Record<GitLaneId, number> = { 0: 10, 1: 22 };
const GRAPH_WIDTH = 30;

interface AheadBehindProps {
  ahead: number;
  behind: number;
}

/** 「↑N ↓M」：可见部分是 Git 习惯写法，读屏播报走 i18n 的领先/落后。 */
function AheadBehind({ ahead, behind }: AheadBehindProps) {
  const { t } = useI18n();
  const label = `${t('git.ahead', { count: ahead })} · ${t('git.behind', { count: behind })}`;
  return (
    <span className="kb-git__ab" title={label}>
      <span className="kb-git__sr">{label}</span>
      <span aria-hidden="true">↑{ahead}</span>
      <span aria-hidden="true">↓{behind}</span>
    </span>
  );
}

/** 当前分支是否已推送：有 upstream 且没有领先提交即视为已推送。 */
function pushState(upstream: GitUpstream | null): 'pushed' | 'unpushed' | null {
  if (!upstream) return null;
  return upstream.ahead > 0 ? 'unpushed' : 'pushed';
}

interface CommitRowProps {
  row: GitGraphRow;
  rows: readonly GitGraphRow[];
  index: number;
  hiddenCount: number;
  /** 代表当前分支的泳道；null = 图里没有当前分支的独有提交（单泳道参照分支） */
  currentLane: GitLaneId | null;
}

/** 单行提交：左侧 mini SVG（跨行竖线 / 分叉汇合线 / 提交点），右侧 refs + subject + 短 sha。 */
function CommitRow({ row, rows, index, hiddenCount, currentLane }: CommitRowProps) {
  const { t } = useI18n();
  const previous = rows[index - 1];
  const isLast = index === rows.length - 1;
  const isHead = row.refs.some((ref) => ref.kind === 'head');
  const isCurrentLane = currentLane !== null && row.lane === currentLane;
  const dotTone = isHead ? 'head' : isCurrentLane ? 'current' : 'base';
  // 最后一行且没有隐藏提交时，泳道线收在提交点上，避免图底部多出一截悬空线。
  const stopsHere = isLast && hiddenCount === 0;
  return (
    <li className={`kb-git__row${row.forkPoint ? ' kb-git__row--fork' : ''}`}>
      <span className="kb-git__cell">
        <svg
          className="kb-git__svg"
          width={GRAPH_WIDTH}
          height={ROW_HEIGHT}
          viewBox={`0 0 ${GRAPH_WIDTH} ${ROW_HEIGHT}`}
          aria-hidden="true"
          focusable="false"
        >
          {row.activeLanes.map((lane) => {
            const startsHere = !previous || !previous.activeLanes.includes(lane);
            const tone = currentLane !== null && lane === currentLane ? 'current' : 'base';
            return (
              <line
                key={`line-${lane}`}
                className={`kb-git__line kb-git__line--${tone}`}
                x1={LANE_X[lane]}
                y1={startsHere ? DOT_Y : 0}
                x2={LANE_X[lane]}
                y2={stopsHere ? DOT_Y : ROW_HEIGHT}
              />
            );
          })}
          {row.forkPoint ? (
            <path
              className="kb-git__join"
              d={`M ${LANE_X[1]} 0 L ${LANE_X[1]} 3 C ${LANE_X[1]} 7 ${LANE_X[1] - 5} ${DOT_Y} ${LANE_X[0]} ${DOT_Y}`}
            />
          ) : null}
          {isHead ? <circle className="kb-git__dot-halo" cx={LANE_X[row.lane]} cy={DOT_Y} r={6.4} /> : null}
          <circle
            className={`kb-git__dot kb-git__dot--${dotTone}`}
            cx={LANE_X[row.lane]}
            cy={DOT_Y}
            r={isHead ? 4 : row.refs.length ? 3.2 : 2.6}
          />
        </svg>
      </span>
      {row.refs.length ? (
        <span className="kb-git__refs">
          {row.refs.map((ref, refIndex) => (
            <code
              className={`kb-git__ref kb-git__ref--${ref.kind}`}
              key={`${ref.kind}:${ref.name}:${refIndex}`}
              title={ref.name}
            >
              {ref.name}
            </code>
          ))}
        </span>
      ) : null}
      <span className="kb-git__subject" title={row.subject || undefined}>
        {row.subject || '—'}
      </span>
      {row.forkPoint ? <span className="kb-git__fork">{t('git.forkPoint')}</span> : null}
      <code className="kb-git__sha" title={row.sha}>
        {row.shortSha}
      </code>
    </li>
  );
}

interface GitGraphProps {
  graph: GitGraphModel;
}

/** 泳道图：泳道标签 + 提交行 + 隐藏提交计数（只读，不可交互）。 */
function GitGraphView({ graph }: GitGraphProps) {
  const { t } = useI18n();
  // 双泳道固定泳道 1；单泳道只有「代表当前分支」时才用业务蓝，否则是参照分支的灰。
  const currentLane: GitLaneId | null = graph.singleLane
    ? graph.laneLabels[0]?.kind === 'current'
      ? 0
      : null
    : 1;
  const baseLabel = graph.laneLabels.find((lane) => lane.kind === 'base')?.label ?? null;
  const currentLabel = graph.laneLabels.find((lane) => lane.kind === 'current')?.label ?? null;
  const laneText = graph.singleLane
    ? baseLabel ?? currentLabel ?? t('git.head')
    : `${baseLabel ?? t('git.base')} / ${currentLabel ?? t('git.head')}`;
  return (
    <div className="kb-git__graph" role="group" aria-label={t('git.graphLabel')}>
      <div className="kb-git__legend">
        {graph.laneLabels.map((lane) => (
          <span className="kb-git__legend-item" key={lane.lane}>
            <span className={`kb-git__legend-dot kb-git__legend-dot--${lane.kind}`} aria-hidden="true" />
            <code className="kb-git__legend-label" title={lane.label ?? undefined}>
              {lane.label ?? t('git.head')}
            </code>
          </span>
        ))}
      </div>
      <ol className="kb-git__rows" aria-label={t('git.graphLabelFor', { label: laneText })}>
        {graph.rows.map((row, index) => (
          <Fragment key={row.key}>
            {/* 分叉点优先保留时被省略的 ahead/behind 提交位于中段，计数提示也放在这里 */}
            {graph.gapIndex === index ? (
              <li className="kb-git__more">{t('git.moreCommits', { count: graph.hiddenCount })}</li>
            ) : null}
            <CommitRow
              row={row}
              rows={graph.rows}
              index={index}
              hiddenCount={graph.hiddenCount}
              currentLane={currentLane}
            />
          </Fragment>
        ))}
      </ol>
      {graph.gapIndex === null && graph.hiddenCount > 0 ? (
        <p className="kb-git__more">{t('git.moreCommits', { count: graph.hiddenCount })}</p>
      ) : null}
    </div>
  );
}

interface GitChipsProps {
  current: GitCurrent;
  upstream: GitUpstream | null;
  base: GitBase | null;
}

/** 分支 / 工作树 chips：分支、工作树、远端跟踪、主分支关系。 */
function GitChips({ current, upstream, base }: GitChipsProps) {
  const { t } = useI18n();
  const pushed = pushState(upstream);
  const branch = current.branch;
  const worktreeName = current.isWorktree
    ? pathBasename(current.worktree) || shortenPath(current.worktree)
    : t('git.mainWorktree');
  // 当前就在主分支上时 base 就是 upstream：两枚 chip 的引用与 ↑↓ 完全一致，
  // 只保留「远端跟踪」一枚，避免抽屉里并排出现两行一模一样的 origin/main ↑N ↓M。
  const relationIsUpstream =
    base !== null &&
    upstream !== null &&
    base.label === upstream.ref &&
    base.ahead === upstream.ahead &&
    base.behind === upstream.behind;
  return (
    <div className="kb-git__chips">
      <span className="kb-git__chip">
        <span className="kb-git__chip-label">{t('git.branch')}</span>
        <code className="kb-git__chip-value" title={branch ?? undefined}>
          {branch ?? t('git.head')}
        </code>
        {current.detached ? <span className="kb-git__chip-note">{t('git.detached')}</span> : null}
        {pushed ? <span className="kb-git__chip-note">{t(pushed === 'unpushed' ? 'git.unpushed' : 'git.pushed')}</span> : null}
      </span>
      <span className="kb-git__chip">
        <span className="kb-git__chip-label">{t('git.worktree')}</span>
        <code className="kb-git__chip-value" title={current.worktree}>
          {worktreeName}
        </code>
      </span>
      {upstream ? (
        <span className="kb-git__chip">
          <span className="kb-git__chip-label">{t('git.remote')}</span>
          <code className="kb-git__chip-value" title={upstream.ref}>
            {upstream.ref}
          </code>
          <AheadBehind ahead={upstream.ahead} behind={upstream.behind} />
        </span>
      ) : (
        <span className="kb-git__chip kb-git__chip--muted">
          <span className="kb-git__chip-label">{t('git.remote')}</span>
          <span className="kb-git__chip-note">{t('git.noUpstream')}</span>
        </span>
      )}
      {base && !relationIsUpstream ? (
        <span className="kb-git__chip">
          <span className="kb-git__chip-label">{t('git.relation')}</span>
          <code className="kb-git__chip-value" title={base.label}>
            {base.label}
          </code>
          <AheadBehind ahead={base.ahead} behind={base.behind} />
        </span>
      ) : null}
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
      {truncated > 0 ? <p className="kb-git__more">{t('git.moreWorktrees', { count: truncated })}</p> : null}
    </div>
  );
}

/**
 * 「分支 / 工作树」区块：数据不可用 / 读取失败时返回 null（整块静默隐藏）。
 * 读取中同样不占位（git 探测通常 <150ms，避免骨架闪烁）。
 */
export function GitBranchSection({ card, sessions }: GitBranchSectionProps) {
  const { t } = useI18n();
  const { git } = useCardGit(card, sessions);
  const graph = useMemo(() => (git && git.available ? buildGitGraph(git) : null), [git]);
  if (!git || !git.available || !graph || graph.rows.length === 0) return null;
  return (
    <section className="kb-drawer__section kb-git">
      <h3 className="kb-drawer__section-title">{t('git.title')}</h3>
      <GitChips current={git.current} upstream={git.upstream} base={git.base} />
      <GitGraphView graph={graph} />
      {git.worktrees.length > 1 ? (
        <GitWorktrees worktrees={git.worktrees} truncated={git.worktreesTruncated ?? 0} base={git.base} />
      ) : null}
    </section>
  );
}
