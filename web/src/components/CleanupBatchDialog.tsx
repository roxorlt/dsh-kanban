/**
 * 批量清理工作副本对话框（v0.25.0 ⑯，docs/contracts/02-http-api.md §13 / 06 §4.8）。
 *
 * 只列出「安全可清理」的候选（已并入主线、干净、无未完成卡片 / 运行中会话占用，
 * 非主工作副本、未锁定）；用户确认后由父组件逐项调用单条清理接口，
 * 这里展示逐项结果（成功 / 失败原因），不提供任何「有丢失风险」的批量入口。
 */
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import type { I18nKey, Translate } from '../i18n';
import { formatWorktreeLabel } from '../lib/useWorkspaces';
import type { CleanupErrorReason } from '../lib/useWorkspaces';
import { batchCleanupFailureKey, groupBatchCleanupCandidates } from '../lib/worktreeBatchCleanup';
import type { BatchCleanupCandidate } from '../lib/worktreeBatchCleanup';
import { shortenPath } from '../lib/forkGraph';
import { Modal } from './Modal';

/** 回收站保留天数（服务端契约固定 7 天）。 */
const TRASH_RETENTION_DAYS = 7;

export interface BatchCleanupOutcomeItem {
  repoRoot: string;
  worktreePath: string;
  /** 工作副本展示名（分支 / 相对路径） */
  label: string;
  ok: boolean;
  /** 失败原因（cleanupErrorReason 的结果；成功时缺省） */
  reason?: CleanupErrorReason;
  message?: string;
}

export interface BatchCleanupOutcome {
  cleanedCount: number;
  failedCount: number;
  results: BatchCleanupOutcomeItem[];
}

interface CleanupBatchDialogProps {
  candidates: readonly BatchCleanupCandidate[];
  /** 父组件逐项执行清理（负责 reload / 回收站刷新 / toast），返回逐项结果 */
  onConfirm: (options: { deleteBranch: boolean }) => Promise<BatchCleanupOutcome>;
  onClose: () => void;
}

function failureText(item: BatchCleanupOutcomeItem, t: Translate): string {
  const key = batchCleanupFailureKey(item.reason ?? 'unknown') as I18nKey;
  return t(key, { message: item.message ?? '' });
}

/** 批量清理：安全项预览 + 确认 + 逐项结果。 */
export function CleanupBatchDialog({ candidates, onConfirm, onClose }: CleanupBatchDialogProps) {
  const { t } = useI18n();
  // 打开时快照候选：清理过程中父组件 reload 会改变候选列表，结果页仍应展示本次清理的对象
  const [targets] = useState(() => [...candidates]);
  const groups = useMemo(() => groupBatchCleanupCandidates(targets), [targets]);
  const branchCount = useMemo(() => targets.filter((item) => item.worktree.branch !== null).length, [targets]);
  const [deleteBranch, setDeleteBranch] = useState(() => branchCount > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BatchCleanupOutcome | null>(null);

  const handleConfirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onConfirm({ deleteBranch: branchCount > 0 && deleteBranch });
      setOutcome(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={outcome ? t('workspace.batchCleanupResultsTitle') : t('workspace.batchCleanupTitle')}
      onClose={onClose}
      onRequestClose={() => {
        if (!busy) onClose();
      }}
      size="md"
      footer={
        outcome ? (
          <button type="button" className="kb-btn kb-btn--primary" onClick={onClose}>
            {t('common.close')}
          </button>
        ) : (
          <>
            <button type="button" className="kb-btn kb-btn--ghost" onClick={onClose} disabled={busy}>
              {t('modal.cancel')}
            </button>
            <button
              type="button"
              className="kb-btn kb-btn--primary"
              onClick={() => void handleConfirm()}
              disabled={busy || targets.length === 0}
            >
              {busy
                ? t('workspace.batchCleanupBusy')
                : t('workspace.batchCleanupConfirm', { count: targets.length })}
            </button>
          </>
        )
      }
    >
      <div className="kb-workspace__batch-dialog">
        {outcome ? (
          <>
            <p className="kb-form__note">
              {outcome.failedCount === 0
                ? t('workspace.batchCleanupResultAllOk', {
                    count: outcome.cleanedCount,
                    days: TRASH_RETENTION_DAYS,
                  })
                : t('workspace.batchCleanupPartial', {
                    done: outcome.cleanedCount,
                    failed: outcome.failedCount,
                  })}
            </p>
            <ul className="kb-workspace__batch-list">
              {outcome.results.map((item) => (
                <li
                  key={`${item.repoRoot}\u0000${item.worktreePath}`}
                  className={`kb-workspace__batch-item${item.ok ? '' : ' kb-workspace__batch-item--failed'}`}
                >
                  <span className="kb-workspace__batch-branch" title={item.worktreePath}>
                    {item.label}
                  </span>
                  <span className="kb-workspace__batch-status">
                    {item.ok ? t('workspace.batchCleanupItemOk') : failureText(item, t)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="kb-form__note">{t('workspace.batchCleanupIntro', { count: targets.length })}</p>
            <ul className="kb-workspace__batch-list" aria-label={t('workspace.batchCleanupListLabel')}>
              {groups.map((group) => (
                <li key={group.repo.root} className="kb-workspace__batch-repo">
                  <p className="kb-workspace__batch-repo-name">
                    {group.repo.name}
                    <span className="kb-workspace__batch-repo-path" title={group.repo.root}>
                      {shortenPath(group.repo.root)}
                    </span>
                  </p>
                  <ul className="kb-workspace__batch-items">
                    {group.items.map((item) => (
                      <li key={item.worktree.path} className="kb-workspace__batch-item">
                        <span className="kb-workspace__batch-branch" title={item.worktree.branch ?? undefined}>
                          {item.worktree.branch ?? t('workspace.detached')}
                        </span>
                        <span className="kb-workspace__batch-path" title={item.worktree.path}>
                          {formatWorktreeLabel(item.repo, item.worktree)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {branchCount > 0 ? (
              <label className="kb-check">
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  disabled={busy}
                  onChange={(event) => setDeleteBranch(event.target.checked)}
                />
                <span className="kb-check__label">
                  {t('workspace.batchCleanupDeleteBranch', { count: branchCount })}
                </span>
              </label>
            ) : null}
            <p className="kb-form__note">
              {t('workspace.batchCleanupTrashNote', { days: TRASH_RETENTION_DAYS })}
            </p>
            {error ? (
              <p className="kb-workspace__cleanup-error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
