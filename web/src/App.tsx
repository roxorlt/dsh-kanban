import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type {
  Approval,
  Board,
  BoardSummary,
  Card,
  ColumnId,
  SessionActivityEntry,
  SessionRow,
  WorkspaceRow,
} from './types';
import { KanbanApiError, api } from './api';
import type { SessionArchiveBatchResult } from './api';
import { BridgeUnavailableError, bridge, nextThemePreference, useBridgeState } from './bridge';
import { buildNativeInbox } from './lib/nativeInbox';
import type { NativeInboxEntry, NativeQuestionAnswer } from './lib/nativeInbox';
import {
  derivePendingSessionIds,
  deriveRunningSessionIds,
  formatTitleList,
  isTerminalCardStatus,
  parseBlockingCards,
  parseSessionActivity,
  sessionArchiveReadiness,
} from './lib/sessionArchive';
import { NativeAnswerModal } from './components/NativeAnswerModal';
import type { NativeInboxProps } from './components/NativeInbox';
import { batchCards } from './api';
import {
  EMPTY_SELECTION,
  allSelected as allCardsSelected,
  clearSelection,
  deselectAll as deselectVisible,
  pruneSelection,
  selectAll as selectAllCards,
  selectedIds as selectedIdList,
  toggleSelection,
} from './lib/selection';
import type { SelectionState } from './lib/selection';
import { SelectionBar } from './components/SelectionBar';
import { formatApprovalSessionText } from './lib/approvalQuestions';
import { approvalMoveTarget } from './lib/approvalOutcome';
import { buildStartPrompt, shouldPromptStartAfterReply, startCardFlow } from './lib/startCard';
import { setupNewCardSession } from './lib/createCardSession';
import type { HostInfo } from './types';
import { I18nContext, readStoredLang, resolveLang, storeLang, translate } from './i18n';
import type { I18nKey, Lang, TranslateVars } from './i18n';
import { copyText } from './lib/clipboard';
import { hasActiveFilters, EMPTY_FILTERS, extractProjects, filterCards } from './lib/filter';
import { cardIdForSession, consumeHighlightSession } from './lib/highlight';
import type { CardFilters } from './lib/filter';
import { countByColumn, groupCardsByColumn } from './lib/grouping';
import type { ColumnGroups } from './lib/grouping';
import { COLUMN_OF_STATUS, COLUMNS, STATUS_OF_COLUMN } from './lib/status';
import {
  buildCardRelationIndex,
  describeChildren,
  extractOpenChildren,
  isClosedStatus,
  isCompleteBlockedError,
} from './lib/cardRelations';
import type { OpenChildRef } from './lib/cardRelations';
import type { ArchiveBoxProps } from './components/ArchiveBox';
import { doneCardsOf } from './lib/listGroups';
import type { ListGroupBy } from './lib/listGroups';
import { applyPage, EMPTY_FEED } from './lib/activities';
import { useWorklineStatuses } from './lib/useWorklineStatuses';
import { collectRunningSessionCwds, useWorkspaces } from './lib/useWorkspaces';
import { buildWorklineOverview, findWorklineRow } from './lib/worklineOverview';
import type { WorklineSelection } from './lib/worklineOverview';
import { buildCleanupNudge } from './lib/worktreeCleanupNudge';
import { buildRebindCandidates, cardCwdState, formatRebindComment } from './lib/rebindDir';
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
import { WorklineFilterBar, WorklineView } from './components/WorklineView';
import { WorkspaceView } from './components/WorkspaceView';
import { ToastRegion, useToasts } from './components/Toast';
import type { ToastAction } from './components/Toast';
import { RebindDirDialog } from './components/RebindDirDialog';
import { Toolbar } from './components/Toolbar';
import type { SyncState, ViewMode } from './components/Toolbar';
import type { ApprovalDecision, ApprovalSubmission } from './components/ApprovalPanel';
import type { CardActionHandlers, Placement } from './components/types';
import { SessionArchiveBatchDialog } from './components/SessionArchiveBatchDialog';
import { StopAndArchiveDialog } from './components/StopAndArchiveDialog';

const VIEW_STORAGE_KEY = 'dsh-kanban.view';
const EMPTY_GROUPS: ColumnGroups = { backlog: [], running: [], needs_you: [], done: [] };

/**
 * 本地预判「这批卡移到 done 会被哪些未收口子卡拦截」（批量路径用；单卡以服务端 409 为准）。
 * 已经处于 done/canceled 的卡不再算完成动作，跳过。
 */
function collectOpenChildrenFor(cards: readonly Card[], ids: readonly string[]): OpenChildRef[] {
  const index = buildCardRelationIndex(cards);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const seen = new Set<string>();
  const openChildren: OpenChildRef[] = [];
  for (const id of ids) {
    const card = byId.get(id);
    if (!card || isTerminalCardStatus(card.status)) continue;
    for (const child of describeChildren(card, index).items) {
      if (isClosedStatus(child.status) || seen.has(child.id)) continue;
      seen.add(child.id);
      openChildren.push({ id: child.id, title: child.title, status: child.status });
    }
  }
  return openChildren;
}

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

/**
 * v0.22 完成拦截确认：把卡移到 done 时服务端 409（CARD_HAS_OPEN_CHILDREN），
 * 或者本地预判选中卡有未收口子卡（批量路径），都落到这个弹窗。
 */
interface CompleteBlockState {
  mode: 'move' | 'batch';
  column: ColumnId;
  /** 单卡路径的卡片标题；批量路径为空 */
  cardTitle: string;
  openChildren: OpenChildRef[];
  placement?: Placement;
  cardId?: string;
  cardIds?: string[];
}

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

/** 归档会话确认框的目标（卡片 + 绑定会话）。 */
interface SessionArchiveTarget {
  card: Card;
  sessionId: string;
  sessionTitle: string;
}

/** SESSION_ACTIVE 后的「停止并归档」确认目标（带宿主活动清单）。 */
interface StopAndArchiveTarget extends SessionArchiveTarget {
  activity: SessionActivityEntry[];
}

function readStoredView(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    // 兼容旧值：只认这四个视图，其它（含 null）回落到看板
    if (stored === 'list') return 'list';
    if (stored === 'workspaces') return 'workspaces';
    if (stored === 'worklines') return 'worklines';
    return 'board';
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
  // 从会话页「返回看板」气泡回来时，短暂高亮来源卡片。
  const [highlightCardId, setHighlightCardId] = useState<string | null>(null);
  const [highlightSession, setHighlightSession] = useState<string | null>(() => consumeHighlightSession());

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
  const notifyRef = useRef<
    (text: string, tone?: 'info' | 'success' | 'error', action?: ToastAction) => void
  >(() => undefined);
  const { toasts, notify, dismiss } = useToasts();
  notifyRef.current = notify;
  const [helpOpen, setHelpOpen] = useState(false);
  const appRef = useRef<HTMLDivElement | null>(null);
  const [unsentDecision, setUnsentDecision] = useState<UnsentDecision | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<SelectionState>(EMPTY_SELECTION);
  const [batchBusy, setBatchBusy] = useState(false);
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
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const refreshWorkspaces = useCallback(async () => {
    if (!embedded) return;
    try {
      const data = await bridge.request('workspaces.list');
      setWorkspaces(data.workspaces ?? []);
    } catch {
      /* 宿主不支持 workspaces.list 时保持空建议 */
    }
  }, [embedded]);

  useEffect(() => {
    if (!embedded) {
      setWorkspaces([]);
      return;
    }
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
    void refreshWorkspaces();
    return () => {
      cancelled = true;
    };
  }, [embedded, refreshWorkspaces]);

  const sessions = bridgeState.sessions.length ? bridgeState.sessions : fallbackSessions;

  // ---------------------------------------------------------- 会话归档/恢复
  // 归档集合以宿主为准：先 GET /sessions/archive 回填，之后以 kanban:sessions 推送为准。
  const [archivedSessionIds, setArchivedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [archiveAvailable, setArchiveAvailable] = useState(false);
  const [archiveSessionTarget, setArchiveSessionTarget] = useState<SessionArchiveTarget | null>(null);
  const [archiveSessionBusy, setArchiveSessionBusy] = useState(false);
  const [stopArchiveTarget, setStopArchiveTarget] = useState<StopAndArchiveTarget | null>(null);
  const [batchArchiveOpen, setBatchArchiveOpen] = useState(false);
  const runningSessionIds = useMemo(() => deriveRunningSessionIds(sessions), [sessions]);
  const pendingSessionIds = useMemo(
    () => derivePendingSessionIds(bridgeState.nativePending.items),
    [bridgeState.nativePending.items],
  );

  // ------------------------------------------------------------------ 视图状态
  const [view, setViewState] = useState<ViewMode>(readStoredView);
  const [filters, setFilters] = useState<CardFilters>(EMPTY_FILTERS);
  // v0.23.0「工作线」视图：点一条工作线后，看板只看这条线的卡片（提示条可清空）
  const [worklineFilter, setWorklineFilter] = useState<WorklineSelection | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // v0.21.0 #16：重新绑定工作目录弹窗（详情抽屉 / 未指定块共用）
  const [rebindTarget, setRebindTarget] = useState<Card | null>(null);
  const [rebindBusy, setRebindBusy] = useState(false);
  const [rebindError, setRebindError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Card | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [approvalDraft, setApprovalDraft] = useState<ApprovalDraftState | null>(null);
  const [activeColumn, setActiveColumn] = useState<ColumnId>('running');
  const [listGroupBy, setListGroupBy] = useState<ListGroupBy>('status');
  const [doneOpen, setDoneOpen] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  // v0.22 完成拦截确认（拖拽 / 移动到菜单 / 批量移动共用）
  const [completeBlock, setCompleteBlock] = useState<CompleteBlockState | null>(null);
  const [completeBusy, setCompleteBusy] = useState(false);
  // v0.22 归档箱（列表视图底部）：null=还没拉取；[]=没有归档卡/接口不可用（整块隐藏）
  const [archiveCards, setArchiveCards] = useState<Card[] | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [restoringArchiveId, setRestoringArchiveId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleViewChange = useCallback((next: ViewMode) => {
    setViewState(next);
    storeView(next);
    // 只读视图（工作区 / 工作线）：进入时退出选择模式，避免批量操作条悬空
    if (next === 'workspaces' || next === 'worklines') {
      setSelectionMode(false);
      setSelectedIds(EMPTY_SELECTION);
      setActiveCardId(null);
    }
  }, []);

  /** 点一条工作线：切到看板并只看这条线的卡片（同一行再点一次不清空，用提示条「显示全部」清空）。 */
  const handleSelectWorkline = useCallback(
    (selection: WorklineSelection) => {
      setWorklineFilter(selection);
      handleViewChange('board');
    },
    [handleViewChange],
  );

  const clearWorklineFilter = useCallback(() => setWorklineFilter(null), []);

  /** 看板 / 列表的「有筛选」状态：搜索 / 项目 + 工作线筛选都算（清空时一起清）。 */
  const hasAnyFilter = hasActiveFilters(filters) || worklineFilter !== null;
  const clearAllFilters = useCallback(() => {
    setFilters({ query: '', project: null });
    setWorklineFilter(null);
  }, []);

  useEffect(() => {
    if (!highlightSession || snapshot.cards.length === 0) return;
    const cardId = cardIdForSession(snapshot.cards, highlightSession);
    setHighlightSession(null);
    if (!cardId) return;
    setHighlightCardId(cardId);
    const frame = requestAnimationFrame(() => {
      document.querySelector(`[data-card-id="${cardId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightSession, snapshot.cards]);

  useEffect(() => {
    if (!highlightCardId) return;
    const timer = window.setTimeout(() => setHighlightCardId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [highlightCardId]);

  // v0.22 父子卡 / 依赖索引：用全量卡片算，筛选不改变子卡计数（旧数据无关系字段时为空索引）
  const cardRelations = useMemo(() => buildCardRelationIndex(snapshot.cards), [snapshot.cards]);
  // 未归档的全部卡片：工作区「显示全部」范围 + 工作线总览 + 清理占用判定用
  const unarchivedCards = useMemo(() => snapshot.cards.filter((card) => !card.archived), [snapshot.cards]);
  // 运行中会话的 cwd：客户端清理安全层（服务端不知道会话 cwd）
  const runningSessionCwds = useMemo(() => collectRunningSessionCwds(sessions), [sessions]);
  // 「工作区」视图：按仓库/工作副本聚合（探测全部未归档卡片的 cwd，范围切换时数据才完整）
  const workspaceState = useWorkspaces(unarchivedCards);
  // v0.23.0「工作线」总览：与「工作区」视图同一份仓库/工作副本数据 + 卡片归属（含按会话归属兜底）
  const worklineOverview = useMemo(
    () =>
      buildWorklineOverview(unarchivedCards, workspaceState.repos, {
        sessions,
        unavailable: workspaceState.unavailable,
      }),
    [unarchivedCards, workspaceState.repos, workspaceState.unavailable, sessions],
  );
  // 当前只看的工作线行（数据刷新后该工作副本可能不在了 → 空卡片列表 + 提示条仍显示）
  const worklineRow = useMemo(
    () => findWorklineRow(worklineOverview, worklineFilter),
    [worklineOverview, worklineFilter],
  );
  const worklineCardIds = useMemo(
    () => (worklineRow ? new Set(worklineRow.cards.map((card) => card.id)) : null),
    [worklineRow],
  );
  const filteredCards = useMemo(() => {
    const base = filterCards(snapshot.cards, filters);
    if (!worklineCardIds) return base;
    return base.filter((card) => worklineCardIds.has(card.id));
  }, [snapshot.cards, filters, worklineCardIds]);
  // 卡片「工作线」徽标：按 cwd 去重批量探测（轻量摘要，不看 graph）
  const worklineStatuses = useWorklineStatuses(filteredCards);
  const groups = useMemo(
    () => (snapshot.board ? groupCardsByColumn(filteredCards, snapshot.board.cardOrder) : EMPTY_GROUPS),
    [filteredCards, snapshot.board],
  );
  const projects = useMemo(() => extractProjects(snapshot.cards), [snapshot.cards]);
  const activeCard = activeCardId ? snapshot.cards.find((card) => card.id === activeCardId) ?? null : null;
  const doneTotal = useMemo(() => doneCardsOf(snapshot.cards).length, [snapshot.cards]);
  // ---- 原生待确认收件（工具授权 / Agent 提问 / 计划审批，见 docs/contracts/04）----
  const nativeEntries = useMemo(
    () => buildNativeInbox(bridgeState.nativePending.items, snapshot.cards, lang),
    [bridgeState.nativePending.items, snapshot.cards, lang],
  );
  const [nativeModalId, setNativeModalId] = useState<string | null>(null);
  const [nativeBusyIds, setNativeBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const nativeModal = nativeModalId
    ? nativeEntries.find((entry) => entry.id === nativeModalId) ?? null
    : null;
  // 项被别处处理（作答道成功、原生 composer 先答、宿主撤回）时关闭弹窗
  useEffect(() => {
    if (nativeModalId && !nativeEntries.some((entry) => entry.id === nativeModalId)) setNativeModalId(null);
  }, [nativeEntries, nativeModalId]);
  /** 「待你确认」总数 = 业务审批卡片 + 原生待确认项 */
  const needsYouCount = countByColumn(snapshot.cards).needs_you + nativeEntries.length;
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
    (text: string, tone: 'info' | 'success' | 'error' = 'info', action?: ToastAction) => notify(text, tone, action),
    [notify],
  );

  // ---------------------------------------------------------- 会话归档/恢复
  // 挂载时回填能力与归档集合（仅嵌入模式；旧服务端/宿主无能力时保持关闭 → 隐藏入口）
  useEffect(() => {
    if (!embedded) {
      setArchiveAvailable(false);
      setArchivedSessionIds(new Set());
      return;
    }
    let cancelled = false;
    const startedAt = Date.now();
    api
      .getSessionArchiveState()
      .then((state) => {
        if (cancelled) return;
        setArchiveAvailable(state.available);
        // 推送比 HTTP 回填更新时以推送为准（避免慢响应覆盖新状态）
        if (bridge.getState().archivedSessionIdsAt <= startedAt) {
          setArchivedSessionIds(new Set(state.archivedSessionIds));
        }
      })
      .catch(() => {
        if (!cancelled) setArchiveAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [embedded]);

  // 桥推送更新归档集合（含 kanban:ready 后的首帧推送）
  useEffect(() => {
    if (!embedded || bridgeState.archivedSessionIdsAt === 0) return;
    setArchivedSessionIds(new Set(bridgeState.archivedSessionIds));
  }, [embedded, bridgeState.archivedSessionIds, bridgeState.archivedSessionIdsAt]);

  const installArchivedSessionIds = useCallback((ids: readonly string[]) => {
    setArchivedSessionIds(new Set(ids));
  }, []);

  const sessionTitleOf = useCallback(
    (sessionId: string) => sessions.find((session) => session.id === sessionId)?.title ?? sessionId,
    [sessions],
  );

  const archiveErrorText = useCallback(
    (error: unknown, fallbackKey: 'sessionArchive.archiveFailed' | 'sessionArchive.restoreFailed'): string => {
      const code = error instanceof KanbanApiError ? error.code : '';
      switch (code) {
        case 'SESSION_NOT_FOUND':
          return t('sessionArchive.notFound');
        case 'SESSION_NOT_BOUND':
          return t('sessionArchive.notBound');
        case 'CARD_NOT_DONE':
          return t('sessionArchive.cardNotDone');
        case 'SESSION_ARCHIVE_UNAVAILABLE':
          return t('sessionArchive.unavailable');
        default:
          return t(fallbackKey, { message: error instanceof Error ? error.message : String(error) });
      }
    },
    [t],
  );

  /** 归档会话：默认不带 stopActivity；SESSION_ACTIVE 时转「停止并归档」二次确认。 */
  const performArchiveSession = useCallback(
    async (target: SessionArchiveTarget, stopActivity: boolean) => {
      setArchiveSessionBusy(true);
      try {
        const result = await api.archiveCardSession(
          target.card.id,
          target.sessionId,
          stopActivity ? { stopActivity: true } : {},
        );
        // 契约返回完整集合；缺省时兜底把本次归档的会话并入本地状态
        installArchivedSessionIds(
          result.archivedSessionIds.includes(target.sessionId)
            ? result.archivedSessionIds
            : [...result.archivedSessionIds, target.sessionId],
        );
        setArchiveSessionTarget(null);
        setStopArchiveTarget(null);
        notifyToast(t('sessionArchive.archivedToast'), 'success');
        announce(t('sessionArchive.archivedToast'));
        await refresh({ silent: true });
      } catch (error) {
        if (error instanceof KanbanApiError && error.code === 'SESSION_ACTIVE') {
          // 运行中：M1 直接提示，M2 改为「停止并归档」二次确认（Q2 拍板）
          const activity = parseSessionActivity(error.details.activity);
          setArchiveSessionTarget(null);
          setStopArchiveTarget({ ...target, activity });
        } else if (error instanceof KanbanApiError && error.code === 'SESSION_BUSY_CARDS') {
          const blockingCards = parseBlockingCards(error.details.blockingCards);
          notifyToast(
            blockingCards.length
              ? t('sessionArchive.busyCards', {
                  count: blockingCards.length,
                  titles: formatTitleList(blockingCards.map((card) => card.title), lang),
                })
              : error.message,
            'error',
          );
          setArchiveSessionTarget(null);
          setStopArchiveTarget(null);
          await refresh({ silent: true });
        } else if (error instanceof KanbanApiError && error.code === 'SESSION_ARCHIVE_UNAVAILABLE') {
          setArchiveAvailable(false);
          setArchiveSessionTarget(null);
          setStopArchiveTarget(null);
          notifyToast(t('sessionArchive.unavailable'), 'error');
        } else {
          notifyToast(archiveErrorText(error, 'sessionArchive.archiveFailed'), 'error');
          setArchiveSessionTarget(null);
          setStopArchiveTarget(null);
          await refresh({ silent: true });
        }
      } finally {
        setArchiveSessionBusy(false);
      }
    },
    [announce, archiveErrorText, installArchivedSessionIds, lang, notifyToast, refresh, t],
  );

  const handleArchiveSession = useCallback(
    (card: Card, sessionId: string) => {
      if (!embedded) return;
      if (!archiveAvailable) {
        notifyToast(t('sessionArchive.unavailable'), 'info');
        return;
      }
      setStopArchiveTarget(null);
      setArchiveSessionTarget({ card, sessionId, sessionTitle: sessionTitleOf(sessionId) });
    },
    [archiveAvailable, embedded, notifyToast, sessionTitleOf, t],
  );

  const handleUnarchiveSession = useCallback(
    async (card: Card, sessionId: string) => {
      try {
        const result = await api.unarchiveCardSession(card.id, sessionId);
        installArchivedSessionIds(result.archivedSessionIds.filter((id) => id !== sessionId));
        notifyToast(t('sessionArchive.restoredToast'), 'success');
        await refresh({ silent: true });
      } catch (error) {
        if (error instanceof KanbanApiError && error.code === 'SESSION_ARCHIVE_UNAVAILABLE') {
          setArchiveAvailable(false);
        }
        notifyToast(archiveErrorText(error, 'sessionArchive.restoreFailed'), 'error');
      }
    },
    [archiveErrorText, installArchivedSessionIds, notifyToast, refresh, t],
  );

  /** 卡片完成时轻提示：本地预检有可归档会话才提示，不自动执行（Q1 拍板 manual-nudge）。 */
  const nudgeArchivableSessions = useCallback(
    (card: Card, cards: readonly Card[]) => {
      if (!embedded || !archiveAvailable || !isTerminalCardStatus(card.status)) return;
      const archivable = card.sessionIds.some((sessionId) => {
        if (archivedSessionIds.has(sessionId)) return false;
        return sessionArchiveReadiness({
          card,
          sessionId,
          cards,
          archivedSessionIds,
          runningSessionIds,
          pendingSessionIds,
          available: archiveAvailable,
        }).archivable;
      });
      if (archivable) notifyToast(t('sessionArchive.nudge'), 'info');
    },
    [archiveAvailable, archivedSessionIds, embedded, notifyToast, pendingSessionIds, runningSessionIds, t],
  );

  /**
   * v0.21.0 #15：卡片进入完成 → 若它的工作副本已并入主线且干净、没有未完成卡片/运行中会话占用，
   * 给一条可操作 toast（「打开工作区」），不弹窗打断。
   * 判定与工作区视图的「可安全清理」同源；工作副本数据来自最近一次探测（≤20s，保守）。
   */
  const nudgeWorktreeCleanup = useCallback(
    (card: Card) => {
      const nudge = buildCleanupNudge({
        card,
        cards: snapshotRef.current.cards.filter((item) => !item.archived),
        repos: workspaceState.repos,
        sessionCwds: runningSessionCwds,
      });
      if (!nudge) return;
      notifyToast(t('workspace.cleanupNudge', { name: nudge.label }), 'info', {
        label: t('workspace.cleanupNudgeAction'),
        onClick: () => handleViewChange('workspaces'),
      });
    },
    [handleViewChange, notifyToast, runningSessionCwds, t, workspaceState.repos],
  );

  /** 卡片从完成态重开（done → 其它列）后，尝试恢复其已归档的绑定会话。 */
  const restoreArchivedSessionsFor = useCallback(
    async (card: Card) => {
      if (!embedded || !archiveAvailable) return;
      const archived = card.sessionIds.filter((sessionId) => archivedSessionIds.has(sessionId));
      let restored = 0;
      for (const sessionId of archived) {
        try {
          const result = await api.unarchiveCardSession(card.id, sessionId);
          installArchivedSessionIds(result.archivedSessionIds);
          restored += 1;
        } catch (error) {
          notifyToast(archiveErrorText(error, 'sessionArchive.restoreFailed'), 'info');
        }
      }
      if (restored > 0) notifyToast(t('sessionArchive.restoredToast'), 'success');
    },
    [archiveAvailable, archiveErrorText, archivedSessionIds, embedded, installArchivedSessionIds, notifyToast, t],
  );

  const handleStopAndArchiveConfirm = useCallback(() => {
    if (!stopArchiveTarget) return;
    void performArchiveSession(stopArchiveTarget, true);
  }, [performArchiveSession, stopArchiveTarget]);

  const handleBatchArchiveCompleted = useCallback(
    (result: SessionArchiveBatchResult) => {
      installArchivedSessionIds(result.archivedSessionIds);
      setBatchArchiveOpen(false);
      const count = result.archivable.length;
      notifyToast(
        result.skipped.length
          ? t('sessionArchive.batchDoneSkipped', { count, skipped: result.skipped.length })
          : t('sessionArchive.batchDone', { count }),
        'success',
      );
      void refresh({ silent: true });
    },
    [installArchivedSessionIds, notifyToast, refresh, t],
  );

  const handleArchiveUnavailable = useCallback(() => {
    setArchiveAvailable(false);
    notifyToast(t('sessionArchive.unavailable'), 'info');
  }, [notifyToast, t]);

  const handleArchiveDoneSessions = useCallback(() => {
    if (!embedded || !archiveAvailable) return;
    setBatchArchiveOpen(true);
  }, [archiveAvailable, embedded]);

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
        // 桥层发消息前会自动恢复已归档会话；恢复失败时不静默，给出可操作提示
        const code = error instanceof BridgeUnavailableError ? error.code : '';
        const message =
          code === 'SESSION_ARCHIVE_UNAVAILABLE' || code === 'SESSION_ARCHIVED'
            ? t('sessionArchive.autoRestoreFailed', {
                message: error instanceof Error ? error.message : String(error),
              })
            : error instanceof Error
              ? error.message
              : String(error);
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

  // -------------------------------------------------- 重新绑定工作目录（v0.21.0 #16）
  /** 打开「重新绑定目录」弹窗（详情抽屉 / 工作区「未指定」块共用入口）。 */
  const handleOpenRebind = useCallback((card: Card) => {
    setRebindError(null);
    setRebindTarget(card);
  }, []);

  /** 候选目录：卡片绑定会话的执行目录 + 已探测仓库的主/子工作副本（含当前 cwd）。 */
  const rebindCandidates = useMemo(() => {
    if (!rebindTarget) return [];
    return buildRebindCandidates({ repos: workspaceState.repos, sessions, card: rebindTarget, t });
  }, [rebindTarget, sessions, t, workspaceState.repos]);

  /** 提交重绑：PATCH cwd（已完成卡片也允许）→ 评论节点写时间线 → 刷新卡片与工作区。 */
  const handleRebindSubmit = useCallback(
    async (path: string) => {
      if (!rebindTarget || rebindBusy) return;
      const nextCwd = path.trim();
      if (!nextCwd) return;
      const card = rebindTarget;
      setRebindBusy(true);
      setRebindError(null);
      try {
        await api.updateCard(card.id, card.version, { cwd: nextCwd });
        // 时间线留痕：PATCH 本身不写活动节点，用评论节点记录「旧 → 新」。
        try {
          await api.addComment(card.id, formatRebindComment(t, card.cwd, nextCwd));
        } catch {
          /* 时间线写入失败不影响改绑结果 */
        }
        setRebindTarget(null);
        notifyToast(t('rebind.done'), 'success');
        await refresh({ silent: true });
        workspaceState.reload();
      } catch (error) {
        if (error instanceof KanbanApiError && error.code === 'VERSION_CONFLICT') {
          setRebindError(t('rebind.failed', { message: t('toast.versionConflict') }));
          await refresh({ silent: true });
        } else {
          setRebindError(
            t('rebind.failed', { message: error instanceof Error ? error.message : String(error) }),
          );
        }
      } finally {
        setRebindBusy(false);
      }
    },
    [notifyToast, rebindBusy, rebindTarget, refresh, t, workspaceState],
  );

  /** 详情抽屉里当前卡片的 cwd 状态（无 / 已失效 / 正常）。 */
  const activeCardCwdState = useMemo(
    () => (activeCard ? cardCwdState(activeCard, workspaceState.unavailable) : 'ok'),
    [activeCard, workspaceState.unavailable],
  );

  // ------------------------------------------------------------ 原生待确认作答
  const setNativeBusy = useCallback((id: string, busy: boolean) => {
    setNativeBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleNativeError = useCallback(
    (error: unknown) => {
      const code = error instanceof BridgeUnavailableError ? error.code : '';
      if (code === 'PENDING_NOT_FOUND' || code === 'PENDING_UNANSWERABLE') {
        notifyToast(t('native.toast.resolvedElsewhere'), 'info');
        return;
      }
      notifyToast(
        t('native.toast.failed', { message: error instanceof Error ? error.message : String(error) }),
        'error',
      );
    },
    [notifyToast, t],
  );

  const handleNativeApproval = useCallback(
    async (entry: NativeInboxEntry, outcome: 'allowed-once' | 'rejected') => {
      setNativeBusy(entry.id, true);
      try {
        await bridge.request('pending.answerApproval', {
          sessionId: entry.sessionId,
          key: entry.id,
          outcome,
        });
        notifyToast(
          outcome === 'allowed-once'
            ? t('native.toast.approved', { tool: entry.toolName ?? '' })
            : t('native.toast.rejected', { tool: entry.toolName ?? '' }),
          'success',
        );
      } catch (error) {
        handleNativeError(error);
      } finally {
        setNativeBusy(entry.id, false);
      }
    },
    [handleNativeError, notifyToast, setNativeBusy, t],
  );

  const handleNativeSubmit = useCallback(
    async (entry: NativeInboxEntry, answers: NativeQuestionAnswer[]) => {
      setNativeBusy(entry.id, true);
      try {
        await bridge.request('pending.answerQuestion', {
          sessionId: entry.sessionId,
          key: entry.id,
          answers,
        });
        notifyToast(t('native.toast.submitted'), 'success');
        setNativeModalId(null);
      } catch (error) {
        handleNativeError(error);
      } finally {
        setNativeBusy(entry.id, false);
      }
    },
    [handleNativeError, notifyToast, setNativeBusy, t],
  );

  const handleNativeDismiss = useCallback(
    async (entry: NativeInboxEntry) => {
      setNativeBusy(entry.id, true);
      try {
        await bridge.request('pending.dismiss', { sessionId: entry.sessionId, key: entry.id });
        notifyToast(t('native.toast.dismissed'), 'success');
        setNativeModalId(null);
      } catch (error) {
        handleNativeError(error);
      } finally {
        setNativeBusy(entry.id, false);
      }
    },
    [handleNativeError, notifyToast, setNativeBusy, t],
  );

  const handleNativeSession = useCallback(
    async (entry: NativeInboxEntry) => {
      if (!embedded) {
        notifyToast(t('native.channelNotReady'), 'info');
        return;
      }
      try {
        await bridge.request('session.open', { sessionId: entry.sessionId });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : String(error), 'error');
      }
    },
    [embedded, notifyToast, t],
  );

  const nativeInbox = useMemo<NativeInboxProps>(
    () => ({
      entries: nativeEntries,
      busyIds: nativeBusyIds,
      onAnswerApproval: (entry, outcome) => void handleNativeApproval(entry, outcome),
      onOpenQuestion: (entry) => setNativeModalId(entry.id),
      onOpenPlan: (entry) => setNativeModalId(entry.id),
      onOpenSession: (entry) => void handleNativeSession(entry),
      onOpenCard: (card) => handleOpenDetail(card.id),
    }),
    [
      handleNativeApproval,
      handleNativeSession,
      handleOpenDetail,
      nativeBusyIds,
      nativeEntries,
    ],
  );

  // -------------------------------------------------- 归档箱（v0.22.0）
  /** 拉取归档卡片列表；旧服务端没有该接口（404）或网络失败时安静隐藏归档箱。 */
  const loadArchivedCards = useCallback(async () => {
    setArchiveLoading(true);
    try {
      const cards = await api.getArchivedCards();
      setArchiveCards(cards);
      setArchiveError(null);
    } catch {
      // 兼容旧服务端：没有归档列表接口时整块不渲染，不阻塞主界面
      setArchiveCards([]);
      setArchiveError(null);
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  /** 列表视图首次出现时拉一次归档列表（懒加载，失败静默）。 */
  useEffect(() => {
    if (view !== 'list' || archiveCards !== null) return;
    void loadArchivedCards();
  }, [view, archiveCards, loadArchivedCards]);

  /** 从归档箱恢复一张卡片：成功后从列表移除 + 刷新主看板。 */
  const handleRestoreArchived = useCallback(
    async (card: Card) => {
      setRestoringArchiveId(card.id);
      try {
        const result = await api.unarchiveCard(card.id);
        setArchiveCards((current) => (current ? current.filter((item) => item.id !== card.id) : current));
        const title = result.card?.title || card.title;
        notifyToast(t('archive.restored', { title }), 'success');
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(
          t('archive.restoreFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
          'error',
        );
      } finally {
        setRestoringArchiveId(null);
      }
    },
    [notifyToast, refresh, t],
  );

  const archiveBoxProps = useMemo<ArchiveBoxProps>(
    () => ({
      cards: archiveCards,
      loading: archiveLoading,
      error: archiveError,
      open: archiveOpen,
      busyCardId: restoringArchiveId,
      onToggle: () => {
        setArchiveOpen((current) => {
          const next = !current;
          if (next) void loadArchivedCards();
          return next;
        });
      },
      onRetry: () => void loadArchivedCards(),
      onRestore: (card) => void handleRestoreArchived(card),
    }),
    [archiveCards, archiveLoading, archiveError, archiveOpen, restoringArchiveId, loadArchivedCards, handleRestoreArchived],
  );

  const handleEdit = useCallback((card: Card) => {
    setFormError(null);
    setFormState({ mode: 'edit', card });
  }, []);

  const handleArchiveRequest = useCallback((card: Card) => {
    setArchiveTarget(card);
  }, []);

  const handleMove = useCallback(
    async (cardId: string, column: ColumnId, placement?: Placement, forceComplete = false) => {
      const current = snapshotRef.current;
      const card = current.cards.find((item) => item.id === cardId);
      if (!card) return false;
      const previous = current;
      const fromColumn = COLUMN_OF_STATUS[card.status];
      setSnapshot(applyOptimisticMove(current, cardId, column, placement));
      try {
        const result = await api.moveCard(cardId, column, {
          version: card.version,
          ...(placement?.beforeId ? { beforeId: placement.beforeId } : {}),
          ...(placement?.afterId ? { afterId: placement.afterId } : {}),
          ...(forceComplete ? { forceComplete: true } : {}),
        });
        const movedText = t('toast.moved', { column: t(`column.${column}` as I18nKey) });
        notifyToast(movedText, 'success');
        announce(movedText);
        // 会话联动：完成时轻提示可归档；从完成态重开时尝试自动恢复已归档会话
        const updatedCards = snapshotRef.current.cards.map((item) =>
          item.id === result.card.id ? result.card : item,
        );
        await refresh({ silent: true });
        if (column === 'done' && !isTerminalCardStatus(card.status)) {
          nudgeArchivableSessions(result.card, updatedCards);
          nudgeWorktreeCleanup(result.card);
        } else if (isTerminalCardStatus(card.status) && column !== 'done') {
          void restoreArchivedSessionsFor(result.card);
        }
        const movedCard = result.card;
        if (column === 'needs_you' && !movedCard.approvals.some((approval) => approval.status === 'pending')) {
          setApprovalDraft({ card: movedCard, previous, fromColumn, busy: false, error: null });
        }
        return true;
      } catch (error) {
        setSnapshot(previous);
        // v0.22 完成拦截：还有未收口子卡 → 弹确认，确认后带 forceComplete 重试（其它路径共用同一弹窗）
        const openChildren = extractOpenChildren((error as KanbanApiError).details);
        if (!forceComplete && column === 'done' && openChildren.length && isCompleteBlockedError(error)) {
          setCompleteBlock({
            mode: 'move',
            column,
            cardTitle: card.title,
            openChildren,
            cardId,
            ...(placement ? { placement } : {}),
          });
          await refresh({ silent: true });
          return false;
        }
        const message =
          error instanceof KanbanApiError && error.code === 'VERSION_CONFLICT'
            ? t('toast.versionConflict')
            : t('toast.moveFailed');
        notifyToast(message, 'error');
        await refresh({ silent: true });
        return false;
      }
    },
    [announce, nudgeArchivableSessions, nudgeWorktreeCleanup, notifyToast, refresh, restoreArchivedSessionsFor, t],
  );

  /** v1.1 待办卡「开始推进」：乐观移列 → 启动提示发送 / 独立预览仅移动；失败回滚。 */
  const handleStartCard = useCallback(
    async (card: Card) => {
      if (card.status !== 'backlog') return;
      const previous = snapshotRef.current;
      setSnapshot(applyOptimisticMove(previous, card.id, 'running'));
      const result = await startCardFlow(card, {
        embedded,
        moveToRunning: async () => {
          await api.moveCard(card.id, 'running', { version: card.version });
        },
        rollbackToBacklog: async () => {
          await api.moveCard(card.id, 'backlog');
        },
        ensureSession: async (text) => {
          const ensured = await bridge.request('session.ensure', {
            text,
            ...(card.sessionIds[0] ? { sessionId: card.sessionIds[0] } : {}),
            ...(card.cwd ? { cwd: card.cwd } : {}),
          });
          return { sessionId: ensured.sessionId, created: ensured.created };
        },
        bindSession: async (sessionId) => {
          await api.bindSession(card.id, sessionId);
        },
      });
      if (result.status === 'skipped') {
        setSnapshot(previous);
        await refresh({ silent: true });
        return;
      }
      if (result.status === 'started') {
        const message = t('toast.started');
        notifyToast(message, 'success');
        announce(message);
        await refresh({ silent: true });
        return;
      }
      if (result.status === 'moved-standalone') {
        notifyToast(t('toast.startedStandalone'), 'info');
        await refresh({ silent: true });
        return;
      }
      setSnapshot(previous);
      notifyToast(t('toast.startFailed'), 'error');
      await refresh({ silent: true });
    },
    [announce, embedded, notifyToast, refresh, t],
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
            { id: 'continue', label: values.continueLabel, tone: 'primary', outcome: 'running' },
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
      submission: ApprovalSubmission,
      comment: string,
      decision: ApprovalDecision,
      sessionIdOverride?: string,
    ) => {
      setResolvingApprovalId(approval.id);
      // 提交即离开「待你确认」：先乐观移列，接口失败再整体回滚（v0.9.5）
      const previous = snapshotRef.current;
      const current = previous.cards.find((item) => item.id === card.id) ?? card;
      const moveTarget = approvalMoveTarget(current, approval, submission, decision);
      if (moveTarget) setSnapshot(applyOptimisticMove(previous, card.id, moveTarget));
      try {
        const resolved = await api.resolveApproval(
          card.id,
          approval.id,
          submission.answers?.length
            ? {
                answers: submission.answers.map(({ questionId, optionIds, custom }) => ({
                  questionId,
                  optionIds,
                  ...(custom ? { custom } : {}),
                })),
                ...(comment ? { comment } : {}),
              }
            : { optionIds: submission.optionIds, ...(comment ? { comment } : {}) },
        );
        const text = formatApprovalSessionText(
          approval,
          submission.answers,
          comment,
          decision,
          submission.optionIds,
        );
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
        // 审批结果把卡片送进「已完成」时，同样给归档轻提示（Q1 manual-nudge）
        if (moveTarget === 'done') {
          const updatedCards = snapshotRef.current.cards.map((item) =>
            item.id === resolved.card.id ? resolved.card : item,
          );
          nudgeArchivableSessions(resolved.card, updatedCards);
        }
        await refresh({ silent: true });
      } catch (error) {
        if (moveTarget) setSnapshot(previous);
        notifyToast(error instanceof Error ? error.message : t('toast.approvalFailed'), 'error');
        await refresh({ silent: true });
      } finally {
        setResolvingApprovalId(null);
      }
    },
    [announce, nudgeArchivableSessions, notifyToast, refresh, sendToSession, t],
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
      // 待办卡回复后只提示、不自动改状态
      const latest = snapshotRef.current.cards.find((item) => item.id === card.id) ?? card;
      if (shouldPromptStartAfterReply(latest.status)) {
        notifyToast(t('toast.replyBacklogHint'), 'info');
      }
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
        // 重开卡片自动恢复其已归档会话（桥层只管打开/发消息；重开由前端触发，docs/11 §4.3）
        await restoreArchivedSessionsFor(card);
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.moveFailed'), 'error');
        await refresh({ silent: true });
      }
    },
    [announce, notifyToast, refresh, restoreArchivedSessionsFor, t],
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
        // 标题只用于时间线节点文案（「主会话切换为「X」」）
        const title = sessions.find((session) => session.id === sessionId)?.title;
        await api.bindSession(card.id, sessionId, title);
        notifyToast(t('toast.primarySet'), 'success');
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('toast.sessionFailed'), 'error');
      }
    },
    [notifyToast, refresh, sessions, t],
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
        // 桥层会先自动恢复已归档会话；失败时给出可操作的提示（不静默）
        const code = error instanceof BridgeUnavailableError ? error.code : '';
        if (code === 'SESSION_ARCHIVE_UNAVAILABLE' || code === 'SESSION_ARCHIVED') {
          notifyToast(
            t('sessionArchive.autoRestoreFailed', {
              message: error instanceof Error ? error.message : String(error),
            }),
            'error',
          );
          return;
        }
        notifyToast(error instanceof Error ? error.message : t('toast.sessionFailed'), 'error');
      }
    },
    [notifyToast, t],
  );

  /** 详情内补建会话：先选工作区/目录；进行中会话创建后发启动提示。 */
  const handleCreateSession = useCallback(
    async (card: Card, options: { workspaceId?: string; cwd: string; start: boolean }) => {
      if (!embedded) {
        notifyToast(t('drawer.createSessionStandalone'), 'info');
        return;
      }
      try {
        const created = await bridge.request('session.create', {
          ...(options.cwd.trim() ? { cwd: options.cwd.trim() } : {}),
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
          title: card.title,
        });
        await api.bindSession(card.id, created.sessionId);
        if (options.start) {
          await bridge.request('session.prompt', { sessionId: created.sessionId, text: buildStartPrompt(card) });
        }
        notifyToast(
          options.start ? t('toast.sessionAutoStarted') : t('toast.sessionCreatedBound'),
          'success',
        );
        await refreshWorkspaces();
        await refresh({ silent: true });
      } catch (error) {
        notifyToast(error instanceof Error ? error.message : t('drawer.createSessionFailed'), 'error');
      }
    },
    [embedded, notifyToast, refresh, refreshWorkspaces, t],
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
          const { card } = await api.createCard({
            boardId: snapshot.board.id,
            title: values.title,
            summary: values.summary || undefined,
            status: values.status,
            project: values.project || undefined,
            workspaceId: values.workspaceId || undefined,
            cwd: values.cwd || undefined,
            ...(values.session.kind === 'existing' && values.session.sessionId
              ? { sessionId: values.session.sessionId }
              : {}),
          });
          notifyToast(t('toast.created'), 'success');
          announce(t('toast.created'));
          if (values.status === 'running' && !embedded) {
            // 独立预览：只建卡，不建会话
            notifyToast(t('toast.cardCreatedNoSession'), 'info');
          } else if (embedded && values.session.kind !== 'none') {
            const plan = {
              kind: values.session.kind,
              ...(values.session.sessionId ? { sessionId: values.session.sessionId } : {}),
              ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
              ...(card.cwd ? { cwd: card.cwd } : {}),
              title: card.title,
              start: values.status === 'running',
              prompt: buildStartPrompt(card),
            };
            const result = await setupNewCardSession(plan, {
              createSession: (input) => bridge.request('session.create', input),
              ensureSession: (input) => bridge.request('session.ensure', input),
              promptSession: async (sessionId, text) => {
                await bridge.request('session.prompt', { sessionId, text });
              },
              bindSession: async (sessionId) => {
                await api.bindSession(card.id, sessionId);
              },
            });
            if (result.status === 'failed') {
              notifyToast(t('toast.cardCreatedSessionFailed'), 'error');
            } else if (values.status === 'running') {
              notifyToast(t('toast.sessionAutoStarted'), 'success');
            } else if (values.session.kind === 'new') {
              notifyToast(t('toast.sessionCreatedBound'), 'success');
            }
            void refreshWorkspaces();
          }
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
      if (archiveCards !== null) void loadArchivedCards();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('toast.archiveFailed');
      notifyToast(message, 'error');
      await refresh({ silent: true });
    } finally {
      setArchiveBusy(false);
    }
  }, [activeCardId, announce, archiveCards, archiveTarget, loadArchivedCards, notifyToast, refresh, t]);

  const actions = useMemo<CardActionHandlers>(
    () => ({
      onToggleExpanded: handleToggleExpanded,
      onOpenDetail: handleOpenDetail,
      onEdit: handleEdit,
      onArchive: handleArchiveRequest,
      onReopen: (card) => void handleReopen(card),
      onMove: (cardId, column, placement) => void handleMove(cardId, column, placement),
      onStartCard: (card) => void handleStartCard(card),
      onResolveApproval: (card, approval, submission, comment, decision) =>
        void handleResolveApproval(card, approval, submission, comment, decision),
      onNotify: (message, tone) => notifyToast(message, tone),
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
      handleStartCard,
      handleToggleExpanded,
      notifyToast,
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
      relations: cardRelations,
    }),
    [now, sessions, expandedIds, resolvingApprovalId, activeCardId, feeds, loadEarlier, cardRelations],
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

  // ---- v1.1 批量选择模式 ----
  const visibleCardIds = useMemo(() => filteredCards.map((card) => card.id), [filteredCards]);
  const allVisibleSelected = allCardsSelected(selectedIds, visibleCardIds);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(clearSelection());
  }, []);

  const enterSelectionMode = useCallback(() => {
    setSelectionMode(true);
    setSelectedIds(clearSelection());
    setActiveCardId(null);
    setExpandedIds(new Set());
  }, []);

  const handleToggleSelectionMode = useCallback(() => {
    if (selectionMode) exitSelectionMode();
    else enterSelectionMode();
  }, [enterSelectionMode, exitSelectionMode, selectionMode]);

  const handleToggleSelect = useCallback((cardId: string) => {
    setSelectedIds((current) => toggleSelection(current, cardId));
  }, []);

  const handleSelectAllVisible = useCallback(() => {
    if (!visibleCardIds.length) {
      notifyToast(t('selection.empty'), 'info');
      return;
    }
    setSelectedIds((current) =>
      allCardsSelected(current, visibleCardIds)
        ? deselectVisible(current, visibleCardIds)
        : selectAllCards(current, visibleCardIds),
    );
  }, [notifyToast, t, visibleCardIds]);

  const handleClearSelection = useCallback(() => setSelectedIds(clearSelection()), []);

  /**
   * 批量移动（v0.22）：force=false 走批量接口；force=true 时把「有未收口子卡」的卡逐张带
   * forceComplete 重试，其余仍走批量接口（服务端批量接口不接受 forceComplete，避免整批失败）。
   */
  const runBatchMove = useCallback(
    async (ids: string[], column: ColumnId, force: boolean) => {
      if (!force) {
        await batchCards('move', ids, column);
        return;
      }
      const current = snapshotRef.current;
      const byId = new Map(current.cards.map((card) => [card.id, card]));
      const index = buildCardRelationIndex(current.cards);
      const forceIds: string[] = [];
      const plainIds: string[] = [];
      for (const id of ids) {
        const card = byId.get(id);
        if (card && describeChildren(card, index).open > 0) forceIds.push(id);
        else plainIds.push(id);
      }
      if (plainIds.length) await batchCards('move', plainIds, column);
      const results = await Promise.allSettled(
        forceIds.map((id) => {
          const card = byId.get(id);
          return api.moveCard(id, column, {
            ...(card ? { version: card.version } : {}),
            forceComplete: true,
          });
        }),
      );
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error(t('toast.moveFailed'));
      }
    },
    [t],
  );

  const handleBatchAction = useCallback(
    async (action: 'archive' | 'move', column?: ColumnId, idsOverride?: string[], force = false) => {
      const ids = idsOverride ?? selectedIdList(selectedIds);
      if (!ids.length) {
        notifyToast(t('selection.none'), 'info');
        return;
      }
      setBatchBusy(true);
      try {
        if (action === 'move' && column) {
          // 批量移动到 done：先用本地关系索引预判，有未收口子卡就先弹确认（与服务端 409 同一弹窗）
          if (column === 'done' && !force) {
            const openChildren = collectOpenChildrenFor(snapshotRef.current.cards, ids);
            if (openChildren.length) {
              setBatchBusy(false);
              setCompleteBlock({ mode: 'batch', column, cardTitle: '', openChildren, cardIds: ids });
              return;
            }
          }
          await runBatchMove(ids, column, force);
        } else {
          await batchCards(action, ids);
        }
        if (action === 'archive') {
          notifyToast(t('selection.archivedToast', { count: ids.length }), 'success');
          if (archiveCards !== null) void loadArchivedCards();
        } else if (column) {
          notifyToast(
            t('selection.movedToast', { count: ids.length, column: t(`column.${column}` as I18nKey) }),
            'success',
          );
        }
        exitSelectionMode();
        await refresh({ silent: true });
      } catch (error) {
        // 服务端 409（本地数据滞后时才可能走到这里）：同样弹完成拦截确认
        const openChildren = extractOpenChildren((error as KanbanApiError).details);
        if (!force && action === 'move' && column === 'done' && openChildren.length && isCompleteBlockedError(error)) {
          setCompleteBlock({
            mode: 'batch',
            column,
            cardTitle: '',
            openChildren,
            cardIds: ids,
          });
        } else {
          notifyToast(error instanceof Error ? error.message : t('toast.approvalFailed'), 'error');
        }
        // 部分成功 / 服务端数据可能已变：刷新到服务端真值
        await refresh({ silent: true });
      } finally {
        setBatchBusy(false);
      }
    },
    [archiveCards, exitSelectionMode, loadArchivedCards, notifyToast, refresh, runBatchMove, selectedIds, t],
  );

  /** 完成拦截确认：确认后带 forceComplete 重试（单卡 / 批量共用）。 */
  const handleCompleteConfirm = useCallback(async () => {
    const block = completeBlock;
    if (!block) return;
    setCompleteBusy(true);
    try {
      if (block.mode === 'move' && block.cardId) {
        await handleMove(block.cardId, block.column, block.placement, true);
      } else if (block.cardIds?.length) {
        await handleBatchAction('move', block.column, block.cardIds, true);
      }
      setCompleteBlock(null);
    } finally {
      setCompleteBusy(false);
    }
  }, [completeBlock, handleBatchAction, handleMove]);

  // 刷新/归档后过滤已不存在的 id；切视图时保留选择
  useEffect(() => {
    const existing = snapshot.cards.filter((card) => !card.archived).map((card) => card.id);
    setSelectedIds((current) => pruneSelection(current, existing));
  }, [snapshot.cards]);

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
          return;
        }
        if (selectionMode) {
          event.preventDefault();
          exitSelectionMode();
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
      } else if (key.toLowerCase() === 'w') {
        event.preventDefault();
        handleViewChange('worklines');
      } else if (key.toLowerCase() === 't') {
        event.preventDefault();
        void cycleTheme();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [cycleTheme, exitSelectionMode, focusSearch, handleCreateCard, handleViewChange, helpOpen, selectionMode]);

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
    if (view === 'worklines') {
      return (
        <WorklineView
          overview={worklineOverview}
          disabled={workspaceState.disabled}
          loaded={workspaceState.loaded}
          selected={worklineFilter}
          now={now}
          onSelectWorkline={handleSelectWorkline}
          onOpenCard={actions.onOpenDetail}
        />
      );
    }
    if (view === 'workspaces') {
      return (
        <WorkspaceView
          cards={filteredCards}
          allCards={unarchivedCards}
          workspaces={workspaceState}
          sessions={sessions}
          runningSessionCwds={runningSessionCwds}
          now={now}
          onOpenCard={actions.onOpenDetail}
          onRebindCard={handleOpenRebind}
          onNotify={actions.onNotify}
        />
      );
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
          worklineStatuses={worklineStatuses}
          filtering={hasAnyFilter}
          onClearFilters={clearAllFilters}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          onToggleSelection={handleToggleSelect}
          highlightedCardId={highlightCardId}
          nativeInbox={nativeInbox}
          archiveBox={archiveBoxProps}
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
        worklineStatuses={worklineStatuses}
        mobile={mobile}
        activeColumn={activeColumn}
        onActiveColumnChange={setActiveColumn}
        onCreateInColumn={(column) => {
          setFormError(null);
          setFormState({ mode: 'create', column });
        }}
        onMoveWithPlacement={(cardId, column, placement) => void handleMove(cardId, column, placement)}
        onViewAllDone={handleViewAllDone}
        filtering={hasAnyFilter}
        onClearFilters={clearAllFilters}
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        onToggleSelection={handleToggleSelect}
        highlightedCardId={highlightCardId}
        nativeInbox={nativeInbox}
        canArchiveSessions={embedded && archiveAvailable}
        onArchiveDoneSessions={handleArchiveDoneSessions}
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
          selectionMode={selectionMode}
          onToggleSelection={handleToggleSelectionMode}
        />
        {selectionMode && view !== 'workspaces' ? (
          <SelectionBar
            count={selectedIds.size}
            visibleCount={visibleCardIds.length}
            busy={batchBusy}
            allSelected={allVisibleSelected}
            onSelectAll={handleSelectAllVisible}
            onClear={handleClearSelection}
            onMove={(column) => void handleBatchAction('move', column)}
            onArchive={() => void handleBatchAction('archive')}
            onCancel={exitSelectionMode}
          />
        ) : null}
        <main className={`kb-main${loading ? ' kb-main--loading' : ''}`}>
          {/* v0.23.0：从「工作线」视图点一条线后，看板/列表/工作区只看这条线的卡片 */}
          {worklineFilter && view !== 'worklines' ? (
            <WorklineFilterBar
              selection={worklineFilter}
              cardCount={filteredCards.length}
              onClear={clearWorklineFilter}
            />
          ) : null}
          {main}
        </main>
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
            <span className="kb-kbd">W</span> {t('shortcut.worklines')}
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
            workspaces={workspaces}
            allCards={snapshot.cards}
            embedded={embedded}
            now={now}
            resolvingApprovalId={resolvingApprovalId}
            onClose={() => setActiveCardId(null)}
            actions={actions}
            onReply={handleReply}
            onResolveApproval={(card, approval, submission, comment, decision, sessionId) =>
              void handleResolveApproval(card, approval, submission, comment, decision, sessionId ?? undefined)
            }
            onNotify={notifyToast}
            onBindSession={(card, sessionId) => void handleBindSession(card, sessionId)}
            onUnbindSession={(card, sessionId) => void handleUnbindSession(card, sessionId)}
            onOpenSession={(sessionId) => void handleOpenSession(sessionId)}
            onSetPrimary={(card, sessionId) => void handleSetPrimary(card, sessionId)}
            onCreateSession={(card, options) => void handleCreateSession(card, options)}
            archivedSessionIds={archivedSessionIds}
            archiveAvailable={archiveAvailable && embedded}
            pendingSessionIds={pendingSessionIds}
            onArchiveSession={(card, sessionId) => handleArchiveSession(card, sessionId)}
            onUnarchiveSession={(card, sessionId) => void handleUnarchiveSession(card, sessionId)}
            cwdState={activeCardCwdState}
            onRebindDir={handleOpenRebind}
          />
        ) : null}

        {formState ? (
          <CardFormModal
            mode={formState.mode}
            {...(formState.mode === 'edit' ? { initial: formState.card } : {})}
            {...(formState.mode === 'create' ? { defaultColumn: formState.column } : {})}
            projects={projects}
            workspaces={workspaces}
            sessions={sessions}
            cards={snapshot.cards}
            embedded={embedded}
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

        {completeBlock ? (
          <ConfirmDialog
            title={t('complete.blockedTitle')}
            message={
              completeBlock.mode === 'batch'
                ? t('complete.blockedBatchBody', {
                    count: completeBlock.openChildren.length,
                    names: formatTitleList(
                      completeBlock.openChildren.map((child) => child.title),
                      lang,
                    ),
                  })
                : t('complete.blockedSingleBody', {
                    title: completeBlock.cardTitle,
                    count: completeBlock.openChildren.length,
                    names: formatTitleList(
                      completeBlock.openChildren.map((child) => child.title),
                      lang,
                    ),
                  })
            }
            confirmLabel={t('complete.confirm')}
            busyLabel={t('complete.confirming')}
            busy={completeBusy}
            onConfirm={() => void handleCompleteConfirm()}
            onClose={() => {
              if (!completeBusy) setCompleteBlock(null);
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

        {archiveSessionTarget ? (
          <ConfirmDialog
            title={t('sessionArchive.confirmTitle')}
            message={t('sessionArchive.confirmBody', { title: archiveSessionTarget.sessionTitle })}
            confirmLabel={t('sessionArchive.archive')}
            busyLabel={t('sessionArchive.confirming')}
            busy={archiveSessionBusy}
            onConfirm={() => void performArchiveSession(archiveSessionTarget, false)}
            onClose={() => {
              if (!archiveSessionBusy) setArchiveSessionTarget(null);
            }}
          />
        ) : null}

        {stopArchiveTarget ? (
          <StopAndArchiveDialog
            sessionTitle={stopArchiveTarget.sessionTitle}
            activity={stopArchiveTarget.activity}
            busy={archiveSessionBusy}
            onConfirm={handleStopAndArchiveConfirm}
            onClose={() => {
              if (!archiveSessionBusy) setStopArchiveTarget(null);
            }}
          />
        ) : null}

        {batchArchiveOpen ? (
          <SessionArchiveBatchDialog
            sessions={sessions}
            cards={snapshot.cards}
            onClose={() => setBatchArchiveOpen(false)}
            onCompleted={handleBatchArchiveCompleted}
            onUnavailable={handleArchiveUnavailable}
          />
        ) : null}

        {rebindTarget ? (
          <RebindDirDialog
            card={rebindTarget}
            candidates={rebindCandidates}
            busy={rebindBusy}
            error={rebindError}
            onSubmit={(path) => void handleRebindSubmit(path)}
            onClose={() => {
              if (!rebindBusy) setRebindTarget(null);
            }}
          />
        ) : null}

        {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}

        {nativeModal ? (
          <NativeAnswerModal
            key={nativeModal.id}
            entry={nativeModal}
            busy={nativeBusyIds.has(nativeModal.id)}
            onClose={() => setNativeModalId(null)}
            onSubmit={(answers) => void handleNativeSubmit(nativeModal, answers)}
            onDismiss={nativeModal.kind === 'plan-review' ? () => void handleNativeDismiss(nativeModal) : null}
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
