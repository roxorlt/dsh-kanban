# DSH 看板 · dsh-kanban

一个跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里的原生看板插件。
**卡片是控制面，DSH 会话是执行面**：你在看板里管理"要做什么、到哪了、需要你决定什么"，agent 在会话里执行，并通过原生工具把进展写回卡片。卡片内回复会直接进入绑定的 DSH 会话，会话里的决定也会回到卡片。

> 状态：v0.7.2，已在 DSH `0.1.5-rc.2` / 桌面 `0.2.1-rc.2` 上完成端到端验证（安装 → 侧栏 → 全屏面板 → 会话桥 → agent 工具 → 审批回写）。数据存本机 `~/.dsh-kanban/data.json`。
> 仓库：[github.com/roxorlt/dsh-kanban](https://github.com/roxorlt/dsh-kanban)

![看板视图（真实 DSH 内）](docs/assets/screens/embedded-board-light.png)

## 功能

- **看板 / 列表双布局**：四列（待办、进行中、待你确认、已完成），可切换为按列分组的列表。
- **卡片 CRUD + 拖拽**：新建、编辑、归档、拖拽换列；列内排序持久化；乐观更新失败自动回滚。
- **卡片摘要分层**：一句话摘要 → 当前动作 → 最近节点 → 结果 → 待决策；折叠、展开、详情三档信息密度。
- **重要节点时间线**：状态变化、进展、评论、审批、会话绑定、产物全部记录。
- **审批与确认**：卡片进入"待你确认"时带结构化待定项（单选 / 多选 / **多问题** + 备注），所有选项与说明在卡片内完整展示；逐题作答后决定直接发回会话；对齐 DSH `ask_user_question`。
- **开始推进**：待办卡片一键移入进行中并启动/续接主会话，附带目标与验收提示；失败自动回滚。
- **新建建议**：工作区/目录/项目/会话建议来自 DSH 工作区与会话记录；进行中新建卡自动建会话并交给 agent；详情可先选目录补建会话。
- **交接摘要（handoff）**：agent 可在会话暂停/归档前写入交接摘要；详情只读展示+复制，新会话启动时自动拼入提示续接。
- **卡片内回复**：回复写时间线，并通过桥进入 DSH 会话；没有会话时可从卡片新建；待办卡回复不会隐式改状态。
- **会话返回看板**：DSH 会话标题右侧提供「看板」按钮，从卡片打开的会话可一键回看板。
- **会话绑定**：选择已有会话作为主会话、打开会话跳转 DSH 对话、显示运行状态。
- **实时刷新**：SSE 推送 revision，断线指数退避，页面隐藏暂停；手动重试只在断连错误条出现。
- **批量操作**：工具栏「选择」进入选择模式（与拖拽手势分离），批量移动到列 / 批量归档；列表视图同样支持。
- **自动归档**：已完成/已取消卡片超过 30 天自动归档（`autoArchiveDays` 可配，0 关闭），不删除数据。
- **密度与规模**：已完成列只显示最近 5 张（查看全部进入列表）；列表支持按状态/项目/优先级分组；时间线分页加载；卡片内素材用紧凑媒体行。
- **横竖屏响应式**：宽屏四列，窄屏列分段 + 单列 + 底部弹层；跟随 DSH 明暗主题。
- **Agent 原生工具**：10 个 `kanban_*` 工具，agent 不需要学 HTTP 就能建卡、推进、请求审批、写结果。
- **本地优先**：JSON 存储、原子写、损坏自动备份重建；无云端依赖。

## 已验证

- 服务端 `node --test`：**67/67 通过**；Web `tsc` + Vite 构建通过，vitest 110/110，令牌 lint 0 error / 0 warning。
- 在**独立 DSH profile** 中真实安装并加载：侧栏入口、`main` 全屏面板、iframe 桥就绪、49 个主题令牌同步、明暗主题、console 0 error。
- 会话桥：`session.create → refresh → open → binding → prompt` 实测 `accepted: true`。
- agent 工具：真实 agent 调用 `kanban_create_card` 创建卡片，SSE 实时出现在看板。
- 审批闭环：看板内「批准」→ 决定写入绑定会话 → agent 通过工具把卡片移到已完成并写结果。
- v0.2 回归：多选审批提交 `optionIds:["unit-test","build"]`、时间线 `before` 分页、脏草稿二次确认、列表按项目分组、done 折叠、竖屏动作区，Playwright 全部通过。
- v0.2.1 修复：DSH 0.2.x 会话 API 兼容（`uiWorkspace.openSession` / `sessions.using`）、三态主题、宿主安全区、快捷键、筛选空文案、审批未绑定兜底。
- v0.3.0 多问题审批；v0.3.1 列表审批动作左对齐；v0.4.0 批量选择 + 自动归档（67 服务端 / 57 Web 测试）。
- 截图与复跑命令见 [验证记录](docs/06-verification.md)。

| 真实 DSH 内（亮） | 真实 DSH 内（暗） |
| --- | --- |
| ![亮色](docs/assets/screens/embedded-board-light.png) | ![暗色](docs/assets/screens/embedded-board-dark.png) |

| 卡片展开（多选审批） | 详情抽屉（多会话/审批回写） |
| --- | --- |
| ![多选审批](docs/assets/screens/approval-multi.png) | ![详情](docs/assets/screens/detail-drawer.png) |

| 列表视图（按项目分组） | 已完成防膨胀 |
| --- | --- |
| ![列表分组](docs/assets/screens/board-list-groups.png) | ![done 折叠](docs/assets/screens/board-list-done.png) |

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
    seed: empty          # demo（默认）| empty
    dataDir: /path/to/data
```

## 使用

| 动作 | 怎么做 |
| --- | --- |
| 新建卡片 | 列底「+ 新建」或顶部「新建」；填标题、摘要、项目、标签、优先级 |
| 推进卡片 | agent 用工具自动移动；你也可以拖拽或卡片菜单「移动到」 |
| 查看进展 | 点卡片文字区域或右上箭头展开"重要节点"；双击卡片或点「详情」看完整时间线、清单、产物 |
| 处理待定项 | 卡片展开后审批区选择方案 / 批准 / 拒绝，可附备注；决定自动发回会话 |
| 回复 agent | 卡片详情底部输入框，发送后进入绑定的主会话 |
| 绑定会话 | 详情 →「会话」→ 选择已有会话，或「新建会话」 |
| 打开会话 | 详情 →「打开会话」，跳转 DSH 对话面板 |
| 切换布局 | 工具栏 Board / List；筛选、搜索、按项目/标签过滤 |
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
| `kanban_create_card` | 建卡 |
| `kanban_update_card` | 更新摘要、当前动作、结果、优先级、清单、产物等 |
| `kanban_move_card` | 移动状态/列（agent 自主推进） |
| `kanban_add_activity` | 追加进展节点 |
| `kanban_request_approval` | 请求授权/方案选择（卡片进入待你确认） |
| `kanban_link_session` | 绑定会话 |
| `kanban_complete_card` | 完成卡片并写结果 |

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
```

目录结构：

```
lib/
  client.js       # DSH 客户端插件：侧栏入口 + main 面板 + iframe 桥
  index.js        # DSH 服务端插件：路由、工具、SSE
  store.js        # 本地 JSON 存储（原子写 / 乐观锁 / revision）
  domain.js       # 状态与列、种子数据、节点构造
  routes.js       # REST API + SSE + 静态资源
  tools.js        # 10 个 kanban_* agent 工具
web/              # 看板 UI（React + Vite），构建产物 web/dist
skills/           # agent 工作流技能
docs/             # 分析、契约、设计、架构、验证
```

## 文档

- [参考项目分析：Codex Taskboard 的核心功能与会话信息架构](docs/01-reference-analysis.md)
- [DSH 插件机制与集成要点](docs/02-dsh-integration.md)
- [设计规范与响应式规格](docs/03-design-system.md)
- [架构与信息架构](docs/04-architecture.md)
- [契约：数据模型](docs/contracts/01-data-model.md) / [HTTP API](docs/contracts/02-http-api.md) / [客户端桥](docs/contracts/03-client-bridge.md)
- [验证记录（含 0.2.1 宿主）](docs/06-verification.md)
- [Deep link 提案（已搁置，应用内打开会话已实现）](docs/08-deeplink-proposal.md)
- [OpenDesign 设计/动效 skill 调研](docs/09-design-motion-skills.md)
- [视觉审计（进行中）](docs/10-visual-audit.md)

## 已知限制

- 每个 workspace 一个看板的模式尚未实现（M2）。
- 卡片内回复只进主会话；多会话回复目标选择器在 v1.1（设计稿已含状态）。
- 会话事件（工具调用数、耗时）目前由 agent 工具写入；自动回填在 M3。
- 审批与 DSH 原生工具审批（bash 等）是两套收件箱，是否合并待评估。
- 无团队协作/云端同步，数据仅本机。
- 未做超大看板（>500 卡）压力测试与真机软键盘验证；旧版 DSH 仅保证降级不崩溃。

## 路线图

| 阶段 | 内容 |
| --- | --- |
| M1（当前） | 单看板、四列、CRUD、审批、会话绑定、卡片内回复、SSE、双布局、响应式、agent 工具与技能 |
| M2 | 多会话回复目标、handoff 交接摘要、卡片依赖与阻塞、审批收件箱合并、按 workspace 分看板 |
| M3 | 会话事件自动回填（工具调用数 / 耗时 / 搜索结果数）、审批与原生审批联动、卡片自动重开、周期卡 |
| M4 | 团队协作、GitHub/Jira 集成、仪表盘（吞吐/阻塞时长）、导出 Markdown/JSON |

## 致谢

信息架构与卡片要素参考了 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（Codex Taskboard）；UI 遵循 DSH 的 alias 令牌与设计规范。

## License

MIT
