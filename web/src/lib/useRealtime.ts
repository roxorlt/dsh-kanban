import { useCallback, useEffect, useRef, useState } from 'react';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DEBOUNCE_MS = 150;
/** 连续失败达到该次数后，从「正在重试」升级为「已断开」（可点击手动重试）。 */
const OFFLINE_AFTER_FAILURES = 3;
/** 浏览器确认离线后，先给「正在重试」，持续该时长再升级为「已断开」。 */
const OFFLINE_PROMOTE_MS = 4_000;

/**
 * SSE 连接状态（docs/10 A-08）：
 * - connecting：首次连接中
 * - connected：已连接，实时同步中
 * - degraded：连接中断，正在按指数退避自动重试
 * - offline：连续重试仍失败（或浏览器已离线），等待用户手动重试
 */
export type RealtimeStatus = 'connecting' | 'connected' | 'degraded' | 'offline';

interface RealtimeOptions {
  enabled: boolean;
  /** 本地当前 revision；收到不同的 revision 才触发刷新。 */
  revision: number;
  onRefresh: () => void;
  /** 收到服务端广播的外部 IM 定位卡片事件 */
  onFocusCard?: (cardId: string) => void;
  /** SSE 地址，默认 /api/kanban/events（测试可覆盖）。 */
  url?: string;
}

export interface RealtimeController {
  status: RealtimeStatus;
  /** 立即重连（清掉退避计时器）；供断线提示上的「重试」入口调用。 */
  reconnect: () => void;
}

/**
 * SSE 实时刷新：收到 revision 变化后 debounce 150ms 拉 /state；
 * 断线指数退避（1s→2s→…→30s）并把状态暴露给页面；页面隐藏时断开、恢复可见时重连
 * （页面隐藏不报 degraded，避免切后台的假告警）。
 */
export function useRealtime({
  enabled,
  revision,
  onRefresh,
  onFocusCard,
  url = '/api/kanban/events',
}: RealtimeOptions): RealtimeController {
  const [status, setStatus] = useState<RealtimeStatus>(enabled ? 'connecting' : 'connected');
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const focusRef = useRef(onFocusCard);
  focusRef.current = onFocusCard;
  const reconnectRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    /** 连续失败次数；open 时清零。 */
    let failures = 0;
    let stopped = false;
    let reconnectTimer: number | null = null;
    let debounceTimer: number | null = null;
    let offlineTimer: number | null = null;

    const publish = (next: RealtimeStatus) => {
      setStatus((current) => (current === next ? current : next));
    };

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const clearOfflineTimer = () => {
      if (offlineTimer !== null) {
        window.clearTimeout(offlineTimer);
        offlineTimer = null;
      }
    };

    const closeSource = () => {
      if (source) {
        source.close();
        source = null;
      }
    };

    const scheduleRefresh = () => {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        refreshRef.current();
      }, DEBOUNCE_MS);
    };

    const connect = () => {
      if (stopped || document.hidden) return;
      closeSource();
      publish(failures > 0 ? 'degraded' : 'connecting');
      const next = new EventSource(url);
      source = next;
      next.addEventListener('open', () => {
        if (stopped || source !== next) return;
        failures = 0;
        publish('connected');
      });
      next.addEventListener('change', (event) => {
        const message = event as MessageEvent<string>;
        try {
          const payload = JSON.parse(message.data) as { revision?: unknown };
          if (typeof payload.revision === 'number' && payload.revision !== revisionRef.current) {
            scheduleRefresh();
          }
        } catch {
          /* 心跳或非 JSON 数据忽略 */
        }
      });
      next.addEventListener('focus', (event) => {
        const message = event as MessageEvent<string>;
        try {
          const payload = JSON.parse(message.data) as { cardId?: unknown };
          if (typeof payload.cardId === 'string' && payload.cardId.trim()) {
            focusRef.current?.(payload.cardId.trim());
          }
        } catch {
          /* 忽略格式异常 */
        }
      });
      next.addEventListener('error', () => {
        if (stopped || source !== next) return;
        closeSource();
        failures += 1;
        // 先给「正在重试」，连续失败后再升级为「已断开」，避免一次抖动就报死。
        publish(failures >= OFFLINE_AFTER_FAILURES ? 'offline' : 'degraded');
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, failures - 1));
        clearReconnect();
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      });
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        // 主动断开（宿主隐藏 / 切后台），保持原状态，不误报断线。
        closeSource();
        clearReconnect();
        clearOfflineTimer();
      } else if (!source) {
        failures = 0;
        connect();
      }
    };

    const onBrowserOffline = () => {
      if (stopped) return;
      clearReconnect();
      closeSource();
      // 立刻可见（2s 内），但先报「正在重试」；持续离线 4s 后才升级为「已断开」。
      publish('degraded');
      clearOfflineTimer();
      offlineTimer = window.setTimeout(() => {
        offlineTimer = null;
        if (!stopped) publish('offline');
      }, OFFLINE_PROMOTE_MS);
    };

    const onBrowserOnline = () => {
      if (stopped || document.hidden) return;
      clearOfflineTimer();
      clearReconnect();
      failures = 0;
      connect();
    };

    // 「重试」：跳过退避等待，立刻重连。
    reconnectRef.current = () => {
      if (stopped || document.hidden) return;
      clearOfflineTimer();
      clearReconnect();
      failures = 0;
      connect();
    };

    connect();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('offline', onBrowserOffline);
    window.addEventListener('online', onBrowserOnline);

    return () => {
      stopped = true;
      reconnectRef.current = () => undefined;
      closeSource();
      clearReconnect();
      clearOfflineTimer();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('offline', onBrowserOffline);
      window.removeEventListener('online', onBrowserOnline);
    };
  }, [enabled, url]);

  const reconnect = useCallback(() => reconnectRef.current(), []);

  return { status, reconnect };
}
