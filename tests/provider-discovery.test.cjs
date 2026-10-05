"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ERROR_CODES,
  ProviderDiscoveryError,
  normalizeProtocol,
  endpoint,
  authorizationHeaders,
  discoverModels,
  probeModel,
} = require("../plugins/custom-api-models/scripts/provider-discovery.cjs");

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function assertCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

test("the deadline covers a response body that stalls after successful headers", async () => {
  let cancelled=false;
  const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
  await assert.rejects(discoverModels({provider:{baseUrl:'https://api.example.test/v1'},key:'credential',fetch:async()=>new Response(stream),timeoutMs:15}),assertCode(ERROR_CODES.TIMEOUT));
});
test("provider metadata cannot reflect the private credential into the result", async () => {
  await assert.rejects(discoverModels({provider:{baseUrl:'https://api.example.test/v1'},key:'private-canary',fetch:async()=>jsonResponse({data:[{id:'private-canary'}]})}),assertCode(ERROR_CODES.INVALID_RESPONSE));
});

test("protocol aliases normalize to the three native protocols", () => {
  assert.equal(normalizeProtocol("openai-chat"), "openai-chat");
  assert.equal(normalizeProtocol("openai-compatible"), "openai-chat");
  assert.equal(normalizeProtocol("chat"), "openai-chat");
  assert.equal(normalizeProtocol("openai-responses"), "openai-responses");
  assert.equal(normalizeProtocol("response"), "openai-responses");
  assert.equal(normalizeProtocol("responses"), "openai-responses");
  assert.equal(normalizeProtocol("anthropic-messages"), "anthropic-messages");
  assert.equal(normalizeProtocol("message"), "anthropic-messages");
  assert.equal(normalizeProtocol("messages"), "anthropic-messages");
  assert.throws(() => normalizeProtocol(undefined), assertCode(ERROR_CODES.INVALID_PROTOCOL));
  assert.throws(() => normalizeProtocol("other"), assertCode(ERROR_CODES.INVALID_PROTOCOL));
});

test("legacy providers without protocol default only to chat endpoints", () => {
  const provider = { baseUrl: "https://api.example.test/v1" };
  assert.equal(endpoint(provider, "models"), "https://api.example.test/v1/models");
  assert.equal(endpoint(provider, "chat"), "https://api.example.test/v1/chat/completions");
  assert.equal(authorizationHeaders(provider, "sk-test").Authorization, "Bearer sk-test");
});

test("endpoint handles base/v1 and complete native generation endpoints", () => {
  const chat = { protocol: "openai-chat", baseUrl: "https://api.example.test/v1" };
  assert.equal(endpoint(chat, "models"), "https://api.example.test/v1/models");
  assert.equal(endpoint(chat, "generation"), "https://api.example.test/v1/chat/completions");

  const completeChat = {
    protocol: "openai-chat",
    baseUrl: "https://api.example.test/v1/chat/completions",
  };
  assert.equal(endpoint(completeChat, "models"), "https://api.example.test/v1/models");
  assert.equal(endpoint(completeChat, "generation"), "https://api.example.test/v1/chat/completions");

  const responses = { protocol: "openai-responses", baseUrl: "https://api.example.test/v1/responses" };
  assert.equal(endpoint(responses, "models"), "https://api.example.test/v1/models");
  assert.equal(endpoint(responses, "responses"), "https://api.example.test/v1/responses");

  const messages = { protocol: "anthropic-messages", baseUrl: "https://api.example.test/v1/messages" };
  assert.equal(endpoint(messages, "models"), "https://api.example.test/v1/models");
  assert.equal(endpoint(messages, "messages"), "https://api.example.test/v1/messages");

  assert.throws(
    () => endpoint({ protocol: "openai-chat", baseUrl: "https://api.example.test/v1/responses" }, "models"),
    assertCode(ERROR_CODES.INVALID_BASE_URL),
  );
});

test("base URLs reject userinfo, query, fragment, and insecure non-loopback HTTP", () => {
  for (const baseUrl of [
    "https://user:pass@api.example.test/v1",
    "https://api.example.test/v1?token=secret",
    "https://api.example.test/v1#fragment",
    "ftp://api.example.test/v1",
    "not-a-url",
  ]) {
    assert.throws(() => endpoint({ baseUrl }, "models"), assertCode(ERROR_CODES.INVALID_BASE_URL));
  }
  assert.throws(
    () => endpoint({ baseUrl: "http://api.example.test/v1" }, "models"),
    assertCode(ERROR_CODES.INSECURE_BASE_URL),
  );
  assert.equal(
    endpoint({ baseUrl: "http://api.example.test/v1", allowInsecureHttp: true }, "models"),
    "http://api.example.test/v1/models",
  );
  assert.equal(endpoint({ baseUrl: "http://127.0.0.1:43123/v1" }, "models"), "http://127.0.0.1:43123/v1/models");
  assert.equal(endpoint({ baseUrl: "http://[::1]:43123/v1" }, "models"), "http://[::1]:43123/v1/models");
});

test("authorization headers follow native protocol authentication", () => {
  assert.deepEqual(authorizationHeaders({ protocol: "openai-chat" }, "sk-test"), {
    Authorization: "Bearer sk-test",
  });
  assert.deepEqual(authorizationHeaders({ protocol: "openai-responses" }, "sk-test"), {
    Authorization: "Bearer sk-test",
  });
  assert.deepEqual(authorizationHeaders({ protocol: "anthropic-messages" }, "sk-test"), {
    "x-api-key": "sk-test",
    "anthropic-version": "2023-06-01",
  });
  assert.deepEqual(
    authorizationHeaders({ protocol: "anthropic-messages", anthropicVersion: "2025-01-01" }, "sk-test"),
    { "x-api-key": "sk-test", "anthropic-version": "2025-01-01" },
  );
  assert.throws(() => authorizationHeaders({}, ""), assertCode(ERROR_CODES.MISSING_CREDENTIAL));
});

test("discovery supports data and models list shapes with provider-reported metadata only", async () => {
  const provider = { baseUrl: "https://api.example.test/v1" };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      data: [
        {
          id: "alpha",
          display_name: "Alpha",
          ctx: 128000,
          capabilities: { tools: true },
          reasoning: "max",
        },
        { model: "beta", context_window: 64000 },
        { id: "gamma", name: "schedule-effort-max" },
        { id: "bad\nid", label: "bad" },
      ],
    });
  };

  const result = await discoverModels({ provider, key: "sk-secret", fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-secret");
  assert.equal(result.supported, true);
  assert.equal(result.count, 3);
  assert.deepEqual(result.models[0], {
    id: "alpha",
    label: "Alpha",
    ctx: 128000,
    capabilities: { tools: true },
  });
  assert.deepEqual(result.models[1], { id: "beta", label: "beta", ctx: 64000 });
  assert.deepEqual(result.models[2], { id: "gamma", label: "schedule-effort-max" });
  assert.equal(Object.hasOwn(result.models[2], "ctx"), false);
  assert.equal(JSON.stringify(result).includes("sk-secret"), false);
  assert.equal(JSON.stringify(result).includes("reasoning"), false);

  const second = await discoverModels({
    provider,
    key: "sk-secret",
    fetch: async () => jsonResponse({ models: [{ id: "delta", label: "Delta" }] }),
  });
  assert.deepEqual(second.models, [{ id: "delta", label: "Delta" }]);
});

test("discovery 404, 405, and 501 report unsupported discovery without reading a body", async () => {
  const provider = { baseUrl: "https://api.example.test/v1" };
  for (const status of [404, 405, 501]) {
    let calls = 0;
    const result = await discoverModels({
      provider,
      key: "sk-test",
      fetch: async () => {
        calls += 1;
        return new Response("body-secret", { status });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.supported, false);
    assert.equal(result.unsupported, true);
    assert.equal(result.manualImport, true);
    assert.deepEqual(result.models, []);
    assert.equal(result.status, status);
    assert.equal(result.code, ERROR_CODES.DISCOVERY_UNSUPPORTED);
    assert.equal(JSON.stringify(result).includes("body-secret"), false);
  }
});

test("probeModel uses native request bodies for all three protocols and returns probeOnly", async () => {
  const cases = [
    {
      protocol: "openai-chat",
      url: "https://api.example.test/v1/chat/completions",
      marker: (body) => body.messages[0].content,
      payload: (marker) => ({
        choices: [{ finish_reason: "stop", message: { content: `prefix ${marker} suffix` } }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
      checkBody: (body) => {
        assert.equal(body.max_tokens, 16);
        assert.match(body.messages[0].content, /^Reply with exactly this text: wb3p_[a-f0-9]{8}$/);
      },
    },
    {
      protocol: "openai-responses",
      url: "https://api.example.test/v1/responses",
      marker: (body) => body.input,
      payload: (marker) => ({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: marker }] }],
        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
      }),
      checkBody: (body) => {
        assert.equal(body.max_output_tokens, 16);
        assert.match(body.input, /^Reply with exactly this text: wb3p_[a-f0-9]{8}$/);
      },
    },
    {
      protocol: "anthropic-messages",
      url: "https://api.example.test/v1/messages",
      marker: (body) => body.messages[0].content,
      payload: (marker) => ({
        stop_reason: "end_turn",
        content: [{ type: "text", text: marker }],
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
      checkBody: (body) => {
        assert.equal(body.max_tokens, 16);
        assert.match(body.messages[0].content, /^Reply with exactly this text: wb3p_[a-f0-9]{8}$/);
      },
    },
  ];

  for (const spec of cases) {
    let captured;
    const fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      const marker = spec.marker(captured.body);
      return jsonResponse(spec.payload(marker));
    };

    const result = await probeModel({
      provider: { protocol: spec.protocol, baseUrl: "https://api.example.test/v1" },
      key: "sk-test",
      model: "model-1",
      fetch,
    });

    assert.equal(captured.url, spec.url);
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.redirect, "manual");
    assert.equal(captured.init.headers["Content-Type"], "application/json");
    assert.equal(captured.body.model, "model-1");
    assert.equal(captured.body.stream, false);
    spec.checkBody(captured.body);
    if (spec.protocol === "anthropic-messages") {
      assert.equal(captured.init.headers["x-api-key"], "sk-test");
      assert.equal(captured.init.headers["anthropic-version"], "2023-06-01");
      assert.equal(captured.init.headers.Authorization, undefined);
    } else {
      assert.equal(captured.init.headers.Authorization, "Bearer sk-test");
    }

    assert.equal(result.probeOnly, true);
    assert.equal(result.ok, true);
    assert.equal(result.completed, true);
    assert.equal(result.markerMatched, true);
    assert.equal(result.usage.inputTokens, 7);
    assert.equal(result.usage.outputTokens, 2);
    assert.equal(JSON.stringify(result).includes("sk-test"), false);
  }
});

test("HTTP 200 without completion or marker is not a successful probe", async () => {
  async function run(payloadForMarker) {
    const fetch = async (url, init) => {
      const marker = JSON.parse(init.body).messages[0].content;
      return jsonResponse(payloadForMarker(marker));
    };
    return probeModel({
      provider: { baseUrl: "https://api.example.test/v1" },
      key: "sk-test",
      model: "model-1",
      fetch,
    });
  }

  const incomplete = await run((marker) => ({
    choices: [{ finish_reason: null, message: { content: marker } }],
  }));
  assert.equal(incomplete.probeOnly, true);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.completed, false);
  assert.equal(incomplete.markerMatched, true);
  assert.equal(incomplete.error.code, ERROR_CODES.PROBE_INCOMPLETE);

  const missing = await run(() => ({
    choices: [{ finish_reason: "stop", message: { content: "not the marker" } }],
  }));
  assert.equal(missing.probeOnly, true);
  assert.equal(missing.ok, false);
  assert.equal(missing.completed, true);
  assert.equal(missing.markerMatched, false);
  assert.equal(missing.error.code, ERROR_CODES.MARKER_MISSING);
  assert.equal(JSON.stringify(missing).includes("not the marker"), false);
});

test("redirects and HTTP errors fail closed without leaking credentials or response bodies", async () => {
  let redirectInit;
  await assert.rejects(
    discoverModels({
      provider: { baseUrl: "https://api.example.test/v1" },
      key: "sk-leak",
      fetch: async (url, init) => {
        redirectInit = init;
        return new Response("body-secret", {
          status: 302,
          headers: { location: "https://evil.example.test/" },
        });
      },
    }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.REDIRECT);
      assert.equal(error.status, 302);
      assert.equal(error.message.includes("sk-leak"), false);
      assert.equal(error.message.includes("body-secret"), false);
      return true;
    },
  );
  assert.equal(redirectInit.redirect, "manual");

  await assert.rejects(
    discoverModels({
      provider: { baseUrl: "https://api.example.test/v1" },
      key: "sk-leak",
      fetch: async () => new Response("body-secret", { status: 500 }),
    }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.HTTP_ERROR);
      assert.equal(error.status, 500);
      assert.equal(error.message.includes("sk-leak"), false);
      assert.equal(error.message.includes("body-secret"), false);
      return true;
    },
  );
});

test("timeouts and external aborts cancel discovery requests", async () => {
  await assert.rejects(
    discoverModels({
      provider: { baseUrl: "https://api.example.test/v1", timeoutMs: 5 },
      key: "sk-test",
      fetch: () => new Promise(() => {}),
    }),
    assertCode(ERROR_CODES.TIMEOUT),
  );

  const controller = new AbortController();
  const fetch = async (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
    controller.abort();
  });
  await assert.rejects(
    discoverModels({
      provider: { baseUrl: "https://api.example.test/v1" },
      key: "sk-test",
      signal: controller.signal,
      fetch,
    }),
    assertCode(ERROR_CODES.ABORTED),
  );
});

test("response size and model count limits fail closed safely", async () => {
  await assert.rejects(
    discoverModels({
      provider: { baseUrl: "https://api.example.test/v1" },
      key: "sk-test",
      maxResponseBytes: 8,
      fetch: async () => jsonResponse({ data: [{ id: "model-1" }] }),
    }),
    assertCode(ERROR_CODES.RESPONSE_TOO_LARGE),
  );

  const models = Array.from({ length: 1001 }, (_, index) => ({ id: `model-${index}` }));
  const result = await discoverModels({
    provider: { baseUrl: "https://api.example.test/v1" },
    key: "sk-test",
    fetch: async () => jsonResponse({ data: models }),
  });
  assert.equal(result.supported, true);
  assert.equal(result.models.length, 1000);
  assert.equal(result.truncated, true);
});

test("fetch is injected and credential/model requirements are explicit", async () => {
  const provider = { baseUrl: "https://api.example.test/v1" };
  await assert.rejects(
    discoverModels({ provider, key: "sk-test" }),
    assertCode(ERROR_CODES.FETCH_REQUIRED),
  );
  await assert.rejects(
    discoverModels({ provider, fetch: async () => jsonResponse({ data: [] }) }),
    assertCode(ERROR_CODES.MISSING_CREDENTIAL),
  );
  await assert.rejects(
    probeModel({
      provider,
      key: "sk-test",
      model: "",
      fetch: async () => jsonResponse({ data: [] }),
    }),
    assertCode(ERROR_CODES.INVALID_MODEL),
  );
});
