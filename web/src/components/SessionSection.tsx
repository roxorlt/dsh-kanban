import { useId } from 'react';
import type { Card, SessionRow } from '../types';
import { useI18n } from '../i18n';
import { IconOpen, IconPlus, IconSession } from './Icons';

interface SessionSectionProps {
  card: Card;
  sessions: SessionRow[];
  embedded: boolean;
  busy?: boolean;
  /** 回复/审批的目标会话（默认主会话） */
  targetSessionId: string | null;
  onTargetChange: (sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onBind: (sessionId: string) => void;
  onUnbind: (sessionId: string) => void;
  onSetPrimary: (sessionId: string) => void;
  onCreateSession: () => void;
}

/**
 * 多会话绑定：列出卡片会话、主会话徽标、设为主会话、解绑、打开；
 * >1 个会话时提供「回复与审批同步到」目标选择。
 */
export function SessionSection({
  card,
  sessions,
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
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const bound = card.sessionIds.map((id) => ({ id, session: byId.get(id) }));
  const available = sessions.filter((session) => !card.sessionIds.includes(session.id));

  if (!bound.length && !embedded) {
    return (
      <div className="kb-session">
        <p className="kb-session__hint">{t('drawer.noSessionHint')}</p>
        <p className="kb-session__hint">{t('drawer.standaloneSessionHint')}</p>
      </div>
    );
  }

  return (
    <div className="kb-session">
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
              onClick={onCreateSession}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconPlus />
              </span>
              {t('drawer.createSession')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
