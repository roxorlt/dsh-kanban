import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { pushOverlay } from '../lib/overlayStack';
import { IconClose } from './Icons';

interface ModalProps {
  title: string;
  onClose: () => void;
  /** Esc / 蒙层 / 右上角关闭时调用；缺省等同 onClose。用于脏草稿二次确认。 */
  onRequestClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 初始聚焦的元素选择器，默认聚焦第一个可交互元素 */
  initialFocus?: string;
  size?: 'sm' | 'md';
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 居中模态（<720px 时由 CSS 变成底部弹层）。Esc 关闭、焦点归还、滚动锁定。 */
export function Modal({
  title,
  onClose,
  onRequestClose,
  children,
  footer,
  initialFocus,
  size = 'md',
}: ModalProps) {
  const titleId = useId();
  const requestClose = onRequestClose ?? onClose;
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Esc 统一由 App 的浮层栈处理（只关最上层）；这里负责 Tab 焦点圈定
  useEffect(() => pushOverlay(() => requestCloseRef.current()), []);

  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    const target = initialFocus ? panelRef.current?.querySelector<HTMLElement>(initialFocus) : null;
    const first = target ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current;
    first?.focus();
    return () => {
      root.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [initialFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const { t } = useI18n();

  return createPortal(
    <div className="kb-overlay" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div
        ref={panelRef}
        className={`kb-modal kb-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="kb-modal__header">
          <h2 id={titleId} className="kb-modal__title">
            {title}
          </h2>
          <button type="button" className="kb-btn kb-btn--icon kb-btn--ghost" aria-label={t('common.close')} onClick={requestClose}>
            <span className="kb-icon">
              <IconClose />
            </span>
          </button>
        </header>
        <div className="kb-modal__body">{children}</div>
        {footer ? <footer className="kb-modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
