import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Approval, ApprovalAnswer, ApprovalOption } from '../types';
import { useI18n } from '../i18n';
import { formatRelative } from '../lib/time';
import {
  APPROVAL_CUSTOM_MAX,
  APPROVAL_CUSTOM_OPTION_ID,
  allAnswersAreReject,
  approvalQuestions,
  buildApprovalAnswers,
  createApprovalDraft,
  emptyApprovalDraftValue,
  flattenAnswers,
  isCustomPicked,
  isDraftValueAnswered,
  isMultiQuestionApproval,
  isRejectOption,
  resolvedAnswerGroups,
  toggleApprovalDraftOption,
  updateApprovalDraftCustom,
  validateApprovalDraft,
} from '../lib/approvalQuestions';
import type { ApprovalDraft, ApprovalDraftIssue } from '../lib/approvalQuestions';
import { supportsApprovalCustomAnswers } from '../lib/serverCapabilities';
import { useServerVersion } from '../lib/useServerVersion';
import { DecisionOption } from './DecisionOption';
import { IconAlert, IconCheck, IconClose, IconInfo, IconPlus } from './Icons';

export type ApprovalDecision = 'approve' | 'reject';

export interface ApprovalSubmission {
  /** 拍平后的 option id（单题/多题都填） */
  optionIds: string[];
  /** v0.3 多问题逐题答案（v0.4 起每题可带 custom） */
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

/** 多题草稿合并：刷新后保留仍合法的选择（题目被服务端替换时按新题裁剪）。 */
function mergeDraft(approval: Approval, current: ApprovalDraft): ApprovalDraft {
  const next: ApprovalDraft = {};
  for (const question of approvalQuestions(approval)) {
    const previous = current[question.id];
    if (!previous) continue;
    const isValidId = (id: string) =>
      id === APPROVAL_CUSTOM_OPTION_ID || question.options.some((option) => option.id === id);
    const optionIds = question.multiSelect
      ? previous.optionIds.filter(isValidId)
      : previous.optionIds.filter(isValidId).slice(0, 1);
    next[question.id] = { optionIds, custom: previous.custom };
  }
  return next;
}

/**
 * 审批区：
 * - 单题（v0.2 兼容）：radio/checkbox + 驳回/批准；
 * - 多题（v0.3 questions[]）：一次一题翻页作答（上一题 / 下一题 + 题号进度点），
 *   每题末尾固定「其他（自行填写）」选项——选中后展开并自动聚焦输入框，自定义文本计入作答；
 *   统一备注默认收起（点「添加备注」展开）；提交时逐题校验（缺题跳到该题 / 自定义为空高亮并聚焦）。
 * resolved 态逐题展示所选 labels 与自定义回答（兼容旧 resolution.optionIds/labels）。
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
  // 服务端版本错配兜底：旧宿主（<0.9.5）不认识「其他（自行填写）」的 custom 答案，
  // 会把空 optionIds 当成「没选」直接 400；拿到明确旧版本时先禁用自定义项并给出可执行提示。
  const serverVersion = useServerVersion();
  const customAnswersSupported = supportsApprovalCustomAnswers(serverVersion);

  // —— 单题状态 ——
  const [singleSelection, setSingleSelection] = useState<string[]>(() => defaultSingleSelection(approval));
  // —— 多题状态（按 question.id 存草稿 + 当前页） ——
  const [drafts, setDrafts] = useState<ApprovalDraft>(() => createApprovalDraft(approval));
  const [page, setPage] = useState(0);
  const [comment, setComment] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [issue, setIssue] = useState<ApprovalDraftIssue | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const customRef = useRef<HTMLTextAreaElement | null>(null);
  const pageFocusRef = useRef(false);

  useEffect(() => {
    setSingleSelection((current) => {
      const valid = current.filter((id) => approval.options.some((option) => option.id === id));
      return valid.length ? valid : defaultSingleSelection(approval);
    });
    setDrafts((current) => mergeDraft(approval, current));
    setPage((current) => Math.min(current, Math.max(0, approvalQuestions(approval).length - 1)));
  }, [approval]);

  const currentQuestion = questions[page];
  const currentDraft = currentQuestion
    ? drafts[currentQuestion.id] ?? emptyApprovalDraftValue()
    : emptyApprovalDraftValue();
  const customPicked = isCustomPicked(currentDraft);

  // 选中「其他（自行填写）」后把焦点交给输入框（默认激活）
  useEffect(() => {
    if (!multiQuestion || !customPicked) return;
    const frame = window.requestAnimationFrame(() => customRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [customPicked, page, multiQuestion]);

  // 翻页后把焦点交给新题的选项（首次渲染不抢焦点）
  useEffect(() => {
    if (!multiQuestion || !pageFocusRef.current) return;
    pageFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const fieldset = panelRef.current?.querySelector<HTMLElement>(`[data-question-index="${page}"]`);
      fieldset?.querySelector<HTMLInputElement>('input')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [page, multiQuestion]);

  // 提交校验失败：聚焦缺题 / 自定义输入
  useEffect(() => {
    if (!multiQuestion || !issue) return;
    const frame = window.requestAnimationFrame(() => {
      if (issue.kind === 'custom-empty') {
        customRef.current?.focus();
        return;
      }
      const fieldset = panelRef.current?.querySelector<HTMLElement>(`[data-question-index="${issue.index}"]`);
      fieldset?.querySelector<HTMLInputElement>('input')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [issue, multiQuestion]);

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
            {groups.map((group, index) => {
              const labels = group.labels.join('、');
              const value = [
                labels,
                group.custom ? t('approval.customAnswer', { text: group.custom }) : '',
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li className="kb-decision-answer" key={group.question.id}>
                  <span className="kb-decision-answer__label">
                    {group.question.header?.trim() || `${index + 1} / ${groups.length}`}
                  </span>
                  <span className="kb-decision-answer__value">
                    {value || t('approval.noAnswer')}
                  </span>
                </li>
              );
            })}
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
      <section
        className={`kb-decision${inDrawer ? ' kb-decision--in-drawer' : ''}`}
        aria-label={t('approval.heading')}
        ref={panelRef}
      >
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
              <DecisionOption
                key={option.id}
                option={option}
                type={multiSelectSingle ? 'checkbox' : 'radio'}
                name={multiSelectSingle ? `${groupId}-${option.id}` : groupId}
                checked={checked}
                disabled={busy}
                onChange={() => toggleSingle(option.id)}
              />
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
  const total = questions.length;
  const goToPage = (index: number) => {
    if (index < 0 || index >= total || index === page) return;
    pageFocusRef.current = true;
    setPage(index);
    setValidation(null);
    setIssue(null);
  };

  const toggleQuestionOption = (questionId: string, optionId: string, multiSelect: boolean) => {
    setValidation(null);
    setIssue(null);
    setDrafts((current) => ({
      ...current,
      [questionId]: toggleApprovalDraftOption(
        current[questionId] ?? emptyApprovalDraftValue(),
        optionId,
        multiSelect,
      ),
    }));
  };

  const submitMulti = () => {
    // 旧服务端不读 custom：只要有任何一题是「仅自定义、没选选项」，就会报
    // 「第 <questionId> 题至少需要选择 1 个选项」；这里提前拦下并给出可执行说明。
    if (
      !customAnswersSupported &&
      Object.values(drafts).some((value) => isCustomPicked(value))
    ) {
      const message = t('approval.customUnsupported', { version: serverVersion ?? '' }).trim();
      setValidation(message);
      onValidationError?.(message);
      return;
    }
    const result = validateApprovalDraft(approval, drafts);
    if (!result.ok) {
      const { index, kind } = result.issue;
      const message =
        kind === 'custom-empty'
          ? t('approval.customEmpty', { index: index + 1 })
          : t('approval.missingQuestion', { index: index + 1 });
      setPage(index);
      setIssue(result.issue);
      setValidation(message);
      onValidationError?.(message);
      return;
    }
    const answers = buildApprovalAnswers(approval, drafts);
    const flattened = flattenAnswers(answers);
    const decision: ApprovalDecision = allAnswersAreReject(approval, answers) ? 'reject' : 'approve';
    onResolve(approval, { optionIds: flattened.optionIds, answers }, comment.trim(), decision);
  };

  const customOption: ApprovalOption = {
    id: APPROVAL_CUSTOM_OPTION_ID,
    label: t('approval.otherOption'),
    description: customAnswersSupported
      ? t('approval.otherOptionDesc')
      : t('approval.customUnsupportedDesc'),
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
        <span className="kb-pill kb-pill--warn">
          {total > 1
            ? t('approval.pageOf', { index: page + 1, total })
            : t('approval.questionCount', { count: total })}
        </span>
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
        {currentQuestion ? (
          <fieldset
            className={`kb-decision-question${issue?.index === page ? ' kb-decision-question--missing' : ''}`}
            data-question-index={page}
            aria-label={`${currentQuestion.header ?? ''} ${currentQuestion.question}`.trim()}
          >
            <legend className="kb-sr-only">{currentQuestion.question}</legend>
            <div className="kb-decision-question__head">
              {currentQuestion.header ? (
                <span className="kb-decision-question__header">{currentQuestion.header}</span>
              ) : null}
              <span className="kb-decision-question__title">{currentQuestion.question}</span>
              <span className={`kb-pill${currentQuestion.multiSelect ? ' kb-pill--business' : ''}`}>
                {currentQuestion.multiSelect ? t('approval.multipleChoice') : t('approval.singleChoice')}
              </span>
            </div>
            <div className="kb-decision-options">
              {currentQuestion.options.map((option) => (
                <DecisionOption
                  key={option.id}
                  option={option}
                  type={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  name={`${groupId}-${currentQuestion.id}`}
                  checked={currentDraft.optionIds.includes(option.id)}
                  disabled={busy}
                  onChange={() =>
                    toggleQuestionOption(currentQuestion.id, option.id, currentQuestion.multiSelect === true)
                  }
                />
              ))}
              <div className="kb-decision-custom-option">
                <DecisionOption
                  key={APPROVAL_CUSTOM_OPTION_ID}
                  option={customOption}
                  type={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  name={`${groupId}-${currentQuestion.id}`}
                  checked={customPicked}
                  disabled={busy || !customAnswersSupported}
                  onChange={() => {
                    if (!customAnswersSupported) return;
                    toggleQuestionOption(
                      currentQuestion.id,
                      APPROVAL_CUSTOM_OPTION_ID,
                      currentQuestion.multiSelect === true,
                    );
                  }}
                />
              </div>
              {customPicked && customAnswersSupported ? (
                <div className="kb-decision-custom">
                  <label className="kb-sr-only" htmlFor={`${groupId}-custom-${currentQuestion.id}`}>
                    {t('approval.customLabel')}
                  </label>
                  <textarea
                    ref={customRef}
                    id={`${groupId}-custom-${currentQuestion.id}`}
                    className="kb-textarea kb-decision-custom__input"
                    rows={3}
                    maxLength={APPROVAL_CUSTOM_MAX}
                    placeholder={t('approval.customPlaceholder')}
                    value={currentDraft.custom}
                    disabled={busy}
                    aria-invalid={issue?.index === page && issue.kind === 'custom-empty' ? true : undefined}
                    onChange={(event) => {
                      setValidation(null);
                      setIssue(null);
                      const questionId = currentQuestion.id;
                      const custom = event.target.value;
                      setDrafts((current) => ({
                        ...current,
                        [questionId]: updateApprovalDraftCustom(
                          current[questionId] ?? emptyApprovalDraftValue(),
                          custom,
                        ),
                      }));
                    }}
                  />
                  <span className="kb-decision-custom__count" aria-hidden="true">
                    {currentDraft.custom.length} / {APPROVAL_CUSTOM_MAX}
                  </span>
                </div>
              ) : null}
            </div>
            {currentQuestion.multiSelect ? (
              <p className="kb-decision-question__hint">{t('approval.multiAtLeastOne')}</p>
            ) : null}
          </fieldset>
        ) : null}
      </div>

      {total > 1 ? (
        <div className="kb-decision-pager" role="group" aria-label={t('approval.pager')}>
          <button
            type="button"
            className="kb-btn kb-btn--ghost kb-btn--sm kb-decision-pager__btn"
            disabled={busy || page === 0}
            onClick={() => goToPage(page - 1)}
          >
            {t('approval.prevQuestion')}
          </button>
          <div className="kb-decision-pager__dots">
            {questions.map((question, index) => {
              const answered = isDraftValueAnswered(drafts[question.id] ?? emptyApprovalDraftValue());
              return (
                <button
                  key={question.id}
                  type="button"
                  className={`kb-decision-dot${index === page ? ' kb-decision-dot--current' : ''}${
                    answered ? ' kb-decision-dot--answered' : ''
                  }`}
                  aria-label={t(answered ? 'approval.jumpQuestionAnswered' : 'approval.jumpQuestion', {
                    index: index + 1,
                  })}
                  aria-current={index === page ? 'step' : undefined}
                  disabled={busy}
                  onClick={() => goToPage(index)}
                />
              );
            })}
          </div>
          <button
            type="button"
            className="kb-btn kb-btn--ghost kb-btn--sm kb-decision-pager__btn"
            disabled={busy || page === total - 1}
            onClick={() => goToPage(page + 1)}
          >
            {t('approval.nextQuestion')}
          </button>
        </div>
      ) : null}

      {validation ? (
        <p className="kb-decision-validation" role="alert">
          {validation}
        </p>
      ) : null}

      {noteOpen || comment.trim() ? (
        <div className="kb-decision-note-block">
          <label className="kb-decision-note-wrap">
            <span className="kb-decision-note-label">{t('approval.overallNote')}</span>
            <textarea
              className="kb-textarea kb-decision-note"
              placeholder={t('approval.unifiedNotePlaceholder')}
              value={comment}
              rows={2}
              disabled={busy}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          {comment.trim() ? null : (
            <button
              type="button"
              className="kb-link-btn kb-decision-note-toggle"
              disabled={busy}
              onClick={() => setNoteOpen(false)}
            >
              {t('approval.hideNote')}
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="kb-link-btn kb-decision-note-toggle"
          disabled={busy}
          onClick={() => setNoteOpen(true)}
        >
          <span className="kb-icon" aria-hidden="true">
            <IconPlus />
          </span>
          {t('approval.addNote')}
        </button>
      )}

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
