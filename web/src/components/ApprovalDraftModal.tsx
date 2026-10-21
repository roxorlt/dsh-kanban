import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Card } from '../types';
import { useI18n } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal } from './Modal';

export interface ApprovalDraftValues {
  title: string;
  detail: string;
  continueLabel: string;
  stopLabel: string;
}

interface ApprovalDraftModalProps {
  card: Card;
  busy: boolean;
  error: string | null;
  onSubmit: (values: ApprovalDraftValues) => void;
  /** 取消：卡片回滚到拖入前的列 */
  onCancel: () => void;
}

/** 拖入「待你确认」但没有 pending approval 时，生成通用审批（标题/详情/选项文案可编辑）。 */
export function ApprovalDraftModal({ card, busy, error, onSubmit, onCancel }: ApprovalDraftModalProps) {
  const { t } = useI18n();
  const initial = {
    title: t('approvalDraft.defaultTitle', { title: card.title }),
    detail: t('approvalDraft.defaultDetail'),
    continueLabel: t('approvalDraft.defaultContinue'),
    stopLabel: t('approvalDraft.defaultStop'),
  };
  const [values, setValues] = useState(initial);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const dirty = (Object.keys(initial) as (keyof ApprovalDraftValues)[]).some(
    (key) => values[key] !== initial[key],
  );

  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onCancel();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!values.title.trim()) {
      setTitleError(t('approvalDraft.required'));
      return;
    }
    setTitleError(null);
    onSubmit({
      title: values.title.trim(),
      detail: values.detail.trim(),
      continueLabel: values.continueLabel.trim() || initial.continueLabel,
      stopLabel: values.stopLabel.trim() || initial.stopLabel,
    });
  };

  return (
    <>
      <Modal
        title={t('approvalDraft.title')}
        onClose={onCancel}
        onRequestClose={requestClose}
        initialFocus="#kb-approval-title"
        footer={
          <>
            <button type="button" className="kb-btn kb-btn--ghost" disabled={busy} onClick={onCancel}>
              {t('modal.cancel')}
            </button>
            <button type="submit" form="kb-approval-form" className="kb-btn kb-btn--primary" disabled={busy}>
              {busy ? t('modal.saving') : t('approvalDraft.create')}
            </button>
          </>
        }
      >
        <form id="kb-approval-form" className="kb-form" onSubmit={handleSubmit}>
          <p className="kb-form__note">{t('approvalDraft.hint')}</p>
          <label className="kb-field">
            <span className="kb-field__label">{t('approvalDraft.fieldTitle')}</span>
            <input
              id="kb-approval-title"
              className="kb-input"
              value={values.title}
              maxLength={160}
              aria-invalid={titleError ? true : undefined}
              onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
            />
            {titleError ? (
              <span className="kb-field__hint" role="alert">
                {titleError}
              </span>
            ) : null}
          </label>
          <label className="kb-field">
            <span className="kb-field__label">{t('approvalDraft.fieldDetail')}</span>
            <textarea
              className="kb-textarea"
              value={values.detail}
              maxLength={1200}
              rows={3}
              onChange={(event) => setValues((current) => ({ ...current, detail: event.target.value }))}
            />
          </label>
          <div className="kb-form__row">
            <label className="kb-field">
              <span className="kb-field__label">{t('approvalDraft.fieldContinue')}</span>
              <input
                className="kb-input"
                value={values.continueLabel}
                maxLength={80}
                onChange={(event) => setValues((current) => ({ ...current, continueLabel: event.target.value }))}
              />
            </label>
            <label className="kb-field">
              <span className="kb-field__label">{t('approvalDraft.fieldStop')}</span>
              <input
                className="kb-input"
                value={values.stopLabel}
                maxLength={80}
                onChange={(event) => setValues((current) => ({ ...current, stopLabel: event.target.value }))}
              />
            </label>
          </div>
          {error ? (
            <p className="kb-form__error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </Modal>

      {discardOpen ? (
        <ConfirmDialog
          title={t('common.discardTitle')}
          message={t('common.discardBody')}
          confirmLabel={t('common.discardConfirm')}
          onConfirm={() => {
            setDiscardOpen(false);
            onCancel();
          }}
          onClose={() => setDiscardOpen(false)}
        />
      ) : null}
    </>
  );
}
