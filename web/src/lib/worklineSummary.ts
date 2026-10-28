/**
 * 「工作线」人话摘要（纯函数，docs/contracts/06-git-context.md §5）。
 *
 * 把 v0.14 的 `git.graph` / `base` / `upstream` 翻译成面向非技术用户的结论：
 * 这条卡片在哪条工作线、比主线多/少多少、线上同步没有。
 * 组件层只负责用 i18n 模板把结构拼成句子，便于单测与中英文复用。
 */
import type { GitContextAvailable } from '../types';

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

export interface WorklineSummary {
  position: WorklinePosition;
  /** 当前分支名；游离 HEAD 时 null */
  branch: string | null;
  /** 主分支名（来自 base.branch；探测不到时 null） */
  mainBranch: string | null;
  mainRelation: MainRelation;
  /** 相对主线的处数（position=main 时均为 0） */
  aheadMain: number;
  behindMain: number;
  remoteRelation: RemoteRelation;
  /** upstream 短名；无则 null */
  upstreamRef: string | null;
  aheadUpstream: number;
  behindUpstream: number;
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

  const position: WorklinePosition = current.detached
    ? 'detached'
    : base?.kind === 'upstream'
      ? 'main'
      : 'feature';

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
    branch: current.branch,
    mainBranch: base?.branch ?? null,
    mainRelation,
    aheadMain,
    behindMain,
    remoteRelation,
    upstreamRef: upstream?.ref ?? null,
    aheadUpstream,
    behindUpstream,
    worktreePath: current.worktree,
    isWorktree: current.isWorktree,
    commitCount: graph.commits.length,
    commitTruncated: (graph.truncated ?? 0) > 0,
    localBranchCount: graph.refs.filter((ref) => ref.kind === 'branch').length,
    worktreeCount: git.worktrees.length,
  };
}
