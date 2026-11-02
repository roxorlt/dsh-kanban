import { describe, expect, it } from 'vitest';
import { collectRevealablePaths, isRevealablePath } from './revealPath';

describe('collectRevealablePaths', () => {
  it('collects repo roots and worktree paths', () => {
    const paths = collectRevealablePaths([
      {
        root: '/Users/roxor/Desktop/dsh/dsh kanban',
        worktrees: [
          { path: '/Users/roxor/Desktop/dsh/dsh kanban' },
          { path: '/Users/roxor/Desktop/dsh/dsh kanban-wt/a' },
        ],
      },
    ]);
    expect(paths).toEqual(
      new Set(['/Users/roxor/Desktop/dsh/dsh kanban', '/Users/roxor/Desktop/dsh/dsh kanban-wt/a']),
    );
  });

  it('skips empty or malformed entries instead of throwing', () => {
    const paths = collectRevealablePaths([
      { root: '', worktrees: [{ path: '' }, { path: '/tmp/wt' }] },
      { root: '/repo', worktrees: [] },
    ] as unknown as Parameters<typeof collectRevealablePaths>[0]);
    expect(paths).toEqual(new Set(['/tmp/wt', '/repo']));
  });

  it('returns an empty set for missing data (loading / failed probe)', () => {
    expect(collectRevealablePaths(null).size).toBe(0);
    expect(collectRevealablePaths(undefined).size).toBe(0);
    expect(collectRevealablePaths([]).size).toBe(0);
  });
});

describe('isRevealablePath', () => {
  const allowed = new Set(['/Users/roxor/Desktop/dsh/dsh kanban', '/tmp/wt']);

  it('accepts exact known worktree paths', () => {
    expect(isRevealablePath('/Users/roxor/Desktop/dsh/dsh kanban', allowed)).toBe(true);
    expect(isRevealablePath('/tmp/wt', allowed)).toBe(true);
  });

  it('rejects unknown paths, prefixes and empty values', () => {
    expect(isRevealablePath('/Users/roxor/Desktop/dsh/dsh kanban-other', allowed)).toBe(false);
    expect(isRevealablePath('/Users/roxor/Desktop/dsh', allowed)).toBe(false);
    expect(isRevealablePath('/tmp/wt/sub', allowed)).toBe(false);
    expect(isRevealablePath('/etc', allowed)).toBe(false);
    expect(isRevealablePath('', allowed)).toBe(false);
    expect(isRevealablePath('rm -rf /', allowed)).toBe(false);
    expect(isRevealablePath('/tmp/wt ', allowed)).toBe(false);
  });

  it('is case- and trailing-slash-sensitive (paths come verbatim from the server map)', () => {
    expect(isRevealablePath('/TMP/WT', allowed)).toBe(false);
    expect(isRevealablePath('/tmp/wt/', allowed)).toBe(false);
  });
});
