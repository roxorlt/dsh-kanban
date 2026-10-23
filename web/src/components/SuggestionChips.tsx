import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import type { Suggestion, SuggestionSource } from '../lib/suggestions';

interface SuggestionChipsProps {
  id: string;
  label: string;
  items: Suggestion[];
  value: string;
  max?: number;
  onPick: (value: string) => void;
}

const SOURCE_KEY: Record<SuggestionSource, I18nKey> = {
  workspace: 'modal.suggestionWorkspace',
  session: 'modal.suggestionSession',
  card: 'modal.suggestionCard',
  existing: 'modal.suggestionCard',
};

/** 可干预的建议 chips：推荐首项带徽标，标注来源；点击填入输入框。 */
export function SuggestionChips({ id, label, items, value, max = 6, onPick }: SuggestionChipsProps) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <div className="kb-suggest" id={id} role="group" aria-label={label}>
      <span className="kb-suggest__label">{label}</span>
      <div className="kb-suggest__list">
        {items.slice(0, max).map((item) => (
          <button
            type="button"
            key={item.value}
            className={`kb-suggest__chip${value === item.value ? ' kb-suggest__chip--active' : ''}${
              item.recommended ? ' kb-suggest__chip--recommended' : ''
            }`}
            title={item.value}
            onClick={() => onPick(item.value)}
          >
            <span className="kb-suggest__value">{item.value}</span>
            {item.recommended ? <span className="kb-suggest__badge">{t('modal.recommended')}</span> : null}
            <span className="kb-suggest__source">{t(SOURCE_KEY[item.source])}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
