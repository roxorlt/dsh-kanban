import type {
  Activity,
  ActivityPage,
  Approval,
  ApprovalAnswer,
  ApprovalQuestion,
  Board,
  Card,
  ColumnId,
  KanbanState,
  Priority,
  SessionRow,
  Status,
} from './types';
import type { CardFilters } from './lib/filter';

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
  | 'NETWORK';

export class KanbanApiError extends Error {
  readonly code: ApiErrorCode | string;
  readonly status: number;
  /** VERSION_CONFLICT 时服务端回传的最新卡片，供 UI 合并。 */
  readonly card?: Card;

  constructor(code: ApiErrorCode | string, message: string, status = 0, card?: Card) {
    super(message);
    this.name = 'KanbanApiError';
    this.code = code;
    this.status = status;
    this.card = card;
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
      (payload as ErrEnvelope | null)?.card,
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
      options: { id: string; label: string; description?: string; tone?: 'primary' | 'danger' | 'ghost' }[];
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
  | { answers: Pick<ApprovalAnswer, 'questionId' | 'optionIds'>[]; comment?: string };

export interface HealthPayload {
  version: string;
  schemaVersion: number;
  dataDir: string;
  revision: number;
}

/** state 响应在冻结契约之外可能附带 activities（时间线）；两者都容忍。 */
export type StatePayload = KanbanState & { activities?: Activity[] };

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

  bindSession: (cardId: string, sessionId: string, title?: string): Promise<{ card: Card; revision: number }> =>
    request<{ card: Card; revision: number }>(`/cards/${encodeURIComponent(cardId)}/session`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, title }),
    }).then((result) => ({ ...result, card: normalizeCard(result.card) })),

  unbindSession: (cardId: string, sessionId: string): Promise<{ card: Card; revision: number }> =>
    request<{ card: Card; revision: number }>(
      `/cards/${encodeURIComponent(cardId)}/session/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ).then((result) => ({ ...result, card: normalizeCard(result.card) })),

  ack: (cardId: string): Promise<{ revision: number }> =>
    request<{ revision: number }>(`/cards/${encodeURIComponent(cardId)}/ack`, { method: 'POST', body: '{}' }),

  seed: (mode: 'demo' | 'empty' | 'reset'): Promise<{ revision: number }> =>
    request<{ revision: number }>('/seed', { method: 'POST', body: JSON.stringify({ mode }) }),

  getCardActivities: getActivities,
};

export type { ActivityPage, SessionRow };

/** 供调试与测试使用：把筛选条件映射成查询串（当前筛选在客户端做）。 */
export function filtersToQuery(filters: CardFilters): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('q', filters.query);
  if (filters.project) params.set('project', filters.project);
  if (filters.label) params.set('label', filters.label);
  return params.toString();
}
