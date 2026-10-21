# Deep link 提案：`dsh://` → 看板卡片 / 对话会话

> 状态：提案，需 DSH 桌面端支持；插件侧已留兜底。
> 背景：用户希望从外部（邮件、文档、终端）点链接直接打开「某会话的某张卡片」。

## 1. 现状（已核实，2026-10-21）

- `DeepSeek Harness.app` 的 `Info.plist` 已注册 URL scheme：`dsh`（`CFBundleURLSchemes = [dsh]`）。
- Electron 主进程 `app.on("open-url")` 目前只处理：
  - `dsh://open` / `dsh://open/` → `focusPrimaryWindow()`；
  - 其它 URL 仅 `event.preventDefault()`，**既聚焦窗口也不转发给渲染进程**。
- 因此 `dsh://session/<sessionId>#<cardId>` 现在不会产生任何导航行为，用户侧表现为「点了没反应」。
- Web 客户端没有接收外部 URL 的通道；`window.__DSH_DESKTOP__` 里也没有 open-url 事件。

## 2. 提案协议

推荐（带参数，扩展性更好）：

```
dsh://open?session=<sessionId>&card=<cardId>
```

备选（路径式，更短）：

```
dsh://session/<sessionId>#<cardId>
```

语义：

| 参数 | 必填 | 行为 |
| --- | --- | --- |
| `session` | 否 | 聚焦窗口后打开该会话（等价于 `uiWorkspace.openSession(sessionId)`） |
| `card` | 否 | 打开看板面板并定位到该卡片（若同时有 session，先打开看板再显示卡片） |
| 都不给 | – | 等价 `dsh://open`：只聚焦窗口 |

约束：

- `sessionId` 必须匹配 `^session-[A-Za-z0-9-]{8,}$`；`cardId` 必须匹配 `^card-[a-f0-9]{6,8}$`；不合法直接忽略并聚焦窗口，不报错弹窗。
- 只做导航，不执行命令/不写数据；外部链接无法触发任何破坏性操作。
- 同一 URL 去重（例如 2s 内重复 open 只处理一次）。

## 3. 宿主需要做的最小改动

1. **主进程**：`open-url` 中解析 URL → `focusPrimaryWindow()` → 把解析结果发给主渲染进程：
   ```js
   app.on('open-url', (event, url) => {
     event.preventDefault();
     focusPrimaryWindow();
     const parsed = parseDshUrl(url);            // 新增
     if (parsed) win.webContents.send('dsh:open-url', parsed);
   });
   ```
   冷启动时（app 未就绪）先缓存最后一个 URL，`did-finish-load` 后补发。
2. **preload**：把 IPC 暴露成受控事件，而不是任意函数：
   ```js
   contextBridge.exposeInMainWorld('__DSH_DEEPLINK__', {
     onOpen(callback) { ipcRenderer.on('dsh:open-url', (_e, payload) => callback(payload)); },
     takeLast() { return ipcRenderer.sendSync('dsh:take-last-deeplink'); },
   });
   ```
3. **Web 客户端**（`apps/web` 或 shell 插件）：启动时读取/订阅该事件，调用 `uiWorkspace.openSession`；看板插件订阅一个客户端事件（或读 `window.__DSH_DEEPLINK__`）执行 `layout.selectPanel('kanban')` + 打开卡片详情。
4. **可选**：在 Web profile / 浏览器版里，用 hash 路由 `#/card/<id>` 与 `?session=` 提供同等能力，不依赖桌面壳。

## 4. 插件侧兜底（已完成）

- 卡片详情「打开会话」：`ctx.sessions`（0.1.x）或 `ctx.uiWorkspace.openSession`（0.2.x）→ 原生导航。
- 看板 URL 支持 `#/card/<cardId>`（面板内定位，可复制给同窗口使用）。
- 复制链接时给出的是「面板内链接 + 说明」，不会给一个当前无行为的 `dsh://` 链接。

## 5. 验收标准（宿主侧）

- [ ] 冷启动点 `dsh://open?session=X`：窗口出现并打开会话 X。
- [ ] 已运行点 `dsh://open?session=X&card=Y`：聚焦窗口、切到看板、定位卡片 Y。
- [ ] 非法/未知参数：只聚焦窗口，无报错弹窗、无副作用。
- [ ] 重复点击同一链接不会重复导航/重复创建会话。
- [ ] 不修改 `app.asar` 的前提下，仅通过 IPC + preload 暴露受控事件。
