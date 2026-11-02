export interface EmptyStateProps {
  title: string;
  hint?: string;
  /** 可选行动入口（如「清空筛选」）；全局空态只给一个入口，列/组内局部提示不带 CTA。 */
  actionLabel?: string;
  onAction?: () => void;
}

/** 空态：一句标题 + 一句 hint + 至多一个行动入口（App 的「还没有卡片」与 A-12 的全局无结果共用）。 */
export function EmptyState({ title, hint, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="kb-empty">
      <span className="kb-empty__title">{title}</span>
      {hint ? <span className="kb-empty__hint">{hint}</span> : null}
      {actionLabel && onAction ? (
        <button type="button" className="kb-btn kb-btn--sm kb-btn--outline" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function SkeletonLine({ width, height = 12 }: { width: string; height?: number }) {
  return <div className="kb-skeleton" style={{ width, height }} />;
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="kb-skeleton-stack" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="kb-skeleton-card" key={index}>
          <SkeletonLine width="62%" height={14} />
          <SkeletonLine width="92%" />
          <SkeletonLine width="74%" />
          <div className="kb-skeleton-meta">
            <SkeletonLine width="72px" height={10} />
            <SkeletonLine width="120px" height={10} />
            <SkeletonLine width="56px" height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonBoard() {
  return (
    <div className="kb-board kb-board--loading" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <section className="kb-column" key={index}>
          <div className="kb-column-head">
            <SkeletonLine width="17px" height={17} />
            <SkeletonLine width="72px" height={12} />
            <SkeletonLine width="20px" height={18} />
          </div>
          <SkeletonCards count={index === 1 ? 3 : 2} />
        </section>
      ))}
    </div>
  );
}
