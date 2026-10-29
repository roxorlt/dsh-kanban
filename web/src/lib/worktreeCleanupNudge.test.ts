import { describe, expect, it } from 'vitest';
import type { Card, GitWorkspaceRepo, GitWorkspaceWorktree } from '../types';
import { buildCleanupNudge, cwdInside, worktreeDisplayName } from './worktreeCleanupNudge';

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
    branch: 'feat/x',
    detached: false,
    sha: 'a1',
    shortSha: 'a1',
    isMain: false,
    isCurrent: false,
    aheadOfBase: 0,
    behindOfBase: 0,
    dirty: false,
    // v0.17+ 字段：可安全清理 = 已并入主线 + 干净
    mergedIntoBase: true,
    modifiedCount: 0,
    untrackedCount: 0,
    ...overrides,
  };
}

function makeRepo(root: string, worktrees: GitWorkspaceWorktree[]): GitWorkspaceRepo {
  return {
    root,
    name: root.split('/').filter(Boolean).pop() ?? root,
    commonDir: `${root}/.git`,
    mainBranch: 'main',
    worktrees,
  };
}

const linkedPath = '/repo/.worktrees/feat-x';
const repo = makeRepo('/repo', [
  makeWorktree('/repo', { isMain: true, isCurrent: true, branch: 'main', mergedIntoBase: true }),
  makeWorktree(linkedPath, { branch: 'feat/x' }),
]);

describe('cwdInside / worktreeDisplayName', () => {
  it('cwd 等于或用 / 前缀落在目录内才算命中（避免 /repo-2 误判进 /repo）', () => {
    expect(cwdInside('/repo', '/repo')).toBe(true);
    expect(cwdInside('/repo/sub', '/repo')).toBe(true);
    expect(cwdInside('/repo/', '/repo')).toBe(true);
    expect(cwdInside('/repo-2', '/repo')).toBe(false);
    expect(cwdInside('', '/repo')).toBe(false);
  });

  it('主工作副本用仓库名，linked 用相对仓库根路径，兜底取末段', () => {
    expect(worktreeDisplayName(repo, '/repo')).toBe('repo');
    expect(worktreeDisplayName(repo, linkedPath)).toBe('.worktrees/feat-x');
    expect(worktreeDisplayName(repo, '/elsewhere/other')).toBe('other');
  });
});

describe('buildCleanupNudge', () => {
  it('完成卡片 + 已并入主线 + 干净 + 只有终态卡片占用 → 提示可清理', () => {
    const card = makeCard('c1', { status: 'done', cwd: `${linkedPath}/src` });
    const result = buildCleanupNudge({ card, cards: [card], repos: [repo] });
    expect(result).toEqual({
      worktreePath: linkedPath,
      label: '.worktrees/feat-x',
      branch: 'feat/x',
    });
  });

  it('同工作副本里还有 done/canceled 卡片 → 终态不阻塞，仍提示', () => {
    const card = makeCard('c1', { status: 'done', cwd: linkedPath });
    const otherDone = makeCard('c2', { status: 'done', cwd: `${linkedPath}/a` });
    const otherCanceled = makeCard('c3', { status: 'canceled', cwd: linkedPath });
    expect(buildCleanupNudge({ card, cards: [card, otherDone, otherCanceled], repos: [repo] })).not.toBeNull();
  });

  it('未完成卡片（running/backlog）占用 → 不提示', () => {
    const card = makeCard('c1', { status: 'done', cwd: linkedPath });
    for (const status of ['running', 'backlog', 'needs_you', 'blocked', 'failed'] as const) {
      const other = makeCard('c2', { status, cwd: linkedPath });
      expect(buildCleanupNudge({ card, cards: [card, other], repos: [repo] })).toBeNull();
    }
  });

  it('运行中会话的 cwd 落在工作副本内 → 不提示', () => {
    const card = makeCard('c1', { status: 'done', cwd: linkedPath });
    expect(
      buildCleanupNudge({ card, cards: [card], repos: [repo], sessionCwds: [`${linkedPath}/sub`] }),
    ).toBeNull();
  });

  it('未并入主线 / 有改动 / git locked / 目录已失效 → 不提示', () => {
    const card = makeCard('c1', { status: 'done', cwd: linkedPath });
    const cases: GitWorkspaceWorktree[] = [
      makeWorktree(linkedPath, { mergedIntoBase: false, aheadOfBase: 2 }),
      makeWorktree(linkedPath, { dirty: true, modifiedCount: 1 }),
      makeWorktree(linkedPath, { untrackedCount: 2 }),
      makeWorktree(linkedPath, { locked: true }),
      makeWorktree(linkedPath, { prunable: true }),
    ];
    for (const worktree of cases) {
      const repoCase = makeRepo('/repo', [makeWorktree('/repo', { isMain: true }), worktree]);
      expect(buildCleanupNudge({ card, cards: [card], repos: [repoCase] })).toBeNull();
    }
  });

  it('卡片 cwd 是主工作副本 / 没 cwd / 匹配不到工作副本 → 不提示', () => {
    const mainCard = makeCard('c1', { status: 'done', cwd: '/repo' });
    expect(buildCleanupNudge({ card: mainCard, cards: [mainCard], repos: [repo] })).toBeNull();

    const noCwd = makeCard('c2', { status: 'done' });
    expect(buildCleanupNudge({ card: noCwd, cards: [noCwd], repos: [repo] })).toBeNull();

    const elsewhere = makeCard('c3', { status: 'done', cwd: '/somewhere/else' });
    expect(buildCleanupNudge({ card: elsewhere, cards: [elsewhere], repos: [repo] })).toBeNull();
  });

  it('非 done 状态不提示（canceled 也不提示清理）', () => {
    for (const status of ['canceled', 'running', 'backlog'] as const) {
      const card = makeCard('c1', { status, cwd: linkedPath });
      expect(buildCleanupNudge({ card, cards: [card], repos: [repo] })).toBeNull();
    }
  });
});
