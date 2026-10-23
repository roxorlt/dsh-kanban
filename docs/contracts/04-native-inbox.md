# 原生待确认收件契约 v0.1（冻结）

看板「待你确认」列除了业务审批卡片，还要展示并作答 DSH 原生的人机交互请求：

| 来源 | 宿主载体 | 说明 |
| --- | --- | --- |
| 工具授权 | `PendingApproval`（ui-approval 注册到 `uiSession`） | 沙箱越权（`sandbox_permissions`）与工具 `ask` 决策；结果为 `allowed-once` / `rejected` |
| Agent 提问 | `PendingQuestion`（ui-user-questions 注册到 `uiSession`） | `ask_user_question`；多题、选项、自定义文本、跳过、计时 |
| 计划审批 | `PendingQuestion` 且 `questions[0].intent.kind === 'plan-review'` | `exit_plan_mode`；同意执行 / 要求修改 |

## 1. 数据来源（父页面）

父页面（`lib/client.js`）注入客户端服务 `uiSession`，订阅：

```js
const status = ctx.uiSession.sessionStatus;   // ObservableSnapshot<Map<sessionId, SessionStatus>>
status.getSnapshot();                          // Map<sessionId, {running, pendingInteraction, completionUnread}>
status.subscribe(() => pushPending());
```

`pendingInteraction` 是宿主公开投影：每个会话**只暴露当前优先级最高**的一项（审批 precedence 0、提问 1、计划审批 2）。因此：

- 每会话最多镜像一项，与宿主 composer 的接管语义一致；
- 同会话同时存在审批与提问时，只看得到提问（宿主行为，不是看板 bug）。

只镜像「仍可作答」的项：

- 审批：`kind === 'approval'`，`answerable === true`；
- 提问：`kind === 'question' | 'plan-review'`，`review === undefined`（排除已结算的只读记录）、`snapshot().closed !== true`。

## 2. 父页面 → iframe 推送 `kanban:pending`

```ts
type PendingPush = {
  type: 'kanban:pending';
  version: 1;
  /** 全量快照，不是增量；不支持时父页面不推送 */
  items: PendingItem[];
  at: number;
};
```

页面 `kanban:ready` 与面板 attach 时各推一次（允许为空数组 = 「宿主支持但没有待确认」）；`uiSession` 变化时自动重推。提问倒计时每秒变化，推送按 250ms 节流。

```ts
interface PendingBase {
  sessionId: string;
  /** 宿主稳定标识；作答时回传，用来定位 pending 对象 */
  key: string;
  /** 会话标题（父页面从 sessions.list 取；缺失时前端用短 id 兜底） */
  sessionTitle?: string;
  /** 会话是否运行中（可选，仅展示用） */
  sessionRunning?: boolean;
  /** 首次被看板观测到的时间（毫秒），用于稳定排序 */
  observedAt: number;
}

interface PendingApproval extends PendingBase {
  kind: 'approval';
  toolName: string;
  callId?: string;
  /** 原始原因，如 `escalate sandbox to workspace-write: 需要写入网络配置` */
  reason?: string;
  /** 宿主本地化展示文案：字符串或 { en, zh, ... }；原样透传 */
  displayReason?: string | Record<string, string>;
}

interface PendingQuestion extends PendingBase {
  kind: 'question' | 'plan-review';
  callId?: string;
  questions: Question[];
  /** 'open' = 前台等待；'continued' = 计时已过、agent 已继续，仍可回答（作答按 steer 送达） */
  state: 'open' | 'continued';
  /** 'waterfall' = 等待中的请求；'rpc' = continued 后的回答通道；'none' = 暂未就绪，禁止提交 */
  channel: 'waterfall' | 'rpc' | 'none';
  /** 计时提问的倒计时（仅 timed 请求） */
  countdown?: { remainingMs: number; running: boolean };
  /** hide = 关闭面板；cancel = 关闭即取消请求（宿主未命名调用） */
  dismissal: 'hide' | 'cancel';
}

interface Question {
  id: string;
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  /** 仅 plan-review：{ kind: 'plan-review', approve: string, callId?: string } */
  intent?: { kind: 'plan-review'; approve: string; callId?: string };
  /** 仅 plan-review：待审计划正文（Markdown 原文） */
  detail?: string;
}

type PendingItem = PendingApproval | PendingQuestion;
```

父页面不计算风险等级、不格式化文案、不裁剪计划正文——这些都属于 Web 侧纯函数（`web/src/lib/nativeInbox.ts`），便于单测。

## 3. iframe → 父页面：作答请求

沿用 `kanban:request` 通道（契约 03），新增三个 method（白名单）：

| method | params | data | 说明 |
| --- | --- | --- | --- |
| `pending.answerApproval` | `{ sessionId, key, outcome: 'allowed-once' \| 'rejected' }` | `{ ok: true }` | 找到同会话同 key 的 `PendingApproval` 后调用 `answer(outcome)`；宿主与原 composer 共用同一条结算与审计 |
| `pending.answerQuestion` | `{ sessionId, key, answers: QuestionAnswer[] }` | `{ ok: true }` | 找到 `PendingQuestion` 后调用 `answer({ answers })`；水系与 RPC 两条通道由宿主 pending 对象自行选择 |
| `pending.dismiss` | `{ sessionId, key }` | `{ ok: true }` | 计划审批「要求修改」与「未命名提问取消」调用 `dismiss()`，语义与原生面板一致 |

```ts
interface QuestionAnswer {
  id: string;
  /** 选项标签；空数组 + 无 custom = 跳过该题 */
  selected: string[];
  /** 自定义文本；单选自定义时 selected 为空数组 */
  custom?: string;
}
```

校验（父页面）：`sessionId`/`key` 非空字符串；`outcome` 在枚举内；`answers` 长度 1–20；每题 `id` 非空、`selected` 为字符串数组（≤8 项、单项 ≤200 字符）、`custom` ≤2000 字符。

### 3.1 错误码

| code | 触发 |
| --- | --- |
| `BAD_REQUEST` | 参数校验失败 |
| `PENDING_NOT_FOUND` | 快照里没有匹配的 pending（已被别处作答/撤回/页面重载） |
| `PENDING_UNANSWERABLE` | 项存在但当前不可作答（审批 `answerable=false`；提问 `channel='none'` 或已关闭） |
| `PENDING_ANSWER_FAILED` | 宿主 `answer()` / `dismiss()` 抛错（含请求在提交后被撤回） |

前端遇到 `PENDING_NOT_FOUND` / `PENDING_UNANSWERABLE` 时提示「已在别处处理」，收件项随下一次推送消失。

## 4. Web 侧派生规则

### 4.1 风险分级（三档 + 依据）

| 档位 | 依据键 | 规则 |
| --- | --- | --- |
| 高 `high` | `danger-full-access` | 审批的 `reason`/`displayReason` 包含 `danger-full-access` |
| 中 `medium` | `workspace-write` | 包含 `workspace-write` |
| 中 `medium` | `mutating-tool` | 工具名属于变更/执行类（`bash`、`pwsh`、`terminal`、`bash_persistent`、`write`、`edit`、`str_replace_editor`、`fs` 等） |
| 低 `low` | `other-tool` | 其余审批 |
| 低 `low` | `info` | Agent 提问（仅信息确认，不授予权限） |
| 中 `medium` | `plan` | 计划审批（同意后按计划进入执行） |

chip 的 `title` 显示对应中文依据（如「申请放宽到 danger-full-access」）。规则只用于分档与提示，**不改变**宿主任何判定。

### 4.2 申请原因文案

`displayReason` 为对象时按界面语言取 `zh`/`en`，其次 `zh`、`en`、`Object.values()[0]`；为字符串时直接用；缺失时回退 `reason`；再缺失显示「（宿主未提供原因）」。

### 4.3 会话与卡片关联

- 会话标题：`sessionTitle`，缺失回落 `session-xxxxxxx`（取 id 末 8 位）；
- 关联卡片：卡片 `sessionIds` 包含该 `sessionId` 的第一张（按 `updatedAt` 降序）；命中则显示卡片标题并可打开详情；
- 排序：风险档（高→中→低）→ 来源（审批 → 计划 → 提问）→ `observedAt` 升序 → `key` 升序。

### 4.4 计划审批解析

`kind === 'plan-review'` 时按宿主同一条件派生（不满足则降级为普通提问）：

1. `questions.length === 1`；
2. `questions[0].intent.kind === 'plan-review'` 且 `detail !== undefined`；
3. `multiSelect !== true`，选项 ≤ 2；
4. 选项里存在 `label === intent.approve` 的「同意」项。

派生出 `{ id, question, plan, approve: Option, decline?: Option }`；同意 = `answerQuestion` 提交 `[{ id, selected: [approve.label] }]`，要求修改 = `pending.dismiss`。

## 5. 降级与兼容

- 旧版 DSH 没有 `uiSession` 服务：父页面不注入、不推送；iframe 保持 `pendingSupport=false`，收件区不渲染。
- 收到过 `kanban:pending`（哪怕空数组）即 `pendingSupport=true`。
- 独立预览（无父页面）：不渲染收件区，现有业务审批卡片行为不变。
- 父页面是唯一写入口；Web 不直接触碰宿主对象。

## 6. 安全

- 消息仍只接受同源且 `event.source === iframe.contentWindow`；method 白名单。
- 作答只经宿主 pending 对象的 `answer()/dismiss()`，不新增审计路径，不伪造结果。
- `key` 只在本次页面生命周期内有效，不落盘、不跨会话复用。
- 不传输 token、凭据、会话全文；计划正文只传 `detail`（宿主本来就展示给用户的内容）。

## 7. 已知限制（v1）

1. 每会话只镜像宿主投影里的**最高优先级**一项；审批与提问同会话并存时审批不可见（与原生 composer 一致）。
2. 提问草稿不跨端同步：原生 composer 的草稿在 DSH 本地存储，看板表单草稿只存在于看板内存。
3. 计时暂停（聚焦暂停倒计时）是宿主 composer 行为，看板作答视为立即编辑（不冻结倒计时）。
4. 未命名提问（无 `callId`）在看板作答即视为完成；「取消请求」不提供入口（需要时去原生面板）。
5. 原生审批的持久策略（always allow）不在看板提供，仅 `允许一次/拒绝`。
6. 已结算项不写回卡片时间线（避免与宿主审计重复）。

## 8. 验收对照

- A1/A2/A3/A5/A6 → 推送与审批项 + 看板按钮；
- A4 → 订阅 `uiSession` 单向同步；
- A7 → 4.1 风险表 + 单测；
- A8 → 本契约 + `lib/client.js` 集成测试；
- A11–A15 → 提问/计划项、多题表单、计时与通道约束。
