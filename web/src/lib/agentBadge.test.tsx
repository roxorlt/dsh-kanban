import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentBadge } from '../components/AgentBadge';
import { SessionSection } from '../components/SessionSection';
import { I18nContext, translate } from '../i18n';
import type { Card } from '../types';
import { describeCardAgent, isExternalCardAgent } from './agentBadge';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-ext0001',
    boardId: 'board-default',
    title: '外部 Agent 会话交互测试',
    summary: '',
    status: 'running',
    priority: 'high',
    labels: [],
    sessionIds: [],
    checklists: [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 2, searches: 0 },
    order: 1000,
    version: 1,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe('describeCardAgent', () => {
  it('空 agent 返回 null', () => {
    expect(describeCardAgent(undefined)).toBeNull();
    expect(describeCardAgent(null)).toBeNull();
    expect(describeCardAgent({ name: '   ' })).toBeNull();
  });

  it('将 DSH 宿主与 DeepSeek 识别为 host 并统一展示 DSH · DeepSeek', () => {
    const hostFromDeepSeek = describeCardAgent({ name: 'DeepSeek', harness: 'dsh' });
    expect(hostFromDeepSeek).toMatchObject({
      kind: 'host',
      label: 'DSH · DeepSeek',
      filterKey: 'DSH · DeepSeek',
      harness: 'dsh',
    });
    expect(isExternalCardAgent({ name: 'DeepSeek', harness: 'dsh' })).toBe(false);
    expect(hostFromDeepSeek?.searchTokens).toEqual(
      expect.arrayContaining(['DSH · DeepSeek', 'DeepSeek', 'dsh', 'deepseek']),
    );

    const hostLegacy = describeCardAgent({ name: 'DSH Agent' });
    expect(hostLegacy).toMatchObject({
      kind: 'host',
      label: 'DSH · DeepSeek',
      filterKey: 'DSH · DeepSeek',
      harness: 'dsh',
    });
  });

  it('将 Carbon / Gemini / Antigravity / Codex / Claude Code 识别为 external，并严格过滤非 http(s) url', () => {
    const carbon = describeCardAgent({
      name: 'Carbon · Gemini',
      harness: 'carbon',
      url: 'https://carbon.example/conversations/123',
    });
    expect(carbon).toMatchObject({
      kind: 'external',
      label: 'Carbon · Gemini',
      filterKey: 'Carbon · Gemini',
      harness: 'carbon',
      url: 'https://carbon.example/conversations/123',
    });
    expect(isExternalCardAgent(carbon ? { name: carbon.label, harness: carbon.harness } : null)).toBe(true);
    expect(carbon?.searchTokens).toEqual(
      expect.arrayContaining(['Carbon · Gemini', 'carbon', 'gemini']),
    );

    const unsafeUrl = describeCardAgent({
      name: 'Codex',
      harness: 'codex',
      url: 'javascript:alert(1)',
    });
    expect(unsafeUrl?.url).toBeUndefined();
  });
});

describe('AgentBadge 与 SessionSection 外部 Agent 渲染', () => {
  const i18nValue = {
    lang: 'zh' as const,
    setLang: () => undefined,
    t: (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
      translate('zh', key, vars),
  };

  it('无 agent 时不渲染任何 DOM', () => {
    expect(renderToStaticMarkup(<AgentBadge agent={undefined} />)).toBe('');
  });

  it('宿主与外部 Agent 输出可区分的语义类名与 data 属性', () => {
    const hostHtml = renderToStaticMarkup(
      <AgentBadge agent={{ name: 'DeepSeek', harness: 'dsh' }} />,
    );
    expect(hostHtml).toContain('kb-agent-badge--host');
    expect(hostHtml).toContain('data-agent-kind="host"');
    expect(hostHtml).toContain('DSH · DeepSeek');

    const extHtml = renderToStaticMarkup(
      <AgentBadge agent={{ name: 'Carbon · Gemini', harness: 'carbon' }} compact />,
    );
    expect(extHtml).toContain('kb-agent-badge--external');
    expect(extHtml).toContain('kb-agent-badge--compact');
    expect(extHtml).toContain('data-agent-kind="external"');
    expect(extHtml).toContain('Carbon · Gemini');
  });

  it('外部 Agent 进行中无本地会话时不报假警报，且渲染远程同步说明与外部会话跳转入口', () => {
    const card = makeCard({
      status: 'running',
      sessionIds: [],
      agent: {
        name: 'Carbon · Gemini',
        harness: 'carbon',
        url: 'https://carbon.example/conversations/abc',
      },
    });
    const html = renderToStaticMarkup(
      <I18nContext.Provider value={i18nValue}>
        <SessionSection
          card={card}
          sessions={[]}
          workspaces={[]}
          cards={[card]}
          embedded
          targetSessionId="__external__"
          onOpenSession={() => undefined}
          onBind={() => undefined}
          onUnbind={() => undefined}
          onSetPrimary={() => undefined}
          onCreateSession={() => undefined}
          archivedSessionIds={new Set()}
          archiveAvailable={false}
          pendingSessionIds={new Set()}
          onArchiveSession={() => undefined}
          onUnarchiveSession={() => undefined}
        />
      </I18nContext.Provider>,
    );
    expect(html).not.toContain('进行中但未关联会话');
    expect(html).toContain('kb-session__external');
    expect(html).toContain('当前由外部 Agent（Carbon · Gemini）远程跟进');
    expect(html).toContain('href="https://carbon.example/conversations/abc"');
    expect(html).toContain('打开外部会话');
    expect(html).toContain('转交本地 DSH 会话接手');
  });

  it('跨端交接卡片：历史本地 DSH 会话不标「主会话」，提供「转交接手」按钮', () => {
    const card = makeCard({
      status: 'running',
      sessionIds: ['sess-old-1'],
      agent: { name: 'Carbon · Gemini', harness: 'carbon' },
    });
    const html = renderToStaticMarkup(
      <I18nContext.Provider value={i18nValue}>
        <SessionSection
          card={card}
          sessions={[{ id: 'sess-old-1', title: '初始 DSH 讨论会话', running: false, updatedAt: 0 }]}
          workspaces={[]}
          cards={[card]}
          embedded
          targetSessionId="__external__"
          onOpenSession={() => undefined}
          onBind={() => undefined}
          onUnbind={() => undefined}
          onSetPrimary={() => undefined}
          onCreateSession={() => undefined}
          archivedSessionIds={new Set()}
          archiveAvailable={false}
          pendingSessionIds={new Set()}
          onArchiveSession={() => undefined}
          onUnarchiveSession={() => undefined}
        />
      </I18nContext.Provider>,
    );
    expect(html).toContain('历史关联的本地 DSH 会话（1）');
    expect(html).toContain('转交接手');
    expect(html).not.toContain('kb-session__primary');
  });
});
