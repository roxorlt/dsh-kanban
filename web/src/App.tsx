import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Activity, Board, BoardSummary, Card, ColumnId, SessionRow } from './types';
import { KanbanApiError, api } from './api';
import { bridge, useBridgeState } from './bridge';
import type { HostInfo } from './types';
import { I18nContext, readStoredLang, resolveLang, storeLang, translate } from './i18n';
import type { I18nKey, Lang, TranslateVars } from './i18n';
import { copyText } from './lib/clipboard';
import { hasActiveFilters, EMPTY_FILTERS, extractLabels, extractProjects, filterCards } from './lib/filter';
import type { CardFilters } from './lib/filter';
import { groupCardsByColumn, type ColumnGroups } from './lib/grouping';
import { COLUMNS, COLUMN_OF_STATUS, STATUS_OF_COLUMN, isWarningStatus } from './lib/status';
import { useMediaQuery } from './lib/useMediaQuery';
import { useRealtime } from './lib/useRealtime';
import { BoardView } from './components/BoardView';
import { CardFormModal } from './components/CardFormModal';
import type { CardFormValues } from './components/CardFormModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DetailDrawer } from './components/DetailDrawer';
import { EmptyState, ErrorState, SkeletonBoard } from './components/feedback';
import { ListView } from './components/ListView';
import { ToastRegion, useToasts } from './components/Toast';
import { Toolbar } from './components/Toolbar';
import type { SyncState, ViewMode } from './components/Toolbar';
import type { ApprovalDecision } from './components/ApprovalPanel';
import type { Approval, ApprovalOption } from './types';
import type { CardActionHandlers, Placement } from './components/types';

const VIEW_STORAGE_KEY = 'dsh-kanban.view';
const EMPTY_GROUPS: ColumnGroups = { backlog: [], running: [], needs_you: [], done: [] };

interface Snapshot {
  boards: BoardSummary[];
  board: Board | null;
  cards: Card[];
  activities: Activity[];
  revision: number;
}

interface LoadError {
  message: string;
  code: string;
}

type FormState =
  | { mode: 'create'; column: ColumnId }
  | { mode: 'edit'; card: Card };

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
  const t = useCallback(
    (key: I18nKey, vars?: TranslateVars) => translate(lang, key, vars),
    [lang],
  );
  const i18nValue = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);

  // ------------------------------------------------------------------ 数据
  const [snapshot, setSnapshot] = useState<Snapshot>({ boards: [], board: null, cards: [], activities: [], revision: -1 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const boardIdRef = useRef<string | null>(null);
  const notifyRef = useRef<(text: string, tone?: 'info' | 'success' | 'error') => void>(() => undefined);
  const { toasts, notify, dismiss } = useToasts();
  notifyRef.current = notify;
  const [announcement, setAnnouncement] = useState('');
  const announce = useCallback((text: string) => {
    setAnnouncement('');
    window.requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) setRefreshing(true);
    try {
      const payload = await api.getState(boardIdRef.current ?? undefined);
      boardIdRef.current = payload.board?.id ?? null;
      setSnapshot({
        boards: payload.boards ?? [],
        board: payload.board ?? null,
        cards: payload.cards ?? [],
        activities: payload.activities ?? [],
        revision: payload.revision ?? 0,
      });
      setLoadError(null);
    } catch (error) {
      const next = toLoadError(error);
      if (!silent) setLoadError(next);
      else notifyRef.current(next.message, 'error');
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
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
  const [view, setView] = useState<ViewMode>(readStoredView);
  const [filters, setFilters] = useState<CardFilters>(EMPTY_FILTERS);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Card | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [activeColumn, setActiveColumn] = useState<ColumnId>('running');
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleViewChange = useCallback((next: ViewMode) => {
    setView(next);
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

  // ------------------------------------------------------------------ 时间线
  const baseActivitiesByCard = useMemo(() => {
    const map: Record<string, Activity[]> = {};
    for (const activity of snapshot.activities) {
      (map[activity.cardId] ??= []).push(activity);
    }
    return map;
  }, [snapshot.activities]);
  const [extraActivities, setExtraActivities] = useState<Record<string, Activity[]>>({});
  const activitiesByCard = useMemo(() => {
    const merged: Record<string, Activity[]> = { ...baseActivitiesByCard };
    for (const [cardId, list] of Object.entries(extraActivities)) {
      if (!merged[cardId]?.length) merged[cardId] = list;
    }
    return merged;
  }, [baseActivitiesByCard, extraActivities]);
  const requestedActivities = useRef<Set<string>>(new Set());
  const lastActivityRevision = useRef<number>(-1);

  // 展开/打开卡片时按需拉时间线；revision 变化后对当前可见卡片重新拉取。
  useEffect(() => {
    const ids = new Set<string>(expandedIds);
    if (activeCardId) ids.add(activeCardId);
    const revisionChanged = lastActivityRevision.current !== snapshot.revision;
    if (revisionChanged) {
      lastActivityRevision.current = snapshot.revision;
      requestedActivities.current.clear();
    }
    for (const cardId of ids) {
      const cached = (activitiesByCard[cardId]?.length ?? 0) > 0;
      if (cached && !revisionChanged) continue;
      if (!revisionChanged && requestedActivities.current.has(cardId)) continue;
      requestedActivities.current.add(cardId);
      void api
        .getCardActivities(cardId)
        .then((list) => {
          if (list.length) setExtraActivities((current) => ({ ...current, [cardId]: list }));
        })
        .catch(() => undefined);
    }
  }, [snapshot.revision, expandedIds, activeCardId, activitiesByCard]);

  useEffect(() => {
    if (!activeCardId) return;
    if (snapshot.cards.some((card) => card.id === activeCardId)) return;
    setActiveCardId(null);
  }, [snapshot.cards, activeCardId]);

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
      const optimistic = applyOptimisticMove(current, cardId, column, placement);
      setSnapshot(optimistic);
      try {
        await api.moveCard(cardId, column, {
          version: card.version,
          ...(placement?.beforeId ? { beforeId: placement.beforeId } : {}),
          ...(placement?.afterId ? { afterId: placement.afterId } : {}),
        });
        const movedText = t('toast.moved', { column: t(`column.${column}` as I18nKey) });
        notifyToast(movedText, 'success');
        announce(movedText);
        if (column === 'needs_you' && !card.approvals.some((approval) => approval.status === 'pending')) {
          notifyToast(t('card.pendingApproval'), 'info');
        }
        await refresh({ silent: true });
      } catch (error) {
        setSnapshot(previous);
        const message = error instanceof KanbanApiError && error.code === 'VERSION_CONFLICT'
          ? t('toast.versionConflict')
          : t('toast.moveFailed');
        notifyToast(message, 'error');
        await refresh({ silent: true });
      }
    },
    [notifyToast, refresh, t],
  );

  const handleResolveApproval = useCallback(
    async (
      card: Card,
      approval: Approval,
      option: ApprovalOption,
      comment: string,
      decision: ApprovalDecision,
    ) => {
      setResolvingApprovalId(approval.id);
      try {
        await api.resolveApproval(card.id, approval.id, option.id, comment || undefined);
        const header = decision === 'approve' ? '已批准' : '已拒绝';
        const note = comment ? `\n备注：${comment}` : '';
        const text = `【看板·审批】${header}「${approval.title}」：${option.label}${note}`;
        const sessionResult = await sendToSession({
          text,
          ...(approval.sessionId ? { sessionId: approval.sessionId } : card.sessionIds[0] ? { sessionId: card.sessionIds[0] } : {}),
          ...(card.cwd ? { cwd: card.cwd } : {}),
        });
        if (sessionResult.ok) {
          notifyToast(t('toast.approvalResolved'), 'success');
          announce(`${t('toast.approvalResolved')}：${approval.title}`);
        } else {
          notifyToast(sessionResult.error ?? t('toast.sessionFailed'), 'error');
        }
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.approvalFailed'), 'error');
        await refresh({ silent: true });
      } finally {
        setResolvingApprovalId(null);
      }
    },
    [notifyToast, refresh, sendToSession, t],
  );

  const handleReply = useCallback(
    async (card: Card, text: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await api.addComment(card.id, text);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : t('composer.replyFailed') };
      }
      const prefixed = `【看板·卡片「${card.title}」】\n${text}`;
      const result = await sendToSession({
        text: prefixed,
        ...(card.sessionIds[0] ? { sessionId: card.sessionIds[0] } : {}),
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

  const handleRetry = useCallback(
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

  const handleCreateCard = useCallback(() => {
    setFormError(null);
    setFormState({ mode: 'create', column: mobile ? activeColumn : 'backlog' });
  }, [activeColumn, mobile]);

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
    [formState, notifyToast, refresh, snapshot.board, t],
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
  }, [activeCardId, archiveTarget, notifyToast, refresh, t]);

  const actions = useMemo<CardActionHandlers>(
    () => ({
      onToggleExpanded: handleToggleExpanded,
      onOpenDetail: handleOpenDetail,
      onEdit: handleEdit,
      onArchive: handleArchiveRequest,
      onMove: (cardId, column, placement) => void handleMove(cardId, column, placement),
      onResolveApproval: (card, approval, option, comment, decision) =>
        void handleResolveApproval(card, approval, option, comment, decision),
      onReply: handleReply,
      onRetry: handleRetry,
      onSessionClick: handleSessionClick,
    }),
    [
      handleArchiveRequest,
      handleEdit,
      handleMove,
      handleOpenDetail,
      handleReply,
      handleResolveApproval,
      handleRetry,
      handleSessionClick,
      handleToggleExpanded,
    ],
  );

  const shared = useMemo(
    () => ({
      now,
      activitiesByCard,
      sessions,
      expandedIds,
      resolvingApprovalId,
      activeCardId,
    }),
    [now, activitiesByCard, sessions, expandedIds, resolvingApprovalId, activeCardId],
  );

  const totalCards = snapshot.cards.filter((card) => !card.archived).length;
  const runningCount = snapshot.cards.filter((card) => card.status === 'running' && !card.archived).length;
  const toggleLang = useCallback(() => setLang(lang === 'zh' ? 'en' : 'zh'), [lang, setLang]);
  const syncState: SyncState =
    bridgeState.mode === 'standalone'
      ? 'standalone'
      : loadError
        ? 'reconnecting'
        : loading && !snapshot.board
          ? 'connecting'
          : 'connected';
  const syncLabel =
    syncState === 'standalone'
      ? t('app.syncStandalone')
      : syncState === 'connecting'
        ? t('app.syncConnecting')
        : syncState === 'reconnecting'
          ? t('app.syncReconnecting')
          : t('app.syncConnected');

  // 键盘快捷键：N 新建（输入类元素内不触发）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        handleCreateCard();
      } else if (key === 'b') {
        event.preventDefault();
        handleViewChange('board');
      } else if (key === 'l') {
        event.preventDefault();
        handleViewChange('list');
      } else if (event.key === '/') {
        event.preventDefault();
        document.getElementById('kb-search-input')?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCreateCard, handleViewChange]);

  // ------------------------------------------------------------------ 渲染
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
          groups={groups}
          cards={filteredCards}
          shared={shared}
          actions={actions}
          onCreateInColumn={(column) => {
            setFormError(null);
            setFormState({ mode: 'create', column });
          }}
        />
      );
    }
    return (
      <BoardView
        board={snapshot.board}
        groups={groups}
        cards={filteredCards}
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
        filtering={hasActiveFilters(filters)}
        onClearFilters={() => setFilters({ query: '', project: null, label: null })}
      />
    );
  })();

  return (
    <I18nContext.Provider value={i18nValue}>
      <div className="kb-app-scope">
        <Toolbar
          boardName={snapshot.board?.name ?? t('app.boardFallback')}
          cardCount={totalCards}
          view={view}
          onViewChange={handleViewChange}
          filters={filters}
          onFiltersChange={setFilters}
          projects={projects}
          labels={labels}
          lang={lang}
          onToggleLang={toggleLang}
          onNewCard={handleCreateCard}
          onRefresh={() => void refresh()}
          refreshing={refreshing}
          syncState={syncState}
          runningCount={runningCount}
        />
        <main className={`kb-main${loading ? ' kb-main--loading' : ''}`}>{main}</main>
        <footer className="kb-statusbar">
          <span className={`kb-dot kb-dot--${syncState === 'connected' ? 'success' : syncState === 'reconnecting' ? 'warn' : syncState === 'connecting' ? 'business' : 'tertiary'}`} aria-hidden="true" />
          <span>{syncLabel}</span>
          <span className="kb-statusbar__spacer" />
          {bridgeState.mode === 'standalone' ? (
            <span className="kb-statusbar__mock">
              <span className="kb-kbd">preview</span>
            </span>
          ) : null}
          <span>{t('app.cardCountTotal', { count: totalCards })}</span>
          <span aria-hidden="true">·</span>
          <span>
            <span className="kb-kbd">⌘K</span> {t('a11y.search')}
          </span>
          <span>
            <span className="kb-kbd">N</span> {t('app.newCard')}
          </span>
        </footer>

        {activeCard ? (
          <DetailDrawer
            card={activeCard}
            boardName={snapshot.board?.name ?? t('app.boardFallback')}
            activities={activitiesByCard[activeCard.id]}
            sessions={sessions}
            embedded={embedded}
            now={now}
            resolvingApprovalId={resolvingApprovalId}
            onClose={() => setActiveCardId(null)}
            actions={actions}
            onReply={handleReply}
            onBindSession={(card, sessionId) => void handleBindSession(card, sessionId)}
            onUnbindSession={(card, sessionId) => void handleUnbindSession(card, sessionId)}
            onOpenSession={(sessionId) => void handleOpenSession(sessionId)}
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

        <div className="kb-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
        <ToastRegion toasts={toasts} onDismiss={dismiss} />
      </div>
    </I18nContext.Provider>
  );
}

/** 供测试引用：看板是否应显示警示（blocked/failed 归入待你确认列）。 */
export function shouldWarn(card: Card): boolean {
  return isWarningStatus(card.status);
}
