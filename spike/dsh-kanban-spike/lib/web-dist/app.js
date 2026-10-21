// iframe 内应用：只能通过 postMessage 请求父页面（DSH 客户端插件）做会话操作。
// 直接 fetch /api/kanban-spike/* 读卡片；SSE 推送 + 3s 轮询兜底。
(function () {
  "use strict";

  var logEl = document.getElementById("log");
  var state = {
    bridgeReady: false,
    mode: "unknown",
    tokens: 0,
    count: null,
    cards: [],
    cwd: "",
    sessionId: null,
    lastSend: null,
    log: [],
    errors: [],
  };
  // 供自动化验证读取（playwright evaluate）。
  window.__kanbanSpike = state;
  window.__dshKanbanSpikeFrame = true;

  function log(line) {
    var stamp = new Date().toISOString().slice(11, 23);
    state.log.push(stamp + " " + line);
    if (state.log.length > 200) state.log.shift();
    if (logEl) logEl.textContent = state.log.join("\n");
    logEl && (logEl.scrollTop = logEl.scrollHeight);
  }

  function setStatus(text, kind) {
    var el = document.getElementById("bridge-status");
    if (!el) return;
    el.textContent = text;
    el.className = "kb-status" + (kind ? " " + kind : "");
  }

  // ---- 主题桥接收端：父页面 postMessage({type:"kanban:theme", mode, tokens}) ----
  function applyTheme(data) {
    var tokens = data && data.tokens && typeof data.tokens === "object" ? data.tokens : {};
    var root = document.documentElement;
    var applied = 0;
    for (var name in tokens) {
      if (!Object.prototype.hasOwnProperty.call(tokens, name)) continue;
      if (!/^--(dsw|dsh)-[a-z0-9-]+$/i.test(name)) continue;
      root.style.setProperty(name, tokens[name]);
      applied++;
    }
    var mode = data && data.mode === "dark" ? "dark" : "light";
    root.setAttribute("data-ds-theme", mode);
    root.style.colorScheme = mode;
    state.tokens = applied;
    state.mode = mode;
    document.getElementById("theme-mode") && (document.getElementById("theme-mode").textContent = mode);
    document.getElementById("token-count") && (document.getElementById("token-count").textContent = String(applied));
    setStatus("主题桥已连接：" + mode + " · " + applied + " 个令牌", "ok");
    log("收到 kanban:theme mode=" + mode + " tokens=" + applied);
  }

  function post(payload) {
    if (window.parent === window) {
      log("没有父页面（直接打开页面模式），跳过 postMessage: " + payload.type);
      return;
    }
    window.parent.postMessage(payload, window.location.origin);
  }

  // ---- 服务端数据：API + SSE ----
  function render() {
    var columns = { todo: [], doing: [], done: [] };
    state.cards.forEach(function (card) {
      (columns[card.column] || columns.todo).push(card);
    });
    var host = document.getElementById("columns");
    if (!host) return;
    var labels = { todo: "待办", doing: "进行中", done: "完成" };
    host.replaceChildren();
    Object.keys(columns).forEach(function (key) {
      var col = document.createElement("div");
      col.className = "kb-column";
      col.dataset.column = key;
      var h2 = document.createElement("h2");
      h2.textContent = labels[key] + " · " + columns[key].length;
      col.appendChild(h2);
      if (!columns[key].length) {
        var empty = document.createElement("div");
        empty.className = "kb-empty";
        empty.textContent = "（空）";
        col.appendChild(empty);
      }
      columns[key].forEach(function (card) {
        var node = document.createElement("div");
        node.className = "kb-card";
        node.dataset.cardId = card.id;
        node.textContent = card.title;
        var src = document.createElement("span");
        src.className = "kb-card-src";
        src.textContent = card.id + " · " + (card.source || "seed");
        node.appendChild(src);
        col.appendChild(node);
      });
      host.appendChild(col);
    });
    var countEl = document.getElementById("card-count");
    if (countEl) countEl.textContent = String(state.cards.length);
  }

  function fetchState() {
    return fetch("/api/kanban-spike/state", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        state.cards = Array.isArray(data.cards) ? data.cards : [];
        state.count = data.count;
        state.cwd = data.cwd || state.cwd;
        render();
        log("GET /api/kanban-spike/state -> count=" + data.count);
      })
      .catch(function (error) {
        state.errors.push(String(error.message || error));
        setStatus("API 读取失败：" + error.message, "err");
        log("API 失败：" + error.message);
      });
  }

  function connectSse() {
    if (typeof EventSource !== "function") return;
    try {
      var source = new EventSource("/api/kanban-spike/events");
      source.addEventListener("hello", function (event) {
        log("SSE hello: " + event.data);
      });
      source.addEventListener("kanban", function (event) {
        log("SSE cards: " + event.data);
        fetchState();
      });
      source.onerror = function () {
        log("SSE 断开，等待浏览器重连（轮询仍在工作）");
      };
    } catch (error) {
      log("SSE 不可用：" + error.message);
    }
  }

  // ---- 父页面桥：发送消息 / 打开会话 ----
  function sendToSession(mode) {
    var button = document.getElementById(mode === "new" ? "send-new" : "send-current");
    if (button) button.disabled = true;
    state.lastSend = null;
    var text =
      mode === "new"
        ? "请调用 kanban_spike_add_card 工具，添加一张标题为「看板冒烟：iframe 触发」的卡片，然后用一句话确认。"
        : "请调用 kanban_spike_cards 工具读取看板卡片数，并用一句话回复数量。";
    log("向父页面请求 sessions prompt（" + mode + "）：" + text.slice(0, 40) + "…");
    post({ type: "kanban:send", target: mode, text: text, cwd: state.cwd });
  }

  document.getElementById("refresh")?.addEventListener("click", function () {
    fetchState();
  });
  document.getElementById("send-new")?.addEventListener("click", function () {
    sendToSession("new");
  });
  document.getElementById("send-current")?.addEventListener("click", function () {
    sendToSession("current");
  });
  document.getElementById("open-session")?.addEventListener("click", function () {
    if (state.lastSend && state.lastSend.sessionId) {
      post({ type: "kanban:open-session", sessionId: state.lastSend.sessionId });
      log("请求父页面打开会话 " + state.lastSend.sessionId);
    }
  });

  window.addEventListener("message", function (event) {
    // 只接受同源父页面消息；父页面用 event.source===iframe.contentWindow 再互验一次。
    if (event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || typeof data.type !== "string") return;
    if (data.type === "kanban:theme") {
      applyTheme(data);
      return;
    }
    if (data.type === "kanban:host-info") {
      state.sessionId = data.current || null;
      if (!state.cwd && data.cwd) state.cwd = data.cwd;
      state.bridgeReady = true;
      setStatus(
        "父页面桥已连接 · 当前会话 " + (data.current ? String(data.current).slice(0, 18) + "…" : "（无，发送时会新建）"),
        "ok"
      );
      log("收到 kanban:host-info current=" + data.current + " ids=" + data.ids);
      return;
    }
    if (data.type === "kanban:send:result") {
      var newButton = document.getElementById("send-new");
      var curButton = document.getElementById("send-current");
      if (newButton) newButton.disabled = false;
      if (curButton) curButton.disabled = false;
      if (data.ok) {
        state.lastSend = { sessionId: data.sessionId, created: data.created, text: data.text };
        setStatus("已通过 session.prompt 发送（" + (data.created ? "新建会话" : "当前会话") + "）", "ok");
        log("prompt 成功 sessionId=" + data.sessionId + " created=" + !!data.created);
        var open = document.getElementById("open-session");
        if (open) {
          open.hidden = false;
          open.textContent = "查看会话 " + String(data.sessionId).slice(0, 14) + "… ›";
        }
      } else {
        setStatus("发送失败：" + (data.message || "未知错误"), "err");
        log("prompt 失败：" + (data.message || JSON.stringify(data)));
      }
    }
  });

  function announce() {
    post({ type: "kanban:ready", version: 1 });
    log("已向父页面发送 kanban:ready（握手）");
  }

  announce();
  fetchState();
  connectSse();
  setInterval(fetchState, 3000); // 轮询兜底：SSE 不可用/断线时仍能反映 agent 工具写入
})();
