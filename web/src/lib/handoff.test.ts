import { describe, expect, it } from 'vitest';
import { formatHandoffCopy, formatHandoffPrompt } from './handoff';

describe('交接摘要文本', () => {
  it('启动提示块：summary + 可选后续，空摘要返回空串', () => {
    expect(formatHandoffPrompt({ summary: '上下文', nextSteps: '下一步', at: 1 })).toBe(
      '【交接摘要】\n上下文\n后续：下一步',
    );
    expect(formatHandoffPrompt({ summary: ' 上下文 ', at: 1 })).toBe('【交接摘要】\n上下文');
    expect(formatHandoffPrompt({ summary: '   ', nextSteps: 'x', at: 1 })).toBe('');
    expect(formatHandoffPrompt(undefined)).toBe('');
  });

  it('复制文本包含摘要与后续', () => {
    expect(formatHandoffCopy({ summary: '摘要', at: 1 })).toBe('摘要');
    expect(formatHandoffCopy({ summary: '摘要', nextSteps: '下一步', at: 1 })).toBe('摘要\n\n下一步');
  });
});
