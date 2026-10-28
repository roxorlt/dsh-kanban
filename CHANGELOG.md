# Changelog

## v0.14.0 — 2026-10-27

### 改进：详情抽屉「分支 / 工作树」升级为 Fork 风格多分支提交图（v0.14）

- 背景（卡片 `card-6f4b3d72` 用户反馈）：v0.13 的「两泳道示意」不是用户要的「像 Fork app 那样的图形化」——真实仓库里多张卡片分属不同分支 / 工作树，希望一眼看到多分支拓扑。v0.14 把该区块重做成**多分支彩色泳道提交图**：本地分支 + `origin/*` 引用同图、合并/分叉用平滑曲线、ref 徽标、可滚动历史。
- 服务端（`lib/git.js` +232 行，契约 v0.2 §4.5）：响应新增可选 `git.graph`——① 按优先级选 ≤10 条引用（HEAD → 当前分支 → 主分支 → `origin/<主分支>` → 当前 upstream → 工作树分支 → 其余本地分支（committerdate 倒序）→ 已列分支的 `origin/<branch>`），`for-each-ref` 单命令解析本地分支 `upstream:track`（ahead/behind/gone）；② `git log --date-order --max-count=48` 取提交（含多父 `%P`），`rev-list --count` 算 `truncated`；③ 任何新命令失败只让 `graph:null`，不影响 v0.13 字段与 `available`；新增 3 条命令仍在 4s 总预算内（真实仓库 121–141ms）。v0.13 字段与行为完全保留。
- 契约：`docs/contracts/06-git-context.md` 升到 **v0.2**——§3 响应新增 `graph`（refs/commits/truncated/refsTruncated/maxCommits/maxRefs）、§4.5 采集与引用优先级、§5 改为 Fork 风格渲染约定（种子泳道、lane 状态机、汇入/出弯、8 色调色板、320px 滚动、窄屏规则）；`docs/contracts/02-http-api.md` §10 同步。
- Web（新增 `forkGraph.ts` / `ForkGraph.tsx`，替换 v0.13 的 `gitGraph.ts` 两泳道实现）：`buildForkGraph` 纯函数布局——refs 顺序做泳道种子（同 sha 共用泳道）、泳道状态机 `{sha,color,active}`、提交取最左期望泳道、**第一父一律沿用当前泳道**（主干颜色稳定，多泳道期望同一父提交时在父行画汇入曲线后释放）、其余父提交占空闲槽位 / 追加列、槽位复用且不左移；`ForkGraph.tsx` 渲染图例（彩点 + ↑↓ + 当前/工作树徽标 + refsTruncated）、每行 SVG（竖直段 + 三次贝塞尔汇入/出弯 + 合并双环 + HEAD 外环）、ref 徽标 + subject 单行省略 + 短 sha（`title` 给完整 sha/作者/时间）、320px 内滚动 + `overscroll-behavior: contain`、`truncated` 行提示；`GitBranchSection` 简化为 chips（当前分支 / 工作树 / 远端跟踪 `origin/xxx ↑N ↓M` / 游离 HEAD）+ ForkGraph + 多工作树列表；8 色调色板（business/success/warn/error/success-secondary/error-secondary/warn-label/label-tertiary，全部 alias 令牌）；≤480px 行内 ref 徽标只留 HEAD 把宽度让给 commit 说明。
- 细节：`origin/main` 这类指向主干祖先的远端引用在图上作为 ref 徽标出现、不单独画线（其泳道与主干汇合）；`base.kind='main'` 时主工作树行 ↑0↓0 仍隐藏；无 `graph`（旧服务端）整块隐藏。
- 测试：服务端 `node --test` **170/170**（v0.14 新增 8 例：合并多父、引用优先级/去重/工作树分支/origin-HEAD 过滤、track 五种形态、48 条截断、refs 上限、老分支 tip 被截、detached HEAD）；Web `vitest` **25 文件 / 241 测试**（forkGraph **16 例**：线性、两分支汇合、合并双父、主干颜色稳定、多泳道期望同一父可达、槽位复用/不左移、refs 同 sha、ref tip 不在 commits、HEAD 标记、8 色循环、截断透传、空 commits）；`tsc --noEmit` 0 error、`vite build` 通过、令牌 lint 9 CSS 0 error / 0 warning。
- 验证：真实数据 = 本仓库（10 refs / 40 提交 / 3 个合并 / 4 个工作树）+ 多分支演示仓库（`node scripts/demo-git-repo.mjs`：5 分支 / 2 合并 / 3 工作树 / 18 提交，含 `origin/main` 分叉与 `feat/long` 长分支）；Chromium 1440×900 DPR2 / 390×844、亮/暗共 **26 项 Playwright 断言全过**、console error 0 / pageerror 0 / 4xx 0、无横向溢出；主干颜色经真实数据核对修复（修复前 main 主干在中段被 origin/main 的泳道接管由蓝变绿，修复后 33 行全部 lane0/color0）。证据 `docs/assets/screens/git-fork-*.png`（8 张），验证记录 `docs/06-verification.md` §1.29。
- 生效方式：含服务端改动（`lib/git.js`），需**合入主线并重启 DSH**；`web/dist` 已重建，刷新看板即生效前端。
- 已知限制：最多 10 条引用 / 48 个提交（更早历史提示「还有 N 个」）、远端只识别 `origin`、打开详情时的快照（4s 缓存）不自动刷新、无搜索/过滤交互。
- 分支：`feat/fork-graph-viz`（基于 `e27dd98`，与主工作区并行会话隔离）；v0.13.0 已由并行会话合入主线（`97ad6da` / `e27dd98`），本版待合入。

## v0.13.0 — 2026-10-27

### 新增：卡片详情「分支 / 工作树」可视化（v0.13）

- 背景（卡片 `card-6f4b3d72`「卡片详情可视化展示 git 分支或 worktree 情况」）：看板管理 coding 任务时，DSH 宿主常用 git 分支或 worktree 执行；多张卡片分属不同分支 / 工作树时，看板里看不出一张卡「现在在哪个分支、哪个工作树、与主分支和远端差多少」。本版在**卡片详情抽屉**（右侧）新增只读「分支 / 工作树」区块：生成方式参照 Fork 等 Git 客户端的泳道提交图。
- 服务端（新增 `lib/git.js`，512 行）：对卡片 `cwd` 执行一组**只读** git 命令，产出 `repo / current / upstream / base / worktrees / commits(ahead·behind·shared) / refs` 上下文；`execFile('git')` 不拼 shell、单条 2s / 整次 4s 超时、`maxBuffer=4MiB`、`GIT_OPTIONAL_LOCKS=0` + `LC_ALL=C`；主分支探测（`origin/HEAD` → `main` → `master` → `origin/main` → `origin/master`）；两种比较模式（当前分支 ≠ 主分支时比主分支；当前就在主分支时比其 upstream）；`?cwd=` 候选（DSH 会话已切到 linked worktree 时前端带上会话执行目录）只有在「与 `card.cwd` 同仓库 + 候选是 linked worktree + `card.cwd` 在主工作树」时才采用，其余静默回退；任何失败都收敛为 `available:false` + `reason`（`no_cwd` / `missing` / `not_git` / `no_commits` / `timeout` / `error`），**不返回 5xx、不写仓库、不落库**。
- 接口（`lib/routes.js`）：新增 `GET/HEAD /api/kanban/cards/:id/git?cwd=`（非 GET/HEAD 405、卡片不存在 404、业务失败仍 200 + `available:false`）。契约见新增 `docs/contracts/06-git-context.md`，`docs/contracts/02-http-api.md` 登记路由。
- Web（新增 4 个文件 / 改 5 个）：`GitBranchSection.tsx`（区块标题、chips：分支 / 工作树 / 远端跟踪 ↑↓ / 主分支关系 ↑↓、两泳道 SVG 提交图、多工作树列表；数据不可用或旧服务端 404 时整块静默隐藏）；`gitGraph.ts`（ahead/behind 按 `committedAt` 稳定合并且同时间戳先 ahead、shared 接后、分叉点汇合线、refs 同 sha 合并去重、**12 行上限优先保住分叉点**并把「还有 N 个提交」放在中段、单泳道退化、路径末两段省略）；`useCardGit.ts`（打开卡片按需请求 + `?cwd=` 候选主会话 cwd + 4s / 20 条 LRU 缓存 + 切卡丢弃在途响应）；`types.ts` / `api.ts`（含服务端响应容错归一化）/ `i18n.tsx`（zh/en 各 23 条 `git.*`）/ `drawer.css`（`kb-git-*`，仅 alias 令牌、0.5px 发丝线、全圆角配 `corner-shape: round`）/ `DetailDrawer.tsx`（插在「结果」之后、「审批」之前）。视觉：HEAD 大圆点 + 外环、分叉点汇合曲线、`origin/*` ref 徽标、当前工作树高亮；亮暗主题只靠令牌。
- 细节口径：`base.kind='main'` 时主工作树行的 ↑↓ 恒为 0/0（自己跟自己比），隐藏避免噪声；`base.kind='upstream'`（当前就在主分支）时保留；当前就在主分支且 base 就是 upstream 时，「主分支关系」chip 与「远端跟踪」完全重复，只保留后者。
- 测试：服务端 `node --test` **162/162**（新增 `test/git.test.mjs` 8 例：普通 / detached / 分叉 + linked worktree / upstream 领先落后 / origin/HEAD 探测 / 11→8 工作树截断 / 提交上限 / 全部不可用原因 / `?cwd=` 采用与忽略；`test/routes.test.mjs` +4 例：404 / 405 / 200 available true·false / HEAD / `?cwd=` 候选）；Web `vitest` **25 文件 / 249 测试**（新增 `gitGraph` 24 例，含分叉点优先截断、工作树计数隐藏）；`tsc --noEmit` 0 error、`vite build` 通过、令牌 lint 9 个 CSS 0 error / 0 warning。
- 真实数据验收：`node scripts/demo-git-repo.mjs` 造演示仓库（main 与 origin/main 分叉、`feat/graph` / `feat/long` 两个 linked worktree、非 git 目录），`scripts/dev-server.mjs` 起独立服务 + 6 张真实卡片；Chromium 1440×900 DPR2 / 390×844、亮/暗共 **16 项 Playwright 断言全过**、console error 0 / pageerror 0 / 4xx 0、无横向溢出；`feat/long` 领先 15 条时 12 行上限下分叉点仍可见（9 ahead + 3 shared + 中段「还有 3 个提交」）；非 git / 无 `cwd` / 目录不存在三种卡区块整块隐藏；`?cwd=` 跨仓库候选被忽略。证据 `docs/assets/screens/git-branch-*.png`（8 张），验证记录 `docs/06-verification.md` §1.26。
- 版本与服务端文件白名单：`package.json` / `web/package.json` → **0.13.0**，`files` 补 `lib/git.js`（否则发版缺文件、`lib/routes.js` 的 import 会在宿主里失败）。
- 生效方式：含服务端改动（`lib/git.js` / `lib/routes.js`），需**重启 DSH**；`web/dist` 已重建，刷新看板即生效前端。旧服务端（< v0.13）无该接口时前端按 404 静默隐藏，其余功能不受影响。**已于 2026-10-28 重启桌面 DSH 验证 `health=0.13.0`**，`/dsh-kanban/` 服务的 dist 与合并后构建同名同字节。
- 已知限制：只比较「当前分支 vs 主分支/上游」两条泳道，不画任意多分支拓扑；远端只识别 `origin`；数据是打开详情时的快照（4s 缓存），不随新提交自动刷新；工作树列表上限 8 个。
- 分支与真实宿主：`feat/git-branch-viz`（基于 `f65b4f1`）已合入主线（merge `97ad6da`，2026-10-27，合入时无冲突）；2026-10-28 13:57 重启桌面 DSH（端口 56161 → 49463）后真实宿主复验通过：health=0.13.0、真实卡 `card-a57f6dbf`（cwd=主仓库）区块出现且工作树列表 4 行（main 当前 + feat/fork-graph-viz / feat/git-branch-viz / feat/m2-session-target）、两泳道 12 行含分叉点；演示仓库 linked worktree / 领先 15 截断 / 非 git·无 cwd·目录不存在隐藏 / 暗色 / 390 竖屏；真实宿主 UI 44/44 + API 42/42 断言全过、console error 0 / pageerror 0 / 4xx 0，v0.10/v0.11 接口共存（证据 `docs/assets/screens/git-realhost-*.png`，记录 docs/06 §1.27）。

## v0.12.0 — 2026-10-27

### 新增：多会话主会话切换与回复/审批目标（M2 收口）

- 背景（卡片 `card-680c0577`「M2 多会话回复目标与主会话切换」）：多会话列表 / 设为主会话 / 回复·审批目标其实在 v0.2 已落地，但**主会话变更从不写时间线**——点「设为主会话」只写一条通用「关联了 DSH 会话」，真实数据里同一会话重复 8 条、看不出主会话被切换；另外设计规范 §2.6/§7.5 要求 Composer 旁有「回复目标下拉」，旧实现是会话区里一组单选 + Composer 只读文案。
- 服务端（`lib/domain.js`）：`linkSession` 拆成三种语义 —— ① 新绑定：`session_linked`，绑定即置顶；已有主会话时文案为「关联了 DSH 会话「X」，设为主会话」，`data.previousSessionId` 记录旧主会话；② 设为主会话（目标已绑定但不是当前主会话）：新活动类型 **`session_primary`**，文案「主会话切换为「X」」，`data = {sessionId, action:'primary', previousSessionId}`；③ 已是主会话：**幂等空操作**，不写节点、不刷新卡片，消除重复绑定刷屏。
- 接口（`lib/routes.js`）：`POST /api/kanban/cards/:id/session` 响应补 `activity`（幂等时为 `null`）、`linked`、`primaryChanged`、`primarySessionId`；非法 sessionId / 不存在卡片行为不变。
- 工具（`lib/tools.js`）：`kanban_link_session` 输出 `primarySessionId`，并按语义给 hint（「该会话已是卡片绑定的会话，已设为主会话。」/「该会话已经是卡片主会话，未重复写入时间线。」）。
- Web：① Composer 上方新增 **「回复/审批目标」下拉**（>1 个会话且嵌入模式时出现；选项带「· 主会话」「· 运行中」，默认主会话），替换会话区旧单选；② 会话行改两行：标题 + `主会话` 徽标 / 运行状态 + **完整 session id**（等宽小字，窄屏省略并带 `title`）；③ 点 `设为主会话` 后默认目标跟随新主会话（用户手动选过其它会话则保持）；④ 多会话时审批区块标题下显示「决定会发送到「X」」，与下拉保持一致；⑤ 回复与审批决定都按当前目标经桥发送（`session.ensure`）。
- 纯逻辑（`web/src/lib/replyTarget.ts`）：`replyTargetOptions`（绑定顺序 / 缺标题退回 id）、`resolveReplyTarget`（目标失效回退主会话）、`nextTargetAfterPrimaryChange`（主会话切换后默认目标跟随）。
- 兼容：`data.json` 不变；新增活动类型只影响白名单（旧数据照常读取）；旧服务端仍可工作，只是不写 `session_primary`、响应无新字段（前端不依赖新字段）。
- 验证：分支上服务端 95/95；并入主线（与 v0.10 决策日志、v0.11 会话归档/失败同步合并）后服务端 `node --test` **150/150**、Web **vitest 24 文件 / 225 测试**、`tsc --noEmit` 0 error、`vite build` 通过、令牌 lint 9 个 CSS 0/0；隔离 dev-server + 宿主桥替身 harness + Chrome 1440×900 DPR2 / 390×844 共 **24 项断言全过、console 0 error、0 个 4xx**（含：设为主会话后时间线出现「主会话切换为「讨论会话」」、Toast、下拉默认值跟随、服务端 `sessionIds` 顺序与 `session_primary` 活动落库、回复与审批决定均发到选定目标、旧单选 `.kb-session__target` 为 0、390 弹层满宽无横向溢出）。
- 生效方式：含服务端改动（`lib/domain.js` / `lib/routes.js` / `lib/tools.js`），需**重启 DSH**；`web/dist` 已重建，刷新看板即生效前端。
- 合并与真实宿主：并入主线（合并提交 `547f46c`）后服务端 150/150、Web 24 文件 / 225 测试、tsc/build/令牌 lint 通过；在**隔离真实 DSH 宿主**（0.1.5-rc.2 + 真实插件 + 3 个真实会话，Playwright）中 4/4 验收全过、console 0 error、0 个 4xx（设为主会话写 `session_primary` 时间线并幂等、目标下拉默认/跟随/手动保持、回复与审批经 `session.ensure` 发到选中会话、390 面板区满宽无溢出）；重启桌面 DSH 后 `health=0.12.0`、真实数据 50 卡正常、v0.10 决策日志（33 条）与 v0.11 归档（available=true）共存，`session_primary` 在真实桌面宿主上实测写入且幂等。
- 证据：`design/screens/m2-multi-session-drawer-1440.png`、`m2-reply-target-switch-1440.png`、`m2-primary-switched-1440.png`、`m2-multi-session-sheet-390.png`（分支上），合并后真实宿主截图 `design/screens/m2-merged-host-01…13-*.png`；验证记录 `docs/06-verification.md` §1.24（分支）与 §1.25（合并 + 真实宿主）；分支 `feat/m2-session-target`（ad30d2a）。


## v0.11.0 — 2026-10-23

### 新增：卡片会话归档联动（M1+M2+自动归档；不做会话复用）

- 背景：看板「一卡一会话」，卡片完成后宿主会话没有任何收敛机制（本机实测 91 个会话 / 173MB）。本版把「卡片生命周期」接到 DSH 0.2.x 的可逆会话归档能力上：归档后会话从侧栏隐藏、不能再跑模型步骤，但可在任意时刻恢复。
- 服务端：新增 `lib/session-archive.js`（包装宿主 `workspaceRegistry`，能力探测 + 稳定错误码）与四个接口（详见 `docs/contracts/02-http-api.md` §9）：`GET /sessions/archive`、`POST /cards/:id/sessions/:sid/archive`（预检：触发卡 done/canceled、会话已绑定、所有未归档绑定卡都已收口；宿主活动检查失败可带 `stopActivity` 重试）、`POST .../unarchive`（幂等）、`POST /sessions/archive-batch`（`dryRun` 预览 + 跳过原因，供已完成列批量与历史数据一次性处理）。
- 活动时间线：新增 `session_archived` / `session_unarchived` 活动（含 `sessionId`、自动归档标记与天数），在触发卡上可追溯。
- 自动归档：`autoArchiveSessionsDays`（默认 7 天，0 关闭）— 卡片 done/canceled 超过 N 天后，若所有绑定卡都已收口且宿主可用，则每小时的定时任务自动归档其会话；运行中/待确认由宿主活动检查拒绝并跳过，不 `stopActivity`。与卡片 30 天自动归档（`autoArchiveDays`）并列。
- 客户端桥（`lib/client.js`）：`kanban:sessions` 推送新增 `archivedSessionIds`；订阅 `ctx.workspaces.list` 失效通知重推；`session.open` / `session.prompt` / `session.ensure` 执行前自动 `unarchiveSession`（幂等），恢复失败返回 `SESSION_ARCHIVE_UNAVAILABLE` 并阻止把消息发进归档会话（归档闸门会静默拦下）。
- Web：详情「会话」区按会话展示 已归档 / 运行中 / 待确认 徽标与「归档会话 / 恢复会话」操作；条件不满足时禁用并展示原因（还有 N 张卡片未完成：… / 会话运行中 / 有待确认 / 宿主不支持）；卡片完成时轻提示「可在详情归档会话」（Q1 拍板，不自动执行）；`SESSION_ACTIVE` 弹「停止并归档此会话？」确认（列出将被停止的回合/后台任务/子智能体/定时提醒，并写明会丢弃排队输入、删除定时任务、被停止的工作不会自动继续）；已完成列头新增「批量归档会话」（先 dryRun 预览可归档与跳过清单，再执行）；卡片从完成态重开时自动恢复其归档会话。
- 版本门槛与降级：宿主没有 `unarchiveSession`（如 CLI 0.1.5）时 `available=false`，全部入口隐藏、接口 501；Web 端 `GET /sessions/archive` 404/失败同样隐藏，避免出现不可逆归档。
- 验证：服务端 149/149（新增 10 例会话归档用例 + 12 例会话语义与失败同步用例，见下一节）；Web vitest 23 文件 / 215 例、tsc 0 error、build 通过、令牌 lint 0/0；用「真服务端路由 + 假 workspaceRegistry + 假父页面桥」搭临时 harness，在真实 Chromium 下 E2E 覆盖归档/恢复/停止并归档/共享会话阻塞/待确认阻塞/批量 dryRun+执行与活动写入，10 项断言全过（截图 `design/screens/session-archive-e2e-*.png`）。真实宿主需重启 DSH 加载服务端 v0.11 后复验。

### 新增：会话运行失败同步到卡片（原 v0.9.6 计划，并入 v0.11.0）

- 现象 / 背景：会话因断网等原因某一轮运行失败（DSH 聊天界面显示「本轮运行失败」）时，看板卡片完全没反应——状态、时间线都不变，只能点进会话才发现；反馈实例的绑定会话在 16:32 / 16:56 两次 `DeepSeek Messages transport failed`（`TRANSPORT`，宿主自动重试 5 次后终态失败）。
- 服务端：新增 `lib/session-sync.js`，监听宿主 `session/event`（`{ global: true }`，与 DSH 自身 api-session-controller 相同的订阅方式），只处理 `turn/end`；失败判定对齐聊天界面「本轮运行失败」：`error` / `interrupted`（进程中途退出）/ 退出账号 `aborted`，`completed` 用于恢复判定。`lib/domain.js` 新增 `recordSessionTurnFailure` / `recordSessionTurnRecovered`（+`mainSessionId` / `cardsByMainSession`）；`lib/index.js` 挂载（`sessionFailureSync:false` 可关闭；旧宿主无 `session/event` 时不触发，不影响其它能力）。
- 行为（按用户拍板）：只同步卡片主会话（`sessionIds[0]`）；失败时时间线追加 `error` 节点（轮次 / 原因 / 错误码），卡片处于「进行中」自动置「失败」进「待你确认」；同一卡片同一会话同一轮只记一次；同一会话下一轮正常完成后自动回「进行中」并保留失败记录；手工置「失败」的卡片不自动恢复。Web 无改动（时间线已支持 `error` 节点与 `failed` 样式）。
- 验证：并入后服务端 `node --test` 149/149（本特性 12 例：判定口径、主会话/归档/非法输入、进行中→失败、同轮去重、非 running 只记节点、恢复回进行中、手工失败不恢复、监听器接线与容错、apply 接线集成、关闭开关）；dev-server 冒烟 `version=0.11.0`、`/state` 正常；桌面宿主重启到 v0.11.0 后 `health=0.11.0`；新增 `scripts/verify-session-sync.mjs`（真实 0.2.1 `cordis` + `dsh-session` 驱动插件）**7/7 通过**，覆盖失败置位、时间线节点、去重、恢复回进行中；真实 Electron 全链路的首次自然失败按 `docs/06-verification.md` §1.23 核对。
- 生效方式：服务端改动，需重启 DSH。

## v0.10.0 — 2026-10-23

### 新增：决策日志（正式审批的原始事件流）

- 背景：看板里的「待你确认」条目、等待中的选择、最终做了什么选择，此前只存在于 `data.json` 的卡片 `approvals[]` 与 300 条时间线里，会被单卡 20 条审批上限和 `/seed` 重置抹掉。目标是留下可追溯的原始数据，日后据此做抽象总结，或让 agent 依据原始记录协助处理待确认事项；**本轮只负责保存原始数据**，不做总结、不自动处理。
- 存储：新增 `lib/decisions.js`，独立文件 `<dataDir>/decisions.jsonl`（默认 `~/.dsh-kanban/decisions.jsonl`，权限 `0600`），一行一个 JSON 事件，只追加、不修改、不删除、无条数上限；与 `data.json` 同目录但不并入，不受单卡 20 条审批上限裁剪与 `/seed` 重置影响。
- 写入顺序：在同一个 `store.update()` 事务里先 append 日志并 `fsync`，再原子写 `data.json`；日志可能领先数据（多记一条未完成操作的记录），不会少记；日志写失败则本次操作中止（`DECISION_LOG_IO`），`data.json` 不提交。
- 事件模型：`approval_requested`（题目 / 选项 / 卡片上下文 / 会话的请求快照）、`approval_resolved`（决定、选项与自定义回答、等待时长 `waitedMs`、提交后落列 `outcomeColumn`）、`approval_unresolved`（未提交就关闭，`reason` 为 `archived` / `left_needs_you` / `trimmed` / `data_reset`），另有 `log_initialized`（回填完成）与 `data_reset`（`POST /seed` 断点）两个标记事件。本轮只记正式审批，不含受阻 / 失败卡、手动移列、agent 自行决策。
- 派生状态：日志不存状态，读取时按事件重放得出 `waiting` / `resolved` / `unresolved`；坏行跳过但不删除，`skippedLines` 在 meta 中可见。
- 存量回填：以 `log_initialized` 标记判断初始化状态；首次启用从 `data.json` 现有 `approvals[]` 与相关活动一次性回填，末行写标记；已有标记不重复回填（若启动瞬间先有实时写入或上次回填在写标记前中断，会补一次回填，历史事件追加在文件末尾，读取按 `at` 排序）。`lib/index.js` 与 `scripts/dev-server.mjs` 均已接线。

### 行为变化：未提交审批的收口

- 卡片归档、或卡片离开「待你确认」列（拖拽 / 批量移动 / 完成 / 状态变更）时，未提交的审批置为 `dismissed`，同时写 `resolvedAt` / `resolvedBy`（不伪造 `resolution`），并记一条 `approval_unresolved`。
- 单卡 20 条审批上限裁剪时被挤掉的 pending 记 `reason=trimmed`；`POST /seed` 前把未提交审批收口为 `data_reset`。
- 历史遗留 pending（旧版本把卡片移出「待你确认」/归档但没关审批）：回填时记未决事件，随后启动流程把 `data.json` 里的审批静默置为 `dismissed`（幂等、不重复记事件），避免日志判死而数据仍可提交的矛盾。
- 回填按确定性 `id` 跳过文件里已有的事件；`waiting` 按唯一 `id` 计数，旧文件中的重复 id 不会让等待数虚高或让分页游标死循环。
- `Approval.status` 的 `dismissed` 由「旧数据兼容值」变为实际写入值；Web 侧沿用既有「已忽略」文案，本次不改前端。

### 接口

- `GET /api/kanban/decisions`：倒序列表，支持 `limit`（默认 50、上限 200）、`before` 游标、`type`、`state=waiting|resolved|unresolved`、`cardId`、`boardId`、`approvalId`、`since`、`until`、`source=live|backfill`；返回 `{ok, decisions, hasMore, nextBefore, total, filtered, waiting, revision}`。
- `GET /api/kanban/decisions/meta`：文件路径、条数、坏行数、按类型计数、首个 / 末个事件时间、回填标记、等待数。
- `GET /api/kanban/decisions/export`：原样导出 `decisions.jsonl` 的字节（不转码，invalid UTF-8 不替换；`application/x-ndjson`，`content-disposition: attachment`）。
- 非法 `type` / `state` / `source` / 时间 / id → `400 BAD_REQUEST`；日志写失败对外为 `500 INTERNAL`，`data.json` 不提交。
- 新增只读工具 `kanban_decisions`（`cardId` / `boardId` / `type` / `state` / `limit` / `before` / `since` / `until`）；工具总数 10 → 11。

### 评审加固（冻结前）

- 启动竞态：把「回填 + 历史遗留 pending 静默置 dismissed」收进同一个 `store.update` 事务，store 写队列天然串行，启动窗口内的 live 归档 / 移列 / 提交不会与回填交错；回填改为**收口感知**（同一请求在日志里已有 resolved / unresolved 时不再补第二条）。
- 坏行后的 `seq` 取历史最大值之后，原始文件不再重号；已有 `decisions.jsonl` 在下次 append 时收紧为 `0600`。
- 导出改为返回**原始字节**并排进写队列（invalid UTF-8 不再被替换成 U+FFFD，也不会读到写了一半的文件）。
- `data_reset` 与 seed demo 补写请求的顺序写进契约（文件顺序 ≠ `at` 顺序，读取仍按 `at`）。
- 修既有缺陷：首启 / `POST /seed demo` 的种子卡先规范化（补齐 `approvals` 等数组），首个进程生命周期内即可对这些卡请求审批（此前会 500）。
- dev-server `--reset` 同时清理 `decisions.jsonl`，避免旧日志标记让新 seed 的请求事件缺失。
- `GET /decisions/export` 文档明确为字节级原样导出。

### 兼容与生效

- 数据向后兼容：`data.json` schema 不变，决策事件不写入 `data.json`（草稿上的 `__decisions` 在落盘前被取走）；旧数据中遗留的 `dismissed` 照常读取。
- 纯服务端改动（新增 `lib/decisions.js`，改 `store` / `domain` / `routes` / `tools` / `index` / dev-server）：需要重启 DSH 才生效；前端代码未改，**不需要重建 `web/dist`**。
- 删除 `decisions.jsonl` 后重启会按当前 `data.json` 重新回填（只含当时仍保留在卡片里的审批）；已裁剪的历史无法恢复。单进程写入假设与 `data.json` 相同（同一 dataDir 不要起两个实例）。

### 验证

- 服务端 `npm test` **127/127** 通过：新增 `test/decisions.test.mjs` 23 例（追加格式与 0600、确定性 sha1 id 固定向量、筛选与游标、派生 state、坏行容忍与 seq 不重号、回填与不重复回填、以 `log_initialized` 判定初始化、收口感知回填、degraded 回填、重复 id 分页、历史遗留 pending 同步、启动回填与 live 写串行、seed demo 补请求、多题 + 自定义回答 + 备注、无效 UTF-8 导出、已有文件收紧 0600、store 接线、日志失败中止、归档 / 离开 / seed 收口、trimmed）；`domain` / `store` / `routes` / `tools` / `index` 各自增量（含启动回填、首启种子卡审批、seed demo 落盘与 HEAD 等集成用例）。
- 真实数据冒烟（`~/.dsh-kanban/data.json` 的副本，未写原文件）：启动 dev-server 回填出 26 条历史事件（13 条 `approval_requested` + 12 条 `approval_resolved` + 1 条 `log_initialized`），其中 1 条仍在等待（`state=waiting`）；`/decisions`、`/decisions/meta`、`/decisions/export` 均返回预期结果，导出与日志文件逐字节一致；6 个非法参数均 400；重启不重复回填、实时请求/提交/归档收口实测通过。
- 契约：见 `docs/contracts/05-decision-log.md`。

### 新增：原生待确认收件箱合并（M2「审批收件箱合并」）

- 说明：本节为并行会话（`feat/native-approval-inbox` → `71e602d`）的合并记录，**2026-10-28 合入主线时补记**：功能代码在此之前已随 v0.9.4 收口提交（`ffe9ed4`）进入主线，本次合并补齐 `package.json` 的 `@deepseek-ai/dsh-client-ui-session` 注入声明、变更日志与验证记录（`docs/06-verification.md` §1.28）。

- 目标：把 DSH 原生的**工具授权**（沙箱越权 / 工具 `ask`）、**Agent 提问**（`ask_user_question`）与**计划审批**（`exit_plan_mode` 的 plan-review）合并进看板「待你确认」列，与业务审批卡片同屏，区分**来源**与**风险等级**，并可在看板内直接作答。
- 数据来源：客户端插件注入宿主公开服务 `uiSession`，只读 `sessionStatus.pendingInteraction` 投影（每会话最高优先级一项）；不抢占 `approval/request` waterfall，不复制状态、不新增审计路径。
- 客户端桥（契约 04）：新增 `kanban:pending` 全量快照推送（attach / `kanban:ready` 各推一次，`uiSession` 变化与提问倒计时 250ms 节流），新增 `pending.answerApproval` / `pending.answerQuestion` / `pending.dismiss` 三个白名单方法；作答直接调用宿主 pending 对象的 `answer()/dismiss()`，与原生 composer 共用同一条决定与审计，先答先得。
- Web：`lib/nativeInbox.ts` 纯函数负责风险三档（`danger-full-access`→高、`workspace-write`→中、变更/执行类工具→中、其余→低；提问=低（信息确认）、计划审批=中（批准后执行））、宿主 `displayReason` 多语言解析、计划审批派生（对齐宿主 `planReviewOf` 条件）、会话↔卡片关联与排序；`NativeInbox` 渲染来源徽标 / 风险 chip（悬浮显示分级依据）/ 工具名 / 申请原因 / 会话名 / 关联卡片 / 倒计时 / 允许一次·拒绝·回答·审阅计划·打开会话；`NativeAnswerModal` 支持多题（单选、多选、自定义文本、逐题跳过）与计划审批（同意执行 / 要求修改）。
- 「待你确认」列与列表视图接入收件区；列计数仍为卡片数、收件区单独计数，工具栏「待你确认」总数包含原生项；收件区不参与卡片拖拽 / 多选 / 批量操作。
- 降级：旧版宿主没有 `uiSession` 服务时父页面不推送、收件区不渲染、业务审批不受影响；独立预览模式不渲染。
- 已知限制：每会话只镜像宿主投影的最高优先级一项（与原生 composer 一致）；提问草稿以原生 composer 为准；看板作答不冻结宿主倒计时；未命名提问不提供「取消请求」入口；原生持久策略（always allow）不在看板提供。

### 验证

- 单元/集成：根 `npm test` 85/85（新增 `test/client-pending.test.mjs` 14 例，用真实 `lib/client.js` + 假宿主验证推送/过滤/排序/作答/陈旧项/错误码）；Web vitest 17 文件 / 137 测试（新增 `nativeInbox.test.ts` 27 例）；`tsc` 0 error；`vite build` 成功；令牌 lint 9 文件 0 error / 0 warning。
- Mock 宿主（真实 web 构建 + 真实 postMessage 协议）：4 项（高风险工具授权 / 中风险工具授权 / 两题 Agent 提问 / 计划审批）按风险→来源排序渲染；允许一次后项消失；未作答提交给出校验提示；多题作答提交后项消失；窄屏 390px 与暗色主题可用；Tab 焦点可到「允许一次」；console 0 error。截图 `design/screens/native-inbox-*.png`。
- **真实宿主 DSH 0.2.1-rc.2 端到端**（隔离 profile + 真实模型 deepseek-flash，Playwright 驱动 GUI）：
  - 工具授权：让 agent 以 `sandbox_permissions: danger-full-access` 调 bash → 看板收件区出现「工具授权 / 高风险 / 会话：执行看板审批端到端验证 / 申请原因」；点「允许一次」→ 宿主 `approval/decided: allowed-once`（asked 后 0.7s）→ bash 正常执行并返回标记（会话日志 `tool/result` 非错误）→ 收件项消失。截图 `native-inbox-real-host.png`、`native-inbox-real-allowed.png`。
  - Agent 提问：agent 调 `ask_user_question`（单选「继续/停止」）→ 看板出现「Agent 提问 / 低风险」；在收件区点「回答」→ 选择「继续」→ 提交后收件项消失；会话日志 `tool/result` 为 `{"answers":[{"id":"continue_verify","selected":["继续"]}]}`（答案经宿主正确送达）。截图 `native-inbox-real-question*.png`。
  - 原生 composer 作答：在同一真实宿主里从原生审批框点「允许一次」→ 会话日志 `approval/decided: allowed-once` 且工具成功；看板项随同一 `uiSession` 投影消失（该项所在会话在本轮后被清理，收件区归零的对照见 `native-inbox-real-allowed.png`）。
  - 期间修复：跳过按钮在弹窗里被拉伸成整行（`align-self:flex-start`）；`kb-column__body` 内卡片列表补 `role=list` 语义容器。
- 复跑：`docs/contracts/04-native-inbox.md` §8 给出验收对照；证据截图同步到 `docs/assets/screens/`。
- 合入主线（2026-10-28，合并提交 `8035ba3`）：11 个文件冲突按版本序解决；本条所述代码在此前已随 v0.9.4 收口提交 `ffe9ed4` 进入主线，本次补齐 `@deepseek-ai/dsh-client-ui-session` 注入声明、本段变更日志与 `docs/assets/screens/native-inbox-*.png` 证据，**无代码 / 行为变更、版本号仍为 0.13.0**。合并后根 `node --test` 162/162、Web vitest 25 文件 / 249 测试、`tsc` 0 error、`vite build` 通过（`web/dist` 重建后文件名与字节不变）、令牌 lint 9 CSS 0/0；真实宿主（`health=0.13.0`）刷新后「待你确认」列顶部出现原生收件项，看板内作答一次成功（来源「Agent 提问」/「低风险」→ 选「收件区作答链路 OK」→ 提交后收件区归零、答案回送到发起会话），证据 `design/screens/native-inbox-merged-realhost-01…04-*.png`，记录 `docs/06-verification.md` §1.28。

## v0.9.5 — 2026-10-23

### 修复：「待你确认」提交选项后卡片状态不立即变更

- 现象：在「待你确认」列提交审批选项（单题/多题、选项或自定义回答、批准/驳回）后，审批结果和时间线都写了，但卡片仍停在 `needs_you`；只有等 agent 或被人工再拖一次才离开该列——「提交了但状态没变」。
- 根因：`lib/domain.js` 的 `resolveApproval` 只写 `approval.resolution` 与 `approval_resolved` 节点，从不改卡片 `status` / `cardOrder`；旧契约还把「解决后仍留在 needs_you」写成预期，Web 端也只把决定文本发回会话、不做移列。
- 服务端：最后一条 pending 审批提交后，在同一次 resolve 事务内迁移卡片——所选选项声明了 `outcome` 就进该列（`running` / `backlog` / `done`），未声明时批准回 `running`、驳回回 `backlog`（自定义回答算批准，与 v0.9.2 判定一致），并追加 `status` 活动「审批已提交，卡片回到/进入「…」」。仍有其它 pending 审批、卡片 `blocked`/`failed`、已归档或不在 `needs_you` 时保持原状态（受阻/失败等人处理，对齐设计规范 §2.5 / §7.2）。
- 契约：`ApprovalOption` 新增 `outcome?: 'running'|'backlog'|'done'`（创建审批与 `kanban_request_approval` 都可声明，非法值 400）；resolve 语义由「解决后留在 needs_you」改为「提交即改列」。
- Web：审批选项（`DecisionOption`）对声明 outcome 的选项显示「提交后进入「已完成」」提示；提交瞬间乐观移列（新纯逻辑 `approvalOutcome.ts`，`needs_you` 列 + 无其它待处理审批才动），接口失败回滚到「待你确认」并 toast；未绑定会话时仍移列，并沿用「未绑定会话」警示与「新建会话并发给 agent」兜底（按用户确认的范围）。
- 人工拖卡进「待你确认」生成的默认确认请求：继续→进行中，先停下来→待办（驳回语义）。
- 文档/技能：contracts 01/02、设计规范 §2.5 / §7.2、`manage-kanban` skill 审批红线同步（提交后不需要 agent 再补移列；确认收尾用 `outcome:"done"`）。

### 验证

- 合并后服务端 `node --test` 94/94（新增 5 类：默认回进行中、outcome done/backlog、驳回回待办、多题/多选声明、仍有 pending / blocked 保持、非法 outcome 400）；Web vitest 20 文件 / 165 测试；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 个 CSS 文件 0 error / 0 warning。
- 真实浏览器（主仓库源码 dev-server + 合并后 dist，Chromium 1440×900，Playwright）：声明 `outcome:"done"` 的选项显示「提交后进入「已完成」」提示；点「批准」后 250ms 内卡片出现在「已完成」列（乐观移列）、服务端 status=done、时间线有「审批已提交，卡片进入「已完成」」；未声明 outcome 的审批提交后回「进行中」；点「拒绝」后回「待办」；刷新后三张卡片仍在目标列（待你确认列清空）；多题审批「自定义回答 + 选项」提交后按批准回「进行中」；console 0 error。证据截图 `design/screens/approval-outcome-hint.png`、`approval-outcome-move.png`、`approval-outcome-columns.png`，记录见 docs/06 §1.20。

## v0.9.4 — 2026-10-23

### 修复：卡片状态点 / 审批选项圆点与右侧文案竖直错位（截图 4 处）

- 现象（用户截图）：待办、待你确认、已完成三列首卡标题左侧的状态点比标题首行文字高约 5.5px（待办的灰色空心环尤其明显）；同屏「待你确认」列的长选项「仅手动：详情里点「归档会话」(推荐)」只有圆点在框内第一行、文案掉到第二行，圆点与文案错位 21px。
- 根因 A（3 个卡片状态点）：`.kb-card-head` 是 `align-items: flex-start`（标题可能多行，圆点只应对齐首行），标题 14px/20px 行高，8px 圆点必须在行内下移 6px 才能压到首行中线。v0.1 就写好的 `.kb-card-head__dot { margin-top: 6px }` 一直没挂到卡片圆点上（JSX 里只有 `kb-dot kb-dot--${tone}`），是死样式，圆点停在了 flex 行顶。
- 根因 B（1 个审批选项圆点）：`.kb-decision-option` 是 `flex-wrap: wrap` 容器，13px 圆点与 label 同一行；label 作为 flex 项没有 `flex`/`min-width`，按 max-content 量尺寸（长文案 201px），列宽 283px 时圆点右侧只剩约 197px → 浏览器把整块 label 挪到下一 flex 行，圆点被单独留在第一行。
- 修复：卡片圆点补 `kb-card-head__dot` 类（6px 上边距对齐首行中线）；`.kb-decision-option__label` 加 `flex: 1 1 0; min-width: 0`，label 占满圆点右侧剩余宽度并在自身内部换行（继续受 2 行截断约束），圆点始终与 label 首行同行。
- 验证：隔离 dev-server + Chrome（DPR 2）实测 1440 / 1280 / 1200 / 1100 / 1028 / 839 / 720 / 390 × 亮暗：三列首卡状态点与标题首行中线偏差 **5.5px → 0.5px**；审批选项换行 **2 个 → 0**、圆点与 label 首行中线偏差 **21px → 0px**；选项盒溢出 0、列头图标偏差 0、console 0 error。Web vitest 19 文件 / 158 测试、`tsc --noEmit` 0 error、令牌 lint 9 CSS 0/0、服务端 89/89、`vite build` 通过。
- 生效方式：纯前端类名/CSS 改动，已重建 `web/dist`；刷新看板（或切走再切回）即可，无需重启 DSH。
- 证据：`design/screens/align-fix-before-after.png`（前后对照总图）、`align-card-dot-before-1440.png` / `align-card-dot-after-1440.png`（四列首卡状态点）、`align-option-before-1200.png` / `align-option-after-1200.png`、`align-option-after-1200-dark.png`、`align-option-after-390.png`。

## v0.9.3 — 2026-10-23

### 修复：详情抽屉「执行目录」路径被截断 + 抽屉加宽一档（右侧抽屉样式）

- 现象（1440×900，卡片 cwd=`/Users/roxor/Desktop/dsh/dsh kanban`）：打开卡片详情抽屉 →「新建会话」，「执行目录」输入框只显示到 `/Users/roxor/Desktop/dsh/dsf`——输入框内容宽 196px、路径需 247px，末尾 **51px 被裁**；1028 竖屏（抽屉 380px）下裁约 81px。新建/编辑卡片弹窗同字段 233px，裁 14px（`…/dsh kanb`）。三处都没有 hover 提示，看不到完整路径。
- 根因：两处表单都用 `.kb-form__row` 两列栅格并排「工作区 + 执行目录」。抽屉正文内容宽 428px（460 抽屉）/348px（380 抽屉），减表单内边距 20 后每列只剩 203px / 166px；该路径在 12px 等宽字体下需要 247px，单行输入框末尾被裁。弹窗固定 520px、每列 233px，同样差 14px。另外元数据「工作目录」行本身是自动换行、不截断，缺的只是 hover 提示。
- 修复 A（路径完整展示）：新增 `.kb-form__row--stack` 单列栅格，抽屉「新建会话」表单与新建/编辑卡片弹窗都改为「工作区」一整行 +「执行目录」一整行 + 建议 chips。改后输入框 344–478px，路径 `scrollWidth = clientWidth`（0 裁切）。
- 修复 B（完整值入口）：执行目录输入框（抽屉/弹窗）、详情元数据「工作目录」、会话标题截断处、产物路径都补 `title`；工作区下拉的每个选项带完整 `title`（含 workspace path）；产物路径允许行内换行，长路径不再顶出抽屉。
- 抽屉加宽（用户拍板）：`clamp(380px, 34vw, 460px)` → `clamp(400px, 36vw, 520px)`——1440px 下 460→518.4px、1512→520px、1028 竖屏 380→400px；同一张长卡片（17 段正文）在 1440px 平均行数 3.00→2.59（-14%）、最高 13→11 行，会话标题可用宽 328→388px。`<720px` 仍是底部弹层全宽。
- 验证：隔离 dev-server 实测 1440/1512/1028/900/390 × 中英 × 亮暗全部 0 裁切、抽屉内无截断元素缺 `title`；Web vitest 16 文件 / 110 测试、tsc 0 error、令牌 lint 8 CSS 0/0、build 成功、服务端 71/71。前/后截图 `design/screens/web-drawer-cwd-*`、`web-card-modal-cwd-*`；干净单提交在分支 `fix/drawer-path-width`（4a2978b）。

## v0.9.2 — 2026-10-23

### 改版：「待你确认」多题审批改为逐题翻页 + 每题「其他（自行填写）」

- 用户反馈：多题审批把两道题的全部选项纵向叠在卡片里，底部只有一个「统一备注」输入框；两组选项都不符合需求时在备注里写了诉求，点提交仍被「第 N 题还没有选择」拦住——备注不算作答，交互不完整。
- 逐题翻页：一次只展示一道题（头部 pill 显示「第 N / M 题」，底部「上一题 / 题号进度点 / 下一题」），进度点同时表示已答 / 未答；不再把多题堆进卡片。卡片内不再有「题目区 + 选项区」两层内部滚动条，面板自然长高、由列体滚动。
- 每题自定义回答：选项末尾固定「其他（自行填写）」；选中后原地展开输入框并自动聚焦（≤600 字，右下角字数计数），内容计入该题作答。单选与选项互斥；多选可与选项共存。提交校验区分两种失败：「没选任何东西」→ 跳到该题并聚焦第一个选项；「选了其他但没填」→ 跳到该题、聚焦输入框并提示「第 N 题选了「其他（自行填写）」，请填写具体内容」。
- 统一备注默认收起：多题审批不再默认展示备注框（容易被误认为答题框）；点「添加备注（可选）」再展开，内容随决定一起发送。
- 数据与服务端：`ApprovalAnswer` 新增 `custom`（≤600 字）；`POST /api/kanban/cards/:id/approvals/:approvalId/resolve` 的 `answers[]` 接受 `custom`；每题必须「至少 1 个选项」或「custom 非空」，单选两者互斥；判定改为「所有选中选项均为拒绝语义**且没有任何自定义回答**」才 `rejected`。`resolution.optionIds/labels` 仍只拍平真实选项；旧数据与旧调用方完全兼容。
- 已解决态与会话文本：逐题展示「选项 · 自定义：文本」；发到会话的全文按「题目标签：选项；自定义：文本」拼接；审批时间线追加「+ N 题自定义」。
- 卡片摘要上限：`summary` 240→600 字（服务端 `LIMITS.summary`、`kanban_create_card` / `kanban_update_card` schema 描述、Web 表单一致）；新建/编辑表单摘要标题行右侧新增「已用 / 600」字数计数；折叠卡仍只显示前两行、列表单行省略、详情抽屉完整展示。
- 复用 v0.9.1 的 `DecisionOption`（2 行截断 + hover/focus/长按看全文），翻页后的单个题目里同样生效。

### 验证

- 服务端 `node --test` 89/89（新增自定义回答校验 / 落库往返 / 判定 / 摘要上限共 4 例）；Web vitest 19 文件 / 158 测试（`approvalQuestions` 重写为 14 例：翻页草稿与互斥、custom-empty、会话文本、已解决展示、normalize custom）；`tsc --noEmit` 0 error；`vite build` 通过；令牌 lint 9 CSS 0 error / 0 warning。
- 隔离 dev-server（`/tmp/dsh-kanban-v091`，demo 数据）+ CDP / headless Chrome 实测：题目 pill 1/3→2/3→3/3、进度点 3 个、备注默认收起；选中「其他」后输入框展开且 `document.activeElement` 命中、计数 0/600；空自定义提交停在本题、红框 + 提示 + 输入框聚焦；两道自定义 + 一道选项 + 备注提交后审批 approved，`resolution.answers` 两条 custom 正确、拍平 `optionIds` 只含真实选项，已解决态显示「自定义：」；抽屉内同样有翻页与进度点、备注收起；390×844 移动端 pill 1/2 → 2/2，输入框聚焦、填写后计数；摘要表单 `maxLength=600`、计数 0/600→540/600、API 直提 500 字摘要成功；全程 console 0 error。
- 生效方式：本次含服务端改动（`lib/domain.js` / `lib/tools.js`），需要重启 DSH；只刷新页面会继续使用旧服务端（旧服务端不接受单题 custom，UI 会收到 400）。
- 证据：`design/screens/v0.9.2-*.png`；文档用 `docs/assets/screens/approval-pager-card.png`、`approval-custom-required.png`、`approval-resolved-custom.png`、`approval-summary-counter.png`、`approval-mobile-pager.png`、`approval-mobile-custom.png`。

## v0.9.1 — 2026-10-23

### 修复：「待你确认」卡片内选项文案溢出、被下一个选项遮住

- 现象：窄窗口（≤1280px，卡片列约 280px）或说明文案较长时，「待你确认」卡片里的选项文案从组件下边沿外溢、被下方选项的背景盖住，hover 也看不全。
- 根因：`.kb-decision-options` 是纵向 flex + `max-height: 260px` 的滚动容器，选项带显式 `min-height: 28px`；长文案换行后需要 84–132px，却被 flex-shrink 压到 61–99px，而文字 `overflow: visible` → 溢出边框并被下一项遮挡。不是「组件高度不够」，也不必须用 hover 才能看全。
- 修复（用户拍板 C 方案）：卡片内选项 label 与 description 各最多 2 行 + 省略号；完整文案通过 hover（桌面，320ms）、键盘 focus-visible 或移动端长按（450ms，移动超 8px 取消）在选项旁弹出提示。提示气泡 portal + fixed 定位，逃出卡片/列体/审批区的 overflow 裁剪，下方放不下自动翻到上方并夹在视口内；长按触发后吞掉抬起补发的 click，避免误选中。选项恢复自然高度（`flex: none`，连同 `.kb-decision-questions` 子项），总高度交给已有的 260px 内部滚动；详情抽屉内保持全文展开（不截断、不在选项内滚动）。
- 边界：未截断的选项不弹提示（如内置「其他（自行填写）」）；超长无空格串用 `overflow-wrap: anywhere` 折行，不撑破卡片；暗色气泡用 `--dsw-specific-tip` + `--dsw-alias-label-primary`（实测对比度正常）。
- 兼容：审批面板翻页 / 自定义回答重做（并行卡 card-502c6637）复用同一 `DecisionOption` 组件，新旧两种布局下均生效；不改审批提交与状态流转逻辑。
- 验证：Web vitest 19 文件 / 158 测试（新增 `tooltipPosition` 8 例、`longPress` 10 例）；tsc 0 error；`vite build` 通过；令牌 lint 9 CSS 0/0；服务端 89/89。隔离 dev-server 1440/1280/1180/1100/390 实测：选项溢出 0（修复前同文案 3/3 溢出 15–44px）、卡片高度不变；hover/focus-visible/长按/翻页/抽屉全文/Esc/滚动收起均通过；console 0 error。真实宿主 `/dsh-kanban/` 用真实待确认卡复测通过。证据 `design/screens/approval-option-clamp-*.png`、`approval-option-drawer-fulltext-1440.png`。

## v0.9.0 — 2026-10-23

### 界面收敛：优先级 / 标签暂从 Web UI 隐藏（保留 API 与数据）

- 决策：看板数据核查显示优先级只有展示用途（不排序、不筛选、不进「开始推进」提示），标签虽接了筛选/搜索但 36 个标签里 18 个只用过一次；按用户确认先隐藏 UI、保留能力，观察一版再决定是否彻底删。
- 移除的界面入口：新建/编辑卡片表单的「优先级」「标签」字段；看板卡片 P0–P3 徽标与标签；列表行标签；详情抽屉优先级 pill 与标签；筛选菜单「标签」分组；列表「按优先级分组」；搜索不再匹配标签。相应 i18n 键与 CSS 一并清理。
- 保留不变：`Card.priority` / `Card.labels` 数据字段、HTTP API、`kanban_create_card` / `kanban_update_card` 参数、`kanban_cards` 的 `label` 过滤、`kanban_card` 输出；旧卡片数据原样保留，没有任何迁移。
- 兼容：服务端本就忽略未知字段；旧调用方继续传 `priority`/`labels` 不会报错，只是界面不再展示。

### 验证

- Web vitest 17 文件 / 136 测试通过；`tsc` 0 error；服务端 85/85；真实 dev-server 预览截图 + console 0 error（见 docs/06 §1.16 与本卡证据）。
- 契约与文档同步：docs/contracts/01、02 注明 UI 隐藏；docs/03 属性行/徽章/分组/新建弹窗/响应式/无障碍/验收项同步；README 功能与使用表同步。

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
