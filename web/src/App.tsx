import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Approval, Board, BoardSummary, Card, ColumnId, SessionRow } from './types';
import { KanbanApiError, api } from './api';
import { bridge, nextThemePreference, useBridgeState } from './bridge';
import type { HostInfo } from './types';
import { I18nContext, readStoredLang, resolveLang, storeLang, translate } from './i18n';
import type { I18nKey, Lang, TranslateVars } from './i18n';
import { copyText } from './lib/clipboard';
import { hasActiveFilters, EMPTY_FILTERS, extractLabels, extractProjects, filterCards } from './lib/filter';
import type { CardFilters } from './lib/filter';
import { countByColumn, groupCardsByColumn } from './lib/grouping';
import type { ColumnGroups } from './lib/grouping';
import { COLUMN_OF_STATUS, COLUMNS, STATUS_OF_COLUMN } from './lib/status';
import { doneCardsOf } from './lib/listGroups';
import type { ListGroupBy } from './lib/listGroups';
import { applyPage, EMPTY_FEED } from './lib/activities';
import type { ActivityFeed } from './lib/activities';
import { useMediaQuery } from './lib/useMediaQuery';
import { useRealtime } from './lib/useRealtime';
import { closeTopOverlay } from './lib/overlayStack';
import { BoardView } from './components/BoardView';
import { ApprovalDraftModal } from './components/ApprovalDraftModal';
import type { ApprovalDraftValues } from './components/ApprovalDraftModal';
import { CardFormModal } from './components/CardFormModal';
import type { CardFormValues } from './components/CardFormModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DetailDrawer } from './components/DetailDrawer';
import { EmptyState, ErrorState, SkeletonBoard } from './components/feedback';
import { HelpDialog } from './components/HelpDialog';
import { ListView } from './components/ListView';
import { ToastRegion, useToasts } from './components/Toast';
import { Toolbar } from './components/Toolbar';
import type { SyncState, ViewMode } from './components/Toolbar';
import type { ApprovalDecision } from './components/ApprovalPanel';
import type { CardActionHandlers, Placement } from './components/types';

const VIEW_STORAGE_KEY = 'dsh-kanban.view';
const EMPTY_GROUPS: ColumnGroups = { backlog: [], running: [], needs_you: [], done: [] };

interface Snapshot {
  boards: BoardSummary[];
  board: Board | null;
  cards: Card[];
  revision: number;
}

interface LoadError {
  message: string;
  code: string;
}

type FormState =
  | { mode: 'create'; column: ColumnId }
  | { mode: 'edit'; card: Card };

interface UnsentDecision {
  cardId: string;
  cardTitle: string;
  cwd?: string;
  text: string;
  reason: 'no_session' | 'not_found';
}

interface ApprovalDraftState {
  card: Card;
  previous: Snapshot;
  fromColumn: ColumnId;
  busy: boolean;
  error: string | null;
}

function readStoredView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function storeView(view: ViewMode): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    /* 私密模式忽略 */
  }
}

function toLoadError(error: unknown): LoadError {
  if (error instanceof KanbanApiError) return { message: error.message, code: error.code };
  return { message: error instanceof Error ? error.message : String(error), code: 'NETWORK' };
}

/** 乐观更新：卡片换列 + cardOrder 重排；失败由调用方整体回滚。 */
function applyOptimisticMove(
  snapshot: Snapshot,
  cardId: string,
  column: ColumnId,
  placement?: Placement,
): Snapshot {
  if (!snapshot.board) return snapshot;
  const targetStatus = STATUS_OF_COLUMN[column];
  const cards = snapshot.cards.map((card) =>
    card.id === cardId ? { ...card, status: targetStatus, updatedAt: Date.now() } : card,
  );
  const cardOrder: Record<ColumnId, string[]> = { backlog: [], running: [], needs_you: [], done: [] };
  for (const key of COLUMNS) {
    cardOrder[key] = (snapshot.board.cardOrder?.[key] ?? []).filter((id) => id !== cardId);
  }
  const target = cardOrder[column];
  let index = 0;
  if (placement?.beforeId) {
    const found = target.indexOf(placement.beforeId);
    index = found >= 0 ? found : target.length;
  } else if (placement?.afterId) {
    const found = target.indexOf(placement.afterId);
    index = found >= 0 ? found + 1 : 0;
  }
  target.splice(index, 0, cardId);
  return { ...snapshot, cards, board: { ...snapshot.board, cardOrder } };
}

export function App() {
  const bridgeState = useBridgeState();
  const embedded = bridgeState.mode === 'embedded';
  const mobile = useMediaQuery('(max-width: 719px)');

  // ------------------------------------------------------------------ i18n
  const [lang, setLangState] = useState<Lang>(() => resolveLang(undefined, readStoredLang()));
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  useEffect(() => {
    if (readStoredLang()) return;
    const locale = hostInfo?.locale ?? bridgeState.host?.locale;
    if (locale) setLangState(locale);
  }, [hostInfo?.locale, bridgeState.host?.locale]);
  const setLang = useCallback((next: Lang) => {
    storeLang(next);
    setLangState(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);
  const t = useCallback((key: I18nKey, vars?: TranslateVars) => translate(lang, key, vars), [lang]);
  const i18nValue = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);

  // ------------------------------------------------------------------ 数据
  const [snapshot, setSnapshot] = useState<Snapshot>({
    boards: [],
    board: null,
    cards: [],
    revision: -1,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const boardIdRef = useRef<string | null>(null);
  const notifyRef = useRef<(text: string, tone?: 'info' | 'success' | 'error') => void>(() => undefined);
  const { toasts, notify, dismiss } = useToasts();
  notifyRef.current = notify;
  const [helpOpen, setHelpOpen] = useState(false);
  const appRef = useRef<HTMLDivElement | null>(null);
  const [unsentDecision, setUnsentDecision] = useState<UnsentDecision | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const announce = useCallback((text: string) => {
    setAnnouncement('');
    window.requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    try {
      const payload = await api.getState(boardIdRef.current ?? undefined);
      boardIdRef.current = payload.board?.id ?? null;
      setSnapshot({
        boards: payload.boards ?? [],
        board: payload.board ?? null,
        cards: payload.cards ?? [],
        revision: payload.revision ?? 0,
      });
      setLoadError(null);
    } catch (error) {
      const next = toLoadError(error);
      setLoadError(next);
      if (silent) notifyRef.current(next.message, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime({
    enabled: embedded ? bridgeState.visible : true,
    revision: snapshot.revision,
    onRefresh: () => void refresh({ silent: true }),
  });

  // ------------------------------------------------------------------ 时间线分页缓存
  const [feeds, setFeeds] = useState<Record<string, ActivityFeed>>({});
  const feedsRef = useRef(feeds);
  feedsRef.current = feeds;
  const feedInFlight = useRef<Set<string>>(new Set());

  const fetchFeed = useCallback(async (cardId: string, options: { reset?: boolean; limit?: number } = {}) => {
    if (feedInFlight.current.has(cardId)) return;
    feedInFlight.current.add(cardId);
    const reset = options.reset ?? false;
    const limit = options.limit ?? 20;
    const before = reset ? undefined : feedsRef.current[cardId]?.nextBefore;
    setFeeds((current) => ({
      ...current,
      [cardId]: {
        ...(reset ? EMPTY_FEED : current[cardId] ?? EMPTY_FEED),
        items: reset ? [] : current[cardId]?.items ?? [],
        loading: true,
      },
    }));
    try {
      const page = await api.getCardActivities(cardId, {
        limit,
        ...(before ? { before } : {}),
      });
      setFeeds((current) => ({
        ...current,
        [cardId]: applyPage(current[cardId] ?? EMPTY_FEED, page, { reset }),
      }));
    } catch (error) {
      setFeeds((current) => ({
        ...current,
        [cardId]: {
          ...(current[cardId] ?? EMPTY_FEED),
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      feedInFlight.current.delete(cardId);
    }
  }, []);

  const loadEarlier = useCallback(
    (cardId: string) => {
      void fetchFeed(cardId, { limit: 20 });
    },
    [fetchFeed],
  );

  // ------------------------------------------------------------------ 会话 / 宿主
  const [fallbackSessions, setFallbackSessions] = useState<SessionRow[]>([]);
  useEffect(() => {
    if (!embedded) return;
    let cancelled = false;
    bridge
      .request('app.info')
      .then((info) => {
        if (!cancelled) setHostInfo(info);
      })
      .catch(() => undefined);
    bridge
      .request('sessions.list')
      .then((data) => {
        if (!cancelled) setFallbackSessions(data.sessions ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [embedded]);

  const sessions = bridgeState.sessions.length ? bridgeState.sessions : fallbackSessions;

  // ------------------------------------------------------------------ 视图状态
  const [view, setViewState] = useState<ViewMode>(readStoredView);
  const [filters, setFilters] = useState<CardFilters>(EMPTY_FILTERS);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Card | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [approvalDraft, setApprovalDraft] = useState<ApprovalDraftState | null>(null);
  const [activeColumn, setActiveColumn] = useState<ColumnId>('running');
  const [listGroupBy, setListGroupBy] = useState<ListGroupBy>('status');
  const [doneOpen, setDoneOpen] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleViewChange = useCallback((next: ViewMode) => {
    setViewState(next);
    storeView(next);
  }, []);

  const filteredCards = useMemo(() => filterCards(snapshot.cards, filters), [snapshot.cards, filters]);
  const groups = useMemo(
    () => (snapshot.board ? groupCardsByColumn(filteredCards, snapshot.board.cardOrder) : EMPTY_GROUPS),
    [filteredCards, snapshot.board],
  );
  const projects = useMemo(() => extractProjects(snapshot.cards), [snapshot.cards]);
  const labels = useMemo(() => extractLabels(snapshot.cards), [snapshot.cards]);
  const activeCard = activeCardId ? snapshot.cards.find((card) => card.id === activeCardId) ?? null : null;
  const doneTotal = useMemo(() => doneCardsOf(snapshot.cards).length, [snapshot.cards]);
  const needsYouCount = countByColumn(snapshot.cards).needs_you;
  const sessionsRunning = snapshot.cards.filter((card) => card.status === 'running' && !card.archived).length;

  // 首次有数据时把移动端默认列指向最需要看的列
  const pickedInitialColumn = useRef(false);
  useEffect(() => {
    if (pickedInitialColumn.current || !snapshot.board) return;
    pickedInitialColumn.current = true;
    const counts: Record<ColumnId, number> = { backlog: 0, running: 0, needs_you: 0, done: 0 };
    for (const card of snapshot.cards) {
      if (!card.archived) counts[COLUMN_OF_STATUS[card.status]] += 1;
    }
    setActiveColumn(counts.needs_you > 0 ? 'needs_you' : counts.running > 0 ? 'running' : 'backlog');
  }, [snapshot.board, snapshot.cards]);

  useEffect(() => {
    if (!activeCardId) return;
    if (snapshot.cards.some((card) => card.id === activeCardId)) return;
    setActiveCardId(null);
  }, [snapshot.cards, activeCardId]);

  const lastFeedRevision = useRef(-1);
  useEffect(() => {
    const first = lastFeedRevision.current === -1;
    if (lastFeedRevision.current === snapshot.revision) return;
    lastFeedRevision.current = snapshot.revision;
    if (first) return;
    const ids = new Set<string>(expandedIds);
    if (activeCardId) ids.add(activeCardId);
    for (const id of ids) {
      const current = feedsRef.current[id];
      if (!current) continue;
      void fetchFeed(id, { reset: true, limit: Math.max(20, current.items.length) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.revision]);

  useEffect(() => {
    const ids = new Set<string>(expandedIds);
    if (activeCardId) ids.add(activeCardId);
    for (const id of ids) {
      const current = feedsRef.current[id];
      if (!current || (current.items.length === 0 && !current.loading && !current.error)) {
        void fetchFeed(id, { reset: true, limit: 20 });
      }
    }
  }, [expandedIds, activeCardId, fetchFeed]);


  // ------------------------------------------------------------------ 动作
  const notifyToast = useCallback(
    (text: string, tone: 'info' | 'success' | 'error' = 'info') => notify(text, tone),
    [notify],
  );

  const sendToSession = useCallback(
    async (input: { text: string; sessionId?: string; cwd?: string }): Promise<{ ok: boolean; error?: string }> => {
      if (!embedded) {
        const copied = await copyText(input.text);
        return copied ? { ok: true } : { ok: false, error: t('composer.copyFailed') };
      }
      try {
        await bridge.request('session.ensure', {
          text: input.text,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        });
        return { ok: true };
      } catch (error) {
        await copyText(input.text);
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    },
    [embedded, t],
  );

  const handleToggleExpanded = useCallback((cardId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const handleOpenDetail = useCallback((cardId: string) => {
    setActiveCardId(cardId);
  }, []);

  const handleEdit = useCallback((card: Card) => {
    setFormError(null);
    setFormState({ mode: 'edit', card });
  }, []);

  const handleArchiveRequest = useCallback((card: Card) => {
    setArchiveTarget(card);
  }, []);

  const handleMove = useCallback(
    async (cardId: string, column: ColumnId, placement?: Placement) => {
      const current = snapshotRef.current;
      const card = current.cards.find((item) => item.id === cardId);
      if (!card) return;
      const previous = current;
      const fromColumn = COLUMN_OF_STATUS[card.status];
      setSnapshot(applyOptimisticMove(current, cardId, column, placement));
      try {
        const result = await api.moveCard(cardId, column, {
          version: card.version,
          ...(placement?.beforeId ? { beforeId: placement.beforeId } : {}),
          ...(placement?.afterId ? { afterId: placement.afterId } : {}),
        });
        const movedText = t('toast.moved', { column: t(`column.${column}` as I18nKey) });
        notifyToast(movedText, 'success');
        announce(movedText);
        await refresh({ silent: true });
        const movedCard = result.card;
        if (column === 'needs_you' && !movedCard.approvals.some((approval) => approval.status === 'pending')) {
          setApprovalDraft({ card: movedCard, previous, fromColumn, busy: false, error: null });
        }
      } catch (error) {
        setSnapshot(previous);
        const message =
          error instanceof KanbanApiError && error.code === 'VERSION_CONFLICT'
            ? t('toast.versionConflict')
            : t('toast.moveFailed');
        notifyToast(message, 'error');
        await refresh({ silent: true });
      }
    },
    [announce, notifyToast, refresh, t],
  );

  const handleApprovalDraftSubmit = useCallback(
    async (values: ApprovalDraftValues) => {
      const draft = approvalDraft;
      if (!draft) return;
      setApprovalDraft({ ...draft, busy: true, error: null });
      try {
        await api.createApproval(draft.card.id, {
          title: values.title,
          detail: values.detail,
          options: [
            { id: 'continue', label: values.continueLabel, tone: 'primary' },
            { id: 'stop', label: values.stopLabel, tone: 'danger' },
          ],
          multiSelect: false,
          ...(draft.card.sessionIds[0] ? { sessionId: draft.card.sessionIds[0] } : {}),
        });
        notifyToast(t('toast.approvalCreated'), 'success');
        setApprovalDraft(null);
        await refresh({ silent: true });
      } catch (error) {
        setApprovalDraft({
          ...draft,
          busy: false,
          error: error instanceof Error ? error.message : t('toast.approvalFailed'),
        });
      }
    },
    [approvalDraft, notifyToast, refresh, t],
  );

  const handleApprovalDraftCancel = useCallback(async () => {
    const draft = approvalDraft;
    setApprovalDraft(null);
    if (!draft) return;
    setSnapshot(draft.previous);
    try {
      await api.moveCard(draft.card.id, draft.fromColumn, { version: draft.card.version });
    } catch {
      /* 回滚失败时以刷新结果为准 */
    }
    await refresh({ silent: true });
  }, [approvalDraft, refresh]);

  const handleResolveApproval = useCallback(
    async (
      card: Card,
      approval: Approval,
      optionIds: string[],
      comment: string,
      decision: ApprovalDecision,
      sessionIdOverride?: string,
    ) => {
      setResolvingApprovalId(approval.id);
      try {
        await api.resolveApproval(card.id, approval.id, optionIds, comment || undefined);
        const labels = optionIds
          .map((optionId) => approval.options.find((option) => option.id === optionId)?.label ?? optionId)
          .filter(Boolean);
        const header = decision === 'approve' ? '已批准' : '已拒绝';
        const note = comment ? `\n备注：${comment}` : '';
        const text = `【看板·审批】${header}「${approval.title}」：${labels.join('、')}${note}`;
        const sessionId = sessionIdOverride ?? approval.sessionId ?? card.sessionIds[0];
        // 审批已经写入时间线：会话缺失/失效时只做中性提示，不报错
        if (!sessionId) {
          setUnsentDecision({
            cardId: card.id,
            cardTitle: card.title,
            ...(card.cwd ? { cwd: card.cwd } : {}),
            text,
            reason: 'no_session',
          });
          notifyToast(t('toast.approvalRecordedNoSession'), 'info');
          announce(t('toast.approvalRecordedNoSession'));
        } else {
          const sessionResult = await sendToSession({
            text,
            sessionId,
            ...(card.cwd ? { cwd: card.cwd } : {}),
          });
          if (sessionResult.ok) {
            notifyToast(t('toast.approvalResolved'), 'success');
            announce(`${t('toast.approvalResolved')}：${approval.title}`);
          } else if (/SESSION_NOT_FOUND|not found|不存在|失效|invalid/i.test(sessionResult.error ?? '')) {
            setUnsentDecision({
              cardId: card.id,
              cardTitle: card.title,
              ...(card.cwd ? { cwd: card.cwd } : {}),
              text,
              reason: 'not_found',
            });
            notifyToast(t('toast.approvalRecordedInvalidSession'), 'info');
            announce(t('toast.approvalRecordedInvalidSession'));
          } else {
            notifyToast(sessionResult.error ?? t('toast.sessionFailed'), 'error');
          }
        }
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.approvalFailed'), 'error');
        await refresh({ silent: true });
      } finally {
        setResolvingApprovalId(null);
      }
    },
    [announce, notifyToast, refresh, sendToSession, t],
  );

  /** 把没发出去的决定补发：新建会话 → 绑定到卡片 → session.ensure。 */
  const handleResendDecision = useCallback(async () => {
    const pending = unsentDecision;
    if (!pending) return;
    try {
      const created = await bridge.request('session.create', {
        ...(pending.cwd ? { cwd: pending.cwd } : {}),
        title: pending.cardTitle,
      });
      await api.bindSession(pending.cardId, created.sessionId);
      await bridge.request('session.ensure', {
        sessionId: created.sessionId,
        text: pending.text,
        ...(pending.cwd ? { cwd: pending.cwd } : {}),
      });
      setUnsentDecision(null);
      notifyToast(t('toast.decisionResent'), 'success');
      await refresh({ silent: true });
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : t('toast.sessionFailed'), 'error');
    }
  }, [notifyToast, refresh, t, unsentDecision]);

  const handleReply = useCallback(
    async (card: Card, text: string, sessionId?: string | null): Promise<{ ok: boolean; error?: string }> => {
      try {
        await api.addComment(card.id, text);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : t('composer.replyFailed') };
      }
      const prefixed = `【看板·卡片「${card.title}」】\n${text}`;
      const targetSessionId = sessionId ?? card.sessionIds[0];
      const result = await sendToSession({
        text: prefixed,
        ...(targetSessionId ? { sessionId: targetSessionId } : {}),
        ...(card.cwd ? { cwd: card.cwd } : {}),
      });
      await refresh({ silent: true });
      if (!result.ok) {
        notifyToast(result.error ?? t('composer.replyFailed'), 'error');
        return { ok: false, error: result.error };
      }
      if (!embedded) notifyToast(t('composer.standaloneHint'), 'info');
      else notifyToast(t('toast.saved'), 'success');
      return { ok: true };
    },
    [embedded, notifyToast, refresh, sendToSession, t],
  );

  const handleReopen = useCallback(
    async (card: Card) => {
      try {
        await api.moveCard(card.id, 'running', { version: card.version });
        notifyToast(t('toast.reopened'), 'success');
        announce(t('toast.reopened'));
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.moveFailed'), 'error');
        await refresh({ silent: true });
      }
    },
    [announce, notifyToast, refresh, t],
  );

  const handleBindSession = useCallback(
    async (card: Card, sessionId: string) => {
      try {
        await api.bindSession(card.id, sessionId);
        notifyToast(t('toast.sessionBound'), 'success');
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.sessionFailed'), 'error');
      }
    },
    [notifyToast, refresh, t],
  );

  const handleSetPrimary = useCallback(
    async (card: Card, sessionId: string) => {
      try {
        await api.bindSession(card.id, sessionId);
        notifyToast(t('toast.primarySet'), 'success');
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.sessionFailed'), 'error');
      }
    },
    [notifyToast, refresh, t],
  );

  const handleUnbindSession = useCallback(
    async (card: Card, sessionId: string) => {
      try {
        await api.unbindSession(card.id, sessionId);
        notifyToast(t('toast.sessionUnbound'), 'success');
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.sessionFailed'), 'error');
      }
    },
    [notifyToast, refresh, t],
  );

  const handleOpenSession = useCallback(
    async (sessionId: string) => {
      try {
        await bridge.request('session.open', { sessionId });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.sessionFailed'), 'error');
      }
    },
    [notifyToast, t],
  );

  const handleCreateSession = useCallback(
    async (card: Card) => {
      try {
        const created = await bridge.request('session.create', {
          ...(card.cwd ? { cwd: card.cwd } : {}),
          ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
          title: card.title,
        });
        await api.bindSession(card.id, created.sessionId);
        notifyToast(t('toast.sessionBound'), 'success');
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.sessionFailed'), 'error');
      }
    },
    [notifyToast, refresh, t],
  );

  const handleRestart = useCallback(
    (card: Card) => {
      notifyToast(t('toast.retried'), 'success');
      announce(t('toast.retried'));
      void handleMove(card.id, 'running');
    },
    [announce, handleMove, notifyToast, t],
  );

  const handleSessionClick = useCallback(
    (card: Card) => {
      const sessionId = card.sessionIds[0];
      if (sessionId && embedded) void handleOpenSession(sessionId);
      else setActiveCardId(card.id);
    },
    [embedded, handleOpenSession],
  );

  const handleCreateCard = useCallback(() => {
    setFormError(null);
    setFormState({ mode: 'create', column: mobile ? activeColumn : 'backlog' });
  }, [activeColumn, mobile]);

  const handleViewAllDone = useCallback(() => {
    handleViewChange('list');
    setListGroupBy('status');
    setDoneOpen(true);
  }, [handleViewChange]);

  const handleSubmitForm = useCallback(
    async (values: CardFormValues) => {
      setFormBusy(true);
      setFormError(null);
      try {
        if (formState?.mode === 'edit') {
          const { card } = formState;
          try {
            await api.updateCard(card.id, card.version, {
              title: values.title,
              summary: values.summary,
              status: values.status,
              priority: values.priority,
              labels: values.labels,
              project: values.project || undefined,
              cwd: values.cwd || undefined,
            });
            notifyToast(t('toast.saved'), 'success');
          } catch (error) {
            if (error instanceof KanbanApiError && error.code === 'VERSION_CONFLICT') {
              notifyToast(t('toast.versionConflict'), 'error');
              await refresh({ silent: true });
            } else {
              throw error;
            }
          }
        } else if (snapshot.board) {
          await api.createCard({
            boardId: snapshot.board.id,
            title: values.title,
            summary: values.summary || undefined,
            status: values.status,
            priority: values.priority,
            labels: values.labels,
            project: values.project || undefined,
            cwd: values.cwd || undefined,
          });
          notifyToast(t('toast.created'), 'success');
          announce(t('toast.created'));
        }
        setFormState(null);
        await refresh({ silent: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : t('toast.saveFailed');
        setFormError(message);
        notifyToast(message, 'error');
      } finally {
        setFormBusy(false);
      }
    },
    [announce, formState, notifyToast, refresh, snapshot.board, t],
  );

  const handleArchiveConfirm = useCallback(async () => {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    try {
      await api.archiveCard(archiveTarget.id, archiveTarget.version);
      notifyToast(t('toast.archived'), 'success');
      announce(t('toast.archived'));
      setArchiveTarget(null);
      if (activeCardId === archiveTarget.id) setActiveCardId(null);
      await refresh({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('toast.archiveFailed');
      notifyToast(message, 'error');
      await refresh({ silent: true });
    } finally {
      setArchiveBusy(false);
    }
  }, [activeCardId, announce, archiveTarget, notifyToast, refresh, t]);

  const actions = useMemo<CardActionHandlers>(
    () => ({
      onToggleExpanded: handleToggleExpanded,
      onOpenDetail: handleOpenDetail,
      onEdit: handleEdit,
      onArchive: handleArchiveRequest,
      onReopen: (card) => void handleReopen(card),
      onMove: (cardId, column, placement) => void handleMove(cardId, column, placement),
      onResolveApproval: (card, approval, optionIds, comment, decision) =>
        void handleResolveApproval(card, approval, optionIds, comment, decision),
      onReply: (card, text) => handleReply(card, text),
      onRetry: handleRestart,
      onSessionClick: handleSessionClick,
    }),
    [
      handleArchiveRequest,
      handleEdit,
      handleMove,
      handleOpenDetail,
      handleReopen,
      handleReply,
      handleResolveApproval,
      handleRestart,
      handleSessionClick,
      handleToggleExpanded,
    ],
  );

  const shared = useMemo(
    () => ({
      now,
      sessions,
      expandedIds,
      resolvingApprovalId,
      activeCardId,
      feeds,
      loadEarlier,
    }),
    [now, sessions, expandedIds, resolvingApprovalId, activeCardId, feeds, loadEarlier],
  );

  const totalCards = snapshot.cards.filter((card) => !card.archived).length;
  const toggleLang = useCallback(() => setLang(lang === 'zh' ? 'en' : 'zh'), [lang, setLang]);
  const syncState: SyncState =
    bridgeState.mode === 'standalone'
      ? 'standalone'
      : loadError && snapshot.board
        ? 'reconnecting'
        : loading && !snapshot.board
          ? 'connecting'
          : 'connected';
  const inIframe = typeof window !== 'undefined' && window.parent !== window;
  const cycleTheme = useCallback(async () => {
    const next = nextThemePreference(bridgeState.themePreference);
    if (!embedded) {
      bridge.setThemePreference(next);
      return;
    }
    try {
      const result = await bridge.request('theme.set', { preference: next });
      if (result.applied) bridge.applyHostThemePreference(next);
      else bridge.setThemePreference(next);
    } catch {
      // 旧宿主没有 theme.set：退化为本地令牌兜底
      bridge.setThemePreference(next);
    }
  }, [bridgeState.themePreference, embedded]);

  // 键盘快捷键：document capture 监听（iframe 内也能生效），点击画布后聚焦 app 容器
  const focusApp = useCallback(() => {
    appRef.current?.focus({ preventScroll: true });
  }, []);

  const focusSearch = useCallback(() => {
    const input = document.getElementById('kb-search-input');
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable),
      );
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (focusSearch()) event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        // 只关最上层浮层（菜单 → 弹窗 → 抽屉），由各浮层注册到 overlayStack
        if (closeTopOverlay()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (helpOpen) {
          event.preventDefault();
          setHelpOpen(false);
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing) return;
      const key = event.key;
      if (key === '?') {
        event.preventDefault();
        setHelpOpen((current) => !current);
      } else if (key === '/') {
        if (focusSearch()) event.preventDefault();
      } else if (key.toLowerCase() === 'n') {
        event.preventDefault();
        handleCreateCard();
      } else if (key.toLowerCase() === 'b') {
        event.preventDefault();
        handleViewChange('board');
      } else if (key.toLowerCase() === 'l') {
        event.preventDefault();
        handleViewChange('list');
      } else if (key.toLowerCase() === 't') {
        event.preventDefault();
        void cycleTheme();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [cycleTheme, focusSearch, handleCreateCard, handleViewChange, helpOpen]);

  const handleRootPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a, [tabindex]')) return;
      focusApp();
    },
    [focusApp],
  );

  const main = (() => {
    if (loading && !snapshot.board) return <SkeletonBoard />;
    if (loadError && !snapshot.board) {
      return (
        <ErrorState
          title={t('app.loadErrorTitle')}
          hint={t('app.loadErrorHint')}
          code={loadError.code}
          retryLabel={t('app.retry')}
          onRetry={() => void refresh()}
        />
      );
    }
    if (!snapshot.board) {
      return <EmptyState title={t('empty.board')} hint={t('empty.boardHint')} />;
    }
    if (view === 'list') {
      return (
        <ListView
          cards={filteredCards}
          cardOrder={snapshot.board.cardOrder}
          groupBy={listGroupBy}
          onGroupByChange={setListGroupBy}
          doneOpen={doneOpen}
          onDoneOpenChange={setDoneOpen}
          shared={shared}
          actions={actions}
          filtering={hasActiveFilters(filters)}
          onClearFilters={() => setFilters({ query: '', project: null, label: null })}
        />
      );
    }
    return (
      <BoardView
        board={snapshot.board}
        groups={groups}
        cards={filteredCards}
        doneTotal={doneTotal}
        shared={shared}
        actions={actions}
        mobile={mobile}
        activeColumn={activeColumn}
        onActiveColumnChange={setActiveColumn}
        onCreateInColumn={(column) => {
          setFormError(null);
          setFormState({ mode: 'create', column });
        }}
        onMoveWithPlacement={(cardId, column, placement) => void handleMove(cardId, column, placement)}
        onViewAllDone={handleViewAllDone}
        filtering={hasActiveFilters(filters)}
        onClearFilters={() => setFilters({ query: '', project: null, label: null })}
      />
    );
  })();

  return (
    <I18nContext.Provider value={i18nValue}>
      <div
        ref={appRef}
        className={`kb-app-scope${inIframe ? ' kb-app--embedded' : ''}`}
        tabIndex={-1}
        style={{ '--kb-host-inset-top': `${bridgeState.insets.top}px` } as CSSProperties}
        onPointerDown={handleRootPointerDown}
      >
        <Toolbar
          boardName={snapshot.board?.name ?? t('app.boardFallback')}
          totalCards={totalCards}
          needsYouCount={needsYouCount}
          sessionsRunning={sessionsRunning}
          view={view}
          onViewChange={handleViewChange}
          filters={filters}
          onFiltersChange={setFilters}
          projects={projects}
          labels={labels}
          lang={lang}
          onToggleLang={toggleLang}
          onNewCard={handleCreateCard}
          syncState={syncState}
          syncError={loadError && snapshot.board ? loadError.message : null}
          onRetry={() => void refresh()}
          themePreference={bridgeState.themePreference}
          themeMode={bridgeState.themeMode}
          onCycleTheme={() => void cycleTheme()}
          onShowHelp={() => setHelpOpen(true)}
        />
        <main className={`kb-main${loading ? ' kb-main--loading' : ''}`}>{main}</main>
        {unsentDecision ? (
          <div className="kb-unsent-banner" role="status" aria-live="polite">
            <span className="kb-unsent-banner__text">
              {unsentDecision.reason === 'no_session'
                ? t('app.unsentNoSession')
                : t('app.unsentInvalidSession')}
            </span>
            <button type="button" className="kb-btn kb-btn--sm kb-btn--primary" onClick={() => void handleResendDecision()}>
              {unsentDecision.reason === 'no_session'
                ? t('app.createSessionAndSend')
                : t('app.rebindSession')}
            </button>
            <button
              type="button"
              className="kb-btn kb-btn--icon kb-btn--sm kb-btn--ghost"
              aria-label={t('app.dismiss')}
              onClick={() => setUnsentDecision(null)}
            >
              ×
            </button>
          </div>
        ) : null}
        <footer className="kb-statusbar">
          {bridgeState.mode === 'standalone' ? (
            <span className="kb-statusbar__mock">
              <span className="kb-kbd">preview</span>
            </span>
          ) : null}
          <span className="kb-statusbar__spacer" />
          <span>
            <span className="kb-kbd">N</span> {t('shortcut.new')}
          </span>
          <span>
            <span className="kb-kbd">B</span> {t('shortcut.board')}
          </span>
          <span>
            <span className="kb-kbd">L</span> {t('shortcut.list')}
          </span>
          <span>
            <span className="kb-kbd">⌘K</span> {t('shortcut.search')}
          </span>
          <span>
            <span className="kb-kbd">T</span> {t('shortcut.theme')}
          </span>
          <span>
            <span className="kb-kbd">?</span> {t('shortcut.help')}
          </span>
        </footer>

        {activeCard ? (
          <DetailDrawer
            card={activeCard}
            boardName={snapshot.board?.name ?? t('app.boardFallback')}
            feed={feeds[activeCard.id]}
            onLoadEarlier={() => loadEarlier(activeCard.id)}
            sessions={sessions}
            embedded={embedded}
            now={now}
            resolvingApprovalId={resolvingApprovalId}
            onClose={() => setActiveCardId(null)}
            actions={actions}
            onReply={handleReply}
            onResolveApproval={(card, approval, optionIds, comment, decision, sessionId) =>
              void handleResolveApproval(card, approval, optionIds, comment, decision, sessionId ?? undefined)
            }
            onBindSession={(card, sessionId) => void handleBindSession(card, sessionId)}
            onUnbindSession={(card, sessionId) => void handleUnbindSession(card, sessionId)}
            onOpenSession={(sessionId) => void handleOpenSession(sessionId)}
            onSetPrimary={(card, sessionId) => void handleSetPrimary(card, sessionId)}
            onCreateSession={(card) => void handleCreateSession(card)}
          />
        ) : null}

        {formState ? (
          <CardFormModal
            mode={formState.mode}
            {...(formState.mode === 'edit' ? { initial: formState.card } : {})}
            {...(formState.mode === 'create' ? { defaultColumn: formState.column } : {})}
            projects={projects}
            labels={labels}
            busy={formBusy}
            error={formError}
            onSubmit={(values) => void handleSubmitForm(values)}
            onClose={() => {
              if (!formBusy) setFormState(null);
            }}
          />
        ) : null}

        {approvalDraft ? (
          <ApprovalDraftModal
            card={approvalDraft.card}
            busy={approvalDraft.busy}
            error={approvalDraft.error}
            onSubmit={(values) => void handleApprovalDraftSubmit(values)}
            onCancel={() => void handleApprovalDraftCancel()}
          />
        ) : null}

        {archiveTarget ? (
          <ConfirmDialog
            title={t('modal.archiveTitle')}
            message={t('modal.archiveBody', { title: archiveTarget.title })}
            confirmLabel={t('modal.archiveConfirm')}
            busyLabel={t('modal.archiving')}
            busy={archiveBusy}
            onConfirm={() => void handleArchiveConfirm()}
            onClose={() => {
              if (!archiveBusy) setArchiveTarget(null);
            }}
          />
        ) : null}

        {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}

        <div className="kb-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
        <ToastRegion toasts={toasts} onDismiss={dismiss} />
      </div>
    </I18nContext.Provider>
  );
}
