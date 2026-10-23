# Changelog

## v0.8.0 — 2026-10-23

### 新增：handoff 交接摘要字段（M2）

- Card 新增 `handoff {summary, nextSteps?, sessionId?, at, by?}`；`summary` ≤400 必填、`nextSteps` ≤600，服务端写入 at/by。
- `PATCH /cards/:id` / `kanban_update_card` 支持 `handoff`：对象覆盖写、`null` 清除；写入追加 `handoff` 活动「更新了交接摘要」，不改变卡片状态。
- Web：详情抽屉只读「交接摘要」区块 + 复制；看板/列表「交接」徽标；时间线渲染 handoff 活动。
- 续接：所有从卡片启动/补建新会话的启动提示统一追加 `【交接摘要】` + 后续；开始推进 / 进行中建卡 / 详情补建会话共用 helper。
- Agent skill 增补：暂停/归档/交接前写 handoff，接手时先读 handoff 续接。

### 验证

- 服务端 71/71；Web vitest 16 文件 / 110 测试；tsc 0 error；build；令牌 lint 0/0。
- 真实 DSH 0.2.1-rc.2：PATCH handoff 后卡片徽标/详情区块/时间线可见；点击开始推进后会话文本逐字包含 `【交接摘要】` + summary + `后续：nextSteps`；agent 据此继续处理；console 0 error。
- 设计：docs/03 §7.18 新增交接摘要规范；截图 handoff-badge/handoff-drawer/handoff-prompt。


## v0.7.3 — 2026-10-23

### 修复：「已完成」列内拖动松手后卡片消失进「查看全部」

- 现象：在已完成列拖动卡片、松手落在列体空白区时，卡片还在已完成里，但预览里不见了（位置被挪到列表末尾附近，折进「查看全部 N」）；竖屏高列（5 张预览下方大片空白）特别容易触发。
- 根因：空白区落点的 `dropTarget` 返回 `beforeId = 列表最后一张`，实际插到倒数第二而不是真正末尾；已完成列预览只渲染最近 5 张，预览外都折进「查看全部」，于是松手即消失。同列拖回原处/松手在卡片自身也会走这条路径（静默改顺序、刷新 `completedAt`、写「移到已完成」时间线）；其他列空白区落点也差一位，与末尾 2px 落点线不一致。
- 修复：`web/src/lib/grouping.ts` 新增 `planCardDrop` 统一落点判断——同列空白区/卡片自身 = 放回原位（返回 null：不请求后端、不重排、不弹 Toast、不写时间线）；同列拖到其他可见卡片仍可排序，落点与当前顺序相同也视为放回原位；跨列拖进「已完成」空白区 = 插到列头（最近完成，预览一定可见）；其他列空白区 = 真正末尾。`BoardView` 落点提示线同步：已完成列内拖回空白不画线、跨列拖进已完成画在首张卡片之前、其他列画在末尾。
- 验证：Web vitest 15 文件 / 107 测试（新增 `planCardDrop` 8 例）；tsc 0 error；令牌 lint 0/0；build 成功；服务端 71/71。Playwright + 真实 Chrome（1440×1800、源码 dev-server）：同列空白/自身 = 0 写请求、位置不变、无 toast；同列拖到第 4 张卡 = 重排后仍可见；跨列进已完成空白 = 请求无 before/afterId、落在预览第 1 张；跨列进进行中空白 = 落在末尾；落点线 3 项断言通过；console 0 error。真实宿主 `/dsh-kanban/`（1028×1800、真实数据、已完成 20 张）同列空白复测：0 写请求、位置 1→1、预览不变、console 0 error。证据 `design/screens/board-drag-done-cross-drop-top.png`、`board-drag-done-same-no-drop-line.png`，记录见 docs/06 §1.14。

## v0.7.2 — 2026-10-23

### 修复：竖屏窄宽度下触摸板横滑到第 4 列不响应

- 现象：竖屏外接屏（720–1099px 断点下 4 列固定 300px，总宽 1268px）必须横向滚动才能看到「已完成」列；但只有光标停在列间隙/列头时横滑才生效，停在卡片、列体或列体空白区完全没反应。
- 根因：列体 `.kb-column__body` 是纵向滚动容器（`overflow-y: auto` + `overscroll-behavior: contain`）。按 CSS 规则，`overflow-x` 会计算成 `auto`，横向 wheel 落在列体上被当作「本容器滚动」；列体本身没有横向溢出，`overscroll-behavior: contain` 又禁止链式滚动交给看板，事件到这里就断了。
- 次要根因：720–1099px 的 `scroll-snap-type: x proximity` 会在每一帧小横滑后把看板吸附回原位（1028/1268 宽下只有起点、末端两个有效吸附点），横滑体验退化成「要么弹回、要么一步跳到底」。
- 修复：新增 `useBoardWheelScroll`（看板容器上的非 passive wheel 监听），横向手势由看板消费（`preventDefault` + `scrollLeft`），光标在卡片/列体/列体空白/列头/列间隙任意位置都能横滑到第 4 列；看板没有横向溢出（≥1100px、<720px 竖屏）时完全不接管。
- 新增 `lib/boardWheel.ts` 纯逻辑做轴向锁定：手势首帧按两轴占比判定 x/y，整个手势只走一个轴，停顿超过 150ms 才重新判定；纵向手势完全交还浏览器（列体照常自己滚），因此不会出现「同一次手势同时横滚 + 竖滚」。⌘/Ctrl + 滚轮不接管（保留缩放），Shift + 滚轮按横向处理，行/页模式 delta 统一换算成像素。
- `.kb-board` 增加 `overscroll-behavior-x: contain`，滚到两端不再触发 macOS 的横滑后退手势。
- 720–1099px 的按列吸附只保留给触摸设备（`@media (pointer: coarse)`）；触摸板/鼠标改为自由横滚，列宽仍保持 300px，不改既有列宽与卡片密度。
- 验证：Web vitest 15 文件 / 102 测试（新增 boardWheel 16 例：轴向判定、手势内锁轴、停顿重判、Shift、行/页换算、缩放不接管、噪声）；tsc 0 error；令牌 lint 0/0；build 成功。真实宿主 `/dsh-kanban/` 用真实 Chrome wheel 事件覆盖 1028×1800（1080 竖屏减宿主侧栏）/1080×1920/960×1600/720×1280/1440×900/390×844：卡片/列体/列头/列间隙横滑均能滚到最大（1028 溢出 240 → left 240；960 溢出 308 → left 308）、竖滑只滚列体（看板 0）、横为主斜滑只横滚、竖为主斜滑只竖滚、动量式连发累积、列表↔看板切换后仍生效、无溢出视口不接管；console 0 error。证据截图 `design/screens/board-wheel-portrait-*.png`，记录见 docs/06 §1.12。

### 修复：详情抽屉「摘要」宽度被操作按钮挤成窄列

- 现象：详情抽屉里的摘要文案只有抽屉内容区约 2/3 宽——1440px 下摘要 286px、1100px 下 206px、390px 下 216px，而正文内容区分别是 428 / 348 / 358px；长摘要在 1440px 被折成 9 行，右边缘比下方 chips、元数据卡片短 142px，看起来像「摘要被挤到左边一列」。
- 根因：`.kb-drawer__summary` 放在 `.kb-drawer__heading` 里，而 heading 是头部 flex 行中与「编辑 + 归档 + 关闭」（138px）并排的可收缩列；摘要因此按标题列宽折行。但它其实位于按钮下方，本可以独占整行。
- 修复：头部拆成两行——首行 `.kb-drawer__header-row`（kicker + 标题｜编辑/归档/关闭），第二行摘要作为 header 直接子元素独占整行；`.kb-drawer__summary` 补 `margin-right: 4px` 抵消「头部操作区 12px 内缩 vs 正文 16px」的差，右边缘与正文内容对齐；另加 `overflow-wrap: anywhere` 防止无空格长串横向溢出。
- 标题列宽度、操作按钮尺寸与位置保持不变，390px 下标题不额外折行；无摘要卡片头部不塌陷。
- 验证：1440/1100/390 摘要宽度 = 正文内容宽（428/348/358），右边缘与 chips/元数据误差 0，行数 9/13/12 → 6/8/8；亮/暗主题同宽，英文界面与含长 URL 的无空格摘要同样不溢出；编辑弹窗、Esc、关闭按钮行为不变；真实宿主 `/dsh-kanban/` 刷新后即生效、console 0 error；Web vitest 15 文件 / 102 测试；tsc 0 error；build 成功；令牌 lint 0/0；服务端 67/67。证据截图 `design/screens/web-drawer-summary-*.png`，记录见 docs/06 §1.13。

## v0.7.1 — 2026-10-23

### 修复：折叠卡页脚「未绑定会话」文案与右侧按钮干涉

- 根因：`.kb-card-foot` 为单行 flex，`.kb-foot-status` 允许收缩但内部文案 `white-space: nowrap` 不会截断；内容溢出后画到右侧指标按钮（工具数/搜索数/会话入口）上。
- 页脚改为可整行换行（`flex-wrap: wrap`，行距 4px）：放不下时指标换到第二行右对齐，宽屏仍是单行。
- 「状态 · 耗时」包进 `.kb-foot-status__text`，可收缩省略；「未绑定会话」改为独立 `flex: none` 警告项，始终保持完整可读。
- 覆盖 1440/1280/1024/900/720/390、中英双语、亮暗主题，以及耗时超 1 小时的压力文本；折叠卡相邻页脚元素 bounding box 交叠 0、页脚溢出 0。
- 去掉 `responsive.css` 中重复的 `<720` 页脚换行规则（已上移为全局）。
- 验证：Web vitest 14 文件 / 86 测试；tsc 0 error；build 成功；令牌 lint 0/0；服务端 67/67；证据截图见 docs/06 §1.10 与 `design/screens/web-foot-warn-*.png`。

### 修复：卡片内输入框聚焦态「双层蓝框」

- 根因：卡片内输入框同时命中两条焦点规则——通用 `.kb-card :is(.kb-input,.kb-textarea):focus` 把 `border-color` 改成业务蓝并叠加 `box-shadow: inset 0 0 0 1px` 业务蓝（两层蓝线）；回复框外层 `.kb-card-reply:focus-within` 又画一圈蓝描边 + 45% 蓝内阴影，外层和内侧 input 各画一圈。
- 修复：卡片内输入框统一改为单圈 `outline: 2px solid var(--dsw-alias-state-business-primary)` + `outline-offset: -2px`（负偏移画在控件内侧，既不外扩压到卡片边框，也不会与 border 叠成两层）；卡片内回复框只由外层画焦点环，内层无边框 input 不再参与。
- 覆盖：看板卡片内回复框、审批面板备注 textarea；亮/暗主题；鼠标点击与键盘 Tab 进入都保留焦点环；失焦恢复中性 0.5px 边框。
- 验证：Playwright + 真实 Chrome（1440px、3x DPR）聚焦态 computed style 仅剩一圈 `outline: 2px solid`（此前是 border 变蓝 + inset 蓝阴影两层）；宿主 `/dsh-kanban/` 刷新后实测同样单圈、console 0 error；Web vitest 14 文件 / 86 测试、tsc/build、令牌 lint 0/0、服务端 67/67 全绿。证据截图 `docs/assets/screens/focus-reply-before-after.png`、`docs/assets/screens/focus-approval-note-before-after.png`，见 docs/06 §1.11。

## v0.7.0 — 2026-10-23

### 新增：新建卡片建议 + 会话关联 + 进行中自动处理

- 新建卡片表单把「工作区 / 执行目录」提到主表单：工作区下拉来自 DSH 左侧工作区（`workspaces.list`）；选工作区自动回填 cwd 与空 project。
- 项目、cwd、会话建议来自 DSH 工作区、会话 cwd、历史卡片；排序「当前工作区 > 近期会话 > 使用频次」，以可点击 chips + 推荐徽标 + 来源标注呈现。
- 新增「关联会话」字段：进行中默认「新建会话并启动」，可选已有会话（推荐/运行中/目录），进行中禁止不关联；其他列默认暂不关联，也可新建/选择会话。
- 建卡提交后：进行中 + 已有会话 → `session.prompt(buildStartPrompt)`；进行中 + 新建 → `session.ensure` → `bindSession`；非进行中 + 新建 → `session.create` → bind（不发提示）。失败保留卡片并提示可在详情补建。
- 详情抽屉无会话时：进行中警示 + 内联「新建会话」表单（必须先选工作区/目录），按钮按状态「创建并开始处理 / 创建并绑定」；创建→bind→(running) prompt→refresh。
- 进行中无会话的卡片在看板/列表显示「未绑定会话」弱警示；独立预览只建卡并给中性提示。

### 验证

- 服务端 67/67；Web vitest 14 文件 / 86 测试；tsc 0 error；build 成功；令牌 lint 0/0。
- 真实 DSH 0.2.1-rc.2：新建「进行中」卡片 → workspaceId/cwd/project 回填、自动创建并绑定 sessionId、toast「已创建，会话已启动」、agent 在会话内实际开始处理并回写卡片；无会话卡片在详情选择工作区/目录 → 创建会话并开始处理 → 新 sessionId + agent 启动；console 0 error。
- 设计：mockup `?newcard=1` / `?drawer=no-session`，截图 19/20；docs §2.9/§7.15/§7.16。


## v0.6.1 — 2026-10-23

### 修复：恢复「点卡片非交互区展开/收起」（对齐设计 demo 与规范）

- 看板卡：标题、摘要、当前动作、属性行、页脚状态等非交互区单击 = 展开/收起；列表行整行主区同理（原实现只有右上角箭头）。
- 详情入口统一为「详情 >」/ `O` / 双击卡片/列表行；点标题不再进详情。
- 键盘对齐规范：`Enter` / `Space` 均为展开收起，`O` 打开详情（原来 `Enter` 打开详情、`Space` 展开）。
- 展开区内部与审批面板内的文字点击不折叠卡片；拖选文字、按钮/链接/输入框不触发。
- 验证：headless Chrome 实测（见 docs/06 §1.9）；web tsc/vitest/build/令牌 lint 与服务端测试全绿。

## v0.6.0 — 2026-10-23

### 调整：返回看板气泡右对齐 + 来源卡片高亮

- 气泡容器按 DSH Composer 宽度令牌（`--dsh-composer-card-max-width` / `--dsh-composer-side-clearance`）居中并右对齐，气泡右边缘与输入框右边缘一致（1440px 实测 1203 = 1203，误差 0）。
- 点击「返回看板」时把被打开的 sessionId 写入 `sessionStorage`；看板挂载后映射到对应卡片，滚动到可见区域并高亮 1.8s（business 蓝描边 + 背景淡闪），自动清除。
- 列表视图行使用同一高亮语义；`prefers-reduced-motion` 下退化为静态描边。
- 修复高亮计时器被列表刷新 cleanup 取消的问题（拆成独立 effect）。

### 动效 skill 补装

- 安装 `ui-animation`（录屏动效复刻/分析，需要 FFmpeg/Python 时再启用）；连同 animate、review-animations、motion-lab 构成完整动效工具链。
- 视觉/动效已拆分为 7 张看板卡（视觉 V1–V4、动效 M1–M3），V1 视觉审计已启动。


## v0.5.1 — 2026-10-22

### 调整：会话页返回看板入口改为条件气泡

- 移除会话标题区常驻「看板」按钮（默认不展示）。
- 改为输入框上方（`conversation.input.dock`）的「返回看板」胶囊气泡；仅同时满足以下条件时出现：
  1. 会话由看板「打开会话」跳转进入；
  2. 当前会话就是被打开的那个；
  3. 左侧栏处于收起状态。
- 点击回看板并清理状态；回到看板/切走会话后不再显示；侧栏展开时不重复入口。
- 真实 DSH 0.2.1-rc.2 宿主实测：展开侧栏无气泡 → 收起侧栏气泡出现（输入框上方右侧）→ 点击返回看板、气泡消失；console 0 error。

### 调研：OpenDesign 设计/动效 skill

- 新增 [docs/09-design-motion-skills.md](docs/09-design-motion-skills.md)：筛选并安装 `animate`、`redesign-existing-projects`、`impeccable-design-polish`、`design-md`、`review-animations`、`motion-lab`；明确哪些营销型/Awwwards 型 skill 不适用。


## v0.5.0 — 2026-10-22

### 新增：待办卡「开始推进」

- 待办（backlog）卡片三个入口：折叠卡 footer 次级按钮、展开卡主按钮、卡片菜单项。
- 点击后：乐观移入「进行中」→ 启动或续接主会话（无会话则创建并绑定）→ 发送固定启动提示（`【看板·开始推进】…`，工具优先，附带目标/验收标准/审批要求）；失败回滚待办。
- 独立预览模式只移动卡片并给中性提示，不创建会话。
- 待办卡回复不再隐式改状态；回复成功后给中性提示「卡片仍在待办，可点开始推进」。

### 新增：会话页快速返回看板

- 客户端插件在 DSH 会话标题右侧 actions 注册「看板」按钮，点击直接回到看板面板（0.1.x/0.2.x 均可用），不丢失会话。

### 验证

- 服务端 67/67；Web vitest 11 文件 / 67 测试；tsc 0 error；build 成功；令牌 lint 0/0。
- 真实 DSH 0.2.1-rc.2 宿主实测：待办卡「开始推进」→ 卡片变进行中 + 新会话收到启动提示 + 绑定 sessionId；会话头部「看板」按钮点击返回看板；无 console 错误。
- 设计：mockup `?start=1`、docs §2.8/§7.12–7.14；截图 18-start-card-1440.png。


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
