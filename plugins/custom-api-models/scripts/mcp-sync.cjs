#!/usr/bin/env node
// Minimal stdio MCP server. Starting it writes models.json before the CLI marks the server connected;
// the MCP status change makes the CLI reload models, so a fresh sandbox picks up the routes.
"use strict";
const lib = require("./sync-models.cjs");
const panel = require("./settings-panel.cjs");
const VERSION = "3.0.0";
const errOut = (e) => ({ ok: false, error: String(e && e.message || e) });
let status = { ok: false, reason: "pending" };
const ready = lib.sync().catch(errOut).then(s => { status = s; });
// Independent MCP sessions share the cloud-host daemon. EOF ends only this
// lease, not other sessions' streams. Requests/other MCP leases keep it alive.
let maintenance = false;
const heartbeat = setInterval(async () => {
  if (maintenance) return; maintenance = true;
  try { const result = await lib.maintainRuntime(); if (result) status = result; }
  catch (e) { status = errOut(e); }
  finally { maintenance = false; }
}, 45000);
heartbeat.unref();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const noArgs = { type: "object", properties: {} };
const TOOLS = [
  { name: "models_settings", description: "Open the two-layer WorkBuddy 3P settings panel: providers/imported model capabilities, then explicit model routing and per-route effort. Only OpenAI-compatible Chat Completions APIs; no protocol conversion. New configurations have empty routes and no provider or maximum-effort preset. Save scope defaults to account through authorized private WorkBuddy assets; connect/finish-connect authorize the owner, and session overrides require explicit scope=session. Provider discovery and a billable model probe are explicit operations. Apply needs a fresh revision and private backups. Only accountCommitted after ready/readback proves saving, not live model traffic; pending/unknown publication must not be retried automatically. Env/file keys are resolved privately for portable account defaults and never accepted/returned through the panel. Context metadata cannot expand provider capacity. 3p priority enforces declared parameters on this cloud plugin host; native priority preserves host parameters. Host refresh/model reselection may be required. Without MCP Apps the HTML is a draft; use /models-settings wizard.",
    _meta: { ui: { resourceUri: panel.URI } },
    inputSchema: { type: "object", additionalProperties: false, properties: {
      action: { type: "string", enum: ["status", "panel", "apply", "discover", "probe", "connect", "finish-connect"], default: "status" },
      scope: { enum: ["account", "session"], default: "account" },
      confirmedConfirmationTypes: { type: "array", items: {type:"string"} },
      providerId: { type: "string" }, model: { type: "string" }, allowBillable: { type: "boolean" },
      expectedRevision: { type: "string" }, patch: { type: "object", additionalProperties: false,
        properties: { switchMode: { enum: ["official", "third-party", "default"] },
          parameterPriority: { enum: ["3p", "native"] },
          effortDefault: { type: ["string", "null"] },
          efforts: { type: "object", additionalProperties: { type: ["string", "null"] } },
          contexts: { type: "object", additionalProperties: { type: ["integer", "null"] } },
          providers: { type: "object" }, routes: { type: "object", additionalProperties: { type: ["string", "object", "null"] } },
          defaultProvider: { type: "string" }, routingMode: { enum: ["same-name", "preset-only", "explicit"] } } }
    } } },
  { name: "models_effort", description: "Inspect or change declared third-party model-default effort. Saving defaults to account; use saveScope=session only for an explicit local override. No maximum-effort preset. Route-specific effort wins over model defaults. A default skips unsupported models; a specific target rejects unsupported levels. Official mode defers third-party preferences. Requires account authorization and fresh settings state; ready/readback is not real traffic proof. In 3p priority this cloud plugin enforces declared parameters, native preserves host parameters.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      action: { type: "string", enum: ["status", "set", "reset"], default: "status" },
      scope: { type: "string", enum: ["default", "model", "all"], description: "Set default or one model; all is reset-only." },
      saveScope: { enum: ["account", "session"], default: "account" },
      level: { type: "string", enum: ["on", "off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      model: { type: "string", description: "provider:upstream-model from status, or an unambiguous upstream id/official alias" }
    } } },
  { name: "models_status", description: "Show configured mode, models.json routing state and errors. This is disk configuration only, not proof of live request routing (runtimeVerified=false). Unknown state is not off. Never shows keys.", inputSchema: noArgs },
  { name: "models_switch", description: "Switch official/third-party mode, saving to account by default. Explicit scope=session is a local override, never a silent fallback. Account authorization is required. Use a non-routed official model during switching, then refresh/reselect; the tool cannot change active selection. Report incomplete local sync or catalog conflicts; ready/readback is not traffic proof.",
    inputSchema: { type: "object", additionalProperties:false, properties: { mode: { type: "string", enum: ["official", "third-party", "default"] },scope:{enum:["account","session"],default:"account"} }, required: ["mode"] } },
  { name: "models_resync", description: "Re-read the workbuddy-3p config and rewrite ~/.codebuddy/models.json", inputSchema: noArgs },
  { name: "models_doctor", description: "In third-party mode send one billable tiny request per configured model; report HTTP status only, not runtime routing proof. Skip all requests in official mode.", inputSchema: noArgs },
];
const clean = (r) => { if (!r || typeof r !== "object") return r; const c = { ...r }; delete c.dst; delete c.plan; return c; };
async function callTool(name, args = {}) {
  if (name === "models_settings") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => !["action", "scope", "confirmedConfirmationTypes", "expectedRevision", "patch", "providerId", "model", "allowBillable"].includes(k))) throw Error("invalid settings arguments");
    const action = args.action || "status";
    if (["connect","finish-connect"].includes(action)) {if(Object.keys(args).some(k=>k!=="action"))throw Error("invalid account login arguments");return lib.accountLogin(action);}
    if (["discover", "probe"].includes(action)) return lib.providerRequest(args);
    if (args.providerId !== undefined || args.model !== undefined || args.allowBillable !== undefined) throw Error("invalid settings arguments");
    if (action === "apply") return lib.applySettings(args);
    if (!["status", "panel"].includes(action) || args.patch !== undefined || args.expectedRevision !== undefined) throw Error("invalid settings action");
    const state = await lib.settingsStatus();
    if (action === "panel") return { ...state, artifactPath: panel.artifact(state), artifactNote: "Fallback HTML is a draft editor only. Use the native MCP Apps panel for direct saving, or copy the generated instruction to the original chat." };
    return state;
  }
  if (name === "models_effort") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => !["action", "scope", "saveScope", "level", "model"].includes(k)))
      throw new Error("invalid effort arguments");
    const action = args.action || "status";
    if (action === "status") {
      if (args.level !== undefined || args.scope !== undefined || args.saveScope!==undefined) throw new Error("status accepts only an optional model");
      return lib.effortStatus({ model: args.model });
    }
    const targetScope=args.scope||(args.model?"model":"default"),saveScope=args.saveScope||"account";
    if(!["set","reset"].includes(action)||!["model","default","all"].includes(targetScope)||!["account","session"].includes(saveScope)||action==="set"&&targetScope==="all"||action==="reset"&&args.level!==undefined||targetScope!=="model"&&args.model!==undefined||action==="set"&&!["on","off","minimal","low","medium","high","xhigh","max"].includes(args.level))throw Error("invalid effort action/scope combination");
    const s=await lib.settingsStatus(),e=await lib.effortStatus(args.model?{model:args.model}:{}),patch={};
    if(targetScope==="model"){
      if(!args.model||e.models.length!==1)throw Error("an unambiguous model is required");
      patch.efforts={[e.models[0].target]:action==="reset"?null:args.level};
    }else{patch.effortDefault=action==="reset"?null:args.level;if(targetScope==="all")patch.efforts=Object.fromEntries([...new Set([...Object.keys(e.preferences.local.models||{}),...Object.keys(e.preferences.config.models||{})])].map(k=>[k,null]));}
    const result=await lib.applySettings({action:"apply",scope:saveScope,expectedRevision:s.revision,patch});
    if(!result.committed)return result;
    return {...await lib.effortStatus(args.model?{model:args.model}:{}),...Object.fromEntries(Object.entries(result).filter(([k])=>!["models","providers","routes"].includes(k)))};
  }
  if (name === "models_status") return { ...lib.status(), lastSync: clean(status) };
  if (name === "models_switch") {
    if(!args||typeof args!=="object"||Object.keys(args).some(k=>!["mode","scope"].includes(k)))throw Error("invalid switch arguments");
    if (!["official", "third-party", "default"].includes(args.mode)) throw new Error("mode must be official, third-party or default");
    const s=await lib.settingsStatus();
    status=await lib.applySettings({action:"apply",scope:args.scope||"account",expectedRevision:s.revision,patch:{switchMode:args.mode}});
    return { ...lib.status(),...clean(status), requiresModelReselection: true,
        note: "Before the next message, use a non-routed official model (for example Hy4 preview), then reselect the target after the host reloads. Some hosts retain a removed custom-local ID; page reload alone is not proof of rebinding. Report any catalog warning or user-model conflict. This tool cannot update the active selection. New sandboxes follow account defaults; this is not a runtime traffic check." };
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
process.stdin.on("end", () => { chain.then(() => ready).then(() => { clearInterval(heartbeat); process.exit(0); }); });
