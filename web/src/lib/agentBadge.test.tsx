import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentBadge } from '../components/AgentBadge';
import { describeCardAgent } from './agentBadge';

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

  it('将 Carbon / Gemini / Antigravity / Codex / Claude Code 识别为 external', () => {
    const carbon = describeCardAgent({ name: 'Carbon · Gemini', harness: 'carbon' });
    expect(carbon).toMatchObject({
      kind: 'external',
      label: 'Carbon · Gemini',
      filterKey: 'Carbon · Gemini',
      harness: 'carbon',
    });
    expect(carbon?.searchTokens).toEqual(
      expect.arrayContaining(['Carbon · Gemini', 'carbon', 'gemini']),
    );

    const legacyAntigravity = describeCardAgent({ name: 'Antigravity', harness: 'antigravity' });
    expect(legacyAntigravity).toMatchObject({
      kind: 'external',
      label: 'Carbon · Gemini',
      filterKey: 'Carbon · Gemini',
      harness: 'antigravity',
    });

    const codex = describeCardAgent({ name: 'Codex', harness: 'codex' });
    expect(codex).toMatchObject({
      kind: 'external',
      label: 'Codex',
      filterKey: 'Codex',
      harness: 'codex',
    });
  });
});

describe('AgentBadge 组件渲染', () => {
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
});
