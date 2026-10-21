import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Card, ColumnId, Priority, Status } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { COLUMNS, COLUMN_OF_STATUS, STATUS_OF_COLUMN } from '../lib/status';
import { Modal } from './Modal';

export interface CardFormValues {
  title: string;
  summary: string;
  project: string;
  labels: string[];
  priority: Priority;
  status: Status;
}

interface CardFormModalProps {
  mode: 'create' | 'edit';
  initial?: Card;
  defaultColumn?: ColumnId;
  projects: string[];
  labels: string[];
  busy: boolean;
  error: string | null;
  onSubmit: (values: CardFormValues) => void;
  onClose: () => void;
}

const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];

function parseLabels(input: string): string[] {
  return input
    .split(/[,，、]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** 新建 / 编辑卡片表单（标题必填；摘要/项目/标签/优先级/列可选）。 */
export function CardFormModal({
  mode,
  initial,
  defaultColumn = 'backlog',
  projects,
  labels,
  busy,
  error,
  onSubmit,
  onClose,
}: CardFormModalProps) {
  const { t } = useI18n();
  const initialColumn: ColumnId = initial ? COLUMN_OF_STATUS[initial.status] : defaultColumn;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [project, setProject] = useState(initial?.project ?? '');
  const [labelsInput, setLabelsInput] = useState(initial?.labels.join(', ') ?? '');
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 'none');
  const [column, setColumn] = useState<ColumnId>(initialColumn);
  const [titleError, setTitleError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) {
      setTitleError(t('modal.titleRequired'));
      return;
    }
    setTitleError(null);
    onSubmit({
      title: title.trim(),
      summary: summary.trim(),
      project: project.trim(),
      labels: parseLabels(labelsInput),
      priority,
      status: STATUS_OF_COLUMN[column],
    });
  };

  return (
    <Modal
      title={mode === 'create' ? t('modal.newCard') : t('modal.editCard')}
      onClose={onClose}
      initialFocus="#kb-card-title"
      footer={
        <>
          <button type="button" className="kb-btn kb-btn--ghost" onClick={onClose} disabled={busy}>
            {t('modal.cancel')}
          </button>
          <button type="submit" form="kb-card-form" className="kb-btn kb-btn--primary" disabled={busy}>
            {busy ? t('modal.saving') : mode === 'create' ? t('modal.create') : t('modal.save')}
          </button>
        </>
      }
    >
      <form id="kb-card-form" className="kb-form" onSubmit={handleSubmit}>
        <label className="kb-field">
          <span className="kb-field__label">{t('modal.titleLabel')}</span>
          <input
            id="kb-card-title"
            className="kb-input"
            value={title}
            maxLength={120}
            placeholder={t('modal.titlePlaceholder')}
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? 'kb-card-title-error' : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {titleError ? (
            <span className="kb-field__hint" id="kb-card-title-error" role="alert">
              {titleError}
            </span>
          ) : null}
        </label>

        <label className="kb-field">
          <span className="kb-field__label">{t('modal.summaryLabel')}</span>
          <textarea
            className="kb-textarea"
            value={summary}
            maxLength={240}
            rows={3}
            placeholder={t('modal.summaryPlaceholder')}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>

        <div className="kb-form__row">
          <label className="kb-field">
            <span className="kb-field__label">{t('modal.projectLabel')}</span>
            <input
              className="kb-input"
              value={project}
              maxLength={80}
              list="kb-project-options"
              placeholder={t('modal.projectPlaceholder')}
              onChange={(event) => setProject(event.target.value)}
            />
            <datalist id="kb-project-options">
              {projects.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
          <label className="kb-field">
            <span className="kb-field__label">{t('modal.priorityLabel')}</span>
            <select
              className="kb-select"
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
            >
              {PRIORITIES.map((item) => (
                <option key={item} value={item}>
                  {t(`priority.${item}` as I18nKey)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="kb-form__row">
          <label className="kb-field">
            <span className="kb-field__label">{t('modal.columnLabel')}</span>
            <select
              className="kb-select"
              value={column}
              onChange={(event) => setColumn(event.target.value as ColumnId)}
            >
              {COLUMNS.map((item) => (
                <option key={item} value={item}>
                  {t(`column.${item}` as I18nKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="kb-field">
            <span className="kb-field__label">{t('modal.labelsLabel')}</span>
            <input
              className="kb-input"
              value={labelsInput}
              list="kb-label-options"
              placeholder={t('modal.labelsPlaceholder')}
              onChange={(event) => setLabelsInput(event.target.value)}
            />
            <datalist id="kb-label-options">
              {labels.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
        </div>

        {error ? (
          <p className="kb-form__error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
