/**
 * 「工作线」总览视图的纯逻辑（v0.23.0，设计原型 design/branch-awareness/screens/v2-branch-overview.png）。
 *
 * 数据全部来自已有只读接口，**不新增卡片字段**：
 * - `POST /git/workspaces`（v0.16，契约 02 §12）：按仓库聚合的工作副本 + 每个副本相对主线的
 *   ahead/behind、upstream、dirty、最近提交、`mergedIntoBase`；
 * - 看板卡片：`groupCardsByWorktree`（含 v0.21「按会话归属」兜底）把卡片映射到工作副本，
 *   与「工作区」视图同一份归属口径（同一张卡片在两处必然落在同一条工作线上）；
 * - 「线上同步状态」沿用 `worktreeStatusInfo` 的分类，不另立口径。
 *
 * 两层分组：第一层 = 仓库 / 项目（由卡片 cwd 推导出的 git 仓库；推不出仓库的卡片统一进「未指定」），
 * 第二层 = 工作线（= 一个工作副本 + 它检出的分支，数据来自 `git worktree list`）。
 *
 * 行状态口径（设计稿三层）：
 * - `merged`：相对主线 0 处改动（`mergedIntoBase===true`）→「已并入主线」（绿）；
 * - `active`：还没并入，但有未完成卡片或有未保存改动 →「进行中」（蓝）；
 * - `stalled`：还没并入、没有未完成卡片、工作区也干净 →「停滞」（橙）；
 * - `unknown`：目录已失效（prunable）或旧服务端算不出合并状态 →「无法判断」（灰）。
 */
import type {
  Card,
  GitSummaryUnavailableReason,
  GitWorkspaceRepo,
  GitWorkspaceUnavailable,
  GitWorkspaceWorktree,
  SessionRow,
} from '../types';
import { isTerminalCardStatus } from './sessionArchive';
import {
  formatWorktreeLabel,
  groupCardsByWorktree,
  parseCommitTimestamp,
  worktreeStatusInfo,
} from './useWorkspaces';
import type { WorktreeRemoteState, WorktreeStatusInfo } from './useWorkspaces';

/** 工作线状态（设计稿：进行中 / 已并入主线 / 停滞 / 无法判断）。 */
export type WorklineStatus = 'active' | 'merged' | 'stalled' | 'unknown';

/** 状态排序权重：进行中 → 停滞 → 已并入主线 → 无法判断。 */
export const WORKLINE_STATUS_RANK: Record<WorklineStatus, number> = {
  active: 0,
  stalled: 1,
  merged: 2,
  unknown: 3,
};

/** 一条工作线（= 一个工作副本 + 它检出的分支）。 */
export interface WorklineRow {
  /** 稳定 key：仓库根 + 工作副本路径 */
  key: string;
  repoRoot: string;
  repoName: string;
  /** 工作副本绝对路径 */
  path: string;
  /** 检出的分支；游离 HEAD 时 null */
  branch: string | null;
  detached: boolean;
  /** 是否仓库主工作副本 */
  isMain: boolean;
  status: WorklineStatus;
  /** 相对主线的处数；无法计算时 null */
  aheadMain: number | null;
  behindMain: number | null;
  /** 改动条占比 0–100（ahead/(ahead+behind)；已并入主线固定 100；算不出时 null） */
  percent: number | null;
  /** 线上同步状态（复用「工作区」视图口径） */
  remote: WorktreeRemoteState;
  upstreamAhead: number;
  upstreamBehind: number;
  /** 有未保存改动（含未跟踪文件） */
  dirty: boolean;
  /** 关联卡片（全部，含已完成） */
  cards: Card[];
  /** 未完成卡片数（不含 done/canceled） */
  openCardCount: number;
  /** 进行中卡片数（status=running） */
  runningCardCount: number;
  /** 最近改动时间（提交时间与卡片更新时间取较新者）；都没有时 null */
  lastActivityAt: number | null;
  /** 工作副本位置文案（主工作副本用仓库名；子工作副本用相对仓库根的路径） */
  location: string;
}

/** 第一层：仓库 / 项目分组。 */
export interface WorklineRepoGroup {
  key: string;
  root: string;
  name: string;
  /** 探测不到主分支时 null */
  mainBranch: string | null;
  /** 该仓库卡片涉及的「项目」（去重、排序；用于组头补充说明） */
  projects: string[];
  worklines: WorklineRow[];
  /** 进行中的工作线条数 */
  activeCount: number;
  /** 进行中卡片数（status=running） */
  runningCardCount: number;
  cardCount: number;
  /** v0.20：被每仓库 12 个工作副本上限截断、未返回的数量 */
  truncatedWorktrees: number;
}

/** 未指定卡片的原因：卡片缺 cwd / 目录探测失败。 */
export type WorklineUnassignedReason = GitSummaryUnavailableReason;

export interface WorklineUnassignedCard {
  card: Card;
  reason: WorklineUnassignedReason;
}

export interface WorklineOverview {
  repos: WorklineRepoGroup[];
  /** 无 cwd / 目录不可用 / 没匹配到工作副本的卡片（「未指定」块） */
  unassigned: WorklineUnassignedCard[];
  /** 仓库数 */
  repoCount: number;
  /** 工作线（工作副本）总数 */
  worklineCount: number;
  /** 进行中的工作线条数 */
  activeCount: number;
  /** 进行中卡片数 */
  runningCardCount: number;
  /** 参与统计的卡片总数（未归档） */
  cardCount: number;
}

/** 选中一条工作线（点行 → 看板只看这条线的卡片）。 */
export interface WorklineSelection {
  repoRoot: string;
  worktreePath: string;
  /** 分支名；游离 HEAD 时 null */
  branch: string | null;
  /** 展示用名称（分支名 / 工作副本位置），写进筛选提示条 */
  label: string;
}

export interface BuildWorklineOverviewOptions {
  /** 会话列表：传给 groupCardsByWorktree 做 v0.21「按会话归属」兜底（与「工作区」视图一致） */
  sessions?: readonly SessionRow[];
  /** `/git/workspaces` 的 unavailable 列表：给「未指定」卡片标注原因 */
  unavailable?: readonly GitWorkspaceUnavailable[];
}

/** 工作线 key：仓库根 + 工作副本路径（去掉末尾 `/`）。 */
export function worklineKey(repoRoot: string, worktreePath: string): string {
  return `${repoRoot.replace(/\/+$/, '')}\u0000${worktreePath.replace(/\/+$/, '')}`;
}

/** 卡片是否未完成（done/canceled 是终态）。 */
function isOpenCard(card: Card): boolean {
  return !isTerminalCardStatus(card.status);
}

/**
 * 行状态派生（纯函数，单测直接覆盖）。
 * @param info worktreeStatusInfo 的分类结果（合并 / 改动）
 * @param openCardCount 未完成卡片数
 * @param prunable 目录已失效
 */
export function deriveWorklineStatus(
  info: Pick<WorktreeStatusInfo, 'merge' | 'changes'>,
  openCardCount: number,
  prunable: boolean,
): WorklineStatus {
  if (prunable) return 'unknown';
  if (info.merge === 'merged') return 'merged';
  const inProgress = openCardCount > 0 || info.changes !== 'clean';
  if (info.merge === 'unknown') return inProgress ? 'active' : 'unknown';
  return inProgress ? 'active' : 'stalled';
}

/** 改动条占比：已并入主线 100；无落后 100；只落后 0；否则 ahead/(ahead+behind)。 */
export function worklinePercent(
  status: WorklineStatus,
  ahead: number | null,
  behind: number | null,
): number | null {
  if (status === 'unknown') return null;
  if (ahead === null || behind === null) return null;
  if (status === 'merged' || behind === 0) return 100;
  if (ahead === 0) return 0;
  return Math.round((ahead / (ahead + behind)) * 100);
}

/** 最近改动时间：工作副本最近提交时间与关联卡片 updatedAt 取较新者。 */
export function worklineLastActivity(
  cards: readonly Card[],
  lastCommitAt: string | null | undefined,
): number | null {
  let latest = parseCommitTimestamp(lastCommitAt);
  for (const card of cards) {
    const at = Number.isFinite(card.updatedAt) ? card.updatedAt : null;
    if (at === null) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/** 单条工作线的展示数据（供列排序 / 组件复用）。 */
export function buildWorklineRow(
  repo: { root: string; name: string },
  worktree: GitWorkspaceWorktree,
  cards: readonly Card[],
): WorklineRow {
  const info = worktreeStatusInfo(worktree);
  const openCardCount = cards.filter(isOpenCard).length;
  const runningCardCount = cards.filter((card) => card.status === 'running').length;
  const status = deriveWorklineStatus(info, openCardCount, worktree.prunable === true);
  const aheadMain = status === 'unknown' ? null : worktree.aheadOfBase ?? null;
  const behindMain = status === 'unknown' ? null : worktree.behindOfBase ?? null;
  return {
    key: worklineKey(repo.root, worktree.path),
    repoRoot: repo.root,
    repoName: repo.name,
    path: worktree.path,
    branch: worktree.branch ?? null,
    detached: worktree.detached === true || !worktree.branch,
    isMain: worktree.isMain === true,
    status,
    aheadMain,
    behindMain,
    percent: worklinePercent(status, aheadMain, behindMain),
    remote: info.remote,
    upstreamAhead: info.upstreamAhead,
    upstreamBehind: info.upstreamBehind,
    dirty: info.changes !== 'clean',
    cards: [...cards],
    openCardCount,
    runningCardCount,
    lastActivityAt: worklineLastActivity(cards, worktree.lastCommitAt),
    location: formatWorktreeLabel(repo, worktree),
  };
}

/** 行排序：状态 → 最近改动新→旧 → 工作副本位置。 */
export function compareWorklineRows(left: WorklineRow, right: WorklineRow): number {
  const rank = WORKLINE_STATUS_RANK[left.status] - WORKLINE_STATUS_RANK[right.status];
  if (rank !== 0) return rank;
  const leftAt = left.lastActivityAt ?? 0;
  const rightAt = right.lastActivityAt ?? 0;
  if (leftAt !== rightAt) return rightAt - leftAt;
  return left.location.localeCompare(right.location, 'zh-Hans-CN');
}

/** 仓库分组排序：进行中工作线多 > 工作线多 > 名称。 */
export function compareWorklineRepoGroups(left: WorklineRepoGroup, right: WorklineRepoGroup): number {
  if (left.activeCount !== right.activeCount) return right.activeCount - left.activeCount;
  if (left.worklines.length !== right.worklines.length) return right.worklines.length - left.worklines.length;
  return left.name.localeCompare(right.name, 'zh-Hans-CN');
}

/** 收集一组卡片上的「项目」名（去空、去重、按中文序）。 */
function collectProjects(cards: readonly Card[]): string[] {
  const seen = new Set<string>();
  for (const card of cards) {
    const project = card.project?.trim();
    if (project) seen.add(project);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/** 「未指定」卡片的原因：缺 cwd 直接标注，其余取 /git/workspaces 的探测原因（没有时按探测失败）。 */
function unassignedReasonOf(
  card: Card,
  unavailable: ReadonlyMap<string, GitWorkspaceUnavailable['reason']>,
): WorklineUnassignedReason {
  const cwd = card.cwd?.trim();
  if (!cwd) return 'no_cwd';
  return unavailable.get(cwd) ?? 'error';
}

/**
 * 构建「工作线总览」：仓库分组 + 未指定卡片 + 总计数。
 * @param cards 未归档卡片（视图范围；「工作线」视图用全部未归档卡片）
 * @param repos `/git/workspaces` 返回的仓库（可空：还没探测完 / 全部不可用）
 */
export function buildWorklineOverview(
  cards: readonly Card[],
  repos: readonly GitWorkspaceRepo[],
  options: BuildWorklineOverviewOptions = {},
): WorklineOverview {
  const grouped = groupCardsByWorktree(cards, repos, { sessions: options.sessions ?? [] });

  const repoGroups: WorklineRepoGroup[] = grouped.repos.map((repo) => {
    const worklines = repo.worktrees
      .map((worktree) => buildWorklineRow(repo, worktree, worktree.cards))
      .sort(compareWorklineRows);
    const repoCards = repo.worktrees.flatMap((worktree) => worktree.cards);
    return {
      key: repo.root,
      root: repo.root,
      name: repo.name,
      mainBranch: repo.mainBranch,
      projects: collectProjects(repoCards),
      worklines,
      activeCount: worklines.filter((row) => row.status === 'active').length,
      runningCardCount: repoCards.filter((card) => card.status === 'running').length,
      cardCount: repoCards.length,
      truncatedWorktrees: Math.max(0, repo.truncatedWorktrees ?? 0),
    };
  });
  repoGroups.sort(compareWorklineRepoGroups);

  const unavailable = new Map<string, GitWorkspaceUnavailable['reason']>();
  for (const item of options.unavailable ?? []) {
    if (typeof item.dir === 'string' && item.dir.trim()) unavailable.set(item.dir.trim(), item.reason);
  }
  const unassigned: WorklineUnassignedCard[] = grouped.unassigned
    .map((card) => ({ card, reason: unassignedReasonOf(card, unavailable) }))
    .sort((a, b) => (b.card.updatedAt ?? 0) - (a.card.updatedAt ?? 0));

  const allWorklines = repoGroups.flatMap((group) => group.worklines);
  return {
    repos: repoGroups,
    unassigned,
    repoCount: repoGroups.length,
    worklineCount: allWorklines.length,
    activeCount: allWorklines.filter((row) => row.status === 'active').length,
    runningCardCount: allWorklines.reduce((total, row) => total + row.runningCardCount, 0),
    cardCount: cards.length,
  };
}

/** 在工作线总览里按选中项找行（找不到 = 数据刷新后该工作副本已不存在）。 */
export function findWorklineRow(
  overview: WorklineOverview,
  selection: WorklineSelection | null | undefined,
): WorklineRow | null {
  if (!selection) return null;
  const root = selection.repoRoot.replace(/\/+$/, '');
  const path = selection.worktreePath.replace(/\/+$/, '');
  for (const group of overview.repos) {
    if (group.root.replace(/\/+$/, '') !== root) continue;
    for (const row of group.worklines) {
      if (row.path.replace(/\/+$/, '') === path) return row;
    }
  }
  return null;
}

/** 选中的工作线关联卡片（按卡片 id 去重，找不到行时返回空数组）。 */
export function selectWorklineCards(
  overview: WorklineOverview,
  selection: WorklineSelection | null | undefined,
): Card[] {
  const row = findWorklineRow(overview, selection);
  if (!row) return [];
  return row.cards;
}

/** 由一行生成选中项（点行 → 看板筛选）。 */
export function toWorklineSelection(row: WorklineRow): WorklineSelection {
  return {
    repoRoot: row.repoRoot,
    worktreePath: row.path,
    branch: row.branch,
    label: row.branch ?? row.location,
  };
}

/** 相对主线的人话文案 key + 参数（组件层直接 t(key, params)）。 */
export interface WorklineRelationText {
  key:
    | 'worklines.sameAsMain'
    | 'worklines.aheadOnly'
    | 'worklines.aheadBehind'
    | 'worklines.behindOnly'
    | 'worklines.mergedBehind'
    | 'worklines.unknownRelation';
  params?: Record<string, number>;
}

/** 相对主线的文案（与行状态同源：状态未知一律「暂无数据」）。 */
export function worklineRelationText(row: WorklineRow): WorklineRelationText {
  if (row.status === 'unknown' || row.aheadMain === null || row.behindMain === null) {
    return { key: 'worklines.unknownRelation' };
  }
  const ahead = Math.max(0, row.aheadMain);
  const behind = Math.max(0, row.behindMain);
  if (row.status === 'merged') {
    return behind === 0
      ? { key: 'worklines.sameAsMain' }
      : { key: 'worklines.mergedBehind', params: { behind } };
  }
  if (ahead > 0 && behind > 0) return { key: 'worklines.aheadBehind', params: { ahead, behind } };
  if (ahead > 0) return { key: 'worklines.aheadOnly', params: { ahead } };
  return { key: 'worklines.behindOnly', params: { behind } };
}
