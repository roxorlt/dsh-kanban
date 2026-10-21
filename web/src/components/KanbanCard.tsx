import { useMemo, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Approval, Card, ColumnId, Priority, SessionRow } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { COLUMN_OF_STATUS, COLUMNS, STATUS_OF_COLUMN, STATUS_TONE, isWarningStatus } from '../lib/status';
import { elapsedMs, formatDuration } from '../lib/time';
import { CARD_TIMELINE_PREVIEW, CARD_TIMELINE_STEP, visibleActivities } from '../lib/activities';
import type { ActivityFeed } from '../lib/activities';
import { ApprovalPanel } from './ApprovalPanel';
import type { ApprovalDecision } from './ApprovalPanel';
import { MenuButton } from './MenuButton';
import type { MenuEntry } from './MenuButton';
import { Timeline, TimelineLoadMore } from './Timeline';
import {
  IconArchive,
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconFile,
  IconFolder,
  IconImage,
  IconLink,
  IconMore,
  IconMove,
  IconOpen,
  IconRedo,
  IconSearch,
  IconSend,
  IconSparkle,
  IconWrench,
} from './Icons';

interface KanbanCardProps {
  card: Card;
  now: number;
  expanded: boolean;
  selected: boolean;
  dragging: boolean;
  feed: ActivityFeed | undefined;
  onLoadEarlier: () => void;
  sessions: SessionRow[];
  resolvingApprovalId: string | null;
  onToggleExpanded: (cardId: string) => void;
  onOpenDetail: (cardId: string) => void;
  onEdit: (card: Card) => void;
  onArchive: (card: Card) => void;
  onReopen: (card: Card) => void;
  onMove: (cardId: string, column: ColumnId) => void;
  onResolveApproval: (
    card: Card,
    approval: Approval,
    optionIds: string[],
    comment: string,
    decision: ApprovalDecision,
  ) => void;
  onReply: (card: Card, text: string) => Promise<{ ok: boolean; error?: string }>;
  onRetry: (card: Card) => void;
  onSessionClick: (card: Card) => void;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
}

const PRIORITY_CODE: Record<Exclude<Priority, 'none'>, string> = {
  urgent: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
};

/** 折叠卡：标题/摘要/当前动作/属性行/页脚/审批/素材；展开卡追加分页时间线与内联回复。 */
export function KanbanCard({
  card,
  now,
  expanded,
  selected,
  dragging,
  feed,
  onLoadEarlier,
  sessions,
  resolvingApprovalId,
  onToggleExpanded,
  onOpenDetail,
  onEdit,
  onArchive,
  onReopen,
  onMove,
  onResolveApproval,
  onReply,
  onRetry,
  onSessionClick,
  onDragStart,
  onDragEnd,
}: KanbanCardProps) {
  const { t, lang } = useI18n();
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(CARD_TIMELINE_PREVIEW);

  const tone = STATUS_TONE[card.status];
  const statusKey = `status.${card.status}` as I18nKey;
  const warning = isWarningStatus(card.status);
  const pendingApproval = card.approvals.find((approval) => approval.status === 'pending');
  const resolvedApproval = pendingApproval
    ? undefined
    : [...card.approvals].reverse().find((approval) => approval.status !== 'pending');
  const elapsed = elapsedMs(card, now);
  const primarySession = card.sessionIds[0]
    ? sessions.find((session) => session.id === card.sessionIds[0])
    : undefined;

  const timelineItems = useMemo(
    () => visibleActivities(feed, expanded ? visibleCount : 0),
    [feed, expanded, visibleCount],
  );
  const loadedCount = feed?.items.length ?? 0;
  const canLoadEarlier = loadedCount > visibleCount || Boolean(feed?.hasMore);

  const images = card.artifacts.filter((artifact) => artifact.kind === 'image' && artifact.url);
  const mediaCount = card.artifacts.length;

  const moveItems: MenuEntry[] = COLUMNS.map((target, index) => ({
    id: `move:${target}`,
    label: `${t('card.moveTo')} · ${t(`column.${target}` as I18nKey)}`,
    icon: <IconMove />,
    checked: card.status === STATUS_OF_COLUMN[target],
    disabled: card.status === STATUS_OF_COLUMN[target],
    separatorBefore: index === 0,
  }));

  const menuItems: MenuEntry[] = [
    { id: 'open', label: t('card.openDetail'), icon: <IconOpen /> },
    { id: 'edit', label: t('card.edit'), icon: <IconEdit /> },
    ...moveItems,
    ...(card.status === 'done' || card.status === 'canceled'
      ? [{ id: 'reopen', label: t('card.reopen'), icon: <IconRedo /> }]
      : []),
    { id: 'archive', label: t('card.archive'), icon: <IconArchive />, danger: true, separatorBefore: true },
  ];

  const handleMenuSelect = (id: string) => {
    if (id === 'open') onOpenDetail(card.id);
    else if (id === 'edit') onEdit(card);
    else if (id === 'archive') onArchive(card);
    else if (id === 'reopen') onReopen(card);
    else if (id.startsWith('move:')) {
      const target = id.slice('move:'.length) as ColumnId;
      if (COLUMNS.includes(target)) onMove(card.id, target);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData('text/plain', card.id);
    event.dataTransfer.effectAllowed = 'move';
    onDragStart(card.id);
  };

  const submitReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = replyText.trim();
    if (!text || replySending) return;
    setReplySending(true);
    setReplyError(null);
    const result = await onReply(card, text);
    setReplySending(false);
    if (result.ok) setReplyText('');
    else setReplyError(result.error ?? t('composer.replyFailed'));
  };

  const loadEarlier = () => {
    setVisibleCount((current) => current + CARD_TIMELINE_STEP);
    if (visibleCount >= loadedCount) onLoadEarlier();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a')) return;
    if (event.key === 'Enter' || event.key.toLowerCase() === 'o') {
      event.preventDefault();
      onOpenDetail(card.id);
    } else if (event.key === ' ') {
      event.preventDefault();
      onToggleExpanded(card.id);
    } else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const columnIndex = COLUMNS.indexOf(COLUMN_OF_STATUS[card.status]);
      const next = COLUMNS[columnIndex + (event.key === 'ArrowRight' ? 1 : -1)];
      if (next) onMove(card.id, next);
    }
  };

  const visibleLabels = card.labels.slice(0, 2);
  const extraLabels = card.labels.length - visibleLabels.length;
  const actionTone =
    card.status === 'running'
      ? 'busy'
      : card.status === 'blocked' || card.status === 'failed'
        ? 'error'
        : card.status === 'needs_you'
          ? 'warn'
          : 'idle';

  return (
    <article
      className={`kb-card${expanded ? ' kb-card--expanded' : ''}${selected ? ' kb-card--selected' : ''}${
        warning ? ' kb-card--warning' : ''
      }${dragging ? ' kb-card--dragging' : ''}`}
      data-status={card.status}
      data-card-id={card.id}
      tabIndex={0}
      role="group"
      aria-label={t('a11y.cardLabel', { title: card.title, status: t(statusKey) })}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onOpenDetail(card.id)}
    >
      <div className="kb-card-head">
        <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
        <h3 className="kb-card-title" onClick={() => onOpenDetail(card.id)}>
          {card.title}
        </h3>
        <button
          type="button"
          className="kb-icon-btn kb-card-toggle"
          aria-expanded={expanded}
          aria-controls={`kb-exp-${card.id}`}
          aria-label={expanded ? t('card.collapse') : t('card.expand')}
          onClick={() => onToggleExpanded(card.id)}
        >
          <span className="kb-icon" aria-hidden="true">
            <IconChevronDown />
          </span>
        </button>
        <MenuButton
          label={t('a11y.cardActions')}
          trigger={<IconMore />}
          triggerClassName="kb-icon-btn kb-card-menu"
          items={menuItems}
          onSelect={handleMenuSelect}
        />
      </div>

      {card.summary ? <p className="kb-card-summary">{card.summary}</p> : null}

      {card.currentAction ? (
        <p className={`kb-card-action kb-card-action--${actionTone}`}>
          <span className="kb-icon" aria-hidden="true">
            <IconSparkle />
          </span>
          <span>{card.currentAction}</span>
        </p>
      ) : null}

      <div className="kb-card-props">
        {card.priority !== 'none' ? (
          <span className="kb-priority" data-p={PRIORITY_CODE[card.priority]}>
            {PRIORITY_CODE[card.priority]}
          </span>
        ) : null}
        {card.project ? (
          <span className="kb-prop-project" title={card.project}>
            <span className="kb-icon" aria-hidden="true">
              <IconFolder />
            </span>
            {card.project}
          </span>
        ) : null}
        {visibleLabels.map((label) => (
          <span className="kb-tag" key={label}>
            {label}
          </span>
        ))}
        {extraLabels > 0 ? <span className="kb-tag">+{extraLabels}</span> : null}
      </div>

      {mediaCount ? (
        <div className="kb-media-row">
          <span className="kb-media-row__thumbs" aria-hidden="true">
            {(images.length ? images : card.artifacts).slice(0, 2).map((artifact) =>
              artifact.kind === 'image' && artifact.url ? (
                <img
                  key={artifact.id}
                  className="kb-media-row__thumb"
                  src={artifact.url}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="kb-media-row__thumb kb-media-row__thumb--icon" key={artifact.id}>
                  {artifact.kind === 'image' ? <IconImage /> : artifact.kind === 'file' ? <IconFile /> : <IconLink />}
                </span>
              ),
            )}
          </span>
          <span className="kb-media-row__count">{t('card.mediaCount', { count: mediaCount })}</span>
          <button
            type="button"
            className="kb-link-btn kb-media-row__action"
            onClick={() => (card.sessionIds.length ? onSessionClick(card) : onOpenDetail(card.id))}
          >
            {card.sessionIds.length ? t('card.viewInSession') : t('card.viewInDetail')}
          </button>
        </div>
      ) : null}

      <div className="kb-card-foot">
        <span className={`kb-foot-status kb-foot-status--${tone}`}>
          <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
          {t(statusKey)}
          {elapsed > 0 ? <span className="kb-foot-elapsed"> · {formatDuration(elapsed, lang)}</span> : null}
        </span>
        <span className="kb-card-foot__metrics">
          <span className="kb-metric" title={t('card.tools')}>
            <span className="kb-icon" aria-hidden="true">
              <IconWrench />
            </span>
            {card.metadata.toolCalls}
          </span>
          <span className="kb-metric" title={t('card.searches')}>
            <span className="kb-icon" aria-hidden="true">
              <IconSearch />
            </span>
            {card.metadata.searches}
          </span>
          <span className="kb-divider-v" aria-hidden="true" />
          <button
            type="button"
            className={`kb-metric kb-metric-link${primarySession?.running ? ' kb-metric--live' : ''}`}
            title={primarySession?.title ?? card.sessionIds[0] ?? t('card.noSession')}
            aria-label={t('card.sessionOpen')}
            onClick={() => onSessionClick(card)}
          >
            <span className="kb-icon" aria-hidden="true">
              <IconLink />
            </span>
          </button>
        </span>
      </div>

      {pendingApproval ? (
        <ApprovalPanel
          approval={pendingApproval}
          busy={resolvingApprovalId === pendingApproval.id}
          now={now}
          onResolve={(approval, optionIds, comment, decision) =>
            onResolveApproval(card, approval, optionIds, comment, decision)
          }
        />
      ) : resolvedApproval ? (
        <ApprovalPanel approval={resolvedApproval} busy={false} now={now} onResolve={() => undefined} />
      ) : null}

      {expanded ? (
        <div className="kb-card-expanded" id={`kb-exp-${card.id}`}>
          <div className="kb-exp-head">
            <span>{t('card.importantNodes')}</span>
            {card.agent?.name ? <span className="kb-exp-agent">{card.agent.name}</span> : null}
            <button type="button" className="kb-link-btn" onClick={() => onOpenDetail(card.id)}>
              {t('card.openDetail')}
              <span className="kb-icon" aria-hidden="true">
                <IconChevronRight />
              </span>
            </button>
          </div>
          <div className="kb-card-timeline-scroll">
            <Timeline activities={timelineItems} now={now} variant="compact" />
            <TimelineLoadMore hasMore={canLoadEarlier} loading={Boolean(feed?.loading) && loadedCount > 0} onClick={loadEarlier} />
          </div>

          {card.status === 'failed' ? (
            <button type="button" className="kb-btn kb-btn--outline kb-btn--sm kb-card-retry" onClick={() => onRetry(card)}>
              <span className="kb-icon" aria-hidden="true">
                <IconRedo />
              </span>
              {t('card.retry')}
            </button>
          ) : null}

          <form className="kb-card-reply" onSubmit={(event) => void submitReply(event)}>
            <label className="kb-sr-only" htmlFor={`kb-reply-${card.id}`}>
              {t('card.reply')}
            </label>
            <input
              id={`kb-reply-${card.id}`}
              className="kb-input kb-card-reply__input"
              type="text"
              autoComplete="off"
              placeholder={t('card.replyPlaceholder')}
              value={replyText}
              disabled={replySending}
              onChange={(event) => setReplyText(event.target.value)}
            />
            <button
              type="submit"
              className="kb-icon-btn kb-card-reply__send"
              disabled={!replyText.trim() || replySending}
              aria-label={t('composer.send')}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconSend />
              </span>
            </button>
          </form>
          {replyError ? (
            <p className="kb-card-reply__error" role="alert">
              {replyError}
            </p>
          ) : null}

          <div className="kb-card-actions">
            <button type="button" className="kb-btn kb-btn--sm kb-btn--outline" onClick={() => onOpenDetail(card.id)}>
              {t('card.openDetail')}
              <span className="kb-icon" aria-hidden="true">
                <IconChevronRight />
              </span>
            </button>
            <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => onEdit(card)}>
              <span className="kb-icon" aria-hidden="true">
                <IconEdit />
              </span>
              {t('card.edit')}
            </button>
            <MenuButton
              label={t('a11y.moveMenu')}
              trigger={
                <>
                  {t('card.moveTo')}
                  <span className="kb-icon" aria-hidden="true">
                    <IconChevronDown />
                  </span>
                </>
              }
              triggerClassName="kb-btn kb-btn--sm kb-btn--ghost kb-card-move"
              items={moveItems}
              onSelect={(id) => {
                if (id.startsWith('move:')) {
                  const target = id.slice('move:'.length) as ColumnId;
                  if (COLUMNS.includes(target)) onMove(card.id, target);
                }
              }}
            />
          </div>
        </div>
      ) : null}
    </article>
  );
}
