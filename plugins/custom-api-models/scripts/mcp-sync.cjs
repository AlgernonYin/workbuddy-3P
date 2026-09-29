#!/usr/bin/env node
// Minimal stdio MCP server. Starting it writes models.json before the CLI marks the server connected;
// the MCP status change makes the CLI reload models, so a fresh sandbox picks up the routes.
"use strict";
const lib = require("./sync-models.cjs");
const VERSION = "2.2.1";
const errOut = (e) => ({ ok: false, error: String(e && e.message || e) });
let status = { ok: false, reason: "pending" };
const ready = lib.sync().catch(errOut).then(s => { status = s; });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const noArgs = { type: "object", properties: {} };
const TOOLS = [
  { name: "models_status", description: "Show whether WorkBuddy models currently go to the official backend or to the configured third-party API, and why. Never shows keys.", inputSchema: noArgs },
  { name: "models_switch", description: "Switch this sandbox between the official WorkBuddy models and the configured third-party API. mode: \"official\", \"third-party\", or \"default\" (clear the local switch and follow plugin/env config).",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["official", "third-party", "default"] } }, required: ["mode"] } },
  { name: "models_resync", description: "Re-read the workbuddy-3p config and rewrite ~/.codebuddy/models.json", inputSchema: noArgs },
  { name: "models_doctor", description: "Send a tiny test request to every model in the current routing plan and report HTTP status only", inputSchema: noArgs },
];
const clean = (r) => { if (!r || typeof r !== "object") return r; const c = { ...r }; delete c.dst; delete c.plan; return c; };
async function callTool(name, args = {}) {
  if (name === "models_status") return { ...lib.status(), lastSync: clean(status) };
  if (name === "models_switch") { status = await lib.setSwitch(args.mode === "default" ? "" : args.mode).catch(errOut); return { ...clean(status), note: "Takes effect for new requests once WorkBuddy reloads models.json; start a new session if the menu does not change." }; }
  if (name === "models_resync") { status = await lib.sync().catch(errOut); return clean(status); }
  if (name === "models_doctor") return lib.doctor().catch(errOut);
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
    try {
      if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "custom-api-models", version: VERSION } });
      else if (msg.method === "ping") reply({});
      else if (msg.method === "tools/list") reply({ tools: TOOLS });
      else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: JSON.stringify(await callTool(msg.params?.name, msg.params?.arguments), null, 2) }] });
      else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    } catch (e) { reply({ isError: true, content: [{ type: "text", text: String(e.message || e) }] }); }
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { chain = chain.then(() => handle(d)); });
process.stdin.on("end", () => { chain.then(() => ready).then(() => process.exit(0)); });
