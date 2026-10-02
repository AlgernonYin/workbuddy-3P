"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const script = path.resolve(__dirname, "../plugins/custom-api-models/scripts/sync-models.cjs");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-safety-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, CODEBUDDY_CONFIG_DIR: dir };
  for (const k of Object.keys(env)) if (/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)) delete env[k];
  const file = name => path.join(dir, name);
  const cfg = { mode: "explicit", providers: { p: { baseUrl: "https://test.invalid/v1", apiKey: "fake-only-canary" } }, routes: { "glm-5.3": "first" } };
  const put = (name, v) => fs.writeFileSync(file(name), typeof v === "string" ? v : JSON.stringify(v));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  const code = s => spawnSync(process.execPath, ["-e", s], { env, encoding: "utf8" });
  put("workbuddy-3p.json", cfg);
  return { dir, env, file, cfg, put, run, code };
}
function ok(r) { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); }

test("bad config preserves last-good routing but explicit official always bypasses provider config", t => {
  const f = fixture(t); ok(f.run());
  const before = fs.readFileSync(f.file("models.json"), "utf8");
  f.put("workbuddy-3p.json", '{"apiKey":"fake-only-canary",BROKEN');
  const bad = f.run(); assert.notEqual(bad.status, 0); assert.ok(!bad.stderr.includes("fake-only-canary"));
  assert.equal(fs.readFileSync(f.file("models.json"), "utf8"), before);
  const status = ok(f.run("--status"));
  assert.equal(status.ok, false); assert.equal(status.modelsJsonActive, true); assert.equal(status.runtimeVerified, false);
  assert.equal(ok(f.run("--official")).active, false);
  assert.equal(ok(f.run("--status")).configuredMode, "official");
  assert.equal(JSON.parse(fs.readFileSync(f.file("models.json"))).models.length, 0);
});

for (const bad of ["missing", "null", "{}", '{"managed":[],"allow":[],"hidden":42}']) {
  test(`ownership state ${bad} yields unknown, never a false off report`, t => {
    const f = fixture(t); ok(f.run());
    const before = fs.readFileSync(f.file("models.json"), "utf8");
    if (bad === "missing") fs.unlinkSync(f.file("workbuddy-3p.state.json")); else f.put("workbuddy-3p.state.json", bad);
    const status = ok(f.run("--status")); assert.equal(status.ok, false); assert.equal(status.active, null); assert.equal(status.managedModels, null);
    assert.notEqual(f.run("--official").status, 0); assert.notEqual(f.run("--uninstall").status, 0);
    assert.equal(fs.readFileSync(f.file("models.json"), "utf8"), before);
    assert.equal(fs.existsSync(f.file("workbuddy-3p.switch")), false);
  });
}

test("config JSON null is an error rather than silently absent", t => {
  const f = fixture(t); f.put("workbuddy-3p.json", "null");
  assert.notEqual(f.run().status, 0); assert.equal(fs.existsSync(f.file("models.json")), false);
});

test("official doctor neither reads broken provider config nor sends third-party requests", t => {
  const f = fixture(t); f.put("workbuddy-3p.switch", "official\n"); f.put("workbuddy-3p.json", "BROKEN");
  const r = f.code(`global.fetch=()=>{throw new Error('NETWORK_MUST_NOT_RUN')};require(${JSON.stringify(script)}).doctor().then(r=>console.log(JSON.stringify(r)))`);
  assert.equal(ok(r).skipped, true);
});

test("invalid extraModels and route object fields are rejected before writes", t => {
  const f = fixture(t);
  for (const edit of [c => c.providers.p.extraModels = [null], c => c.providers.p.extraModels = [""], c => c.routes["glm-5.3"] = { model: 12 }, c => c.routes["glm-5.3"] = { provider: [] }]) {
    const c = structuredClone(f.cfg); edit(c); f.put("workbuddy-3p.json", c);
    assert.notEqual(f.run().status, 0); assert.equal(fs.existsSync(f.file("models.json")), false);
  }
});

test("secret URL and models JSON fragments never appear in errors or summaries", t => {
  const f = fixture(t), secret = "PRIVATE_CANARY_987654";
  for (const base of [`https://u:${secret}@test.invalid/v1`, `https://test.invalid/v1?key=${secret}`, `https://test.invalid/v1#${secret}`]) {
    f.cfg.providers.p.baseUrl = base; f.put("workbuddy-3p.json", f.cfg);
    const r = f.run(); assert.notEqual(r.status, 0); assert.ok(!(r.stdout + r.stderr).includes(secret));
  }
  f.cfg.providers.p.baseUrl = `https://test.invalid/${secret}/v1`; f.put("workbuddy-3p.json", f.cfg);
  const summary = ok(f.run()); assert.equal(summary.providers[0].host, "test.invalid"); assert.ok(!JSON.stringify(summary).includes(secret));
  f.put("models.json", `{"apiKey":"${secret}",BROKEN`);
  for (const arg of ["--status", "--uninstall", "--official"]) {
    const r = f.run(arg); assert.ok(!(r.stdout + r.stderr).includes(secret));
  }
});

test("non-HTTPS credential URLs are not quoted in errors", t => {
  const f = fixture(t); delete f.cfg.providers.p.apiKey;
  f.cfg.providers.p.apiKeyUrl = "http://test.invalid/PRIVATE_CANARY_987654"; f.put("workbuddy-3p.json", f.cfg);
  const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /must use https/); assert.ok(!r.stderr.includes("PRIVATE_CANARY"));
});

test("concurrent in-process switches serialize without blocking each other", t => {
  const f = fixture(t); ok(f.run());
  const r = f.code(`const lib=require(${JSON.stringify(script)}); Promise.all([lib.setSwitch('official'),lib.setSwitch('third-party')]).then(()=>console.log(JSON.stringify(lib.status()))).catch(e=>{console.error(e.message);process.exitCode=1})`);
  const s = ok(r); assert.equal(s.configuredMode, "third-party"); assert.equal(s.modelsJsonActive, true);
  assert.equal(fs.existsSync(f.file("workbuddy-3p.lock")), false);
});

test("ordinary state-write failure restores both prior routing and prior switch", t => {
  const f = fixture(t); ok(f.run("--official"));
  const r = f.code(`const fs=require('fs'),lib=require(${JSON.stringify(script)});const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b.endsWith('workbuddy-3p.state.json'))throw new Error('injected');return rename(a,b)};lib.setSwitch('third-party').then(()=>{throw new Error('expected failure')}).catch(e=>console.log(JSON.stringify({error:e.message,status:lib.status()})))`);
  const result = ok(r); assert.match(result.error, /previous routing restored/);
  assert.equal(result.status.configuredMode, "official"); assert.equal(result.status.active, false);
  assert.equal(fs.existsSync(f.file("models.json")), false);
  assert.equal(fs.readdirSync(f.dir).some(n => n.includes(".tmp-")), false);
});

test("an old lock owned by a live process is never stolen", async t => {
  const f = fixture(t), lock = f.file("workbuddy-3p.lock");
  fs.writeFileSync(lock, String(process.pid)); const old = new Date(Date.now() - 120000); fs.utimesSync(lock, old, old);
  const child = spawn(process.execPath, [script], { env: f.env, stdio: "ignore" });
  t.after(() => child.kill());
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(child.exitCode, null); assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
  assert.equal(fs.existsSync(f.file("models.json")), false);
  child.kill(); await new Promise(resolve => child.once("exit", resolve));
});

test("stdio MCP exposes truthful disk status and switching/doctor behavior", t => {
  const f = fixture(t);
  const calls = [
    { id: 1, method: "initialize", params: {} },
    { id: 2, method: "tools/call", params: { name: "models_switch", arguments: { mode: "official" } } },
    { id: 3, method: "tools/call", params: { name: "models_doctor", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "models_status", arguments: {} } },
    { id: 5, method: "tools/call", params: { name: "models_switch", arguments: { mode: "third-party" } } },
    { id: 6, method: "tools/call", params: { name: "models_status", arguments: {} } },
  ];
  const r = spawnSync(process.execPath, [path.join(path.dirname(script), "mcp-sync.cjs")], {
    env: f.env, encoding: "utf8", input: calls.map(x => JSON.stringify({ jsonrpc: "2.0", ...x })).join("\n") + "\n",
  });
  assert.equal(r.status, 0, r.stderr); assert.ok(!r.stdout.includes("fake-only-canary"));
  const replies = r.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies[0].result.serverInfo.version, "2.4.0");
  const result = id => JSON.parse(replies.find(r => r.id === id).result.content[0].text);
  assert.equal(result(2).active, false); assert.equal(result(3).skipped, true);
  assert.equal(result(2).requiresModelReselection, true); assert.match(result(2).note, /before|Before/);
  assert.equal(result(4).runtimeVerified, false); assert.equal(result(4).modelsJsonActive, false);
  assert.equal(result(5).active, true); assert.equal(result(6).modelsJsonActive, true);
});
