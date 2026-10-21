import { useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { copyText } from '../lib/clipboard';
import { IconCopy, IconReply } from './Icons';

interface ComposerProps {
  embedded: boolean;
  onSubmit: (text: string) => Promise<{ ok: boolean; error?: string }>;
  autoFocus?: boolean;
}

/**
 * 卡片内回复：先写 comments（时间线），再经桥发到主会话；
 * 独立模式 / 桥不可用时降级为复制文本并显式提示。
 */
export function Composer({ embedded, onSubmit, autoFocus }: ComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const canSend = text.trim().length > 0 && !sending;

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
      const result = await onSubmit(value);
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
            <span className="kb-icon">
              <IconCopy />
            </span>
            {copied ? t('composer.copied') : t('composer.copy')}
          </button>
        </div>
      ) : null}
      {text.trim() ? (
        <div className="kb-composer__aux">
          <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={() => void handleCopy()}>
            <span className="kb-icon">
              <IconCopy />
            </span>
            {copied ? t('composer.copied') : t('composer.copy')}
          </button>
        </div>
      ) : null}
      <div className="kb-composer__footer">
        <span className="kb-composer__meta">{t('composer.send')} · ⌘/Ctrl + Enter</span>
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          disabled={!canSend}
          onClick={() => void handleSubmit()}
        >
          <span className="kb-icon">
            <IconReply />
          </span>
          {sending ? t('composer.sending') : t('composer.send')}
        </button>
      </div>
    </section>
  );
}
