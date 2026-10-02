#!/usr/bin/env node
// Minimal stdio MCP server. Starting it writes models.json before the CLI marks the server connected;
// the MCP status change makes the CLI reload models, so a fresh sandbox picks up the routes.
"use strict";
const lib = require("./sync-models.cjs");
const panel = require("./settings-panel.cjs");
const VERSION = "2.4.0";
const errOut = (e) => ({ ok: false, error: String(e && e.message || e) });
let status = { ok: false, reason: "pending" };
const ready = lib.sync().catch(errOut).then(s => { status = s; });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const noArgs = { type: "object", properties: {} };
const TOOLS = [
  { name: "models_settings", description: "Open the WorkBuddy 3P interactive settings panel, or inspect/apply secret-free structured settings. Supports model-specific thinking/off where declared, highest-supported-per-model, bounded input context, providers and custom routes, official/third-party switch. status is read-only; apply requires a fresh revision and creates private backups under the existing routing lock. API keys are never accepted/returned: preserve existing credentials or use apiKeyEnv. Never expand provider context capacity. Changes are sandbox-local, native overrides still win, host catalog refresh and model reselection may be required. On hosts without MCP Apps use /models-settings chat wizard or panel artifact (draft only).",
    _meta: { ui: { resourceUri: panel.URI } },
    inputSchema: { type: "object", additionalProperties: false, properties: {
      action: { type: "string", enum: ["status", "panel", "apply"], default: "status" },
      expectedRevision: { type: "string" }, patch: { type: "object", additionalProperties: false,
        properties: { switchMode: { enum: ["official", "third-party", "default"] },
          maxEffort: { type: "boolean" }, efforts: { type: "object", additionalProperties: { type: ["string", "null"] } },
          contexts: { type: "object", additionalProperties: { type: ["integer", "null"] } },
          providers: { type: "object" }, routes: { type: "object", additionalProperties: { type: ["string", "null"] } },
          defaultProvider: { type: "string" }, routingMode: { enum: ["same-name", "preset-only", "explicit"] } } }
    } } },
  { name: "models_effort", description: "Inspect, set or reset persistent third-party MODEL DEFAULT effort, not native session/global settings. The status operation itself does not resolve credentials or send provider/model requests; MCP startup still performs normal routing sync. A sandbox default skips unsupported models; model-specific settings reject unsupported levels. Local settings persist only in this sandbox; profileConfigPatch can be merged into an account-private profile for future sandboxes (not automatically uploaded). Native reasoningEffort overrides win. Official mode only saves deferred preferences. When requiresModelReselection=true, reselect the model after the host reloads; runtimeVerified=false.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      action: { type: "string", enum: ["status", "set", "reset"], default: "status" },
      scope: { type: "string", enum: ["default", "model", "all"], description: "Set default or one model; all is reset-only." },
      level: { type: "string", enum: ["on", "off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      model: { type: "string", description: "provider:upstream-model from status, or an unambiguous upstream id/official alias" }
    } } },
  { name: "models_status", description: "Show configured mode, models.json routing state and errors. This is disk configuration only, not proof of live request routing (runtimeVerified=false). Unknown state is not off. Never shows keys.", inputSchema: noArgs },
  { name: "models_switch", description: "Configure official/third-party/default mode for this sandbox. IMPORTANT: the host can retain the previous model ID after switching. Tell the user to reselect a model before the next message (if unchanged, select Hy3 then the target). Prefer a non-routed official model such as default Hy3 while switching. This tool cannot change the host's active selection.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["official", "third-party", "default"] } }, required: ["mode"] } },
  { name: "models_resync", description: "Re-read the workbuddy-3p config and rewrite ~/.codebuddy/models.json", inputSchema: noArgs },
  { name: "models_doctor", description: "In third-party mode send one billable tiny request per configured model; report HTTP status only, not runtime routing proof. Skip all requests in official mode.", inputSchema: noArgs },
];
const clean = (r) => { if (!r || typeof r !== "object") return r; const c = { ...r }; delete c.dst; delete c.plan; return c; };
async function callTool(name, args = {}) {
  if (name === "models_settings") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => !["action", "expectedRevision", "patch"].includes(k))) throw Error("invalid settings arguments");
    const action = args.action || "status";
    if (action === "apply") return lib.applySettings(args);
    if (!["status", "panel"].includes(action) || args.patch !== undefined || args.expectedRevision !== undefined) throw Error("invalid settings action");
    const state = await lib.settingsStatus();
    if (action === "panel") return { ...state, artifactPath: panel.artifact(state), artifactNote: "Fallback HTML is a draft editor only. Use the native MCP Apps panel for direct saving, or copy the generated instruction to the original chat." };
    return state;
  }
  if (name === "models_effort") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => !["action", "scope", "level", "model"].includes(k)))
      throw new Error("invalid effort arguments");
    const action = args.action || "status";
    if (action === "status") {
      if (args.level !== undefined || args.scope !== undefined) throw new Error("status accepts only an optional model");
      return lib.effortStatus({ model: args.model });
    }
    return lib.setEffort({ ...args, action });
  }
  if (name === "models_status") return { ...lib.status(), lastSync: clean(status) };
  if (name === "models_switch") {
    if (!["official", "third-party", "default"].includes(args.mode)) throw new Error("mode must be official, third-party or default");
    status = await lib.setSwitch(args.mode === "default" ? "" : args.mode).catch(errOut);
    return { ...clean(status), requiresModelReselection: true,
      note: "Before the next message, reselect the target in the model picker; if it appears unchanged, select Hy3 then the target. The host may retain a removed custom-local ID and report no endpoint until reselected. This tool cannot update the active selection. New sandboxes follow account defaults; this is not a runtime traffic check." };
  }
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
      if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion || "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "custom-api-models", version: VERSION } });
      else if (msg.method === "ping") reply({});
      else if (msg.method === "tools/list") reply({ tools: TOOLS });
      else if (msg.method === "resources/list") reply({ resources: [{ uri: panel.URI, name: "WorkBuddy 3P Settings", mimeType: panel.MIME }] });
      else if (msg.method === "resources/read") {
        if (msg.params?.uri !== panel.URI) throw Error("unknown resource");
        reply({ contents: [{ uri: panel.URI, mimeType: panel.MIME, text: panel.render(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] });
      }
      else if (msg.method === "tools/call") {
        const data = await callTool(msg.params?.name, msg.params?.arguments);
        reply({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], ...(msg.params?.name === "models_settings" ? { structuredContent: data, _meta: { ui: { resourceUri: panel.URI } } } : {}) });
      }
      else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    } catch (e) { reply({ isError: true, content: [{ type: "text", text: String(e.message || e) }] }); }
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { chain = chain.then(() => handle(d)); });
process.stdin.on("end", () => { chain.then(() => ready).then(() => process.exit(0)); });
