import type { Card, ColumnId } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import type { ColumnGroups } from '../lib/grouping';
import { COLUMNS } from '../lib/status';
import { countByColumn } from '../lib/grouping';
import { elapsedMs, formatDuration } from '../lib/time';
import { cardTimeline } from '../lib/timeline';
import type { CardActionHandlers, CardViewShared } from './types';
import { ApprovalPanel } from './ApprovalPanel';
import { MenuButton } from './MenuButton';
import type { MenuEntry } from './MenuButton';
import { Timeline } from './Timeline';
import {
  IconArchive,
  IconChevronDown,
  IconClock,
  IconEdit,
  IconMore,
  IconMove,
  IconOpen,
  IconReply,
  IconSearch,
  IconWrench,
} from './Icons';

const COLUMN_TONE: Record<ColumnId, string> = {
  backlog: 'tertiary',
  running: 'business',
  needs_you: 'warn',
  done: 'success',
};

interface ListViewProps {
  groups: ColumnGroups;
  cards: Card[];
  shared: CardViewShared;
  actions: CardActionHandlers;
  onCreateInColumn: (column: ColumnId) => void;
}

/** 列表视图：按列分组，行可展开看摘要 / 最近节点 / 审批 / 操作。 */
export function ListView({ groups, cards, shared, actions, onCreateInColumn }: ListViewProps) {
  const { t } = useI18n();
  const counts = countByColumn(cards);

  return (
    <div className="kb-list" role="region" aria-label={t('app.viewList')}>
      {COLUMNS.map((column) => (
        <section className="kb-list__group" key={column} aria-label={t('a11y.columnRegion', { column: t(`column.${column}` as I18nKey), count: counts[column] })}>
          <header className="kb-list__group-head">
            <span className={`kb-dot kb-dot--${COLUMN_TONE[column]}`} aria-hidden="true" />
            <h2 className="kb-list__group-title">{t(`column.${column}` as I18nKey)}</h2>
            <span className="kb-pill kb-pill--count">{counts[column]}</span>
            <button
              type="button"
              className="kb-btn kb-btn--sm kb-btn--ghost kb-list__group-add"
              onClick={() => onCreateInColumn(column)}
              aria-label={t('a11y.newCardInColumn', { column: t(`column.${column}` as I18nKey) })}
            >
              + {t('app.newCard')}
            </button>
          </header>
          {groups[column].length ? (
            <ul className="kb-list__items">
              {groups[column].map((card) => (
                <ListRow key={card.id} card={card} shared={shared} actions={actions} />
              ))}
            </ul>
          ) : (
            <div className="kb-list__empty">{t('column.empty')}</div>
          )}
        </section>
      ))}
    </div>
  );
}

function ListRow({
  card,
  shared,
  actions,
}: {
  card: Card;
  shared: CardViewShared;
  actions: CardActionHandlers;
}) {
  const { t, lang } = useI18n();
  const expanded = shared.expandedIds.has(card.id);
  const statusKey = `status.${card.status}` as I18nKey;
  const tone = card.status === 'done' ? 'success' : card.status === 'running' ? 'business' : card.status === 'blocked' || card.status === 'failed' ? 'error' : card.status === 'needs_you' ? 'warn' : 'tertiary';
  const elapsed = elapsedMs(card, shared.now);
  const pendingApproval = card.approvals.find((approval) => approval.status === 'pending');
  const timeline = cardTimeline(card, shared.activitiesByCard[card.id]).slice(0, 4);

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
    { id: 'archive', label: t('card.archive'), icon: <IconArchive />, danger: true, separatorBefore: true },
  ];

  return (
    <li className={`kb-list__item${expanded ? ' kb-list__item--expanded' : ''}`}>
      <div className="kb-list__row">
        <button
          type="button"
          className="kb-list__title"
          onClick={() => actions.onOpenDetail(card.id)}
          aria-label={`${t('card.openDetail')}：${card.title}`}
        >
          <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
          <span className="kb-list__title-text">{card.title}</span>
        </button>
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
          {pendingApproval ? <span className="kb-pill kb-pill--warn">{t('card.pendingApproval')}</span> : null}
          <button
            type="button"
            className="kb-btn kb-btn--icon kb-btn--sm kb-btn--ghost"
            aria-expanded={expanded}
            aria-label={expanded ? t('list.collapseRow') : t('list.expandRow')}
            onClick={() => actions.onToggleExpanded(card.id)}
          >
            <span className="kb-icon kb-list__chevron">
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
              else if (id.startsWith('move:')) {
                const target = id.slice('move:'.length) as ColumnId;
                if (COLUMNS.includes(target)) actions.onMove(card.id, target);
              }
            }}
          />
        </span>
      </div>

      <div className="kb-list__summary-line">
        <span className="kb-list__summary">{card.summary || t('card.summaryFallback')}</span>
        <span className="kb-list__status-line">
          <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
          {t(statusKey)}
          {card.project ? <span className="kb-list__project"> · {card.project}</span> : null}
          {card.labels.length ? (
            <span className="kb-list__labels">
              {card.labels.slice(0, 3).map((label) => (
                <span className="kb-tag" key={label}>
                  {label}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </div>

      {expanded ? (
        <div className="kb-list__expanded">
          {card.currentAction ? <p className="kb-list__action">{card.currentAction}</p> : null}
          {pendingApproval ? (
            <ApprovalPanel
              approval={pendingApproval}
              busy={shared.resolvingApprovalId === pendingApproval.id}
              now={shared.now}
              onResolve={(approval, option, comment, decision) =>
                actions.onResolveApproval(card, approval, option, comment, decision)
              }
            />
          ) : null}
          <div className="kb-list__section">
            <h3 className="kb-list__section-title">{t('list.recentNodes')}</h3>
            <Timeline activities={timeline} now={shared.now} variant="compact" />
          </div>
          <div className="kb-list__actions">
            <button type="button" className="kb-btn kb-btn--sm kb-btn--outline" onClick={() => actions.onOpenDetail(card.id)}>
              {t('card.openDetail')}
            </button>
            <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => actions.onOpenDetail(card.id)}>
              <span className="kb-icon" aria-hidden="true">
                <IconReply />
              </span>
              {t('card.reply')}
            </button>
            <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => actions.onEdit(card)}>
              <span className="kb-icon" aria-hidden="true">
                <IconEdit />
              </span>
              {t('card.edit')}
            </button>
            <button type="button" className="kb-btn kb-btn--sm kb-btn--danger" onClick={() => actions.onArchive(card)}>
              <span className="kb-icon" aria-hidden="true">
                <IconArchive />
              </span>
              {t('card.archive')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
