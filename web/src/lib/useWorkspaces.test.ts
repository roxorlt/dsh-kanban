import { describe, expect, it } from 'vitest';
import type { Card, GitWorkspaceRepo, GitWorkspaceWorktree, SessionRow } from '../types';
import {
  normalizeCleanupResult,
  normalizeGitTrash,
  normalizeGitWorkspaces,
  normalizePruneResult,
  normalizeTrashRestore,
} from '../api';
import {
  chunkWorkspaceDirs,
  cleanupErrorNeedsLossConfirm,
  cleanupErrorReason,
  collectRunningSessionCwds,
  collectWorkspaceCwds,
  countBoundSessions,
  evaluateWorktreeCleanup,
  findWorktreeForCwd,
  formatLastCommitRelative,
  groupCardsByWorktree,
  mergeWorkspaceResults,
  parseCommitTimestamp,
  previewWorkspaceCards,
  pruneErrorReason,
  selectWorkspaceCards,
  sortRepoGroups,
  sortWorktreeGroups,
  splitRepoWorktrees,
  trashErrorReason,
  worktreeStatusBadges,
  worktreeStatusInfo,
} from './useWorkspaces';
import type { WorkspaceRepoGroup, WorkspaceWorktreeGroup } from './useWorkspaces';

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

/** v0.21.0 #14：会话 cwd 兜底归属用的 SessionRow。 */
function makeSession(id: string, cwd?: string): SessionRow {
  return { id, title: id, running: false, updatedAt: 0, ...(cwd === undefined ? {} : { cwd }) };
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

  it('有未完成卡片占用 → 不可清理（原因：有 N 张卡片在用）', () => {
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

// ------------------------------------------------ v0.18 回收站 + P1 精修

/** 排序/分组用：工作副本 + 已归组卡片。 */
function groupWorktree(
  path: string,
  overrides: Partial<GitWorkspaceWorktree> & { cards?: Card[] } = {},
): WorkspaceWorktreeGroup {
  return { ...makeWorktree(path), cards: [], ...overrides };
}

function makeRepoGroup(root: string, worktrees: WorkspaceWorktreeGroup[]): WorkspaceRepoGroup {
  return {
    root,
    name: root.split('/').filter(Boolean).pop() ?? root,
    commonDir: `${root}/.git`,
    mainBranch: 'main',
    worktrees,
  cardCount: worktrees.reduce((total, worktree) => total + worktree.cards.length, 0),
  };
}

describe('collectRunningSessionCwds', () => {
  it('只收 running 且有 cwd 的会话，trim 后去重', () => {
    expect(
      collectRunningSessionCwds([
        { running: true, cwd: '/repo/.worktrees/feat-x ' },
        { running: true, cwd: '/repo/.worktrees/feat-x' },
        { running: false, cwd: '/repo/.worktrees/feat-y' },
        { running: true },
        { running: true, cwd: '   ' },
      ]),
    ).toEqual(['/repo/.worktrees/feat-x']);
  });

  it('空列表返回空数组', () => {
    expect(collectRunningSessionCwds([])).toEqual([]);
  });
});

describe('evaluateWorktreeCleanup · 运行中会话（客户端安全层）', () => {
  const mergedClean = {
    mergedIntoBase: true,
    modifiedCount: 0,
    untrackedCount: 0,
    dirty: false,
  };

  it('运行中会话 cwd 落在工作副本内（含子目录）→ 禁止清理并优先提示会话', () => {
    const check = evaluateWorktreeCleanup(cleanupInput(mergedClean), {
      sessionCwds: ['/repo/.worktrees/feat-x/web/src'],
    });
    expect(check).toMatchObject({ canCleanup: false, blocked: 'session', runningSessionCount: 1 });
  });

  it('会话在别的工作副本里不影响清理', () => {
    const check = evaluateWorktreeCleanup(cleanupInput(mergedClean), {
      sessionCwds: ['/repo/.worktrees/other-worktree'],
    });
    expect(check).toMatchObject({ canCleanup: true, blocked: null, runningSessionCount: 0 });
  });

  it('阻塞原因优先级：主工作副本 > 会话 > 卡片在跑 > 卡片占用', () => {
    const session = { sessionCwds: ['/repo/.worktrees/feat-x'] };
    expect(
      evaluateWorktreeCleanup(cleanupInput({ ...mergedClean, isMain: true }), session).blocked,
    ).toBe('main');
    expect(
      evaluateWorktreeCleanup(
        cleanupInput({ ...mergedClean, cards: [makeCard('running', { status: 'running' })] }),
        session,
      ).blocked,
    ).toBe('session');
    expect(
      evaluateWorktreeCleanup(cleanupInput({ ...mergedClean, cards: [makeCard('idle')] }), session).blocked,
    ).toBe('session');
  });
});

describe('sortWorktreeGroups / sortRepoGroups / splitRepoWorktrees', () => {
  const mainWt = groupWorktree('/repo', { isMain: true, lastCommitAt: '2026-10-01T00:00:00+08:00' });
  const runningWt = groupWorktree('/repo/.worktrees/running', {
    cards: [makeCard('r1', { status: 'running' })],
    lastCommitAt: '2026-10-10T00:00:00+08:00',
  });
  const dirtyWt = groupWorktree('/repo/.worktrees/dirty', {
    modifiedCount: 2,
    lastCommitAt: '2026-10-05T00:00:00+08:00',
  });
  const cardsWt = groupWorktree('/repo/.worktrees/cards', {
    cards: [makeCard('c1'), makeCard('c2')],
    lastCommitAt: '2026-10-02T00:00:00+08:00',
  });
  const idleNewWt = groupWorktree('/repo/.worktrees/idle-new', {
    lastCommitAt: '2026-10-28T00:00:00+08:00',
  });
  const idleOldWt = groupWorktree('/repo/.worktrees/idle-old', {
    lastCommitAt: '2026-10-20T00:00:00+08:00',
  });

  it('工作副本排序：主副本固定第一，其余 running > 有改动 > 有卡片 > 最近提交新→旧', () => {
    const sorted = sortWorktreeGroups([idleOldWt, cardsWt, mainWt, idleNewWt, dirtyWt, runningWt]);
    expect(sorted.map((worktree) => worktree.path)).toEqual([
      '/repo',
      '/repo/.worktrees/running',
      '/repo/.worktrees/dirty',
      '/repo/.worktrees/cards',
      '/repo/.worktrees/idle-new',
      '/repo/.worktrees/idle-old',
    ]);
  });

  it('工作副本排序：同条件按分支名兜底', () => {
    const beta = groupWorktree('/repo/.worktrees/beta', { branch: 'feat/beta', lastCommitAt: null });
    const alpha = groupWorktree('/repo/.worktrees/alpha', { branch: 'feat/alpha', lastCommitAt: null });
    expect(sortWorktreeGroups([beta, alpha]).map((worktree) => worktree.branch)).toEqual([
      'feat/alpha',
      'feat/beta',
    ]);
  });

  it('仓库排序：running 卡片 > 有改动 > 有卡片 > 名称', () => {
    const repoRunning = makeRepoGroup('/repo-running', [
      groupWorktree('/repo-running', { cards: [makeCard('r', { status: 'running' })] }),
    ]);
    const repoDirty = makeRepoGroup('/repo-dirty', [
      groupWorktree('/repo-dirty', { modifiedCount: 1 }),
    ]);
    const repoCards = makeRepoGroup('/repo-cards', [
      groupWorktree('/repo-cards', { cards: [makeCard('a'), makeCard('b')] }),
    ]);
    const repoEmpty = makeRepoGroup('/repo-empty', [groupWorktree('/repo-empty')]);
    const sorted = sortRepoGroups([repoEmpty, repoCards, repoDirty, repoRunning]);
    expect(sorted.map((repo) => repo.name)).toEqual(['repo-running', 'repo-dirty', 'repo-cards', 'repo-empty']);
  });

  it('splitRepoWorktrees：主副本恒为 main，0 卡片的非主副本进 idle', () => {
    const split = splitRepoWorktrees([mainWt, runningWt, dirtyWt, idleNewWt]);
    expect(split.main.map((worktree) => worktree.path)).toEqual(['/repo']);
    expect(split.active.map((worktree) => worktree.path)).toEqual(['/repo/.worktrees/running']);
    expect(split.idle.map((worktree) => worktree.path)).toEqual([
      '/repo/.worktrees/dirty',
      '/repo/.worktrees/idle-new',
    ]);
  });
});

describe('previewWorkspaceCards', () => {
  const many = Array.from({ length: 7 }, (_, index) => makeCard(`card-${index}`));

  it('默认只展示前 5 张，并返回折叠数量', () => {
    const preview = previewWorkspaceCards(many);
    expect(preview.visible.map((card) => card.id)).toEqual([
      'card-0',
      'card-1',
      'card-2',
      'card-3',
      'card-4',
    ]);
    expect(preview.hiddenCount).toBe(2);
  });

  it('不超过上限时不折叠；可自定义上限', () => {
    expect(previewWorkspaceCards(many.slice(0, 5)).hiddenCount).toBe(0);
    expect(previewWorkspaceCards(many.slice(0, 4)).visible).toHaveLength(4);
    expect(previewWorkspaceCards(many, 2)).toMatchObject({ visible: many.slice(0, 2), hiddenCount: 5 });
  });
});

describe('selectWorkspaceCards', () => {
  const filtered = [makeCard('f1')];
  const all = [makeCard('f1'), makeCard('a2')];

  it('filtered 返回当前筛选结果，all 返回全部未归档卡片（均为新数组）', () => {
    expect(selectWorkspaceCards('filtered', filtered, all).map((card) => card.id)).toEqual(['f1']);
    expect(selectWorkspaceCards('all', filtered, all).map((card) => card.id)).toEqual(['f1', 'a2']);
    expect(selectWorkspaceCards('all', filtered, all)).not.toBe(all);
  });
});

describe('parseCommitTimestamp / formatLastCommitRelative', () => {
  const now = Date.parse('2026-10-28T12:00:00+08:00');

  it('解析 ISO 时间；缺失/非法返回 null', () => {
    expect(parseCommitTimestamp('2026-10-28T11:00:00+08:00')).toBe(
      Date.parse('2026-10-28T11:00:00+08:00'),
    );
    expect(parseCommitTimestamp(null)).toBeNull();
    expect(parseCommitTimestamp(undefined)).toBeNull();
    expect(parseCommitTimestamp('')).toBeNull();
    expect(parseCommitTimestamp('not-a-date')).toBeNull();
  });

  it('最近提交相对时间（zh/en）；无数据返回 null', () => {
    expect(formatLastCommitRelative('2026-10-26T12:00:00+08:00', now, 'zh')).toBe('2 天前');
    expect(formatLastCommitRelative('2026-10-26T12:00:00+08:00', now, 'en')).toBe('2d ago');
    expect(formatLastCommitRelative(null, now, 'zh')).toBeNull();
    expect(formatLastCommitRelative('bad', now, 'zh')).toBeNull();
  });
});

describe('trashErrorReason', () => {
  it('识别回收站错误码（error.code / details.reason / body.reason）', () => {
    expect(trashErrorReason({ code: 'RESTORE_PATH_EXISTS' })).toBe('RESTORE_PATH_EXISTS');
    expect(trashErrorReason({ code: 'CONFLICT', details: { reason: 'RESTORE_SHA_MISSING' } })).toBe(
      'RESTORE_SHA_MISSING',
    );
    expect(trashErrorReason({ reason: 'NOT_FOUND' })).toBe('NOT_FOUND');
    expect(trashErrorReason({ code: 'RESTORE_FAILED' })).toBe('RESTORE_FAILED');
    expect(trashErrorReason({ code: 'TRASH_DELETE_FAILED' })).toBe('TRASH_DELETE_FAILED');
  });

  it('认不出/非对象归 unknown', () => {
    expect(trashErrorReason({ code: 'WHAT' })).toBe('unknown');
    expect(trashErrorReason(null)).toBe('unknown');
    expect(trashErrorReason('RESTORE_SHA_MISSING')).toBe('unknown');
  });
});

describe('normalizeGitTrash / normalizeTrashRestore', () => {
  it('回收站列表：兼容 entries 字段与裸数组，丢弃无 id 条目，名称按路径兜底', () => {
    const result = normalizeGitTrash({
      entries: [
        {
          id: 'entry-1',
          repoRoot: '/repo',
          worktreePath: '/repo/.worktrees/feat-x',
          repoName: 'repo',
          worktreeName: 'feat-x',
          branch: 'feat/x',
          sha: 'abc1234',
          trashedAt: '2026-10-28T20:54:58+08:00',
          branchDeleted: true,
          restorable: true,
        },
        { repoRoot: '/repo', worktreePath: '/repo/.worktrees/no-id' },
      ],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 'entry-1',
      repoName: 'repo',
      worktreeName: 'feat-x',
      branch: 'feat/x',
      sha: 'abc1234',
      branchDeleted: true,
      restorable: true,
    });
    const bare = normalizeGitTrash([{ id: 'entry-2', repoRoot: '/repo', worktreePath: '/repo/.worktrees/x' }]);
    expect(bare.entries[0]).toMatchObject({
      id: 'entry-2',
      repoName: 'repo',
      worktreeName: 'x',
      restorable: false,
      branchDeleted: false,
    });
  });

  it('回收站列表：空/非法输入返回空数组', () => {
    expect(normalizeGitTrash(null).entries).toEqual([]);
    expect(normalizeGitTrash({ entries: 'nope' }).entries).toEqual([]);
  });

  it('恢复结果：兼容 restored 包裹/平铺，restoredTo 缺省用 worktreePath', () => {
    expect(
      normalizeTrashRestore({
        restored: { id: 'e1', repoRoot: '/repo', worktreePath: '/repo/.worktrees/x', branch: 'feat/x' },
      }),
    ).toEqual({
      id: 'e1',
      repoRoot: '/repo',
      worktreePath: '/repo/.worktrees/x',
      restoredTo: '/repo/.worktrees/x',
      branch: 'feat/x',
    });
    expect(
      normalizeTrashRestore({ id: 'e2', worktreePath: '/repo/.worktrees/y', restoredTo: '/repo/.worktrees/y' })
        .restoredTo,
    ).toBe('/repo/.worktrees/y');
    expect(normalizeTrashRestore(null)).toEqual({
      id: '',
      repoRoot: '',
      worktreePath: '',
      restoredTo: '',
      branch: null,
    });
  });
});

// ------------------------------------------------ v0.20 复制/锁定/失效记录/截断

describe('evaluateWorktreeCleanup · locked（v0.20）', () => {
  const mergedClean = {
    mergedIntoBase: true,
    modifiedCount: 0,
    untrackedCount: 0,
    dirty: false,
  };

  it('locked 的工作副本不可清理，原因优先级最高（含主工作副本）', () => {
    expect(evaluateWorktreeCleanup(cleanupInput({ ...mergedClean, locked: true }))).toMatchObject({
      canCleanup: false,
      blocked: 'locked',
      safe: false,
    });
    expect(
      evaluateWorktreeCleanup(cleanupInput({ ...mergedClean, locked: true, isMain: true })).blocked,
    ).toBe('locked');
    expect(
      evaluateWorktreeCleanup(cleanupInput({ ...mergedClean, locked: true }), {
        sessionCwds: ['/repo/.worktrees/feat-x'],
      }).blocked,
    ).toBe('locked');
  });

  it('未 locked 时行为不变（主副本 / 会话 / 卡片仍按原优先级）', () => {
    expect(evaluateWorktreeCleanup(cleanupInput({ ...mergedClean, isMain: true })).blocked).toBe('main');
    expect(
      evaluateWorktreeCleanup(cleanupInput(mergedClean), { sessionCwds: ['/repo/.worktrees/feat-x'] })
        .blocked,
    ).toBe('session');
  });
});

describe('pruneErrorReason', () => {
  it('识别 PRUNE_FAILED / NOT_FOUND / BAD_REQUEST（含 details.reason 形态）', () => {
    expect(pruneErrorReason({ code: 'PRUNE_FAILED' })).toBe('PRUNE_FAILED');
    expect(pruneErrorReason({ code: 'ERROR', details: { reason: 'NOT_FOUND' } })).toBe('NOT_FOUND');
    expect(pruneErrorReason({ reason: 'BAD_REQUEST' })).toBe('BAD_REQUEST');
  });

  it('认不出/非对象归 unknown', () => {
    expect(pruneErrorReason({ code: 'WHAT' })).toBe('unknown');
    expect(pruneErrorReason(null)).toBe('unknown');
    expect(pruneErrorReason('PRUNE_FAILED')).toBe('unknown');
  });
});

describe('normalizeGitWorkspaces · 截断字段（v0.20）', () => {
  it('归一化 worktreeCount / truncatedWorktrees', () => {
    const repo = normalizeGitWorkspaces({
      repos: [
        {
          root: '/repo',
          worktreeCount: 14,
          truncatedWorktrees: 2,
          worktrees: [{ path: '/repo' }],
        },
      ],
    }).repos[0];
    expect(repo?.worktreeCount).toBe(14);
    expect(repo?.truncatedWorktrees).toBe(2);
  });

  it('旧服务端缺字段时：worktreeCount 退回实际条数、truncatedWorktrees=0', () => {
    const repo = normalizeGitWorkspaces({
      repos: [{ root: '/repo', worktrees: [{ path: '/repo' }, { path: '/repo/.worktrees/b' }] }],
    }).repos[0];
    expect(repo?.worktreeCount).toBe(2);
    expect(repo?.truncatedWorktrees).toBe(0);
  });

  it('非法/负数截断字段回退默认值', () => {
    const repo = normalizeGitWorkspaces({
      repos: [{ root: '/repo', worktreeCount: -1, truncatedWorktrees: 'x', worktrees: [{ path: '/repo' }] }],
    }).repos[0];
    expect(repo?.worktreeCount).toBe(1);
    expect(repo?.truncatedWorktrees).toBe(0);
  });
});

describe('normalizePruneResult', () => {
  it('兼容 pruned 包裹与平铺字段', () => {
    expect(normalizePruneResult({ repoRoot: '/repo', removed: true })).toEqual({
      repoRoot: '/repo',
      removed: true,
    });
    expect(normalizePruneResult({ pruned: { repoRoot: '/repo', removed: false } })).toEqual({
      repoRoot: '/repo',
      removed: false,
    });
  });

  it('空/非法输入安全兜底', () => {
    expect(normalizePruneResult(null)).toEqual({ repoRoot: '', removed: false });
    expect(normalizePruneResult({ removed: 'yes' })).toEqual({ repoRoot: '', removed: false });
  });
});

// ------------------------------------------- v0.21.0 #14 会话 cwd 兜底归属 / #15 终态清理

const sessionRepo = makeRepo('/repo', [
  makeWorktree('/repo', { isMain: true, isCurrent: true }),
  makeWorktree('/repo/.worktrees/feat-x', { branch: 'feat/x' }),
  makeWorktree('/repo/.worktrees/feat-y', { branch: 'feat/y' }),
]);

/** #14 用会话集合：主副本 / 两个 linked 工作副本 / 子目录 / 无 cwd。 */
const sessions = [
  makeSession('main', '/repo'),
  makeSession('feat-x', ' /repo/.worktrees/feat-x '),
  makeSession('feat-y', '/repo/.worktrees/feat-y'),
  makeSession('nested', '/repo/.worktrees/feat-x/web'),
  makeSession('no-cwd'),
];

describe('findWorktreeForCwd（v0.21.0 #14 导出）', () => {
  it('dirs 原文精确匹配优先，其次按工作副本路径最长前缀', () => {
    const repo = makeRepo('/repo', [
      makeWorktree('/repo', { isMain: true }),
      makeWorktree('/repo/.worktrees/feat-x', { branch: 'feat/x', dirs: ['/tmp/linked-x'] }),
    ]);
    expect(findWorktreeForCwd('/tmp/linked-x', [repo])?.worktree.path).toBe('/repo/.worktrees/feat-x');
    expect(findWorktreeForCwd('/repo/.worktrees/feat-x/src/deep', [repo])?.worktree.path).toBe(
      '/repo/.worktrees/feat-x',
    );
    expect(findWorktreeForCwd('/repo', [repo])?.worktree.isMain).toBe(true);
  });

  it('cwd 两侧空白被 trim；无 cwd / 空白 / 不匹配返回 null', () => {
    expect(findWorktreeForCwd(' /repo/.worktrees/feat-y/web ', [sessionRepo])).toMatchObject({
      repo: { root: '/repo' },
      worktree: { path: '/repo/.worktrees/feat-y' },
    });
    expect(findWorktreeForCwd(undefined, [sessionRepo])).toBeNull();
    expect(findWorktreeForCwd('   ', [sessionRepo])).toBeNull();
    expect(findWorktreeForCwd('/tmp/nowhere', [sessionRepo])).toBeNull();
    expect(findWorktreeForCwd('/repo', [])).toBeNull();
  });

  it('#15 复用：能定位到卡片 cwd 所在工作副本（主副本 / linked 都可识别）', () => {
    expect(findWorktreeForCwd('/repo/apps/web', [sessionRepo])).toMatchObject({
      worktree: { path: '/repo', isMain: true },
    });
    expect(findWorktreeForCwd('/repo/.worktrees/feat-x/apps', [sessionRepo])).toMatchObject({
      worktree: { path: '/repo/.worktrees/feat-x', isMain: false },
    });
  });
});

describe('groupCardsByWorktree · 会话 cwd 兜底归属（v0.21.0 #14）', () => {
  it('卡片 cwd 在主工作副本、会话在 linked 工作副本 → 改归该工作副本并记 attribution', () => {
    const card = makeCard('card', { cwd: '/repo', sessionIds: ['feat-x'] });
    const groups = groupCardsByWorktree([card], [sessionRepo], { sessions });
    const [repo] = groups.repos;
    const [mainWt, featX, featY] = repo!.worktrees;
    expect(mainWt?.cards).toEqual([]);
    expect(featX?.cards.map((item) => item.id)).toEqual(['card']);
    expect(featY?.cards).toEqual([]);
    expect(repo?.cardCount).toBe(1);
    expect(groups.unassigned).toEqual([]);
    expect(groups.sessionAttributed).toEqual([
      {
        cardId: 'card',
        sessionId: 'feat-x',
        sessionCwd: '/repo/.worktrees/feat-x',
        worktreePath: '/repo/.worktrees/feat-x',
      },
    ]);
  });

  it('会话执行目录在主工作副本 → 不兜底（维持主副本归属）', () => {
    const groups = groupCardsByWorktree(
      [makeCard('card', { cwd: '/repo', sessionIds: ['main'] })],
      [sessionRepo],
      { sessions },
    );
    expect(groups.repos[0]?.worktrees[0]?.cards.map((item) => item.id)).toEqual(['card']);
    expect(groups.sessionAttributed).toEqual([]);
  });

  it('卡片 cwd 已落在 linked 工作副本 → 卡片 cwd 优先（即使会话在别的工作副本）', () => {
    const groups = groupCardsByWorktree(
      [makeCard('card', { cwd: '/repo/.worktrees/feat-y', sessionIds: ['feat-x'] })],
      [sessionRepo],
      { sessions },
    );
    const [, featX, featY] = groups.repos[0]!.worktrees;
    expect(featY?.cards.map((item) => item.id)).toEqual(['card']);
    expect(featX?.cards).toEqual([]);
    expect(groups.sessionAttributed).toEqual([]);
  });

  it('会话 cwd 在另一个仓库的 linked 工作副本 → 跨仓库不兜底', () => {
    const otherRepo = makeRepo('/other', [
      makeWorktree('/other', { isMain: true }),
      makeWorktree('/other/.worktrees/z', { branch: 'feat/z' }),
    ]);
    const groups = groupCardsByWorktree(
      [makeCard('card', { cwd: '/repo', sessionIds: ['other-linked'] })],
      [sessionRepo, otherRepo],
      { sessions: [makeSession('other-linked', '/other/.worktrees/z')] },
    );
    expect(groups.repos[0]?.worktrees[0]?.cards.map((item) => item.id)).toEqual(['card']);
    expect(groups.repos[1]?.worktrees[1]?.cards).toEqual([]);
    expect(groups.sessionAttributed).toEqual([]);
  });

  it('多会话：跳过没有 cwd 的会话，取第一个命中的（子目录 cwd 也算命中）', () => {
    const groups = groupCardsByWorktree(
      [makeCard('card', { cwd: '/repo', sessionIds: ['missing', 'no-cwd', 'nested', 'feat-x'] })],
      [sessionRepo],
      { sessions },
    );
    const [, featX, featY] = groups.repos[0]!.worktrees;
    expect(featX?.cards.map((item) => item.id)).toEqual(['card']);
    expect(featY?.cards).toEqual([]);
    expect(groups.sessionAttributed).toMatchObject([
      { cardId: 'card', sessionId: 'nested', worktreePath: '/repo/.worktrees/feat-x' },
    ]);
  });

  it('卡片没有 cwd → 仍进未指定，不做会话兜底', () => {
    const groups = groupCardsByWorktree([makeCard('card', { sessionIds: ['feat-x'] })], [sessionRepo], {
      sessions,
    });
    expect(groups.unassigned.map((item) => item.id)).toEqual(['card']);
    expect(groups.repos[0]?.worktrees.every((worktree) => worktree.cards.length === 0)).toBe(true);
    expect(groups.sessionAttributed).toEqual([]);
  });

  it('sessions 缺省时不兜底（向后兼容），sessionAttributed 为空', () => {
    const groups = groupCardsByWorktree(
      [makeCard('card', { cwd: '/repo', sessionIds: ['feat-x'] })],
      [sessionRepo],
    );
    expect(groups.repos[0]?.worktrees[0]?.cards.map((item) => item.id)).toEqual(['card']);
    expect(groups.sessionAttributed).toEqual([]);
  });

  it('sessionAttributed 顺序与卡片遍历顺序一致，只在真正改归时记录', () => {
    const cards = [
      makeCard('a', { cwd: '/repo', sessionIds: ['feat-x'] }),
      makeCard('b', { cwd: '/repo', sessionIds: ['main'] }),
      makeCard('c', { cwd: '/repo', sessionIds: ['feat-y'] }),
    ];
    const groups = groupCardsByWorktree(cards, [sessionRepo], { sessions });
    expect(groups.sessionAttributed.map((attribution) => attribution.cardId)).toEqual(['a', 'c']);
  });
});

describe('evaluateWorktreeCleanup · 终态卡片不占用清理判定（v0.21.0 #15）', () => {
  const mergedClean = {
    mergedIntoBase: true,
    upstream: { ref: 'origin/main', ahead: 0, behind: 0 },
    modifiedCount: 0,
    untrackedCount: 0,
    dirty: false,
  };

  it('只有 done / canceled 卡片 → 可安全清理（终态不再占用）', () => {
    const check = evaluateWorktreeCleanup(
      cleanupInput({
        ...mergedClean,
        cards: [makeCard('done', { status: 'done' }), makeCard('canceled', { status: 'canceled' })],
      }),
    );
    expect(check).toMatchObject({
      canCleanup: true,
      blocked: null,
      cardCount: 0,
      runningCardCount: 0,
      safe: true,
    });
  });

  it('混有未完成卡片 → 仍不可清理，cardCount 只数未完成卡片', () => {
    const check = evaluateWorktreeCleanup(
      cleanupInput({
        ...mergedClean,
        cards: [
          makeCard('done', { status: 'done' }),
          makeCard('canceled', { status: 'canceled' }),
          makeCard('todo'),
        ],
      }),
    );
    expect(check).toMatchObject({ canCleanup: false, blocked: 'in-use', cardCount: 1, runningCardCount: 0 });
  });

  it('混有运行中 + done → 原因仍是「有卡片在跑」，计数只数未完成卡片', () => {
    const check = evaluateWorktreeCleanup(
      cleanupInput({
        ...mergedClean,
        cards: [makeCard('done', { status: 'done' }), makeCard('running', { status: 'running' })],
      }),
    );
    expect(check).toMatchObject({ canCleanup: false, blocked: 'running', cardCount: 1, runningCardCount: 1 });
  });

  it('卡片都已完成但工作副本未并入 → 可清理，仍需要第二层危险确认', () => {
    const check = evaluateWorktreeCleanup(
      cleanupInput({
        mergedIntoBase: false,
        aheadOfBase: 2,
        modifiedCount: 0,
        untrackedCount: 0,
        cards: [makeCard('done', { status: 'done' })],
      }),
    );
    expect(check).toMatchObject({
      canCleanup: true,
      blocked: null,
      cardCount: 0,
      needsDangerConfirm: true,
    });
  });
});
