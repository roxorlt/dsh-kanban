import { useI18n } from '../i18n';
import type { ColumnId } from '../types';
import { COLUMNS } from '../lib/status';
import { IconArchive, IconCheck, IconChevronDown, IconClose, IconMove } from './Icons';
import { MenuButton } from './MenuButton';
import type { MenuEntry } from './MenuButton';

interface SelectionBarProps {
  count: number;
  /** 当前视图可全选的卡片数 */
  visibleCount: number;
  busy: boolean;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onMove: (column: ColumnId) => void;
  onArchive: () => void;
  onCancel: () => void;
  /**
   * 退出离场中（App 用 usePresence(selectionMode, 140) 驱动，见 docs/11-motion.md §6.4）：
   * 只挂 `.kb-batchbar--leaving` 跑 140ms 淡出；离场期间不吃指针事件。
   */
  closing?: boolean;
}

/** 批量选择操作条：已选 N 张 / 全选当前视图 / 清空 / 移动到 / 归档 / 取消。 */
export function SelectionBar({
  count,
  visibleCount,
  busy,
  allSelected,
  onSelectAll,
  onClear,
  onMove,
  onArchive,
  onCancel,
  closing = false,
}: SelectionBarProps) {
  const { t } = useI18n();
  const moveItems: MenuEntry[] = COLUMNS.map((column) => ({
    id: `move:${column}`,
    label: t(`column.${column}`),
    icon: <IconMove />,
  }));
  return (
    <div
      className={`kb-batchbar${closing ? ' kb-batchbar--leaving' : ''}`}
      role="toolbar"
      aria-label={t('selection.mode')}
    >
      <span className="kb-batchbar__count" aria-live="polite">
        {t('selection.selected', { count })}
      </span>
      <button
        type="button"
        className="kb-btn kb-btn--sm kb-btn--ghost kb-batchbar__select-all"
        disabled={busy || visibleCount === 0}
        title={t('selection.selectAllTitle', { count: visibleCount })}
        aria-pressed={allSelected}
        onClick={onSelectAll}
      >
        <span className="kb-icon" aria-hidden="true">
          <IconCheck />
        </span>
        {allSelected ? t('selection.deselectAll') : t('selection.selectAll')}
      </button>
      <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" disabled={busy || count === 0} onClick={onClear}>
        {t('selection.clear')}
      </button>
      <span className="kb-batchbar__hint">{t('selection.hint')}</span>
      <span className="kb-batchbar__spacer" />
      <MenuButton
        label={t('selection.moveTo')}
        trigger={
          <>
            <span className="kb-icon" aria-hidden="true">
              <IconMove />
            </span>
            {t('selection.moveTo')}
            <span className="kb-icon" aria-hidden="true">
              <IconChevronDown />
            </span>
          </>
        }
        triggerClassName="kb-btn kb-btn--sm kb-btn--outline"
        items={moveItems}
        onSelect={(id) => {
          if (!id.startsWith('move:')) return;
          const column = id.slice('move:'.length) as ColumnId;
          if (COLUMNS.includes(column)) onMove(column);
        }}
      />
      <button
        type="button"
        className="kb-btn kb-btn--sm kb-btn--outline kb-batchbar__danger"
        disabled={busy || count === 0}
        onClick={onArchive}
      >
        <span className="kb-icon" aria-hidden="true">
          <IconArchive />
        </span>
        {t('selection.archive')}
      </button>
      <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" disabled={busy} onClick={onCancel}>
        <span className="kb-icon" aria-hidden="true">
          <IconClose />
        </span>
        {t('selection.cancel')}
      </button>
    </div>
  );
}
