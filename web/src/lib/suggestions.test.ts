import { describe, expect, it } from 'vitest';
import type { Card, SessionRow, WorkspaceRow } from '../types';
import {
  pathBasename,
  recommendedSession,
  suggestCwds,
  suggestProjects,
  suggestSessions,
  workspaceDefaults,
} from './suggestions';

const WORKSPACES: WorkspaceRow[] = [
  { workspaceId: 'ws-kanban', title: 'DSH 看板', path: '/Users/dev/projects/dsh-kanban', sessionIds: ['s1', 's2'] },
  { workspaceId: 'ws-other', title: '发布运维', path: '/Users/dev/projects/release-ops', sessionIds: ['s3'] },
];

const SESSIONS: SessionRow[] = [
  { id: 's1', title: '看板 Web UI 实现', running: true, updatedAt: 300, workspaceId: 'ws-kanban', cwd: '/Users/dev/projects/dsh-kanban' },
  { id: 's2', title: '审批与多问题', running: false, updatedAt: 200, workspaceId: 'ws-kanban', cwd: '/Users/dev/projects/dsh-kanban/web' },
  { id: 's3', title: '发布运维脚本', running: false, updatedAt: 100, workspaceId: 'ws-other', cwd: '/Users/dev/projects/release-ops' },
  { id: 's4', title: '其他项目', running: false, updatedAt: 50, cwd: '/Users/dev/projects/misc' },
];

function card(project: string | undefined, cwd?: string): Card {
  return {
    id: `card-${project ?? 'none'}-${cwd ?? ''}`,
    boardId: 'board',
    title: 't',
    summary: '',
    status: 'backlog',
    priority: 'none',
    labels: [],
    project,
    cwd,
    sessionIds: [],
    checklists: [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0, elapsedMs: 0 },
    order: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

const CARDS = [
  card('dsh-kanban', '/Users/dev/projects/dsh-kanban'),
  card('dsh-kanban'),
  card('docs'),
  card('release-ops', '/Users/dev/projects/release-ops'),
];

describe('项目建议', () => {
  it('选中工作区优先，其次会话 cwd basename，再按项目频次去重排序', () => {
    const list = suggestProjects({ workspaces: WORKSPACES, sessions: SESSIONS, cards: CARDS, selectedWorkspaceId: 'ws-other' });
    expect(list[0]).toMatchObject({ value: '发布运维', source: 'workspace', recommended: true });
    expect(list.map((item) => item.value)).toEqual(
      expect.arrayContaining(['release-ops', 'dsh-kanban', 'docs', 'web', 'misc']),
    );
    // dsh-kanban 同时来自 workspace/会话/卡片，只保留一条
    expect(list.filter((item) => item.value === 'dsh-kanban')).toHaveLength(1);
    // docs 仅卡片来源
    expect(list.find((item) => item.value === 'docs')?.source).toBe('card');
    // 推荐项只有第一个
    expect(list.filter((item) => item.recommended)).toHaveLength(1);
  });

  it('工作区 title 与 path basename 都会进入建议，且忽略空值', () => {
    const workspaces = [...WORKSPACES, { workspaceId: 'ws-empty', title: '/', path: '', sessionIds: [] }];
    const list = suggestProjects({ workspaces, sessions: [], cards: [] });
    expect(list.map((item) => item.value)).toEqual(expect.arrayContaining(['DSH 看板', 'dsh-kanban', '发布运维', 'release-ops']));
    expect(list.every((item) => item.value.trim().length > 0)).toBe(true);
  });
});

describe('cwd 建议', () => {
  it('选中工作区 path 推荐首项，工作区 path > 近期会话 cwd > 卡片 cwd', () => {
    const list = suggestCwds({ workspaces: WORKSPACES, sessions: SESSIONS, cards: CARDS, selectedWorkspaceId: 'ws-kanban' });
    expect(list[0]).toMatchObject({ value: '/Users/dev/projects/dsh-kanban', source: 'workspace', recommended: true });
    const values = list.map((item) => item.value);
    expect(values.indexOf('/Users/dev/projects/dsh-kanban')).toBe(0);
    expect(values).toContain('/Users/dev/projects/dsh-kanban/web');
    expect(values).toContain('/Users/dev/projects/misc');
    // 去重
    expect(new Set(values).size).toBe(values.length);
    expect(list.find((item) => item.value === '/Users/dev/projects/dsh-kanban/web')?.source).toBe('session');
  });

  it('无选中工作区时按工作区列表顺序，卡片 cwd 兜底', () => {
    const list = suggestCwds({
      workspaces: [],
      sessions: [],
      cards: [card('x', '/tmp/card-dir')],
    });
    expect(list).toEqual([{ value: '/tmp/card-dir', source: 'card', recommended: true }]);
  });
});

describe('会话建议', () => {
  it('cwd 精确命中排第一并标推荐', () => {
    const list = suggestSessions({
      sessions: SESSIONS,
      cwd: '/Users/dev/projects/dsh-kanban',
      workspaceId: 'ws-kanban',
      project: 'dsh-kanban',
      title: 'Web UI',
    });
    expect(list[0]?.session.id).toBe('s1');
    expect(list[0]?.recommended).toBe(true);
    expect(list[0]?.reason).toBe('cwd-exact');
    // s2 是子目录 + workspace + 关键词，排第二
    expect(list[1]?.session.id).toBe('s2');
    expect(list.filter((item) => item.recommended)).toHaveLength(1);
  });

  it('cwd 前缀、workspaceId、关键词与 running 依次影响评分', () => {
    const notRunning = SESSIONS.map((session) => ({ ...session, running: false }));
    const cwdPrefix = suggestSessions({ sessions: notRunning, cwd: '/Users/dev/projects/dsh-kanban/web/src' });
    expect(cwdPrefix[0]?.session.id).toBe('s2');
    expect(cwdPrefix[0]?.reason).toBe('cwd-prefix');
    const workspaceOnly = suggestSessions({ sessions: SESSIONS, workspaceId: 'ws-other' });
    expect(workspaceOnly[0]?.session.id).toBe('s3');
    expect(workspaceOnly[0]?.reason).toBe('workspace');
    const keyword = suggestSessions({ sessions: SESSIONS, title: '审批' });
    expect(keyword[0]?.session.id).toBe('s2');
    expect(keyword[0]?.reason).toBe('keyword');
  });

  it('最多返回 8 条，无匹配时按 updatedAt 排序', () => {
    const many: SessionRow[] = Array.from({ length: 12 }, (_, index) => ({
      id: `s-${index}`,
      title: `会话 ${index}`,
      running: false,
      updatedAt: 1000 - index,
      cwd: `/tmp/${index}`,
    }));
    const list = suggestSessions({ sessions: many });
    expect(list).toHaveLength(8);
    expect(list[0]?.session.id).toBe('s-0');
    expect(list[0]?.reason).toBe('recent');
    expect(recommendedSession(list)?.session.id).toBe('s-0');
    expect(recommendedSession([])).toBeNull();
  });
});

describe('工具函数', () => {
  it('pathBasename 处理尾斜杠与 Windows 路径', () => {
    expect(pathBasename('/Users/dev/dsh-kanban/')).toBe('dsh-kanban');
    expect(pathBasename('C:\\work\\project\\')).toBe('project');
    expect(pathBasename('/')).toBe('');
    expect(pathBasename(undefined)).toBe('');
  });

  it('workspaceDefaults 回填 cwd 与 project', () => {
    expect(workspaceDefaults(WORKSPACES[0])).toEqual({ cwd: '/Users/dev/projects/dsh-kanban', project: 'DSH 看板' });
    expect(workspaceDefaults(undefined)).toEqual({ cwd: '', project: '' });
  });
});
