"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const script = path.join(root, "plugins/custom-api-models/scripts/sync-models.cjs");
const official = require("../plugins/custom-api-models/presets/workbuddy-official.json");
function fixture(t, original = { models: [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-official-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, CODEBUDDY_CONFIG_DIR: dir };
  for (const k of Object.keys(env)) if (/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)) delete env[k];
  env.WB3P_PARAMETER_PRIORITY = "native";
  const file = name => path.join(dir, name);
  const put = (name, v) => fs.writeFileSync(file(name), typeof v === "string" ? v : JSON.stringify(v));
  const get = name => JSON.parse(fs.readFileSync(file(name), "utf8"));
  put("models.json", original);
  put("workbuddy-3p.json", { mode: "explicit", providers: { p: { baseUrl: "https://test.invalid/v1", apiKey: "fake-catalog-canary" } }, routes: { "glm-5.1": "glm-5.1", "future-official-id": "other-upstream" } });
  let entry = script;
  const raw = (...args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8" });
  const code = source => spawnSync(process.execPath, ["-e", source], { env, encoding: "utf8" });
  const run = (...args) => { const r = raw(...args); assert.equal(r.status, 0, r.stderr); assert.ok(!r.stdout.includes("fake-catalog-canary")); return JSON.parse(r.stdout); };
  return { file, put, get, raw, run, original, code, useScript: p => { entry = p; } };
}

test("official catalog explicitly clears stale custom slots without losing ownership", t => {
  const original = { models: [{ id: "foreign", url: "https://user.invalid/v1", apiKey: "fake-user-canary" }], unrelated: true };
  const f = fixture(t, original); f.run();
  const ino = fs.statSync(f.file("models.json")).ino;
  const result = f.run("--official"), out = f.get("models.json");
  assert.ok(Array.isArray(out.availableModels), "official catalog must be explicit, not a deleted field");
  const state = f.get("workbuddy-3p.state.json");
  assert.equal(result.active, false); assert.equal(result.officialCatalogFallback, true);
  assert.deepEqual(out.models, original.models); assert.equal(out.unrelated, true);
  for (const id of [...official.keepOfficial, ...official.routable, "future-official-id", "custom-local:foreign"]) assert.ok(out.availableModels.includes(id), id);
  assert.ok(!out.availableModels.includes("custom-local:glm-5.1"));
  assert.ok(!out.availableModels.includes("custom-local:other-upstream"));
  assert.deepEqual(out.workbuddy3pManaged.ids, []);
  assert.deepEqual(state.managed, []); assert.deepEqual(state.providers, {});
  assert.equal(state.hadAllowlist, false); assert.equal(state.officialCatalogFallback, true);
  assert.deepEqual([...state.allow].sort(), [...out.availableModels].sort());
  assert.equal(fs.statSync(f.file("models.json")).ino, ino);
  const status = f.run("--status"); assert.equal(status.managedModels, 0); assert.equal(status.runtimeVerified, false);
});

test("official catalog cycles and uninstall restore original absence of allowlist", t => {
  const f = fixture(t), original = f.get("models.json"); f.run();
  for (let i = 0; i < 3; i++) {
    f.run("--official");
    const before = fs.readFileSync(f.file("models.json"), "utf8");
    assert.equal(f.run("--official").changed, false);
    assert.equal(fs.readFileSync(f.file("models.json"), "utf8"), before);
    f.run("--third-party"); assert.equal(f.get("workbuddy-3p.state.json").hadAllowlist, false);
  }
  f.run("--official"); f.run("--uninstall");
  assert.deepEqual(f.get("models.json"), original);
  assert.equal(fs.existsSync(f.file("workbuddy-3p.state.json")), false);
});

for (const availableModels of [[], ["glm-5.1", "future-official-id"]]) test(`official catalog preserves user allowlist ${JSON.stringify(availableModels)}`, t => {
  const original = { models: [], availableModels }, f = fixture(t, original);
  f.run(); f.run("--official"); assert.deepEqual(f.get("models.json"), original);
  assert.equal(fs.existsSync(f.file("workbuddy-3p.state.json")), false);
});

test("official catalog cleanup conservatively preserves the entire externally edited allowlist", t => {
  const f = fixture(t); f.run(); f.run("--official");
  const out = f.get("models.json"); out.availableModels.push("foreign-added-id");
  out.models.push({ id: "foreign-added-model", url: "https://user.invalid" }); f.put("models.json", out);
  const edited = fs.readFileSync(f.file("models.json"), "utf8");
  assert.notEqual(f.raw("--third-party").status, 0);
  assert.equal(fs.readFileSync(f.file("models.json"), "utf8"), edited);
  assert.ok(f.run("--uninstall").catalogWarning);
  assert.deepEqual(f.get("models.json"), { models: [{ id: "foreign-added-model", url: "https://user.invalid" }], availableModels: out.availableModels });
});

test("official catalog marker refuses missing ownership state", t => {
  const f = fixture(t); f.run(); f.run("--official");
  const before = fs.readFileSync(f.file("models.json"), "utf8"); fs.unlinkSync(f.file("workbuddy-3p.state.json"));
  assert.notEqual(f.raw("--uninstall").status, 0); assert.notEqual(f.raw("--official").status, 0);
  assert.equal(fs.readFileSync(f.file("models.json"), "utf8"), before);
});

test("official catalog rejects malformed fallback ownership without changing files", t => {
  const f = fixture(t); f.run(); f.run("--official");
  const s = f.get("workbuddy-3p.state.json"); s.officialCatalogFallback = "true"; f.put("workbuddy-3p.state.json", s);
  const before = fs.readFileSync(f.file("models.json"), "utf8");
  assert.notEqual(f.raw("--uninstall").status, 0); assert.equal(fs.readFileSync(f.file("models.json"), "utf8"), before);
});

test("official catalog escape hatch works with broken provider config and holds no credentials", t => {
  const f = fixture(t); f.run(); f.put("workbuddy-3p.json", "BROKEN"); f.run("--official");
  assert.deepEqual(f.get("workbuddy-3p.state.json").providers, {});
  assert.ok(!fs.readFileSync(f.file("workbuddy-3p.state.json"), "utf8").includes("fake-catalog-canary"));
  f.run("--official"); f.run("--uninstall"); assert.deepEqual(f.get("models.json"), { models: [] });
});

for (const [name, edit] of [["reordered", list => list.reverse()], ["partially deleted", list => list.slice(1)]]) test(`externally ${name} official list survives cleanup verbatim`, t => {
  const f = fixture(t); f.run(); f.run("--official");
  const out = f.get("models.json"); out.availableModels = edit(out.availableModels); f.put("models.json", out);
  assert.notEqual(f.raw("--third-party").status, 0);
  f.run("--uninstall"); assert.deepEqual(f.get("models.json"), { models: [], availableModels: out.availableModels });
});

for (const allowlist of [undefined, ["glm-5.1"]]) test(`restored same-ID user model conflict is reported (${allowlist === undefined ? "fallback" : "user list"})`, t => {
  const user = { id: "glm-5.1", url: "https://user.invalid/v1", apiKey: "fake-user-conflict" };
  const original = { models: [user], ...(allowlist ? { availableModels: allowlist } : {}) }, f = fixture(t, original);
  f.run(); const r = f.run("--official"); assert.deepEqual(f.get("models.json").models, [user]);
  assert.deepEqual(r.officialCatalogConflicts, ["glm-5.1"]); assert.equal(r.runtimeVerified, false);
  assert.match(r.catalogWarning, /shadow/);
});

function clonePackage(f, preset) {
  const dest = f.file("isolated-package"); fs.cpSync(path.join(root, "plugins/custom-api-models"), dest, { recursive: true });
  const file = path.join(dest, "presets/workbuddy-official.json");
  if (preset === null) fs.unlinkSync(file); else fs.writeFileSync(file, typeof preset === "string" ? preset : JSON.stringify(preset));
  f.useScript(path.join(dest, "scripts/sync-models.cjs"));
}

for (const preset of [null, "BROKEN", { keepOfficial: [], routable: [] }, { keepOfficial: [3], routable: [] }]) test(`unavailable bundled official catalog never writes an empty deny-all (${JSON.stringify(preset)})`, t => {
  const f = fixture(t); f.run(); clonePackage(f, preset);
  const r = f.run("--official"); assert.equal(r.active, false); assert.equal(r.fallbackUnavailable, true);
  assert.equal(r.requiresHostRefresh, true); assert.equal(r.runtimeVerified, false);
  assert.deepEqual(f.get("models.json"), { models: [] }); assert.equal(fs.existsSync(f.file("workbuddy-3p.state.json")), false);
});

test("preset drift never changes historical synthetic catalog cleanup ownership", t => {
  const f = fixture(t); f.run(); f.run("--official");
  clonePackage(f, { keepOfficial: ["new-native-id"], routable: ["new-native-route"] });
  f.run("--uninstall"); assert.deepEqual(f.get("models.json"), { models: [] });
});

test("pure official sandbox without prior plugin routes is not given a synthetic catalog", t => {
  const f = fixture(t); assert.equal(f.run("--official").changed, false);
  assert.deepEqual(f.get("models.json"), { models: [] }); assert.equal(fs.existsSync(f.file("workbuddy-3p.state.json")), false);
});

test("official state-write failure rolls back the generated catalog and switch", t => {
  const f = fixture(t); f.run(); const before = fs.readFileSync(f.file("models.json"), "utf8"), state = fs.readFileSync(f.file("workbuddy-3p.state.json"), "utf8");
  const r = f.code(`const fs=require('fs'), rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===${JSON.stringify(f.file("workbuddy-3p.state.json"))})throw Error('forced state failure');return rename(a,b)};require(${JSON.stringify(script)}).setSwitch('official').then(()=>process.exit(2),()=>console.log('rejected'));`);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), "rejected");
  assert.equal(fs.readFileSync(f.file("models.json"), "utf8"), before); assert.equal(fs.readFileSync(f.file("workbuddy-3p.state.json"), "utf8"), state);
  assert.equal(fs.existsSync(f.file("workbuddy-3p.switch")), false);
});

test("external models edit during asynchronous planning is rejected, never rolled back over", t => {
  const f = fixture(t); f.run(); const cfg = f.get("workbuddy-3p.json"); delete cfg.providers.p.apiKey;
  cfg.providers.p.apiKeyUrl = "https://credential.invalid/private"; f.put("workbuddy-3p.json", cfg);
  const edited = f.get("models.json"); edited.foreignConcurrentChange = true;
  const r = f.code(`const fs=require('fs');global.fetch=async()=>{fs.writeFileSync(${JSON.stringify(f.file("models.json"))},${JSON.stringify(JSON.stringify(edited))});return{ok:true,json:async()=>({apiKey:'fake-new-canary'})}};require(${JSON.stringify(script)}).sync().then(()=>process.exit(2),e=>console.log(e.message));`);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /changed before routing commit/);
  assert.deepEqual(f.get("models.json"), edited);
});
