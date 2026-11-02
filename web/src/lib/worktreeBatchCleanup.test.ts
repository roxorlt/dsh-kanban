import { describe, expect, it } from 'vitest';
import type { Card, GitWorkspaceWorktree } from '../types';
import { normalizeCleanupResult } from '../api';
import type { WorkspaceRepoGroup, WorkspaceWorktreeGroup } from './useWorkspaces';
import {
  batchCleanupFailureKey,
  CLEANUP_NUDGE_DISMISS_TTL_MS,
  collectBatchCleanupCandidates,
  groupBatchCleanupCandidates,
  shouldShowCleanupNudge,
} from './worktreeBatchCleanup';

// ---------------------------------------------------------------- fixtures

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

/** 一个「已并入主线、干净」的工作副本（安全可清理的基线）。 */
const SAFE: Partial<GitWorkspaceWorktree> = {
  mergedIntoBase: true,
  aheadOfBase: 0,
  modifiedCount: 0,
  untrackedCount: 0,
  dirty: false,
};

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

// ---------------------------------------------------------------- ⑯ 候选

describe('collectBatchCleanupCandidates', () => {
  it('只收「已并入主线 + 干净 + 无占用」的非主工作副本', () => {
    const repo = makeRepoGroup('/repo', [
      groupWorktree('/repo', { ...SAFE, isMain: true }),
      groupWorktree('/repo/.worktrees/feat-a', { ...SAFE, branch: 'feat/a' }),
      groupWorktree('/repo/.worktrees/feat-b', { ...SAFE, branch: 'feat/b' }),
    ]);
    const candidates = collectBatchCleanupCandidates([repo]);
    expect(candidates.map((item) => item.worktree.path)).toEqual([
      '/repo/.worktrees/feat-a',
      '/repo/.worktrees/feat-b',
    ]);
    expect(candidates.every((item) => item.check.safe)).toBe(true);
    expect(candidates[0]?.repo.root).toBe('/repo');
  });

  it('未合并 / 有改动 / 未完成卡片 / 运行中卡片 / 锁定 / 目录失效都不是安全项', () => {
    const repo = makeRepoGroup('/repo', [
      groupWorktree('/repo/.worktrees/unmerged', { ...SAFE, mergedIntoBase: false, aheadOfBase: 2 }),
      groupWorktree('/repo/.worktrees/modified', { ...SAFE, modifiedCount: 2, dirty: true }),
      groupWorktree('/repo/.worktrees/untracked', { ...SAFE, untrackedCount: 1 }),
      groupWorktree('/repo/.worktrees/backlog', { ...SAFE, cards: [makeCard('b1')] }),
      groupWorktree('/repo/.worktrees/running', {
        ...SAFE,
        cards: [makeCard('r1', { status: 'running' })],
      }),
      groupWorktree('/repo/.worktrees/done', {
        ...SAFE,
        cards: [makeCard('d1', { status: 'done' })],
      }),
      groupWorktree('/repo/.worktrees/locked', { ...SAFE, locked: true }),
      groupWorktree('/repo/.worktrees/gone', { ...SAFE, prunable: true }),
    ]);
    const candidates = collectBatchCleanupCandidates([repo]);
    // 只有 done/canceled 终态卡片的副本不算占用 → 仍是安全项；locked / prunable 不在批量范围
    expect(candidates.map((item) => item.worktree.path)).toEqual(['/repo/.worktrees/done']);
  });

  it('运行中会话 cwd 落在工作副本内 → 不是安全项（客户端安全层）', () => {
    const repo = makeRepoGroup('/repo', [
      groupWorktree('/repo/.worktrees/busy', { ...SAFE }),
      groupWorktree('/repo/.worktrees/free', { ...SAFE }),
    ]);
    const candidates = collectBatchCleanupCandidates([repo], {
      sessionCwds: ['/repo/.worktrees/busy/web/src'],
    });
    expect(candidates.map((item) => item.worktree.path)).toEqual(['/repo/.worktrees/free']);
  });

  it('跨仓库保持传入顺序（同仓库内保持工作副本顺序）', () => {
    const first = makeRepoGroup('/a', [
      groupWorktree('/a/.worktrees/w1', { ...SAFE }),
      groupWorktree('/a/.worktrees/w2', { ...SAFE }),
    ]);
    const second = makeRepoGroup('/b', [groupWorktree('/b/.worktrees/w3', { ...SAFE })]);
    expect(collectBatchCleanupCandidates([second, first]).map((item) => item.worktree.path)).toEqual([
      '/b/.worktrees/w3',
      '/a/.worktrees/w1',
      '/a/.worktrees/w2',
    ]);
  });
});

describe('groupBatchCleanupCandidates', () => {
  it('按仓库分组并保持顺序', () => {
    const repoA = makeRepoGroup('/a', [groupWorktree('/a/.worktrees/w1', { ...SAFE })]);
    const repoB = makeRepoGroup('/b', [groupWorktree('/b/.worktrees/w2', { ...SAFE })]);
    const groups = groupBatchCleanupCandidates(collectBatchCleanupCandidates([repoA, repoB]));
    expect(groups.map((group) => group.repo.root)).toEqual(['/a', '/b']);
    expect(groups[0]?.items.map((item) => item.worktree.path)).toEqual(['/a/.worktrees/w1']);
  });
});

// ---------------------------------------------------------------- ⑱ 提醒

describe('shouldShowCleanupNudge', () => {
  const now = Date.UTC(2026, 10, 2, 8, 0, 0);

  it('没有安全项时不显示（即使从未关闭）', () => {
    expect(shouldShowCleanupNudge({ count: 0, now })).toBe(false);
    expect(shouldShowCleanupNudge({ count: -1, now })).toBe(false);
  });

  it('有安全项且从未关闭 → 显示', () => {
    expect(shouldShowCleanupNudge({ count: 2, now })).toBe(true);
    expect(shouldShowCleanupNudge({ count: 2, dismissedAt: null, now })).toBe(true);
  });

  it('关闭后 24 小时内不显示，到期后再次出现（定期提醒）', () => {
    const dismissedAt = now - 60 * 60 * 1000;
    expect(shouldShowCleanupNudge({ count: 2, dismissedAt, now })).toBe(false);
    expect(
      shouldShowCleanupNudge({ count: 2, dismissedAt: now - CLEANUP_NUDGE_DISMISS_TTL_MS + 1, now }),
    ).toBe(false);
    expect(
      shouldShowCleanupNudge({ count: 2, dismissedAt: now - CLEANUP_NUDGE_DISMISS_TTL_MS, now }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------- 失败原因 / 归一化

describe('batchCleanupFailureKey', () => {
  it('已知错误码映射到单条清理的人话文案', () => {
    expect(batchCleanupFailureKey('WORKTREE_DIRTY')).toBe('workspace.cleanupErrorDirty');
    expect(batchCleanupFailureKey('WORKTREE_IN_USE')).toBe('workspace.cleanupErrorInUse');
    expect(batchCleanupFailureKey('NOT_FOUND')).toBe('workspace.cleanupErrorNotFound');
  });

  it('认不出的错误走兜底文案', () => {
    expect(batchCleanupFailureKey('unknown')).toBe('workspace.cleanupErrorUnknown');
  });
});

describe('normalizeCleanupResult · ③ affectedCards', () => {
  it('透传合法 affectedCards，丢弃不合法项', () => {
    const result = normalizeCleanupResult({
      repoRoot: '/repo',
      worktreePath: '/repo/.worktrees/wt',
      trashedTo: '/trash/20261102-repo-wt',
      branchName: 'feat/x',
      branchDeleted: true,
      trashRetentionDays: 7,
      affectedCards: [
        { id: 'card-1', title: 'A' },
        { id: 'card-2' },
        { title: 'missing id' },
        'bad',
      ],
    });
    expect(result.affectedCards).toEqual([
      { id: 'card-1', title: 'A' },
      { id: 'card-2', title: 'card-2' },
    ]);
  });

  it('旧服务端没有 affectedCards → 空数组', () => {
    expect(normalizeCleanupResult({ repoRoot: '/repo' }).affectedCards).toEqual([]);
  });
});
