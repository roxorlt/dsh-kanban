/**
 * 列表视图底部的「归档箱」（v0.22.0）。
 *
 * 历史数据治理会分批归档旧卡；归档卡不在正常 cards 数组里，因此这里单独展示
 * 已归档卡片标题 + 状态 + 归档时间，并提供单张「恢复」（POST /cards/:id/unarchive）。
 * 只读展示，不做批量恢复；没有归档卡（或服务端还没提供列表接口）时整块不渲染。
 */
import type { Card } from '../types';
import { useI18n } from '../i18n';
import { STATUS_TONE } from '../lib/status';
import { formatDateTime } from '../lib/time';
import { IconChevronDown } from './Icons';

export interface ArchiveBoxProps {
  /** 已归档卡片（已加载成功）；null 表示尚未加载 */
  cards: Card[] | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  /** 正在恢复的卡片 id（禁用按钮） */
  busyCardId: string | null;
  onToggle: () => void;
  onRetry: () => void;
  onRestore: (card: Card) => void;
}

/** 归档箱：可收起；每条显示标题 / 状态 / 归档时间 / 单张恢复。 */
export function ArchiveBox({
  cards,
  loading,
  error,
  open,
  busyCardId,
  onToggle,
  onRetry,
  onRestore,
}: ArchiveBoxProps) {
  const { t, lang } = useI18n();
  const items = cards ?? [];
  // 没有归档卡（或旧服务端没有列表接口）时整块不渲染；加载中也先不占位
  if (!error && items.length === 0) return null;
  const panelId = 'kb-archive-panel';

  return (
    <section className="kb-archive" aria-label={t('archive.title', { count: items.length })}>
      <button
        type="button"
        className="kb-archive__head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className={`kb-archive__chevron${open ? ' kb-archive__chevron--open' : ''}`} aria-hidden="true">
          <IconChevronDown />
        </span>
        <span className="kb-archive__title">{t('archive.title', { count: items.length })}</span>
        {!open && items.length > 0 ? (
          <span className="kb-archive__head-hint">{t('archive.collapsedHint', { count: items.length })}</span>
        ) : null}
      </button>

      {open ? (
        <div id={panelId} className="kb-archive__body">
          <p className="kb-archive__hint">{t('archive.hint')}</p>
          {loading ? <p className="kb-archive__hint">{t('archive.loading')}</p> : null}
          {error ? (
            <p className="kb-archive__error" role="alert">
              {error}
              <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={onRetry}>
                {t('archive.retry')}
              </button>
            </p>
          ) : null}
          {!loading && !error && items.length === 0 ? (
            <p className="kb-archive__hint">{t('archive.empty')}</p>
          ) : null}
          {items.length > 0 ? (
            <ul className="kb-archive__list">
              {items.map((card) => {
                const tone = STATUS_TONE[card.status];
                const modifier = tone === 'tertiary' ? '' : ` kb-pill--${tone}`;
                const busy = busyCardId === card.id;
                return (
                  <li className="kb-archive__item" key={card.id}>
                    <div className="kb-archive__main">
                      <span className="kb-archive__name" title={card.title}>
                        {card.title}
                      </span>
                      <span className="kb-archive__meta">
                        <span className={`kb-pill${modifier}`}>
                          <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
                          {t(`status.${card.status}`)}
                        </span>
                        <span>{t('archive.archivedAt', { time: formatDateTime(card.archivedAt ?? card.updatedAt, lang) })}</span>
                        {card.mergedInto ? (
                          <span className="kb-tag kb-archive__tag">{t('relations.mergedIntoUnknown', { id: card.mergedInto })}</span>
                        ) : null}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="kb-btn kb-btn--sm kb-btn--outline"
                      disabled={busy}
                      onClick={() => onRestore(card)}
                    >
                      {busy ? t('archive.restoring') : t('archive.restore')}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
