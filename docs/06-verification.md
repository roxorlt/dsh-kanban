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
