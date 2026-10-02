"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const { createParameterProxy, forceParameters } = require(path.join(
  __dirname,
  "..",
  "plugins",
  "custom-api-models",
  "scripts",
  "parameter-proxy.cjs",
));

const SECRET = "parameter-proxy-test-secret-0123456789";
const SERVER_ID = "wb3p-test-server";
const PROVIDER_KEY = "fake-provider-key-never-return-this";
const CLIENT_KEY = "fake-client-key-never-forward-this";

const hmac = (value) => crypto.createHmac("sha256", SECRET).update(value).digest("base64url");

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function qwenModel(overrides = {}) {
  return {
    id: "qwen-test",
    supportsReasoning: true,
    onlyReasoning: false,
    compat: { thinkingFormat: "qwen", supportsReasoningEffort: true },
    reasoning: { defaultEffort: "xhigh", effort: "xhigh", canDisableThinking: true },
    thinkingLevelMap: { off: "none", low: "low", medium: "medium", xhigh: "xhigh" },
    ...overrides,
  };
}

test("forceParameters rewrites declared Qwen thinking parameters without inventing levels", () => {
  const body = {
    model: "qwen-test",
    messages: [{ role: "user", content: "hello" }],
    enable_thinking: false,
    reasoning_effort: "low",
    reasoning: { effort: "low" },
    thinking_budget: 123,
    keep: true,
  };
  const model = qwenModel();
  const result = forceParameters(body, model);

  assert.deepEqual(result, {
    model: "qwen-test",
    messages: [{ role: "user", content: "hello" }],
    enable_thinking: true,
    reasoning_effort: "xhigh",
    keep: true,
  });
  assert.equal(body.enable_thinking, false, "pure function must not mutate input");
  assert.equal(body.reasoning_effort, "low");

  const off = forceParameters({ model: "m", enable_thinking: true, reasoning_effort: "max" }, qwenModel({
    reasoning: { defaultEffort: "off", effort: "off", canDisableThinking: true },
  }));
  assert.deepEqual(off, { model: "m", enable_thinking: false });

  const switchOnly = forceParameters({ model: "m", reasoning_effort: "low" }, qwenModel({
    compat: { thinkingFormat: "qwen", supportsReasoningEffort: false },
    reasoning: { defaultEffort: "high", effort: "high", canDisableThinking: true },
    thinkingLevelMap: { off: "none", high: "high" },
  }));
  assert.deepEqual(switchOnly, { model: "m", enable_thinking: true });

  const unknown = forceParameters({ model: "m", enable_thinking: true, reasoning_effort: "high" }, {
    supportsReasoning: true,
    compat: { thinkingFormat: "unknown", supportsReasoningEffort: true },
    reasoning: { defaultEffort: "high" },
    thinkingLevelMap: { high: "high" },
  });
  assert.deepEqual(unknown, { model: "m", enable_thinking: true, reasoning_effort: "high" });
});
test("off projection, custom OpenAI capabilities and every Bailian model use declared provider parameters", () => {
  const fs = require("fs"), effort = require("../plugins/custom-api-models/scripts/effort.cjs");
  const preset = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugins/custom-api-models/presets/bailian.json"), "utf8"));
  for (const [id, config] of Object.entries(preset.models)) {
    const model = { ...effort.mergeModel(preset.templates[config.template], config), id };
    const levels = model.reasoning.supportedEfforts;
    if (levels.length) model.reasoning = { ...model.reasoning, defaultEffort: levels.at(-1) };
    const out = forceParameters({ model: id, reasoning_effort: "medium", enable_thinking: false }, model);
    if (levels.length) assert.equal(out.reasoning_effort, model.thinkingLevelMap[levels.at(-1)], id);
    else assert.equal(out.reasoning_effort, undefined, id);
    if (model.compat.thinkingFormat === "qwen") assert.equal(out.enable_thinking, true, id);
    else assert.equal(out.enable_thinking, undefined, id);
    if (model.reasoning.canDisableThinking && !model.onlyReasoning) {
      model.supportsReasoning = false; model.reasoning = { ...model.reasoning, defaultEffort: "off" };
      const off = forceParameters({ model: id, enable_thinking: true, reasoning_effort: "max" }, model);
      assert.equal(off.enable_thinking, false, id); assert.equal(off.reasoning_effort, undefined, id);
    }
  }
  const custom = { id: "custom-openai", supportsReasoning: true, compat: { thinkingFormat: "openai", supportsReasoningEffort: true },
    reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "high" } };
  assert.deepEqual(forceParameters({ model: custom.id, reasoning_effort: "low", thinking_budget: 999 }, custom),
    { model: custom.id, reasoning_effort: "high" });
});
test("aggregate upload budget is shared by concurrent bodies, not copied per request", async t => {
  const proxy = await createParameterProxy({ secret: SECRET, serverId: SERVER_ID, readRoute: async () => null, timeoutMs: 4000 });
  const requests = [];
  t.after(async () => { for (const req of requests) req.destroy(); await proxy.close(); });
  const modelId = "aggregate-test", block = Buffer.alloc(12 * 1024 * 1024, 32);
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("aggregate gate did not reject")), 2500);
    for (let i = 0; i < 3; i++) {
      const req = http.request(proxy.urlFor(modelId), { method: "POST", headers: { authorization: `Bearer ${proxy.tokenFor(modelId)}` } }, res => {
        clearTimeout(timer); res.resume(); resolve(res.statusCode);
      });
      req.on("error", () => {}); requests.push(req); req.write(block);
      // Deliberately no end: all three bodies compete for the shared buffer budget.
    }
  });
  assert.equal(await result, 413);
});

test("proxy uses opaque URL/token, rewrites 3p, and forwards only provider credentials", async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const raw = await readRequestBody(req);
    seen.push({ headers: req.headers, body: JSON.parse(raw.toString("utf8")) });
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "upstream-req" });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  let routeCalls = 0;
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async (modelId) => {
      routeCalls += 1;
      assert.equal(modelId, "qwen-test");
      return {
        model: qwenModel(),
        url: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        apiKey: PROVIDER_KEY,
        priority: "3p",
      };
    },
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const modelId = "qwen-test";
  const url = proxy.urlFor(modelId);
  assert.equal(url, `http://127.0.0.1:${proxy.port}/models/${Buffer.from(modelId, "utf8").toString("base64url")}/chat/completions`);
  assert.ok(!url.includes("key") && !url.includes("?"));
  assert.equal(proxy.tokenFor(modelId), hmac(`client:${SERVER_ID}:${modelId}`));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.tokenFor(modelId)}`,
      "content-type": "application/json",
      cookie: "session=must-not-forward",
      "x-danger": "must-not-forward",
      "x-api-key": CLIENT_KEY,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hello" }],
      enable_thinking: false,
      reasoning_effort: "low",
      reasoning: { effort: "low" },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), JSON.stringify({ ok: true }));
  assert.equal(routeCalls, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${PROVIDER_KEY}`);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers["x-danger"], undefined);
  assert.equal(seen[0].headers["x-api-key"], undefined);
  assert.equal(seen[0].headers["accept-encoding"], "identity");
  assert.deepEqual(seen[0].body, {
    model: modelId,
    messages: [{ role: "user", content: "hello" }],
    enable_thinking: true,
    reasoning_effort: "xhigh",
  });
});

test("native priority passes request parameters through unchanged", async (t) => {
  let received = null;
  const upstream = http.createServer(async (req, res) => {
    received = JSON.parse((await readRequestBody(req)).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ native: true }));
  });
  const upstreamPort = await listen(upstream);
  const modelId = "native-test";
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async () => ({
      model: { id: modelId, supportsReasoning: true },
      url: `http://127.0.0.1:${upstreamPort}/chat`,
      apiKey: PROVIDER_KEY,
      priority: "native",
    }),
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const body = {
    model: modelId,
    messages: [],
    enable_thinking: false,
    reasoning_effort: "low",
    reasoning: { effort: "low" },
    custom: { preserved: true },
  };
  const response = await fetch(proxy.urlFor(modelId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.tokenFor(modelId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(received, body);
});

test("auth, URL, body identity and official-null requests fail before upstream", async (t) => {
  let routeCalls = 0;
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async (modelId) => {
      routeCalls += 1;
      if (modelId === "official") return null;
      return {
        model: { id: modelId, supportsReasoning: false },
        url: `http://127.0.0.1:${upstreamPort}/chat`,
        apiKey: PROVIDER_KEY,
        priority: "3p",
      };
    },
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const modelId = "official";
  const token = proxy.tokenFor(modelId);
  const request = (authorization, body) => fetch(proxy.urlFor(modelId), {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  let response = await request(`Bearer ${token}x`, { model: modelId, messages: [] });
  assert.equal(response.status, 401);
  await response.text();
  assert.equal(routeCalls, 0);

  response = await request(`Bearer ${token}`, { model: "different-model", messages: [] });
  assert.equal(response.status, 400);
  await response.text();
  assert.equal(routeCalls, 0);

  response = await request(`Bearer ${token}`, { model: modelId, messages: [] });
  assert.equal(response.status, 410);
  await response.text();
  assert.equal(routeCalls, 1);
  assert.equal(upstreamHits, 0);

  response = await fetch(`${proxy.urlFor(modelId)}?key=should-not-be-used`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [] }),
  });
  assert.equal(response.status, 400);
  await response.text();
  assert.equal(routeCalls, 1);
});

test("HTTP and SSE response bodies stream through and preserve content type", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    await readRequestBody(req);
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: one\n\n");
      setTimeout(() => res.write("data: two\n\n"), 10);
      setTimeout(() => res.end("data: three\n\n"), 20);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"value":');
    setTimeout(() => res.end('"complete"}'), 15);
  });
  const upstreamPort = await listen(upstream);
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async (modelId) => ({
      model: { id: modelId, supportsReasoning: false },
      url: `http://127.0.0.1:${upstreamPort}/${modelId === "sse-model" ? "sse" : "json"}`,
      apiKey: PROVIDER_KEY,
      priority: "native",
    }),
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const post = async (modelId) => fetch(proxy.urlFor(modelId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.tokenFor(modelId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: modelId, messages: [] }),
  });

  const json = await post("json-model");
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("content-type"), "application/json");
  assert.equal(await json.text(), '{"value":"complete"}');

  const sse = await post("sse-model");
  assert.equal(sse.status, 200);
  assert.equal(sse.headers.get("content-type"), "text/event-stream");
  const reader = sse.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), "data: one\n\ndata: two\n\ndata: three\n\n");
});

test("redirects are not followed and upstream errors are scrubbed", async (t) => {
  let targetHits = 0;
  const target = http.createServer((_req, res) => {
    targetHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("must not be reached");
  });
  const targetPort = await listen(target);
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/target` });
    res.end();
  });
  const redirectPort = await listen(redirect);

  const failing = http.createServer(async (req, res) => {
    await readRequestBody(req);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `leak ${PROVIDER_KEY} ${SECRET}` }));
  });
  const failingPort = await listen(failing);

  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async (modelId) => ({
      model: { id: modelId, supportsReasoning: false },
      url: modelId === "redirect" ? `http://127.0.0.1:${redirectPort}/redirect` : `http://127.0.0.1:${failingPort}/fail`,
      apiKey: PROVIDER_KEY,
      priority: "native",
    }),
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(redirect);
    await closeServer(target);
    await closeServer(failing);
  });

  const call = (modelId) => fetch(proxy.urlFor(modelId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.tokenFor(modelId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: modelId, messages: [] }),
  });

  let response = await call("redirect");
  assert.equal(response.status, 502);
  let text = await response.text();
  assert.ok(!text.includes(PROVIDER_KEY) && !text.includes(SECRET));
  assert.equal(targetHits, 0);

  response = await call("failure");
  assert.equal(response.status, 502);
  text = await response.text();
  assert.ok(!text.includes(PROVIDER_KEY) && !text.includes(SECRET));
  assert.ok(!text.includes("leak"));
});

test("client abort cancels the upstream request", async (t) => {
  let upstreamClosed = false;
  const upstream = http.createServer(async (req, res) => {
    await readRequestBody(req);
    res.once("close", () => { upstreamClosed = true; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: started\n\n");
  });
  const upstreamPort = await listen(upstream);
  const modelId = "abort-model";
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async () => ({
      model: { id: modelId, supportsReasoning: false },
      url: `http://127.0.0.1:${upstreamPort}/stream`,
      apiKey: PROVIDER_KEY,
      priority: "native",
    }),
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const controller = new AbortController();
  const response = await fetch(proxy.urlFor(modelId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.tokenFor(modelId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: modelId, messages: [] }),
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  try { await reader.cancel(); } catch {}
  await waitFor(() => upstreamClosed);
  assert.equal(upstreamClosed, true);
});

test("timeout aborts an upstream request and returns a generic error", async (t) => {
  const upstream = http.createServer(async (_req, res) => {
    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    }, 250);
  });
  const upstreamPort = await listen(upstream);
  const modelId = "timeout-model";
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    timeoutMs: 30,
    readRoute: async () => ({
      model: { id: modelId, supportsReasoning: false },
      url: `http://127.0.0.1:${upstreamPort}/slow`,
      apiKey: PROVIDER_KEY,
      priority: "native",
    }),
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const response = await fetch(proxy.urlFor(modelId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.tokenFor(modelId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: modelId, messages: [] }),
  });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.ok(!text.includes(PROVIDER_KEY) && !text.includes(SECRET));
});

test("health returns only the server id and nonce proof", async (t) => {
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async () => null,
  });
  t.after(() => proxy.close());

  const nonce = "a".repeat(64);
  const response = await fetch(`http://127.0.0.1:${proxy.port}/_wb3p/health?nonce=${nonce}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(SECRET));
  assert.deepEqual(JSON.parse(text), {
    serverId: SERVER_ID,
    proof: hmac(`health:${SERVER_ID}:${nonce}`),
  });

  const invalid = await fetch(`http://127.0.0.1:${proxy.port}/_wb3p/health?nonce=short`);
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes(SECRET));
});

test("per-request size limit and concurrency gate reject before upstream", async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    upstreamHits += 1;
    await readRequestBody(req);
    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    }, 120);
  });
  const upstreamPort = await listen(upstream);
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async (modelId) => ({
      model: { id: modelId, supportsReasoning: false },
      url: `http://127.0.0.1:${upstreamPort}/chat`,
      apiKey: PROVIDER_KEY,
      priority: "native",
    }),
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const modelId = "gate-model";
  const token = proxy.tokenFor(modelId);
  const oversized = await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      path: `/models/${Buffer.from(modelId, "utf8").toString("base64url")}/chat/completions`,
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(16 * 1024 * 1024 + 1),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(oversized.status, 413);
  assert.equal(upstreamHits, 0);

  const calls = Array.from({ length: 5 }, () => fetch(proxy.urlFor(modelId), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [] }),
  }));
  const responses = await Promise.all(calls);
  const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
  await Promise.all(responses.map((response) => response.text()));
  assert.equal(upstreamHits, 4);
});

test("close aborts in-flight requests and releases the loopback server", async (t) => {
  let upstreamClosed = false;
  const upstream = http.createServer(async (req, res) => {
    res.once("close", () => { upstreamClosed = true; });
    await readRequestBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: waiting\n\n");
  });
  const upstreamPort = await listen(upstream);
  const modelId = "close-model";
  const proxy = await createParameterProxy({
    secret: SECRET,
    serverId: SERVER_ID,
    readRoute: async () => ({
      model: { id: modelId, supportsReasoning: false },
      url: `http://127.0.0.1:${upstreamPort}/stream`,
      apiKey: PROVIDER_KEY,
      priority: "native",
    }),
  });
  t.after(() => closeServer(upstream));

  const response = await fetch(proxy.urlFor(modelId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.tokenFor(modelId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: modelId, messages: [] }),
  });
  const reader = response.body.getReader(); await reader.read();
  await proxy.close();
  await assert.rejects(reader.read());
  await waitFor(() => upstreamClosed);
  assert.equal(upstreamClosed, true);

  await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/_wb3p/health?nonce=${"b".repeat(64)}`));
});
