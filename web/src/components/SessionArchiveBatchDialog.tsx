import { useEffect, useRef, useState } from 'react';
import type { Card, SessionRow } from '../types';
import { KanbanApiError, api } from '../api';
import type { SessionArchiveBatchResult } from '../api';
import { useI18n } from '../i18n';
import {
  formatTitleList,
  normalizeSkipReason,
  parseBlockingCards,
} from '../lib/sessionArchive';
import { Modal } from './Modal';

interface SessionArchiveBatchDialogProps {
  sessions: SessionRow[];
  cards: Card[];
  onClose: () => void;
  /** 执行成功：把响应里的归档集合回填本地状态并刷新卡片 */
  onCompleted: (result: SessionArchiveBatchResult) => void;
  /** 宿主不支持可逆归档（401/501）：隐藏入口 */
  onUnavailable: () => void;
}

/**
 * 「已完成卡片批量归档会话」：挂载先 dryRun 预览（可归档 N 个 / 跳过原因），
 * 确认后再执行（docs/11 §12.1 批量与历史数据）。
 */
export function SessionArchiveBatchDialog({
  sessions,
  cards,
  onClose,
  onCompleted,
  onUnavailable,
}: SessionArchiveBatchDialogProps) {
  const { t, lang } = useI18n();
  const [preview, setPreview] = useState<SessionArchiveBatchResult | null>(null);
  const [phase, setPhase] = useState<'scanning' | 'ready' | 'archiving' | 'failed'>('scanning');
  const [error, setError] = useState<string | null>(null);

  // 父组件回调可能是内联函数：用 ref 固定，避免挂载时的 dryRun 被重复触发。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    let cancelled = false;
    api
      .archiveSessionsBatch({ scope: 'done', dryRun: true })
      .then((result) => {
        if (cancelled) return;
        // 宿主能力在挂载期间失效：收起入口，不展示不可执行的计划
        if (result.available === false) {
          unavailableRef.current();
          closeRef.current();
          return;
        }
        setPreview(result);
        setPhase('ready');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof KanbanApiError && caught.code === 'SESSION_ARCHIVE_UNAVAILABLE') {
          unavailableRef.current();
          closeRef.current();
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const execute = async () => {
    setPhase('archiving');
    setError(null);
    try {
      const result = await api.archiveSessionsBatch({ scope: 'done', dryRun: false });
      if (result.available === false) {
        unavailableRef.current();
        closeRef.current();
        return;
      }
      completedRef.current(result);
    } catch (caught) {
      if (caught instanceof KanbanApiError && caught.code === 'SESSION_ARCHIVE_UNAVAILABLE') {
        unavailableRef.current();
        closeRef.current();
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('ready');
    }
  };

  const sessionTitle = (sessionId: string): string =>
    sessions.find((session) => session.id === sessionId)?.title ?? sessionId;
  const cardTitle = (cardId: string): string => cards.find((card) => card.id === cardId)?.title ?? cardId;

  const skipReason = (item: SessionArchiveBatchResult['skipped'][number]): string => {
    const kind = normalizeSkipReason(item.reason ?? '');
    const blockingCards = parseBlockingCards(item.blockingCards);
    switch (kind) {
      case 'card':
        if (!blockingCards.length) return item.message || t('sessionArchive.reasonUnknown');
        return t('sessionArchive.busyCards', {
          count: blockingCards.length,
          titles: formatTitleList(blockingCards.map((card) => card.title), lang),
        });
      case 'running':
        return t('sessionArchive.reasonRunning');
      case 'pending':
        return t('sessionArchive.reasonPending');
      case 'host':
        return t('sessionArchive.reasonHost');
      case 'archived':
        return t('sessionArchive.reasonAlreadyArchived');
      case 'missing':
        return t('sessionArchive.reasonMissing');
      case 'failed':
        return item.message || t('sessionArchive.reasonFailed');
      default:
        return item.message || item.reason || t('sessionArchive.reasonUnknown');
    }
  };

  const archivable = preview?.archivable ?? [];
  const skipped = preview?.skipped ?? [];
  const busy = phase === 'archiving';
  const scanning = phase === 'scanning';

  return (
    <Modal
      title={t('sessionArchive.batchTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="kb-btn kb-btn--ghost" onClick={onClose} disabled={busy}>
            {t('modal.cancel')}
          </button>
          <button
            type="button"
            className="kb-btn kb-btn--primary"
            onClick={() => void execute()}
            disabled={busy || scanning || phase === 'failed' || archivable.length === 0}
          >
            {busy
              ? t('sessionArchive.batchRunning')
              : t('sessionArchive.batchConfirm', { count: archivable.length })}
          </button>
        </>
      }
    >
      {scanning ? (
        <p className="kb-drawer__loading" role="status">
          <span className="kb-spinner" aria-hidden="true" />
          {t('sessionArchive.batchScanning')}
        </p>
      ) : null}

      {error ? (
        <p className="kb-field__hint" role="alert">
          {error}
        </p>
      ) : null}

      {phase !== 'scanning' && preview ? (
        <div className="kb-archive-batch">
          <p className="kb-archive-batch__summary">
            {t('sessionArchive.batchArchivable', { count: archivable.length })}
          </p>
          {archivable.length ? (
            <ul className="kb-archive-batch__list">
              {archivable.map((item) => (
                <li className="kb-archive-batch__item" key={item.sessionId}>
                  <span className="kb-archive-batch__item-title" title={sessionTitle(item.sessionId)}>
                    {sessionTitle(item.sessionId)}
                  </span>
                  <span className="kb-archive-batch__meta">{cardTitle(item.cardId)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kb-archive-batch__empty">{t('sessionArchive.batchEmpty')}</p>
          )}

          {skipped.length ? (
            <div className="kb-archive-batch__section">
              <p className="kb-archive-batch__summary">
                {t('sessionArchive.batchSkipped', { count: skipped.length })}
              </p>
              <ul className="kb-archive-batch__list">
                {skipped.map((item) => (
                  <li className="kb-archive-batch__item kb-archive-batch__item--skipped" key={item.sessionId}>
                    <span className="kb-archive-batch__item-title" title={sessionTitle(item.sessionId)}>
                      {sessionTitle(item.sessionId)}
                    </span>
                    <span className="kb-archive-batch__reason">{skipReason(item)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
