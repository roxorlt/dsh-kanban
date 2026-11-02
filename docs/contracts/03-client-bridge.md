# 看板 ↔ DSH 客户端桥契约 v0.1（冻结）

看板 UI 运行在 `lib/client.js` 注册的全屏面板里的同源 iframe（`/dsh-kanban/`）。iframe 不能直接访问 DSH 的 React 服务，所有原生能力经 `postMessage` 桥接。

## 1. 通道

- `iframe.contentWindow.postMessage(msg, location.origin)`，两端都校验 `event.origin === location.origin`、`event.source`。
- 消息必须带 `version: 1`（本契约版本）。
- 请求-响应配对：iframe 生成 `requestId`（crypto.randomUUID），父页面回包带同一 id。
- 父页面 → iframe 的推送不配对，按 `type` 分发。

## 2. iframe → 父页面

```ts
type IframeMessage =
  | { type: 'kanban:ready'; version: 1 }
  | { type: 'kanban:request'; version: 1; requestId: string; method: BridgeMethod; params?: unknown };
```

父页面响应：

```ts
type ParentResponse =
  | { type: 'kanban:response'; version: 1; requestId: string; ok: true; data: unknown }
  | { type: 'kanban:response'; version: 1; requestId: string; ok: false; error: { code: string; message: string } };
```

### BridgeMethod 一览

| method | params | data | 说明 |
| --- | --- | --- | --- |
| `app.info` | – | `{locale:'zh'|'en', themeMode:'light'|'dark', dshVersion?:string, panelVisible:boolean}` | 启动握手后调用 |
| `sessions.list` | – | `{sessions: SessionRow[], current: string|null}` | 供卡片绑定会话选择器；`SessionRow` 含 `cwd`（v0.7） |
| `workspaces.list` | – | `{workspaces: WorkspaceRow[]}` | v0.7：DSH 左侧工作区（`workspaceId/title/path/sessionIds`），用于新建卡片的项目/cwd/会话建议与回填；v0.19 起也是绑定会话选择器的工作区分组 / 默认范围来源（无新增桥字段） |
| `sessions.refresh` | – | `{sessions, current}` | 手动刷新 |
| `session.open` | `{sessionId}` | `{ok:true}` | 选中会话并切到对话面板（父页面调 `ctx.layout.selectPanel(null)`） |
| `session.create` | `{cwd?, workspaceId?, title?}` | `{sessionId}` | 新建会话（不自动打开） |
| `session.prompt` | `{sessionId, text, mode?:'queue'|'steer'}` | `{accepted:true}` | 向会话发送一条用户消息。**创建会话 + 首次 prompt 用 `session.ensure`** |
| `session.ensure` | `{sessionId?, cwd?, workspaceId?, text}` | `{sessionId, created:boolean}` | 有 id 就复用，没有就建；随后 prompt。用于"卡片内直接回复" |
| `card.open` | `{cardId, boardId}` | `{ok:true}` | 让看板 UI 自己处理，父页面仅记录 lastCard（可选） |
| `panel.select` | `{panel:'kanban'|'conversation'}` | `{ok:true}` | 切换主面板 |
| `toast` | `{text, tone?:'info'|'success'|'error'}` | `{ok:true}` | 可选：让父页面用 DSH 风格提示；MVP 允许 iframe 自绘 |
| `host.capabilities` | – | `{revealPath:boolean}` | v0.24：宿主能力探测（详见 §8）；旧版宿主返回 `UNKNOWN_METHOD` |
| `host.revealPath` | `{path}` | `{ok:true}` | v0.24：把工作副本目录在 Finder / 文件管理器中定位（详见 §8） |

`SessionRow`：`{ id: string; title: string; running: boolean; updatedAt: number; workspaceId?: string; cwd?: string }`。

> v0.19 绑定会话选择器：默认只列「卡片所属工作区」的会话（workspaceId → cwd 最长前缀 → 已绑定会话推断），工作区归属优先看 `workspaces.list` 的 `sessionIds`、其次按 `cwd` 前缀匹配；`sessions` 列表没给出但工作区注册表里有的会话会补兜底行。

`WorkspaceRow`：`{ workspaceId: string; title: string; path: string; sessionIds: string[]; updatedAt?: number }`。

## 3. 父页面 → iframe

```ts
type ParentPush =
  | { type: 'kanban:theme'; version: 1; mode: 'light'|'dark'; tokens: Record<string,string> }
  | { type: 'kanban:sessions'; version: 1; sessions: SessionRow[]; current: string|null }
  | { type: 'kanban:visibility'; version: 1; visible: boolean }
  | { type: 'kanban:host'; version: 1; locale: 'zh'|'en'; dshVersion?: string };
```

- `kanban:theme`：iframe 加载后先发一次，收到 `kanban:ready` 再发一次；宿主主题变化时 50ms debounce 重发。iframe 把它写到 `<html data-kanban-theme>` 与 CSS 变量（仅覆盖 fallback，token 名与 DSH 一致）。
- `kanban:sessions`：父页面订阅 `ctx.sessions.list`，节流 500ms 推送。
- `kanban:visibility`：面板切走时通知 iframe 暂停 SSE 重连与轮询。

## 4. 父页面（client.js）实现要点

- 注册：
  - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'kanban', order: 20, label: ... }, KanbanIcon))`
  - `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'kanban' }, KanbanPanel))`
- 打开：侧栏项点击由 sidebar 调 `ctx.layout.selectPanel('kanban')`（以 integrator 验证为准；不生效则在图标组件里主动调用）。
- 会话能力：`ctx.inject(['sessions','workspaces'], ctx => { ... })`；`ctx.sessions.binding(id)?.session`，缺失先 `await ctx.sessions.refresh()`；`prompt` 前如需新建：`await ctx.sessions.create({cwd, workspaceId})`。
- 发送消息文本格式（看板追加的可读前缀）：
  - 普通回复：`【看板·卡片「标题」】\n{用户输入}`
  - 审批通过：`【看板·审批】已批准「{approval.title}」：{optionLabel}{comment ? '\n备注：'+comment : ''}`
  - 审批拒绝：`【看板·审批】已拒绝「{approval.title}」：{optionLabel}{...}`
  - 请求讨论：`【看板·卡片「标题」】想和你讨论：{用户输入}`
- 顺序：iframe 先把回复写入卡片 comments（`POST /comments`）形成时间线，再调用桥 `session.ensure`；桥失败时保留时间线并提示错误，同时提供复制文本降级（不删除已写节点，便于用户在看板内看到自己说过什么）。

## 5. 降级

- 父页面缺少 sessions 服务（旧版 DSH）：桥仍返回 `sessions.list=[]`，`session.*` 返回 `{code:'SESSION_UNAVAILABLE', message:'当前 DSH 版本不支持会话操作，粘贴文本到对话仍可用'}`，UI 显示复制按钮。
- 直接以浏览器打开 `/dsh-kanban/`（无父页面）：`window.parent === window`，UI 进入"独立模式"：不显示会话操作，仅看板 CRUD；便于开发与截图。

## 6. 安全

- 只接受同源消息；父页面对 method 做白名单，禁止透传任意函数名。
- iframe sandbox 不设置 allow-scripts 以外的权限（同源路由本身可信）。
- 不把 token、路径、附件字节经桥传输；`cwd` 仅来自卡片自身字段或 DSH workspace。

## 7. v0.11 增量：会话归档联动

- `kanban:sessions` 推送新增可选字段 `archivedSessionIds: string[]`（来自父页面 `ctx.workspaces.list` 快照的 `archivedSessionIds`）；宿主/旧版本缺失时按空数组处理。
- 父页面订阅 `ctx.workspaces.list` 的失效通知并按既有节流重推 `kanban:sessions`（归档/恢复/置顶/工作区变化都会触发）。
- 会话使用前自动恢复：`session.open` / `session.prompt` / `session.ensure` 在执行前检查归档集合；命中则先 `ctx.uiWorkspace.unarchiveSession(sessionId)`（幂等）再继续。恢复失败（宿主无能力/调用失败）返回 `{code:'SESSION_ARCHIVE_UNAVAILABLE'}`，**不得**把消息继续发进归档会话（会被归档闸门静默拦下）。
- iframe 侧以 `GET /api/kanban/sessions/archive` 做首屏能力/状态回填，之后以推送为准。

## 8. v0.24 增量：工作副本「在 Finder 中打开」（host.capabilities / host.revealPath）

- 需求：工作副本行提供「在 Finder 中打开」，把该目录在宿主桌面的 Finder（Windows = 资源管理器，Linux = 文件管理器）里定位。iframe 没有系统权限，所以由父页面调用 DSH 客户端 Remote 完成。
- **DSH 侧能力（0.2.x 已内建，本插件不新增/不修改宿主 API）**：客户端插件注入 `remote` 服务后可用
  - `ctx.remote.session.canOpenWorkspacePath()` → `{ok:true, value:boolean}`：本部署能否把宿主机路径交给原生桌面（无需会话；SSH 会话、无桌面后端为 false）。
  - `ctx.remote.session.openWorkspacePath({ path, action:'reveal' })` → `{ok:true, value:{opened:true}}`：宿主先 `verifyDesktopPath`（路径映射校验 + resolve）再执行原生定位（macOS = `open -R`）。失败返回 `{ok:false, error:{code, message}}`。
  - 参考实现：`@deepseek-ai/dsh-api-session-controller` 的 `session/canOpenWorkspacePath` / `session/openWorkspacePath`，原生命令在 `@deepseek-ai/dsh-native-command` 的 `revealNativePath`。
- **桥方法**：

| method | params | data | 说明 |
| --- | --- | --- | --- |
| `host.capabilities` | – | `{ revealPath: boolean }` | 能力探测；旧版宿主返回 `UNKNOWN_METHOD`，iframe 按「不支持」处理并隐藏入口 |
| `host.revealPath` | `{ path }` | `{ ok: true }` | 在 Finder / 文件管理器中定位该目录 |

- **权限边界（两道，目的：只允许工作副本目录，不提供「打开任意路径」能力）**：
  1. iframe 侧：只允许传入服务端 `/git/workspaces` 工作区地图里的仓库根 / 工作副本路径（精确匹配，`web/src/lib/revealPath.ts`；服务端只接受由看板卡片 `cwd` 推导出的仓库）。任意路径、子目录、命令串都不在允许集合里。
  2. 父页面侧：`host.revealPath` 只接受**绝对路径**（POSIX `/…` 或 Windows `C:\…`），拒绝空值 / 超长（>1024）/ 控制字符 / 含 `..` 段；随后宿主 `verifyDesktopPath` 再复核一次路径映射。
- **错误码**：`REVEAL_BAD_PATH`（参数不是合法的绝对路径）、`REVEAL_UNAVAILABLE`（旧版宿主 / 独立预览 / 非桌面环境 / 能力探测为 false）、`REVEAL_FAILED`（宿主拒绝或原生命令失败，`message` 带宿主原因）。失败时 iframe 用 toast 提示「无法在 Finder 中打开：{message}」，其它功能不受影响。
- **降级**：`host.capabilities` 失败、返回 false，或 iframe 处于独立预览模式（无父页面）→ 不渲染「在 Finder 中打开」按钮；旧版宿主的其它桥能力与看板功能不变。
- iframe 侧调用顺序：点击 → 校验路径属于允许集合 → `host.revealPath` → 失败提示；成功不额外提示（Finder 窗口即反馈）。

