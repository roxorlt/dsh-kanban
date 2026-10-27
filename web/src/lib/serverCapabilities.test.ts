import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ANSWER_MIN_SERVER_VERSION,
  compareServerVersions,
  parseServerVersion,
  supportsApprovalCustomAnswers,
} from './serverCapabilities';

describe('parseServerVersion', () => {
  it('parses plain, v-prefixed and prerelease versions', () => {
    expect(parseServerVersion('0.9.5')).toEqual([0, 9, 5]);
    expect(parseServerVersion('v0.9.5')).toEqual([0, 9, 5]);
    expect(parseServerVersion('0.10.0-rc.1')).toEqual([0, 10, 0]);
    expect(parseServerVersion('  1.2.3  ')).toEqual([1, 2, 3]);
  });

  it('returns null for missing or unparsable versions', () => {
    expect(parseServerVersion(null)).toBeNull();
    expect(parseServerVersion(undefined)).toBeNull();
    expect(parseServerVersion('')).toBeNull();
    expect(parseServerVersion('latest')).toBeNull();
    expect(parseServerVersion('0.9')).toBeNull();
  });
});

describe('compareServerVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareServerVersions([0, 9, 5], [0, 9, 5])).toBe(0);
    expect(compareServerVersions([0, 10, 0], [0, 9, 5])).toBe(1);
    expect(compareServerVersions([0, 9, 4], [0, 9, 5])).toBe(-1);
    expect(compareServerVersions([1, 0, 0], [0, 99, 99])).toBe(1);
  });
});

describe('supportsApprovalCustomAnswers', () => {
  it('treats unknown versions as supported (optimistic fallback)', () => {
    expect(CUSTOM_ANSWER_MIN_SERVER_VERSION).toEqual([0, 9, 5]);
    expect(supportsApprovalCustomAnswers(null)).toBe(true);
    expect(supportsApprovalCustomAnswers(undefined)).toBe(true);
    expect(supportsApprovalCustomAnswers('unknown')).toBe(true);
  });

  it('rejects servers older than 0.9.5', () => {
    expect(supportsApprovalCustomAnswers('0.7.0')).toBe(false);
    expect(supportsApprovalCustomAnswers('0.9.4')).toBe(false);
  });

  it('accepts 0.9.5 and newer', () => {
    expect(supportsApprovalCustomAnswers('0.9.5')).toBe(true);
    expect(supportsApprovalCustomAnswers('0.9.5-rc.1')).toBe(true);
    expect(supportsApprovalCustomAnswers('0.10.0')).toBe(true);
    expect(supportsApprovalCustomAnswers('1.0.0')).toBe(true);
  });
});
