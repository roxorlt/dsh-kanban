import { describe, expect, it } from 'vitest';
import type { Card, GitWorkspaceRepo, GitWorkspaceWorktree } from '../types';
import { normalizeGitWorkspaces } from '../api';
import {
  chunkWorkspaceDirs,
  collectWorkspaceCwds,
  countBoundSessions,
  groupCardsByWorktree,
  mergeWorkspaceResults,
} from './useWorkspaces';

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

function makeWorktree(path: string, overrides: Partial<GitWorkspaceWorktree> = {}): GitWorkspaceWorktree {
  return {
    path,
    branch: 'main',
    detached: false,
    sha: 'a1',
    shortSha: 'a1',
    isMain: false,
    isCurrent: false,
    aheadOfBase: null,
    behindOfBase: null,
    dirty: false,
    ...overrides,
  };
}

function makeRepo(root: string, worktrees: GitWorkspaceWorktree[]): GitWorkspaceRepo {
  return { root, name: root.split('/').filter(Boolean).pop() ?? root, commonDir: `${root}/.git`, mainBranch: 'main', worktrees };
}

const repoOne = makeRepo('/repo', [
  makeWorktree('/repo', { isMain: true, isCurrent: true }),
  makeWorktree('/repo/.worktrees/feat-x', { branch: 'feat/x', aheadOfBase: 2, behindOfBase: 0, dirty: true }),
  makeWorktree('/repo/.worktrees/feat-y', { branch: 'feat/y' }),
]);
const repoTwo = makeRepo('/other', [makeWorktree('/other', { isMain: true })]);

describe('collectWorkspaceCwds', () => {
  it('只取未归档、有 cwd 的卡片，trim 后去重并保持出现顺序', () => {
    const cards = [
      makeCard('a', { cwd: '/repo' }),
      makeCard('b', { cwd: '/repo' }),
      makeCard('c', { cwd: ' /other ' }),
      makeCard('d'),
      makeCard('e', { cwd: '/repo/archived', archived: true }),
    ];
    expect(collectWorkspaceCwds(cards)).toEqual(['/repo', '/other']);
  });

  it('空列表 / 全部无 cwd 返回空数组', () => {
    expect(collectWorkspaceCwds([])).toEqual([]);
    expect(collectWorkspaceCwds([makeCard('a'), makeCard('b', { cwd: '  ' })])).toEqual([]);
  });
});

describe('chunkWorkspaceDirs', () => {
  it('按 32 个一批切分（契约 §12 上限）', () => {
    const dirs = Array.from({ length: 65 }, (_, index) => `/repo/${index}`);
    expect(chunkWorkspaceDirs(dirs).map((chunk) => chunk.length)).toEqual([32, 32, 1]);
  });

  it('空列表不分批，可自定义批量大小', () => {
    expect(chunkWorkspaceDirs([])).toEqual([]);
    expect(chunkWorkspaceDirs(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });
});

describe('groupCardsByWorktree', () => {
  const cards = [
    makeCard('main-exact', { cwd: '/repo' }),
    makeCard('main-nested', { cwd: '/repo/src/deep', status: 'running' }),
    makeCard('feat-x', { cwd: '/repo/.worktrees/feat-x/src', status: 'running' }),
    makeCard('feat-x-trailing', { cwd: '/repo/.worktrees/feat-x/' }),
    makeCard('feat-y', { cwd: '/repo/.worktrees/feat-y' }),
    makeCard('other', { cwd: '/other/pkg' }),
    makeCard('no-cwd'),
    makeCard('unknown-dir', { cwd: '/tmp/nowhere' }),
    makeCard('sibling-prefix', { cwd: '/repo-other/x' }),
  ];
  const groups = groupCardsByWorktree(cards, [repoOne, repoTwo]);

  it('按 cwd 最长前缀归到工作副本（含子目录与末尾斜杠）', () => {
    const [repoA, repoB] = groups.repos;
    const [mainWt, featX, featY] = repoA!.worktrees;
    expect(mainWt?.cards.map((card) => card.id)).toEqual(['main-exact', 'main-nested']);
    expect(featX?.cards.map((card) => card.id)).toEqual(['feat-x', 'feat-x-trailing']);
    expect(featY?.cards.map((card) => card.id)).toEqual(['feat-y']);
    expect(repoB?.worktrees[0]?.cards.map((card) => card.id)).toEqual(['other']);
    expect(repoA?.cardCount).toBe(5);
    expect(repoB?.cardCount).toBe(1);
  });

  it('无 cwd / 未匹配 / 同前缀但不同目录的卡片进未归属', () => {
    expect(groups.unassigned.map((card) => card.id)).toEqual(['no-cwd', 'unknown-dir', 'sibling-prefix']);
  });

  it('汇总计数：工作副本数 / 卡片数 / 运行中卡片数', () => {
    expect(groups.worktreeCount).toBe(4);
    expect(groups.cardCount).toBe(9);
    expect(groups.runningCount).toBe(2);
  });

  it('没有仓库时所有卡片都未归属', () => {
    const empty = groupCardsByWorktree(cards, []);
    expect(empty.repos).toEqual([]);
    expect(empty.unassigned).toHaveLength(cards.length);
    expect(empty.worktreeCount).toBe(0);
  });
});

describe('countBoundSessions', () => {
  it('去重统计卡片绑定的会话数', () => {
    expect(countBoundSessions([])).toBe(0);
    const cards = [
      makeCard('a', { sessionIds: ['s1'] }),
      makeCard('b', { sessionIds: ['s1', 's2'] }),
      makeCard('c'),
    ];
    expect(countBoundSessions(cards)).toBe(2);
  });
});

describe('mergeWorkspaceResults', () => {
  it('仓库按 root 去重、工作副本按 path 去重，不可用项拼接、disabled 取或', () => {
    const first = {
      repos: [repoOne],
      unavailable: [{ dir: '/tmp/a', reason: 'not_git' as const }],
      disabled: false,
    };
    const second = {
      repos: [
        makeRepo('/repo', [makeWorktree('/repo'), makeWorktree('/repo/.worktrees/feat-z', { branch: 'feat/z' })]),
        repoTwo,
      ],
      unavailable: [{ dir: '/tmp/b', reason: 'missing' as const }],
      disabled: true,
    };
    const merged = mergeWorkspaceResults([first, second]);
    expect(merged.repos.map((repo) => repo.root)).toEqual(['/repo', '/other']);
    expect(merged.repos[0]?.worktrees.map((worktree) => worktree.path)).toEqual([
      '/repo',
      '/repo/.worktrees/feat-x',
      '/repo/.worktrees/feat-y',
      '/repo/.worktrees/feat-z',
    ]);
    expect(merged.unavailable.map((item) => item.dir)).toEqual(['/tmp/a', '/tmp/b']);
    expect(merged.disabled).toBe(true);
  });

  it('空结果合并为空', () => {
    expect(mergeWorkspaceResults([])).toEqual({ repos: [], unavailable: [], disabled: false });
  });
});

describe('normalizeGitWorkspaces', () => {
  it('repos 缺省 []；非法仓库/工作副本丢弃；字段兜底', () => {
    const result = normalizeGitWorkspaces({
      repos: [
        { root: '/repo', worktrees: [{ path: '/repo', sha: 'abc1234' }] },
        { root: '', worktrees: [] },
        { root: '/empty', worktrees: [] },
        'bad',
      ],
      unavailable: [{ dir: '/tmp/x', reason: 'not_git' }, { dir: '/tmp/y', reason: 'weird' }, 'bad'],
    });
    expect(result.repos).toHaveLength(1);
    const repo = result.repos[0]!;
    expect(repo.root).toBe('/repo');
    expect(repo.name).toBe('repo');
    expect(repo.commonDir).toBe('');
    expect(repo.mainBranch).toBeNull();
    expect(repo.worktrees[0]).toMatchObject({
      path: '/repo',
      branch: null,
      detached: false,
      sha: 'abc1234',
      shortSha: 'abc1234',
      isMain: false,
      isCurrent: false,
      aheadOfBase: null,
      behindOfBase: null,
      dirty: false,
    });
    expect(result.unavailable.map((item) => item.reason)).toEqual(['not_git', 'error']);
  });

  it('disabled 只接受显式 true', () => {
    expect(normalizeGitWorkspaces({ repos: [], disabled: true }).disabled).toBe(true);
    expect(normalizeGitWorkspaces({ repos: [], disabled: 'yes' }).disabled).toBe(false);
    expect(normalizeGitWorkspaces(null).disabled).toBe(false);
    expect(normalizeGitWorkspaces(null).repos).toEqual([]);
    expect(normalizeGitWorkspaces(null).unavailable).toEqual([]);
  });
});
