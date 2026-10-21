import { useEffect, useId, useMemo, useRef } from 'react';
import type { Activity, Card, SessionRow } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { STATUS_TONE, isWarningStatus } from '../lib/status';
import { elapsedMs, formatDateTime, formatDuration, formatRelative } from '../lib/time';
import { cardTimeline } from '../lib/timeline';
import { ApprovalPanel } from './ApprovalPanel';
import { Composer } from './Composer';
import { SessionSection } from './SessionSection';
import { Timeline } from './Timeline';
import type { CardActionHandlers } from './types';
import {
  IconArchive,
  IconClose,
  IconCommit,
  IconEdit,
  IconFile,
  IconImage,
  IconLink,
  IconReport,
} from './Icons';

interface DetailDrawerProps {
  card: Card;
  boardName: string;
  activities: Activity[] | undefined;
  sessions: SessionRow[];
  embedded: boolean;
  now: number;
  resolvingApprovalId: string | null;
  onClose: () => void;
  actions: CardActionHandlers;
  onReply: (card: Card, text: string) => Promise<{ ok: boolean; error?: string }>;
  onBindSession: (card: Card, sessionId: string) => void;
  onUnbindSession: (card: Card, sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onCreateSession: (card: Card) => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function artifactIcon(kind: string) {
  switch (kind) {
    case 'link':
      return <IconLink />;
    case 'commit':
      return <IconCommit />;
    case 'image':
      return <IconImage />;
    case 'report':
      return <IconReport />;
    default:
      return <IconFile />;
  }
}

/** 卡片详情抽屉：宽屏右侧 440px，<720px 由 CSS 变成底部 92% 高 sheet。 */
export function DetailDrawer({
  card,
  boardName,
  activities,
  sessions,
  embedded,
  now,
  resolvingApprovalId,
  onClose,
  actions,
  onReply,
  onBindSession,
  onUnbindSession,
  onOpenSession,
  onCreateSession,
}: DetailDrawerProps) {
  const { t, lang } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const tone = STATUS_TONE[card.status];
  const statusKey = `status.${card.status}` as I18nKey;
  const timeline = useMemo(() => cardTimeline(card, activities), [card, activities]);
  const elapsed = elapsedMs(card, now);
  const pendingApprovals = card.approvals.filter((approval) => approval.status === 'pending');
  const resolvedApprovals = card.approvals.filter((approval) => approval.status !== 'pending');
  const checklistDone = card.checklists.filter((item) => item.done).length;
  const checklistPercent = card.checklists.length
    ? Math.round((checklistDone / card.checklists.length) * 100)
    : 0;

  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();
    return () => {
      root.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="kb-drawer-overlay" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className="kb-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-status={card.status}
      >
        <span className="kb-drawer__grabber" aria-hidden="true" />
        <header className="kb-drawer__header">
          <div className="kb-drawer__heading">
            <p className="kb-drawer__kicker">
              <span>{boardName}</span>
              <span aria-hidden="true"> · </span>
              <span>{t(statusKey)}</span>
              {card.project ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span>{card.project}</span>
                </>
              ) : null}
              {isWarningStatus(card.status) ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="kb-drawer__warning">{card.currentAction ?? t(statusKey)}</span>
                </>
              ) : null}
            </p>
            <div className="kb-drawer__title-row">
              <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
              <h2 id={titleId} className="kb-drawer__title">
                {card.title}
              </h2>
            </div>
            {card.summary ? <p className="kb-drawer__summary">{card.summary}</p> : null}
          </div>
          <div className="kb-drawer__header-actions">
            <button type="button" className="kb-btn kb-btn--sm kb-btn--outline" onClick={() => actions.onEdit(card)}>
              <span className="kb-icon" aria-hidden="true">
                <IconEdit />
              </span>
              {t('card.edit')}
            </button>
            <button
              type="button"
              className="kb-btn kb-btn--icon kb-btn--ghost"
              aria-label={t('card.archive')}
              title={t('card.archive')}
              onClick={() => actions.onArchive(card)}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconArchive />
              </span>
            </button>
            <button
              type="button"
              className="kb-btn kb-btn--icon kb-btn--ghost"
              aria-label={t('drawer.close')}
              onClick={onClose}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconClose />
              </span>
            </button>
          </div>
        </header>

        <div className="kb-drawer__body">
          <div className="kb-drawer__chips">
            <span className={`kb-pill${tone === 'business' ? ' kb-pill--business' : tone === 'warn' ? ' kb-pill--warn' : tone === 'success' ? ' kb-pill--success' : tone === 'error' ? ' kb-pill--error' : ''}`}>
              <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
              {t(statusKey)}
            </span>
            {card.priority !== 'none' ? (
              <span className="kb-pill">{t(`priority.${card.priority}` as I18nKey)}</span>
            ) : null}
            {card.labels.map((label) => (
              <span className="kb-tag" key={label}>
                {label}
              </span>
            ))}
            {card.agent?.name ? (
              <span className="kb-pill">
                {t('card.agent')} · {card.agent.name}
              </span>
            ) : null}
          </div>

          {card.currentAction ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.currentAction')}</h3>
              <p className="kb-drawer__text">{card.currentAction}</p>
            </section>
          ) : null}

          {card.progress ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.progress')}</h3>
              <div className="kb-progress">
                <div
                  className="kb-progress__bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(card.progress.percent ?? 0)}
                >
                  <span
                    className="kb-progress__fill"
                    style={{ width: `${Math.max(0, Math.min(100, card.progress.percent ?? 0))}%` }}
                  />
                </div>
                <span className="kb-progress__label">
                  {card.progress.total
                    ? `${card.progress.step}/${card.progress.total}`
                    : `${card.progress.percent ?? 0}%`}
                  {card.progress.text ? ` · ${card.progress.text}` : ''}
                </span>
              </div>
            </section>
          ) : null}

          {card.result ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.result')}</h3>
              <p className="kb-drawer__text kb-drawer__text--result">{card.result}</p>
            </section>
          ) : null}

          {pendingApprovals.length ? (
            <section className="kb-drawer__section kb-drawer__section--approval">
              <h3 className="kb-drawer__section-title">{t('drawer.approvals')}</h3>
              {pendingApprovals.map((approval) => (
                <ApprovalPanel
                  key={approval.id}
                  approval={approval}
                  busy={resolvingApprovalId === approval.id}
                  now={now}
                  onResolve={(target, option, comment, decision) =>
                    actions.onResolveApproval(card, target, option, comment, decision)
                  }
                />
              ))}
            </section>
          ) : null}

          {card.checklists.length ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.checklist')}</h3>
              <div className="kb-checklist">
                <div className="kb-checklist__head">
                  <span className="kb-checklist__count">
                    {checklistDone}/{card.checklists.length}
                  </span>
                  <div className="kb-progress__bar kb-checklist__bar">
                    <span className="kb-progress__fill" style={{ width: `${checklistPercent}%` }} />
                  </div>
                </div>
                <ul className="kb-checklist__items">
                  {card.checklists.map((item) => (
                    <li className={`kb-checklist__item${item.done ? ' kb-checklist__item--done' : ''}`} key={item.id}>
                      <span className={`kb-check${item.done ? ' kb-check--done' : ''}`} aria-hidden="true">
                        {item.done ? '✓' : ''}
                      </span>
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <section className="kb-drawer__section">
            <h3 className="kb-drawer__section-title">{t('drawer.timeline')}</h3>
            <Timeline activities={timeline} now={now} variant="full" />
          </section>

          {resolvedApprovals.length ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.approvals')}</h3>
              {resolvedApprovals.map((approval) => (
                <ApprovalPanel
                  key={approval.id}
                  approval={approval}
                  busy={false}
                  now={now}
                  onResolve={() => undefined}
                />
              ))}
            </section>
          ) : null}

          {card.artifacts.length ? (
            <section className="kb-drawer__section">
              <h3 className="kb-drawer__section-title">{t('drawer.artifacts')}</h3>
              <ul className="kb-artifacts">
                {card.artifacts.map((artifact) => {
                  const content = (
                    <>
                      <span className="kb-icon" aria-hidden="true">
                        {artifactIcon(artifact.kind)}
                      </span>
                      <span>{artifact.label}</span>
                      {artifact.path ? <code className="kb-artifacts__path">{artifact.path}</code> : null}
                    </>
                  );
                  return (
                    <li key={artifact.id} className="kb-artifacts__item">
                      {artifact.url ? (
                        <a href={artifact.url} target="_blank" rel="noreferrer noopener">
                          {content}
                        </a>
                      ) : (
                        <span>{content}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section className="kb-drawer__section">
            <h3 className="kb-drawer__section-title">{t('drawer.sessions')}</h3>
            <SessionSection
              card={card}
              sessions={sessions}
              embedded={embedded}
              busy={false}
              onOpenSession={onOpenSession}
              onBind={(sessionId) => onBindSession(card, sessionId)}
              onUnbind={(sessionId) => onUnbindSession(card, sessionId)}
              onCreateSession={() => onCreateSession(card)}
            />
          </section>

          <section className="kb-drawer__section">
            <h3 className="kb-drawer__section-title">{t('drawer.metadata')}</h3>
            <dl className="kb-meta-grid">
              <div>
                <dt>{t('drawer.toolCalls')}</dt>
                <dd>{card.metadata.toolCalls}</dd>
              </div>
              <div>
                <dt>{t('drawer.searches')}</dt>
                <dd>{card.metadata.searches}</dd>
              </div>
              <div>
                <dt>{t('drawer.elapsed')}</dt>
                <dd>{formatDuration(elapsed, lang)}</dd>
              </div>
              {typeof card.metadata.tokensIn === 'number' || typeof card.metadata.tokensOut === 'number' ? (
                <div>
                  <dt>{t('drawer.tokens')}</dt>
                  <dd>
                    {card.metadata.tokensIn ?? 0} / {card.metadata.tokensOut ?? 0}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{t('drawer.createdAt')}</dt>
                <dd>{formatDateTime(card.createdAt, lang)}</dd>
              </div>
              <div>
                <dt>{t('drawer.updatedAt')}</dt>
                <dd>{formatDateTime(card.updatedAt, lang)}</dd>
              </div>
              {card.startedAt ? (
                <div>
                  <dt>{t('drawer.startedAt')}</dt>
                  <dd>{formatDateTime(card.startedAt, lang)}</dd>
                </div>
              ) : null}
              {card.completedAt ? (
                <div>
                  <dt>{t('drawer.completedAt')}</dt>
                  <dd>{formatDateTime(card.completedAt, lang)}</dd>
                </div>
              ) : null}
              {card.cwd ? (
                <div className="kb-meta-grid__wide">
                  <dt>{t('drawer.workspace')}</dt>
                  <dd>
                    <code className="kb-meta-grid__code">{card.cwd}</code>
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="kb-drawer__updated">{formatRelative(card.updatedAt, now, lang)}</p>
          </section>
        </div>

        <footer className="kb-drawer__footer">
          <Composer embedded={embedded} onSubmit={(text) => onReply(card, text)} autoFocus={false} />
        </footer>
      </div>
    </div>
  );
}
