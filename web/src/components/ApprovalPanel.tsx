import { useEffect, useId, useMemo, useState } from 'react';
import type { Approval, ApprovalOption } from '../types';
import { useI18n } from '../i18n';
import { formatRelative } from '../lib/time';
import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons';

export type ApprovalDecision = 'approve' | 'reject';

interface ApprovalPanelProps {
  approval: Approval;
  busy: boolean;
  now: number;
  /** optionIds：单选长度 1，多选可多个；decision 由面板按所选选项语义给出 */
  onResolve: (
    approval: Approval,
    optionIds: string[],
    comment: string,
    decision: ApprovalDecision,
  ) => void;
}

const REJECT_IDS = ['no', 'reject', 'deny', 'cancel', 'stop', 'hold'];

function isRejectOption(option: ApprovalOption): boolean {
  return option.tone === 'danger' || REJECT_IDS.includes(option.id);
}

function rejectOptionOf(approval: Approval): ApprovalOption | undefined {
  return approval.options.find(isRejectOption);
}

function defaultOptionOf(approval: Approval): ApprovalOption | undefined {
  return approval.options.find((option) => option.tone === 'primary' || option.id === 'yes') ?? approval.options[0];
}

function resolvedLabels(approval: Approval): string[] {
  const resolution = approval.resolution;
  if (!resolution) return [];
  if (Array.isArray(resolution.labels) && resolution.labels.length) return resolution.labels;
  if (typeof resolution.label === 'string' && resolution.label) return [resolution.label];
  const ids = Array.isArray(resolution.optionIds)
    ? resolution.optionIds
    : typeof resolution.optionId === 'string'
      ? [resolution.optionId]
      : [];
  return ids
    .map((optionId) => approval.options.find((option) => option.id === optionId)?.label ?? optionId)
    .filter(Boolean);
}

/**
 * 审批区：完整展示全部选项与说明；单选用 radio，多选用 checkbox（approval.multiSelect）。
 * 提交 optionIds[]；resolved 展示所选 labels（兼容旧 resolution.optionId/label）。
 */
export function ApprovalPanel({ approval, busy, now, onResolve }: ApprovalPanelProps) {
  const { t, lang } = useI18n();
  const groupId = useId();
  const multi = Boolean(approval.multiSelect);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const initial = defaultOptionOf(approval);
    return initial ? [initial.id] : [];
  });
  const [comment, setComment] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    setSelectedIds((current) => {
      const valid = current.filter((id) => approval.options.some((option) => option.id === id));
      if (valid.length) return valid;
      const fallback = defaultOptionOf(approval);
      return fallback ? [fallback.id] : [];
    });
  }, [approval]);

  const selectedOptions = useMemo(
    () => approval.options.filter((option) => selectedIds.includes(option.id)),
    [approval.options, selectedIds],
  );

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
    const labels = resolvedLabels(approval);
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
        {labels.length ? (
          <p className="kb-decision-resolved">
            <strong>{labels.join('、')}</strong>
            {approval.resolution?.comment ? <span> · {approval.resolution.comment}</span> : null}
          </p>
        ) : null}
      </section>
    );
  }

  const toggleOption = (optionId: string) => {
    setValidation(null);
    setSelectedIds((current) => {
      if (!multi) return [optionId];
      return current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId];
    });
  };

  const submitSelected = () => {
    if (!selectedOptions.length) {
      setValidation(t('approval.selectAtLeastOne'));
      return;
    }
    const allReject = selectedOptions.every(isRejectOption);
    onResolve(
      approval,
      selectedOptions.map((option) => option.id),
      comment.trim(),
      allReject ? 'reject' : 'approve',
    );
  };

  const rejectOption = rejectOptionOf(approval);

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
        <legend className="kb-sr-only">
          {t('approval.option')}
          {multi ? ` · ${t('approval.multiHint')}` : ''}
        </legend>
        {multi ? <p className="kb-decision-multi-hint">{t('approval.multiHint')}</p> : null}
        {approval.options.map((option) => {
          const checked = selectedIds.includes(option.id);
          return (
            <label key={option.id} className={`kb-decision-option${checked ? ' kb-decision-option--selected' : ''}`}>
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={multi ? `${groupId}-${option.id}` : groupId}
                value={option.id}
                checked={checked}
                disabled={busy}
                onChange={() => toggleOption(option.id)}
              />
              <span className="kb-decision-option__label">{option.label}</span>
              {option.description ? <span className="kb-decision-option__desc">{option.description}</span> : null}
            </label>
          );
        })}
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

      {validation ? (
        <p className="kb-decision-validation" role="alert">
          {validation}
        </p>
      ) : null}

      <div className="kb-decision-actions">
        {multi ? (
          <button
            type="button"
            className="kb-btn kb-btn--primary kb-btn--sm"
            disabled={busy || !selectedOptions.length}
            onClick={submitSelected}
          >
            <span className="kb-icon" aria-hidden="true">
              <IconCheck />
            </span>
            {busy ? t('approval.resolving') : t('approval.submit')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="kb-btn kb-btn--outline kb-btn--sm"
              disabled={busy || !rejectOption}
              title={rejectOption ? undefined : t('approval.noRejectOption')}
              onClick={() => {
                if (rejectOption) onResolve(approval, [rejectOption.id], comment.trim(), 'reject');
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
              disabled={busy || !selectedOptions.length}
              onClick={submitSelected}
            >
              <span className="kb-icon" aria-hidden="true">
                <IconCheck />
              </span>
              {busy ? t('approval.resolving') : t('approval.approve')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
