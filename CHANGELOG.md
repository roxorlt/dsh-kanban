# Changelog

## v0.4.0 — 2026-10-22

### 新增：批量选择与批量操作（v1.1 批次）

- 工具栏「选择」入口进入选择模式：卡片/列表行显示复选框，点击切换选中，不展开、不进详情；进入时清空展开与抽屉。
- 拖拽完全禁用（`draggable=false` + dragstart 守卫 + drop 拦截），与批量选择手势分离；Esc 或「取消」退出。
- 批量条：已选 N / 全选当前视图（全选后变取消全选）/ 清空 / 移动到 ▾ / 归档 / 取消；0 选时移动与归档禁用；竖屏换行。
- 选择集是纯 reducer，切视图/刷新保持选择并按现存非归档卡片清理；批量成功 toast + 清空 + 退出 + refresh。
- 新增 `POST /api/kanban/cards/batch`（archive/move，cardIds 1–200，跳过不存在/已归档），返回 `{ok,cards,skipped,revision}`。
- 时间线新增 `archived` 活动类型；归档写 `archived`、`archivedAt`。

### 新增：已完成自动归档

- 插件配置 `autoArchiveDays`（默认 30，0 关闭）：仅归档 `done/canceled` 且 `completedAt` 超过 N 天的卡片；启动即跑一次 + 每小时一次。
- 自动归档写 `archived` 活动（system），不删除数据；已完成列底部与帮助浮层新增说明。

### 验证

- 服务端 `node --test` 67/67；Web vitest 10 文件 / 57 测试；tsc 0 error；令牌 lint 0/0；build 成功。
- Playwright：选择模式、全选/清空、批量移动（status 变更）、批量归档（toast、卡片消失、archivedAt/archived 活动）、拖拽 no-op、Esc 退出；console 0 error。
- 设计：mockup `?selection=1`、自动归档说明、lint 0/0；截图 `design/screens/17-selection-batch-1440.png`。


## v0.3.2 — 2026-10-22

### 示例数据清理

- 种子卡片统一加「示例」标签，避免与真实任务混淆；首次启动的示例卡一眼可辨。
- 修正过时的「接入 DSH 客户端桥发送消息」示例：不再声称当前版本缺少 sessions 接口，改为中性的「演示受阻状态」（对应能力已在 v0.2.1 完成）。
- 线网看板中已有示例卡已同步补「示例」标签；该卡已标记完成并写明「示例卡，可归档」。


## v0.3.1 — 2026-10-21

### 修复：列表展开区的审批动作改为左对齐（按用户参考图）

- 语义纠正：不是「标题左侧的窄动作列」，而是**列表行展开区底部的审批/行内动作整体左对齐**——备注在上、按钮在下、靠左，按钮固定 84–96px 宽，不拉伸、不横通栏。
- 列表行展开时隐藏行首快捷动作簇，避免同一动作出现两套入口；折叠行仍保留右对齐的固定宽动作簇。
- 卡片内审批动作保持右对齐（与列表展开面板区分），已在设计规范 §4.2 写明。
- 覆盖：`ApprovalPanel` 在列表展开区（单题/多题）全部生效；移动端不被 `flex:1` 拉通栏。

### 验证

- Web tsc 0 error / build 成功；列表展开实测 `.kb-decision-actions` 为 `flex-start`，驳回/批准按钮 84px 固定宽，DOM 左边界与内容一致。
- mockup `?listActions=left` 默认左对齐、`?listActions=right` 对照；lint-tokens 0/0；截图 `design/screens/15-list-actions-left-1440.png`、`docs/assets/screens/list-actions-left-production.png`。


## v0.3.0 — 2026-10-21

### 新增：多问题审批（对齐 DSH `ask_user_question`）

- 数据模型：`Approval.questions[]`（1–6 题，每题 `header/question/multiSelect/options`）与 `ApprovalAnswer`；保留单题字段与旧 resolution 兼容。见 [契约](docs/contracts/01-data-model.md)。
- API：`POST /approvals` 支持 `questions[]`；`POST /approvals/:id/resolve` 支持 `{answers:[{questionId,optionIds[]}],comment}`，逐题校验、逐题必答；`resolution` 同时写 `answers` 与拍平的 `optionIds/labels`。
- Agent 工具：`kanban_request_approval` 新增 `questions` 参数（与旧 title/options 二选一）；`kanban_card` 返回题目；pendingApproval 摘要带题数。
- Web：卡片/列表/详情复用同一审批组件；逐题 fieldset、单选/多选徽标、全部选项说明、统一备注、「提交全部回答」；缺题高亮+聚焦+toast；已解决态逐题展示；卡片内限高滚动。
- 会话文本：`【看板·审批】已提交「title」：\n- header：A、B…`；未绑定会话保持中性提示 +「新建会话并发给 agent」。
- 种子：新增 3 题示例卡「上线评审：发布窗口与检查项」；总卡数 7→8。

### 验证

- 服务端 `node --test` 60/60；Web vitest 8 文件 / 49 测试；tsc 0 error；令牌 lint 8 CSS 0/0；build 成功。
- Playwright 真实 dev-server：3 题逐题作答 → `resolution.answers` 三题正确、`optionIds` 拍平、approved；单题审批回归正常；console 0 error。


## v0.2.1 — 2026-10-21

### 修复（用户实测 12 项）

- 去重：卡片数/待确认/会话运行中只保留顶栏一处；连接状态只保留工具栏右侧一处；footer 只留快捷键与预览标识。
- 宿主安全区：接入 DSH 0.2.x 的 `--dsh-frame-overlay-top` / `--dsh-frame-leading-clearance`，macOS 侧栏折叠时的悬浮「展开/新建会话」按钮不再压住看板标题行。
- 夜间模式：工具栏新增三态主题（跟随/亮/暗，`T` 同效，localStorage）；嵌入时优先调用宿主 `theme.set`，整个 DSH 一起切换，旧版/独立模式才用本地令牌兜底。
- 快捷键：document capture + 画布聚焦修复 iframe 场景失效；N/B/L/⌘K/T///?/Esc；`?` 打开帮助。
- 筛选：修复 `.kb-check` 与清单勾选样式撞类名导致的空文案/错乱；空组、长文本、暗色、组内滚动。
- 「加载更早」改为 12px ghost 文字；「打开详情」统一为「详情 >」。
- 密度对齐 mock：顶栏 52 / 工具栏 48 / 列头 40 / 列距 12 / 卡片 padding 10×12 / 标题 20 / 正文 13 / meta 12 / 列表行 44 / 区块 12。
- 卡片内输入框 focus 改为 inset 1px 业务蓝，不再与卡片边框撞色/出框。
- 卡片展开动作改为「详情 > / 编辑 / 移动到 ▾」文字按钮。
- 审批兜底：审批先落库；卡片未绑定会话时提示「审批已记录；未绑定会话，决定未发送」并提供「新建会话并发给 agent」；会话失效时提示「重新绑定会话」，不再报红色错误。
- （客户端）修复 DSH 0.2.x 下「打开会话」报 `sessions.open is not a function`：0.2.x 改用 `ctx.uiWorkspace.openSession`，提示词改用 `sessions.using(target,{source},op)`；0.1.x 自动回退旧 API。

### 新增

- 设计：列表动作区左置变体（`?listActions=left`）、多问题审批（对齐 DSH `ask_user_question`）、三态主题 mock、紧凑规格 §4.5。
- 文档：[Deep link 提案](docs/08-deeplink-proposal.md)、[DSH 0.2.1 兼容说明](docs/02-dsh-integration.md)。

### 验证

- 服务端 node --test 55/55；Web vitest 39/39；tsc、vite build、令牌 lint 0/0。
- 真实 DSH **0.2.1-rc.2** web 宿主：插件加载、iframe 桥、insets、theme.set、会话 create/prompt/open 全部实测；打开会话可正确跳转对话；审批未绑定提示为中性。
- Playwright 回归：去重、insets 76px、三态主题、快捷键、筛选、审批兜底、详情按钮文案、console 0 error。


## v0.2.0 — 2026-10-21

### 新增

- **审批多选**：`Approval.multiSelect`，卡片内完整展示全部选项与说明；单选用 radio、多选用 checkbox，提交 `optionIds[]`；兼容旧 `optionId` 数据。
- **人工发起确认**：把卡片拖进「待你确认」且没有待定项时，弹窗生成通用确认（标题预填「需要你确认：{卡片标题}」，选项 继续/停止，可编辑）。
- **时间线分页**：`GET /cards/:id/activities?before=` 游标；卡片展开默认 3 条 + 「加载更早」，详情 20 条 + 分页；展开区限高内部滚动。
- **已完成防膨胀**：看板已完成列显示最近 5 张 + 「查看全部 N」；列表视图已完成分组默认折叠 + 加载更多；done 卡片可「重新打开」。
- **列表分组**：按状态（默认）/ 项目 / 优先级切换分组。
- **多会话**：详情展示会话列表、主会话徽标、设为主会话；有多个会话时选择回复/审批同步目标。
- **媒体行**：卡片内非文字素材改为紧凑媒体行（缩略图 + 数量 + 在会话中查看），不内联大图。
- **弹窗草稿保护**：点蒙层 / Esc / 关闭时若有未保存修改，二次确认「放弃未保存的修改？」。

### 改进

- 工具栏移除刷新按钮与「Agent 自主推进」开关（自主性不是全局开关；SSE 自动刷新，手动重试只在错误条）。
- 面包屑移除「Agents」，改为看板名 + 未归档卡片数 + 待你确认 / 会话运行中计数。
- 术语统一：运行中的实体称「会话」；「DSH Agent」只用于时间线 actor。
- 同义同步提示收敛到 Composer 一处。
- 新建入口收敛：看板视图只用列内 `+`，列表视图只用工具栏新建。
- 列表动作区固定宽度右对齐，窄屏换行左对齐；批准/驳回/重试不再横通栏。
- 新建/编辑表单把「执行目录」收进「更多」，项目说明为逻辑分组。
- 种子数据增加多选审批示例；示例卡片不再伪造会话绑定。

### 决策记录

见 [docs/03-design-system.md §10.3](docs/03-design-system.md) 与 [docs/04-architecture.md §10](docs/04-architecture.md)。

### 验证

- 服务端 `node --test` 55/55；Web `tsc` 0 error、vitest 38/38、vite build、令牌 lint 0/0。
- Playwright 回归：多选审批提交 `optionIds:["unit-test","build"]`、时间线分页、脏草稿二次确认、列表分组/折叠、窄屏布局、明暗主题，console 0 error。
- 详见 [docs/06-verification.md](docs/06-verification.md)。
