import { useId } from 'react';
import type { Card, SessionRow } from '../types';
import { useI18n } from '../i18n';
import { IconOpen, IconPlus, IconSession } from './Icons';

interface SessionSectionProps {
  card: Card;
  sessions: SessionRow[];
  embedded: boolean;
  busy?: boolean;
  onOpenSession: (sessionId: string) => void;
  onBind: (sessionId: string) => void;
  onUnbind: (sessionId: string) => void;
  onCreateSession: () => void;
}

/** 会话绑定：展示主会话标题/运行状态，可从 sessions.list 选择已有会话绑定或打开。 */
export function SessionSection({
  card,
  sessions,
  embedded,
  busy,
  onOpenSession,
  onBind,
  onUnbind,
  onCreateSession,
}: SessionSectionProps) {
  const { t } = useI18n();
  const selectId = useId();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const bound = card.sessionIds.map((id) => ({ id, session: byId.get(id) }));
  const available = sessions.filter((session) => !card.sessionIds.includes(session.id));

  if (!bound.length && !embedded) {
    return <p className="kb-session__hint">{t('drawer.standaloneSessionHint')}</p>;
  }

  return (
    <div className="kb-session">
      {bound.length ? (
        <ul className="kb-session__list">
          {bound.map(({ id, session }, index) => (
            <li className="kb-session__row" key={id}>
              <span className="kb-icon kb-session__icon">
                <IconSession />
              </span>
              <span className="kb-session__title">
                {session?.title ?? id}
                {index === 0 ? <span className="kb-tag kb-session__primary">{t('drawer.primarySession')}</span> : null}
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
                    <span className="kb-icon">
                      <IconOpen />
                    </span>
                    {t('drawer.openSession')}
                  </button>
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
          ))}
        </ul>
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
