#!/usr/bin/env node
// workbuddy-3p: route WorkBuddy / CodeBuddy Code cloud models to your own OpenAI-compatible APIs.
// Writes the plugin-managed part of ~/.codebuddy/models.json; user-defined entries are preserved.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const ROOT = path.resolve(__dirname, "..");
const PRESETS = path.join(ROOT, "presets");
const ENV = process.env;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const envName = (s) => String(s).replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
const opt = (k) => ENV[`CODEBUDDY_PLUGIN_OPTION_${k}`] || ENV[`CLAUDE_PLUGIN_OPTION_${k}`] || "";
const configDir = () => ENV.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".codebuddy");

// ---------- config discovery ----------
function configCandidates(dir) {
  return [ENV.WB3P_CONFIG, path.join(dir, "workbuddy-3p.json"), "/etc/workbuddy-3p/config.json",
          "/opt/workbuddy-3p/config.json", path.join(ROOT, "config.json")].filter(Boolean);
}
function loadConfig(dir) {
  if (ENV.WB3P_CONFIG_JSON) { try { return { cfg: JSON.parse(ENV.WB3P_CONFIG_JSON), from: "$WB3P_CONFIG_JSON" }; } catch {} }
  for (const p of configCandidates(dir)) { const j = readJson(p); if (j) return { cfg: j, from: p }; }
  // Zero-file setup: environment variables / plugin options only.
  const baseUrl = ENV.WB3P_BASE_URL || opt("BASE_URL");
  const preset = ENV.WB3P_PRESET || opt("PRESET") || (baseUrl ? "" : "bailian");
  const name = preset || "custom";
  const cfg = { providers: { [name]: { preset: preset || undefined, baseUrl: baseUrl || undefined } }, default: name };
  const routes = ENV.WB3P_ROUTES || opt("ROUTES");
  if (routes) { try { cfg.routes = JSON.parse(routes); } catch {} }
  return { cfg, from: "env" };
}

function loadPreset(name) {
  if (!name) return null;
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad preset name: ${name}`);
  const p = readJson(path.join(PRESETS, name + ".json"));
  if (!p) throw new Error(`unknown preset: ${name}`);
  return p;
}
const OFFICIAL = readJson(path.join(PRESETS, "workbuddy-official.json")) || { keepOfficial: [], routable: [] };

// ---------- api keys ----------
function keyFromFile(p) {
  if (!p) return "";
  const j = readJson(p); if (j && j.apiKey) return String(j.apiKey).trim();
  const s = readText(p); return s && !s.startsWith("{") && !/\s/.test(s) ? s : "";
}
async function keyFromUrl(url) {
  if (!/^https:\/\//.test(url || "")) return "";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (r.ok) { const j = await r.json(); return j && j.apiKey ? String(j.apiKey).trim() : ""; }
  } catch {}
  return "";
}
async function resolveKey(name, p, isDefault, dir, previous) {
  const E = envName(name);
  const tries = [
    () => p.apiKey,
    () => p.apiKeyEnv && ENV[p.apiKeyEnv],
    () => ENV[`WB3P_${E}_API_KEY`],
    () => isDefault && (ENV.WB3P_API_KEY || opt("API_KEY")),
    () => keyFromFile(p.apiKeyFile),
    () => keyFromFile(path.join(dir, "workbuddy-3p.secrets", name)),
    () => isDefault && keyFromFile(ENV.WB3P_API_KEY_FILE),
  ];
  for (const t of tries) { const k = t(); if (k) return { key: String(k).trim(), source: "local" }; }
  const u = await keyFromUrl(p.apiKeyUrl || (isDefault ? ENV.WB3P_API_KEY_URL : ""));
  if (u) return { key: u, source: "url" };
  if (previous) return { key: previous, source: "previous models.json" };
  return { key: "", source: "missing" };
}

// ---------- build ----------
// A route target is "official", "<provider>:<model>", "<provider>" (same-name) or "<model>" (default provider).
function parseTarget(t, cfg, officialId) {
  if (t === "official" || t === false || t === null) return null;
  if (t === true || t === undefined || t === "") return { provider: cfg.default, model: officialId };
  const s = String(t), i = s.indexOf(":");
  if (i > 0 && cfg.providers[s.slice(0, i)]) return { provider: s.slice(0, i), model: s.slice(i + 1) };
  if (cfg.providers[s]) return { provider: s, model: officialId };
  return { provider: cfg.default, model: s };
}

function chatUrl(base) {
  const b = String(base || "").replace(/\/+$/, "");
  return /\/chat\/completions$/.test(b) ? b : b + "/chat/completions";
}

async function build(cfg, dir, prevModels) {
  const providers = cfg.providers || {};
  const names = Object.keys(providers);
  if (!names.length) throw new Error("no providers configured");
  cfg.default = cfg.default && providers[cfg.default] ? cfg.default : names[0];
  const P = {};
  for (const n of names) {
    const p = providers[n] || {}, preset = loadPreset(p.preset);
    const baseUrl = p.baseUrl || preset?.baseUrl;
    if (!baseUrl) throw new Error(`provider ${n}: baseUrl missing`);
    const url = chatUrl(baseUrl);
    const prev = prevModels.find(m => m && m.url === url && m.apiKey)?.apiKey || "";
    P[n] = { ...p, name: n, preset, url, label: p.label || preset?.label || n, ...(await resolveKey(n, p, n === cfg.default, dir, prev)) };
  }

  // 1. routes: preset mapping of the default provider -> same-name for other known ids -> user overrides.
  const mode = cfg.mode || "same-name"; // "same-name" | "preset-only" | "explicit"
  const routes = {};
  const dp = P[cfg.default];
  if (mode !== "explicit") {
    for (const id of OFFICIAL.routable || []) {
      if (dp.preset?.routes?.[id]) routes[id] = { provider: dp.name, model: dp.preset.routes[id] };
      else if (mode === "same-name" && !(dp.preset?.unsupported || []).includes(id)) routes[id] = { provider: dp.name, model: id };
    }
  }
  for (const [id, t] of Object.entries(cfg.routes || {})) {
    const r = parseTarget(t, cfg, id);
    if (r) routes[id] = r; else delete routes[id];
  }

  // 2. one custom model per (provider, upstream model); official ids become aliases.
  const entries = new Map(), warnings = [], routed = {};
  const addModel = (provider, model, alias) => {
    const p = P[provider];
    if (!p) { warnings.push(`route ${alias}: unknown provider ${provider}`); return; }
    if (!p.key) { warnings.push(`provider ${provider}: no api key, ${alias} stays official`); return; }
    let e = [...entries.values()].find(x => x.id === model);
    if (e && e.url !== p.url) { warnings.push(`model id ${model} used by two providers; ${alias} skipped`); return; }
    if (!e) {
      const pm = { ...(p.preset?.models?.[model] || {}), ...(p.models?.[model] || {}), ...(cfg.models?.[`${provider}:${model}`] || {}) };
      const tpl = clone(p.preset?.templates?.[pm.template] || p.defaults || cfg.defaults || {
        maxInputTokens: 128000, maxOutputTokens: 32768, supportsToolCall: true, supportsImages: false, supportsReasoning: false,
      });
      delete pm.template;
      e = { ...tpl, ...pm, id: model, name: `${p.label} / ${model}`, url: p.url, apiKey: p.key, aliases: [] };
      entries.set(`${provider}\u0000${model}`, e);
    }
    if (alias) { e.routed = true; routed[alias] = `${p.label} / ${model}`; if (alias !== model && !e.aliases.includes(alias)) e.aliases.push(alias); }
  };
  for (const [id, r] of Object.entries(routes)) addModel(r.provider, r.model, id);
  // Extra models exposed without replacing an official slot (e.g. qwen for a custom picker / CLI).
  for (const n of names) for (const m of [...(P[n].extraModels || []), ...(n === cfg.default && mode !== "explicit" ? Object.keys(dp.preset?.models || {}) : [])])
    addModel(n, m, null);

  const extraIds = [];
  const routedIds = new Set([...entries.values()].flatMap(e => e.routed ? [e.id, ...e.aliases] : [...e.aliases]));
  const keep = [...new Set([...(OFFICIAL.keepOfficial || []), ...(OFFICIAL.routable || []), ...(cfg.keepOfficial || [])])]
    .filter(id => !routedIds.has(id));
  const models = [...entries.values()].map(e => { const extra = !e.routed; delete e.routed; if (extra) extraIds.push(e.id); return e; });
  return { models, keep, warnings, providers: P, routed, extra: extraIds };
}

// ---------- merge & write ----------
async function sync(opts = {}) {
  const dir = configDir(), dst = path.join(dir, "models.json"), statePath = path.join(dir, "workbuddy-3p.state.json");
  const cur = readJson(dst) || {}, state = readJson(statePath) || { managed: [] };
  const managed = new Set(state.managed || []);
  const userModels = (cur.models || []).filter(m => m && !managed.has(m.id));
  const prevManaged = (cur.models || []).filter(m => m && managed.has(m.id));
  const { cfg, from } = loadConfig(dir);
  if (cfg.enabled === false) return { ...(opts.dryRun ? { changed: false } : uninstall()), disabled: true, config: from };
  const b = await build(clone(cfg), dir, prevManaged);

  const mineIds = new Set(b.models.map(m => m.id));
  const user = userModels.filter(m => !mineIds.has(m.id));
  const out = { ...cur, models: [...user, ...b.models] };
  // availableModels: kept official ids + all custom models (ours and the user's). Existing user allowlist entries are kept.
  const userAllow = Array.isArray(cur.availableModels) ? cur.availableModels.filter(x => !(state.allow || []).includes(x)) : [];
  const allow = [...new Set([...userAllow, ...b.keep, ...out.models.map(m => "custom-local:" + m.id)])];
  if (b.models.length) out.availableModels = allow; else if (!userAllow.length) delete out.availableModels;

  const summary = {
    ok: b.models.length > 0 || !b.warnings.length, config: from, providers: Object.values(b.providers).map(p => ({ name: p.name, url: p.url, key: p.source })),
    routed: b.routed, extra: b.extra,
    keptOfficial: b.keep.length, userModelsPreserved: user.length, warnings: b.warnings,
  };
  if (opts.dryRun) return summary;
  // Nothing to manage and nothing managed before: leave the user's files untouched.
  if (!b.models.length && !managed.size) return { ...summary, changed: false };
  const text = JSON.stringify(out, null, 2) + "\n";
  const before = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : null;
  if (before !== text) {
    fs.mkdirSync(dir, { recursive: true });
    if (before !== null && !fs.existsSync(dst + ".bak-workbuddy-3p")) fs.copyFileSync(dst, dst + ".bak-workbuddy-3p");
    const tmp = `${dst}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, dst); fs.chmodSync(dst, 0o600);
  }
  const newState = { managed: [...mineIds], allow: b.models.length ? allow.filter(x => !userAllow.includes(x)) : [], updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath, JSON.stringify(newState, null, 2), { mode: 0o600 });
  return { ...summary, changed: before !== text, dst };
}

// Remove everything this plugin wrote, keeping user entries.
function uninstall() {
  const dir = configDir(), dst = path.join(dir, "models.json"), statePath = path.join(dir, "workbuddy-3p.state.json");
  const cur = readJson(dst), state = readJson(statePath);
  if (!cur || !state) return { ok: true, changed: false };
  const managed = new Set(state.managed || []), allow = new Set(state.allow || []);
  cur.models = (cur.models || []).filter(m => !managed.has(m.id));
  if (Array.isArray(cur.availableModels)) {
    cur.availableModels = cur.availableModels.filter(x => !allow.has(x));
    if (!cur.availableModels.length) delete cur.availableModels;
  }
  fs.writeFileSync(dst, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  fs.unlinkSync(statePath);
  return { ok: true, changed: true, remainingModels: cur.models.length };
}

// Send one tiny request per routed upstream model (no key is printed).
async function doctor() {
  const s = await sync({ dryRun: true });
  const cur = readJson(path.join(configDir(), "models.json")) || { models: [] };
  const state = readJson(path.join(configDir(), "workbuddy-3p.state.json")) || { managed: [] };
  const res = [];
  for (const m of cur.models.filter(x => state.managed.includes(x.id))) {
    const t0 = Date.now();
    try {
      const r = await fetch(m.url, { method: "POST", signal: AbortSignal.timeout(30000),
        headers: { "content-type": "application/json", authorization: `Bearer ${m.apiKey}` },
        body: JSON.stringify({ model: m.id, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 16, stream: false }) });
      res.push({ model: m.id, status: r.status, ms: Date.now() - t0, error: r.ok ? undefined : (await r.text()).slice(0, 160) });
    } catch (e) { res.push({ model: m.id, status: "error", error: String(e.message || e).slice(0, 160) }); }
  }
  return { plan: { providers: s.providers, warnings: s.warnings }, results: res };
}

module.exports = { sync, uninstall, doctor };
if (require.main === module) {
  const a = process.argv.slice(2), quiet = a.includes("--quiet");
  const run = a.includes("--uninstall") ? Promise.resolve(uninstall()) : a.includes("--doctor") ? doctor() : sync({ dryRun: a.includes("--dry-run") });
  run.then(r => { if (!quiet) console.log(JSON.stringify(r, null, 2)); },
           e => { if (!quiet) console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exitCode = quiet ? 0 : 1; });
}
