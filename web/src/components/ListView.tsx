import { useMemo, useState } from 'react';
import type { Card, ColumnId } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import type { Board } from '../types';
import { COLUMNS } from '../lib/status';
import { elapsedMs, formatDuration, formatDateTime } from '../lib/time';
import {
  DONE_LIST_LIMIT,
  LIST_GROUP_BY_OPTIONS,
  groupCardsForList,
} from '../lib/listGroups';
import type { ListGroupBy } from '../lib/listGroups';
import type { CardActionHandlers, CardViewShared } from './types';
import type { WorklineStatus } from '../lib/worklineSummary';
import type { WorklineStatusMap } from '../lib/useWorklineStatuses';
import { EmptyState } from './feedback';
import { WorklineBadge } from './WorklineBadge';
import { CardRelationBadges } from './CardRelations';
import { AgentBadge } from './AgentBadge';
import { isExternalCardAgent } from '../lib/agentBadge';
import { ArchiveBox } from './ArchiveBox';
import type { ArchiveBoxProps } from './ArchiveBox';
import { ApprovalPanel } from './ApprovalPanel';
import { ApprovalSlot } from './ApprovalSlot';
// 展开区挂载外壳与看板卡片共用（同一套语感）；实现放 KanbanCard.tsx 是为了不新增文件。
import { useExpandedPresence } from './KanbanCard';
import { NativeInbox } from './NativeInbox';
import type { NativeInboxProps } from './NativeInbox';
import { MenuButton } from './MenuButton';
import type { MenuEntry } from './MenuButton';
import { Timeline } from './Timeline';
import {
  IconArchive,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconEdit,
  IconMore,
  IconMove,
  IconOpen,
  IconRedo,
  IconSearch,
  IconWrench,
} from './Icons';

interface ListViewProps {
  cards: Card[];
  cardOrder: Board['cardOrder'];
  groupBy: ListGroupBy;
  onGroupByChange: (groupBy: ListGroupBy) => void;
  doneOpen: boolean;
  onDoneOpenChange: (open: boolean) => void;
  shared: CardViewShared;
  actions: CardActionHandlers;
  /** cwd → 工作线状态（列表行「工作线」徽标） */
  worklineStatuses: WorklineStatusMap;
  filtering: boolean;
  onClearFilters: () => void;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelection: (cardId: string) => void;
  highlightedCardId: string | null;
  /** 原生待确认收件（工具授权 / Agent 提问 / 计划审批） */
  nativeInbox: NativeInboxProps;
  /** v0.22 底部「归档箱」（无归档卡时不渲染） */
  archiveBox: ArchiveBoxProps;
}

const COLUMN_TONE: Record<ColumnId, string> = {
  backlog: 'tertiary',
  running: 'business',
  needs_you: 'warn',
  done: 'success',
};

/** 列表视图：按状态/项目分组；done 分组默认折叠并可加载更多。 */
export function ListView({
  cards,
  cardOrder,
  groupBy,
  onGroupByChange,
  doneOpen,
  onDoneOpenChange,
  shared,
  actions,
  worklineStatuses,
  filtering,
  onClearFilters,
  selectionMode,
  selectedIds,
  onToggleSelection,
  highlightedCardId,
  nativeInbox,
  archiveBox,
}: ListViewProps) {
  const { t } = useI18n();
  const [doneVisible, setDoneVisible] = useState(DONE_LIST_LIMIT);
  const groups = useMemo(() => groupCardsForList(cards, groupBy, cardOrder), [cards, groupBy, cardOrder]);
  /**
   * A-12：全局无结果（筛选/搜索后所有分组都空、也没有宿主待确认项）时，只在列表顶部出现
   * 一个全局空态 + 一个清空入口；分组头保留，组内退化成一行「无匹配卡片」提示。
   */
  const noResults = filtering && cards.length === 0 && nativeInbox.entries.length === 0;

  const groupLabel = (group: (typeof groups)[number]): string => {
    if (group.label.startsWith('column.')) return t(group.label as I18nKey);
    return group.label || t('list.noProject');
  };

  return (
    <div className="kb-list" role="region" aria-label={t('app.viewList')}>
      <div className="kb-list__toolbar">
        <span className="kb-list__groupby-label">{t('list.groupBy')}</span>
        <div className="kb-seg" role="group" aria-label={t('list.groupBy')}>
          {LIST_GROUP_BY_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={`kb-seg-btn${groupBy === option ? ' kb-seg-btn--active' : ''}`}
              aria-pressed={groupBy === option}
              onClick={() => onGroupByChange(option)}
            >
              {option === 'status' ? t('list.groupStatus') : t('list.groupProject')}
            </button>
          ))}
        </div>
        <span className="kb-list__count">{t('app.cardCount', { count: cards.length })}</span>
      </div>

      {noResults ? (
        <div className="kb-global-empty">
          <EmptyState
            title={t('empty.filtered')}
            hint={t('empty.filteredHint')}
            actionLabel={t('app.clearFilters')}
            onAction={onClearFilters}
          />
        </div>
      ) : null}

      {groupBy !== 'status' && nativeInbox.entries.length ? (
        <div className="kb-list__inbox">
          <NativeInbox {...nativeInbox} />
        </div>
      ) : null}

      {groups.map((group) => {
        const isDoneStatus = groupBy === 'status' && group.key === 'status:done';
        const collapsed = isDoneStatus && !doneOpen;
        const visible = isDoneStatus ? group.cards.slice(0, doneVisible) : group.cards;
        const hidden = isDoneStatus ? Math.max(0, group.count - visible.length) : 0;
        return (
          <section
            className={`kb-list__group${collapsed ? ' kb-list__group--collapsed' : ''}`}
            key={group.key}
            aria-label={`${groupLabel(group)} ${group.count}`}
          >
            <header className="kb-list__group-head">
              {group.column ? (
                <span className={`kb-dot kb-dot--${COLUMN_TONE[group.column]}`} aria-hidden="true" />
              ) : (
                <span className="kb-dot kb-dot--tertiary" aria-hidden="true" />
              )}
              <h2 className="kb-list__group-title">{groupLabel(group)}</h2>
              <span className="kb-pill kb-pill--count">{group.count}</span>
              {isDoneStatus ? (
                <button
                  type="button"
                  className="kb-btn kb-btn--sm kb-btn--ghost kb-list__group-toggle"
                  aria-expanded={doneOpen}
                  onClick={() => onDoneOpenChange(!doneOpen)}
                >
                  <span className={`kb-icon kb-list__chevron${doneOpen ? ' kb-list__chevron--open' : ''}`} aria-hidden="true">
                    <IconChevronRight />
                  </span>
                  {doneOpen ? t('list.hideDone') : t('list.showDone', { count: group.count })}
                </button>
              ) : null}
            </header>

            {collapsed ? null : (
              <>
                {groupBy === 'status' && group.key === 'status:needs_you' ? (
                  <div className="kb-list__inbox">
                    <NativeInbox {...nativeInbox} />
                  </div>
                ) : null}
                {group.count === 0 ? (
                  filtering ? (
                    // A-12：局部空态只留一行紧凑提示、不带 CTA；清空入口只在全局空态出现一次。
                    <div className="kb-list__filter-hint">{t('empty.noMatchShort')}</div>
                  ) : (
                    <div className="kb-list__empty">{t('column.empty')}</div>
                  )
                ) : (
                  <>
                    <ul className="kb-list__items">
                      {visible.map((card) => (
                        <ListRow
                          key={card.id}
                          card={card}
                          shared={shared}
                          actions={actions}
                          selectionMode={selectionMode}
                          selectionSelected={selectedIds.has(card.id)}
                          worklineStatus={card.cwd?.trim() ? worklineStatuses[card.cwd.trim()] : undefined}
                          onToggleSelection={onToggleSelection}
                          highlighted={highlightedCardId === card.id}
                        />
                      ))}
                    </ul>
                    {isDoneStatus && hidden > 0 ? (
                      <div className="kb-list__more">
                        <button
                          type="button"
                          className="kb-btn kb-btn--sm kb-btn--ghost"
                          onClick={() => setDoneVisible((current) => current + DONE_LIST_LIMIT)}
                        >
                          {t('list.loadMoreCount', { count: hidden })}
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </>
            )}
          </section>
        );
      })}
      <ArchiveBox {...archiveBox} />
    </div>
  );
}

function ListRow({
  card,
  shared,
  actions,
  selectionMode,
  selectionSelected,
  worklineStatus,
  onToggleSelection,
  highlighted = false,
}: {
  card: Card;
  shared: CardViewShared;
  actions: CardActionHandlers;
  selectionMode: boolean;
  selectionSelected: boolean;
  /** 工作线徽标状态：undefined=未就绪，null=探测失败（未知） */
  worklineStatus?: WorklineStatus | null;
  onToggleSelection: (cardId: string) => void;
  highlighted?: boolean;
}) {
  const { t, lang } = useI18n();
  const expanded = shared.expandedIds.has(card.id);
  const expand = useExpandedPresence(expanded);
  const statusKey = `status.${card.status}` as I18nKey;
  const tone =
    card.status === 'done'
      ? 'success'
      : card.status === 'running'
        ? 'business'
        : card.status === 'blocked' || card.status === 'failed'
          ? 'error'
          : card.status === 'needs_you'
            ? 'warn'
            : 'tertiary';
  const elapsed = elapsedMs(card, shared.now);
  const pendingApproval = card.approvals.find((approval) => approval.status === 'pending');
  const resolvedApproval = pendingApproval
    ? undefined
    : [...card.approvals].reverse().find((approval) => approval.status !== 'pending');
  const feed = shared.feeds[card.id];
  const timeline = (feed?.items ?? []).slice(0, 5);

  const items: MenuEntry[] = [
    { id: 'open', label: t('card.openDetail'), icon: <IconOpen /> },
    { id: 'edit', label: t('card.edit'), icon: <IconEdit /> },
    ...COLUMNS.map((target, index) => ({
      id: `move:${target}`,
      label: `${t('card.moveTo')} · ${t(`column.${target}` as I18nKey)}`,
      icon: <IconMove />,
      checked: card.status === target,
      disabled: card.status === target,
      separatorBefore: index === 0,
    })),
    ...(card.status === 'done' || card.status === 'canceled'
      ? [{ id: 'reopen', label: t('card.reopen'), icon: <IconRedo /> }]
      : []),
    { id: 'archive', label: t('card.archive'), icon: <IconArchive />, danger: true, separatorBefore: true },
  ];

  return (
    <li
      className={`kb-list__item${expanded ? ' kb-list__item--expanded' : ''}${
        selectionMode ? ' kb-list__item--selectable' : ''
      }${selectionSelected ? ' kb-list__item--selected' : ''}${highlighted ? ' kb-list__item--highlight' : ''}`}
      data-card-id={card.id}
      data-status={card.status}
      tabIndex={0}
      role="group"
      aria-label={t('a11y.cardLabel', { title: card.title, status: t(statusKey) })}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, textarea, select, label')) return;
        // 拖选文字时不误触发
        if (window.getSelection()?.toString()) return;
        if (selectionMode) {
          onToggleSelection(card.id);
          return;
        }
        // 展开区内部点击不折叠，避免阅读/作答时误触
        if (target.closest('.kb-list__expanded')) return;
        actions.onToggleExpanded(card.id);
      }}
      onDoubleClick={(event) => {
        if (selectionMode) return;
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, textarea, select, label')) return;
        actions.onOpenDetail(card.id);
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button, input, textarea, select, a')) return;
        if (selectionMode) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleSelection(card.id);
          }
          return;
        }
        // 与看板卡一致：Enter / Space 展开收起，O 打开详情
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          actions.onToggleExpanded(card.id);
        } else if (event.key.toLowerCase() === 'o') {
          event.preventDefault();
          actions.onOpenDetail(card.id);
        }
      }}
    >
      <div className="kb-list__row">
        {selectionMode ? (
          <label className="kb-list__check" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              checked={selectionSelected}
              aria-label={t(selectionSelected ? 'selection.deselectCard' : 'selection.selectCard', {
                title: card.title,
              })}
              onChange={() => onToggleSelection(card.id)}
            />
          </label>
        ) : null}
        <div className="kb-list__main">
          <button
            type="button"
            className="kb-list__title"
            aria-expanded={expanded}
            aria-controls={`kb-list-exp-${card.id}`}
            aria-label={`${t(expanded ? 'list.collapseRow' : 'list.expandRow')}：${card.title}`}
            onClick={() => (selectionMode ? onToggleSelection(card.id) : actions.onToggleExpanded(card.id))}
          >
            <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
            <span className="kb-list__title-text">{card.title}</span>
          </button>
          {/* A-15：状态只在「标题左侧 dot + 本行状态词」出现一次；项目/标签留在 summary 行，
              时间/搜索/工具留在右侧 meta；不要把这套信息搬进标题行，行高不增加。 */}
          <div className="kb-list__summary-line">
            <span className="kb-list__summary">{card.summary || t('card.summaryFallback')}</span>
            <span className="kb-list__status-line">
              <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
              {t(statusKey)}
              {card.project ? <span className="kb-list__project"> · {card.project}</span> : null}
            </span>
          </div>
        </div>
        <span className="kb-list__row-meta">
          {elapsed > 0 ? (
            <span title={t('card.elapsed')}>
              <span className="kb-icon" aria-hidden="true">
                <IconClock />
              </span>
              {formatDuration(elapsed, lang)}
            </span>
          ) : null}
          <span title={t('card.searches')}>
            <span className="kb-icon" aria-hidden="true">
              <IconSearch />
            </span>
            {card.metadata.searches}
          </span>
          <span title={t('card.tools')}>
            <span className="kb-icon" aria-hidden="true">
              <IconWrench />
            </span>
            {card.metadata.toolCalls}
          </span>
          <AgentBadge agent={card.agent} compact />
          {card.handoff ? (
            <span
              className="kb-tag kb-tag--handoff"
              title={t('handoff.badgeAria', { date: formatDateTime(card.handoff.at, lang) })}
              aria-label={t('handoff.badgeAria', { date: formatDateTime(card.handoff.at, lang) })}
            >
              {t('handoff.badge')}
            </span>
          ) : null}
          <CardRelationBadges card={card} relations={shared.relations} parentClassName="kb-rel-parent--list" />
          {card.status === 'running' && !card.sessionIds.length && !isExternalCardAgent(card.agent) ? (
            <span className="kb-list__session-warn" title={t('drawer.runningNoSessionWarn')}>
              {t('card.noSessionWarn')}
            </span>
          ) : null}
          {pendingApproval ? <span className="kb-pill kb-pill--warn">{t('card.pendingApproval')}</span> : null}
          {!selectionMode ? (
            <>
              <button
                type="button"
                className="kb-btn kb-btn--icon kb-btn--sm kb-btn--ghost"
                aria-expanded={expanded}
                aria-controls={`kb-list-exp-${card.id}`}
                aria-label={expanded ? t('list.collapseRow') : t('list.expandRow')}
                onClick={() => actions.onToggleExpanded(card.id)}
              >
                <span className={`kb-icon kb-list__chevron${expanded ? ' kb-list__chevron--open' : ''}`} aria-hidden="true">
                  <IconChevronDown />
                </span>
              </button>
              <MenuButton
                label={t('a11y.cardActions')}
                trigger={<IconMore />}
                triggerClassName="kb-btn kb-btn--icon kb-btn--sm kb-btn--ghost"
                items={items}
                onSelect={(id) => {
                  if (id === 'open') actions.onOpenDetail(card.id);
                  else if (id === 'edit') actions.onEdit(card);
                  else if (id === 'archive') actions.onArchive(card);
                  else if (id === 'reopen') actions.onReopen(card);
                  else if (id.startsWith('move:')) {
                    const target = id.slice('move:'.length) as ColumnId;
                    if (COLUMNS.includes(target)) actions.onMove(card.id, target);
                  }
                }}
              />
            </>
          ) : null}
        </span>
      </div>

      <div className="kb-list__workline">
        <WorklineBadge cwd={card.cwd} status={worklineStatus} />
      </div>

      {expand.render && !selectionMode ? (
        <div
          className={`kb-list__expand${expand.revealed ? ' kb-list__expand--open' : ''}${
            expand.leaving ? ' kb-list__expand--leaving' : ''
          }`}
        >
          <div className="kb-list__expand__clip">
            <div className="kb-list__expanded" id={`kb-list-exp-${card.id}`}>
              {card.currentAction ? <p className="kb-list__action">{card.currentAction}</p> : null}
              {/* 交互式审批由 ApprovalSlot 负责离场（docs/11-motion.md §6.3）：不能再让 pendingApproval
                  条件包住它，否则审批一消失组件就被卸载，淡出帧丢失；只读历史视图保持原样。 */}
              <ApprovalSlot
                approval={pendingApproval ?? null}
                busy={pendingApproval ? shared.resolvingApprovalId === pendingApproval.id : false}
                now={shared.now}
                onResolve={(approval, submission, comment, decision) =>
                  actions.onResolveApproval(card, approval, submission, comment, decision)
                }
                onValidationError={(message) => actions.onNotify(message, 'error')}
              />
              {!pendingApproval && resolvedApproval ? (
                <ApprovalPanel approval={resolvedApproval} busy={false} now={shared.now} onResolve={() => undefined} />
              ) : null}
              <div className="kb-list__section">
                <h3 className="kb-list__section-title">{t('list.recentNodes')}</h3>
                <Timeline activities={timeline} now={shared.now} variant="compact" />
              </div>
              <div className="kb-list__actions">
                <button type="button" className="kb-btn kb-btn--sm kb-btn--outline" onClick={() => actions.onOpenDetail(card.id)}>
                  {t('card.openDetail')}
                  <span className="kb-icon" aria-hidden="true">
                    <IconChevronRight />
                  </span>
                </button>
                <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => actions.onEdit(card)}>
                  <span className="kb-icon" aria-hidden="true">
                    <IconEdit />
                  </span>
                  {t('card.edit')}
                </button>
                {card.status === 'failed' ? (
                  <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => actions.onRetry(card)}>
                    <span className="kb-icon" aria-hidden="true">
                      <IconRedo />
                    </span>
                    {t('card.retry')}
                  </button>
                ) : null}
                <button type="button" className="kb-btn kb-btn--sm kb-btn--danger" onClick={() => actions.onArchive(card)}>
                  <span className="kb-icon" aria-hidden="true">
                    <IconArchive />
                  </span>
                  {t('card.archive')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}
