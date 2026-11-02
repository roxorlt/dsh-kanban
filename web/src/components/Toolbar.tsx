import type { ChangeEvent, ReactNode } from 'react';
import type { CardFilters } from '../lib/filter';
import { hasActiveFilters } from '../lib/filter';
import type { Lang } from '../i18n';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { FilterMenu } from './FilterMenu';
import type { ThemePreference } from '../bridge';
import {
  IconAuto,
  IconBoard,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconFilter,
  IconFolder,
  IconGlobe,
  IconHelp,
  IconList,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSun,
  IconWorkline,
} from './Icons';

export type ViewMode = 'board' | 'list' | 'workspaces' | 'worklines';
export type SyncState = 'connected' | 'connecting' | 'reconnecting' | 'offline' | 'standalone';

interface ToolbarProps {
  boardName: string;
  totalCards: number;
  needsYouCount: number;
  sessionsRunning: number;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  filters: CardFilters;
  onFiltersChange: (filters: CardFilters) => void;
  projects: string[];
  lang: Lang;
  onToggleLang: () => void;
  onNewCard: () => void;
  syncState: SyncState;
  /** 数据刷新失败时的内联错误条（重试入口，替代刷新按钮） */
  syncError: string | null;
  onRetry: () => void;
  themePreference: ThemePreference;
  themeMode: 'light' | 'dark';
  onCycleTheme: () => void;
  onShowHelp: () => void;
  selectionMode: boolean;
  onToggleSelection: () => void;
  /** 首屏数据尚未到达：顶栏计数改占位条、依赖数据的操作禁用（docs/10 A-13）。 */
  loading: boolean;
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

/** 顶栏：看板名 + 计数（待你确认 / 会话运行中），Board/List、搜索/筛选、状态点；列表视图才有新建。 */
export function Toolbar({
  boardName,
  totalCards,
  needsYouCount,
  sessionsRunning,
  view,
  onViewChange,
  filters,
  onFiltersChange,
  projects,
  lang,
  onToggleLang,
  onNewCard,
  syncState,
  syncError,
  onRetry,
  themePreference,
  themeMode,
  onCycleTheme,
  onShowHelp,
  selectionMode,
  onToggleSelection,
  loading,
}: ToolbarProps) {
  const { t } = useI18n();
  const activeFilters = hasActiveFilters(filters);
  const themeLabel =
    themePreference === 'system'
      ? `${t('theme.follow')}${themeMode === 'dark' ? ` · ${t('theme.dark')}` : ''}`
      : themePreference === 'light'
        ? t('theme.light')
        : t('theme.dark');
  const themeIcon = themePreference === 'system' ? <IconAuto /> : themeMode === 'dark' ? <IconMoon /> : <IconSun />;
  const themeShortLabel =
    themePreference === 'system'
      ? t('theme.shortFollow')
      : themePreference === 'light'
        ? t('theme.shortLight')
        : t('theme.shortDark');

  const views: { id: ViewMode; icon: ReactNode; key: I18nKey }[] = [
    { id: 'board', icon: <IconBoard />, key: 'app.viewBoard' },
    { id: 'list', icon: <IconList />, key: 'app.viewList' },
    { id: 'worklines', icon: <IconWorkline />, key: 'app.viewWorklines' },
    { id: 'workspaces', icon: <IconFolder />, key: 'app.viewWorkspaces' },
  ];
  const syncLabel =
    syncState === 'standalone'
      ? t('app.syncStandalone')
      : syncState === 'connecting'
        ? t('app.syncConnecting')
        : syncState === 'reconnecting'
          ? t('app.syncReconnecting')
          : syncState === 'offline'
            ? t('app.syncOffline')
            : t('app.syncConnected');
  const syncTone =
    syncState === 'connected'
      ? 'success'
      : syncState === 'reconnecting'
        ? 'warn'
        : syncState === 'offline'
          ? 'error'
          : syncState === 'connecting'
            ? 'business'
            : 'tertiary';
  /** 连接中断/已断开时，状态点变成可点重试入口（docs/10 A-08）。 */
  const syncRetryable = syncState === 'reconnecting' || syncState === 'offline';
  /** 首屏 loading：顶栏计数用占位条，禁用依赖数据的操作（docs/10 A-13）。 */
  const loadingHint = t('app.loadingHint');

  return (
    <>
      <header className="kb-topbar">
        <div className="kb-crumbs">
        <h1 className="kb-crumb-current">{boardName}</h1>
        <span
          className={`kb-crumb-tag${loading ? ' kb-crumb-tag--loading' : ''}`}
          title={loading ? loadingHint : t('app.boardCardCountTooltip', { count: totalCards })}
        >
          {loading ? (
            <span className="kb-crumb-placeholder" aria-hidden="true" />
          ) : (
            t('app.cardCountTotal', { count: totalCards })
          )}
        </span>
        <span className="kb-crumb-counts">
          {loading ? (
            <>
              <span className="kb-crumb-count" aria-hidden="true">
                <span className="kb-crumb-placeholder" />
              </span>
              <span className="kb-crumb-count" aria-hidden="true">
                <span className="kb-crumb-placeholder" />
              </span>
            </>
          ) : (
            <>
              <span className="kb-crumb-count kb-crumb-count--needs">
                <span className="kb-dot kb-dot--warn" aria-hidden="true" />
                {t('app.needsYouCount', { count: needsYouCount })}
              </span>
              <span className="kb-crumb-count kb-crumb-count--running">
                <span className="kb-dot kb-dot--business" aria-hidden="true" />
                {t('app.sessionsRunning', { count: sessionsRunning })}
              </span>
            </>
          )}
        </span>
      </div>

        <div className="kb-topbar-actions">
        <div className="kb-seg kb-viewseg" role="tablist" aria-label={t('app.viewTabs')}>
          {views.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={view === entry.id}
              aria-label={t(entry.key)}
              title={t(entry.key)}
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
          className="kb-icon-btn kb-theme-btn"
          onClick={onCycleTheme}
          aria-label={t('theme.cycle', { mode: themeLabel })}
          title={t('theme.current', { mode: themeLabel })}
        >
          <span className="kb-icon" aria-hidden="true">
            {themeIcon}
          </span>
          <span className="kb-theme-label" aria-hidden="true">
            {themeShortLabel}
          </span>
        </button>

        <button
          type="button"
          className="kb-icon-btn kb-help-btn"
          onClick={onShowHelp}
          aria-label={t('shortcut.help')}
          title={t('shortcut.help')}
        >
          <span className="kb-icon" aria-hidden="true">
            <IconHelp />
          </span>
        </button>

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

        {view === 'list' || loading ? (
          <button
            type="button"
            className="kb-btn kb-btn--primary kb-new-btn"
            onClick={onNewCard}
            disabled={loading}
            aria-disabled={loading || undefined}
            title={loading ? loadingHint : undefined}
          >
            <span className="kb-icon" aria-hidden="true">
              <IconPlus />
            </span>
            <span className="kb-new-btn__text">{t('app.newCard')}</span>
          </button>
        ) : null}
        </div>
      </header>

      {selectionMode ? null : (
      <div className="kb-toolbar">
        <label className="kb-search">
          <span className="kb-icon kb-search__icon" aria-hidden="true">
            <IconSearch />
          </span>
          <span className="kb-sr-only">{t('a11y.search')}</span>
          <input
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

        {loading ? (
          <button
            type="button"
            className="kb-btn kb-btn--outline kb-btn--sm kb-filter-btn"
            disabled
            aria-disabled="true"
            title={loadingHint}
          >
            <span className="kb-icon" aria-hidden="true">
              <IconFilter />
            </span>
            {t('app.toolbarFilters')}
            <span className="kb-icon kb-filter-caret" aria-hidden="true">
              <IconChevronDown />
            </span>
          </button>
        ) : (
          <FilterMenu filters={filters} projects={projects} onChange={onFiltersChange} />
        )}

        <div className="kb-filter-chips" aria-label={t('app.filterTitle')}>
          {filters.project ? (
            <Chip
              label={filters.project}
              removeLabel={t('app.clearFilters')}
              onRemove={() => onFiltersChange({ ...filters, project: null })}
            />
          ) : null}
          {activeFilters ? (
            <button
              type="button"
              className="kb-link-btn"
              onClick={() => onFiltersChange({ query: '', project: null })}
            >
              {t('app.clearFilters')}
            </button>
          ) : null}
        </div>

        {view === 'workspaces' ? null : (
        <button
          type="button"
          className={`kb-btn kb-btn--sm ${selectionMode ? 'kb-btn--primary' : 'kb-btn--outline'} kb-select-btn`}
          aria-pressed={selectionMode}
          onClick={onToggleSelection}
          disabled={loading}
          aria-disabled={loading || undefined}
          title={loading ? loadingHint : undefined}
        >
          <span className="kb-icon" aria-hidden="true">
            <IconCheck />
          </span>
          {selectionMode ? t('selection.exit') : t('selection.enter')}
        </button>
        )}

        <div className="kb-toolbar-spacer" />

        {syncRetryable ? (
          <button
            type="button"
            className="kb-agent-live kb-agent-live--action"
            title={`${syncLabel} · ${t('app.syncRetryAction')}`}
            aria-label={`${syncLabel} · ${t('app.syncRetryAction')}`}
            onClick={onRetry}
          >
            <span className={`kb-dot kb-dot--${syncTone}`} aria-hidden="true" />
            {syncLabel}
          </button>
        ) : (
          <span className="kb-agent-live" title={syncLabel}>
            <span className={`kb-dot kb-dot--${syncTone}`} aria-hidden="true" />
            {syncLabel}
          </span>
        )}
        {/* aria-live：只在状态文案变化时播报一次，退避重试期间文案不变，不会反复播报 */}
        <span className="kb-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {syncLabel}
        </span>
      </div>
      )}

      {syncError ? (
        <div className="kb-errorbar" role="alert">
          <span className="kb-errorbar__message">{syncError}</span>
          <button type="button" className="kb-btn kb-btn--sm kb-btn--outline" onClick={onRetry}>
            {t('app.retry')}
          </button>
        </div>
      ) : null}
    </>
  );
}
