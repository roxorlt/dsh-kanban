import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { Modal } from './Modal';

interface HelpDialogProps {
  onClose: () => void;
}

const SHORTCUTS: { keys: string[]; labelKey: I18nKey }[] = [
  { keys: ['N'], labelKey: 'shortcut.new' },
  { keys: ['B'], labelKey: 'shortcut.board' },
  { keys: ['L'], labelKey: 'shortcut.list' },
  { keys: ['⌘', 'K'], labelKey: 'shortcut.search' },
  { keys: ['Esc'], labelKey: 'shortcut.close' },
  { keys: ['?'], labelKey: 'shortcut.help' },
  { keys: ['T'], labelKey: 'shortcut.theme' },
  { keys: ['Enter', 'Space'], labelKey: 'shortcut.expand' },
  { keys: ['O'], labelKey: 'shortcut.open' },
];

/** 键盘快捷键帮助（`?` 打开，Esc 关闭）。 */
export function HelpDialog({ onClose }: HelpDialogProps) {
  const { t } = useI18n();
  return (
    <Modal title={t('help.title')} onClose={onClose} size="sm">
      <p className="kb-help__hint">{t('help.hint')}</p>
      <ul className="kb-help__list">
        {SHORTCUTS.map((shortcut) => (
          <li className="kb-help__row" key={shortcut.labelKey}>
            <span className="kb-help__keys">
              {shortcut.keys.map((key) => (
                <span className="kb-kbd" key={key}>
                  {key}
                </span>
              ))}
            </span>
            <span className="kb-help__label">{t(shortcut.labelKey)}</span>
          </li>
        ))}
      </ul>
      <p className="kb-help__hint kb-help__archive">{t('help.autoArchive')}</p>
    </Modal>
  );
}
