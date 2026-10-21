import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconAlert, IconCheckCircle, IconInfo } from './Icons';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

const TOAST_TIMEOUT_MS = 4200;

export function useToasts(): {
  toasts: ToastItem[];
  notify: (text: string, tone?: ToastTone) => void;
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
    (text: string, tone: ToastTone = 'info') => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-2), { id, text, tone }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), TOAST_TIMEOUT_MS),
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
