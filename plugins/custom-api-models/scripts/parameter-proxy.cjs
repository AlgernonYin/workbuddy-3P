"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { listenFetchSafe } = require("./loopback-ports.cjs");

const HOST = "127.0.0.1";
const HEALTH_PATH = "/_wb3p/health";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 600000;
const THINKING_FIELDS = [
  "enable_thinking",
  "reasoning_effort",
  "reasoning",
  "thinking",
  "thinking_budget",
  "thinkingLevel",
  "thinking_level",
];
const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-request-id",
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "cache-control",
  "content-type",
  "request-id",
  "retry-after",
  "x-request-id",
]);
const ERROR_MESSAGES = {
  400: "invalid request",
  401: "unauthorized",
  404: "not found",
  405: "method not allowed",
  410: "model unavailable",
  413: "payload too large",
  429: "too many requests",
  502: "upstream request failed",
};

class RequestError extends Error {
  constructor(status) {
    super(ERROR_MESSAGES[status] || "request failed");
    this.status = status;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function hmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}
const proxyToken = (secret, serverId, modelId) => hmac(secret, `client:${serverId}:${modelId}`);
const proxyUrl = (port, modelId) => `http://${HOST}:${port}/models/${encodeModelId(modelId)}/chat/completions`;

function encodeModelId(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new TypeError("modelId must be a non-empty string");
  }
  return Buffer.from(modelId, "utf8").toString("base64url");
}

function decodeModelId(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) return null;
  const modelId = bytes.toString("utf8");
  if (!modelId || !Buffer.from(modelId, "utf8").equals(bytes)) return null;
  return modelId;
}

function copyStringHeader(headers, target, name) {
  const value = headers[name];
  if (typeof value === "string" && value.length > 0) target[name] = value;
}

function buildUpstreamHeaders(req, apiKey) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (REQUEST_HEADER_ALLOWLIST.has(name) && typeof value === "string" && value.length > 0) {
      headers[name] = value;
    }
  }
  headers.authorization = `Bearer ${apiKey}`;
  headers["accept-encoding"] = "identity";
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  return headers;
}

function copyResponseHeaders(upstreamHeaders, res) {
  upstreamHeaders.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (RESPONSE_HEADER_ALLOWLIST.has(lower) || lower.startsWith("openai-")) {
      res.setHeader(name, value);
    }
  });
  res.setHeader("x-content-type-options", "nosniff");
}

function sendJson(res, status, value) {
  if (res.headersSent || res.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(bytes.length));
  res.setHeader("cache-control", "no-store");
  res.end(bytes);
}

function sendError(res, status) {
  sendJson(res, status, { error: { message: ERROR_MESSAGES[status] || "request failed" } });
}

function parseContentLength(header) {
  if (header === undefined) return null;
  if (typeof header !== "string" || !/^\d+$/.test(header.trim())) throw new RequestError(400);
  const value = Number(header);
  if (!Number.isSafeInteger(value)) throw new RequestError(400);
  return value;
}

function releaseBody(state) {
  if (!state || state.bodyReleased) return;
  state.bodyReleased = true;
  state.budget.bytes -= state.bodyBytes;
  if (state.budget.bytes < 0) state.budget.bytes = 0;
  state.bodyBytes = 0;
}

function readRequestBody(req, state) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      state.controller.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };

    const stopReading = () => {
      req.removeListener("data", onData);
      req.resume();
    };

    const onData = (chunk) => {
      if (settled) return;
      const length = chunk.length;
      if (state.bodyBytes + length > MAX_BODY_BYTES ||
          state.budget.bytes + length > MAX_AGGREGATE_BYTES) {
        stopReading();
        finish(new RequestError(413));
        return;
      }
      state.bodyBytes += length;
      state.budget.bytes += length;
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, state.bodyBytes));
    const onError = () => finish(new RequestError(400));
    const onAborted = () => {
      state.clientGone = true;
      finish(new RequestError(400));
    };
    const onAbort = () => finish(new RequestError(502));

    try {
      const contentLength = parseContentLength(req.headers["content-length"]);
      if (contentLength !== null && contentLength > MAX_BODY_BYTES) {
        req.resume();
        finish(new RequestError(413));
        return;
      }
      const contentEncoding = req.headers["content-encoding"];
      if (contentEncoding && contentEncoding !== "identity") {
        req.resume();
        finish(new RequestError(413));
        return;
      }
      if (state.controller.signal.aborted) {
        finish(new RequestError(502));
        return;
      }
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("aborted", onAborted);
      state.controller.signal.addEventListener("abort", onAbort, { once: true });
    } catch (error) {
      finish(error instanceof RequestError ? error : new RequestError(400));
    }
  });
}

function parseJsonBody(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!isObject(parsed)) throw new Error("body is not an object");
    return parsed;
  } catch {
    throw new RequestError(400);
  }
}

function bearerTokenMatches(req, expected) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer[ \t]+([A-Za-z0-9_-]+)$/i.exec(header);
  if (!match) return false;
  const actualBytes = Buffer.from(match[1], "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function forceParameters(body, model) {
  if (!isObject(body)) return body;
  const result = { ...body };
  if (!isObject(model)) return result;
  const format = model.compat && model.compat.thinkingFormat;
  if (format !== "qwen" && format !== "openai") return result;
  const reasoning = isObject(model.reasoning) ? model.reasoning : {};
  const level = reasoning.defaultEffort !== undefined ? reasoning.defaultEffort : reasoning.effort;
  // Native off projection disables supportsReasoning but retains this explicit
  // provider policy. It still needs enable_thinking=false, not just field removal.
  if (model.supportsReasoning !== true && level !== "off") return result;
  for (const field of THINKING_FIELDS) delete result[field];

  const map = isObject(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
  const mapped = map ? (own(map, level) ? map[level] : undefined)
    : Array.isArray(reasoning.supportedEfforts) && reasoning.supportedEfforts.includes(level) ? level : undefined;
  const canToggle = model.onlyReasoning !== true && reasoning.canDisableThinking === true &&
    map && map.off !== null && map.off !== undefined;
  const off = level === "off";
  const active = !off || model.onlyReasoning === true;

  if (format === "qwen") {
    if (off && canToggle) result.enable_thinking = false;
    else if (active && (model.onlyReasoning === true || canToggle)) result.enable_thinking = true;
  }

  if (active && model.compat.supportsReasoningEffort === true &&
      typeof mapped === "string" && mapped !== "none") {
    result.reasoning_effort = mapped;
  }
  return result;
}

function validateRoute(route, modelId) {
  if (!isObject(route) || !isObject(route.model) ||
      (route.priority !== "3p" && route.priority !== "native") ||
      route.model.id !== modelId || typeof route.url !== "string" || typeof route.apiKey !== "string" || route.apiKey.length === 0) {
    throw new RequestError(502);
  }
  let parsed;
  try {
    parsed = new URL(route.url);
  } catch {
    throw new RequestError(502);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RequestError(502);
  }
}

async function streamUpstream(response, res) {
  res.statusCode = response.status;
  copyResponseHeaders(response.headers, res);
  res.flushHeaders();
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
}

async function createParameterProxy(options) {
  const { secret, serverId, readRoute } = options || {};
  if ((typeof secret !== "string" && !Buffer.isBuffer(secret)) ||
      (typeof secret === "string" && secret.length === 0) ||
      (Buffer.isBuffer(secret) && secret.length === 0)) {
    throw new TypeError("secret must be a non-empty string or Buffer");
  }
  if (typeof serverId !== "string" || serverId.length === 0) {
    throw new TypeError("serverId must be a non-empty string");
  }
  if (typeof readRoute !== "function") throw new TypeError("readRoute must be a function");
  if (typeof globalThis.fetch !== "function") throw new Error("Node.js 18+ fetch support is required");

  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");

  const tokenFor = (modelId) => proxyToken(secret, serverId, modelId);

  let activeRequests = 0;
  const budget = { bytes: 0 };
  const inFlight = new Set();
  const sockets = new Set();
  let closing = false;
  let closePromise = null;
  let activity = Date.now();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent && !res.writableEnded) sendError(res, 502);
      else if (!res.writableEnded) res.destroy();
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  async function handleRequest(req, res) {
    activity = Date.now();
    const parsedUrl = new URL(req.url || "/", `http://${HOST}`);
    if (req.method === "GET" && parsedUrl.pathname === HEALTH_PATH) {
      const keys = [...parsedUrl.searchParams.keys()];
      const nonce = parsedUrl.searchParams.get("nonce");
      if (keys.length !== 1 || keys[0] !== "nonce" || !/^[0-9a-fA-F]{64}$/.test(nonce || "")) {
        sendError(res, 400);
        return;
      }
      sendJson(res, 200, {
        serverId,
        proof: hmac(secret, `health:${serverId}:${nonce}`),
      });
      return;
    }

    const match = /^\/models\/([A-Za-z0-9_-]+)\/chat\/completions$/.exec(parsedUrl.pathname);
    if (!match) {
      sendError(res, 404);
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendError(res, 405);
      return;
    }
    if (parsedUrl.search) {
      sendError(res, 400);
      return;
    }

    const modelId = decodeModelId(match[1]);
    if (!modelId) {
      sendError(res, 404);
      return;
    }
    if (!bearerTokenMatches(req, tokenFor(modelId))) {
      sendError(res, 401);
      return;
    }
    if (closing) { sendError(res, 410); return; }
    if (activeRequests >= MAX_CONCURRENCY) {
      sendError(res, 429);
      return;
    }

    activeRequests += 1;
    let state = null;
    let onClientGone = null;
    try {
      state = {
        budget,
        bodyBytes: 0,
        bodyReleased: false,
        clientGone: false,
        closing: false,
        controller: new AbortController(),
        timer: null,
      };
      inFlight.add(state);
      state.timer = setTimeout(() => state.controller.abort(), timeoutMs);
      if (typeof state.timer.unref === "function") state.timer.unref();

      onClientGone = () => {
        if (res.writableEnded) return;
        state.clientGone = true;
        state.controller.abort();
      };
      res.once("close", onClientGone);
      req.once("aborted", onClientGone);

      const rawBody = await readRequestBody(req, state);
      const body = parseJsonBody(rawBody);
      if (body.model !== modelId) throw new RequestError(400);

      let route;
      try {
        route = await readRoute(modelId);
      } catch {
        throw new RequestError(502);
      }
      if (route === null) throw new RequestError(410);
      validateRoute(route, modelId);

      const selected = route.priority === "3p" ? forceParameters(body, route.model) : body;
      // Routing changes the model identifier only; protocol, content, tools and SSE remain native.
      const outboundBody = route.upstreamModel ? { ...selected, model: route.upstreamModel } : selected;
      const outboundBytes = Buffer.from(JSON.stringify(outboundBody), "utf8");
      if (outboundBytes.length > MAX_BODY_BYTES) throw new RequestError(413);

      let upstream;
      try {
        upstream = await fetch(route.url, {
          method: "POST",
          headers: buildUpstreamHeaders(req, route.apiKey),
          body: outboundBytes,
          redirect: "error",
          signal: state.controller.signal,
        });
      } catch {
        throw new RequestError(502);
      }

      if (!upstream.ok) {
        try { await upstream.body?.cancel(); } catch {}
        throw new RequestError(502);
      }
      await streamUpstream(upstream, res);
    } catch (error) {
      if (state && state.closing) return;
      if (state && state.clientGone) return;
      const status = error instanceof RequestError ? error.status : 502;
      if (!res.headersSent && !res.writableEnded) sendError(res, status);
      else if (!res.writableEnded) res.destroy();
    } finally {
      if (onClientGone) {
        res.removeListener("close", onClientGone);
        req.removeListener("aborted", onClientGone);
      }
      if (state) {
        if (state.timer) clearTimeout(state.timer);
        inFlight.delete(state);
        releaseBody(state);
      }
      activeRequests -= 1;
      activity = Date.now();
    }
  }

  const port = await listenFetchSafe(server);
  const urlFor = (modelId) => proxyUrl(port, modelId);

  return {
    port,
    urlFor,
    tokenFor,
    lastActivity: () => activeRequests > 0 ? Date.now() : activity,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise((resolve) => {
        for (const state of inFlight) {
          state.closing = true;
          state.controller.abort();
        }
        for (const socket of sockets) socket.destroy();
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close(() => resolve());
      });
      return closePromise;
    },
  };
}

module.exports = {
  createParameterProxy,
  forceParameters,
  proxyUrl,
  proxyToken,
};
