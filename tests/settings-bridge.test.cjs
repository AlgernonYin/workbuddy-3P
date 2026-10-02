"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../plugins/custom-api-models/scripts/mcp-app-bridge.js"), "utf8");
function bridge(response) {
  const handlers = [], parent = { postMessage(msg) {
    if (msg.id === undefined) return;
    const result = msg.method === "ui/initialize" ? { hostInfo: { name: "Fixture" }, hostCapabilities: { serverTools: {} } } : response;
    queueMicrotask(() => handlers.forEach(fn => fn({ source: parent, origin: "https://fixture.invalid", data: { jsonrpc: "2.0", id: msg.id, result } })));
  } };
  const window = { parent, addEventListener(name, fn) { handlers.push(fn); } };
  vm.runInNewContext(source, { window, document: { documentElement: { scrollHeight: 100 } }, setTimeout, clearTimeout });
  return { api: window.wb3pBridge, window, handlers };
}
test("bridge rejects errors with otherwise plausible state and never treats notifications as an apply receipt", async () => {
  const b = bridge({ structuredContent: { ok: false, revision: "old", models: [] } });
  assert.equal(await b.api.connect(), true);
  await assert.rejects(b.api.callTool({ action: "apply" }), /未应用/);
});
test("bridge returns committed readback failure distinctly from normal state", async () => {
  const b = bridge({ structuredContent: { ok: true, committed: true, stateUnavailable: true } });
  await b.api.connect(); const result = await b.api.callTool({ action: "apply" });
  assert.equal(result.committed, true); assert.equal(result.stateUnavailable, true);
});
test("bridge ignores unrelated frame notifications", async () => {
  const b = bridge({ structuredContent: { ok: true, revision: "new" } }); await b.api.connect(); let observed = false;
  b.api.subscribe(() => { observed = true; });
  b.handlers[0]({ source: {}, origin: "https://fixture.invalid", data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { revision: "forged" } } } });
  assert.equal(observed, false);
});
test("a status-shaped cached response cannot satisfy an apply request", async () => {
  const b = bridge({ structuredContent: { ok: true, revision: "cached", models: [] } }); await b.api.connect();
  await assert.rejects(b.api.callTool({ action: "apply" }), /提交回执/);
});
test("bridge requires explicit ok and commit receipts for mutation success", async () => {
  const good = bridge({ structuredContent: { ok: true, committed: true, revision: "updated" } }); await good.api.connect();
  assert.equal((await good.api.callTool({ action: "apply" })).committed, true);
  const bad = bridge({ structuredContent: { committed: false, ok: true, revision: "cached" } }); await bad.api.connect();
  await assert.rejects(bad.api.callTool({ action: "apply" }), /提交回执/);
  const ambiguous = bridge({ structuredContent: { committed: true, revision: "cached" } }); await ambiguous.api.connect();
  await assert.rejects(ambiguous.api.callTool({ action: "apply" }), /配置回执/);
});
