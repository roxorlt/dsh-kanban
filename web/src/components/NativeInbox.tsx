/**
 * 原生待确认收件区（「待你确认」列顶部）：
 * 展示 DSH 宿主里的工具授权 / Agent 提问 / 计划审批，并支持在看板内直接作答。
 * 数据与派生规则见 lib/nativeInbox.ts 与 docs/contracts/04-native-inbox.md。
 */
import type { Card } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import type { NativeInboxEntry, NativeRiskBasis, NativeRiskLevel } from '../lib/nativeInbox';
import { formatCountdown } from '../lib/nativeInbox';
import {
  IconAlert,
  IconClock,
  IconEdit,
  IconHand,
  IconInfo,
  IconLink,
  IconOpen,
  IconWrench,
} from './Icons';

export interface NativeInboxActions {
  onAnswerApproval: (entry: NativeInboxEntry, outcome: 'allowed-once' | 'rejected') => void;
  onOpenQuestion: (entry: NativeInboxEntry) => void;
  onOpenPlan: (entry: NativeInboxEntry) => void;
  onOpenSession: (entry: NativeInboxEntry) => void;
  onOpenCard: (card: Card) => void;
}

export interface NativeInboxProps extends NativeInboxActions {
  entries: NativeInboxEntry[];
  /** 正在提交的项 key */
  busyIds: ReadonlySet<string>;
}

const RISK_KEY: Record<NativeRiskLevel, I18nKey> = {
  high: 'native.risk.high',
  medium: 'native.risk.medium',
  low: 'native.risk.low',
};

const RISK_BASIS_KEY: Record<NativeRiskBasis, I18nKey> = {
  'danger-full-access': 'native.risk.basis.dangerFullAccess',
  'workspace-write': 'native.risk.basis.workspaceWrite',
  'mutating-tool': 'native.risk.basis.mutatingTool',
  'other-tool': 'native.risk.basis.otherTool',
  info: 'native.risk.basis.info',
  plan: 'native.risk.basis.plan',
};

function sourceKey(entry: NativeInboxEntry): I18nKey {
  if (entry.kind === 'approval') return 'native.source.approval';
  if (entry.kind === 'plan-review') return 'native.source.plan';
  return 'native.source.question';
}

function SourceIcon({ entry }: { entry: NativeInboxEntry }) {
  if (entry.kind === 'approval') return <IconWrench />;
  if (entry.kind === 'plan-review') return <IconEdit />;
  return <IconInfo />;
}

/** 收件区：仅在有待确认项时渲染；卡片列计数不包含它。 */
export function NativeInbox({
  entries,
  busyIds,
  onAnswerApproval,
  onOpenQuestion,
  onOpenPlan,
  onOpenSession,
  onOpenCard,
}: NativeInboxProps) {
  const { t } = useI18n();
  if (!entries.length) return null;

  return (
    <section className="kb-inbox" aria-label={t('native.sectionTitle')}>
      <header className="kb-inbox__head">
        <span className="kb-inbox__head-icon" aria-hidden="true">
          <IconHand />
        </span>
        <h3 className="kb-inbox__title">{t('native.sectionTitle')}</h3>
        <span className="kb-pill kb-pill--warn kb-pill--count" aria-label={t('native.count', { count: entries.length })}>
          {entries.length}
        </span>
        <span className="kb-inbox__hint">{t('native.sectionHint')}</span>
      </header>

      <div className="kb-inbox__list" role="list">
        {entries.map((entry) => {
          const busy = busyIds.has(entry.id);
          const riskLabel = t(RISK_KEY[entry.riskLevel]);
          const basisLabel = t(RISK_BASIS_KEY[entry.riskBasis]);
          const riskTitle = t('native.risk.title', { level: riskLabel, basis: basisLabel });
          const canAnswer = entry.answerable && !busy;
          return (
            <article
              key={entry.id}
              role="listitem"
              className={`kb-inbox-item kb-inbox-item--${entry.riskLevel}`}
              data-pending-key={entry.id}
              aria-busy={busy}
            >
              <div className="kb-inbox-item__top">
                <span className={`kb-inbox-source kb-inbox-source--${entry.source}`}>
                  <span className="kb-icon" aria-hidden="true">
                    <SourceIcon entry={entry} />
                  </span>
                  {t(sourceKey(entry))}
                </span>
                <span
                  className={`kb-inbox-risk kb-inbox-risk--${entry.riskLevel}`}
                  title={riskTitle}
                  aria-label={riskTitle}
                >
                  <span className="kb-dot kb-dot--warn" aria-hidden="true" />
                  {riskLabel}
                </span>
                {entry.countdownMs !== undefined && entry.countdownRunning ? (
                  <span className="kb-inbox-countdown" title={t('native.countdownHint')}>
                    <span className="kb-icon" aria-hidden="true">
                      <IconClock />
                    </span>
                    {formatCountdown(entry.countdownMs)}
                  </span>
                ) : null}
                <span className="kb-inbox-item__session" title={entry.sessionId}>
                  {t('native.session', { session: entry.sessionLabel })}
                </span>
              </div>

              <p className="kb-inbox-item__title">{entry.title || t('native.noReason')}</p>

              {entry.kind === 'plan-review' && entry.planReview?.summary ? (
                <p className="kb-inbox-item__summary">{entry.planReview.summary}</p>
              ) : null}

              <div className="kb-inbox-item__meta">
                {entry.kind === 'approval' ? (
                  <span className="kb-inbox-meta">{t('native.tool', { tool: entry.toolName ?? '—' })}</span>
                ) : (
                  <span className="kb-inbox-meta">
                    {t('native.questionCount', { count: entry.questionCount ?? 0 })}
                  </span>
                )}
                {entry.state === 'continued' ? (
                  <span className="kb-inbox-meta kb-inbox-meta--warn">{t('native.continued')}</span>
                ) : null}
                {entry.card ? (
                  <button
                    type="button"
                    className="kb-inbox-card-link"
                    onClick={() => onOpenCard(entry.card as Card)}
                    title={t('native.openCard', { title: entry.card.title })}
                  >
                    <span className="kb-icon" aria-hidden="true">
                      <IconLink />
                    </span>
                    {entry.card.title}
                  </button>
                ) : null}
              </div>

              <div className="kb-inbox-item__actions">
                {entry.kind === 'approval' ? (
                  <>
                    <button
                      type="button"
                      className="kb-btn kb-btn--sm kb-btn--primary"
                      disabled={!canAnswer}
                      onClick={() => onAnswerApproval(entry, 'allowed-once')}
                    >
                      {busy ? t('native.submitting') : t('native.allowOnce')}
                    </button>
                    <button
                      type="button"
                      className="kb-btn kb-btn--sm kb-btn--outline"
                      disabled={!canAnswer}
                      onClick={() => onAnswerApproval(entry, 'rejected')}
                    >
                      {t('native.reject')}
                    </button>
                  </>
                ) : entry.kind === 'plan-review' ? (
                  <button
                    type="button"
                    className="kb-btn kb-btn--sm kb-btn--primary"
                    disabled={!canAnswer}
                    onClick={() => onOpenPlan(entry)}
                  >
                    {t('native.reviewPlan')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="kb-btn kb-btn--sm kb-btn--primary"
                    disabled={!canAnswer || entry.channel === 'none'}
                    title={entry.channel === 'none' ? t('native.channelNotReady') : undefined}
                    onClick={() => onOpenQuestion(entry)}
                  >
                    {t('native.answer')}
                  </button>
                )}
                <button
                  type="button"
                  className="kb-btn kb-btn--sm kb-btn--ghost kb-inbox-item__open"
                  onClick={() => onOpenSession(entry)}
                >
                  <span className="kb-icon" aria-hidden="true">
                    <IconOpen />
                  </span>
                  {t('native.openSession')}
                </button>
                {!entry.answerable ? (
                  <span className="kb-inbox-item__blocked">
                    <span className="kb-icon" aria-hidden="true">
                      <IconAlert />
                    </span>
                    {t('native.notAnswerable')}
                  </span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
