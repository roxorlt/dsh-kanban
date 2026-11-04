import { describe, expect, it } from 'vitest';
import type { SessionRow, WorkspaceRow } from '../types';
import {
  UNASSIGNED_GROUP_KEY,
  type SessionPickerGroup,
  type SessionPickerSession,
  collectPickerSessions,
  countPickerSessions,
  defaultExpandedGroupKeys,
  filterSessionGroups,
  filterSessionGroupsToWorkspace,
  groupSessionsByWorkspace,
  indexWorkspacesBySessionId,
  normalizePath,
  resolvePickerScopeWorkspace,
  resolveSessionWorkspace,
  shortSessionId,
  workspaceGroupKey,
  workspacePathRank,
} from './sessionPicker';

function makeSession(overrides: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    title: overrides.id,
    running: false,
    updatedAt: 0,
    cwd: undefined,
    workspaceId: undefined,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<WorkspaceRow> & { workspaceId: string }): WorkspaceRow {
  return {
    title: overrides.workspaceId,
    path: `/work/${overrides.workspaceId}`,
    sessionIds: [],
    ...overrides,
  };
}

function groupAt(groups: readonly SessionPickerGroup[], index: number): SessionPickerGroup {
  const group = groups[index];
  if (!group) throw new Error(`缺少第 ${index} 个分组`);
  return group;
}

function firstSession(group: SessionPickerGroup): SessionPickerSession {
  const session = group.sessions[0];
  if (!session) throw new Error('分组里没有会话');
  return session;
}

const workspaces: WorkspaceRow[] = [
  makeWorkspace({ workspaceId: 'ws-kanban', title: 'dsh kanban', path: '/Users/dev/workspace/dsh kanban', sessionIds: ['s-kanban-1'] }),
  makeWorkspace({ workspaceId: 'ws-api', title: 'api-server', path: '/Users/dev/projects/api-server', sessionIds: ['s-api-1', 's-api-2'] }),
  makeWorkspace({ workspaceId: 'ws-empty', title: '空工作区', path: '/work/empty', sessionIds: [] }),
];

const sessions: SessionRow[] = [
  makeSession({ id: 's-kanban-1', title: '看板会话下拉框', cwd: '/Users/dev/workspace/dsh kanban', updatedAt: 100 }),
  makeSession({ id: 's-api-1', title: '阅读交接文件并规划未完成工作', cwd: '/Users/dev/projects/api-server', running: true, updatedAt: 300 }),
  makeSession({ id: 's-api-2', title: '清理临时构建产物', cwd: '/Users/dev/projects/api-server', updatedAt: 200 }),
  makeSession({ id: 's-new-child', title: '子目录里的新会话', cwd: '/Users/dev/projects/api-server/sub', updatedAt: 250 }),
  makeSession({ id: 's-orphan', title: '孤儿会话', cwd: '/tmp/elsewhere', updatedAt: 50 }),
  makeSession({ id: 's-no-cwd', title: '没有 cwd 的会话', updatedAt: 10 }),
];

describe('normalizePath / workspacePathRank', () => {
  it('规范化尾部斜杠、重复分隔符与反斜杠', () => {
    expect(normalizePath('  /a//b/  ')).toBe('/a/b');
    expect(normalizePath('C:\\tmp\\x\\')).toBe('C:/tmp/x');
    expect(normalizePath('')).toBe('');
    expect(normalizePath(null)).toBe('');
    expect(normalizePath('/')).toBe('/');
  });

  it('相同路径命中且排在子目录之前，目录边界不会被误命中', () => {
    const base = '/Users/dev/projects/api-server';
    expect(workspacePathRank('/Users/dev/projects/api-server', base)).toBe(base.length + 1);
    expect(workspacePathRank('/Users/dev/projects/api-server/sub', base)).toBe(base.length);
    expect(workspacePathRank('/Users/dev/projects/api-server2', base)).toBe(-1);
    expect(workspacePathRank(undefined, base)).toBe(-1);
    expect(workspacePathRank('/x', '')).toBe(-1);
  });
});

describe('shortSessionId', () => {
  it('去掉 session- 前缀并截断到 8 位', () => {
    expect(shortSessionId('session-b423633c-6fd6-4ad0-aff3-23f80185ac0c')).toBe('b423633c');
    expect(shortSessionId('session-abc')).toBe('abc');
    expect(shortSessionId('ytd-ask-123456789')).toBe('ytd-ask-');
    expect(shortSessionId('')).toBe('');
  });
});

describe('resolveSessionWorkspace', () => {
  it('注册表 sessionIds 优先', () => {
    expect(resolveSessionWorkspace(makeSession({ id: 's-api-1' }), workspaces)?.workspaceId).toBe('ws-api');
  });

  it('注册表没有时按 cwd 最长前缀归组', () => {
    expect(resolveSessionWorkspace(makeSession({ id: 's-new-child', cwd: '/Users/dev/projects/api-server/sub' }), workspaces)?.workspaceId).toBe('ws-api');
  });

  it('session.workspaceId 直接命中', () => {
    expect(resolveSessionWorkspace(makeSession({ id: 's-x', workspaceId: 'ws-kanban' }), workspaces)?.workspaceId).toBe('ws-kanban');
  });

  it('都匹配不到返回 null', () => {
    expect(resolveSessionWorkspace(makeSession({ id: 's-orphan', cwd: '/tmp/elsewhere' }), workspaces)).toBeNull();
  });

  it('同 ID 出现在多个工作区时取注册表顺序的第一个', () => {
    const index = indexWorkspacesBySessionId([
      makeWorkspace({ workspaceId: 'first', sessionIds: ['dup'] }),
      makeWorkspace({ workspaceId: 'second', sessionIds: ['dup'] }),
    ]);
    expect(index.get('dup')?.workspaceId).toBe('first');
  });
});

describe('collectPickerSessions', () => {
  it('宿主列表打底，补上工作区注册表里缺的会话（placeholder）', () => {
    const merged = collectPickerSessions(sessions, workspaces);
    const byId = new Map(merged.map((session) => [session.id, session]));
    expect(merged).toHaveLength(sessions.length);
    expect(byId.get('s-api-2')?.placeholder).toBeUndefined();
    // 构造一个宿主列表缺 api-server 第二个会话的场景
    const partial = collectPickerSessions(
      sessions.filter((session) => session.id !== 's-api-2'),
      workspaces,
    );
    const placeholder = partial.find((session) => session.id === 's-api-2');
    expect(placeholder?.placeholder).toBe(true);
    expect(placeholder?.cwd).toBe('/Users/dev/projects/api-server');
    expect(placeholder?.title).toBe('');
  });

  it('不重复添加同一会话', () => {
    const merged = collectPickerSessions(sessions, workspaces);
    const ids = merged.map((session) => session.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('groupSessionsByWorkspace', () => {
  it('按工作区注册表顺序分组，无归属会话压到末尾', () => {
    const groups = groupSessionsByWorkspace({ sessions, workspaces });
    expect(groups.map((group) => group.workspaceId)).toEqual(['ws-kanban', 'ws-api', null]);
    expect(groupAt(groups, groups.length - 1).key).toBe(UNASSIGNED_GROUP_KEY);
    expect(groupAt(groups, 1).title).toBe('api-server');
    expect(groupAt(groups, 1).path).toBe('/Users/dev/projects/api-server');
  });

  it('组内按最近活动倒序，空工作区不出现', () => {
    const groups = groupSessionsByWorkspace({ sessions, workspaces });
    expect(groupAt(groups, 1).sessions.map((session) => session.id)).toEqual(['s-api-1', 's-new-child', 's-api-2']);
    expect(groups.some((group) => group.workspaceId === 'ws-empty')).toBe(false);
  });

  it('排除已绑定到当前卡片的会话', () => {
    const groups = groupSessionsByWorkspace({ sessions, workspaces, excludeSessionIds: ['s-api-1'] });
    expect(groupAt(groups, 1).sessions.map((session) => session.id)).toEqual(['s-new-child', 's-api-2']);
  });

  it('全部会话都被排除时返回空数组', () => {
    const groups = groupSessionsByWorkspace({
      sessions,
      workspaces,
      excludeSessionIds: sessions.map((session) => session.id),
    });
    expect(groups).toEqual([]);
    expect(countPickerSessions(groups)).toBe(0);
  });

  it('未归入工作区的分组标题留空（由界面本地化）', () => {
    const groups = groupSessionsByWorkspace({ sessions, workspaces });
    expect(groupAt(groups, 2).title).toBe('');
    expect(groupAt(groups, 2).path).toBeNull();
  });
});

describe('filterSessionGroups', () => {
  const groups = groupSessionsByWorkspace({ sessions, workspaces });

  it('空搜索词原样返回', () => {
    expect(filterSessionGroups(groups, '   ')).toEqual(groups);
  });

  it('搜工作区名时整组保留', () => {
    const filtered = filterSessionGroups(groups, 'api');
    expect(filtered).toHaveLength(1);
    expect(groupAt(filtered, 0).sessions).toHaveLength(3);
  });

  it('搜工作区路径同样命中整组', () => {
    const filtered = filterSessionGroups(groups, 'projects/api');
    expect(filtered).toHaveLength(1);
    expect(groupAt(filtered, 0).workspaceId).toBe('ws-api');
  });

  it('搜标题只留命中的会话', () => {
    const filtered = filterSessionGroups(groups, '清理');
    expect(filtered).toHaveLength(1);
    expect(groupAt(filtered, 0).sessions.map((session) => session.id)).toEqual(['s-api-2']);
  });

  it('搜会话 ID 与 cwd 都能命中', () => {
    expect(firstSession(groupAt(filterSessionGroups(groups, 'orphan'), 0)).id).toBe('s-orphan');
    expect(firstSession(groupAt(filterSessionGroups(groups, '/tmp/elsewhere'), 0)).id).toBe('s-orphan');
  });

  it('无命中返回空数组', () => {
    expect(filterSessionGroups(groups, '不存在的会话')).toEqual([]);
  });
});

describe('defaultExpandedGroupKeys', () => {
  const groups = groupSessionsByWorkspace({ sessions, workspaces });

  it('优先展开卡片所属工作区（workspaceId）', () => {
    expect([...defaultExpandedGroupKeys(groups, { workspaceId: 'ws-kanban' })]).toEqual([workspaceGroupKey('ws-kanban')]);
  });

  it('没有 workspaceId 时按卡片 cwd 最长前缀匹配', () => {
    expect([...defaultExpandedGroupKeys(groups, { cwd: '/Users/dev/projects/api-server' })]).toEqual([workspaceGroupKey('ws-api')]);
  });

  it('都匹配不到时展开最近有动作的分组', () => {
    expect([...defaultExpandedGroupKeys(groups, { cwd: '/tmp/elsewhere' })]).toEqual([workspaceGroupKey('ws-api')]);
  });

  it('只有一个分组时直接展开', () => {
    const only = groupSessionsByWorkspace({
      sessions: [makeSession({ id: 's-api-1', title: '唯一', updatedAt: 1 })],
      workspaces,
    });
    expect([...defaultExpandedGroupKeys(only, {})]).toEqual([workspaceGroupKey('ws-api')]);
  });

  it('没有可选项时返回空集合', () => {
    expect(defaultExpandedGroupKeys([], { workspaceId: 'ws-kanban' }).size).toBe(0);
  });
});

describe('resolvePickerScopeWorkspace', () => {
  it('优先卡片 workspaceId', () => {
    const scope = resolvePickerScopeWorkspace({ sessions, workspaces, card: { workspaceId: 'ws-api' } });
    expect(scope?.workspaceId).toBe('ws-api');
  });

  it('没有 workspaceId 时按卡片 cwd 最长前缀', () => {
    const scope = resolvePickerScopeWorkspace({ sessions, workspaces, card: { cwd: '/Users/dev/projects/api-server/sub' } });
    expect(scope?.workspaceId).toBe('ws-api');
  });

  it('卡片没有 workspaceId/cwd 时按已绑定会话推断', () => {
    const scope = resolvePickerScopeWorkspace({
      sessions,
      workspaces,
      card: { sessionIds: ['s-kanban-1'] },
    });
    expect(scope?.workspaceId).toBe('ws-kanban');
  });

  it('绑定会话只在注册表里也能推断（按注册表归属）', () => {
    const scope = resolvePickerScopeWorkspace({
      sessions: sessions.filter((session) => session.id !== 's-api-2'),
      workspaces,
      card: { sessionIds: ['s-api-2'] },
    });
    expect(scope?.workspaceId).toBe('ws-api');
  });

  it('都匹配不到返回 null（界面退回所有工作区）', () => {
    expect(resolvePickerScopeWorkspace({ sessions, workspaces, card: { cwd: '/tmp/elsewhere' } })).toBeNull();
  });
});

describe('filterSessionGroupsToWorkspace', () => {
  const groups = groupSessionsByWorkspace({ sessions, workspaces });

  it('只留指定工作区分组', () => {
    const scoped = filterSessionGroupsToWorkspace(groups, 'ws-api');
    expect(scoped).toHaveLength(1);
    expect(groupAt(scoped, 0).workspaceId).toBe('ws-api');
    expect(groupAt(scoped, 0).sessions.map((session) => session.id)).toEqual(['s-api-1', 's-new-child', 's-api-2']);
  });

  it('找不到该工作区时返回空数组', () => {
    expect(filterSessionGroupsToWorkspace(groups, 'ws-missing')).toEqual([]);
  });
});
