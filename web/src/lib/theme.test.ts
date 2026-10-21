import { describe, expect, it } from 'vitest';
import { nextThemePreference } from '../bridge';

describe('主题三态循环', () => {
  it('system → light → dark → system', () => {
    expect(nextThemePreference('system')).toBe('light');
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
  });
});
