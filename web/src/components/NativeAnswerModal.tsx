/**
 * 看板内作答原生请求的弹窗：
 * - Agent 提问：逐题单选/多选 + 自定义文本 + 跳过，提交整批 answers；
 * - 计划审批：展示计划正文，「同意执行」提交 approve 选项，「要求修改」走宿主 dismiss。
 */
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import type { NativeInboxEntry, NativeQuestionAnswer } from '../lib/nativeInbox';
import { buildQuestionAnswers, draftComplete, formatCountdown } from '../lib/nativeInbox';
import { IconAlert, IconClock, IconEdit } from './Icons';
import { Modal } from './Modal';

interface Draft {
  selected: string[];
  custom: string;
  skipped: boolean;
}

export interface NativeAnswerModalProps {
  entry: NativeInboxEntry;
  busy: boolean;
  onClose: () => void;
  onSubmit: (answers: NativeQuestionAnswer[]) => void;
  /** 计划审批「要求修改」；普通提问为 null */
  onDismiss: (() => void) | null;
}

export function NativeAnswerModal({ entry, busy, onClose, onSubmit, onDismiss }: NativeAnswerModalProps) {
  const { t } = useI18n();
  const questions = useMemo(() => entry.questions ?? [], [entry.questions]);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    questions.map(() => ({ selected: [], custom: '', skipped: false })),
  );
  const [error, setError] = useState<string | null>(null);

  const plan = entry.planReview;

  if (plan) {
    return (
      <Modal
        title={t('native.planTitle')}
        size="md"
        onClose={onClose}
        footer={
          <>
            {onDismiss ? (
              <button type="button" className="kb-btn kb-btn--outline" disabled={busy} onClick={onDismiss}>
                {t('native.planDiscuss')}
              </button>
            ) : null}
            <button
              type="button"
              className="kb-btn kb-btn--primary"
              disabled={busy}
              onClick={() => onSubmit([{ id: plan.id, selected: [plan.approve.label] }])}
            >
              {busy ? t('native.submitting') : t('native.planApprove')}
            </button>
          </>
        }
      >
        <div className="kb-plan">
          <div className="kb-plan__strip">
            <span className="kb-icon" aria-hidden="true">
              <IconEdit />
            </span>
            {t('native.planStrip')}
          </div>
          <p className="kb-plan__question">{plan.question}</p>
          <pre className="kb-plan__body" aria-label={t('native.planAria')}>
            {plan.plan}
          </pre>
          {entry.state === 'continued' ? <p className="kb-plan__hint">{t('native.continued')}</p> : null}
        </div>
      </Modal>
    );
  }

  const channel = entry.channel ?? 'none';
  const canSubmit = !busy && channel !== 'none';

  const updateDraft = (index: number, update: (draft: Draft) => Draft) => {
    setDrafts((current) => current.map((draft, itemIndex) => (itemIndex === index ? update(draft) : draft)));
    setError(null);
  };

  const choose = (index: number, label: string, multiSelect: boolean) => {
    updateDraft(index, (draft) => {
      if (draft.skipped) return draft;
      if (multiSelect) {
        const selected = draft.selected.includes(label)
          ? draft.selected.filter((item) => item !== label)
          : [...draft.selected, label];
        return { ...draft, selected };
      }
      return { ...draft, selected: [label], custom: '' };
    });
  };

  const toggleSkip = (index: number) => {
    updateDraft(index, (draft) =>
      draft.skipped
        ? { selected: [], custom: '', skipped: false }
        : { selected: [], custom: '', skipped: true },
    );
  };

  const submit = () => {
    const missing = drafts.findIndex((draft) => !draftComplete(draft));
    if (missing >= 0) {
      setError(t('native.incomplete'));
      const node = document.querySelector<HTMLElement>(`[data-question-index="${missing}"] input, [data-question-index="${missing}"] textarea`);
      node?.focus();
      return;
    }
    setError(null);
    onSubmit(buildQuestionAnswers(questions, drafts));
  };

  return (
    <Modal
      title={
        questions.length > 1
          ? t('native.answerTitleCount', { count: questions.length })
          : t('native.answerTitle')
      }
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="kb-btn kb-btn--ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="kb-btn kb-btn--primary" disabled={!canSubmit} onClick={submit}>
            {busy ? t('native.submitting') : t('native.submitAnswers')}
          </button>
        </>
      }
    >
      <div className="kb-question-form">
        <p className="kb-question-form__source">
          {t('native.session', { session: entry.sessionLabel })}
          {entry.countdownMs !== undefined && entry.countdownRunning ? (
            <span className="kb-inbox-countdown">
              <span className="kb-icon" aria-hidden="true">
                <IconClock />
              </span>
              {formatCountdown(entry.countdownMs)}
            </span>
          ) : null}
        </p>
        {entry.state === 'continued' ? (
          <p className="kb-question-form__hint">{t('native.continued')}</p>
        ) : null}
        {channel === 'none' ? (
          <p className="kb-question-form__hint kb-question-form__hint--warn">
            <span className="kb-icon" aria-hidden="true">
              <IconAlert />
            </span>
            {t('native.channelNotReady')}
          </p>
        ) : null}

        {questions.map((question, index) => {
          const draft = drafts[index] ?? { selected: [], custom: '', skipped: false };
          const options = question.options ?? [];
          return (
            <fieldset
              key={question.id}
              className={`kb-question${draft.skipped ? ' kb-question--skipped' : ''}`}
              data-question-index={index}
            >
              <legend className="kb-question__legend">
                <span className="kb-question__index">{t('native.questionIndex', { index: index + 1 })}</span>
                <span className="kb-question__text">
                  {question.header ? <span className="kb-question__header">{question.header}</span> : null}
                  {question.question}
                </span>
                {question.multiSelect ? <span className="kb-pill">{t('native.multiSelect')}</span> : null}
                {draft.skipped ? <span className="kb-pill kb-pill--warn">{t('native.skipOn')}</span> : null}
              </legend>

              {options.length ? (
                <div className="kb-question__options">
                  {options.map((option) => {
                    const checked = draft.selected.includes(option.label);
                    return (
                      <label
                        key={option.label}
                        className={`kb-question__option${checked ? ' kb-question__option--selected' : ''}`}
                      >
                        <input
                          type={question.multiSelect ? 'checkbox' : 'radio'}
                          name={`native-question-${index}`}
                          checked={checked}
                          disabled={busy || draft.skipped}
                          onChange={() => choose(index, option.label, question.multiSelect === true)}
                        />
                        <span className="kb-question__option-body">
                          <span className="kb-question__option-label">{option.label}</span>
                          {option.description ? (
                            <span className="kb-question__option-desc">{option.description}</span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : null}

              <textarea
                className="kb-question__custom"
                rows={2}
                placeholder={t('native.customPlaceholder')}
                value={draft.custom}
                disabled={busy || draft.skipped}
                onChange={(event) =>
                  updateDraft(index, (current) => ({
                    ...current,
                    custom: event.target.value,
                    selected: question.multiSelect === true ? current.selected : [],
                  }))
                }
              />
              <button
                type="button"
                className={`kb-btn kb-btn--sm ${draft.skipped ? 'kb-btn--outline' : 'kb-btn--ghost'}`}
                disabled={busy}
                onClick={() => toggleSkip(index)}
              >
                {draft.skipped ? t('native.unskip') : t('native.skip')}
              </button>
            </fieldset>
          );
        })}

        {error ? (
          <p className="kb-question-form__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
