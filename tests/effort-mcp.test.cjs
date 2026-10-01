"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const script = path.resolve(__dirname, "../plugins/custom-api-models/scripts/sync-models.cjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-effort-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, CODEBUDDY_CONFIG_DIR: dir };
  for (const k of Object.keys(env)) if (/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)) delete env[k];
  fs.writeFileSync(path.join(dir, "workbuddy-3p.json"), JSON.stringify({ mode: "explicit",
    providers: { p: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "FAKE_SECRET_CANARY_ONLY", extraModels: ["m"],
      models: { m: { supportsReasoning: true, compat: { supportsReasoningEffort: true },
        reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "high" } } } } } }));
  return { dir, env };
}

test("MCP effort tool lists capability, sets/resets defaults, and rejects bad arguments without secrets", t => {
  const f = fixture(t);
  const calls = [{ id: 1, method: "tools/list" },
    ...[{ action: "status" }, { action: "set", scope: "model", model: "p:m", level: "low" },
      { action: "set", model: "p:m", level: "max" }, { action: "status", scope: "default" },
      { action: "reset", scope: "all" }, { action: "status", unknown: true }]
      .map((args, i) => ({ id: i + 2, method: "tools/call", params: { name: "models_effort", arguments: args } }))];
  const p = spawnSync(process.execPath, [path.join(path.dirname(script), "mcp-sync.cjs")], { env: f.env,
    input: calls.map(c => JSON.stringify({ jsonrpc: "2.0", ...c })).join("\n") + "\n", encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  assert.ok(!(p.stdout + p.stderr).includes("FAKE_SECRET_CANARY_ONLY"));
  const replies = p.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(replies[0].result.tools.some(x => x.name === "models_effort"));
  const result = id => replies.find(r => r.id === id).result;
  const data = id => JSON.parse(result(id).content[0].text);
  assert.deepEqual(data(2).models[0].supportedEfforts, ["low", "high"]);
  assert.equal(data(2).runtimeVerified, false);
  assert.equal(data(3).models[0].configuredEffort, "low");
  assert.equal(data(3).requiresModelReselection, true);
  for (const id of [4, 5, 7]) assert.equal(result(id).isError, true);
  assert.equal(data(6).models[0].configuredEffort, "high");
  assert.equal(fs.existsSync(path.join(f.dir, "workbuddy-3p.effort.json")), false);
});

test("incomplete/conflicting CLI effort options never perform a broader mutation", t => {
  const f = fixture(t);
  const run = args => spawnSync(process.execPath, [script, ...args], { env: f.env, encoding: "utf8" });
  assert.equal(run(["--effort", "low"]).status, 0);
  const before = fs.readFileSync(path.join(f.dir, "workbuddy-3p.effort.json"), "utf8");
  const modelsBefore = fs.readFileSync(path.join(f.dir, "models.json"), "utf8");
  for (const args of [["--effort-reset", "--model"], ["--effort", "--model", "p:m"],
    ["--effort", "high", "--official"], ["--effort-status", "--effort", "high"],
    ["--effort-reset", "--all", "--model", "p:m"],
    ["--effort", "high", "--modle", "p:m"], ["--effort-reset", "--modle", "p:m"],
    ["--effort", "high", "p:m"], ["--effort", "high", "--model", "p:m", "--model", "p:m"],
    ["--effort", "high", "--effort", "low"], ["--effort-status", "--unknown"],
    ["--effort-status", "--effort-status"], ["--effort-reset", "--all", "--all"],
    ["--effort", "high", "--unknown", "--quiet"], ["--effort-status", "--all"]]) {
    assert.notEqual(run(args).status, 0);
    assert.equal(fs.readFileSync(path.join(f.dir, "workbuddy-3p.effort.json"), "utf8"), before);
    assert.equal(fs.readFileSync(path.join(f.dir, "models.json"), "utf8"), modelsBefore);
  }
  const quiet = run(["--effort", "high", "--model", "p:m", "--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "workbuddy-3p.effort.json"), "utf8")).models["p:m"], "high");
});

test("official override clearing stale managed routes still requires model reselection", t => {
  const f = fixture(t);
  const run = (args, env = f.env) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  assert.equal(run([]).status, 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.dir, "models.json"), "utf8")).models.length > 0);
  const env = { ...f.env, WB3P_ENABLED: "official" };
  const p = run(["--effort", "high"], env);
  assert.equal(p.status, 0, p.stderr);
  const r = JSON.parse(p.stdout);
  assert.equal(r.deferred, true);
  assert.equal(r.changed, true);
  assert.equal(r.requiresModelReselection, true);
  assert.match(r.note, /reselect the model/);
  const models = fs.existsSync(path.join(f.dir, "models.json")) ? JSON.parse(fs.readFileSync(path.join(f.dir, "models.json"), "utf8")).models : [];
  assert.equal(models.length, 0);
  const again = run(["--effort", "low"], env);
  assert.equal(again.status, 0, again.stderr);
  const unchanged = JSON.parse(again.stdout);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.requiresModelReselection, false);
  assert.doesNotMatch(unchanged.note, /reselect the model/);
});

test("a routing I/O failure rolls preferences and model defaults back together", t => {
  const f = fixture(t);
  const p = spawnSync(process.execPath, ["-e", `const fs=require('fs'),lib=require(${JSON.stringify(script)});
    (async()=>{await lib.setEffort({level:'low'}); const before=fs.readFileSync(process.env.CODEBUDDY_CONFIG_DIR+'/models.json','utf8');
    const rename=fs.renameSync; fs.renameSync=(a,b)=>{if(b.endsWith('workbuddy-3p.state.json'))throw Error('injected');return rename(a,b)};
    try{await lib.setEffort({level:'high'});throw Error('expected failure')}catch(e){if(!e.message.includes('previous routing restored'))throw e;}
    const pref=JSON.parse(fs.readFileSync(process.env.CODEBUDDY_CONFIG_DIR+'/workbuddy-3p.effort.json','utf8'));
    if(pref.default!=='low'||fs.readFileSync(process.env.CODEBUDDY_CONFIG_DIR+'/models.json','utf8')!==before)throw Error('rollback failed');
    console.log('ok')})().catch(e=>{console.error(e.message);process.exitCode=1})`], { env: f.env, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr); assert.equal(p.stdout.trim(), "ok");
});

test("official mode can save global deferred preferences even with missing/broken provider config", t => {
  const f = fixture(t);
  const run = args => spawnSync(process.execPath, [script, ...args], { env: f.env, encoding: "utf8" });
  assert.equal(run(["--official"]).status, 0);
  for (const broken of [null, "BROKEN"]) {
    const file = path.join(f.dir, "workbuddy-3p.json");
    if (broken === null) fs.unlinkSync(file); else fs.writeFileSync(file, broken);
    const p = run(["--effort", "high"]); assert.equal(p.status, 0, p.stderr);
    const r = JSON.parse(p.stdout); assert.equal(r.deferred, true); assert.ok(r.capabilityWarning);
    assert.equal(run(["--effort-status"]).status, 0);
    assert.equal(fs.existsSync(path.join(f.dir, "models.json")), false);
  }
});

test("post-commit diagnostic cleanup failure never rolls only preferences back", t => {
  const f = fixture(t);
  const p = spawnSync(process.execPath, ["-e", `const fs=require('fs'),lib=require(${JSON.stringify(script)});
    (async()=>{await lib.setEffort({level:'low'}); const rm=fs.rmSync;
    fs.rmSync=(p,o)=>{if(p.endsWith('workbuddy-3p.last-error.json'))throw Error('injected');return rm(p,o)};
    const r=await lib.setEffort({level:'high'});if(!r.cleanupWarning)throw Error('missing cleanup warning');
    const pref=JSON.parse(fs.readFileSync(process.env.CODEBUDDY_CONFIG_DIR+'/workbuddy-3p.effort.json','utf8'));
    const models=JSON.parse(fs.readFileSync(process.env.CODEBUDDY_CONFIG_DIR+'/models.json','utf8'));
    if(pref.default!=='high'||models.models[0].reasoning.defaultEffort!=='high')throw Error('post-commit inconsistency');
    console.log('ok')})().catch(e=>{console.error(e.message);process.exitCode=1})`], { env: f.env, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr); assert.equal(p.stdout.trim(), "ok");
});

test("profile replacement export preserves effective local-default-over-config-model precedence", t => {
  const f = fixture(t), cfgfile = path.join(f.dir, "workbuddy-3p.json");
  const cfg = JSON.parse(fs.readFileSync(cfgfile, "utf8")); cfg.effort = { default: "low", models: { "p:m": "low" } };
  fs.writeFileSync(cfgfile, JSON.stringify(cfg));
  const run = args => spawnSync(process.execPath, [script, ...args], { env: f.env, encoding: "utf8" });
  const p = run(["--effort", "high"]); assert.equal(p.status, 0, p.stderr);
  const r = JSON.parse(p.stdout); assert.equal(r.models[0].configuredEffort, "high");
  cfg.effort = r.profileConfigPatch.effort; fs.writeFileSync(cfgfile, JSON.stringify(cfg));
  fs.unlinkSync(path.join(f.dir, "workbuddy-3p.effort.json"));
  const status = run(["--effort-status"]); assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).models[0].configuredEffort, "high");
});
