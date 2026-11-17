import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Approval, Card, CardWaitCondition, SessionRow, WorkspaceRow } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { STATUS_TONE, isWarningStatus } from '../lib/status';
import { elapsedMs, formatDateTime, formatDuration, formatRelative } from '../lib/time';
import { describeCardRuntime } from '../lib/runtime';
import type { ActivityFeed } from '../lib/activities';
import { ApprovalPanel } from './ApprovalPanel';
import { ApprovalSlot } from './ApprovalSlot';
import type { ApprovalDecision, ApprovalSubmission } from './ApprovalPanel';
import { Composer } from './Composer';
import { ConfirmDialog } from './ConfirmDialog';
import { GitBranchSection } from './GitBranchSection';
import { RelationSection } from './CardRelations';
import { SessionSection } from './SessionSection';
import { AgentBadge } from './AgentBadge';
import { Timeline, TimelineLoadMore } from './Timeline';
import type { CardActionHandlers } from './types';
import type { CreateSessionOptions } from './SessionSection';
import {
  nextTargetAfterPrimaryChange,
  replyTargetOptions,
  resolveReplyTarget,
} from '../lib/replyTarget';
import { buildCardRelationIndex } from '../lib/cardRelations';
import { pushOverlay } from '../lib/overlayStack';
import { copyText } from '../lib/clipboard';
import { formatHandoffCopy } from '../lib/handoff';
import {
  IconArchive,
  IconClose,
  IconCommit,
  IconCopy,
  IconEdit,
  IconFile,
  IconImage,
  IconLink,
  IconReport,
} from './Icons';

interface DetailDrawerProps {
  card: Card;
  boardName: string;
  feed: ActivityFeed | undefined;
  onLoadEarlier: () => void;
  sessions: SessionRow[];
  workspaces: WorkspaceRow[];
  /** 用于 cwd 建议的全量卡片 */
  allCards: Card[];
  embedded: boolean;
  now: number;
  resolvingApprovalId: string | null;
  onClose: () => void;
  actions: CardActionHandlers;
  onReply: (card: Card, text: string, sessionId: string | null) => Promise<{ ok: boolean; error?: string }>;
  onResolveApproval: (
    card: Card,
    approval: Approval,
    submission: ApprovalSubmission,
    comment: string,
    decision: ApprovalDecision,
    sessionId: string | null,
  ) => void;
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void;
  onBindSession: (card: Card, sessionId: string) => void;
  onUnbindSession: (card: Card, sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onSetPrimary: (card: Card, sessionId: string) => void;
  onCreateSession: (card: Card, options: CreateSessionOptions) => void;
  /** 宿主当前已归档的会话 id */
  archivedSessionIds: ReadonlySet<string>;
  /** 宿主是否提供可逆归档（false 时隐藏归档/恢复入口） */
  archiveAvailable: boolean;
  /** 有待确认项的会话 id（原生 approval/question/plan） */
  pendingSessionIds: ReadonlySet<string>;
  onArchiveSession: (card: Card, sessionId: string) => void;
  onUnarchiveSession: (card: Card, sessionId: string) => void;
  /** v0.21.0 #16：卡片 cwd 状态（App 计算） */
  cwdState?: 'ok' | 'missing' | 'invalid';
  /** v0.21.0 #16：打开「重新绑定目录」弹窗 */
  onRebindDir?: (card: Card) => void;
  /** Super-Agent Runtime：切换自动接力开关 */
  onToggleAutoStart?: (card: Card, next: boolean) => void;
  /** Super-Agent Runtime：设置或清除等待唤醒条件 */
  onUpdateWaitCondition?: (card: Card, waitCondition: CardWaitCondition | null) => void;
  /**
   * 离场中（App 用 `usePresence` 驱动，见 docs/11-motion.md §6.2）：
   * 挂 `.kb-drawer-overlay--leaving` 跑收回过渡，并在第一帧解除焦点圈定、归还焦点。
   */
  closing?: boolean;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** ApprovalSlot 的淡出时长：与 ApprovalSlot.tsx 的 APPROVAL_EXIT_MS / base.css 的 --kb-dur-exit 同源。 */
const APPROVAL_SLOT_EXIT_MS = 140;
/** 摘掉离场审批 id 的宽限：淡出时长 + 余量，避免和 ApprovalSlot 内部卸载抢跑。 */
const APPROVAL_SLOT_PRUNE_MS = APPROVAL_SLOT_EXIT_MS + 40;
/**
 * 遮罩 backdrop-filter 的启用时点：抽屉进场 220ms（--kb-dur-slow）+ 一点余量。
 * 全屏 backdrop-filter 在动画期间每帧重新合成，是本机实测里唯一的掉帧源
 * （44 帧 9 帧 >20ms / max 49.6ms；动画期去掉后 60 帧仅 1 帧 >20ms，见 docs/11-motion.md §8）。
 * 所以进场/离场动画期间不挂 blur，静止后再恢复 DSH 的 mask-blur。
 */
const DRAWER_BLUR_SETTLE_MS = 240;

function artifactIcon(kind: string) {
  switch (kind) {
    case 'link':
      return <IconLink />;
    case 'commit':
      return <IconCommit />;
    case 'image':
      return <IconImage />;
    case 'report':
      return <IconReport />;
    default:
      return <IconFile />;
  }
}

/** 卡片详情抽屉：多会话、分页时间线、媒体素材、草稿保护（<720px 变底部 sheet）。 */
export function DetailDrawer({
  card,
  boardName,
  feed,
  onLoadEarlier,
  sessions,
  workspaces,
  allCards,
  embedded,
  now,
  resolvingApprovalId,
  onClose,
  actions,
  onReply,
  onResolveApproval,
  onNotify,
  onBindSession,
  onUnbindSession,
  onOpenSession,
  onSetPrimary,
  onCreateSession,
  archivedSessionIds,
  archiveAvailable,
  pendingSessionIds,
  onArchiveSession,
  onUnarchiveSession,
  cwdState = 'ok',
  onRebindDir,
  onToggleAutoStart,
  onUpdateWaitCondition,
  closing = false,
}: DetailDrawerProps) {
  const { t, lang } = useI18n();
  // v0.22 关系索引：用全量卡片算父子/依赖，避免详情抽屉里再请求接口
  const relations = useMemo(() => buildCardRelationIndex(allCards), [allCards]);
  const runtimeInfo = useMemo(() => describeCardRuntime(card, now), [card, now]);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  /** 打开期间被锁住的页面滚动；离场第一帧就要还回去（见下面的 closing effect） */
  const scrollLock = useRef<{ root: HTMLElement; previous: string } | null>(null);
  /** 遮罩 blur 只在进场动画播完后开启；离场立刻关掉（见 DRAWER_BLUR_SETTLE_MS） */
  const [blurSettled, setBlurSettled] = useState(false);
  const [targetSessionId, setTargetSessionId] = useState<string | null>(() =>
    resolveReplyTarget(card.sessionIds, card.sessionIds[0] ?? null),
  );
  const [composerDirty, setComposerDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [handoffCopied, setHandoffCopied] = useState(false);
  useEffect(() => {
    setHandoffCopied(false);
  }, [card.id]);

  const copyHandoff = async () => {
    if (!card.handoff) return;
    if (await copyText(formatHandoffCopy(card.handoff))) {
      setHandoffCopied(true);
      window.setTimeout(() => setHandoffCopied(false), 1600);
    }
  };

  const tone = STATUS_TONE[card.status];
  const statusKey = `status.${card.status}` as I18nKey;
  const activities = feed?.items ?? [];
  const loadingActivities = feed?.loading ?? false;
  const elapsed = elapsedMs(card, now);
  const pendingApprovals = card.approvals.filter((approval) => approval.status === 'pending');
  const resolvedApprovals = card.approvals.filter((approval) => approval.status !== 'pending');
  const checklistDone = card.checklists.filter((item) => item.done).length;
  const checklistPercent = card.checklists.length
    ? Math.round((checklistDone / card.checklists.length) * 100)
    : 0;
  const images = card.artifacts.filter((artifact) => artifact.kind === 'image' && artifact.url);
  const otherArtifacts = card.artifacts.filter((artifact) => !(artifact.kind === 'image' && artifact.url));

  useEffect(() => {
    setTargetSessionId(resolveReplyTarget(card.sessionIds, card.sessionIds[0] ?? null));
    setComposerDirty(false);
    setDiscardOpen(false);
  }, [card.id]);

  useEffect(() => {
    setTargetSessionId((current) => resolveReplyTarget(card.sessionIds, current));
  }, [card.sessionIds]);

  // —— 审批区块离场（docs/11-motion.md §6.3）——
  // 提交成功后服务端刷新会把该审批从 pendingApprovals 里移除；若直接 map pendingApprovals，
  // ApprovalSlot 会连同数据一起卸载，140ms 淡出根本没机会播。这里让 slot 列表比数据多活一拍：
  // 先喂 approval=null 让它淡出，APPROVAL_SLOT_PRUNE_MS 后才摘 id；换卡时渲染期直接重置。
  const [approvalSlotIds, setApprovalSlotIds] = useState<string[]>(() => pendingApprovals.map((item) => item.id));
  const [approvalSlotCardId, setApprovalSlotCardId] = useState(card.id);
  if (approvalSlotCardId !== card.id) {
    setApprovalSlotCardId(card.id);
    setApprovalSlotIds(pendingApprovals.map((approval) => approval.id));
  } else {
    // 新出现的审批 id 在渲染期并入（避免多一帧空白）；state 里只多留正在离场的旧 id
    const missingApprovalIds = pendingApprovals
      .map((approval) => approval.id)
      .filter((id) => !approvalSlotIds.includes(id));
    if (missingApprovalIds.length) setApprovalSlotIds([...approvalSlotIds, ...missingApprovalIds]);
  }
  const pendingApprovalKey = pendingApprovals.map((approval) => approval.id).join('|');
  useEffect(() => {
    const live = new Set(pendingApprovals.map((approval) => approval.id));
    const timer = window.setTimeout(() => {
      setApprovalSlotIds((current) => {
        const next = current.filter((id) => live.has(id));
        return next.length === current.length ? current : next;
      });
    }, APPROVAL_SLOT_PRUNE_MS);
    return () => window.clearTimeout(timer);
    // pendingApprovals 每次渲染都是新数组，不能直接做依赖；pendingApprovalKey 是 id 的稳定串
  }, [pendingApprovalKey]);

  const requestClose = () => {
    // 幂等：离场期间 Esc / 遮罩 / 关闭按钮再触发都直接忽略，避免重复 onClose 或误开草稿确认框
    if (closing) return;
    if (composerDirty) setDiscardOpen(true);
    else onClose();
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  const closingRef = useRef(closing);
  closingRef.current = closing;

  // Esc 由 App 的浮层栈统一处理（抽屉属于最上层时关闭）
  useEffect(() => pushOverlay(() => requestCloseRef.current()), []);

  // —— 焦点圈定 / 页面滚动锁定 / 离场即时释放（docs/11-motion.md §6.2）——
  // 离场由 App 的 usePresence 驱动：closing 的第一帧就解开圈定并归还焦点。
  // 不能等 180ms 后卸载——那期间焦点会留在已关闭的对话框里，页面滚动也一直被锁着。
  useEffect(() => {
    const root = document.documentElement;
    if (closing) {
      if (scrollLock.current) {
        scrollLock.current.root.style.overflow = scrollLock.current.previous;
        scrollLock.current = null;
      }
      const target = previouslyFocused.current;
      if (target && document.contains(target)) target.focus();
      // 打开抽屉的元素可能已不在文档里：焦点不能留在即将 aria-hidden 的抽屉内，
      // 否则浏览器会以「含焦点的祖先不能被 aria-hidden」为由忽略这个属性。
      if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      panelRef.current?.setAttribute('aria-hidden', 'true');
      return;
    }
    // 打开（含离场中途反向）：重新锁滚动、取消 aria-hidden，并把焦点圈回抽屉
    if (!scrollLock.current) {
      scrollLock.current = { root, previous: root.style.overflow };
      root.style.overflow = 'hidden';
    }
    // 记录/更新「焦点从哪来往哪还」：初次打开是触发元素；
    // 离场中途反向重开时用户可能已经点了别的卡，归还目标要跟着换
    if (document.activeElement instanceof HTMLElement && !panelRef.current?.contains(document.activeElement)) {
      previouslyFocused.current = document.activeElement;
    }
    panelRef.current?.removeAttribute('aria-hidden');
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();
    return () => {
      // 卸载兜底：App 没走 leaving 直接卸载时，也要把页面滚动与焦点还回去
      if (scrollLock.current) {
        scrollLock.current.root.style.overflow = scrollLock.current.previous;
        scrollLock.current = null;
      }
      const target = previouslyFocused.current;
      if (target && document.contains(target)) target.focus();
    };
  }, [closing]);

  // —— 遮罩 blur 的启用时点（性能，见 DRAWER_BLUR_SETTLE_MS）——
  // 进场动画期间保持关闭，动画结束后再开启；离场一开始就关掉（收回的 180ms 也不掉帧）。
  useEffect(() => {
    if (closing) {
      setBlurSettled(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setBlurSettled(true), DRAWER_BLUR_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 离场期间不再拦截 Tab：圈定已经解除，焦点该回到打开抽屉的元素上
      if (closingRef.current || event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const targetSession = resolveReplyTarget(card.sessionIds, targetSessionId);
  const targetOptions = replyTargetOptions(card.sessionIds, sessions);
  const targetOption = targetOptions.find((option) => option.id === targetSession) ?? targetOptions[0];
  const targetLabel = targetOption?.title ?? null;
  // 设为主会话后按设计规范 §7.5 让默认目标跟随（用户手动选过其它会话则保持）
  const handleSetPrimary = (sessionId: string) => {
    const previousPrimary = card.sessionIds[0] ?? null;
    setTargetSessionId((current) => nextTargetAfterPrimaryChange(current, previousPrimary, sessionId));
    onSetPrimary(card, sessionId);
  };

  return (
    <div
      className={`kb-drawer-overlay${closing ? ' kb-drawer-overlay--leaving' : ''}${
        blurSettled ? ' kb-drawer-overlay--settled' : ''
      }`}
      role="presentation"
      onPointerDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        ref={panelRef}
        className="kb-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-status={card.status}
      >
        <span className="kb-drawer__grabber" aria-hidden="true" />
        <header className="kb-drawer__header">
          {/* 标题区与操作按钮同排；摘要独占一行，宽度跟抽屉正文内容对齐 */}
          <div className="kb-drawer__header-row">
            <div className="kb-drawer__heading">
              <p className="kb-drawer__kicker">
                <span>{boardName}</span>
                <span aria-hidden="true"> · </span>
                <span>{t(statusKey)}</span>
                {card.project ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span>{card.project}</span>
                  </>
                ) : null}
                {card.agent?.name ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <AgentBadge agent={card.agent} />
                  </>
                ) : null}
                {isWarningStatus(card.status) ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="kb-drawer__warning">{card.currentAction ?? t(statusKey)}</span>
                  </>
                ) : null}
              </p>
              <div className="kb-drawer__title-row">
                <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
                <h2 id={titleId} className="kb-drawer__title">
                  {card.title}
                </h2>
              </div>
            </div>
            <div className="kb-drawer__header-actions">
              <button type="button" className="kb-btn kb-btn--sm kb-btn--outline" onClick={() => actions.onEdit(card)}>
                <span className="kb-icon" aria-hidden="true">
                  <IconEdit />
                </span>
                {t('card.edit')}
              </button>
              <button
                type="button"
                className="kb-btn kb-btn--icon kb-btn--ghost"
                aria-label={t('card.archive')}
                title={t('card.archive')}
                onClick={() => actions.onArchive(card)}
              >
                <span className="kb-icon" aria-hidden="true">
                  <IconArchive />
                </span>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn--icon kb-btn--ghost"
                aria-label={t('drawer.close')}
                onClick={requestClose}
              >
                <span className="kb-icon" aria-hidden="true">
                  <IconClose />
                </span>
              </button>
            </div>
          </div>
          {card.summary ? <p className="kb-drawer__summary">{card.summary}</p> : null}
        </header>

        <div className="kb-drawer__body">
          <RelationSection card={card} relations={relations} onOpenCard={actions.onOpenDetail} />

          {card.status !== 'done' && card.status !== 'canceled' ? (
            <section className="kb-drawer__section kb-drawer__runtime" aria-label={t('runtime.sectionTitle')}>
              <div className="kb-drawer__runtime-head">
                <h3 className="kb-drawer__section-title">{t('runtime.sectionTitle')}</h3>
                <span className="kb-drawer__details-meta">
                  {t('runtime.generationMeta', {
                    gen: runtimeInfo.generation,
                    nudges: runtimeInfo.nudgesUsed,
                    retries: runtimeInfo.retriesUsed,
                  })}
                </span>
              </div>
              <div className="kb-drawer__runtime-controls">
                <span
                  className={`kb-tag ${
                    runtimeInfo.watchdogState === 'stalled' || runtimeInfo.watchdogState === 'retry_exhausted'
                      ? 'kb-tag--runtime-warn'
                      : 'kb-tag--runtime'
                  }`}
                >
                  {runtimeInfo.watchdogState === 'guarding'
                    ? t('runtime.watchdogGuarding')
                    : runtimeInfo.watchdogState === 'nudged'
                      ? t('runtime.watchdogNudged', { used: runtimeInfo.nudgesUsed })
                      : runtimeInfo.watchdogState === 'stalled'
                        ? t('runtime.watchdogStalled')
                        : runtimeInfo.watchdogState === 'retrying'
                          ? t('runtime.watchdogRetrying', { used: runtimeInfo.retriesUsed })
                          : runtimeInfo.watchdogState === 'retry_exhausted'
                            ? t('runtime.watchdogRetryExhausted')
                            : t('runtime.watchdogIdle')}
                </span>
                {onToggleAutoStart ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={runtimeInfo.autoStart}
                    className={`kb-switch${runtimeInfo.autoStart ? ' kb-switch--on' : ''}`}
                    title={t('runtime.autoStartHint')}
                    onClick={() => onToggleAutoStart(card, !runtimeInfo.autoStart)}
                  >
                    <span className="kb-switch__track" aria-hidden="true">
                      <span className="kb-switch__thumb" />
                    </span>
                    <span className="kb-switch__label">{t('runtime.autoStartBadge')}</span>
                  </button>
                ) : null}
                {onUpdateWaitCondition ? (
                  runtimeInfo.waitActive ? (
                    <span className="kb-drawer__runtime-wait">
                      <span className="kb-drawer__details-meta">
                        {t('runtime.waitRemaining', {
                          remaining: formatDuration(runtimeInfo.waitActive.remainingMs, lang),
                          reason: runtimeInfo.waitActive.reason ? ` · ${runtimeInfo.waitActive.reason}` : '',
                        })}
                      </span>
                      <button
                        type="button"
                        className="kb-btn kb-btn--sm kb-btn--outline"
                        onClick={() => onUpdateWaitCondition(card, null)}
                      >
                        {t('runtime.waitClear')}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="kb-btn kb-btn--sm kb-btn--ghost"
                      onClick={() =>
                        onUpdateWaitCondition(card, {
                          kind: 'time',
                          notBefore: Date.now() + 30 * 60_000,
                          reason: '定时挂起 30m',
                        })
                      }
                    >
                      {t('runtime.waitSnooze30m')}
                    </button>
                  )
                ) : null}
              </div>
            </section>
          ) : null}

          {card.currentAction || card.progress ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">
                {card.progress ? t('drawer.progress') : t('drawer.currentAction')}
              </h3>
              {card.currentAction ? <p className="kb-drawer__text">{card.currentAction}</p> : null}
              {card.progress ? (
                <div className="kb-progress">
                  <div
                    className="kb-progress__bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(card.progress.percent ?? 0)}
                  >
                    <span
                      className="kb-progress__fill"
                      style={
                        {
                          // A-07：进度改由 transform: scaleX 驱动，值用 0–1 的 CSS 变量传给 drawer.css
                          '--kb-progress': Math.max(0, Math.min(100, card.progress.percent ?? 0)) / 100,
                        } as CSSProperties
                      }
                    />
                  </div>
                  <span className="kb-progress__label">
                    {card.progress.total ? `${card.progress.step}/${card.progress.total}` : `${card.progress.percent ?? 0}%`}
                    {card.progress.text ? ` · ${card.progress.text}` : ''}
                  </span>
                </div>
              ) : null}
            </section>
          ) : null}

          {card.result ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.result')}</h3>
              <p className="kb-drawer__text kb-drawer__text--result">{card.result}</p>
            </section>
          ) : null}

          {/* 分支 / 工作树：数据不可用、读取失败或旧服务端 404 时整块静默隐藏 */}
          <GitBranchSection card={card} sessions={sessions} />

          {/* 审批区块列表含离场的审批（approvalSlotIds 比 pendingApprovals 多活一拍，见上方注释） */}
          {approvalSlotIds.length ? (
            <section className="kb-drawer__section kb-drawer__section--approval">
              <h3 className="kb-drawer__section-title">{t('drawer.approvals')}</h3>
              {targetOptions.length > 1 && targetLabel ? (
                <p className="kb-drawer__target-hint">{t('drawer.approvalTargetHint', { session: targetLabel })}</p>
              ) : null}
              {approvalSlotIds.map((approvalId) => {
                const approval = pendingApprovals.find((item) => item.id === approvalId) ?? null;
                // 交互式审批走 ApprovalSlot：提交成功后由它保留 140ms 做「已提交」淡出（§6.3）
                return (
                  <ApprovalSlot
                    key={approvalId}
                    approval={approval}
                    busy={resolvingApprovalId === approvalId}
                    now={now}
                    inDrawer
                    onResolve={(target, submission, comment, decision) =>
                      onResolveApproval(card, target, submission, comment, decision, targetSession)
                    }
                    onValidationError={(message) => onNotify(message, 'error')}
                  />
                );
              })}
            </section>
          ) : null}

          {card.checklists.length ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.checklist')}</h3>
              <div className="kb-checklist">
                <div className="kb-checklist__head">
                  <span className="kb-checklist__count">
                    {checklistDone}/{card.checklists.length}
                  </span>
                  <div className="kb-progress__bar kb-checklist__bar">
                    <span className="kb-progress__fill" style={{ '--kb-progress': checklistPercent / 100 } as CSSProperties} />
                  </div>
                </div>
                <ul className="kb-checklist__items">
                  {card.checklists.map((item) => (
                    <li className={`kb-checklist__item${item.done ? ' kb-checklist__item--done' : ''}`} key={item.id}>
                      <span className={`kb-checkbox${item.done ? ' kb-checkbox--done' : ''}`} aria-hidden="true">
                        {item.done ? '✓' : ''}
                      </span>
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <section className="kb-drawer__section">
            <h3 className="kb-drawer__section-title">{t('drawer.timeline')}</h3>
            <div className="kb-drawer__timeline-scroll">
              {loadingActivities && !activities.length ? (
                <p className="kb-drawer__loading">
                  <span className="kb-spinner" aria-hidden="true" />
                  {t('common.loading')}
                </p>
              ) : (
                <Timeline activities={activities} now={now} variant="full" />
              )}
            </div>
            <TimelineLoadMore
              hasMore={Boolean(feed?.hasMore)}
              loading={Boolean(feed?.loading) && activities.length > 0}
              onClick={onLoadEarlier}
            />
          </section>

          {resolvedApprovals.length ? (
            <details className="kb-drawer__section kb-drawer__details">
              <summary className="kb-drawer__details-summary">
                <span className="kb-drawer__section-title">{t('drawer.approvals')}</span>
                <span className="kb-drawer__details-meta">{resolvedApprovals.length}</span>
              </summary>
              <div className="kb-drawer__details-body">
                {resolvedApprovals.map((approval) => (
                  <ApprovalPanel key={approval.id} approval={approval} busy={false} now={now} onResolve={() => undefined} />
                ))}
              </div>
            </details>
          ) : null}

          {card.artifacts.length ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.artifacts')}</h3>
              {images.length ? (
                <div className="kb-media-grid">
                  {images.map((artifact) => (
                    <a
                      className="kb-media-thumb"
                      key={artifact.id}
                      href={artifact.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={artifact.label}
                    >
                      <img src={artifact.url} alt={artifact.label} loading="lazy" referrerPolicy="no-referrer" />
                      <span>{artifact.label}</span>
                    </a>
                  ))}
                </div>
              ) : null}
              {otherArtifacts.length ? (
                <ul className="kb-artifacts">
                  {otherArtifacts.map((artifact) => {
                    const content = (
                      <>
                        <span className="kb-icon" aria-hidden="true">
                          {artifactIcon(artifact.kind)}
                        </span>
                        <span>{artifact.label}</span>
                        {artifact.path && artifact.path !== artifact.label ? (
                          <code className="kb-artifacts__path" title={artifact.path}>
                            {artifact.path}
                          </code>
                        ) : null}
                      </>
                    );
                    return (
                      <li key={artifact.id} className="kb-artifacts__item">
                        {artifact.url ? (
                          <a href={artifact.url} target="_blank" rel="noreferrer noopener">
                            {content}
                          </a>
                        ) : (
                          <span>{content}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ) : null}

          {card.handoff ? (
            <details
              className="kb-drawer__section kb-drawer__details kb-drawer__section--handoff"
              aria-label={t('handoff.title')}
              open={card.status === 'needs_you'}
            >
              <summary className="kb-drawer__details-summary">
                <span className="kb-drawer__section-title">{t('handoff.title')}</span>
                <span className="kb-drawer__details-meta">{formatDateTime(card.handoff.at, lang)}</span>
              </summary>
              <div className="kb-drawer__details-body">
                <div className="kb-drawer__section-head">
                  <p className="kb-handoff__summary">{card.handoff.summary}</p>
                  <button
                    type="button"
                    className="kb-btn kb-btn--sm kb-btn--ghost kb-handoff__copy"
                    onClick={() => void copyHandoff()}
                  >
                    <span className="kb-icon" aria-hidden="true">
                      <IconCopy />
                    </span>
                    {handoffCopied ? t('handoff.copied') : t('handoff.copy')}
                  </button>
                </div>
                {card.handoff.nextSteps ? (
                  <div className="kb-handoff__next">
                    <span className="kb-handoff__label">{t('handoff.nextSteps')}</span>
                    <p>{card.handoff.nextSteps}</p>
                  </div>
                ) : null}
                <dl className="kb-handoff__meta">
                  <div>
                    <dt>{t('handoff.writtenAt')}</dt>
                    <dd>{formatDateTime(card.handoff.at, lang)}</dd>
                  </div>
                  <div>
                    <dt>{t('handoff.sourceSession')}</dt>
                    <dd>
                      {card.handoff.sessionId
                        ? sessions.find((session) => session.id === card.handoff?.sessionId)?.title ??
                          card.handoff.sessionId
                        : t('common.none')}
                    </dd>
                  </div>
                  {card.handoff.by ? (
                    <div>
                      <dt>{t('handoff.by')}</dt>
                      <dd>{card.handoff.by.name}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            </details>
          ) : null}

          <section className="kb-drawer__section">
            <h3 className="kb-drawer__section-title">{t('drawer.sessions')}</h3>
            <SessionSection
              card={card}
              sessions={sessions}
              workspaces={workspaces}
              cards={allCards}
              embedded={embedded}
              busy={false}
              targetSessionId={targetSession}
              onOpenSession={onOpenSession}
              onBind={(sessionId) => onBindSession(card, sessionId)}
              onUnbind={(sessionId) => onUnbindSession(card, sessionId)}
              onSetPrimary={handleSetPrimary}
              onCreateSession={onCreateSession}
              archivedSessionIds={archivedSessionIds}
              archiveAvailable={archiveAvailable}
              pendingSessionIds={pendingSessionIds}
              onArchiveSession={onArchiveSession}
              onUnarchiveSession={onUnarchiveSession}
            />
          </section>

          <details className="kb-drawer__section kb-drawer__details" open={cwdState === 'invalid'}>
            <summary className="kb-drawer__details-summary">
              <span className="kb-drawer__section-title">{t('drawer.metadata')}</span>
              <span className="kb-drawer__details-meta">
                {formatDuration(elapsed, lang)} · {formatRelative(card.updatedAt, now, lang)}
              </span>
            </summary>
            <div className="kb-drawer__details-body">
              <dl className="kb-meta-grid">
                <div>
                  <dt>{t('drawer.toolCalls')}</dt>
                  <dd>{card.metadata.toolCalls}</dd>
                </div>
                <div>
                  <dt>{t('drawer.searches')}</dt>
                  <dd>{card.metadata.searches}</dd>
                </div>
                <div>
                  <dt>{t('drawer.elapsed')}</dt>
                  <dd>{formatDuration(elapsed, lang)}</dd>
                </div>
                {typeof card.metadata.tokensIn === 'number' || typeof card.metadata.tokensOut === 'number' ? (
                  <div>
                    <dt>{t('drawer.tokens')}</dt>
                    <dd>
                      {card.metadata.tokensIn ?? 0} / {card.metadata.tokensOut ?? 0}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t('drawer.createdAt')}</dt>
                  <dd>{formatDateTime(card.createdAt, lang)}</dd>
                </div>
                <div>
                  <dt>{t('drawer.updatedAt')}</dt>
                  <dd>{formatDateTime(card.updatedAt, lang)}</dd>
                </div>
                {card.startedAt ? (
                  <div>
                    <dt>{t('drawer.startedAt')}</dt>
                    <dd>{formatDateTime(card.startedAt, lang)}</dd>
                  </div>
                ) : null}
                {card.completedAt ? (
                  <div>
                    <dt>{t('drawer.completedAt')}</dt>
                    <dd>{formatDateTime(card.completedAt, lang)}</dd>
                  </div>
                ) : null}
                {/* v0.21.0 #16：工作目录一行总是显示；失效时给警示标签，可重新绑定 */}
                <div className="kb-meta-grid__wide kb-drawer__cwd-row">
                  <dt>{t('drawer.workspace')}</dt>
                  <dd>
                    {card.cwd ? (
                      <code className="kb-meta-grid__code" title={card.cwd}>
                        {card.cwd}
                      </code>
                    ) : (
                      <span className="kb-drawer__cwd-missing">{t('drawer.cwdMissing')}</span>
                    )}
                    {cwdState === 'invalid' ? (
                      <span className="kb-pill kb-pill--warn kb-drawer__cwd-invalid">{t('drawer.cwdInvalid')}</span>
                    ) : null}
                    {onRebindDir ? (
                      <button
                        type="button"
                        className="kb-btn kb-btn--sm kb-btn--ghost kb-drawer__cwd-rebind"
                        onClick={() => onRebindDir(card)}
                      >
                        {t('drawer.rebindCwd')}
                      </button>
                    ) : null}
                  </dd>
                </div>
              </dl>
            </div>
          </details>
        </div>

        <footer className="kb-drawer__footer">
          <Composer
            embedded={embedded}
            targets={targetOptions}
            targetSessionId={targetSession}
            onTargetChange={setTargetSessionId}
            onSubmit={(text, sessionId) => onReply(card, text, sessionId)}
            autoFocus={false}
            onDirtyChange={setComposerDirty}
          />
        </footer>
      </div>

      {discardOpen ? (
        <ConfirmDialog
          title={t('common.discardTitle')}
          message={t('common.discardBody')}
          confirmLabel={t('common.discardConfirm')}
          busyLabel={t('common.discardConfirm')}
          onConfirm={() => {
            setDiscardOpen(false);
            setComposerDirty(false);
            onClose();
          }}
          onClose={() => setDiscardOpen(false)}
        />
      ) : null}
    </div>
  );
}
