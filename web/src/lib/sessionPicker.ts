/**
 * 「绑定会话」选择器的纯逻辑（v0.19.0，卡片 card-d60ae026）。
 *
 * 数据来源：宿主会话列表（桥推送的 `sessions`）+ DSH 工作区注册表（`workspaces.list`）。
 * 目标是解决三件事：
 * 1. 选项按工作区分组（分组顺序跟 DSH 左侧工作区一致），无归属的会话进末尾「未归入工作区」；
 * 2. 长列表靠「分组折叠 + 搜索」收缩：搜索同时匹配标题 / 工作区名 / 工作区路径 / 会话 ID / cwd，
 *    所以输入工作区名（如 `rea L2`）就能定位到该工作区的会话；
 * 3. 工作区注册表里有、宿主会话列表却没给出的会话补一条兜底行，避免「明明在侧栏能看到，
 *    下拉框里却选不到」；已绑定到当前卡片的会话从可选项里排除。
 *
 * 只放纯函数，不依赖 React/DOM，便于单测。
 */
import type { SessionRow, WorkspaceRow } from '../types';

/** 卡片上用于定位「当前工作区」的字段（只需要这两个）。 */
export interface CardWorkspaceHint {
  workspaceId?: string | null;
  cwd?: string | null;
}

/** 选择器里的会话行；placeholder=true 表示只在工作区注册表出现、宿主列表没给出。 */
export interface SessionPickerSession extends SessionRow {
  placeholder?: boolean;
}

/** 一个工作区分组（或末尾的「未归入工作区」分组）。 */
export interface SessionPickerGroup {
  /** 分组键：`workspace:<workspaceId>` 或 `unassigned`。 */
  key: string;
  workspaceId: string | null;
  /** 工作区标题；「未归入工作区」分组为空字符串，由界面按 i18n 文案渲染。 */
  title: string;
  /** 工作区路径；未归组为 null。 */
  path: string | null;
  sessions: SessionPickerSession[];
}

export const UNASSIGNED_GROUP_KEY = 'unassigned';
export const WORKSPACE_GROUP_PREFIX = 'workspace:';

export function workspaceGroupKey(workspaceId: string): string {
  return `${WORKSPACE_GROUP_PREFIX}${workspaceId}`;
}

/** 路径规范化：去首尾空白、反斜杠转 `/`、合并重复分隔符、去尾部斜杠；空值返回 ''。 */
export function normalizePath(path: string | null | undefined): string {
  if (typeof path !== 'string') return '';
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!normalized) return '';
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
}

/** 会话 ID 的短形态：去掉 `session-` 前缀后最多 8 位，用于窄行展示。 */
export function shortSessionId(id: string): string {
  const stripped = id.startsWith('session-') ? id.slice('session-'.length) : id;
  return stripped.length > 8 ? stripped.slice(0, 8) : stripped;
}

/**
 * cwd 命中工作区路径时返回前缀长度（相同路径额外 +1，排在同前缀子目录之前）；不命中返回 -1。
 * 用于「最长前缀」匹配：会话 cwd 落在某个工作区目录下时归到该工作区。
 */
export function workspacePathRank(
  cwd: string | null | undefined,
  workspacePath: string | null | undefined,
): number {
  const target = normalizePath(cwd);
  const base = normalizePath(workspacePath);
  if (!target || !base) return -1;
  if (target === base) return base.length + 1;
  const prefix = base === '/' ? '/' : `${base}/`;
  return target.startsWith(prefix) ? base.length : -1;
}

/**
 * 工作区注册表里 `会话 ID → 工作区` 的索引。
 * 同一会话被登记在多个工作区时以注册表顺序的第一个为准（与 DSH 侧栏一致）。
 */
export function indexWorkspacesBySessionId(
  workspaces: readonly WorkspaceRow[],
): Map<string, WorkspaceRow> {
  const index = new Map<string, WorkspaceRow>();
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds ?? []) {
      if (typeof sessionId === 'string' && sessionId && !index.has(sessionId)) {
        index.set(sessionId, workspace);
      }
    }
  }
  return index;
}

/**
 * 会话 → 工作区：先查工作区注册表的 sessionIds（权威），再按 cwd 最长前缀匹配；
 * 都匹配不到返回 null。
 */
export function resolveSessionWorkspace(
  session: Pick<SessionRow, 'id' | 'cwd' | 'workspaceId'>,
  workspaces: readonly WorkspaceRow[],
  index: Map<string, WorkspaceRow> = indexWorkspacesBySessionId(workspaces),
): WorkspaceRow | null {
  if (session.id && index.has(session.id)) return index.get(session.id) ?? null;
  if (session.workspaceId) {
    const byId = workspaces.find((workspace) => workspace.workspaceId === session.workspaceId);
    if (byId) return byId;
  }
  let best: WorkspaceRow | null = null;
  let bestRank = -1;
  for (const workspace of workspaces) {
    const rank = workspacePathRank(session.cwd, workspace.path);
    if (rank > bestRank) {
      best = workspace;
      bestRank = rank;
    }
  }
  return bestRank >= 0 ? best : null;
}

/**
 * 合并会话：宿主列表打底，再补上工作区注册表里出现、宿主列表没给出的会话（兜底行）。
 * 兜底行 title 留空，由界面用「工作区标题 · 短 ID」渲染；running/updatedAt 未知按空闲/0 处理。
 */
export function collectPickerSessions(
  sessions: readonly SessionRow[],
  workspaces: readonly WorkspaceRow[],
): SessionPickerSession[] {
  const merged: SessionPickerSession[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (!session || typeof session.id !== 'string' || !session.id || seen.has(session.id)) continue;
    seen.add(session.id);
    merged.push(session);
  }
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds ?? []) {
      if (typeof sessionId !== 'string' || !sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      merged.push({
        id: sessionId,
        title: '',
        running: false,
        updatedAt: 0,
        ...(workspace.path ? { cwd: workspace.path } : {}),
        workspaceId: workspace.workspaceId,
        placeholder: true,
      });
    }
  }
  return merged;
}

/** 组内排序：最近有动作的在前，其次按会话 ID 稳定排序。 */
function compareSessions(left: SessionPickerSession, right: SessionPickerSession): number {
  const delta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  if (delta !== 0) return delta;
  return left.id.localeCompare(right.id);
}

export interface BuildSessionGroupsInput {
  sessions: readonly SessionRow[];
  workspaces: readonly WorkspaceRow[];
  /** 已绑定到当前卡片的会话（不出现在可选项里）。 */
  excludeSessionIds?: readonly string[];
}

/**
 * 按工作区分组：分组顺序 = 工作区注册表顺序（空组丢弃），无归属会话压到末尾「未归入工作区」。
 * 组内按最近活动倒序；已绑定到当前卡片的会话被排除。
 */
export function groupSessionsByWorkspace({
  sessions,
  workspaces,
  excludeSessionIds = [],
}: BuildSessionGroupsInput): SessionPickerGroup[] {
  const excluded = new Set(
    excludeSessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const index = indexWorkspacesBySessionId(workspaces);
  const buckets = new Map<string, SessionPickerSession[]>();
  const unassigned: SessionPickerSession[] = [];
  for (const session of collectPickerSessions(sessions, workspaces)) {
    if (excluded.has(session.id)) continue;
    const workspace = resolveSessionWorkspace(session, workspaces, index);
    if (!workspace) {
      unassigned.push(session);
      continue;
    }
    const bucket = buckets.get(workspace.workspaceId);
    if (bucket) bucket.push(session);
    else buckets.set(workspace.workspaceId, [session]);
  }
  const groups: SessionPickerGroup[] = [];
  for (const workspace of workspaces) {
    const bucket = buckets.get(workspace.workspaceId);
    if (!bucket || bucket.length === 0) continue;
    groups.push({
      key: workspaceGroupKey(workspace.workspaceId),
      workspaceId: workspace.workspaceId,
      title: workspace.title || workspace.path || workspace.workspaceId,
      path: workspace.path || null,
      sessions: [...bucket].sort(compareSessions),
    });
  }
  if (unassigned.length > 0) {
    groups.push({
      key: UNASSIGNED_GROUP_KEY,
      workspaceId: null,
      title: '',
      path: null,
      sessions: unassigned.sort(compareSessions),
    });
  }
  return groups;
}

/** 会话是否命中搜索词：标题 / 会话 ID / cwd 大小写不敏感包含。 */
function sessionMatches(session: Pick<SessionPickerSession, 'id' | 'title' | 'cwd'>, needle: string): boolean {
  if ((session.title ?? '').toLowerCase().includes(needle)) return true;
  if (session.id.toLowerCase().includes(needle)) return true;
  if ((session.cwd ?? '').toLowerCase().includes(needle)) return true;
  return false;
}

/**
 * 搜索过滤：工作区名 / 路径命中的分组整体保留（这样搜 `rea` 就能看到 rea L2 的全部会话），
 * 否则只保留组内命中的会话；空组丢弃。空搜索词原样返回。
 */
export function filterSessionGroups(
  groups: readonly SessionPickerGroup[],
  query: string,
): SessionPickerGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];
  const filtered: SessionPickerGroup[] = [];
  for (const group of groups) {
    const groupMatch =
      group.title.toLowerCase().includes(needle) || (group.path ?? '').toLowerCase().includes(needle);
    const sessions = groupMatch ? group.sessions : group.sessions.filter((session) => sessionMatches(session, needle));
    if (sessions.length === 0) continue;
    filtered.push({ ...group, sessions });
  }
  return filtered;
}

/**
 * 刚打开选择器时默认展开哪些分组：
 * 1. 卡片所属工作区（先按 workspaceId，再按卡片 cwd 最长前缀）；
 * 2. 都匹配不到时展开「最近有动作」的那组（避免完全折叠、看不见用户刚用过的会话）；
 * 3. 只有一个分组时直接展开。
 */
export function defaultExpandedGroupKeys(
  groups: readonly SessionPickerGroup[],
  card: CardWorkspaceHint,
): Set<string> {
  if (groups.length === 0) return new Set();
  if (card.workspaceId) {
    const hit = groups.find((group) => group.workspaceId === card.workspaceId);
    if (hit) return new Set([hit.key]);
  }
  const cwdCandidates = card.cwd
    ? groups
        .filter((group) => group.path)
        .map((group) => ({ group, rank: workspacePathRank(card.cwd, group.path) }))
        .filter((entry) => entry.rank >= 0)
        .sort((left, right) => right.rank - left.rank)
    : [];
  const byCwd = cwdCandidates[0];
  if (byCwd) return new Set([byCwd.group.key]);
  const firstGroup = groups[0];
  if (!firstGroup) return new Set();
  if (groups.length === 1) return new Set([firstGroup.key]);
  let recentKey = firstGroup.key;
  let recentAt = -1;
  for (const group of groups) {
    const at = group.sessions[0]?.updatedAt ?? 0;
    if (at > recentAt) {
      recentAt = at;
      recentKey = group.key;
    }
  }
  return new Set([recentKey]);
}

/** 可选会话总数（用于触发器禁用态与「N 个会话」提示）。 */
export function countPickerSessions(groups: readonly SessionPickerGroup[]): number {
  let total = 0;
  for (const group of groups) total += group.sessions.length;
  return total;
}

/**
 * 选择器默认范围：卡片所属工作区。
 * 优先级：卡片 workspaceId → 卡片 cwd 最长前缀 → 已绑定会话所属工作区；都匹配不到返回 null（调用方退回「所有工作区」）。
 */
export function resolvePickerScopeWorkspace({
  sessions,
  workspaces,
  card,
}: {
  sessions: readonly SessionRow[];
  workspaces: readonly WorkspaceRow[];
  card: CardWorkspaceHint & { sessionIds?: readonly string[] };
}): WorkspaceRow | null {
  if (card.workspaceId) {
    const byId = workspaces.find((workspace) => workspace.workspaceId === card.workspaceId);
    if (byId) return byId;
  }
  if (card.cwd) {
    let best: WorkspaceRow | null = null;
    let bestRank = -1;
    for (const workspace of workspaces) {
      const rank = workspacePathRank(card.cwd, workspace.path);
      if (rank > bestRank) {
        best = workspace;
        bestRank = rank;
      }
    }
    if (best) return best;
  }
  const index = indexWorkspacesBySessionId(workspaces);
  for (const sessionId of card.sessionIds ?? []) {
    if (!sessionId) continue;
    const workspace = index.get(sessionId);
    if (workspace) return workspace;
    // 注册表没登记的绑定会话：再按会话 cwd 归组
    const row = sessions.find((session) => session.id === sessionId);
    const byCwd = row ? resolveSessionWorkspace(row, workspaces, index) : null;
    if (byCwd) return byCwd;
  }
  return null;
}

/** 把分组裁到单个工作区（找不到该工作区分组时返回空数组）。 */
export function filterSessionGroupsToWorkspace(
  groups: readonly SessionPickerGroup[],
  workspaceId: string,
): SessionPickerGroup[] {
  const hit = groups.find((group) => group.workspaceId === workspaceId);
  return hit ? [hit] : [];
}
