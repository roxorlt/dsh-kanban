import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { copyText } from '../lib/clipboard';
import type { ReplyTargetOption } from '../lib/replyTarget';
import { IconCopy, IconReply } from './Icons';

interface ComposerProps {
  embedded: boolean;
  /** 卡片绑定的会话，主会话排第一位；>1 时提供「回复/审批目标」下拉 */
  targets: ReplyTargetOption[];
  targetSessionId: string | null;
  onTargetChange?: (sessionId: string) => void;
  onSubmit: (text: string, sessionId: string | null) => Promise<{ ok: boolean; error?: string }>;
  autoFocus?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * 卡片内回复（唯一的同步文案出口）：先写时间线，再经桥发到选定会话；
 * 多会话时在输入框上方切换「回复/审批目标」（设计规范 §2.6 / §7.5）；
 * 独立模式 / 桥不可用时降级复制文本。
 */
export function Composer({
  embedded,
  targets,
  targetSessionId,
  onTargetChange,
  onSubmit,
  autoFocus,
  onDirtyChange,
}: ComposerProps) {
  const { t } = useI18n();
  const selectId = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const canSend = text.trim().length > 0 && !sending;

  useEffect(() => {
    onDirtyChange?.(text.trim().length > 0);
  }, [text, onDirtyChange]);

  const target = targets.find((option) => option.id === targetSessionId) ?? targets[0];
  const targetLabel = target?.title ?? t('card.noSession');
  const selectable = Boolean(embedded && targets.length > 1 && onTargetChange);

  const handleCopy = async () => {
    const ok = await copyText(text);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1600);
    else setError(t('composer.copyFailed'));
  };

  const handleSubmit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await onSubmit(value, targetSessionId);
      if (result.ok) {
        setText('');
        setCopied(false);
      } else {
        setError(result.error ?? t('composer.replyFailed'));
      }
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError.message : t('composer.replyFailed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="kb-composer" aria-label={t('card.reply')}>
      <div className="kb-composer__target">
        {selectable ? (
          <>
            <label className="kb-composer__target-label" htmlFor={selectId}>
              {t('drawer.replyTarget')}
            </label>
            <select
              id={selectId}
              className="kb-select kb-composer__target-select"
              value={target?.id ?? ''}
              title={t('drawer.replyTargetHint')}
              onChange={(event) => onTargetChange?.(event.target.value)}
            >
              {targets.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                  {option.primary ? ` · ${t('drawer.primarySession')}` : ''}
                  {option.running ? ` · ${t('drawer.running')}` : ''}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <span className="kb-composer__target-label">{t('drawer.replyTarget')}</span>
            <span className="kb-composer__target-value" title={targetLabel}>
              {targetLabel}
            </span>
            {targets.length > 1 ? (
              <span className="kb-composer__target-hint">{t('drawer.sessionCount', { count: targets.length })}</span>
            ) : null}
          </>
        )}
      </div>
      <textarea
        ref={textareaRef}
        className="kb-textarea kb-composer__input"
        placeholder={t('composer.placeholder')}
        value={text}
        rows={3}
        autoFocus={autoFocus}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void handleSubmit();
          }
        }}
      />
      {!embedded ? <p className="kb-composer__hint">{t('composer.standaloneHint')}</p> : null}
      {error ? (
        <div className="kb-composer__error" role="alert">
          <span>{error}</span>
          <button type="button" className="kb-btn kb-btn--sm kb-btn--outline" onClick={() => void handleCopy()}>
            <span className="kb-icon" aria-hidden="true">
              <IconCopy />
            </span>
            {copied ? t('composer.copied') : t('composer.copy')}
          </button>
        </div>
      ) : null}
      {text.trim() ? (
        <div className="kb-composer__aux">
          <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => void handleCopy()}>
            <span className="kb-icon" aria-hidden="true">
              <IconCopy />
            </span>
            {copied ? t('composer.copied') : t('composer.copy')}
          </button>
        </div>
      ) : null}
      <div className="kb-composer__footer">
        <span className="kb-composer__meta">{t('composer.send')} · ⌘/Ctrl + Enter</span>
        <button type="button" className="kb-btn kb-btn--primary" disabled={!canSend} onClick={() => void handleSubmit()}>
          <span className="kb-icon" aria-hidden="true">
            <IconReply />
          </span>
          {sending ? t('composer.sending') : t('composer.send')}
        </button>
      </div>
    </section>
  );
}
