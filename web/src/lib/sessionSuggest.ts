/**
 * 补绑推荐（v0.20.1，卡片 card-974dc87b）。
 *
 * 背景：agent 以前建的卡片常常没绑会话，详情抽屉里只剩一句「未绑定」提示，
 * 用户只能去一一翻会话列表。这个模块用卡片已有信息，从宿主会话列表里挑一个
 * 最可能正确的会话，给用户一个「点一下补齐」的入口——**只推荐，不自动绑定**；
 * 用户手动选择永远优先。
 *
 * 打分规则（从高到低，各档互斥取最高档）：
 * 1. workspace：会话属于卡片所属工作区（card.workspaceId → 工作区注册表；
 *    否则 card.cwd 与工作区 path 最长前缀匹配）；
 * 2. cwd：会话 cwd 与卡片 cwd 相同，或二者互为目录前缀（卡片常是会话目录的子目录，反之亦然）；
 * 3. project：卡片 project 与某个工作区的名称 / 目录 basename 相等，该工作区下的会话；
 * 4. 最近活跃（updatedAt）只做同一档内的 tie-break，不参与加分——
 *    否则「最近用过但和卡片毫无关系」的会话会被推出来。
 *
 * 任何一档都没命中时返回 null：推荐不出来就不显示，宁缺毋滥。
 *
 * 只放纯函数，不依赖 React/DOM，便于单测。
 */
import type { Card, SessionRow, WorkspaceRow } from '../types';
import { normalizePath, resolveSessionWorkspace, workspacePathRank } from './sessionPicker';
import { pathBasename } from './suggestions';

/** 命中的相关性档位；界面上按档位给一句原因。 */
export type SessionBindReason = 'workspace' | 'cwd' | 'project';

/** 补绑推荐结果。 */
export interface SessionBindSuggestion {
  session: SessionRow;
  reason: SessionBindReason;
  /** 命中工作区时的工作区显示名（卡片 workspaceId 直接命中、但注册表里没有该工作区时为空）。 */
  workspaceTitle?: string;
}

export interface SessionBindInput {
  card: Card;
  sessions: readonly SessionRow[];
  workspaces: readonly WorkspaceRow[];
  /** 宿主已归档的会话：不再作为候选（归档会话要恢复后才能继续用）。 */
  archivedSessionIds: ReadonlySet<string>;
}

/** 各档得分。档与档之间留足间隔，保证「高档一定赢过低档」。 */
const SCORE_WORKSPACE = 300;
const SCORE_CWD_SAME = 220;
const SCORE_CWD_PREFIX = 150;
const SCORE_PROJECT = 120;

/** 低于这个分数视为「和卡片没有可解释的关系」，返回 null（不显示推荐）。 */
export const MIN_SESSION_BIND_SCORE = 100;

/** 工作区显示名：标题 > 目录 basename > workspaceId（保证界面上永远认得出）。 */
function workspaceDisplayTitle(workspace: WorkspaceRow): string {
  const title = (workspace.title ?? '').trim();
  if (title) return title;
  const basename = pathBasename(workspace.path);
  return basename || workspace.workspaceId;
}

/**
 * 卡片所属工作区：先按 card.workspaceId 精确命中，再按 card.cwd 与各工作区 path
 * 做最长前缀匹配；都匹配不到返回 null。
 */
export function resolveCardWorkspace(
  card: Pick<Card, 'workspaceId' | 'cwd'>,
  workspaces: readonly WorkspaceRow[],
): WorkspaceRow | null {
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
    if (bestRank >= 0) return best;
  }
  return null;
}

/**
 * 卡片 project 可能对应的工作区：project 与「工作区 title / 目录 basename」
 * 忽略大小写与首尾空白后相等。这是弱信号（可能重名），所以打分排在工作区 / cwd 之后。
 */
export function findProjectWorkspaces(
  project: string | undefined,
  workspaces: readonly WorkspaceRow[],
): WorkspaceRow[] {
  const needle = (project ?? '').trim().toLowerCase();
  if (!needle) return [];
  return workspaces.filter((workspace) => {
    const title = (workspace.title ?? '').trim().toLowerCase();
    const basename = pathBasename(workspace.path).trim().toLowerCase();
    return title === needle || basename === needle;
  });
}

/** a 是否为 b 的上级目录（按整段目录边界：/a/b 不会命中 /a/bc）。 */
function isParentPath(parent: string, child: string): boolean {
  if (!parent || !child || parent === child) return false;
  const prefix = parent === '/' ? '/' : `${parent}/`;
  return child.startsWith(prefix);
}

interface ScoreContext {
  cardCwd: string;
  cardWorkspace: WorkspaceRow | null;
  cardWorkspaceId: string | null;
  projectWorkspaces: readonly WorkspaceRow[];
  workspaces: readonly WorkspaceRow[];
}

interface CandidateScore {
  score: number;
  reason: SessionBindReason;
  workspaceTitle?: string;
}

/** 给单个会话打相关性分；一档都没命中返回 null。 */
function scoreCandidate(session: SessionRow, context: ScoreContext): CandidateScore | null {
  const sessionWorkspace = resolveSessionWorkspace(session, context.workspaces);
  let best: CandidateScore | null = null;
  const consider = (score: number, reason: SessionBindReason, workspaceTitle?: string): void => {
    if (score <= (best?.score ?? -1)) return;
    best = { score, reason, ...(workspaceTitle ? { workspaceTitle } : {}) };
  };

  // 档 1：同一个工作区。
  if (context.cardWorkspace) {
    if (sessionWorkspace && sessionWorkspace.workspaceId === context.cardWorkspace.workspaceId) {
      consider(SCORE_WORKSPACE, 'workspace', workspaceDisplayTitle(context.cardWorkspace));
    }
  } else if (context.cardWorkspaceId && session.workspaceId === context.cardWorkspaceId) {
    // 工作区注册表里没有卡片记录的 workspaceId（注册表可能过期）：按会话自带的 workspaceId 兜底，
    // 两边 ID 完全一致仍是可靠信号，只是拿不到工作区显示名。
    const title =
      sessionWorkspace && sessionWorkspace.workspaceId === context.cardWorkspaceId
        ? workspaceDisplayTitle(sessionWorkspace)
        : undefined;
    consider(SCORE_WORKSPACE, 'workspace', title);
  }

  // 档 2：cwd 相同 / 互为前缀。
  const sessionCwd = normalizePath(session.cwd);
  if (context.cardCwd && sessionCwd) {
    if (sessionCwd === context.cardCwd) {
      consider(SCORE_CWD_SAME, 'cwd');
    } else if (
      isParentPath(sessionCwd, context.cardCwd) ||
      isParentPath(context.cardCwd, sessionCwd)
    ) {
      consider(SCORE_CWD_PREFIX, 'cwd');
    }
  }

  // 档 3：项目名对应到某个工作区，会话属于该工作区。
  if (context.projectWorkspaces.length > 0) {
    const sessionWorkspaceId = sessionWorkspace?.workspaceId ?? session.workspaceId ?? null;
    const hit = sessionWorkspaceId
      ? context.projectWorkspaces.find((workspace) => workspace.workspaceId === sessionWorkspaceId)
      : undefined;
    if (hit) consider(SCORE_PROJECT, 'project', workspaceDisplayTitle(hit));
  }

  return best;
}

/**
 * 补绑推荐主函数：返回最可能正确的会话，或 null（没候选 / 候选都与卡片无关）。
 *
 * 候选过滤：排除已归档、已绑定到当前卡片、ID 为空的会话。
 * 排序：档位分高者优先；同档内 updatedAt 新者优先；再相同按会话 ID 保证结果稳定。
 */
export function suggestSessionToBind({
  card,
  sessions,
  workspaces,
  archivedSessionIds,
}: SessionBindInput): SessionBindSuggestion | null {
  if (sessions.length === 0) return null;

  const context: ScoreContext = {
    cardCwd: normalizePath(card.cwd),
    cardWorkspace: resolveCardWorkspace(card, workspaces),
    cardWorkspaceId: (card.workspaceId ?? '').trim() || null,
    projectWorkspaces: findProjectWorkspaces(card.project, workspaces),
    workspaces,
  };
  const bound = new Set(card.sessionIds ?? []);
  const seen = new Set<string>();
  const scored: Array<{ session: SessionRow; result: CandidateScore }> = [];

  for (const session of sessions) {
    if (!session || typeof session.id !== 'string' || !session.id) continue;
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    if (archivedSessionIds.has(session.id)) continue;
    if (bound.has(session.id)) continue;
    const result = scoreCandidate(session, context);
    if (!result || result.score < MIN_SESSION_BIND_SCORE) continue;
    scored.push({ session, result });
  }

  if (scored.length === 0) return null;
  scored.sort(
    (left, right) =>
      right.result.score - left.result.score ||
      (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0) ||
      left.session.id.localeCompare(right.session.id),
  );
  const top = scored[0];
  if (!top) return null;
  return {
    session: top.session,
    reason: top.result.reason,
    ...(top.result.workspaceTitle ? { workspaceTitle: top.result.workspaceTitle } : {}),
  };
}
