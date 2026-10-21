import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { IconClose } from './Icons';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 初始聚焦的元素选择器，默认聚焦第一个可交互元素 */
  initialFocus?: string;
  size?: 'sm' | 'md';
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 居中模态（<720px 时由 CSS 变成底部弹层）。Esc 关闭、焦点归还、滚动锁定。 */
export function Modal({ title, onClose, children, footer, initialFocus, size = 'md' }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

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
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
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
  }, [onClose]);

  const { t } = useI18n();

  return createPortal(
    <div className="kb-overlay" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
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
          <button type="button" className="kb-btn kb-btn--icon kb-btn--ghost" aria-label={t('common.close')} onClick={onClose}>
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
