import { useId, useMemo, useState } from 'react';
import type { Card, SessionRow, WorkspaceRow } from '../types';
import { useI18n } from '../i18n';
import { suggestCwds } from '../lib/suggestions';
import {
  deriveRunningSessionIds,
  formatTitleList,
  isTerminalCardStatus,
  sessionArchiveReadiness,
  summarizeSessionArchiveBlocker,
} from '../lib/sessionArchive';
import { SuggestionChips } from './SuggestionChips';
import { IconAlert, IconArchive, IconOpen, IconPlus, IconSession } from './Icons';

export interface CreateSessionOptions {
  workspaceId?: string;
  cwd: string;
  start: boolean;
}

interface SessionSectionProps {
  card: Card;
  sessions: SessionRow[];
  workspaces: WorkspaceRow[];
  /** 用于 cwd 建议的看板卡片 */
  cards: Card[];
  embedded: boolean;
  busy?: boolean;
  /** 回复/审批的目标会话（默认主会话），用于高亮当前目标行 */
  targetSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onBind: (sessionId: string) => void;
  onUnbind: (sessionId: string) => void;
  onSetPrimary: (sessionId: string) => void;
  onCreateSession: (card: Card, options: CreateSessionOptions) => void;
  /** 宿主当前已归档的会话 id（桥推送 / GET /sessions/archive） */
  archivedSessionIds: ReadonlySet<string>;
  /** 宿主是否提供可逆归档（R7）：false 时隐藏所有归档/恢复入口 */
  archiveAvailable: boolean;
  /** 有待确认项（原生 approval/question/plan）的会话 id（R6 预检） */
  pendingSessionIds: ReadonlySet<string>;
  onArchiveSession: (card: Card, sessionId: string) => void;
  onUnarchiveSession: (card: Card, sessionId: string) => void;
}

/**
 * 多会话绑定：列出卡片会话（标题、session id、主会话徽标、运行状态）、
 * 设为主会话、解绑、打开；回复/审批目标在 Composer 里的下拉选择。
 * 无会话进行中卡片显示警示；「新建会话」先展开内联表单选工作区/目录。
 */
export function SessionSection({
  card,
  sessions,
  workspaces,
  cards,
  embedded,
  busy,
  targetSessionId,
  onOpenSession,
  onBind,
  onUnbind,
  onSetPrimary,
  onCreateSession,
  archivedSessionIds,
  archiveAvailable,
  pendingSessionIds,
  onArchiveSession,
  onUnarchiveSession,
}: SessionSectionProps) {
  const { t, lang } = useI18n();
  const selectId = useId();
  const workspaceSelectId = useId();
  const cwdInputId = useId();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const bound = card.sessionIds.map((id) => ({ id, session: byId.get(id) }));
  const available = sessions.filter((session) => !card.sessionIds.includes(session.id));
  const runningWithoutSession = card.status === 'running' && bound.length === 0;
  const runningSessionIds = useMemo(() => deriveRunningSessionIds(sessions), [sessions]);
  const archivedBound = bound.filter(({ id }) => archivedSessionIds.has(id));
  // 非完成卡片上出现已归档会话：提醒「继续前需恢复」（docs/11 §6.1）
  const showArchivedWarning = embedded && archiveAvailable && archivedBound.length > 0 && !isTerminalCardStatus(card.status);

  const blockReasonText = (readiness: ReturnType<typeof sessionArchiveReadiness>): string | null => {
    const summary = summarizeSessionArchiveBlocker(readiness.blockers);
    if (!summary) return null;
    if (summary.kind === 'card') {
      return t('sessionArchive.busyCards', {
        count: summary.count ?? 0,
        titles: formatTitleList(summary.titles ?? [], lang),
      });
    }
    if (summary.kind === 'running') return t('sessionArchive.reasonRunning');
    if (summary.kind === 'pending') return t('sessionArchive.reasonPending');
    return t('sessionArchive.reasonHost');
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(card.workspaceId ?? '');
  const [cwd, setCwd] = useState(card.cwd ?? '');
  const [createError, setCreateError] = useState<string | null>(null);

  const cwdSuggestions = useMemo(
    () => suggestCwds({ workspaces, sessions, cards, selectedWorkspaceId: workspaceId || null }),
    [cards, sessions, workspaceId, workspaces],
  );

  if (!bound.length && !embedded) {
    return (
      <div className="kb-session">
        <p className="kb-session__hint">{t('drawer.noSessionHint')}</p>
        <p className="kb-session__hint">{t('drawer.standaloneSessionHint')}</p>
      </div>
    );
  }

  const openCreateForm = () => {
    const selected = workspaces.find((workspace) => workspace.workspaceId === workspaceId) ?? workspaces[0];
    setWorkspaceId(selected?.workspaceId ?? '');
    setCwd((current) => current || card.cwd || selected?.path || '');
    setCreateError(null);
    setCreateOpen(true);
  };

  const submitCreate = () => {
    if (!cwd.trim() && !workspaceId) {
      setCreateError(t('drawer.createSessionNeedCwd'));
      return;
    }
    setCreateError(null);
    setCreateOpen(false);
    onCreateSession(card, {
      ...(workspaceId ? { workspaceId } : {}),
      cwd: cwd.trim(),
      start: card.status === 'running',
    });
  };

  return (
    <div className="kb-session">
      {runningWithoutSession ? (
        <p className="kb-session__warn" role="status">
          <span className="kb-icon" aria-hidden="true">
            <IconAlert />
          </span>
          {t('drawer.runningNoSessionWarn')}
        </p>
      ) : null}

      {showArchivedWarning ? (
        <p className="kb-session__warn kb-session__warn--archived" role="status">
          <span className="kb-icon" aria-hidden="true">
            <IconAlert />
          </span>
          {t('sessionArchive.archivedWarning')}
        </p>
      ) : null}

      {bound.length ? (
        <>
          <p className="kb-session__summary">{t('drawer.sessionCount', { count: bound.length })}</p>
          <ul className="kb-session__list">
            {bound.map(({ id, session }, index) => {
              const isPrimary = index === 0;
              const selectedTarget = (targetSessionId ?? card.sessionIds[0]) === id;
              const archived = archivedSessionIds.has(id);
              const pending = pendingSessionIds.has(id);
              const running = session?.running ?? runningSessionIds.has(id);
              const readiness = sessionArchiveReadiness({
                card,
                sessionId: id,
                cards,
                archivedSessionIds,
                runningSessionIds,
                pendingSessionIds,
                available: archiveAvailable,
              });
              // 归档入口只在「完成/取消」卡片上渲染（docs/11 §6.1：未完成时不渲染，避免误解）
              const showArchive = embedded && archiveAvailable && readiness.cardTerminal && !archived;
              const showRestore = embedded && archiveAvailable && archived;
              const blockReason = showArchive && !readiness.archivable ? blockReasonText(readiness) : null;
              return (
                <li
                  className={`kb-session__row${selectedTarget ? ' kb-session__row--target' : ''}${blockReason ? ' kb-session__row--stack' : ''}`}
                  key={id}
                >
                  <span className="kb-icon kb-session__icon" aria-hidden="true">
                    <IconSession />
                  </span>
                  <span className="kb-session__main">
                    <span className="kb-session__title" title={session?.title ?? id}>
                      <span className="kb-session__name">{session?.title ?? id}</span>
                      {isPrimary ? (
                        <span className="kb-tag kb-session__primary">{t('drawer.primarySession')}</span>
                      ) : null}
                    </span>
                    <span className="kb-session__meta">
                      {archived ? (
                        <span className="kb-pill kb-session__badge">
                          <span className="kb-dot kb-dot--tertiary" aria-hidden="true" />
                          {t('sessionArchive.archived')}
                        </span>
                      ) : (
                        <span className={`kb-pill${running ? ' kb-pill--business' : ''}`}>
                          <span className={`kb-dot kb-dot--${running ? 'business' : 'tertiary'}`} aria-hidden="true" />
                          {running ? t('drawer.running') : t('drawer.idle')}
                        </span>
                      )}
                      {pending ? <span className="kb-pill kb-pill--warn">{t('sessionArchive.pendingBadge')}</span> : null}
                      <code className="kb-session__id" title={id}>
                        {id}
                      </code>
                    </span>
                  </span>
                  {embedded ? (
                    <span className="kb-session__actions">
                      <button
                        type="button"
                        className="kb-btn kb-btn--sm kb-btn--ghost"
                        disabled={busy}
                        onClick={() => onOpenSession(id)}
                      >
                        <span className="kb-icon" aria-hidden="true">
                          <IconOpen />
                        </span>
                        {t('drawer.openSession')}
                      </button>
                      {!isPrimary ? (
                        <button
                          type="button"
                          className="kb-btn kb-btn--sm kb-btn--ghost"
                          disabled={busy}
                          onClick={() => onSetPrimary(id)}
                        >
                          {t('drawer.setPrimary')}
                        </button>
                      ) : null}
                      {showArchive ? (
                        <button
                          type="button"
                          className="kb-btn kb-btn--sm kb-btn--ghost"
                          disabled={busy || !readiness.archivable}
                          title={blockReason ?? undefined}
                          onClick={() => onArchiveSession(card, id)}
                        >
                          <span className="kb-icon" aria-hidden="true">
                            <IconArchive />
                          </span>
                          {t('sessionArchive.archive')}
                        </button>
                      ) : null}
                      {showRestore ? (
                        <button
                          type="button"
                          className="kb-btn kb-btn--sm kb-btn--outline"
                          disabled={busy}
                          onClick={() => onUnarchiveSession(card, id)}
                        >
                          {t('sessionArchive.unarchive')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="kb-btn kb-btn--sm kb-btn--ghost"
                        disabled={busy}
                        onClick={() => onUnbind(id)}
                      >
                        {t('drawer.unbind')}
                      </button>
                    </span>
                  ) : null}
                  {blockReason ? <p className="kb-session__reason">{blockReason}</p> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="kb-session__hint">{t('drawer.noSessionHint')}</p>
      )}


      {!embedded ? <p className="kb-session__hint">{t('drawer.standaloneSessionHint')}</p> : null}

      {embedded ? (
        <div className="kb-session__bind">
          <label className="kb-session__select-label" htmlFor={selectId}>
            {t('drawer.bindSession')}
          </label>
          <div className="kb-session__bind-row">
            <select
              id={selectId}
              className="kb-select"
              value=""
              disabled={busy || !available.length}
              onChange={(event) => {
                const value = event.target.value;
                if (value) onBind(value);
              }}
            >
              <option value="" disabled>
                {available.length ? t('drawer.selectSession') : t('drawer.sessionPickerEmpty')}
              </option>
              {available.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                  {session.running ? ` · ${t('drawer.running')}` : ''}
                  {archivedSessionIds.has(session.id) ? ` · ${t('sessionArchive.archived')}` : ''}
                  {pendingSessionIds.has(session.id) ? ` · ${t('sessionArchive.pendingBadge')}` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="kb-btn kb-btn--sm kb-btn--outline kb-session__create"
              disabled={busy}
              onClick={() => (createOpen ? setCreateOpen(false) : openCreateForm())}
              aria-expanded={createOpen}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconPlus />
              </span>
              {createOpen ? t('drawer.createSessionCancel') : t('drawer.createSession')}
            </button>
          </div>
        </div>
      ) : null}

      {embedded && createOpen ? (
        <div className="kb-session-create" role="group" aria-label={t('drawer.createSessionFormTitle')}>
          <h4 className="kb-session-create__title">{t('drawer.createSessionFormTitle')}</h4>
          {/* 抽屉只有 400–520px：工作区/执行目录各占整行，避免两列把路径输入框挤到截断 */}
          <div className="kb-form__row kb-form__row--stack">
            <label className="kb-field">
              <span className="kb-field__label">{t('drawer.createSessionWorkspace')}</span>
              <select
                id={workspaceSelectId}
                className="kb-select"
                value={workspaceId}
                onChange={(event) => {
                  const next = event.target.value;
                  setWorkspaceId(next);
                  const workspace = workspaces.find((item) => item.workspaceId === next);
                  if (workspace?.path) setCwd(workspace.path);
                }}
              >
                <option value="">{t('modal.workspaceNone')}</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.workspaceId} value={workspace.workspaceId}>
                    {workspace.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="kb-field">
              <span className="kb-field__label">{t('drawer.createSessionCwd')}</span>
              <input
                id={cwdInputId}
                className="kb-input"
                value={cwd}
                title={cwd.trim() || undefined}
                placeholder={t('drawer.createSessionCwdPlaceholder')}
                onChange={(event) => setCwd(event.target.value)}
              />
              <SuggestionChips
                id="kb-session-cwd-suggestions"
                label={t('modal.cwdSuggestions')}
                items={cwdSuggestions}
                value={cwd}
                onPick={(value) => setCwd(value)}
              />
            </label>
          </div>
          {createError ? (
            <p className="kb-field__hint" role="alert">
              {createError}
            </p>
          ) : null}
          <div className="kb-session-create__actions">
            <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => setCreateOpen(false)}>
              {t('drawer.createSessionCancel')}
            </button>
            <button type="button" className="kb-btn kb-btn--sm kb-btn--primary" disabled={busy} onClick={submitCreate}>
              {card.status === 'running'
                ? t('drawer.createSessionAndStart')
                : t('drawer.createSessionAndBind')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
