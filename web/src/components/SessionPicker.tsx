/**
 * 「绑定会话」选择器（v0.19.0，卡片 card-d60ae026）。
 *
 * 抽屉里的原生 <select> 有三个问题：选项平铺上百条、只看得到标题、没有工作区概念。
 * 这里换成带范围切换 / 搜索 / 折叠分组的浮层：
 * - 默认只列「卡片所属工作区」的会话（卡片 cwd / workspaceId / 已绑定会话推断），一屏就能选完；
 * - 可切到「所有工作区」：按 DSH 工作区分组，组头显示工作区名 / 路径 / 会话数，点组头折叠或展开；
 * - 搜索同时匹配会话标题、会话 ID、cwd、工作区名与路径（搜 `rea` 能直接定位 rea L2）；
 * - 原生 select 兜底不了的场景（宿主列表与工作区注册表不一致）由纯逻辑补行；
 * - 底部提供「按会话 ID 绑定」，任何会话 ID 都能直接绑。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Card, SessionRow, WorkspaceRow } from '../types';
import { useI18n } from '../i18n';
import { formatRelative } from '../lib/time';
import { pushOverlay } from '../lib/overlayStack';
import {
  countPickerSessions,
  defaultExpandedGroupKeys,
  filterSessionGroups,
  filterSessionGroupsToWorkspace,
  groupSessionsByWorkspace,
  resolvePickerScopeWorkspace,
  shortSessionId,
  type SessionPickerGroup,
  type SessionPickerSession,
} from '../lib/sessionPicker';
import { IconChevronDown, IconChevronRight, IconSearch, IconSession } from './Icons';

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 420;
const PANEL_ESTIMATED_HEIGHT = 360;
const VIEWPORT_MARGIN = 8;
const GAP = 6;

type PickerScope = 'workspace' | 'all';

interface PanelPosition {
  top: number;
  left: number;
  width: number;
}

interface SessionPickerProps {
  card: Card;
  sessions: SessionRow[];
  workspaces: WorkspaceRow[];
  archivedSessionIds: ReadonlySet<string>;
  pendingSessionIds: ReadonlySet<string>;
  busy?: boolean;
  onBind: (sessionId: string) => void;
}

/** 抽屉宽度 400–520px：浮层宽度跟着触发器走，但夹在 320–420px 与视口之间。 */
function panelWidth(triggerWidth: number): number {
  const available = window.innerWidth - VIEWPORT_MARGIN * 2;
  return Math.max(240, Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, triggerWidth), available));
}

export function SessionPicker({
  card,
  sessions,
  workspaces,
  archivedSessionIds,
  pendingSessionIds,
  busy,
  onBind,
}: SessionPickerProps) {
  const { t, lang } = useI18n();
  const pickerId = useId();
  const manualInputId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PickerScope>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [manualOpen, setManualOpen] = useState(false);
  const [manualId, setManualId] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const groups = useMemo(
    () => groupSessionsByWorkspace({ sessions, workspaces, excludeSessionIds: card.sessionIds }),
    [card.sessionIds, sessions, workspaces],
  );
  const total = useMemo(() => countPickerSessions(groups), [groups]);
  // 卡片所属工作区：默认范围只列它名下的会话（推断不到时退回所有工作区）。
  const scopeWorkspace = useMemo(
    () => resolvePickerScopeWorkspace({ sessions, workspaces, card }),
    [card, sessions, workspaces],
  );
  const effectiveScope: PickerScope = scope === 'workspace' && scopeWorkspace ? 'workspace' : 'all';
  const scopedGroups = useMemo(
    () =>
      effectiveScope === 'workspace' && scopeWorkspace
        ? filterSessionGroupsToWorkspace(groups, scopeWorkspace.workspaceId)
        : groups,
    [effectiveScope, groups, scopeWorkspace],
  );
  const filtered = useMemo(() => filterSessionGroups(scopedGroups, query), [query, scopedGroups]);
  const searching = query.trim().length > 0;
  const visibleCount = useMemo(
    () => countPickerSessions(searching ? filtered : scopedGroups),
    [filtered, scopedGroups, searching],
  );
  // 「所有工作区」模式：搜索时命中的分组一律展开；否则按用户手动折叠状态。
  const expandedKeys = useMemo(
    () => (searching ? new Set(filtered.map((group) => group.key)) : expanded),
    [expanded, filtered, searching],
  );

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openPicker = () => {
    if (busy || total === 0) return;
    setQuery('');
    setManualOpen(false);
    setManualId('');
    setScope(scopeWorkspace ? 'workspace' : 'all');
    setExpanded(defaultExpandedGroupKeys(groups, card));
    setOpen(true);
  };

  // 定位：贴在触发器下方；下方放不下且上方更宽裕时翻到上方。
  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = panelWidth(rect.width);
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN));
    const below = rect.bottom + GAP;
    const above = rect.top - PANEL_ESTIMATED_HEIGHT - GAP;
    const flipAbove =
      below + PANEL_ESTIMATED_HEIGHT > window.innerHeight - VIEWPORT_MARGIN && above > VIEWPORT_MARGIN;
    setPosition({ top: flipAbove ? above : below, left, width });
  }, [open]);

  useEffect(() => {
    if (!open || !position) return;
    searchRef.current?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    return pushOverlay(() => close(true));
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    // 抽屉正文滚动时浮层会错位：直接关闭（浮层自身滚动不算）。
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const toggleGroup = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const bind = (sessionId: string) => {
    if (busy) return;
    onBind(sessionId);
    close(true);
  };

  const submitManual = (event: React.FormEvent) => {
    event.preventDefault();
    const sessionId = manualId.trim();
    if (!sessionId || busy) return;
    bind(sessionId);
  };

  const focusSessionRow = (where: 'first' | 'last') => {
    const rows = panelRef.current?.querySelectorAll<HTMLButtonElement>('.kb-session-picker__row');
    if (!rows || rows.length === 0) return;
    (where === 'first' ? rows[0] : rows[rows.length - 1])?.focus();
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusSessionRow('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusSessionRow('last');
    }
  };

  const sessionTitle = (session: SessionPickerSession, workspaceTitle: string): string => {
    if (!session.placeholder) return session.title || session.id;
    // 兜底行没有宿主标题：用「工作区名 · 短 ID」保证能认出来
    return `${workspaceTitle} · ${shortSessionId(session.id)}`;
  };

  const renderRow = (session: SessionPickerSession, workspaceTitle: string) => {
    const title = sessionTitle(session, workspaceTitle);
    const archived = archivedSessionIds.has(session.id);
    const pending = pendingSessionIds.has(session.id);
    return (
      <li key={session.id}>
        <button
          type="button"
          className="kb-session-picker__row"
          disabled={busy}
          onClick={() => bind(session.id)}
          title={`${title}\n${session.id}`}
        >
          <span className="kb-session-picker__row-title">
            <span className="kb-icon kb-session-picker__row-icon" aria-hidden="true">
              <IconSession />
            </span>
            <span className="kb-session-picker__row-name">{title}</span>
            {session.running ? (
              <span className="kb-pill kb-pill--business">
                <span className="kb-dot kb-dot--business" aria-hidden="true" />
                {t('drawer.running')}
              </span>
            ) : null}
            {archived ? (
              <span className="kb-pill">
                <span className="kb-dot kb-dot--tertiary" aria-hidden="true" />
                {t('sessionArchive.archived')}
              </span>
            ) : null}
            {pending ? <span className="kb-pill kb-pill--warn">{t('sessionArchive.pendingBadge')}</span> : null}
          </span>
          <span className="kb-session-picker__row-meta">
            <code className="kb-session-picker__row-id" title={session.id}>
              {session.placeholder ? session.id : shortSessionId(session.id)}
            </code>
            {session.updatedAt ? (
              <>
                <span className="kb-session-picker__row-sep" aria-hidden="true">
                  ·
                </span>
                <span className="kb-session-picker__row-time">{formatRelative(session.updatedAt, Date.now(), lang)}</span>
              </>
            ) : null}
            {session.placeholder ? (
              <>
                <span className="kb-session-picker__row-sep" aria-hidden="true">
                  ·
                </span>
                <span className="kb-session-picker__row-hint">{t('sessionPicker.notListedByHost')}</span>
              </>
            ) : null}
          </span>
        </button>
      </li>
    );
  };

  const triggerText = total === 0 ? t('drawer.sessionPickerEmpty') : t('drawer.selectSession');
  const workspaceTitleOf = (group: SessionPickerGroup): string =>
    group.workspaceId ? group.title : t('sessionPicker.unassigned');
  const scopeTitle = scopeWorkspace?.title ?? t('sessionPicker.scopeAll');

  const renderGroups = () => {
    if (filtered.length === 0) {
      const empty =
        !searching && effectiveScope === 'workspace' && scopeWorkspace
          ? t('sessionPicker.workspaceEmpty', { name: scopeWorkspace.title })
          : t('sessionPicker.empty');
      return <p className="kb-session-picker__empty">{empty}</p>;
    }
    return filtered.map((group) => {
      const isOpen = expandedKeys.has(group.key);
      const listId = `${pickerId}-${group.key}`;
      const workspaceTitle = workspaceTitleOf(group);
      return (
        <div className="kb-session-picker__group" key={group.key}>
          <button
            type="button"
            className="kb-session-picker__group-head"
            aria-expanded={isOpen}
            aria-controls={listId}
            onClick={() => toggleGroup(group.key)}
          >
            <span className="kb-icon kb-session-picker__chevron" data-open={isOpen ? 'true' : 'false'} aria-hidden="true">
              <IconChevronRight />
            </span>
            <span className="kb-session-picker__group-main">
              <span className="kb-session-picker__group-title">{workspaceTitle}</span>
              {group.path ? (
                <span className="kb-session-picker__group-path" title={group.path}>
                  {group.path}
                </span>
              ) : null}
            </span>
            <span className="kb-session-picker__group-count">
              {t('sessionPicker.sessionCount', { count: group.sessions.length })}
            </span>
          </button>
          {isOpen ? (
            <ul className="kb-session-picker__list" id={listId}>
              {group.sessions.map((session) => renderRow(session, workspaceTitle))}
            </ul>
          ) : null}
        </div>
      );
    });
  };

  // 本工作区范围：直接平铺该工作区的会话（不用再点开分组）。
  const renderScopedList = () => {
    const group = filtered[0];
    if (!group || group.sessions.length === 0) {
      const empty = searching
        ? t('sessionPicker.empty')
        : scopeWorkspace
          ? t('sessionPicker.workspaceEmpty', { name: scopeWorkspace.title })
          : t('sessionPicker.empty');
      return <p className="kb-session-picker__empty">{empty}</p>;
    }
    const workspaceTitle = workspaceTitleOf(group);
    return (
      <ul className="kb-session-picker__list kb-session-picker__list--flat">
        {group.sessions.map((session) => renderRow(session, workspaceTitle))}
      </ul>
    );
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="kb-session-picker__trigger"
        disabled={busy || total === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(true) : openPicker())}
      >
        <span className="kb-session-picker__trigger-text">{triggerText}</span>
        <span className="kb-icon kb-session-picker__trigger-caret" aria-hidden="true">
          <IconChevronDown />
        </span>
      </button>

      {open && position ? (
        <div
          ref={panelRef}
          className="kb-session-picker"
          role="dialog"
          aria-label={t('sessionPicker.dialogTitle')}
          style={{ top: position.top, left: position.left, width: position.width }}
        >
          <div className="kb-session-picker__search">
            <span className="kb-icon kb-session-picker__search-icon" aria-hidden="true">
              <IconSearch />
            </span>
            <input
              ref={searchRef}
              id={`${pickerId}-search`}
              className="kb-input kb-session-picker__search-input"
              type="search"
              value={query}
              aria-label={t('sessionPicker.searchLabel')}
              placeholder={t('sessionPicker.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>

          <div className="kb-session-picker__scope" role="group" aria-label={t('sessionPicker.scopeLabel')}>
            <button
              type="button"
              className="kb-session-picker__scope-option"
              aria-pressed={effectiveScope === 'workspace'}
              disabled={!scopeWorkspace}
              title={scopeWorkspace ? t('sessionPicker.scopeWorkspaceTitle', { name: scopeTitle }) : undefined}
              onClick={() => setScope('workspace')}
            >
              {t('sessionPicker.scopeWorkspace')}
            </button>
            <button
              type="button"
              className="kb-session-picker__scope-option"
              aria-pressed={effectiveScope === 'all'}
              onClick={() => setScope('all')}
            >
              {t('sessionPicker.scopeAll')}
            </button>
            {effectiveScope === 'workspace' ? (
              <>
                <span className="kb-session-picker__scope-name" title={scopeWorkspace?.path ?? undefined}>
                  {scopeTitle}
                </span>
                <span className="kb-session-picker__scope-sep" aria-hidden="true">
                  ·
                </span>
              </>
            ) : (
              <span className="kb-session-picker__scope-name" />
            )}
            <span className="kb-session-picker__scope-count">
              {t('sessionPicker.sessionCount', { count: visibleCount })}
            </span>
          </div>

          <div className="kb-session-picker__groups">
            {effectiveScope === 'workspace' ? renderScopedList() : renderGroups()}
          </div>

          <div className="kb-session-picker__foot">
            {manualOpen ? (
              <form className="kb-session-picker__manual" onSubmit={submitManual}>
                <label className="kb-session-picker__manual-label" htmlFor={manualInputId}>
                  {t('sessionPicker.manualLabel')}
                </label>
                <div className="kb-session-picker__manual-row">
                  <input
                    id={manualInputId}
                    className="kb-input"
                    value={manualId}
                    placeholder={t('sessionPicker.manualPlaceholder')}
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    onChange={(event) => setManualId(event.target.value)}
                  />
                  <button type="submit" className="kb-btn kb-btn--sm kb-btn--outline" disabled={busy || !manualId.trim()}>
                    {t('sessionPicker.manualSubmit')}
                  </button>
                </div>
                <p className="kb-session-picker__manual-hint">{t('sessionPicker.manualHint')}</p>
              </form>
            ) : (
              <button type="button" className="kb-session-picker__manual-toggle" onClick={() => setManualOpen(true)}>
                {t('sessionPicker.manualToggle')}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
