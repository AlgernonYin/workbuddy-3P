"use strict";
// Small dependency-free implementation of the standard MCP Apps postMessage transport.
// Only the embedding parent can respond; no credentials or general-purpose host RPCs.
(() => {
  const pending = new Map(), listeners = new Set();
  let id = 0, connected = false, hostOrigin, connecting, lastResult;
  const send = msg => window.parent.postMessage({ jsonrpc: "2.0", ...msg }, hostOrigin && hostOrigin !== "null" ? hostOrigin : "*");
  function request(method, params, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(Error("宿主未响应；配置尚未应用 / Host did not respond; settings not applied")); }, timeout);
      pending.set(requestId, { resolve, reject, timer, method });
      send({ id: requestId, method, params });
    });
  }
  window.addEventListener("message", event => {
    if (event.source !== window.parent || hostOrigin !== undefined && event.origin !== hostOrigin) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      if (p.method === "ui/initialize" && msg.result?.hostInfo) hostOrigin = event.origin;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(Error("宿主拒绝操作 / Host rejected operation")); else p.resolve(msg.result);
    } else if (connected && msg.method === "ui/notifications/tool-result") {
      lastResult = msg.params;
      for (const fn of listeners) fn(lastResult);
    } else if (msg.method === "ui/resource-teardown" && msg.id !== undefined) {
      connected = false; send({ id: msg.id, result: {} });
    }
  });
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  function isCompleteStatusState(state) {
    return isObject(state) && state.ok === true && typeof state.revision === "string" &&
      (Array.isArray(state.providers) || isObject(state.providers)) && isObject(state.routes) && isObject(state.accountSync);
  }
  function isKnownApplyReceipt(state) {
    if (!isObject(state)) return false;
    if (state.ok === false && (state.confirmationRequired === true || state.outcomeUnknown === true || state.publicationPending === true)) return true;
    return state.accountCommitted === true && (state.localSyncPending === true || state.partial === true || state.stateUnavailable === true);
  }
  function isKnownActionReceipt(action, state) {
    if (!isObject(state)) return false;
    if (action === "connect" || action === "finish-connect") {
      return (state.ok === true && (state.accountConnected === true || state.loginRequired === true || typeof state.authorizationUrl === "string")) ||
        (action === "finish-connect" && state.ok === false && state.loginPending === true);
    }
    if (action === "discover" || action === "probe") return typeof state.ok === "boolean" && typeof state.providerId === "string";
    return false;
  }
  window.wb3pBridge = {
    get available() { return connected; },
    connect() {
      if (window.parent === window) return Promise.resolve(false);
      return connecting ||= request("ui/initialize", { appInfo: { name: "workbuddy-3p-settings", version: "3.0.0" },
        appCapabilities: {}, protocolVersion: "2026-01-26" }, 4000).then(result => {
        connected = !!result?.hostCapabilities?.serverTools;
        send({ method: "ui/notifications/initialized", params: {} });
        return connected;
      }).catch(() => false);
    },
    subscribe(fn) { listeners.add(fn); if (lastResult) fn(lastResult); return () => listeners.delete(fn); },
    async callTool(args) {
      if (!connected) throw Error("宿主没有直接保存接口；请使用会话向导 / Direct save unavailable; use chat wizard");
      const result = await request("tools/call", { name: "models_settings", arguments: args }, 45000);
      if (result?.isError) throw Error(result.content?.find(c => c.type === "text")?.text || "配置未应用 / Not applied");
      const state = result?.structuredContent, action = args?.action;
      if (isCompleteStatusState(state) && action === "status") { lastResult = result; return state; }
      if (action === "status") throw Error("状态未返回完整配置 / Missing complete status state; reread before retrying");
      if (isKnownApplyReceipt(state)) { lastResult = result; return state; }
      if (isKnownActionReceipt(action, state)) { lastResult = result; return state; }
      if (state?.ok === false || state?.error || state?.isError) throw Error("宿主未应用设置 / Host did not apply settings");
      if (action === "apply") {
        if (state?.committed !== true) throw Error("未收到本次保存的提交回执 / Missing apply commit receipt");
        if (state?.stateUnavailable === true) { lastResult = result; return state; }
        if (state?.ok !== true || typeof state.revision !== "string") throw Error("缺少配置回执；请重新读取 / Missing settings receipt; reread before retrying");
        lastResult = result;
        return state;
      }
      throw Error("缺少配置回执；请重新读取 / Missing settings receipt; reread before retrying");
    },
    notifySize() { if (connected) send({ method: "ui/notifications/size-changed", params: { height: Math.min(document.documentElement.scrollHeight, 1800) } }); }
  };
})();
