"use strict";

const { randomUUID } = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_MODELS = 1000;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const MAX_MODEL_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 512;
const MAX_CREDENTIAL_LENGTH = 16384;
const MAX_JSON_DEPTH = 4;
const MAX_JSON_ARRAY_LENGTH = 100;
const MAX_JSON_STRING_LENGTH = 4096;

const PROTOCOLS = Object.freeze({
  OPENAI_CHAT: "openai-chat",
  OPENAI_RESPONSES: "openai-responses",
  ANTHROPIC_MESSAGES: "anthropic-messages",
});

const GENERATION_SUFFIX = Object.freeze({
  [PROTOCOLS.OPENAI_CHAT]: "/chat/completions",
  [PROTOCOLS.OPENAI_RESPONSES]: "/responses",
  [PROTOCOLS.ANTHROPIC_MESSAGES]: "/messages",
});

const ERROR_CODES = Object.freeze({
  INVALID_PROVIDER: "INVALID_PROVIDER",
  INVALID_PROTOCOL: "INVALID_PROTOCOL",
  INVALID_BASE_URL: "INVALID_BASE_URL",
  INSECURE_BASE_URL: "INSECURE_BASE_URL",
  INVALID_ENDPOINT_KIND: "INVALID_ENDPOINT_KIND",
  MISSING_CREDENTIAL: "MISSING_CREDENTIAL",
  INVALID_CREDENTIAL: "INVALID_CREDENTIAL",
  INVALID_MODEL: "INVALID_MODEL",
  INVALID_ANTHROPIC_VERSION: "INVALID_ANTHROPIC_VERSION",
  INVALID_SIGNAL: "INVALID_SIGNAL",
  FETCH_REQUIRED: "FETCH_REQUIRED",
  HTTP_ERROR: "HTTP_ERROR",
  REDIRECT: "REDIRECT",
  TIMEOUT: "TIMEOUT",
  ABORTED: "ABORTED",
  RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  REQUEST_FAILED: "REQUEST_FAILED",
  DISCOVERY_UNSUPPORTED: "DISCOVERY_UNSUPPORTED",
  PROBE_INCOMPLETE: "PROBE_INCOMPLETE",
  MARKER_MISSING: "MARKER_MISSING",
});

class ProviderDiscoveryError extends Error {
  constructor(code, status = null, message = "") {
    super(message || code);
    this.name = "ProviderDiscoveryError";
    this.code = code;
    this.status = Number.isInteger(status) ? status : null;
    this.statusCode = this.status;
    this.httpStatus = this.status;
  }

  toJSON() {
    return { name: this.name, code: this.code, status: this.status };
  }
}

function fail(code, status = null, message = "") {
  throw new ProviderDiscoveryError(code, status, message);
}

function normalizeProtocol(value) {
  if (typeof value !== "string") fail(ERROR_CODES.INVALID_PROTOCOL);
  const protocol = value.trim().toLowerCase();
  if (protocol === PROTOCOLS.OPENAI_CHAT || protocol === "openai-compatible" || protocol === "chat") {
    return PROTOCOLS.OPENAI_CHAT;
  }
  if (protocol === PROTOCOLS.OPENAI_RESPONSES || protocol === "response" || protocol === "responses") {
    return PROTOCOLS.OPENAI_RESPONSES;
  }
  if (protocol === PROTOCOLS.ANTHROPIC_MESSAGES || protocol === "message" || protocol === "messages") {
    return PROTOCOLS.ANTHROPIC_MESSAGES;
  }
  fail(ERROR_CODES.INVALID_PROTOCOL);
}

function assertProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    fail(ERROR_CODES.INVALID_PROVIDER);
  }
}

function providerProtocol(provider) {
  assertProvider(provider);
  const value = provider.protocol;
  if (value === undefined || value === null || value === "") return PROTOCOLS.OPENAI_CHAT;
  return normalizeProtocol(value);
}

function stripTrailingSlash(value) {
  const text = String(value || "");
  if (text === "/") return "";
  return text.replace(/\/+$/, "");
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || host === "::ffff:127.0.0.1"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseBaseUrl(provider) {
  assertProvider(provider);
  const raw = provider.baseUrl;
  if (typeof raw !== "string" || !raw.trim()) fail(ERROR_CODES.INVALID_BASE_URL);

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    fail(ERROR_CODES.INVALID_BASE_URL);
  }

  if (!url.hostname || (url.protocol !== "https:" && url.protocol !== "http:")) {
    fail(ERROR_CODES.INVALID_BASE_URL);
  }
  if (url.username || url.password || url.search || url.hash) {
    fail(ERROR_CODES.INVALID_BASE_URL);
  }
  if (url.protocol === "http:" && !(isLoopbackHostname(url.hostname) || provider.allowInsecureHttp === true)) {
    fail(ERROR_CODES.INSECURE_BASE_URL);
  }

  url.pathname = stripTrailingSlash(url.pathname);
  return url;
}

function normalizeEndpointKind(kind, protocol) {
  const value = String(kind || "").trim().toLowerCase().replace(/_/g, "-");
  if (value === "models" || value === "model-list" || value === "list") return "models";
  if (value === "generation" || value === "generate" || value === "inference" || value === "probe") {
    return "generation";
  }
  if (protocol === PROTOCOLS.OPENAI_CHAT
    && (value === "chat" || value === "chat-completions" || value === "completions")) {
    return "generation";
  }
  if (protocol === PROTOCOLS.OPENAI_RESPONSES && value === "responses") return "generation";
  if (protocol === PROTOCOLS.ANTHROPIC_MESSAGES && value === "messages") return "generation";
  fail(ERROR_CODES.INVALID_ENDPOINT_KIND);
}

function detectCompleteGeneration(providerUrl, protocol) {
  const path = stripTrailingSlash(providerUrl.pathname);
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith("/models")) fail(ERROR_CODES.INVALID_BASE_URL);

  for (const [candidate, suffix] of Object.entries(GENERATION_SUFFIX)) {
    if (!lowerPath.endsWith(suffix)) continue;
    if (candidate !== protocol) fail(ERROR_CODES.INVALID_BASE_URL);
    return { complete: true, prefix: path.slice(0, path.length - suffix.length) };
  }
  return { complete: false, prefix: "" };
}

function apiBasePath(pathname) {
  const path = stripTrailingSlash(pathname);
  if (!path) return "/v1";
  if (/\/v\d+[A-Za-z0-9._-]*$/i.test(path)) return path;
  return path + "/v1";
}

function formatUrl(url) {
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function endpoint(provider, kind) {
  const protocol = providerProtocol(provider);
  const providerUrl = parseBaseUrl(provider);
  const target = normalizeEndpointKind(kind, protocol);
  const complete = detectCompleteGeneration(providerUrl, protocol);

  if (complete.complete) {
    if (target === "models") {
      providerUrl.pathname = `${stripTrailingSlash(complete.prefix)}/models`;
    }
    return formatUrl(providerUrl);
  }

  const base = apiBasePath(providerUrl.pathname);
  providerUrl.pathname = target === "models"
    ? `${base}/models`
    : `${base}${GENERATION_SUFFIX[protocol]}`;
  return formatUrl(providerUrl);
}

function normalizeCredential(key) {
  if (typeof key !== "string") fail(ERROR_CODES.MISSING_CREDENTIAL);
  const credential = key.trim();
  if (!credential) fail(ERROR_CODES.MISSING_CREDENTIAL);
  if (credential.length > MAX_CREDENTIAL_LENGTH || /[\u0000-\u001f\u007f]/.test(credential)) {
    fail(ERROR_CODES.INVALID_CREDENTIAL);
  }
  return credential;
}

function anthropicVersion(provider) {
  const value = provider.anthropicVersion === undefined || provider.anthropicVersion === null
    ? DEFAULT_ANTHROPIC_VERSION
    : provider.anthropicVersion;
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.trim())) {
    fail(ERROR_CODES.INVALID_ANTHROPIC_VERSION);
  }
  return value.trim();
}

function authorizationHeaders(provider, key) {
  const protocol = providerProtocol(provider);
  const credential = normalizeCredential(key);
  if (protocol === PROTOCOLS.ANTHROPIC_MESSAGES) {
    return {
      "x-api-key": credential,
      "anthropic-version": anthropicVersion(provider),
    };
  }
  return { Authorization: `Bearer ${credential}` };
}

function requestHeaders(provider, key, includeJson) {
  const headers = {
    Accept: "application/json",
    ...authorizationHeaders(provider, key),
  };
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function timeoutValue(options, provider) {
  return positiveNumber(options.timeoutMs ?? provider.timeoutMs, DEFAULT_TIMEOUT_MS);
}

function maxResponseBytesValue(options, provider) {
  return Math.min(
    positiveNumber(options.maxResponseBytes ?? provider.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
    DEFAULT_MAX_RESPONSE_BYTES,
  );
}

function modelLimitValue(options, provider) {
  return Math.min(positiveNumber(options.maxModels ?? provider.maxModels, DEFAULT_MAX_MODELS), DEFAULT_MAX_MODELS);
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") fail(ERROR_CODES.FETCH_REQUIRED);
  return fetchImpl;
}

function isAbortError(error) {
  return Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR" || error.code === 20);
}

function withDeadline(timeoutMs, externalSignal, task) {
  if (externalSignal && (typeof externalSignal !== "object" || typeof externalSignal.addEventListener !== "function")) {
    return Promise.reject(new ProviderDiscoveryError(ERROR_CODES.INVALID_SIGNAL));
  }
  if (externalSignal?.aborted) return Promise.reject(new ProviderDiscoveryError(ERROR_CODES.ABORTED));

  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProviderDiscoveryError(ERROR_CODES.TIMEOUT));
    }, timeoutMs);
  });
  const abortPromise = externalSignal
    ? new Promise((_, reject) => { rejectAbort = reject; })
    : null;
  const onExternalAbort = () => {
    controller.abort();
    if (rejectAbort) rejectAbort(new ProviderDiscoveryError(ERROR_CODES.ABORTED));
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const pending = [Promise.resolve().then(() => task(controller.signal)), timeoutPromise];
  if (abortPromise) pending.push(abortPromise);

  return Promise.race(pending)
    .catch((error) => {
      if (error instanceof ProviderDiscoveryError) throw error;
      if (externalSignal?.aborted) throw new ProviderDiscoveryError(ERROR_CODES.ABORTED);
      if (timedOut) throw new ProviderDiscoveryError(ERROR_CODES.TIMEOUT);
      if (isAbortError(error)) throw new ProviderDiscoveryError(ERROR_CODES.REQUEST_FAILED);
      throw new ProviderDiscoveryError(ERROR_CODES.REQUEST_FAILED);
    })
    .finally(() => {
      if (externalSignal?.removeEventListener) externalSignal.removeEventListener("abort", onExternalAbort);
      clearTimeout(timer);
    });
}

function responseStatus(response) {
  if (Number.isInteger(response?.status)) return response.status;
  if (Number.isInteger(response?.statusCode)) return response.statusCode;
  if (response?.ok === true) return 200;
  return 0;
}

function assertNotRedirect(response, status) {
  if (response?.redirected === true || response?.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    fail(ERROR_CODES.REDIRECT, status || null);
  }
}

function assertHttpOk(status) {
  if (!(status >= 200 && status < 300)) fail(ERROR_CODES.HTTP_ERROR, status || null);
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return null;
}

async function readStreamText(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value);
      total += chunk.length;
      if (total > maxBytes) fail(ERROR_CODES.RESPONSE_TOO_LARGE, responseStatus(response));
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ProviderDiscoveryError || isAbortError(error)) throw error;
    fail(ERROR_CODES.INVALID_RESPONSE, responseStatus(response));
  } finally {
    if (typeof reader.releaseLock === "function") reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readJsonResponse(response, maxBytes) {
  const status = responseStatus(response);
  const declaredLength = Number(headerValue(response, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    fail(ERROR_CODES.RESPONSE_TOO_LARGE, status || null);
  }

  let text;
  try {
    if (response?.body && typeof response.body.getReader === "function") {
      text = await readStreamText(response, maxBytes);
    } else if (typeof response?.arrayBuffer === "function") {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) fail(ERROR_CODES.RESPONSE_TOO_LARGE, status || null);
      text = bytes.toString("utf8");
    } else if (typeof response?.text === "function") {
      text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) fail(ERROR_CODES.RESPONSE_TOO_LARGE, status || null);
    } else if (typeof response?.json === "function") {
      const value = await response.json();
      if (value === undefined) fail(ERROR_CODES.INVALID_RESPONSE, status || null);
      const serialized = JSON.stringify(value);
      if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > maxBytes) {
        fail(ERROR_CODES.RESPONSE_TOO_LARGE, status || null);
      }
      return value;
    } else {
      fail(ERROR_CODES.INVALID_RESPONSE, status || null);
    }
  } catch (error) {
    if (error instanceof ProviderDiscoveryError || isAbortError(error)) throw error;
    fail(ERROR_CODES.INVALID_RESPONSE, status || null);
  }

  if (typeof text !== "string") fail(ERROR_CODES.INVALID_RESPONSE, status || null);
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) fail(ERROR_CODES.INVALID_RESPONSE, status || null);
  try {
    return JSON.parse(trimmed);
  } catch {
    fail(ERROR_CODES.INVALID_RESPONSE, status || null);
  }
}

function validateModelId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > MAX_MODEL_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

function validateLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || label.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) return null;
  return label;
}

function firstDefined(values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function cloneJson(value, depth = 0, seen = new WeakSet()) {
  if (value === null) return null;
  if (typeof value === "string") return value.length <= MAX_JSON_STRING_LENGTH ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || depth >= MAX_JSON_DEPTH || seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.slice(0, MAX_JSON_ARRAY_LENGTH)) {
      const cloned = cloneJson(item, depth + 1, seen);
      result.push(cloned === undefined ? null : cloned);
    }
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const result = {};
  for (const key of Object.keys(value).slice(0, MAX_JSON_ARRAY_LENGTH)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const cloned = cloneJson(value[key], depth + 1, seen);
    if (cloned !== undefined) result[key] = cloned;
  }
  return result;
}

function normalizeModelEntry(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const id = validateModelId(firstDefined([item.id, item.model]));
  if (!id) return null;

  const label = validateLabel(firstDefined([
    item.label,
    item.display_name,
    item.displayName,
    item.name,
  ])) || id;
  const ctx = cloneJson(firstDefined([
    item.ctx,
    item.context_window,
    item.contextWindow,
    item.context_length,
    item.contextLength,
    item.max_input_tokens,
    item.maxInputTokens,
  ]));
  const capabilities = cloneJson(firstDefined([
    item.capabilities,
    item.capability,
    item.features,
  ]));

  const model = { id, label };
  if (ctx !== undefined) model.ctx = ctx;
  if (capabilities !== undefined) model.capabilities = capabilities;
  return model;
}

function normalizeModels(payload, status, maxModels) {
  let list;
  if (Array.isArray(payload)) list = payload;
  else if (payload && typeof payload === "object" && Array.isArray(payload.data)) list = payload.data;
  else if (payload && typeof payload === "object" && Array.isArray(payload.models)) list = payload.models;
  else fail(ERROR_CODES.INVALID_RESPONSE, status || null);

  const models = [];
  const seen = new Set();
  for (const item of list) {
    if (models.length >= maxModels) break;
    const model = normalizeModelEntry(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }

  return {
    supported: true,
    models,
    count: models.length,
    truncated: list.length > maxModels,
    status,
  };
}

function requestOptions({ fetchImpl, url, method, headers, body, signal, timeoutMs, consume }) {
  requireFetch(fetchImpl);
  const init = {
    method,
    headers,
    redirect: "manual",
    signal: undefined,
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  return withDeadline(timeoutMs, signal, async (requestSignal) => {
    init.signal = requestSignal;
    const response = await fetchImpl(url, init);
    const cancel = () => { void response.body?.cancel().catch(() => {}); };
    requestSignal.addEventListener("abort", cancel, { once: true });
    try { return await consume(response); }
    finally { requestSignal.removeEventListener("abort", cancel); if (requestSignal.aborted) cancel(); }
  });
}

async function discoverModels({ provider, key, fetch, signal, timeoutMs, maxResponseBytes, maxModels } = {}) {
  const options = { timeoutMs, maxResponseBytes, maxModels };
  const url = endpoint(provider, "models");
  const headers = requestHeaders(provider, key, false);
  const fetchImpl = requireFetch(fetch);
  const limitBytes = maxResponseBytesValue(options, provider);
  const limitModels = modelLimitValue(options, provider);

  return requestOptions({
    fetchImpl,
    url,
    method: "GET",
    headers,
    signal,
    timeoutMs: timeoutValue(options, provider),
    consume: async (response) => {
    const status = responseStatus(response);
    assertNotRedirect(response, status);
    if (status === 404 || status === 405 || status === 501) {
      await response.body?.cancel().catch(() => {});
      return {
        supported: false,
        unsupported: true,
        manualImport: true,
        models: [],
        count: 0,
        truncated: false,
        status,
        code: ERROR_CODES.DISCOVERY_UNSUPPORTED,
      };
    }
    assertHttpOk(status);
    const payload = await readJsonResponse(response, limitBytes);
    const result = normalizeModels(payload, status, limitModels);
    // A provider response must never turn the credential into model metadata.
    if (JSON.stringify(result).includes(key)) fail(ERROR_CODES.INVALID_RESPONSE, status);
    return result;
    },
  });
}

function createMarker() {
  return `wb3p_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function probeBody(protocol, model, marker) {
  if (protocol === PROTOCOLS.OPENAI_CHAT) {
    return {
      model,
      messages: [{ role: "user", content: `Reply with exactly this text: ${marker}` }],
      max_tokens: 16,
      stream: false,
    };
  }
  if (protocol === PROTOCOLS.OPENAI_RESPONSES) {
    return {
      model,
      input: `Reply with exactly this text: ${marker}`,
      max_output_tokens: 16,
      stream: false,
    };
  }
  if (protocol === PROTOCOLS.ANTHROPIC_MESSAGES) {
    return {
      model,
      messages: [{ role: "user", content: `Reply with exactly this text: ${marker}` }],
      max_tokens: 16,
      stream: false,
    };
  }
  fail(ERROR_CODES.INVALID_PROTOCOL);
}

function collectText(value, output, depth = 0, seen = new WeakSet()) {
  if (value === undefined || value === null || depth > 8) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1, seen);
    return;
  }
  if (typeof value.text === "string") output.push(value.text);
  if (typeof value.output_text === "string") output.push(value.output_text);
  if (value.message !== undefined) collectText(value.message, output, depth + 1, seen);
  if (value.content !== undefined) collectText(value.content, output, depth + 1, seen);
}

function completionState(protocol, payload) {
  const text = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { completed: false, text };
  }

  if (protocol === PROTOCOLS.OPENAI_CHAT) {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const completed = choices.some((choice) => (
      typeof choice?.finish_reason === "string" && choice.finish_reason.trim() !== ""
    ));
    for (const choice of choices) collectText(choice?.message?.content, text);
    return { completed, text };
  }

  if (protocol === PROTOCOLS.OPENAI_RESPONSES) {
    const completed = String(payload.status || "").toLowerCase() === "completed" || payload.completed === true;
    collectText(payload.output_text, text);
    collectText(payload.output, text);
    return { completed, text };
  }

  if (protocol === PROTOCOLS.ANTHROPIC_MESSAGES) {
    const completed = typeof payload.stop_reason === "string" && payload.stop_reason.trim() !== "";
    collectText(payload.content, text);
    return { completed, text };
  }
  fail(ERROR_CODES.INVALID_PROTOCOL);
}

function nonNegativeCount(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

function probeUsage(payload) {
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : {};
  return {
    inputTokens: nonNegativeCount(usage.input_tokens, usage.prompt_tokens, usage.inputTokens, usage.promptTokens),
    outputTokens: nonNegativeCount(usage.output_tokens, usage.completion_tokens, usage.outputTokens, usage.completionTokens),
    totalTokens: nonNegativeCount(usage.total_tokens, usage.totalTokens),
  };
}

function probeResult(protocol, payload, marker, status) {
  const state = completionState(protocol, payload);
  const markerMatched = state.text.some((value) => value.includes(marker));
  const completed = Boolean(state.completed);
  const ok = completed && markerMatched;
  const usage = probeUsage(payload);
  const result = {
    probeOnly: true,
    ok,
    completed,
    markerMatched,
    status,
    usage,
  };
  if (!ok) {
    result.error = {
      name: "ProviderDiscoveryError",
      code: completed ? ERROR_CODES.MARKER_MISSING : ERROR_CODES.PROBE_INCOMPLETE,
      status,
    };
  }
  return result;
}

async function probeModel({ provider, key, model, fetch, signal, timeoutMs, maxResponseBytes } = {}) {
  const options = { timeoutMs, maxResponseBytes };
  const protocol = providerProtocol(provider);
  const modelId = validateModelId(model);
  if (!modelId) fail(ERROR_CODES.INVALID_MODEL);
  const marker = createMarker();
  const url = endpoint(provider, "generation");
  const headers = requestHeaders(provider, key, true);
  const body = probeBody(protocol, modelId, marker);
  const fetchImpl = requireFetch(fetch);
  const limitBytes = maxResponseBytesValue(options, provider);

  return requestOptions({
    fetchImpl,
    url,
    method: "POST",
    headers,
    body,
    signal,
    timeoutMs: timeoutValue(options, provider),
    consume: async (response) => {
    const status = responseStatus(response);
    assertNotRedirect(response, status);
    assertHttpOk(status);
    const payload = await readJsonResponse(response, limitBytes);
    return probeResult(protocol, payload, marker, status);
    },
  });
}

module.exports = {
  ERROR_CODES,
  ProviderDiscoveryError,
  normalizeProtocol,
  endpoint,
  authorizationHeaders,
  discoverModels,
  probeModel,
};


