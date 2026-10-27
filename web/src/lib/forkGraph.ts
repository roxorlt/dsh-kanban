/**
 * Fork 风格多分支提交图的泳道布局（纯函数，无 React 依赖）。
 *
 * 输入：docs/contracts/06-git-context.md §3 的 `git.graph`（refs + commits，commits 为 --date-order，
 * 父提交永远出现在孩子之后）。输出：逐行泳道几何数据 + 图例 refs。
 *
 * 算法（契约 §5）：
 * 1. 种子泳道：按 refs 顺序分配，sha 相同共用一条泳道；只给 sha 出现在 commits 里的 ref 分配泳道。
 * 2. lanes[i] = { sha|null, color, active }：sha 是该泳道「下一个期望的提交」，
 *    active = 线已经从上方画到当前行（false = 线还未开始，或已结束）。
 * 3. 自上而下遍历 commits：dotLane = 期望该 sha 的最左泳道；其余同 sha 泳道画汇入曲线后释放。
 * 4. 第一父**一律沿用当前泳道**（即使别的泳道也在等同一个 sha —— 两条泳道同时期望同一提交是
 *    允许的中间状态，主干/当前分支颜色因此保持稳定）；汇合发生在父提交那一行：多泳道匹配时
 *    最左泳道拿圆点、其余画汇入曲线后释放。
 *    其余父已有泳道期望则出弯汇入，否则占空闲泳道（没有空闲就追加新列），颜色 = 泳道序号 % 8。
 * 5. 泳道序号稳定、不左移；释放的泳道置空槽位，可被后面的父提交复用。
 *
 * 另外把 v0.13 的 shortenPath / shouldShowWorktreeCounts 迁到这里（行为不变）。
 */
import type { GitBase, GitGraphCommit, GitGraphData, GitGraphRef, GitWorktree } from '../types';

/** 调色板槽位数（drawer.css 里 `--kb-git-lane-0..7`）。 */
export const FORK_GRAPH_COLOR_COUNT = 8;

/** lane 数超过该值时列宽从 14px 收窄到 12px（渲染层用，布局算法不感知像素）。 */
export const FORK_GRAPH_COMPACT_LANE_COUNT = 8;

/** 每行连线：同泳道是竖直线，跨泳道是平滑三次贝塞尔曲线。 */
export interface ForkGraphSegment {
  fromLane: number;
  fromY: 'top' | 'dot';
  toLane: number;
  toY: 'dot' | 'bottom';
  /** 调色板槽位 0..7（渲染层映射到 --kb-git-lane-N） */
  color: number;
}

export interface ForkGraphDot {
  lane: number;
  color: number;
  /** 合并提交（parents.length > 1）：渲染成双环 */
  isMerge: boolean;
  /** 该提交是 HEAD 引用的 sha：渲染时加深外环 */
  isHead: boolean;
}

export interface ForkGraphRow {
  commit: GitGraphCommit;
  /** 该提交上的 refs 徽标（同一 sha 的引用，按 graph.refs 顺序） */
  refs: ForkGraphRefInfo[];
  segments: ForkGraphSegment[];
  dot: ForkGraphDot;
}

/** 图例项：ref + 种子泳道/颜色；tip 不在 commits 里的 ref lane=null（只在图例/工作树展示）。 */
export interface ForkGraphRefInfo extends GitGraphRef {
  lane: number | null;
  color: number;
}

export interface ForkGraphLayout {
  rows: ForkGraphRow[];
  /** 图例用，顺序 = graph.refs 顺序 */
  refs: ForkGraphRefInfo[];
  /** 渲染列数，至少 2 列（单分支也不至于窄成一条线） */
  laneCount: number;
  colorCount: number;
  /** 引用范围内被省略的提交数（原样透传 graph.truncated） */
  truncated: number;
  /** 被省略的引用数（原样透传 graph.refsTruncated ?? 0） */
  refsTruncated: number;
}

interface ForkLane {
  /** 该泳道下一个期望的提交 sha；null = 空槽位 */
  sha: string | null;
  color: number;
  /** 线是否已经从上方画到当前行 */
  active: boolean;
}

function laneColor(lane: number): number {
  return lane % FORK_GRAPH_COLOR_COUNT;
}

/** 找第一条「期望该 sha」的泳道（其余父提交出弯用），没有返回 null。 */
function findLaneExpecting(lanes: readonly ForkLane[], sha: string): number | null {
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index]?.sha === sha) return index;
  }
  return null;
}

/** 找一个空槽位；没有则追加新列。返回泳道序号（颜色 = 序号 % 8）。 */
function allocateLane(lanes: ForkLane[]): number {
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index]?.sha === null) return index;
  }
  lanes.push({ sha: null, color: laneColor(lanes.length), active: false });
  return lanes.length - 1;
}

/**
 * 种子泳道 + 图例 refs。
 * 只把 sha 出现在 commits 里的 ref 作为种子；同 sha 共用泳道；tip 被 48 条上限截掉的 ref
 * 只给颜色（lane=null），仅在图例/工作树列表展示。
 */
function seedLanes(graph: GitGraphData): { lanes: ForkLane[]; refs: ForkGraphRefInfo[] } {
  const commitShas = new Set(graph.commits.map((commit) => commit.sha));
  const shaToLane = new Map<string, number>();
  const lanes: ForkLane[] = [];
  const refs: ForkGraphRefInfo[] = [];
  let unseededCount = 0;
  for (const ref of graph.refs) {
    let lane: number | null = null;
    if (commitShas.has(ref.sha)) {
      const existing = shaToLane.get(ref.sha);
      if (existing === undefined) {
        lane = lanes.length;
        lanes.push({ sha: ref.sha, color: laneColor(lane), active: false });
        shaToLane.set(ref.sha, lane);
      } else {
        lane = existing;
      }
    }
    refs.push({
      ...ref,
      lane,
      // 没进图的 ref 也给一个稳定颜色，图例圆点不至于全灰
      color: lane !== null ? laneColor(lane) : laneColor(lanes.length + unseededCount),
    });
    if (lane === null) unseededCount += 1;
  }
  return { lanes, refs };
}

/**
 * 把 `graph` 转成逐行泳道布局。
 * @param graph 契约 §3 的 `git.graph`（仅当服务端返回该字段时调用）
 */
export function buildForkGraph(graph: GitGraphData): ForkGraphLayout {
  const { lanes, refs } = seedLanes(graph);
  const headSha = graph.refs.find((ref) => ref.kind === 'head')?.sha ?? null;

  const refsBySha = new Map<string, ForkGraphRefInfo[]>();
  for (const ref of refs) {
    const list = refsBySha.get(ref.sha) ?? [];
    list.push(ref);
    refsBySha.set(ref.sha, list);
  }

  const rows: ForkGraphRow[] = [];
  let maxLane = -1;
  const noteLane = (lane: number): void => {
    if (lane > maxLane) maxLane = lane;
  };

  for (const commit of graph.commits) {
    // 1) 本行提交落在哪条泳道：期望该 sha 的最左泳道
    const matches: number[] = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index]?.sha === commit.sha) matches.push(index);
    }
    // 防御：数据里出现没有泳道期望的提交（正常 date-order 不会发生）→ 临时占一条空泳道
    const dotLane = matches.length > 0 ? matches[0]! : allocateLane(lanes);
    const dotState = lanes[dotLane]!;
    const dotColor = dotState.color;
    noteLane(dotLane);

    const segments: ForkGraphSegment[] = [];

    // 2) 其它 active 且不匹配的泳道：竖直贯穿
    for (let index = 0; index < lanes.length; index += 1) {
      const lane = lanes[index];
      if (!lane || !lane.active) continue;
      if (lane.sha === commit.sha) continue;
      segments.push({ fromLane: index, fromY: 'top', toLane: index, toY: 'bottom', color: lane.color });
      noteLane(index);
    }

    // 3) 其它匹配该 sha 的泳道（同一父被多条泳道期望）：汇入曲线 top→dot，然后释放（空槽位保留）
    //    第一父一律沿用当前泳道，所以这里会真正走到：主干/当前分支的线汇入最左泳道
    for (const lane of matches) {
      if (lane === dotLane) continue;
      const state = lanes[lane]!;
      if (state.active) {
        segments.push({ fromLane: lane, fromY: 'top', toLane: dotLane, toY: 'dot', color: state.color });
        noteLane(lane);
      }
      lanes[lane] = { sha: null, color: state.color, active: false };
    }

    // 4) 本泳道的线从上面接到圆点
    if (dotState.active) {
      segments.push({ fromLane: dotLane, fromY: 'top', toLane: dotLane, toY: 'dot', color: dotColor });
    }

    // 5) 父提交：第一父一律沿用当前泳道（颜色稳定），其余父汇入已有泳道或占空闲泳道
    const parents = commit.parents;
    if (parents.length > 0) {
      const first = parents[0]!;
      // 即使别的泳道也在等这个父提交也不换道：允许两泳道同时期望同一 sha，
      // 到父提交行时再由上面的「多泳道匹配 → 汇入曲线 + 释放」完成合流。
      lanes[dotLane] = { sha: first, color: dotColor, active: true };
      segments.push({ fromLane: dotLane, fromY: 'dot', toLane: dotLane, toY: 'bottom', color: dotColor });
      for (const parent of parents.slice(1)) {
        const target = findLaneExpecting(lanes, parent);
        if (target !== null) {
          segments.push({ fromLane: dotLane, fromY: 'dot', toLane: target, toY: 'bottom', color: lanes[target]!.color });
          lanes[target] = { sha: parent, color: lanes[target]!.color, active: true };
          noteLane(target);
          continue;
        }
        const laneIndex = allocateLane(lanes);
        const color = laneColor(laneIndex);
        lanes[laneIndex] = { sha: parent, color, active: true };
        segments.push({ fromLane: dotLane, fromY: 'dot', toLane: laneIndex, toY: 'bottom', color });
        noteLane(laneIndex);
      }
    } else {
      // 根提交：泳道线到此结束
      lanes[dotLane] = { sha: null, color: dotColor, active: false };
    }

    rows.push({
      commit,
      refs: refsBySha.get(commit.sha) ?? [],
      segments,
      dot: {
        lane: dotLane,
        color: dotColor,
        isMerge: parents.length > 1,
        isHead: headSha !== null && commit.sha === headSha,
      },
    });
  }

  return {
    rows,
    refs,
    laneCount: Math.max(2, maxLane + 1),
    colorCount: FORK_GRAPH_COLOR_COUNT,
    truncated: graph.truncated ?? 0,
    refsTruncated: graph.refsTruncated ?? 0,
  };
}

/**
 * 路径末 N 段（默认 2）：抽屉只有 400–520px，完整路径靠 `title` 看全。
 * 同时兼容 `/` 与 `\\`，忽略尾部分隔符；路径不足 N 段时返回全部。
 */
export function shortenPath(path: string | null | undefined, segments = 2): string {
  if (!path) return '';
  const trimmed = path.trim();
  const parts = trimmed.split(/[/\\]+/).filter(Boolean);
  if (!parts.length) return trimmed;
  return parts.slice(-Math.max(1, segments)).join('/');
}

/**
 * 工作树行是否展示「相对参照分支的 ↑↓」。
 *
 * `base.kind === 'main'` 时主工作树（branch 与 base.branch 相同）是拿主分支和自己比，
 * aheadOfBase/behindOfBase 恒为 0/0，属于纯噪声，隐藏；
 * `base.kind === 'upstream'` 时主工作树相对远端有真实差异，保留计数。
 */
export function shouldShowWorktreeCounts(
  worktree: Pick<GitWorktree, 'branch'>,
  base: Pick<GitBase, 'kind' | 'branch'> | null,
): boolean {
  if (!base) return true;
  if (base.kind !== 'main') return true;
  return worktree.branch === null || worktree.branch !== base.branch;
}
