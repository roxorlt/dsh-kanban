import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { Board, Card, ColumnId } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import type { ColumnGroups } from '../lib/grouping';
import { COLUMNS } from '../lib/status';
import { countByColumn, planCardDrop } from '../lib/grouping';
import { DONE_PREVIEW_LIMIT } from '../lib/listGroups';
import { useBoardWheelScroll } from '../lib/useBoardWheelScroll';
import type { WorklineStatusMap } from '../lib/useWorklineStatuses';
import { KanbanCard } from './KanbanCard';
import { NativeInbox } from './NativeInbox';
import type { NativeInboxProps } from './NativeInbox';
import type { CardActionHandlers, CardViewShared, Placement } from './types';
import { EmptyState } from './feedback';
import { IconArchive, IconCheckCircle, IconChevronRight, IconCircle, IconHand, IconPlus, IconSparkle } from './Icons';

interface BoardViewProps {
  board: Board;
  groups: ColumnGroups;
  cards: Card[];
  /** 未筛选的已完成总数（用于「查看全部 N」） */
  doneTotal: number;
  shared: CardViewShared;
  actions: CardActionHandlers;
  /** cwd → 工作线状态（卡片「工作线」徽标） */
  worklineStatuses: WorklineStatusMap;
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
  /** 原生待确认收件（工具授权 / Agent 提问 / 计划审批），只出现在「待你确认」列 */
  nativeInbox: NativeInboxProps;
  /** 已完成列头「批量归档会话」入口是否可见（embedded 且宿主可用时才显示） */
  canArchiveSessions: boolean;
  onArchiveDoneSessions: () => void;
}

const COLUMN_TONE: Record<ColumnId, string> = {
  backlog: 'tertiary',
  running: 'business',
  needs_you: 'warn',
  done: 'success',
};

/** 落位 settle 类清除时长（ms）：180ms 过渡 + 一帧余量（docs/11-motion.md §6.6）。 */
const DROP_SETTLE_MS = 200;
/** 目标列接收提示清除时长（ms）：220ms 背景过渡 + 余量（docs/11-motion.md §6.6）。 */
const COLUMN_RECEIVED_MS = 240;
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
  worklineStatuses,
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
  nativeInbox,
  canArchiveSessions,
  onArchiveDoneSessions,
}: BoardViewProps) {
  const { t } = useI18n();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<ColumnId | null>(null);
  const [overCardId, setOverCardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<ColumnId>>(() => new Set());
  // 落位反馈（docs/11-motion.md §6.6）：droppedId 保留 ~200ms 让卡片播完 settle；
  // droppedStartId 只活一帧 —— 同列重排是同一个 DOM 节点，必须靠「次帧移除起始态」触发过渡。
  const [droppedId, setDroppedId] = useState<string | null>(null);
  const [droppedStartId, setDroppedStartId] = useState<string | null>(null);
  const [receivedColumn, setReceivedColumn] = useState<ColumnId | null>(null);
  const settleTimer = useRef<number | null>(null);
  const receivedTimer = useRef<number | null>(null);
  const dropHandled = useRef(false);
  const boardRef = useBoardWheelScroll();
  const counts = countByColumn(cards);
  /**
   * A-12：全局无结果（筛选/搜索后所有列都空、也没有宿主待确认项）时，只在顶部出现一个
   * 全局空态 + 一个清空入口；列壳保留，列内退化成一行「无匹配卡片」提示。
   */
  const noResults = filtering && cards.length === 0 && nativeInbox.entries.length === 0;

  const clearDropTimers = () => {
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    if (receivedTimer.current !== null) {
      window.clearTimeout(receivedTimer.current);
      receivedTimer.current = null;
    }
  };

  // 次帧移除起始态：同列重排不会新建 DOM 节点，@starting-style 不生效（docs/11-motion.md §6.6）。
  useEffect(() => {
    if (!droppedStartId) return undefined;
    const frame = requestAnimationFrame(() => setDroppedStartId(null));
    return () => cancelAnimationFrame(frame);
  }, [droppedStartId]);

  // 卸载时清一次性定时器，避免对已卸载组件 setState。
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      if (receivedTimer.current !== null) window.clearTimeout(receivedTimer.current);
    },
    [],
  );

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
      const sourceColumn = COLUMNS.find((key) => groups[key].some((card) => card.id === cardId));
      const placement = planCardDrop({
        ids,
        draggedId: cardId,
        targetId: overCardId,
        sameColumn: sourceColumn === column,
        column,
      });
      // placement 为 null = 放回原位：不请求后端，也不触发「移到某列」的 toast 与时间线。
      if (placement) {
        // 落位反馈：先清上一张卡的定时器，连续拖多张不叠类、不误播（docs/11-motion.md §6.6）。
        clearDropTimers();
        setDroppedId(cardId);
        setDroppedStartId(cardId);
        settleTimer.current = window.setTimeout(() => {
          settleTimer.current = null;
          setDroppedId(null);
        }, DROP_SETTLE_MS);
        if (sourceColumn !== column) {
          // 只有跨列才让目标列闪一下「收到」；同列重排只播落位 settle。
          setReceivedColumn(column);
          receivedTimer.current = window.setTimeout(() => {
            receivedTimer.current = null;
            setReceivedColumn(null);
          }, COLUMN_RECEIVED_MS);
        } else {
          setReceivedColumn(null);
        }
        onMoveWithPlacement(cardId, column, placement);
      }
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
    const isSelfDrag = draggedId !== null && allColumnCards.some((card) => card.id === draggedId);
    const isCollapsed = collapsed.has(column) && !mobile;
    const totalForColumn = isDone && !filtering ? doneTotal : allColumnCards.length;
    const hiddenDone = isDone ? Math.max(0, totalForColumn - visibleCards.length) : 0;

    return (
      <section
        key={column}
        className={`kb-column${isOver ? ' kb-column--over' : ''}${
          receivedColumn === column ? ' kb-column--received' : ''
        }${isCollapsed ? ' kb-column--collapsed' : ''}`}
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
          <h2 className="kb-column-title">{t(`column.${column}` as I18nKey)}</h2>
          <span
            className="kb-count-pill"
            aria-label={t('column.cardCount', { count: counts[column] })}
            title={isDone ? t('board.autoArchiveHint') : undefined}
          >
            {counts[column]}
          </span>
          <span className="kb-column-head__actions">
            {column === 'done' && canArchiveSessions ? (
              <button
                type="button"
                className="kb-icon-btn"
                aria-label={t('sessionArchive.batchAction')}
                title={t('sessionArchive.batchAction')}
                onClick={onArchiveDoneSessions}
              >
                <span className="kb-icon" aria-hidden="true">
                  <IconArchive />
                </span>
              </button>
            ) : null}
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
          <div className="kb-column__body" role="group" aria-label={t('column.cardCount', { count: allColumnCards.length })}>
            {column === 'needs_you' ? <NativeInbox {...nativeInbox} /> : null}
            {allColumnCards.length === 0 ? (
              filtering ? (
                // A-12：过滤无匹配时列内只留一行紧凑提示；「清空筛选」只在全局空态出现一次。
                <div className="kb-column__filter-hint">{t('empty.noMatchShort')}</div>
              ) : (
                <div className="kb-column__empty">
                  <span className="kb-empty-icon" aria-hidden="true">
                    <IconPlus />
                  </span>
                  <span className="kb-column__empty-title">{t('empty.columnTitle')}</span>
                  <span className="kb-column__empty-desc">{t('empty.columnHint')}</span>
                  <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => onCreateInColumn(column)}>
                    <span className="kb-icon" aria-hidden="true">
                      <IconPlus />
                    </span>
                    {t('app.newCard')}
                  </button>
                </div>
              )
            ) : (
              <div className="kb-column__cards" role="list" aria-label={t('column.cardCount', { count: allColumnCards.length })}>
                {isDone && isOver && !overCardId && !isSelfDrag ? (
                  <div className="kb-drop-line" aria-hidden="true" />
                ) : null}
                {visibleCards.map((card) => (
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
                    worklineStatus={card.cwd?.trim() ? worklineStatuses[card.cwd.trim()] : undefined}
                    relations={shared.relations}
                    resolvingApprovalId={shared.resolvingApprovalId}
                    selectionMode={selectionMode}
                    selectionSelected={selectedIds.has(card.id)}
                    highlighted={highlightedCardId === card.id}
                    dropPhase={
                      droppedStartId === card.id ? 'start' : droppedId === card.id ? 'settle' : undefined
                    }
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
                ))}
              </div>
            )}
            {hiddenDone > 0 ? (
              <button type="button" className="kb-column__more" onClick={onViewAllDone}>
                {t('board.viewAllDone', { count: totalForColumn })}
                <span className="kb-icon" aria-hidden="true">
                  <IconChevronRight />
                </span>
              </button>
            ) : null}
            {/* 列体空白区的落点提示：已完成列内拖回空白区 = 放回原位，不请求后端；
                跨列拖进已完成列插到列头，提示线画在首张卡片前；其他列画在末尾。 */}
            {isOver && !overCardId && !isDone ? <div className="kb-drop-line" aria-hidden="true" /> : null}
          </div>
        )}
      </section>
    );
  };

  if (mobile) {
    const current = COLUMNS.includes(activeColumn) ? activeColumn : 'running';
    return (
      <>
        {noResults ? <GlobalEmptyResult onClearFilters={onClearFilters} /> : null}
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
      </>
    );
  }

  return (
    <>
      {noResults ? <GlobalEmptyResult onClearFilters={onClearFilters} /> : null}
      <div
        ref={boardRef}
        className={`kb-board${selectionMode ? ' kb-board--selection' : ''}`}
        role="region" aria-label={t('a11y.boardRegion', { name: board.name })}>
        {COLUMNS.map(renderColumn)}
      </div>
    </>
  );
}

/** A-12 全局空态：一句标题 + 一句 hint + 唯一「清空筛选」入口；列壳/分组壳仍保留。 */
function GlobalEmptyResult({ onClearFilters }: { onClearFilters: () => void }) {
  const { t } = useI18n();
  return (
    <div className="kb-global-empty">
      <EmptyState
        title={t('empty.filtered')}
        hint={t('empty.filteredHint')}
        actionLabel={t('app.clearFilters')}
        onAction={onClearFilters}
      />
    </div>
  );
}
