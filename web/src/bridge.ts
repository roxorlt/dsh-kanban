/**
 * 看板 ↔ DSH 客户端桥（docs/contracts/03-client-bridge.md）。
 * 只负责 postMessage 通道、主题令牌注入与会话/面板能力；
 * 不掺 HTTP API 逻辑（那在 api.ts）。
 */
import { useEffect, useState } from 'react';
import type { HostInfo, SessionRow, WorkspaceRow } from './types';

export type BridgeMethod =
  | 'app.info'
  | 'sessions.list'
  | 'workspaces.list'
  | 'sessions.refresh'
  | 'session.open'
  | 'session.create'
  | 'session.prompt'
  | 'session.ensure'
  | 'card.open'
  | 'panel.select'
  | 'toast'
  | 'theme.set';

export interface BridgeParamsMap {
  'app.info': undefined;
  'sessions.list': undefined;
  'workspaces.list': undefined;
  'sessions.refresh': undefined;
  'session.open': { sessionId: string };
  'session.create': { cwd?: string; workspaceId?: string; title?: string };
  'session.prompt': { sessionId: string; text: string; mode?: 'queue' | 'steer' };
  'session.ensure': { sessionId?: string; cwd?: string; workspaceId?: string; text: string };
  'card.open': { cardId: string; boardId: string };
  'panel.select': { panel: 'kanban' | 'conversation' };
  toast: { text: string; tone?: 'info' | 'success' | 'error' };
  'theme.set': { preference: ThemePreference };
}

export interface BridgeDataMap {
  'app.info': HostInfo;
  'sessions.list': { sessions: SessionRow[]; current: string | null };
  'workspaces.list': { workspaces: WorkspaceRow[] };
  'sessions.refresh': { sessions: SessionRow[]; current: string | null };
  'session.open': { ok: true };
  'session.create': { sessionId: string };
  'session.prompt': { accepted: true };
  'session.ensure': { sessionId: string; created: boolean };
  'card.open': { ok: true };
  'panel.select': { ok: true };
  toast: { ok: true };
  'theme.set': { applied: boolean };
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
  | {
      type: 'kanban:host';
      version: 1;
      locale: 'zh' | 'en';
      dshVersion?: string;
      insets?: { top?: number; leading?: number; platform?: string; fullscreen?: boolean };
    };

export type BridgeMode = 'connecting' | 'embedded' | 'standalone';
/** 主题偏好：system=跟随宿主/系统；light/dark=手动覆盖（用本地令牌） */
export type ThemePreference = 'system' | 'light' | 'dark';

/** 宿主安全区（DSH 0.2.x --dsh-frame-overlay-top / --dsh-frame-leading-clearance） */
export interface HostInsets {
  top: number;
  leading: number;
  platform?: string;
  fullscreen?: boolean;
}

export interface BridgeState {
  mode: BridgeMode;
  host: HostInfo | null;
  sessions: SessionRow[];
  currentSessionId: string | null;
  visible: boolean;
  /** 父页面明确表示不支持会话能力（旧版 DSH）时置 false。 */
  sessionSupport: boolean;
  /** 宿主安全区（未收到时 top=0） */
  insets: HostInsets;
  /** 主题偏好：默认跟随宿主 */
  themePreference: ThemePreference;
  /** 当前生效的明暗 */
  themeMode: 'light' | 'dark';
  /** 主题来源：host=宿主统一换主题；local=看板本地令牌兜底 */
  themeSource: 'host' | 'local';
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
const STORAGE_THEME_PREF = 'dsh-kanban.theme-preference';
const STORAGE_THEME_SOURCE = 'dsh-kanban.theme-source';
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
    insets: { top: 0, leading: 0 },
    themePreference: readThemePreference(),
    themeMode: 'light',
    themeSource: readThemeSource(),
  };

  private listeners = new Set<(state: BridgeState) => void>();
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: BridgeUnavailableError) => void; timer: number }
  >();
  private started = false;
  private hostTimer: number | null = null;
  private mediaQuery: MediaQueryList | null = null;
  private hostTheme: { tokens: Record<string, string>; mode: 'light' | 'dark' } | null = null;

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    window.addEventListener('message', this.handleMessage);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    const inIframe = window.parent !== window;
    if (!inIframe) {
      this.setMode('standalone');
      this.applyThemePreference();
    } else {
      // 契约：window.parent !== window 且收到过 kanban:host/kanban:theme 才算嵌入。
      this.post({ type: 'kanban:ready', version: 1 });
      this.hostTimer = window.setTimeout(() => {
        if (this.state.mode === 'connecting') {
          this.setMode('standalone');
          this.applyThemePreference();
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

  /**
   * 本地三态主题（standalone，或宿主 theme.set applied:false 时的兜底）。
   * 手动 light/dark 时清空宿主令牌、用本地 tokens.css。
   */
  setThemePreference(preference: ThemePreference): void {
    this.persistPreference(preference, 'local');
    this.setState({ themePreference: preference, themeSource: 'local' });
    this.applyThemePreference();
  }

  /** 宿主已统一换主题：跟随宿主推送的 kanban:theme 令牌。 */
  applyHostThemePreference(preference: ThemePreference): void {
    this.persistPreference(preference, 'host');
    this.setState({ themePreference: preference, themeSource: 'host' });
    this.applyThemePreference();
  }

  private persistPreference(preference: ThemePreference, source: 'host' | 'local'): void {
    try {
      localStorage.setItem(STORAGE_THEME_PREF, preference);
      localStorage.setItem(STORAGE_THEME_SOURCE, source);
    } catch {
      /* 私密模式忽略 */
    }
  }

  cycleThemePreference(): ThemePreference {
    const next = nextThemePreference(this.state.themePreference);
    this.setThemePreference(next);
    return next;
  }

  private setState(patch: Partial<BridgeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private setMode(mode: BridgeMode): void {
    this.setState({ mode });
    document.documentElement.dataset.kanbanHost = mode;
    if (mode !== 'connecting') this.applyThemePreference();
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
        const insets = data.insets ?? {};
        this.setState({
          host: {
            locale: data.locale,
            themeMode: previous?.themeMode ?? 'light',
            dshVersion: data.dshVersion,
            panelVisible: previous?.panelVisible ?? true,
          },
          insets: {
            top: Number.isFinite(insets.top) ? Math.max(0, Number(insets.top)) : 0,
            leading: Number.isFinite(insets.leading) ? Math.max(0, Number(insets.leading)) : 0,
            platform: typeof insets.platform === 'string' ? insets.platform : undefined,
            fullscreen: Boolean(insets.fullscreen),
          },
        });
        this.applyInsets();
        break;
      }
      case 'kanban:theme': {
        this.hostTheme = { tokens: data.tokens ?? {}, mode: data.mode };
        const host = this.state.host;
        if (host) this.setState({ host: { ...host, themeMode: data.mode } });
        if (this.state.themeSource === 'host') this.applyThemePreference();
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
    this.setState({ themeMode: mode });
    try {
      localStorage.setItem(STORAGE_THEME, mode);
    } catch {
      /* 私密模式忽略 */
    }
  }

  private clearHostTokens(): void {
    const root = document.documentElement;
    for (const key of TOKEN_KEYS) root.style.removeProperty(key);
    TOKEN_KEYS.clear();
  }

  private prefersDark(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /** 应用三态主题：system 用宿主/系统；light/dark 用本地 tokens.css 兜底令牌。 */
  private applyThemePreference(): void {
    const preference = this.state.themePreference;
    const root = document.documentElement;
    let mode: 'light' | 'dark';
    const followHost =
      this.state.mode === 'embedded' && this.hostTheme && this.state.themeSource === 'host';
    if (followHost && this.hostTheme) {
      this.applyTokens(this.hostTheme.tokens, this.hostTheme.mode);
      return;
    }
    this.clearHostTokens();
    mode = preference === 'system' ? (this.prefersDark() ? 'dark' : 'light') : preference;
    root.dataset.kanbanTheme = mode;
    this.setState({ themeMode: mode });
    try {
      localStorage.setItem(STORAGE_THEME, mode);
    } catch {
      /* 私密模式忽略 */
    }
  }

  private applyInsets(): void {
    const root = document.documentElement;
    const { top, leading } = this.state.insets;
    root.style.setProperty('--kb-host-inset-top', `${top}px`);
    root.style.setProperty('--kb-host-inset-leading', `${leading}px`);
  }

  private handleMediaChange = (): void => {
    if (this.state.themePreference !== 'system') return;
    if (this.state.mode === 'embedded' && this.hostTheme) return;
    this.applyThemePreference();
  };

  private handleVisibilityChange = (): void => {
    if (this.state.mode === 'embedded') return;
    this.setState({ visible: !document.hidden });
  };
}

/** 三态循环：跟随 → 亮 → 暗 → 跟随（纯函数，便于单测）。 */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  if (current === 'system') return 'light';
  if (current === 'light') return 'dark';
  return 'system';
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readThemeSource(): 'host' | 'local' {
  const stored = safeStorageGet(STORAGE_THEME_SOURCE);
  if (stored === 'host' || stored === 'local') return stored;
  // 默认：system 跟随宿主；已持久化的手动偏好用本地令牌
  return readThemePreference() === 'system' ? 'host' : 'local';
}

function readThemePreference(): ThemePreference {
  const stored = safeStorageGet(STORAGE_THEME_PREF);
  if (stored === 'system' || stored === 'light' || stored === 'dark') return stored;
  // 兼容旧版只存了 light/dark 的独立模式偏好
  const legacy = safeStorageGet(STORAGE_THEME);
  if (legacy === 'light' || legacy === 'dark') return legacy;
  return 'system';
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
