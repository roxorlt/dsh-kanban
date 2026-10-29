# DSH 看板 · Web UI（web/）

Vite + React 18 + TypeScript 的看板前端，构建产物 `web/dist` 由插件静态路由直接服务（`/dsh-kanban/`）。

## 命令

```bash
# 从仓库根目录
npm --prefix web install          # 首次安装依赖（国内网络可加 --registry=https://registry.npmmirror.com）
npm --prefix web run dev          # Vite 开发服务器 http://127.0.0.1:5183，/api 代理到 4599
npm --prefix web run build        # tsc --noEmit + vite build → web/dist
npm --prefix web run typecheck    # 仅类型检查
npm --prefix web run test         # vitest 单测（分组 / 筛选 / 时间格式化 / 工作区清理判定 / 重新绑定候选 / 完成清理提示）
npm --prefix web run lint:tokens  # dsh-ui-spec 的令牌合规检查

# 依赖后端：优先用 builder 的 dev-server
node scripts/dev-server.mjs --port 4599
# 后端尚未就绪时的独立 mock（内存数据 + SSE + 静态 dist）
npm --prefix web run dev:mock     # node web/dev/mock-api.mjs --port 4599
```

开发时两个终端分别跑 `dev-server`（或 `dev:mock`）与 `run dev`；生产构建后可直接访问
`http://127.0.0.1:4599/dsh-kanban/`（dev-server 会服务 `web/dist`）。

## 目录结构

```
web/
  index.html                  # 首帧主题/语言防闪、内联 favicon
  vite.config.ts              # base:'./'、/api → 127.0.0.1:4599、vitest 配置
  dev/mock-api.mjs            # 契约形状的本地 mock（state/cards/move/comments/approvals/SSE/静态资源）
  src/
    main.tsx                  # 启动 bridge、挂载 App、按序加载样式
    App.tsx                   # 数据编排：快照刷新、乐观移动、审批/回复、会话、toast、快捷键
    api.ts                    # HTTP 层（冻结契约 02），含卡片归一化与错误类型
    bridge.ts                 # postMessage 桥（冻结契约 03）：握手、主题令牌、sessions、request 配对
    i18n.tsx                  # zh/en 字典与 Context（默认 zh；宿主 locale / localStorage 可切）
    types.ts                  # 数据模型类型（冻结契约 01）
    lib/
      status.ts               # 状态↔列映射、色调、警示判断
      grouping.ts             # 四列分组 + cardOrder 排序 + dropTarget 计算
      filter.ts               # 搜索（标题/摘要/项目/标签）+ 项目/标签筛选
      time.ts                 # 时长、相对时间、日期格式化
      timeline.ts             # 时间线合并/兜底合成
      useRealtime.ts          # SSE：150ms debounce、指数退避、页面隐藏暂停
      useMediaQuery.ts        # 响应式断点
      clipboard.ts            # 复制（clipboard + execCommand 兜底）
      forkGraph.ts            # 详情「分支 / 工作树」Fork 风格多泳道布局（种子泳道、状态机、汇入/出弯、8 色、路径省略）
      worklineSummary.ts      # 「工作线」结论（位置 / 与主线 / 与线上 / 计数），详情与卡片徽标共用（v0.14.1/v0.15）
      useWorklineStatuses.ts  # 看板批量工作线摘要（cwd 去重、防抖、15s 缓存、20s 可见刷新）（v0.15）
      useWorkspaces.ts        # 「工作区」视图数据：按仓库聚合、dirs 精确归组、15s 缓存、按会话兜底归组、清理判定（v0.16/v0.21）
      rebindDir.ts            # 「重新绑定工作目录」纯函数：候选目录、卡片 cwd 状态、时间线留痕文案（v0.21）
      worktreeCleanupNudge.ts # 完成卡片时的可清理提示判定：终态不占用 + 已并入干净才提示（v0.21）
      useCardGit.ts           # 打开卡片按需拉 Git 上下文（?cwd= 候选会话目录 + 4s LRU 缓存 + 失败静默）
    components/               # Toolbar/FilterMenu/BoardView/ListView/KanbanCard/DetailDrawer/
                              # ApprovalPanel/Timeline/Composer/SessionSection/Modal/Toast/RebindDirDialog/Icons…
    styles/
      tokens.css              # 独立模式的 DSH 令牌兜底（亮/暗；嵌入后由宿主行内令牌覆盖）
      base.css app.css board.css list.css drawer.css modal.css responsive.css inbox.css workspaces.css
```

## 行为说明

- **嵌入 vs 独立**：`window.parent !== window` 且收到过 `kanban:host`/`kanban:theme` 才视为嵌入 DSH；
  否则为独立模式（隐藏会话操作，回复/审批降级为「写时间线 + 复制文本」）。
- **主题**：三态循环「跟随系统 → 亮 → 暗」（`T` 同效，localStorage 持久化）。
  嵌入时先调桥 `theme.set`：宿主 `applied:true` 就由宿主统一换主题（整个 DSH 一起变，看板接收新的
  `kanban:theme` 令牌）；`applied:false` 才清空宿主令牌、用本地 `tokens.css` 兜底。独立模式全程本地三态。
- **宿主安全区**：`kanban:host` 推送可带 `insets {top, leading, platform, fullscreen}`；嵌入时外层
  `padding-top: max(16px, top+8px)`、左右 16px，保证标题行不压住 DSH 左上「侧边栏展开/新建会话」浮层控件。
- **实时**：`EventSource /api/kanban/events`，revision 变化后 150ms 拉 `/state`；断线 1s→30s 退避；
  `document.hidden` 或父页面 `kanban:visibility=false` 时断开，恢复后重连。
- **乐观移动**：拖拽/菜单/键盘换列先本地改 `status + cardOrder`，失败整体回滚并 toast。
- **新建卡片（v0.7）**：工作区/执行目录提到主表单；选工作区自动回填 cwd 与空 project；
  项目、cwd、会话建议来自 `workspaces.list` / 会话 cwd / 历史卡片，按「选中工作区 > 近期会话 > 频次」排序，
  以可点击 chips + 推荐徽标 + 来源标注呈现（非只读 datalist）。进行中卡片必须新建或选择会话：
  已有会话走 `session.prompt` 发 buildStartPrompt，新建走 `session.ensure` 后绑定；失败保留卡片并提示
  「卡片已创建，但会话未启动，可在详情补建」。详情抽屉无会话时警告并内联「新建会话」（先选工作区/目录，
  按状态创建并绑定/开始处理）；独立预览只建卡并给中性提示，看板/列表对进行中未绑定会话显示弱警示；
  折叠卡页脚空间不足时整行换行（v0.7.1），「未绑定会话」不参与压缩、不与右侧指标按钮交叠。
- **交接摘要（v0.8）**：卡片 `handoff`（summary/nextSteps/sessionId/at/by）。看板卡片与列表行显示「交接」小徽标
  （title/aria 带日期）；详情抽屉新增只读「交接摘要」区块（摘要、后续、写入时间/来源会话/写入者 + 复制）。
  `buildStartPrompt` 统一在末尾追加 `【交接摘要】\n{summary}\n后续：{nextSteps}`，开始推进、新建卡片自动会话、
  详情创建会话等所有启动/续接路径复用；无 handoff 不追加。时间线渲染 `handoff` 活动「更新了交接摘要」。
- **审批**：兼容单题与 v0.3 多问题（`questions[]`）。单题沿用 radio/复选框 + `optionIds[]`；多问题逐题渲染
  fieldset（header 小标题、序号、问题、单选/多选徽标、全部选项与说明），统一备注 +「提交全部回答」，提交前
  逐题校验并高亮/聚焦缺题，提交 `answers:[{questionId, optionIds[]}]`。卡片内 questions 限高滚动、详情内展开。
  resolved 逐题展示所选 labels（兼容旧 `resolution.optionIds/labels`）；多问题会话全文按
  `【看板·审批】已提交「title」：\n- header：A、B` 拼接（`session.ensure`，详情里可用目标会话覆盖）。
- **多会话（v0.12）**：详情抽屉列出卡片全部会话（两行：标题 + 主会话徽标 / 运行状态 + 完整 session id）、
  设为主会话（复用绑接口置顶，写 `session_primary` 时间线）、解绑/打开；>1 个会话时 Composer 上方出现
  「回复/审批目标」下拉（默认主会话，设为主会话后默认目标跟随），回复与审批决定都发到该会话。
- **详情抽屉头部（v0.7.2）**：首行是 kicker + 标题（左）与编辑/归档/关闭（右）；摘要独占第二行，
  宽度与正文内容一致（右边缘与 chips / 元数据对齐），长摘要不再被 138px 操作簇挤成窄列。
- **工作区「按会话归属」（v0.21）**：卡片 `cwd` 在主工作副本、绑定会话在同仓库 linked worktree 时，`groupCardsByWorktree(..., { sessions })` 把卡片归到会话所在工作副本并记入 `WorkspaceGroups.sessionAttributed`，mini 卡片标题后显示「按会话归属」`kb-tag`（title 带会话目录）；按 `sessionIds` 取第一个有执行目录的会话，卡片 cwd 已在 linked 时以 cwd 为准，无 cwd / 跨仓库不兜底。
- **完成卡片可清理提示（v0.21）**：卡片从非终态移入已完成后，`worktreeCleanupNudge.buildCleanupNudge` 按工作区探测数据判定「已并入主线 + 干净 + 无未完成卡片 / 运行中会话占用」，满足时弹带「打开工作区」按钮的可操作 toast（10s 自动消失，不弹窗）；`evaluateWorktreeCleanup` 与 `useWorkspaces` 同步把 `done`/`canceled` 终态卡片排除出占用（`cardCount` 只数未完成卡片），服务端清理接口同口径。
- **重新绑定工作目录（v0.21）**：`rebindDir.buildRebindCandidates` 生成候选（绑定会话执行目录 → 主工作副本 → linked worktree，排除 prunable、按 path 去重），`RebindDirDialog` 提供搜索 / 当前项禁用 / 逐行应用；入口在详情抽屉「工作目录」行与工作区「未指定」块卡片行尾；提交走 `PATCH /cards/:id` 改 `cwd`（已完成卡片也可改），成功后写时间线「旧 → 新」并刷新卡片与工作区。`DetailDrawer` 新增 `cwdState` / `onRebindDir`，`WorkspaceView` 新增 `sessions` / `onRebindCard`。
- **回收站与工作区 P1（v0.18）**：回收站可恢复/彻底删除（旧条目不可恢复）；没有远端（从未推送）+ 未合并风险提示；运行中会话阻塞清理；卡片预览前 5、排序、筛选范围开关、最近提交时间、空闲工作副本收起。
- **工作副本清理（v0.17）**：工作副本行显示合并/远端/改动状态与「可安全清理」；清理按钮两段式确认，目录移入回收站 7 天，已合并分支可一并删；脏/未合并走危险确认。
- **「工作区」视图（v0.16）**：工具栏第三个视图，按仓库分块列工作副本 / 卡片 / 会话 / 未保存改动；只读；点击 mini 卡片打开详情。数据走 `POST /git/workspaces`（服务端按仓库 8s 缓存；前端 15s 缓存 + 20s 可见刷新），卡片按服务端 `dirs[]` 精确归组。查看板/列表/工作区三视图持久化在 `dsh-kanban.view`（旧值兼容）。
- **提交图 hover 高亮（v0.16）**：详情抽屉展开的提交图，悬停行或图例项 → 同色泳道保持、其它淡出，图例同步高亮；180ms 过渡，`prefers-reduced-motion` 关闭；无布局/点击变化。
- **卡片「工作线」徽标（v0.15）**：看板卡片与列表行在摘要下方显示 `工作线 feat/x · 多 3 · 未同步`（仅非主线 feature 显示；无 cwd / 非 git 不显示；失败灰色「未知」）。数据走 `POST /git/summaries`（服务端只允许看板卡片 cwd、10s 缓存），前端按 cwd 去重批量拉取、15s 缓存、20s 可见刷新。
- **工作线（v0.14.1，人话版）**：详情抽屉默认展示一句话总结（在哪条工作线、比主线多/少多少、线上是否同步）+ 关键事实表；原 Fork 风格多泳道图与多工作树列表折叠进「提交图」按钮（默认收起，点击展开）。纯函数 `worklineSummary.ts` 负责把 git 数据翻译成结论；v0.14 的 Fork 图渲染保持不变。
- **分支 / 工作树（v0.14，Fork 风格，折叠在「提交图」里）**：详情抽屉「结果」之后、「审批」之前新增只读区块：chips（当前分支 / 工作树 / 远端跟踪 `origin/xxx ↑N ↓M`）+
  引用图例（彩点 + ↑↓ + 当前 / 工作树徽标）+ 多泳道 SVG 提交图（本地分支与 `origin/*` 同图、合并/分叉贝塞尔曲线、合并双环、HEAD 外环、
  彩色 ref 徽标、320px 内滚动、`truncated` 行提示）+ 多工作树列表（当前工作树高亮）。纯函数 `forkGraph.ts` 负责泳道布局（主干颜色稳定、
  第一父沿用当前泳道、多泳道期望同一父提交时汇入后释放）。数据来自 `GET /cards/:id/git?cwd=`（可带卡片主会话执行目录候选，
  服务端校验同仓库 linked worktree 后采纳）；非 git / 无 cwd / 目录不存在 / 旧服务端 404 / 无 `graph` 字段时整块静默隐藏。
- **时间线分页**：`GET /cards/:id/activities?limit=&before=`（返回 `hasMore/nextBefore`）。
  展开卡默认最近 3 条 +「加载更早」，展开区 max-height 内部滚动；详情首屏 20 条 + 分页加载。
- **已完成**：看板 done 列只展示最近 5 张 +「查看全部 N」跳到列表并展开 done；列表 done 分组默认折叠、
  分页加载更多；done 卡片菜单可「重新打开」。
- **列表分组**：状态 / 项目 / 优先级三档切换，动作区固定宽度右对齐（窄屏换行左对齐）。
- **开始推进（v1.1）**：待办卡在 footer（ghost）、展开动作区（主按钮）、卡片菜单提供「开始推进」。
  乐观移到进行中并 POST move；嵌入时经桥 `session.ensure` 发送启动提示（summary 或 currentAction），
  无会话由宿主创建并把返回 sessionId 绑定到卡片；失败回滚到待办并提示。独立预览只移动卡片并给中性提示。
  待办卡回复成功后再给一条中性提示「已发送给 agent；卡片仍在待办，可点「开始推进」」，不自动改状态。
- **批量选择（v1.1）**：工具栏「选择」进入；卡片/列表行显示复选框，点击卡片切换选中（不展开/不进详情），
  拖拽与列落点禁用。批量条含已选 N 张、全选当前视图（全选后变「取消全选」）、清空、移动到 ▾、归档、取消；
  拖拽已停用 · Esc 退出。切视图/刷新保留选择并清理失效 id。提交 `POST /cards/batch`：
  归档写 `archivedAt` + `archived` 活动，移动写目标列 status 与 cardOrder；成功 toast + 清空 + 退出 + refresh。
- **通用审批**：拖拽/移动卡片进入「待你确认」且没有 pending approval 时，弹出可编辑的通用审批
  （标题/详情/继续/停止文案）；取消则卡片回滚到原列。
- **回复**：先 `POST /cards/:id/comments` 写时间线，再经桥 `session.ensure` 发
  `【看板·卡片「标题」】\n…`；失败自动复制文本并提示。
- **时间线数据**：契约 `/state` 不含 activities；UI 在展开/打开卡片时按需请求
  `GET /cards/:id/activities`（builder-server 已实现），revision 变化时对可见卡片重拉；
  接口不可用时用卡片字段合成兜底节点。
- **卡片归一化**：契约要求「一律返回完整 Card」，但种子/写回可能省略空数组字段；
  `api.ts` 的 `normalizeCard` 补默认值，避免 UI 假设字段存在；`normalizeApproval` 兼容新旧 resolution。
- **草稿保护**：卡片表单 / 通用审批弹窗 / 详情抽屉（回复草稿）在 Esc、蒙层点击、关闭按钮时若有未保存内容，
  先弹「放弃未保存的修改？」二次确认。
- **键盘**：`document` capture 监听（iframe 内可用），点击画布后聚焦 app 容器；输入框内不触发单键。
  `⌘K`/`/` 搜索、`N` 新建、`B`/`L` 切视图、`T` 主题、`?` 帮助、`Esc` 关闭最上层浮层（浮层栈：菜单 → 弹窗 → 抽屉）、
  `Enter`/`O` 详情、`Space` 展开、`Alt+←/→` 换列；拖拽另有菜单「移动到…」替代。
- **审批兜底**：审批写入时间线后，若卡片未绑定会话 → 中性提示「审批已记录；未绑定会话，决定未发送」+
  「新建会话并发给 agent」；会话失效（`SESSION_NOT_FOUND`）→ 同一提示条给「重新绑定会话」，不再报红色错误 toast。
- **信息去重**：卡片数与「待你确认 / 会话运行中」只在顶栏出现；连接状态只在工具栏右侧出现；
  底部状态栏只保留快捷键提示与独立预览标识。

## 合规与验收

- 样式只消费 `--dsw-alias-*` / `--dsw-font-*` / elevation / legacy motion 令牌，组件局部变量用 `--kb-*`；
  中性实线 0.5px、浮层 `border:0` + elevation、全圆配 `corner-shape: round`。
- `npm --prefix web run lint:tokens`：10 个 CSS 文件（`tokens.css` 是主题兜底值镜像，逐行标注了 `lint-tokens-ignore` 例外）；v0.21 新增样式（`base.css` 的 toast 动作按钮、`modal.css` 的 `.kb-rebind*`、`drawer.css` 的工作目录行、`workspaces.css` 的会话归属标签与重绑按钮）的 lint 结果以 Lead 最终全量验收为准。
- `npm --prefix web run test`：vitest 单测（分组 / 筛选 / 时间格式化 / 工作区清理判定 / 重新绑定候选 / 完成清理提示等）；v0.21.0 为 **30 文件 / 392 例**（docs/06 §1.38）。
- 截图：`design/screens/web-*.png`（宽屏看板、暗色、嵌入宿主安全区、列表分组、详情抽屉、多选审批、
  多问题审批的卡片/抽屉/列表/已解决态、通用审批弹窗、未发送决定提示、筛选浮层、快捷键帮助、
  390 竖屏看板/底部弹层/列表、与 mockup 的密度对照）。

## 待服务端配合 / 契约建议

1. `/state` 增加 `activities`（当前看板最近节点数组）可省掉每卡一次请求；不改也能跑（已按卡懒加载）。
2. 种子与写接口应返回完整 Card（`approvals/sessionIds/checklists/artifacts/metadata` 等空字段也返回），
   否则第三方客户端容易踩空；UI 已做归一化兜底。
3. `/cards/:id/move` 目前只回 `card`，若同时回 `board.cardOrder` 可减少一次 `/state` 刷新。
