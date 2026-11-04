/**
 * 卡片 / 列表行的「工作线」徽标（docs/contracts/06-git-context.md §5 卡片徽标，v0.15）。
 *
 * - 只对非主线的 feature 工作线显示（主线、游离 HEAD 不显示，控制噪音）；
 * - 卡片无 cwd → 不渲染；有 cwd 但探测失败/不可用 → 灰色「工作线未知」（不谎报）；
 * - 内容：彩色圆点 + 「工作线 <branch>」+ 关系短语（多 N / 已并入主线 / 和主线一致 / 少 N）
 *   + 线上短语（未同步 / 线上落后 N / 已同步），`title` 给全文；
 * - 11px 单行：窄卡片时分支名先省略，关系/线上短语保留。
 */
import { useI18n } from '../i18n';
import type { Translate } from '../i18n';
import type { WorklineStatus } from '../lib/worklineSummary';

interface WorklineBadgeProps {
  /** 卡片 cwd；无 cwd 不渲染 */
  cwd?: string | null;
  /** hook 返回的状态：undefined = 还没探测完/不显示；null = 探测失败（未知） */
  status?: WorklineStatus | null;
  className?: string;
}

type BadgeTone = 'feature' | 'merged' | 'behind' | 'unknown';

/** 圆点颜色语义：feature 蓝（有自己的改动）、merged 绿、behind 橙、未知灰。 */
function badgeTone(status: WorklineStatus): Exclude<BadgeTone, 'unknown'> {
  switch (status.mainRelation) {
    case 'same':
    case 'merged':
      return 'merged';
    case 'behind-only':
      return 'behind';
    default:
      return 'feature';
  }
}

/** 与主线的关系短语（徽标）。 */
function relationText(status: WorklineStatus, t: Translate): string {
  switch (status.mainRelation) {
    case 'same':
      return t('workline.same');
    case 'merged':
      return t('workline.merged');
    case 'behind-only':
      return t('workline.behind', { count: status.behindMain });
    case 'ahead-only':
      return t('workline.ahead', { count: status.aheadMain });
    case 'ahead-behind':
      // 徽标单行放不下两组计数：优先显示「多 N」，完整信息在详情抽屉与 title 里
      return t('workline.ahead', { count: status.aheadMain });
    case 'main':
    default:
      return t('workline.same');
  }
}

/** 与线上的关系短语（徽标）。 */
function remoteText(status: WorklineStatus, t: Translate): string {
  switch (status.remoteRelation) {
    case 'no-upstream':
      return t('workline.notSynced');
    case 'synced':
      return t('workline.synced');
    case 'ahead':
      // 本地领先 = 线上落后 N
      return t('workline.remoteBehind', { count: status.aheadUpstream });
    case 'behind':
    case 'diverged':
    default:
      return t('workline.notSynced');
  }
}

/** 卡片/列表「工作线」徽标；不满足展示条件时返回 null（不占位）。 */
export function WorklineBadge({ cwd, status, className }: WorklineBadgeProps) {
  const { t } = useI18n();
  if (!cwd) return null;
  if (status === undefined) return null; // 尚未探测完：先不占位，避免闪烁
  const classes = ['kb-workline'];
  if (className) classes.push(className);
  if (status === null) {
    const label = t('workline.unknown');
    classes.push('kb-workline--unknown');
    return (
      <span className={classes.join(' ')} role="img" aria-label={label} title={label}>
        <span className="kb-workline__dot" aria-hidden="true" />
        <span className="kb-workline__unknown">{label}</span>
      </span>
    );
  }
  if (status.position !== 'feature') return null; // 主线 / 游离 HEAD：不显示
  // 探测不到主分支时「与主线」的结论没有参照物，宁可不显示也不谎报
  if (!status.mainBranch) return null;
  classes.push(`kb-workline--${badgeTone(status)}`);
  const branch = status.branch ?? '';
  const relation = relationText(status, t);
  const remote = remoteText(status, t);
  const showRemoteInline = status.remoteRelation === 'behind' || status.remoteRelation === 'diverged';
  return (
    <span
      className={classes.join(' ')}
      role="img"
      aria-label={t('workline.aria', { branch, relation, remote })}
      title={t('workline.title', { branch, relation, remote })}
    >
      <span className="kb-workline__dot" aria-hidden="true" />
      {branch ? (
        <code className="kb-workline__branch" title={`${t('workline.branch')} ${branch}`}>
          {branch}
        </code>
      ) : null}
      <span className="kb-workline__relation">{relation}</span>
      {showRemoteInline ? (
        <>
          <span className="kb-workline__sep" aria-hidden="true">
            ·
          </span>
          <span className="kb-workline__remote">{remote}</span>
        </>
      ) : null}
    </span>
  );
}
