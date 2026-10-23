import { useId, useMemo, useState } from 'react';
import type { Card, SessionRow, WorkspaceRow } from '../types';
import { useI18n } from '../i18n';
import { suggestCwds } from '../lib/suggestions';
import { SuggestionChips } from './SuggestionChips';
import { IconAlert, IconOpen, IconPlus, IconSession } from './Icons';

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
  /** 回复/审批的目标会话（默认主会话） */
  targetSessionId: string | null;
  onTargetChange: (sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onBind: (sessionId: string) => void;
  onUnbind: (sessionId: string) => void;
  onSetPrimary: (sessionId: string) => void;
  onCreateSession: (card: Card, options: CreateSessionOptions) => void;
}

/**
 * 多会话绑定：列出卡片会话、主会话徽标、设为主会话、解绑、打开；
 * >1 个会话时提供「回复与审批同步到」目标选择。
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
  onTargetChange,
  onOpenSession,
  onBind,
  onUnbind,
  onSetPrimary,
  onCreateSession,
}: SessionSectionProps) {
  const { t } = useI18n();
  const selectId = useId();
  const targetGroup = useId();
  const workspaceSelectId = useId();
  const cwdInputId = useId();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const bound = card.sessionIds.map((id) => ({ id, session: byId.get(id) }));
  const available = sessions.filter((session) => !card.sessionIds.includes(session.id));
  const runningWithoutSession = card.status === 'running' && bound.length === 0;

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

      {bound.length ? (
        <>
          <p className="kb-session__summary">
            {t('drawer.sessionCount', { count: bound.length })}
            {bound.length > 1 ? ` · ${t('drawer.primarySession')}` : ''}
          </p>
          <ul className="kb-session__list">
            {bound.map(({ id, session }, index) => {
              const isPrimary = index === 0;
              const selectedTarget = (targetSessionId ?? card.sessionIds[0]) === id;
              return (
                <li className={`kb-session__row${selectedTarget ? ' kb-session__row--target' : ''}`} key={id}>
                  <span className="kb-icon kb-session__icon" aria-hidden="true">
                    <IconSession />
                  </span>
                  <span className="kb-session__title">
                    {session?.title ?? id}
                    {isPrimary ? (
                      <span className="kb-tag kb-session__primary">{t('drawer.primarySession')}</span>
                    ) : null}
                  </span>
                  <span className={`kb-pill${session?.running ? ' kb-pill--business' : ''}`}>
                    <span className={`kb-dot kb-dot--${session?.running ? 'business' : 'tertiary'}`} aria-hidden="true" />
                    {session?.running ? t('drawer.running') : t('drawer.idle')}
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
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="kb-session__hint">{t('drawer.noSessionHint')}</p>
      )}

      {embedded && bound.length > 1 ? (
        <fieldset className="kb-session__target" aria-label={t('drawer.approvalTarget')}>
          <legend className="kb-session__target-legend">{t('drawer.approvalTarget')}</legend>
          {bound.map(({ id, session }) => (
            <label
              className={`kb-check${(targetSessionId ?? card.sessionIds[0]) === id ? ' kb-check--on' : ''}`}
              key={`${targetGroup}-${id}`}
            >
              <input
                type="radio"
                name={targetGroup}
                value={id}
                checked={(targetSessionId ?? card.sessionIds[0]) === id}
                onChange={() => onTargetChange(id)}
              />
              <span>{session?.title ?? id}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

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
                  {session.title} {session.running ? `· ${t('drawer.running')}` : ''}
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
          <div className="kb-form__row">
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
