"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { spawnSync, spawn } = require("child_process");
const coreFile = path.resolve(__dirname, "../plugins/custom-api-models/scripts/sync-models.cjs");
const runtime = require("../plugins/custom-api-models/scripts/parameter-runtime.cjs");
const key = "FAKE_PRIVATE_UPSTREAM_KEY_RUNTIME_TEST_ONLY";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-runtime-")), env = { ...process.env, CODEBUDDY_CONFIG_DIR: dir };
  for (const k of Object.keys(env)) if (/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)) delete env[k];
  // Deliberately no priority override: this tests the public 3p default.
  const calls = [], upstream = http.createServer(async (req, res) => {
    let body = ""; for await (const b of req) body += b;
    calls.push({ body: JSON.parse(body), authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"RUNTIME_OK"},"finish_reason":null}]}\n\n');
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const read = file => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const invoke = code => {
    const r = spawnSync(process.execPath, ["-e", `const lib=require(${JSON.stringify(coreFile)});(async()=>{${code}})().catch(e=>{console.error(e.message);process.exitCode=1})`],
      { env, encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    assert.ok(!(r.stdout + r.stderr).includes(key), "private upstream key leaked"); return JSON.parse(r.stdout);
  };
  const sync = () => invoke("console.log(JSON.stringify(await lib.sync()))");
  const apply = patch => invoke(`const s=await lib.settingsStatus();console.log(JSON.stringify(await lib.applySettings({action:'apply',scope:'session',expectedRevision:s.revision,patch:${JSON.stringify(patch)}})))`);
  const reg = () => read("workbuddy-3p.runtime.json");
  t.after(async () => {
    // Only kill identities created by this fixture, never scan arbitrary PIDs.
    try { const r = reg(); if (r.pid > 0) pids.add(r.pid); } catch {}
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    // SIGTERM invokes asynchronous fail-closed teardown on Linux. Removing the
    // fixture before its routing lock/registry cleanup finishes causes ENOTEMPTY.
    for (const pid of pids) {
      const deadline = Date.now() + 5000;
      for (;;) {
        try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") break; throw e; }
        if (process.platform === "linux") {
          try { if (fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(")")[1].trim().startsWith("Z")) break; }
          catch (e) { if (e.code === "ENOENT") break; throw e; }
        }
        if (Date.now() > deadline) throw Error("fixture daemon did not stop; preserving fixture directory");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pids = new Set();
  const start = async () => {
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    fs.writeFileSync(path.join(dir, "workbuddy-3p.json"), JSON.stringify({ mode: "explicit", providers: { p: { baseUrl, apiKey: key,
      extraModels: ["qwen3.8-flash"], models: { "qwen3.8-flash": { supportsReasoning: true, onlyReasoning: false,
        reasoning: { supportedEfforts: ["low", "medium", "xhigh"], defaultEffort: "xhigh", canDisableThinking: true },
        thinkingLevelMap: { off: "none", low: "low", medium: "medium", xhigh: "xhigh" },
        compat: { thinkingFormat: "qwen", supportsReasoningEffort: true } } } } } }));
    sync(); pids.add(reg().pid); return baseUrl + "/chat/completions";
  };
  const model = () => read("models.json").models.find(m => m.id === "qwen3.8-flash");
  const request = (m = model()) => fetch(m.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${m.apiKey}` },
    body: JSON.stringify({ model: m.id, messages: [{ role: "user", content: "test" }], stream: true, reasoning_effort: "medium", enable_thinking: false }) });
  return { dir, env, read, invoke, sync, apply, reg, start, model, request, calls, pids };
}
test("default3p launches on plugin host, projects opaque key, reuses across CLI and enforces real upstream SSE", async t => {
  const f = fixture(t); await f.start();
  const first = f.reg(), m = f.model();
  assert.notEqual(m.apiKey, key); assert.match(m.url, /^http:\/\/127\.0\.0\.1:/); assert.ok(!m.url.includes(m.apiKey));
  assert.equal(f.read("workbuddy-3p.state.json").providers.p.apiKey, key);
  assert.equal(await runtime.healthy(first), true);
  f.sync(); assert.equal(f.reg().pid, first.pid); assert.equal(f.reg().port, first.port);
  const r = await f.request(), body = await r.text(); assert.equal(r.status, 200); assert.match(body, /RUNTIME_OK/); assert.match(body, /"stop"/);
  assert.equal(f.calls[0].body.reasoning_effort, "xhigh"); assert.equal(f.calls[0].body.enable_thinking, true);
  assert.equal(f.calls[0].authorization, `Bearer ${key}`);
});
test("multiple actual MCP lifetimes share one host daemon; one EOF cannot break the other's route", async t => {
  const f = fixture(t); await f.start(); const first = f.reg();
  const serverFile = path.join(path.dirname(coreFile), "mcp-sync.cjs");
  const children = [];
  t.after(() => { for (const c of children) if (c.exitCode === null) c.kill(); });
  const open = async () => {
    const child = spawn(process.execPath, [serverFile], { env: f.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); children.push(child);
    let buf = "";
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("MCP initialize timeout")), 10000);
      child.stdout.on("data", b => { buf += b; if (!buf.includes("\n")) return; clearTimeout(timer); resolve(JSON.parse(buf.split("\n")[0])); });
      child.once("error", reject);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    assert.equal((await reply).result.serverInfo.version, "3.0.0"); return child;
  };
  const [a, b] = await Promise.all([open(), open()]); assert.equal(f.reg().pid, first.pid);
  const exit = new Promise(resolve => a.once("exit", resolve)); a.stdin.end(); await exit;
  assert.equal(await runtime.healthy(f.reg()), true);
  const r = await f.request(); await r.text(); assert.equal(r.status, 200);
  assert.equal(f.calls[0].body.reasoning_effort, "xhigh");
  const exitB = new Promise(resolve => b.once("exit", resolve)); b.stdin.end(); await exitB;
});
test("official rejects cached adapter without provider traffic; resume shares daemon; native optout is direct", async t => {
  const f = fixture(t), url = await f.start(), stale = f.model(), reg = f.reg();
  f.apply({ switchMode: "official" });
  const denied = await f.request(stale); assert.equal(denied.ok, false); await denied.text(); assert.equal(f.calls.length, 0);
  f.apply({ switchMode: "third-party" }); assert.equal(f.reg().pid, reg.pid);
  assert.equal((await f.request()).status, 200);
  f.apply({ parameterPriority: "native" }); assert.equal(f.model().url, url); assert.equal(f.model().apiKey, key);
  const native = await f.request(); await native.text(); assert.equal(f.calls.at(-1).body.reasoning_effort, "medium");
  assert.equal(f.calls.at(-1).body.enable_thinking, false);
  const closed = await f.request(stale); await closed.text(); assert.equal(closed.ok, false);
});
test("priority is secret-free, revision guarded, backed up; thinking off and restored preference affect the next request", async t => {
  const f = fixture(t); await f.start();
  const result = f.apply({ efforts: { "p:qwen3.8-flash": "off" }, parameterPriority: "3p" });
  assert.equal(result.parameterPriority, "3p"); assert.equal(result.committed, true);
  assert.ok(fs.existsSync(path.join(result.backup, "manifest.json")));
  const r = await f.request(); await r.text(); assert.equal(f.calls[0].body.enable_thinking, false);
  assert.equal(f.calls[0].body.reasoning_effort, undefined);
  f.apply({ maxEffort: true }); const next = await f.request(); await next.text(); assert.equal(f.calls.at(-1).body.reasoning_effort, "xhigh");
  const manifests = f.read(path.relative(f.dir, path.join(result.backup, "manifest.json")));
  assert.ok(manifests.some(m => m.file.endsWith("workbuddy-3p.parameters.json")));
  const guard = f.invoke(`const fs=require('fs'),p=require('path').join(process.env.CODEBUDDY_CONFIG_DIR,'workbuddy-3p.parameters.json');const s=await lib.settingsStatus();fs.writeFileSync(p,JSON.stringify({version:1,priority:'native'}));try{await lib.applySettings({action:'apply',scope:'session',expectedRevision:s.revision,patch:{maxEffort:true}})}catch(e){console.log(JSON.stringify({rejected:/settings changed/.test(e.message)}));return}throw Error('accepted stale')`);
  assert.equal(guard.rejected, true);
});
test("offline fallback only reuses original provider key at same normalized endpoint, not opaque projection", async t => {
  const f = fixture(t); await f.start();
  let cfg = f.read("workbuddy-3p.json"); delete cfg.providers.p.apiKey;
  fs.writeFileSync(path.join(f.dir, "workbuddy-3p.json"), JSON.stringify(cfg)); f.sync();
  const r = await f.request(); await r.text(); assert.equal(f.calls[0].authorization, `Bearer ${key}`);
  cfg.providers.p.baseUrl = "https://different.invalid/v1";
  fs.writeFileSync(path.join(f.dir, "workbuddy-3p.json"), JSON.stringify(cfg));
  const result = f.sync(); assert.equal(result.active, false); assert.equal(f.read("models.json").models.length, 0);
});
test("failed routing commit rolls priority and projected credential/endpoint back together", async t => {
  const f = fixture(t); await f.start(); f.apply({ parameterPriority: "3p" });
  const result = f.invoke(`const fs=require('fs'),path=require('path'),d=process.env.CODEBUDDY_CONFIG_DIR;
    const files=['models.json','workbuddy-3p.state.json','workbuddy-3p.parameters.json'];const before=files.map(n=>fs.readFileSync(path.join(d,n),'utf8'));
    const s=await lib.settingsStatus(),write=fs.writeFileSync;let failed=false;
    fs.writeFileSync=(p,...a)=>{if(String(p).includes('workbuddy-3p.state.json.tmp-'))throw Error('injected state failure');return write(p,...a)};
    try{await lib.applySettings({action:'apply',scope:'session',expectedRevision:s.revision,patch:{parameterPriority:'native'}})}catch(e){failed=true}finally{fs.writeFileSync=write}
    console.log(JSON.stringify({failed,restored:files.every((n,i)=>fs.readFileSync(path.join(d,n),'utf8')===before[i])}));`);
  assert.deepEqual(result, { failed: true, restored: true });
  const r = await f.request(); await r.text(); assert.equal(r.status, 200); assert.equal(f.calls[0].body.reasoning_effort, "xhigh");
});
test("daemon teardown fails closed, preserves user edits and opaque bindings; maintenance recovers", async t => {
  const f = fixture(t); await f.start(); const first = f.reg(), m = f.model();
  const models = f.read("models.json"); models.models[0].url = "https://user-edit.invalid/v1/chat/completions";
  fs.writeFileSync(path.join(f.dir, "models.json"), JSON.stringify(models));
  f.invoke(`await lib.retireProxyRuntime(${JSON.stringify(first.serverId)});console.log('true')`);
  assert.equal(f.model().url, "https://user-edit.invalid/v1/chat/completions");
  // Restore fixture fields before killing only the fixture daemon identity.
  fs.writeFileSync(path.join(f.dir, "models.json"), JSON.stringify({ ...models, models: [m] }));
  const before = fs.readFileSync(path.join(f.dir, "models.json"), "utf8");
  const stale = await f.request(m); await stale.text(); assert.equal(stale.ok, false); assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(f.dir, "models.json"), "utf8"), before);
  assert.notEqual(f.model().apiKey, key); assert.match(f.model().url, /^http:\/\/127\.0\.0\.1:/);
  process.kill(first.pid); f.pids.delete(first.pid);
  await new Promise(resolve => setTimeout(resolve, 100));
  f.invoke("console.log(JSON.stringify(await lib.maintainRuntime()))"); f.pids.add(f.reg().pid);
  assert.notEqual(f.reg().pid, first.pid); assert.notEqual(f.model().apiKey, m.apiKey);
  const r = await f.request(); await r.text(); assert.equal(r.status, 200); assert.equal(f.calls[0].body.reasoning_effort, "xhigh");
  f.invoke(`await lib.retireProxyRuntime(${JSON.stringify(first.serverId)});console.log('true')`);
  assert.ok(f.reg().serverId !== first.serverId, "old teardown must not remove successor");
});
test("config enabled=false rejects stale cache before sync, maintenance applies official; invalid/missing config fails closed", async t => {
  const f = fixture(t); await f.start(); const stale = f.model(), file = path.join(f.dir, "workbuddy-3p.json"), cfg = f.read("workbuddy-3p.json");
  fs.writeFileSync(file, JSON.stringify({ ...cfg, enabled: false }));
  const denied = await f.request(stale); await denied.text(); assert.equal(denied.status, 410); assert.equal(f.calls.length, 0);
  const stopped = f.invoke("console.log(JSON.stringify(await lib.maintainRuntime()))"); assert.equal(stopped.disabled, true);
  assert.equal(f.read("models.json").models.length, 0);
  fs.writeFileSync(file, JSON.stringify({ ...cfg, enabled: true })); f.sync();
  const r = await f.request(); await r.text(); assert.equal(r.status, 200);
  const count = f.calls.length;
  fs.writeFileSync(file, '{broken'); const invalid = await f.request(); await invalid.text(); assert.equal(invalid.status, 410);
  fs.rmSync(file); const missing = await f.request(); await missing.text(); assert.equal(missing.status, 410);
  assert.equal(f.calls.length, count);
});
