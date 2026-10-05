"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SYNC = path.join(ROOT, "plugins", "custom-api-models", "scripts", "sync-models.cjs");
const MCP = path.join(ROOT, "plugins", "custom-api-models", "scripts", "mcp-sync.cjs");
const FAKE_KEY = "fake-private-key-account-official-escape";
const USER_KEY = "fake-user-key-account-official-escape";
const SENTINEL = "__WB3P_ACCOUNT_OFFICIAL_ESCAPE__";

function cleanEnv(dir) {
  const env = { ...process.env, CODEBUDDY_CONFIG_DIR: dir };
  for (const key of Object.keys(env)) {
    if (/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(key)) delete env[key];
  }
  return env;
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

function readTextOrNull(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validModel() {
  return {
    maxInputTokens: 64000,
    maxOutputTokens: 2048,
    supportsToolCall: true,
    supportsReasoning: true,
    onlyReasoning: false,
    reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "low", canDisableThinking: true },
    thinkingLevelMap: { off: "none", low: "low", high: "high" },
    compat: { thinkingFormat: "openai", supportsReasoningEffort: true }
  };
}

function validConfig(baseUrl = "https://fake-account.invalid/v1") {
  return {
    mode: "explicit",
    enabled: "third-party",
    parameterPriority: "native",
    default: "p",
    providers: {
      p: {
        baseUrl,
        apiKey: FAKE_KEY,
        extraModels: ["m"],
        models: { m: validModel() }
      }
    },
    routes: { "last-good": "p:m" }
  };
}

function applyBadKind(cfg, kind) {
  if (kind === "preset") {
    cfg.providers.p.preset = "this-preset-does-not-exist";
    delete cfg.providers.p.baseUrl;
    return;
  }
  if (kind === "route-provider") {
    cfg.routes = { "last-good": { provider: "missing-provider", model: "m" } };
    return;
  }
  if (kind === "capability") {
    cfg.providers.p.models.m = { supportsReasoning: "yes" };
    return;
  }
  throw new Error(`unknown bad fixture kind ${kind}`);
}

function writeLastGoodModels(dir) {
  const userModel = {
    id: "user-owned",
    url: "https://user.invalid/v1/chat/completions",
    apiKey: USER_KEY
  };
  const managedModel = {
    id: "last-good",
    aliases: ["glm-5.1"],
    url: "https://last-good.invalid/v1/chat/completions",
    apiKey: FAKE_KEY
  };
  writeJson(path.join(dir, "models.json"), {
    models: [userModel, managedModel],
    availableModels: ["glm-5.1", "custom-local:last-good", "user-kept"],
    workbuddy3pManaged: { version: 1, ids: ["last-good"] }
  });
  writeJson(path.join(dir, "workbuddy-3p.state.json"), {
    managed: ["last-good"],
    allow: ["glm-5.1", "custom-local:last-good"],
    hidden: ["glm-5.1"],
    displaced: [],
    providers: {
      p: {
        url: "https://last-good.invalid/v1/chat/completions",
        modelIds: ["last-good"],
        apiKey: FAKE_KEY
      }
    },
    hadAllowlist: true,
    officialCatalogIds: ["glm-5.1"],
    updatedAt: "2026-10-05T00:00:00.000Z"
  });
}

function makeFixture(t, options = {}) {
  const {
    badKind = "route-provider",
    corruptAccountCache = false,
    withLastGood = true,
    cleanup = true
  } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-account-official-escape-"));
  if (cleanup) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = cleanEnv(dir);
  const cfg = validConfig();
  applyBadKind(cfg, badKind);
  writeJson(path.join(dir, "workbuddy-3p.json"), cfg);
  writeJson(path.join(dir, "workbuddy-3p.scope.json"), { version: 1, scope: "account" });

  const cacheFile = path.join(dir, "workbuddy-3p.account-cache.json");
  if (corruptAccountCache) writeText(cacheFile, '{"kind":"workbuddy-3p-private-profile",BROKEN');
  else writeJson(cacheFile, {
    kind: "workbuddy-3p-private-profile",
    version: 1,
    config: cfg
  });

  if (withLastGood) writeLastGoodModels(dir);
  return {
    dir,
    env,
    cfg,
    cacheFile,
    modelsFile: path.join(dir, "models.json"),
    stateFile: path.join(dir, "workbuddy-3p.state.json"),
    switchFile: path.join(dir, "workbuddy-3p.switch"),
    scopeFile: path.join(dir, "workbuddy-3p.scope.json")
  };
}

function runNode(env, body, timeout = 20000) {
  const source = [
    `const lib=require(${JSON.stringify(SYNC)});`,
    "(async()=>{",
    body,
    "})().catch(e=>{console.error(e && e.stack || String(e));process.exitCode=1;});"
  ].join("\n");
  return spawnSync(process.execPath, ["-e", source], { env, encoding: "utf8", timeout, windowsHide: true });
}

function testJson(stdout) {
  const line = stdout.trim().split(/\r?\n/).reverse().find(value => value.startsWith(SENTINEL));
  assert.ok(line, `missing test JSON sentinel in output:\n${stdout}`);
  return JSON.parse(line.slice(SENTINEL.length));
}

function runLibJson(f, body, timeout = 20000) {
  const result = runNode(f.env, body, timeout);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return testJson(result.stdout);
}

function assertLastGoodUnchanged(f, before) {
  assert.equal(fs.readFileSync(f.modelsFile, "utf8"), before);
}

function assertOfficialSessionFiles(f, payload) {
  assert.equal(payload.result.ok, true);
  assert.equal(payload.result.active, false);
  assert.equal(payload.result.scope, "session");
  assert.equal(payload.result.committed, true);
  assert.equal(payload.result.sessionCommitted, true);
  assert.equal(payload.status.configuredMode, "official");
  assert.equal(payload.status.active, false);
  assert.equal(payload.status.modelsJsonActive, false);
  assert.equal(readTextOrNull(f.switchFile), "official\n");
  assert.deepEqual(readJson(f.scopeFile), { version: 1, scope: "session" });
}

function assertLastGoodEscapeResult(f, payload) {
  assertOfficialSessionFiles(f, payload);
  const models = readJson(f.modelsFile);
  assert.equal(models.workbuddy3pManaged, undefined);
  assert.equal((models.models || []).some(model => model.id === "last-good"), false);
  assert.equal((models.models || []).some(model => model.id === "user-owned"), true);
  assert.equal(fs.existsSync(f.stateFile), false);
}

for (const [label, badKind] of [
  ["bad preset", "preset"],
  ["invalid route/provider", "route-provider"],
  ["invalid capability", "capability"]
]) {
  test(`session official escape bypasses ${label}`, t => {
    const f = makeFixture(t, { badKind });
    const originalModels = fs.readFileSync(f.modelsFile, "utf8");
    const originalLocal = fs.readFileSync(path.join(f.dir, "workbuddy-3p.json"), "utf8");
    const originalCache = fs.readFileSync(f.cacheFile, "utf8");

    const failedSync = runNode(f.env, "await lib.sync();");
    assert.notEqual(failedSync.status, 0, `${label} fixture unexpectedly synchronized`);
    assertLastGoodUnchanged(f, originalModels);

    const payload = runLibJson(f, [
      'const result=await lib.setSwitch("official",{scope:"session"});',
      `console.log(${JSON.stringify(SENTINEL)}+JSON.stringify({result,status:lib.status()}));`
    ].join("\n"));
    assertLastGoodEscapeResult(f, payload);
    assert.equal(fs.readFileSync(path.join(f.dir, "workbuddy-3p.json"), "utf8"), originalLocal);
    assert.equal(fs.readFileSync(f.cacheFile, "utf8"), originalCache);
  });
}

test("session official escape bypasses a corrupt account cache", t => {
  const f = makeFixture(t, { badKind: "route-provider", corruptAccountCache: true });
  const originalModels = fs.readFileSync(f.modelsFile, "utf8");
  const originalLocal = fs.readFileSync(path.join(f.dir, "workbuddy-3p.json"), "utf8");
  const originalCache = fs.readFileSync(f.cacheFile, "utf8");

  const failedSync = runNode(f.env, "await lib.sync();");
  assert.notEqual(failedSync.status, 0, "corrupt account cache unexpectedly synchronized");
  assertLastGoodUnchanged(f, originalModels);

  const payload = runLibJson(f, [
    'const result=await lib.setSwitch("official",{scope:"session"});',
    `console.log(${JSON.stringify(SENTINEL)}+JSON.stringify({result,status:lib.status()}));`
  ].join("\n"));
  assertLastGoodEscapeResult(f, payload);
  assert.equal(fs.readFileSync(path.join(f.dir, "workbuddy-3p.json"), "utf8"), originalLocal);
  assert.equal(fs.readFileSync(f.cacheFile, "utf8"), originalCache);
});

test("MCP models_switch uses the direct session official escape", t => {
  const f = makeFixture(t, { badKind: "route-provider", corruptAccountCache: true });
  const originalModels = fs.readFileSync(f.modelsFile, "utf8");
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "models_switch", arguments: { mode: "official", scope: "session" } } })
  ].join("\n") + "\n";

  const child = spawnSync(process.execPath, [MCP], { env: f.env, encoding: "utf8", input, timeout: 20000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.ok(!(child.stdout + child.stderr).includes(FAKE_KEY), "fake private key leaked from MCP output");
  const replies = child.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const call = replies.find(reply => reply.id === 2);
  assert.ok(call, `missing MCP switch reply:\n${child.stdout}`);
  assert.equal(call.isError, undefined);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.scope, "session");
  assert.equal(payload.sessionCommitted, true);
  assert.equal(payload.configuredMode, "official");
  assert.equal(payload.active, false);
  assert.equal(readTextOrNull(f.switchFile), "official\n");
  assert.deepEqual(readJson(f.scopeFile), { version: 1, scope: "session" });
  const models = readJson(f.modelsFile);
  assert.equal(models.workbuddy3pManaged, undefined);
  assert.equal((models.models || []).some(model => model.id === "last-good"), false);
  assert.equal((models.models || []).some(model => model.id === "user-owned"), true);
  assert.notEqual(fs.readFileSync(f.modelsFile, "utf8"), originalModels);
});

test("missing ownership state blocks session official without blind writes", t => {
  const f = makeFixture(t, { badKind: "route-provider" });
  const originalModels = fs.readFileSync(f.modelsFile, "utf8");
  const originalScope = fs.readFileSync(f.scopeFile, "utf8");
  fs.rmSync(f.stateFile, { force: true });

  const result = runNode(f.env, [
    'let error=null;',
    'try{await lib.setSwitch("official",{scope:"session"});}catch(e){error=e.message;}',
    `console.log(${JSON.stringify(SENTINEL)}+JSON.stringify({error}));`
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const payload = testJson(result.stdout);
  assert.match(payload.error || "", /ownership state missing/i);
  assertLastGoodUnchanged(f, originalModels);
  assert.equal(fs.readFileSync(f.scopeFile, "utf8"), originalScope);
  assert.equal(fs.existsSync(f.switchFile), false);
  assert.equal(fs.existsSync(path.join(f.dir, "workbuddy-3p.lock")), false);
});

test("failed escape rollback preserves an external concurrent switch and scope", t => {
  const f = makeFixture(t, { badKind: "route-provider" });
  const originalModels = fs.readFileSync(f.modelsFile, "utf8");
  const externalSwitch = "third-party\n";
  const externalScope = JSON.stringify({ version: 1, scope: "session" }, null, 2) + "\n";

  const result = runNode(f.env, [
    'const fs=require("node:fs"),path=require("node:path");',
    'const switchFile=path.join(process.env.CODEBUDDY_CONFIG_DIR,"workbuddy-3p.switch");',
    'const scopeFile=path.join(process.env.CODEBUDDY_CONFIG_DIR,"workbuddy-3p.scope.json");',
    `const externalSwitch=${JSON.stringify(externalSwitch)},externalScope=${JSON.stringify(externalScope)};`,
    'const realWriteSync=fs.writeSync;let injected=false;',
    'fs.writeSync=function(fd,buffer,offset,length,position){',
    '  if(!injected&&fs.existsSync(switchFile)&&fs.readFileSync(switchFile,"utf8")==="official\\n"){',
    '    injected=true;',
    '    fs.writeFileSync(switchFile,externalSwitch);',
    '    fs.writeFileSync(scopeFile,externalScope);',
    '    throw new Error("injected concurrent commit failure");',
    '  }',
    '  return realWriteSync.apply(fs,arguments);',
    '};',
    'let error=null;',
    'try{await lib.setSwitch("official",{scope:"session"});}catch(e){error=e.message;}',
    'fs.writeSync=realWriteSync;',
    `console.log(${JSON.stringify(SENTINEL)}+JSON.stringify({error,injected}));`
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const payload = testJson(result.stdout);
  assert.equal(payload.injected, true);
  assert.ok(payload.error, "injected commit failure was not surfaced");
  assert.equal(fs.readFileSync(f.switchFile, "utf8"), externalSwitch, "rollback overwrote an external switch");
  assert.equal(fs.readFileSync(f.scopeFile, "utf8"), externalScope, "rollback overwrote an external scope");
  assert.equal(fs.readFileSync(f.modelsFile, "utf8"), originalModels);
  assert.equal(fs.existsSync(path.join(f.dir, "workbuddy-3p.lock")), false);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return true; }
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

async function stopPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
  if (await waitForPidExit(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
  await waitForPidExit(pid);
}

test("session official clears the old localhost adapter and never forwards to supplier", async t => {
  const f = makeFixture(t, { badKind: "route-provider", corruptAccountCache: true, withLastGood: false, cleanup: false });
  let supplierHits = 0;
  const supplier = http.createServer(async (req, res) => {
    supplierHits += 1;
    for await (const _chunk of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(supplier);
  let daemonPid = 0;
  t.after(async () => {
    await stopPid(daemonPid);
    await closeServer(supplier);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });

  const valid = validConfig(`http://127.0.0.1:${port}/v1`);
  valid.providers.p.extraModels = ["last-good"];
  valid.providers.p.models = { "last-good": validModel() };
  valid.routes = { "last-good": "p:last-good" };
  writeJson(path.join(f.dir, "workbuddy-3p.json"), valid);
  writeJson(path.join(f.dir, "workbuddy-3p.parameters.json"), { version: 1, priority: "3p" });
  writeJson(f.scopeFile, { version: 1, scope: "session" });
  writeText(f.cacheFile, '{"kind":"workbuddy-3p-private-profile",BROKEN');

  const started = runLibJson(f, [
    'const result=await lib.setSwitch("third-party");',
    `console.log(${JSON.stringify(SENTINEL)}+JSON.stringify({result,status:lib.status()}));`
  ].join("\n"));
  assert.equal(started.status.active, true);
  const models = readJson(f.modelsFile);
  const oldModel = (models.models || []).find(model => model.id === "last-good");
  assert.ok(oldModel, "third-party sync did not create the last-good route");
  assert.match(oldModel.url, /^http:\/\/127\.0\.0\.1:\d+\//);
  assert.notEqual(oldModel.apiKey, FAKE_KEY);

  const registry = readJson(path.join(f.dir, "workbuddy-3p.runtime.json"));
  daemonPid = registry.pid;
  assert.ok(Number.isInteger(daemonPid) && daemonPid > 0);
  assert.equal(supplierHits, 0);

  const escaped = runLibJson(f, [
    'const result=await lib.setSwitch("official",{scope:"session"});',
    `console.log(${JSON.stringify(SENTINEL)}+JSON.stringify({result,status:lib.status()}));`
  ].join("\n"));
  assertOfficialSessionFiles(f, escaped);

  const response = await fetch(oldModel.url, {
    method: "POST",
    headers: { authorization: `Bearer ${oldModel.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "last-good", messages: [] })
  });
  await response.text();
  assert.equal(response.status, 410);
  assert.equal(supplierHits, 0, "the retired adapter forwarded to the supplier");
});