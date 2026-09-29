#!/usr/bin/env node
// Writes ~/.codebuddy/models.json so official WorkBuddy model ids resolve to Bailian (DashScope).
// Key: see apiKey() below; the repo never contains a key.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const ROOT = path.resolve(__dirname, "..");
const URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
// [dashscope id, template, supportsImages, official ids routed here]
const MAP = [
  ["deepseek-v4.1-flash", "deepseek-v4.1-flash", true, ["deepseek-v4.1-flash"]],
  ["deepseek-v4-pro", "deepseek-v4.1-flash", false, ["deepseek-v4-pro"]],
  ["deepseek-v4-flash", "deepseek-v4.1-flash", false, ["deepseek-v4-flash"]],
  ["deepseek-v3.2", "deepseek-v4.1-flash", false, ["deepseek-v3-2-volc"]],
  ["glm-5.3", "glm-5.3", false, ["glm-5.3", "glm-5.3-flashx"]],
  ["glm-5.2", "glm-5.3", false, ["glm-5.2"]],
  ["glm-5.1", "glm-5.3", false, ["glm-5.1"]],
  ["glm-5", "glm-5.3", false, ["glm-5.0", "glm-5.0-turbo"]],
  ["glm-4.7", "glm-5.3", false, ["glm-4.7", "glm-4.6"]],
  ["kimi-k3", "kimi-k3", true, ["kimi-k3-1", "kimi-k3-2", "kimi-k3"]],
  ["kimi/kimi-k2.8-preview", "kimi-k3", true, ["kimi-k2.8-preview"]],
  ["kimi-k2.7-code", "kimi-k3", false, ["kimi-k2.7"]],
  ["kimi-k2.6", "kimi-k3", false, ["kimi-k2.6"]],
  ["kimi-k2.5", "kimi-k3", false, ["kimi-k2.5"]],
  ["kimi-k2-thinking", "kimi-k3", false, ["kimi-k2-thinking"]],
  ["MiniMax/MiniMax-M3", "MiniMax/MiniMax-M3", true, ["minimax-m3", "minimax-m3-pay"]],
  ["MiniMax/MiniMax-M2.7", "MiniMax/MiniMax-M3", false, ["minimax-m2.7"]],
  ["MiniMax/MiniMax-M2.5", "MiniMax/MiniMax-M3", false, ["minimax-m2.5"]],
  // Qwen borrows official slots (menu shows the official name)
  ["qwen3.8-max", "qwen3.8-max", true, ["glm-5v-turbo"]],
  ["qwen3.8-flash", "qwen3.8-flash", true, ["glm-5.3-flash"]],
];
// Official ids that stay on the official backend (Hunyuan etc.)
const KEEP = ["auto", "default", "lite", "hy4-preview", "hy4-preview-x", "hy3", "hy3-x", "hunyuan-chat",
  "hunyuan-2.0-thinking", "hunyuan-image-alpha", "hunyuan-image-alpha-edit", "hunyuan-image-v3.0-art",
  "hunyuan-image-v3.0", "hunyuan-image-v2.0-general-edit", "glm-4.6v"];

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// Key sources (first hit wins); nothing secret lives in the repo:
//   $BAILIAN_API_KEY, $BAILIAN_KEY_FILE, <plugin>/secret.json,
//   ~/.codebuddy/bailian-secret.json, /opt/keepalive/workbuddy-models/secret.json,
//   optional private key URL in $BAILIAN_KEY_URL or ~/.codebuddy/bailian-key-url,
//   then the key already present in models.json (offline fallback).
function keyFromFile(p) {
  if (!p) return "";
  const j = readJson(p);
  if (j && j.apiKey) return String(j.apiKey).trim();
  try { const s = fs.readFileSync(p, "utf8").trim(); return /^sk-[\w-]+$/.test(s) ? s : ""; } catch { return ""; }
}
async function apiKey(dst, dir) {
  if (process.env.BAILIAN_API_KEY) return process.env.BAILIAN_API_KEY.trim();
  for (const p of [process.env.BAILIAN_KEY_FILE, path.join(ROOT, "secret.json"), path.join(dir, "bailian-secret.json"),
                   "/opt/keepalive/workbuddy-models/secret.json"]) {
    const k = keyFromFile(p); if (k) return k;
  }
  let url = process.env.BAILIAN_KEY_URL || "";
  if (!url) { try { url = fs.readFileSync(path.join(dir, "bailian-key-url"), "utf8").trim(); } catch {} }
  if (url.startsWith("https://")) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (j && j.apiKey) return String(j.apiKey).trim(); }
    } catch {}
  }
  const cur = readJson(dst);
  const m = cur && Array.isArray(cur.models) && cur.models.find(x => x && x.url === URL && x.apiKey);
  return m ? m.apiKey : "";
}
function build(key) {
  const T = JSON.parse(fs.readFileSync(path.join(__dirname, "templates.json"), "utf8"));
  const models = MAP.map(([id, tpl, img, aliases]) => ({
    ...JSON.parse(JSON.stringify(T[tpl])), id, name: `百炼 / ${id}`, url: URL, apiKey: key,
    supportsImages: img, aliases: [...aliases],
  }));
  return { models, availableModels: [...KEEP, ...MAP.map(m => "custom-local:" + m[0])] };
}

async function sync() {
  const dir = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".codebuddy");
  const dst = path.join(dir, "models.json");
  const key = await apiKey(dst, dir);
  if (!key) return { ok: false, reason: "no api key" };
  const text = JSON.stringify(build(key), null, 2);
  let cur = null; try { cur = fs.readFileSync(dst, "utf8"); } catch {}
  if (cur === text) return { ok: true, changed: false, dst };
  fs.mkdirSync(dir, { recursive: true });
  if (cur !== null) { try { fs.copyFileSync(dst, dst + ".bak-bailian-plugin"); } catch {} }
  const tmp = dst + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, dst);
  return { ok: true, changed: true, dst };
}

module.exports = { sync };
if (require.main === module) {
  sync().catch(e => ({ ok: false, reason: String(e && e.message || e) }))
    .then(r => { if (!process.argv.includes("--quiet")) console.log(JSON.stringify(r)); });
}
