"use strict";
// Runs on the plugin host, never on a user's browser or the maintainer's computer.
// The routing lock protects registry creation AND every private route snapshot.
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { spawn } = require("child_process");
const SCHEMA = 1;
const digest = s => crypto.createHash("sha256").update(s).digest("hex");
const codeHash = () => digest(["parameter-runtime.cjs", "parameter-proxy.cjs", "sync-models.cjs", "parameters.cjs"]
  .map(n => fs.readFileSync(path.join(__dirname, n), "utf8").replace(/\r\n/g, "\n")).join("\0"));
const hmac = (secret, value) => crypto.createHmac("sha256", secret).update(value).digest("base64url");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function read(p) {
  let r;
  try {
    const st = fs.lstatSync(p.runtime);
    if (!st.isFile() || st.isSymbolicLink()) throw Error("parameter runtime registry must be a regular file");
    r = JSON.parse(fs.readFileSync(p.runtime, "utf8"));
  } catch (e) { if (e.code === "ENOENT") return null; throw Error("invalid parameter runtime registry"); }
  if (!r || r.version !== SCHEMA || !/^[a-f0-9]{64}$/.test(r.serverId) || !/^[a-f0-9]{64}$/.test(r.secret) ||
    !Number.isInteger(r.port) || r.port < 0 || r.port > 65535 || !Number.isInteger(r.pid) || r.pid < 0 ||
    !/^[a-f0-9]{64}$/.test(r.codeHash)) throw Error("invalid parameter runtime registry");
  return r;
}
async function healthy(r) {
  if (!r || !r.port || r.codeHash !== codeHash()) return false;
  const nonce = crypto.randomBytes(32).toString("hex");
  try {
    const resp = await fetch(`http://127.0.0.1:${r.port}/_wb3p/health?nonce=${nonce}`, { redirect: "error", signal: AbortSignal.timeout(900) });
    if (!resp.ok) return false;
    if (!resp.body) return false;
    const reader = resp.body.getReader(), chunks = []; let length = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 2048) { await reader.cancel(); return false; }
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks, length).toString("utf8");
    const result = JSON.parse(text);
    return result.serverId === r.serverId && same(result.proof, hmac(r.secret, `health:${r.serverId}:${nonce}`));
  } catch { return false; }
}
// Caller holds the routing lock; the child boot path never tries to take it.
async function ensure(p, writeAtomic) {
  const previous = read(p);
  if (await healthy(previous)) return previous;
  const r = { version: SCHEMA, serverId: crypto.randomBytes(32).toString("hex"), secret: crypto.randomBytes(32).toString("hex"),
    port: 0, pid: 0, codeHash: codeHash() };
  writeAtomic(p.runtime, JSON.stringify(r));
  let child;
  try {
    child = spawn(process.execPath, [__filename, "--daemon", p.dir, r.serverId],
      { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    let startError, exited = false;
    child.once("error", () => { startError = true; }); child.once("exit", () => { exited = true; }); child.unref();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !startError && !exited) {
      await new Promise(resolve => setTimeout(resolve, 80));
      const now = read(p);
      if (now?.serverId !== r.serverId) throw Error("parameter runtime changed during startup");
      if (await healthy(now)) return now;
    }
    throw Error("parameter runtime startup failed; previous routing retained");
  } catch (e) {
    if (read(p)?.serverId === r.serverId) {
      if (previous) writeAtomic(p.runtime, JSON.stringify(previous)); else fs.rmSync(p.runtime, { force: true });
    }
    throw e;
  }
}
function projection(r, modelId) {
  // Must match parameter-proxy's public methods exactly.
  const { proxyUrl, proxyToken } = require("./parameter-proxy.cjs");
  return { url: proxyUrl(r.port, modelId), apiKey: proxyToken(r.secret, r.serverId, modelId) };
}
async function heartbeat(p) { return healthy(read(p)); }

async function daemon(dir, serverId) {
  process.env.CODEBUDDY_CONFIG_DIR = dir;
  const core = require("./sync-models.cjs"), p = core.runtimePaths(dir), initial = read(p);
  if (!initial || initial.serverId !== serverId || initial.codeHash !== codeHash()) return;
  const { createParameterProxy } = require("./parameter-proxy.cjs");
  let stopping = false;
  const timeoutMs = process.env.WB3P_PARAMETER_TIMEOUT_MS === undefined ? undefined : Number(process.env.WB3P_PARAMETER_TIMEOUT_MS);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000))
    throw Error("invalid parameter timeout; expected 1000..1800000 milliseconds");
  const proxy = await createParameterProxy({ secret: initial.secret, serverId, timeoutMs, readRoute: id => core.proxyRouteSnapshot(id, serverId) });
  // Recheck bootstrap identity before publishing readiness; never replace a successor.
  if (read(p)?.serverId !== serverId) { await proxy.close(); return; }
  core.runtimeWrite(p.runtime, JSON.stringify({ ...initial, pid: process.pid, port: proxy.port }));
  let lastUse = Date.now();
  // Proxy reports request activity (including stream lifetime) without exposing content.
  if (proxy.onActivity) proxy.onActivity(() => { lastUse = Date.now(); });
  async function stop() {
    if (stopping) return; stopping = true; clearInterval(timer);
    await proxy.close();
    await core.retireProxyRuntime(serverId).catch(() => {});
  }
  // Health/requests track idle via the adapter itself; active streams never idle out.
  const timer = setInterval(() => {
    try {
      const current = read(p);
      if (current?.serverId !== serverId || Date.now() - Math.max(lastUse, proxy.lastActivity?.() || 0) > 30 * 60 * 1000)
        stop().then(() => process.exit(0));
    } catch { stop().then(() => process.exit(0)); }
  }, 15000);
  process.once("SIGTERM", () => stop().then(() => process.exit(0)));
  process.once("SIGINT", () => stop().then(() => process.exit(0)));
}
module.exports = { ensure, read, healthy, heartbeat, projection };
if (require.main === module) daemon(process.argv[3], process.argv[4]).catch(() => { process.exitCode = 1; });
