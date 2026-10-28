import { describe, expect, it } from 'vitest';
import type { GitContextAvailable, GitGraphData } from '../types';
import { buildWorklineSummary } from './worklineSummary';

interface Overrides {
  current?: Partial<GitContextAvailable['current']>;
  base?: GitContextAvailable['base'];
  upstream?: GitContextAvailable['upstream'];
  graph?: GitGraphData | undefined;
  worktrees?: GitContextAvailable['worktrees'];
}

function makeGraph(overrides: Partial<GitGraphData> = {}): GitGraphData {
  return {
    refs: [
      { name: 'HEAD', kind: 'head', sha: 'a1', shortSha: 'a1' },
      { name: 'main', kind: 'branch', sha: 'a1', shortSha: 'a1', isCurrent: true },
      { name: 'feat/x', kind: 'branch', sha: 'b2', shortSha: 'b2', isCurrent: false },
    ],
    commits: [{ sha: 'a1', shortSha: 'a1', subject: 'x', authorName: 'a', committedAt: 1, parents: [] }],
    truncated: 0,
    ...overrides,
  };
}

function makeGit(overrides: Overrides = {}): GitContextAvailable {
  const graph = 'graph' in overrides ? overrides.graph : makeGraph();
  return {
    available: true,
    reason: null,
    dir: '/repo',
    repo: { name: 'repo', root: '/repo', commonDir: '/repo/.git' },
    current: {
      worktree: '/repo',
      isWorktree: false,
      isMainWorktree: true,
      branch: 'main',
      detached: false,
      sha: 'a1',
      shortSha: 'a1',
      subject: 'x',
      authorName: 'a',
      committedAt: 1,
      ...(overrides.current ?? {}),
    },
    upstream: overrides.upstream === undefined ? { ref: 'origin/main', remote: 'origin', branch: 'main', ahead: 0, behind: 0 } : overrides.upstream,
    base: overrides.base === undefined
      ? { kind: 'upstream', label: 'origin/main', branch: 'main', remoteRef: 'origin/main', ahead: 0, behind: 0, mergeBase: null, remoteAhead: 0, remoteBehind: 0 }
      : overrides.base,
    worktrees: overrides.worktrees ?? [
      { path: '/repo', branch: 'main', detached: false, sha: 'a1', shortSha: 'a1', isMain: true, isCurrent: true, aheadOfBase: 0, behindOfBase: 0 },
    ],
    commits: { ahead: [], behind: [], shared: [] },
    refs: [],
    limits: { ahead: 12, behind: 8, shared: 4, worktrees: 8 },
    ...(graph === undefined ? {} : { graph }),
  } as GitContextAvailable;
}

describe('buildWorklineSummary', () => {
  it('feature 分支：多主线 + 未关联线上', () => {
    const summary = buildWorklineSummary(makeGit({
      current: { branch: 'feat/x', isWorktree: true, worktree: '/repo/.worktrees/feat-x' },
      base: { kind: 'main', label: 'main', branch: 'main', remoteRef: 'origin/main', ahead: 3, behind: 1, mergeBase: { sha: 'm', shortSha: 'm' }, remoteAhead: 0, remoteBehind: 2 },
      upstream: null,
      worktrees: [
        { path: '/repo', branch: 'main', detached: false, sha: 'a1', shortSha: 'a1', isMain: true, isCurrent: false, aheadOfBase: 0, behindOfBase: 0 },
        { path: '/repo/.worktrees/feat-x', branch: 'feat/x', detached: false, sha: 'b2', shortSha: 'b2', isMain: false, isCurrent: true, aheadOfBase: 3, behindOfBase: 1 },
      ],
    }));
    expect(summary).toMatchObject({
      position: 'feature',
      branch: 'feat/x',
      mainBranch: 'main',
      mainRelation: 'ahead-behind',
      aheadMain: 3,
      behindMain: 1,
      remoteRelation: 'no-upstream',
      isWorktree: true,
      worktreePath: '/repo/.worktrees/feat-x',
      worktreeCount: 2,
      localBranchCount: 2,
    });
  });

  it('feature 分支：改动已并入主线（ahead=0、behind>0）', () => {
    const summary = buildWorklineSummary(makeGit({
      current: { branch: 'feat/done' },
      base: { kind: 'main', label: 'main', branch: 'main', remoteRef: 'origin/main', ahead: 0, behind: 4, mergeBase: { sha: 'm', shortSha: 'm' }, remoteAhead: 1, remoteBehind: 0 },
      upstream: { ref: 'origin/feat/done', remote: 'origin', branch: 'feat/done', ahead: 0, behind: 0 },
    }));
    expect(summary?.position).toBe('feature');
    expect(summary?.mainRelation).toBe('merged');
    expect(summary?.behindMain).toBe(4);
    expect(summary?.remoteRelation).toBe('synced');
  });

  it('就在主线上：主线关系为 main，线上关系取 upstream', () => {
    const summary = buildWorklineSummary(makeGit({
      upstream: { ref: 'origin/main', remote: 'origin', branch: 'main', ahead: 18, behind: 0 },
    }));
    expect(summary).toMatchObject({
      position: 'main',
      mainRelation: 'main',
      aheadMain: 0,
      remoteRelation: 'ahead',
      aheadUpstream: 18,
      behindUpstream: 0,
    });
  });

  it('线上关系：落后 / 分叉 / 无', () => {
    const behind = buildWorklineSummary(makeGit({
      current: { branch: 'feat/x' },
      base: { kind: 'main', label: 'main', branch: 'main', remoteRef: 'origin/main', ahead: 2, behind: 0, mergeBase: null, remoteAhead: 0, remoteBehind: 0 },
      upstream: { ref: 'origin/feat/x', remote: 'origin', branch: 'feat/x', ahead: 0, behind: 2 },
    }));
    expect(behind?.mainRelation).toBe('ahead-only');
    expect(behind?.remoteRelation).toBe('behind');

    const diverged = buildWorklineSummary(makeGit({
      current: { branch: 'feat/x' },
      base: { kind: 'main', label: 'main', branch: 'main', remoteRef: 'origin/main', ahead: 2, behind: 1, mergeBase: null, remoteAhead: 0, remoteBehind: 0 },
      upstream: { ref: 'origin/feat/x', remote: 'origin', branch: 'feat/x', ahead: 2, behind: 1 },
    }));
    expect(diverged?.remoteRelation).toBe('diverged');
  });

  it('游离 HEAD：position=detached 且 branch 为 null', () => {
    const summary = buildWorklineSummary(makeGit({
      current: { branch: null, detached: true },
      base: { kind: 'main', label: 'main', branch: 'main', remoteRef: 'origin/main', ahead: 2, behind: 1, mergeBase: null, remoteAhead: 0, remoteBehind: 0 },
      upstream: null,
    }));
    expect(summary).toMatchObject({ position: 'detached', branch: null, mainRelation: 'ahead-behind', remoteRelation: 'no-upstream' });
  });

  it('截断与计数：commitCount / commitTruncated / localBranchCount', () => {
    const summary = buildWorklineSummary(makeGit({
      graph: makeGraph({ truncated: 12 }),
    }));
    expect(summary?.commitCount).toBe(1);
    expect(summary?.commitTruncated).toBe(true);
    expect(summary?.localBranchCount).toBe(2);
    expect(summary?.worktreeCount).toBe(1);
  });

  it('没有 graph（旧服务端）返回 null', () => {
    expect(buildWorklineSummary(makeGit({ graph: undefined }))).toBeNull();
  });
});
