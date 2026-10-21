# dsh-kanban-spike

DSH（DeepSeek Harness）0.1.5-rc.2 的**最小可安装插件**，用来验证 Kanban 项目所需的平台集成路径：

- 侧栏 `sidebar.panellist` 入口 + `layout` 的 root-scoped `main` keyed 全屏面板（主方案）；
- `shell.overlay` 浮层（fallback 方案，供对比）；
- 面板内同源 iframe（`/kanban-spike`），父页面 ↔ iframe 主题令牌桥与就绪握手；
- iframe 按钮 → 父页面 `ctx.sessions.binding(id).session.prompt([...], "queue")` **真的**向新会话发消息；
- `ctx.sessions.create/open/refresh/list` 与当前会话 id 获取；
- 服务端 `ctx.webServer.register`（页面 / 静态资源 / JSON API / SSE）与 `ctx.tools.register`（agent 工具）；
- `ctx.locale.register` 字典、CSS 注入、错误上报、HMR 结论。

详细调查结论、签名、坑与生产建议见 [`../../docs/02-dsh-integration.md`](../../docs/02-dsh-integration.md)。

## 目录

```
dsh-kanban-spike/
├── package.json          # dsh.bundle.patch + dsh.client（platform:web, inject）
├── cordis.patch.yml      # bundle 层：insert id=kanban-spike name=dsh-kanban-spike
├── lib/
│   ├── index.js          # 服务端：路由 + 工具 + 内存卡片仓库 + SSE
│   ├── client.js         # 客户端：window.__ModuleLoader__.load({id,factory})
│   ├── page.html         # iframe 页面骨架
│   └── web-dist/         # 静态资源（app.js / style.css），由自建静态 handler 提供
└── README.md
```

## 安装到 scratch profile

> 不要装进 `desktop` / `web` 等已有 profile；下面的 `kanban-spike` 是独立 scratch profile。

```bash
# 1) 从官方 web 模板初始化 scratch profile（首次；只创建配置，不启动服务器）
dsh --profile kanban-spike --from-default-profile web --dump-default-config > /dev/null

# 2) 安装本插件（本地路径；路径含空格也可以，注意引号）
dsh plugin --profile kanban-spike add "/Users/roxor/Desktop/dsh/dsh kanban/spike/dsh-kanban-spike"

# 3) 确认安装结果
dsh plugin --profile kanban-spike list --depth 0
dsh --profile kanban-spike --dump-config | grep -A2 'kanban-spike'
cat ~/.dsh/profiles/kanban-spike/package.json   # dependencies 有 link:…；dsh.profile.bundles 有 dsh-kanban-spike
```

安装会改三处：`~/.dsh/profiles/kanban-spike/package.json`（dependency + `dsh.profile.bundles`）、
`~/.dsh/profiles/kanban-spike/node_modules/dsh-kanban-spike`（指向本目录的符号链接）、
`~/.dsh/profiles/kanban-spike/.plugin-manager/logs/`（pnpm 操作日志）。

## 启动与验证

```bash
dsh --profile kanban-spike --port 0 --no-open
# 输出形如：dsh web: http://127.0.0.1:<port>/?token=<launch-token>
```

浏览器打开上面的 URL（token 用于换 cookie，会 303 到 `/`）。手工验证点：

1. 左侧栏出现「看板」入口，底部出现「看板浮层」（`shell.overlay` 方案）；
2. 点「看板」后中心列被 main 面板占满，iframe 内显示 3 张种子卡片，右上角显示主题桥已连接、同步到的 `--dsw-*` 令牌数（≈23）；
3. 点 iframe 内「发送到新会话」→ 父页面创建会话并 `session.prompt(..., "queue")`，约 2 秒后 agent 调用 `kanban_spike_add_card`，卡片数变 4（SSE 推送 + 3s 轮询兜底）；
4. 点「查看会话 …」→ 切回官方 Conversation，可看到本次工具调用；
5. 点侧栏底部「看板浮层」→ 覆盖全窗口的 `shell.overlay` 版本。

纯 curl 验证（不需要浏览器）：

```bash
BASE=http://127.0.0.1:<port>
curl -s "$BASE/api/kanban-spike/state"                       # {"ok":true,"count":3,"cards":[...]}
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/kanban-spike"          # 200
curl -s -D - -o /dev/null "$BASE/kanban-spike-static/app.js"           # 200 application/javascript
curl -s -N --max-time 2 "$BASE/api/kanban-spike/events"                # SSE: event: hello
curl -s --path-as-is -o /dev/null -w '%{http_code}\n' "$BASE/kanban-spike-static/%2e%2e%2f..%2findex.js"  # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: http://evil.example' \
  -H 'content-type: application/json' --data '{"title":"x"}' "$BASE/api/kanban-spike/cards"  # 403
```

实测证据（截图 / curl 记录 / E2E JSON / 工具可见性）在
[`docs/assets/dsh-integration/`](../../docs/assets/dsh-integration/)：
`01-sidebar-entry.png`、`02-main-panel-iframe.png`、`03-prompt-and-tool-updated.png`、
`04-session-opened.png`、`05-overlay-fallback.png`、`curl-verification.txt`、
`e2e-results.json`、`hmr-result.json`、`session-tool-evidence.json`。

## iframe ↔ 父页面消息协议

| 方向 | type | 负载 | 说明 |
|---|---|---|---|
| iframe→父 | `kanban:ready` | `{version:1}` | iframe 脚本末尾发一次；父页面收到后回发主题 + host-info |
| 父→iframe | `kanban:theme` | `{mode:"light"\|"dark", tokens:{--dsw-*:值}}` | 加载后 / ready / body 属性变化（防抖 50ms）时发送 |
| 父→iframe | `kanban:host-info` | `{current, ids, phase, cwd}` | 当前会话 id 与列表规模；空表示发送时会新建 |
| iframe→父 | `kanban:send` | `{target:"new"\|"current", text, cwd}` | 父页面执行 `sessions.create/refresh/open` + `binding.session.prompt` |
| 父→iframe | `kanban:send:result` | `{ok, sessionId?, created?, message?}` | prompt 被接受/失败的结果（不是 agent 完成） |
| iframe→父 | `kanban:open-session` | `{sessionId}` | `sessions.open(id)` + `layout.selectPanel(null)` 切回 Conversation |

双方都校验 `event.origin === location.origin` 且 `event.source === iframe.contentWindow`（父侧）。

## 已知限制（spike 范围）

- 卡片仓库是**进程内存**，重启归零；生产要换持久化（JSON/SQLite）并考虑多窗口一致性。
- 自定义 `/api/kanban-spike/*` 路由比官方 `/api` 前缀更长，会**绕过** client-connection 的 cookie 认证与 Host/Origin 防区，因此本插件自建了同源校验；生产必须保留并加固。
- iframe 内的 UI 不参与 DSH 主题 CSS 继承，只能靠主题桥；桥固定同步 23 个令牌，令牌清单要随 DSH 版本维护。
- `shell.overlay` 浮层没有官方焦点陷阱/Esc 关闭，本 spike 未实现；生产若用作模态，需要自己补（可参考 dsh-video-companion 的 `LibraryOverlay`）。
- 服务端 `lib/index.js` 改动**不会热重载**，必须重启 `dsh` 进程；客户端 `lib/client.js` 改动会被 `dsh-client-hmr` 自动热替换（实测 1→2 版本无刷新，见 `hmr-result.json`）。

## 卸载 / 清理

```bash
dsh plugin --profile kanban-spike remove dsh-kanban-spike
# 彻底清理（含 scratch profile 的配置、node_modules、日志）
rm -rf ~/.dsh/profiles/kanban-spike
# 若用过了独立 home：rm -rf /tmp/dsh-spike-home
```

注意：`remove` 后 `node_modules/dsh-kanban-spike` 符号链接可能残留（pnpm 对 `link:` 依赖的行为），
但 `dsh.profile.bundles` 已移除该包，`dump-config` 不再出现 `kanban-spike`，重启后插件不会加载。
