# Changelog

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
