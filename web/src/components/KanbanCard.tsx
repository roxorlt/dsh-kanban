import { useEffect, useMemo, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Approval, Card, ColumnId, SessionRow } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { COLUMN_OF_STATUS, COLUMNS, STATUS_OF_COLUMN, STATUS_TONE, isWarningStatus } from '../lib/status';
import { elapsedMs, formatDateTime, formatDuration, formatRelative } from '../lib/time';
import { CARD_TIMELINE_PREVIEW, CARD_TIMELINE_STEP, visibleActivities } from '../lib/activities';
import type { ActivityFeed } from '../lib/activities';
import type { CardRelationIndex } from '../lib/cardRelations';
import type { WorklineStatus } from '../lib/worklineSummary';
import { usePresence } from '../lib/usePresence';
import { ApprovalSlot } from './ApprovalSlot';
import { canStartCard } from '../lib/startCard';
import { describeCardRuntime } from '../lib/runtime';
import type { ApprovalDecision, ApprovalSubmission } from './ApprovalPanel';
import { MenuButton } from './MenuButton';
import type { MenuEntry } from './MenuButton';
import { Timeline, TimelineLoadMore } from './Timeline';
import { WorklineBadge } from './WorklineBadge';
import { CardRelationBadges } from './CardRelations';
import { AgentBadge } from './AgentBadge';
import { describeCardAgent } from '../lib/agentBadge';
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
  /** 卡片「工作线」徽标状态：undefined=未就绪，null=探测失败（未知） */
  worklineStatus?: WorklineStatus | null;
  /** v0.22 父子卡/依赖关系索引（徽标用；旧数据无关系时为空索引） */
  relations: CardRelationIndex;
  resolvingApprovalId: string | null;
  selectionMode: boolean;
  selectionSelected: boolean;
  highlighted?: boolean;
  onToggleSelection: (cardId: string) => void;
  onToggleExpanded: (cardId: string) => void;
  onOpenDetail: (cardId: string) => void;
  onEdit: (card: Card) => void;
  onArchive: (card: Card) => void;
  onReopen: (card: Card) => void;
  onMove: (cardId: string, column: ColumnId) => void;
  onStartCard: (card: Card) => void;
  onResolveApproval: (
    card: Card,
    approval: Approval,
    submission: ApprovalSubmission,
    comment: string,
    decision: ApprovalDecision,
  ) => void;
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void;
  onReply: (card: Card, text: string) => Promise<{ ok: boolean; error?: string }>;
  onRetry: (card: Card) => void;
  onSessionClick: (card: Card) => void;
  onToggleAutoStart?: (card: Card, next: boolean) => void;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
  /**
   * 拖拽落位反馈（docs/11-motion.md §6.6）：
   * 'start' = 起始帧（次帧由 BoardView 移除），'settle' = 落定过渡中；undefined = 不播。
   */
  dropPhase?: 'start' | 'settle';
}

/** 展开区离场等待时长（ms）：与 styles/base.css 的 --kb-dur-exit 同源（docs/11-motion.md §3.1/§6.1）。 */
const CARD_EXPAND_EXIT_MS = 140;

/**
 * 展开/收起的挂载外壳，看板卡片与列表行共用（同一套语感、避免两处时长漂移）。
 * 高度过渡本体在 CSS：.kb-card-expand / .kb-list__expand 的 grid-template-rows 0fr↔1fr。
 *
 * - usePresence：收起后保留挂载 140ms，CSS 才拿得到离场帧，随后卸载（docs/11-motion.md §5）；
 * - revealed：刚挂载的展开区先按收起态（0fr）渲染，次帧再置 true 才触发入场过渡；
 *   首屏已展开的卡片（初始 expanded=true）直接为 true —— 按规范，初次挂载不播动画。
 */
export function useExpandedPresence(expanded: boolean): {
  /** 是否渲染展开区（展开中或离场等待中）。 */
  render: boolean;
  /** 是否处在离场过渡中（挂 *--leaving）。 */
  leaving: boolean;
  /** 是否已进入「展开」态（挂 *--open）；false 时保持 0fr 作为入场起点。 */
  revealed: boolean;
} {
  const { mounted, leaving } = usePresence(expanded, CARD_EXPAND_EXIT_MS);
  const [revealed, setRevealed] = useState(expanded);
  useEffect(() => {
    if (expanded && !revealed) {
      // 次帧再置「展开」：必须让收起态先被绘制一帧，CSS 过渡才有起点（不能直接动画到 auto）。
      const frame = requestAnimationFrame(() => setRevealed(true));
      return () => cancelAnimationFrame(frame);
    }
    // 完全卸载后复位，下次展开重新从 0fr 播放入场。
    if (!expanded && !mounted) setRevealed(false);
    return undefined;
  }, [expanded, mounted, revealed]);
  return { render: expanded || mounted, leaving, revealed };
}

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
  worklineStatus,
  relations,
  resolvingApprovalId,
  selectionMode,
  selectionSelected,
  highlighted = false,
  onToggleSelection,
  onToggleExpanded,
  onOpenDetail,
  onEdit,
  onArchive,
  onReopen,
  onMove,
  onStartCard,
  onResolveApproval,
  onNotify,
  onReply,
  onRetry,
  onSessionClick,
  onToggleAutoStart,
  onDragStart,
  onDragEnd,
  dropPhase,
}: KanbanCardProps) {
  const { t, lang } = useI18n();
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(CARD_TIMELINE_PREVIEW);
  const expand = useExpandedPresence(expanded);

  const tone = STATUS_TONE[card.status];
  const statusKey = `status.${card.status}` as I18nKey;
  const warning = isWarningStatus(card.status);
  const isSubStatus = card.status === 'blocked' || card.status === 'failed' || card.status === 'canceled';
  const pendingApproval = card.approvals.find((approval) => approval.status === 'pending');
  // A-04：一张卡最多展开一个审批（pending 的那条），其余压成一行摘要，点开详情查看
  const otherApprovals = useMemo(
    () => card.approvals.filter((approval) => approval.id !== pendingApproval?.id).slice(-2),
    [card.approvals, pendingApproval?.id],
  );
  const elapsed = elapsedMs(card, now);
  const runtimeInfo = useMemo(() => describeCardRuntime(card, now), [card, now]);
  const agentDesc = useMemo(() => describeCardAgent(card.agent), [card.agent]);
  const isExternalAgent = agentDesc?.kind === 'external';
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

  const canStart = canStartCard(card);
  const canToggleAuto = card.status !== 'done' && card.status !== 'canceled' && Boolean(onToggleAutoStart);
  const menuItems: MenuEntry[] = [
    ...(canStart
      ? [{ id: 'start', label: t('card.start'), icon: <IconSparkle />, separatorBefore: false }]
      : []),
    ...(canToggleAuto
      ? [
          {
            id: 'autostart',
            label: runtimeInfo.autoStart ? t('runtime.autoStartOn') : t('runtime.enableAutoStart'),
            icon: <IconSparkle />,
            checked: runtimeInfo.autoStart,
          },
        ]
      : []),
    { id: 'open', label: t('card.openDetail'), icon: <IconOpen /> },
    { id: 'edit', label: t('card.edit'), icon: <IconEdit /> },
    ...moveItems,
    ...(card.status === 'done' || card.status === 'canceled'
      ? [{ id: 'reopen', label: t('card.reopen'), icon: <IconRedo /> }]
      : []),
    { id: 'archive', label: t('card.archive'), icon: <IconArchive />, danger: true, separatorBefore: true },
  ];

  const handleMenuSelect = (id: string) => {
    if (id === 'start') onStartCard(card);
    else if (id === 'autostart') onToggleAutoStart?.(card, !runtimeInfo.autoStart);
    else if (id === 'open') onOpenDetail(card.id);
    else if (id === 'edit') onEdit(card);
    else if (id === 'archive') onArchive(card);
    else if (id === 'reopen') onReopen(card);
    else if (id.startsWith('move:')) {
      const target = id.slice('move:'.length) as ColumnId;
      if (COLUMNS.includes(target)) onMove(card.id, target);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    if (selectionMode) {
      event.preventDefault();
      return;
    }
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
    if (selectionMode) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onToggleSelection(card.id);
      }
      return;
    }
    // 与 demo/规范一致：Enter / Space 展开收起，O 打开详情
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggleExpanded(card.id);
    } else if (event.key.toLowerCase() === 'o') {
      event.preventDefault();
      onOpenDetail(card.id);
    } else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const columnIndex = COLUMNS.indexOf(COLUMN_OF_STATUS[card.status]);
      const next = COLUMNS[columnIndex + (event.key === 'ArrowRight' ? 1 : -1)];
      if (next) onMove(card.id, next);
    }
  };

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
      }${dragging ? ' kb-card--dragging' : ''}${selectionMode ? ' kb-card--selectable' : ''}${
        selectionSelected ? ' kb-card--picked' : ''
      }${highlighted ? ' kb-card--highlight' : ''}${
        dropPhase === 'start' ? ' kb-card--dropped-start' : ''
      }${dropPhase === 'settle' ? ' kb-card--dropped' : ''}`}
      data-status={card.status}
      data-card-id={card.id}
      tabIndex={0}
      role="group"
      aria-label={t('a11y.cardLabel', { title: card.title, status: t(statusKey) })}
      draggable={!selectionMode}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, textarea, select, label')) return;
        // 拖选文字时不误触发
        if (window.getSelection()?.toString()) return;
        if (selectionMode) {
          onToggleSelection(card.id);
          return;
        }
        // 展开区与审批面板内部点击不折叠，避免阅读/作答时误触
        if (target.closest('.kb-card-expanded, .kb-decision')) return;
        onToggleExpanded(card.id);
      }}
      onDoubleClick={() => {
        if (!selectionMode) onOpenDetail(card.id);
      }}
    >
      <div className="kb-card-head">
        <span className={`kb-dot kb-dot--${tone} kb-card-head__dot`} aria-hidden="true" />
        {selectionMode ? (
          <label className="kb-card-select" onClick={(event) => event.stopPropagation()}>
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
        <h3 className="kb-card-title">{card.title}</h3>
        {!selectionMode ? (
        <>
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
        </>
        ) : null}
      </div>

      {card.summary && (expanded || card.status !== 'running' || !card.currentAction) ? (
        <p className="kb-card-summary">{card.summary}</p>
      ) : null}

      <WorklineBadge cwd={card.cwd} status={worklineStatus} />

      {card.currentAction ? (
        <p className={`kb-card-action kb-card-action--${actionTone}`}>
          <span className="kb-icon" aria-hidden="true">
            <IconSparkle />
          </span>
          <span>{card.currentAction}</span>
        </p>
      ) : null}

      <div className="kb-card-props">
        {card.project ? (
          <span className="kb-prop-project" title={card.project}>
            <span className="kb-icon" aria-hidden="true">
              <IconFolder />
            </span>
            {card.project}
          </span>
        ) : null}
        <AgentBadge agent={card.agent} />
        {card.handoff ? (
          <span
            className="kb-tag kb-tag--handoff"
            title={t('handoff.badgeAria', { date: formatDateTime(card.handoff.at, lang) })}
            aria-label={t('handoff.badgeAria', { date: formatDateTime(card.handoff.at, lang) })}
          >
            {runtimeInfo.isUpstreamHandoff ? t('runtime.upstreamHandoffBadge') : t('handoff.badge')}
          </span>
        ) : null}
        {runtimeInfo.autoStart && !((card.status === 'backlog' || card.status === 'blocked') && !selectionMode && onToggleAutoStart) ? (
          <span className="kb-tag kb-tag--runtime" title={t('runtime.autoStartHint')}>
            {t('runtime.autoStartBadge')}
          </span>
        ) : null}
        {runtimeInfo.waitActive ? (
          <span className="kb-tag kb-tag--runtime" title={runtimeInfo.waitActive.reason || undefined}>
            {t('runtime.waitBadge', { remaining: formatDuration(runtimeInfo.waitActive.remainingMs, lang) })}
          </span>
        ) : null}
        {runtimeInfo.watchdogState === 'nudged' ? (
          <span className="kb-tag kb-tag--runtime">{t('runtime.watchdogNudged', { used: runtimeInfo.nudgesUsed })}</span>
        ) : runtimeInfo.watchdogState === 'stalled' ? (
          <span className="kb-tag kb-tag--runtime-warn">{t('runtime.watchdogStalled')}</span>
        ) : runtimeInfo.watchdogState === 'retrying' ? (
          <span className="kb-tag kb-tag--runtime">{t('runtime.watchdogRetrying', { used: runtimeInfo.retriesUsed })}</span>
        ) : runtimeInfo.watchdogState === 'retry_exhausted' ? (
          <span className="kb-tag kb-tag--runtime-warn">{t('runtime.watchdogRetryExhausted')}</span>
        ) : null}
        <CardRelationBadges card={card} relations={relations} />
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
            onClick={() =>
              (!isExternalAgent && card.sessionIds.length) || Boolean(agentDesc?.url)
                ? onSessionClick(card)
                : onOpenDetail(card.id)
            }
          >
            {(!isExternalAgent && card.sessionIds.length) || Boolean(agentDesc?.url)
              ? t('card.viewInSession')
              : t('card.viewInDetail')}
          </button>
        </div>
      ) : null}

      <div className="kb-card-foot">
        {isSubStatus ? (
          <span className={`kb-foot-status kb-foot-status--${tone}`}>
            <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
            <span className="kb-foot-status__text">
              {t(statusKey)}
              {elapsed > 0 ? <span className="kb-foot-elapsed"> · {formatDuration(elapsed, lang)}</span> : null}
            </span>
          </span>
        ) : elapsed > 0 ? (
          <span className="kb-foot-status kb-foot-status--tertiary">
            <span className="kb-foot-status__text">
              <span className="kb-foot-elapsed">{formatDuration(elapsed, lang)}</span>
            </span>
          </span>
        ) : null}
        {card.status === 'running' && !card.sessionIds.length && !isExternalAgent ? (
          <span className="kb-foot-warn" title={t('drawer.runningNoSessionWarn')}>
            {t('card.noSessionWarn')}
          </span>
        ) : null}
        {canStart && !selectionMode ? (
          <button
            type="button"
            className="kb-btn kb-btn--sm kb-btn--ghost kb-foot-start"
            onClick={() => onStartCard(card)}
          >
            <span className="kb-icon" aria-hidden="true">
              <IconSparkle />
            </span>
            {t('card.start')}
          </button>
        ) : null}
        {(card.status === 'backlog' || card.status === 'blocked') && !selectionMode && onToggleAutoStart ? (
          <button
            type="button"
            aria-pressed={runtimeInfo.autoStart}
            className={`kb-btn kb-btn--sm kb-btn--ghost kb-foot-autostart${runtimeInfo.autoStart ? ' kb-foot-autostart--on' : ''}`}
            title={t('runtime.autoStartHint')}
            onClick={() => onToggleAutoStart(card, !runtimeInfo.autoStart)}
          >
            {runtimeInfo.autoStart ? t('runtime.autoStartBadge') : t('runtime.enableAutoStart')}
          </button>
        ) : null}
        <span className="kb-card-foot__metrics">
          {card.metadata.toolCalls > 0 ? (
            <span className="kb-metric" title={t('card.tools')}>
              <span className="kb-icon" aria-hidden="true">
                <IconWrench />
              </span>
              {card.metadata.toolCalls}
            </span>
          ) : null}
          {card.metadata.searches > 0 ? (
            <span className="kb-metric" title={t('card.searches')}>
              <span className="kb-icon" aria-hidden="true">
                <IconSearch />
              </span>
              {card.metadata.searches}
            </span>
          ) : null}
          {card.metadata.toolCalls > 0 || card.metadata.searches > 0 ? (
            <span className="kb-divider-v" aria-hidden="true" />
          ) : null}
          <button
            type="button"
            className={`kb-metric kb-metric-link${!isExternalAgent && primarySession?.running ? ' kb-metric--live' : ''}`}
            title={
              isExternalAgent
                ? agentDesc?.url
                  ? t('card.openExternalSession', { agent: agentDesc.label })
                  : t('card.externalSessionDetail', { agent: agentDesc?.label ?? '' })
                : (primarySession?.title ?? card.sessionIds[0] ?? t('card.noSession'))
            }
            aria-label={
              isExternalAgent
                ? agentDesc?.url
                  ? t('card.openExternalSession', { agent: agentDesc.label })
                  : t('card.externalSessionDetail', { agent: agentDesc?.label ?? '' })
                : t('card.sessionOpen')
            }
            onClick={() => onSessionClick(card)}
          >
            <span className="kb-icon" aria-hidden="true">
              {isExternalAgent && agentDesc?.url ? <IconOpen /> : <IconLink />}
            </span>
          </button>
        </span>
      </div>

      {/* 交互式审批用 ApprovalSlot 包一层（docs/11-motion.md §6.3）：提交成功后审批变 null，
          由它保留 140ms 淡出再卸载；因此这里不能再让 pendingApproval 直接条件包住，
          否则审批消失的瞬间组件就被卸载，离场帧丢失。只读历史视图保持原样。 */}
      {!selectionMode ? (
        <ApprovalSlot
          approval={pendingApproval ?? null}
          busy={pendingApproval ? resolvingApprovalId === pendingApproval.id : false}
          now={now}
          onResolve={(approval, submission, comment, decision) =>
            onResolveApproval(card, approval, submission, comment, decision)
          }
          onValidationError={(message) => onNotify(message, 'error')}
        />
      ) : null}
      {/* A-04：其余审批只占一行（标题 + 结果 + 时间），点开详情看完整选项与回答 */}
      {!selectionMode && otherApprovals.length ? (
        <ul className="kb-decision-summaries" aria-label={t('drawer.approvals')}>
          {otherApprovals.map((approval) => {
            const summaryStatusKey = `approval.status.${approval.status}` as I18nKey;
            const summaryTone =
              approval.status === 'approved' ? 'success' : approval.status === 'rejected' ? 'error' : 'tertiary';
            return (
              <li key={approval.id}>
                <button type="button" className="kb-decision-summary" onClick={() => onOpenDetail(card.id)}>
                  <span className={`kb-dot kb-dot--${summaryTone}`} aria-hidden="true" />
                  <span className="kb-decision-summary__title">{approval.title}</span>
                  <span className="kb-decision-summary__status">{t(summaryStatusKey)}</span>
                  {approval.resolvedAt ? (
                    <span className="kb-decision-summary__time">
                      {formatRelative(approval.resolvedAt, now, lang)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {expand.render && !selectionMode ? (
        <div
          className={`kb-card-expand${expand.revealed ? ' kb-card-expand--open' : ''}${
            expand.leaving ? ' kb-card-expand--leaving' : ''
          }`}
        >
          <div className="kb-card-expand__clip">
            <div className="kb-card-expanded" id={`kb-exp-${card.id}`}>
              <div className="kb-exp-head">
                <span>{t('card.importantNodes')}</span>
                {card.agent?.name ? (
                  <span className="kb-exp-agent">{describeCardAgent(card.agent)?.label ?? card.agent.name}</span>
                ) : null}
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
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
