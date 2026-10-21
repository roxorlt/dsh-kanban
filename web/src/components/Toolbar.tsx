import { useEffect, useRef } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import type { CardFilters } from '../lib/filter';
import { hasActiveFilters } from '../lib/filter';
import type { Lang } from '../i18n';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { FilterMenu } from './FilterMenu';
import {
  IconBoard,
  IconChevronRight,
  IconClose,
  IconGlobe,
  IconList,
  IconPlus,
  IconRefresh,
  IconSearch,
} from './Icons';

export type ViewMode = 'board' | 'list';
export type SyncState = 'connected' | 'connecting' | 'reconnecting' | 'standalone';

interface ToolbarProps {
  boardName: string;
  cardCount: number;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  filters: CardFilters;
  onFiltersChange: (filters: CardFilters) => void;
  projects: string[];
  labels: string[];
  lang: Lang;
  onToggleLang: () => void;
  onNewCard: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  syncState: SyncState;
  runningCount: number;
}

function Chip({ label, onRemove, removeLabel }: { label: string; onRemove: () => void; removeLabel: string }) {
  return (
    <span className="kb-filter-chip">
      <span>{label}</span>
      <button type="button" className="kb-filter-chip__x" aria-label={removeLabel} onClick={onRemove}>
        <span className="kb-icon" aria-hidden="true">
          <IconClose />
        </span>
      </button>
    </span>
  );
}

/** 顶部两行：面包屑 / 视图切换 / 新建 + 搜索 / 筛选 / 实时状态 / 刷新。 */
export function Toolbar({
  boardName,
  cardCount,
  view,
  onViewChange,
  filters,
  onFiltersChange,
  projects,
  labels,
  lang,
  onToggleLang,
  onNewCard,
  onRefresh,
  refreshing,
  syncState,
  runningCount,
}: ToolbarProps) {
  const { t } = useI18n();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const activeFilters = hasActiveFilters(filters);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const anchorViews: { id: ViewMode; icon: ReactNode; key: I18nKey }[] = [
    { id: 'board', icon: <IconBoard />, key: 'app.viewBoard' },
    { id: 'list', icon: <IconList />, key: 'app.viewList' },
  ];

  return (
    <>
      <header className="kb-topbar">
        <nav className="kb-crumbs" aria-label="breadcrumb">
          <span className="kb-crumb">{t('app.breadcrumbRoot')}</span>
          <span className="kb-crumb-sep" aria-hidden="true">
            <IconChevronRight size={12} />
          </span>
          <h1 className="kb-crumb-current">{boardName}</h1>
          <span className="kb-crumb-tag">{t('app.cardCount', { count: cardCount })}</span>
        </nav>

        <div className="kb-topbar-actions">
          <div className="kb-seg" role="tablist" aria-label={t('app.viewBoard')}>
            {anchorViews.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={view === entry.id}
                className={`kb-seg-btn${view === entry.id ? ' kb-seg-btn--active' : ''}`}
                onClick={() => onViewChange(entry.id)}
              >
                <span className="kb-icon" aria-hidden="true">
                  {entry.icon}
                </span>
                <span className="kb-seg-label">{t(entry.key)}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            className="kb-icon-btn kb-lang-btn"
            onClick={onToggleLang}
            aria-label={t('app.language')}
            title={t('app.language')}
          >
            <span className="kb-icon" aria-hidden="true">
              <IconGlobe />
            </span>
            <span className="kb-lang-label">{lang === 'zh' ? '中' : 'EN'}</span>
          </button>

          <button type="button" className="kb-btn kb-btn--primary kb-new-btn" onClick={onNewCard}>
            <span className="kb-icon" aria-hidden="true">
              <IconPlus />
            </span>
            <span className="kb-new-btn__text">{t('app.newCard')}</span>
          </button>
        </div>
      </header>

      <div className="kb-toolbar">
        <label className="kb-search">
          <span className="kb-icon kb-search__icon" aria-hidden="true">
            <IconSearch />
          </span>
          <span className="kb-sr-only">{t('a11y.search')}</span>
          <input
            ref={searchRef}
            id="kb-search-input"
            type="search"
            className="kb-search__input"
            placeholder={t('app.searchPlaceholder')}
            autoComplete="off"
            value={filters.query}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onFiltersChange({ ...filters, query: event.target.value })
            }
          />
          {filters.query ? (
            <button
              type="button"
              className="kb-icon-btn kb-search__clear"
              aria-label={t('app.clearFilters')}
              onClick={() => onFiltersChange({ ...filters, query: '' })}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconClose />
              </span>
            </button>
          ) : (
            <span className="kb-kbd" aria-hidden="true">
              ⌘K
            </span>
          )}
        </label>

        <FilterMenu filters={filters} projects={projects} labels={labels} onChange={onFiltersChange} />

        <div className="kb-filter-chips" aria-label={t('app.filterTitle')}>
          {filters.project ? (
            <Chip
              label={filters.project}
              removeLabel={t('app.clearFilters')}
              onRemove={() => onFiltersChange({ ...filters, project: null })}
            />
          ) : null}
          {filters.label ? (
            <Chip
              label={filters.label}
              removeLabel={t('app.clearFilters')}
              onRemove={() => onFiltersChange({ ...filters, label: null })}
            />
          ) : null}
          {activeFilters ? (
            <button
              type="button"
              className="kb-link-btn"
              onClick={() => onFiltersChange({ query: '', project: null, label: null })}
            >
              {t('app.clearFilters')}
            </button>
          ) : null}
        </div>

        <div className="kb-toolbar-spacer" />

        <span className="kb-agent-live" title={t('app.syncConnected')}>
          <span
            className={`kb-dot kb-dot--${syncState === 'connected' ? 'success' : syncState === 'connecting' ? 'business' : syncState === 'reconnecting' ? 'warn' : 'tertiary'}`}
            aria-hidden="true"
          />
          {runningCount > 0 ? t('app.liveCount', { count: runningCount }) : t('app.syncConnected')}
        </span>

        <button
          type="button"
          className="kb-icon-btn"
          onClick={onRefresh}
          aria-label={t('app.refresh')}
          title={t('app.refresh')}
        >
          <span className={`kb-icon${refreshing ? ' kb-spin' : ''}`} aria-hidden="true">
            <IconRefresh />
          </span>
        </button>
      </div>
    </>
  );
}
