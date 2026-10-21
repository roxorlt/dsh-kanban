import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Approval, ApprovalAnswer } from '../types';
import { useI18n } from '../i18n';
import { formatRelative } from '../lib/time';
import {
  allAnswersAreReject,
  approvalQuestions,
  buildApprovalAnswers,
  flattenAnswers,
  isMultiQuestionApproval,
  isRejectOption,
  resolvedAnswerGroups,
  validateApprovalSelection,
} from '../lib/approvalQuestions';
import type { ApprovalSelection } from '../lib/approvalQuestions';
import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons';

export type ApprovalDecision = 'approve' | 'reject';

export interface ApprovalSubmission {
  /** 拍平后的 option id（单题/多题都填） */
  optionIds: string[];
  /** v0.3 多问题逐题答案 */
  answers?: ApprovalAnswer[];
}

interface ApprovalPanelProps {
  approval: Approval;
  busy: boolean;
  now: number;
  /** 详情抽屉内放宽展示；卡片内限高滚动 */
  inDrawer?: boolean;
  onResolve: (
    approval: Approval,
    submission: ApprovalSubmission,
    comment: string,
    decision: ApprovalDecision,
  ) => void;
  /** 逐题校验失败时提示（toast） */
  onValidationError?: (message: string) => void;
}

function defaultSingleSelection(approval: Approval): string[] {
  const preferred =
    approval.options.find((option) => option.tone === 'primary' || option.id === 'yes') ?? approval.options[0];
  return preferred ? [preferred.id] : [];
}

/**
 * 审批区：
 * - 单题（v0.2 兼容）：radio/checkbox + 驳回/批准；
 * - 多题（v0.3 questions[]）：逐题 fieldset（header、题号、单选/多选徽标、全部选项与说明）+ 统一备注 +
 *   「提交全部回答」，逐题校验（缺题高亮/聚焦 + toast），提交 answers[]。
 * resolved 态逐题展示所选 labels（兼容旧 resolution.optionIds/labels）。
 */
export function ApprovalPanel({
  approval,
  busy,
  now,
  inDrawer = false,
  onResolve,
  onValidationError,
}: ApprovalPanelProps) {
  const { t, lang } = useI18n();
  const groupId = useId();
  const multiQuestion = isMultiQuestionApproval(approval);
  const questions = useMemo(() => approvalQuestions(approval), [approval]);

  // —— 单题状态 ——
  const [singleSelection, setSingleSelection] = useState<string[]>(() => defaultSingleSelection(approval));
  // —— 多题状态（按 question.id 存 optionIds） ——
  const [selection, setSelection] = useState<ApprovalSelection>({});
  const [comment, setComment] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [missingIndex, setMissingIndex] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setSingleSelection((current) => {
      const valid = current.filter((id) => approval.options.some((option) => option.id === id));
      return valid.length ? valid : defaultSingleSelection(approval);
    });
    setSelection((current) => {
      const next: ApprovalSelection = {};
      for (const question of approvalQuestions(approval)) {
        const valid = (current[question.id] ?? []).filter((id) =>
          question.options.some((option) => option.id === id),
        );
        if (valid.length) next[question.id] = valid;
      }
      return next;
    });
  }, [approval]);

  useEffect(() => {
    if (missingIndex === null) return;
    const frame = window.requestAnimationFrame(() => {
      const node = panelRef.current?.querySelector<HTMLElement>(
        `[data-question-index="${missingIndex}"] input`,
      );
      node?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [missingIndex]);

  const pending = approval.status === 'pending';

  // ---------------------------------------------------------------- resolved
  if (!pending) {
    const statusKey =
      approval.status === 'approved'
        ? 'approval.status.approved'
        : approval.status === 'rejected'
          ? 'approval.status.rejected'
          : 'approval.status.dismissed';
    const tone = approval.status === 'approved' ? 'success' : approval.status === 'rejected' ? 'error' : 'tertiary';
    const pillClass = tone === 'tertiary' ? 'kb-pill' : `kb-pill kb-pill--${tone}`;
    const groups = resolvedAnswerGroups(approval);
    const legacyLabels = approval.resolution?.labels ?? [];
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
        {multiQuestion && groups.length ? (
          <ul className="kb-decision-answers">
            {groups.map((group, index) => (
              <li className="kb-decision-answer" key={group.question.id}>
                <span className="kb-decision-answer__label">
                  {group.question.header?.trim() || `${index + 1} / ${groups.length}`}
                </span>
                <span className="kb-decision-answer__value">
                  {group.labels.length ? group.labels.join('、') : t('approval.noAnswer')}
                </span>
              </li>
            ))}
          </ul>
        ) : legacyLabels.length ? (
          <p className="kb-decision-resolved">
            <strong>{legacyLabels.join('、')}</strong>
            {approval.resolution?.comment ? <span> · {approval.resolution.comment}</span> : null}
          </p>
        ) : null}
        {multiQuestion && approval.resolution?.comment ? (
          <p className="kb-decision-resolved">{approval.resolution.comment}</p>
        ) : null}
      </section>
    );
  }

  // ------------------------------------------------------------ single mode
  const submitSingle = () => {
    if (!singleSelection.length) {
      setValidation(t('approval.selectAtLeastOne'));
      onValidationError?.(t('approval.selectAtLeastOne'));
      return;
    }
    const allReject = approval.options
      .filter((option) => singleSelection.includes(option.id))
      .every(isRejectOption);
    onResolve(
      approval,
      { optionIds: singleSelection },
      comment.trim(),
      allReject ? 'reject' : 'approve',
    );
  };

  if (!multiQuestion) {
    const multiSelectSingle = approval.multiSelect === true;
    const rejectOption = approval.options.find(isRejectOption);
    const toggleSingle = (optionId: string) => {
      setValidation(null);
      setSingleSelection((current) =>
        multiSelectSingle
          ? current.includes(optionId)
            ? current.filter((id) => id !== optionId)
            : [...current, optionId]
          : [optionId],
      );
    };
    return (
      <section className="kb-decision" aria-label={t('approval.heading')} ref={panelRef}>
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
          <legend className="kb-sr-only">{t('approval.option')}</legend>
          {multiSelectSingle ? <p className="kb-decision-multi-hint">{t('approval.multiHint')}</p> : null}
          {approval.options.map((option) => {
            const checked = singleSelection.includes(option.id);
            return (
              <label key={option.id} className={`kb-decision-option${checked ? ' kb-decision-option--selected' : ''}`}>
                <input
                  type={multiSelectSingle ? 'checkbox' : 'radio'}
                  name={multiSelectSingle ? `${groupId}-${option.id}` : groupId}
                  value={option.id}
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggleSingle(option.id)}
                />
                <span className="kb-decision-option__label">{option.label}</span>
                {option.description ? (
                  <span className="kb-decision-option__desc">{option.description}</span>
                ) : null}
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
          <button
            type="button"
            className="kb-btn kb-btn--outline kb-btn--sm"
            disabled={busy || !rejectOption}
            title={rejectOption ? undefined : t('approval.noRejectOption')}
            onClick={() => {
              if (rejectOption) onResolve(approval, { optionIds: [rejectOption.id] }, comment.trim(), 'reject');
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
            disabled={busy || !singleSelection.length}
            onClick={submitSingle}
          >
            <span className="kb-icon" aria-hidden="true">
              <IconCheck />
            </span>
            {busy
              ? t('approval.resolving')
              : multiSelectSingle
                ? t('approval.submit')
                : t('approval.approve')}
          </button>
        </div>
      </section>
    );
  }

  // ------------------------------------------------- multi-question mode
  const toggleQuestionOption = (questionId: string, optionId: string, multiSelect: boolean) => {
    setValidation(null);
    setMissingIndex(null);
    setSelection((current) => {
      const existing = current[questionId] ?? [];
      if (!multiSelect) return { ...current, [questionId]: [optionId] };
      return {
        ...current,
        [questionId]: existing.includes(optionId)
          ? existing.filter((id) => id !== optionId)
          : [...existing, optionId],
      };
    });
  };

  const submitMulti = () => {
    const result = validateApprovalSelection(approval, selection);
    if (!result.ok) {
      const index = result.missingIndex ?? 0;
      setMissingIndex(index);
      const message = t('approval.missingQuestion', { index: index + 1 });
      setValidation(message);
      onValidationError?.(message);
      return;
    }
    const answers = buildApprovalAnswers(approval, selection);
    const flattened = flattenAnswers(answers);
    const decision: ApprovalDecision = allAnswersAreReject(approval, answers) ? 'reject' : 'approve';
    onResolve(approval, { optionIds: flattened.optionIds, answers }, comment.trim(), decision);
  };

  return (
    <section
      className={`kb-decision kb-decision--multi${inDrawer ? ' kb-decision--in-drawer' : ''}`}
      aria-label={t('approval.heading')}
      ref={panelRef}
    >
      <div className="kb-decision-q">
        <span className="kb-icon" aria-hidden="true">
          <IconAlert />
        </span>
        <span className="kb-decision-q__title">{approval.title}</span>
        <span className="kb-pill kb-pill--warn">{t('approval.questionCount', { count: questions.length })}</span>
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

      <div className="kb-decision-questions">
        {questions.map((question, index) => {
          const isMissing = missingIndex === index;
          return (
            <fieldset
              className={`kb-decision-question${isMissing ? ' kb-decision-question--missing' : ''}`}
              key={question.id}
              data-question-index={index}
              aria-label={`${question.header ?? ''} ${question.question}`.trim()}
            >
              <legend className="kb-sr-only">{question.question}</legend>
              <div className="kb-decision-question__head">
                {question.header ? <span className="kb-decision-question__header">{question.header}</span> : null}
                <span className="kb-decision-question__index">
                  {index + 1} / {questions.length}
                </span>
                <span className="kb-decision-question__title">{question.question}</span>
                <span className={`kb-pill${question.multiSelect ? ' kb-pill--business' : ''}`}>
                  {question.multiSelect ? t('approval.multipleChoice') : t('approval.singleChoice')}
                </span>
              </div>
              <div className="kb-decision-options">
                {question.options.map((option) => {
                  const checked = (selection[question.id] ?? []).includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className={`kb-decision-option${checked ? ' kb-decision-option--selected' : ''}`}
                    >
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`${groupId}-${question.id}`}
                        value={option.id}
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggleQuestionOption(question.id, option.id, question.multiSelect === true)}
                      />
                      <span className="kb-decision-option__label">{option.label}</span>
                      {option.description ? (
                        <span className="kb-decision-option__desc">{option.description}</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              {question.multiSelect ? (
                <p className="kb-decision-question__hint">{t('approval.multiAtLeastOne')}</p>
              ) : null}
            </fieldset>
          );
        })}
      </div>

      <label className="kb-decision-note-wrap">
        <span className="kb-sr-only">{t('approval.comment')}</span>
        <textarea
          className="kb-textarea kb-decision-note"
          placeholder={t('approval.unifiedNotePlaceholder')}
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
        <button type="button" className="kb-btn kb-btn--primary kb-btn--sm" disabled={busy} onClick={submitMulti}>
          <span className="kb-icon" aria-hidden="true">
            <IconCheck />
          </span>
          {busy ? t('approval.resolving') : t('approval.submitAll')}
        </button>
      </div>
    </section>
  );
}
