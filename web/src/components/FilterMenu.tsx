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
  agents?: string[];
  onChange: (filters: CardFilters) => void;
}

/** 筛选浮层：项目单选 + 执行 Agent 单选，浮层 border:0 + elevation，Esc/外点关闭。 */
export function FilterMenu({ filters, projects, agents = [], onChange }: FilterMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const activeCount = (filters.project ? 1 : 0) + (filters.agent ? 1 : 0);

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
                    {!filters.project ? (
                      <span className="kb-icon" aria-hidden="true">
                        <IconCheck />
                      </span>
                    ) : null}
                  </label>
                  {projects.map((project) => (
                    <label className={`kb-check${filters.project === project ? ' kb-check--on' : ''}`} key={project}>
                      <input
                        type="radio"
                        name="kb-filter-project"
                        checked={filters.project === project}
                        onChange={() => onChange({ ...filters, project })}
                      />
                      <span className="kb-check__label" title={project}>
                        {project}
                      </span>
                      {filters.project === project ? (
                        <span className="kb-icon" aria-hidden="true">
                          <IconCheck />
                        </span>
                      ) : null}
                    </label>
                  ))}
                  {!projects.length ? <p className="kb-filter-group__empty">{t('filter.noProjects')}</p> : null}
                </div>
              </div>

              <div className="kb-filter-group">
                <span className="kb-filter-group__label">{t('app.filterAgent')}</span>
                <div className="kb-filter-group__list">
                  <label className={`kb-check${!filters.agent ? ' kb-check--on' : ''}`}>
                    <input
                      type="radio"
                      name="kb-filter-agent"
                      checked={!filters.agent}
                      onChange={() => onChange({ ...filters, agent: null })}
                    />
                    <span className="kb-check__label">{t('app.allAgents')}</span>
                    {!filters.agent ? (
                      <span className="kb-icon" aria-hidden="true">
                        <IconCheck />
                      </span>
                    ) : null}
                  </label>
                  {agents.map((agentLabel) => (
                    <label
                      className={`kb-check${filters.agent === agentLabel ? ' kb-check--on' : ''}`}
                      key={agentLabel}
                    >
                      <input
                        type="radio"
                        name="kb-filter-agent"
                        checked={filters.agent === agentLabel}
                        onChange={() => onChange({ ...filters, agent: agentLabel })}
                      />
                      <span className="kb-check__label" title={agentLabel}>
                        {agentLabel}
                      </span>
                      {filters.agent === agentLabel ? (
                        <span className="kb-icon" aria-hidden="true">
                          <IconCheck />
                        </span>
                      ) : null}
                    </label>
                  ))}
                  {!agents.length ? <p className="kb-filter-group__empty">{t('filter.noAgents')}</p> : null}
                </div>
              </div>

              <div className="kb-filter-panel__foot">
                <button
                  type="button"
                  className="kb-btn kb-btn--sm kb-btn--ghost"
                  disabled={!hasActiveFilters(filters)}
                  onClick={() => onChange({ query: filters.query, project: null, agent: null })}
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
