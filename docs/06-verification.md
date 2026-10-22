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
