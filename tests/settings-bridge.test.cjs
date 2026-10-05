"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgePath = path.resolve(__dirname, "../plugins/custom-api-models/scripts/mcp-app-bridge.js");
const htmlPath = path.resolve(__dirname, "../plugins/custom-api-models/ui/settings.html");
const bridgeSource = fs.readFileSync(bridgePath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");

function loadSettingsInternals() {
  const match = html.match(/<script id="wb3p-ui">([\s\S]*?)<\/script>/);
  assert.ok(match, "missing UI script");
  const sandbox = { window: { addEventListener() {} }, document: { readyState: "loading", addEventListener() {} } };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(match[1], sandbox, { filename: htmlPath });
  return sandbox.window.__wb3pSettingsInternals;
}

function bridge(response) {
  const handlers = [], messages = [];
  const parent = {
    postMessage(msg) {
      messages.push(msg);
      if (msg.id === undefined) return;
      const result = msg.method === "ui/initialize"
        ? { hostInfo: { name: "Fixture" }, hostCapabilities: { serverTools: {} } }
        : response;
      queueMicrotask(() => handlers.forEach((fn) => fn({
        source: parent,
        origin: "https://fixture.invalid",
        data: { jsonrpc: "2.0", id: msg.id, result },
      })));
    },
  };
  const window = { parent, addEventListener(name, fn) { handlers.push(fn); } };
  vm.runInNewContext(bridgeSource, { window, document: { documentElement: { scrollHeight: 100 } }, setTimeout, clearTimeout });
  return { api: window.wb3pBridge, window, handlers, messages };
}

test("bridge handshake declares appInfo version 3.0.0", async () => {
  const b = bridge({ structuredContent: { ok: true } });
  assert.equal(await b.api.connect(), true);
  const initialize = b.messages.find(message => message.method === "ui/initialize");
  assert.equal(initialize.params.appInfo.name, "workbuddy-3p-settings");
  assert.equal(initialize.params.appInfo.version, "3.0.0");
});
class FakeNode {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName; this.id = id; this.children = []; this.parentNode = null;
    this._textContent = ""; this.className = ""; this.style = {}; this.hidden = false;
    this.disabled = false; this.checked = false; this.value = ""; this.listeners = new Map();
  }
  set textContent(value) { this._textContent = value === undefined || value === null ? "" : String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(""); }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; return child; }
  addEventListener(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }
  dispatch(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn({ target: this, ...event }); }
  setAttribute(name, value) { this[name] = String(value); }
  click() { if (!this.disabled) this.dispatch("click"); }
  focus() {} remove() { if (this.parentNode) this.parentNode.removeChild(this); } select() {}
}

function uiBridgeHarness(initialState, responses) {
  const ids = [
    "initial-state", "operation-status", "confirmation-panel", "confirmation-types", "confirm-apply-button", "cancel-confirmation-button",
    "publication-block-panel", "publication-block-detail", "status-recheck-button", "connection", "connection-title", "connection-detail",
    "waiting-panel", "waiting-detail", "settings-panel", "account-sync-status", "account-connect-button", "account-finish-button", "account-login-status",
    "model-source", "parameter-priority", "scope-account", "scope-session", "import-session-button", "tab-providers", "tab-routing", "panel-providers", "panel-routing",
    "provider-list", "discovery-workbench", "new-provider-id", "new-provider-protocol", "new-provider-label", "new-provider-base-url",
    "new-provider-api-key-env", "new-provider-extra-models", "add-provider-button", "route-source", "route-target", "add-route-button",
    "official-model-options", "route-list", "offline-panel", "offline-output", "copy-offline-button", "download-offline-button",
    "offline-status", "apply-button", "action-title", "action-detail",
  ];
  const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode(id.includes("button") ? "button" : id.includes("select") ? "select" : "div", id)]));
  nodes["initial-state"].textContent = JSON.stringify(initialState);
  const documentHandlers = new Map(), windowHandlers = new Map();
  const document = {
    readyState: "loading",
    body: new FakeNode("body", "body"),
    documentElement: new FakeNode("html", "html"),
    createElement(tag) { return new FakeNode(tag); },
    getElementById(id) { return nodes[id] || null; },
    addEventListener(name, fn) { const list = documentHandlers.get(name) || []; list.push(fn); documentHandlers.set(name, list); },
    dispatch(name, event = {}) { for (const fn of documentHandlers.get(name) || []) fn(event); },
  };
  const window = {
    parent: null,
    addEventListener(name, fn) { const list = windowHandlers.get(name) || []; list.push(fn); windowHandlers.set(name, list); },
    dispatch(name, event = {}) { for (const fn of windowHandlers.get(name) || []) fn(event); },
    requestAnimationFrame(fn) { fn(); return 1; },
  };
  window.window = window;
  const callLog = [];
  let responseIndex = 0;
  const parent = {
    postMessage(msg) {
      if (msg.id === undefined) return;
      let result;
      if (msg.method === "ui/initialize") result = { hostInfo: { name: "Fixture" }, hostCapabilities: { serverTools: {} } };
      else if (msg.method === "tools/call") {
        const call = { name: msg.params.name, arguments: msg.params.arguments };
        callLog.push(call);
        const response = responses[Math.min(responseIndex++, responses.length - 1)];
        result = typeof response === "function" ? response(call) : response;
      } else result = {};
      queueMicrotask(() => window.dispatch("message", {
        source: parent, origin: "https://fixture.invalid", data: { jsonrpc: "2.0", id: msg.id, result },
      }));
    },
  };
  window.parent = parent;
  const context = { window, document, URL, Blob, navigator: {}, setTimeout, clearTimeout, queueMicrotask };
  vm.runInNewContext(bridgeSource, context, { filename: bridgePath });
  const uiSource = html.match(/<script id="wb3p-ui">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(uiSource, context, { filename: htmlPath });
  document.dispatch("DOMContentLoaded", {});
  return {
    nodes, callLog,
    async settle() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('an initial state does not leave discovery disabled after a boolean bridge handshake',async()=>{
  const h=uiBridgeHarness({ok:true,revision:'initial',accountSync:{available:true,status:'synced'},providers:[{id:'p',protocol:'openai-chat',nativeSessionSupported:true,label:'P',baseUrl:'https://api.example.invalid/v1',models:{m:{maxInputTokens:64000}},extraModels:['m'],credential:{configured:true,kind:'environment'}}],routes:{}},[]);
  for(let i=0;i<8;i++)await Promise.resolve();
  const find=(node,text)=>node.textContent===text?node:(node.children||[]).map(child=>find(child,text)).find(Boolean);
  const button=find(h.nodes['provider-list'],'拉取支持的模型');
  assert.ok(button);assert.equal(button.disabled,false);assert.deepEqual(h.callLog,[]);
});
test('switching to routing immediately includes a model imported in the provider layer',async()=>{
 const h=uiBridgeHarness({ok:true,revision:'initial',accountSync:{available:true,status:'synced'},providers:[{id:'p',protocol:'openai-chat',nativeSessionSupported:true,baseUrl:'https://api.example.invalid/v1',models:{old:{maxInputTokens:64000}},extraModels:['old'],credential:{configured:true}}],routes:{}},[{structuredContent:{ok:true,providerId:'p',protocol:'openai-chat',supported:true,models:[{id:'new'}]}}]);
 await h.settle();
 const find=(node,predicate)=>predicate(node)?node:(node.children||[]).map(child=>find(child,predicate)).find(Boolean);
 find(h.nodes['provider-list'],n=>n.tagName==='button'&&n.textContent==='拉取支持的模型').click();await h.settle();
 const check=find(h.nodes['provider-list'],n=>n.id==='discovery-p-0');assert.ok(check);check.checked=true;check.dispatch('change');
 find(h.nodes['provider-list'],n=>n.tagName==='button'&&n.textContent==='导入所选（尚未保存）').click();
 h.nodes['tab-routing'].click();
 assert.ok(h.nodes['route-target'].children.some(n=>n.value==='p:new'));
});

test('switching edit scope reads its separate baseline instead of promoting hidden session values',async()=>{
 const account={ok:true,scope:'account',revision:'account-r',accountSync:{available:true,status:'synced'},configuredMode:'official',parameterPriority:'native',providers:[],routes:{}};
 const session={...account,scope:'session',revision:'session-r',configuredMode:'third-party',parameterPriority:'3p'};
 const h=uiBridgeHarness(account,[{structuredContent:session},{structuredContent:account}]);await h.settle();
 h.nodes['scope-session'].checked=true;h.nodes['scope-session'].dispatch('change');await h.settle();
 assert.deepEqual(JSON.parse(JSON.stringify(h.callLog[0].arguments)),{action:'status',scope:'session'});
 assert.equal(h.nodes['model-source'].value,'third-party');assert.equal(h.nodes['parameter-priority'].value,'3p');
 h.nodes['scope-account'].checked=true;h.nodes['scope-account'].dispatch('change');await h.settle();
 assert.deepEqual(JSON.parse(JSON.stringify(h.callLog[1].arguments)),{action:'status',scope:'account'});
 assert.equal(h.nodes['model-source'].value,'official');assert.equal(h.nodes['parameter-priority'].value,'native');
 assert.equal(h.nodes['apply-button'].disabled,true);
});

test('first session import is a separate explicit account publication and cannot be triggered by a scope radio',async()=>{
 const account={ok:true,scope:'account',canImportSession:true,revision:'r',accountSync:{available:true,status:'not-published'},configuredMode:'official',providers:[],routes:{}};
 const session={...account,scope:'session',configuredMode:'third-party',parameterPriority:'3p'};
 const h=uiBridgeHarness(account,[{structuredContent:session},{structuredContent:{...account,committed:true,accountCommitted:true}}]);await h.settle();
 assert.equal(h.nodes['import-session-button'].disabled,false);
 h.nodes['import-session-button'].click();await h.settle();
 assert.equal(h.nodes['scope-account'].checked,true);assert.equal(h.nodes['apply-button'].disabled,false,h.nodes['operation-status'].textContent);
 h.nodes['apply-button'].click();await h.settle();
 const request=h.callLog.find(c=>c.arguments.action==='apply').arguments;
 assert.equal(request.scope,'account');assert.equal(request.importSession,true);assert.deepEqual(Object.keys(request.patch),[]);
});

test('an unsaved draft prevents scope switches and cannot leak into account edits',async()=>{
 const h=uiBridgeHarness({ok:true,scope:'session',revision:'r',accountSync:{available:true,status:'synced'},configuredMode:'official',providers:[],routes:{}},[]);await h.settle();
 h.nodes['model-source'].value='third-party';h.nodes['model-source'].dispatch('change');
 h.nodes['scope-account'].checked=true;h.nodes['scope-account'].dispatch('change');await h.settle();
 assert.equal(h.nodes['scope-session'].checked,true);assert.equal(h.callLog.length,0);
 assert.match(h.nodes['operation-status'].textContent,/未复制任何参数/);
});
test("bridge rejects errors with otherwise plausible state and never treats notifications as an apply receipt", async () => {
  const b = bridge({ structuredContent: { ok: false, revision: "old", models: [] } });
  assert.equal(await b.api.connect(), true);
  await assert.rejects(b.api.callTool({ action: "apply" }), /未应用/);
});

test("bridge returns committed readback failure distinctly from normal state", async () => {
  const b = bridge({ structuredContent: { ok: true, committed: true, stateUnavailable: true } });
  await b.api.connect();
  const result = await b.api.callTool({ action: "apply" });
  assert.equal(result.committed, true);
  assert.equal(result.stateUnavailable, true);
});

test("bridge ignores unrelated frame notifications", async () => {
  const b = bridge({ structuredContent: { ok: true, revision: "new" } });
  await b.api.connect();
  let observed = false;
  b.api.subscribe(() => { observed = true; });
  b.handlers[0]({
    source: {},
    origin: "https://fixture.invalid",
    data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { revision: "forged" } } },
  });
  assert.equal(observed, false);
});

test("a status-shaped cached response cannot satisfy an apply request", async () => {
  const b = bridge({ structuredContent: { ok: true, revision: "cached", models: [] } });
  await b.api.connect();
  await assert.rejects(b.api.callTool({ action: "apply" }), /提交回执/);
});

test("bridge requires explicit ok and commit receipts for mutation success", async () => {
  const good = bridge({ structuredContent: { ok: true, committed: true, revision: "updated" } });
  await good.api.connect();
  assert.equal((await good.api.callTool({ action: "apply" })).committed, true);

  const bad = bridge({ structuredContent: { committed: false, ok: true, revision: "cached" } });
  await bad.api.connect();
  await assert.rejects(bad.api.callTool({ action: "apply" }), /提交回执/);

  const ambiguous = bridge({ structuredContent: { committed: true, revision: "cached" } });
  await ambiguous.api.connect();
  await assert.rejects(ambiguous.api.callTool({ action: "apply" }), /配置回执/);
});

test("bridge returns known account and provider action receipts unchanged without inventing state", async () => {
  const receipts = [
    { action: "connect", receipt: { ok: true, loginRequired: true, authorizationUrl: "https://www.workbuddy.cn/auth" } },
    { action: "finish-connect", receipt: { ok: true, accountConnected: true, accountCommitted: false } },
    { action: "finish-connect", receipt: { ok: false, loginPending: true } },
    { action: "discover", receipt: { ok: true, providerId: "p", models: [] } },
    { action: "probe", receipt: { ok: false, providerId: "p", model: "m", error: { code: "REQUEST_FAILED" } } },
  ];
  for (const item of receipts) {
    const b = bridge({ structuredContent: item.receipt });
    await b.api.connect();
    const result = await b.api.callTool({ action: item.action });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), item.receipt);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "state"), false);
  }
});

test("bridge passes known apply outcomes to the UI and keeps MCP isError as a hard failure", async () => {
  for (const receipt of [
    { ok: false, confirmationRequired: true, confirmationTypes: ["publish", "overwrite"] },
    { ok: false, outcomeUnknown: true, accountCommitted: null },
    { ok: false, publicationPending: true, accountCommitted: null },
    { ok: true, accountCommitted: true, localSyncPending: true },
  ]) {
    const b = bridge({ structuredContent: receipt });
    await b.api.connect();
    assert.deepEqual(JSON.parse(JSON.stringify(await b.api.callTool({ action: "apply" }))), receipt);
  }

  const hard = bridge({ isError: true, content: [{ type: "text", text: "hard failure" }], structuredContent: { ok: false, confirmationRequired: true } });
  await hard.api.connect();
  await assert.rejects(hard.api.callTool({ action: "apply" }), /hard failure/);
});

test("bridge status requires a complete state with revision and does not promote action receipts", async () => {
  const incomplete = bridge({ structuredContent: { ok: true, revision: "r" } });
  await incomplete.api.connect();
  await assert.rejects(incomplete.api.callTool({ action: "status" }), /完整配置/);

  const noRevision = bridge({ structuredContent: { ok: true, providers: [], routes: {} } });
  await noRevision.api.connect();
  await assert.rejects(noRevision.api.callTool({ action: "status" }), /完整配置/);

  const state = { ok: true, revision: "r", providers: [], routes: {}, accountSync: { available: true, status: "synced", retryBlocked: false } };
  const complete = bridge({ structuredContent: state });
  await complete.api.connect();
  assert.deepEqual(JSON.parse(JSON.stringify(await complete.api.callTool({ action: "status" }))), state);
});

test("real UI and bridge keep outcomeUnknown blocked after an unresolved status refresh", async () => {
  const initial = {
    ok: true, revision: "r1", configuredMode: "official", parameterPriority: "3p", readOnly: false,
    accountSync: { available: true, status: "synced", retryBlocked: false },
    providers: [], routes: {}, officialModels: [],
  };
  const unresolved = {
    ok: true, revision: "r2", configuredMode: "official", parameterPriority: "3p", readOnly: false,
    accountSync: { available: true, status: "publication-unresolved", retryBlocked: true, outcomeUnknown: true, publicationPending: true },
    providers: [], routes: {}, officialModels: [],
  };
  const resolved = {
    ok: true, revision: "r3", configuredMode: "official", parameterPriority: "3p", readOnly: false,
    accountSync: { available: true, status: "synced", retryBlocked: false },
    providers: [], routes: {}, officialModels: [],
  };
  const harness = uiBridgeHarness(initial, [
    { structuredContent: { ok: false, outcomeUnknown: true, accountCommitted: null } },
    { structuredContent: unresolved },
    { structuredContent: resolved },
  ]);
  await harness.settle();

  harness.nodes["model-source"].value = "third-party";
  harness.nodes["model-source"].dispatch("change");
  harness.nodes["apply-button"].click();
  await harness.settle();
  assert.equal(harness.callLog.filter(call => call.arguments.action === "apply").length, 1);
  assert.equal(harness.nodes["publication-block-panel"].hidden, false);

  harness.nodes["status-recheck-button"].click();
  await harness.settle();
  assert.equal(harness.callLog.filter(call => call.arguments.action === "status").length, 1);
  assert.equal(harness.nodes["publication-block-panel"].hidden, false);
  assert.match(harness.nodes["publication-block-detail"].textContent, /publication-unresolved/);
  assert.match(harness.nodes["publication-block-detail"].textContent, /retryBlocked=true/);
  harness.nodes["apply-button"].click();
  assert.equal(harness.callLog.filter(call => call.arguments.action === "apply").length, 1);

  harness.nodes["status-recheck-button"].click();
  await harness.settle();
  assert.equal(harness.nodes["publication-block-panel"].hidden, true);
  assert.equal(harness.callLog.filter(call => call.arguments.action === "apply").length, 1);
});
test("real UI and bridge preserve the user draft through account connect refresh", async () => {
  const initial = {
    ok: true, revision: "r1", configuredMode: "official", parameterPriority: "3p", readOnly: false,
    accountSync: { available: false, status: "not-connected", retryBlocked: false },
    providers: [], routes: {}, officialModels: [],
  };
  const connected = {
    ok: true, revision: "r2", configuredMode: "official", parameterPriority: "3p", readOnly: false,
    accountSync: { available: true, status: "synced", retryBlocked: false },
    providers: [], routes: {}, officialModels: [],
  };
  const harness = uiBridgeHarness(initial, [
    { structuredContent: { ok: true, loginRequired: true, authorizationUrl: "https://www.workbuddy.cn/auth" } },
    { structuredContent: { ok: true, accountConnected: true, accountCommitted: false } },
    { structuredContent: connected },
  ]);
  await harness.settle();

  harness.nodes["model-source"].value = "third-party";
  harness.nodes["model-source"].dispatch("change");
  harness.nodes["account-connect-button"].click();
  await harness.settle();
  assert.equal(harness.nodes["account-finish-button"].hidden, false);
  harness.nodes["account-finish-button"].click();
  await harness.settle();

  assert.deepEqual(harness.callLog.map(call => call.arguments.action), ["connect", "finish-connect", "status"]);
  assert.equal(harness.nodes["model-source"].value, "third-party");
  assert.equal(harness.nodes["apply-button"].disabled, false);
  assert.equal(harness.nodes["account-sync-status"].textContent.includes("账号同步可用"), true);
});
test("real UI and bridge block apply when the initial status is unresolved", async () => {
  const initial = {
    ok: true, revision: "r1", configuredMode: "official", parameterPriority: "3p", readOnly: false,
    accountSync: { available: true, status: "publication-unresolved", retryBlocked: true, outcomeUnknown: true, publicationPending: true },
    providers: [], routes: {}, officialModels: [],
  };
  const harness = uiBridgeHarness(initial, []);
  await harness.settle();
  harness.nodes["model-source"].value = "third-party";
  harness.nodes["model-source"].dispatch("change");
  assert.equal(harness.nodes["apply-button"].disabled, true);
  harness.nodes["apply-button"].click();
  assert.equal(harness.callLog.filter(call => call.arguments.action === "apply").length, 0);
  assert.equal(harness.nodes["publication-block-panel"].hidden, false);
});
test("UI refuses to treat a bridge-returned committed response as success without a scoped receipt", async () => {
  const internals = loadSettingsInternals();
  const b = bridge({ structuredContent: { ok: true, committed: true, revision: "updated" } });
  await b.api.connect();
  const result = await b.api.callTool({ action: "apply", scope: "account" });
  assert.equal(internals.hasCommitReceipt(result, "account"), false);
  assert.equal(internals.hasCommitReceipt(result, "session"), false);
});

test("UI accepts only committed plus session or accountCommitted as a save receipt", () => {
  const internals = loadSettingsInternals();
  assert.equal(internals.hasCommitReceipt({ committed: true, revision: "new" }, "session"), false);
  assert.equal(internals.hasCommitReceipt({ committed: false, session: true, revision: "new" }, "session"), false);
  assert.equal(internals.hasCommitReceipt({ committed: true, session: true, revision: "new" }, "session"), true);
  assert.equal(internals.hasCommitReceipt({ committed: true, accountCommitted: true, revision: "new" }, "account"), true);
  assert.equal(internals.hasCommitReceipt({ committed: true, session: true, revision: "new" }, "account"), false);
});
