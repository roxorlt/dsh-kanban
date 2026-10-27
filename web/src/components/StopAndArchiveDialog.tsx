import type { SessionActivityEntry } from '../types';
import { useI18n } from '../i18n';
import { summarizeSessionActivity } from '../lib/sessionArchive';
import { IconAlert } from './Icons';
import { Modal } from './Modal';

interface StopAndArchiveDialogProps {
  /** 会话标题（宿主可能没有标题，调用方回退到会话 id） */
  sessionTitle: string;
  /** SESSION_ACTIVE 返回的将被停止的工作清单 */
  activity: readonly SessionActivityEntry[];
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 「停止并归档」二次确认（对齐 DSH 原生文案，docs/11 §6.2）。
 * 必须写明 stopActivity 的副作用：丢弃排队输入、删除定时任务、被停止的工作不会自动继续。
 */
export function StopAndArchiveDialog({
  sessionTitle,
  activity,
  busy,
  onConfirm,
  onClose,
}: StopAndArchiveDialogProps) {
  const { t } = useI18n();
  const groups = summarizeSessionActivity(activity);

  const activityLabel = (group: (typeof groups)[number]): string => {
    switch (group.kind) {
      case 'job':
        return t('sessionArchive.activityJob', { count: group.count });
      case 'subagent':
        return t('sessionArchive.activitySubagent', { count: group.count });
      case 'schedule':
        return t('sessionArchive.activitySchedule', { count: group.count });
      default:
        return t('sessionArchive.activityTurn');
    }
  };

  return (
    <Modal
      title={t('sessionArchive.stopTitle')}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="kb-btn kb-btn--ghost" onClick={onClose} disabled={busy}>
            {t('modal.cancel')}
          </button>
          <button type="button" className="kb-btn kb-btn--primary" onClick={onConfirm} disabled={busy}>
            {busy ? t('sessionArchive.stopping') : t('sessionArchive.stopConfirm')}
          </button>
        </>
      }
    >
      <p className="kb-confirm__message">{t('sessionArchive.stopBody', { title: sessionTitle })}</p>

      {groups.length ? (
        <div className="kb-archive-activity">
          <p className="kb-archive-activity__title">{t('sessionArchive.stopWork')}</p>
          <ul className="kb-archive-activity__list">
            {groups.map((group, index) => (
              <li key={`${group.kind}-${index}`} className="kb-archive-activity__item">
                <span className="kb-archive-activity__kind">{activityLabel(group)}</span>
                {group.labels.length ? (
                  <span className="kb-archive-activity__names">{group.labels.join(' / ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="kb-archive-note">
        <span className="kb-icon" aria-hidden="true">
          <IconAlert />
        </span>
        <span>{t('sessionArchive.stopSideEffect')}</span>
      </p>
    </Modal>
  );
}
