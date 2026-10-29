import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
}

const TOAST_TIMEOUT_MS = 4200;
/** 带操作按钮的 toast 多留一会儿，给用户点按钮的时间（仍不打断）。 */
const TOAST_ACTION_TIMEOUT_MS = 10_000;

export function useToasts(): {
  toasts: ToastItem[];
  notify: (text: string, tone?: ToastTone, action?: ToastAction) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (text: string, tone: ToastTone = 'info', action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-2), { id, text, tone, ...(action ? { action } : {}) }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), action ? TOAST_ACTION_TIMEOUT_MS : TOAST_TIMEOUT_MS),
      );
    },
    [dismiss],
  );

  return { toasts, notify, dismiss };
}

/** 自绘 toast（契约允许 iframe 自绘；不依赖父页面）。 */
export function ToastRegion({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return createPortal(
    <div className="kb-toast-region" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`kb-toast kb-toast--${toast.tone}`}>
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
