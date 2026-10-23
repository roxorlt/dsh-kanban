# 验证记录（v0.2）

> 结论：**服务端 49/49 测试通过；Web UI 类型检查/构建/令牌 lint 通过；插件在独立 DSH profile 中真实安装、加载、渲染，并通过「侧栏入口 → 全屏面板 → 会话桥 → agent 工具 → 审批回写」的端到端闭环验证。**
> 所有验证均在隔离环境进行，未修改、未向用户当前 GUI 会话发消息。

## 1. 环境

| 项 | 值 |
| --- | --- |
| DSH | `0.1.5-rc.2`（`/opt/homebrew/bin/dsh`） |
| Node | v22.22.2 |
| 验证用 DSH_HOME | `/tmp/dsh-kanban-e2e`（隔离 profile / 会话 / 数据） |
| 验证用 profile | `kanban-dev`（从官方 `web` 模板初始化） |
| 插件数据目录 | `/tmp/dsh-kanban-e2e/data`（通过 `--patch` 覆盖 dataDir） |
| 浏览器 | Google Chrome headless + playwright-core 1.64.1 |
| 用户环境 | 未触碰 `~/.dsh/profiles/desktop`、未重启/操作正在运行的 GUI |

## 1.1 v0.2 增量验证（2026-10-21）

| 项 | 结果 |
| --- | --- |
| 服务端测试 | 55/55（新增多选审批、旧 resolution 迁移、`before` 分页边界） |
| Web 单测 | 38/38（新增 activities 分页、列表分组、审批新旧 resolution 兼容） |
| 构建 | tsc 0 error；dist JS 80KB gzip / CSS 10KB gzip |
| 令牌 lint | 8 个 CSS：0 error / 0 warning |
| 嵌入 DSH 实测 | 7 张卡片（含 1 张多选审批示例）；多选审批卡渲染 4 个 checkbox；主题 light/dark 均正常；49 令牌同步；console 0 error |
| 交互回归（Playwright） | 多选审批提交 `optionIds:["unit-test","build"]` + labels；`GET activities?limit=1` 返回 `hasMore/nextBefore`；新建弹窗脏草稿点蒙层弹出「放弃未保存的修改？」；列表分组切换状态/项目/优先级；已完成列折叠；390 竖屏列表；console 0 error |
| 截图 | `docs/assets/screens/`（embedded、board-wide/dark、approval-multi、board-list-groups、board-list-done、detail-drawer、portrait-*） |

> 注意：桌面版新增服务端能力（审批多选、时间线分页）需要**重启 DSH** 才能生效；只刷新页面会继续使用旧服务端（前端已兼容旧接口，不会报错）。

## 1.2 v0.2.1 增量验证（2026-10-21）

桌面 App 实际运行的是 **DSH 0.2.1-rc.2**，会话 API 与 CLI 0.1.5 不同；本轮用同版本 CLI 起独立 web 宿主实测。

| 项 | 结果 |
| --- | --- |
| 宿主版本 | `@deepseek-ai/dsh@0.2.1-rc.2`（独立 `DSH_HOME` + 独立 profile） |
| 会话 API | 0.2.x 无 `sessions.open`；改用 `ctx.uiWorkspace.openSession` ✔；`sessions.binding` 改为 `sessions.using(id,{source:'gateway'},op)` ✔ |
| 打开会话 | 详情抽屉「打开会话」→ 宿主切到对话，iframe 卸载、无 `sessions.open is not a function` 报错 ✔ |
| 新建 + 回复 | `session.create → session.ensure(prompt)` 返回 accepted，会话 `running: true`，agent 回复 OK ✔ |
| 主题 | 看板三态按钮 → 宿主 `theme.set` → 宿主 `data-ds-dark-theme` 切换（false→true→false 实测），旧宿主自动退化本地令牌 ✔ |
| 安全区 | 注入 `--dsh-frame-overlay-top:68px` 后，看板标题行 top=76（68+8）、left=16；不再压住宿主左上悬浮控件 ✔ |
| 去重 | 顶栏只出现一次卡片数/待确认/会话运行中；连接状态只在工具栏右侧；footer 只含快捷键与预览标识 ✔ |
| 快捷键 | N 打开新建、B/L 切换视图、⌘K 聚焦搜索、`?` 打开帮助、Esc 关闭；均在 iframe 内实测 ✔ |
| 筛选 | 项目/标签选项文案完整、无空行；空组/长文本/暗色正常 ✔ |
| 审批兜底 | 未绑定会话时提示「审批已记录；未绑定会话，决定未发送」+「新建会话并发给 agent」，非红色错误；审批已落库 ✔ |
| 自动化 | 服务端 55/55；Web vitest 39/39；tsc/build/令牌 lint 0/0；Playwright 自查 + 本轮回归 console 0 error |

证据截图：`docs/assets/screens/`（embedded-board-light / board-wide / board-dark / filter-panel / approval-unsent / help-shortcuts / detail-drawer / approval-multi / board-list-groups / board-list-done / portrait-* / list-actions-left / multi-question-approval）。

> 说明：真机 Electron 的窗口 chrome 无法在 headless 中复现，安全区通过注入宿主同名 CSS 变量验证；其余交互在 0.2.1 web 宿主实测。

## 1.3 v0.3 增量验证（多问题审批）

| 项 | 结果 |
| --- | --- |
| 服务端 | `node --test` 60/60（多题创建/边界、逐题校验、answers resolve、旧单题兼容） |
| Web | vitest 49/49；tsc 0 error；令牌 lint 8 CSS 0/0；build 成功 |
| 真实 dev-server | 种子 8 卡（新增 3 题「上线评审：发布窗口与检查项」）；Playwright 逐题选择 → `resolution.answers` 3 条正确、`optionIds` 拍平、approved；单题审批回归正常 |
| 截图 | `docs/assets/screens/multi-question-pending.png`、`multi-question-resolved.png`、`multi-question-drawer.png` |

## 1.4 v0.3.1（列表审批动作左对齐）

- 用户参考图确认语义：列表行展开区底部审批/行内动作整体左对齐、固定 84–96px、不拉伸；卡片内审批保持右对齐。
- Web 实测：`.kb-decision-actions` 在列表展开区 computed `justify-content: flex-start`；驳回/批准按钮各 84px，左边界与内容对齐（截图 `docs/assets/screens/list-actions-left-production.png`）。
- 展开行隐藏行首快捷动作簇；移动端按钮不被 `flex:1` 拉通栏。
- mockup 默认 left、`?listActions=right` 对照；lint 0/0。

## 1.5 v0.4.0（v1.1 批次：批量选择 + 自动归档）

| 项 | 结果 |
| --- | --- |
| 服务端 | `node --test` 67/67：batch archive/move（混合/上限/参数校验）、自动归档 29/30/31 天边界、done/canceled vs running、days=0、活动类型/archivedAt、index 启动接线 |
| Web | vitest 10 文件 / 57 测试；tsc 0 error；令牌 lint 0/0；build 成功 |
| 真实 dev-server | 选择模式：8 卡 → 选 2 张批量移动（status/顺序正确）→ 选 1 张批量归档（toast、状态隐藏、archivedAt + archived 活动）→ Esc 退出；拖拽 `draggable=false` |
| 自动归档 | 仅 done/canceled 超过 N 天；启动即跑 + 每小时；帮助/已完成列提示 30 天策略 |
| 截图 | `docs/assets/screens/selection-batch.png`、`selection-batch-design.png`、`selection-board.png`、`selection-list.png`、`help-autoarchive.png` |

## 1.6 v0.5.0（开始推进 + 会话返回看板）

| 项 | 结果 |
| --- | --- |
| 服务端 | 67/67 |
| Web | vitest 11 文件 / 67 测试；tsc 0 error；build 成功；令牌 lint 0/0 |
| DSH 0.2.1-rc.2 宿主 | 待办卡「开始推进」→ 卡片 status=running、新 sessionId 绑定、会话收到启动提示（逐字）；会话标题右侧「看板」按钮存在，点击返回看板（iframe 重新挂载）；console 0 error |
| 设计 | mockup `?start=1`、docs §2.8/§7.12–7.14；截图 `start-card.png`、`start-card-design.png`、`conversation-back-board.png` |

## 1.7 v0.5.1（返回看板条件气泡）

| 项 | 结果 |
| --- | --- |
| DSH 0.2.1-rc.2 宿主 | 从看板打开卡片会话 → 侧栏展开时无气泡；收起侧栏后输入框上方出现「返回看板」气泡；点击回到看板、气泡清理；console 0 error |
| 条件 | 仅 `sessionId===被打开会话` 且 `[data-sidebar-collapsed]` 存在；`conversation.input.dock` 渲染；不新增头部按钮 |
| 截图 | `docs/assets/screens/return-bubble.png`、`return-bubble-expanded.png` |
| 设计 | docs/03 §7.13 与 D-35 已更新为条件气泡规范 |

## 1.8 v0.6.0（返回气泡右对齐 + 来源卡片高亮）

| 项 | 结果 |
| --- | --- |
| DSH 0.2.1-rc.2 宿主 | 打开会话 → 收起侧栏 → 气泡右边缘 1203px，输入框卡片右边缘 1203px（误差 0）；点击返回 → 看板挂载并高亮来源卡 `card-2171aaa8`，1.8s 后 class 清除；console 0 error |
| 自测 | web tsc 0 error；vitest 12 文件 / 69 测试；build / lint 0/0；服务端 67/67 |
| 截图 | `docs/assets/screens/return-bubble-aligned.png`、`return-highlight.png` |
| 设计 | docs/03 §7.13 增加对齐/HIGHLIGHT/reduced-motion/验收标准 |

## 1.9 v0.6.1（恢复「点卡片非交互区展开/收起」）

| 项 | 结果 |
| --- | --- |
| 看板卡 | 点摘要 / 标题 / 属性行展开收起；再点收起；点菜单按钮不展开；展开区内文字不误收起 |
| 键盘 | `Enter` 展开、`Space` 收起、`O` 打开详情；`Esc` 关闭详情 |
| 审批面板 | 隔离 dev-server 种子数据：点问题标题 / 说明 / 选项 / 备注框均不展开；点选项可正常选中 |
| 列表行 | 点摘要 / 标题展开收起；键盘 `Enter` 展开、`O` 详情 |
| 选择模式 | 点卡身 = 勾选，不展开；`Esc` 退出 |
| 自测 | web tsc 0 error；vitest 12 文件 / 69 测试；build / 令牌 lint 0/0；服务端 67/67 |
| headless Chrome | 线上看板 24/25（1 项因线上无待审批卡跳过），隔离种子数据审批面板 10/10；console 0 error |
| 设计 | docs/03 §2.3、§7.4、§7.8 同步触发区域与快捷键 |

## 1.9 v0.7.0（新建卡片建议 + 会话关联 + 进行中自动处理）

| 项 | 结果 |
| --- | --- |
| 建议数据 | 真实宿主 `workspaces.list` 返回 1 个工作区（title/path）；新建表单显示工作区、cwd 推荐、项目建议（当前工作区 > 历史卡片）、已有会话列表（推荐/运行中/目录） |
| 进行中新建 | 1440px：选工作区自动回填 cwd + project，默认「新建会话」；创建后卡片 `status=running`、`workspaceId/cwd/project` 写入、`sessionIds` 自动绑定；toast「卡片已创建，会话已启动」；会话内 agent 实际开始处理并回写 currentAction/工具数 |
| 详情补建 | 无会话的进行中卡：抽屉显示「进行中但未关联会话」；点「新建会话」出现工作区/cwd 建议表单；选择工作区后创建 → 新 sessionId 绑定 + 启动提示 → agent 开始处理；console 0 error |
| 表单 CTA | 进行中 + 新建 →「创建并启动」；进行中 + 已有会话 →「创建并绑定」；其他列 →「创建」 |
| 自测 | 服务端 67/67；Web 14 文件 / 86 测试；tsc/build/令牌 lint 全绿 |
| 截图 | `newcard-suggest.png`、`newcard-suggest-design.png`、`newcard-created-running.png`、`newcard-session-agent.png`、`drawer-create-session.png`、`drawer-create-session-design.png` |

## 1.10 v0.7.1（折叠卡页脚「未绑定会话」与右侧按钮干涉）

| 项 | 结果 |
| --- | --- |
| 复现 | 隔离 dev-server 种子（`running` 且 `sessionIds: []` 的卡片）：1024/900/720px 中文下「未绑定会话」压住右侧工具图标 11px；英文 720–1440px 全部压盖 6.9–45.9px；1440px 中文在耗时 >1 小时时也会触发（根因：`.kb-card-foot` 单行不换行，`.kb-foot-status` 可收缩但内部 nowrap 文案溢出可见） |
| 修复 | 页脚允许整行换行（`flex-wrap`，行距 4px）；「状态 · 耗时」包进 `.kb-foot-status__text` 可省略；「未绑定会话」独立为 `flex: none` 的警告项，不参与压缩 |
| 自动化实测 | Playwright + 真实 Chrome：1440/1280/1024/900/720/390 × 中英双语 × 亮/暗主题 × 耗时 >1 小时压力文本，折叠页脚相邻子元素 bounding box 交叠数 0、页脚横向/纵向溢出 0；console 0 error |
| 视觉 | 宽屏单行不变；紧凑宽度改为两行（第一行状态 + 警示，第二行指标右对齐）；`design/screens/web-foot-warn-before-1024.png` / `web-foot-warn-before-foot-1024.png` / `web-foot-warn-after-1024.png` / `web-foot-warn-after-1024-dark.png` / `web-foot-warn-after-en-1440.png` / `web-foot-warn-after-390.png` |
| 自测 | Web vitest 14 文件 / 86 测试；tsc 0 error；build 成功；令牌 lint 0/0；服务端 67/67 |
| 宿主 | `~/.dsh/profiles/desktop` 以 link 指向本仓库，重建 `web/dist` 后宿主 `/dsh-kanban/` 首页引用新产物（`index-D6pSvrZj.css` / `index-CvJIeErd.js`），刷新页面即生效 |

## 1.11 v0.7.1 补记（卡片内输入框聚焦态「双层蓝框」）

| 项 | 结果 |
| --- | --- |
| 复现 | 看板展开卡内的回复框点入后出现两层嵌套蓝色圆角框；审批面板备注框（卡片内 textarea）同样。1440px、3x DPR 截图见 `docs/assets/screens/focus-reply-before-after.png` |
| 根因 | 通用规则 `.kb-card :is(.kb-input,.kb-textarea):focus` 同时把 `border-color` 改为业务蓝并叠加 `box-shadow: inset 0 0 0 1px` 业务蓝（两层蓝线）；回复框外层 `.kb-card-reply:focus-within` 另有一圈蓝描边 + 45% 蓝内阴影，且内层带 `.kb-input` 类的无边框 input 也命中通用规则，外层/内层各画一圈 |
| 修复 | 卡片内输入框焦点环统一为单圈 `outline: 2px solid var(--dsw-alias-state-business-primary)` + `outline-offset: -2px`（负偏移画在控件内侧，不外扩压到卡片边框）；`.kb-card-reply:focus-within` 只留这一圈；`.kb-card .kb-card-reply .kb-card-reply__input:is(:focus,:focus-visible)` 把内层 input 的 outline/border-color/box-shadow 全部清掉 |
| 实测（computed style） | 聚焦时回复框外层：`outline: rgb(65,118,230) solid 2px; outline-offset: -2px; box-shadow: none; border: 1px solid rgba(0,0,0,0.1)`；内层 input：`outline: none; box-shadow: none`；暗色主题同样单圈（业务蓝自动换 token 值）；失焦后外层恢复 `outline: none`。卡片内审批备注 textarea 同规则 |
| 宿主实测 | 真实宿主 `/dsh-kanban/`（1440px）刷新后：23 张卡、4 列正常渲染，展开卡回复框聚焦仅单圈；console/page error 0 |
| 自测 | Web vitest 14 文件 / 86 测试；tsc 0 error；build 成功且产物与已发布版本一致（`index-D6pSvrZj.css` / `index-CvJIeErd.js` 重建无 diff）；令牌 lint 0/0；服务端 67/67 |
| 截图 | `docs/assets/screens/focus-reply-before-after.png`（回复框 before/after light+dark）、`focus-approval-note-before-after.png`（审批备注框 before/after） |

## 1.12 v0.7.2（竖屏触摸板横滑 + 轴向锁定）

| 项 | 结果 |
| --- | --- |
| 复现（真实宿主 `/dsh-kanban/`，1028×1800 = 1080 竖屏减宿主侧栏） | 4 列 300px + 间隙 + padding 总宽 1268px，视口 1028 → 横向溢出 240px；真实 Chrome wheel 事件在列间隙（`elementFromPoint` = `.kb-board`）横滑可滚到底，在卡片标题/列体空白（目标在 `.kb-column__body` 内）横滑 `scrollLeft` 始终 0；960×1600 视口溢出 308，现象相同 |
| 根因 | 列体 `.kb-column__body` 是纵向滚动容器（`overflow-y: auto` + `overscroll-behavior: contain`），`overflow-x` 按规范计算成 `auto`：横向 wheel 落在列体上被当作本容器滚动；列体无横向溢出且 `contain` 禁止链式滚动交给 `.kb-board`，事件链在这里截断。只有目标落在列间隙/列头（不属于列体滚动容器）时才能滚 |
| 次要根因 | 720–1099px 的 `scroll-snap-type: x proximity`：单次 wheel 后立即吸附，1268/1028 宽下有效吸附点只有起点 16 与末端 308/240，出现「小横滑弹回原位、大横滑直接跳底」 |
| 修复 A（手势接管） | `web/src/lib/useBoardWheelScroll.ts`：看板容器挂非 passive `wheel` 监听（React 根监听是 passive，无法 preventDefault），横向手势 `preventDefault` + `board.scrollLeft += deltaX`，光标在卡片/列体空白/列头/列间隙任意位置都能横滑；`ResizeObserver` + 手势首帧测量横向溢出，无溢出（≥1100px、<720px）时完全不接管 |
| 修复 B（轴向锁定） | `web/src/lib/boardWheel.ts`：手势首帧按两轴绝对值占比锁定 x/y，整个手势只走一个轴，停顿 >150ms 才重新判定；纵向手势一律不 preventDefault（列体自滚）；⌘/Ctrl+滚轮不接管（缩放），Shift+滚轮把 deltaY 当横向，deltaMode 1/2 换算为 16px/行、100px/页 |
| 修复 C（吸附与边界） | 720–1099px 的 `scroll-snap` 只保留给 `(pointer: coarse)` 触摸设备，精细指针自由横滚；`.kb-board` 加 `overscroll-behavior-x: contain` 避免两端触发 macOS 后退手势 |
| 自动化实测（真实 Chrome + CDP wheel，真实宿主 1028×1800） | 横滑·卡片 0→240（到底）；横滑·列间隙 0→240；横滑·列头 0→240；横滑·列体空白 0→240；竖滑·卡片 `scrollLeft` 0、列体 360；斜滑 90/40（横为主）只横滚 240、列体 0；斜滑 40/90（竖为主）看板 0、列体 270；反向横滑看板 0、列体 0；动量式 17 连发累积到 303（max 308）；横滑→停顿→竖滑新手势正确重判；`列表 ↔ 看板` 切换后横滑仍生效；console 0 error |
| 其他视口 | 960×1600（溢出 308 → 到底 308）、1080×1920（188→188）、720×1280（548 溢出，3 发 120 累积 360，竖滚 0）、1440×900（无溢出：横滑不接管、列体竖滚正常）、390×844（单列：横滑不接管） |
| 自测 | Web vitest 15 文件 / 102 测试（新增 `boardWheel.test.ts` 16 例）；tsc 0 error；令牌 lint 8 CSS 0/0；build 成功；服务端 67/67 |
| 截图 | `design/screens/board-wheel-portrait-1028-before.png` / `-after.png`（1028 竖屏横滑前/后，后图第 4 列完整可见）、`board-wheel-portrait-1080-before.png` / `-after.png` |

## 1.13 v0.7.2 补记（详情抽屉摘要宽度）

| 项 | 结果 |
| --- | --- |
| 复现（隔离 dev-server 种子卡 + 真实宿主卡片） | 打开卡片详情抽屉后，摘要段落只有抽屉内容区约 2/3 宽：1440px 下 286px（内容区 428px）、1100px 下 206px（348px）、390px 底图 216px（358px）；长摘要（「横划交互问题」）在 1440px 被折成 9 行，右边缘停在 x=1282，比下方 chips / 元数据卡片右边缘（1424）短 142px |
| 根因 | `.kb-drawer__summary` 位于 `.kb-drawer__heading` 内，而 heading 是头部 flex 行中与「编辑 + 归档 + 关闭」（共 138px）并排的可收缩列：`heading = 抽屉宽 − 左右内边距 − gap − 操作簇`（1440px：460−16−12−8−138 = 286）。摘要在 DOM 上排在按钮下方，本可独占整行，却跟着标题列一起被挤窄 |
| 修复 | 头部拆两行：首行 `.kb-drawer__header-row`（kicker + 标题｜编辑/归档/关闭），第二行 `.kb-drawer__summary` 作为 `header` 直接子元素独占整行；摘要加 `margin-right: 4px` 抵消「头部操作区 12px 内缩 vs 正文内容 16px」的差，右边缘与正文内容对齐；另加 `overflow-wrap: anywhere` 防止无空格长串横向溢出。标题列宽、操作按钮尺寸与位置保持不变 |
| 自动化实测（Playwright + Chromium，隔离 dev-server，同一张长摘要测试卡） | 摘要宽度 = 正文内容宽：1440px 428 = 428、1100px 348 = 348、390px 358 = 358，右边缘与 chips / 元数据误差 **0**；摘要行数 9 / 13 / 12 → **6 / 8 / 8**，头部高度 260 → 194（1440px）；标题宽度保持 270 / 190 / 200px 不变（390px 不额外折行）；操作簇仍 138×32、右边缘 1428（12px 内缩，未被本修复改动）；无摘要卡片（本卡自身）摘要节点不渲染、头部高度 80px 不塌陷；暗色主题同宽；英文界面（Edit 按钮）摘要 428 = 正文 428；含长 URL 的无空格摘要 `scrollWidth = clientWidth`（348），抽屉横向溢出 0；编辑弹窗可打开、Esc 关闭后抽屉仍在、关闭按钮正常关闭；console 0 error |
| 宿主实测 | 真实桌面宿主 `/dsh-kanban/`（不重启进程，仅刷新页面即加载新 `web/dist`）打开「横划交互问题」：1440px 摘要 428 = 正文内容 428、右边缘 1424 = chips 1424、6 行；390px 摘要 358 = 正文 358；页面错误 / console error 0 |
| 自测 | Web vitest 15 文件 / 102 测试；tsc 0 error；build 成功（`index-2_jo36uV.css` / `index-CX6NhCBz.js`，重建无 diff）；令牌 lint 8 CSS 0/0；服务端 67/67 |
| 截图 | `design/screens/web-drawer-summary-before-1440.png` / `-after-1440.png`、`-before-390.png` / `-after-390.png`、`-after-1440-dark.png`（亮/暗同宽）、`-after-host-1440.png`（真实宿主卡片）；对比图 `docs/assets/screens/drawer-summary-width-before-after.png`、`drawer-summary-width-narrow-before-after.png` |

## 2. 自动化测试

### 2.1 服务端（node --test）

```
$ npm test
# tests 49
# pass 49
# fail 0
# duration_ms ~0.65s
```

覆盖：`store`（原子写 / 串行队列 / revision / 损坏备份重建 / schema 迁移）、`domain`（状态列映射 / 规范化 / 种子 / 写原语）、`routes`（CRUD / move / 乐观锁 409 / 审批 resolve / comments / session link / 同源 403 / SSE 首帧 / 静态资源防穿越与 SPA fallback）、`tools`（10 个工具 schema 与 execute）、`index`（插件注册）。

### 2.2 Web

```
$ npm --prefix web run build
> tsc --noEmit   # 0 error
> vite build     # dist: JS gzip ~74KB / CSS gzip ~9KB
$ npm --prefix web run test    # vitest 24/24
$ npm --prefix web run lint:tokens
# 8 个 CSS 文件：0 error / 0 warning
```

### 2.3 令牌规范

`dsh-ui-spec` 的 `lint-tokens.mjs` 对 8 个 CSS 文件 0 error / 0 warning；`design/lint` 抽出的 mockup 组件样式同样 0/0。

## 3. 端到端验证

### 3.1 安装与加载

```bash
export DSH_HOME=/tmp/dsh-kanban-e2e
mkdir -p "$DSH_HOME" && cp ~/.dsh/.credentials.yaml "$DSH_HOME/"
dsh --profile kanban-dev --from-default-profile web --dump-default-config > /dev/null
dsh plugin --profile kanban-dev add "/Users/roxor/Desktop/dsh/dsh kanban"
dsh --profile kanban-dev --patch /tmp/dsh-kanban-e2e/kanban-e2e.yml --port 5599 --no-open
# → dsh web: http://127.0.0.1:5599/?token=...
```

结果：

- profile `package.json` 出现 `"dsh-kanban": "link:..."`，`dsh.profile.bundles` 追加 `dsh-kanban`；
- `dsh --profile kanban-dev --dump-config` 出现 `- id: kanban / name: dsh-kanban`；
- 页面侧栏出现「看板」入口，点击后主面板加载 `/dsh-kanban/` iframe；
- 客户端诊断 `window.__DSH_KANBAN__`：`{ ready: true, errors: [], themeTokens: 49 }`；
- 浏览器 console **0 error**；iframe 与父页面同源、主题 `light` 正常。

证据：`docs/assets/screens/embedded-board-light.png`、`embedded-board-dark.png`、`docs/assets/dsh-integration/`（spike 阶段）。

### 3.2 会话桥（iframe → 父页面 → DSH 会话）

在 iframe 内直接发 `kanban:request`，父页面执行：

| 调用 | 结果 |
| --- | --- |
| `sessions.list` | `{ sessions: [], current: null }`（隔离 home，正确） |
| `session.create {cwd:"/tmp"}` | `session-cae481ba-53ee-4b8d-81ed-794b6a3558ad` |
| `session.prompt {sessionId, text}` | `{ accepted: true }` |
| 再次 `sessions.list` | 新会话 `running: true, title: "tmp"` |
| `window.__DSH_KANBAN__` | `errors: []` |

### 3.3 Agent 工具的端到端可见性与写入

向新会话发送：「请调用 `kanban_boards` 查看看板；调用 `kanban_create_card` 创建 title=「E2E 工具验证」的卡片」。

结果（轮询 `/api/kanban/state`）：

```json
{
  "id": "card-ff6f1851",
  "title": "E2E 工具验证",
  "summary": "由 DSH agent 通过 kanban 工具创建",
  "status": "running"
}
```

说明真实 agent 请求中包含 10 个 `kanban_*` 工具，且写入经 SSE 实时出现在看板（截图中「进行中」列可见）。

### 3.4 审批 → 会话回写 → agent 更新卡片（闭环）

1. API 建卡 `card-ddbc5176` 并绑定真实会话 `session-419ed43d…`，请求审批 `ap-50e81177`（选项：批准继续 / 停止）；
2. 在嵌入 UI 中展开卡片 → 选「批准继续」→ 备注「E2E 审批备注」→ 点「批准」；
3. 结果：
   - 审批状态 `approved`，`resolution: { optionId:"yes", label:"批准继续", comment:"E2E 审批备注" }`；
   - UI toast「审批已处理：是否继续执行发布？」；
   - 绑定会话 `running: true`，标题更新，说明决定文本已进入会话；
   - agent 随后通过工具把卡片移到 `done`、写入 result 与 `approval_resolved` 时间线（见展开卡与详情截图）；
4. console 0 error。

证据：`docs/assets/screens/approval-expanded.png`、`card-expanded.png`、`detail-drawer.png`。

### 3.5 视觉/响应式

| 场景 | 截图 |
| --- | --- |
| 真实 DSH 内、亮色宽屏 | `docs/assets/screens/embedded-board-light.png` |
| 真实 DSH 内、暗色宽屏 | `docs/assets/screens/embedded-board-dark.png` |
| 卡片展开 + 重要节点 | `docs/assets/screens/card-expanded.png` |
| 详情抽屉 | `docs/assets/screens/detail-drawer.png` |
| 列表视图 | `docs/assets/screens/board-list.png` |
| 竖屏 390 看板 / 列表 / 底部弹层 | `portrait-board.png` / `portrait-list.png` / `portrait-sheet.png` |
| 设计稿 mockup（6 态） | `design/screens/01-…06-*.png` |

## 4. 重载矩阵（来自 docs/02 实测）

| 改动 | 生效方式 |
| --- | --- |
| `lib/client.js` | DSH client HMR 自动热替换（开发期） |
| `lib/*.js`（服务端） | 必须重启 DSH 进程 |
| `cordis.patch.yml` / config | 重启 |
| `package.json` / 依赖 | 重新 `dsh plugin add` + 重启 |
| `web/dist` 静态资源 | 刷新页面即可（路由读磁盘） |

## 5. 未验证 / 风险

1. 未在真实 **desktop 应用重启** 后手测（隔离 web profile 已跑通；desktop profile 的额外 bundle 不影响插件依赖，安装后 `dump-config` 已验证组合树）。
2. 软键盘避让仅用 `dvh` 处理，未真机验证。
3. 屏幕阅读器 / 真实触屏未做人工测试；键盘路径用 Playwright 覆盖。
4. 超大看板（>500 卡）与高频 SSE 更新未做压力测试。
5. 旧版 DSH（无 `sessions`/`main` keyed slot）只保证降级不崩溃，未实机验证。
6. 未验证归档会话的回复行为（桥会返回 `SESSION_NOT_FOUND` 并提示重新绑定）。

## 6. 复跑

```bash
# 单元测试
npm test
npm --prefix web run test

# 本地联调（不依赖 DSH）
node scripts/dev-server.mjs --port 4599 --data /tmp/kanban-dev/data.json
# 浏览器打开 http://127.0.0.1:4599/dsh-kanban/

# 构建前端
npm --prefix web run build
```
