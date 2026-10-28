import { describe, expect, it } from 'vitest';
import type { Card, GitWorkspaceRepo, GitWorkspaceWorktree } from '../types';
import { normalizeCleanupResult, normalizeGitWorkspaces } from '../api';
import {
  chunkWorkspaceDirs,
  cleanupErrorNeedsLossConfirm,
  cleanupErrorReason,
  collectWorkspaceCwds,
  countBoundSessions,
  evaluateWorktreeCleanup,
  groupCardsByWorktree,
  mergeWorkspaceResults,
  worktreeStatusBadges,
  worktreeStatusInfo,
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

// ---------------------------------------------- v0.17 Phase A / Phase B

/** 清理判定入参：工作副本字段 + 已归组的 cards。 */
function cleanupInput(
  overrides: Partial<GitWorkspaceWorktree> & { cards?: Card[] } = {},
): GitWorkspaceWorktree & { cards: Card[] } {
  return { ...makeWorktree('/repo/.worktrees/feat-x'), cards: [], ...overrides };
}

describe('worktreeStatusInfo / worktreeStatusBadges', () => {
  it('已并入 + 已同步 + 干净 → 三条中性/成功短语', () => {
    const worktree = makeWorktree('/repo/.worktrees/feat-x', {
      mergedIntoBase: true,
      upstream: { ref: 'origin/main', ahead: 0, behind: 0 },
      modifiedCount: 0,
      untrackedCount: 0,
    });
    expect(worktreeStatusInfo(worktree)).toMatchObject({
      merge: 'merged',
      aheadMain: 0,
      remote: 'synced',
      changes: 'clean',
      modifiedCount: 0,
      untrackedCount: 0,
    });
    expect(worktreeStatusBadges(worktree)).toEqual([
      { kind: 'merge', key: 'workspace.mergedIntoMain' },
      { kind: 'remote', key: 'workspace.remoteSynced' },
      { kind: 'changes', key: 'workspace.clean' },
    ]);
  });

  it('未并入（多 N）+ 没有远端 + 有未保存改动', () => {
    const worktree = makeWorktree('/repo/.worktrees/feat-x', {
      aheadOfBase: 3,
      mergedIntoBase: false,
      upstream: null,
      modifiedCount: 2,
      untrackedCount: 1,
    });
    expect(worktreeStatusInfo(worktree)).toMatchObject({
      merge: 'unmerged',
      aheadMain: 3,
      remote: 'no-upstream',
      changes: 'modified',
    });
    expect(worktreeStatusBadges(worktree)).toEqual([
      { kind: 'merge', key: 'workspace.notMerged', params: { count: 3 } },
      { kind: 'remote', key: 'workspace.remoteNone' },
      { kind: 'changes', key: 'workspace.dirty' },
    ]);
  });

  it('远端分叉（未推送 + 线上落后）与未跟踪文件', () => {
    const worktree = makeWorktree('/repo/.worktrees/feat-x', {
      mergedIntoBase: true,
      upstream: { ref: 'origin/feat-x', ahead: 2, behind: 4 },
      modifiedCount: 0,
      untrackedCount: 3,
    });
    expect(worktreeStatusInfo(worktree)).toMatchObject({
      remote: 'diverged',
      upstreamAhead: 2,
      upstreamBehind: 4,
      changes: 'untracked',
    });
    expect(worktreeStatusBadges(worktree).map((badge) => badge.key)).toEqual([
      'workspace.mergedIntoMain',
      'workspace.unpushed',
      'workspace.remoteBehind',
      'workspace.untracked',
    ]);
  });

  it('old server 兼容：缺 mergedIntoBase 用 aheadOfBase 推断，缺 upstream 不显示远端，dirty 兜底为有改动', () => {
    const oldServer = makeWorktree('/repo/.worktrees/feat-x', {
      aheadOfBase: 0,
      // mergedIntoBase / upstream / modifiedCount / untrackedCount 均缺失
      dirty: true,
    });
    expect(worktreeStatusInfo(oldServer)).toMatchObject({ merge: 'merged', remote: 'unknown', changes: 'modified' });
    expect(worktreeStatusBadges(oldServer)).toEqual([
      { kind: 'merge', key: 'workspace.mergedIntoMain' },
      { kind: 'changes', key: 'workspace.dirty' },
    ]);
  });

  it('mergedIntoBase=null（探测不到主线）不显示合并短语', () => {
    const worktree = makeWorktree('/repo/.worktrees/feat-x', {
      mergedIntoBase: null,
      aheadOfBase: null,
      upstream: { ref: 'origin/feat-x', ahead: 0, behind: 0 },
      modifiedCount: 0,
      untrackedCount: 0,
    });
    expect(worktreeStatusInfo(worktree).merge).toBe('unknown');
    expect(worktreeStatusBadges(worktree).map((badge) => badge.kind)).toEqual(['remote', 'changes']);
  });
});

describe('evaluateWorktreeCleanup', () => {
  const mergedClean = {
    mergedIntoBase: true,
    upstream: { ref: 'origin/main', ahead: 0, behind: 0 },
    modifiedCount: 0,
    untrackedCount: 0,
    dirty: false,
  };

  it('主工作副本不可清理', () => {
    const check = evaluateWorktreeCleanup(cleanupInput({ ...mergedClean, isMain: true }));
    expect(check).toMatchObject({ canCleanup: false, blocked: 'main', safe: false, needsDangerConfirm: false });
  });

  it('有运行中卡片 → 不可清理（原因：有卡片在跑）', () => {
    const check = evaluateWorktreeCleanup(
      cleanupInput({ ...mergedClean, cards: [makeCard('running', { status: 'running' })] }),
    );
    expect(check).toMatchObject({
      canCleanup: false,
      blocked: 'running',
      cardCount: 1,
      runningCardCount: 1,
    });
  });

  it('有未归档卡片占用 → 不可清理（原因：有 N 张卡片在用）', () => {
    const check = evaluateWorktreeCleanup(
      cleanupInput({ ...mergedClean, cards: [makeCard('a'), makeCard('b')] }),
    );
    expect(check).toMatchObject({ canCleanup: false, blocked: 'in-use', cardCount: 2, runningCardCount: 0 });
  });

  it('干净且已并入 → 安全可清理（不需要危险确认）', () => {
    expect(evaluateWorktreeCleanup(cleanupInput(mergedClean))).toMatchObject({
      canCleanup: true,
      blocked: null,
      safe: true,
      needsDangerConfirm: false,
    });
  });

  it('未并入 → 可清理但需要第二层危险确认', () => {
    const check = evaluateWorktreeCleanup(
      cleanupInput({ mergedIntoBase: false, aheadOfBase: 4, modifiedCount: 0, untrackedCount: 0 }),
    );
    expect(check).toMatchObject({ canCleanup: true, blocked: null, safe: false, needsDangerConfirm: true });
  });

  it('有未保存改动 / 未跟踪文件 → 需要危险确认', () => {
    expect(
      evaluateWorktreeCleanup(cleanupInput({ mergedIntoBase: true, modifiedCount: 2, untrackedCount: 0 }))
        .needsDangerConfirm,
    ).toBe(true);
    expect(
      evaluateWorktreeCleanup(cleanupInput({ mergedIntoBase: true, modifiedCount: 0, untrackedCount: 3 }))
        .needsDangerConfirm,
    ).toBe(true);
  });
});

describe('cleanupErrorReason', () => {
  it('兼容 error.code / details.reason / body.reason 三种形态', () => {
    expect(cleanupErrorReason({ code: 'WORKTREE_DIRTY' })).toBe('WORKTREE_DIRTY');
    expect(cleanupErrorReason({ code: 'CONFLICT', details: { reason: 'WORKTREE_IN_USE' } })).toBe('WORKTREE_IN_USE');
    expect(cleanupErrorReason({ reason: 'BRANCH_IN_USE' })).toBe('BRANCH_IN_USE');
  });

  it('认不出的错误码归 unknown（UI 用兜底文案），非对象也安全', () => {
    expect(cleanupErrorReason({ code: 'WHATEVER' })).toBe('unknown');
    expect(cleanupErrorReason(null)).toBe('unknown');
    expect(cleanupErrorReason('WORKTREE_UNMERGED')).toBe('unknown');
  });

  it('WORKTREE_DIRTY / WORKTREE_UNMERGED 表示需要 confirmLoss（升级危险确认）', () => {
    expect(cleanupErrorNeedsLossConfirm({ code: 'WORKTREE_DIRTY' })).toBe(true);
    expect(cleanupErrorNeedsLossConfirm({ details: { reason: 'WORKTREE_UNMERGED' } })).toBe(true);
    expect(cleanupErrorNeedsLossConfirm({ code: 'WORKTREE_IN_USE' })).toBe(false);
    expect(cleanupErrorNeedsLossConfirm({ code: 'TRASH_MOVE_FAILED' })).toBe(false);
  });

  it('服务端额外错误码（prune/删分支失败/目标不存在）也能识别', () => {
    expect(cleanupErrorReason({ code: 'WORKTREE_PRUNE_FAILED' })).toBe('WORKTREE_PRUNE_FAILED');
    expect(cleanupErrorReason({ code: 'BRANCH_DELETE_FAILED' })).toBe('BRANCH_DELETE_FAILED');
    expect(cleanupErrorReason({ code: 'NOT_FOUND' })).toBe('NOT_FOUND');
  });
});

describe('normalizeGitWorkspaces v0.17 字段', () => {
  it('归一化 Phase A 新字段', () => {
    const result = normalizeGitWorkspaces({
      repos: [
        {
          root: '/repo',
          worktrees: [
            {
              path: '/repo/.worktrees/feat-x',
              mergedIntoBase: false,
              upstream: { ref: 'origin/feat-x', ahead: 2, behind: -1 },
              modifiedCount: 3,
              untrackedCount: 5,
              locked: true,
              prunable: false,
              lastCommitAt: '2026-10-28T17:01:26+08:00',
            },
          ],
        },
      ],
    });
    expect(result.repos[0]?.worktrees[0]).toMatchObject({
      mergedIntoBase: false,
      upstream: { ref: 'origin/feat-x', ahead: 2, behind: 0 },
      modifiedCount: 3,
      untrackedCount: 5,
      locked: true,
      prunable: false,
      lastCommitAt: '2026-10-28T17:01:26+08:00',
    });
  });

  it('旧服务端缺字段时保持 undefined（前端据此显示「未知」而不谎报）', () => {
    const worktree = normalizeGitWorkspaces({
      repos: [{ root: '/repo', worktrees: [{ path: '/repo' }] }],
    }).repos[0]?.worktrees[0];
    expect(worktree?.mergedIntoBase).toBeUndefined();
    expect(worktree?.upstream).toBeUndefined();
    expect(worktree?.modifiedCount).toBeUndefined();
    expect(worktree?.untrackedCount).toBeUndefined();
    expect(worktree?.locked).toBeUndefined();
  });

  it('upstream=null（没有远端）保留 null；非法 upstream 归 null', () => {
    const [noRemote, broken] = normalizeGitWorkspaces({
      repos: [
        {
          root: '/repo',
          worktrees: [
            { path: '/repo/.worktrees/a', upstream: null },
            { path: '/repo/.worktrees/b', upstream: { ahead: 1 } },
          ],
        },
      ],
    }).repos[0]!.worktrees;
    expect(noRemote?.upstream).toBeNull();
    expect(broken?.upstream).toBeNull();
  });
});

describe('normalizeCleanupResult', () => {
  it('归一化清理结果并对缺省值兜底', () => {
    expect(normalizeCleanupResult(null)).toEqual({
      repoRoot: '',
      worktreePath: '',
      trashedTo: '',
      branchName: null,
      branchDeleted: false,
      trashRetentionDays: 7,
    });
    expect(
      normalizeCleanupResult({
        repoRoot: '/repo',
        worktreePath: '/repo/.worktrees/feat-x',
        trashedTo: '/Users/x/.dsh-kanban/trash/20261028-repo-feat-x',
        branchName: 'feat/x',
        branchDeleted: true,
        trashRetentionDays: 7,
      }),
    ).toEqual({
      repoRoot: '/repo',
      worktreePath: '/repo/.worktrees/feat-x',
      trashedTo: '/Users/x/.dsh-kanban/trash/20261028-repo-feat-x',
      branchName: 'feat/x',
      branchDeleted: true,
      trashRetentionDays: 7,
    });
  });

  it('branchName 缺失归 null、非法 retention 回落 7 天', () => {
    const result = normalizeCleanupResult({ branchName: null, branchDeleted: false, trashRetentionDays: 0 });
    expect(result.branchName).toBeNull();
    expect(result.trashRetentionDays).toBe(7);
  });
});

describe('groupCardsByWorktree · dirs 精确归组（v0.17 契约）', () => {
  it('优先用 worktrees[].dirs 原文精确匹配，其次才用最长前缀', () => {
    const repo = makeRepo('/repo', [
      makeWorktree('/repo/.worktrees/feat-x', { branch: 'feat/x', dirs: ['/tmp/linked-x'] }),
    ]);
    const groups = groupCardsByWorktree(
      [makeCard('linked', { cwd: '/tmp/linked-x' }), makeCard('nested', { cwd: '/repo/.worktrees/feat-x/src' })],
      [repo],
    );
    expect(groups.repos[0]?.worktrees[0]?.cards.map((card) => card.id)).toEqual(['linked', 'nested']);
    expect(groups.unassigned).toEqual([]);
  });
});
