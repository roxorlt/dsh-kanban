/**
 * 「工作线」总览纯逻辑单测（v0.23.0，docs/contracts/06 §5 / 02 §12）。
 * 覆盖：行状态派生 / 改动条 / 相对主线文案 / 最近改动 / 仓库分组排序 /
 * 未指定原因 / 选中行与卡片筛选 / 共享的工作副本展示名。
 */
import { describe, expect, it } from 'vitest';
import type {
  Card,
  GitWorkspaceRepo,
  GitWorkspaceUnavailable,
  GitWorkspaceWorktree,
  SessionRow,
} from '../types';
import { formatWorktreeLabel } from './useWorkspaces';
import {
  buildWorklineOverview,
  buildWorklineRow,
  compareWorklineRows,
  deriveWorklineStatus,
  findWorklineRow,
  selectWorklineCards,
  toWorklineSelection,
  worklineKey,
  worklineLastActivity,
  worklinePercent,
  worklineRelationText,
} from './worklineOverview';
import type { WorklineOverview, WorklineRow, WorklineStatus } from './worklineOverview';

// ---------------------------------------------------------------- fixtures

function makeCard(overrides: Partial<Card> & { id: string }): Card {
  return {
    boardId: 'board-default',
    title: `卡片 ${overrides.id}`,
    summary: '',
    status: 'running',
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
  };
}

function makeWorktree(overrides: Partial<GitWorkspaceWorktree> & { path: string }): GitWorkspaceWorktree {
  return {
    branch: 'main',
    detached: false,
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    isMain: false,
    isCurrent: false,
    aheadOfBase: 0,
    behindOfBase: 0,
    dirty: false,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<GitWorkspaceRepo> & { root: string; worktrees: GitWorkspaceWorktree[] }): GitWorkspaceRepo {
  return {
    name: overrides.root.split('/').filter(Boolean).pop() ?? overrides.root,
    commonDir: `${overrides.root}/.git`,
    mainBranch: 'main',
    ...overrides,
  };
}

// ---------------------------------------------------------------- helpers

/** 取第一个仓库的第一条工作线（noUncheckedIndexedAccess 下避免索引断言）。 */
function firstRowOf(overview: WorklineOverview): WorklineRow {
  const row = overview.repos[0]?.worklines[0];
  if (!row) throw new Error('fixture 应该至少有一条工作线');
  return row;
}

// ---------------------------------------------------------------- 行状态

describe('deriveWorklineStatus', () => {
  const clean = { merge: 'unmerged' as const, changes: 'clean' as const };

  it('已并入主线（ahead=0）优先于卡片状态', () => {
    expect(deriveWorklineStatus({ merge: 'merged', changes: 'clean' }, 3, false)).toBe('merged');
    expect(deriveWorklineStatus({ merge: 'merged', changes: 'clean' }, 0, false)).toBe('merged');
  });

  it('还没并入但有未完成卡片 → 进行中', () => {
    expect(deriveWorklineStatus(clean, 1, false)).toBe('active');
  });

  it('还没并入但有未保存改动 → 进行中（没有卡片也算）', () => {
    expect(deriveWorklineStatus({ merge: 'unmerged', changes: 'modified' }, 0, false)).toBe('active');
  });

  it('还没并入、没有未完成卡片、工作区干净 → 停滞', () => {
    expect(deriveWorklineStatus(clean, 0, false)).toBe('stalled');
  });

  it('目录已失效 → 无法判断', () => {
    expect(deriveWorklineStatus({ merge: 'merged', changes: 'clean' }, 5, true)).toBe('unknown');
  });

  it('算不出合并状态：有待办的算进行中，否则无法判断', () => {
    const unknown = { merge: 'unknown' as const, changes: 'clean' as const };
    expect(deriveWorklineStatus(unknown, 1, false)).toBe('active');
    expect(deriveWorklineStatus(unknown, 0, false)).toBe('unknown');
  });
});

describe('buildWorklineRow', () => {
  const repo = { root: '/repo', name: 'repo' };

  it('聚合卡片数 / 进行中卡片数 / 未完成数 / 最近改动', () => {
    const worktree = makeWorktree({
      path: '/repo',
      isMain: true,
      aheadOfBase: 2,
      behindOfBase: 1,
      lastCommitAt: '2026-10-30T10:00:00+08:00',
    });
    const cards = [
      makeCard({ id: 'c1', status: 'running', updatedAt: Date.parse('2026-10-30T09:00:00+08:00') }),
      makeCard({ id: 'c2', status: 'done', updatedAt: Date.parse('2026-10-30T11:00:00+08:00') }),
    ];
    const row = buildWorklineRow(repo, worktree, cards);
    expect(row.cards).toHaveLength(2);
    expect(row.openCardCount).toBe(1);
    expect(row.runningCardCount).toBe(1);
    expect(row.status).toBe('active');
    expect(row.aheadMain).toBe(2);
    expect(row.behindMain).toBe(1);
    expect(row.percent).toBe(67);
    expect(row.lastActivityAt).toBe(Date.parse('2026-10-30T11:00:00+08:00'));
    expect(row.location).toBe('repo');
    expect(row.key).toBe(worklineKey('/repo', '/repo'));
  });

  it('线上状态沿用 worktreeStatusInfo（upstream 有 ahead → 没推送）', () => {
    const worktree = makeWorktree({
      path: '/repo/.worktrees/feat',
      branch: 'feat/x',
      aheadOfBase: 1,
      upstream: { ref: 'origin/feat/x', ahead: 2, behind: 0 },
    });
    const row = buildWorklineRow(repo, worktree, []);
    expect(row.remote).toBe('unpushed');
    expect(row.upstreamAhead).toBe(2);
    expect(row.location).toBe('.worktrees/feat');
  });

  it('目录已失效（prunable）→ 无法判断，且不显示相对主线数据', () => {
    const worktree = makeWorktree({ path: '/repo/.worktrees/gone', prunable: true, aheadOfBase: 2 });
    const row = buildWorklineRow(repo, worktree, []);
    expect(row.status).toBe('unknown');
    expect(row.aheadMain).toBeNull();
    expect(row.percent).toBeNull();
  });

  it('游离 HEAD 时 branch 为 null、位置仍可读', () => {
    const worktree = makeWorktree({ path: '/repo/.worktrees/detached', branch: null, detached: true });
    const row = buildWorklineRow(repo, worktree, []);
    expect(row.branch).toBeNull();
    expect(row.detached).toBe(true);
    expect(row.location).toBe('.worktrees/detached');
  });
});

describe('worklinePercent / worklineRelationText', () => {
  /** 只覆盖状态与两个计数（其余字段用一条正常行兜底）。 */
  function relationRow(status: WorklineStatus, ahead: number | null, behind: number | null) {
    return {
      ...buildWorklineRow({ root: '/repo', name: 'repo' }, makeWorktree({ path: '/repo', aheadOfBase: 0 }), []),
      status,
      aheadMain: ahead,
      behindMain: behind,
    };
  }

  it('percent：已并入/不落后 100，只落后 0，分叉按 ahead 占比，状态未知 null', () => {
    expect(worklinePercent('merged', 0, 0)).toBe(100);
    expect(worklinePercent('merged', 0, 4)).toBe(100);
    expect(worklinePercent('active', 3, 0)).toBe(100);
    expect(worklinePercent('stalled', 0, 5)).toBe(0);
    expect(worklinePercent('active', 3, 1)).toBe(75);
    expect(worklinePercent('unknown', 3, 1)).toBeNull();
    expect(worklinePercent('active', null, null)).toBeNull();
  });

  it('relation 文案：一致 / 已并入但落后 / 只多 / 多又少 / 只少 / 未知', () => {
    expect(worklineRelationText(relationRow('merged', 0, 0))).toEqual({ key: 'worklines.sameAsMain' });
    expect(worklineRelationText(relationRow('merged', 0, 3))).toEqual({
      key: 'worklines.mergedBehind',
      params: { behind: 3 },
    });
    expect(worklineRelationText(relationRow('active', 3, 0))).toEqual({
      key: 'worklines.aheadOnly',
      params: { ahead: 3 },
    });
    expect(worklineRelationText(relationRow('active', 3, 2))).toEqual({
      key: 'worklines.aheadBehind',
      params: { ahead: 3, behind: 2 },
    });
    expect(worklineRelationText(relationRow('stalled', 0, 5))).toEqual({
      key: 'worklines.behindOnly',
      params: { behind: 5 },
    });
    expect(worklineRelationText(relationRow('unknown', null, null))).toEqual({
      key: 'worklines.unknownRelation',
    });
  });

  it('未知状态即使有数字也只显示「暂无数据」（不谎报）', () => {
    expect(worklineRelationText(relationRow('unknown', 2, 1))).toEqual({
      key: 'worklines.unknownRelation',
    });
  });
});

describe('worklineLastActivity', () => {
  it('取提交时间与卡片更新时间的较新者', () => {
    const cards = [makeCard({ id: 'c1', updatedAt: 3000 }), makeCard({ id: 'c2', updatedAt: 1000 })];
    expect(worklineLastActivity(cards, '1970-01-01T00:00:02.000Z')).toBe(3000);
    expect(worklineLastActivity(cards, '1970-01-01T00:00:05.000Z')).toBe(5000);
  });

  it('都没有时间时返回 null', () => {
    expect(worklineLastActivity([], null)).toBeNull();
    expect(worklineLastActivity([], 'not-a-date')).toBeNull();
  });
});

// ---------------------------------------------------------------- 分组

function makeFixture(): { cards: Card[]; repos: GitWorkspaceRepo[] } {
  const repoA = makeRepo({
    root: '/work/alpha',
    worktrees: [
      makeWorktree({ path: '/work/alpha', isMain: true, branch: 'main', aheadOfBase: 0, behindOfBase: 0 }),
      makeWorktree({
        path: '/work/alpha/.worktrees/feat',
        branch: 'feat/a',
        aheadOfBase: 3,
        behindOfBase: 0,
        upstream: { ref: 'origin/feat/a', ahead: 1, behind: 0 },
        lastCommitAt: '2026-10-30T08:00:00+08:00',
      }),
      makeWorktree({
        path: '/work/alpha/.worktrees/docs',
        branch: 'docs/x',
        aheadOfBase: 1,
        behindOfBase: 4,
        lastCommitAt: '2026-10-20T08:00:00+08:00',
      }),
    ],
  });
  const repoB = makeRepo({
    root: '/work/beta',
    worktrees: [
      makeWorktree({ path: '/work/beta', isMain: true, branch: 'main', aheadOfBase: 0 }),
      makeWorktree({ path: '/work/beta/.worktrees/fix', branch: 'fix/b', aheadOfBase: 2, dirty: true }),
    ],
  });
  const cards: Card[] = [
    makeCard({ id: 'a1', cwd: '/work/alpha/.worktrees/feat', project: 'alpha', status: 'running', updatedAt: 100 }),
    makeCard({ id: 'a2', cwd: '/work/alpha/.worktrees/feat/src', project: 'alpha', status: 'done', updatedAt: 200 }),
    makeCard({ id: 'a3', cwd: '/work/alpha/.worktrees/docs', status: 'backlog', updatedAt: 50 }),
    makeCard({ id: 'a4', cwd: '/work/alpha', project: 'alpha', status: 'done', updatedAt: 10 }),
    makeCard({ id: 'b1', cwd: '/work/beta/.worktrees/fix', project: 'beta', status: 'running', updatedAt: 60 }),
    makeCard({ id: 'x1', project: 'orphan', status: 'backlog', updatedAt: 30 }),
    makeCard({ id: 'x2', cwd: '/tmp/gone/work', status: 'backlog', updatedAt: 40 }),
  ];
  return { cards, repos: [repoA, repoB] };
}

describe('buildWorklineOverview', () => {
  it('两层分组：仓库 → 工作线；组头计数与项目去重', () => {
    const { cards, repos } = makeFixture();
    const overview = buildWorklineOverview(cards, repos);
    expect(overview.repoCount).toBe(2);
    expect(overview.worklineCount).toBe(5);
    expect(overview.cardCount).toBe(7);
    expect(overview.runningCardCount).toBe(2);
    const alpha = overview.repos.find((group) => group.name === 'alpha');
    expect(alpha).toBeTruthy();
    expect(alpha?.projects).toEqual(['alpha']);
    expect(alpha?.worklines).toHaveLength(3);
    expect(alpha?.cardCount).toBe(4);
    // 进行中的线（feat/a 有未完成卡、docs/x 有未完成卡）排在前面，已并入的 main 在后
    expect(alpha?.worklines.map((row) => row.branch)).toEqual(['feat/a', 'docs/x', 'main']);
    expect(alpha?.activeCount).toBe(2);
  });

  it('仓库块按进行中条数排序', () => {
    const { cards, repos } = makeFixture();
    const overview = buildWorklineOverview(cards, repos);
    // alpha 有 2 条进行中，beta 有 1 条
    expect(overview.repos.map((group) => group.name)).toEqual(['alpha', 'beta']);
  });

  it('未指定：无 cwd → no_cwd；不可用原因透传；仓库内未匹配 → unmatched', () => {
    const { cards, repos } = makeFixture();
    const unavailable: GitWorkspaceUnavailable[] = [{ dir: '/tmp/gone/work', reason: 'missing' }];
    const overview = buildWorklineOverview(cards, repos, { unavailable });
    expect(overview.unassigned.map((item) => item.card.id)).toEqual(['x2', 'x1']);
    expect(overview.unassigned.map((item) => item.reason)).toEqual(['missing', 'no_cwd']);
  });

  it('仓库根下的子目录（含已被 12 上限截断的工作副本）按前缀归到主工作副本，与「工作区」视图一致', () => {
    const repo = makeRepo({
      root: '/work/alpha',
      worktrees: [makeWorktree({ path: '/work/alpha', isMain: true, aheadOfBase: 0 })],
    });
    const cards = [makeCard({ id: 'c1', cwd: '/work/alpha/.worktrees/hidden' })];
    const overview = buildWorklineOverview(cards, [repo]);
    expect(overview.unassigned).toHaveLength(0);
    expect(firstRowOf(overview).cards.map((card) => card.id)).toEqual(['c1']);
  });

  it('没有探测到仓库时全部进未指定，且不报错', () => {
    const cards = [makeCard({ id: 'c1', cwd: '/plain/dir' }), makeCard({ id: 'c2' })];
    const overview = buildWorklineOverview(cards, []);
    expect(overview.repos).toEqual([]);
    expect(overview.worklineCount).toBe(0);
    expect(overview.unassigned.map((item) => item.card.id)).toEqual(['c1', 'c2']);
  });

  it('按会话归属兜底：卡片 cwd 在主工作副本、会话在同仓库 linked 工作副本 → 归到 linked 线', () => {
    const { cards, repos } = makeFixture();
    const sessions: SessionRow[] = [
      { id: 's1', title: '会话', running: true, updatedAt: 1, cwd: '/work/alpha/.worktrees/feat' },
    ];
    const withSession = cards.map((card) => (card.id === 'a4' ? { ...card, sessionIds: ['s1'] } : card));
    const overview = buildWorklineOverview(withSession, repos, { sessions });
    const feat = overview.repos
      .find((group) => group.name === 'alpha')
      ?.worklines.find((row) => row.branch === 'feat/a');
    expect(feat?.cards.map((card) => card.id)).toContain('a4');
  });

  it('工作副本被 12 上限截断时组里带 truncatedWorktrees', () => {
    const repo = makeRepo({
      root: '/work/alpha',
      worktrees: [makeWorktree({ path: '/work/alpha', isMain: true, aheadOfBase: 0 })],
      truncatedWorktrees: 3,
    });
    const overview = buildWorklineOverview([makeCard({ id: 'c1', cwd: '/work/alpha' })], [repo]);
    expect(overview.repos[0]?.truncatedWorktrees).toBe(3);
  });
});

describe('findWorklineRow / selectWorklineCards / toWorklineSelection', () => {
  it('按仓库根 + 工作副本路径找行并取卡片', () => {
    const { cards, repos } = makeFixture();
    const overview = buildWorklineOverview(cards, repos);
    const feat = findWorklineRow(overview, {
      repoRoot: '/work/alpha',
      worktreePath: '/work/alpha/.worktrees/feat/',
      branch: 'feat/a',
      label: 'feat/a',
    });
    expect(feat?.branch).toBe('feat/a');
    const selected = selectWorklineCards(overview, {
      repoRoot: '/work/alpha',
      worktreePath: '/work/alpha/.worktrees/feat',
      branch: 'feat/a',
      label: 'feat/a',
    });
    expect(selected.map((card) => card.id).sort()).toEqual(['a1', 'a2']);
  });

  it('工作副本已不存在时返回 null / 空数组（不抛错）', () => {
    const { cards, repos } = makeFixture();
    const overview = buildWorklineOverview(cards, repos);
    const selection = toWorklineSelection({
      ...firstRowOf(overview),
      path: '/work/alpha/.worktrees/gone',
    });
    expect(findWorklineRow(overview, selection)).toBeNull();
    expect(selectWorklineCards(overview, selection)).toEqual([]);
    expect(findWorklineRow(overview, null)).toBeNull();
  });

  it('toWorklineSelection：有分支用分支名当标签，游离 HEAD 用工作副本位置', () => {
    const row = buildWorklineRow(
      { root: '/repo', name: 'repo' },
      makeWorktree({ path: '/repo/.worktrees/x', branch: 'feat/x', aheadOfBase: 1 }),
      [],
    );
    expect(toWorklineSelection(row)).toEqual({
      repoRoot: '/repo',
      worktreePath: '/repo/.worktrees/x',
      branch: 'feat/x',
      label: 'feat/x',
    });
    const detached = buildWorklineRow(
      { root: '/repo', name: 'repo' },
      makeWorktree({ path: '/repo/.worktrees/y', branch: null, detached: true, aheadOfBase: 1 }),
      [],
    );
    expect(toWorklineSelection(detached).label).toBe('.worktrees/y');
  });
});

describe('compareWorklineRows', () => {
  it('状态 → 最近改动新到旧 → 位置', () => {
    const base = { root: '/repo', name: 'repo' };
    const active = buildWorklineRow(base, makeWorktree({ path: '/repo/a', branch: 'a', aheadOfBase: 1 }), []);
    const merged = buildWorklineRow(base, makeWorktree({ path: '/repo/b', branch: 'b', aheadOfBase: 0 }), []);
    const older = buildWorklineRow(
      base,
      makeWorktree({ path: '/repo/c', branch: 'c', aheadOfBase: 1, lastCommitAt: '2026-01-01T00:00:00Z' }),
      [],
    );
    expect([merged, older, active].sort(compareWorklineRows).map((row) => row.branch)).toEqual(['c', 'a', 'b']);
  });
});

describe('formatWorktreeLabel（与「工作区」视图共用）', () => {
  it('主工作副本 = 仓库名；子副本 = 相对仓库根的路径', () => {
    expect(formatWorktreeLabel({ root: '/work/alpha', name: 'alpha' }, { path: '/work/alpha' })).toBe('alpha');
    expect(formatWorktreeLabel({ root: '/work/alpha', name: 'alpha' }, { path: '/work/alpha/.worktrees/x' })).toBe(
      '.worktrees/x',
    );
  });

  it('末尾斜杠不影响判定', () => {
    expect(formatWorktreeLabel({ root: '/work/alpha/', name: 'alpha' }, { path: '/work/alpha/' })).toBe('alpha');
    expect(formatWorktreeLabel({ root: '/work/alpha/', name: 'alpha' }, { path: '/work/alpha/.worktrees/x/' })).toBe(
      '.worktrees/x',
    );
  });

  it('仓库外路径兜底为缩短路径（不抛错）', () => {
    const label = formatWorktreeLabel({ root: '/work/alpha', name: 'alpha' }, { path: '/elsewhere/deep/path' });
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toContain('/work/alpha');
  });
});
