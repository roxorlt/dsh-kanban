import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { presenceExitMs } from '../lib/usePresence';
import { useMediaQuery } from '../lib/useMediaQuery';
import { IconAlert, IconCheckCircle, IconInfo } from './Icons';

export type ToastTone = 'info' | 'success' | 'error';

/** 可操作 toast 的动作（v0.21.0 #15：完成提示里的「打开工作区」）。 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  /** 可选操作按钮：例如完成卡片后的「打开工作区」；不弹窗、不打断。 */
  action?: ToastAction;
  /** 正在离场（已挂 `.kb-toast--leaving`，只跑淡出），等淡出播完才从列表移除。 */
  leaving?: boolean;
}

const TOAST_TIMEOUT_MS = 4200;
/** 带操作按钮的 toast 多留一会儿，给用户点按钮的时间（仍不打断）。 */
const TOAST_ACTION_TIMEOUT_MS = 10_000;
/** 离场等待：与 styles/base.css 的 `--kb-dur-exit` 同源（docs/11-motion.md §3.1 / §6.4）。
 *  离场比进场快一档；reduced-motion 下由 presenceExitMs 压到 120ms 纯淡出（§4 B 级）。 */
const TOAST_EXIT_MS = 140;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function useToasts(): {
  toasts: ToastItem[];
  notify: (text: string, tone?: ToastTone, action?: ToastAction) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  /** 自动消失计时器（notify 时设置，关闭时清掉）。 */
  const autoTimers = useRef(new Map<number, number>());
  /** 离场等待计时器（先标 leaving 播 CSS 淡出，到点再真正移除）。 */
  const exitTimers = useRef(new Map<number, number>());
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  // 用 ref 读「当前」RM 偏好：定时器回调可能晚于一次偏好切换才触发，读闭包里的 state 会过期
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  /** 清掉某个 toast 的两类计时器；重复调用幂等（连续关闭不会堆积）。 */
  const clearTimers = useCallback((id: number) => {
    const auto = autoTimers.current.get(id);
    if (auto !== undefined) {
      window.clearTimeout(auto);
      autoTimers.current.delete(id);
    }
    const exit = exitTimers.current.get(id);
    if (exit !== undefined) {
      window.clearTimeout(exit);
      exitTimers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: number) => {
    // 自动超时与手动关闭可能撞在一起：先摘掉自动计时器，再判断是否已在离场
    const auto = autoTimers.current.get(id);
    if (auto !== undefined) {
      window.clearTimeout(auto);
      autoTimers.current.delete(id);
    }
    // 已在离场窗口里就不要重排（重复点击会把 140ms 重新计时，淡出会闪一下）
    if (exitTimers.current.has(id)) return;
    const exitMs = presenceExitMs(TOAST_EXIT_MS, reducedMotionRef.current, true);
    if (exitMs <= 0) {
      setToasts((current) => current.filter((toast) => toast.id !== id));
      return;
    }
    // 先标 leaving 留在列表里：CSS 过渡需要元素还在 DOM 上才能播完淡出
    setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
    exitTimers.current.set(
      id,
      window.setTimeout(() => {
        exitTimers.current.delete(id);
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, exitMs),
    );
  }, []);

  const notify = useCallback(
    (text: string, tone: ToastTone = 'info', action?: ToastAction) => {
      const id = nextId.current++;
      // 最多 3 条：留最近 2 条再追加；被挤掉那条的计时器由下面的清理 effect 收走
      setToasts((current) => [...current.slice(-2), { id, text, tone, ...(action ? { action } : {}) }]);
      autoTimers.current.set(
        id,
        window.setTimeout(() => dismiss(id), action ? TOAST_ACTION_TIMEOUT_MS : TOAST_TIMEOUT_MS),
      );
    },
    [dismiss],
  );

  /** 兜底清理：被条数上限挤掉 / 已真删的 toast 不再留计时器（防 Map 缓慢泄漏）。 */
  useEffect(() => {
    const alive = new Set(toasts.map((toast) => toast.id));
    for (const id of autoTimers.current.keys()) {
      if (!alive.has(id)) clearTimers(id);
    }
    for (const id of exitTimers.current.keys()) {
      if (!alive.has(id)) clearTimers(id);
    }
  }, [toasts, clearTimers]);

  /** 卸载时清空所有待触发计时器，避免组件树卸载后回调还去 setState。 */
  useEffect(
    () => () => {
      for (const id of autoTimers.current.keys()) clearTimers(id);
      for (const id of exitTimers.current.keys()) clearTimers(id);
    },
    [clearTimers],
  );

  return { toasts, notify, dismiss };
}

/** 自绘 toast（契约允许 iframe 自绘；不依赖父页面）。 */
export function ToastRegion({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return createPortal(
    <div className="kb-toast-region" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`kb-toast kb-toast--${toast.tone}${toast.leaving ? ' kb-toast--leaving' : ''}`}>
          <span className="kb-icon kb-toast__icon">
            {toast.tone === 'success' ? <IconCheckCircle /> : toast.tone === 'error' ? <IconAlert /> : <IconInfo />}
          </span>
          <span>{toast.text}</span>
          {toast.action ? (
            <button
              type="button"
              className="kb-btn kb-btn--sm kb-btn--outline kb-toast__action"
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="kb-btn kb-btn--icon kb-btn--sm kb-btn--ghost"
            onClick={() => onDismiss(toast.id)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
