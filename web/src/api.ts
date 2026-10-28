import type {
  Activity,
  ActivityPage,
  Approval,
  ApprovalOutcome,
  ApprovalQuestion,
  Board,
  Card,
  ColumnId,
  GitContext,
  GitGraphCommit,
  GitGraphData,
  GitGraphRef,
  GitGraphRefKind,
  GitSummary,
  GitSummaryAvailable,
  GitSummaryBase,
  GitSummaryUnavailableReason,
  GitSummaryUpstream,
  GitUnavailableReason,
  GitWorkspaceRepo,
  GitWorkspacesResult,
  GitWorkspaceUnavailable,
  GitWorkspaceUpstream,
  GitWorkspaceWorktree,
  CleanupWorktreeInput,
  CleanupWorktreeResult,
  KanbanState,
  Priority,
  SessionActivityEntry,
  SessionRow,
  Status,
} from './types';
import type { CardFilters } from './lib/filter';
import { normalizeSessionIdList } from './lib/sessionArchive';

/** 契约里的错误码集合（未知 code 也按字符串处理）。 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'BAD_JSON'
  | 'TOO_LARGE'
  | 'BOARD_NOT_FOUND'
  | 'CARD_NOT_FOUND'
  | 'APPROVAL_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'FORBIDDEN_ORIGIN'
  | 'CONFLICT'
  | 'INTERNAL'
  | 'NETWORK'
  // ---- 会话归档/恢复（docs/11 §12.2）----
  | 'CARD_NOT_DONE'
  | 'SESSION_NOT_BOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY_CARDS'
  | 'SESSION_ACTIVE'
  | 'SESSION_ARCHIVE_UNAVAILABLE'
  | 'SESSION_ARCHIVE_FAILED';

/** 错误响应里附带的业务字段（服务端 `...extra` 原样带回）。 */
export interface ApiErrorDetails {
  /** VERSION_CONFLICT 时服务端回传的最新卡片 */
  card?: Card;
  /** SESSION_BUSY_CARDS：仍未完成的绑定卡片 */
  blockingCards?: Array<{ id: string; title: string; status: string }>;
  /** SESSION_ACTIVE：宿主返回的活动清单（turn/job/subagent/schedule） */
  activity?: SessionActivityEntry[];
  [key: string]: unknown;
}

export class KanbanApiError extends Error {
  readonly code: ApiErrorCode | string;
  readonly status: number;
  /** 错误响应里除 `ok` / `error` 外的业务字段。 */
  readonly details: ApiErrorDetails;
  /** VERSION_CONFLICT 时服务端回传的最新卡片，供 UI 合并。 */
  readonly card?: Card;

  constructor(code: ApiErrorCode | string, message: string, status = 0, details: ApiErrorDetails = {}) {
    super(message);
    this.name = 'KanbanApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.card = details.card;
  }
}

const BASE = '/api/kanban';

/**
 * 归一化卡片：冻结契约定的是「一律返回完整 Card」，但服务端种子/局部写回可能省略空字段；
 * UI 不假设字段一定存在，缺失时补安全默认值（不改变服务端语义）。
 */
export function normalizeCard(raw: Partial<Card> & { id: string }): Card {
  return {
    ...raw,
    title: raw.title ?? '',
    summary: raw.summary ?? '',
    status: raw.status ?? 'backlog',
    priority: raw.priority ?? 'none',
    labels: raw.labels ?? [],
    sessionIds: raw.sessionIds ?? [],
    checklists: raw.checklists ?? [],
    approvals: (raw.approvals ?? []).map((approval) => normalizeApproval(approval as Approval)),
    artifacts: raw.artifacts ?? [],
    metadata: { toolCalls: 0, searches: 0, ...(raw.metadata ?? {}) },
    order: raw.order ?? 0,
    version: raw.version ?? 1,
    createdAt: raw.createdAt ?? 0,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? 0,
    boardId: raw.boardId ?? 'board-default',
    ...(raw.handoff
      ? {
          handoff: {
            summary: raw.handoff.summary ?? '',
            ...(raw.handoff.nextSteps ? { nextSteps: raw.handoff.nextSteps } : {}),
            ...(raw.handoff.sessionId ? { sessionId: raw.handoff.sessionId } : {}),
            at: raw.handoff.at ?? 0,
            ...(raw.handoff.by ? { by: raw.handoff.by } : {}),
          },
        }
      : {}),
  } as Card;
}

/** 兼容旧 resolution（{optionId,label}）与新 resolution（{optionIds,labels}）。 */
export function normalizeApproval(raw: Approval & { resolution?: Partial<Approval['resolution']> & { optionId?: string; label?: string } }): Approval {
  const questions = raw.questions?.map((question, index) => ({
    ...question,
    id: question.id || `q-${index + 1}`,
    options: question.options ?? [],
    multiSelect: question.multiSelect === true,
  }));
  const resolution = raw.resolution;
  if (!resolution) return { ...raw, multiSelect: raw.multiSelect ?? false, ...(questions ? { questions } : {}) };
  const optionIds = resolution.optionIds ?? (resolution.optionId ? [resolution.optionId] : []);
  const labels = resolution.labels ?? (resolution.label ? [resolution.label] : []);
  const answers = resolution.answers?.map((answer) => ({
    questionId: answer.questionId,
    optionIds: answer.optionIds ?? [],
    labels: answer.labels ?? [],
    ...(typeof answer.custom === 'string' && answer.custom.trim() ? { custom: answer.custom } : {}),
  }));
  return {
    ...raw,
    multiSelect: raw.multiSelect ?? false,
    ...(questions ? { questions } : {}),
    resolution: { ...resolution, optionIds, labels, ...(answers ? { answers } : {}) },
  };
}

function normalizeCards(cards: readonly Partial<Card>[] | undefined): Card[] {
  return (cards ?? []).filter((card): card is Partial<Card> & { id: string } => Boolean(card?.id)).map(normalizeCard);
}

interface OkEnvelope {
  ok: true;
}
type Envelope<T> = OkEnvelope & T;

interface ErrEnvelope {
  ok: false;
  error?: { code?: string; message?: string };
  card?: Card;
  [extra: string]: unknown;
}

/** 从错误响应里拆出业务字段（card / blockingCards / activity 等）。 */
export function extractErrorDetails(payload: unknown): ApiErrorDetails {
  if (!payload || typeof payload !== 'object') return {};
  const details: ApiErrorDetails = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key === 'ok' || key === 'error') continue;
    details[key] = value;
  }
  return details;
}

async function request<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new KanbanApiError('NETWORK', message, 0);
  }

  let payload: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const err = (payload as ErrEnvelope | null)?.error;
    throw new KanbanApiError(
      err?.code ?? 'INTERNAL',
      err?.message ?? `HTTP ${response.status}`,
      response.status,
      extractErrorDetails(payload),
    );
  }
  if (!payload || typeof payload !== 'object' || (payload as OkEnvelope).ok !== true) {
    throw new KanbanApiError('INTERNAL', '响应格式不符合契约', response.status);
  }
  return payload as Envelope<T>;
}

export interface CreateCardInput {
  boardId: string;
  title: string;
  summary?: string;
  status?: Status;
  priority?: Priority;
  labels?: string[];
  project?: string;
  workspaceId?: string;
  cwd?: string;
  sessionId?: string;
  agent?: { name: string };
}

export type CardChanges = Partial<
  Pick<
    Card,
    | 'title'
    | 'summary'
    | 'currentAction'
    | 'result'
    | 'status'
    | 'priority'
    | 'labels'
    | 'project'
    | 'workspaceId'
    | 'cwd'
    | 'agent'
    | 'progress'
    | 'checklists'
    | 'artifacts'
    | 'metadata'
    | 'order'
    | 'handoff'
  >
>;

export interface MoveOptions {
  version?: number;
  beforeId?: string;
  afterId?: string;
}

export type ApprovalCreateInput =
  | {
      title: string;
      detail: string;
      options: { id: string; label: string; description?: string; tone?: 'primary' | 'danger' | 'ghost'; outcome?: ApprovalOutcome }[];
      multiSelect?: boolean;
      sessionId?: string;
    }
  | {
      /** v0.3 多问题：标题由服务端/第一题派生 */
      questions: ApprovalQuestion[];
      detail?: string;
      sessionId?: string;
    };

export type ApprovalResolveInput =
  | { optionIds: string[]; comment?: string }
  | {
      answers: { questionId: string; optionIds: string[]; custom?: string }[];
      comment?: string;
    };

export type BatchAction = 'archive' | 'move';

export interface HealthPayload {
  version: string;
  schemaVersion: number;
  dataDir: string;
  revision: number;
}

/** state 响应在冻结契约之外可能附带 activities（时间线）；两者都容忍。 */
export type StatePayload = KanbanState & { activities?: Activity[] };

// ------------------------------------------------------------ 会话归档/恢复（docs/11 §12.2）

/** GET /sessions/archive：宿主是否提供可逆归档 + 当前归档集合。 */
export interface SessionArchiveState {
  available: boolean;
  archivedSessionIds: string[];
}

/** 单卡归档/恢复的成功响应。 */
export interface SessionArchiveResult {
  card: Card;
  revision: number;
  archivedSessionIds: string[];
  /** 归档成功但时间线活动写入失败时的服务端警告（不阻塞 UI） */
  warning?: string;
}

export interface SessionArchiveBatchItem {
  sessionId: string;
  /** 代表卡（写时间线用） */
  cardId: string;
  /** 该会话绑定到的全部已完成卡（服务端一并返回） */
  cardIds: string[];
}

export interface SessionArchiveBatchSkippedItem {
  sessionId: string;
  cardId?: string;
  cardIds?: string[];
  /** 服务端原因：already_archived / blocking_cards / running / missing / failed 等 */
  reason: string;
  blockingCards?: Array<{ id: string; title: string; status: string }>;
  activity?: unknown[];
  message?: string;
}

export interface SessionArchiveBatchResult {
  dryRun: boolean;
  /** 宿主是否提供可逆归档（服务端回填，便于前端同步隐藏入口） */
  available?: boolean;
  archivable: SessionArchiveBatchItem[];
  skipped: SessionArchiveBatchSkippedItem[];
  archivedSessionIds: string[];
  revision?: number;
}

export interface ArchiveCardSessionOptions {
  /** 会话仍在运行时的用户二次确认后置 true：先停活再归档（会丢弃排队输入/删除定时任务） */
  stopActivity?: boolean;
}

export interface ArchiveSessionsBatchInput {
  scope: 'done';
  cardIds?: Iterable<string>;
  dryRun?: boolean;
  stopActivity?: boolean;
}

function normalizeArchivedSessionIds(value: unknown): string[] {
  return normalizeSessionIdList(value);
}

function normalizeArchiveResult(result: {
  card: Card;
  revision?: number;
  archivedSessionIds?: string[];
  warning?: string;
}): SessionArchiveResult {
  return {
    card: normalizeCard(result.card),
    revision: result.revision ?? 0,
    archivedSessionIds: normalizeArchivedSessionIds(result.archivedSessionIds),
    ...(typeof result.warning === 'string' && result.warning ? { warning: result.warning } : {}),
  };
}

async function getActivities(
  cardId: string,
  options: { limit?: number; before?: string } = {},
): Promise<ActivityPage> {
  try {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.before) params.set('before', options.before);
    const query = params.toString();
    const result = await request<{ activities?: Activity[]; hasMore?: boolean; nextBefore?: string }>(
      `/cards/${encodeURIComponent(cardId)}/activities${query ? `?${query}` : ''}`,
    );
    const activities = result.activities ?? [];
    return {
      activities,
      hasMore: result.hasMore ?? activities.length >= (options.limit ?? 30),
      nextBefore: result.nextBefore ?? activities[activities.length - 1]?.id,
    };
  } catch {
    return { activities: [], hasMore: false };
  }
}

/** git 上下文不可用原因枚举（契约 §3.1）；未知值一律归到 error。 */
const GIT_UNAVAILABLE_REASONS: readonly GitUnavailableReason[] = [
  'no_cwd',
  'missing',
  'not_git',
  'no_commits',
  'timeout',
  'error',
];

function normalizeGitReason(value: unknown): GitUnavailableReason {
  return GIT_UNAVAILABLE_REASONS.find((reason) => reason === value) ?? 'error';
}

/** git 摘要不可用原因（比详情多一个 forbidden）。 */
const GIT_SUMMARY_REASONS: readonly GitSummaryUnavailableReason[] = [...GIT_UNAVAILABLE_REASONS, 'forbidden'];

function normalizeGitSummaryReason(value: unknown): GitSummaryUnavailableReason {
  return GIT_SUMMARY_REASONS.find((reason) => reason === value) ?? 'error';
}

function normalizeSummaryBase(raw: unknown): GitSummaryBase | null {
  if (!raw || typeof raw !== 'object') return null;
  const base = raw as Partial<GitSummaryBase>;
  return {
    kind: base.kind === 'upstream' ? 'upstream' : 'main',
    ahead: typeof base.ahead === 'number' && base.ahead > 0 ? base.ahead : 0,
    behind: typeof base.behind === 'number' && base.behind > 0 ? base.behind : 0,
  };
}

function normalizeSummaryUpstream(raw: unknown): GitSummaryUpstream | null {
  if (!raw || typeof raw !== 'object') return null;
  const upstream = raw as Partial<GitSummaryUpstream>;
  if (typeof upstream.ref !== 'string' || !upstream.ref) return null;
  return {
    ref: upstream.ref,
    ahead: typeof upstream.ahead === 'number' && upstream.ahead > 0 ? upstream.ahead : 0,
    behind: typeof upstream.behind === 'number' && upstream.behind > 0 ? upstream.behind : 0,
  };
}

/**
 * 容错归一化单条 Git 摘要（`POST /git/summaries` 的 summaries value）。
 * available 缺失/非 true → 按不可用处理（reason 未知归 error），保证徽标降级为「未知」而不是谎报。
 */
export function normalizeGitSummary(raw: unknown): GitSummary {
  if (!raw || typeof raw !== 'object' || (raw as { available?: unknown }).available !== true) {
    const reason = raw && typeof raw === 'object' ? (raw as { reason?: unknown }).reason : null;
    return { available: false, reason: normalizeGitSummaryReason(reason) };
  }
  const summary = raw as Partial<GitSummaryAvailable>;
  return {
    available: true,
    dir: typeof summary.dir === 'string' ? summary.dir : '',
    branch: typeof summary.branch === 'string' ? summary.branch : null,
    detached: summary.detached === true,
    mainBranch: typeof summary.mainBranch === 'string' ? summary.mainBranch : null,
    base: normalizeSummaryBase(summary.base),
    upstream: normalizeSummaryUpstream(summary.upstream),
    isWorktree: summary.isWorktree === true,
    worktreePath: typeof summary.worktreePath === 'string' ? summary.worktreePath : null,
  };
}

/** 容错归一化批量摘要：key 按请求原文保留（服务端契约 §11），非法条目丢弃。 */
export function normalizeGitSummaries(raw: unknown): Record<string, GitSummary> {
  if (!raw || typeof raw !== 'object') return {};
  const summaries: Record<string, GitSummary> = {};
  for (const [dir, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!dir) continue;
    summaries[dir] = normalizeGitSummary(value);
  }
  return summaries;
}

function normalizeNullableCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeWorkspaceUpstream(raw: unknown): GitWorkspaceUpstream | null {
  if (!raw || typeof raw !== 'object') return null;
  const upstream = raw as Partial<GitWorkspaceUpstream>;
  if (typeof upstream.ref !== 'string' || !upstream.ref) return null;
  return {
    ref: upstream.ref,
    ahead: typeof upstream.ahead === 'number' && upstream.ahead > 0 ? upstream.ahead : 0,
    behind: typeof upstream.behind === 'number' && upstream.behind > 0 ? upstream.behind : 0,
  };
}

function normalizeWorkspaceWorktree(raw: unknown): GitWorkspaceWorktree | null {
  if (!raw || typeof raw !== 'object') return null;
  const worktree = raw as Partial<GitWorkspaceWorktree>;
  if (typeof worktree.path !== 'string' || !worktree.path) return null;
  const sha = typeof worktree.sha === 'string' ? worktree.sha : '';
  // v0.17 增量字段：旧服务端没有 → 保持字段缺失（前端按「未知」处理，不谎报）
  const mergedIntoBase =
    worktree.mergedIntoBase === true ? true : worktree.mergedIntoBase === false ? false : worktree.mergedIntoBase === null ? null : undefined;
  const upstream =
    worktree.upstream === undefined
      ? undefined
      : worktree.upstream === null
        ? null
        : normalizeWorkspaceUpstream(worktree.upstream);
  return {
    path: worktree.path,
    branch: typeof worktree.branch === 'string' ? worktree.branch : null,
    detached: worktree.detached === true,
    sha,
    shortSha: typeof worktree.shortSha === 'string' && worktree.shortSha ? worktree.shortSha : sha.slice(0, 7),
    isMain: worktree.isMain === true,
    isCurrent: worktree.isCurrent === true,
    aheadOfBase: normalizeNullableCount(worktree.aheadOfBase),
    behindOfBase: normalizeNullableCount(worktree.behindOfBase),
    dirty: worktree.dirty === true,
    ...(Array.isArray(worktree.dirs)
      ? { dirs: worktree.dirs.filter((dir): dir is string => typeof dir === 'string' && Boolean(dir.trim())) }
      : {}),
    ...(mergedIntoBase === undefined ? {} : { mergedIntoBase }),
    ...(upstream === undefined ? {} : { upstream }),
    ...(typeof worktree.modifiedCount === 'number' && worktree.modifiedCount >= 0
      ? { modifiedCount: worktree.modifiedCount }
      : {}),
    ...(typeof worktree.untrackedCount === 'number' && worktree.untrackedCount >= 0
      ? { untrackedCount: worktree.untrackedCount }
      : {}),
    ...(typeof worktree.locked === 'boolean' ? { locked: worktree.locked } : {}),
    ...(typeof worktree.prunable === 'boolean' ? { prunable: worktree.prunable } : {}),
    ...(typeof worktree.lastCommitAt === 'string' || worktree.lastCommitAt === null
      ? { lastCommitAt: typeof worktree.lastCommitAt === 'string' ? worktree.lastCommitAt : null }
      : {}),
  };
}

function normalizeWorkspaceRepo(raw: unknown): GitWorkspaceRepo | null {
  if (!raw || typeof raw !== 'object') return null;
  const repo = raw as Partial<GitWorkspaceRepo>;
  if (typeof repo.root !== 'string' || !repo.root) return null;
  const worktrees = Array.isArray(repo.worktrees)
    ? repo.worktrees.map(normalizeWorkspaceWorktree).filter((item): item is GitWorkspaceWorktree => item !== null)
    : [];
  if (!worktrees.length) return null;
  const root = repo.root;
  return {
    root,
    name: typeof repo.name === 'string' && repo.name ? repo.name : root.split('/').filter(Boolean).pop() ?? root,
    commonDir: typeof repo.commonDir === 'string' ? repo.commonDir : '',
    mainBranch: typeof repo.mainBranch === 'string' ? repo.mainBranch : null,
    worktrees,
  };
}

function normalizeWorkspaceUnavailable(raw: unknown): GitWorkspaceUnavailable | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<GitWorkspaceUnavailable>;
  if (typeof item.dir !== 'string' || !item.dir) return null;
  return {
    dir: item.dir,
    reason: normalizeGitSummaryReason(item.reason),
    ...(typeof item.message === 'string' && item.message ? { message: item.message } : {}),
  };
}

/** 容错归一化清理结果（contract §13 的 `cleanup` 对象）。 */
export function normalizeCleanupResult(raw: unknown): CleanupWorktreeResult {
  const payload = raw && typeof raw === 'object' ? (raw as Partial<CleanupWorktreeResult>) : {};
  return {
    repoRoot: typeof payload.repoRoot === 'string' ? payload.repoRoot : '',
    worktreePath: typeof payload.worktreePath === 'string' ? payload.worktreePath : '',
    trashedTo: typeof payload.trashedTo === 'string' ? payload.trashedTo : '',
    branchName: typeof payload.branchName === 'string' ? payload.branchName : null,
    branchDeleted: payload.branchDeleted === true,
    trashRetentionDays:
      typeof payload.trashRetentionDays === 'number' && payload.trashRetentionDays > 0
        ? payload.trashRetentionDays
        : 7,
  };
}

/**
 * 容错归一化工作区地图（`POST /git/workspaces`）。
 * repos 缺省 []；单条非法仓库/工作副本直接丢弃；disabled 仅接受显式 true。
 */
export function normalizeGitWorkspaces(raw: unknown): GitWorkspacesResult {
  if (!raw || typeof raw !== 'object') return { repos: [], unavailable: [], disabled: false };
  const payload = raw as Partial<GitWorkspacesResult>;
  const repos = Array.isArray(payload.repos)
    ? payload.repos.map(normalizeWorkspaceRepo).filter((repo): repo is GitWorkspaceRepo => repo !== null)
    : [];
  const unavailable = Array.isArray(payload.unavailable)
    ? payload.unavailable
        .map(normalizeWorkspaceUnavailable)
        .filter((item): item is GitWorkspaceUnavailable => item !== null)
    : [];
  return { repos, unavailable, disabled: payload.disabled === true };
}

/**
 * 容错归一化 git 上下文：服务端字段缺失时不让抽屉渲染崩溃。
 * 数组缺失 → 空数组（图退化为空、组件整块隐藏）；available 缺失 → 按不可用处理。
 */
/** graph 引用类型枚举（契约 §4.5）；未知值按名称推断。 */
const GIT_GRAPH_REF_KINDS: readonly GitGraphRefKind[] = ['head', 'branch', 'remote'];

function inferGraphRefKind(name: string): GitGraphRefKind {
  if (name === 'HEAD') return 'head';
  if (name.includes('/')) return 'remote';
  return 'branch';
}

function normalizeGraphRef(raw: unknown): GitGraphRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const ref = raw as Partial<GitGraphRef>;
  if (typeof ref.name !== 'string' || !ref.name || typeof ref.sha !== 'string' || !ref.sha) return null;
  const kind = GIT_GRAPH_REF_KINDS.find((item) => item === ref.kind) ?? inferGraphRefKind(ref.name);
  return {
    name: ref.name,
    kind,
    sha: ref.sha,
    shortSha: typeof ref.shortSha === 'string' && ref.shortSha ? ref.shortSha : ref.sha.slice(0, 7),
    branch: typeof ref.branch === 'string' ? ref.branch : null,
    ...(typeof ref.isCurrent === 'boolean' ? { isCurrent: ref.isCurrent } : {}),
    upstream: typeof ref.upstream === 'string' ? ref.upstream : null,
    ahead: typeof ref.ahead === 'number' ? ref.ahead : null,
    behind: typeof ref.behind === 'number' ? ref.behind : null,
  };
}

function normalizeGraphCommit(raw: unknown): GitGraphCommit | null {
  if (!raw || typeof raw !== 'object') return null;
  const commit = raw as Partial<GitGraphCommit>;
  if (typeof commit.sha !== 'string' || !commit.sha) return null;
  return {
    sha: commit.sha,
    shortSha: typeof commit.shortSha === 'string' && commit.shortSha ? commit.shortSha : commit.sha.slice(0, 7),
    subject: typeof commit.subject === 'string' ? commit.subject : '',
    authorName: typeof commit.authorName === 'string' ? commit.authorName : '',
    committedAt: typeof commit.committedAt === 'number' ? commit.committedAt : 0,
    parents: Array.isArray(commit.parents)
      ? commit.parents.filter((sha): sha is string => typeof sha === 'string' && sha.length > 0)
      : [],
  };
}

/**
 * 容错归一化多分支图：缺字段/格式不对时返回 undefined（按旧服务端处理，整块隐藏）。
 * 数组里非法条目直接丢弃；parents 保证为字符串数组（合并提交拓扑依赖它）。
 */
function normalizeGitGraph(raw: unknown): GitGraphData | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const graph = raw as Partial<GitGraphData>;
  if (!Array.isArray(graph.commits)) return undefined;
  const commits = graph.commits
    .map(normalizeGraphCommit)
    .filter((commit): commit is GitGraphCommit => commit !== null);
  const refs = Array.isArray(graph.refs)
    ? graph.refs.map(normalizeGraphRef).filter((ref): ref is GitGraphRef => ref !== null)
    : [];
  if (!commits.length && !refs.length) return undefined;
  return {
    refs,
    ...(typeof graph.refsTruncated === 'number' && graph.refsTruncated > 0
      ? { refsTruncated: graph.refsTruncated }
      : {}),
    commits,
    truncated: typeof graph.truncated === 'number' && graph.truncated > 0 ? graph.truncated : 0,
    ...(typeof graph.maxCommits === 'number' ? { maxCommits: graph.maxCommits } : {}),
    ...(typeof graph.maxRefs === 'number' ? { maxRefs: graph.maxRefs } : {}),
  };
}

function normalizeGitContext(raw: GitContext | null | undefined): GitContext {
  if (!raw || typeof raw !== 'object' || raw.available !== true) {
    return {
      available: false,
      reason: normalizeGitReason(raw && typeof raw === 'object' ? raw.reason : null),
      message: raw && typeof raw === 'object' ? raw.message ?? null : null,
      requestedDir: raw && typeof raw === 'object' ? raw.requestedDir ?? null : null,
    };
  }
  if (!raw.dir || !raw.current || !raw.repo) {
    throw new KanbanApiError('INTERNAL', 'git 响应缺少必要字段');
  }
  const graph = normalizeGitGraph(raw.graph);
  return {
    ...raw,
    // 旧服务端没有 graph：保持字段缺失（前端整块隐藏，不回退两泳道）
    ...(graph ? { graph } : {}),
    upstream: raw.upstream ?? null,
    base: raw.base
      ? {
          ...raw.base,
          remoteRef: raw.base.remoteRef ?? null,
          remoteAhead: raw.base.remoteAhead ?? null,
          remoteBehind: raw.base.remoteBehind ?? null,
          mergeBase: raw.base.mergeBase ?? null,
        }
      : null,
    worktrees: raw.worktrees ?? [],
    worktreesTruncated: raw.worktreesTruncated ?? 0,
    commits: {
      ahead: raw.commits?.ahead ?? [],
      behind: raw.commits?.behind ?? [],
      shared: raw.commits?.shared ?? [],
    },
    refs: raw.refs ?? [],
  };
}

/** POST /cards/:id/session 的响应：新绑定或主会话切换；已是主会话时 activity 为 null（幂等）。 */
export interface BindSessionResult {
  card: Card;
  revision: number;
  activity?: Activity | null;
  linked?: boolean;
  primaryChanged?: boolean;
  primarySessionId?: string | null;
}

export const api = {
  getHealth: (): Promise<HealthPayload> => request<HealthPayload>('/health'),

  getState: async (boardId?: string): Promise<StatePayload> => {
    const suffix = boardId ? `?boardId=${encodeURIComponent(boardId)}` : '';
    const payload = await request<StatePayload>(`/state${suffix}`);
    return { ...payload, cards: normalizeCards(payload.cards) };
  },

  getBoards: (): Promise<{ boards: Board[] }> => request<{ boards: Board[] }>('/boards'),

  createCard: async (input: CreateCardInput): Promise<{ card: Card; revision: number }> => {
    const result = await request<{ card: Card; revision: number }>('/cards', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return { ...result, card: normalizeCard(result.card) };
  },

  updateCard: (
    cardId: string,
    version: number,
    changes: CardChanges,
    actor?: { kind: 'user' | 'agent' | 'system'; name: string },
  ): Promise<{ card: Card; revision: number }> =>
    request<{ card: Card; revision: number }>(`/cards/${encodeURIComponent(cardId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ version, changes, actor }),
    }).then((result) => ({ ...result, card: normalizeCard(result.card) })),

  archiveCard: (cardId: string, version?: number): Promise<{ revision: number }> =>
    request<{ revision: number }>(`/cards/${encodeURIComponent(cardId)}`, {
      method: 'DELETE',
      body: JSON.stringify(typeof version === 'number' ? { version } : {}),
    }),

  moveCard: (cardId: string, column: ColumnId, options: MoveOptions = {}): Promise<{ card: Card; revision: number }> =>
    request<{ card: Card; revision: number }>(`/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'POST',
      body: JSON.stringify({ column, ...options }),
    }).then((result) => ({ ...result, card: normalizeCard(result.card) })),

  /** v1.1 批量归档/移动：POST /cards/batch（cardIds 1..200；move 必带 column）。 */
  batchCards: (
    action: BatchAction,
    cardIds: readonly string[],
    column?: ColumnId,
  ): Promise<{ cards: Card[]; revision: number }> =>
    request<{ cards: Card[]; revision: number }>('/cards/batch', {
      method: 'POST',
      body: JSON.stringify({
        action,
        cardIds: [...cardIds],
        ...(action === 'move' ? { column } : {}),
      }),
    }).then((result) => ({ ...result, cards: (result.cards ?? []).map((card) => normalizeCard(card)) })),

  addComment: (cardId: string, text: string): Promise<{ activity: Activity; card: Card; revision: number }> =>
    request<{ activity: Activity; card: Card; revision: number }>(
      `/cards/${encodeURIComponent(cardId)}/comments`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ).then((result) => ({ ...result, card: normalizeCard(result.card) })),

  createApproval: (
    cardId: string,
    input: ApprovalCreateInput,
  ): Promise<{ approval: Approval; card: Card; revision: number }> =>
    request<{ approval: Approval; card: Card; revision: number }>(
      `/cards/${encodeURIComponent(cardId)}/approvals`,
      { method: 'POST', body: JSON.stringify(input) },
    ).then((result) => ({
      ...result,
      approval: normalizeApproval(result.approval),
      card: normalizeCard(result.card),
    })),

  resolveApproval: (
    cardId: string,
    approvalId: string,
    input: ApprovalResolveInput,
  ): Promise<{ approval: Approval; card: Card; revision: number }> => {
    const body =
      'answers' in input
        ? { answers: input.answers, comment: input.comment }
        : {
            optionIds: input.optionIds,
            // optionId 同时带上以兼容尚未升级的 dev-server
            optionId: input.optionIds[0],
            comment: input.comment,
          };
    return request<{ approval: Approval; card: Card; revision: number }>(
      `/cards/${encodeURIComponent(cardId)}/approvals/${encodeURIComponent(approvalId)}/resolve`,
      { method: 'POST', body: JSON.stringify(body) },
    ).then((result) => ({
      ...result,
      approval: normalizeApproval(result.approval),
      card: normalizeCard(result.card),
    }));
  },

  /**
   * 绑定会话 / 设为主会话：服务端把该会话放到 sessionIds[0]。
   * 已绑定但不是主会话时写 `session_primary` 节点（activity 非空，linked=false）；
   * 已是主会话时幂等（activity=null、primaryChanged=false，不写时间线）。
   */
  bindSession: (cardId: string, sessionId: string, title?: string): Promise<BindSessionResult> =>
    request<BindSessionResult>(`/cards/${encodeURIComponent(cardId)}/session`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, title }),
    }).then((result) => ({ ...result, card: normalizeCard(result.card) })),

  unbindSession: (cardId: string, sessionId: string): Promise<{ card: Card; revision: number }> =>
    request<{ card: Card; revision: number }>(
      `/cards/${encodeURIComponent(cardId)}/session/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ).then((result) => ({ ...result, card: normalizeCard(result.card) })),

  /** 会话归档状态与宿主能力（嵌入模式下挂载时回填，之后以桥推送为准）。 */
  getSessionArchiveState: async (): Promise<SessionArchiveState> => {
    const result = await request<{ available?: boolean; archivedSessionIds?: string[] }>('/sessions/archive');
    return {
      available: result.available === true,
      archivedSessionIds: normalizeArchivedSessionIds(result.archivedSessionIds),
    };
  },

  /** 从某张已完成卡归档其绑定会话；运行中会话首次调用会得到 SESSION_ACTIVE。 */
  archiveCardSession: (
    cardId: string,
    sessionId: string,
    options: ArchiveCardSessionOptions = {},
  ): Promise<SessionArchiveResult> =>
    request<{ card: Card; revision?: number; archivedSessionIds?: string[]; warning?: string }>(
      `/cards/${encodeURIComponent(cardId)}/sessions/${encodeURIComponent(sessionId)}/archive`,
      { method: 'POST', body: JSON.stringify(options.stopActivity === true ? { stopActivity: true } : {}) },
    ).then(normalizeArchiveResult),

  /** 恢复（取消归档）某张卡绑定的会话；宿主幂等。 */
  unarchiveCardSession: (cardId: string, sessionId: string): Promise<SessionArchiveResult> =>
    request<{ card: Card; revision?: number; archivedSessionIds?: string[]; warning?: string }>(
      `/cards/${encodeURIComponent(cardId)}/sessions/${encodeURIComponent(sessionId)}/unarchive`,
      { method: 'POST', body: '{}' },
    ).then(normalizeArchiveResult),

  /** 已完成卡片的批量/历史会话归档；`dryRun` 先预览 archivable / skipped。 */
  archiveSessionsBatch: async (input: ArchiveSessionsBatchInput): Promise<SessionArchiveBatchResult> => {
    const cardIds = input.cardIds ? [...input.cardIds] : [];
    const result = await request<{
      dryRun?: boolean;
      available?: boolean;
      archivable?: SessionArchiveBatchItem[];
      skipped?: SessionArchiveBatchSkippedItem[];
      archivedSessionIds?: string[];
      revision?: number;
    }>('/sessions/archive-batch', {
      method: 'POST',
      body: JSON.stringify({
        scope: input.scope,
        ...(cardIds.length ? { cardIds } : {}),
        ...(input.dryRun ? { dryRun: true } : {}),
        ...(input.stopActivity ? { stopActivity: true } : {}),
      }),
    });
    return {
      dryRun: result.dryRun === true,
      ...(typeof result.available === 'boolean' ? { available: result.available } : {}),
      archivable: Array.isArray(result.archivable)
        ? result.archivable
            .filter((item) => item && typeof item.sessionId === 'string')
            .map((item) => ({
              sessionId: item.sessionId,
              cardId: item.cardId ?? (item.cardIds?.[0] ?? ''),
              cardIds: Array.isArray(item.cardIds)
                ? item.cardIds.filter((id): id is string => typeof id === 'string')
                : item.cardId
                  ? [item.cardId]
                  : [],
            }))
        : [],
      skipped: Array.isArray(result.skipped)
        ? result.skipped
            .filter((item) => item && typeof item.sessionId === 'string')
            .map((item) => ({
              ...item,
              reason: typeof item.reason === 'string' ? item.reason : 'failed',
            }))
        : [],
      archivedSessionIds: normalizeArchivedSessionIds(result.archivedSessionIds),
      ...(typeof result.revision === 'number' ? { revision: result.revision } : {}),
    };
  },

  /**
   * 卡片 Git 上下文（docs/contracts/06-git-context.md）：
   * `cwd` 是「卡片主会话执行目录」候选，服务端只在同仓库 linked worktree 方向正确时采用。
   * 业务失败（无 cwd / 非 git 仓库等）也是 200 + `available:false`；网络/旧服务端 404 会抛错，
   * 由调用方（useCardGit）兜底静默隐藏区块。
   */
  getCardGit: async (cardId: string, options: { cwd?: string } = {}): Promise<GitContext> => {
    const params = new URLSearchParams();
    if (options.cwd) params.set('cwd', options.cwd);
    const query = params.toString();
    const result = await request<{ git?: GitContext | null }>(
      `/cards/${encodeURIComponent(cardId)}/git${query ? `?${query}` : ''}`,
    );
    return normalizeGitContext(result.git);
  },

  /**
   * v0.15 批量 Git 摘要（卡片「工作线」徽标，docs/contracts/02-http-api.md §11）：
   * `dirs` 1–32 个，服务端按请求原文做 key；网络/HTTP 错误向上抛，由 useWorklineStatuses 兜底为未知。
   */
  getGitSummaries: async (dirs: string[]): Promise<Record<string, GitSummary>> => {
    const result = await request<{ summaries?: Record<string, unknown> }>('/git/summaries', {
      method: 'POST',
      body: JSON.stringify({ dirs }),
    });
    return normalizeGitSummaries(result.summaries);
  },

  /**
   * v0.16 工作区地图（「工作区」视图，docs/contracts/02-http-api.md §12）：
   * `dirs` 1–32 个卡片 cwd；返回按仓库聚合的工作副本与不可用项，网络/HTTP 错误向上抛。
   */
  getGitWorkspaces: async (dirs: string[]): Promise<GitWorkspacesResult> => {
    const result = await request<Partial<GitWorkspacesResult>>('/git/workspaces', {
      method: 'POST',
      body: JSON.stringify({ dirs }),
    });
    return normalizeGitWorkspaces(result);
  },

  /**
   * v0.17 清理工作副本（软删除，docs/contracts/02-http-api.md §13）：
   * 把目录移入回收站 + prune + 可选删本地分支；服务端会重新校验（卡片占用/脏/未合并），
   * 失败抛 KanbanApiError（code / details.reason 兼容两种形态），由调用方映射成人话。
   */
  cleanupWorktree: async (input: CleanupWorktreeInput): Promise<CleanupWorktreeResult> => {
    const result = await request<{ cleanup?: Partial<CleanupWorktreeResult> }>('/git/worktrees/cleanup', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return normalizeCleanupResult(result.cleanup);
  },

  ack: (cardId: string): Promise<{ revision: number }> =>
    request<{ revision: number }>(`/cards/${encodeURIComponent(cardId)}/ack`, { method: 'POST', body: '{}' }),

  seed: (mode: 'demo' | 'empty' | 'reset'): Promise<{ revision: number }> =>
    request<{ revision: number }>('/seed', { method: 'POST', body: JSON.stringify({ mode }) }),

  getCardActivities: getActivities,
};

export type { ActivityPage, SessionRow };

/** 批量归档/移动的具名封装（App 与单测共用；参数与 POST /cards/batch 契约一致）。 */
export function batchCards(
  action: BatchAction,
  cardIds: readonly string[],
  column?: ColumnId,
): Promise<{ cards: Card[]; revision: number }> {
  return api.batchCards(action, cardIds, column);
}

/** 供调试与测试使用：把筛选条件映射成查询串（当前筛选在客户端做）。 */
export function filtersToQuery(filters: CardFilters): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('q', filters.query);
  if (filters.project) params.set('project', filters.project);
  return params.toString();
}
