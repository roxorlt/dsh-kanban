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
| 自测 | Web vitest 15 文件 / 102 测试（新增 `boardWheel.test.ts` 16 例）；tsc 0 error；令牌 lint 8 CSS 0/0；build 成功；服务端 71/71 |
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

## 1.14 v0.7.3（已完成列内拖动落点）

| 项 | 结果 |
| --- | --- |
| 复现（隔离 dev-server，1440×1800 / 1028×1800，已完成 13 张） | 在「已完成」预览第 2 张按住拖到列体空白区松手：请求 `POST /cards/card-…/move {"column":"done","beforeId":"<列表最后一张>"}` → 卡片从位置 1 落到位置 11（共 13），预览里消失、进「查看全部 13」，同时弹 toast「已移动到「已完成」」；卡片 `completedAt` 被刷新 |
| 根因 | 空白区落点的 `dropTarget` 返回 `beforeId = 列表最后一张`（插到倒数第二，不是真正末尾）；已完成列只渲染最近 5 张，预览外都折进「查看全部」，松手即消失。同列拖回原处/松手在卡片自身也走同一路径（会静默改顺序、刷新完成时间、写「移到已完成」时间线）；其他列空白区落点也差一位（与末尾 2px 落点线不一致） |
| 修复 | `web/src/lib/grouping.ts` 用 `planCardDrop` 统一落点判断：① 同列空白区 / 卡片自身 → 返回 null（放回原位：不请求、不重排、不弹 toast、不写时间线）；② 同列拖到其他可见卡片 → 排序，落点与当前顺序相同也返回 null；③ 跨列拖进「已完成」空白区 → 插到列头（最近完成，预览可见）；④ 其他列空白区 → 真正末尾。`BoardView` 同步：落点提示线在已完成列内拖回空白时不画、跨列拖进已完成画在首张卡片之前、其他列画在末尾 |
| 自动化实测（Playwright + 真实 Chrome，源码 dev-server，1440×1800） | A1 同列第 2 张 → 空白区：drop 事件触发 1 次、`/move` 请求 **0**、位置 1→1、预览完全不变、toast 0；A2 拖回自身：请求 0、顺序不变；A3 同列第 1 张拖到第 4 张卡：`afterId` 请求 1 次、位置 0→2、仍在预览内；A4 跨列（待你确认→已完成空白）：请求体只有 `column/version`、落在完成列表位置 0（预览第 1 张）；A5 跨列（待你确认→进行中空白）：`afterId=最后一张`、落在末尾；A6 落点线：已完成列内拖回空白 0 条线、跨列进已完成 1 条线且在首张卡片前、其他列 1 条线在末尾；console 0 error |
| 真机宿主实测 | 真实桌面宿主 `/dsh-kanban/`（1028×1800，已完成 20 张，真实数据）把预览第 2 张「卡片的“摘要”文案…」拖到列体空白区松手：**0 个写请求**、位置 1→1、预览列表完全不变、无 toast、console 0 error |
| 自测 | Web vitest 15 文件 / 107 测试（新增 `planCardDrop` 8 例）；tsc 0 error；令牌 lint 8 CSS 0/0；build 成功；服务端 71/71 |
| 截图 | `design/screens/board-drag-done-cross-drop-top.png`（跨列拖进已完成：落点线在首张卡片前）、`board-drag-done-same-no-drop-line.png`（同列拖回空白：不画落点线） |

## 1.10 v0.8.0（handoff 交接摘要）

| 项 | 结果 |
| --- | --- |
| 服务端 | `node --test` 71/71：normalize 截断/服务端 at/by、PATCH 写入/覆盖/null 清除/非法、活动、存储 roundtrip、工具 schema |
| Web | vitest 16 文件 / 110 测试；tsc/build/令牌 lint 全绿 |
| 真实宿主 | 给卡片写 handoff 后：看板徽标「交接」出现、详情「交接摘要」含 summary/后续/写入时间/来源会话/写入者；点「开始推进」创建的会话文本逐字包含 `【交接摘要】` + summary + `后续：nextSteps`，agent 继续处理；console 0 error |
| 清除 | `handoff:null` 清除并追加「清除了交接摘要」活动，卡片状态不变 |
| 截图 | `handoff-badge.png`、`handoff-detail.png`、`handoff-drawer.png`、`handoff-prompt.png` |

## 1.15 v0.9.0（优先级/标签从界面隐藏）

| 项 | 结果 |
| --- | --- |
| 决策 | 用户审批选择「先隐藏，保留 API 与数据」（ap-3c40b051 / option-3）；不做数据迁移，旧卡片字段原样保留 |
| 改动面（仅 Web） | 新建/编辑表单去掉「优先级」「标签」；看板卡去掉 P0–P3 徽标与标签；列表行去掉标签；详情抽屉去掉优先级 pill 与标签；筛选菜单只剩「项目」；列表分组只剩「状态 / 项目」；搜索不再匹配标签；i18n 键与 `kb-priority` / `kb-list__labels` CSS 清理。服务端 `lib/`、HTTP API、`kanban_*` 工具与数据字段未动 |
| 自动化 | 服务端 `node --test` 85/85；Web vitest 17 文件 / 136 测试；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 CSS 0 error / 0 warning |
| 真实 dev-server（隔离数据 `/tmp/dsh-kanban-v09`，demo 8 卡，CDP + headless Chrome 1440×900） | DOM 断言：`.kb-priority` 0 个、`.kb-card-props .kb-tag` 0 个、`.kb-list__labels` 0 个；分组选项只有「状态 / 项目」；筛选浮层分组只有「项目」；新建表单字段为 标题/摘要/工作区/执行目录/项目/列/会话，无「优先级 / 标签」；console 0 error |
| 真实数据回归（用户 `~/.dsh-kanban/data.json` 只读副本，41 张卡、8 个会话运行中） | 看板卡片数与列计数正常（共 41 张）；`.kb-priority` 0 个、`.kb-card-props .kb-tag` 0 个、项目属性仍显示 24 个；打开详情抽屉 chips 只剩状态（待办），无优先级/标签；console 0 error |
| API 保留验证 | `GET /api/kanban/state` 仍返回 `priority: "medium"` 与 `labels: ["ui","nice-to-have","示例"]`；旧卡片数据未迁移，随时可恢复展示 |
| 截图 | `docs/assets/screens/v0.9-board-no-priority-labels.png`、`v0.9-list-no-priority-labels.png`、`v0.9-filter-no-label-group.png`、`v0.9-form-no-priority-labels.png`、`v0.9-real-board-hidden-fields.png`、`v0.9-real-drawer-hidden-fields.png` |

## 1.16 v0.9.1（「待你确认」选项文案溢出 → 2 行截断 + hover/长按看全文）

| 项 | 结果 |
| --- | --- |
| 决策 | 用户在审批中选择方案 C：选项文案最多 2 行（省略号），hover/长按看全文；不增加卡片高度，键盘 focus-visible 同样能看到完整文案 |
| 根因 | `.kb-decision-options` 是纵向 flex + `max-height: 260px` 滚动容器，选项显式 `min-height: 28px` 覆盖自动最小尺寸；长文案换行后需 84–132px，被 flex-shrink 压到 61–99px，文字 `overflow: visible` → 溢出边框、被下方选项背景遮住（1180–1280px 同文案 3/3 溢出 15–44px） |
| 修复 | 选项 label/desc 各 2 行 clamp + `overflow-wrap: anywhere`；新增 `DecisionOption`（截断检测 + portal/fixed 提示气泡 + 下方放不下翻转 + 视口夹取 + hover 320ms / focus-visible / 长按 450ms + 抬起 click 抑制 + 长按滑动取消）；`.kb-decision-options > .kb-decision-option`、`.kb-decision-questions > .kb-decision-question` 设 `flex: none`；详情抽屉内取消截断与限高；暗色气泡令牌 |
| 自动化 | Web vitest 19 文件 / 158 测试（新增 `tooltipPosition` 8 例、`longPress` 10 例）；tsc 0 error；`vite build` 通过；令牌 lint 9 CSS 0 error / 0 warning；服务端 89/89 |
| 隔离 dev-server（demo + 复现卡；1440/1280/1180/1100/390） | 选项溢出 0（修复前 3/3 溢出 15–44px）；hover 320ms 弹完整 label+description，移开/滚动/Esc/点外部收起；键盘 Tab 到选项（focus-visible）弹提示；移动端长按 450ms 弹提示、不误选中、长按中滑动取消；未截断选项不弹；超长无空格串折行且 `pageScrollWidth=clientWidth`；近底部翻到上方；抽屉内全文展开（无 clamp、无选项内滚动）；暗色气泡 bg `rgb(53,54,56)` / 文字 `rgb(249,250,251)`；中英界面；console 0 error |
| 真实宿主 `/dsh-kanban/`（真实待确认卡 card-032f9d01） | 重新构建后刷新：选项无溢出；hover 气泡与长按提示可读、未被裁剪；详情抽屉内全文展开；console 0 error |
| 版本/文档 | v0.9.1；`docs/03` §7.19 + §10.3 #9；本表；CHANGELOG |
| 提交 | 未创建 git 提交：工作区仍有并行会话在途改动（审批面板翻页重做 / 原生收件），避免混提交，待其收尾后单独提交（同 v0.9.0 卡的处理方式） |
| 截图 | `design/screens/approval-option-clamp-hover-1280.png`、`approval-option-clamp-longlabel-1280.png`、`approval-option-clamp-longpress-390.png`、`approval-option-clamp-dark-1440.png`、`approval-option-clamp-flip-1280x430.png`、`approval-option-drawer-fulltext-1440.png`、`approval-option-real-host-*.png` |

## 1.17 v0.9.2（多题审批逐题翻页 + 每题自定义回答；摘要上限 600）

| 项 | 结果 |
| --- | --- |
| 反馈 | 用户：多题审批把两道题的选项纵向叠在卡片里，底部只有一个「统一备注」输入框；选项都不符合需求时在备注里写了诉求，提交仍被「第 N 题还没有选择」拦住——备注不算作答，交互不完整。建议：① 多题之间翻页，一次只展示一题；② 输入框默认不展示，每题固定一个「其他」选项，选中后再展开并自动聚焦 |
| 交互改版 | 一次一题（头部 pill「第 N / M 题」+ 上一题 / 题号进度点 / 下一题）；每题选项末尾固定「其他（自行填写）」→ 选中后原地展开输入框、自动聚焦、≤600 字计数；统一备注默认收起为「添加备注（可选）」；校验两种失败分别跳题并聚焦（没选任何东西 / 选了其他但没填）；卡片内取消「题目区 + 选项区」两层内部滚动，面板自然长高由列体滚动 |
| 数据/服务端 | `ApprovalAnswer.custom`（≤600 字）；resolve `answers[].custom`；每题「至少 1 个选项」或「custom 非空」，单选互斥；rejected 需「选中选项全为拒绝语义且无任何 custom」；拍平 `optionIds/labels` 只含真实选项；旧数据/旧调用方兼容；时间线追加「+ N 题自定义」，会话全文按「题目标签：选项；自定义：文本」拼接 |
| 摘要上限 | `summary` 240→600：服务端 `LIMITS.summary`、`kanban_create_card` / `kanban_update_card` schema 描述、Web 表单 `maxLength` 同步；新建/编辑表单标题行右侧新增「已用 / 600」计数；折叠卡仍两行截断、列表单行、抽屉全文 |
| 自动化 | 服务端 `node --test` 89/89（新增自定义回答校验/落库/判定、摘要上限 4 例）；Web vitest 19 文件 / 158 测试（`approvalQuestions` 14 例）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 CSS 0 error / 0 warning |
| 隔离 dev-server（`/tmp/dsh-kanban-v091`，demo 8 卡，CDP + headless Chrome） | pill 1/3→2/3→3/3、进度点 3 个；备注默认收起（`.kb-decision-note-block` 0 个）；选中「其他」→ 输入框出现、`document.activeElement` = 自定义 textarea、计数 `0 / 600`；Q1 已答、Q2 选了其他但留空时提交：停在「第 2 / 3 题」、红框、提示「第 2 题选了「其他（自行填写）」，请填写具体内容」、焦点回到输入框；填入后计数 20/600；提交后 `resolution.answers` = 两条 custom + 一条 option，拍平 optionIds=`['ready']`，status=approved，已解决态显示「自定义：」；抽屉内翻页按钮 2 个 / 进度点 3 个 / 备注默认收起；390×844：pill 1/2→2/2、其他选项、聚焦输入、15/600 计数；摘要表单 `maxLength=600`、`0 / 600`→`540 / 600`；API 直提 500 字摘要成功；console 0 error |
| 生效方式 | 含服务端改动，需重启 DSH；只刷新页面会继续用旧服务端（旧服务端不接受单题 custom，UI 会收到 400） |
| 版本/文档 | v0.9.2；CHANGELOG；`docs/03` §2.5.1 / §5 两行；`docs/contracts/01` §3.z + `ApprovalAnswer.custom` + summary；`docs/contracts/02` resolve 行 + summary 说明；本表 |
| 提交 | 未创建 git 提交：工作区仍有并行会话在途改动，避免混提交 |
| 截图 | `design/screens/v0.9.2-approval-pager-card.png`、`v0.9.2-approval-custom-required.png`、`v0.9.2-approval-filled.png`、`v0.9.2-approval-resolved-custom.png`、`v0.9.2-approval-drawer-pager.png`、`v0.9.2-summary-counter.png`、`v0.9.2-mobile-approval.png`、`v0.9.2-mobile-custom-filled.png`、`v0.9.2-mobile-page2.png`、`v0.9.2-dark-form.png` |

## 1.18 v0.9.3（详情抽屉「执行目录」路径截断 + 抽屉加宽）

| 项 | 结果 |
| --- | --- |
| 现象（真实宿主 `/dsh-kanban/`，1440×900，卡片 cwd=`/Users/roxor/Desktop/dsh/dsh kanban`） | 详情抽屉 →「新建会话」表单里，「执行目录」输入框只显示到 `/Users/roxor/Desktop/dsh/dsf`：输入框内容宽 196px、路径需 247px，末尾 51px 被裁；1028×1800 竖屏（抽屉 380px）只显示到 `/Users/roxor/Desktop/dsh/ds`，裁约 81px。新建/编辑卡片弹窗同字段输入框 233px、裁 14px（`…/dsh kanb`）。三处都没有 hover 提示 |
| 根因 | 两处表单都用 `.kb-form__row` 两列栅格并排「工作区 + 执行目录」。抽屉正文内容宽 428px（460 抽屉）/348px（380 抽屉），减表单内边距 20 后两列各 203px / 166px；12px 等宽字体下该路径需 247px，输入框单行显示时末尾被裁。弹窗固定 520px、两列各 233px，同样差 14px |
| 修复 | 路径类字段改整行：新增 `.kb-form__row--stack`（单列栅格），抽屉「新建会话」表单与新建/编辑卡片弹窗都变成「工作区」一整行 +「执行目录」一整行 + 建议 chips。改后输入框宽 344–478px，`scrollWidth = clientWidth`（0 裁切） |
| hover 提示 | 执行目录输入框（抽屉/弹窗）、详情元数据「工作目录」、抽屉会话标题截断处、产物路径补 `title`；工作区下拉的每个选项也带完整 `title`（含 workspace path）；产物路径允许行内换行，长路径不再顶出抽屉 |
| 抽屉宽度（按卡片「右侧抽屉样式」拍板 option-1） | `clamp(380px, 34vw, 460px)` → `clamp(400px, 36vw, 520px)`：1440px 下 460→518.4px、1512→520px、1028 竖屏 380→400px、900→400px；<720 仍是底部弹层全宽。同一张 17 段正文的长卡片在 1440：平均行数 3.00 → 2.59（**-14%**）、最高 13 → 11 行；会话标题可用宽 328 → 388px（完整显示需 358px 的会话名） |
| 自动化实测（CDP + 真实 Chrome，隔离 dev-server，同一张测试卡） | 加宽后抽屉：1440×900 = **518.4px**（表单 1 列 464px、输入 462px、裁切 **0**）、1512×982 = **520px**、1028×1800 = **400px**（表单 346px、输入 344px、裁切 0）、900×900 = 400px、390×844 = 底部弹层 390px（输入 334px、裁切 0）；卡片弹窗 520px（输入 478px、裁切 0）。上述尺寸 × 中英 × 亮暗下元数据「工作目录」`scrollWidth = clientWidth`、抽屉内无任何截断元素缺 `title`；`title` 与完整值逐字一致；console 0 error |
| 真实宿主实测（`/dsh-kanban/`，真实 42 张卡，刷新即生效） | 打开「右侧抽屉样式」：1440×900 抽屉 **518.4px**，「元数据 / 工作目录」= `/Users/roxor/Desktop/dsh/dsh kanban` 完整、带 `title`；新建会话表单 1 列 464.4px、执行目录输入 462px、裁切 **0**；会话标题被截断处有 `title`；抽屉内**无任何截断元素缺 `title`**。1028×1800（抽屉 **400px**）：表单 346px、输入 344px、裁切 0。真实最长卡片（「一直用看板新建卡片…」）在 1440：平均正文行数 3.0 → 2.0、最高 7 → 6 行、摘要 7 → 6 行；会话标题从 328px（截 36px）变为 386px（完整）；抽屉加宽前后同屏对比见截图 |
| 自测 | Web vitest 16 文件 / 110 测试；tsc 0 error；令牌 lint 8 CSS 0/0；build 成功；服务端 71/71 |
| 分支 | `fix/drawer-path-width` 提交 `4a2978b`（基于 v0.8.0，含 dist/文档/CHANGELOG/截图，便于单独合并） |
| 截图 | `design/screens/web-drawer-cwd-before-1440.png` / `-after-1440.png`（同一张卡，抽屉 460→518px 且路径由截断变完整）、`web-drawer-cwd-before-1028.png` / `-after-1028.png`（380→400px）、`web-card-modal-cwd-before-1440.png` / `-after-1440.png`、`web-card-modal-cwd-after-1028.png`；真实宿主：`web-drawer-cwd-real-host-after-1440.png`、`web-drawer-cwd-real-host-after-1028.png` |

## 1.19 v0.9.4（卡片状态点 / 审批选项圆点与文案竖直对齐）

| 项 | 结果 |
| --- | --- |
| 现象（用户截图） | 待办、待你确认、已完成三列首卡标题左侧状态点均高于标题首行文字中心约 5.5px；同屏「待你确认」列长选项「仅手动：详情里点「归档会话」(推荐)」的圆点留在第一行、文案掉到第二行，错位 21px |
| 根因 A（3 个卡片状态点） | `.kb-card-head` 为 `align-items: flex-start`，标题 14px/20px、状态点 8px，需要 `margin-top: 6px` 才能对齐首行中线；v0.1 起就有 `.kb-card-head__dot { margin-top: 6px }`，但 `KanbanCard.tsx` 的圆点从未带这个类（只有 `kb-dot kb-dot--${tone}`），属于死样式，圆点停在 flex 行顶 |
| 根因 B（1 个审批选项圆点） | `.kb-decision-option` 是 `flex-wrap: wrap`，13px 圆点与 label 同行；label 没有 `flex` / `min-width`，按 max-content 量宽（约 201.17px）。1200×1022 下选项宽 223px，圆点右侧只剩约 197px，浏览器把整块 label 挪到下一 flex 行，圆点孤零零留在第一行 |
| 修复 | ① `KanbanCard.tsx` 圆点补 `kb-card-head__dot` 类；② `.kb-decision-option__label` 增加 `flex: 1 1 0; min-width: 0`，label 占满剩余宽度并在自身内部换行（继续受 2 行截断约束），description 仍独占一行 |
| 自动化实测（隔离 dev-server + Chrome，DPR 2，`design/screens/align-*`） | 修复前：1440×900 三列首卡状态点偏差 **-5.5px**、选项不换行；1200×1022 状态点 **-5.5px**、长选项换行 **2 个**、圆点与 label 首行偏差 **21px**。修复后：1440 / 1280 / 1200 / 1100 / 1028 / 900 / 839 / 720 / 390 × 亮暗全部 **状态点偏差 +0.5px（≈0）**、**选项换行 0**、**圆点/label 偏差 0px**、选项盒溢出 0、列头图标偏差 0、console 0 error |
| 自测 | Web vitest 19 文件 / 158 测试；`tsc --noEmit` 0 error；令牌 lint 9 CSS 0 error / 0 warning；服务端 `node --test` 89/89；`vite build` 成功（`web/dist` 已重建） |
| 生效方式 | 纯前端类名/CSS 改动，**刷新看板即可**（无需重启 DSH；宿主按 `no-store` 返回 index.html、资源带内容哈希） |
| 截图 | `design/screens/align-fix-before-after.png`（前后对照总图）、`align-card-dot-before-1440.png` / `align-card-dot-after-1440.png`、`align-option-before-1200.png` / `align-option-after-1200.png`、`align-option-after-1200-dark.png`、`align-option-after-390.png` |

## 1.20 v0.9.5（审批提交即改列）

| 项 | 结果 |
|---|---|
| 反馈 | 用户：在「待你确认」提交选项后卡片一直还在「待你确认」列，预期应立即进入对应列（继续处理→进行中、已完结→已完成），重点是「没有立即变更状态」而不是写死「进行中」 |
| 复现（修复前） | 建卡 running → 请求审批后 `status=needs_you` → `POST .../resolve` 返回 `approval.status=approved`，但 `card.status` 仍是 `needs_you`、仍在「待你确认」列 |
| 根因 | `lib/domain.js#resolveApproval` 只写审批结果与时间线，不改 `status`/`cardOrder`；契约旧文案「解决后卡片仍留在 needs_you」 |
| 规则（按设计文档 §2.5 / §7.2） | 最终一条 pending 审批提交后同事务迁移：选中选项声明 `outcome` 即进该列（running/backlog/done，多问按题序、多选取提交序第一个声明）；未声明时批准→`running`、驳回→`backlog`（自定义回答算批准）；追加 `status` 节点；仍有 pending / `blocked`/`failed` / 已归档 / 不在 `needs_you` 保持原状态 |
| 单测 | 合并后服务端 94/94（新增：默认回进行中、outcome done/backlog、驳回回待办、多题/多选声明、仍有 pending 留原列、blocked 保持、非法 outcome 400、旧数据宽松读取丢弃坏 outcome） |
| Web | 提交瞬间乐观移列（`approvalOutcome.ts` 纯逻辑，7 例单测）；失败回滚并 toast；`DecisionOption` 对声明 outcome 的选项显示「提交后进入「已完成」」；合并后 vitest 20 文件 / 165 测试，tsc 0 error，build 通过，令牌 lint 9 CSS 0/0 |
| 真实浏览器（合并后主仓库源码 dev-server + dist；Chromium 1440×900；Playwright） | ① 选项 hint「提交后进入「已完成」」可见；② 点「批准」（`outcome:"done"`）后 250ms 内卡片在「已完成」列、服务端 status=done、时间线 `审批已提交，卡片进入「已完成」`；③ 未声明 outcome 的审批提交后回「进行中」；④ 点「拒绝」后回「待办」；⑤ 刷新后三张卡片仍在目标列且「待你确认」列清空；⑥ 多题审批「自定义回答 + 选项」提交后按批准回「进行中」（服务端 status=running）；⑦ console 0 error |
| 截图 | `design/screens/approval-outcome-hint.png`（选项去向提示）、`approval-outcome-move.png`（提交后立即出现在已完成列 + 未绑定会话兜底）、`approval-outcome-columns.png`（刷新后：待办/进行中/已完成三列 + 待你确认清空） |
| 生效方式 | 含服务端改动（`lib/domain.js` / `lib/tools.js`），需重启 DSH；仅刷新页面会继续用旧服务端（旧服务端不改状态，乐观移列会被刷新回滚） |
| 提交 | `814c17e`（合并 `fix/approval-resolve-outcome` → v0.9.5） |

## 1.21 v0.10.0（决策日志，2026-10-23）

| 项 | 结果 |
|---|---|
| 范围 | 只记录正式审批（请求 / 提交 / 未提交关闭）；不含受阻 / 失败卡、手动移列、agent 自行决策。本轮只负责保存原始数据，不做总结与自动处理。 |
| 存储 | 新增 `lib/decisions.js`：`<dataDir>/decisions.jsonl`（默认 `~/.dsh-kanban/decisions.jsonl`），一行一个 JSON 事件，只追加、不修改、不删除、无条数上限，权限 `0600`；与 `data.json` 同目录但不并入。 |
| 写入顺序 | `store.update()` 同一事务内先 append 日志（`fsync`），再原子写 `data.json`；日志可能领先数据、不会少记；日志写失败 → 本次操作中止（`DECISION_LOG_IO`），`data.json` 不提交（测试用同名目录占住日志文件验证 revision 与审批均未变）。 |
| 事件 | `approval_requested`（请求快照）、`approval_resolved`（决定 / 选项 / 自定义回答 / `waitedMs` / `outcomeColumn`）、`approval_unresolved`（`archived` / `left_needs_you` / `trimmed` / `data_reset`），另有标记事件 `log_initialized` / `data_reset`。 |
| 环境 | 本机 macOS 26.3（arm64）、Node v22.22.2；未启动/重启用户正在运行的 DSH GUI。 |
| 回填（真实数据副本） | 把 `~/.dsh-kanban/data.json` 只读复制到 `/tmp/dsh-kanban-v010-smoke/data.json`（副本含 45 张卡、295 条活动、13 条审批 = 12 条已决 + 1 条 pending；复制只读，本次验证未写入原文件），执行 `node scripts/dev-server.mjs --port 4610 --data /tmp/dsh-kanban-v010-smoke/data.json` → 输出 `[决策日志] 已回填 26 条历史事件`；`/decisions/meta`：`entries=26`、`skippedLines=0`、`byType` 为 13 `approval_requested` / 12 `approval_resolved` / 1 `log_initialized`、`waiting=1`、`revision=255`。 |
| 列表接口 | `GET /decisions`：`total=26`、`filtered=26`、`waiting=1`；`limit=3` 时 `hasMore=true` 且 `nextBefore` 为有效事件 id。`state=waiting` 命中 1 条「归档触发：已完成卡片的会话如何触发归档？」（`source=backfill`、`cardStatus=needs_you`）。 |
| meta / 导出 | `GET /decisions/meta` 200；`GET /decisions/export` 200，`content-type: application/x-ndjson; charset=utf-8`、`content-disposition: attachment; filename="decisions-20261023.jsonl"`、`content-length=52748`；下载文件与 `decisions.jsonl` 逐字节一致（`cmp` 无差异），共 26 行。 |
| 错误码 | `type=nope`、`state=pending`、`source=seed`、`since=abc`、`cardId=bad`、`before=dec-ffffffffffff` 均返回 `400 BAD_REQUEST`。 |
| 不重复回填 | 同一副本目录再次启动 dev-server：不再输出回填行（日志中已有 `log_initialized` 标记），`/decisions/meta` 仍为 `entries=26`；`/health` 的 `version` 为 `0.10.0`。 |
| 回填去重 / 历史遗留 pending | 回填按确定性 `id` 去重、收口感知（已有 resolved/unresolved 不再补）；历史遗留 pending 与回填在同一个 `store.update` 事务内静默置为 `dismissed`，启动窗口 live 写不会交错，重复启动幂等；单测覆盖「先有实时事件再回填」「重复 id 分页不死循环」「遗留 pending 同步」「启动回填 + live 归档只产生一条收口」等。 |
| 评审加固（P2） | 坏行后 seq 不重号；已有文件 append 时收紧为 0600；导出返回原始字节（invalid UTF-8 不替换）并与写队列串行；`data_reset` 与 seed demo 补请求顺序按契约记录；首启 / seed demo 的种子卡先规范化，首个生命周期即可请求审批。 |
| 单测 | `npm test` **127/127**（`test/decisions.test.mjs` 新增 23 例；`domain` / `store` / `routes` / `tools` / `index` 各自增量）。 |
| 真实宿主首次启用（2026-10-27 重启到 v0.11.0 后） | `/api/kanban/decisions/meta`：`exists=true`、`sizeBytes=63485`、`entries=31`、`byType={approval_requested:15, approval_resolved:15, log_initialized:1}`、`waiting=0`、`skippedLines=0`；说明恢复启动回填与实时写入在真实宿主可用。列表 / 导出 / 只读工具与「新审批提交后落两条事件」已由 2026-10-28 验收行补齐。 |
| 真实宿主验收补齐（2026-10-28，宿主 **v0.13.0**，桌面 DSH 13:57 重启、端口 49463） | `GET /api/kanban/health` → `version:"0.13.0"`（v0.10 决策日志能力随 v0.11 / v0.12 / v0.13 一并加载）。`decisions.jsonl` **37 条** = 回填 26（含 `log_initialized`，`counts.entries=25`）+ 实时 11；`/decisions/meta`：`entries=37`、`skippedLines=0`、`waiting=0`（与看板待确认 0 一致）、`byType={approval_requested:18, approval_resolved:18, log_initialized:1}`、权限 `0600`、`data.json` 无 `__decisions` 字段。`GET /decisions`：`limit=3` 时 `hasMore=true` / `nextBefore` 有效；`type`、`state=resolved`、`cardId` 筛选命中；非法 `type` / `state` / `since` → `400 BAD_REQUEST`。`GET /decisions/export`：`content-type: application/x-ndjson; charset=utf-8`、`content-disposition: attachment; filename="decisions-20261028.jsonl"`、`content-length=78184`，与 `decisions.jsonl` `cmp` 逐字节一致（37 行）。`kanban_decisions` 只读工具可读（返回 `file` / `hint`，`waitedMs` / `resolution.labels` / `outcomeColumn` 可查）。**新审批提交落两条实时事件**：验收卡在真实宿主发起审批 → `approval_requested`（`dec-18b4b8fe3ef9`，seq 36，`source=live`，revision 386，14:04:07 实时落盘）+ 用户提交后 `approval_resolved`（`dec-d60cc9eea645`，seq 37，`requestId=dec-18b4b8fe3ef9`、同 `approvalId=ap-d6a567b0`、`decision=approved`、`resolution.labels=["验收通过，继续收尾"]`、`waitedMs=4668596`（≈77.8 分钟）、`outcomeColumn=running`，15:21:55 实时落盘）。回填日志行：宿主从 Finder 启动、stdout 无持久日志，无法事后回看；以 `log_initialized` 事件（`counts.entries=25`）+ 后续多次重启未重复回填为等价持久证据。 |
| 生效方式 | 纯服务端改动（`lib/decisions.js` 新增，`store` / `domain` / `routes` / `tools` / `index` / dev-server 接线），**重启 DSH 后生效**；前端代码未改，无需重建 `web/dist`。 |
| 截图 | 无（后端数据能力，以命令输出与接口响应为证据）。 |

## 1.22 v0.11.0（会话归档联动，2026-10-23）

- 范围：卡片会话归档/恢复（详情操作 + 完成轻提示 + 停止并归档确认 + 批量/历史处理 + 已完成 7 天自动归档），会话复用不做。
- 服务端：`node --test` **137/137**；新增 `test/session-archive.test.mjs` 10 例，覆盖适配器能力探测/`stopActivity` 透传/错误映射（`SESSION_ACTIVE`/`SESSION_NOT_FOUND`/`SESSION_ARCHIVE_UNAVAILABLE`）、单卡预检（完成态/绑定/反向依赖）、批量预检（共享会话/已归档/`completedBefore`）、HTTP 归档/恢复/批量 dryRun+执行/无宿主 501 降级与时间线活动。
- Web：`tsc --noEmit` 0 error；`vitest run` **23 文件 / 215 例**通过（新增 `lib/sessionArchive.test.ts` 与 `api.archive.test.ts`，+2 文件/44 例）；`vite build` 通过；令牌 lint 9 个 CSS 0 错误 0 警告。
- 真实 Chromium E2E（临时 harness：真 `lib/routes.js` + 假 `workspaceRegistry` + 假父页面桥，嵌入模式）10 项断言全过：
  1. 完成卡归档成功（registry 归档集合包含目标会话）；
  2. 会话行切换「已归档 / 恢复会话」；
  3. 触发卡时间线写入 `session_archived`；
  4. 恢复会话成功（集合移除）；
  5. 运行中会话首次归档 → `SESSION_ACTIVE` 弹「停止并归档此会话？」，含「进行中的回合」与副作用说明；
  6. 确认后 `stopActivity:true` 归档成功；
  7. 共享会话被未完成卡阻塞：按钮禁用并显示「还有 1 张卡片未完成：进行中卡B」；
  8. 有待确认项的会话禁用归档；
  9. 已完成列「批量归档会话」dryRun 预览可归档 3 / 跳过 2（含原因）；
  10. 批量执行后历史卡片会话进入归档集合。
- 证据：`design/screens/session-archive-e2e-drawer.png`、`session-archive-e2e-batch-preview.png`、`session-archive-e2e-batch-done.png`。
- 真实宿主（桌面 `0.2.1-rc.2`）分两次核对：2026-10-27 09:06 重启到 v0.11.0 时确认 `health=0.11.0`、`/sessions/archive available=true`（29 个历史归档会话）；2026-10-27 15:53 重启到 **v0.12.0** 后完成完整 UI 走查（真实宿主 API + 真实 `web/dist`，经本地代理 + 假父页面桥置为嵌入模式；桌面窗口本身不可脚本化）：

| # | 清单 | 结果 |
| --- | --- | --- |
| 1 | health / archive 能力 | ✅ `health=0.12.0`、`GET /sessions/archive available=true`（归档集合 29 个） |
| 2 | 已完成卡详情归档 | ✅ 真实卡 `card-02d2dc3c`「合入 v0.12.0 多会话分支…」详情出现「归档会话」→ 归档成功；归档集合 +1；行内变「已归档 / 恢复会话」；时间线写入 `session_archived`「归档了会话，可在卡片详情恢复」。侧栏隐藏由 DSH 原生归档语义保证，桌面窗口未直接截图 |
| 3 | 恢复会话 | ✅ 点「恢复会话」后归档集合移除、时间线写入 `session_unarchived` |
| 4 | 运行中会话「停止并归档」 | ⚠️ 真实宿主当时唯一运行中的是本验收卡绑定的会话（不能停止），无安全可停止的运行中会话；该路径由隔离 harness E2E 第 5/6 项覆盖（`SESSION_ACTIVE` → 确认框 → `stopActivity` 成功），真实宿主留待自然场景观察 |
| 5 | 打开/回复已归档会话自动恢复 | ⚠️ 桥层自动恢复逻辑由 `lib/client.js` 实现并由 harness 覆盖；真实宿主需在桌面窗口内点开归档会话才能观察，本次未直接触发 |
| 6 | 批量归档 / 历史数据 | ✅ 真实数据 dryRun 预览「可归档 15 个 / 跳过 1 个（运行中的验收卡占用 session-b3295675…）」；执行后**真实归档 15 个已完成卡片的会话**（归档集合 29→44），代表卡时间线写 `session_archived`。`autoArchiveSessionsDays=7` 未到期限，自动通道本次未触发；历史数据由手动批量完成，后续自动通道同类逻辑复用同一执行器 |
| 7 | console | ✅ 页面 console error 0 |

- 说明：本次真实宿主批量归档的 15 个会话均属于已完成卡片，可在对应卡片详情逐个「恢复会话」；验收卡自身的会话因卡片仍在「进行中」被服务端正确跳过（反向依赖生效）。
- 证据：`design/screens/session-archive-host-before.png` / `-archived.png` / `-restored.png` / `-blocked.png` / `-batch-preview.png` / `-batch-done.png`（6 张，真实宿主数据）。

### 重启后复验清单（v0.11.0）—— 已完成

1. ✅ health / available（v0.11.0 与 v0.12.0 两次实测）。
2. ✅ 已完成卡详情归档 + 行内状态 + 时间线活动（真实宿主）。
3. ✅ 恢复会话（真实宿主）。
4. ⚠️ 停止并归档：harness 覆盖，真实宿主待自然场景（无安全运行中会话）。
5. ⚠️ 桥自动恢复：代码/harness 覆盖，真实宿主未直接触发。
6. ✅ 批量 dryRun + 执行（真实归档 15 个历史会话）；autoArchiveSessionsDays 未到期限未触发。
7. ✅ console 0 error。

## 1.23 v0.11.0（会话运行失败同步）

- 范围：卡片主会话某一轮运行失败（`error` / `interrupted` / 退出账号 `aborted`）→ 时间线写 `error` 节点 + 「进行中」自动置「失败」（进「待你确认」）；同一会话下一轮正常完成 → 自动回「进行中」并保留失败记录；只同步主会话，手工置失败不自动恢复。
- 取证：本次反馈的绑定会话第 3/4 轮 `turn/end` 为 `reason.kind=error`、`DeepSeek Messages transport failed`（`TRANSPORT`，宿主自动重试 5 次后终态失败，16:32 / 16:56 各一次）；失败期间卡片状态与时间线无任何反馈。
- 实现：`lib/session-sync.js` 监听宿主 `session/event`（`{ global: true }`，与 DSH 自身 api-session-controller 相同订阅方式）过滤 `turn/end`；`lib/domain.js` 新增 `recordSessionTurnFailure` / `recordSessionTurnRecovered`（+`mainSessionId` / `cardsByMainSession`）；`lib/index.js` 挂载（`sessionFailureSync:false` 可关闭）；Web 无改动（时间线已支持 `error` 节点与 `failed` 样式）。
- 单测：`node --test` **149/149**（本特性 12 例：判定口径、主会话/归档/非法输入、进行中→失败、同轮去重、非 running 只记节点、恢复回进行中、手工失败不恢复、监听器接线与容错、apply 接线集成、关闭开关）。
- dev-server 冒烟：`node scripts/dev-server.mjs --port 4xxx` 启动正常；`/api/kanban/health` 返回 `version=0.11.0`，`/api/kanban/state` 正常出 4 列数据（该通道不覆盖宿主事件，仅确认服务端加载无回归）。
- 真实宿主能力核对（桌面 `0.2.1-rc.2`，2026-10-27 09:06 重启到 v0.11.0）：`GET /api/kanban/health` 返回 `version: 0.11.0`，说明包含本特性的服务端已加载。
- 宿主库级失败复验（真实 DSH 0.2.1 的 `cordis` + `dsh-session`，从桌面宿主 `app.asar` 解包）：新增 `scripts/verify-session-sync.mjs`，把插件挂到真实 cordis、用真实 `SessionStore` 创建会话并 append `turn/start` + `turn/end`，**7/7 通过**：
  1. 失败后卡片自动置 `failed`；
  2. 时间线写入 1 条 `error` 节点；
  3. 节点带 `kind=session_turn_failure`、`turn=1`、`code=TRANSPORT`、原始 message；
  4. 同一轮重复事件不重复记录（去重）；
  5. 下一轮 `completed` 后卡片自动回 `running`；
  6. 恢复节点写入且失败记录保留；
  7. 插件真实注册 2 条路由 + 11 个工具（确认真加载）。
  复跑：`DSH_HOST_MODULES=<解包目录>/dsh/node_modules node scripts/verify-session-sync.mjs`。
- 真实 Electron 全链路：等宿主下一次自然失败时核对 `~/.dsh-kanban/data.json` 出现 `data.kind='session_turn_failure'`（修复目标即此类场景）；如需主动制造，可临时断网几秒后让某个绑定卡片的会话跑一轮。
## 1.24 v0.12.0（M2 多会话：主会话切换写时间线 + 回复/审批目标下拉，2026-10-27）

| 项 | 结果 |
|---|---|
| 背景 | 卡片卡 `card-680c0577`「M2 多会话回复目标与主会话切换」：多会话列表 / 设为主会话 / 回复·审批目标在 v0.2 已有，缺口是「主会话变更写入时间线」——旧实现点「设为主会话」只写通用「关联了 DSH 会话」，真实数据里同一会话重复 8 条且看不出切换；设计规范 §2.6/§7.5 要求 Composer 旁的目标下拉，旧实现是会话区单选 + Composer 只读文案 |
| 服务端 | `linkSession` 区分三种语义：新绑定（`session_linked`，已有主会话时文案带「设为主会话」+ `previousSessionId`）、设为主会话（新类型 `session_primary`「主会话切换为「X」」，含前后主会话）、已是主会话（幂等空操作，不写节点、不刷新卡片）。`POST /cards/:id/session` 响应补 `activity / linked / primaryChanged / primarySessionId`；`kanban_link_session` 输出 `primarySessionId` 与对应 hint |
| 单测（合并后） | 服务端 `node --test` **150/150**（分支新增多会话 domain 用例，扩展 routes 绑定/主会话/幂等、tools hint 断言；与主线的 149 条用例共存）；Web `vitest` **24 文件 / 225 测试**（新增 `replyTarget` 10 例：选项顺序与缺标题回退、目标解析、主会话切换后目标跟随）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 个 CSS 0 error / 0 warning |
| Web | Composer 上方新增「回复/审批目标」下拉（>1 会话 + 嵌入模式；主会话选项带「· 主会话」、运行中带「· 运行中」），替换会话区旧单选；会话行改两行（标题 + 主会话徽标 / 运行状态 + 完整 session id，窄屏省略并带 `title`）；`设为主会话` 后默认目标跟随（用户手动选过其它会话则保持）；多会话时审批区块显示「决定会发送到「X」」；回复与审批决定都按当前目标会话经桥发送 |
| 真实浏览器（隔离 dev-server + 宿主桥替身 + Chrome 1440×900 DPR2 / 390×844） | 24 项断言全过、console 0 error、0 个 4xx 请求：嵌入握手 embedded；会话列表 2 行且主会话徽标在首位；会话行显示完整 `session-m2-beta` / `session-m2-alpha`；旧单选 `.kb-session__target` 0 个；目标下拉默认主会话且选项为「执行会话 · 主会话」「讨论会话 · 运行中」；审批提示指向主会话；切换目标后高亮行与审批提示同步；点「设为主会话」后 1.2s 内时间线出现「主会话切换为「讨论会话」」、Toast「已设为主会话」、下拉默认值跟随、列表首位切换、服务端 `sessionIds=[alpha,beta]`、活动落库 `session_primary`（`previousSessionId=beta`）；回复经 `session.ensure` 发到选定目标；审批「批准」决定同样发到选定目标；390 底部弹层满宽、无横向溢出、目标下拉可见 |
| 截图 | `design/screens/m2-multi-session-drawer-1440.png`（两行会话 + 目标下拉 + 审批目标提示）、`m2-reply-target-switch-1440.png`（切到非主会话）、`m2-primary-switched-1440.png`（设为主会话后的时间线节点 + Toast + 目标跟随）、`m2-multi-session-sheet-390.png`（竖屏底部弹层） |
| 生效方式 | 含服务端改动（`lib/domain.js` / `lib/routes.js` / `lib/tools.js`），需**重启 DSH**；`web/dist` 已重建，刷新看板后前端生效（旧服务端仍能工作，只是不写 `session_primary` 且响应无新字段） |
| 提交 | 合并 `feat/m2-session-target`（ad30d2a）→ 主线；真实宿主复验见 §1.25 |

## 1.25 v0.12.0 合并主线与真实宿主复验（2026-10-27）

| 项 | 结果 |
|---|---|
| 合并 | `feat/m2-session-target`（ad30d2a）→ 主线合并提交 **`547f46c`**。解决 9 处冲突：`CHANGELOG` / `README` / `docs/04` / `docs/06` / `docs/contracts/01` 版本头与条目（v0.12.0 置顶、保留 v0.10/v0.11 条目）、`lib/domain.js` 的 `ACTIVITY_TYPES`（`session_primary` 与 `session_archived` / `session_unarchived` 共存）、`SessionSection`（保留归档/待确认徽标并把会话行改为两行 + 完整 session id）、`web/dist`（删旧产物后重建，不再保留分支构建）。版本号 `package.json` / `web/package.json` → **0.12.0** |
| 自动测试（合并后） | 服务端 `node --test` **150/150**（v0.12 多会话用例与 v0.10/v0.11 用例共存）；Web `tsc --noEmit` 0 error、`vite build` 通过、`vitest` **24 文件 / 225 测试**、令牌 lint 9 个 CSS 0 error / 0 warning |
| 服务端功能自检（合并后 `scripts/dev-server.mjs` + HTTP 脚本，11 项全过） | `health.version=0.12.0`；新绑定写 `session_linked`（已有主会话时文案「关联了 DSH 会话「X」，设为主会话」+ `previousSessionId`）；设为主会话写 `session_primary`「主会话切换为「讨论会话」」+ `previousSessionId=beta`；再次设置已是主会话 → 幂等（`activity:null`、时间线节点数不变、`sessionIds` 不变）；`sessionIds` 主会话置顶；v0.11 `/sessions/archive`、v0.10 `/decisions/meta`、comment 路由均正常（合并未破坏旧接口） |
| 合并后 UI 冒烟（Chromium，standalone dev-server） | 会话行按合并后的两行结构渲染（`.kb-session__main` 2 行、`.kb-session__id` 显示完整 id、主会话徽标 1 个），console 0 error |
| **真实 DSH 宿主 E2E（隔离 web 宿主 0.1.5-rc.2 + 真实插件 + Playwright/Chromium，4/4 验收 PASS）** | 环境：`DSH_HOME=/tmp/dsh-kanban-m2-host`、profile `kanban-dev`、`dsh plugin add` 链接本仓库、端口 5599、插件 `seed:empty` + `dataDir` 指向 `/tmp`；3 个**真实 DSH 会话**由详情「新建会话」经宿主桥创建（`session.create`），宿主桥握手 `embedded`/`ready=true`、49 主题令牌 |
| ↳ ① 设为主会话 → 时间线 + 服务端活动 + 幂等 | **PASS**：点「设为主会话」后服务端新增 `{"type":"session_primary","text":"主会话切换为「m2-b」","data":{"sessionId":"session-63a651b1-…","action":"primary","previousSessionId":"session-6f614821-…"}}`（节点数 2→3），抽屉时间线同步渲染该文案 + Toast「已设为主会话」，该行升到首位并带「主会话」徽标（主会话行不再渲染「设为主会话」）。对已是主会话的会话再绑定 → `{primaryChanged:false, activity:null, linked:false}`，`session_primary` 节点数 4→4 不变 |
| ↳ ② 目标下拉默认主会话 / 跟随 / 手动保持 | **PASS**：默认值 = `sessionIds[0]`（选项文案「m2-c · 主会话」，3 个选项覆盖全部绑定会话）；设 `m2-b` 为主会话后默认值自动变为 `session-63a651b1`（「m2-b · 主会话」）；先手动选 `session-521261a8` 再改主会话 → 默认值保持手动选择不被抢走；回复发出后下拉保持所选会话 |
| ↳ ③ 回复 / 审批决定发到下拉选中会话 | **PASS**：拦截 iframe→宿主 `kanban:request`：回复为 `method=session.ensure`、`params.sessionId=session-521261a8-…`（选中会话），审批为 `session.ensure`、`params.sessionId=session-63a651b1-…`，宿主均回 `ok:true`；服务端审批 `ap-9fe9458c` → `approved`、卡片回 `running`。独立旁证：解压隔离宿主会话存档（`session.v3.jsonl.zstd`），回复文本落在 C 会话、审批文本落在 B 会话，主会话 A（m2-c）没有这些文本。审批区块「决定会发送到「X」」随下拉逐项切换（3/3 命中） |
| ↳ ④ 390×844 弹层满宽 / 无横向溢出 / 下拉可见 | **PASS**：窗口 390×844 时 DSH 侧栏仍占 56px，看板面板区 334×844；抽屉 `left=0, right=334, width=334`（=面板区满宽，圆角 16px，高 776），`documentElement/body scrollWidth==clientWidth`、`overflowX=0`；目标下拉 `left=91, right=318`（完整可见）；关闭抽屉后看板同样无横向溢出 |
| 真实宿主统计 | console error **0**、4xx **0**；断言 phase3 15 PASS（其中 R3c 首轮为测试脚本期望写错——把会话 C 的标题写成 m2-c 且当时审批已结算导致 hint 为 null，已用新建审批在 phase5 复跑 **PASS**，产品行为正确）；phase4 390 5 项全过 |
| 真实宿主证据 | `design/screens/m2-merged-host-01-session1.png` … `13-390-approval-hint.png`（13 张：两行会话行、目标默认/跟随/保持、设为主会话时间线节点、回复/审批路由、审批目标提示、390 抽屉与看板）；机器可读结果 `/tmp/dsh-kanban-m2-host/results.json`、`results2.json`、`results3.json`；复跑命令见 §6 |
| 桌面 DSH 重启后真实宿主（**2026-10-27 09:41 重启**，端口 58243 → 64054） | `GET /api/kanban/health` → **`version:"0.12.0"`**、`dataDir:"~/.dsh-kanban"`、revision 308；真实数据 50 张卡正常读出；`/dsh-kanban/` 返回新构建产物 `assets/index-DEFL1SPt.js`（200，371 KB）与 `assets/index-I71DtbCt.css`（200，88 KB），与本地 `web/dist` 哈希一致；v0.10 `/decisions/meta`（entries 33、waiting 0）与 v0.11 `/sessions/archive`（`available:true`，29 个历史归档会话）均可用——说明重启后 v0.12 + v0.11 + v0.10 服务端共存 |
| 桌面宿主 v0.12 真实行为（HTTP，12 项 11 PASS + 1 项用 `force` 重试通过） | 在真实数据的桌面宿主上建临时卡 `card-dd9029e2` 并绑定两个真实会话：新绑定 A → `session_linked`「关联了 DSH 会话「复验会话 A」」；新绑定 B → 「…，设为主会话」+ `previousSessionId=A`；设 A 为主会话 → **`session_primary`「主会话切换为「复验会话 A」」**（`previousSessionId=B`、`linked:false`、`primaryChanged:true`）；再次设置 → 幂等（`activity:null`、时间线节点 4→4 不变）；时间线节点齐全（2×`session_linked` + 1×`session_primary`）；`sessionIds` 主会话置顶 `[A,B]`。临时卡随后归档清理（删除接口需乐观锁 version 或 `force:true`，非缺陷） |
| 桌面宿主 UI 渲染说明 | 桌面 App 窗口不可脚本化（无 CDP；本机未授予辅助功能权限），UI 渲染证据来自隔离真实宿主（上两行，同一 `web/dist` 与同一插件代码）；桌面宿主已确认返回同一份新前端产物，刷新看板即生效 |
| 生效方式 | v0.12.0 含服务端改动（`lib/domain.js` / `lib/routes.js` / `lib/tools.js`），需**重启 DSH**；`web/dist` 已重建，刷新看板即生效前端（旧服务端不写 `session_primary`，前端仍可工作）。**已于 2026-10-27 09:41 重启桌面 DSH 完成，health=0.12.0** |
| 已知口径 | 390「满宽」按**看板面板区**计（334px，DSH 侧栏在 390 宽仍占 56px 且「收起侧栏」按钮未渲染）；隔离真实宿主的渲染已覆盖，桌面 App 内 390 弹层因窗口不可脚本化未自动复核，可人工抽查 |

## 1.26 v0.13.0（卡片详情 Git 分支 / 工作树可视化，2026-10-27）

> 注：本版「两泳道示意」已被 **v0.14.0 的 Fork 风格多分支提交图**取代（见 §1.29）；本节与 `git-branch-*.png` 保留为 v0.13 历史证据。

| 项 | 结果 |
|---|---|
| 背景 | 卡片 `card-6f4b3d72`「卡片详情可视化展示 git 分支或 worktree 情况」：DSH 宿主用分支 / worktree 执行 coding 任务时，看板里看不出「这张卡片现在在哪个分支、哪个工作树、与主分支和远端差多少」。本版在**卡片详情抽屉**新增只读「分支 / 工作树」区块：当前分支与工作树、远端跟踪 ↑↓、主分支关系 ↑↓、Fork 风格的**两泳道提交图**（HEAD / 分叉点 / 共享主干）与多工作树列表；数据来自对卡片 `cwd` 的**只读 git 探测**，不落库、不改卡片字段（契约 `docs/contracts/06-git-context.md`） |
| 服务端 | 新增 `lib/git.js`（`collectGitContext`，512 行）：`execFile('git')` 不拼 shell，单条命令 2s / 整次 4s 超时、`maxBuffer=4MiB`、`GIT_OPTIONAL_LOCKS=0` + `LC_ALL=C`；主分支探测（origin/HEAD → main → master → origin/main → origin/master）、upstream 与主分支两套 base 模式、`git worktree list` 解析、提交列表上限（ahead 12 / behind 8 / shared 4）、refs 标记；`?cwd=` 候选只接受「与 `card.cwd` 同仓库 + 候选是 linked worktree + `card.cwd` 在主工作树」时才采用，其余静默回退到 `card.cwd`；失败一律收敛为 `available:false` + `reason`（`no_cwd` / `missing` / `not_git` / `no_commits` / `timeout` / `error`）。`lib/routes.js` 新增 `GET/HEAD /api/kanban/cards/:id/git?cwd=`（非 GET/HEAD 405、卡片不存在 404、业务失败仍 200）；`package.json` 的 `files` 已补 `lib/git.js` |
| Web | 新增 `web/src/lib/gitGraph.ts`（ahead/behind 按 `committedAt` 稳定合并且同时间戳先 ahead、shared 接后、分叉点、refs 同 sha 合并、**12 行上限优先保住分叉点** + 中段「还有 N 个提交」、单泳道退化、`shortenPath`）与 `useCardGit`（打开卡片按需请求；`?cwd=` 取卡片主会话 cwd；4s / 20 条 LRU 缓存；旧服务端 404 与失败静默隐藏）；`GitBranchSection.tsx`（chips + 两泳道 SVG + 多工作树列表，当前工作树高亮；`base.kind='main'` 时主工作树行不再显示自比 ↑0↓0）；接入 `DetailDrawer`（结果之后、审批之前）；`types.ts` / `api.ts` / `i18n.tsx`（zh/en 23 条 `git.*`）/ `drawer.css`（`kb-git-*`，仅 alias 令牌、0.5px 发丝线、全圆角配 `corner-shape: round`） |
| 单测 | 服务端 `node --test test/*.test.mjs` **162/162**（新增 12：`test/git.test.mjs` 8 例覆盖普通仓库 / detached / 分叉 + linked worktree / upstream 领先落后 / origin/HEAD 探测 / 11→8 工作树截断 / 提交上限 / 全部不可用原因 / `?cwd=` 采用与忽略；`test/routes.test.mjs` 4 例覆盖 404 / 405 / 200 available true·false / HEAD / 候选目录）。Web `vitest` **25 文件 / 249 测试**（新增 `gitGraph` 24 例：排序稳定、分叉点与 activeLanes、refs 合并去重、12 行截断优先分叉点与中段提示、单泳道、工作树计数隐藏、`shortenPath`）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 个 CSS 0 error / 0 warning |
| 真实仓库接口自检（dev-server + 临时 git 仓库） | 演示仓库：`main` 与 `origin/main` 分叉（本地领先 1 / 落后 1）、`feat/graph` linked worktree（领先 main 3 / 落后 1、本地 1 提交未推）、`feat/long` linked worktree（领先 main 15，验证 12 行截断仍能看到分叉点）。HTTP 验证：worktree 卡返回 `current.isWorktree=true`、`worktree=.worktrees/feat-graph`、`base.ahead=3/behind=1`、`upstream.ahead=1`、2 个工作树且 `isCurrent` 正确；主仓库卡返回 `base.kind=upstream`（origin/main ↑1↓1）、`commits` 计数与 `rev-list` 一致；`?cwd=` 传入 linked worktree 时被采用（`dir` 变为 worktree、`current.isWorktree=true`），跨仓库 / 方向相反候选被忽略；非 git 目录 / 无 cwd / 目录不存在分别返回 `not_git` / `no_cwd` / `missing`；未知卡片 404、POST 405 |
| 真实浏览器验收（Chromium 1440×900 DPR2 / 390×844，亮/暗，16 项断言全 PASS） | 打开 6 张真实卡片：① worktree 卡区块出现、6 行、分叉点、图例 `main / feat/graph`、refs 含 `HEAD` 与 `origin/feat/graph`、3 个工作树且当前高亮；② 主仓库卡 4 行、分叉点、`origin/main` ref；③ `feat/long` 卡 12 行、分叉点仍可见、中段「还有 3 个提交」（9 ahead + 3 shared）；④ 非 git / 无 cwd / 目录不存在三张卡区块整块隐藏；⑤ 暗色下区块与分叉点正常；⑥ 390 竖屏区块出现且抽屉 `scrollWidth==clientWidth`（无横向溢出），长 subject 省略、长路径靠 `title` 看全。全程 **console error 0、pageerror 0、4xx 0** |
| 截图 | `docs/assets/screens/git-branch-worktree-light.png`（worktree 卡：chips + 两泳道 + 分叉点 + 工作树列表）、`git-branch-main-light.png`（main vs origin/main）、`git-branch-fork-truncated-light.png`（领先 15 条、12 行上限下仍见分叉点与中段提示）、`git-branch-worktree-dark.png`、`git-branch-worktree-portrait.png`（390 竖屏）、`git-branch-board-light.png` / `git-branch-board-dark.png`（1440 看板 + 右侧抽屉全貌）、`git-branch-hidden-nogit.png`（非 git 目录：区块隐藏、无报错） |
| 生效方式 | 含服务端改动（`lib/git.js` / `lib/routes.js`），需**重启 DSH**；`web/dist` 已重建（v0.13.0），刷新看板后前端生效。旧服务端（< v0.13）没有 git 接口时，前端按 404 静默隐藏该区块，其余功能不受影响 |
| 分支 | `feat/git-branch-viz`（基于 `f65b4f1`；已合入主线 merge `97ad6da`，见 §1.27） |
| 已知限制 | 远端只识别 `origin`（无 origin 时只显示本地关系）；提交图只比较当前分支与主分支/上游两条线，不画任意多分支拓扑；抽屉打开期间不自动刷新（4s 缓存 + 打开时请求，契约 §1）；工作树列表上限 8 个（多余数量提示）；桌面真实宿主复验见 §1.27（合入主线并重启 DSH 后执行） |

## 1.27 v0.13.0 合入主线与真实宿主复验（2026-10-27 合入 / 10-28 重启复验）

| 项 | 结果 |
|---|---|
| 合并 | `feat/git-branch-viz`（`95762de`，v0.13.0）→ 主线合并提交 **`97ad6da`**。**无冲突**：分支基于 `f65b4f1`，合入时 main 恰好仍停在同一提交（v0.12 之后主工作区的并行改动已在 `f65b4f1` 内收口），卡面预判的 `CHANGELOG` / `README` / `docs/04` / `docs/06` / `package.json` / `web/package.json` / `web/dist` 冲突均未发生，`--no-ff` 一键干净合并 |
| 版本头 | `package.json` / `web/package.json` → **0.13.0**；`files` 含 `lib/git.js`；`CHANGELOG` v0.13.0 置顶；README 状态行 / 功能 / 已验证 / 截图表已含 v0.13 |
| dist 重建 | 合并后先删除旧产物（`rm -rf web/dist`）再 `npm --prefix web run build`（`tsc --noEmit && vite build`）：`index-D4ScdgBg.css`（93.79 KB，gzip 14.30 KB）/ `index-uM6BVSce.js`（376.16 KB，gzip 113.03 KB），与分支构建内容哈希一致（可复现），重建后工作树干净 |
| 合入后自测 | 服务端 `node --test test/*.test.mjs` **162/162**；Web `vitest` **25 文件 / 249 测试**；`tsc --noEmit` 0 error；令牌 lint 9 个 CSS 0 error / 0 warning |
| 桌面 DSH 重启后真实宿主（**2026-10-28 13:57 重启**，端口 56161 → **49463**，进程 PID 28038） | `GET /api/kanban/health` → **`version:"0.13.0"`**、`dataDir:"~/.dsh-kanban"`、revision 351；`/dsh-kanban/` 引用 **`assets/index-D4ScdgBg.css` / `assets/index-uM6BVSce.js`**，与本地 `web/dist` 同名且字节一致（93,791 / 383,470 B）——重启后加载的是合并后构建产物；真实数据 **52 张卡**正常读出。重启口径：首次提交「已重启」时宿主进程实际未退出（PID 32933 启动于 10-27 13:37、health 仍 0.12.0、端口仍 56161），macOS 上需 **⌘Q / 菜单「退出」** 真正结束进程后再打开，第二次重启才生效 |
| 真实卡「分支 / 工作树」区块（真实宿主 UI 脚本 **44/44 断言 PASS**） | 打开真实卡 `card-a57f6dbf`（cwd=主仓库）：区块出现；chips 3 个（分支 `main` 未推送 / 工作树「主工作树」/ 远端跟踪 `origin/main` ↑13↓0）；两泳道图 12 行 + 分叉点 1 个，refs `HEAD` / `main` / `origin/main`；**工作树列表 4 行**（`main` 当前 + `feat/fork-graph-viz` ↑14 / `feat/git-branch-viz` ↑11 / `feat/m2-session-target` ↑5），当前工作树高亮唯一；截图见下 |
| 演示仓库分叉场景（真实宿主 API 脚本 **42/42 断言 PASS**） | `node scripts/demo-git-repo.mjs` → 6 张临时卡：`feat/graph` linked worktree（`isWorktree=true`、base ↑3↓1、upstream 本地 1 提交未推、3 个工作树且当前高亮）；`feat/long` base ↑15（12 行上限下分叉点仍可见、中段「还有 3 个提交」）；主仓库 `base.kind=upstream`（origin/main ↑1↓1）；非 git / 目录不存在 / 无 cwd 分别返回 `not_git` / `missing` / `no_cwd`；真实 linked worktree（`.agents/worktrees/feat/git-branch-viz`）卡返回 `isWorktree=true`、分支 `feat/git-branch-viz`；临时卡全部归档，`/state` 无残留 |
| 隐藏与降级 | 非 git / 无 cwd / 目录不存在三种卡片抽屉中 `.kb-git` 整块隐藏且无占位；全程 **console error 0、pageerror 0、`/api/kanban/` 4xx/5xx 0** |
| 暗色 / 390 竖屏 | Chromium 1440×900 DPR2 暗色下区块与分叉点正常；390×844 竖屏区块出现，抽屉 `scrollWidth == clientWidth`（390/390）、区块 358/358，无横向溢出；长 subject 省略 |
| 旧接口回归 | 重启后 `GET /decisions/meta`（35 条、waiting 0）、`GET /sessions/archive`（`available:true`）与 v0.13 的 `GET /cards/:id/git` 共存；`/state` 52 卡正常 |
| 截图 | `docs/assets/screens/git-realhost-section-real-card.png`（真实卡区块元素级：chips + 两泳道 + 分叉点 + **4 工作树列表**）、`git-realhost-existing-card.png`（真实卡右侧抽屉全貌）、`git-realhost-worktree-light.png`（演示 linked worktree 全貌）、`git-realhost-worktree-dark.png`（暗色）、`git-realhost-worktree-portrait.png`（390 竖屏）、`git-realhost-hidden-nogit.png`（非 git 卡：区块隐藏、无报错） |
| 一次性脚本 | 真实宿主 UI 脚本 `/tmp/realhost-verify/verify.mjs`（44 断言 + `--expect-version` / `--real-card`）、API 脚本 `/tmp/lead-v013/realhost-check.py`（42 断言）、完整 results JSON 与原始截图均在 `/tmp/lead-v013/`，属一次性验证资产，未纳入仓库 |
| 生效方式 | v0.13.0 含服务端改动（`lib/git.js` / `lib/routes.js`），需**重启 DSH**；`web/dist` 已重建，刷新看板即生效前端。旧服务端（< v0.13）无该接口时前端按 404 静默隐藏。**已于 2026-10-28 13:57 重启桌面 DSH 完成，health=0.13.0** |

## 1.28 v0.10.0 原生待确认收件箱合入主线（2026-10-28）

| 项 | 结果 |
| --- | --- |
| 合并 | `feat/native-approval-inbox`（`71e602d`，标注 v0.10.0）→ `main`，合并提交 **`8035ba3`**（2026-10-28）。主工作区干净、其他会话的 v0.13.0 提交已全部落盘后执行 |
| 关键发现 | 该特性源码早已随 v0.9.4 收口提交（`ffe9ed4`）进入主线：`web/src/lib/nativeInbox.ts`、`NativeInbox.tsx`、`NativeAnswerModal.tsx`、`styles/inbox.css`、`test/client-pending.test.mjs`、`docs/contracts/04-native-inbox.md` 与分支**字节一致**，`App.tsx` / `bridge.ts` / `BoardView.tsx` / `lib/client.js` 也已含原生收件接线（取主线版本）。因此本次合并的实际增量 = CHANGELOG 的 v0.10.0 收件箱段 + `package.json` 的 `@deepseek-ai/dsh-client-ui-session` 注入声明 + 13 张 `docs/assets/screens/native-inbox-*.png`；**无代码 / 行为变更，无版本号变更（仍是 0.13.0）** |
| 冲突解决（11 个） | `package.json` / `web/package.json` 版本保持 **0.13.0**（仅补 `dsh-client-ui-session` 注入，与 `lib/client.js` 的 `ctx.inject(["uiSession"])` 对齐）；`lib/client.js`（保留 v0.11 的 `archivedSessionIds` 推送）、`web/src/App.tsx`、`bridge.ts`、`components/BoardView.tsx` 取主线；`README.md`、`docs/04-architecture.md` 取主线（主线是超集，§5.4 原生收件与代码地图齐备）；`docs/06` 分支的 v0.10 验证记录改写为本 §（原编号 1.15 与主线 v0.9.0 段冲突，按版本序另起 1.28）；`web/dist/index.html` 取主线并在合并后重建 |
| 卫生 | 丢弃分支误提交的 `web/node_modules` 绝对路径软链（120000 blob；合并检出时曾覆盖本地依赖目录，已 `npm ci` 重装 98 包）；丢弃分支携带的 `web/dist` 旧构建产物（`index-Bh9ckJyG.js` / `index-HKKRtcqK.css`） |
| 自动化复跑（合并后） | 根 `node --test` **162/162**；Web `vitest` **25 文件 / 249 测试**；`tsc --noEmit` **0 error**；`vite build` 通过且 `web/dist` 重建后文件名与字节同合并前（`index-uM6BVSce.js` / `index-D4ScdgBg.css`）；令牌 lint 9 CSS **0 error / 0 warning** |
| 真实宿主刷新验收（桌面宿主端口 49463，`health=0.13.0`） | 无头 Chromium 带宿主 auth cookie 打开 GUI → 侧栏「看板」→ iframe 实际加载 `./assets/index-uM6BVSce.js` + `./assets/index-D4ScdgBg.css`（= 合并后 dist），桥 `ready:true` / `pendingCount:0` / console error 0 / pageerror 0；随后在本会话发起一次真实 `ask_user_question`（自动验收探针）→ 看板「待你确认」列顶部「来自 DSH 会话」收件区出现该项（来源「Agent 提问」/「低风险」/ 会话名 / 关联卡片 /「1 个问题」）→ 看板内点「回答」→ 作答弹窗呈现 2 个选项 → 选「收件区作答链路 OK」→「提交全部回答」→ 收件项与弹窗消失、桥 `pendingCount` 归 0、toast「回答已提交」，同一份答案经宿主 pending 对象回送到发起提问的会话（工具返回 `{"answers":[{"id":"native-inbox-probe","selected":["收件区作答链路 OK"]}]}`） |
| 截图 | `design/screens/native-inbox-merged-realhost-01-board.png`（刷新后看板）、`-02-pending.png`（收件项出现）、`-03-modal.png`（作答弹窗）、`-04-answered.png`（作答后收件区归零）；同步 `docs/assets/screens/` |
| 脚本 | `/tmp/dsh-cdp/{cdp.mjs,accept-realhost.mjs}`（一次性验收脚本，未入库） |
| 已知事项 | CHANGELOG 的 v0.10.0 段现同时记录「决策日志」与「原生待确认收件箱」两个特性（两者代码都随 v0.10 上线，收件箱段为 2026-10-28 补记）；分支上旧测试计数（85/85、vitest 17/137）保留为分支时点记录，合并后以 §2 的 162/162、25/249 为准 |
| 生效方式 | 本次无服务端 / 前端代码变更，刷新看板即与主线一致；宿主版本仍是 0.13.0 |

## 1.29 v0.14.0（卡片详情「分支 / 工作树」升级为 Fork 风格多分支提交图，2026-10-27）

| 项 | 结果 |
|---|---|
| 背景 | 卡片 `card-6f4b3d72` 用户反馈：v0.13 的「两泳道示意」不是要的「像 Fork app 那样的图形化」——真实仓库里多张卡片分属不同分支 / 工作树，要一眼看到多分支拓扑。v0.14 把该区块重做为**多分支彩色泳道图**（本地分支 + `origin/*` 同图、合并/分叉曲线、ref 徽标、可滚动历史） |
| 服务端 | `lib/git.js` +232 行：响应新增可选 `git.graph`（契约 v0.2 §4.5）。引用选取 ≤10 条：HEAD → 当前分支 → 主分支 → `origin/<主分支>` → 当前 upstream → 工作树分支 → 其余本地分支（committerdate 倒序）→ 已列分支的 `origin/<branch>`；`for-each-ref` 单命令解析本地分支 `upstream:track`（ahead/behind/gone）；`git log --date-order --max-count=48`（含多父 `%P`）；`rev-list --count` 算 `truncated`；`refsTruncated` 统计被上限挤掉的引用。新命令失败只让 `graph:null`，v0.13 字段与 `available` 不受影响；3 条新命令仍在 4s 预算内（真实仓库实测 121–141ms） |
| 契约 | `docs/contracts/06-git-context.md` 升 **v0.2**：§3 响应 graph、§4.5 引用优先级 / for-each-ref / date-order / 截断语义、§5 Fork 风格渲染约定（种子泳道、lane 状态机、汇入/出弯、主干颜色稳定、8 色 token 调色板、320px 滚动、≤480px 窄屏规则）；`docs/contracts/02-http-api.md` §10 登记 |
| Web | 新增 `web/src/lib/forkGraph.ts`（16 例单测）与 `web/src/components/ForkGraph.tsx`，替换 v0.13 `gitGraph.ts` 两泳道实现并删除；`GitBranchSection` 重构为「chips（当前分支 / 工作树 / 远端跟踪 ↑↓ / 游离 HEAD）+ 引用图例 + ForkGraph + 多工作树列表」；`types.ts` / `api.ts` 增加 `graph` 类型与容错归一化（缺 graph = 旧服务端，整块隐藏）；`i18n.tsx` zh/en 各 20 条 `git.*`；`drawer.css` 换成 `kb-git__fork-*` + 8 色域（全部 alias 令牌）+ 行 hover + ≤480px 只保留 HEAD 行内徽标 |
| 布局算法 | 纯函数：refs 顺序做种子泳道（同 sha 共用）、lane 状态机 `{sha,color,active}`、提交取最左期望泳道、**第一父一律沿用当前泳道**（主干颜色稳定）、多泳道期望同一父提交时在父行画 `top→dot` 汇入曲线并释放多余泳道、其余父提交占空闲槽位 / 追加列、泳道序号不左移、空槽复用；8 色循环 |
| 单测 | 服务端 `node --test test/*.test.mjs` **170/170**（v0.14 新增 8 例：合并多父 + date-order 拓扑、引用优先级/去重/工作树分支/origin-HEAD 过滤、track 五种形态、48 条截断、refs 上限、老分支 tip 被截、detached HEAD）；Web `vitest` **25 文件 / 241 测试**（forkGraph 16 例：线性、两分支汇合、合并双父、主干颜色稳定、多泳道期望同一父可达、槽位复用/不左移、refs 同 sha、ref tip 不在 commits、HEAD、8 色循环、截断透传、空 commits、路径省略、工作树计数）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 CSS 0 error / 0 warning |
| 真实数据验收（Chromium 1440×900 DPR2 / 390×844，亮/暗，**26 项断言全 PASS**） | 数据 = ① 本仓库真实数据（10 refs / 40 提交 / 3 个合并提交 / 4 个工作树，`refsTruncated=1` → 图例「还有 1 个引用」）；② 多分支演示仓库（`node scripts/demo-git-repo.mjs --root /tmp/git-viz-verify/env`：5 分支 / 2 合并 / 3 工作树 / 18 提交，`origin/main` 与本地分叉、`feat/long` 长分支）。断言：区块出现；图例 ≥10 refs 且含 HEAD / main / origin/main / 工作树分支；提交行 40（真实）/ 18（演示）；合并双环 3 / 2；HEAD 外环 1；8 色 / 7 色全部出现；内部滚动 `scrollHeight 880 > clientHeight 320`；多工作树 4 / 3 行且当前高亮；抽屉与底部弹层无横向溢出；非 git / 无 cwd / 目录不存在三种卡区块整块隐藏；**console error 0、pageerror 0、4xx 0** |
| 主干颜色修复（联调发现） | 初版在真实数据上当前分支（main/HEAD，lane0 蓝）的主干历史在中段被 `origin/main`（lane1 绿）接管、颜色由蓝变绿，与图例不符。改为「第一父一律沿用当前泳道，父提交行再汇入并释放多余泳道」后，33 行 first-parent 主干全部保持 lane0/color0，捞入段出现在第 4 / 11 / 17 行；laneCount 仍 8（无多余列）。新增 2 例单测覆盖（主干颜色稳定、多泳道期望同一父可达） |
| 截图 | `docs/assets/screens/git-fork-graph-light.png`（真实仓库多泳道图）、`git-fork-graph-dark.png`、`git-fork-graph-detail-light.png`（合并/分叉曲线细节）、`git-fork-graph-worktree-light.png`（多工作树卡片）、`git-fork-board-light.png` / `git-fork-board-dark.png`（1440 看板 + 抽屉）、`git-fork-graph-portrait.png`（390 竖屏）、`git-fork-graph-hidden-nogit.png`（非 git 卡片：区块隐藏、无报错） |
| 生效方式 | 含服务端改动（`lib/git.js`），**已合入主线（`3d9e755`），需重启 DSH 后生效**；`web/dist` 已重建（v0.14.0）。旧服务端无 `graph` 字段时前端整块隐藏，其余功能不受影响 |
| 分支 | `feat/fork-graph-viz`（基于 `e27dd98`，与主工作区并行会话隔离）；**已合入主线 merge `3d9e755`**（合入前先把 main `5278d6c` 合进分支并解决 README / docs 06 文档冲突，v0.14 章节顺延为 §1.29）；合入后自测 170/170、241 例、tsc/build/令牌 lint 通过 |
| 已知限制 | 最多 10 条引用 / 48 个提交（更早历史与多余引用给「还有 N 个」提示）、远端只识别 `origin`、打开详情时的快照（4s 缓存）不自动刷新、只读无搜索/过滤/展开交互；`origin/main` 这类指向主干祖先的引用在图上只作为 ref 徽标出现、不单独画线 |

## 1.30 v0.14.1（详情抽屉「工作线」人话版，面向非技术用户，2026-10-28）

| 项 | 结果 |
|---|---|
| 背景 | 用户对分支图反馈的出发点是「**不懂代码的用户也能看懂**」，并要求先落地原型方案 4（`design/branch-awareness/`）：先说人话、图折叠为进阶；同时明确原型里的解释性文案（如「给需要细看的人」）不要出现在正式功能里 |
| Web 结构（仅前端） | 详情抽屉区块标题改为「工作线」：① **一句话总结**（例：「这张卡片在「feat/branch-badge」工作线上。比主线多 3 处改动，主线还有 1 处没并进来。线上还没同步（本地多 3 处）。」）；② **关键事实表**：在哪条工作线 / 和主线比 / 和线上比 / 工作副本；③ **「提交图」折叠按钮**（默认收起，`aria-expanded` + 箭头旋转，右侧显示改动数）→ 展开后是 v0.14 的 Fork 风格多泳道图 + 多工作树列表。原 chips（分支 / 工作树 / 远端跟踪 ↑↓）移除，技术符号只保留在折叠区 |
| 纯逻辑 | 新增 `web/src/lib/worklineSummary.ts`（`buildWorklineSummary`）：把 `current/base/upstream/graph` 翻译成结构化结论——位置（`detached` / `main` / `feature`）、与主线关系（`main` / `same` / `merged` / `ahead-only` / `ahead-behind` / `behind-only`）、与线上关系（`no-upstream` / `synced` / `ahead` / `behind` / `diverged`）；组件只负责用 zh/en 模板拼句子，7 例单测覆盖各分支 |
| 文案与去技术化 | 统一用「工作线 / 主线 / 线上 / 改动（处） / 工作副本 / 并入主线 / 未同步」等口语词；正式界面不出现「给需要细看的人」这类原型注释；英文文案同步（zh/en 各新增 33 条 `git.*`） |
| 单测 | Web `vitest` **26 文件 / 248 测试**（新增 worklineSummary 7 例：feature 多主线+未关联线上、已并入主线、就在主线、线上落后/分叉、游离 HEAD、截断计数、无 graph）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 CSS 0 error / 0 warning；服务端无改动（170/170 不变） |
| 真实浏览器验收（dev-server + 真实仓库卡 + 演示仓库 worktree 卡；1440×900 DPR2 / 390×844，亮/暗） | 真实主分支卡：总结「当前就在主线「main」上。线上还没同步（本地多 24 处）。」、事实表 4 行正确、折叠默认收起；点击后展开 48 提交多泳道图（点击前 `.kb-git__fork` 不存在、点击后出现），顶部图例、合并双环、工作树列表正常。演示仓库 `feat/graph` 卡：总结「这张卡片在「feat/graph」工作线上。比主线多 1 处改动，主线还有 5 处没并进来。线上还没同步（本地多 1 处）。」、事实表 4 行正确；展开后 18 行图 + 3 个工作树。390 竖屏抽屉 `scrollWidth==clientWidth`（无横向溢出）、暗色主题正常；全程 **console error 0 / pageerror 0** |
| 截图 | `docs/assets/screens/git-workline-collapsed-light.png`（默认折叠的人话版）、`git-workline-collapsed-dark.png`、`git-workline-feature-light.png`（feature 分支卡）、`git-workline-expanded-light.png`（展开提交图）、`git-workline-portrait-light.png`（390 竖屏） |
| 生效方式 | 纯前端改动，**已合入 main（merge `78c3046`），刷新看板即生效、无需重启 DSH**；服务端接口与数据未改（v0.14 `graph` 不变）。注意：`/api/kanban/health` 的版本号在重启前仍显示 0.14.0（服务端进程未重启），前端已是 0.14.1 |
| 分支 | `feat/workline-summary`（基于 v0.14.0 主线 `f30889a`），**已合入 main（merge `78c3046`）**；README / CHANGELOG / 版本号同步为 **0.14.1** |

## 1.31 v0.15.0（卡片 / 列表「工作线」徽标 + hover 高亮 demo + 方案 2/3 调整版原型，2026-10-28）

| 项 | 结果 |
|---|---|
| 背景 | 用户确认方案 1 按 Lead 结论落地：卡片/列表显示工作线状态，但**不给卡片加真值字段**（由 `cwd` 派生、按仓库聚合、失败显示未知），并先看可交互 hover 高亮 demo 与按项目/仓库分组的方案 2/3 原型 |
| 服务端 | 新增 `POST /api/kanban/git/summaries`（契约 02 §11 / 06 §4.6）：`lib/git.js` 新增 `collectGitSummary`（轻量，不采 graph/提交列表，约 8 条只读命令/目录；含 base 两种模式、upstream、worktree 检测；失败收敛 no_cwd/missing/not_git/no_commits/timeout/error）；`lib/routes.js` 新增路由：`dirs` 1–32 非空字符串、**允许集合 = 未归档卡片 cwd 原文（trim 严格相等）**、其余逐项 `forbidden`、去重并发、realpath 缓存 10s/上限 128、全部失败仍 200；`gitSummaryCacheTtlMs` 仅测试用 |
| Web | `worklineSummary.ts` 抽出 `buildWorklineStatus`（位置 / 与主线 / 与线上分类，与详情共用）；`api.getGitSummaries` + 容错归一化；`useWorklineStatuses`（未归档有 cwd 去重、400ms 防抖、≤32/批、模块缓存 15s、20s 可见时刷新、失败静默未知且不缓存）；`WorklineBadge`（彩点 + `工作线 feat/x` + 关系/线上短语；仅 feature 显示；无 cwd / 非 git 不渲染；missing/timeout/error/forbidden 显示灰色「工作线未知」；11px 单行、窄卡省略分支名保留关系、title/aria 全文）；接入 `KanbanCard` / `ListView` / `BoardView` / `App`；`board.css` / `list.css` / i18n 同步 |
| 顺带修正 | 当前分支 === 主分支（主分支无 upstream 的仓库）此前被判成 feature，现已判为「就在主线上」，详情抽屉文案同步修正 |
| 单测 | 服务端 `node --test` **181/181**（新增 11：collectGitSummary 5 + 路由 6，含 400 矩阵 / forbidden / 归档排除 / 缓存命中与 TTL 过期 / 逐项失败仍 200 / 405/404）；Web `vitest` **26 文件 / 260 测试**（worklineStatus 分类、批次/归一化等新增 12 例；既有 248 例无回退）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 CSS 0 error / 0 warning |
| 真实浏览器验收（dev-server + 真实/演示仓库数据；1440×900 DPR2 / 390×844，亮/暗） | 看板与列表均正确：`feat/graph` 卡 `工作线 feat/graph · 多 1 · 线上落后 1`、`feat/long` 卡 `工作线 feat/long · 多 6 · 未同步`、目录不存在卡灰色「工作线未知」；主线卡（cwd=主仓库）、无 cwd 卡、非 git 卡均不显示徽标；暗色与 390 竖屏正常（`documentElement.scrollWidth==390`），console error 0 / pageerror 0 / 4xx 0；列表视图同样 3 条徽标。服务端实测：主仓库摘要首次 ~200ms、同目录缓存命中 2ms、feature worktree 49ms |
| 设计交付 | ① `design/branch-awareness/hover-lane-demo.html`：**可交互**的 hover 高亮泳道 demo（真实仓库 48 提交 / 7 条工作线数据、亮暗切换；悬停任意提交行 → 同色泳道保持高亮、其它淡出、图例同步高亮；无点击/跳转；已用 Playwright 验证 48 行、悬停后 18 条同色段保持、127 条淡出、图例 is-active 正确、console 0 error）。② 方案 2/3 原型更新为**按「项目 / 仓库」两级分组**（`v2-branch-overview.png` / `v3-worktree-map.png`），无 cwd 的卡片进「未指定仓库」 |
| 截图 | `docs/assets/screens/git-workline-badges-board-light.png`、`-board-dark.png`、`-list-light.png`、`-portrait.png`（4 张） |
| 生效方式 | 含服务端改动（`lib/git.js` / `lib/routes.js`），**已合入主线（merge `e1fbe81`），重启 DSH 后生效**；`web/dist` 已重建；hover demo 为静态 HTML 可直接打开 |
| 分支 | `feat/workline-badges`（基于 v0.14.1 主线 `226aa01`），**已合入 main（merge `e1fbe81`）**；版本号 0.15.0；合入后自测 181/181、260 例通过 |

## 1.32 v0.16.0（「工作区」视图按仓库分块 + 提交图 hover 高亮泳道，2026-10-28）

| 项 | 结果 |
|---|---|
| 背景 | 用户确认「先方案 3、后方案 2」；并将 hover 高亮泳道从 demo 落进正式功能，按设计规范复核交互样式（`docs/03-design-system.md` 增 §7.22 / §7.23） |
| 服务端 | 新增 `POST /api/kanban/git/workspaces`（契约 02 §12 / 06 §4.7）：按 `git-common-dir` 去重仓库；每仓库 `mainBranch` + `worktrees[]`（path/branch/detached/sha/主工作副本/isCurrent/ahead-behind 相对主线/`dirty`）；工作副本上限 12（主工作副本与请求目录所在副本优先）；`dirty` = `git status --porcelain --untracked-files=no`；**每个工作副本返回 `dirs[]`**（本次请求落在该副本的 cwd 原文，解决 `/tmp` ↔ realpath 前缀不一致的归组问题）；只读、按仓库缓存 8s/64、允许集合=未归档卡片 cwd、失败目录进 `unavailable` |
| Web | 新增第三视图「工作区」（`ViewMode` 扩展 + 持久化兼容旧值；只读，进入时退出选择模式）：`WorkspaceView` 按仓库分块（仓库头 + 工作副本行：纯 CSS 文件夹图标、分支、主工作树/当前/有未保存改动/干净、相对主线 `多 N · 少 M`/`与主线一致`、相对仓库根路径、关联卡片 mini 列表[点击开详情]、会话数）；未归属卡片进「未指定」；空态/disabled 兜底。`useWorkspaces`：cwd 去重、400ms 防抖、≤32/批、15s 缓存、20s 可见刷新、失败保留旧数据；`groupCardsByWorktree` 优先用 `dirs[]` 精确归组、退回最长前缀。提交图 `ForkGraph` 增加 hover：行/图例项悬停 → 同色泳道保持、其它 0.18（180ms 过渡、reduced-motion 关闭），图例同色高亮；不改布局/无点击 |
| 设计规范 | `docs/03-design-system.md` 新增 §7.22「数据图表 hover 高亮」（触发/表现/过渡/不改什么/实现口径/可访问性/原型）与 §7.23「工作区视图」（入口/块头/工作副本行/未指定/数据/密度响应式）；契约 06 升 v0.5（§4.7 + §5 hover） |
| 单测 | 服务端 `node --test` **192/192**（v0.16 新增 11：工作区地图采集与路由，含去重/多 worktree/dirty/12 上限/forbidden/缓存命中与 TTL/400 矩阵/405；另补 `dirs[]` 映射与符号链接归组断言）；Web `vitest` **27 文件 / 273 测试**（新增 13：分组/批次/会话计数/归一化）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 10 CSS 0 error / 0 warning |
| 真实浏览器验收（dev-server + 真实仓库/演示仓库数据；1440×900 DPR2 / 390×844，亮/暗） | 工作区视图：2 个仓库 / 10 个工作副本；主仓库 1 卡、演示仓库 3 卡正确归组（修复前因 `/tmp` ↔ `/private/tmp` 前缀不一致全落「未指定」，现按 `dirs[]` 精确归组）、未指定 3 卡（无 cwd / 非 git / 目录不存在）；dirty 标记（当前工作副本）正确；点击 mini 卡片打开详情；390 竖屏 `documentElement.scrollWidth==390` 无溢出；console error 0 / pageerror 0 / 4xx 0。hover：真实仓库 48 行图上悬停 → 120 条非本泳道线 opacity 0.18、24 条保持、图例对应分支 `is-active`、移开恢复全部可见；亮/暗正常 |
| 截图 | `docs/assets/screens/git-workspaces-light.png` / `-dark.png` / `-portrait.png` / `-drawer.png`；`git-workline-hover-light.png` / `-dark.png`；另有设计原型 `design/branch-awareness/screens/workspace-view-*.png`、`hover-product-light.png` |
| 真实宿主复验（2026-10-28 用户重启后，端口 60252） | `/api/kanban/health` → **version 0.16.0**、revision 418；`/dsh-kanban/` 返回 dist `index-mXGBYiKw.js` / `index-WCQB2KVJ.css` 与 main `web/dist` 一致。真实宿主 UI（Playwright 直连）：① 临时卡（cwd=worktree）徽标正确显示「工作线 feat/workspace-view · 已并入主线 · 未同步」，验收后已归档；② 「工作区」视图 = **1 个仓库 · 7 个工作副本 · 1 张卡片在运行**，主工作副本挂 27 张真实卡、临时卡正确归到 `feat/workspace-view` 工作副本；③ 详情抽屉展开提交图后悬停行 → 同泳道保持、其它 143 条淡出、图例同步高亮（activeColor 7）、移开恢复；全程 console error 0 / pageerror 0 / 4xx 0。证据 `docs/assets/screens/git-*.png`（realhost 系列）；`POST /git/summaries`、`POST /git/workspaces` 在真实宿主均 200 |
| 生效方式 | 含服务端改动（`lib/git.js` / `lib/routes.js`），**已合入主线（merge `aeb5ba4`），重启 DSH 后生效（已重启验证，health=0.16.0）**；`web/dist` 已重建。hover 高亮纯前端，刷新即可；工作区视图需要新接口（已生效） |
| 分支 | `feat/workspace-view`（基于 v0.15.0 主线 `9acf3f0`），**已合入 main（merge `aeb5ba4`）**；版本号 0.16.0；合入后自测 192/192、273 例通过 |

## 1.33 v0.16.1（「工作区」视图仓库块展开 / 收起，2026-10-28）

| 项 | 结果 |
|---|---|
| 反馈 | 工作区视图里「项目（仓库）」层级缺少展开收起能力，工作副本多时页面过长（本仓库 7 个工作副本） |
| Web（仅前端） | 每个仓库块头加展开/收起箭头按钮：`aria-expanded` + `aria-controls`、箭头 -90°/0° 旋转（180ms、`prefers-reduced-motion` 关闭）、`:focus-visible` 2px 业务蓝；收起保留仓库名/路径/计数 +「已收起 · N 个工作副本 · 点左侧箭头展开」；展开恢复工作副本列表；状态写 `localStorage`（`dsh-kanban.workspaces.collapsed`，解析容错、不可用时静默降级）；块头 hover 底 `interactive-bg-hover`，不使用字号/字重突变，无布局跳动 |
| 单测 | Web `vitest` 27 文件 / 273 例（无回归）、`tsc --noEmit` 0 error、`vite build` 通过、令牌 lint 10 CSS 0 error / 0 warning；服务端无改动（192/192 不变） |
| 真实宿主验收（Playwright 直连 60252，v0.16.0 服务端 + v0.16.1 前端） | 切「工作区」→ 仓库块箭头可点击：收起后工作副本列表隐藏、提示显示、`aria-expanded=false`；再点展开恢复；刷新页面后仍保持收起（localStorage 生效）；亮/暗与 390 竖屏正常、console error 0 |
| 截图 | `docs/assets/screens/git-workspaces-collapsed-light.png` / `-dark.png` / `-portrait.png`（收起后保留块头计数与提示） |
| 生效方式 | 纯前端改动，**已合入 main，刷新看板即生效，无需重启 DSH** |
| 分支 | `feat/workspace-view`（v0.16.1 追加提交，基于 v0.16.0 主线） |

## 1.34 v0.17.0（工作副本 Phase A 清理状态 + Phase B 二次确认软删除，2026-10-28）

| 项 | 结果 |
|---|---|
| 用户决策 | ① 仓库标题栏整行可点；②「未指定」块也可收起；③ Phase A+B 通过，已合并分支可一起删、软删除防误删、未合并允许二次确认后强删、磁盘占用暂不做 |
| 服务端 | `/git/workspaces` worktree 增 `mergedIntoBase`/`upstream`/`modifiedCount`/`untrackedCount`/`locked`/`prunable`/`lastCommitAt`，`dirty=modifiedCount>0`；新增 `POST /git/worktrees/cleanup`（契约 02 §13）：目标必须来自看板未归档卡片 cwd 推导的仓库工作副本；主副本 / WORKTREE_IN_USE / DIRTY / UNMERGED / BRANCH_IN_USE 全套校验；脏/未合并需 `confirmLoss`；目录 rename 到 `~/.dsh-kanban/trash`（7 天）+ `git worktree prune`；可选删分支（合并 `-d`、未合并 `-D`）；locked 先解锁；trash 过期清理；审计日志；成功失效工作区缓存 |
| Web | 仓库标题栏整行 `<button>`（`span role="heading"`，三角仅视觉，键盘可用）+「未指定」整行收起（localStorage）；工作副本行 Phase A 状态徽标 +「可安全清理」；清理按钮 disabled 原因（主副本/有卡片在用/卡片在跑）；`CleanupWorktreeDialog` 两段式确认（第一层路径/分支/状态/回收站说明/删分支勾选；脏/未合并第二层危险确认需勾风险）；成功 toast + reload；错误码映射人话；`useWorkspaces` 返回 reload |
| 单测 | 服务端 `node --test` **206/206**（新增 14：Phase A 字段 + 软删/删分支/脏/未合并/主副本/卡片占用/任意路径/locked/trash 过期/缓存失效）；Web `vitest` **27 文件 / 294 例**（新增 21：状态分类/清理判定/错误码/归一化）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 10 CSS 0/0 |
| 真实浏览器验收（dev-server + 演示仓库真实 git；1440×900） | 工作区展示 2 仓库 13 工作副本：`feat/cleanup-demo` 可安全清理（已并入主线/没有远端/干净）、`feat/graph`/`feat/long` 按钮 disabled「有卡片在跑」、主工作副本 disabled「主工作副本不能清理」；安全清理 → 第一层确认（删分支默认勾选）→ 成功 toast「已清理并删除本地分支 feat/cleanup-demo（回收站保留 7 天）」、行消失、`git worktree list` 移除、目录进 trash；未合并 `feat/unmerged-demo` → 第二层危险确认列出「还有 1 处改动没并入主线」→ 勾选后清理成功（未勾删分支则分支保留）；全程 console error 0 / 4xx 0（cleanup 预期 200） |
| 截图 | `docs/assets/screens/git-workspaces-cleanup-light.png`、`-cleanup-dialog.png`、`-cleanup-danger.png` |
| 生效方式 | 含服务端改动，**已合入 main（merge `8d37ba7`），需重启 DSH 后生效**；回收站 `~/.dsh-kanban/trash`（7 天自动清理） |
| 分支 | `feat/worktree-cleanup`（基于 v0.16.1 主线 `0d92b04`），**已合入 main（merge `8d37ba7`）**；版本 0.17.0；合入后自测 206/206、294 例通过 |

## 1.35 v0.18.0（回收站恢复 P0 + 工作区 P1 五项，2026-10-28）

| 项 | 结果 |
|---|---|
| 用户问题 | 「没有远端」是什么意思、能否清理；P0/P1 按顺序做掉；P2/P3 部分需解释 |
| 结论 | 「没有远端」= 分支从未推送过（没有 upstream），**不是能否清理的判定条件**：已并入主线就安全（主线里有提交）；未合并 + 没有远端时删除分支会丢提交（回收站只保留文件，不恢复提交历史），所以 v0.18 在危险确认中明确提示 |
| 服务端 | cleanup 写 manifest.json（sha/branch/原路径/branchDeleted）；新增 GET /git/trash（旧条目 restorable:false）、POST /git/trash/restore（分支在/worktree add；分支已删按 sha 重建；覆盖文件排除 .git/manifest；原路径已存在/SHA 缺失 409；成功后失效工作区缓存）、DELETE /git/trash/:id（彻底删除）；id 防穿越 |
| Web | 底部「回收站（N）」可收起区块（恢复/彻底删除 + 错误人话 + toast + reload）；运行中会话 cwd 阻塞清理（P0-③，客户端安全层，服务端卡片 cwd 兜底）；「没有远端（从未推送）」与未合并风险提示；P1：卡片预览 5 + 还有 N 张、仓库/工作副本排序（主副本固定第一）、筛选范围开关（默认全部，持久化，App 传 allCards）、最近提交相对时间、空闲工作副本子分组默认收起；修复滚动容器 flex 压缩裁剪 |
| 测试 | 服务端 **216/216**（+10 回收站）；Web 27 文件 / **313 例**（+19）；tsc/build/令牌 lint 全过 |
| 真实浏览器验收（dev-server + 演示仓库真实 git） | 清理生成 manifest → 回收站 3 条（1 可恢复/2 旧条目不可恢复，旧条目恢复按钮 disabled）→ 点恢复轻确认 → toast「已恢复「repo / feat-trash-demo」」→ 回收站条目减少、`git worktree list` 恢复工作副本、回收站文件回来；P1 排序/预览/scope/相对时间/空闲分组渲染正确；390/暗色无横向溢出；console error 0 / 4xx 0 |
| 截图 | `docs/assets/screens/git-workspaces-v018-light.png`、`git-workspaces-trash-restore.png`、`git-workspaces-trash-after.png` |
| 生效方式 | 含服务端改动，**已合入 main（merge `3274a01`），需重启 DSH 后生效**；回收站 `~/.dsh-kanban/trash`（7 天自动清理） |
| 分支 | `feat/workspace-polish`（基于 `90a55b3`），**已合入 main（merge `3274a01`）**；版本 0.18.0；合入后自测 216/216、313 例通过 |

## 2. 自动化测试

### 2.1 服务端（node --test）

```
$ npm test
# tests 162
# pass 162 / # fail 0
# duration_ms ~4.6s
```

覆盖：`store`（原子写 / 串行队列 / revision / 损坏备份重建 / schema 迁移）、`domain`（状态列映射 / 规范化 / 种子 / 写原语 / 审批决策事件收集 / 会话运行失败与恢复回写）、`git`（卡片 Git 上下文：普通仓库 / detached / 分叉 + linked worktree / upstream 领先落后 / 主分支探测 / 工作树截断 / 提交上限 / 全部不可用原因 / `?cwd=` 候选采用与忽略）、`session-sync`（turn 失败判定口径 / 主会话过滤 / 同轮去重 / 监听器接线与容错）、`decisions`（追加格式 / 派生状态 / 筛选分页 / 坏行容忍 / 回填 / store 接线与日志失败中止）、`session-archive`（能力探测 / 预检 / 批量 / HTTP 降级 / 活动写入）、`routes`（CRUD / move / 乐观锁 409 / 审批 resolve / comments / session link / 同源 403 / SSE 首帧 / 静态资源防穿越与 SPA fallback / 决策日志与会话归档接口 / 卡片 Git 上下文接口）、`tools`（11 个工具 schema 与 execute）、`index`（插件注册、决策日志回填、会话运行失败监听接线）。

### 2.2 Web

```
$ npm --prefix web run build
> tsc --noEmit   # 0 error
> vite build     # dist: JS gzip ~113KB / CSS gzip ~14KB
$ npm --prefix web run test    # vitest 25 文件 / 249 测试（含 gitGraph 24 例）
$ npm --prefix web run lint:tokens
# 9 个 CSS 文件：0 error / 0 warning
```

### 2.3 令牌规范

`dsh-ui-spec` 的 `lint-tokens.mjs` 对 9 个 CSS 文件 0 error / 0 warning；`design/lint` 抽出的 mockup 组件样式同样 0/0。

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

# 宿主库级验证：会话运行失败同步（真实 0.2.1 cordis + dsh-session，需先从 app.asar 解包）
DSH_HOST_MODULES=/tmp/dsh021/dsh/node_modules node scripts/verify-session-sync.mjs

# 构建前端
npm --prefix web run build

# v0.12 隔离真实 DSH 宿主 E2E（真实插件 + 真实会话 + Playwright；0.1.5-rc.2）
export DSH_HOME=/tmp/dsh-kanban-m2-host
mkdir -p "$DSH_HOME" && cp ~/.dsh/.credentials.yaml "$DSH_HOME/"
dsh --profile kanban-dev --from-default-profile web --dump-default-config > /dev/null
dsh plugin --profile kanban-dev add "$(pwd)"
# $DSH_HOME/cordis.patch.yml 覆盖 dataDir 到 $DSH_HOME/data、seed: empty
dsh --profile kanban-dev --port 5599 --no-open        # 记下首行 token URL
node /tmp/dsh-kanban-m2-host/scripts/login.mjs         # 存 auth.json（反复用 token 换 cookie 会被宿主鉴权节流）
# 建一张 backlog 卡并逐段复验（脚本保留在 /tmp/dsh-kanban-m2-host/scripts/）
node /tmp/dsh-kanban-m2-host/scripts/phase3.mjs        # ① 设为主会话时间线/幂等 ② 目标下拉 ③ 回复路由
node /tmp/dsh-kanban-m2-host/scripts/phase4.mjs        # ④ 390 面板区满宽/无溢出
node /tmp/dsh-kanban-m2-host/scripts/phase5.mjs        # ③ 审批目标提示与路由
```
> 说明：v0.12 的隔离宿主脚本（phase1–5、login、结果 JSON）放在 `/tmp/dsh-kanban-m2-host/`，属一次性验证资产，未纳入仓库；产品变更与断言结论见 §1.25。

```bash
# v0.13 卡片 Git 分支 / 工作树可视化 —— 服务端单测 + 真实仓库手工复跑
npm test                                   # 162/162（含 test/git.test.mjs 8 例 + routes 4 例）
npm --prefix web run test                  # 25 文件 / 249 例（含 gitGraph 24 例）
npm --prefix web run build                 # tsc --noEmit + vite build → web/dist
npm --prefix web run lint:tokens           # 9 个 CSS 0 error / 0 warning

# ① 造演示仓库（main 与 origin/main 分叉 + feat/graph / feat/long 两个 linked worktree + 非 git 目录）
node scripts/demo-git-repo.mjs             # 默认 /tmp/dsh-kanban-git-demo，可 --root 指定

# ② 起独立 dev-server（不碰真实 ~/.dsh-kanban）
node scripts/dev-server.mjs --port 4609 --data /tmp/dsh-kanban-git-demo/data/data.json --seed empty --reset

# ③ 建卡（cwd 指向主仓库 / worktree / 非 git 目录 / 不存在的目录，各建一张）
curl -s -X POST http://127.0.0.1:4609/api/kanban/cards -H 'content-type: application/json' \
  -d '{"boardId":"board-default","title":"worktree 演示","status":"running","cwd":"/tmp/dsh-kanban-git-demo/repo/.worktrees/feat-graph"}'
curl -s "http://127.0.0.1:4609/api/kanban/cards/<cardId>/git" | python3 -m json.tool   # 直接看契约响应

# ④ 打开 http://127.0.0.1:4609/dsh-kanban/ 双击卡片：详情抽屉出现「分支 / 工作树」区块
#    非 git / 无 cwd / 目录不存在的卡片该区块不出现；390 竖屏与暗色主题同样复查
#    本次 16 项 Playwright 断言脚本与截图脚本为一次性资产，保留在 /tmp/git-viz-verify/tools/（未入库），
#    结果与证据见 §1.26。

# v0.14 Fork 风格多分支提交图 —— 服务端/前端单测 + 真实数据验收
npm test                                   # 170/170（含 test/git.test.mjs 的 8 个 graph 用例）
npm --prefix web run test                  # 25 文件 / 241 例（含 forkGraph 16 例）
npm --prefix web run build                 # tsc --noEmit + vite build → web/dist
npm --prefix web run lint:tokens           # 9 个 CSS 0 error / 0 warning

# ① 多分支演示仓库（5 分支 / 2 合并 / 3 工作树 / 18 提交）
node scripts/demo-git-repo.mjs --root /tmp/git-viz-verify/env

# ② 独立 dev-server（不碰真实 ~/.dsh-kanban）
node scripts/dev-server.mjs --port 4611 --data /tmp/git-viz-verify/data/data.json --seed empty --reset

# ③ 建卡：cwd 分别指向主仓库 / linked worktree / 非 git 目录 / 不存在的目录（POST /api/kanban/cards），
#    再 GET /api/kanban/cards/<id>/git 直接看 graph 响应（refs / commits / truncated / refsTruncated）
#    打开 http://127.0.0.1:4611/dsh-kanban/ 双击卡片：详情抽屉出现「分支 / 工作树」多泳道图，
#    滚到中段可见合并/分叉曲线；非 git / 无 cwd / 目录不存在三种卡区块不出现；390 竖屏与暗色复查。
#    本次 26 项 Playwright 断言脚本与截图脚本为一次性资产，保留在 /tmp/git-viz-verify/tools/（未入库），
#    结果与证据见 §1.29。
# ⑤ v0.13.0 重启桌面 DSH 后的真实宿主复验（一次性脚本，未入库；端口取重启后启 runtime context）
#    UI：44 项断言（含 --expect-version / --real-card；--cleanup 自动归档临时卡）
node /tmp/realhost-verify/verify.mjs --base http://127.0.0.1:<新端口> \
  --out /tmp/lead-v013/shots-realhost --cleanup --expect-version 0.13.0 --real-card card-a57f6dbf
#    API：42 项断言（health / dist 一致性 / 真实卡 4 工作树 / 演示仓库分叉 / 不可用原因 / 旧接口回归）
python3 /tmp/lead-v013/realhost-check.py --base http://127.0.0.1:<新端口> \
  --repo "/Users/roxor/Desktop/dsh/dsh kanban" --demo-root /tmp/dsh-kanban-git-demo \
  --expect-version 0.13.0 --real-card card-a57f6dbf --out /tmp/lead-v013/realhost-results.json
#    结果与证据见 §1.27；重启口径：需 ⌘Q / 菜单「退出」真正结束宿主进程，仅关窗口不会重载服务端

# v0.15.0 卡片「工作线」徽标 / hover demo 复跑
npm --prefix web run test                  # 26 文件 / 260 例（worklineStatus 等）
node --test test/*.test.mjs                # 181/181（含 test/git-summary.test.mjs 11 例）
npm --prefix web run build                 # 重建 web/dist
# dev-server 打开看板即可看卡片徽标（需要先起独立 dev-server；徽标走 POST /api/kanban/git/summaries）
# hover 高亮 demo：直接用浏览器打开 design/branch-awareness/hover-lane-demo.html

# v0.16.0 工作区视图 / hover 高亮复跑
npm --prefix web run test                  # 27 文件 / 273 例
node --test test/*.test.mjs                # 192/192（含 test/git-workspaces.test.mjs 11 例）
npm --prefix web run build                 # 重建 web/dist
# 打开看板 → 工具栏切「工作区」；hover 详情抽屉里展开的提交图任意行看图例同步高亮
