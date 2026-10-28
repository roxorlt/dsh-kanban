/**
 * 「工作线」状态分类（纯函数，docs/contracts/06-git-context.md §5）。
 *
 * `buildWorklineStatus` 是详情抽屉「人话总结」与看板/列表「工作线」徽标共用的分类器：
 * 输入分支/主分支探测结果，输出位置（游离 HEAD / 主线上 / 某条工作线）与
 * 「和主线比」「和线上比」两组结论 + 计数，保证两处结论一致。
 * `buildWorklineSummary` 在它之上补充详情页需要的 graph 计数等展示数据。
 */
import type { GitBase, GitContextAvailable, GitUpstream } from '../types';

/** 卡片所处位置：游离 HEAD / 就在主线 / 在某条工作线上。 */
export type WorklinePosition = 'detached' | 'main' | 'feature';

/** 工作线与主线的关系。 */
export type MainRelation =
  /** 就在主线上 */
  | 'main'
  /** 与主线完全一致 */
  | 'same'
  /** 改动已全部并入主线（主线可能又有新改动） */
  | 'merged'
  /** 比主线多（可并发） */
  | 'ahead-only'
  /** 比主线多、且落后主线 */
  | 'ahead-behind'
  /** 落后主线（没有自己的新改动） */
  | 'behind-only';

/** 工作线与线上（upstream）的关系。 */
export type RemoteRelation = 'no-upstream' | 'synced' | 'ahead' | 'behind' | 'diverged';

/** 工作线状态（徽标与详情共用；不含 graph 计数）。 */
export interface WorklineStatus {
  position: WorklinePosition;
  /** 当前分支名；游离 HEAD 时 null */
  branch: string | null;
  /** 主分支名（探测不到时 null） */
  mainBranch: string | null;
  mainRelation: MainRelation;
  remoteRelation: RemoteRelation;
  /** 相对主线的处数（position=main 时均为 0） */
  aheadMain: number;
  behindMain: number;
  aheadUpstream: number;
  behindUpstream: number;
}

export interface WorklineStatusInput {
  /** 当前分支名；游离 HEAD 时 null */
  branch: string | null;
  detached: boolean;
  /** 主分支名（探测不到时 null） */
  mainBranch: string | null;
  /** 与主线的比较；探测不到主分支时 null */
  base: Pick<GitBase, 'kind' | 'ahead' | 'behind'> | null;
  upstream: Pick<GitUpstream, 'ahead' | 'behind'> | null;
}

/**
 * 把分支/主线/线上探测结果分类成位置与两组关系（详情与徽标共用同一套结论）。
 * 位置判定：`detached` → 游离；当前分支 === 主分支（或 base.kind==='upstream'，即主分支有 upstream）→ 主线；其余 → 工作线（feature）。
 */
export function buildWorklineStatus({
  branch,
  detached,
  mainBranch,
  base,
  upstream,
}: WorklineStatusInput): WorklineStatus {
  const onMainBranch = mainBranch !== null && branch !== null && branch === mainBranch;
  let position: WorklinePosition;
  if (detached) position = 'detached';
  else if (onMainBranch || base?.kind === 'upstream') position = 'main';
  else position = 'feature';

  const aheadMain = Math.max(0, base?.ahead ?? 0);
  const behindMain = Math.max(0, base?.behind ?? 0);
  let mainRelation: MainRelation;
  if (position === 'main') mainRelation = 'main';
  else if (aheadMain === 0 && behindMain === 0) mainRelation = 'same';
  else if (aheadMain === 0) mainRelation = 'merged';
  else if (behindMain === 0) mainRelation = 'ahead-only';
  else mainRelation = 'ahead-behind';

  const aheadUpstream = Math.max(0, upstream?.ahead ?? 0);
  const behindUpstream = Math.max(0, upstream?.behind ?? 0);
  const remoteRelation: RemoteRelation = !upstream
    ? 'no-upstream'
    : aheadUpstream > 0 && behindUpstream > 0
      ? 'diverged'
      : aheadUpstream > 0
        ? 'ahead'
        : behindUpstream > 0
          ? 'behind'
          : 'synced';

  return {
    position,
    branch,
    mainBranch,
    mainRelation,
    remoteRelation,
    aheadMain,
    behindMain,
    aheadUpstream,
    behindUpstream,
  };
}

export interface WorklineSummary extends WorklineStatus {
  /** upstream 短名；无则 null */
  upstreamRef: string | null;
  /** 当前工作副本路径 */
  worktreePath: string;
  isWorktree: boolean;
  /** 图上展示的改动数（最多 48） */
  commitCount: number;
  /** 是否还有更早的改动未取回 */
  commitTruncated: boolean;
  /** 仓库里的工作线条数（图上返回的本地分支数） */
  localBranchCount: number;
  /** 工作副本数量 */
  worktreeCount: number;
}

/** 没有 graph（旧服务端）或数据不完整时返回 null，组件整块隐藏。 */
export function buildWorklineSummary(git: GitContextAvailable): WorklineSummary | null {
  const graph = git.graph;
  if (!graph) return null;
  const { current, base, upstream } = git;
  return {
    ...buildWorklineStatus({
      branch: current.branch,
      detached: current.detached,
      mainBranch: base?.branch ?? null,
      base,
      upstream,
    }),
    upstreamRef: upstream?.ref ?? null,
    worktreePath: current.worktree,
    isWorktree: current.isWorktree,
    commitCount: graph.commits.length,
    commitTruncated: (graph.truncated ?? 0) > 0,
    localBranchCount: graph.refs.filter((ref) => ref.kind === 'branch').length,
    worktreeCount: git.worktrees.length,
  };
}
