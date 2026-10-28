/**
 * 清理工作副本对话框（v0.17 Phase B，docs/contracts/02-http-api.md §13 / 06 §4.8）。
 *
 * 两段式确认：
 * 1. 普通确认：路径 / 分支 / 状态摘要 + 回收站软删除说明 +「同时删除本地分支」（已并入主线默认勾选）；
 * 2. 第二层危险确认（脏 / 未合并，或服务端返回 WORKTREE_DIRTY / WORKTREE_UNMERGED 时升级）：
 *    逐条列出丢失风险，必须勾选「我已了解风险，仍然清理」才能提交 confirmLoss。
 *
 * 纯展示 + 表单状态；真正的接口调用与 toast / reload 由父组件 WorkspaceView 处理。
 */
import { useState } from 'react';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { evaluateWorktreeCleanup, worktreeStatusBadges, worktreeStatusInfo } from '../lib/useWorkspaces';
import type { WorkspaceRepoGroup, WorkspaceWorktreeGroup } from '../lib/useWorkspaces';
import { IconAlert } from './Icons';
import { Modal } from './Modal';

export interface CleanupTarget {
  repo: WorkspaceRepoGroup;
  worktree: WorkspaceWorktreeGroup;
}

export interface CleanupConfirmOptions {
  deleteBranch: boolean;
  /** 已明确接受未合并 / 未保存改动的丢失风险 */
  confirmLoss: boolean;
}

export interface CleanupOutcome {
  ok: boolean;
  /** 失败时展示的人话文案（父组件已把错误码映射好） */
  message?: string;
  /** 服务端要求 confirmLoss：对话框升级到第二层危险确认 */
  lossRequired?: boolean;
}

interface CleanupWorktreeDialogProps {
  target: CleanupTarget;
  onConfirm: (options: CleanupConfirmOptions) => Promise<CleanupOutcome>;
  onClose: () => void;
}

/** 回收站保留天数（服务端契约固定 7 天）。 */
const TRASH_RETENTION_DAYS = 7;

/** 清理工作副本：两段式确认对话框。 */
export function CleanupWorktreeDialog({ target, onConfirm, onClose }: CleanupWorktreeDialogProps) {
  const { t } = useI18n();
  const status = worktreeStatusInfo(target.worktree);
  const check = evaluateWorktreeCleanup(target.worktree);
  const branch = target.worktree.branch;
  const canDeleteBranch = branch !== null;
  const unmergedAhead = Math.max(1, status.aheadMain);
  const badges = worktreeStatusBadges(target.worktree);
  /** 从未推送：未合并时删分支 = 提交彻底丢失（回收站只能找回文件，不能恢复提交历史）。 */
  const isNoRemote = status.remote === 'no-upstream';

  const [stage, setStage] = useState<'confirm' | 'danger'>('confirm');
  // 已并入主线 → 默认勾选「同时删除本地分支」；否则默认不勾
  const [deleteBranch, setDeleteBranch] = useState(status.merge === 'merged');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDeleteBranch = canDeleteBranch && deleteBranch;
  const branchRiskVisible = confirmDeleteBranch && status.merge === 'unmerged';

  const runCleanup = async (confirmLoss: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onConfirm({ deleteBranch: confirmDeleteBranch, confirmLoss });
      if (outcome.ok) return; // 父组件成功后关闭对话框
      setError(outcome.message ?? t('workspace.cleanupErrorUnknown', { message: '' }));
      if (outcome.lossRequired && stage === 'confirm') {
        setStage('danger');
        setRiskAccepted(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePrimary = (): void => {
    if (busy) return;
    if (stage === 'confirm') {
      // 本地判定脏 / 未合并 → 直接升级到危险确认；否则交给服务端校验
      if (check.needsDangerConfirm) {
        setStage('danger');
        setRiskAccepted(false);
        setError(null);
        return;
      }
      void runCleanup(false);
      return;
    }
    if (!riskAccepted) return;
    void runCleanup(true);
  };

  const dangerWarnings: string[] = [];
  if (status.merge === 'unmerged') {
    dangerWarnings.push(t('workspace.cleanupDangerAhead', { count: unmergedAhead }));
  }
  if (status.modifiedCount > 0) {
    dangerWarnings.push(t('workspace.cleanupDangerModified', { count: status.modifiedCount }));
  }
  if (status.untrackedCount > 0) {
    dangerWarnings.push(t('workspace.cleanupDangerUntracked', { count: status.untrackedCount }));
  }
  if (branchRiskVisible) {
    dangerWarnings.push(t('workspace.cleanupDangerBranch', { count: unmergedAhead }));
  }
  if (isNoRemote && status.merge === 'unmerged' && confirmDeleteBranch) {
    dangerWarnings.push(t('workspace.cleanupDangerNoRemote'));
  }

  const primaryDisabled = busy || (stage === 'danger' && !riskAccepted);
  const primaryLabel =
    stage === 'danger'
      ? t('workspace.cleanupDangerConfirm')
      : busy
        ? t('workspace.cleanupBusy')
        : t('workspace.cleanupConfirm');

  return (
    <Modal
      title={stage === 'danger' ? t('workspace.cleanupDangerTitle') : t('workspace.cleanupTitle')}
      onClose={onClose}
      onRequestClose={() => {
        if (!busy) onClose();
      }}
      size="sm"
      footer={
        <>
          <button type="button" className="kb-btn kb-btn--ghost" onClick={onClose} disabled={busy}>
            {t('modal.cancel')}
          </button>
          <button
            type="button"
            className={`kb-btn ${stage === 'danger' ? 'kb-workspace__cleanup-danger' : 'kb-btn--primary'}`}
            onClick={handlePrimary}
            disabled={primaryDisabled}
          >
            {busy ? t('workspace.cleanupBusy') : primaryLabel}
          </button>
        </>
      }
    >
      <div className={`kb-workspace__cleanup-dialog${stage === 'danger' ? ' kb-workspace__cleanup-dialog--danger' : ''}`}>
        {stage === 'confirm' ? (
          <>
            <dl className="kb-workspace__cleanup-meta">
              <div>
                <dt>{t('workspace.cleanupPathLabel')}</dt>
                <dd className="kb-workspace__cleanup-path" title={target.worktree.path}>
                  {target.worktree.path}
                </dd>
              </div>
              <div>
                <dt>{t('workspace.cleanupBranchLabel')}</dt>
                <dd className="kb-workspace__cleanup-branch" title={branch ?? undefined}>
                  {branch ?? t('workspace.detached')}
                </dd>
              </div>
              <div>
                <dt>{t('workspace.cleanupStatusLabel')}</dt>
                <dd className="kb-workspace__cleanup-status">
                  {badges.map((badge) => (
                    <span key={`${badge.kind}:${badge.key}`}>{t(badge.key as I18nKey, badge.params)}</span>
                  ))}
                </dd>
              </div>
            </dl>
            <p className="kb-form__note">{t('workspace.cleanupTrashNote', { days: TRASH_RETENTION_DAYS })}</p>
            {isNoRemote && status.merge === 'merged' ? (
              <p className="kb-form__note">{t('workspace.cleanupNoRemoteMerged')}</p>
            ) : null}
            {isNoRemote && status.merge === 'unmerged' ? (
              <p className="kb-workspace__cleanup-warn">{t('workspace.cleanupNoRemoteUnmerged')}</p>
            ) : null}
            {canDeleteBranch ? (
              <label className="kb-check">
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  disabled={busy}
                  onChange={(event) => setDeleteBranch(event.target.checked)}
                />
                <span className="kb-check__label">{t('workspace.cleanupDeleteBranch', { branch })}</span>
              </label>
            ) : null}
            {branchRiskVisible ? (
              <p className="kb-workspace__cleanup-warn">{t('workspace.cleanupBranchNote', { count: unmergedAhead })}</p>
            ) : null}
          </>
        ) : (
          <>
            <p className="kb-workspace__cleanup-danger-head">
              <span className="kb-workspace__cleanup-danger-icon" aria-hidden="true">
                <IconAlert />
              </span>
              {t('workspace.cleanupDangerIntro')}
            </p>
            <ul className="kb-workspace__cleanup-warnings">
              {dangerWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p className="kb-form__note">{t('workspace.cleanupTrashNote', { days: TRASH_RETENTION_DAYS })}</p>
            <label className="kb-check">
              <input
                type="checkbox"
                checked={riskAccepted}
                disabled={busy}
                onChange={(event) => setRiskAccepted(event.target.checked)}
              />
              <span className="kb-check__label">{t('workspace.cleanupRiskCheck')}</span>
            </label>
          </>
        )}
        {error ? (
          <p className="kb-workspace__cleanup-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
