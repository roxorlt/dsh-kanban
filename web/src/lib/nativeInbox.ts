/**
 * 原生待确认收件：把 DSH 宿主推送的 pending 项（工具授权 / Agent 提问 / 计划审批）
 * 派生为可渲染的收件项。
 *
 * 数据来源与字段见 docs/contracts/04-native-inbox.md；这里只做纯函数，
 * 不碰 postMessage、不碰 React，便于单测。
 */
import type { Card } from '../types';

export type NativeLang = 'zh' | 'en';

export type NativeRiskLevel = 'high' | 'medium' | 'low';

/** 风险判定依据（组件层用 i18n 映射成文案）。 */
export type NativeRiskBasis =
  | 'danger-full-access'
  | 'workspace-write'
  | 'mutating-tool'
  | 'other-tool'
  | 'info'
  | 'plan';

/** 三项来源区分：工具授权 / Agent 提问 / 计划审批。 */
export type NativeSource = 'approval' | 'question' | 'plan-review';

/** 宿主 displayReason 的多语言对象（{ en, zh, ... }）。 */
export type NativeDisplayReason = Record<string, string>;

export interface NativeQuestionOption {
  label: string;
  description?: string;
}

export interface NativeQuestion {
  id: string;
  question: string;
  header?: string;
  options?: NativeQuestionOption[];
  multiSelect?: boolean;
  /** 仅 plan-review：{ kind: 'plan-review', approve: 同意选项 label, callId? } */
  intent?: { kind: string; approve?: string; callId?: string };
  /** 仅 plan-review：待审计划正文 */
  detail?: string;
}

export interface NativePendingBase {
  sessionId: string;
  key: string;
  sessionTitle?: string;
  sessionRunning?: boolean;
  observedAt?: number;
}

export interface NativePendingApproval extends NativePendingBase {
  kind: 'approval';
  toolName: string;
  callId?: string;
  reason?: string;
  displayReason?: string | NativeDisplayReason;
  answerable?: boolean;
}

export interface NativePendingQuestion extends NativePendingBase {
  kind: 'question' | 'plan-review';
  callId?: string;
  questions: NativeQuestion[];
  state?: 'open' | 'continued';
  channel?: 'waterfall' | 'rpc' | 'none';
  countdown?: { remainingMs: number; running?: boolean };
  dismissal?: 'hide' | 'cancel';
}

export type NativePendingItem = NativePendingApproval | NativePendingQuestion;

export interface NativeQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

/** 计划审批的派生视图（与宿主 planReviewOf 的条件一致）。 */
export interface NativePlanReview {
  id: string;
  question: string;
  plan: string;
  approve: NativeQuestionOption;
  decline?: NativeQuestionOption;
  title: string;
  summary: string;
}

/** 收件区一条可渲染项。 */
export interface NativeInboxEntry {
  /** 等于宿主 pending key */
  id: string;
  kind: NativePendingItem['kind'];
  source: NativeSource;
  riskLevel: NativeRiskLevel;
  riskBasis: NativeRiskBasis;
  /** 审批=申请原因；提问=第一题；计划审批=计划标题 */
  title: string;
  sessionId: string;
  /** 会话标题；缺失时为会话 id 短码 */
  sessionLabel: string;
  sessionRunning: boolean;
  answerable: boolean;
  observedAt: number;
  toolName?: string;
  callId?: string;
  questionCount?: number;
  countdownMs?: number;
  countdownRunning?: boolean;
  state?: 'open' | 'continued';
  channel?: 'waterfall' | 'rpc' | 'none';
  questions?: NativeQuestion[];
  planReview?: NativePlanReview;
  /** 绑定该会话的最近一张未归档卡片 */
  card?: Card;
  item: NativePendingItem;
}

/** 变更 / 执行类工具：即使宿主没写升级模式，也至少按中风险呈现。 */
const MUTATING_TOOLS = new Set([
  'bash',
  'bash_persistent',
  'pwsh',
  'pwsh_persistent',
  'terminal',
  'write',
  'edit',
  'multiedit',
  'str_replace_editor',
  'apply_patch',
  'fs',
  'fs_write',
  'notebook_edit',
]);

const RISK_RANK: Record<NativeRiskLevel, number> = { high: 0, medium: 1, low: 2 };
const SOURCE_RANK: Record<NativePendingItem['kind'], number> = {
  approval: 0,
  'plan-review': 1,
  question: 2,
};
export const NATIVE_SOURCE_RANK = SOURCE_RANK;

function displayReasonStrings(value: string | NativeDisplayReason | undefined): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/**
 * 取宿主本地化展示文案：优先当前界面语言，其次 zh / en，最后任一语言。
 * 返回空串表示宿主没给可用文案。
 */
export function resolveNativeText(
  value: string | NativeDisplayReason | undefined,
  lang: NativeLang,
): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const preferred = [lang, 'zh', 'en'];
  for (const key of preferred) {
    const text = value[key];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  for (const text of Object.values(value)) {
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

/**
 * 风险三档：先看宿主给的理由里是否点名了沙箱模式，再看工具类型；
 * 提问只做信息确认、计划审批按中风险（批准后会进入执行）。
 */
export function classifyNativeRisk(item: NativePendingItem): {
  level: NativeRiskLevel;
  basis: NativeRiskBasis;
} {
  if (item.kind !== 'approval') {
    return item.kind === 'plan-review'
      ? { level: 'medium', basis: 'plan' }
      : { level: 'low', basis: 'info' };
  }
  const haystack = [item.reason ?? '', ...displayReasonStrings(item.displayReason)]
    .join(' ')
    .toLowerCase();
  if (haystack.includes('danger-full-access')) return { level: 'high', basis: 'danger-full-access' };
  if (haystack.includes('workspace-write')) return { level: 'medium', basis: 'workspace-write' };
  const tool = item.toolName.trim().toLowerCase();
  if (MUTATING_TOOLS.has(tool)) return { level: 'medium', basis: 'mutating-tool' };
  return { level: 'low', basis: 'other-tool' };
}

/** 会话标题兜底：没有标题时用 id 短码（去掉 session- 前缀）。 */
export function nativeSessionLabel(item: NativePendingItem): string {
  const title = item.sessionTitle?.trim();
  if (title) return title;
  const raw = item.sessionId.trim();
  const stripped = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
  return stripped.slice(0, 8) || raw.slice(0, 8) || '—';
}

/** 计划正文摘要：标题取首行（去掉 Markdown 标题符号），摘要取后续内容首段。 */
export function summarizePlan(plan: string): { title: string; summary: string } {
  const lines = plan
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const first = lines[0] ?? '';
  const title = first.replace(/^#{1,6}\s*/, '').slice(0, 120);
  const rest = lines
    .slice(1)
    .filter((line) => !line.startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: title || rest.slice(0, 60) || '', summary: rest.slice(0, 200) };
}

/**
 * 计划审批派生（与宿主 ui-user-questions 的 planReviewOf 条件保持一致）：
 * 单题、intent.kind==='plan-review'、有 detail、非多选、选项 ≤2 且有 approve 项。
 */
export function derivePlanReview(item: NativePendingItem): NativePlanReview | null {
  if (item.kind !== 'plan-review') return null;
  const questions = item.questions ?? [];
  if (questions.length !== 1) return null;
  const question = questions[0];
  if (!question) return null;
  const intent = question.intent;
  if (!intent || intent.kind !== 'plan-review') return null;
  if (typeof question.detail !== 'string' || question.detail.trim() === '') return null;
  if (question.multiSelect === true) return null;
  const options = question.options ?? [];
  if (options.length > 2) return null;
  const approveLabel = typeof intent.approve === 'string' ? intent.approve : '';
  const approve = options.find((option) => option.label === approveLabel);
  if (!approve) return null;
  const decline = options.find((option) => option.label !== approveLabel);
  const { title, summary } = summarizePlan(question.detail);
  return {
    id: question.id,
    question: question.question,
    plan: question.detail,
    approve,
    ...(decline ? { decline } : {}),
    title,
    summary,
  };
}

/** 是否还能作答：提问需要通道就绪；审批由父页面过滤，缺省按可作答处理。 */
export function nativeAnswerable(item: NativePendingItem): boolean {
  if (item.kind === 'approval') return item.answerable !== false;
  const channel = item.channel ?? 'none';
  return channel !== 'none';
}

/** 会话 ↔ 卡片关联：同会话的未归档卡片里取最近更新的一张。 */
export function linkedCardOf(cards: Card[], sessionId: string): Card | undefined {
  let match: Card | undefined;
  for (const card of cards) {
    if (card.archived) continue;
    if (!card.sessionIds?.includes(sessionId)) continue;
    if (!match || card.updatedAt > match.updatedAt) match = card;
  }
  return match;
}

function buildEntry(item: NativePendingItem, cards: Card[], lang: NativeLang): NativeInboxEntry {
  const risk = classifyNativeRisk(item);
  const planReview = derivePlanReview(item) ?? undefined;
  const common = {
    id: item.key,
    kind: item.kind,
    source: item.kind,
    riskLevel: risk.level,
    riskBasis: risk.basis,
    sessionId: item.sessionId,
    sessionLabel: nativeSessionLabel(item),
    sessionRunning: Boolean(item.sessionRunning),
    answerable: nativeAnswerable(item),
    observedAt: item.observedAt ?? 0,
    card: linkedCardOf(cards, item.sessionId),
    item,
  };
  if (item.kind === 'approval') {
    const reason = resolveNativeText(item.displayReason, lang) || (item.reason ?? '').trim();
    return {
      ...common,
      title: reason,
      toolName: item.toolName,
      ...(item.callId ? { callId: item.callId } : {}),
    };
  }
  const questions = item.questions ?? [];
  const first = questions[0];
  const title = planReview
    ? planReview.title
    : first
      ? first.header
        ? `${first.header}：${first.question}`
        : first.question
      : '';
  return {
    ...common,
    title: title.trim(),
    ...(item.callId ? { callId: item.callId } : {}),
    questionCount: questions.length,
    questions,
    ...(planReview ? { planReview } : {}),
    ...(item.countdown ? { countdownMs: Math.max(0, item.countdown.remainingMs) } : {}),
    ...(item.countdown?.running !== undefined ? { countdownRunning: item.countdown.running } : {}),
    ...(item.state ? { state: item.state } : {}),
    ...(item.channel ? { channel: item.channel } : {}),
  };
}

function compareEntries(a: NativeInboxEntry, b: NativeInboxEntry): number {
  const risk = RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel];
  if (risk !== 0) return risk;
  const source = SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind];
  if (source !== 0) return source;
  if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 把宿主推送的 pending 项派生为排序稳定的收件项列表。 */
export function buildNativeInbox(
  items: readonly NativePendingItem[],
  cards: readonly Card[],
  lang: NativeLang,
): NativeInboxEntry[] {
  return items
    .map((item) => buildEntry(item, cards as Card[], lang))
    .sort(compareEntries);
}

/** 倒计时展示：mm:ss（超过 1 小时用 h:mm:ss）。 */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/**
 * 把表单草稿组装成宿主答案批次：
 * 跳过 = { id, selected: [] }；单选自定义 = selected 空 + custom；
 * 多选自定义 = selected 标签 + custom。
 */
export function buildQuestionAnswers(
  questions: readonly NativeQuestion[],
  drafts: readonly { selected: string[]; custom: string; skipped: boolean }[],
): NativeQuestionAnswer[] {
  return questions.map((question, index) => {
    const draft = drafts[index] ?? { selected: [], custom: '', skipped: false };
    if (draft.skipped) return { id: question.id, selected: [] };
    const custom = draft.custom.trim();
    if (custom === '') return { id: question.id, selected: [...draft.selected] };
    if (question.multiSelect === true) {
      return { id: question.id, selected: [...draft.selected], custom };
    }
    return { id: question.id, selected: [], custom };
  });
}

/** 每题是否「已作答或显式跳过」。 */
export function draftComplete(draft: { selected: string[]; custom: string; skipped: boolean }): boolean {
  return draft.skipped || draft.selected.length > 0 || draft.custom.trim() !== '';
}
