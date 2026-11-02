# DSH 看板 · dsh-kanban

一个跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里的原生看板插件。
**卡片是控制面，DSH 会话是执行面**：你在看板里管理"要做什么、到哪了、需要你决定什么"，agent 在会话里执行，并通过原生工具把进展写回卡片。卡片内回复会直接进入绑定的 DSH 会话，会话里的决定也会回到卡片。

> 状态：v0.26.0（视觉后续 V2–V6：A-01…A-15 收口 + DESIGN.md + 验收工具；动效第一批：tokens 审计 + 六项实现 + 独立审查。**已合入 main（merge `68fbc4f`），纯前端/客户端改动刷新看板即生效**。v0.25.0 清理闭环：清理成功后给相关卡片写时间线留痕（P0 ③）、工作区「批量清理」只列安全项（P2 ⑯）、视图内可清理提醒 24h 可关闭（P2 ⑱）；含服务端改动，**已合入 main（merge `49400ca`），重启 DSH 后生效**。v0.24.0「工作副本 → 在 Finder 中打开」为纯客户端改动、刷新看板即生效；v0.23.0「工作线」总览视图、v0.22.1 执行上下文补全已合入 main）。已在 DSH `0.1.5-rc.2` / 桌面 `0.2.1-rc.2`（当前宿主 `0.2.1-rc.3`）上完成端到端验证（安装 → 侧栏 → 全屏面板 → 会话桥 → agent 工具 → 审批回写 → 会话归档 → 多会话回复目标 → 卡片 Git 分支 / 工作树可视化 → 原生待确认收件箱 → 工作副本在 Finder 中定位）。v0.9.2 起含服务端改动（审批自定义回答、摘要上限），v0.10.0 决策日志 / 原生待确认收件箱、v0.11.0 会话归档联动 + 会话运行失败同步、v0.12.0 多会话目标下拉与主会话切换时间线、v0.13.0 卡片 Git 分支 / 工作树、v0.14.0 Fork 风格多分支提交图、v0.15.0 卡片工作线徽标、v0.16.0 工作区视图、v0.17.0 工作副本清理、v0.18.0 回收站恢复、v0.20.0 P2 批 1（复制路径 / locked·prunable / 上限提示）、v0.20.1 agent 建卡自动绑定会话/工作区、v0.21.0 P2 批 2（按会话归属 / 完成卡片可清理提示 / 重新绑定工作目录）、v0.25.0 清理留痕 + 批量清理同样含服务端改动，**都需要重启 DSH 后生效**；v0.19.0 绑定会话选择器、v0.23.0「工作线」视图与纯前端修复、v0.24.0 在 Finder 中打开、v0.25.0 批量清理与提醒的客户端部分刷新看板即可。数据存本机 `~/.dsh-kanban/data.json`，决策日志另存同目录 `decisions.jsonl`（只追加）。
> 仓库：[github.com/roxorlt/dsh-kanban](https://github.com/roxorlt/dsh-kanban)

![看板视图（真实 DSH 内）](docs/assets/screens/embedded-board-light.png)

## 功能

- **看板 / 列表双布局**：四列（待办、进行中、待你确认、已完成），可切换为按列分组的列表。
- **卡片 CRUD + 拖拽**：新建、编辑、归档、拖拽换列；列内排序持久化；乐观更新失败自动回滚。
- **卡片摘要分层**：摘要（≤600 字，表单显示字数计数）→ 当前动作 → 最近节点 → 结果 → 待决策；折叠、展开、详情三档信息密度。
- **重要节点时间线**：状态变化、进展、评论、审批、会话绑定、产物、会话运行失败/恢复全部记录。
- **会话运行失败同步（v0.11）**：绑定的主会话某一轮运行失败（断网 / 模型错误 / 进程中断）时，卡片时间线立刻出现失败节点；卡片若在「进行中」自动置「失败」进「待你确认」；同一会话下一轮成功后自动回「进行中」，失败记录保留。
- **审批与确认**：卡片进入"待你确认"时带结构化待定项（单选 / 多选 / **多问题** + 备注），所有选项与说明在卡片内完整展示；多问题审批一次一题翻页作答（上一题 / 题号进度点 / 下一题），每题选项末尾固定「其他（自行填写）」——选中后展开并自动聚焦输入框，自定义文本计入作答；逐题作答后决定直接发回会话；对齐 DSH `ask_user_question`；**提交即改列**（v0.9.5）：选项可声明 `outcome`，提交后卡片立刻离开「待你确认」（未声明时批准回进行中、驳回回待办）。
- **决策日志（v0.10）**：正式审批从请求到结果的原始事件流，独立存 `<dataDir>/decisions.jsonl`，只追加，不随单卡 20 条审批上限裁剪或 `/seed` 重置丢失；记录请求快照、最终选择与自定义回答、等待时长、未提交就关闭的原因（归档 / 离开待你确认 / 裁剪 / 重置）。首次启用自动回填存量审批历史，可经 HTTP 接口或只读工具 `kanban_decisions` 查询。
- **开始推进**：待办卡片一键移入进行中并启动/续接主会话，附带目标与验收提示；失败自动回滚。
- **新建建议**：工作区/目录/项目/会话建议来自 DSH 工作区与会话记录；进行中新建卡自动建会话并交给 agent；详情可先选目录补建会话。
- **交接摘要（handoff）**：agent 可在会话暂停/归档前写入交接摘要；详情只读展示+复制，新会话启动时自动拼入提示续接。
- **卡片内回复**：回复写时间线，并通过桥进入 DSH 会话；没有会话时可从卡片新建；待办卡回复不会隐式改状态。
- **会话返回看板**：DSH 会话标题右侧提供「看板」按钮，从卡片打开的会话可一键回看板。
- **会话绑定**：选择已有会话作为主会话、打开会话跳转 DSH 对话、显示运行状态。
- **agent 建卡自动绑定会话/工作区（v0.20.1）**：agent 用 `kanban_create_card` 建卡时，服务端从工具上下文读出当前会话 id、执行目录 `cwd` 和所属工作区，自动补到卡片上（不用 agent 手写）；拆子任务需要独立会话时传 `sessionMode:"new"`，服务端按显式 `workspaceId`/`cwd`（不传则继承当前会话位置）通过宿主 `sessionController` **真实新建一个 DSH 会话**（标题=卡片标题）并绑定；`sessionMode:"none"` 用于不需要执行会话的备忘卡。宿主不支持时降级为填好目录/工作区、不绑会话并提示。老卡片没绑会话时，详情里的「补绑推荐」按同工作区/同目录/同项目推荐最可能的会话，一键绑定（只推荐，不自动改用户绑定）。
- **卡片收敛机制（v0.22.0）**：卡片=可单独验收的交付物/决定，步骤写 checklist、执行线程用一卡多会话（skill/工具描述内置「拆卡三问」）。新增父子卡 `parentCardId` 与前置依赖 `dependsOn`：建卡自动挂到当前会话唯一进行中父卡、父卡显示子卡进度、子卡收口前完成会被 409 拦截（`forceComplete` 强完成写审计）、依赖全部完成自动唤醒受阻卡、子卡进入终态/需人处理回写父卡时间线。新增 3 个工具：`kanban_review_board` 只读巡检（陈旧待办/已完成未归档/重复候选/会话 WIP）、`kanban_merge_cards` 合并碎片卡、`kanban_archive_cards` 批量归档；归档可恢复——列表视图底部「归档箱（N）」一键恢复。
- **执行上下文补全（v0.22.1）**：`merge_cards` 合并时目标卡自动继承源卡的 `cwd`/`workspaceId`/`project`（不覆盖已有值）；插件启动时把「有 `cwd`、缺 `workspaceId`」的未归档卡按宿主工作区注册表自动回填（worktree/子目录解析不到则跳过；`workspaceBackfill:false` 可关）。
- **多会话目标与主会话切换（v0.12）**：详情抽屉列出卡片全部会话（主会话徽标 + 完整 session id + 运行状态）；`设为主会话` 即置顶并写入时间线（「主会话切换为「X」」），已是主会话时幂等不重复记录；**回复/审批目标**用 Composer 上方的下拉切换，默认主会话，设为主会话后默认目标跟随。
- **「工作线」总览视图（v0.23.0，方案 2）**：工具栏第三个 Tab（快捷键 `W`）；按「项目 / 仓库」两级分组——第一层是卡片 `cwd` 推导出的仓库（组头 = 仓库名 + 缩短路径 + 工作线数 / 进行中卡片数 + 涉及项目），推不出仓库的卡片进「未指定」并逐张标注原因（没有执行目录 / 目录不存在 / 不是 git 仓库 / 探测失败 / 不在看板卡片目录里）；组内每条**工作线**一行（= 一个工作副本 + 它检出的分支）：状态四档（进行中 / 已并入主线 / 停滞 / 无法判断）、相对主线「多 N 处 · 少 M 处」（分叉时带改动占比细条）、线上同步状态（已同步线上 / 有 N 处没推送 / 线上落后 N 处 / 没有远端 / 未知）、工作副本位置、关联卡片数 + 进行中卡片数、最近改动时间、未保存改动提示。**点一条工作线 → 看板只显示这条线的卡片**，视图上方常驻提示条「只看工作线 X · N 张卡片」+「显示全部卡片」一键恢复（看板 / 列表 / 工作区里都可见；清空时搜索与项目筛选一并清空）。数据复用 v0.16 `/git/workspaces`（与「工作区」视图同一份服务端 8s 缓存、前端 15s + 20s 刷新）与 v0.21「按会话归属」的卡片归属，**不新增卡片字段**；只读视图，清理 / 改绑仍在「工作区」视图。
- **「工作区」视图（v0.16）**：工具栏「工作区」Tab 按**仓库分块**列工作副本——仓库名/根路径/工作副本数 → 每个工作副本一行（分支、主工作树/当前/有未保存改动/干净、相对主线多/少、路径、关联卡片 mini 列表[点击开详情]、会话数）；无 `cwd`/非 git / 目录已失效的卡片进「未指定」块。**仓库标题栏与「未指定」块整行可点收起**（v0.16.1/v0.17.0，记住选择）；工作副本行显示「已并入主线 / 还没并入」+「已同步线上 / 有 N 处没推送 / 没有远端」+「有未保存改动 / 有未跟踪文件 / 干净」+「可安全清理」，并支持**两段确认清理**（目录移入 `~/.dsh-kanban/trash` 保留 7 天；已合并分支可一并删除；脏/未合并需二次危险确认）；v0.18.0 起有**回收站（N）**可恢复条目、`没有远端（从未推送）`风险提示、运行中会话所在工作副本禁止清理；P1：卡片预览前 5、仓库/工作副本排序、筛选范围开关、最近提交相对时间、空闲工作副本默认收起；v0.21.0 起支持「按会话归属」标签、清理占用只算未完成卡片、失效 cwd 可直接重新绑定（见下三条）。数据按仓库批量聚合（服务端缓存 8s、前端 15s + 20s 可见刷新），除工作副本清理与「重新绑定目录」外只读。
- **工作区「按会话归属」（v0.21.0）**：卡片 `cwd` 落在主工作副本、但它绑定的会话在**同仓库的 linked 工作副本**里执行时，工作区视图把卡片归到会话所在的工作副本，并在卡片标题后加「按会话归属」小标签（`title` 显示会话执行目录）。规则：按 `sessionIds` 顺序取**第一个有执行目录的会话**——它不满足条件就维持卡片 `cwd` 的原归属（不继续往后找）；卡片 `cwd` 已在 linked 工作副本时以 `cwd` 为准；无 `cwd` 的卡片不兜底（仍进「未指定」），跨仓库不兜底。只影响工作区视图的归组展示，不改卡片数据。
- **完成卡片时的清理提示（v0.21.0）**：卡片从待办 / 进行中 / 待你确认移入「已完成」后，若它所在的工作副本**已并入主线、干净**、且没有未完成卡片 / 运行中会话占用，弹一条**可操作 toast**「卡片完成：工作副本「X」已并入主线且干净，可清理」+「打开工作区」按钮（停留 10s 自动消失，不弹窗、不打断、不改当前视图）；主工作副本 / locked / 目录已失效不提示。同时服务端把清理占用口径收窄为「**未完成卡片**」：`done` / `canceled` 是终态，**不再占用**工作副本的清理判定（409 文案改为「该工作副本仍被 N 张未完成卡片使用」），但已完成卡片的 `cwd` 仍会被探测（工作区地图仍能看到它们）。
- **重新绑定工作目录（v0.21.0）**：工作副本被清理后旧卡片 `cwd` 指向已不存在的目录时，详情抽屉「工作目录」一行（现在总是显示：无目录显示「未设置工作目录」，目录已失效追加警示标签）与工作区「未指定」块的卡片行尾都提供「重新绑定目录」；对话框按「绑定会话执行目录 → 主工作副本 → linked worktree」列候选（排除失效记录、按路径去重）、支持搜索、当前目录标「当前」并禁用；选定后 `PATCH` 卡片 `cwd` 并写一条时间线「重新绑定工作目录：旧 → 新」，已完成 / 已取消卡片也可改绑。
- **卡片 / 列表「工作线」徽标（v0.15）**：看板卡片与列表行在摘要下方显示一行紧凑徽标：`工作线 feat/x · 多 3 · 未同步`（已并入主线 / 和主线一致 / 线上落后 N 等变体），只对非主线的工作线显示，主线卡、无 `cwd`、非 git 仓库不显示，探测失败显示灰色「工作线未知」。**不为卡片新增字段**：由 `cwd` 派生、按仓库去重批量探测（服务端 `POST /api/kanban/git/summaries`，只允许看板卡片 cwd、10s 缓存；前端 400ms 防抖 + 15s 缓存 + 20s 可见时刷新）。
- **Fork 风格分支 / 工作树可视化（v0.14）**：详情抽屉按卡片执行目录只读探测 Git，用**多分支彩色泳道图**展示仓库拓扑——所有本地分支（含工作树分支）与 `origin` 远端引用共 10 条、最近 48 个提交（含合并提交的多父曲线），HEAD 外环、合并提交双环、分支汇入主干的平滑曲线、彩色 ref 徽标；顶部 chips 显示当前分支 / 工作树 / 远端跟踪（`origin/xxx ↑N ↓M`，无 upstream 时「未关联远端」），引用图例给出每条分支的颜色 + `↑N ↓M`（相对 upstream）+ 当前 / 工作树徽标；多工作树时列出各工作树分支、相对主分支 ↑↓、路径并高亮当前工作树。工作目录不是 Git 仓库、不存在或无 `cwd` 时整块静默隐藏。DSH 用 worktree 执行任务时，卡片 `cwd` 仍是主仓库也行——主会话已在 linked worktree 时前端会带上会话执行目录候选，服务端校验同仓库后采纳。
- **会话归档联动（v0.11）**：卡片完成后可在详情归档其 DSH 会话（从侧栏隐藏、随时可恢复）；归档前检查共享该会话的其它卡片是否都已完成、会话是否空闲/有待确认；运行中会话弹「停止并归档」二次确认（写明会丢弃排队输入、删除定时任务、被停止的工作不会自动继续）；已完成列支持批量归档（dryRun 预览 + 跳过原因，可直接处理历史数据）；卡片完成时轻提示，重开卡片/打开会话/发消息前自动恢复；已完成超过 7 天的卡片会话自动归档（`autoArchiveSessionsDays` 可配，0 关闭）；旧宿主无可逆能力时入口自动隐藏。
- **实时刷新**：SSE 推送 revision，断线指数退避，页面隐藏暂停；手动重试只在断连错误条出现。
- **批量操作**：工具栏「选择」进入选择模式（与拖拽手势分离），批量移动到列 / 批量归档；列表视图同样支持。
- **自动归档**：已完成/已取消卡片超过 30 天自动归档（`autoArchiveDays` 可配，0 关闭），不删除数据。
- **密度与规模**：已完成列只显示最近 5 张（查看全部进入列表）；列表支持按状态/项目分组；时间线分页加载；卡片内素材用紧凑媒体行。
- **优先级/标签暂隐藏（v0.9.0）**：卡片 `priority` / `labels` 仍在 API 与数据中保留，Web 端的新建/编辑表单、卡片、详情、筛选与「按优先级分组」不再展示；观察一版后再决定是否彻底移除（见 CHANGELOG v0.9.0）。
- **横竖屏响应式**：宽屏四列，窄屏列分段 + 单列 + 底部弹层；跟随 DSH 明暗主题。
- **Agent 原生工具**：14 个 `kanban_*` 工具，agent 不需要学 HTTP 就能建卡、推进、请求审批、写结果、回顾决策日志。
- **本地优先**：JSON 存储、原子写、损坏自动备份重建；无云端依赖。

## 已验证

- v0.26.0 **视觉后续 V2–V6**：`docs/10` 视觉审计 A-01…A-15 **15/15 收口**——窄屏工具栏、390 触控热区 14/14 组、视图 tab 可访问名、SSE 断线可见态与重试、错误页用户化与诊断折叠、批量条对比、浅色状态/元数据对比（附录 A.1 18 行亮暗全 ≥4.5）、审批视觉权重、四级字号、宽屏列表路径（行高 62 / 主栏 1180）、空态去重、loading 计数占位与禁用、拒绝按钮可见解释、列表状态去重。新增 **`DESIGN.md`**（视觉唯一事实源）与 **`scripts/visual-audit.mjs`**（零依赖 CDP 验收工具，可复跑）。测试：合并后整树 服务端 **310/310**、Web **37 文件 / 489 例**、`tsc` + Vite 构建通过、令牌 lint 11 CSS 0/0、console error 0 / 4xx 0；**合并动效批次后视觉验收 15/15 复跑通过**。验收矩阵与截图 `docs/12-visual-acceptance.md` + `docs/assets/screens/visual-v2/`（docs/06 §1.43）。
- v0.26.0 **动效第一批（M1→M3）**：`docs/11-motion.md`（审计 A-01~A-10、频率闸门、tokens、两级 reduced-motion、60fps 预算、逐项规格）+ 六项实现（卡片展开/收起、详情抽屉进出、审批提交反馈、批量条出现/退出、返回气泡与来源高亮、拖拽落位/跨列过渡，明确不做 FLIP）+ `review-animations` 独立审查修复（2 个 Block：Toast 过渡作用域失效、批量条离场闪「已选 0 张」；P1 抽屉 blur 动画期掉帧改「动画期关、静止后开」）。动效 tokens 上移到 `:root`（portal 组件才拿得到）；`usePresence` 离场原语 4 例单测。测试：整树 Web **37 文件 / 489 例**、`tsc` 0 error、`vite build` 通过、令牌 lint 11 CSS 0/0；浏览器实测（Playwright，SwiftShader 软件渲染，帧数只作下限）卡片展开 44 帧 max 16.7ms、批量条 41 帧 max 9.3ms、抽屉开 p95 25.1ms；GPU 真机与 2000 卡规模为架构性保证、未实测。合并：`feat/motion-batch`（`3040760`）→ merge `68fbc4f`，与视觉批次同版上线。
- v0.25.0 清理闭环（③ 留痕 / ⑯ 批量清理 / ⑱ 视图内提醒）：清理成功后，`cwd` 落在被清理工作副本内的**未归档卡片**（含已完成）各获得一条时间线节点「工作副本已清理…可重新绑定工作目录」（`data.kind='worktree_cleaned'`，不改卡片 `cwd`）；工作区顶部新增「批量清理（N）」——只列**安全项**（非主工作副本、未锁定、目录未失效、已并入主线、干净、无未完成卡片、无运行中会话），预览后逐项调用单条清理接口（服务端逐项再校验，不提供带丢失风险的批量入口），逐项结果可见、单项失败不中断；有安全项时顶部出现可关闭的内联提醒「有 N 个工作副本可安全清理」，关闭后 24 小时再次出现（不弹窗、不打断，候选基于全部仓库、不受筛选影响）。契约：`docs/contracts/02-http-api.md` §13 / `01-data-model.md` §3。测试：服务端 **310/310**（+2 例清理留痕）、Web **36 文件 / 485 例**（+12 例批量清理纯逻辑）、`tsc` + Vite 构建通过、令牌 lint 11 CSS 0/0（docs/06 §1.44）。按用户确认的**精简口径**验收：本轮不做隔离演示截图与真实宿主复验；含服务端改动，**合入 main 后需重启 DSH**。分支 `feat/workspace-cleanup-closure`（基于 `65cbf6c`，**已合入 main（merge `49400ca`）**）。
- v0.24.0 工作副本「在 Finder 中打开」：工作副本路径行在「复制路径」旁新增按钮，经桥 (`host.capabilities` / `host.revealPath`) 调用 DSH 客户端 Remote `session/openWorkspacePath({path, action:'reveal'})`（macOS = `open -R`）把目录交给宿主桌面；**旧版宿主 / 独立预览没有该桥能力时不显示按钮**，其它功能不受影响。权限边界两道：前端只允许服务端 `/git/workspaces` 工作区地图里的仓库根 / 工作副本路径（精确匹配，不做前缀），桥只接受绝对路径并拒绝空值 / 超长 / 控制字符 / 含 `..`，随后 DSH 宿主再 `verifyDesktopPath`。测试：服务端 **308/308**（+14 例客户端桥测试）、Web **35 文件 / 473 例**（+6 例路径允许集合测试）、`tsc` + Vite 构建通过、令牌 lint 11 CSS 0/0；**真实 DSH 验收**：真实 GUI + headless Chromium 点 `dsh kanban` 行的按钮 → 桥响应 `{ok:true}`，**macOS 窗口列表新增标题为「dsh kanban」的 Finder 窗口**，`errors: []`；直接以 `/etc/hosts` 调桥被宿主拒绝 `Path has no verified Host path`；独立预览下 2 个工作副本行 0 个按钮、复制路径仍在。截图 `docs/assets/screens/workspace-reveal-finder.png`、`workspace-reveal-hidden.png`、`finder-reveal-window.png`（docs/06 §1.42）。纯客户端改动，**已合入 main（merge `03767c0`）**；DSH client-hmr 自动重载客户端 bundle（实测 rev `9cf82bc58ea8` → `9fff0c220f58`），刷新看板即生效、无需重启 DSH。
- v0.21.0 P2 批 2（14 按会话归属 / 15 完成卡片可清理提示 / 16 重新绑定工作目录）：卡片 `cwd` 在主仓库但绑定会话在 linked 工作副本时按会话 cwd 兜底归组并标「按会话归属」；卡片完成且工作副本已并入主线、干净时弹可操作 toast（「打开工作区」，不打断）；工作副本清理后旧卡片可在详情 /「未指定」块重新绑定目录（PATCH + 时间线，已完成卡片可改）。服务端 `done`/`canceled` 终态卡片不再占用工作副本清理判定。测试：服务端 **228/228**、Web **30 文件 / 392 例**、tsc/build/令牌 lint 全过；隔离 dev-server + 演示仓库真实 git + headless Chrome（1440×900 / 390×844）走通「完成 → 提示 → 清理 → 重绑」闭环、console 0 error，截图 `docs/assets/screens/workspace-cleanup-nudge.png`、`workspace-rebind-dialog.png`、`drawer-cwd-rebind.png`、`workspace-rebind-390.png`（docs/06 §1.38）。含服务端改动，**已合入 main（merge `0a27ddf`），重启 DSH 后已复验通过**（health=0.21.0；真实数据下「按会话归属」标签、完成卡片可清理 toast、清理后重绑 + 时间线均正常，截图 `docs/assets/screens/workspace-v021-real-*.png`）。
- v0.23.0「工作线」总览视图（方案 2）：工具栏第三个 Tab 按「项目 / 仓库」两级分组列工作线，行内展示状态（进行中 / 已并入主线 / 停滞 / 无法判断）、相对主线多/少、线上同步状态、工作副本位置、关联卡片数与最近改动时间；点一条工作线 → 看板只看这条线的卡片（提示条可一键恢复）。数据复用 `/git/workspaces` 与「按会话归属」卡片归属，不新增卡片字段；顺手修复 390 竖屏工具栏换行高度压住视图内容的老问题。测试：服务端 **294/294**（无改动）、Web **34 文件 / 467 例**、`tsc` + Vite 构建通过、令牌 lint **11 CSS 0 error / 0 warning**；隔离 dev-server + 演示仓库（2 仓库 / 6 工作副本，含 prunable / 未推送 / 无远端 / 分叉 / 非 git 目录 / 无 cwd）+ headless Chrome（1440×900 / 390×844、亮/暗）**26 项断言全过**、console 0 error / 4xx 0，截图 `docs/assets/screens/workline-overview-light.png`、`workline-overview-dark.png`、`workline-overview-390.png`、`workline-filtered-board.png`、`workline-overview-selected.png`（docs/06 §1.41）。纯前端改动，**合入 main 后刷新看板即生效、无需重启 DSH**。
- 服务端 `node --test`：**310/310 通过**（v0.25.0 清理留痕 + 动效批次的 lib/client.js 改动后；v0.13 12 + v0.14 8 + v0.15 11 + v0.16 11 + v0.17 清理 14 + v0.18 回收站 10 + v0.20.1 自动绑定 31 + v0.21.0 工作区 4 + v0.22.0 收敛 29 + v0.22.1 补全 6 + v0.24.0 客户端桥 14 + v0.25.0 清理留痕 2 + 并行未提交会话联动 7；v0.23.0 无服务端改动）；Web `tsc` + Vite 构建通过，vitest 37 文件 / 489 测试（含 usePresence 4 例），令牌 lint 11 CSS 0 error / 0 warning。
- v0.22.0 卡片收敛机制：拆卡纪律（skill + 工具描述 + 建卡软提醒）、父子卡 `parentCardId` / 依赖 `dependsOn`（环校验、自动挂父卡、子卡进度、完成拦截 + forceComplete 审计、依赖就绪唤醒 blocked→backlog、子卡状态回写父卡）、3 个新工具（`kanban_review_board` 只读巡检 / `kanban_merge_cards` 合并 / `kanban_archive_cards` 批量归档+恢复）、HTTP `POST /cards/:id/unarchive` 与 `GET /archive`、Web 关系徽标与抽屉关系区块、完成拦截确认、列表「归档箱」单张恢复。服务端 288/288（+29）、Web 438 例（+26）、tsc/build/令牌 lint 全过（docs/06 §1.39）。历史数据治理 dry-run 已出（78 → 26，待用户确认后执行）。含服务端改动，**合入 main 后需重启 DSH**；纯前端部分刷新即生效。
- v0.20.1 agent 建卡自动绑定会话/工作区：`kanban_create_card` 默认从工具上下文自动补全 `sessionId`/`cwd`/`workspaceId` 并写 `session_linked` 时间线；`sessionMode:"new"` 经宿主 `sessionController` 真实新建会话（标题=卡片标题、attach 工作区）并绑定，宿主不支持/失败时卡片照常创建 + warnings 降级；`"none"` 不绑。Web 对未绑会话卡片给「补绑推荐」（同工作区 > 同 cwd > 项目对应工作区分档，一键绑定，只推荐不自动改）。服务端 255/255（+31）、Web 375 例（+20）、tsc/build/令牌 lint 全过（docs/06 §1.37）。含服务端改动，**已合入 main（merge `e6d5f3e`），需重启 DSH 后复验**；补绑推荐纯前端刷新即生效。
- v0.19.0 绑定会话选择器：抽屉里的原生下拉框换成选择器浮层——**默认只列卡片所属工作区的会话**（按 workspaceId → cwd → 已绑定会话推断），一屏选完；可切「所有工作区」按工作区分组、组头折叠、搜索（标题 / 会话 ID / cwd / 工作区名与路径）；行内短会话 ID + 状态徽标，工作区注册表兜底行 +「按会话 ID 绑定」。隔离 harness（真 `lib/routes.js` + 真同源父页面桥 + Chromium 1440×900 / 390×844）**25 项断言全过**、console 0 error / 4xx 0，截图 `docs/assets/screens/session-picker-*.png`（docs/06 §1.36）。纯前端改动，**合入 main 后刷新看板即生效**。
- v0.18.0 回收站恢复 + P1 工作区体验：清理写 manifest，回收站列表/恢复（分支已删按 sha 重建）/彻底删除，旧条目不可恢复；「没有远端（从未推送）」+ 未合并删除分支风险提示；运行中会话所在工作副本禁止清理；卡片预览前 5、排序、筛选范围开关、最近提交相对时间、空闲工作副本收起。dev-server + 演示仓库验证恢复链路与页面渲染；截图 `docs/assets/screens/git-workspaces-v018-light.png`、`git-workspaces-trash-*.png`（docs/06 §1.35）。含服务端改动，**已合入主线（merge `3274a01`），重启 DSH 后生效**。
- v0.17.0 工作副本清理（Phase A+B）：工作副本行状态徽标（合并/远端/改动）+ 清理按钮与原因禁用；两段确认清理，目录软删除到 `~/.dsh-kanban/trash`（7 天），已合并分支可删、未合并需 danger 确认；服务端 `/git/worktrees/cleanup` 全套校验（主副本/卡片占用/脏/未合并/分支占用）。dev-server + 演示仓库验证安全清理、危险清理、trash/branch 状态与预期一致；截图 `docs/assets/screens/git-workspaces-cleanup-*.png`。
- v0.16.0「工作区」视图 + 提交图 hover 高亮：工作区视图按仓库分块列工作副本/卡片/会话/未保存改动（服务端 `/git/workspaces` 按仓库缓存、`dirs[]` 精确归组解决 realpath 前缀问题）；hover 悬停提交行或图例项高亮同色泳道、其它淡出（180ms、reduced-motion 关闭、无布局变化）。含服务端改动，**已合入主线（merge `aeb5ba4`），重启 DSH 后生效**（hover 为纯前端，刷新即可）。dev-server + 真实/演示仓库验证：2 仓库/10 工作副本/卡片归组与 dirty 正确、点击 mini 卡片开详情、390 竖屏无溢出；hover 120 条淡出/24 条保持/图例同步；console 0 error / 4xx 0（截图 `docs/assets/screens/git-workspaces-*.png`、`git-workline-hover-*.png`，见 docs/06 §1.32）。
- v0.15.0 卡片 / 列表「工作线」徽标：派生式（不落卡片字段），按仓库去重批量摘要（服务端 10s 缓存 / 前端 15s 缓存 + 20s 刷新），只对非主线 feature 显示，失败显示「工作线未知」；dev-server + 真实/演示仓库数据在看板、列表、亮/暗、390 竖屏验证（主线/无 cwd/非 git 不显示、目录不存在显示未知、无横向溢出、console 0 error，截图 `docs/assets/screens/git-workline-badges-*.png`，见 docs/06 §1.31）。另交付可交互 hover 高亮泳道 demo（`design/branch-awareness/hover-lane-demo.html`）与按项目/仓库分组的方案 2/3 原型。含服务端改动，**已合入主线（merge `e1fbe81`），重启 DSH 后生效**。
- v0.14.1「工作线」人话版（面向非技术用户）：详情抽屉默认展示一句话总结（在哪条工作线、比主线多/少多少、线上是否同步）+ 关键事实表；提交图与多工作树列表折叠为「提交图」，默认收起。纯前端改动，已合入主线（merge `78c3046`），**刷新看板即生效、无需重启 DSH**；真实仓库主分支卡与演示仓库 worktree 卡在亮/暗/390 竖屏渲染正确、无横向溢出、console 0 error（截图 `docs/assets/screens/git-workline-*.png`，详见 docs/06 §1.30）。
- v0.14.0 Fork 风格多分支提交图：详情抽屉「分支 / 工作树」区块升级为多泳道彩色提交图（本地分支 + origin 引用 ≤10 条、最近 48 提交、合并提交多父曲线、主干颜色稳定、8 色调色板、320px 内滚动、图例带 ↑↓/当前/工作树徽标、chips 含远端跟踪）。在**本仓库真实数据**（10 refs / 40 提交 / 3 个合并 / 4 个工作树）与多分支演示仓库（5 分支 / 2 合并 / 3 工作树 / 18 提交）上验收：Chromium 1440×900 DPR2 + 390×844、亮/暗共 **26 项断言全过**、console 0 error / pageerror 0 / 4xx 0、无横向溢出；非 git / 无 cwd / 目录不存在三种卡区块整块隐藏（证据 `docs/assets/screens/git-fork-*.png`，详见 docs/06 §1.29）。含服务端改动，已合入主线（merge `3d9e755`），**重启 DSH 后生效**；真实宿主复验在重启后执行。
- v0.13.0 卡片 Git 分支 / 工作树可视化（**已被 v0.14 的 Fork 风格多泳道图取代**，历史证据见 docs/06 §1.26 / §1.27）：详情抽屉新增只读「分支 / 工作树」区块；含服务端改动，已合入主线（merge `97ad6da`），**2026-10-28 重启桌面 DSH 后 `health=0.13.0`**，真实宿主复验通过（真实卡 `card-a57f6dbf` 区块出现且列出 4 个工作树、两泳道图 12 行含分叉点；演示仓库 linked worktree / 截断 / 非 git·无 cwd·目录不存在隐藏 / 暗色 / 390 竖屏共 44 + 42 项断言全过，证据 `docs/assets/screens/git-realhost-*.png`）。
- v0.12.0 多会话主会话切换与回复/审批目标：合并后服务端 150/150、Web vitest 24 文件 / 225 测试；`设为主会话` 写入 `session_primary` 时间线（「主会话切换为「X」」，已是主会话幂等不重复），Composer 上方「回复/审批目标」下拉默认主会话、设为主会话后默认跟随，回复与审批决定都发到选中会话；隔离真实 DSH 宿主（0.1.5-rc.2 + 真实插件 + 3 个真实会话，Playwright）4/4 验收全过、console 0 error、0 个 4xx（截图 `design/screens/m2-merged-host-*.png`）；2026-10-27 09:41 重启桌面 DSH 后 `/api/kanban/health` 返回 0.12.0、真实数据与 v0.10/v0.11 接口共存（全部证据见 docs/06 §1.25）。
- v0.11.0 会话归档联动：真实 Chromium E2E（真服务端路由 + 假 workspaceRegistry + 假父页面桥）覆盖归档/恢复/停止并归档/共享会话阻塞/待确认阻塞/批量预览+执行/时间线活动，10 项断言全过；真实宿主需重启 DSH 加载服务端 v0.11 后复验（证据 `design/screens/session-archive-e2e-*.png`）。
- v0.11.0 会话运行失败同步：并入后服务端 149/149（本特性 12 例覆盖失败判定口径、主会话过滤、同轮去重、自动置失败/恢复、监听器接线与开关）；dev-server 冒烟正常；真实宿主失败复验在重启 DSH 后执行（步骤见 docs/06 §1.23）。
- 在**独立 DSH profile** 中真实安装并加载：侧栏入口、`main` 全屏面板、iframe 桥就绪、49 个主题令牌同步、明暗主题、console 0 error。
- 会话桥：`session.create → refresh → open → binding → prompt` 实测 `accepted: true`。
- agent 工具：真实 agent 调用 `kanban_create_card` 创建卡片，SSE 实时出现在看板。
- 审批闭环：看板内「批准」→ 决定写入绑定会话 → agent 通过工具把卡片移到已完成并写结果。
- v0.2 回归：多选审批提交 `optionIds:["unit-test","build"]`、时间线 `before` 分页、脏草稿二次确认、列表按项目分组、done 折叠、竖屏动作区，Playwright 全部通过。
- v0.2.1 修复：DSH 0.2.x 会话 API 兼容（`uiWorkspace.openSession` / `sessions.using`）、三态主题、宿主安全区、快捷键、筛选空文案、审批未绑定兜底。
- v0.3.0 多问题审批；v0.3.1 列表审批动作左对齐；v0.4.0 批量选择 + 自动归档（67 服务端 / 57 Web 测试）。
- v0.9.2 多题审批逐题翻页 + 每题自定义回答 + 摘要上限 600（89 服务端 / 158 Web 测试；隔离 dev-server CDP 实测翻页、自动聚焦、校验跳题、已解决展示与移动端）。
- v0.9.4 修复卡片状态点 / 审批选项圆点与文案竖直错位（1440/1280/1200/1100/1028/900/390 × 亮暗实测状态点偏差 5.5→0.5px、选项换行 2→0、圆点与首行偏差 21→0px）。
- v0.9.5 审批提交即改列：提交「待你确认」选项后卡片立刻离开该列（默认批准→进行中、驳回→待办；选项可声明 `outcome` 进已完成），Web 端乐观移列、失败回滚；服务端 94 测试 / Web 165 测试。
- v0.10.0 决策日志：服务端 127/127；真实 `data.json` 副本启动回填 26 条历史事件（含 1 条等待中），`/decisions`、`/decisions/meta`、`/decisions/export` 与非法参数 400 均实测通过。
- 截图与复跑命令见 [验证记录](docs/06-verification.md)。

| 真实 DSH 内（亮） | 真实 DSH 内（暗） |
| --- | --- |
| ![亮色](docs/assets/screens/embedded-board-light.png) | ![暗色](docs/assets/screens/embedded-board-dark.png) |

| 卡片展开（多选审批） | 详情抽屉（多会话/审批回写） |
| --- | --- |
| ![多选审批](docs/assets/screens/approval-multi.png) | ![详情](docs/assets/screens/detail-drawer.png) |

| 多题审批翻页（v0.9.2） | 每题「其他（自行填写）」 |
| --- | --- |
| ![翻页](docs/assets/screens/approval-pager-card.png) | ![自定义回答](docs/assets/screens/approval-custom-required.png) |

| 已解决态展示自定义回答 | 移动端 |
| --- | --- |
| ![已解决](docs/assets/screens/approval-resolved-custom.png) | ![移动端](docs/assets/screens/approval-mobile-pager.png) |

| 列表视图（按项目分组） | 已完成防膨胀 |
| --- | --- |
| ![列表分组](docs/assets/screens/board-list-groups.png) | ![done 折叠](docs/assets/screens/board-list-done.png) |

| 工作区 v0.18（P1 + 回收站） | 回收站恢复确认 |
| --- | --- |
| ![工作区 v0.18](docs/assets/screens/git-workspaces-v018-light.png) | ![恢复确认](docs/assets/screens/git-workspaces-trash-restore.png) |

| 工作副本清理状态与按钮（v0.17） | 危险确认（未合并） |
| --- | --- |
| ![清理状态](docs/assets/screens/git-workspaces-cleanup-light.png) | ![危险确认](docs/assets/screens/git-workspaces-cleanup-danger.png) |

| 「工作区」视图（v0.16，按仓库分块） | 暗色 |
| --- | --- |
| ![工作区视图](docs/assets/screens/git-workspaces-light.png) | ![暗色](docs/assets/screens/git-workspaces-dark.png) |

| 提交图 hover 高亮泳道 | 390 竖屏工作区 |
| --- | --- |
| ![hover 高亮](docs/assets/screens/git-workline-hover-light.png) | ![竖屏](docs/assets/screens/git-workspaces-portrait.png) |

| 卡片「工作线」徽标（v0.15） | 暗色 |
| --- | --- |
| ![卡片徽标](docs/assets/screens/git-workline-badges-board-light.png) | ![暗色](docs/assets/screens/git-workline-badges-board-dark.png) |

| 列表视图徽标 | 390 竖屏 |
| --- | --- |
| ![列表徽标](docs/assets/screens/git-workline-badges-list-light.png) | ![竖屏](docs/assets/screens/git-workline-badges-portrait.png) |

| 「工作线」人话版（v0.14.1，默认折叠） | 暗色 |
| --- | --- |
| ![工作线人话版](docs/assets/screens/git-workline-collapsed-light.png) | ![暗色](docs/assets/screens/git-workline-collapsed-dark.png) |

| 工作线（feature 分支卡） | 提交图展开（进阶） |
| --- | --- |
| ![feature 工作线](docs/assets/screens/git-workline-feature-light.png) | ![展开提交图](docs/assets/screens/git-workline-expanded-light.png) |

| Fork 风格多泳道图（真实仓库，v0.14） | 暗色 |
| --- | --- |
| ![多泳道图](docs/assets/screens/git-fork-graph-light.png) | ![暗色](docs/assets/screens/git-fork-graph-dark.png) |

| 合并 / 分叉曲线细节（滚到中段） | 多工作树卡片 |
| --- | --- |
| ![曲线细节](docs/assets/screens/git-fork-graph-detail-light.png) | ![多工作树](docs/assets/screens/git-fork-graph-worktree-light.png) |

| 看板 + 右侧详情全貌 | 390 竖屏 |
| --- | --- |
| ![看板](docs/assets/screens/git-fork-board-light.png) | ![竖屏](docs/assets/screens/git-fork-graph-portrait.png) |

| v0.13 真实宿主：真实卡区块（历史，已被 v0.14 取代） | v0.13 真实宿主：390 竖屏（历史） |
| --- | --- |
| ![真实宿主区块](docs/assets/screens/git-realhost-section-real-card.png) | ![真实宿主竖屏](docs/assets/screens/git-realhost-worktree-portrait.png) |
| --- | --- |
| ![曲线细节](docs/assets/screens/git-fork-graph-detail-light.png) | ![多工作树](docs/assets/screens/git-fork-graph-worktree-light.png) |

| 看板 + 右侧详情全貌 | 390 竖屏 |
| --- | --- |
| ![看板](docs/assets/screens/git-fork-board-light.png) | ![竖屏](docs/assets/screens/git-fork-graph-portrait.png) |

## 安装

要求：DSH `0.1.5-rc.2` 或兼容版本，Node.js ≥ 22。

```bash
# 1. 克隆仓库
git clone https://github.com/roxorlt/dsh-kanban.git
cd dsh-kanban

# 2. 构建前端（仓库已提交 dist，可跳过）
npm --prefix web install && npm --prefix web run build

# 3. 安装
#    Web / 自建 profile：用官方 CLI
dsh plugin --profile web add "$(pwd)"
#    桌面版：desktop profile 由 Electron 应用独占管理，CLI 会拒绝；用随附脚本：
node scripts/install-desktop.mjs --dry-run   # 先看将要改什么
node scripts/install-desktop.mjs             # 写入 profile（自动备份 package.json）

# 4. 重启 DSH（或在桌面应用里刷新一次页面）
```

重启后侧栏出现「看板」图标，点击进入全屏看板。首次启动会写入一组示例卡片；删除 `~/.dsh-kanban/data.json` 后重启即可恢复为空看板（或调用 `POST /api/kanban/seed`）。

> 安装机制：插件加入 profile 的 `dsh.profile.bundles`，`cordis.patch.yml` 再把插件行挂到 profile 根。桌面版脚本做的事与 CLI 相同（link 依赖 + bundles 条目 + node_modules 符号链接），只是绕过了「desktop 由应用管理」的限制；写前会备份 `package.json`。
> 移除：`node scripts/install-desktop.mjs --remove`（桌面版）或 `dsh plugin --profile web remove dsh-kanban`（Web 版）。

### 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里可以覆盖：

```yaml
- id: kanban
  config:
    seed: empty                # demo（默认）| empty
    dataDir: /path/to/data
    autoArchiveDays: 30        # 已完成卡片自动归档天数；0 关闭（默认 30）
    autoArchiveSessionsDays: 7 # 已完成卡片的会话自动归档天数；0 关闭（默认 7，需 DSH 0.2.x 可逆归档）
    workspaceBackfill: true    # v0.22.1：启动时把「有 cwd、缺 workspaceId」的未归档卡按工作区注册表回填；false 关闭
```

## 使用

| 动作 | 怎么做 |
| --- | --- |
| 新建卡片 | 列底「+ 新建」或顶部「新建」；填标题、摘要、项目；工作区/执行目录/会话按需 |
| 推进卡片 | agent 用工具自动移动；你也可以拖拽或卡片菜单「移动到」 |
| 查看进展 | 点卡片文字区域或右上箭头展开"重要节点"；双击卡片或点「详情」看完整时间线、清单、产物 |
| 处理待定项 | 卡片展开后审批区选择方案 / 批准 / 拒绝，可附备注；决定自动发回会话 |
| 回复 agent | 卡片详情底部输入框，发送后进入「回复/审批目标」下拉选中的会话（默认主会话） |
| 绑定会话 | 详情 →「会话」→ 选择已有会话，或「新建会话」；没有绑定时会先给出「补绑推荐」（同工作区/同目录/同项目最近会话），一键绑定 |
| 卡片关系 | 看板卡显示「子卡 done/total」徽标；详情 →「关系」看父卡/子卡/依赖（可点击跳转）；子卡没收口时完成会弹确认，可强完成 |
| 找回归档卡片 | 列表视图底部「归档箱（N 张）」→ 选一张「恢复」，回到原状态列 |
| 打开会话 | 详情 →「打开会话」，跳转 DSH 对话面板 |
| 重新绑定工作目录 | 详情 →「工作目录」行「重新绑定目录」，或工作区「未指定」块卡片行尾「重新绑定目录」→ 选候选目录 →「使用此目录」；已完成卡片也可改绑 |
| 归档会话 | 卡片完成/取消后 → 详情 →「会话」→「归档会话」；会话运行中/有待确认/共享卡未完成时会禁用并给出原因 |
| 恢复会话 | 详情 →「会话」→「恢复会话」；打开会话、卡片内回复、重开卡片时也会自动恢复 |
| 批量归档会话 | 已完成列头「批量归档会话」→ 预览可归档/跳过清单 → 确认执行（一次性处理历史已完成卡片） |
| 切换布局 | 工具栏 Board / List；筛选、搜索、按项目过滤 |
| 移动端 | 窄屏顶部列分段 + 单列，详情为底部弹层 |

### 给 agent 的技能

`skills/manage-kanban/` 是一份 DSH 技能，教 agent 按"建卡 → 领取 → 写进展 → 请求审批 → 完成"的节奏使用看板。安装：

```bash
ln -s "$(pwd)/skills/manage-kanban" ~/.dsh/skills/manage-kanban
```

也可以不装技能：工具描述本身已经包含工作流约束。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `kanban_boards` | 列出看板与各列计数 |
| `kanban_cards` | 查询卡片（项目/状态/标签/关键词/会话） |
| `kanban_card` | 卡片详情（时间线、待定项、清单） |
| `kanban_decisions` | 只读查询决策日志（审批请求 / 提交 / 未决关闭、等待时长） |
| `kanban_create_card` | 建卡（默认自动绑定当前会话 + 补全 `cwd`/`workspaceId`；`sessionMode:"new"` 真实新建会话并绑定，`"none"` 不绑；可传 `parentCardId`/`dependsOn`，不传且当前会话恰有 1 张进行中卡时自动挂父卡） |
| `kanban_update_card` | 更新摘要、当前动作、结果、优先级、清单、产物、`parentCardId`/`dependsOn`、`forceComplete` 等 |
| `kanban_move_card` | 移动状态/列（agent 自主推进；完成有未收口子卡时需 `forceComplete`） |
| `kanban_add_activity` | 追加进展节点 |
| `kanban_request_approval` | 请求授权/方案选择（卡片进入待你确认） |
| `kanban_link_session` | 绑定会话 |
| `kanban_complete_card` | 完成卡片并写结果（有未收口子卡会 409，`force:true` 强完成写审计） |
| `kanban_review_board` | 收敛巡检（只读：陈旧待办 / 已完成未归档 / 重复候选 / 会话 WIP / 无 cwd 卡） |
| `kanban_merge_cards` | 合并碎片卡（子卡/依赖/会话归并、源卡归档；`dryRun` 预览） |
| `kanban_archive_cards` | 批量归档 / 恢复（`dryRun` 预览；有未收口子卡跳过） |

## 开发

```bash
# 服务端（独立于 DSH，含 demo 数据与静态资源）
node scripts/dev-server.mjs --port 4599

# 前端热更新（代理 /api 到 4599）
npm --prefix web install
npm --prefix web run dev

# 测试
npm test

# 构建
npm --prefix web run build

# 造一个带分叉 / 远端 / linked worktree 的演示仓库（验证详情抽屉「分支 / 工作树」区块）
node scripts/demo-git-repo.mjs
```

目录结构：

```
lib/
  client.js       # DSH 客户端插件：侧栏入口 + main 面板 + iframe 桥
  index.js        # DSH 服务端插件：路由、工具、SSE
  store.js        # 本地 JSON 存储（原子写 / 乐观锁 / revision）
  decisions.js    # 决策日志：decisions.jsonl 只追加事件流（读取 / 回填 / 导出）
  domain.js       # 状态与列、种子数据、节点构造
  git.js          # 卡片 Git 上下文：只读探测分支 / worktree / 远端关系 / 多分支提交图数据（v0.13/v0.14）
  routes.js       # REST API + SSE + 静态资源
  tools.js        # 11 个 kanban_* agent 工具
web/              # 看板 UI（React + Vite），构建产物 web/dist
skills/           # agent 工作流技能
docs/             # 分析、契约、设计、架构、验证
```

## 文档

- [参考项目分析：Codex Taskboard 的核心功能与会话信息架构](docs/01-reference-analysis.md)
- [DSH 插件机制与集成要点](docs/02-dsh-integration.md)
- [设计规范与响应式规格](docs/03-design-system.md)
- [架构与信息架构](docs/04-architecture.md)
- [契约：数据模型](docs/contracts/01-data-model.md) / [HTTP API](docs/contracts/02-http-api.md) / [客户端桥](docs/contracts/03-client-bridge.md) / [决策日志](docs/contracts/05-decision-log.md) / [卡片 Git 上下文](docs/contracts/06-git-context.md)
- [**DESIGN.md：视觉唯一事实源**](DESIGN.md)（令牌/字体层级/组件规则/动效预算/「不该改」清单/验收门槛）
- [验证记录（含 0.2.1 宿主）](docs/06-verification.md)
- [Deep link 提案（已搁置，应用内打开会话已实现）](docs/08-deeplink-proposal.md)
- [OpenDesign 设计/动效 skill 调研](docs/09-design-motion-skills.md)
- [视觉审计 V1（问题清单 A-01…A-15 与三批计划）](docs/10-visual-audit.md)
- [视觉验收报告 V2（A-01…A-15 收口、截图矩阵与 craft 评审）](docs/12-visual-acceptance.md)

## 已知限制

- 每个 workspace 一个看板的模式尚未实现（M2）。
- 会话事件（工具调用数、耗时）目前由 agent 工具写入；自动回填在 M3。
- 审批与 DSH 原生工具审批（bash 等）是两套收件箱，是否合并待评估。
- 无团队协作/云端同步，数据仅本机。
- 决策日志只追加、不自动清理/轮转，长期使用会持续增长；需要备份可在 DSH 停止写入时直接复制 `decisions.jsonl`（或调 `/decisions/export`）。
- 未做超大看板（>500 卡）压力测试与真机软键盘验证；旧版 DSH 仅保证降级不崩溃。
- 回收站恢复（v0.18）：旧条目（无 manifest）不可恢复；恢复是覆盖文件、不还原清理前已删除的已跟踪文件；无进度/大小上限。
- 工作副本清理（v0.17）：跨磁盘时回收站移动会失败（不强删）；不统计磁盘占用（⑰ 待排期）；未合并删除需在第二层危险确认里明确勾选。
- 批量清理与可清理提醒（v0.25.0）：批量只处理**安全项**（脏 / 未合并仍走单条清理的第二层危险确认），且是逐项调用、**非原子**——中途失败时已清理的项不回滚（目录都在回收站，可恢复）；候选与「运行中会话」判定来自最近一次工作区探测（≤20s，运行中会话 cwd 为客户端安全层，服务端不知道会话 cwd），存在极短竞态；提醒关闭 24 小时后重现（浏览器 localStorage）；清理留痕只写未归档卡片、归档卡不写，且不改卡片 `cwd`（仍需手动重新绑定）。
- 工作区视图（v0.16）受当前筛选影响；每仓库最多 12 个工作副本；`dirty` 不统计未跟踪文件；写操作只有工作副本清理（v0.17）与「重新绑定目录」（v0.21.0），没有切分支等其它写操作；含服务端接口，需重启 DSH 后生效。
- 工作区批 2（v0.21.0）：按会话归属只影响工作区视图的归组展示（不改卡片数据），按 `sessionIds` 取第一个有执行目录的会话判定，跨仓库不兜底；完成卡片清理提示依赖最近一次工作区探测（≤20s），数据未就绪时不提示、只对 `done` 提示；重新绑定候选只来自「已探测仓库的工作副本 + 卡片绑定会话的执行目录」，不能手输任意路径，服务端不校验新目录是否存在。
- 卡片徽标（v0.15）只对非主线 feature 工作线显示；「多 N 且少 M」单行只显示「多 N」（完整计数在详情/title）；探测不到主分支不显示；符号链接写法与卡片 cwd 不一致会显示「工作线未知」；单批最多 32 个不同仓库目录并发探测（正常看板 1–3 个）。
- 分支可视化（v0.14/v0.14.1）的文字结论覆盖「与主线 / 与线上」两类关系，不评价代码质量、测试或可合入性；最多画 10 条引用（本地分支 + `origin/*`，按 HEAD → 当前分支 → 主分支 → origin 主分支 → 工作树分支 → 其余分支优先级）、最近 48 个提交；更早历史与超出引用数用「还有 N 个」提示，不提供搜索/过滤。远端只识别 `origin`；数据是打开详情时的快照（4s 缓存），不随会话新提交自动刷新；工作树列表上限 8 个。
- 卡片未绑定会话或会话无 `cwd` 时，「分支 / 工作树」以卡片 `cwd` 为准；卡片 `cwd` 缺失则整块隐藏。

## 路线图

| 阶段 | 内容 |
| --- | --- |
| M1（当前） | 单看板、四列、CRUD、审批、会话绑定、卡片内回复、SSE、双布局、响应式、agent 工具与技能 |
| M2（进行中） | 多会话回复目标（v0.12 完成）、handoff 交接摘要（v0.8）、审批收件箱合并（v0.10）、卡片 Git 分支 / 工作树可视化（v0.13~v0.18：Fork 图、人话版、卡片徽标、工作区视图、工作副本清理、回收站恢复）；剩余：卡片依赖与阻塞、按 workspace 分看板 |
| M3 | 会话事件自动回填（工具调用数 / 耗时 / 搜索结果数）、审批与原生审批联动、卡片自动重开、周期卡 |
| M4 | 团队协作、GitHub/Jira 集成、仪表盘（吞吐/阻塞时长）、导出 Markdown/JSON |

## 致谢

信息架构与卡片要素参考了 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（Codex Taskboard）；UI 遵循 DSH 的 alias 令牌与设计规范。

## License

MIT
