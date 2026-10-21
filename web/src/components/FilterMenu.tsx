import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CardFilters } from '../lib/filter';
import { hasActiveFilters } from '../lib/filter';
import { useI18n } from '../i18n';
import { IconCheck, IconChevronDown, IconClose, IconFilter } from './Icons';
import { pushOverlay } from '../lib/overlayStack';

interface FilterMenuProps {
  filters: CardFilters;
  projects: string[];
  labels: string[];
  onChange: (filters: CardFilters) => void;
}

/** 筛选浮层：项目 / 标签 两组单选，浮层 border:0 + elevation，Esc/外点关闭。 */
export function FilterMenu({ filters, projects, labels, onChange }: FilterMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const activeCount = (filters.project ? 1 : 0) + (filters.label ? 1 : 0);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 280;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setPosition({ top: rect.bottom + 6, left });
    const first = panelRef.current?.querySelector<HTMLElement>('button, input');
    first?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return pushOverlay(() => close());
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="kb-btn kb-btn--outline kb-btn--sm kb-filter-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('a11y.filterMenu')}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="kb-icon" aria-hidden="true">
          <IconFilter />
        </span>
        {t('app.toolbarFilters')}
        {activeCount ? <span className="kb-filter-count">{activeCount}</span> : null}
        <span className="kb-icon kb-filter-caret" aria-hidden="true">
          <IconChevronDown />
        </span>
      </button>

      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              className="kb-filter-panel"
              role="dialog"
              aria-modal="false"
              aria-label={t('app.filterTitle')}
              style={{ top: position.top, left: position.left }}
            >
              <div className="kb-filter-panel__head">
                <span>{t('app.filterTitle')}</span>
                <button
                  type="button"
                  className="kb-btn kb-btn--icon kb-btn--sm kb-btn--ghost"
                  aria-label={t('common.close')}
                  onClick={close}
                >
                  <span className="kb-icon" aria-hidden="true">
                    <IconClose />
                  </span>
                </button>
              </div>

              <div className="kb-filter-group">
                <span className="kb-filter-group__label">{t('app.filterProject')}</span>
                <div className="kb-filter-group__list">
                <label className={`kb-check${!filters.project ? ' kb-check--on' : ''}`}>
                  <input
                    type="radio"
                    name="kb-filter-project"
                    checked={!filters.project}
                    onChange={() => onChange({ ...filters, project: null })}
                  />
                  <span className="kb-check__label">{t('app.allProjects')}</span>
                  {!filters.project ? <span className="kb-icon" aria-hidden="true"><IconCheck /></span> : null}
                </label>
                {projects.map((project) => (
                  <label className={`kb-check${filters.project === project ? ' kb-check--on' : ''}`} key={project}>
                    <input
                      type="radio"
                      name="kb-filter-project"
                      checked={filters.project === project}
                      onChange={() => onChange({ ...filters, project })}
                    />
                    <span className="kb-check__label" title={project}>{project}</span>
                    {filters.project === project ? <span className="kb-icon" aria-hidden="true"><IconCheck /></span> : null}
                  </label>
                ))}
                {!projects.length ? (
                  <p className="kb-filter-group__empty">{t('filter.noProjects')}</p>
                ) : null}
                </div>
              </div>

              <div className="kb-filter-group">
                <span className="kb-filter-group__label">{t('app.filterLabel')}</span>
                <div className="kb-filter-group__list">
                <label className={`kb-check${!filters.label ? ' kb-check--on' : ''}`}>
                  <input
                    type="radio"
                    name="kb-filter-label"
                    checked={!filters.label}
                    onChange={() => onChange({ ...filters, label: null })}
                  />
                  <span className="kb-check__label">{t('app.allLabels')}</span>
                  {!filters.label ? <span className="kb-icon" aria-hidden="true"><IconCheck /></span> : null}
                </label>
                {labels.map((label) => (
                  <label className={`kb-check${filters.label === label ? ' kb-check--on' : ''}`} key={label}>
                    <input
                      type="radio"
                      name="kb-filter-label"
                      checked={filters.label === label}
                      onChange={() => onChange({ ...filters, label })}
                    />
                    <span className="kb-check__label" title={label}>{label}</span>
                    {filters.label === label ? <span className="kb-icon" aria-hidden="true"><IconCheck /></span> : null}
                  </label>
                ))}
                {!labels.length ? <p className="kb-filter-group__empty">{t('filter.noLabels')}</p> : null}
                </div>
              </div>

              <div className="kb-filter-panel__foot">
                <button
                  type="button"
                  className="kb-btn kb-btn--sm kb-btn--ghost"
                  disabled={!hasActiveFilters(filters)}
                  onClick={() => onChange({ query: filters.query, project: null, label: null })}
                >
                  {t('app.clearFilters')}
                </button>
                <button type="button" className="kb-btn kb-btn--sm kb-btn--primary" onClick={close}>
                  {t('app.filterApply')}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
