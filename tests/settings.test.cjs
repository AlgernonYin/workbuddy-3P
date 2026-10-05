"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const script = path.resolve(__dirname, "../plugins/custom-api-models/scripts/sync-models.cjs");
const canary = "FAKE_SETTINGS_SECRET_ONLY";
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, CODEBUDDY_CONFIG_DIR: dir };
  for (const k of Object.keys(env)) if (/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)) delete env[k];
  env.WB3P_PARAMETER_PRIORITY = "native";
  const cfg = { mode: "explicit", providers: { p: { baseUrl: "http://127.0.0.1:9/v1", apiKey: canary,
    extraModels: ["a", "b", "toggle", "fixed"], models: {
      a: { maxInputTokens: 128000, supportsReasoning: true, onlyReasoning: false,
        reasoning: { supportedEfforts: ["low", "medium", "xhigh"], defaultEffort: "medium", canDisableThinking: true },
        thinkingLevelMap: { off: "none", low: "low", medium: "medium", xhigh: "xhigh" }, compat: { thinkingFormat: "qwen", supportsReasoningEffort: true } },
      b: { maxInputTokens: 64000, supportsReasoning: true, onlyReasoning: true,
        reasoning: { supportedEfforts: ["low", "high", "max"], defaultEffort: "high" },
        thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" } },
      toggle: { maxInputTokens: 64000, supportsReasoning: true, onlyReasoning: false,
        reasoning: { supportedEfforts: [], defaultEffort: "high", canDisableThinking: true },
        compat: { thinkingFormat: "qwen", supportsReasoningEffort: false }, thinkingLevelMap: { off: "none", high: "high" } },
      fixed: { supportsReasoning: true, onlyReasoning: true, compat: { supportsReasoningEffort: false }, reasoning: { supportedEfforts: [] } }
    } } }, ...extra };
  fs.writeFileSync(path.join(dir, "workbuddy-3p.json"), JSON.stringify(cfg));
  const invoke = expr => {
    // Each spawn is a new MCP/API lifetime. Issue literal fixture revisions in
    // that lifetime; stale-token tests explicitly retain a variable in-process.
    const code = expr.replace(/"expectedRevision":"[a-f0-9]{64}"/g, '"expectedRevision":__testRevision');
    const token = code.includes("__testRevision") ? "const __testRevision=(await lib.settingsStatus()).revision;" : "";
    const r = spawnSync(process.execPath, ["-e", `const lib=require(${JSON.stringify(script)});(async()=>{${token}${code}})().catch(e=>{console.error(e.message);process.exitCode=1})`], { env, encoding: "utf8" });
    assert.ok(!(r.stdout + r.stderr).includes(canary), "secret leaked in response"); return r;
  };
  const ok = expr => { const r = invoke(expr); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const status = () => ok("console.log(JSON.stringify(await lib.settingsStatus()))");
  const apply = (patch, revision = status().revision) => ok(`console.log(JSON.stringify(await lib.applySettings(${JSON.stringify({ action: "apply", scope: "session", expectedRevision: revision, patch })})))`);
  const snap = () => ["workbuddy-3p.json", "workbuddy-3p.effort.json", "workbuddy-3p.context.json", "workbuddy-3p.switch", "models.json", "workbuddy-3p.state.json"]
    .map(n => fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), "utf8") : null);
  ok("console.log(JSON.stringify(await lib.sync()))");
  return { dir, env, invoke, ok, read, status, apply, snap };
}
test("settings status is secret-free and read-only; context capacities and toggles are per model", t => {
  const f = fixture(t), before = f.snap(), state = f.status();
  assert.deepEqual(f.snap(), before); assert.equal(state.runtimeVerified, false);
  assert.equal(state.models.find(m => m.id === "a").baseInputTokens, 128000);
  assert.equal(state.models.find(m => m.id === "toggle").canDisableThinking, true);
  assert.deepEqual(state.models.find(m => m.id === "toggle").supportedEfforts, []);
  assert.deepEqual(state.providers[0].credential, { configured: true, kind: "inline" });
});
test("highest per model, bounded contexts and backups are committed together without changing user models", t => {
  const f = fixture(t), file = path.join(f.dir, "models.json"), inode = fs.statSync(file).ino;
  const out = f.read("models.json"); out.models.push({ id: "user-owned", name: "Mine" }); fs.writeFileSync(file, JSON.stringify(out));
  const state = f.apply({ maxEffort: true, contexts: { "p:a": 32000 } });
  const models = f.read("models.json").models;
  assert.equal(models.find(m => m.id === "a").reasoning.defaultEffort, "xhigh");
  assert.equal(models.find(m => m.id === "b").reasoning.defaultEffort, "max");
  assert.equal(models.find(m => m.id === "toggle").reasoning.defaultEffort, "high");
  assert.ok(models.some(m => m.id === "user-owned")); assert.equal(models.find(m => m.id === "a").maxInputTokens, 32000);
  assert.equal(fs.statSync(file).ino, inode); assert.equal(state.requiresHostRefresh, true);
  assert.ok(fs.existsSync(path.join(state.backup, "manifest.json")));
  assert.equal(f.read("workbuddy-3p.effort.json").models["p:toggle"], "on");
  const reset = f.apply({ contexts: { "p:a": null }, efforts: { "p:a": null } });
  assert.equal(reset.models.find(m => m.id === "a").maxInputTokens, 128000);
  assert.equal(reset.models.find(m => m.id === "a").configuredEffort, "medium");
});
test("on/off switch-only models do not acquire fake effort support", t => {
  const f = fixture(t);
  f.apply({ efforts: { "p:toggle": "off", "p:a": "off" } });
  assert.equal(f.read("models.json").models.find(m => m.id === "toggle").reasoning.defaultEffort, "off");
  f.apply({ efforts: { "p:toggle": "on", "p:a": "on" } });
  assert.equal(f.read("models.json").models.find(m => m.id === "a").reasoning.defaultEffort, "medium", "thinking on preserves the imported default rather than selecting the maximum");
  assert.deepEqual(f.status().models.find(m => m.id === "toggle").supportedEfforts, []);
});
test("unsupported effort, oversized contexts, invalid fields and secrets are rejected before writes", t => {
  const f = fixture(t), before = f.snap();
  for (const patch of [{ efforts: { "p:a": "max" } }, { efforts: { "p:fixed": "off" } },
    { contexts: { "p:a": 1000000 } }, { contexts: { "p:a": "32000" } }, { contexts: { "p:a": 1 } },
    { providers: { p: { apiKey: "DO_NOT_ACCEPT_KEYS_IN_CHAT" } } }, { providers: { p: { extraModels: [null] } } },
    { routes: { a: {} } }, { typo: true }, { maxEffort: true, efforts: { "p:a": "low" } }]) {
    const r = f.invoke(`await lib.applySettings(${JSON.stringify({ action: "apply", scope: "session", expectedRevision: f.status().revision, patch })})`);
    assert.notEqual(r.status, 0); assert.deepEqual(f.snap(), before);
  }
});
test("stale panels cannot overwrite concurrent changes or a new model configuration", t => {
  const f = fixture(t);
  const r = f.invoke(`const fs=require('fs'),path=require('path');const s=await lib.settingsStatus();await lib.applySettings({action:'apply',scope:'session',expectedRevision:s.revision,patch:{efforts:{'p:a':'low'}}});const p=path.join(process.env.CODEBUDDY_CONFIG_DIR,'models.json'),before=fs.readFileSync(p,'utf8');try{await lib.applySettings({action:'apply',scope:'session',expectedRevision:s.revision,patch:{maxEffort:true}});throw Error('accepted stale')}catch(e){if(!e.message.includes('settings changed'))throw e}if(fs.readFileSync(p,'utf8')!==before)throw Error('stale write changed models');console.log('true')`);
  assert.equal(r.status, 0, r.stderr); assert.equal(f.read("workbuddy-3p.effort.json").models["p:a"], "low");
});
test("provider and route forms preserve credentials and unknown configuration, requiring endpoint consent", t => {
  const f = fixture(t, { myExtraField: "preserve" });
  f.apply({ providers: { p: { label: "New label" } }, routes: { "official-alias": "p:a" } });
  const cfg = f.read("workbuddy-3p.json"); assert.equal(cfg.myExtraField, "preserve"); assert.equal(cfg.providers.p.apiKey, canary);
  const before = f.snap(), revision = f.status().revision;
  const denied = f.invoke(`await lib.applySettings(${JSON.stringify({ action: "apply", scope: "session", expectedRevision: revision, patch: { providers: { p: { baseUrl: "https://other.invalid/v1" } } } })})`);
  assert.notEqual(denied.status, 0); assert.deepEqual(f.snap(), before);
  f.apply({ providers: { p: { baseUrl: "https://other.invalid/v1", reuseCredential: true } } });
  assert.equal(f.read("workbuddy-3p.json").providers.p.apiKey, canary);
});
test("official switch defers values, default clears switch and resumes third-party with stored settings", t => {
  const f = fixture(t);
  const official = f.apply({ switchMode: "official", maxEffort: true, contexts: { "p:a": 32000 } });
  assert.equal(official.deferred, true); assert.equal(f.read("models.json").models.length, 0);
  const restored = f.apply({ switchMode: "default" });
  assert.equal(restored.configuredMode, "third-party"); assert.equal(restored.deferred, false);
  assert.equal(fs.existsSync(path.join(f.dir, "workbuddy-3p.switch")), false);
  assert.equal(f.read("models.json").models.find(m => m.id === "a").maxInputTokens, 32000);
});
test("state write failure restores configuration and all settings without replacing models inode", t => {
  const f = fixture(t), before = f.snap(), revision = f.status().revision;
  const r = f.invoke(`const fs=require('fs');const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b.endsWith('workbuddy-3p.state.json'))throw Error('injected');return rename(a,b)};await lib.applySettings(${JSON.stringify({ action: "apply", scope: "session", expectedRevision: revision, patch: { contexts: { "p:a": 32000 }, maxEffort: true, providers: { p: { label: "Changed" } } } })})`);
  assert.notEqual(r.status, 0); assert.deepEqual(f.snap(), before); assert.equal(fs.existsSync(path.join(f.dir, "workbuddy-3p.lock")), false);
});
test("MCP Apps resource metadata and structured state use the real settings API", t => {
  const f = fixture(t);
  const messages = [{ id: 1, method: "initialize" }, { id: 2, method: "tools/list" },
    { id: 3, method: "resources/read", params: { uri: "ui://workbuddy-3p/settings" } },
    { id: 4, method: "tools/call", params: { name: "models_settings", arguments: { action: "status" } } }];
  const r = spawnSync(process.execPath, [path.join(path.dirname(script), "mcp-sync.cjs")], { env: f.env, encoding: "utf8",
    input: messages.map(m => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n" });
  assert.equal(r.status, 0, r.stderr); assert.ok(!r.stdout.includes(canary));
  const replies = r.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(replies[0].result.capabilities.resources);
  assert.equal(replies[1].result.tools.find(t => t.name === "models_settings")._meta.ui.resourceUri, "ui://workbuddy-3p/settings");
  assert.equal(replies[2].result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok(!replies[2].result.contents[0].text.includes("__WB3P_STATE__"));
  assert.equal(replies[3].result.structuredContent.models.length, 4);
});
test("editing a private profile preserves its envelope and never creates a credential-shadowing local config", t => {
  const f = fixture(t), cfg = f.read("workbuddy-3p.json");
  fs.unlinkSync(path.join(f.dir, "workbuddy-3p.json"));
  const skill = path.join(f.dir, "skills", "private-profile"); fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: workbuddy-3p-profile\n---\nPrivate.");
  const profile = path.join(skill, "workbuddy-3p.profile.json");
  fs.writeFileSync(profile, JSON.stringify({ kind: "workbuddy-3p-private-profile", version: 1, config: cfg, privateEnvelopeField: "preserve" }));
  const out = f.apply({ providers: { p: { label: "Edited privately" } } });
  assert.equal(out.sourceKind, "private-profile"); assert.equal(fs.existsSync(path.join(f.dir, "workbuddy-3p.json")), false);
  const raw = JSON.parse(fs.readFileSync(profile, "utf8")); assert.equal(raw.privateEnvelopeField, "preserve"); assert.equal(raw.config.providers.p.apiKey, canary);
});
test("effective environment switching is included in revision", t => {
  const f = fixture(t);
  const r = f.invoke("const before=await lib.settingsStatus();process.env.WB3P_ENABLED='official';const after=await lib.settingsStatus();if(before.revision===after.revision)throw Error('revision unchanged');try{await lib.applySettings({action:'apply',scope:'session',expectedRevision:before.revision,patch:{maxEffort:true}});throw Error('accepted stale')}catch(e){if(!e.message.includes('settings changed'))throw e}console.log('true')");
  assert.equal(r.status, 0, r.stderr);
});
test("a committed readback failure reports committed, not unapplied", t => {
  const f = fixture(t), revision = f.status().revision;
  const result = f.ok(`const fs=require('fs');let committed=false;const rename=fs.renameSync,read=fs.readFileSync;fs.renameSync=(a,b)=>{const result=rename(a,b);if(b.endsWith('workbuddy-3p.state.json'))committed=true;return result};fs.readFileSync=(p,...args)=>{if(committed&&String(p).endsWith('workbuddy-3p.context.json'))throw Error('injected readback');return read(p,...args)};console.log(JSON.stringify(await lib.applySettings(${JSON.stringify({ action: "apply", scope: "session", expectedRevision: revision, patch: { contexts: { "p:a": 32000 } } })})))`);
  assert.equal(result.committed, true); assert.equal(result.stateUnavailable, true);
  assert.equal(f.read("models.json").models.find(m => m.id === "a").maxInputTokens, 32000);
});
test("prepared plan drift rejects routing and does not roll back a concurrent external config edit", t => {
  const f = fixture(t), revision = f.status().revision, modelsBefore = fs.readFileSync(path.join(f.dir, "models.json"), "utf8");
  const r = f.invoke(`const fs=require('fs');const rename=fs.renameSync;fs.renameSync=(a,b)=>{const out=rename(a,b);if(b.endsWith('workbuddy-3p.context.json')){const p=process.env.CODEBUDDY_CONFIG_DIR+'/workbuddy-3p.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.externalConcurrentEdit=true;fs.writeFileSync(p,JSON.stringify(c));}return out};await lib.applySettings(${JSON.stringify({ action: "apply", scope: "session", expectedRevision: revision, patch: { providers: { p: { label: "Candidate" } }, contexts: { "p:a": 32000 } } })})`);
  assert.notEqual(r.status, 0); assert.equal(f.read("workbuddy-3p.json").externalConcurrentEdit, true);
  assert.equal(fs.readFileSync(path.join(f.dir, "models.json"), "utf8"), modelsBefore);
});
test("numeric contextWindow also bounds edits; null/object windows are not coerced to zero", () => {
  const c = require("../plugins/custom-api-models/scripts/context.cjs"), owner = new Map([["m", "p"]]);
  const edit = m => c.apply([m], owner, { version: 1, models: { "p:m": 32000 } });
  assert.throws(() => edit({ id: "m", maxInputTokens: 100000, contextWindow: 8192 }), /exceeds/);
  const m = { id: "m", maxInputTokens: 100000, contextWindow: null }; edit(m); assert.equal(m.contextWindow, null);
  const n = { id: "m", maxInputTokens: 100000, contextWindow: { supportedLengths: [100000] } }; edit(n); assert.deepEqual(n.contextWindow, { supportedLengths: [100000] });
});
test("revisions are stable within a server, random across restart, and reject a previous server token", t => {
  const f = fixture(t), old = f.status().revision, next = f.status().revision;
  assert.notEqual(old, next);
  const stable = f.invoke("const a=await lib.settingsStatus(),b=await lib.settingsStatus();if(a.revision!==b.revision)throw Error('unstable live revision');console.log('true')");
  assert.equal(stable.status, 0, stable.stderr);
  const invalid = f.invoke(`const old=${JSON.stringify(old)};await lib.applySettings({action:'apply',scope:'session',expectedRevision:old,patch:{maxEffort:true}})`);
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /settings changed/);
});
