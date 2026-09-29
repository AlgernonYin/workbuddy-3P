#!/usr/bin/env node
// Minimal stdio MCP server. Its only job: write models.json before the CLI marks it connected,
// because an MCP status change triggers ProductManager.sync(), which reloads custom models.
"use strict";
let status = { ok: false, reason: "pending" };
// Finish writing models.json before answering initialize, so the connect-triggered reload sees it.
const ready = require("./sync-models.cjs").sync()
  .catch(e => ({ ok: false, reason: String(e && e.message || e) }))
  .then(s => { status = s; });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
async function handle(d) {
  buf += d; await ready; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        reply({ protocolVersion: msg.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} },
                serverInfo: { name: "bailian-models", version: "1.1.0" } }); break;
      case "tools/list":
        reply({ tools: [{ name: "bailian_models_status", description: "Show whether Bailian model routing was written",
                          inputSchema: { type: "object", properties: {} } }] }); break;
      case "tools/call":
        reply({ content: [{ type: "text", text: JSON.stringify({ ...status, dst: undefined }) }] }); break;
      default:
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  }
}
let chain = Promise.resolve();
process.stdin.removeAllListeners("data");
process.stdin.on("data", (d) => { chain = chain.then(() => handle(d)); });
process.stdin.on("end", () => { chain.then(() => ready).then(() => process.exit(0)); });
