import type { Card, SessionRow, WorkspaceRow } from '../types';

export type SuggestionSource = 'workspace' | 'session' | 'card' | 'existing';

export interface Suggestion {
  value: string;
  source: SuggestionSource;
  /** 列表第一项为推荐项 */
  recommended: boolean;
  /** 出现/命中次数（用于展示频次） */
  count?: number;
}

export interface ProjectSuggestionInput {
  workspaces: readonly WorkspaceRow[];
  sessions: readonly SessionRow[];
  cards: readonly Card[];
  selectedWorkspaceId?: string | null;
}

export interface CwdSuggestionInput {
  workspaces: readonly WorkspaceRow[];
  sessions: readonly SessionRow[];
  cards: readonly Card[];
  selectedWorkspaceId?: string | null;
}

/** 目录 basename（同时兼容 / 与 \\，忽略尾部分隔符）。 */
export function pathBasename(path: string | undefined): string {
  if (!path) return '';
  const cleaned = path.trim().replace(/[/\\]+$/, '');
  if (!cleaned) return '';
  const parts = cleaned.split(/[/\\]+/);
  return parts[parts.length - 1] ?? '';
}

function normalizePath(path: string | undefined): string {
  return (path ?? '').trim().replace(/[/\\]+$/, '');
}

function pathDepth(path: string): number {
  return path.split(/[/\\]+/).filter(Boolean).length;
}

function recentSessions(sessions: readonly SessionRow[]): SessionRow[] {
  return [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
}

interface RankedValue {
  value: string;
  source: SuggestionSource;
  score: number;
  count: number;
}

function toSuggestions(map: Map<string, RankedValue>): Suggestion[] {
  const list = [...map.values()]
    .filter((item) => item.value.trim().length > 0)
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value, 'zh-Hans-CN'));
  return list.map((item, index) => ({
    value: item.value,
    source: item.source,
    recommended: index === 0,
    ...(item.count > 1 ? { count: item.count } : {}),
  }));
}

function bump(map: Map<string, RankedValue>, value: string, source: SuggestionSource, score: number): void {
  const key = value.trim();
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    if (score > existing.score) {
      existing.score = score;
      existing.source = source;
    }
    return;
  }
  map.set(key, { value: key, source, score, count: 1 });
}

/**
 * 项目建议：选中工作区（title + path basename）> 近期会话 cwd basename > 既有卡片 project 频次。
 * 去重后推荐首项。
 */
export function suggestProjects(input: ProjectSuggestionInput): Suggestion[] {
  const map = new Map<string, RankedValue>();
  const sessions = recentSessions(input.sessions);
  const selected = input.workspaces.find((workspace) => workspace.workspaceId === input.selectedWorkspaceId);

  if (selected) {
    bump(map, selected.title, 'workspace', 1000);
    bump(map, pathBasename(selected.path), 'workspace', 990);
  }

  input.workspaces.forEach((workspace, index) => {
    if (workspace.workspaceId === input.selectedWorkspaceId) return;
    const base = Math.max(0, 60 - index * 5);
    bump(map, workspace.title, 'workspace', base);
    bump(map, pathBasename(workspace.path), 'workspace', base - 1);
  });

  sessions.forEach((session, index) => {
    const score = Math.max(5, 80 - index * 6) + (session.running ? 4 : 0);
    bump(map, pathBasename(session.cwd), 'session', score);
  });

  for (const card of input.cards) {
    if (card.project) bump(map, card.project, 'card', Math.min(45, 12 + (map.get(card.project)?.count ?? 0) * 4));
  }

  return toSuggestions(map);
}

/**
 * cwd 建议：选中/各工作区 path 优先，其次会话 cwd，最后既有卡片 cwd；JSON 去重并标来源。
 */
export function suggestCwds(input: CwdSuggestionInput): Suggestion[] {
  const map = new Map<string, RankedValue>();
  const sessions = recentSessions(input.sessions);
  const selected = input.workspaces.find((workspace) => workspace.workspaceId === input.selectedWorkspaceId);

  if (selected?.path) bump(map, normalizePath(selected.path), 'workspace', 1000);
  input.workspaces.forEach((workspace, index) => {
    if (workspace.workspaceId === input.selectedWorkspaceId) return;
    bump(map, normalizePath(workspace.path), 'workspace', Math.max(0, 80 - index * 6));
  });
  sessions.forEach((session, index) => {
    bump(map, normalizePath(session.cwd), 'session', Math.max(5, 60 - index * 5) + (session.running ? 4 : 0));
  });
  for (const card of input.cards) {
    bump(map, normalizePath(card.cwd), 'card', 35);
  }

  return toSuggestions(map);
}

/** 选工作区后的默认 cwd/project 回填（project 仅用于空值回填）。 */
export function workspaceDefaults(workspace: WorkspaceRow | undefined): { cwd: string; project: string } {
  if (!workspace) return { cwd: '', project: '' };
  return { cwd: normalizePath(workspace.path), project: workspace.title.trim() };
}

export type SessionMatchReason = 'cwd-exact' | 'cwd-prefix' | 'workspace' | 'keyword' | 'recent' | 'running';

export interface SessionSuggestion {
  session: SessionRow;
  score: number;
  reason: SessionMatchReason;
  recommended: boolean;
}

export interface SessionSuggestionInput {
  sessions: readonly SessionRow[];
  cwd?: string;
  workspaceId?: string;
  project?: string;
  title?: string;
}

function keywordHits(session: SessionRow, keywords: readonly string[]): number {
  const haystack = `${session.title} ${pathBasename(session.cwd)}`.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword)).length;
}

/**
 * 会话建议打分：cwd 精确 > cwd 前缀 > workspaceId > project/title 关键词，running 与近期更新加分；
 * 返回前 8 条，得分最高者为推荐项。
 */
export function suggestSessions(input: SessionSuggestionInput): SessionSuggestion[] {
  const cwd = normalizePath(input.cwd);
  const keywords = `${input.project ?? ''} ${input.title ?? ''}`
    .toLowerCase()
    .split(/[\s,，、/\\_-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  const ordered = [...input.sessions].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
  );

  const scored = ordered.map((session, index) => {
    const sessionCwd = normalizePath(session.cwd);
    let score = 0;
    let reason: SessionMatchReason = 'recent';
    if (cwd && sessionCwd && sessionCwd === cwd) {
      score += 120;
      reason = 'cwd-exact';
    } else if (
      cwd &&
      sessionCwd &&
      (sessionCwd.startsWith(`${cwd}/`) || cwd.startsWith(`${sessionCwd}/`))
    ) {
      // 前缀匹配时目录越深越相关（同前缀下更具体的子目录优先）
      score += 70 + Math.min(20, Math.max(0, pathDepth(sessionCwd) - 3) * 5);
      reason = 'cwd-prefix';
    }
    if (input.workspaceId && session.workspaceId === input.workspaceId) {
      score += 60;
      if (reason === 'recent') reason = 'workspace';
    }
    const hits = keywordHits(session, keywords);
    if (hits) {
      score += Math.min(50, hits * 25);
      if (reason === 'recent') reason = 'keyword';
    }
    if (session.running) {
      score += 15;
      if (reason === 'recent') reason = 'running';
    }
    score += Math.max(0, 12 - index * 2);
    return { session, score, reason, recommended: false };
  });

  scored.sort(
    (a, b) => b.score - a.score || (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0) || a.session.id.localeCompare(b.session.id),
  );
  const top = scored.slice(0, 8);
  return top.map((item, index) => ({ ...item, recommended: index === 0 }));
}

/** 推荐（首项）；无会话时返回 null。 */
export function recommendedSession(suggestions: readonly SessionSuggestion[]): SessionSuggestion | null {
  return suggestions.find((item) => item.recommended) ?? suggestions[0] ?? null;
}
