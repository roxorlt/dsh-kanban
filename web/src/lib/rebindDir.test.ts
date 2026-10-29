import { describe, expect, it } from 'vitest';
import type {
  Card,
  GitWorkspaceRepo,
  GitWorkspaceUnavailable,
  GitWorkspaceWorktree,
  SessionRow,
} from '../types';
import { translate } from '../i18n';
import type { Translate } from '../i18n';
import { buildRebindCandidates, cardCwdState, formatRebindComment } from './rebindDir';

/** 用真实 zh 字典做 t：顺带验证 i18n 键与占位符确实可用。 */
const t: Translate = (key, vars) => translate('zh', key, vars);

type CardCwdInput = Pick<Card, 'cwd' | 'sessionIds'>;

function makeWorktree(path: string, overrides: Partial<GitWorkspaceWorktree> = {}): GitWorkspaceWorktree {
  return {
    path,
    branch: 'main',
    detached: false,
    sha: 'aaaa1111222233334444555566667777888899aa',
    shortSha: 'aaaa111',
    isMain: false,
    isCurrent: false,
    aheadOfBase: 0,
    behindOfBase: 0,
    dirty: false,
    ...overrides,
  };
}

function makeRepo(
  name: string,
  worktrees: GitWorkspaceWorktree[],
  overrides: Partial<GitWorkspaceRepo> = {},
): GitWorkspaceRepo {
  return {
    root: `/repos/${name}`,
    name,
    commonDir: `/repos/${name}/.git`,
    mainBranch: 'main',
    worktrees,
    ...overrides,
  };
}

function makeSession(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return { id, title: id, running: false, updatedAt: 0, ...overrides };
}

function makeCard(overrides: Partial<CardCwdInput> = {}): CardCwdInput {
  return { cwd: undefined, sessionIds: [], ...overrides };
}

describe('buildRebindCandidates', () => {
  const repos: GitWorkspaceRepo[] = [
    makeRepo('kanban', [
      makeWorktree('/repos/kanban', { branch: 'main', isMain: true }),
      makeWorktree('/repos/kanban/.worktrees/feat-a', { branch: 'feat/a' }),
      makeWorktree('/repos/kanban/.worktrees/gone', { branch: 'feat/gone', prunable: true }),
    ]),
    makeRepo('other', [
      makeWorktree('/repos/other', { branch: 'main', isMain: true }),
      makeWorktree('/repos/other/.worktrees/feat-b', { branch: 'feat/b' }),
    ]),
  ];
  const sessions: SessionRow[] = [
    makeSession('s-a', { title: '会话 A', cwd: '/repos/kanban/.worktrees/feat-a' }),
    makeSession('s-other', { title: '会话 B', cwd: '/repos/other' }),
  ];

  it('顺序：绑定会话目录 → 每个仓库的主副本 → linked worktree', () => {
    const card = makeCard({ sessionIds: ['s-a', 's-other'] });
    const candidates = buildRebindCandidates({ repos, sessions, card, t });
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      '/repos/kanban/.worktrees/feat-a',
      '/repos/other',
      '/repos/kanban',
      // /repos/kanban/.worktrees/feat-a 已被会话候选占用
      '/repos/other/.worktrees/feat-b',
    ]);
    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      'session',
      'session',
      'main',
      'worktree',
    ]);
  });

  it('按 path 去重：会话目录与工作副本重复时只保留先出现的会话候选', () => {
    const candidates = buildRebindCandidates({
      repos,
      sessions,
      card: makeCard({ sessionIds: ['s-other'] }),
      t,
    });
    const otherMain = candidates.filter((candidate) => candidate.path === '/repos/other');
    expect(otherMain).toHaveLength(1);
    expect(otherMain[0]?.kind).toBe('session');
  });

  it('排除 prunable 的工作副本', () => {
    const candidates = buildRebindCandidates({
      repos,
      sessions,
      card: makeCard({ sessionIds: [] }),
      t,
    });
    expect(candidates.some((candidate) => candidate.path === '/repos/kanban/.worktrees/gone')).toBe(false);
  });

  it('跳过空目录、未知会话与没有 cwd 的会话', () => {
    const candidates = buildRebindCandidates({
      repos: [
        makeRepo('kanban', [
          makeWorktree('   ', { isMain: true }),
          makeWorktree('/repos/kanban-worktree', { branch: 'feat/x' }),
        ]),
      ],
      sessions: [
        makeSession('s-empty', { cwd: '   ' }),
        makeSession('s-no-cwd'),
        makeSession('s-unknown-dir', { cwd: '/elsewhere' }),
      ],
      card: makeCard({ sessionIds: ['s-missing', 's-empty', 's-no-cwd', 's-unknown-dir'] }),
      t,
    });
    expect(candidates.map((candidate) => candidate.path)).toEqual(['/elsewhere', '/repos/kanban-worktree']);
    expect(candidates[0]?.kind).toBe('session');
  });

  it('isCurrent 标记卡片当前 cwd，其余候选为 false；卡片无 cwd 时全部为 false', () => {
    const withCwd = buildRebindCandidates({
      repos,
      sessions,
      card: makeCard({ cwd: '/repos/kanban', sessionIds: ['s-a'] }),
      t,
    });
    const current = withCwd.filter((candidate) => candidate.isCurrent);
    expect(current.map((candidate) => candidate.path)).toEqual(['/repos/kanban']);

    const withoutCwd = buildRebindCandidates({
      repos,
      sessions,
      card: makeCard({ sessionIds: [] }),
      t,
    });
    expect(withoutCwd.every((candidate) => candidate.isCurrent === false)).toBe(true);
  });

  it('label / detail：会话、主副本、linked worktree、游离 HEAD 各自本地化', () => {
    const candidates = buildRebindCandidates({
      repos: [
        makeRepo('kanban', [
          makeWorktree('/repos/kanban', { branch: 'main', isMain: true }),
          makeWorktree('/repos/kanban/.worktrees/feat-a', { branch: 'feat/a' }),
          makeWorktree('/repos/kanban/.worktrees/detached', { branch: null, detached: true }),
        ]),
      ],
      sessions: [makeSession('s-a', { title: '会话 A', cwd: '/repos/kanban/.worktrees/feat-a' })],
      card: makeCard({ sessionIds: ['s-a'] }),
      t,
    });
    const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
    expect(byPath.get('/repos/kanban/.worktrees/feat-a')).toMatchObject({
      kind: 'session',
      label: '绑定会话：会话 A',
      detail: '会话执行目录 · /repos/kanban/.worktrees/feat-a',
    });
    expect(byPath.get('/repos/kanban')).toMatchObject({ kind: 'main', label: '主工作副本 · kanban', detail: 'main' });
    expect(byPath.get('/repos/kanban/.worktrees/detached')).toMatchObject({
      kind: 'worktree',
      label: '游离 HEAD',
      detail: 'kanban',
    });
  });

  it('会话标题为空时用会话 id 兜底', () => {
    const candidates = buildRebindCandidates({
      repos: [],
      sessions: [makeSession('s-empty-title', { title: '', cwd: '/tmp/dir' })],
      card: makeCard({ sessionIds: ['s-empty-title'] }),
      t,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.label).toBe('绑定会话：s-empty-title');
  });

  it('没有仓库也没有会话时返回空数组', () => {
    expect(buildRebindCandidates({ repos: [], sessions: [], card: makeCard(), t })).toEqual([]);
  });
});

describe('cardCwdState', () => {
  it('没有 cwd / 空串 / 只有空白都算 missing', () => {
    expect(cardCwdState({ cwd: undefined }, [])).toBe('missing');
    expect(cardCwdState({ cwd: '' }, [])).toBe('missing');
    expect(cardCwdState({ cwd: '   ' }, [])).toBe('missing');
  });

  it('cwd 被探测为 missing 时算 invalid', () => {
    const unavailable: GitWorkspaceUnavailable[] = [
      { dir: '/repos/gone', reason: 'missing' },
      { dir: '/repos/not-git', reason: 'not_git' },
    ];
    expect(cardCwdState({ cwd: '/repos/gone' }, unavailable)).toBe('invalid');
    // 首尾空白不影响匹配
    expect(cardCwdState({ cwd: '  /repos/gone  ' }, unavailable)).toBe('invalid');
  });

  it('其它不可用原因、无关目录、没有记录都算 ok', () => {
    const unavailable: GitWorkspaceUnavailable[] = [
      { dir: '/repos/not-git', reason: 'not_git' },
      { dir: '/repos/other', reason: 'timeout' },
    ];
    expect(cardCwdState({ cwd: '/repos/not-git' }, unavailable)).toBe('ok');
    expect(cardCwdState({ cwd: '/repos/other' }, unavailable)).toBe('ok');
    expect(cardCwdState({ cwd: '/repos/fine' }, unavailable)).toBe('ok');
    expect(cardCwdState({ cwd: '/repos/fine' }, [])).toBe('ok');
  });
});

describe('formatRebindComment', () => {
  it('有旧目录：moved 文案带旧目录与新目录', () => {
    expect(formatRebindComment(t, '/old/dir', '/new/dir')).toBe('重新绑定工作目录：/old/dir → /new/dir');
  });

  it('没有旧目录（undefined / 空串）：set 文案只带新目录', () => {
    expect(formatRebindComment(t, undefined, '/new/dir')).toBe('重新绑定工作目录：/new/dir');
    expect(formatRebindComment(t, '', '/new/dir')).toBe('重新绑定工作目录：/new/dir');
    expect(formatRebindComment(t, '   ', '/new/dir')).toBe('重新绑定工作目录：/new/dir');
  });
});
