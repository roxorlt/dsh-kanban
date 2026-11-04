import { describe, expect, it } from 'vitest';
import type { Card, SessionRow, WorkspaceRow } from '../types';
import { findProjectWorkspaces, resolveCardWorkspace, suggestSessionToBind } from './sessionSuggest';

function makeCard(overrides: Partial<Card> & { id: string }): Card {
  return {
    boardId: 'board-default',
    title: overrides.title ?? overrides.id,
    summary: '',
    status: 'backlog',
    priority: 'none',
    labels: [],
    sessionIds: [],
    checklists: [],
    approvals: [],
    artifacts: [],
    metadata: { toolCalls: 0, searches: 0 },
    order: 0,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Card;
}

function makeSession(overrides: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    title: overrides.id,
    running: false,
    updatedAt: 0,
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

const KANBAN_PATH = '/Users/dev/workspace/dsh kanban';
const API_PATH = '/Users/dev/projects/api-server';

const workspaces: WorkspaceRow[] = [
  makeWorkspace({ workspaceId: 'ws-kanban', title: 'dsh kanban', path: KANBAN_PATH }),
  makeWorkspace({ workspaceId: 'ws-api', title: 'api-server', path: API_PATH }),
  makeWorkspace({ workspaceId: 'ws-empty', title: '空工作区', path: '/work/empty' }),
];

const NO_IDS: ReadonlySet<string> = new Set();

describe('resolveCardWorkspace', () => {
  it('优先按 card.workspaceId 命中工作区', () => {
    expect(resolveCardWorkspace({ workspaceId: 'ws-api' }, workspaces)?.workspaceId).toBe('ws-api');
  });

  it('没有 workspaceId 时按卡片 cwd 最长前缀匹配', () => {
    expect(resolveCardWorkspace({ cwd: `${API_PATH}/sub` }, workspaces)?.workspaceId).toBe('ws-api');
    expect(resolveCardWorkspace({ cwd: `${API_PATH}/sub`, workspaceId: 'ws-kanban' }, workspaces)?.workspaceId).toBe(
      'ws-kanban',
    );
  });

  it('匹配不到返回 null', () => {
    expect(resolveCardWorkspace({ cwd: '/tmp/elsewhere' }, workspaces)).toBeNull();
    expect(resolveCardWorkspace({}, workspaces)).toBeNull();
  });
});

describe('findProjectWorkspaces', () => {
  it('project 与工作区 title 或目录 basename 相等时命中（忽略大小写与空白）', () => {
    expect(findProjectWorkspaces('api-server', workspaces).map((workspace) => workspace.workspaceId)).toEqual(['ws-api']);
    expect(findProjectWorkspaces(' dsh KANBAN ', workspaces).map((workspace) => workspace.workspaceId)).toEqual([
      'ws-kanban',
    ]);
  });

  it('project 为空或只是包含关系时不命中', () => {
    expect(findProjectWorkspaces(undefined, workspaces)).toEqual([]);
    expect(findProjectWorkspaces('api', workspaces)).toEqual([]);
  });
});

describe('suggestSessionToBind — 同工作区优先', () => {
  it('卡片所属工作区的会话赢过其它工作区里更新的会话', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', workspaceId: 'ws-kanban', cwd: KANBAN_PATH }),
      sessions: [
        makeSession({ id: 's-kanban-old', title: '旧看板会话', workspaceId: 'ws-kanban', updatedAt: 10 }),
        makeSession({ id: 's-api-new', title: '新 api 会话', workspaceId: 'ws-api', updatedAt: 999 }),
        makeSession({ id: 's-orphan', title: '无关会话', cwd: '/tmp/elsewhere', updatedAt: 1000 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-kanban-old');
    expect(suggestion?.reason).toBe('workspace');
    expect(suggestion?.workspaceTitle).toBe('dsh kanban');
  });

  it('卡片没有 workspaceId 时按卡片 cwd 最长前缀找到工作区', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', cwd: `${API_PATH}/sub` }),
      sessions: [
        makeSession({ id: 's-api', title: 'api 会话', cwd: API_PATH, updatedAt: 5 }),
        makeSession({ id: 's-kanban', title: '看板会话', workspaceId: 'ws-kanban', updatedAt: 900 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-api');
    expect(suggestion?.reason).toBe('workspace');
    expect(suggestion?.workspaceTitle).toBe('api-server');
  });

  it('工作区注册表里没有卡片记录的 workspaceId 时，按会话自带 workspaceId 兜底', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', workspaceId: 'ws-ghost' }),
      sessions: [
        makeSession({ id: 's-ghost', workspaceId: 'ws-ghost', updatedAt: 1 }),
        makeSession({ id: 's-other', workspaceId: 'ws-kanban', updatedAt: 999 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-ghost');
    expect(suggestion?.reason).toBe('workspace');
    expect(suggestion?.workspaceTitle).toBeUndefined();
  });
});

describe('suggestSessionToBind — 同 cwd', () => {
  it('卡片 cwd 与某个会话 cwd 相同时推荐它（即使该会话不在工作区注册表里）', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', cwd: '/tmp/elsewhere/project' }),
      sessions: [
        makeSession({ id: 's-same-cwd', title: '同目录会话', cwd: '/tmp/elsewhere/project', updatedAt: 1 }),
        makeSession({ id: 's-more-recent', title: '无关但更新的会话', cwd: '/tmp/other', updatedAt: 999 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-same-cwd');
    expect(suggestion?.reason).toBe('cwd');
    expect(suggestion?.workspaceTitle).toBeUndefined();
  });

  it('互为前缀（子目录 / 上级目录）时也推荐，但排在 cwd 相同之后', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', cwd: '/tmp/elsewhere/project' }),
      sessions: [
        makeSession({ id: 's-child', title: '子目录会话', cwd: '/tmp/elsewhere/project/src', updatedAt: 900 }),
        makeSession({ id: 's-same', title: '同目录会话', cwd: '/tmp/elsewhere/project', updatedAt: 1 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-same');
    expect(suggestion?.reason).toBe('cwd');
  });

  it('目录边界不会被误命中（/a/b 不该匹配 /a/bc）', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', cwd: '/tmp/elsewhere/project' }),
      sessions: [makeSession({ id: 's-lookalike', cwd: '/tmp/elsewhere/project2', updatedAt: 1 })],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion).toBeNull();
  });
});

describe('suggestSessionToBind — 项目匹配', () => {
  it('卡片 project 对应到工作区时，推荐该工作区的会话', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', project: 'api-server' }),
      sessions: [
        makeSession({ id: 's-kanban', title: '看板会话', workspaceId: 'ws-kanban', updatedAt: 999 }),
        makeSession({ id: 's-api', title: 'api 会话', workspaceId: 'ws-api', updatedAt: 1 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-api');
    expect(suggestion?.reason).toBe('project');
    expect(suggestion?.workspaceTitle).toBe('api-server');
  });

  it('project 与工作区目录 basename 相等也能命中', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', project: 'dsh kanban' }),
      sessions: [makeSession({ id: 's-kanban', workspaceId: 'ws-kanban', updatedAt: 1 })],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-kanban');
    expect(suggestion?.reason).toBe('project');
  });
});

describe('suggestSessionToBind — 排除与空结果', () => {
  it('排除已绑定到当前卡片的会话', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', workspaceId: 'ws-kanban', sessionIds: ['s-kanban-newest'] }),
      sessions: [
        makeSession({ id: 's-kanban-newest', workspaceId: 'ws-kanban', updatedAt: 999 }),
        makeSession({ id: 's-kanban-older', workspaceId: 'ws-kanban', updatedAt: 1 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-kanban-older');
  });

  it('排除宿主已归档的会话', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', workspaceId: 'ws-kanban' }),
      sessions: [
        makeSession({ id: 's-archived', workspaceId: 'ws-kanban', updatedAt: 999 }),
        makeSession({ id: 's-live', workspaceId: 'ws-kanban', updatedAt: 1 }),
      ],
      workspaces,
      archivedSessionIds: new Set(['s-archived']),
    });
    expect(suggestion?.session.id).toBe('s-live');
  });

  it('相关会话全被排除时返回 null', () => {
    expect(
      suggestSessionToBind({
        card: makeCard({ id: 'c1', workspaceId: 'ws-kanban', sessionIds: ['s-bound'] }),
        sessions: [
          makeSession({ id: 's-bound', workspaceId: 'ws-kanban' }),
          makeSession({ id: 's-archived', workspaceId: 'ws-kanban' }),
        ],
        workspaces,
        archivedSessionIds: new Set(['s-archived']),
      }),
    ).toBeNull();
  });

  it('没有任何相关性时返回 null（不为了有推荐而乱推）', () => {
    expect(
      suggestSessionToBind({
        card: makeCard({ id: 'c1' }),
        sessions: [
          makeSession({ id: 's-kanban', workspaceId: 'ws-kanban', updatedAt: 999 }),
          makeSession({ id: 's-api', workspaceId: 'ws-api', updatedAt: 900 }),
          makeSession({ id: 's-recent', title: '最近活跃但无关', cwd: '/tmp/elsewhere', updatedAt: 1000 }),
        ],
        workspaces,
        archivedSessionIds: NO_IDS,
      }),
    ).toBeNull();
  });

  it('没有会话时返回 null', () => {
    expect(
      suggestSessionToBind({
        card: makeCard({ id: 'c1', workspaceId: 'ws-kanban' }),
        sessions: [],
        workspaces,
        archivedSessionIds: NO_IDS,
      }),
    ).toBeNull();
  });
});

describe('suggestSessionToBind — 最近活跃 tie-break', () => {
  it('同一档内 updatedAt 更新的会话优先', () => {
    const suggestion = suggestSessionToBind({
      card: makeCard({ id: 'c1', workspaceId: 'ws-kanban' }),
      sessions: [
        makeSession({ id: 's-old', workspaceId: 'ws-kanban', updatedAt: 1 }),
        makeSession({ id: 's-new', workspaceId: 'ws-kanban', updatedAt: 2 }),
        makeSession({ id: 's-mid', workspaceId: 'ws-kanban', updatedAt: 1.5 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(suggestion?.session.id).toBe('s-new');
  });

  it('updatedAt 相同时按会话 ID 稳定排序', () => {
    const first = suggestSessionToBind({
      card: makeCard({ id: 'c1', workspaceId: 'ws-kanban' }),
      sessions: [
        makeSession({ id: 's-b', workspaceId: 'ws-kanban', updatedAt: 10 }),
        makeSession({ id: 's-a', workspaceId: 'ws-kanban', updatedAt: 10 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    const second = suggestSessionToBind({
      card: makeCard({ id: 'c1', workspaceId: 'ws-kanban' }),
      sessions: [
        makeSession({ id: 's-a', workspaceId: 'ws-kanban', updatedAt: 10 }),
        makeSession({ id: 's-b', workspaceId: 'ws-kanban', updatedAt: 10 }),
      ],
      workspaces,
      archivedSessionIds: NO_IDS,
    });
    expect(first?.session.id).toBe('s-a');
    expect(second?.session.id).toBe('s-a');
  });
});
