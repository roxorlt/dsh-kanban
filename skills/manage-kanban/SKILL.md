---
name: manage-kanban
description: Use when 需要把多步任务放上 DSH 看板、查看/继续看板上的任务、向用户请求审批或标记任务完成时。触发词：看板、卡片、kanban、任务进展、请求审批、完成卡片、接着做看板任务。
---

# manage-kanban — 用 DSH 看板管理工作流

看板是**任务控制面**，DSH 会话是**执行面**。用户在看板里看卡片摘要、时间线、审批和结果；你在会话里执行，并通过 `kanban_*` 工具把状态回写到卡片。卡片本身不执行任何东西。

## 何时用

- 任务需要多步执行、跨多轮对话，或产出需要用户验收 → 建卡。
- 用户说「看看看板」「接着做 XXX」「有哪些要确认的」→ 先查询。
- 让用户做一个会阻塞你的决定（上线/删数据/方案选择）→ 请求审批，而不是在对话里干等。
- 一个阶段的活干完、需要给用户交代结果 → 完成卡片。

一次性问答、小于 2 分钟且无需回看的小改动，不必建卡。

## 标准工作流

1. **找卡**：`kanban_boards` 看板列表与各列计数；`kanban_cards` 按 `status`/`project`/`label`/`q`/`sessionId` 找目标卡；`kanban_card` 读完整详情（时间线、checklist、pending approval）。
2. **领取（claim）**：没有单独的 claim 工具。把卡片移到 `running`（`kanban_move_card`），并用 `kanban_link_session` 绑定当前会话，让用户「打开会话」时回到这里。
   - 你**自己新建**的卡片不用再手动绑：建卡默认就自动绑定你当前的会话，并补全 `cwd` / `workspaceId`（见下节「建卡自动绑定会话/工作区」）。
3. **执行并更新进展**：
   - `kanban_update_card` 更新 `currentAction`（一两句话，写正在做什么）、`progress`（`{step,total,text}`）、`checklists`（勾选子步骤）。
   - 里程碑、错误、关键决定用 `kanban_add_activity` 写一条时间线；**不要每一步工具调用都写**，只写用户值得看的节点。
   - 状态语义：`running` 进行中、`blocked` 受阻（需要人看）、`failed` 失败、`canceled` 已取消。
   - 会话运行失败同步（v0.11）：卡片主会话某一轮运行失败时，服务端自动把 `running` 卡置为 `failed` 并写 `error` 节点（含轮次/原因/错误码）；同一会话下一轮正常完成后自动回 `running`，失败记录保留。看到这类节点先判断是否重试/收尾，不要当成人工结论。
4. **需要用户决策**：`kanban_request_approval`，提供 1–4 个选项；卡片会自动进入「待你确认」列。**发完就停**，等用户在看板里选择，不要在同一轮里假装已获批准继续执行。
5. **完成**：`kanban_complete_card`，`result` 写清交付物、位置、验收方式。已完成卡片不复用；有后续工作就新建卡片。
6. **收尾**：如果用户要求讨论/答复，用 `kanban_update_card` 或 `kanban_add_activity` 把结论留在卡片上，让时间线自洽。

## 工具速查

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `kanban_boards` | 列看板与四列计数 | – |
| `kanban_cards` | 查卡片摘要列表 | `boardId` `status` `project` `label` `q` `sessionId` `limit` |
| `kanban_card` | 单卡详情 + 最近时间线 | `cardId` `activityLimit` |
| `kanban_decisions` | 只读查询决策日志（审批原始事件流） | `cardId` `boardId` `type` `state` `limit` `before` `since` `until` |
| `kanban_create_card` | 建卡（默认自动绑定当前会话/目录） | `title`(必填) `summary` `status` `priority` `labels` `project` `sessionMode`(默认 `reuse`；拆到新会话用 `new`，不需要会话用 `none`) `workspaceId` `cwd` `sessionId` |
| `kanban_update_card` | 更新字段 | `cardId` + 任意字段（`currentAction` `progress` `checklists` `status` `result`…） |
| `kanban_move_card` | 换列/换状态 + 原因 | `cardId` `column` 或 `status` `text` |
| `kanban_add_activity` | 追加时间线节点 | `cardId` `text` `type` `data` `metadata` |
| `kanban_request_approval` | 请求审批（→待你确认） | 单题：`title` `detail` `options`(1–8) `multiSelect`；多题：`questions`(1–6 题，每题独立单选/多选) |
| `kanban_link_session` | 绑定当前会话 | `cardId` `sessionId` `title` |
| `kanban_complete_card` | 完成并写结果 | `cardId` `result` |

回顾历史决定、等待时长（`waitedMs`）或某张卡经历过的审批时，用 `kanban_decisions` 只读查询决策日志——原始审批事件流存在 `dataDir/decisions.jsonl`（默认 `~/.dsh-kanban/decisions.jsonl`），包含仍在等待、已提交、未提交就关闭的条目；它只读，不写数据，也不替你或用户做决定。

## 建卡自动绑定会话/工作区（v0.20.1）

建卡时服务端会从**你的工具上下文**直接读出当前会话 id、执行目录 `cwd` 和所属工作区，自动补到卡片上——**不要手写 `sessionId`/`cwd`/`workspaceId`**，除非你要偏离默认值。`sessionMode` 控制绑定方式：

| `sessionMode` | 行为 | 什么时候用 |
| --- | --- | --- |
| `reuse`（默认） | 绑定**你当前这个会话**，并补全 `cwd`/`workspaceId`；同一会话能继续做这个子任务时就用它 | 大多数建卡场景；拆出的子任务仍由你继续推进 |
| `new` | 在工作区/目录上**真实新建一个 DSH 会话**并绑定（会话标题=卡片标题），返回 `binding.sessionId` 就是新会话的 id | 子任务需要独立上下文、要并行跑、或属于另一个项目/目录 |
| `none` | 不绑会话（仍尽量补全 `cwd`/`workspaceId`） | 只做备忘/想法、暂时不会执行的卡片 |

`new` 的目录怎么找：显式传 `workspaceId` 或 `cwd` 最高优先；都不传就继承你当前会话的位置。能匹配到工作区时会话会挂到该工作区（会话 cwd=工作区根目录，卡片 `cwd` 保留你传的子目录）；只给目录没有工作区时会话按该目录创建。

- 显式传 `sessionId` 时以它为准（不再按 `sessionMode` 自动绑）。
- 用户手动绑定的值优先：**不要**用建卡自动值覆盖用户已经改过的绑定/目录；发现数据明显不对（目录不存在、会话与任务明显不符）时提示用户确认，不要静默使用。
- 返回 JSON 里看 `binding`（实际绑了什么、`created` 表示是否新建会话）和 `warnings`（例如宿主不支持自动新建会话、目录与复用会话不一致）——有 warning 要处理或告诉用户。
- 老卡片没绑会话时，用户可以在卡片详情里用「补绑推荐」一键绑定；agent 侧也可以 `kanban_link_session` 补绑。

## 调用示例

```json
{ "title": "实现看板 SSE 实时刷新", "summary": "卡片状态变化 150ms 内同步到 UI", "project": "dsh-kanban", "priority": "high", "labels": ["server"] }
```
```json
{ "title": "rQuant L2：补系统通知识别测试", "summary": "独立项目的子任务，需要自己的会话", "project": "rQuant L2", "sessionMode": "new", "cwd": "/path/to/rquant-l2" }
```
```json
{ "cardId": "card-1a2b3c4d", "column": "running", "text": "开始实现" }
```
```json
{ "cardId": "card-1a2b3c4d", "currentAction": "正在补 routes 的 SSE 测试", "progress": { "step": 2, "total": 4 } }
```
```json
{ "cardId": "card-1a2b3c4d", "text": "SSE 广播与断线清理已通过测试", "type": "progress" }
```
```json
{ "cardId": "card-1a2b3c4d", "title": "是否把迁移脚本跑到生产？", "detail": "会锁表约 30 秒，影响写入。", "options": [{ "label": "执行", "tone": "primary" }, { "id": "no", "label": "先不执行", "tone": "danger" }] }
```
```json
{ "cardId": "card-1a2b3c4d", "title": "发布前要带哪些检查？", "multiSelect": true, "options": [{ "label": "单元测试" }, { "label": "构建" }, { "label": "真实设备" }, { "label": "文档" }] }
```
```json
{ "cardId": "card-1a2b3c4d", "questions": [
  { "header": "发布窗口", "question": "选择本次发布窗口", "options": ["今天 22:00", { "id": "hold", "label": "暂缓", "tone": "danger" }] },
  { "header": "发布检查", "question": "本次要带哪些检查？", "multiSelect": true, "options": ["单元测试", "构建", "真实设备", "文档"] }
] }
```
```json
{ "cardId": "card-1a2b3c4d", "result": "routes.js 已实现全部 REST + SSE；npm test 30/30 通过；冒烟命令见报告。" }
```

## 审批红线（必须遵守）

- **不要替用户做审批决定**，也不要自行把 `needs_you` 的卡片改回 `running`；只有用户在看板里选择后（时间线出现 `approval_resolved`）才继续。
- **提交即改列（v0.9.5）**：用户提交审批后卡片会自动离开「待你确认」——选项声明了 `outcome` 就进该列，否则批准回 `running`、驳回回 `backlog`。所以看到 `approval_resolved` 后**不要再用 `kanban_move_card` 补移列**；`blocked`/`failed` 卡不会自动变，仍由你按结论改回 `running` 或 `done`。
- 请求审批时用 `outcome` 声明去向：确认收尾/完成用 `{ "label": "确认完成", "outcome": "done" }`；回待办等重新排期用 `outcome: "backlog"`；要停止并交还用户用 `tone: "danger"`（提交后回待办）。
- 需要用户勾选多个项时用 `multiSelect: true`（选项 1–8 个）；单选审批用户只会选一个。
- 一次要问用户多个问题（最多 6 题，每题可独立单选/多选）时传 `questions[]`，不要串多次审批；多题时 `title` 由服务端从第一题生成。
- 请求审批后在同一轮里不要假设结果；明确告诉用户「已在看板等你确认」。
- `blocked`/`failed` 卡片在「待你确认」列展示，审批提交不改变其状态；解决后由你改回 `running` 或 `done`，并在时间线说明原因。
- 用户拒绝时尊重结论：停下、记录原因，必要时新建卡片而不是反复重试。

## 反模式

- ❌ 每个工具调用都 `kanban_add_activity` → 时间线噪音。只记里程碑/错误/决定。
- ❌ 建卡时手写 `sessionId`/`cwd`/`workspaceId`（默认会自动填）或为同一件事的每张子卡都开 `sessionMode:'new'` → 会话爆炸；能由当前会话继续做的子任务用默认 `reuse`。
- ❌ 卡片还停在 `backlog` 就开始大段干活 → 用户看不出你在做什么。先领取。
- ❌ 复用已完成的卡片做新任务 → 结果与时间线混杂，新建卡。
- ❌ `result` 写「完成了」→ 写清交付物与验收方式。
- ❌ 把 `approvals` 当普通评论用 → 审批只用于真正需要用户拍板的决定。

## 出错时

- `CARD_NOT_FOUND`：卡片不存在或已归档，用 `kanban_cards` 重新查找。
- `BAD_REQUEST`：检查参数（状态枚举、选项数量 1–4、必填文本）。
- `CONFLICT`：卡片状态已被用户改变，重新读卡后再决定下一步。
- 审批决议在 `approval.resolution`：单题 `{ optionIds, labels, comment? }`；多题额外有 `answers: [{questionId, optionIds, labels, custom?}]`（`optionIds/labels` 仍是拍平后的兼容字段；`custom` 是用户选「其他（自行填写）」时填的自定义回答，≤600 字，单选自定义时 `optionIds` 为空）。不要假设旧的单值 `optionId`。
- 多题审批用户会逐题作答；你只能在用户完成后读取 `answers`，不要自行补答或推断用户选择。看到 `custom` 就按用户原文理解，不要把它当备注忽略。
- 工具返回 `{ok:false,error:{code,message}}` 时不要重试同样的错误参数；根据 `message` 修正。

## 收到卡片回复 / 开始推进时的第一步

- 当用户从看板卡片内回复，或点击「开始推进」时，**先 `kanban_move_card` 把卡片移到 `running`，并用 `kanban_update_card` 写一句 `currentAction`**，再开始实际工作；不要等做完才改状态。
- 如果卡片已经是 `running`，只更新 `currentAction`；如果用户在待办卡片里只是提问、没有启动意图，可以保持 `backlog` 并直接回答。
- 完成时用 `kanban_complete_card` 写 `result`；需要用户决策时用 `kanban_request_approval`，不要替用户做选择。

## 交接摘要（handoff）

- 会话即将归档/暂停、或要把卡片交给另一个会话前，用 `kanban_update_card` 写 `handoff`：
  `{ summary: "当前进度/已完成/关键决策", nextSteps: "下一步与验收标准", sessionId: "可选来源会话" }`。summary ≤400、nextSteps ≤600。
- 接手一张有 `handoff` 的卡片时，先读 `kanban_card` 的 handoff，按摘要与 nextSteps 续接；不要从头重做。
- handoff 是覆盖写；`handoff: null` 清除。写入会追加 `handoff` 活动，不改变卡片状态。
