import type { CardAgent } from '../types';

export type AgentKind = 'host' | 'external';

export interface AgentBadgeDescriptor {
  kind: AgentKind;
  /** 徽章与筛选菜单统一展示的短标签（如 `DSH · DeepSeek`、`Carbon · Gemini`、`Codex`） */
  label: string;
  /** 筛选分组键，与展示标签保持一致，避免同一 Agent 的历史别名拆成两项 */
  filterKey: string;
  /** 归一化后的 harness 标识（`dsh` / `carbon` / `codex` 等） */
  harness: string;
  /** 经过 http/https 协议校验的外部会话链接（可选） */
  url?: string;
  /** 供全文搜索匹配的词条集合 */
  searchTokens: string[];
}

const HOST_HARNESSES = new Set(['dsh', 'deepseek']);
const CARBON_HARNESSES = new Set(['carbon', 'gemini', 'antigravity']);
const GENERIC_EXTERNAL_NAMES = new Set([
  'antigravity',
  'carbon',
  'gemini',
  'cloud mcp agent',
  'mcp agent',
]);

function sanitizeExternalAgentUrl(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function inferHarness(name: string, rawHarness?: string): string {
  const explicit = (rawHarness ?? '').trim().toLowerCase();
  if (explicit) return explicit;
  const lower = name.toLowerCase();
  if (
    lower === 'deepseek' ||
    lower === 'dsh agent' ||
    lower === 'dsh' ||
    lower.startsWith('dsh ') ||
    lower.startsWith('dsh·') ||
    lower.startsWith('dsh ·') ||
    lower.startsWith('deepseek')
  ) {
    return 'dsh';
  }
  if (lower.includes('carbon') || lower.includes('gemini') || lower.includes('antigravity')) {
    return 'carbon';
  }
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('cursor')) return 'cursor';
  return 'external';
}

/**
 * 将 `card.agent` 解析为宿主（`DSH · DeepSeek`）vs 外部 Harness（`Carbon · Gemini` / `Codex` 等）描述。
 * 没有任何有效 `agent.name` 的历史卡片返回 `null`（不渲染空壳徽章）。
 */
export function describeCardAgent(agent?: CardAgent | null): AgentBadgeDescriptor | null {
  const rawName = agent?.name?.trim() ?? '';
  const rawHarness = agent?.harness?.trim() ?? '';
  if (!rawName && !rawHarness) return null;

  const harness = inferHarness(rawName, rawHarness);
  const kind: AgentKind = HOST_HARNESSES.has(harness) ? 'host' : 'external';
  const lowerName = rawName.toLowerCase();
  const safeUrl = sanitizeExternalAgentUrl(agent?.url);

  let label = rawName;
  if (kind === 'host') {
    if (!rawName || lowerName === 'deepseek' || lowerName === 'dsh agent' || lowerName === 'dsh') {
      label = 'DSH · DeepSeek';
    }
  } else if (CARBON_HARNESSES.has(harness)) {
    if (!rawName || GENERIC_EXTERNAL_NAMES.has(lowerName)) {
      label = 'Carbon · Gemini';
    }
  } else if (!rawName) {
    if (harness === 'codex') label = 'Codex';
    else if (harness === 'claude-code' || harness === 'claude') label = 'Claude Code';
    else if (harness === 'cursor') label = 'Cursor';
    else label = harness;
  }

  const tokenSet = new Set<string>();
  for (const part of [label, rawName, rawHarness, harness]) {
    const trimmed = part.trim();
    if (trimmed) tokenSet.add(trimmed);
  }
  if (kind === 'host') {
    tokenSet.add('dsh');
    tokenSet.add('deepseek');
  } else if (CARBON_HARNESSES.has(harness) || label.toLowerCase().includes('carbon')) {
    tokenSet.add('carbon');
    tokenSet.add('gemini');
  }

  return {
    kind,
    label,
    filterKey: label,
    harness,
    ...(safeUrl ? { url: safeUrl } : {}),
    searchTokens: [...tokenSet],
  };
}

export function isExternalCardAgent(agent?: CardAgent | null): boolean {
  return describeCardAgent(agent)?.kind === 'external';
}
