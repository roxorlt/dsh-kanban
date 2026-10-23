import type { Handoff } from '../types';

/** 启动提示里拼接的交接摘要块（无 summary 时返回空串）。 */
export function formatHandoffPrompt(handoff: Handoff | undefined): string {
  const summary = handoff?.summary?.trim() ?? '';
  if (!summary) return '';
  const nextSteps = handoff?.nextSteps?.trim();
  return `【交接摘要】\n${summary}${nextSteps ? `\n后续：${nextSteps}` : ''}`;
}

/** 详情抽屉「复制交接摘要」的文本。 */
export function formatHandoffCopy(handoff: Handoff): string {
  const parts = [handoff.summary.trim()];
  if (handoff.nextSteps?.trim()) parts.push(`${handoff.nextSteps.trim()}`);
  return parts.join('\n\n');
}
