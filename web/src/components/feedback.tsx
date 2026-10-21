import { IconAlert } from './Icons';
import { useI18n } from '../i18n';

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="kb-empty">
      <span className="kb-empty__title">{title}</span>
      {hint ? <span className="kb-empty__hint">{hint}</span> : null}
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

export function ErrorState({
  title,
  hint,
  code,
  retryLabel,
  onRetry,
}: {
  title: string;
  hint?: string;
  code?: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="kb-error" role="alert">
      <span className="kb-icon" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>
        <IconAlert />
      </span>
      <div className="kb-error__title">{title}</div>
      {hint ? <div className="kb-error__hint">{hint}</div> : null}
      {code ? <div className="kb-error__code">{code}</div> : null}
      <button type="button" className="kb-btn kb-btn--outline" onClick={onRetry} aria-label={t('common.retry')}>
        {retryLabel}
      </button>
    </div>
  );
}
