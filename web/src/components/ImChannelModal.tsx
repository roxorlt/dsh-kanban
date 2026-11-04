import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { ImSanitizedConfig, ImStatusResponse, WeixinLiveStatus } from '../api';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n';
import { buildQrSvgPath } from '../lib/qrcode';
import { IconCheck, IconCheckCircle, IconCopy, IconPlus, IconQrCode, IconRefresh, IconTrash } from './Icons';
import { Modal } from './Modal';

type ImTab = 'weixin' | 'webhook' | 'mcp' | 'rules';
type WebhookProvider = 'dingtalk' | 'feishu' | 'onebot' | 'generic';
type McpClientKind = 'claude' | 'json' | 'codex' | 'http';

const DEFAULT_RULE_EVENTS = ['approval_requested', 'card_blocked', 'card_completed', 'daily_digest'] as const;

const RULE_ITEMS: readonly { id: (typeof DEFAULT_RULE_EVENTS)[number]; titleKey: I18nKey }[] = [
  { id: 'approval_requested', titleKey: 'im.ruleApprovalTitle' },
  { id: 'card_blocked', titleKey: 'im.ruleBlockedTitle' },
  { id: 'card_completed', titleKey: 'im.ruleCompletedTitle' },
  { id: 'daily_digest', titleKey: 'im.ruleDigestTitle' },
];

const MCP_CLIENTS: readonly { id: McpClientKind; labelKey: I18nKey }[] = [
  { id: 'claude', labelKey: 'im.mcpClientClaude' },
  { id: 'json', labelKey: 'im.mcpClientJson' },
  { id: 'codex', labelKey: 'im.mcpClientCodex' },
  { id: 'http', labelKey: 'im.mcpClientHttp' },
];

export interface ImChannelModalProps {
  boardName: string;
  initialStatus: ImStatusResponse | null;
  onStatusChange: (next: ImStatusResponse) => void;
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void;
  onClose: () => void;
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'dingtalk':
      return '钉钉';
    case 'feishu':
      return '飞书';
    case 'onebot':
      return 'OneBot';
    default:
      return 'Webhook';
  }
}

async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback below */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function ImChannelModal({
  boardName,
  initialStatus,
  onStatusChange,
  onNotify,
  onClose,
}: ImChannelModalProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ImTab>('weixin');
  const [status, setStatus] = useState<ImStatusResponse | null>(initialStatus);
  const [loadingStatus, setLoadingStatus] = useState(!initialStatus);

  // 微信扫码会话状态
  const [qrCodeId, setQrCodeId] = useState<string | null>(initialStatus?.weixinLive?.activeQr?.qrcode ?? null);
  const [qrUrl, setQrUrl] = useState<string | null>(initialStatus?.weixinLive?.activeQr?.qrcodeUrl ?? null);
  const [qrPhase, setQrPhase] = useState<'idle' | 'wait' | 'scaned' | 'expired'>(() => {
    const active = initialStatus?.weixinLive?.activeQr;
    if (!active || initialStatus?.weixinLive?.loggedIn) return 'idle';
    if (active.status === 'scaned') return 'scaned';
    if (active.status === 'expired') return 'expired';
    return active.qrcodeUrl ? 'wait' : 'idle';
  });
  const [qrStarting, setQrStarting] = useState(false);
  const [wxLogoutBusy, setWxLogoutBusy] = useState(false);
  const [testingTargetId, setTestingTargetId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  // Webhook 添加表单状态
  const [showAddForm, setShowAddForm] = useState(false);
  const [botProvider, setBotProvider] = useState<WebhookProvider>('dingtalk');
  const [botName, setBotName] = useState('');
  const [botUrl, setBotUrl] = useState('');
  const [botKeyword, setBotKeyword] = useState('');
  const [botSecret, setBotSecret] = useState('');
  const [botFormBusy, setBotFormBusy] = useState(false);
  const [botFormError, setBotFormError] = useState<string | null>(null);
  const [busyTargetId, setBusyTargetId] = useState<string | null>(null);
  const [rulesBusyEvent, setRulesBusyEvent] = useState<string | null>(null);

  // MCP 配置片段切换与复制反馈
  const [mcpClient, setMcpClient] = useState<McpClientKind>('claude');
  const [mcpCopied, setMcpCopied] = useState(false);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const syncStatus = useCallback((next: ImStatusResponse) => {
    setStatus(next);
    onStatusChangeRef.current(next);
  }, []);

  const applyPartialStatus = useCallback(
    (config: ImSanitizedConfig, weixinLive: WeixinLiveStatus | null) => {
      setStatus((prev) => {
        const merged: ImStatusResponse = {
          runtimeOrigin: prev?.runtimeOrigin ?? null,
          config,
          weixinLive,
          cc2imLive: prev?.cc2imLive ?? null,
          ...(prev?.mcp ? { mcp: prev.mcp } : {}),
        };
        onStatusChangeRef.current(merged);
        return merged;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadingStatus((prev) => prev && !initialStatus);
    api
      .getImStatus()
      .then((fresh) => {
        if (cancelled) return;
        syncStatus(fresh);
        if (!fresh.weixinLive?.loggedIn && fresh.weixinLive?.activeQr?.qrcodeUrl) {
          setQrCodeId(fresh.weixinLive.activeQr.qrcode ?? null);
          setQrUrl(fresh.weixinLive.activeQr.qrcodeUrl);
          setQrPhase(fresh.weixinLive.activeQr.status === 'scaned' ? 'scaned' : 'wait');
        }
      })
      .catch(() => {
        /* 独立预览模式或接口暂不可达时保持兜底视图 */
      })
      .finally(() => {
        if (!cancelled) setLoadingStatus(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialStatus, syncStatus]);

  const wxLive = status?.weixinLive ?? null;
  const wxConnected = Boolean(wxLive?.loggedIn && !wxLive?.sessionExpired && status?.config?.weixin?.enabled !== false);
  const wxSessionExpired = Boolean(wxLive?.sessionExpired);

  // 微信二维码长轮询状态检查
  useEffect(() => {
    if ((qrPhase !== 'wait' && qrPhase !== 'scaned') || !qrUrl) return undefined;
    let active = true;
    const controller = new AbortController();

    const loop = async () => {
      while (active && !controller.signal.aborted) {
        try {
          const res = await api.pollWeixinQr(qrCodeId ?? undefined, controller.signal);
          if (!active || controller.signal.aborted) break;
          if (res.loggedIn || res.status === 'confirmed') {
            setQrPhase('idle');
            setQrUrl(null);
            setQrCodeId(null);
            setFeedback(null);
            onNotify(t('im.wxConnectedToast'), 'success');
            const fresh = await api.getImStatus();
            if (active) syncStatus(fresh);
            break;
          }
          if (res.status === 'scaned') {
            setQrPhase('scaned');
          } else if (res.status === 'expired') {
            setQrPhase('expired');
            break;
          }
        } catch {
          if (!active || controller.signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 1800));
        }
      }
    };

    void loop();
    return () => {
      active = false;
      controller.abort();
    };
  }, [qrPhase, qrUrl, qrCodeId, onNotify, syncStatus, t]);

  const qrSvg = useMemo(() => {
    if (!qrUrl) return null;
    try {
      return buildQrSvgPath(qrUrl, 2);
    } catch {
      return null;
    }
  }, [qrUrl]);

  const handleStartWeixinQr = async () => {
    setQrStarting(true);
    setFeedback(null);
    try {
      const started = await api.startWeixinQr();
      setQrCodeId(started.qrcode);
      setQrUrl(started.qrcodeUrl);
      setQrPhase('wait');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFeedback({ text: msg, isError: true });
      onNotify(msg, 'error');
    } finally {
      setQrStarting(false);
    }
  };

  const handleCancelQr = () => {
    setQrPhase('idle');
    setQrUrl(null);
    setQrCodeId(null);
  };

  const handleLogoutWeixin = async () => {
    setWxLogoutBusy(true);
    setFeedback(null);
    try {
      const res = await api.logoutWeixin();
      applyPartialStatus(res.config, res.weixinLive);
      setQrPhase('idle');
      setQrUrl(null);
      setQrCodeId(null);
      onNotify(t('im.wxLoggedOutToast'), 'info');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFeedback({ text: msg, isError: true });
      onNotify(msg, 'error');
    } finally {
      setWxLogoutBusy(false);
    }
  };

  const handleSendTest = async (targetId: string) => {
    setTestingTargetId(targetId);
    setFeedback(null);
    try {
      const res = await api.sendImTest({ targetId, boardName });
      const first = res.results[0];
      if (res.ok && first?.ok !== false) {
        onNotify(t('im.testSuccessToast'), 'success');
        const fresh = await api.getImStatus().catch(() => null);
        if (fresh) syncStatus(fresh);
      } else {
        const respErrmsg =
          first?.response && typeof first.response.errmsg === 'string' ? first.response.errmsg : undefined;
        const reason = first?.error || respErrmsg || t('error.unknown');
        setFeedback({ text: reason, isError: true });
        onNotify(t('im.testFailedToast', { reason }), 'error');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setFeedback({ text: reason, isError: true });
      onNotify(t('im.testFailedToast', { reason }), 'error');
    } finally {
      setTestingTargetId(null);
    }
  };

  const handleAddBotSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedUrl = botUrl.trim();
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setBotFormError('请输入以 http:// 或 https:// 开头的完整 Webhook 地址');
      return;
    }
    setBotFormBusy(true);
    setBotFormError(null);
    try {
      const res = await api.updateImConfig({
        addTarget: {
          provider: botProvider,
          name: botName.trim() || `${providerLabel(botProvider)}机器人`,
          url: trimmedUrl,
          ...(botKeyword.trim() ? { keyword: botKeyword.trim() } : {}),
          ...(botSecret.trim() ? { secret: botSecret.trim() } : {}),
        },
      });
      applyPartialStatus(res.config, res.weixinLive);
      setBotName('');
      setBotUrl('');
      setBotKeyword('');
      setBotSecret('');
      setShowAddForm(false);
      onNotify(t('im.webhookSavedToast'), 'success');
    } catch (error) {
      setBotFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBotFormBusy(false);
    }
  };

  const handleToggleBot = async (targetId: string, enabled: boolean) => {
    setBusyTargetId(targetId);
    try {
      const res = await api.updateImConfig({
        patchTarget: { id: targetId, enabled },
      });
      applyPartialStatus(res.config, res.weixinLive);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusyTargetId(null);
    }
  };

  const handleRemoveBot = async (targetId: string) => {
    setBusyTargetId(targetId);
    try {
      const res = await api.updateImConfig({
        removeTargetId: targetId,
      });
      applyPartialStatus(res.config, res.weixinLive);
      onNotify(t('im.webhookRemovedToast'), 'info');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusyTargetId(null);
    }
  };

  const enabledEvents = useMemo(() => {
    const raw =
      status?.config?.weixin?.events ??
      status?.config?.targets?.[0]?.events ??
      ([...DEFAULT_RULE_EVENTS, 'light_text'] as string[]);
    return new Set(raw);
  }, [status]);

  const handleToggleRule = async (eventId: string, nextOn: boolean) => {
    setRulesBusyEvent(eventId);
    const nextSet = new Set(enabledEvents);
    if (nextOn) nextSet.add(eventId);
    else nextSet.delete(eventId);
    nextSet.add('light_text');
    try {
      const res = await api.updateImConfig({
        events: Array.from(nextSet),
      });
      applyPartialStatus(res.config, res.weixinLive);
      onNotify(t('im.rulesSavedToast'), 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setRulesBusyEvent(null);
    }
  };

  const targets = status?.config?.targets ?? [];

  const mcpHttpUrl = status?.mcp?.loopbackEndpoint || status?.mcp?.httpEndpoint || 'http://127.0.0.1:4599/api/kanban/mcp';
  const mcpStdioScript = status?.mcp?.stdioScriptPath || '~/.dsh/profiles/desktop/node_modules/dsh-kanban/bin/kanban-mcp.mjs';
  const mcpDataDir = status?.mcp?.dataDir || '~/.dsh-kanban';
  const mcpToolCount = status?.mcp?.toolCount ?? 20;

  const mcpSnippet = useMemo(() => {
    switch (mcpClient) {
      case 'claude':
        return `claude mcp add dsh-kanban -- node "${mcpStdioScript}"`;
      case 'json':
        return JSON.stringify(
          {
            mcpServers: {
              'dsh-kanban': {
                command: 'node',
                args: [mcpStdioScript],
              },
            },
          },
          null,
          2,
        );
      case 'codex':
        return `codex mcp add dsh-kanban -- node "${mcpStdioScript}"`;
      case 'http':
        return `curl -X POST ${mcpHttpUrl} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
    }
  }, [mcpClient, mcpHttpUrl, mcpStdioScript]);

  const handleCopyMcp = async () => {
    const ok = await writeClipboardText(mcpSnippet);
    if (ok) {
      setMcpCopied(true);
      onNotify(t('im.mcpCopiedToast'), 'success');
      window.setTimeout(() => setMcpCopied(false), 1800);
    } else {
      onNotify(t('workspace.copyUnavailable'), 'error');
    }
  };

  const wxBadge = (() => {
    if (wxConnected) {
      return { toneClass: 'kb-im-badge--connected', dotClass: 'kb-dot--success', text: t('im.wxBadgeConnected') };
    }
    if (wxSessionExpired || qrPhase === 'expired') {
      return { toneClass: 'kb-im-badge--warn', dotClass: 'kb-dot--warn', text: t('im.wxBadgeExpired') };
    }
    if (qrPhase === 'scaned') {
      return { toneClass: 'kb-im-badge--active', dotClass: 'kb-dot--business', text: t('im.wxBadgeScanned') };
    }
    if (qrPhase === 'wait') {
      return { toneClass: 'kb-im-badge--active', dotClass: 'kb-dot--business', text: t('im.wxBadgeWaiting') };
    }
    return { toneClass: '', dotClass: 'kb-dot--tertiary', text: t('im.wxBadgeIdle') };
  })();

  return (
    <Modal title={t('im.modalTitle')} size="md" onClose={onClose}>
      <div className="kb-im-main">
        <div className="kb-seg kb-im-tabs" role="tablist" aria-label={t('im.modalTitle')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'weixin'}
            className={`kb-seg-btn${tab === 'weixin' ? ' kb-seg-btn--active' : ''}`}
            onClick={() => {
              setTab('weixin');
              setFeedback(null);
            }}
          >
            <span
              className={`kb-dot ${wxConnected ? 'kb-dot--success' : wxSessionExpired ? 'kb-dot--warn' : 'kb-dot--tertiary'}`}
              aria-hidden="true"
            />
            <span>{t('im.tabWeixin')}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'webhook'}
            className={`kb-seg-btn${tab === 'webhook' ? ' kb-seg-btn--active' : ''}`}
            onClick={() => {
              setTab('webhook');
              setFeedback(null);
            }}
          >
            <span>{t('im.tabWebhook')}</span>
            {targets.length > 0 ? <span className="kb-im-tab-count">{targets.length}</span> : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mcp'}
            className={`kb-seg-btn${tab === 'mcp' ? ' kb-seg-btn--active' : ''}`}
            onClick={() => {
              setTab('mcp');
              setFeedback(null);
            }}
          >
            <span className="kb-dot kb-dot--success" aria-hidden="true" />
            <span>{t('im.tabMcp')}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rules'}
            className={`kb-seg-btn${tab === 'rules' ? ' kb-seg-btn--active' : ''}`}
            onClick={() => {
              setTab('rules');
              setFeedback(null);
            }}
          >
            <span>{t('im.tabRules')}</span>
          </button>
        </div>

        {tab === 'weixin' ? (
          <section className="kb-im-panel" aria-label={t('im.wxTitle')}>
            <div className="kb-im-panel__head">
              <div className="kb-im-panel__title">{t('im.wxTitle')}</div>
              <span className={`kb-im-badge ${wxBadge.toneClass}`}>
                <span className={`kb-dot ${wxBadge.dotClass}`} aria-hidden="true" />
                {wxBadge.text}
              </span>
            </div>

            {wxConnected ? (
              <>
                <dl className="kb-im-facts">
                  <dt className="kb-im-facts__dt">{t('im.wxAccountLabel')}</dt>
                  <dd className="kb-im-facts__dd">
                    <span className="kb-im-code">{wxLive?.accountId || wxLive?.userId || 'iLink Bot'}</span>
                  </dd>

                  <dt className="kb-im-facts__dt">{t('im.wxContextLabel')}</dt>
                  <dd className="kb-im-facts__dd">
                    <span
                      className={`kb-dot ${(wxLive?.contextUserCount ?? 0) > 0 ? 'kb-dot--success' : 'kb-dot--warn'}`}
                      aria-hidden="true"
                    />
                    <span>
                      {(wxLive?.contextUserCount ?? 0) > 0 ? t('im.wxContextReady') : t('im.wxContextPending')}
                    </span>
                  </dd>

                  <dt className="kb-im-facts__dt">{t('im.wxStatsLabel')}</dt>
                  <dd className="kb-im-facts__dd">
                    <span>
                      {t('im.wxStatsValue', {
                        inbound: wxLive?.inboundCount ?? 0,
                        outbound: wxLive?.outboundCount ?? 0,
                      })}
                    </span>
                  </dd>
                </dl>

                {feedback ? (
                  <div className={`kb-im-feedback${feedback.isError ? ' kb-im-feedback--error' : ''}`} role="status">
                    {feedback.text}
                  </div>
                ) : null}

                <div className="kb-im-panel__foot">
                  <button
                    type="button"
                    className="kb-btn kb-btn--sm kb-btn--outline"
                    disabled={testingTargetId === 'weixin'}
                    onClick={() => void handleSendTest('weixin')}
                  >
                    {testingTargetId === 'weixin' ? t('im.wxTesting') : t('im.wxTestBtn')}
                  </button>

                  <button
                    type="button"
                    className="kb-btn kb-btn--sm kb-btn--ghost"
                    disabled={wxLogoutBusy}
                    onClick={() => void handleLogoutWeixin()}
                  >
                    {wxLogoutBusy ? t('im.wxLoggingOut') : t('im.wxLogoutBtn')}
                  </button>
                </div>
              </>
            ) : (qrPhase === 'wait' || qrPhase === 'scaned') && qrSvg ? (
              <div className="kb-im-qr-stage">
                <div className="kb-im-qr-box">
                  <svg
                    className="kb-im-qr-svg"
                    viewBox={qrSvg.viewBox}
                    shapeRendering="crispEdges"
                    role="img"
                    aria-label={t('im.wxScanHint')}
                  >
                    <path d={qrSvg.path} fill="currentColor" />
                  </svg>
                  {qrPhase === 'scaned' ? (
                    <div className="kb-im-qr-mask">
                      <span className="kb-icon" style={{ color: 'var(--kb-status-done)' }} aria-hidden="true">
                        <IconCheckCircle />
                      </span>
                      <span className="kb-im-qr-mask__title">{t('im.wxScannedTitle')}</span>
                    </div>
                  ) : null}
                </div>

                <div className="kb-im-stage-actions">
                  <button
                    type="button"
                    className="kb-btn kb-btn--sm kb-btn--outline"
                    disabled={qrStarting}
                    onClick={() => void handleStartWeixinQr()}
                  >
                    <span className="kb-icon" aria-hidden="true">
                      <IconRefresh />
                    </span>
                    {t('im.wxRefreshQr')}
                  </button>
                  <button type="button" className="kb-btn kb-btn--sm kb-btn--ghost" onClick={handleCancelQr}>
                    {t('im.wxCancelQr')}
                  </button>
                </div>
              </div>
            ) : wxSessionExpired || qrPhase === 'expired' ? (
              <div className="kb-im-qr-stage">
                <div className="kb-im-alert">
                  <span className="kb-im-alert__title">{t('im.wxExpiredTitle')}</span>
                </div>

                {feedback ? (
                  <div className={`kb-im-feedback${feedback.isError ? ' kb-im-feedback--error' : ''}`} role="status">
                    {feedback.text}
                  </div>
                ) : null}

                <button
                  type="button"
                  className="kb-btn kb-btn--primary"
                  disabled={qrStarting}
                  onClick={() => void handleStartWeixinQr()}
                >
                  <span className="kb-icon" aria-hidden="true">
                    <IconQrCode />
                  </span>
                  {qrStarting ? t('im.wxGenerating') : t('im.wxReconnect')}
                </button>
              </div>
            ) : (
              <div className="kb-im-qr-stage">
                <div className="kb-im-qr-placeholder" aria-hidden="true">
                  <span className="kb-icon">
                    <IconQrCode />
                  </span>
                </div>

                {feedback ? (
                  <div className={`kb-im-feedback${feedback.isError ? ' kb-im-feedback--error' : ''}`} role="status">
                    {feedback.text}
                  </div>
                ) : null}

                <button
                  type="button"
                  className="kb-btn kb-btn--primary"
                  disabled={qrStarting || loadingStatus}
                  onClick={() => void handleStartWeixinQr()}
                >
                  <span className="kb-icon" aria-hidden="true">
                    <IconQrCode />
                  </span>
                  {loadingStatus ? t('common.loading') : qrStarting ? t('im.wxGenerating') : t('im.wxGenerateQr')}
                </button>
              </div>
            )}
          </section>
        ) : null}

        {tab === 'webhook' ? (
          <section className="kb-im-panel" aria-label={t('im.webhookTitle')}>
            <div className="kb-im-panel__head">
              <div className="kb-im-panel__title">{t('im.webhookTitle')}</div>
              <button
                type="button"
                className="kb-btn kb-btn--sm kb-btn--outline"
                onClick={() => {
                  setShowAddForm((prev) => !prev);
                  setBotFormError(null);
                }}
              >
                {showAddForm ? (
                  t('im.webhookCancelAdd')
                ) : (
                  <>
                    <span className="kb-icon" aria-hidden="true">
                      <IconPlus />
                    </span>
                    {t('im.webhookAddBtn')}
                  </>
                )}
              </button>
            </div>

            {showAddForm ? (
              <form className="kb-im-bot-form" onSubmit={(e) => void handleAddBotSubmit(e)}>
                <div className="kb-form__row">
                  <label className="kb-field">
                    <span className="kb-field__label">{t('im.webhookProvider')}</span>
                    <select
                      className="kb-select"
                      value={botProvider}
                      onChange={(e) => setBotProvider(e.target.value as WebhookProvider)}
                    >
                      <option value="dingtalk">{t('im.webhookProviderDingtalk')}</option>
                      <option value="feishu">{t('im.webhookProviderFeishu')}</option>
                      <option value="onebot">{t('im.webhookProviderOnebot')}</option>
                      <option value="generic">{t('im.webhookProviderGeneric')}</option>
                    </select>
                  </label>

                  <label className="kb-field">
                    <span className="kb-field__label">{t('im.webhookName')}</span>
                    <input
                      type="text"
                      className="kb-input"
                      placeholder={t('im.webhookNamePlaceholder')}
                      value={botName}
                      onChange={(e) => setBotName(e.target.value)}
                    />
                  </label>
                </div>

                <label className="kb-field">
                  <span className="kb-field__label">{t('im.webhookUrl')}</span>
                  <input
                    type="url"
                    required
                    className="kb-input"
                    placeholder={t('im.webhookUrlPlaceholder')}
                    value={botUrl}
                    onChange={(e) => setBotUrl(e.target.value)}
                  />
                </label>

                <div className="kb-form__row">
                  <label className="kb-field">
                    <span className="kb-field__label">{t('im.webhookKeyword')}</span>
                    <input
                      type="text"
                      className="kb-input"
                      placeholder={t('im.webhookKeywordPlaceholder')}
                      value={botKeyword}
                      onChange={(e) => setBotKeyword(e.target.value)}
                    />
                  </label>

                  <label className="kb-field">
                    <span className="kb-field__label">{t('im.webhookSecret')}</span>
                    <input
                      type="password"
                      className="kb-input"
                      autoComplete="off"
                      placeholder={t('im.webhookSecretPlaceholder')}
                      value={botSecret}
                      onChange={(e) => setBotSecret(e.target.value)}
                    />
                  </label>
                </div>

                {botFormError ? <div className="kb-form__error">{botFormError}</div> : null}

                <div className="kb-im-bot-form__actions">
                  <button
                    type="button"
                    className="kb-btn kb-btn--sm kb-btn--ghost"
                    disabled={botFormBusy}
                    onClick={() => setShowAddForm(false)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="kb-btn kb-btn--sm kb-btn--primary" disabled={botFormBusy}>
                    {botFormBusy ? t('im.webhookSaving') : t('im.webhookSaveBtn')}
                  </button>
                </div>
              </form>
            ) : null}

            {feedback ? (
              <div className={`kb-im-feedback${feedback.isError ? ' kb-im-feedback--error' : ''}`} role="status">
                {feedback.text}
              </div>
            ) : null}

            {targets.length === 0 ? (
              <div className="kb-im-bot-empty">{t('im.webhookEmpty')}</div>
            ) : (
              <div className="kb-im-bot-list">
                {targets.map((target) => {
                  const isBusy = busyTargetId === target.id;
                  const isTesting = testingTargetId === target.id;
                  return (
                    <div key={target.id} className="kb-im-bot-item">
                      <div className="kb-im-bot-item__top">
                        <div className="kb-im-bot-item__meta">
                          <span className="kb-tag">{providerLabel(target.provider)}</span>
                          <span className="kb-im-bot-item__name">{target.name}</span>
                          {target.keyword ? (
                            <span className="kb-tag">{t('im.webhookKeywordTag', { keyword: target.keyword })}</span>
                          ) : null}
                          {target.hasSecret ? <span className="kb-tag">{t('im.webhookSecretTag')}</span> : null}
                        </div>

                        <div className="kb-im-bot-item__actions">
                          <button
                            type="button"
                            className="kb-btn kb-btn--sm kb-btn--outline"
                            disabled={isTesting || isBusy}
                            onClick={() => void handleSendTest(target.id)}
                          >
                            {isTesting ? t('im.wxTesting') : t('im.webhookTestBtn')}
                          </button>

                          <button
                            type="button"
                            role="switch"
                            aria-checked={target.enabled}
                            aria-label={target.name}
                            className={`kb-switch${target.enabled ? ' kb-switch--on' : ''}`}
                            disabled={isBusy}
                            onClick={() => void handleToggleBot(target.id, !target.enabled)}
                          >
                            <span className="kb-switch__track" aria-hidden="true">
                              <span className="kb-switch__thumb" />
                            </span>
                          </button>

                          <button
                            type="button"
                            className="kb-btn kb-btn--icon kb-btn--sm kb-btn--ghost"
                            aria-label={t('im.webhookRemoveAria', { name: target.name })}
                            title={t('im.webhookRemoveAria', { name: target.name })}
                            disabled={isBusy}
                            onClick={() => void handleRemoveBot(target.id)}
                          >
                            <span className="kb-icon" aria-hidden="true">
                              <IconTrash />
                            </span>
                          </button>
                        </div>
                      </div>
                      <div className="kb-im-bot-item__url" title={target.urlMasked}>
                        {target.urlMasked}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        {tab === 'mcp' ? (
          <section className="kb-im-panel" aria-label={t('im.mcpTitle')}>
            <div className="kb-im-panel__head">
              <div className="kb-im-panel__title">{t('im.mcpTitle')}</div>
              <span className="kb-im-badge kb-im-badge--connected">
                <span className="kb-dot kb-dot--success" aria-hidden="true" />
                {t('im.mcpBadgeReady', { count: mcpToolCount })}
              </span>
            </div>

            <dl className="kb-im-facts">
              <dt className="kb-im-facts__dt">{t('im.mcpHttpLabel')}</dt>
              <dd className="kb-im-facts__dd">
                <code className="kb-im-code">{mcpHttpUrl}</code>
              </dd>

              <dt className="kb-im-facts__dt">{t('im.mcpStdioLabel')}</dt>
              <dd className="kb-im-facts__dd">
                <code className="kb-im-code">{`node "${mcpStdioScript}"`}</code>
              </dd>

              <dt className="kb-im-facts__dt">{t('im.mcpDataDirLabel')}</dt>
              <dd className="kb-im-facts__dd">
                <code className="kb-im-code">{mcpDataDir}</code>
              </dd>
            </dl>

            <div className="kb-im-mcp-bar">
              <div className="kb-seg" role="tablist" aria-label={t('im.mcpTitle')}>
                {MCP_CLIENTS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={mcpClient === entry.id}
                    className={`kb-seg-btn${mcpClient === entry.id ? ' kb-seg-btn--active' : ''}`}
                    onClick={() => {
                      setMcpClient(entry.id);
                      setMcpCopied(false);
                    }}
                  >
                    {t(entry.labelKey)}
                  </button>
                ))}
              </div>

              <button
                type="button"
                className="kb-btn kb-btn--sm kb-btn--outline"
                onClick={() => void handleCopyMcp()}
              >
                <span className="kb-icon" aria-hidden="true">
                  {mcpCopied ? <IconCheck /> : <IconCopy />}
                </span>
                {mcpCopied ? t('im.mcpCopiedBtn') : t('im.mcpCopyBtn')}
              </button>
            </div>

            <pre className="kb-im-codeblock">
              <code>{mcpSnippet}</code>
            </pre>
          </section>
        ) : null}

        {tab === 'rules' ? (
          <section className="kb-im-panel" aria-label={t('im.rulesTitle')}>
            <div className="kb-im-panel__head">
              <div className="kb-im-panel__title">{t('im.rulesTitle')}</div>
            </div>

            <div className="kb-im-rules">
              {RULE_ITEMS.map((rule) => {
                const checked = enabledEvents.has(rule.id);
                const busy = rulesBusyEvent === rule.id;
                return (
                  <div key={rule.id} className="kb-im-rule">
                    <span className="kb-im-rule__title">{t(rule.titleKey)}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={checked}
                      aria-label={t(rule.titleKey)}
                      className={`kb-switch${checked ? ' kb-switch--on' : ''}`}
                      disabled={busy}
                      onClick={() => void handleToggleRule(rule.id, !checked)}
                    >
                      <span className="kb-switch__track" aria-hidden="true">
                        <span className="kb-switch__thumb" />
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
