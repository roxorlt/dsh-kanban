/**
 * 父子卡 / 依赖关系的三处展示（v0.22.0）：
 * - 看板卡片、列表行上的紧凑徽标（子卡 done/total、属于：父卡）；
 * - 详情抽屉的「关系」区块（父卡 / 子卡 / 依赖，点击可跳转）。
 *
 * 数据全部来自 cardRelations 的纯函数；字段缺失时组件什么都不渲染（不出现空区块）。
 */
import type { Card, Status } from '../types';
import { useI18n } from '../i18n';
import { STATUS_TONE } from '../lib/status';
import {
  describeChildren,
  describeDepends,
  isDependencyReady,
  mergedTargetOf,
  parentCardOf,
} from '../lib/cardRelations';
import type { CardRelationIndex } from '../lib/cardRelations';

/** 状态小徽标（父卡 / 子卡 / 依赖卡共用；status=null 表示卡片不在当前数据里）。 */
export function RelationStatusPill({ status }: { status: Status | null }) {
  const { t } = useI18n();
  if (!status) return <span className="kb-tag kb-rel__tag kb-rel__tag--muted">{t('relations.unknownCard')}</span>;
  const tone = STATUS_TONE[status];
  const modifier = tone === 'tertiary' ? '' : ` kb-pill--${tone}`;
  return (
    <span className={`kb-pill kb-rel__pill${modifier}`}>
      <span className={`kb-dot kb-dot--${tone}`} aria-hidden="true" />
      {t(`status.${status}`)}
    </span>
  );
}

interface CardRelationBadgesProps {
  card: Card;
  relations: CardRelationIndex | null;
  /** 父卡小字的额外 class（看板/列表布局不同） */
  parentClassName?: string;
}

/**
 * 卡片上的紧凑关系徽标：子卡「3/5」+ 「属于：父卡」小字。
 * 有子卡但全部收口时用中性色；还有未收口子卡时用 warn 色（与完成拦截提示一致）。
 */
export function CardRelationBadges({ card, relations, parentClassName = '' }: CardRelationBadgesProps) {
  const { t } = useI18n();
  if (!relations) return null;
  const children = describeChildren(card, relations);
  const parent = parentCardOf(card, relations.cardsById);
  return (
    <>
      {children.total > 0 ? (
        <span
          className={`kb-tag kb-rel-badge${children.open > 0 ? ' kb-rel-badge--open' : ''}`}
          title={t('relations.childrenBadgeAria', {
            done: children.done,
            total: children.total,
            open: children.open,
          })}
          aria-label={t('relations.childrenBadgeAria', {
            done: children.done,
            total: children.total,
            open: children.open,
          })}
        >
          {t('relations.childrenBadge', { done: children.done, total: children.total })}
        </span>
      ) : null}
      {parent ? (
        <span
          className={`kb-rel-parent ${parentClassName}`.trim()}
          title={t('relations.parentBadge', { title: parent.title })}
        >
          {t('relations.parentBadge', { title: parent.title })}
        </span>
      ) : null}
    </>
  );
}

interface RelationSectionProps {
  card: Card;
  relations: CardRelationIndex | null;
  onOpenCard: (cardId: string) => void;
}

/** 详情抽屉「关系」区块：没有任何关系时返回 null（不渲染空标题）。 */
export function RelationSection({ card, relations, onOpenCard }: RelationSectionProps) {
  const { t } = useI18n();
  if (!relations) return null;
  const parent = parentCardOf(card, relations.cardsById);
  const children = describeChildren(card, relations);
  const depends = describeDepends(card, relations.cardsById);
  const mergedTarget = mergedTargetOf(card, relations.cardsById);
  const hasParentRef = Boolean(card.parentCardId && card.parentCardId !== card.id);
  if (!hasParentRef && children.total === 0 && depends.length === 0 && !card.mergedInto) return null;
  const dependencyReady = isDependencyReady(card, relations.cardsById);

  return (
    <section className="kb-drawer__section kb-drawer__section--relations">
      <h3 className="kb-drawer__section-title">{t('relations.title')}</h3>
      <div className="kb-rel">
        {hasParentRef ? (
          <div className="kb-rel__row">
            <span className="kb-rel__label">{t('relations.parent')}</span>
            {parent ? (
              <button
                type="button"
                className="kb-rel__link"
                title={t('relations.openCard', { title: parent.title })}
                onClick={() => onOpenCard(parent.id)}
              >
                {parent.title}
              </button>
            ) : (
              <span className="kb-rel__muted">{t('relations.unknownCard')}</span>
            )}
            {parent ? <RelationStatusPill status={parent.status} /> : null}
          </div>
        ) : null}

        {children.total > 0 ? (
          <div className="kb-rel__group">
            <div className="kb-rel__group-head">
              <span className="kb-rel__label">{t('relations.children')}</span>
              <span className="kb-tag kb-rel__tag">
                {t('relations.childrenBadge', { done: children.done, total: children.total })}
              </span>
            </div>
            <ul className="kb-rel__list">
              {children.items.map((item) => (
                <li className="kb-rel__item" key={item.id}>
                  <button
                    type="button"
                    className="kb-rel__link"
                    title={t('relations.openCard', { title: item.title })}
                    onClick={() => onOpenCard(item.id)}
                  >
                    {item.title}
                  </button>
                  <RelationStatusPill status={item.status} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {depends.length > 0 ? (
          <div className="kb-rel__group">
            <div className="kb-rel__group-head">
              <span className="kb-rel__label">{t('relations.dependsOn')}</span>
              <span className={`kb-tag kb-rel__tag${dependencyReady ? '' : ' kb-rel__tag--warn'}`}>
                {dependencyReady ? t('relations.ready') : t('relations.notReady')}
              </span>
            </div>
            <ul className="kb-rel__list">
              {depends.map((item) => (
                <li className="kb-rel__item" key={item.id}>
                  {item.missing ? (
                    <span className="kb-rel__muted" title={item.id}>
                      {item.title}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="kb-rel__link"
                      title={t('relations.openCard', { title: item.title })}
                      onClick={() => onOpenCard(item.id)}
                    >
                      {item.title}
                    </button>
                  )}
                  <RelationStatusPill status={item.status} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {card.mergedInto ? (
          <p className="kb-rel__merged">
            {mergedTarget
              ? t('relations.mergedInto', { title: mergedTarget.title })
              : t('relations.mergedIntoUnknown', { id: card.mergedInto })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
