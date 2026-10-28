/**
 * Fork 风格多分支提交图（只读展示，docs/contracts/06-git-context.md §5）。
 *
 * - 顶部引用图例：每个 ref 一枚彩色圆点 + 名称；本地分支带 ↑N ↓M、「当前」/「工作树」徽标；
 *   远端引用用空心点；tip 被截断的 ref 只出现在图例里。
 * - 主体：固定最大高度、内部滚动的多泳道提交图；行高 22、列宽 14（泳道 > 8 时 12）。
 *   每行先画连线（同泳道竖直、跨泳道平滑三次贝塞尔），再画圆点
 *   （合并提交双环、HEAD 加深外环），右侧 ref 徽标 + subject 单行省略 + 短 sha。
 * - 纯展示：不可点击、无展开；完整 sha / 作者 / 时间放原生 title。
 */
import { useI18n } from '../i18n';
import type { ForkGraphLayout, ForkGraphRefInfo, ForkGraphRow, ForkGraphSegment } from '../lib/forkGraph';
import { FORK_GRAPH_COMPACT_LANE_COUNT } from '../lib/forkGraph';
import { formatDateTime } from '../lib/time';

/** 与 drawer.css 的 .kb-git__fork-row / .kb-git__fork-svg 尺寸保持一致。 */
const ROW_HEIGHT = 22;
const DOT_Y = 11;
const LANE_WIDTH = 14;
const LANE_WIDTH_COMPACT = 12;
/** 图列左右各留 2px，避免 HEAD 外环/出弯曲线被行容器裁掉 */
const GRAPH_PADDING = 2;
const MERGE_RING_RADIUS = 4.8;
const MERGE_CORE_RADIUS = 2.2;
const DOT_RADIUS = 4;
const HEAD_RING_RADIUS = 7;

interface AheadBehindProps {
  ahead: number;
  behind: number;
}

/** 「↑N ↓M」：可见部分是 Git 习惯写法，读屏播报走 i18n 的领先/落后。 */
export function AheadBehind({ ahead, behind }: AheadBehindProps) {
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

function laneWidthFor(laneCount: number): number {
  return laneCount > FORK_GRAPH_COMPACT_LANE_COUNT ? LANE_WIDTH_COMPACT : LANE_WIDTH;
}

function laneX(lane: number, width: number): number {
  return lane * width + width / 2 + GRAPH_PADDING;
}

/** 行内连线路径：同泳道直线；跨泳道用平滑三次贝塞尔（汇入时竖直起、水平收进圆点；出弯时水平离开圆点、竖直向下）。 */
function segmentPath(segment: ForkGraphSegment, width: number): string {
  const x1 = laneX(segment.fromLane, width);
  const x2 = laneX(segment.toLane, width);
  const y1 = segment.fromY === 'top' ? 0 : DOT_Y;
  if (segment.fromLane === segment.toLane) return `M ${x1} ${y1} L ${x1} ${segment.toY === 'bottom' ? ROW_HEIGHT : DOT_Y}`;
  if (segment.toY === 'dot') {
    return `M ${x1} 0 C ${x1} ${DOT_Y * 0.6}, ${x2} ${DOT_Y}, ${x2} ${DOT_Y}`;
  }
  const tail = ROW_HEIGHT - DOT_Y;
  return `M ${x1} ${DOT_Y} C ${x1 + (x2 - x1) * 0.4} ${DOT_Y}, ${x2} ${DOT_Y + tail * 0.6}, ${x2} ${ROW_HEIGHT}`;
}

interface ForkRefBadgeProps {
  /** 用 graphRef 而不是 ref：ref 是 React 保留 prop，函数组件拿不到 */
  graphRef: ForkGraphRefInfo;
}

/** 行内 ref 徽标：HEAD 深色底、远端引用描边、本地分支实心彩点 + 名称。 */
function ForkRefBadge({ graphRef }: ForkRefBadgeProps) {
  const { t } = useI18n();
  if (graphRef.kind === 'head') {
    return (
      <span className="kb-git__fork-ref kb-git__fork-ref--head" title={graphRef.name}>
        {graphRef.name}
      </span>
    );
  }
  return (
    <span
      className={`kb-git__fork-ref${graphRef.kind === 'remote' ? ' kb-git__fork-ref--remote' : ''}`}
      title={graphRef.name}
    >
      <span
        className={`kb-git__fork-ref-dot kb-git__fork-c${graphRef.color}${
          graphRef.kind === 'remote' ? ' kb-git__fork-ref-dot--hollow' : ''
        }`}
        aria-hidden="true"
      />
      {graphRef.kind === 'remote' ? <span className="kb-git__sr">{t('git.remote')}</span> : null}
      <code className="kb-git__fork-ref-name">{graphRef.name}</code>
    </span>
  );
}

interface ForkGraphRowViewProps {
  row: ForkGraphRow;
  width: number;
  graphWidth: number;
}

function ForkGraphRowView({ row, width, graphWidth }: ForkGraphRowViewProps) {
  const { t, lang } = useI18n();
  const commit = row.commit;
  const dotX = laneX(row.dot.lane, width);
  const detailTitle = `${commit.sha}\n${commit.authorName}\n${formatDateTime(commit.committedAt, lang)}`;
  return (
    <li className="kb-git__fork-row">
      <span className="kb-git__fork-graph" style={{ width: graphWidth }}>
        <svg
          className="kb-git__fork-svg"
          width={graphWidth}
          height={ROW_HEIGHT}
          viewBox={`0 0 ${graphWidth} ${ROW_HEIGHT}`}
          aria-hidden="true"
          focusable="false"
        >
          {row.segments.map((segment, index) => (
            <path
              key={`segment-${index}`}
              className={`kb-git__fork-seg kb-git__fork-c${segment.color}`}
              d={segmentPath(segment, width)}
            />
          ))}
          {row.dot.isHead ? (
            <circle className="kb-git__fork-head-ring" cx={dotX} cy={DOT_Y} r={HEAD_RING_RADIUS} />
          ) : null}
          {row.dot.isMerge ? (
            <>
              <circle
                className={`kb-git__fork-merge-ring kb-git__fork-c${row.dot.color}`}
                cx={dotX}
                cy={DOT_Y}
                r={MERGE_RING_RADIUS}
              />
              <circle
                className={`kb-git__fork-dot kb-git__fork-c${row.dot.color}`}
                cx={dotX}
                cy={DOT_Y}
                r={MERGE_CORE_RADIUS}
              />
            </>
          ) : (
            <circle className={`kb-git__fork-dot kb-git__fork-c${row.dot.color}`} cx={dotX} cy={DOT_Y} r={DOT_RADIUS} />
          )}
        </svg>
      </span>
      {row.refs.length ? (
        <span className="kb-git__fork-refs">
          {row.refs.map((item) => (
            <ForkRefBadge key={`${item.kind}:${item.name}`} graphRef={item} />
          ))}
        </span>
      ) : null}
      <span className="kb-git__fork-subject" title={commit.subject || undefined}>
        {commit.subject || '—'}
      </span>
      {row.dot.isMerge ? <span className="kb-git__sr">{t('git.mergeCommit')}</span> : null}
      <code className="kb-git__fork-sha" title={detailTitle}>
        {commit.shortSha}
      </code>
    </li>
  );
}

interface ForkGraphProps {
  layout: ForkGraphLayout;
  /** 工作树当前检出的分支名（图例里给「工作树」徽标） */
  worktreeBranches: ReadonlySet<string>;
}

/** 引用图例 + Fork 风格多泳道提交图 + 截断提示。 */
export function ForkGraph({ layout, worktreeBranches }: ForkGraphProps) {
  const { t } = useI18n();
  const width = laneWidthFor(layout.laneCount);
  const graphWidth = layout.laneCount * width + GRAPH_PADDING * 2;
  return (
    <div className="kb-git__fork">
      <div className="kb-git__fork-legend" role="list" aria-label={t('git.legendLabel')}>
        {layout.refs.map((ref) => (
          <span className="kb-git__fork-legend-item" role="listitem" key={`${ref.kind}:${ref.name}`}>
            <span
              className={`kb-git__fork-legend-dot kb-git__fork-c${ref.color}${
                ref.kind === 'remote' ? ' kb-git__fork-legend-dot--hollow' : ''
              }`}
              aria-hidden="true"
            />
            <code className="kb-git__fork-legend-name" title={ref.name}>
              {ref.name}
            </code>
            {ref.kind === 'branch' && typeof ref.ahead === 'number' && typeof ref.behind === 'number' ? (
              <AheadBehind ahead={ref.ahead} behind={ref.behind} />
            ) : null}
            {ref.kind === 'branch' && ref.isCurrent ? (
              <span className="kb-git__tag kb-git__tag--current">{t('git.current')}</span>
            ) : null}
            {ref.kind === 'branch' && worktreeBranches.has(ref.name) ? (
              <span className="kb-git__tag">{t('git.worktree')}</span>
            ) : null}
          </span>
        ))}
        {layout.refsTruncated > 0 ? (
          <span className="kb-git__fork-legend-more">{t('git.moreRefs', { count: layout.refsTruncated })}</span>
        ) : null}
      </div>
      <div className="kb-git__fork-scroll" role="group" aria-label={t('git.graphLabel')}>
        <ol
          className="kb-git__fork-rows"
          aria-label={t('git.graphAria', { commits: layout.rows.length, refs: layout.refs.length })}
        >
          {layout.rows.map((row) => (
            <ForkGraphRowView key={row.commit.sha} row={row} width={width} graphWidth={graphWidth} />
          ))}
        </ol>
      </div>
      {layout.truncated > 0 ? (
        <p className="kb-git__fork-more">{t('git.graphTruncated', { count: layout.rows.length })}</p>
      ) : null}
    </div>
  );
}
