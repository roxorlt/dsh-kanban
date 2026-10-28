import { describe, expect, it } from 'vitest';
import type { GitContextAvailable, GitGraphData } from '../types';
import { buildWorklineStatus, buildWorklineSummary } from './worklineSummary';
import type { WorklineStatusInput } from './worklineSummary';
import { chunkWorklineDirs, collectWorklineCwds, worklineStatusFromSummary } from './useWorklineStatuses';
import { normalizeGitSummaries } from '../api';
import type { Card } from '../types';

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

const statusInput = (overrides: Partial<WorklineStatusInput> = {}): WorklineStatusInput => ({
  branch: 'feat/x',
  detached: false,
  mainBranch: 'main',
  base: { kind: 'main', ahead: 0, behind: 0 },
  upstream: { ahead: 0, behind: 0 },
  ...overrides,
});

describe('buildWorklineStatus', () => {
  it('位置分类：主线（分支名===主分支 / base.kind=upstream）/ feature / detached', () => {
    expect(buildWorklineStatus(statusInput({ branch: 'main' })).position).toBe('main');
    expect(
      buildWorklineStatus(statusInput({ branch: 'main', base: { kind: 'upstream', ahead: 2, behind: 0 } })).position,
    ).toBe('main');
    expect(buildWorklineStatus(statusInput()).position).toBe('feature');
    expect(buildWorklineStatus(statusInput({ branch: null, detached: true })).position).toBe('detached');
  });

  it('与主线的分类：same / merged / ahead-only / ahead-behind / main（计数透传）', () => {
    expect(buildWorklineStatus(statusInput()).mainRelation).toBe('same');
    expect(buildWorklineStatus(statusInput({ base: { kind: 'main', ahead: 0, behind: 3 } })).mainRelation).toBe('merged');
    expect(buildWorklineStatus(statusInput({ base: { kind: 'main', ahead: 4, behind: 0 } })).mainRelation).toBe('ahead-only');
    const aheadBehind = buildWorklineStatus(statusInput({ base: { kind: 'main', ahead: 4, behind: 3 } }));
    expect(aheadBehind.mainRelation).toBe('ahead-behind');
    expect(aheadBehind.aheadMain).toBe(4);
    expect(aheadBehind.behindMain).toBe(3);
    const onMain = buildWorklineStatus(statusInput({ branch: 'main', base: { kind: 'upstream', ahead: 5, behind: 0 } }));
    expect(onMain.mainRelation).toBe('main');
    expect(onMain.aheadMain).toBe(5);
  });

  it('与线上的分类：no-upstream / synced / ahead / behind / diverged', () => {
    expect(buildWorklineStatus(statusInput({ upstream: null })).remoteRelation).toBe('no-upstream');
    expect(buildWorklineStatus(statusInput()).remoteRelation).toBe('synced');
    expect(buildWorklineStatus(statusInput({ upstream: { ahead: 3, behind: 0 } })).remoteRelation).toBe('ahead');
    expect(buildWorklineStatus(statusInput({ upstream: { ahead: 0, behind: 2 } })).remoteRelation).toBe('behind');
    const diverged = buildWorklineStatus(statusInput({ upstream: { ahead: 3, behind: 2 } }));
    expect(diverged.remoteRelation).toBe('diverged');
    expect(diverged.aheadUpstream).toBe(3);
    expect(diverged.behindUpstream).toBe(2);
  });

  it('base / upstream 缺失或负数时按 0 降级，不出现负计数', () => {
    const status = buildWorklineStatus({
      branch: 'feat/x',
      detached: false,
      mainBranch: null,
      base: { kind: 'main', ahead: -2, behind: -1 },
      upstream: null,
    });
    expect(status.position).toBe('feature');
    expect(status.aheadMain).toBe(0);
    expect(status.behindMain).toBe(0);
    expect(status.remoteRelation).toBe('no-upstream');
  });
});

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    boardId: 'board',
    title: id,
    summary: '',
    status: 'backlog',
    priority: 'none',
    labels: [],
    sessionIds: [],
    checklists: [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0 },
    order: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Card;
}

describe('collectWorklineCwds', () => {
  it('只取未归档、有 cwd 的卡片，cwd 去重并保持出现顺序', () => {
    const cards = [
      makeCard('a', { cwd: '/repo/a' }),
      makeCard('b', { cwd: '/repo/a' }),
      makeCard('c', { cwd: ' /repo/b ' }),
      makeCard('d'),
      makeCard('e', { cwd: '/repo/c', archived: true }),
    ];
    expect(collectWorklineCwds(cards)).toEqual(['/repo/a', '/repo/b']);
  });

  it('没有卡片/全部无 cwd 时返回空列表', () => {
    expect(collectWorklineCwds([])).toEqual([]);
    expect(collectWorklineCwds([makeCard('a'), makeCard('b', { cwd: '' })])).toEqual([]);
  });
});

describe('chunkWorklineDirs', () => {
  it('按 32 个一批切分（契约上限）', () => {
    const dirs = Array.from({ length: 65 }, (_, index) => `/repo/${index}`);
    const chunks = chunkWorklineDirs(dirs);
    expect(chunks.map((chunk) => chunk.length)).toEqual([32, 32, 1]);
    expect(chunks[2]).toEqual(['/repo/64']);
  });

  it('空列表不分批，可自定义批量大小', () => {
    expect(chunkWorklineDirs([])).toEqual([]);
    expect(chunkWorklineDirs(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });
});

describe('worklineStatusFromSummary', () => {
  it('非 git 仓库 / 无 cwd → undefined（徽标不显示）；其余失败 → null（灰色未知）', () => {
    expect(worklineStatusFromSummary({ available: false, reason: 'not_git' })).toBeUndefined();
    expect(worklineStatusFromSummary({ available: false, reason: 'no_cwd' })).toBeUndefined();
    expect(worklineStatusFromSummary({ available: false, reason: 'timeout' })).toBeNull();
    expect(worklineStatusFromSummary({ available: false, reason: 'missing' })).toBeNull();
    expect(worklineStatusFromSummary({ available: false, reason: 'forbidden' })).toBeNull();
  });

  it('available:true → 与详情同一套分类', () => {
    const status = worklineStatusFromSummary({
      available: true,
      dir: '/repo',
      branch: 'feat/x',
      detached: false,
      mainBranch: 'main',
      base: { kind: 'main', ahead: 2, behind: 1 },
      upstream: { ref: 'origin/feat/x', ahead: 1, behind: 0 },
      isWorktree: true,
      worktreePath: '/repo/.worktrees/feat-x',
    });
    expect(status).toMatchObject({
      position: 'feature',
      branch: 'feat/x',
      mainRelation: 'ahead-behind',
      aheadMain: 2,
      behindMain: 1,
      remoteRelation: 'ahead',
      aheadUpstream: 1,
    });
  });
});

describe('normalizeGitSummaries', () => {
  it('按请求原文 key 保留；不可用原因归并；缺字段兜底', () => {
    const summaries = normalizeGitSummaries({
      '/repo/a': {
        available: true,
        dir: '/repo/a',
        branch: 'main',
        detached: false,
        mainBranch: 'main',
        base: { kind: 'main', ahead: -1, behind: 2 },
        upstream: null,
        isWorktree: false,
        worktreePath: '/repo/a',
      },
      '/repo/b': { available: false, reason: 'forbidden' },
      '/repo/c': { available: false, reason: 'weird' },
      '/repo/d': 'bad',
      '': { available: true },
    });
    expect(summaries['/repo/a']).toMatchObject({
      available: true,
      branch: 'main',
      base: { kind: 'main', ahead: 0, behind: 2 },
      upstream: null,
      isWorktree: false,
    });
    expect(summaries['/repo/b']).toEqual({ available: false, reason: 'forbidden' });
    expect(summaries['/repo/c']).toEqual({ available: false, reason: 'error' });
    expect(summaries['/repo/d']).toEqual({ available: false, reason: 'error' });
    expect(summaries['']).toBeUndefined();
  });

  it('非对象输入返回空 map', () => {
    expect(normalizeGitSummaries(null)).toEqual({});
    expect(normalizeGitSummaries(undefined)).toEqual({});
    expect(normalizeGitSummaries([])).toEqual({});
  });
});
