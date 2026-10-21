import { useI18n } from '../i18n';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** 危险操作二次确认（归档等）。 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel,
  busy = false,
  danger = true,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="kb-btn kb-btn--ghost" onClick={onClose} disabled={busy}>
            {t('modal.cancel')}
          </button>
          <button
            type="button"
            className={`kb-btn ${danger ? 'kb-btn--primary' : 'kb-btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyLabel ?? t('modal.saving')) : confirmLabel}
          </button>
        </>
      }
    >
      <p className="kb-confirm__message">{message}</p>
    </Modal>
  );
}
