/**
 * 「工作线」总览视图（v0.23.0，设计原型 design/branch-awareness/screens/v2-branch-overview.png）。
 *
 * 方案 2「工作线总览」：按「项目 / 仓库」两级分组，组内每条工作线一行，回答
 * 「现在有几条线在跑、各自到哪一步」：
 * - 第一层 = 仓库（卡片 cwd 推导出的 git 仓库；推不出仓库的卡片进「未指定」）；
 * - 第二层 = 工作线（= 一个工作副本 + 它检出的分支）；
 * - 行内：状态（进行中 / 已并入主线 / 停滞 / 无法判断）、相对主线多/少、线上同步状态、
 *   工作副本位置、关联卡片数、最近改动时间；
 * - 点一条工作线 → 看板只看这条线的卡片（App 切到看板并显示「只看工作线」提示条）。
 *
 * 数据全部复用 v0.16 `/git/workspaces`（仓库 / 工作副本 / 相对主线 / upstream）+
 * 卡片映射（`groupCardsByWorktree`，含 v0.21「按会话归属」兜底），**不新增卡片字段**。
 * 只读视图：不提供清理 / 改绑等写操作（那些在「工作区」视图与详情抽屉里）。
 */
import type { CSSProperties } from 'react';
import type { I18nKey, Lang } from '../i18n';
import { useI18n } from '../i18n';
import { shortenPath } from '../lib/forkGraph';
import { STATUS_TONE } from '../lib/status';
import { formatDateTime, formatRelative } from '../lib/time';
import {
  toWorklineSelection,
  worklineRelationText,
} from '../lib/worklineOverview';
import type {
  WorklineOverview,
  WorklineRelationText,
  WorklineRow,
  WorklineSelection,
  WorklineStatus,
  WorklineUnassignedCard,
  WorklineUnassignedReason,
} from '../lib/worklineOverview';

interface WorklineViewProps {
  /** 工作线总览数据（App 用全部未归档卡片 + /git/workspaces 结果构建） */
  overview: WorklineOverview;
  /** 服务端关闭 git 功能（/git/workspaces 返回 disabled） */
  disabled?: boolean;
  /** 至少完成过一次工作区探测（区分「读取中」与「确实为空」） */
  loaded?: boolean;
  /** 当前只看的工作线（选中行高亮） */
  selected?: WorklineSelection | null;
  /** 相对时间基准（App 的 15s 时钟）；缺省 Date.now() */
  now?: number;
  /** 点一条工作线：App 切到看板并只看这条线的卡片 */
  onSelectWorkline: (selection: WorklineSelection) => void;
  /** 点击「未指定」里的卡片打开详情 */
  onOpenCard: (cardId: string) => void;
}

/** 每仓库最多展示的工作副本数（服务端上限，契约 §12 v0.20）。 */
const WORKTREE_DISPLAY_LIMIT = 12;

/** 行状态 → 文案 key。 */
const STATUS_LABEL: Record<WorklineStatus, I18nKey> = {
  active: 'worklines.statusActive',
  merged: 'worklines.statusMerged',
  stalled: 'worklines.statusStalled',
  unknown: 'worklines.statusUnknown',
};

/** 行状态 → 一句话解释（badge title，帮非技术用户理解口径）。 */
const STATUS_HINT: Record<WorklineStatus, I18nKey> = {
  active: 'worklines.statusHintActive',
  merged: 'worklines.statusHintMerged',
  stalled: 'worklines.statusHintStalled',
  unknown: 'worklines.statusHintUnknown',
};

/** 「未指定」卡片原因 → 文案 key。 */
const UNASSIGNED_REASON: Record<WorklineUnassignedReason, I18nKey> = {
  no_cwd: 'worklines.unassignedReasonNoCwd',
  missing: 'worklines.unassignedReasonMissing',
  not_git: 'worklines.unassignedReasonNotGit',
  no_commits: 'worklines.unassignedReasonNoCommits',
  timeout: 'worklines.unassignedReasonTimeout',
  error: 'worklines.unassignedReasonError',
  forbidden: 'worklines.unassignedReasonForbidden',
};

/** 线上同步状态 → 文案 + 色调类（diverged 连续两条，用 · 连接）。 */
function remoteBadge(row: WorklineRow, t: ReturnType<typeof useI18n>['t']): { text: string; tone: string } {
  switch (row.remote) {
    case 'synced':
      return { text: t('workspace.remoteSynced'), tone: ' kb-worklines__badge--ok' };
    case 'no-upstream':
      return { text: t('workspace.remoteNone'), tone: '' };
    case 'unpushed':
      return { text: t('workspace.unpushed', { count: row.upstreamAhead }), tone: ' kb-worklines__badge--warn' };
    case 'behind':
      return { text: t('workspace.remoteBehind', { count: row.upstreamBehind }), tone: ' kb-worklines__badge--warn' };
    case 'diverged':
      return {
        text: `${t('workspace.unpushed', { count: row.upstreamAhead })} · ${t('workspace.remoteBehind', {
          count: row.upstreamBehind,
        })}`,
        tone: ' kb-worklines__badge--warn',
      };
    default:
      return { text: t('worklines.remoteUnknown'), tone: ' kb-worklines__badge--muted' };
  }
}

/** 一行工作线（整行 button：点它 = 只看这条线的卡片，键盘 Enter/Space 同样可用）。 */
function WorklineRowView({
  row,
  selected,
  now,
  onSelect,
}: {
  row: WorklineRow;
  selected: boolean;
  now: number;
  onSelect: (row: WorklineRow) => void;
}) {
  const { t, lang } = useI18n();
  const name = row.branch ?? t('worklines.detached');
  const relation: WorklineRelationText = worklineRelationText(row);
  // 目录已失效 / 算不出状态时不展示线上结论（原型里这一格是「—」，不谎报）
  const remote =
    row.status === 'unknown'
      ? { text: '—', tone: ' kb-worklines__badge--muted' }
      : remoteBadge(row, t);
  const remoteTitle = row.status === 'unknown' ? t('worklines.statusHintUnknown') : undefined;
  const lastActivity = row.lastActivityAt;
  const lastActivityText = lastActivity === null ? null : formatRelative(lastActivity, now, lang as Lang);
  const lastActivityTitle = lastActivity === null ? undefined : formatDateTime(lastActivity, lang as Lang);
  return (
    <li className="kb-worklines__item">
      <button
        type="button"
        className={`kb-worklines__row${selected ? ' kb-worklines__row--selected' : ''}`}
        aria-pressed={selected}
        aria-label={t('worklines.select', { name })}
        title={row.path}
        onClick={() => onSelect(row)}
      >
        <span
          className={`kb-worklines__dot kb-worklines__dot--${row.status}`}
          aria-hidden="true"
        />
        <span className="kb-worklines__main">
          <span className="kb-worklines__name-line">
            <code className="kb-worklines__name" title={row.branch ?? row.path}>
              {name}
            </code>
            {selected ? <span className="kb-tag kb-worklines__selected-tag">{t('worklines.selected')}</span> : null}
          </span>
          <span className="kb-worklines__meta">
            <span>{t('worklines.cardCount', { count: row.cards.length })}</span>
            {row.runningCardCount > 0 ? (
              <span className="kb-worklines__running">{t('worklines.runningCards', { count: row.runningCardCount })}</span>
            ) : null}
            {row.dirty ? <span className="kb-worklines__dirty">{t('worklines.dirty')}</span> : null}
            {lastActivityText ? (
              <span className="kb-worklines__last" title={lastActivityTitle}>
                {t('worklines.lastActivity', { when: lastActivityText })}
              </span>
            ) : null}
          </span>
        </span>
        <span
          className={`kb-worklines__badge kb-worklines__badge--status kb-worklines__badge--${row.status}`}
          title={t(STATUS_HINT[row.status])}
        >
          {t(STATUS_LABEL[row.status])}
        </span>
        <span className="kb-worklines__relation">
          {row.percent === null ? (
            <span className="kb-worklines__bar" aria-hidden="true">
              {/* 进度用 CSS 变量传 0–1，让填充块走 scaleX（GPU 属性）而不是过渡 width（A-07） */}
              <i
                className="kb-worklines__bar-fill kb-worklines__bar-fill--unknown"
                style={{ '--kb-worklines-progress': 0 } as CSSProperties}
              />
            </span>
          ) : (
            <span className="kb-worklines__bar" aria-hidden="true">
              <i
                className={`kb-worklines__bar-fill kb-worklines__bar-fill--${row.status}`}
                style={{ '--kb-worklines-progress': row.percent / 100 } as CSSProperties}
              />
            </span>
          )}
          <span className="kb-worklines__relation-text">{t(relation.key, relation.params)}</span>
        </span>
        <span className={`kb-worklines__badge kb-worklines__badge--remote${remote.tone}`} title={remoteTitle}>
          {remote.text}
        </span>
        <span className="kb-worklines__location">{row.location}</span>
      </button>
    </li>
  );
}

/** 一个仓库块：组头（仓库名 / 路径 / 工作线数 / 进行中卡片数 / 项目）+ 工作线行。 */
function RepoGroupView({
  group,
  selectedKey,
  now,
  onSelect,
}: {
  group: WorklineOverview['repos'][number];
  selectedKey: string | null;
  now: number;
  onSelect: (row: WorklineRow) => void;
}) {
  const { t } = useI18n();
  const truncated = group.truncatedWorktrees;
  return (
    <section className="kb-worklines__repo" aria-label={group.name}>
      <header className="kb-worklines__repo-head">
        <span className="kb-worklines__repo-icon" aria-hidden="true" />
        <span className="kb-worklines__repo-name" role="heading" aria-level={2} title={group.root}>
          {group.name}
        </span>
        <span className="kb-worklines__repo-meta">
          {t('worklines.repoMeta', {
            path: shortenPath(group.root, 2),
            worklines: group.worklines.length,
            running: group.runningCardCount,
          })}
        </span>
        {group.projects.length ? (
          <span className="kb-worklines__repo-projects" title={group.projects.join(' · ')}>
            {t('worklines.repoProjects', { projects: group.projects.join(' · ') })}
          </span>
        ) : null}
        {truncated > 0 ? (
          <span className="kb-worklines__truncated">
            {t('worklines.truncated', { count: truncated, limit: WORKTREE_DISPLAY_LIMIT })}
          </span>
        ) : null}
      </header>
      <ul className="kb-worklines__rows">
        {group.worklines.map((row) => (
          <WorklineRowView
            key={row.key}
            row={row}
            selected={selectedKey === row.key}
            now={now}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

/** 「未指定」块：无 cwd / 目录不可用 / 没匹配到工作副本的卡片（只读，点开详情）。 */
function UnassignedSection({
  cards,
  onOpenCard,
}: {
  cards: WorklineUnassignedCard[];
  onOpenCard: (cardId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="kb-worklines__repo kb-worklines__repo--unassigned" aria-label={t('worklines.unassigned')}>
      <header className="kb-worklines__repo-head">
        <span className="kb-worklines__repo-icon kb-worklines__repo-icon--muted" aria-hidden="true" />
        <span className="kb-worklines__repo-name" role="heading" aria-level={2}>
          {t('worklines.unassigned')}
        </span>
        <span className="kb-worklines__repo-meta">{t('worklines.cardCount', { count: cards.length })}</span>
      </header>
      <div className="kb-worklines__unassigned">
        <p className="kb-worklines__hint">{t('worklines.unassignedHint')}</p>
        <ul className="kb-worklines__unassigned-list">
          {cards.map(({ card, reason }) => (
            <li className="kb-worklines__unassigned-item" key={card.id}>
              <button
                type="button"
                className="kb-worklines__unassigned-card"
                title={card.title}
                aria-label={t('workspace.openCard', { title: card.title })}
                onClick={() => onOpenCard(card.id)}
              >
                <span className={`kb-dot kb-dot--${STATUS_TONE[card.status]}`} aria-hidden="true" />
                <span className="kb-worklines__unassigned-title">{card.title}</span>
                <span className="kb-tag kb-worklines__unassigned-reason">{t(UNASSIGNED_REASON[reason])}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * 「只看工作线」提示条（App 在选了一条工作线后显示在视图上方）：
 * 文案 + 清空按钮；让「为什么卡片变少了」始终可见、一键恢复。
 */
export function WorklineFilterBar({
  selection,
  cardCount,
  onClear,
}: {
  selection: WorklineSelection;
  cardCount: number;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="kb-worklines-filter" role="status">
      <span className="kb-worklines-filter__text">
        {t('worklines.filterActive', { name: selection.label, count: cardCount })}
      </span>
      <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={onClear}>
        {t('worklines.filterClear')}
      </button>
    </div>
  );
}

/** 「工作线」总览视图：摘要 + 仓库块 + 未指定块；只读，点行去看板。 */
export function WorklineView({
  overview,
  disabled = false,
  loaded = false,
  selected,
  now,
  onSelectWorkline,
  onOpenCard,
}: WorklineViewProps) {
  const { t } = useI18n();
  const nowValue = now ?? Date.now();
  const selectedKey = selected
    ? `${selected.repoRoot.replace(/\/+$/, '')}\u0000${selected.worktreePath.replace(/\/+$/, '')}`
    : null;

  if (disabled) {
    return (
      <div className="kb-worklines" role="region" aria-label={t('app.viewWorklines')}>
        <p className="kb-worklines__empty">{t('worklines.disabled')}</p>
      </div>
    );
  }
  if (!overview.cardCount) {
    return (
      <div className="kb-worklines" role="region" aria-label={t('app.viewWorklines')}>
        <p className="kb-worklines__empty">{t('worklines.empty')}</p>
      </div>
    );
  }
  if (!loaded && !overview.repos.length) {
    return (
      <div className="kb-worklines" role="region" aria-label={t('app.viewWorklines')}>
        <p className="kb-worklines__empty">{t('worklines.loading')}</p>
      </div>
    );
  }

  const summary = t('worklines.summary', {
    repos: overview.repoCount,
    worklines: overview.worklineCount,
    active: overview.activeCount,
  });

  return (
    <div className="kb-worklines" role="region" aria-label={t('app.viewWorklines')}>
      <header className="kb-worklines__summary">
        <span className="kb-worklines__summary-text">{summary}</span>
      </header>
      {!overview.repos.length && overview.cardCount > 0 ? (
        <p className="kb-worklines__hint">{t('worklines.noReposHint')}</p>
      ) : null}
      {overview.repos.map((group) => (
        <RepoGroupView
          key={group.key}
          group={group}
          selectedKey={selectedKey}
          now={nowValue}
          onSelect={(row) => onSelectWorkline(toWorklineSelection(row))}
        />
      ))}
      {overview.unassigned.length ? (
        <UnassignedSection cards={overview.unassigned} onOpenCard={onOpenCard} />
      ) : null}
    </div>
  );
}
