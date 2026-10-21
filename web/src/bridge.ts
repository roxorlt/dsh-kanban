/**
 * 看板 ↔ DSH 客户端桥（docs/contracts/03-client-bridge.md）。
 * 只负责 postMessage 通道、主题令牌注入与会话/面板能力；
 * 不掺 HTTP API 逻辑（那在 api.ts）。
 */
import { useEffect, useState } from 'react';
import type { HostInfo, SessionRow } from './types';

export type BridgeMethod =
  | 'app.info'
  | 'sessions.list'
  | 'sessions.refresh'
  | 'session.open'
  | 'session.create'
  | 'session.prompt'
  | 'session.ensure'
  | 'card.open'
  | 'panel.select'
  | 'toast';

export interface BridgeParamsMap {
  'app.info': undefined;
  'sessions.list': undefined;
  'sessions.refresh': undefined;
  'session.open': { sessionId: string };
  'session.create': { cwd?: string; workspaceId?: string; title?: string };
  'session.prompt': { sessionId: string; text: string; mode?: 'queue' | 'steer' };
  'session.ensure': { sessionId?: string; cwd?: string; workspaceId?: string; text: string };
  'card.open': { cardId: string; boardId: string };
  'panel.select': { panel: 'kanban' | 'conversation' };
  toast: { text: string; tone?: 'info' | 'success' | 'error' };
}

export interface BridgeDataMap {
  'app.info': HostInfo;
  'sessions.list': { sessions: SessionRow[]; current: string | null };
  'sessions.refresh': { sessions: SessionRow[]; current: string | null };
  'session.open': { ok: true };
  'session.create': { sessionId: string };
  'session.prompt': { accepted: true };
  'session.ensure': { sessionId: string; created: boolean };
  'card.open': { ok: true };
  'panel.select': { ok: true };
  toast: { ok: true };
}

interface RequestMessage {
  type: 'kanban:request';
  version: 1;
  requestId: string;
  method: BridgeMethod;
  params?: unknown;
}

interface ResponseMessage {
  type: 'kanban:response';
  version: 1;
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

type ParentPush =
  | { type: 'kanban:theme'; version: 1; mode: 'light' | 'dark'; tokens: Record<string, string> }
  | { type: 'kanban:sessions'; version: 1; sessions: SessionRow[]; current: string | null }
  | { type: 'kanban:visibility'; version: 1; visible: boolean }
  | { type: 'kanban:host'; version: 1; locale: 'zh' | 'en'; dshVersion?: string };

export type BridgeMode = 'connecting' | 'embedded' | 'standalone';

export interface BridgeState {
  mode: BridgeMode;
  host: HostInfo | null;
  sessions: SessionRow[];
  currentSessionId: string | null;
  visible: boolean;
  /** 父页面明确表示不支持会话能力（旧版 DSH）时置 false。 */
  sessionSupport: boolean;
}

export class BridgeUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeUnavailableError';
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
const HOST_HANDSHAKE_GRACE_MS = 1_500;
const STORAGE_THEME = 'dsh-kanban.theme';
const TOKEN_KEYS = new Set<string>();

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `req-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function isParentPush(value: unknown): value is ParentPush {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'kanban:theme' ||
    type === 'kanban:sessions' ||
    type === 'kanban:visibility' ||
    type === 'kanban:host'
  );
}

class KanbanBridge {
  private state: BridgeState = {
    mode: typeof window !== 'undefined' && window.parent !== window ? 'connecting' : 'standalone',
    host: null,
    sessions: [],
    currentSessionId: null,
    visible: true,
    sessionSupport: true,
  };

  private listeners = new Set<(state: BridgeState) => void>();
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: BridgeUnavailableError) => void; timer: number }
  >();
  private started = false;
  private hostTimer: number | null = null;
  private mediaQuery: MediaQueryList | null = null;

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    window.addEventListener('message', this.handleMessage);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    const inIframe = window.parent !== window;
    if (!inIframe) {
      this.setMode('standalone');
      this.applyStandaloneTheme();
    } else {
      // 契约：window.parent !== window 且收到过 kanban:host/kanban:theme 才算嵌入。
      this.post({ type: 'kanban:ready', version: 1 });
      this.hostTimer = window.setTimeout(() => {
        if (this.state.mode === 'connecting') {
          this.setMode('standalone');
          this.applyStandaloneTheme();
        }
      }, HOST_HANDSHAKE_GRACE_MS);
    }

    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaQuery.addEventListener('change', this.handleMediaChange);
  }

  subscribe(listener: (state: BridgeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): BridgeState {
    return this.state;
  }

  get isEmbedded(): boolean {
    return this.state.mode === 'embedded';
  }

  private setState(patch: Partial<BridgeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private setMode(mode: BridgeMode): void {
    this.setState({ mode });
    document.documentElement.dataset.kanbanHost = mode;
    if (this.hostTimer !== null) {
      window.clearTimeout(this.hostTimer);
      this.hostTimer = null;
    }
  }

  private post(message: unknown): void {
    if (window.parent === window) return;
    window.parent.postMessage(message, window.location.origin);
  }

  private handleMessage = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== window.parent) return;
    const data: unknown = event.data;

    if (data && typeof data === 'object' && (data as { type?: unknown }).type === 'kanban:response') {
      this.handleResponse(data as ResponseMessage);
      return;
    }
    if (!isParentPush(data)) return;

    if (this.state.mode !== 'embedded') this.setMode('embedded');

    switch (data.type) {
      case 'kanban:host': {
        const previous = this.state.host;
        this.setState({
          host: {
            locale: data.locale,
            themeMode: previous?.themeMode ?? 'light',
            dshVersion: data.dshVersion,
            panelVisible: previous?.panelVisible ?? true,
          },
        });
        break;
      }
      case 'kanban:theme': {
        this.applyTokens(data.tokens, data.mode);
        const host = this.state.host;
        if (host) this.setState({ host: { ...host, themeMode: data.mode } });
        break;
      }
      case 'kanban:sessions': {
        this.setState({ sessions: data.sessions, currentSessionId: data.current });
        break;
      }
      case 'kanban:visibility': {
        this.setState({ visible: data.visible });
        break;
      }
    }
  };

  private handleResponse(message: ResponseMessage): void {
    const entry = this.pending.get(message.requestId);
    if (!entry) return;
    this.pending.delete(message.requestId);
    window.clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.data);
    } else {
      const code = message.error?.code ?? 'UNKNOWN';
      entry.reject(new BridgeUnavailableError(code, message.error?.message ?? code));
    }
  }

  request<M extends BridgeMethod>(
    method: M,
    params?: BridgeParamsMap[M],
  ): Promise<BridgeDataMap[M]> {
    if (!this.isEmbedded) {
      return Promise.reject(
        new BridgeUnavailableError(
          'SESSION_UNAVAILABLE',
          '当前为独立预览模式，DSH 会话能力不可用，可复制文本到对话中使用',
        ),
      );
    }
    const requestId = uuid();
    const message: RequestMessage = {
      type: 'kanban:request',
      version: 1,
      requestId,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise<BridgeDataMap[M]>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeUnavailableError('TIMEOUT', `桥接调用超时：${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (data) => resolve(data as BridgeDataMap[M]),
        reject,
        timer,
      });
      this.post(message);
    });
  }

  /** 把宿主主题令牌写到 :root；不认识的键也照写（宿主是权威）。 */
  private applyTokens(tokens: Record<string, string>, mode: 'light' | 'dark'): void {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(tokens)) {
      if (!key.startsWith('--')) continue;
      root.style.setProperty(key, value);
      TOKEN_KEYS.add(key);
    }
    root.dataset.kanbanTheme = mode;
    try {
      localStorage.setItem(STORAGE_THEME, mode);
    } catch {
      /* 私密模式忽略 */
    }
  }

  private applyStandaloneTheme(): void {
    const stored = safeStorageGet(STORAGE_THEME);
    const prefersDark =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const mode: 'light' | 'dark' = stored === 'light' || stored === 'dark' ? stored : prefersDark ? 'dark' : 'light';
    document.documentElement.dataset.kanbanTheme = mode;
  }

  private handleMediaChange = (event: MediaQueryListEvent): void => {
    if (this.state.mode !== 'standalone') return;
    if (safeStorageGet(STORAGE_THEME)) return;
    document.documentElement.dataset.kanbanTheme = event.matches ? 'dark' : 'light';
  };

  private handleVisibilityChange = (): void => {
    if (this.state.mode === 'embedded') return;
    this.setState({ visible: !document.hidden });
  };
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const bridge = new KanbanBridge();

/** React 订阅桥状态（宿主握手/主题/会话/可见性）。 */
export function useBridgeState(): BridgeState {
  const [state, setState] = useState<BridgeState>(() => bridge.getState());
  useEffect(() => {
    setState(bridge.getState());
    return bridge.subscribe(setState);
  }, []);
  return state;
}
