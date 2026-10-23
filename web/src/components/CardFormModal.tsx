import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { Card, ColumnId, Priority, SessionRow, Status, WorkspaceRow } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { COLUMNS, COLUMN_OF_STATUS, STATUS_OF_COLUMN } from '../lib/status';
import {
  pathBasename,
  recommendedSession,
  suggestCwds,
  suggestProjects,
  suggestSessions,
  workspaceDefaults,
} from '../lib/suggestions';
import type { NewCardSessionKind } from '../lib/createCardSession';
import { validateNewCardSession } from '../lib/createCardSession';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal } from './Modal';
import { SuggestionChips } from './SuggestionChips';

export interface CardFormValues {
  title: string;
  summary: string;
  project: string;
  labels: string[];
  priority: Priority;
  status: Status;
  workspaceId: string;
  cwd: string;
  /** 新建卡片时的会话选择（编辑模式忽略） */
  session: { kind: NewCardSessionKind; sessionId?: string };
}

interface CardFormModalProps {
  mode: 'create' | 'edit';
  initial?: Card;
  defaultColumn?: ColumnId;
  projects: string[];
  labels: string[];
  workspaces: WorkspaceRow[];
  sessions: SessionRow[];
  cards: Card[];
  embedded: boolean;
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

/**
 * 新建 / 编辑卡片表单。
 * 新建时主表单含：工作区（自动回填 cwd/project）、执行目录（带可干预建议 chips）、项目建议、会话选择；
 * 进行中卡片必须新建或选择会话（独立预览降级为只建卡）。
 */
export function CardFormModal({
  mode,
  initial,
  defaultColumn = 'backlog',
  projects,
  labels,
  workspaces,
  sessions,
  cards,
  embedded,
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
  const [workspaceId, setWorkspaceId] = useState(initial?.workspaceId ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [sessionKind, setSessionKind] = useState<NewCardSessionKind>(
    mode === 'create' && initialColumn === 'running' ? 'new' : 'none',
  );
  const [sessionId, setSessionId] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  const running = statusOfColumn(column) === 'running';

  const baseline = {
    title: initial?.title ?? '',
    summary: initial?.summary ?? '',
    project: initial?.project ?? '',
    labels: initial?.labels.join(', ') ?? '',
    priority: initial?.priority ?? 'none',
    column: initialColumn,
    workspaceId: initial?.workspaceId ?? '',
    cwd: initial?.cwd ?? '',
    sessionKind: mode === 'create' && initialColumn === 'running' ? 'new' : 'none',
    sessionId: '',
  };
  const dirty =
    title !== baseline.title ||
    summary !== baseline.summary ||
    project !== baseline.project ||
    labelsInput !== baseline.labels ||
    priority !== baseline.priority ||
    column !== baseline.column ||
    workspaceId !== baseline.workspaceId ||
    cwd !== baseline.cwd ||
    sessionKind !== baseline.sessionKind ||
    sessionId !== baseline.sessionId;

  const projectSuggestions = useMemo(
    () =>
      suggestProjects({
        workspaces,
        sessions,
        cards,
        selectedWorkspaceId: workspaceId || null,
      }),
    [cards, sessions, workspaceId, workspaces],
  );
  const cwdSuggestions = useMemo(
    () =>
      suggestCwds({
        workspaces,
        sessions,
        cards,
        selectedWorkspaceId: workspaceId || null,
      }),
    [cards, sessions, workspaceId, workspaces],
  );
  const sessionSuggestions = useMemo(
    () => suggestSessions({ sessions, cwd, workspaceId, project, title }),
    [cwd, project, sessions, title, workspaceId],
  );
  const topSession = recommendedSession(sessionSuggestions);

  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  const handleWorkspaceChange = (nextId: string) => {
    setWorkspaceId(nextId);
    const workspace = workspaces.find((item) => item.workspaceId === nextId);
    const defaults = workspaceDefaults(workspace);
    if (defaults.cwd) setCwd(defaults.cwd);
    if (!project.trim() && defaults.project) setProject(defaults.project);
  };

  const handleColumnChange = (nextColumn: ColumnId) => {
    setColumn(nextColumn);
    setSessionError(null);
    if (statusOfColumn(nextColumn) === 'running') {
      setSessionKind((current) => (current === 'none' ? 'new' : current));
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) {
      setTitleError(t('modal.titleRequired'));
      return;
    }
    setTitleError(null);
    if (mode === 'create') {
      const validation = validateNewCardSession({ running, kind: sessionKind, embedded });
      if (validation === 'running-needs-session') {
        setSessionError(t('modal.sessionNeedChoice'));
        return;
      }
      if (embedded && sessionKind === 'existing' && !sessionId) {
        setSessionError(t('modal.sessionExistingEmpty'));
        return;
      }
    }
    setSessionError(null);
    onSubmit({
      title: title.trim(),
      summary: summary.trim(),
      project: project.trim(),
      labels: parseLabels(labelsInput),
      priority,
      status: statusOfColumn(column),
      workspaceId: workspaceId.trim(),
      cwd: cwd.trim(),
      session: embedded && mode === 'create' ? { kind: sessionKind, ...(sessionId ? { sessionId } : {}) } : { kind: 'none' },
    });
  };

  const orderedSessions = useMemo(() => {
    const seen = new Set<string>();
    const ordered: SessionRow[] = [];
    for (const item of sessionSuggestions) {
      if (seen.has(item.session.id)) continue;
      seen.add(item.session.id);
      ordered.push(item.session);
    }
    for (const session of sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      ordered.push(session);
    }
    return ordered;
  }, [sessionSuggestions, sessions]);

  return (
    <>
      <Modal
        title={mode === 'create' ? t('modal.newCard') : t('modal.editCard')}
        onClose={onClose}
        onRequestClose={requestClose}
        initialFocus="#kb-card-title"
        footer={
          <>
            <button type="button" className="kb-btn kb-btn--ghost" onClick={requestClose} disabled={busy}>
              {t('modal.cancel')}
            </button>
            <button type="submit" form="kb-card-form" className="kb-btn kb-btn--primary" disabled={busy}>
              {busy
                ? t('modal.saving')
                : mode === 'edit'
                  ? t('modal.save')
                  : running
                    ? sessionKind === 'existing'
                      ? t('modal.createAndBind')
                      : t('modal.createAndStart')
                    : t('modal.create')}
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
              <span className="kb-field__label">{t('modal.workspaceLabel')}</span>
              <select
                className="kb-select"
                value={workspaceId}
                onChange={(event) => handleWorkspaceChange(event.target.value)}
              >
                <option value="">{t('modal.workspaceNone')}</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.workspaceId} value={workspace.workspaceId}>
                    {workspace.title}
                    {workspace.path ? ` · ${workspace.path}` : ''}
                  </option>
                ))}
              </select>
              <span className="kb-field__note">{t('modal.workspaceHint')}</span>
            </label>

            <label className="kb-field">
              <span className="kb-field__label">{t('modal.cwdLabel')}</span>
              <input
                className="kb-input"
                value={cwd}
                placeholder={t('modal.cwdPlaceholder')}
                onChange={(event) => setCwd(event.target.value)}
              />
              <SuggestionChips
                id="kb-cwd-suggestions"
                label={t('modal.cwdSuggestions')}
                items={cwdSuggestions}
                value={cwd}
                onPick={(value) => setCwd(value)}
              />
            </label>
          </div>

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
                {projectSuggestions.map((item) => (
                  <option key={item.value} value={item.value} />
                ))}
                {[...new Set(projects.filter((item) => !projectSuggestions.some((entry) => entry.value === item)))].map(
                  (item) => (
                    <option key={item} value={item} />
                  ),
                )}
              </datalist>
              <SuggestionChips
                id="kb-project-suggestions"
                label={t('modal.projectSuggestions')}
                items={projectSuggestions}
                value={project}
                onPick={(value) => setProject(value)}
              />
              <span className="kb-field__note">{t('modal.projectHint')}</span>
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
                onChange={(event) => handleColumnChange(event.target.value as ColumnId)}
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

          {mode === 'create' ? (
            <fieldset className="kb-field kb-field--full kb-session-choice">
              <legend className="kb-field__label">{t('modal.sessionLabel')}</legend>
              {!embedded ? (
                <p className="kb-field__note">{t('modal.sessionStandaloneHint')}</p>
              ) : (
                <>
                  <div className="kb-choice-row">
                    <label className={`kb-choice${sessionKind === 'none' ? ' kb-choice--on' : ''}`}>
                      <input
                        type="radio"
                        name="kb-session-kind"
                        checked={sessionKind === 'none'}
                        disabled={running}
                        onChange={() => {
                          setSessionKind('none');
                          setSessionError(null);
                        }}
                      />
                      <span>{t('modal.sessionNone')}</span>
                    </label>
                    <label className={`kb-choice${sessionKind === 'new' ? ' kb-choice--on' : ''}`}>
                      <input
                        type="radio"
                        name="kb-session-kind"
                        checked={sessionKind === 'new'}
                        onChange={() => {
                          setSessionKind('new');
                          setSessionError(null);
                        }}
                      />
                      <span>{t('modal.sessionNew')}</span>
                    </label>
                    <label className={`kb-choice${sessionKind === 'existing' ? ' kb-choice--on' : ''}`}>
                      <input
                        type="radio"
                        name="kb-session-kind"
                        checked={sessionKind === 'existing'}
                        onChange={() => {
                          setSessionKind('existing');
                          setSessionError(null);
                          if (!sessionId) {
                            const first = topSession?.session.id ?? '';
                            setSessionId(first);
                          }
                        }}
                      />
                      <span>{t('modal.sessionExisting')}</span>
                    </label>
                  </div>
                  {running ? <p className="kb-field__note">{t('modal.sessionRunningHint')}</p> : null}
                  {sessionKind === 'existing' ? (
                    <div className="kb-session-choice__existing">
                      <select
                        className="kb-select"
                        value={sessionId}
                        aria-label={t('modal.sessionExisting')}
                        onChange={(event) => setSessionId(event.target.value)}
                      >
                        <option value="" disabled>
                          {orderedSessions.length ? t('drawer.selectSession') : t('modal.sessionExistingEmpty')}
                        </option>
                        {orderedSessions.map((session) => {
                          const recommended = topSession?.session.id === session.id;
                          const meta = [pathBasename(session.cwd), session.running ? t('modal.sessionRunningTag') : '']
                            .filter(Boolean)
                            .join(' · ');
                          return (
                            <option key={session.id} value={session.id}>
                              {session.title}
                              {meta ? ` · ${meta}` : ''}
                              {recommended ? ` · ${t('modal.recommended')}` : ''}
                            </option>
                          );
                        })}
                      </select>
                      {topSession ? (
                        <span className="kb-field__note">
                          <span className="kb-suggest__badge">{t('modal.recommended')}</span>{' '}
                          {topSession.session.title}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {sessionError ? (
                    <span className="kb-field__hint" role="alert">
                      {sessionError}
                    </span>
                  ) : null}
                </>
              )}
            </fieldset>
          ) : null}

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
          busyLabel={t('common.discardConfirm')}
          onConfirm={() => {
            setDiscardOpen(false);
            onClose();
          }}
          onClose={() => setDiscardOpen(false)}
        />
      ) : null}
    </>
  );
}

function statusOfColumn(column: ColumnId): Status {
  return STATUS_OF_COLUMN[column];
}
