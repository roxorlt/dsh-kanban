import { describe, expect, it } from 'vitest';
import {
  GIT_GRAPH_MAX_ROWS,
  buildGitGraph,
  shortenPath,
  shouldShowWorktreeCounts,
} from './gitGraph';
import type { GitCommit, GitContextAvailable, GitRef } from '../types';

const T = 1_793_000_000_000;

function commit(index: number, committedAt: number, subject = `commit ${index}`): GitCommit {
  return {
    sha: `sha-${index}`,
    shortSha: `s${index}`,
    subject,
    authorName: 'tester',
    committedAt,
  };
}

function ref(name: string, sha: string, kind: GitRef['kind']): GitRef {
  return { name, sha, shortSha: sha.slice(0, 7), kind };
}

/** 契约 §3 的最小可用 git 对象（默认：feat/x 领先 main 2 条、落后 1 条）。 */
function makeGit(overrides: Partial<GitContextAvailable> = {}): GitContextAvailable {
  return {
    available: true,
    reason: null,
    dir: '/repo/.agents/worktrees/feat-x',
    requestedDir: null,
    repo: { name: 'repo', root: '/repo', commonDir: '/repo/.git' },
    current: {
      worktree: '/repo/.agents/worktrees/feat-x',
      isWorktree: true,
      isMainWorktree: false,
      branch: 'feat/x',
      detached: false,
      sha: 'sha-0',
      shortSha: 's0',
      subject: 'commit 0',
      authorName: 'tester',
      committedAt: T,
    },
    upstream: { ref: 'origin/feat/x', remote: 'origin', branch: 'feat/x', ahead: 2, behind: 0 },
    base: {
      kind: 'main',
      label: 'main',
      branch: 'main',
      remoteRef: 'origin/main',
      ahead: 2,
      behind: 1,
      mergeBase: { sha: 'sha-mb', shortSha: 'smb' },
      remoteAhead: 0,
      remoteBehind: 0,
    },
    worktrees: [
      {
        path: '/repo',
        branch: 'main',
        detached: false,
        sha: 'sha-base',
        shortSha: 'sbase',
        isMain: true,
        isCurrent: false,
        aheadOfBase: 0,
        behindOfBase: 0,
      },
    ],
    worktreesTruncated: 0,
    commits: { ahead: [], behind: [], shared: [] },
    refs: [],
    limits: { ahead: 12, behind: 8, shared: 4, worktrees: 8 },
    fetchedAt: T,
    durationMs: 42,
    ...overrides,
  };
}

describe('buildGitGraph 行顺序', () => {
  it('ahead/behind 按 committedAt 倒序合并，同时间戳先 ahead 后 behind（各自保持新→旧）', () => {
    const git = makeGit({
      commits: {
        ahead: [commit(0, T), commit(1, T - 200), commit(2, T - 200)],
        behind: [commit(10, T - 100), commit(11, T - 200), commit(12, T - 300)],
        shared: [commit(20, T - 400)],
      },
    });
    const graph = buildGitGraph(git);
    expect(graph.rows.map((row) => row.sha)).toEqual([
      'sha-0', // ahead T
      'sha-10', // behind T-100
      'sha-1', // ahead T-200（同时间戳先 ahead）
      'sha-2', // ahead T-200
      'sha-11', // behind T-200
      'sha-12', // behind T-300
      'sha-20', // shared 接在最后
    ]);
    expect(graph.rows.map((row) => row.lane)).toEqual([1, 0, 1, 1, 0, 0, 0]);
    expect(graph.rows.map((row) => row.source)).toEqual([
      'ahead',
      'behind',
      'ahead',
      'ahead',
      'behind',
      'behind',
      'shared',
    ]);
  });

  it('ahead/behind 为空时退化为单泳道（不画空泳道）', () => {
    const git = makeGit({
      commits: {
        ahead: [],
        behind: [commit(10, T - 100), commit(11, T - 200)],
        shared: [commit(20, T - 300)],
      },
    });
    const graph = buildGitGraph(git);
    expect(graph.singleLane).toBe(true);
    expect(graph.laneLabels).toHaveLength(1);
    // 落后时顶部最新提交属于参照分支
    expect(graph.laneLabels[0]).toMatchObject({ lane: 0, kind: 'base', label: 'main' });
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(graph.forkRowIndex).toBeNull();
    // 单泳道每行都只有一条竖线
    expect(graph.rows.every((row) => row.activeLanes.length === 1 && row.lane === 0)).toBe(true);
  });

  it('base===null 时单泳道，泳道标签用当前分支', () => {
    const git = makeGit({
      base: null,
      upstream: null,
      commits: { ahead: [], behind: [], shared: [commit(0, T), commit(1, T - 100)] },
    });
    const graph = buildGitGraph(git);
    expect(graph.singleLane).toBe(true);
    expect(graph.laneLabels).toEqual([{ lane: 0, kind: 'current', label: 'feat/x' }]);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0]);
    expect(graph.rows.every((row) => row.forkPoint === false)).toBe(true);
  });

  it('detached 时当前泳道 label 为 null（由组件渲染 HEAD 文案）', () => {
    const git = makeGit({
      current: {
        ...makeGit().current,
        branch: null,
        detached: true,
      },
      commits: {
        ahead: [commit(0, T)],
        behind: [],
        shared: [commit(20, T - 100)],
      },
    });
    const graph = buildGitGraph(git);
    expect(graph.singleLane).toBe(false);
    expect(graph.laneLabels[1]).toEqual({ lane: 1, kind: 'current', label: null });
  });

  it('当前分支与参照分支同一提交（ahead/behind 均为空）也能构建', () => {
    const git = makeGit({
      base: { ...makeGit().base!, ahead: 0, behind: 0 },
      commits: { ahead: [], behind: [], shared: [commit(0, T)] },
    });
    const graph = buildGitGraph(git);
    expect(graph.singleLane).toBe(true);
    expect(graph.laneLabels[0]).toMatchObject({ kind: 'current', label: 'feat/x' });
    expect(graph.rows).toHaveLength(1);
  });

  it('完全没有提交时返回空行（组件整块隐藏）', () => {
    const git = makeGit({ commits: { ahead: [], behind: [], shared: [] } });
    const graph = buildGitGraph(git);
    expect(graph.rows).toEqual([]);
    expect(graph.totalRows).toBe(0);
    expect(graph.hiddenCount).toBe(0);
  });
});

describe('buildGitGraph 分叉点与泳道线', () => {
  it('分叉点是 shared 首条（mergeBase），该行两泳道汇合（泳道 1 不再穿过该行）', () => {
    const git = makeGit({
      commits: {
        ahead: [commit(0, T), commit(1, T - 100)],
        behind: [commit(10, T - 50)],
        shared: [commit(20, T - 200), commit(21, T - 300)],
      },
      refs: [
        ref('HEAD', 'sha-0', 'head'),
        ref('feat/x', 'sha-0', 'branch'),
        ref('main', 'sha-20', 'base'),
      ],
    });
    const graph = buildGitGraph(git);
    // 合并段：A0(T, lane1) → B10(T-50, lane0) → A1(T-100, lane1)，随后 shared[0] 是分叉点
    expect(graph.forkRowIndex).toBe(3);
    expect(graph.rows.map((row) => row.sha)).toEqual(['sha-0', 'sha-10', 'sha-1', 'sha-20', 'sha-21']);
    expect(graph.rows.map((row) => row.forkPoint)).toEqual([false, false, false, true, false]);
    expect(graph.rows.map((row) => row.activeLanes)).toEqual([
      [1], // 泳道 0 还没出现，只有当前分支线
      [0, 1], // 两边都有提交时两条线都穿过
      [0, 1],
      [0], // 分叉点行：泳道 1 汇入，不再单独穿过
      [0], // 分叉之后只剩参照分支线
    ]);
    expect(graph.laneLabels).toEqual([
      { lane: 0, kind: 'base', label: 'main' },
      { lane: 1, kind: 'current', label: 'feat/x' },
    ]);
    expect(graph.singleLane).toBe(false);
  });

  it('没有 shared 提交时不画分叉点', () => {
    const git = makeGit({
      commits: { ahead: [commit(0, T)], behind: [commit(10, T - 100)], shared: [] },
    });
    const graph = buildGitGraph(git);
    expect(graph.forkRowIndex).toBeNull();
    expect(graph.rows.every((row) => row.forkPoint === false)).toBe(true);
  });

  it('泳道 1 的线一直延续到分叉点前一行为止', () => {
    const git = makeGit({
      commits: {
        ahead: [commit(0, T), commit(1, T - 300)],
        behind: [commit(10, T - 100), commit(11, T - 200)],
        shared: [commit(20, T - 400)],
      },
    });
    const graph = buildGitGraph(git);
    const laneOneRows = graph.rows
      .map((row, index) => ({ index, lanes: row.activeLanes }))
      .filter((item) => item.lanes.includes(1))
      .map((item) => item.index);
    expect(laneOneRows).toEqual([0, 1, 2, 3]);
    expect(graph.forkRowIndex).toBe(4);
  });
});

describe('buildGitGraph refs 合并', () => {
  it('同一 sha 的 refs 合并到同一行；HEAD 排最前；同名去重；其他 sha 不串行', () => {
    const git = makeGit({
      commits: {
        ahead: [commit(0, T), commit(1, T - 100)],
        behind: [],
        shared: [commit(20, T - 200)],
      },
      refs: [
        ref('origin/feat/x', 'sha-0', 'upstream'),
        ref('feat/x', 'sha-0', 'branch'),
        ref('HEAD', 'sha-0', 'head'),
        ref('feat/x', 'sha-0', 'branch'), // 重复项
        ref('main', 'sha-20', 'base'),
        ref('origin/main', 'sha-20', 'base'),
        ref('main', 'sha-20', 'base'), // 重复项
        ref('stale', 'sha-not-fetched', 'branch'), // 未出现在提交列表里
      ],
    });
    const graph = buildGitGraph(git);
    const head = graph.rows.find((row) => row.sha === 'sha-0');
    expect(head?.refs.map((item) => item.name)).toEqual(['HEAD', 'feat/x', 'origin/feat/x']);
    const fork = graph.rows.find((row) => row.sha === 'sha-20');
    expect(fork?.refs.map((item) => item.name)).toEqual(['main', 'origin/main']);
    expect(fork?.forkPoint).toBe(true);
    // 没有 ref 的行不产生空徽标
    const middle = graph.rows.find((row) => row.sha === 'sha-1');
    expect(middle?.refs).toEqual([]);
    // 未展示的 sha 不影响行数据
    expect(graph.rows.some((row) => row.sha === 'sha-not-fetched')).toBe(false);
  });
});

describe('buildGitGraph 12 行截断', () => {
  it('超过上限只保留前 12 行，并给出隐藏计数', () => {
    const ahead = Array.from({ length: 10 }, (_, index) => commit(index, T - index * 10));
    const behind = Array.from({ length: 10 }, (_, index) => commit(100 + index, T - 5 - index * 10));
    const git = makeGit({ commits: { ahead, behind, shared: [] } });
    const graph = buildGitGraph(git);
    expect(GIT_GRAPH_MAX_ROWS).toBe(12);
    expect(graph.totalRows).toBe(20);
    expect(graph.rows).toHaveLength(12);
    expect(graph.hiddenCount).toBe(8);
    // 截断后按时间倒序取最新 12 条
    expect(graph.rows[0]?.sha).toBe('sha-0');
  });

  it('分叉点优先：领先 12 条时保留 fork 行 + shared 行，只裁掉 ahead/behind', () => {
    const ahead = Array.from({ length: 12 }, (_, index) => commit(index, T - index * 10));
    const shared = [commit(200, T - 500), commit(201, T - 600), commit(202, T - 700)];
    const git = makeGit({ commits: { ahead, behind: [], shared } });
    const graph = buildGitGraph(git);
    expect(graph.rows).toHaveLength(12);
    // 9 条 ahead（12 − 3 条 shared 尾行）+ 3 条 shared
    expect(graph.rows.slice(0, 9).every((row) => row.source === 'ahead')).toBe(true);
    expect(graph.rows.slice(9).every((row) => row.source === 'shared')).toBe(true);
    expect(graph.rows[9]?.sha).toBe('sha-200'); // mergeBase / 分叉点
    expect(graph.forkRowIndex).toBe(9);
    expect(graph.rows[9]?.forkPoint).toBe(true);
    // 隐藏计数只算被省略的 ahead 行
    expect(graph.hiddenCount).toBe(12 - 9);
    expect(graph.gapIndex).toBe(9);
    // 参照泳道可见：两条泳道标签都在
    expect(graph.laneLabels.map((lane) => lane.kind)).toEqual(['base', 'current']);
  });

  it('ahead 20 条时 fork 与 2 条以上 shared 行仍可见，hiddenCount 正确', () => {
    const ahead = Array.from({ length: 20 }, (_, index) => commit(index, T - index * 10));
    const shared = Array.from({ length: 4 }, (_, index) => commit(300 + index, T - 400 - index * 10));
    const git = makeGit({ commits: { ahead, behind: [], shared } });
    const graph = buildGitGraph(git);
    expect(graph.totalRows).toBe(24);
    expect(graph.rows).toHaveLength(12);
    // 12 行 = 8 条 ahead + 4 条 shared（fork 行是 shared 首条）
    expect(graph.forkRowIndex).toBe(8);
    const forkRow = graph.rows[8];
    expect(forkRow?.forkPoint).toBe(true);
    expect(forkRow?.sha).toBe('sha-300');
    expect(graph.rows.slice(8).map((row) => row.sha)).toEqual(['sha-300', 'sha-301', 'sha-302', 'sha-303']);
    // 至少 2 条 shared 行可见（实际 3 条：fork + 2 条更旧）
    expect(graph.rows.length - 1 - graph.forkRowIndex!).toBeGreaterThanOrEqual(2);
    // hiddenCount 只算被省略的 ahead 行：20 − 8
    expect(graph.hiddenCount).toBe(12);
    expect(graph.gapIndex).toBe(8);
  });

  it('分叉点优先时 behind 行同样计入被省略的合并段', () => {
    const ahead = Array.from({ length: 10 }, (_, index) => commit(index, T - index * 10));
    const behind = Array.from({ length: 3 }, (_, index) => commit(100 + index, T - 5 - index * 20));
    const shared = Array.from({ length: 4 }, (_, index) => commit(300 + index, T - 400 - index * 10));
    const git = makeGit({ commits: { ahead, behind, shared } });
    const graph = buildGitGraph(git);
    expect(graph.rows).toHaveLength(12);
    expect(graph.forkRowIndex).toBe(8);
    // 省略合并段尾部 5 行（13 − 8），shared 4 行全保留
    expect(graph.hiddenCount).toBe(ahead.length + behind.length - 8);
    expect(graph.gapIndex).toBe(8);
  });

  it('单泳道截断维持原逻辑（从新到旧取 12 条）', () => {
    const shared = Array.from({ length: 20 }, (_, index) => commit(400 + index, T - index * 10));
    const git = makeGit({ base: null, upstream: null, commits: { ahead: [], behind: [], shared } });
    const graph = buildGitGraph(git);
    expect(graph.singleLane).toBe(true);
    expect(graph.rows).toHaveLength(12);
    expect(graph.hiddenCount).toBe(8);
    expect(graph.forkRowIndex).toBeNull();
    expect(graph.gapIndex).toBeNull();
    expect(graph.rows[0]?.sha).toBe('sha-400');
  });

  it('没有 shared 行时不画分叉点，直接截断（防御性数据）', () => {
    const ahead = Array.from({ length: 12 }, (_, index) => commit(index, T - index * 10));
    const git = makeGit({ commits: { ahead, behind: [], shared: [] } });
    const graph = buildGitGraph(git);
    expect(graph.forkRowIndex).toBeNull();
    expect(graph.gapIndex).toBeNull();
    expect(graph.hiddenCount).toBe(0);
    // 参照泳道没有任何可见提交：图例只保留当前分支，避免出现没有线的泳道标签
    expect(graph.laneLabels).toEqual([{ lane: 1, kind: 'current', label: 'feat/x' }]);
  });

  it('恰好 12 行时不截断', () => {
    const ahead = Array.from({ length: 9 }, (_, index) => commit(index, T - index * 10));
    const git = makeGit({
      commits: { ahead, behind: [], shared: [commit(200, T - 500), commit(201, T - 600), commit(202, T - 700)] },
    });
    const graph = buildGitGraph(git);
    expect(graph.totalRows).toBe(12);
    expect(graph.rows).toHaveLength(12);
    expect(graph.hiddenCount).toBe(0);
    expect(graph.forkRowIndex).toBe(9);
  });
});

describe('shouldShowWorktreeCounts', () => {
  const mainWorktree = { branch: 'main' };

  it('base.kind=main：主工作树行（branch===base.branch）的 ↑0↓0 是自比噪声，隐藏', () => {
    expect(shouldShowWorktreeCounts(mainWorktree, { kind: 'main', branch: 'main' })).toBe(false);
  });

  it('base.kind=main：其他工作树行保留计数', () => {
    expect(shouldShowWorktreeCounts({ branch: 'feat/x' }, { kind: 'main', branch: 'main' })).toBe(true);
  });

  it('base.kind=upstream：主工作树行保留（相对远端有真实差异）', () => {
    expect(shouldShowWorktreeCounts(mainWorktree, { kind: 'upstream', branch: 'main' })).toBe(true);
  });

  it('base 缺失 / detached 工作树不因这条规则被隐藏', () => {
    expect(shouldShowWorktreeCounts(mainWorktree, null)).toBe(true);
    expect(shouldShowWorktreeCounts({ branch: null }, { kind: 'main', branch: 'main' })).toBe(true);
  });
});

describe('shortenPath', () => {
  it('保留末尾两段（抽屉窄，完整路径靠 title）', () => {
    expect(shortenPath('/Users/roxor/Desktop/dsh/dsh kanban')).toBe('dsh/dsh kanban');
    expect(shortenPath('/Users/roxor/Desktop/dsh/dsh kanban/')).toBe('dsh/dsh kanban');
    expect(shortenPath('/repo/.agents/worktrees/feat/x')).toBe('feat/x');
  });

  it('兼容 Windows 路径、不足两段与空值', () => {
    expect(shortenPath('C:\\work\\project\\')).toBe('work/project');
    expect(shortenPath('/repo')).toBe('repo');
    expect(shortenPath('')).toBe('');
    expect(shortenPath(null)).toBe('');
    expect(shortenPath(undefined)).toBe('');
  });

  it('可指定保留段数', () => {
    expect(shortenPath('/a/b/c/d', 3)).toBe('b/c/d');
    expect(shortenPath('/a/b/c/d', 1)).toBe('d');
  });
});
