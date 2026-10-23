# DSH 看板 · Web UI（web/）

Vite + React 18 + TypeScript 的看板前端，构建产物 `web/dist` 由插件静态路由直接服务（`/dsh-kanban/`）。

## 命令

```bash
# 从仓库根目录
npm --prefix web install          # 首次安装依赖（国内网络可加 --registry=https://registry.npmmirror.com）
npm --prefix web run dev          # Vite 开发服务器 http://127.0.0.1:5183，/api 代理到 4599
npm --prefix web run build        # tsc --noEmit + vite build → web/dist
npm --prefix web run typecheck    # 仅类型检查
npm --prefix web run test         # vitest 单测（分组 / 筛选 / 时间格式化）
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
    components/               # Toolbar/FilterMenu/BoardView/ListView/KanbanCard/DetailDrawer/
                              # ApprovalPanel/Timeline/Composer/SessionSection/Modal/Toast/Icons…
    styles/
      tokens.css              # 独立模式的 DSH 令牌兜底（亮/暗；嵌入后由宿主行内令牌覆盖）
      base.css app.css board.css list.css drawer.css modal.css responsive.css
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
  按状态创建并绑定/开始处理）；独立预览只建卡并给中性提示，看板/列表对进行中未绑定会话显示弱警示。
- **审批**：兼容单题与 v0.3 多问题（`questions[]`）。单题沿用 radio/复选框 + `optionIds[]`；多问题逐题渲染
  fieldset（header 小标题、序号、问题、单选/多选徽标、全部选项与说明），统一备注 +「提交全部回答」，提交前
  逐题校验并高亮/聚焦缺题，提交 `answers:[{questionId, optionIds[]}]`。卡片内 questions 限高滚动、详情内展开。
  resolved 逐题展示所选 labels（兼容旧 `resolution.optionIds/labels`）；多问题会话全文按
  `【看板·审批】已提交「title」：\n- header：A、B` 拼接（`session.ensure`，详情里可用目标会话覆盖）。
- **多会话**：详情抽屉列出卡片全部会话、主会话徽标、设为主会话（复用绑接口置顶）、解绑/打开；
  >1 个会话时可选「回复与审批同步到」的目标会话。
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
- `npm --prefix web run lint:tokens`：8 个 CSS 文件，0 error / 0 warning
  （`tokens.css` 是主题兜底值镜像，逐行标注了 `lint-tokens-ignore` 例外）。
- `npm --prefix web run test`：24 个单测（分组 / 筛选 / 时间格式化）。
- 截图：`design/screens/web-*.png`（宽屏看板、暗色、嵌入宿主安全区、列表分组、详情抽屉、多选审批、
  多问题审批的卡片/抽屉/列表/已解决态、通用审批弹窗、未发送决定提示、筛选浮层、快捷键帮助、
  390 竖屏看板/底部弹层/列表、与 mockup 的密度对照）。

## 待服务端配合 / 契约建议

1. `/state` 增加 `activities`（当前看板最近节点数组）可省掉每卡一次请求；不改也能跑（已按卡懒加载）。
2. 种子与写接口应返回完整 Card（`approvals/sessionIds/checklists/artifacts/metadata` 等空字段也返回），
   否则第三方客户端容易踩空；UI 已做归一化兜底。
3. `/cards/:id/move` 目前只回 `card`，若同时回 `board.cardOrder` 可减少一次 `/state` 刷新。
