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
- **主题**：嵌入时把父页面 `kanban:theme` 的 `tokens` 写到 `document.documentElement.style`；
  独立时用 `tokens.css` 的亮暗 fallback，跟随系统并写入 `data-kanban-theme`。
- **实时**：`EventSource /api/kanban/events`，revision 变化后 150ms 拉 `/state`；断线 1s→30s 退避；
  `document.hidden` 或父页面 `kanban:visibility=false` 时断开，恢复后重连。
- **乐观移动**：拖拽/菜单/键盘换列先本地改 `status + cardOrder`，失败整体回滚并 toast。
- **审批**：折叠卡内即可 批准/拒绝（方案单选 + 备注）；成功后经桥发
  `【看板·审批】已批准「…」：…`（`session.ensure`，优先用审批的 sessionId，否则主会话/卡片 cwd）。
- **回复**：先 `POST /cards/:id/comments` 写时间线，再经桥 `session.ensure` 发
  `【看板·卡片「标题」】\n…`；失败自动复制文本并提示。
- **时间线数据**：契约 `/state` 不含 activities；UI 在展开/打开卡片时按需请求
  `GET /cards/:id/activities`（builder-server 已实现），revision 变化时对可见卡片重拉；
  接口不可用时用卡片字段合成兜底节点。
- **卡片归一化**：契约要求「一律返回完整 Card」，但种子/写回可能省略空数组字段；
  `api.ts` 的 `normalizeCard` 补默认值，避免 UI 假设字段存在。
- **键盘**：`⌘K`/`Ctrl+K`/`/` 聚焦搜索、`N` 新建、`B`/`L` 切视图、`Enter`/`O` 打开详情、
  `Space` 展开、`Alt+←/→` 换列、`Esc` 关闭浮层；拖拽另有菜单「移动到…」替代。

## 合规与验收

- 样式只消费 `--dsw-alias-*` / `--dsw-font-*` / elevation / legacy motion 令牌，组件局部变量用 `--kb-*`；
  中性实线 0.5px、浮层 `border:0` + elevation、全圆配 `corner-shape: round`。
- `npm --prefix web run lint:tokens`：8 个 CSS 文件，0 error / 0 warning
  （`tokens.css` 是主题兜底值镜像，逐行标注了 `lint-tokens-ignore` 例外）。
- `npm --prefix web run test`：24 个单测（分组 / 筛选 / 时间格式化）。
- 截图：`design/screens/web-*.png`（宽屏看板、展开卡、详情抽屉、列表、暗色、390 竖屏看板/底部弹层/列表）。

## 待服务端配合 / 契约建议

1. `/state` 增加 `activities`（当前看板最近节点数组）可省掉每卡一次请求；不改也能跑（已按卡懒加载）。
2. 种子与写接口应返回完整 Card（`approvals/sessionIds/checklists/artifacts/metadata` 等空字段也返回），
   否则第三方客户端容易踩空；UI 已做归一化兜底。
3. `/cards/:id/move` 目前只回 `card`，若同时回 `board.cardOrder` 可减少一次 `/state` 刷新。
