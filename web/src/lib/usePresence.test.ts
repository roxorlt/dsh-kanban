import { describe, expect, it } from 'vitest';
import { presenceExitMs } from './usePresence';

describe('presence exit delay', () => {
  it('keeps the exit window when motion is allowed', () => {
    expect(presenceExitMs(140, false)).toBe(140);
    expect(presenceExitMs(180, false)).toBe(180);
  });

  it('collapses movement exits to zero under reduced motion', () => {
    expect(presenceExitMs(140, true)).toBe(0);
    expect(presenceExitMs(180, true)).toBe(0);
    expect(presenceExitMs(220, true)).toBe(0);
  });

  it('keeps an opacity-only fade window under reduced motion when asked', () => {
    expect(presenceExitMs(140, true, true)).toBe(120);
    expect(presenceExitMs(60, true, true)).toBe(60);
    // 非 RM 下 keep 选项不改变原值
    expect(presenceExitMs(140, false, true)).toBe(140);
  });

  it('treats non-positive or invalid durations as instant', () => {
    expect(presenceExitMs(0, false)).toBe(0);
    expect(presenceExitMs(-10, false)).toBe(0);
    expect(presenceExitMs(Number.NaN, false)).toBe(0);
  });
});
