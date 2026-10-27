import { describe, expect, it } from 'vitest';
import {
  FORK_GRAPH_COLOR_COUNT,
  buildForkGraph,
  shortenPath,
  shouldShowWorktreeCounts,
} from './forkGraph';
import type { GitGraphCommit, GitGraphData, GitGraphRef } from '../types';

const T = Date.UTC(2026, 10, 1, 12, 0, 0);

function commit(sha: string, parents: string[], minutesAgo: number, subject = `commit ${sha}`): GitGraphCommit {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject,
    authorName: 'tester',
    committedAt: T - minutesAgo * 60_000,
    parents,
  };
}

function ref(
  name: string,
  sha: string,
  kind: GitGraphRef['kind'] = 'branch',
  extra: Partial<GitGraphRef> = {},
): GitGraphRef {
  return { name, kind, sha, shortSha: sha.slice(0, 7), branch: kind === 'remote' ? null : name, ...extra };
}

function makeGraph(overrides: Partial<GitGraphData> = {}): GitGraphData {
  return { refs: [], commits: [], truncated: 0, ...overrides };
}

describe('buildForkGraph 线性单分支', () => {
  const commits = [
    commit('aaaaaaa1', ['bbbbbbb2'], 0),
    commit('bbbbbbb2', ['ccccccc3'], 10),
    commit('ccccccc3', [], 20),
  ];
  const graph = makeGraph({
    refs: [ref('HEAD', 'aaaaaaa1', 'head', { branch: 'main' }), ref('main', 'aaaaaaa1', 'branch', { isCurrent: true })],
    commits,
  });
  const layout = buildForkGraph(graph);

  it('同 sha 的 HEAD / 分支共用一条种子泳道，laneCount 至少 2', () => {
    expect(layout.laneCount).toBe(2);
    expect(layout.refs.map((item) => item.lane)).toEqual([0, 0]);
    expect(layout.refs.map((item) => item.color)).toEqual([0, 0]);
  });

  it('每个提交都落在泳道 0，HEAD 行标记 isHead，当前行有 dot→bottom 延续', () => {
    expect(layout.rows.map((row) => row.dot.lane)).toEqual([0, 0, 0]);
    expect(layout.rows.map((row) => row.dot.color)).toEqual([0, 0, 0]);
    expect(layout.rows.map((row) => row.dot.isHead)).toEqual([true, false, false]);
    expect(layout.rows[0]?.segments).toEqual([
      { fromLane: 0, fromY: 'dot', toLane: 0, toY: 'bottom', color: 0 },
    ]);
    // 中间行：从上面接进圆点 + 继续向下
    expect(layout.rows[1]?.segments).toEqual([
      { fromLane: 0, fromY: 'top', toLane: 0, toY: 'dot', color: 0 },
      { fromLane: 0, fromY: 'dot', toLane: 0, toY: 'bottom', color: 0 },
    ]);
    // 根提交：线在圆点结束
    expect(layout.rows[2]?.segments).toEqual([{ fromLane: 0, fromY: 'top', toLane: 0, toY: 'dot', color: 0 }]);
  });

  it('行右侧带该 sha 的 refs 徽标（HEAD + 分支）', () => {
    expect(layout.rows[0]?.refs.map((item) => item.name)).toEqual(['HEAD', 'main']);
    expect(layout.rows[1]?.refs).toEqual([]);
  });
});

describe('buildForkGraph 两分支汇合', () => {
  it('同一父提交被两条泳道期望：父提交行画出汇入曲线并释放多余泳道（分支颜色不切换）', () => {
    const graph = makeGraph({
      refs: [
        ref('HEAD', 'aaaaaaa1', 'head', { branch: 'feat/x' }),
        ref('main', 'bbbbbbb2', 'branch'),
      ],
      commits: [
        commit('aaaaaaa1', ['ccccccc3'], 0), // 当前分支 tip，父 = 公共祖先
        commit('bbbbbbb2', ['ccccccc3'], 5), // main tip，父 = 同一个公共祖先
        commit('ccccccc3', [], 10),
      ],
    });
    const layout = buildForkGraph(graph);
    // 当前分支 tip 在泳道 0；main tip 在泳道 1
    expect(layout.rows.map((row) => row.dot.lane)).toEqual([0, 1, 0]);
    expect(layout.rows.map((row) => row.dot.color)).toEqual([0, 1, 0]);
    // 两条分支各自沿自己的泳道向下等公共祖先，不换道
    expect(layout.rows[0]?.segments).toContainEqual({
      fromLane: 0,
      fromY: 'dot',
      toLane: 0,
      toY: 'bottom',
      color: 0,
    });
    expect(layout.rows[1]?.segments).toContainEqual({
      fromLane: 1,
      fromY: 'dot',
      toLane: 1,
      toY: 'bottom',
      color: 1,
    });
    // 公共祖先行：最左泳道 0 拿圆点；泳道 1 的线以汇入曲线（top→dot）进入圆点后被释放
    expect(layout.rows[2]?.dot.lane).toBe(0);
    expect(layout.rows[2]?.segments).toContainEqual({
      fromLane: 1,
      fromY: 'top',
      toLane: 0,
      toY: 'dot',
      color: 1,
    });
    expect(layout.rows[2]?.segments).toContainEqual({
      fromLane: 0,
      fromY: 'top',
      toLane: 0,
      toY: 'dot',
      color: 0,
    });
    expect(layout.laneCount).toBe(2);
  });
});

describe('buildForkGraph 合并提交', () => {
  it('双父：第一父沿用当前泳道，第二父占空闲泳道并出弯，合并提交标记 isMerge', () => {
    const graph = makeGraph({
      refs: [ref('HEAD', 'aaaaaaa1', 'head', { branch: 'main' })],
      commits: [
        commit('aaaaaaa1', ['bbbbbbb2', 'ccccccc3'], 0), // merge：父 P1 + P2
        commit('bbbbbbb2', ['ddddddd4'], 5), // P1 链
        commit('ccccccc3', ['ddddddd4'], 6), // P2 链
        commit('ddddddd4', [], 10),
      ],
    });
    const layout = buildForkGraph(graph);
    expect(layout.rows[0]?.dot.isMerge).toBe(true);
    expect(layout.rows[1]?.dot.isMerge).toBe(false);
    expect(layout.rows[0]?.dot.lane).toBe(0);
    // 第一父（P1）留在泳道 0
    expect(layout.rows[0]?.segments).toContainEqual({
      fromLane: 0,
      fromY: 'dot',
      toLane: 0,
      toY: 'bottom',
      color: 0,
    });
    // 第二父（P2）拿到新泳道 1，出弯
    expect(layout.rows[0]?.segments).toContainEqual({
      fromLane: 0,
      fromY: 'dot',
      toLane: 1,
      toY: 'bottom',
      color: 1,
    });
    expect(layout.rows[1]?.dot.lane).toBe(0);
    expect(layout.rows[2]?.dot.lane).toBe(1);
    // P2 的泳道也一路沿用第一父（主干 lane0 同时在等它），不换道
    expect(layout.rows[2]?.segments).toContainEqual({
      fromLane: 1,
      fromY: 'dot',
      toLane: 1,
      toY: 'bottom',
      color: 1,
    });
    // 到公共祖先行才汇合：泳道 1 以汇入曲线进入泳道 0 的圆点后释放
    expect(layout.rows[3]?.dot.lane).toBe(0);
    expect(layout.rows[3]?.segments).toContainEqual({
      fromLane: 1,
      fromY: 'top',
      toLane: 0,
      toY: 'dot',
      color: 1,
    });
    expect(layout.laneCount).toBe(2);
  });

  it('第二父已有泳道期望时出弯到已有泳道，不新增列', () => {
    const graph = makeGraph({
      refs: [
        ref('HEAD', 'aaaaaaa1', 'head', { branch: 'main' }),
        ref('feat/y', 'ccccccc3', 'branch'), // 提前占一条泳道等待 P2
      ],
      commits: [
        commit('aaaaaaa1', ['bbbbbbb2', 'ccccccc3'], 0),
        commit('bbbbbbb2', ['ddddddd4'], 5),
        commit('ccccccc3', ['ddddddd4'], 6),
        commit('ddddddd4', [], 10),
      ],
    });
    const layout = buildForkGraph(graph);
    expect(layout.refs.map((item) => item.lane)).toEqual([0, 1]);
    expect(layout.laneCount).toBe(2);
    expect(layout.rows[0]?.segments).toContainEqual({
      fromLane: 0,
      fromY: 'dot',
      toLane: 1,
      toY: 'bottom',
      color: 1,
    });
    // 已有泳道的线保持 active：P2 行从上面接进圆点
    expect(layout.rows[2]?.dot.lane).toBe(1);
    expect(layout.rows[2]?.segments).toContainEqual({
      fromLane: 1,
      fromY: 'top',
      toLane: 1,
      toY: 'dot',
      color: 1,
    });
  });
});

describe('buildForkGraph 主干颜色稳定（第一父一律沿用当前泳道）', () => {
  it('main 第一父同时被 origin/main 期望时，main 主干仍保持 lane0/颜色不变，共同祖先行才汇合', () => {
    const graph = makeGraph({
      refs: [
        ref('HEAD', 'aaaaaaa1', 'head', { branch: 'main' }),
        ref('main', 'aaaaaaa1', 'branch', { isCurrent: true, upstream: 'origin/main', ahead: 2, behind: 0 }),
        ref('origin/main', 'ddddddd4', 'remote'), // 远端 tip 落在主干祖先上
      ],
      commits: [
        commit('aaaaaaa1', ['bbbbbbb2', 'ddddddd4'], 0), // main 上的合并提交：P1 主干 + P2 已被 origin/main 指向
        commit('bbbbbbb2', ['ccccccc3'], 5),
        commit('ccccccc3', ['ddddddd4'], 6), // main 主干继续到共同祖先
        commit('ddddddd4', ['eeeeeee5'], 10), // 共同祖先（origin/main tip）
        commit('eeeeeee5', [], 15),
      ],
    });
    const layout = buildForkGraph(graph);
    // 合并提交之后的 main 主干每一行都留在 lane0，颜色不切换
    expect(layout.rows.map((row) => row.dot.lane)).toEqual([0, 0, 0, 0, 0]);
    expect(layout.rows.map((row) => row.dot.color)).toEqual([0, 0, 0, 0, 0]);
    // 主干继续走自己的泳道，不会出弯到 origin/main 的泳道
    expect(layout.rows[2]?.segments).toContainEqual({
      fromLane: 0,
      fromY: 'dot',
      toLane: 0,
      toY: 'bottom',
      color: 0,
    });
    expect(layout.rows[2]?.segments.some((segment) => segment.fromLane === 0 && segment.toLane !== 0)).toBe(false);
    // 共同祖先行：origin/main 泳道（1）的线以汇入曲线进入 lane0 圆点，然后被释放
    expect(layout.rows[3]?.dot.lane).toBe(0);
    expect(layout.rows[3]?.segments).toContainEqual({
      fromLane: 1,
      fromY: 'top',
      toLane: 0,
      toY: 'dot',
      color: 1,
    });
    // 汇合后 origin/main 泳道不再画线（最后一行只有主干自己的线）
    expect(layout.rows[4]?.segments).toEqual([{ fromLane: 0, fromY: 'top', toLane: 0, toY: 'dot', color: 0 }]);
    // 汇合没有产生多余列
    expect(layout.laneCount).toBe(2);
  });
});

describe('buildForkGraph 同一父被多泳道期望', () => {
  it('两条分支各自沿自己的泳道等到同一个父提交：父提交行出现跨泳道汇入段', () => {
    const graph = makeGraph({
      refs: [
        ref('HEAD', 'aaaaaaa1', 'head', { branch: 'feat/a' }),
        ref('feat/b', 'bbbbbbb2', 'branch'),
      ],
      commits: [
        commit('aaaaaaa1', ['ccccccc3'], 0),
        commit('bbbbbbb2', ['ccccccc3'], 5),
        commit('ccccccc3', [], 10),
      ],
    });
    const layout = buildForkGraph(graph);
    // 两条泳道都继续期望公共父提交（允许同一 sha 被多条泳道期望）
    expect(layout.rows[0]?.dot.lane).toBe(0);
    expect(layout.rows[1]?.dot.lane).toBe(1);
    // 「同一父被多 lane 期望」路径现在真正可达：存在 fromLane≠toLane 且以 dot 结束的汇入段
    const mergeIns = layout.rows[2]?.segments.filter((segment) => segment.fromLane !== segment.toLane && segment.toY === 'dot');
    expect(mergeIns).toEqual([{ fromLane: 1, fromY: 'top', toLane: 0, toY: 'dot', color: 1 }]);
    expect(layout.rows[2]?.dot.lane).toBe(0);
    expect(layout.laneCount).toBe(2);
  });
});

describe('buildForkGraph 泳道序号稳定与槽位复用', () => {
  it('释放的泳道不左移，后续父提交复用最小空闲槽位', () => {
    const graph = makeGraph({
      refs: [
        ref('HEAD', 'aaaaaaa1', 'head', { branch: 'main' }),
        ref('feat/w', 'eeeeeee5', 'branch'),
      ],
      commits: [
        commit('aaaaaaa1', ['bbbbbbb2', 'ccccccc3'], 0), // merge → 第二父占泳道 2
        commit('bbbbbbb2', ['ddddddd4'], 5),
        commit('ccccccc3', [], 6), // 根提交：释放泳道 2
        commit('eeeeeee5', ['hhhhhhh8', 'ggggggg7'], 7), // 另一个 merge：复用释放的泳道 2
        commit('ddddddd4', [], 10),
        commit('hhhhhhh8', [], 11),
        commit('ggggggg7', [], 12),
      ],
      truncated: 3,
      refsTruncated: 2,
    });
    const layout = buildForkGraph(graph);
    // 种子：HEAD → 泳道 0，feat/w → 泳道 1；泳道 2 由合并提交的第二父创建
    expect(layout.rows.map((row) => row.dot.lane)).toEqual([0, 0, 2, 1, 0, 1, 2]);
    expect(layout.laneCount).toBe(3);
    // 泳道 2 在 ccccccc3 行释放后，被 eeeeeee5 的第二父复用（不是新列 3）
    expect(layout.rows[3]?.segments).toContainEqual({
      fromLane: 1,
      fromY: 'dot',
      toLane: 2,
      toY: 'bottom',
      color: 2,
    });
    // 贯穿线：处理泳道 0 的提交时，泳道 2 的线竖直穿过
    expect(layout.rows[1]?.segments).toContainEqual({
      fromLane: 2,
      fromY: 'top',
      toLane: 2,
      toY: 'bottom',
      color: 2,
    });
    // 截断计数原样透传
    expect(layout.truncated).toBe(3);
    expect(layout.refsTruncated).toBe(2);
  });
});

describe('buildForkGraph refs 与颜色', () => {
  it('tip 不在 commits 里的 ref 不占泳道，但给图例颜色', () => {
    const graph = makeGraph({
      refs: [
        ref('HEAD', 'aaaaaaa1', 'head', { branch: 'main' }),
        ref('main', 'aaaaaaa1', 'branch', { isCurrent: true }),
        ref('old/stale', '99999999', 'branch'), // tip 被 48 条上限截掉
      ],
      commits: [commit('aaaaaaa1', [], 0)],
    });
    const layout = buildForkGraph(graph);
    expect(layout.refs.map((item) => item.lane)).toEqual([0, 0, null]);
    expect(layout.refs[2]?.color).toBeGreaterThanOrEqual(0);
    expect(layout.refs[2]?.color).toBeLessThan(FORK_GRAPH_COLOR_COUNT);
  });

  it('颜色按泳道序号循环 8 色', () => {
    const shas = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9'].map((item) => `${item}00000${item}`);
    const refs = shas.map((sha, index) => ref(`branch-${index}`, sha, 'branch'));
    const commits = shas.map((sha, index) => commit(sha, [], index));
    const layout = buildForkGraph(makeGraph({ refs, commits }));
    expect(layout.refs.map((item) => item.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0]);
    expect(layout.rows.map((row) => row.dot.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0]);
    expect(layout.laneCount).toBe(9);
    expect(layout.colorCount).toBe(8);
  });

  it('HEAD 标记只给 HEAD ref 的 sha', () => {
    const graph = makeGraph({
      refs: [ref('HEAD', 'bbbbbbb2', 'head', { branch: 'main' }), ref('main', 'aaaaaaa1', 'branch')],
      commits: [commit('aaaaaaa1', ['bbbbbbb2'], 0), commit('bbbbbbb2', [], 5)],
    });
    const layout = buildForkGraph(graph);
    expect(layout.rows.map((row) => row.dot.isHead)).toEqual([false, true]);
  });
});

describe('buildForkGraph 边界', () => {
  it('空 commits 也能给出图例与最小列数', () => {
    const layout = buildForkGraph(
      makeGraph({ refs: [ref('HEAD', 'aaaaaaa1', 'head', { branch: 'main' })], commits: [], truncated: 9 }),
    );
    expect(layout.rows).toEqual([]);
    expect(layout.laneCount).toBe(2);
    expect(layout.refs[0]?.lane).toBeNull();
    expect(layout.truncated).toBe(9);
  });
});

describe('shortenPath', () => {
  it('保留末尾两段（抽屉窄，完整路径靠 title）', () => {
    expect(shortenPath('/Users/roxor/Desktop/dsh/dsh kanban')).toBe('dsh/dsh kanban');
    expect(shortenPath('/Users/roxor/Desktop/dsh/dsh kanban/')).toBe('dsh/dsh kanban');
    expect(shortenPath('/repo/.agents/worktrees/feat/x')).toBe('feat/x');
    expect(shortenPath('C:\\work\\project\\')).toBe('work/project');
    expect(shortenPath('/repo')).toBe('repo');
    expect(shortenPath('')).toBe('');
    expect(shortenPath(null)).toBe('');
    expect(shortenPath('/a/b/c/d', 3)).toBe('b/c/d');
  });
});

describe('shouldShowWorktreeCounts', () => {
  it('base.kind=main：主工作树行是自比，隐藏 0/0', () => {
    expect(shouldShowWorktreeCounts({ branch: 'main' }, { kind: 'main', branch: 'main' })).toBe(false);
    expect(shouldShowWorktreeCounts({ branch: 'feat/x' }, { kind: 'main', branch: 'main' })).toBe(true);
  });

  it('base.kind=upstream 或 base 缺失时保留计数', () => {
    expect(shouldShowWorktreeCounts({ branch: 'main' }, { kind: 'upstream', branch: 'main' })).toBe(true);
    expect(shouldShowWorktreeCounts({ branch: 'main' }, null)).toBe(true);
    expect(shouldShowWorktreeCounts({ branch: null }, { kind: 'main', branch: 'main' })).toBe(true);
  });
});
