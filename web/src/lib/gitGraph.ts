/**
 * 卡片 Git 上下文的泳道图数据（纯函数，无 React 依赖）。
 *
 * 输入：docs/contracts/06-git-context.md §3 的 `git` 对象（`available:true`）。
 * 输出：组件层直接渲染的泳道标签 + 行数据 + 截断计数。
 *
 * 渲染文案不在这里拼：分支名 / base.label 是 Git 原始数据，原样返回；
 * detached 时当前泳道 label 为 null，由组件回退到 i18n 的 HEAD 文案。
 *
 * 泳道约定（契约 §5）：泳道 0 = 参照分支（主分支 / upstream，灰），
 * 泳道 1 = 当前分支（业务蓝）；`base` 缺失 / `mergeBase` 缺失 / 当前分支没有领先提交时
 * 图退化为单泳道（见 `singleLane`），避免画一条没有提交的空泳道。
 */
import type { GitBase, GitCommit, GitContextAvailable, GitRef, GitWorktree } from '../types';

/** 泳道 id：0 = 参照分支，1 = 当前分支。 */
export type GitLaneId = 0 | 1;

/** 泳道图最多展示的提交行数；超出部分只在末尾显示「还有 N 个提交」。 */
export const GIT_GRAPH_MAX_ROWS = 12;

/** 提交来源（单测与调试用；决定行所属泳道）。 */
export type GitGraphRowSource = 'ahead' | 'behind' | 'shared';

export interface GitGraphLaneLabel {
  lane: GitLaneId;
  /** base = 参照分支（主分支 / 远端），current = 当前分支 */
  kind: 'base' | 'current';
  /** 展示标签：base.label / 当前分支名；detached 为 null（组件渲染 HEAD 文案） */
  label: string | null;
}

export interface GitGraphRow {
  /** React key（同一提交只出现一次，仍带序号防御重复数据） */
  key: string;
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  /** 毫秒时间戳 */
  committedAt: number;
  /** 提交点所在泳道 */
  lane: GitLaneId;
  /**
   * 穿过本行上下边界的竖线泳道（升序）；分叉点行不含已汇入的泳道 1。
   * 组件据此判断竖线从行顶还是提交点中心开始（上一行是否含同一泳道）。
   */
  activeLanes: GitLaneId[];
  /** 分叉点行：泳道 1 的线从本行顶部斜线汇入本行提交点（泳道 0） */
  forkPoint: boolean;
  /** 合并到同一 sha 的 refs 徽标（按名称去重，HEAD 排最前） */
  refs: GitRef[];
  source: GitGraphRowSource;
}

export interface GitGraphModel {
  /** 泳道标签：双泳道 [泳道 0 = base, 泳道 1 = 当前分支]；单泳道时只有一项 */
  laneLabels: GitGraphLaneLabel[];
  rows: GitGraphRow[];
  /** 超出 12 行展示上限被省略的提交数（>0 时组件渲染「还有 N 个提交」） */
  hiddenCount: number;
  /** 截断前的总行数（ahead + behind 合并后 + shared） */
  totalRows: number;
  /** 分叉点行在 rows 里的下标；未展示或不存在时为 null */
  forkRowIndex: number | null;
  /**
   * 中段截断位置：在 rows[gapIndex] 之前渲染「还有 N 个提交」。
   * 分叉点优先保留时，被省略的是 ahead/behind 的旧提交，正好落在这里；
   * null = 截断发生在列表末尾（或者没有截断）。
   */
  gapIndex: number | null;
  /** 单泳道模式（base / mergeBase 缺失，或当前分支没有领先提交） */
  singleLane: boolean;
}

interface RawRow {
  commit: GitCommit;
  lane: GitLaneId;
  source: GitGraphRowSource;
}

/** refs 徽标展示顺序：HEAD → 当前分支 → 参照分支 → 远端跟踪。 */
const REF_KIND_ORDER: Record<GitRef['kind'], number> = {
  head: 0,
  branch: 1,
  base: 2,
  upstream: 3,
};

/**
 * ahead/behind 合并：`committedAt` 倒序（新 → 旧）。
 * 输入按「先 ahead 后 behind」拼接，`Array#sort` 自 ES2019 起稳定，
 * 因此同一时间戳天然保持「先 ahead 后 behind」，且各自的日志顺序（新 → 旧）不变。
 */
function mergeAheadBehind(git: GitContextAvailable): RawRow[] {
  const rows: RawRow[] = [
    ...git.commits.ahead.map((commit): RawRow => ({ commit, lane: 1, source: 'ahead' })),
    ...git.commits.behind.map((commit): RawRow => ({ commit, lane: 0, source: 'behind' })),
  ];
  rows.sort((left, right) => right.commit.committedAt - left.commit.committedAt);
  return rows;
}

/**
 * 单泳道提交：ahead/behind（若有，按时间倒序合并）全部画在泳道 0，shared 接在后面。
 * 契约的单泳道退化数据里 ahead/behind 为空，这里兼容「当前分支落后参照分支」等仍带 behind 的情况。
 */
function singleLaneRows(git: GitContextAvailable): RawRow[] {
  const merged = mergeAheadBehind(git).map(
    (row): RawRow => ({ commit: row.commit, lane: 0, source: row.source }),
  );
  return [
    ...merged,
    ...git.commits.shared.map((commit): RawRow => ({ commit, lane: 0, source: 'shared' })),
  ];
}

/** 同 sha 的 refs 合并到同一行展示；同名只保留第一条。 */
function groupRefsBySha(refs: readonly GitRef[]): Map<string, GitRef[]> {
  const grouped = new Map<string, GitRef[]>();
  for (const ref of refs) {
    if (!ref || typeof ref.sha !== 'string' || !ref.sha || typeof ref.name !== 'string' || !ref.name) continue;
    const list = grouped.get(ref.sha) ?? [];
    if (!list.some((item) => item.name === ref.name)) list.push(ref);
    grouped.set(ref.sha, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => (REF_KIND_ORDER[left.kind] ?? 99) - (REF_KIND_ORDER[right.kind] ?? 99));
  }
  return grouped;
}

/**
 * 选取展示行（上限 12 行）。
 *
 * 有分叉点时优先保住尾部「fork 行 + shared 行」：先填 ahead/behind 合并段的前若干行，
 * 再接 fork 行与 shared 行，被裁掉的是合并段里较旧的提交（正好位于图的中段）。
 * 这样当前分支领先再多（服务端 ahead 上限 12）也能看到与参照分支的汇合点。
 * 没有 shared 行（单泳道 / 防御性数据）时维持原来的「从新到旧直接截断」。
 */
function selectVisibleRows(
  rawRows: readonly RawRow[],
  forkRawIndex: number | null,
): { visible: RawRow[]; forkRowIndex: number | null; hiddenCount: number; gapIndex: number | null } {
  const total = rawRows.length;
  const hasFork = forkRawIndex !== null && forkRawIndex < total;
  if (total <= GIT_GRAPH_MAX_ROWS) {
    return { visible: [...rawRows], forkRowIndex: hasFork ? forkRawIndex : null, hiddenCount: 0, gapIndex: null };
  }
  if (!hasFork) {
    return {
      visible: rawRows.slice(0, GIT_GRAPH_MAX_ROWS),
      forkRowIndex: null,
      hiddenCount: total - GIT_GRAPH_MAX_ROWS,
      gapIndex: null,
    };
  }
  const mergedRows = rawRows.slice(0, forkRawIndex);
  const sharedRows = rawRows.slice(forkRawIndex);
  const tailCount = Math.min(sharedRows.length, GIT_GRAPH_MAX_ROWS);
  const keepMerged = GIT_GRAPH_MAX_ROWS - tailCount;
  const visible = [...mergedRows.slice(0, keepMerged), ...sharedRows.slice(0, tailCount)];
  return {
    visible,
    forkRowIndex: keepMerged,
    hiddenCount: total - visible.length,
    // 只有被省略的合并段行才会落在「当前分支 → 分叉点」之间；尾部 shared 超限属于异常数据，不画中段提示
    gapIndex: keepMerged < mergedRows.length ? keepMerged : null,
  };
}

/**
 * 构建泳道图数据。
 *
 * 行顺序：ahead/behind 合并后按 `committedAt` 倒序 → 随后 `commits.shared`（首条即 mergeBase / 分叉点）；
 * 显示上限 12 行，超出部分只回 `hiddenCount`。同一时间戳保持「先 ahead 后 behind」的稳定顺序。
 *
 * @param git 契约 §3 的 `git`（仅 available:true 时调用；不可用时组件整块隐藏）
 */
export function buildGitGraph(git: GitContextAvailable): GitGraphModel {
  // 当前分支没有领先提交 / 没有参照物时画不出两条泳道：退化单泳道，避免右泳道空悬。
  const singleLane = !git.base || !git.base.mergeBase || git.commits.ahead.length === 0;

  const merged = singleLane ? [] : mergeAheadBehind(git);
  const rawRows: RawRow[] = singleLane
    ? singleLaneRows(git)
    : [
        ...merged,
        ...git.commits.shared.map((commit): RawRow => ({ commit, lane: 0, source: 'shared' })),
      ];

  const totalRows = rawRows.length;
  const refsBySha = groupRefsBySha(git.refs);

  // 分叉点 = 合并段之后的第一条 shared 提交（mergeBase 本身）
  const forkRawIndex = singleLane ? null : merged.length;
  const { visible, forkRowIndex, hiddenCount, gapIndex } = selectVisibleRows(rawRows, forkRawIndex);

  // 单泳道时泳道线可能显示的是主分支历史（当前分支落后）或当前分支自身（同一提交 / 无主分支）：
  // 落后时顶部最新提交属于参照分支，标成 base 才不误导；其余情况标成当前分支。
  const singleLaneKind: GitGraphLaneLabel['kind'] =
    git.base && git.base.behind > 0 ? 'base' : 'current';
  const laneLabels: GitGraphLaneLabel[] = singleLane
    ? [
        {
          lane: 0,
          kind: singleLaneKind,
          label: singleLaneKind === 'base' ? git.base?.label ?? null : git.current.branch,
        },
      ]
    : [
        { lane: 0, kind: 'base', label: git.base?.label ?? null },
        { lane: 1, kind: 'current', label: git.current.branch },
      ];

  // 各泳道首次出现的行：竖线从该行的提交点中心开始，避免行顶多出一截悬空线。
  const laneStart: Record<GitLaneId, number> = { 0: -1, 1: -1 };
  for (let index = 0; index < visible.length; index += 1) {
    const raw = visible[index];
    if (!raw) continue;
    if (laneStart[raw.lane] < 0) laneStart[raw.lane] = index;
  }
  const hasLane0 = laneStart[0] >= 0;
  const hasLane1 = laneStart[1] >= 0;

  const rows: GitGraphRow[] = visible.map((raw, index) => {
    const activeLanes: GitLaneId[] = [];
    // 泳道 0 的线从首个参照分支提交一直画到最下方（shared 历史继续）。
    if (hasLane0 && index >= laneStart[0]) activeLanes.push(0);
    // 泳道 1 的线在分叉点行上方结束，由该行绘制汇合斜线。
    if (hasLane1 && index >= laneStart[1] && (forkRowIndex === null || index < forkRowIndex)) activeLanes.push(1);
    const refs = refsBySha.get(raw.commit.sha) ?? [];
    return {
      key: `${raw.commit.sha}:${index}`,
      sha: raw.commit.sha,
      shortSha: raw.commit.shortSha || raw.commit.sha.slice(0, 7),
      subject: raw.commit.subject ?? '',
      authorName: raw.commit.authorName ?? '',
      committedAt: raw.commit.committedAt,
      lane: raw.lane,
      activeLanes,
      forkPoint: index === forkRowIndex,
      refs,
      source: raw.source,
    };
  });

  // 被 12 行上限截断后，参照泳道可能一条可见提交都没有（只剩当前分支）：
  // 此时不展示没有线的泳道标签，避免「图里只有一条泳道、图例却有两条」的误导。
  const usedLanes = new Set<GitLaneId>(rows.map((row) => row.lane));
  const visibleLaneLabels = laneLabels.filter((lane) => usedLanes.has(lane.lane));

  return {
    laneLabels: visibleLaneLabels.length ? visibleLaneLabels : laneLabels,
    rows,
    hiddenCount,
    totalRows,
    forkRowIndex,
    gapIndex,
    singleLane,
  };
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
