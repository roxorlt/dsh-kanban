import type { Activity } from '../types';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { formatRelative } from '../lib/time';
import { activityStatus, activityTitle } from '../lib/timeline';

interface TimelineProps {
  activities: Activity[];
  now: number;
  variant?: 'compact' | 'full';
}

function activityText(activity: Activity, t: ReturnType<typeof useI18n>['t']): string {
  if (activity.text) return activity.text;
  const status = activityStatus(activity);
  if (status) return `${t('activity.status')} · ${t(`status.${status}` as I18nKey)}`;
  const title = activityTitle(activity);
  if (title) return `${t('activity.approval_requested')}：${title}`;
  return t(`activity.${activity.type}` as I18nKey);
}

/** 时间线：竖线 + 节点，时间在右侧（展开卡与详情抽屉共用）。 */
export function Timeline({ activities, now, variant = 'full' }: TimelineProps) {
  const { t, lang } = useI18n();
  if (!activities.length) {
    return <p className="kb-timeline-empty">{t('drawer.noTimeline')}</p>;
  }
  return (
    <ol className={`kb-timeline kb-timeline--${variant}`} aria-label={t('drawer.timeline')}>
      {activities.map((activity, index) => {
        const state = activity.type === 'error' ? 'error' : index === 0 ? 'current' : 'past';
        return (
          <li key={activity.id} className="kb-tl-node" data-state={state} data-type={activity.type}>
            <span className="kb-tl-text">{activityText(activity, t)}</span>
            <time className="kb-tl-time" dateTime={new Date(activity.at).toISOString()}>
              {formatRelative(activity.at, now, lang)}
            </time>
            {variant === 'full' && activity.actor?.kind === 'agent' ? (
              <span className="kb-tl-detail">{activity.actor.name}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
