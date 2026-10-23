import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import {
  buildNativeInbox,
  buildQuestionAnswers,
  classifyNativeRisk,
  derivePlanReview,
  draftComplete,
  formatCountdown,
  nativeAnswerable,
  nativeSessionLabel,
  resolveNativeText,
  summarizePlan,
} from './nativeInbox';
import type {
  NativePendingApproval,
  NativePendingItem,
  NativePendingQuestion,
  NativeQuestion,
} from './nativeInbox';

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    boardId: 'board-default',
    title: '审批收件箱合并',
    summary: '',
    status: 'running',
    priority: 'medium',
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
  };
}

function approval(overrides: Partial<NativePendingApproval> = {}): NativePendingApproval {
  return {
    kind: 'approval',
    sessionId: 'session-019dcc39-70f2-4250-be4b-4050261d5596',
    key: 'approval:1',
    toolName: 'bash',
    reason: 'escalate sandbox to workspace-write: 需要写入工作区外的配置',
    answerable: true,
    observedAt: 10,
    ...overrides,
  };
}

function question(overrides: Partial<NativeQuestion> = {}): NativeQuestion {
  return {
    id: 'q1',
    question: '默认看板采用哪个名称？',
    options: [{ label: 'DSH 看板' }, { label: '任务看板' }],
    ...overrides,
  };
}

function pendingQuestion(overrides: Partial<NativePendingQuestion> = {}): NativePendingQuestion {
  return {
    kind: 'question',
    sessionId: 'session-019dcc39-70f2-4250-be4b-4050261d5596',
    key: 'question:session-019dcc39-70f2-4250-be4b-4050261d5596:call-1',
    questions: [question()],
    state: 'open',
    channel: 'waterfall',
    dismissal: 'hide',
    observedAt: 20,
    ...overrides,
  };
}

describe('resolveNativeText', () => {
  it('字符串原样返回并裁剪空白', () => {
    expect(resolveNativeText('  允许一次  ', 'zh')).toBe('允许一次');
  });

  it('多语言对象优先当前语言，其次 zh / en，最后任一语言', () => {
    expect(resolveNativeText({ en: 'Allow once', zh: '允许一次' }, 'zh')).toBe('允许一次');
    expect(resolveNativeText({ en: 'Allow once', zh: '允许一次' }, 'en')).toBe('Allow once');
    expect(resolveNativeText({ fr: 'Autoriser' }, 'zh')).toBe('Autoriser');
  });

  it('缺失/空白返回空串', () => {
    expect(resolveNativeText(undefined, 'zh')).toBe('');
    expect(resolveNativeText({ zh: '   ' }, 'zh')).toBe('');
  });
});

describe('classifyNativeRisk', () => {
  it('理由点名 danger-full-access → 高风险', () => {
    const item = approval({ reason: 'escalate sandbox to danger-full-access: 需要写系统目录' });
    expect(classifyNativeRisk(item)).toEqual({ level: 'high', basis: 'danger-full-access' });
  });

  it('displayReason 是对象时也参与判定', () => {
    const item = approval({
      reason: undefined,
      displayReason: { zh: '允许本次操作使用 danger-full-access 权限：安装依赖' },
    });
    expect(classifyNativeRisk(item).level).toBe('high');
  });

  it('workspace-write → 中风险', () => {
    expect(classifyNativeRisk(approval())).toEqual({ level: 'medium', basis: 'workspace-write' });
  });

  it('变更/执行类工具（无模式提示）→ 中风险', () => {
    const item = approval({ toolName: 'write', reason: '工具 write 请求越权执行' });
    expect(classifyNativeRisk(item)).toEqual({ level: 'medium', basis: 'mutating-tool' });
  });

  it('只读/未知工具 → 低风险', () => {
    const item = approval({ toolName: 'web_fetch', reason: '工具 web_fetch 需要确认' });
    expect(classifyNativeRisk(item)).toEqual({ level: 'low', basis: 'other-tool' });
  });

  it('Agent 提问 → 低风险（信息确认）', () => {
    expect(classifyNativeRisk(pendingQuestion())).toEqual({ level: 'low', basis: 'info' });
  });

  it('计划审批 → 中风险（批准后执行）', () => {
    expect(classifyNativeRisk(pendingQuestion({ kind: 'plan-review' }))).toEqual({
      level: 'medium',
      basis: 'plan',
    });
  });
});

describe('nativeSessionLabel / nativeAnswerable', () => {
  it('会话标题缺失时用 id 短码', () => {
    expect(nativeSessionLabel(approval({ sessionTitle: ' 审批收件箱 ' }))).toBe('审批收件箱');
    expect(nativeSessionLabel(approval({ sessionTitle: undefined }))).toBe('019dcc39');
  });

  it('提问通道为 none 时不可作答', () => {
    expect(nativeAnswerable(pendingQuestion({ channel: 'none' }))).toBe(false);
    expect(nativeAnswerable(pendingQuestion({ channel: 'rpc', state: 'continued' }))).toBe(true);
  });

  it('审批 answerable=false 时不可作答', () => {
    expect(nativeAnswerable(approval({ answerable: false }))).toBe(false);
  });
});

describe('derivePlanReview', () => {
  const plan = '# 把收件箱合并到看板\n\n第一步：客户端桥；第二步：收件区 UI。\n更多内容。';
  const planQuestion = question({
    id: 'q-plan',
    question: '是否按此计划执行？',
    options: [{ label: '同意执行' }, { label: '要求修改' }],
    intent: { kind: 'plan-review', approve: '同意执行' },
    detail: plan,
  });

  it('满足宿主条件时派生 approve/decline 与摘要', () => {
    const derived = derivePlanReview(pendingQuestion({ kind: 'plan-review', questions: [planQuestion] }));
    expect(derived).not.toBeNull();
    expect(derived?.approve.label).toBe('同意执行');
    expect(derived?.decline?.label).toBe('要求修改');
    expect(derived?.title.length).toBeGreaterThan(0);
    expect(derived?.summary).not.toContain('#');
  });

  it('kind 不是 plan-review 时返回 null', () => {
    expect(derivePlanReview(pendingQuestion({ kind: 'question', questions: [planQuestion] }))).toBeNull();
  });

  it('多选 / 超过两个选项 / 缺 detail / 缺 approve 时降级为 null', () => {
    expect(
      derivePlanReview(
        pendingQuestion({ kind: 'plan-review', questions: [{ ...planQuestion, multiSelect: true }] }),
      ),
    ).toBeNull();
    expect(
      derivePlanReview(
        pendingQuestion({
          kind: 'plan-review',
          questions: [{ ...planQuestion, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }],
        }),
      ),
    ).toBeNull();
    expect(
      derivePlanReview(
        pendingQuestion({ kind: 'plan-review', questions: [{ ...planQuestion, detail: undefined }] }),
      ),
    ).toBeNull();
    expect(
      derivePlanReview(
        pendingQuestion({
          kind: 'plan-review',
          questions: [{ ...planQuestion, intent: { kind: 'plan-review', approve: '不存在的选项' } }],
        }),
      ),
    ).toBeNull();
    expect(
      derivePlanReview(
        pendingQuestion({ kind: 'plan-review', questions: [planQuestion, planQuestion] }),
      ),
    ).toBeNull();
  });
});

describe('summarizePlan', () => {
  it('取首行为标题、过滤标题行后拼摘要', () => {
    const result = summarizePlan('# 计划标题\n\n- 步骤一\n- 步骤二');
    expect(result.title).toBe('计划标题');
    expect(result.summary).toBe('- 步骤一 - 步骤二');
  });

  it('空文本返回空', () => {
    expect(summarizePlan('   ')).toEqual({ title: '', summary: '' });
  });
});

describe('buildNativeInbox', () => {
  it('按风险 → 来源 → observedAt 排序，并派生标题', () => {
    const items: NativePendingItem[] = [
      pendingQuestion({ key: 'q', observedAt: 100 }),
      approval({ key: 'a-medium', observedAt: 200 }),
      approval({
        key: 'a-high',
        observedAt: 300,
        reason: 'escalate sandbox to danger-full-access: 安装系统依赖',
        displayReason: { zh: '允许本次操作使用 danger-full-access 权限：安装系统依赖' },
      }),
    ];
    const entries = buildNativeInbox(items, [], 'zh');
    expect(entries.map((entry) => entry.id)).toEqual(['a-high', 'a-medium', 'q']);
    expect(entries[0]?.riskLevel).toBe('high');
    expect(entries[0]?.title).toBe('允许本次操作使用 danger-full-access 权限：安装系统依赖');
    expect(entries[1]?.title).toContain('escalate sandbox');
    expect(entries[2]?.title).toBe('默认看板采用哪个名称？');
    expect(entries[2]?.questionCount).toBe(1);
  });

  it('同风险同来源按 observedAt / key 稳定排序', () => {
    const items: NativePendingItem[] = [
      approval({ key: 'b', observedAt: 20 }),
      approval({ key: 'a', observedAt: 20 }),
      approval({ key: 'c', observedAt: 10 }),
    ];
    expect(buildNativeInbox(items, [], 'zh').map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('关联同会话最近更新的未归档卡片', () => {
    const sessionId = 'session-019dcc39-70f2-4250-be4b-4050261d5596';
    const cards: Card[] = [
      card({ id: 'old', sessionIds: [sessionId], updatedAt: 10 }),
      card({ id: 'newest', sessionIds: [sessionId], updatedAt: 30 }),
      card({ id: 'archived', sessionIds: [sessionId], updatedAt: 99, archived: true }),
    ];
    const [entry] = buildNativeInbox([approval({ sessionId })], cards, 'zh');
    expect(entry?.card?.id).toBe('newest');
  });

  it('透传倒计时与计时常量', () => {
    const [entry] = buildNativeInbox(
      [
        pendingQuestion({
          countdown: { remainingMs: 64_000, running: true },
          state: 'open',
        }),
      ],
      [],
      'zh',
    );
    expect(entry?.countdownMs).toBe(64_000);
    expect(entry?.countdownRunning).toBe(true);
    expect(entry?.channel).toBe('waterfall');
  });

  it('计划审批派生 planReview 并用计划标题作 title', () => {
    const [entry] = buildNativeInbox(
      [
        pendingQuestion({
          kind: 'plan-review',
          questions: [
            question({
              id: 'q-plan',
              question: '是否按此计划执行？',
              options: [{ label: '同意执行' }, { label: '要求修改' }],
              intent: { kind: 'plan-review', approve: '同意执行' },
              detail: '# 把收件箱合并到看板\n\n先做客户端桥。',
            }),
          ],
        }),
      ],
      [],
      'zh',
    );
    expect(entry?.planReview?.approve.label).toBe('同意执行');
    expect(entry?.title).toBe('把收件箱合并到看板');
  });
});

describe('buildQuestionAnswers', () => {
  const questions: NativeQuestion[] = [
    question({ id: 'q1', multiSelect: true }),
    question({ id: 'q2' }),
    question({ id: 'q3' }),
  ];

  it('跳过题输出空 selected；单选自定义清空 selected；多选自定义保留标签', () => {
    const answers = buildQuestionAnswers(questions, [
      { selected: ['A', 'B'], custom: '补充说明', skipped: false },
      { selected: ['仅选项'], custom: '', skipped: false },
      { selected: [], custom: '', skipped: true },
    ]);
    expect(answers).toEqual([
      { id: 'q1', selected: ['A', 'B'], custom: '补充说明' },
      { id: 'q2', selected: ['仅选项'] },
      { id: 'q3', selected: [] },
    ]);
  });

  it('缺失草稿按跳过处理', () => {
    expect(buildQuestionAnswers(questions.slice(0, 1), [])).toEqual([{ id: 'q1', selected: [] }]);
  });

  it('draftComplete 覆盖选择 / 自定义 / 跳过', () => {
    expect(draftComplete({ selected: ['A'], custom: '', skipped: false })).toBe(true);
    expect(draftComplete({ selected: [], custom: '嗯', skipped: false })).toBe(true);
    expect(draftComplete({ selected: [], custom: '', skipped: true })).toBe(true);
    expect(draftComplete({ selected: [], custom: '  ', skipped: false })).toBe(false);
  });
});

describe('formatCountdown', () => {
  it('格式化 mm:ss 与 h:mm:ss', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(64_000)).toBe('1:04');
    expect(formatCountdown(3_600_000 + 61_000)).toBe('1:01:01');
  });
});
