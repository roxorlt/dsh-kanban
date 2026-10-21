import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

export interface MenuEntry {
  id: string;
  label: string;
  icon?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** 在上方画一条分隔线 */
  separatorBefore?: boolean;
}

interface MenuButtonProps {
  label: string;
  trigger: ReactNode;
  items: MenuEntry[];
  onSelect: (id: string) => void;
  align?: 'start' | 'end';
  triggerClassName?: string;
  disabled?: boolean;
}

interface MenuPosition {
  top: number;
  left: number;
  minWidth: number;
}

const VIEWPORT_MARGIN = 8;

/**
 * 轻量下拉菜单。浮层用 portal + fixed 定位，避免被看板列的 overflow 裁剪。
 * 键盘：Enter/Space/↓ 打开；↑/↓/Home/End 移动；Enter 选择；Esc 关闭并归还焦点。
 */
export function MenuButton({
  label,
  trigger,
  items,
  onSelect,
  align = 'start',
  triggerClassName,
  disabled,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = Math.max(176, rect.width);
    let left = align === 'end' ? rect.right - menuWidth : rect.left;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - menuWidth - VIEWPORT_MARGIN));
    const estimatedHeight = items.length * 32 + 12;
    const below = rect.bottom + 6;
    const above = rect.top - estimatedHeight - 6;
    const top = below + estimatedHeight > window.innerHeight - VIEWPORT_MARGIN && above > VIEWPORT_MARGIN ? above : below;
    setPosition({ top, left, minWidth: menuWidth });
  }, [align, items.length]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const firstEnabled = items.findIndex((item) => !item.disabled);
    if (firstEnabled >= 0) itemRefs.current[firstEnabled]?.focus();
  }, [open, items, measure]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(true);
      }
    };
    const onScrollOrResize = () => close();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, close]);

  const focusItem = (index: number) => {
    const total = items.length;
    if (!total) return;
    let next = index;
    for (let i = 0; i < total; i += 1) {
      next = (index + i + total) % total;
      if (!items[next]?.disabled) break;
    }
    itemRefs.current[next]?.focus();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(current + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(items.length - 1);
    } else if (event.key === 'Tab') {
      close();
    }
  };

  const select = (entry: MenuEntry) => {
    if (entry.disabled) return;
    close(true);
    onSelect(entry.id);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName ?? 'kb-btn kb-btn--icon kb-btn--ghost'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (open) close();
          else setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="kb-menu"
              role="menu"
              aria-label={label}
              style={{ top: position.top, left: position.left, minWidth: position.minWidth, position: 'fixed' }}
              onKeyDown={handleMenuKeyDown}
            >
              {items.map((entry, index) => (
                <div key={entry.id}>
                  {entry.separatorBefore ? <div className="kb-menu__sep" role="separator" /> : null}
                  <button
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    type="button"
                    role="menuitem"
                    aria-current={entry.checked ? 'true' : undefined}
                    className="kb-menu__item"
                    disabled={entry.disabled}
                    style={entry.danger ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      select(entry);
                    }}
                  >
                    {entry.icon ? <span className="kb-icon">{entry.icon}</span> : null}
                    <span style={{ flex: 1 }}>{entry.label}</span>
                    {entry.checked ? <span aria-hidden="true">✓</span> : null}
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
