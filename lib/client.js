window.__ModuleLoader__.load({
  id: "dsh-kanban",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    const NS = "kanban";
    const PANEL_KEY = "kanban";
    const IFRAME_PATH = "/dsh-kanban/";
    const STYLE_ID = "dsh-kanban-panel-style";
    const BRIDGE_VERSION = 1;
    /** 原生待确认推送的消息版本（契约 04 第 2 节）。 */
    const PENDING_VERSION = 1;
    /** 原生提问倒计时每秒 publish，推送按 250ms 节流（契约 04 第 2 节）。 */
    const PENDING_PUSH_THROTTLE_MS = 250;

    // ---- 诊断：验证脚本可通过 window.__DSH_KANBAN__ 读取真实错误 ----
    const diagnostics = { version: 1, errors: [], ready: false, themeTokens: 0, currentSession: null, pendingCount: 0 };
    window.__DSH_KANBAN__ = diagnostics;
    function reportError(where, error) {
      const message = String((error && (error.message || error)) || "unknown");
      diagnostics.errors.push({ where, message, at: Date.now() });
      if (diagnostics.errors.length > 50) diagnostics.errors.shift();
      // eslint-disable-next-line no-console
      console.error("[dsh-kanban] " + where + ":", error);
    }

    const dictionaries = {
      zh: { "panel.title": "看板", "dock.return": "返回看板" },
      en: { "panel.title": "Kanban", "dock.return": "Back to board" },
    };
    let ctxRef = null;
    function labelFor(key, fallback) {
      try {
        const locale = ctxRef && ctxRef.get ? ctxRef.get("locale") : undefined;
        if (locale && typeof locale.bind === "function") {
          const translated = locale.bind(NS)(key);
          if (translated && translated !== key) return translated;
        }
      } catch (error) {
        reportError("labelFor", error);
      }
      return fallback;
    }

    // ---- 主题令牌：DSH 把 alias 令牌以内联变量写在 body 上（暗色在 body[data-ds-dark-theme]）。 ----
    // iframe 不继承父页面 CSS 变量，所以父页面读取生效值后 postMessage 过去。
    const THEME_TOKENS = [
      "--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2", "--dsw-alias-bg-layer-3",
      "--dsw-alias-bg-skeleton", "--dsw-alias-bg-mask-1", "--dsw-alias-bg-module-platform",
      "--dsw-alias-label-primary", "--dsw-alias-label-secondary", "--dsw-alias-label-tertiary",
      "--dsw-alias-label-caption", "--dsw-alias-label-dimmed", "--dsw-alias-label-primary-foreground",
      "--dsw-alias-border-l1", "--dsw-alias-border-l2", "--dsw-alias-border-l3", "--dsw-alias-border-l4",
      "--dsw-alias-interactive-bg-hover", "--dsw-alias-interactive-bg-active",
      "--dsw-alias-interactive-bg-hover-danger", "--dsw-alias-interactive-bg-hover-solid",
      "--dsw-alias-button-primary-fill", "--dsw-alias-button-primary-hover", "--dsw-alias-button-primary-dimmed",
      "--dsw-alias-button-primary-text",
      "--dsw-alias-state-business-primary", "--dsw-alias-state-business-secondary", "--dsw-alias-state-business-tertiary",
      "--dsw-alias-state-error-primary", "--dsw-alias-state-error-secondary", "--dsw-alias-state-error-tertiary",
      "--dsw-alias-state-success-primary", "--dsw-alias-state-success-secondary", "--dsw-alias-state-success-tertiary",
      "--dsw-alias-state-warn-primary", "--dsw-alias-state-warn-secondary", "--dsw-alias-state-warn-tertiary",
      "--dsw-alias-link", "--dsw-specific-sidebar-fill", "--dsw-specific-input-major",
      "--dsw-alias-toast-bg", "--dsw-alias-tooltip-bg",
      "--dsw-elevation-panel", "--dsw-elevation-prominent", "--dsw-elevation-soft",
      "--dsw-font-family", "--ds-font-family-code",
      "--dsw-font-xxs-11", "--dsw-font-xs-13", "--dsw-font-sm-14", "--dsw-font-md-16",
      "--ds-transition-duration", "--ds-transition-duration-fast", "--ds-transition-duration-slow",
      "--ds-ease-in-out", "--ds-ease-out",
    ];

    function themeMode() {
      const isDark = (node) => Boolean(node) && (
        node.hasAttribute("data-ds-dark-theme") || node.getAttribute("data-ds-theme") === "dark"
      );
      return isDark(document.body) || isDark(document.documentElement) ? "dark" : "light";
    }

    function themeTokens() {
      const roots = [document.body, document.documentElement].filter(Boolean).map((node) => getComputedStyle(node));
      const tokens = {};
      for (const name of THEME_TOKENS) {
        for (const style of roots) {
          const value = style.getPropertyValue(name).trim();
          if (value) { tokens[name] = value; break; }
        }
      }
      return tokens;
    }

    /** DSH 0.2.x 在 macOS 上把「侧边栏展开 / 新建会话」悬浮在 center 列左上角；
     *  这些 CSS 变量是宿主给出的安全区：--dsh-frame-overlay-top / --dsh-frame-leading-clearance。
     *  把它们发给看板，避免内容压住宿主控件。 */
    function hostInsets() {
      try {
        const root = getComputedStyle(document.documentElement);
        const num = (name) => {
          const value = parseFloat(root.getPropertyValue(name));
          return Number.isFinite(value) ? value : 0;
        };
        const top = num("--dsh-frame-overlay-top") || num("--dsh-frame-top-clearance");
        const leading = num("--dsh-frame-leading-clearance");
        return {
          top: Math.round(top),
          leading: Math.round(leading),
          platform: document.documentElement.getAttribute("data-platform") || "",
          fullscreen: document.documentElement.hasAttribute("data-fullscreen"),
        };
      } catch {
        return { top: 0, leading: 0, platform: "", fullscreen: false };
      }
    }

    function uiLocale() {
      const lang = navigator.language || "zh-CN";
      return /^zh/i.test(lang) ? "zh" : "en";
    }

    function errorPayload(error) {
      return {
        code: error && typeof error.code === "string" ? error.code : "BRIDGE_ERROR",
        message: error && error.message ? String(error.message) : "操作未完成，请稍后重试。",
      };
    }

    const CSS = `
.dsh-kanban-panel{position:relative;display:flex;box-sizing:border-box;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base);overflow:hidden}
.dsh-kanban-frame{display:block;flex:1;width:100%;height:100%;min-height:0;border:0;background:var(--dsw-alias-bg-base)}
.dsh-kanban-return-dock{box-sizing:border-box;display:flex;justify-content:flex-end;width:100%;max-width:calc(var(--dsh-composer-card-max-width,952px) + 2 * var(--dsh-composer-side-clearance,16px));margin:0 auto;padding:0 var(--dsh-composer-side-clearance,16px) 8px;pointer-events:none}
.dsh-kanban-return-bubble{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-12);white-space:nowrap;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out),color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dsh-kanban-return-bubble:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-kanban-return-bubble:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-kanban-return-bubble__icon{display:inline-flex;align-items:center;justify-content:center;flex:none}
`;

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return () => {};
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => { style.remove(); };
    }

    function KanbanIcon(props) {
      const size = typeof props?.size === "number" ? props.size : 18;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 18 18", fill: "none", "aria-hidden": true, focusable: false },
        h("rect", { x: 2, y: 3, width: 3, height: 12, rx: 1.1, fill: "currentColor", opacity: 0.42 }),
        h("rect", { x: 6.5, y: 3, width: 3, height: 8, rx: 1.1, fill: "currentColor", opacity: 0.78 }),
        h("rect", { x: 11, y: 3, width: 3, height: 5.2, rx: 1.1, fill: "currentColor" }),
        h("circle", { cx: 12.5, cy: 10.6, r: 1.1, fill: "currentColor", opacity: 0.9 }),
        h("circle", { cx: 12.5, cy: 14.1, r: 1.1, fill: "currentColor", opacity: 0.5 }),
      );
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // ---- 单一桥实例：面板 iframe ↔ DSH 原生能力 ----
    function createBridge({ getSessions, getLayout, getWorkspaces, getUiWorkspace, getTheme, getUiSession }) {
      let frame = null;
      let lastSessionsPush = 0;
      let pendingTimer = null;
      /** 首次观测时间：identity（sessionId + 0x00 + key）→ Date.now()，key 消失时清理。 */
      const pendingObservedAt = new Map();
      /** 提问对象自己的倒计时订阅：pending 对象 → unsubscribe。宿主可能随时换对象，旧的必须取消。 */
      const pendingSubscriptions = new Map();

      const post = (message) => {
        if (!frame || !frame.contentWindow) return;
        try {
          frame.contentWindow.postMessage({ version: BRIDGE_VERSION, ...message }, location.origin);
        } catch { /* 面板正在卸载 */ }
      };

      const readSessions = () => {
        const sessions = getSessions();
        if (!sessions) return { sessions: [], current: null };
        try {
          const snapshot = sessions.list.getSnapshot();
          const rows = (snapshot.ids || [])
            .map((id) => snapshot.byId?.[id] ?? { id, sessionId: id })
            .filter(Boolean)
            .map((row) => {
              const id = row.id ?? row.sessionId;
              return {
                id,
                title: row.displayTitle || row.title || String(id),
                running: Boolean(row.running),
                updatedAt: Number(row.updatedAt) || 0,
                cwd: row.cwd || undefined,
                blank: Boolean(row.blank),
                parentId: row.parentId || undefined,
                origin: row.origin || undefined,
              };
            });
          // 0.1.x 的 list 快照带 current；0.2.x 把选择状态移到了导航层，这里保持 null。
          return { sessions: rows, current: snapshot.current || null };
        } catch (error) {
          reportError("readSessions", error);
          return { sessions: [], current: null };
        }
      };

      /** 宿主全局归档集合（DSH 0.2.x；旧宿主/不可用时为空数组）。 */
      function readArchivedSessionIds() {
        try {
          const workspaces = getWorkspaces();
          const snapshot = workspaces?.list?.getSnapshot?.() ?? {};
          return Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds.map(String) : [];
        } catch (error) {
          reportError("readArchivedSessionIds", error);
          return [];
        }
      }

      function isArchivedSession(sessionId) {
        return readArchivedSessionIds().includes(sessionId);
      }

      /**
       * 使用会话前的自动恢复（方案 §4.3）：把会话从归档集合中取回，避免 prompt 被归档闸门静默吞掉。
       * 幂等：未归档直接返回 false；恢复失败抛出可读错误，绝不静默继续。
       */
      async function ensureSessionActive(sessionId) {
        if (!isArchivedSession(sessionId)) return false;
        const uiWorkspace = getUiWorkspace();
        if (!uiWorkspace || typeof uiWorkspace.unarchiveSession !== "function") {
          throw Object.assign(new Error("该会话已归档，且当前 DSH 版本不支持取消归档。"), { code: "SESSION_ARCHIVE_UNAVAILABLE" });
        }
        try {
          await uiWorkspace.unarchiveSession(sessionId);
        } catch (error) {
          throw Object.assign(new Error(`恢复已归档会话失败：${error?.message || error}`), { code: "SESSION_ARCHIVE_UNAVAILABLE" });
        }
        return true;
      }

      function fallbackCwd() {
        try {
          const sessions = getSessions();
          const snapshot = sessions?.list?.getSnapshot?.();
          const current = snapshot?.current ? snapshot.byId?.[snapshot.current] : null;
          if (current?.cwd) return current.cwd;
          const workspaces = getWorkspaces();
          const items = workspaces?.list?.getSnapshot?.()?.items || [];
          return items.find((item) => typeof item.path === "string")?.path;
        } catch (error) {
          reportError("fallbackCwd", error);
          return undefined;
        }
      }

      // ---- 原生待确认收件（契约 04）：把 uiSession.sessionStatus 投影镜像给看板 ----
      // 每个会话只暴露最高优先级的 pendingInteraction；父页面只读它，作答仍走宿主对象。

      function readPendingStatus() {
        const uiSession = getUiSession();
        const status = uiSession && uiSession.sessionStatus;
        if (!status || typeof status.getSnapshot !== "function") return null;
        try {
          const snapshot = status.getSnapshot();
          return snapshot instanceof Map ? snapshot : null;
        } catch (error) {
          reportError("pending.status", error);
          return null;
        }
      }

      function sessionRowsById() {
        const rows = new Map();
        for (const row of readSessions().sessions) rows.set(row.id, row);
        return rows;
      }

      function clearPendingTimer() {
        if (pendingTimer === null) return;
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }

      function collectPending() {
        const questions = new Set();
        const snapshot = readPendingStatus();
        if (!snapshot) return { supported: false, items: [], questions };
        const rows = sessionRowsById();
        const now = Date.now();
        const seen = new Set();
        const items = [];
        for (const [sessionId, status] of snapshot) {
          const pending = status && status.pendingInteraction;
          if (!pending || typeof pending.key !== "string" || !pending.key) continue;
          const kind = pending.kind;
          const identity = sessionId + "\u0000" + pending.key;
          let item = null;
          if (kind === "approval") {
            // answerable 是 host 对象的 getter：已结算/已撤回的审批不镜像，否则前端会显示不可答项。
            let answerable = false;
            try { answerable = Boolean(pending.answerable); } catch (error) { reportError("pending.answerable", error); }
            if (!answerable) continue;
            item = {
              kind: "approval",
              toolName: typeof pending.toolName === "string" ? pending.toolName : String(pending.toolName ?? ""),
              ...(pending.callId === undefined ? {} : { callId: pending.callId }),
              ...(pending.reason === undefined ? {} : { reason: pending.reason }),
              ...(pending.displayReason === undefined ? {} : { displayReason: pending.displayReason }),
            };
          } else if (kind === "question" || kind === "plan-review") {
            // review !== undefined 是已结算的只读回放卡片，不属于待收件。
            if (pending.review !== undefined) continue;
            let state;
            try { state = typeof pending.snapshot === "function" ? pending.snapshot() : undefined; } catch (error) {
              reportError("pending.questionSnapshot", error);
              state = undefined;
            }
            if (!state || state.closed === true) continue;
            questions.add(pending);
            item = {
              kind,
              ...(pending.callId === undefined ? {} : { callId: pending.callId }),
              questions: Array.isArray(pending.questions) ? pending.questions : [],
              state: state.state === "continued" ? "continued" : "open",
              channel: state.channel === "waterfall" || state.channel === "rpc" ? state.channel : "none",
              ...(state.countdown && typeof state.countdown === "object"
                ? { countdown: { remainingMs: Number(state.countdown.remainingMs) || 0, running: Boolean(state.countdown.running) } }
                : {}),
              dismissal: pending.dismissal === "cancel" ? "cancel" : "hide",
            };
          } else {
            continue;
          }
          let observedAt = pendingObservedAt.get(identity);
          if (observedAt === undefined) {
            observedAt = now;
            pendingObservedAt.set(identity, observedAt);
          }
          const row = rows.get(sessionId);
          items.push({
            sessionId,
            key: pending.key,
            ...(row ? { sessionTitle: row.title, sessionRunning: row.running } : {}),
            observedAt,
            ...item,
          });
          seen.add(identity);
        }
        for (const identity of [...pendingObservedAt.keys()]) if (!seen.has(identity)) pendingObservedAt.delete(identity);
        const group = (item) => (item.kind === "approval" ? 0 : item.kind === "plan-review" ? 1 : 2);
        items.sort((left, right) => (group(left) - group(right))
          || (left.observedAt - right.observedAt)
          || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
        return { supported: true, items, questions };
      }

      function clearQuestionSubscriptions() {
        for (const unsubscribe of pendingSubscriptions.values()) {
          try { unsubscribe(); } catch (error) { reportError("pending.questionUnsubscribe", error); }
        }
        pendingSubscriptions.clear();
      }

      function syncQuestionSubscriptions(questions) {
        for (const [pending, unsubscribe] of [...pendingSubscriptions]) {
          if (questions.has(pending)) continue;
          pendingSubscriptions.delete(pending);
          try { unsubscribe(); } catch (error) { reportError("pending.questionUnsubscribe", error); }
        }
        for (const pending of questions) {
          if (pendingSubscriptions.has(pending)) continue;
          // 倒计时每秒 publish；只有提问对象自带 subscribe 时才挂，审批对象没有。
          if (typeof pending.subscribe !== "function") continue;
          try {
            const unsubscribe = pending.subscribe(() => schedulePendingPush());
            if (typeof unsubscribe === "function") pendingSubscriptions.set(pending, unsubscribe);
          } catch (error) {
            reportError("pending.questionSubscribe", error);
          }
        }
      }

      function sendPending() {
        const result = collectPending();
        diagnostics.pendingCount = result.items.length;
        if (!result.supported) { clearQuestionSubscriptions(); return false; }
        if (frame) syncQuestionSubscriptions(result.questions);
        else clearQuestionSubscriptions();
        post({ type: "kanban:pending", version: PENDING_VERSION, items: result.items, at: Date.now() });
        return true;
      }

      function schedulePendingPush() {
        if (pendingTimer !== null) return;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          sendPending();
        }, PENDING_PUSH_THROTTLE_MS);
      }

      function pushPending(force = false) {
        if (!force) { schedulePendingPush(); return; }
        clearPendingTimer();
        sendPending();
      }

      function locatePending(sessionId, key) {
        const snapshot = readPendingStatus();
        if (!snapshot) return null;
        const status = snapshot.get(sessionId);
        const pending = status && status.pendingInteraction;
        if (!pending || pending.key !== key) return null;
        return pending;
      }

      function pendingNotFound() {
        return Object.assign(new Error("这条待确认已在别处处理，稍后会从列表消失。"), { code: "PENDING_NOT_FOUND" });
      }
      function pendingUnanswerable(message) {
        return Object.assign(new Error(message), { code: "PENDING_UNANSWERABLE" });
      }
      function pendingAnswerFailed(error) {
        return Object.assign(
          new Error(error && error.message ? String(error.message) : "宿主没有接受这次作答。"),
          { code: "PENDING_ANSWER_FAILED" },
        );
      }
      function badRequest(message) {
        return Object.assign(new Error(message), { code: "BAD_REQUEST" });
      }
      function readPendingTarget(params) {
        if (typeof params.sessionId !== "string" || !params.sessionId) throw badRequest("缺少会话 id。");
        if (typeof params.key !== "string" || !params.key) throw badRequest("缺少待确认项的 key。");
        return { sessionId: params.sessionId, key: params.key };
      }
      function readAnswers(value) {
        if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw badRequest("答案数量需在 1–20 之间。");
        return value.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw badRequest("答案格式不对。");
          if (typeof entry.id !== "string" || !entry.id) throw badRequest("答案缺少题目 id。");
          if (!Array.isArray(entry.selected) || entry.selected.length > 8) throw badRequest("选项数量超出范围。");
          const selected = entry.selected.map((label) => {
            if (typeof label !== "string" || label.length > 200) throw badRequest("选项标签格式不对。");
            return label;
          });
          if (entry.custom !== undefined && (typeof entry.custom !== "string" || entry.custom.length > 2000)) {
            throw badRequest("自定义文本格式不对。");
          }
          return entry.custom === undefined ? { id: entry.id, selected } : { id: entry.id, selected, custom: entry.custom };
        });
      }

      function notFound() {
        return Object.assign(new Error("找不到这个会话，可能已被归档或删除。"), { code: "SESSION_NOT_FOUND" });
      }

      function unavailable() {
        return Object.assign(new Error("当前 DSH 版本不支持会话操作。"), { code: "SESSION_UNAVAILABLE" });
      }

      async function legacySessionFace(sessionId) {
        const sessions = getSessions();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const binding = sessions.binding(sessionId);
          if (binding) return binding.session;
          await sessions.refresh().catch(() => {});
          await sleep(60);
        }
        throw notFound();
      }

      /** 0.2.x：sessions.using(target, {source}, op) 会 retain → ready → 回调 → release。 */
      async function withSession(sessionId, operation) {
        const sessions = getSessions();
        if (!sessions) throw unavailable();
        if (typeof sessions.using === "function") {
          try {
            return await sessions.using(sessionId, { source: "gateway" }, async (reference) => {
              const ready = reference?.ready;
              const binding = reference?.binding ?? (ready ? await ready : undefined);
              if (!binding?.session) throw notFound();
              return await operation(binding.session);
            });
          } catch (error) {
            if (error && typeof error.code === "string" && error.code.startsWith("SESSION")) throw error;
            const code = error?.rpcError?.code || error?.code;
            if (code === "session/not-found" || code === "session/archived" || code === "session/writer-held") throw notFound();
            throw Object.assign(new Error(error?.message || "会话操作未完成，请稍后重试。"), { code: "SESSION_OPERATION_FAILED" });
          }
        }
        const face = await legacySessionFace(sessionId);
        return operation(face);
      }

      async function promptSession(sessionId, text, mode) {
        if (typeof text !== "string" || !text.trim()) {
          throw Object.assign(new Error("要发送的内容为空。"), { code: "BAD_REQUEST" });
        }
        await ensureSessionActive(sessionId);
        const content = [{ type: "text", text: text.trim() }];
        const delivery = mode === "steer" ? "steer" : "queue";
        const result = await withSession(sessionId, (session) => session.prompt(content, delivery));
        if (result && result.ok === false) {
          const message = result.error?.message || "会话没有接受这条消息。";
          throw Object.assign(new Error(message), { code: "PROMPT_REJECTED" });
        }
        return { accepted: true };
      }

      function openSessionInHost(sessionId) {
        const uiWorkspace = getUiWorkspace();
        if (uiWorkspace && typeof uiWorkspace.openSession === "function") {
          uiWorkspace.openSession(sessionId);
          return true;
        }
        const sessions = getSessions();
        if (sessions && typeof sessions.open === "function") {
          sessions.open(sessionId);
          return true;
        }
        return false;
      }

      async function ensureSession(params = {}) {
        const sessions = getSessions();
        if (!sessions) throw Object.assign(new Error("当前 DSH 版本不支持会话操作。"), { code: "SESSION_UNAVAILABLE" });
        let sessionId = typeof params.sessionId === "string" && params.sessionId ? params.sessionId : null;
        let created = false;
        if (!sessionId) {
          const cwd = params.cwd || fallbackCwd();
          sessionId = await sessions.create({
            ...(cwd ? { cwd } : {}),
            ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
          });
          created = true;
          // create 成功后刷新列表；0.2.x 不再用 open 选中会话，prompt 由 using() 自行 retain。
          await sessions.refresh().catch(() => {});
        }
        await promptSession(sessionId, params.text, params.mode);
        return { sessionId, created };
      }

      const methods = {
        "app.info": () => ({
          locale: uiLocale(),
          themeMode: themeMode(),
          panelVisible: Boolean(frame),
          themePreference: (() => {
            try { return getTheme()?.getTheme?.()?.id ?? null; } catch { return null; }
          })(),
        }),
        "sessions.list": readSessions,
        "workspaces.list": () => {
          const workspaces = getWorkspaces();
          if (!workspaces) return { workspaces: [] };
          try {
            const snapshot = workspaces.list?.getSnapshot?.() ?? workspaces.getSnapshot?.() ?? {};
            const items = Array.isArray(snapshot.items) ? snapshot.items : [];
            return {
              workspaces: items
                .filter((item) => item && typeof item.workspaceId === "string")
                .map((item) => ({
                  workspaceId: item.workspaceId,
                  title: item.title || item.path || item.workspaceId,
                  path: item.path || "",
                  sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds : [],
                  updatedAt: Number(item.updatedAt) || 0,
                })),
            };
          } catch (error) {
            reportError("readWorkspaces", error);
            return { workspaces: [] };
          }
        },
        "sessions.refresh": async () => {
          const sessions = getSessions();
          if (sessions) await sessions.refresh();
          return readSessions();
        },
        "session.open": async (params = {}) => {
          const sessions = getSessions();
          const layout = getLayout();
          if (!sessions) throw Object.assign(new Error("当前 DSH 版本不支持会话操作。"), { code: "SESSION_UNAVAILABLE" });
          if (typeof params.sessionId !== "string" || !params.sessionId) {
            throw Object.assign(new Error("缺少会话 id。"), { code: "BAD_REQUEST" });
          }
          await ensureSessionActive(params.sessionId);
          if (!openSessionInHost(params.sessionId)) {
            throw Object.assign(new Error("当前 DSH 版本不支持打开会话。"), { code: "SESSION_UNAVAILABLE" });
          }
          returnStore.setSession(params.sessionId);
          // 0.2.x 的 uiWorkspace.openSession 自带「切到对话」导航；旧版补一次面板切换。
          if (getUiWorkspace()?.openSession && layout) return { ok: true };
          if (layout) layout.selectPanel(null);
          return { ok: true };
        },
        "session.create": async (params = {}) => {
          const sessions = getSessions();
          if (!sessions) throw Object.assign(new Error("当前 DSH 版本不支持会话操作。"), { code: "SESSION_UNAVAILABLE" });
          const cwd = params.cwd || fallbackCwd();
          const sessionId = await sessions.create({
            ...(cwd ? { cwd } : {}),
            ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
          });
          await sessions.refresh().catch(() => {});
          return { sessionId };
        },
        "session.prompt": async (params = {}) => {
          if (typeof params.sessionId !== "string" || !params.sessionId) {
            throw Object.assign(new Error("缺少会话 id。"), { code: "BAD_REQUEST" });
          }
          return promptSession(params.sessionId, params.text, params.mode);
        },
        "session.ensure": (params = {}) => ensureSession(params),
        "pending.answerApproval": async (params = {}) => {
          const target = readPendingTarget(params);
          if (params.outcome !== "allowed-once" && params.outcome !== "rejected") {
            throw badRequest("未知的审批结果。");
          }
          const pending = locatePending(target.sessionId, target.key);
          if (!pending || pending.kind !== "approval") throw pendingNotFound();
          let answerable = false;
          try { answerable = Boolean(pending.answerable); } catch (error) { reportError("pending.answerable", error); }
          if (!answerable) throw pendingUnanswerable("这条审批已被处理或撤回。");
          try {
            await pending.answer(params.outcome);
          } catch (error) {
            throw pendingAnswerFailed(error);
          }
          return { ok: true };
        },
        "pending.answerQuestion": async (params = {}) => {
          const target = readPendingTarget(params);
          const answers = readAnswers(params.answers);
          const pending = locatePending(target.sessionId, target.key);
          if (!pending || (pending.kind !== "question" && pending.kind !== "plan-review")) throw pendingNotFound();
          let state;
          try { state = typeof pending.snapshot === "function" ? pending.snapshot() : undefined; } catch (error) {
            reportError("pending.questionSnapshot", error);
            state = undefined;
          }
          if (!state || state.closed === true || state.channel === "none") {
            throw pendingUnanswerable("这条提问当前不收答案，可能已超时或已关闭。");
          }
          try {
            await pending.answer({ answers });
          } catch (error) {
            throw pendingAnswerFailed(error);
          }
          return { ok: true };
        },
        "pending.dismiss": async (params = {}) => {
          const target = readPendingTarget(params);
          const pending = locatePending(target.sessionId, target.key);
          if (!pending || (pending.kind !== "question" && pending.kind !== "plan-review")) throw pendingNotFound();
          if (pending.review !== undefined) throw pendingUnanswerable("这条记录已经结算，不能再关闭。");
          try {
            await pending.dismiss();
          } catch (error) {
            throw pendingAnswerFailed(error);
          }
          return { ok: true };
        },
        "theme.set": (params = {}) => {
          const preference = params && typeof params.preference === "string" ? params.preference : "";
          if (!["light", "dark", "system"].includes(preference)) {
            throw Object.assign(new Error("未知主题偏好。"), { code: "BAD_REQUEST" });
          }
          const theme = getTheme();
          if (theme && typeof theme.setTheme === "function") {
            theme.setTheme(preference);
            return { applied: true, preference };
          }
          return { applied: false, preference };
        },
        "panel.select": (params = {}) => {
          const layout = getLayout();
          if (!layout) throw Object.assign(new Error("面板切换暂不可用。"), { code: "LAYOUT_UNAVAILABLE" });
          if (params.panel === "kanban") { returnStore.clear(); layout.selectPanel(PANEL_KEY); }
          else if (params.panel === "conversation") layout.selectPanel(null);
          else throw Object.assign(new Error("未知面板。"), { code: "BAD_REQUEST" });
          return { ok: true };
        },
        toast: () => ({ ok: true }),
      };

      async function onRequest(message) {
        const requestId = message.requestId;
        if (typeof requestId !== "string" || !requestId) return;
        const method = message.method;
        if (typeof method !== "string" || !Object.prototype.hasOwnProperty.call(methods, method)) {
          post({ type: "kanban:response", requestId, ok: false, error: { code: "UNKNOWN_METHOD", message: "看板请求了未知的宿主能力。" } });
          return;
        }
        try {
          const data = await methods[method](message.params || {});
          post({ type: "kanban:response", requestId, ok: true, data });
        } catch (error) {
          reportError("bridge:" + method, error);
          post({ type: "kanban:response", requestId, ok: false, error: errorPayload(error) });
        }
      }

      function onMessage(event) {
        if (event.origin !== location.origin) return;
        if (!frame || event.source !== frame.contentWindow) return;
        const data = event.data;
        if (!data || data.version !== BRIDGE_VERSION) return;
        if (data.type === "kanban:ready") {
          diagnostics.ready = true;
          const tokens = themeTokens();
          diagnostics.themeTokens = Object.keys(tokens).length;
          post({ type: "kanban:host", locale: uiLocale(), insets: hostInsets() });
          post({ type: "kanban:theme", mode: themeMode(), tokens });
          post({ type: "kanban:sessions", ...readSessions(), archivedSessionIds: readArchivedSessionIds() });
          sendPending();
          return;
        }
        if (data.type === "kanban:request") { onRequest(data); return; }
      }

      const sendSessions = () => {
        const snapshot = readSessions();
        diagnostics.currentSession = snapshot.current;
        post({ type: "kanban:sessions", ...snapshot, archivedSessionIds: readArchivedSessionIds() });
      };

      return {
        attach(nextFrame) {
          frame = nextFrame;
          const tokens = themeTokens();
          diagnostics.themeTokens = Object.keys(tokens).length;
          post({ type: "kanban:host", locale: uiLocale(), insets: hostInsets() });
          post({ type: "kanban:theme", mode: themeMode(), tokens });
          sendSessions();
          // 面板挂载时推一次全量快照（空数组 = 宿主支持但没有待确认）。
          sendPending();
        },
        detach() {
          frame = null;
          clearPendingTimer();
          clearQuestionSubscriptions();
        },
        onMessage,
        postTheme() { post({ type: "kanban:theme", mode: themeMode(), tokens: themeTokens() }); },
        pushSessions(force = false) {
          const now = Date.now();
          if (!force && now - lastSessionsPush < 500) return;
          lastSessionsPush = now;
          sendSessions();
        },
        pushPending,
        schedulePendingPush,
        pushVisibility(visible) { post({ type: "kanban:visibility", visible }); },
      };
    }

    // 由 apply 初始化；面板组件通过闭包读取。
    let bridge = null;
    const layoutRef = { current: null };

    // 返回看板气泡的状态：只对「从看板打开的那个会话」且左侧栏收起时展示。
    const returnStore = (() => {
      let state = { sessionId: null, collapsed: false };
      const listeners = new Set();
      const emit = () => { for (const listener of listeners) listener(); };
      return {
        getSnapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        setSession(sessionId) {
          const next = typeof sessionId === "string" ? sessionId : null;
          if (state.sessionId === next) return;
          state = { ...state, sessionId: next };
          emit();
        },
        setCollapsed(collapsed) {
          if (state.collapsed === Boolean(collapsed)) return;
          state = { ...state, collapsed: Boolean(collapsed) };
          emit();
        },
        clear() { this.setSession(null); },
      };
    })();

    function readSidebarCollapsed() {
      try { return Boolean(document.querySelector("[data-sidebar-collapsed]")); } catch { return false; }
    }

    /** 输入框上方的「返回看板」气泡：从看板跳到会话、且侧栏收起时出现。 */
    function KanbanReturnDock(props) {
      const state = React.useSyncExternalStore(returnStore.subscribe, returnStore.getSnapshot);
      const sessionId = (props && (props.sessionId || (props.session && props.session.sessionId))) || null;
      if (!state.collapsed || !sessionId || state.sessionId !== sessionId) return null;
      return h(
        "div",
        { className: "dsh-kanban-return-dock" },
        h(
          "button",
          {
            type: "button",
            className: "dsh-kanban-return-bubble",
            title: "返回看板",
            onClick: () => {
              try {
                if (state.sessionId) sessionStorage.setItem("dsh-kanban:return-highlight-session", state.sessionId);
              } catch {}
              returnStore.clear();
              try { layoutRef.current?.selectPanel(PANEL_KEY); } catch (error) { reportError("return:selectPanel", error); }
            },
          },
          h("span", { className: "dsh-kanban-return-bubble__icon", "aria-hidden": true }, h(KanbanIcon, { size: 14 })),
          h("span", null, labelFor("dock.return", "返回看板")),
        ),
      );
    }

    function KanbanPanel() {
      const frameRef = React.useRef(null);

      React.useEffect(() => {
        returnStore.clear();
        const frame = frameRef.current;
        if (frame && bridge) bridge.attach(frame);
        if (bridge) bridge.pushVisibility(true);
        return () => {
          if (bridge) {
            bridge.pushVisibility(false);
            bridge.detach();
          }
        };
      }, []);

      return h(
        "div",
        { className: "dsh-kanban-panel" },
        h("iframe", {
          ref: frameRef,
          className: "dsh-kanban-frame",
          src: IFRAME_PATH,
          title: "DSH 看板",
          allow: "clipboard-write",
        }),
      );
    }

    // ---- 插件主体 ----
    function apply(ctx) {
      ctxRef = ctx;
      const refs = { sessions: null, layout: null, workspaces: null, uiWorkspace: null, theme: null, uiSession: null };
      bridge = createBridge({
        getSessions: () => refs.sessions,
        getLayout: () => refs.layout,
        getWorkspaces: () => refs.workspaces,
        getUiWorkspace: () => refs.uiWorkspace,
        getTheme: () => refs.theme,
        getUiSession: () => refs.uiSession,
      });

      ctx.effect(() => injectStyles(), "dsh-kanban: panel styles");

      ctx.inject(["locale"], (localeCtx) => localeCtx.effect(
        () => localeCtx.locale.register(NS, dictionaries),
        "dsh-kanban: locale",
      ));

      ctx.inject(["layout"], (layoutCtx) => layoutCtx.effect(() => {
        refs.layout = layoutCtx.layout;
        layoutRef.current = layoutCtx.layout;
        return () => { refs.layout = null; layoutRef.current = null; };
      }, "dsh-kanban: layout ref"));

      ctx.inject(["sessions"], (sessionCtx) => sessionCtx.effect(() => {
        refs.sessions = sessionCtx.sessions;
        let unsubscribe = null;
        try {
          unsubscribe = sessionCtx.sessions.list.subscribe(() => bridge?.pushSessions());
        } catch (error) {
          reportError("sessions.subscribe", error);
        }
        try { bridge?.pushSessions(true); } catch (error) { reportError("sessions.push", error); }
        return () => {
          if (unsubscribe) unsubscribe();
          refs.sessions = null;
        };
      }, "dsh-kanban: sessions ref"));

      ctx.inject(["workspaces"], (workspaceCtx) => workspaceCtx.effect(() => {
        refs.workspaces = workspaceCtx.workspaces;
        let unsubscribe = null;
        // workspace 集合（含 archivedSessionIds/pinnedSessionIds）变化时重推会话帧；无 payload 的失效通知。
        try {
          unsubscribe = workspaceCtx.workspaces?.list?.subscribe?.(() => bridge?.pushSessions(true));
        } catch (error) {
          reportError("workspaces.subscribe", error);
        }
        try { bridge?.pushSessions(true); } catch (error) { reportError("workspaces.push", error); }
        return () => {
          if (unsubscribe) unsubscribe();
          refs.workspaces = null;
        };
      }, "dsh-kanban: workspaces ref"));

      ctx.inject(["uiWorkspace"], (workspaceCtx) => workspaceCtx.effect(() => {
        refs.uiWorkspace = workspaceCtx.uiWorkspace;
        return () => { refs.uiWorkspace = null; };
      }, "dsh-kanban: uiWorkspace ref"));

      ctx.inject(["theme"], (themeCtx) => themeCtx.effect(() => {
        refs.theme = themeCtx.theme;
        return () => { refs.theme = null; };
      }, "dsh-kanban: theme ref"));

      // 契约 04：原生待确认收件。旧版宿主没有 uiSession 服务时 inject 不会回调，
      // 父页面也就不推送 kanban:pending，iframe 保持 pendingSupport=false。
      ctx.inject(["uiSession"], (sessionUiCtx) => sessionUiCtx.effect(() => {
        refs.uiSession = sessionUiCtx.uiSession;
        let unsubscribe = null;
        try {
          const status = sessionUiCtx.uiSession && sessionUiCtx.uiSession.sessionStatus;
          if (status && typeof status.subscribe === "function") {
            unsubscribe = status.subscribe(() => bridge?.schedulePendingPush());
          }
        } catch (error) {
          reportError("uiSession.subscribe", error);
        }
        try { bridge?.pushPending(true); } catch (error) { reportError("pending.push", error); }
        return () => {
          if (unsubscribe) unsubscribe();
          refs.uiSession = null;
        };
      }, "dsh-kanban: uiSession ref"));

      ctx.effect(() => {
        const sync = () => returnStore.setCollapsed(readSidebarCollapsed());
        sync();
        const frame = requestAnimationFrame(sync);
        const observer = new MutationObserver(sync);
        observer.observe(document.documentElement, {
          attributes: true,
          subtree: true,
          attributeFilter: ["data-sidebar-collapsed", "data-fullscreen"],
        });
        window.addEventListener("resize", sync);
        return () => {
          cancelAnimationFrame(frame);
          observer.disconnect();
          window.removeEventListener("resize", sync);
        };
      }, "dsh-kanban: sidebar collapse watcher");

      ctx.effect(() => {
        const onMessage = (event) => bridge?.onMessage(event);
        window.addEventListener("message", onMessage);

        let timer = null;
        const schedule = () => {
          clearTimeout(timer);
          timer = setTimeout(() => bridge?.postTheme(), 50);
        };
        const observer = new MutationObserver(schedule);
        if (document.body) {
          observer.observe(document.body, { attributes: true, attributeFilter: ["style", "class", "data-ds-dark-theme"] });
        }
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-ds-dark-theme", "style"] });

        return () => {
          clearTimeout(timer);
          observer.disconnect();
          window.removeEventListener("message", onMessage);
        };
      }, "dsh-kanban: bridge listeners");

      try {
        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_KEY, order: 20, label: () => labelFor("panel.title", "看板") },
          KanbanIcon,
        ));
      } catch (error) { reportError("register:sidebar.panellist", error); }

      try {
        ctx.slots.inject("main", () => ctx.slots.register(
          { name: "main", key: PANEL_KEY },
          KanbanPanel,
        ));
      } catch (error) { reportError("register:main", error); }

      // 输入框上方的返回气泡：仅从看板跳转到会话且侧栏收起时展示。
      try {
        ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
          {
            name: "conversation.input.dock",
            id: "kanban-return",
            order: 30,
            label: () => labelFor("dock.return", "返回看板"),
            inject: (sessionId) => ({ sessionId }),
          },
          KanbanReturnDock,
        ));
      } catch (error) { reportError("register:conversation.dock", error); }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.KanbanIcon = KanbanIcon;
    return module.exports;
  },
});
