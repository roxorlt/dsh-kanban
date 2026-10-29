/**
 * 「重新绑定工作目录」对话框（v0.21.0 #16）。
 *
 * 卡片 cwd 对应的目录被清理 / 已失效后，用户从候选目录里挑一个作为卡片新的工作目录。
 * 候选由 `lib/rebindDir.buildRebindCandidates` 生成（父组件算好传进来），这里只做：
 * 搜索过滤、当前项标记并禁用、逐行「使用此目录」、空态 / 错误 / 提交中状态。
 *
 * PATCH 卡片 + 写时间线由父组件负责（`onSubmit`），业务错误作为 `error` 传回本对话框展示。
 */
import { useState } from 'react';
import type { Card } from '../types';
import { useI18n } from '../i18n';
import type { RebindCandidate } from '../lib/rebindDir';
import { shortenPath } from '../lib/forkGraph';
import { IconSearch } from './Icons';
import { Modal } from './Modal';

export interface RebindDirDialogProps {
  card: Card;
  candidates: RebindCandidate[];
  busy: boolean;
  /** 父组件已本地化的错误文案（App 用 rebind.failed 包好）；原样展示 */
  error: string | null;
  onSubmit: (path: string) => void;
  onClose: () => void;
}

/** 候选行搜索：label / detail / path 任一包含查询串（忽略大小写）。 */
function matchesQuery(candidate: RebindCandidate, query: string): boolean {
  return [candidate.label, candidate.detail ?? '', candidate.path].some((text) =>
    text.toLowerCase().includes(query),
  );
}

/** 重新绑定工作目录：候选列表 + 搜索 + 逐行应用。 */
export function RebindDirDialog({ candidates, busy, error, onSubmit, onClose }: RebindDirDialogProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  /** 正在提交的候选 path：busy 时只有这一行的按钮显示「绑定中…」 */
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery
    ? candidates.filter((candidate) => matchesQuery(candidate, normalizedQuery))
    : candidates;

  const apply = (candidate: RebindCandidate): void => {
    if (busy || candidate.isCurrent) return;
    setPendingPath(candidate.path);
    onSubmit(candidate.path);
  };

  const renderBody = () => {
    if (candidates.length === 0) {
      return <p className="kb-rebind__empty">{t('rebind.noCandidates')}</p>;
    }
    if (visible.length === 0) {
      return <p className="kb-rebind__empty">{t('rebind.empty')}</p>;
    }
    return (
      <ul className="kb-rebind__list">
        {visible.map((candidate) => {
          const applying = busy && pendingPath === candidate.path;
          return (
            <li
              key={candidate.path}
              className={`kb-rebind__item${candidate.isCurrent ? ' kb-rebind__item--current' : ''}`}
            >
              <div className="kb-rebind__info">
                <div className="kb-rebind__label-row">
                  <span className="kb-rebind__label" title={candidate.label}>
                    {candidate.label}
                  </span>
                  {candidate.isCurrent ? (
                    <span className="kb-tag kb-rebind__current">{t('rebind.current')}</span>
                  ) : null}
                </div>
                {candidate.detail ? (
                  <span className="kb-rebind__detail" title={candidate.detail}>
                    {candidate.detail}
                  </span>
                ) : null}
                <code className="kb-rebind__path" title={candidate.path}>
                  {shortenPath(candidate.path)}
                </code>
              </div>
              <button
                type="button"
                className="kb-btn kb-btn--sm kb-btn--outline kb-rebind__apply"
                disabled={busy || candidate.isCurrent}
                onClick={() => apply(candidate)}
              >
                {applying ? t('rebind.applying') : t('rebind.apply')}
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <Modal
      title={t('rebind.title')}
      onClose={onClose}
      onRequestClose={() => {
        if (!busy) onClose();
      }}
      size="md"
      initialFocus="#kb-rebind-search"
      footer={
        <button type="button" className="kb-btn kb-btn--ghost" onClick={onClose} disabled={busy}>
          {t('modal.cancel')}
        </button>
      }
    >
      <div className="kb-rebind">
        <p className="kb-rebind__hint">{t('rebind.hint')}</p>

        <div className="kb-rebind__search">
          <span className="kb-icon" aria-hidden="true">
            <IconSearch />
          </span>
          <input
            id="kb-rebind-search"
            className="kb-input"
            type="search"
            value={query}
            aria-label={t('rebind.searchPlaceholder')}
            placeholder={t('rebind.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {error ? (
          <p className="kb-rebind__error" role="alert">
            {error}
          </p>
        ) : null}

        {renderBody()}
      </div>
    </Modal>
  );
}
