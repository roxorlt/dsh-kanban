// dsh-kanban-spike —— 客户端半边（浏览器 bundle）
//
// 加载格式：`window.__ModuleLoader__.load({ id, factory })`。
// 执行 bundle 只注册工厂；工厂在首次 materialize 时运行，所有副作用
// （含 CSS 注入、slots 注册）都发生在 factory 闭包里（DSH lazy-CJS 模型）。
//
// 本文件提供：
//   1. sidebar.panellist 入口 + layout root-scoped "main" keyed 面板（主方案）；
//   2. shell.overlay 浮层（fallback 方案，供对比）；
//   3. 同源 iframe + 主题令牌桥 + iframe→父页面 action 桥；
//   4. 通过 ctx.sessions.binding(id).session.prompt([...], "queue") 真正发消息；
//   5. locale 字典注册、错误上报。
window.__ModuleLoader__.load({
  id: "dsh-kanban-spike",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var NS = "kanban-spike";
    var FRAME_URL = "/kanban-spike";

    // ---- 错误上报（也挂在 window 上，便于自动化读出真实客户端错误）----
    var errors = [];
    function reportError(where, error) {
      var message = String((error && (error.message || error)) || "unknown");
      errors.push({ where: where, message: message, at: Date.now() });
      if (errors.length > 50) errors.shift();
      // eslint-disable-next-line no-console
      console.error("[dsh-kanban-spike] " + where + ":", error);
    }
    window.__DSH_KANBAN_SPIKE__ = { errors: errors, version: 1 };

    function safe(where, fn) {
      try {
        return fn();
      } catch (error) {
        reportError(where, error);
        return undefined;
      }
    }

    // ---- 主题令牌桥（parent → iframe）----
    // iframe 是独立文档，不继承父页面 body 的内联 CSS 变量，因此父页面必须
    // 取值并通过 postMessage 发送；iframe 侧把它们 setProperty 回自己的 :root。
    var THEME_TOKENS = [
      "--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2", "--dsw-alias-bg-layer-3",
      "--dsw-alias-bg-skeleton", "--dsw-alias-label-primary", "--dsw-alias-label-secondary",
      "--dsw-alias-label-tertiary", "--dsw-alias-label-caption", "--dsw-alias-label-primary-foreground",
      "--dsw-alias-border-l1", "--dsw-alias-border-l2", "--dsw-alias-border-l3",
      "--dsw-alias-interactive-bg-hover", "--dsw-alias-interactive-bg-active",
      "--dsw-alias-button-primary-fill", "--dsw-alias-button-primary-hover",
      "--dsw-alias-state-business-primary", "--dsw-alias-state-error-primary", "--dsw-alias-state-success-primary",
      "--dsw-alias-state-warn-primary", "--dsw-alias-link",
      "--dsh-content-font-size",
    ];

    function themeMode() {
      var dark = function (node) {
        return Boolean(node) && (node.hasAttribute("data-ds-dark-theme") || node.getAttribute("data-ds-theme") === "dark");
      };
      return dark(document.body) || dark(document.documentElement) ? "dark" : "light";
    }

    function themeTokens() {
      var nodes = [document.body, document.documentElement].filter(Boolean);
      var styles = nodes.map(function (node) { return window.getComputedStyle(node); });
      var tokens = {};
      THEME_TOKENS.forEach(function (name) {
        for (var i = 0; i < styles.length; i++) {
          var value = styles[i].getPropertyValue(name).trim();
          if (value) { tokens[name] = value; break; }
        }
      });
      return tokens;
    }

    function postToFrame(frame, payload) {
      try {
        if (frame && frame.contentWindow) frame.contentWindow.postMessage(payload, window.location.origin);
      } catch (error) {
        reportError("postToFrame", error);
      }
    }

    /** 主题桥发送端：加载后发、收到 kanban:ready 重发、宿主主题变化防抖 50ms 重发。 */
    function useThemeBridge(active, frameRef) {
      React.useEffect(function () {
        if (!active) return undefined;
        var frame = frameRef.current;
        if (!frame) return undefined;
        var timer = null;
        var post = function () {
          postToFrame(frame, { type: "kanban:theme", version: 1, mode: themeMode(), tokens: themeTokens() });
        };
        var schedule = function () {
          if (timer) clearTimeout(timer);
          timer = setTimeout(post, 50);
        };
        var onMessage = function (event) {
          if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
          if (!event.data || event.data.type !== "kanban:ready") return;
          // 握手成功后同时补发主题与会话状态：theme 是渲染前提，host-info 让 iframe 知道当前会话。
          post();
          postToFrame(frame, Object.assign({ type: "kanban:host-info" }, hostInfo()));
        };
        var observer = new MutationObserver(schedule);
        if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "data-ds-theme", "style"] });
        frame.addEventListener("load", post);
        window.addEventListener("message", onMessage);
        post();
        return function () {
          if (timer) clearTimeout(timer);
          observer.disconnect();
          frame.removeEventListener("load", post);
          window.removeEventListener("message", onMessage);
        };
      }, [active]);
    }

    // ---- 会话能力：ctx.inject(["sessions","workspaces"]) ----
    var nativeDeps = null;
    var layoutService = null;

    function currentCwd() {
      var deps = nativeDeps;
      if (!deps) return undefined;
      var snapshot = deps.sessions.list.getSnapshot();
      var current = snapshot.current;
      var row = current ? snapshot.byId[current] : undefined;
      if (row && typeof row.cwd === "string" && row.cwd) return row.cwd;
      try {
        var workspaceSnapshot = deps.workspaces && deps.workspaces.list && deps.workspaces.list.getSnapshot();
        var items = (workspaceSnapshot && workspaceSnapshot.items) || [];
        if (current) {
          var hit = items.find(function (item) { return Array.isArray(item.sessionIds) && item.sessionIds.indexOf(current) !== -1; });
          if (hit && hit.path) return hit.path;
        }
        if (items.length && items[0].path) return items[0].path;
      } catch (error) {
        reportError("currentCwd.workspaces", error);
      }
      return undefined;
    }

    function hostInfo() {
      var deps = nativeDeps;
      if (!deps) return { current: null, ids: 0, phase: "unavailable", cwd: undefined };
      var snapshot = deps.sessions.list.getSnapshot();
      return { current: snapshot.current || null, ids: snapshot.ids.length, phase: snapshot.phase, cwd: currentCwd() };
    }

    function waitForBinding(sessions, sessionId) {
      return new Promise(function (resolve, reject) {
        var tries = 0;
        var tick = function () {
          var binding = null;
          try { binding = sessions.binding(sessionId); } catch (error) { reject(error); return; }
          if (binding) { resolve(binding); return; }
          if (++tries > 60) { reject(new Error("sessions.binding(" + sessionId + ") 60 次轮询仍不可用")); return; }
          setTimeout(tick, 50);
        };
        tick();
      });
    }

    function remoteFailureText(result) {
      if (!result) return "空结果";
      if (result.ok === true) return "";
      var failure = result.error || {};
      return String(failure.message || failure.code || JSON.stringify(failure));
    }

    /**
     * 真正向会话发消息：优先复用当前会话；target === "new" 时先 create+refresh+open。
     * @returns {Promise<{sessionId: string, created: boolean, text: string}>}
     */
    async function sendPrompt(input) {
      var deps = nativeDeps;
      if (!deps || !deps.sessions) throw new Error("sessions 服务尚未就绪（ctx.inject(['sessions','workspaces']) 未完成）");
      var sessions = deps.sessions;
      var text = typeof input.text === "string" ? input.text.trim().slice(0, 8000) : "";
      if (!text) throw new Error("消息内容为空");
      var sessionId;
      var created = false;
      if (input.target === "new") {
        var cwd = (typeof input.cwd === "string" && input.cwd) || currentCwd();
        if (!cwd) throw new Error("拿不到工作目录，无法新建会话");
        sessionId = await sessions.create({ cwd: cwd });
        created = true;
        await sessions.refresh();
        sessions.open(sessionId);
      } else {
        var snapshot = sessions.list.getSnapshot();
        sessionId = snapshot.current;
        if (!sessionId) {
          var fallbackCwd = (typeof input.cwd === "string" && input.cwd) || currentCwd();
          if (!fallbackCwd) throw new Error("当前没有会话且拿不到工作目录；请先从侧栏打开一个会话");
          sessionId = await sessions.create({ cwd: fallbackCwd });
          created = true;
          await sessions.refresh();
          sessions.open(sessionId);
        }
      }
      var binding = await waitForBinding(sessions, sessionId);
      // 精确契约：SessionFace.prompt(content: PromptContentPart[], mode: 'queue'|'steer', signal?, requestId?)
      var result = await binding.session.prompt([{ type: "text", text: text }], "queue");
      if (!result || result.ok !== true) throw new Error(remoteFailureText(result));
      return { sessionId: sessionId, created: created, text: text };
    }

    function openSession(sessionId) {
      var deps = nativeDeps;
      if (!deps || !deps.sessions) throw new Error("sessions 服务尚未就绪");
      if (typeof sessionId === "string" && sessionId) deps.sessions.open(sessionId);
      if (layoutService && typeof layoutService.selectPanel === "function") layoutService.selectPanel(null);
      toggleStore.set(false);
    }

    // ---- iframe → 父页面 action 桥 ----
    function useActionBridge(active, frameRef) {
      React.useEffect(function () {
        if (!active) return undefined;
        var frame = frameRef.current;
        if (!frame) return undefined;
        var disposed = false;
        var reply = function (payload) { if (!disposed) postToFrame(frame, payload); };
        var onMessage = function (event) {
          if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
          var data = event.data;
          if (!data || typeof data.type !== "string") return;
          if (data.type === "kanban:request-state") {
            reply(Object.assign({ type: "kanban:host-info" }, hostInfo()));
            return;
          }
          if (data.type === "kanban:send") {
            sendPrompt({ target: data.target === "new" ? "new" : "current", text: data.text, cwd: data.cwd })
              .then(function (sent) {
                reply({ type: "kanban:send:result", ok: true, sessionId: sent.sessionId, created: sent.created, text: sent.text });
              })
              .catch(function (error) {
                reply({ type: "kanban:send:result", ok: false, message: String((error && error.message) || error).slice(0, 400) });
              });
            return;
          }
          if (data.type === "kanban:open-session") {
            try { openSession(data.sessionId); } catch (error) { reportError("kanban:open-session", error); }
          }
        };
        window.addEventListener("message", onMessage);
        return function () {
          disposed = true;
          window.removeEventListener("message", onMessage);
        };
      }, [active]);
    }

    // ---- iframe 载体 ----
    function KanbanFrame(props) {
      var frameRef = React.useRef(null);
      useThemeBridge(Boolean(props.active), frameRef);
      useActionBridge(Boolean(props.active), frameRef);
      return h("iframe", {
        ref: frameRef,
        className: "dsh-kanban-frame",
        src: FRAME_URL,
        title: "DSH 看板（spike iframe）",
        allow: "clipboard-write",
      });
    }

    function KanbanPanel() {
      return h("div", { className: "dsh-kanban-panel", "data-kanban-spike-panel": "main" }, h(KanbanFrame, { active: true }));
    }

    // ---- fallback：shell.overlay 浮层 ----
    var overlayOpen = false;
    var overlayListeners = new Set();
    var toggleStore = {
      getSnapshot: function () { return overlayOpen; },
      subscribe: function (listener) {
        overlayListeners.add(listener);
        return function () { overlayListeners.delete(listener); };
      },
      set: function (next) {
        overlayOpen = Boolean(next);
        overlayListeners.forEach(function (listener) { listener(); });
      },
    };

    function KanbanOverlay() {
      var open = React.useSyncExternalStore(toggleStore.subscribe, toggleStore.getSnapshot);
      if (!open) return null;
      return h("div", {
        className: "dsh-kanban-overlay",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "DSH 看板浮层（spike fallback）",
        "data-kanban-spike-overlay": "open",
      },
        h("div", { className: "dsh-kanban-overlay-bar" },
          h("span", { className: "dsh-kanban-overlay-title" }, "DSH 看板 · shell.overlay fallback"),
          h("button", {
            type: "button",
            className: "dsh-kanban-overlay-close",
            onClick: function () { toggleStore.set(false); },
          }, "关闭")),
        h(KanbanFrame, { active: open }));
    }

    function OverlayButton(props) {
      var wide = Boolean(props && props.wide);
      return h("button", {
        type: "button",
        className: "dsh-kanban-foot" + (wide ? "" : " dsh-kanban-foot-rail"),
        title: "看板浮层（shell.overlay 方案）",
        "aria-label": "看板浮层",
        onClick: function () { toggleStore.set(true); },
      }, wide ? "看板浮层" : "▦");
    }

    function KanbanIcon(props) {
      var size = (props && props.size) || 16;
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
        strokeWidth: 1.3, strokeLinejoin: "round", "aria-hidden": "true", focusable: "false",
      },
        h("rect", { x: 1.5, y: 2.5, width: 4, height: 11, rx: 1 }),
        h("rect", { x: 6.25, y: 2.5, width: 4, height: 7, rx: 1 }),
        h("rect", { x: 11, y: 2.5, width: 3.5, height: 9, rx: 1 }));
    }

    // ---- CSS（全部走 DSH 设计令牌）----
    var CSS = [
      ".dsh-kanban-panel{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}",
      ".dsh-kanban-frame{flex:1;min-height:0;width:100%;border:0;display:block;background:var(--dsw-alias-bg-base);}",
      ".dsh-kanban-overlay{position:fixed;inset:0;z-index:40;pointer-events:auto;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}",
      ".dsh-kanban-overlay-bar{flex:none;height:44px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 12px;border-bottom:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}",
      ".dsh-kanban-overlay-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary);}",
      ".dsh-kanban-overlay-close{min-height:26px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);cursor:pointer;}",
      ".dsh-kanban-overlay-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
      ".dsh-kanban-foot{display:flex;align-items:center;gap:8px;width:100%;min-width:0;box-sizing:border-box;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13);text-align:left;}",
      ".dsh-kanban-foot:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
      ".dsh-kanban-foot:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;}",
      ".dsh-kanban-foot-rail{justify-content:center;padding:6px 0;}",
    ].join("\n");

    function injectStyles() {
      var el = document.createElement("style");
      el.setAttribute("data-dsh-kanban-spike", "1");
      el.textContent = CSS;
      document.head.appendChild(el);
      return function () { try { el.remove(); } catch (error) { /* ignore */ } };
    }

    // ---- locale 字典 ----
    var dictionaries = {
      zh: { "panel.title": "看板", "panel.overlay": "看板浮层" },
      en: { "panel.title": "Kanban", "panel.overlay": "Kanban overlay" },
    };

    function labelFor(key, fallback) {
      try {
        var locale = ctxRef && ctxRef.get ? ctxRef.get("locale") : undefined;
        if (locale && typeof locale.bind === "function") {
          var translated = locale.bind(NS)(key);
          if (translated && translated !== key) return translated;
        }
      } catch (error) {
        reportError("labelFor", error);
      }
      return fallback;
    }

    // 根 ctx 引用（apply 时赋值），供 label thunk 在渲染期读取 locale。
    var ctxRef = null;

    function apply(ctx) {
      ctxRef = ctx;
      ctx.effect(injectStyles);

      ctx.inject(["locale"], function (localeCtx) {
        localeCtx.effect(function () {
          return localeCtx.locale.register(NS, dictionaries);
        });
      });

      ctx.inject(["layout"], function (layoutCtx) {
        layoutService = layoutCtx.layout;
      });

      // 会话能力：sessions 提供 list/create/open/binding/refresh；workspaces 用于找 cwd。
      ctx.inject(["sessions", "workspaces"], function (sessionCtx) {
        sessionCtx.effect(function () {
          nativeDeps = { sessions: sessionCtx.sessions, workspaces: sessionCtx.workspaces };
          return function () {
            if (nativeDeps && nativeDeps.sessions === sessionCtx.sessions) nativeDeps = null;
          };
        });
      });

      // 主方案：侧栏列表项 + layout 的 root-scoped "main" keyed 面板。
      safe("sidebar.panellist", function () {
        ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register(
            { name: "sidebar.panellist", id: "kanban-spike", order: 20, label: function () { return labelFor("panel.title", "看板"); } },
            KanbanIcon,
          );
        });
      });

      safe("main", function () {
        ctx.slots.inject("main", function () {
          return ctx.slots.register({ name: "main", key: "kanban-spike" }, KanbanPanel);
        });
      });

      // fallback 方案：底部动作 + shell.overlay 浮层。
      safe("sidebar.footer.action", function () {
        ctx.slots.inject("sidebar.footer.action", function () {
          return ctx.slots.register(
            { name: "sidebar.footer.action", id: "kanban-spike-overlay", order: 15, label: function () { return labelFor("panel.overlay", "看板浮层"); } },
            OverlayButton,
          );
        });
      });

      safe("shell.overlay", function () {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({ name: "shell.overlay", id: "kanban-spike-overlay" }, KanbanOverlay);
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    // 仅作调试导出：便于在控制台确认 bundle 已物化。
    exports.spike = { FRAME_URL: FRAME_URL, THEME_TOKENS: THEME_TOKENS };
    return module.exports;
  },
});
