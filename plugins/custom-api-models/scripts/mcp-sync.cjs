#!/usr/bin/env node
// Minimal stdio MCP server. Starting it writes models.json before the CLI marks the server connected;
// the MCP status change triggers the CLI's model reload, so new sessions pick up the routes without a restart.
"use strict";
const lib = require("./sync-models.cjs");
let status = { ok: false, reason: "pending" };
const redact = (s) => { if (!s) return s; const c = { ...s }; delete c.dst; return c; };
const ready = lib.sync().catch(e => ({ ok: false, error: String(e && e.message || e) })).then(s => { status = s; });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const TOOLS = [
  { name: "models_status", description: "Show which WorkBuddy model ids are routed to which third-party API (keys are never shown)", inputSchema: { type: "object", properties: {} } },
  { name: "models_resync", description: "Re-read the workbuddy-3p config and rewrite ~/.codebuddy/models.json", inputSchema: { type: "object", properties: {} } },
  { name: "models_doctor", description: "Send a tiny test request to every routed upstream model and report HTTP status", inputSchema: { type: "object", properties: {} } },
];
async function callTool(name) {
  if (name === "models_status") return status;
  if (name === "models_resync") { status = await lib.sync().catch(e => ({ ok: false, error: String(e.message || e) })); return status; }
  if (name === "models_doctor") return lib.doctor();
  throw new Error("unknown tool " + name);
}
let buf = "", chain = Promise.resolve();
async function handle(d) {
  buf += d; await ready; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    try {
      if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "custom-api-models", version: "2.0.0" } });
      else if (msg.method === "ping") reply({});
      else if (msg.method === "tools/list") reply({ tools: TOOLS });
      else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: JSON.stringify(redact(await callTool(msg.params?.name)), null, 2) }] });
      else fail(-32601, "Method not found");
    } catch (e) { reply({ isError: true, content: [{ type: "text", text: String(e.message || e) }] }); }
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { chain = chain.then(() => handle(d)); });
process.stdin.on("end", () => { chain.then(() => ready).then(() => process.exit(0)); });
