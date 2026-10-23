import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { Board, Card, ColumnId } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import type { ColumnGroups } from '../lib/grouping';
import { COLUMNS } from '../lib/status';
import { countByColumn, dropTarget } from '../lib/grouping';
import { DONE_PREVIEW_LIMIT } from '../lib/listGroups';
import { useBoardWheelScroll } from '../lib/useBoardWheelScroll';
import { KanbanCard } from './KanbanCard';
import type { CardActionHandlers, CardViewShared, Placement } from './types';
import { IconCheckCircle, IconChevronRight, IconCircle, IconHand, IconPlus, IconSparkle } from './Icons';

interface BoardViewProps {
  board: Board;
  groups: ColumnGroups;
  cards: Card[];
  /** 未筛选的已完成总数（用于「查看全部 N」） */
  doneTotal: number;
  shared: CardViewShared;
  actions: CardActionHandlers;
  mobile: boolean;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelection: (cardId: string) => void;
  highlightedCardId: string | null;
  activeColumn: ColumnId;
  onActiveColumnChange: (column: ColumnId) => void;
  onCreateInColumn: (column: ColumnId) => void;
  onMoveWithPlacement: (cardId: string, column: ColumnId, placement: Placement) => void;
  onViewAllDone: () => void;
  filtering: boolean;
  onClearFilters: () => void;
}

const COLUMN_TONE: Record<ColumnId, string> = {
  backlog: 'tertiary',
  running: 'business',
  needs_you: 'warn',
  done: 'success',
};

const COLUMN_EN: Record<ColumnId, string> = {
  backlog: 'BACKLOG',
  running: 'RUNNING',
  needs_you: 'NEEDS YOU',
  done: 'DONE',
};

function columnIcon(column: ColumnId) {
  if (column === 'running') return <IconSparkle />;
  if (column === 'needs_you') return <IconHand />;
  if (column === 'done') return <IconCheckCircle />;
  return <IconCircle />;
}

/** 看板视图：四列 / 竖屏单列 + 列分段；列内 + 新建；done 只展示最近 5 张。 */
export function BoardView({
  board,
  groups,
  cards,
  doneTotal,
  shared,
  actions,
  mobile,
  selectionMode,
  selectedIds,
  onToggleSelection,
  highlightedCardId,
  activeColumn,
  onActiveColumnChange,
  onCreateInColumn,
  onMoveWithPlacement,
  onViewAllDone,
  filtering,
  onClearFilters,
}: BoardViewProps) {
  const { t } = useI18n();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<ColumnId | null>(null);
  const [overCardId, setOverCardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<ColumnId>>(() => new Set());
  const dropHandled = useRef(false);
  const boardRef = useBoardWheelScroll();
  const counts = countByColumn(cards);

  const toggleCollapsed = (column: ColumnId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  };

  const resetDrag = () => {
    setDraggedId(null);
    setOverColumn(null);
    setOverCardId(null);
    dropHandled.current = false;
  };

  const handleDrop = (column: ColumnId, event: DragEvent<HTMLElement>) => {
    if (selectionMode) return;
    event.preventDefault();
    dropHandled.current = true;
    const cardId = draggedId ?? event.dataTransfer.getData('text/plain');
    if (cardId) {
      const ids = groups[column].map((card) => card.id);
      const targetId = overCardId && overCardId !== cardId ? overCardId : null;
      const placement = dropTarget(ids, cardId, targetId);
      onMoveWithPlacement(cardId, column, placement);
    }
    resetDrag();
  };

  const handleDragOverColumn = (column: ColumnId) => (event: DragEvent<HTMLElement>) => {
    if (selectionMode || !draggedId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (overColumn !== column) {
      setOverColumn(column);
      setOverCardId(null);
    }
  };

  const renderColumn = (column: ColumnId) => {
    const allColumnCards = groups[column];
    const isDone = column === 'done';
    const visibleCards = isDone ? allColumnCards.slice(0, DONE_PREVIEW_LIMIT) : allColumnCards;
    const isOver = overColumn === column && draggedId !== null;
    const isCollapsed = collapsed.has(column) && !mobile;
    const totalForColumn = isDone && !filtering ? doneTotal : allColumnCards.length;
    const hiddenDone = isDone ? Math.max(0, totalForColumn - visibleCards.length) : 0;

    return (
      <section
        key={column}
        className={`kb-column${isOver ? ' kb-column--over' : ''}${isCollapsed ? ' kb-column--collapsed' : ''}`}
        data-column={column}
        aria-label={t('a11y.columnRegion', { column: t(`column.${column}` as I18nKey), count: counts[column] })}
        onDragOver={handleDragOverColumn(column)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setOverColumn((current) => (current === column ? null : current));
            setOverCardId(null);
          }
        }}
        onDrop={(event) => handleDrop(column, event)}
      >
        <header className="kb-column-head">
          <span className={`kb-col-icon kb-col-icon--${COLUMN_TONE[column]}`} aria-hidden="true">
            {columnIcon(column)}
          </span>
          <h2 className="kb-column-title">
            {t(`column.${column}` as I18nKey)}
            <span className="kb-col-en" aria-hidden="true">
              {COLUMN_EN[column]}
            </span>
          </h2>
          <span className="kb-count-pill" aria-label={t('column.cardCount', { count: counts[column] })}>
            {counts[column]}
          </span>
          <span className="kb-column-head__actions">
            {!mobile ? (
              <button
                type="button"
                className="kb-icon-btn kb-column-fold"
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? t('column.expand') : t('column.collapse')}
                onClick={() => toggleCollapsed(column)}
              >
                <span className="kb-icon" aria-hidden="true">
                  <IconChevronRight />
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className="kb-icon-btn"
              aria-label={t('a11y.newCardInColumn', { column: t(`column.${column}` as I18nKey) })}
              onClick={() => onCreateInColumn(column)}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconPlus />
              </span>
            </button>
          </span>
        </header>

        {isCollapsed ? (
          <div className="kb-column-collapsed">
            <span>{t('column.collapsedHint')}</span>
            <span>{t('column.cardCount', { count: counts[column] })}</span>
          </div>
        ) : (
          <div className="kb-column__body" role="list" aria-label={t('column.cardCount', { count: allColumnCards.length })}>
            {allColumnCards.length === 0 ? (
              <div className="kb-column__empty">
                <span className="kb-empty-icon" aria-hidden="true">
                  {filtering ? <IconCircle /> : <IconPlus />}
                </span>
                <span className="kb-column__empty-title">
                  {filtering ? t('empty.filtered') : t('empty.columnTitle')}
                </span>
                <span className="kb-column__empty-desc">
                  {filtering ? t('empty.filteredHint') : t('empty.columnHint')}
                </span>
                {filtering ? (
                  <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={onClearFilters}>
                    {t('app.clearFilters')}
                  </button>
                ) : (
                  <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => onCreateInColumn(column)}>
                    <span className="kb-icon" aria-hidden="true">
                      <IconPlus />
                    </span>
                    {t('app.newCard')}
                  </button>
                )}
              </div>
            ) : (
              visibleCards.map((card) => (
                <div
                  role="listitem"
                  key={card.id}
                  className={`kb-card-slot${isOver && overCardId === card.id ? ' kb-card-slot--drop-before' : ''}`}
                  onDragOver={(event) => {
                    if (selectionMode) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (overCardId !== card.id) setOverCardId(card.id);
                    if (overColumn !== column) setOverColumn(column);
                  }}
                >
                  <KanbanCard
                    card={card}
                    now={shared.now}
                    expanded={shared.expandedIds.has(card.id)}
                    selected={shared.activeCardId === card.id}
                    dragging={draggedId === card.id}
                    feed={shared.feeds[card.id]}
                    onLoadEarlier={() => shared.loadEarlier(card.id)}
                    sessions={shared.sessions}
                    resolvingApprovalId={shared.resolvingApprovalId}
                    selectionMode={selectionMode}
                    selectionSelected={selectedIds.has(card.id)}
                    highlighted={highlightedCardId === card.id}
                    onToggleSelection={onToggleSelection}
                    onToggleExpanded={actions.onToggleExpanded}
                    onOpenDetail={actions.onOpenDetail}
                    onEdit={actions.onEdit}
                    onArchive={actions.onArchive}
                    onReopen={actions.onReopen}
                    onMove={actions.onMove}
                    onStartCard={actions.onStartCard}
                    onResolveApproval={actions.onResolveApproval}
                    onNotify={actions.onNotify}
                    onReply={actions.onReply}
                    onRetry={actions.onRetry}
                    onSessionClick={actions.onSessionClick}
                    onDragStart={(cardId) => {
                      if (selectionMode) return;
                      setDraggedId(cardId);
                      setOverColumn(column);
                    }}
                    onDragEnd={() => {
                      if (dropHandled.current) {
                        dropHandled.current = false;
                        return;
                      }
                      resetDrag();
                    }}
                  />
                </div>
              ))
            )}
            {hiddenDone > 0 ? (
              <button type="button" className="kb-column__more" onClick={onViewAllDone}>
                {t('board.viewAllDone', { count: totalForColumn })}
                <span className="kb-icon" aria-hidden="true">
                  <IconChevronRight />
                </span>
              </button>
            ) : null}
            {column === 'done' && !selectionMode ? (
              <p className="kb-column__hint">{t('board.autoArchiveHint')}</p>
            ) : null}
            {isOver && !overCardId ? <div className="kb-drop-line" aria-hidden="true" /> : null}
          </div>
        )}
      </section>
    );
  };

  if (mobile) {
    const current = COLUMNS.includes(activeColumn) ? activeColumn : 'running';
    return (
      <div
        ref={boardRef}
        className={`kb-board kb-board--mobile${selectionMode ? ' kb-board--selection' : ''}`}
        role="region" aria-label={t('a11y.boardRegion', { name: board.name })}>
        <div className="kb-column-switch" role="tablist" aria-label={t('app.viewBoard')}>
          {COLUMNS.map((column) => (
            <button
              key={column}
              type="button"
              role="tab"
              aria-selected={current === column}
              className={`kb-column-switch__item${current === column ? ' kb-column-switch__item--active' : ''}`}
              onClick={() => onActiveColumnChange(column)}
            >
              <span className={`kb-dot kb-dot--${COLUMN_TONE[column]}`} aria-hidden="true" />
              <span>{t(`column.${column}` as I18nKey)}</span>
              <span className="kb-pill kb-pill--count">{counts[column]}</span>
            </button>
          ))}
        </div>
        <div className="kb-board__mobile-column">{renderColumn(current)}</div>
      </div>
    );
  }

  return (
    <div
      ref={boardRef}
      className={`kb-board${selectionMode ? ' kb-board--selection' : ''}`}
      role="region" aria-label={t('a11y.boardRegion', { name: board.name })}>
      {COLUMNS.map(renderColumn)}
    </div>
  );
}
