import { useEffect, useId, useState } from 'react';
import type { Approval, ApprovalOption } from '../types';
import { useI18n } from '../i18n';
import { formatRelative } from '../lib/time';
import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons';

export type ApprovalDecision = 'approve' | 'reject';

interface ApprovalPanelProps {
  approval: Approval;
  busy: boolean;
  now: number;
  onResolve: (approval: Approval, option: ApprovalOption, comment: string, decision: ApprovalDecision) => void;
}

function rejectOptionOf(approval: Approval): ApprovalOption | undefined {
  return approval.options.find((option) => option.id === 'no' || option.tone === 'danger');
}

function defaultOptionOf(approval: Approval): ApprovalOption | undefined {
  return approval.options.find((option) => option.tone === 'primary' || option.id === 'yes') ?? approval.options[0];
}

/**
 * 审批区（decision 卡）：问题 + 影响说明 + 方案单选 + 备注 + 拒绝/批准。
 * 解决后调 resolve API，再经桥把决定文本发到主会话。
 */
export function ApprovalPanel({ approval, busy, now, onResolve }: ApprovalPanelProps) {
  const { t, lang } = useI18n();
  const groupId = useId();
  const initial = defaultOptionOf(approval);
  const [selectedId, setSelectedId] = useState<string>(initial?.id ?? '');
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (!approval.options.some((option) => option.id === selectedId)) {
      setSelectedId(defaultOptionOf(approval)?.id ?? '');
    }
  }, [approval, selectedId]);

  const selected = approval.options.find((option) => option.id === selectedId) ?? defaultOptionOf(approval);
  const rejectOption = rejectOptionOf(approval);
  const pending = approval.status === 'pending';

  if (!pending) {
    const statusKey =
      approval.status === 'approved'
        ? 'approval.status.approved'
        : approval.status === 'rejected'
          ? 'approval.status.rejected'
          : 'approval.status.dismissed';
    const tone = approval.status === 'approved' ? 'success' : approval.status === 'rejected' ? 'error' : 'tertiary';
    const pillClass = tone === 'tertiary' ? 'kb-pill' : `kb-pill kb-pill--${tone}`;
    return (
      <section className="kb-decision kb-decision--resolved" aria-label={t('approval.heading')}>
        <div className="kb-decision-q">
          <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
          <span className="kb-decision-q__title">{approval.title}</span>
          <span className={pillClass}>{t(statusKey)}</span>
          {approval.resolvedAt ? (
            <span className="kb-decision-time">{formatRelative(approval.resolvedAt, now, lang)}</span>
          ) : null}
        </div>
        {approval.resolution ? (
          <p className="kb-decision-resolved">
            {approval.resolution.label}
            {approval.resolution.comment ? <span> · {approval.resolution.comment}</span> : null}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="kb-decision" aria-label={t('approval.heading')}>
      <div className="kb-decision-q">
        <span className="kb-icon" aria-hidden="true">
          <IconAlert />
        </span>
        <span className="kb-decision-q__title">{approval.title}</span>
        <span className="kb-decision-time">
          {t('approval.requestedBy', { name: approval.requestedBy.name })} ·{' '}
          {formatRelative(approval.requestedAt, now, lang)}
        </span>
      </div>

      {approval.detail ? (
        <p className="kb-decision-risk">
          <span className="kb-icon" aria-hidden="true">
            <IconInfo />
          </span>
          <span>{approval.detail}</span>
        </p>
      ) : null}

      <fieldset className="kb-decision-options" aria-label={t('approval.option')}>
        <legend className="kb-sr-only">{t('approval.chooseOption')}</legend>
        {approval.options.map((option) => (
          <label
            key={option.id}
            className={`kb-decision-option${selected?.id === option.id ? ' kb-decision-option--selected' : ''}`}
          >
            <input
              type="radio"
              name={groupId}
              value={option.id}
              checked={selected?.id === option.id}
              disabled={busy}
              onChange={() => setSelectedId(option.id)}
            />
            <span className="kb-decision-option__label">{option.label}</span>
            {option.description ? <span className="kb-decision-option__desc">{option.description}</span> : null}
          </label>
        ))}
      </fieldset>

      <label className="kb-decision-note-wrap">
        <span className="kb-sr-only">{t('approval.comment')}</span>
        <textarea
          className="kb-textarea kb-decision-note"
          placeholder={t('approval.commentPlaceholder')}
          value={comment}
          rows={1}
          disabled={busy}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      <div className="kb-decision-actions">
        <button
          type="button"
          className="kb-btn kb-btn--outline kb-btn--sm"
          disabled={busy || !rejectOption}
          title={rejectOption ? undefined : t('approval.noRejectOption')}
          onClick={() => {
            if (rejectOption) onResolve(approval, rejectOption, comment.trim(), 'reject');
          }}
        >
          <span className="kb-icon" aria-hidden="true">
            <IconClose />
          </span>
          {t('approval.reject')}
        </button>
        <button
          type="button"
          className="kb-btn kb-btn--primary kb-btn--sm"
          disabled={busy || !selected}
          onClick={() => {
            if (selected) onResolve(approval, selected, comment.trim(), 'approve');
          }}
        >
          <span className="kb-icon" aria-hidden="true">
            <IconCheck />
          </span>
          {busy ? t('approval.resolving') : t('approval.approve')}
        </button>
      </div>
    </section>
  );
}
