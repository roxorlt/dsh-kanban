import { useEffect, useRef } from 'react';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DEBOUNCE_MS = 150;

interface RealtimeOptions {
  enabled: boolean;
  /** 本地当前 revision；收到不同的 revision 才触发刷新。 */
  revision: number;
  onRefresh: () => void;
  /** SSE 地址，默认 /api/kanban/events（测试可覆盖）。 */
  url?: string;
}

/**
 * SSE 实时刷新：收到 revision 变化后 debounce 150ms 拉 /state；
 * 断线指数退避（1s→2s→…→30s）；页面隐藏时断开、恢复可见时重连。
 */
export function useRealtime({ enabled, revision, onRefresh, url = '/api/kanban/events' }: RealtimeOptions): void {
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let attempt = 0;
    let stopped = false;
    let reconnectTimer: number | null = null;
    let debounceTimer: number | null = null;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
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
      attempt += 1;
      source = new EventSource(url);
      source.addEventListener('open', () => {
        attempt = 0;
      });
      source.addEventListener('change', (event) => {
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
      source.addEventListener('error', () => {
        source?.close();
        source = null;
        if (stopped) return;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
        clearReconnect();
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      });
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        source?.close();
        source = null;
        clearReconnect();
      } else if (!source) {
        attempt = 0;
        connect();
      }
    };

    connect();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopped = true;
      source?.close();
      source = null;
      clearReconnect();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, url]);
}
