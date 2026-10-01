#!/usr/bin/env node
// workbuddy-3p: route WorkBuddy / CodeBuddy Code cloud model choices to your own OpenAI-compatible APIs.
// Writes only the plugin-managed part of ~/.codebuddy/models.json; user-defined entries are preserved.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const ROOT = path.resolve(__dirname, "..");
const PRESETS = path.join(ROOT, "presets");
const ENV = process.env;
const MODES = ["same-name", "preset-only", "explicit"];
const effort = require("./effort.cjs");

class ConfigError extends Error {}
const fail = (msg) => { throw new ConfigError(msg); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const envName = (s) => String(s).replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
const opt = (k) => ENV[`CODEBUDDY_PLUGIN_OPTION_${k}`] || ENV[`CLAUDE_PLUGIN_OPTION_${k}`] || "";
const configDir = () => ENV.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".codebuddy");
const paths = (dir = configDir()) => ({
  dir, models: path.join(dir, "models.json"), state: path.join(dir, "workbuddy-3p.state.json"),
  lock: path.join(dir, "workbuddy-3p.lock"), switch: path.join(dir, "workbuddy-3p.switch"),
  lastError: path.join(dir, "workbuddy-3p.last-error.json"), backup: path.join(dir, "models.json.bak-workbuddy-3p"),
  effort: path.join(dir, "workbuddy-3p.effort.json"),
});

// Missing file -> null. Existing but unreadable/invalid -> error (never silently ignored).
function readJsonStrict(p, what) {
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; fail(`${what} ${p}: ${e.message}`); }
  try { return JSON.parse(text); } catch { fail(`${what} ${p} is not valid JSON`); }
}
const readJsonLoose = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, p);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  try { fs.chmodSync(p, 0o600); } catch {}
}

// ---------- cross-process lock (SessionStart hook and MCP server start together) ----------
async function withLock(dir, fn) {
  const lock = paths(dir).lock;
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A slow credential URL is not evidence that its owning process died.
      try {
        const pid = Number(fs.readFileSync(lock, "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (err) { if (err.code === "ESRCH") { fs.unlinkSync(lock); continue; } }
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`lock busy: ${lock}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const release = () => { try { fs.unlinkSync(lock); } catch {} };
  try { const r = fn(); if (r && typeof r.then === "function") return r.finally(release); release(); return r; }
  catch (e) { release(); throw e; }
}

// ---------- switch: official <-> third-party ----------
const OFF = new Set(["official", "off", "0", "false", "no", "disabled"]);
const ON = new Set(["third-party", "thirdparty", "3p", "on", "1", "true", "yes", "enabled"]);
function parseSwitch(v, where) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v ? "third-party" : "official";
  const s = String(v).trim().toLowerCase();
  if (OFF.has(s)) return "official";
  if (ON.has(s)) return "third-party";
  fail(`${where}: expected "official" or "third-party", got ${JSON.stringify(v)}`);
}
// Precedence: switch file (set by MCP tool / CLI, per sandbox) > env/plugin option > config.enabled > on.
function resolveSwitch(dir, cfg) {
  const f = parseSwitch(readText(paths(dir).switch), "workbuddy-3p.switch");
  if (f) return { mode: f, from: "switch file" };
  const e = parseSwitch(ENV.WB3P_ENABLED, "WB3P_ENABLED") || parseSwitch(opt("ENABLED"), "plugin option ENABLED");
  if (e) return { mode: e, from: ENV.WB3P_ENABLED ? "WB3P_ENABLED" : "plugin option ENABLED" };
  if (cfg && cfg.enabled !== undefined) return { mode: parseSwitch(cfg.enabled, "config.enabled"), from: "config" };
  return { mode: "third-party", from: "default" };
}
async function setSwitch(mode) {
  const m = parseSwitch(mode, "switch");
  const p = paths();
  return withLock(p.dir, async () => {
    const previous = fs.existsSync(p.switch) ? fs.readFileSync(p.switch, "utf8") : null;
    try {
      if (!m) fs.rmSync(p.switch, { force: true }); else writeAtomic(p.switch, m + "\n");
      const result = await syncUnlocked({}, p);
      fs.rmSync(p.lastError, { force: true });
      return result;
    } catch (e) {
      if (previous === null) fs.rmSync(p.switch, { force: true }); else writeAtomic(p.switch, previous);
      recordError(p, e);
      throw e;
    }
  });
}

// ---------- config discovery ----------
function configCandidates(dir) {
  return [ENV.WB3P_CONFIG, path.join(dir, "workbuddy-3p.json"), "/etc/workbuddy-3p/config.json",
          "/opt/workbuddy-3p/config.json", path.join(ROOT, "config.json")].filter(Boolean);
}
// A private account skill carries data only. Never search public plugin caches for keys.
function cloudProfile(dir) {
  const skillDir = path.join(dir, "skills");
  let entries;
  try { entries = fs.readdirSync(skillDir, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = path.join(skillDir, entry.name, "workbuddy-3p.profile.json");
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    if (!st.isFile() || st.isSymbolicLink()) fail("cloud profile must be a regular file");
    found.push(p);
  }
  if (found.length > 1) fail("multiple cloud profiles found; keep one private workbuddy-3p profile");
  if (!found.length) return null;
  const skill = readText(path.join(path.dirname(found[0]), "SKILL.md"));
  const frontMatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontMatter || !/^name:[ \t]*workbuddy-3p-profile[ \t]*\r?$/m.test(frontMatter[1]))
    fail("cloud profile must belong to the workbuddy-3p-profile skill");
  const profile = readJsonStrict(found[0], "cloud profile");
  if (!isObj(profile) || profile.kind !== "workbuddy-3p-private-profile" || profile.version !== 1 || !isObj(profile.config))
    fail("invalid cloud profile schema");
  return { cfg: profile.config, from: found[0] };
}
function loadConfig(dir) {
  if (ENV.WB3P_CONFIG_JSON) {
    try { return { cfg: JSON.parse(ENV.WB3P_CONFIG_JSON), from: "$WB3P_CONFIG_JSON" }; }
    catch { fail("WB3P_CONFIG_JSON is not valid JSON"); }
  }
  if (ENV.WB3P_CONFIG && !fs.existsSync(ENV.WB3P_CONFIG)) fail(`WB3P_CONFIG points to a missing file: ${ENV.WB3P_CONFIG}`);
  for (const p of configCandidates(dir)) {
    const j = readJsonStrict(p, "config");
    if (j !== null || fs.existsSync(p)) return { cfg: j, from: p };
  }
  // Zero-file setup. No provider is guessed: either BASE_URL or PRESET must be given explicitly.
  const baseUrl = ENV.WB3P_BASE_URL || opt("BASE_URL");
  const preset = ENV.WB3P_PRESET || opt("PRESET");
  if (preset && !/^[\w.-]+$/.test(preset)) fail("bad preset name");
  if (!baseUrl && !preset) return cloudProfile(dir) || { cfg: null, from: "none" };
  const name = preset || "custom";
  const cfg = { providers: { [name]: { preset: preset || undefined, baseUrl: baseUrl || undefined } }, default: name };
  const routes = ENV.WB3P_ROUTES || opt("ROUTES");
  if (routes) {
    try { cfg.routes = JSON.parse(routes); } catch { fail("ROUTES is not valid JSON"); }
  }
  return { cfg, from: "env" };
}

function validateConfig(cfg) {
  if (!isObj(cfg)) fail("config must be a JSON object");
  if (!isObj(cfg.providers) || !Object.keys(cfg.providers).length) fail("config.providers must be a non-empty object");
  for (const [n, p] of Object.entries(cfg.providers)) {
    if (!isObj(p)) fail(`provider ${n} must be an object`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n)) fail("provider names must use letters, digits, dots, underscores or hyphens");
    for (const k of ["baseUrl", "label", "preset", "apiKey", "apiKeyEnv", "apiKeyFile", "apiKeyUrl"])
      if (p[k] !== undefined && typeof p[k] !== "string") fail(`provider ${n}.${k} must be a string`);
    if (p.extraModels !== undefined && !(Array.isArray(p.extraModels) && p.extraModels.every(x => typeof x === "string" && x.trim())))
      fail(`provider ${n}.extraModels must be an array of non-empty strings`);
    for (const k of ["models", "defaults"]) if (p[k] !== undefined && !isObj(p[k])) fail(`provider ${n}.${k} must be an object`);
  }
  if (cfg.default !== undefined && !cfg.providers[cfg.default]) fail(`default provider ${cfg.default} is not configured`);
  if (cfg.mode !== undefined && !MODES.includes(cfg.mode)) fail(`mode must be one of ${MODES.join(", ")}`);
  if (cfg.routes !== undefined && !isObj(cfg.routes)) fail("routes must be an object");
  if (cfg.keepOfficial !== undefined && !(Array.isArray(cfg.keepOfficial) && cfg.keepOfficial.every(x => typeof x === "string")))
    fail("keepOfficial must be an array of strings");
  for (const k of ["models", "defaults"]) if (cfg[k] !== undefined && !isObj(cfg[k])) fail(`${k} must be an object`);
  if (cfg.effort !== undefined) effort.validatePreferences(cfg.effort);
}

function loadPreset(name) {
  if (!name) return null;
  if (!/^[\w.-]+$/.test(name)) fail(`bad preset name: ${name}`);
  const p = readJsonStrict(path.join(PRESETS, name + ".json"), "preset");
  if (!p) fail(`unknown preset: ${name}`);
  return p;
}
const OFFICIAL = readJsonLoose(path.join(PRESETS, "workbuddy-official.json")) || { keepOfficial: [], routable: [] };

// ---------- persistent model-default effort (no credentials) ----------
function readEffort(p) {
  const value = readJsonStrict(p.effort, "local effort preferences");
  if (value === null && !fs.existsSync(p.effort)) return { version: 1 };
  return effort.validatePreferences(value, true);
}

function effortReport(plan, cfg, local, sw, current, state, selector) {
  const selected = selector ? effort.resolveTarget(plan, selector) : null;
  const official = sw.mode === "official";
  // Export a replacement effort object with the same precedence after moving
  // local preferences into a profile. A local default masks config per-models.
  const profileModels = { ...(local.default === undefined ? cfg.effort?.models : {}), ...local.models };
  const profileDefault = local.default ?? cfg.effort?.default;
  const models = plan.effort.models.filter(m => !selected || m.target === selected).map(m => {
    const disk = (current.models || []).find(x => x.id === m.model && state.managed.includes(x.id));
    return { ...m, applied: !official && m.applied,
      onDiskEffort: disk?.reasoning?.defaultEffort ?? disk?.reasoning?.effort ?? null,
      ...(official ? { reason: "official mode; third-party preference deferred" } : {}) };
  });
  return { ok: true, configuredMode: sw.mode, runtimeVerified: false,
    preferences: { local, config: cfg.effort || {} }, models,
    skipped: models.filter(m => !official && m.requestedSource !== "model" && !m.applied),
    orphanedTargets: plan.effort.orphanedTargets,
    profileConfigPatch: { effort: { ...(profileDefault !== undefined ? { default: profileDefault } : {}),
      ...(Object.keys(profileModels).length ? { models: profileModels } : {}) } },
    note: "These are third-party model defaults, not verified request parameters. Native session/user reasoningEffort overrides take precedence. Local changes do not synchronize the account or other sandboxes." };
}

async function effortContext(p, local) {
  const override = resolveSwitch(p.dir, null);
  let cfg, sw = override, plan;
  try {
    ({ cfg } = loadConfig(p.dir));
    if (!cfg) fail("no provider configured; effort capabilities unavailable");
    sw = resolveSwitch(p.dir, cfg);
    plan = await buildPlan(clone(cfg), p.dir, { providers: {}, keys: {} }, { metadataOnly: true, preferences: local });
  } catch (e) {
    // The explicit official escape hatch must work even with missing/bad 3P
    // config. Without capabilities, only global deferred preferences are safe.
    if (override.mode !== "official") throw e;
    return { cfg: {}, sw: override, plan: { models: [], effort: { models: [], orphanedTargets: Object.keys(local.models || {}) } },
      capabilityWarning: "third-party capabilities unavailable in official mode; model-specific changes require valid configuration" };
  }
  return { cfg, sw, plan };
}

async function effortStatus({ model } = {}) {
  const p = paths();
  return withLock(p.dir, async () => {
    const current = parseModels(fs.existsSync(p.models) ? fs.readFileSync(p.models, "utf8") : null);
    const state = readState(p); checkOwnership(current, state);
    const local = readEffort(p), { cfg, sw, plan, capabilityWarning } = await effortContext(p, local);
    return { ...effortReport(plan, cfg, local, sw, current, state, model), ...(capabilityWarning ? { capabilityWarning } : {}) };
  });
}

async function setEffort(args = {}) {
  if (!isObj(args)) fail("effort arguments must be an object");
  const action = args.action || "set", scope = args.scope || (args.model ? "model" : "default");
  if (!["set", "reset"].includes(action) || !["default", "model", "all"].includes(scope) ||
      action === "set" && scope === "all" || scope !== "model" && args.model !== undefined ||
      action === "reset" && args.level !== undefined)
    fail("invalid effort action/scope combination");
  if (action === "set" && !effort.LEVELS.includes(args.level)) fail("invalid effort level; use minimal, low, medium, high, xhigh or max");
  const p = paths();
  return withLock(p.dir, async () => {
    const previous = fs.existsSync(p.effort) ? fs.readFileSync(p.effort, "utf8") : null;
    const local = action === "reset" && scope === "all" ? { version: 1 } : clone(readEffort(p));
    const current = parseModels(fs.existsSync(p.models) ? fs.readFileSync(p.models, "utf8") : null);
    const state = readState(p); checkOwnership(current, state);
    const initial = await effortContext(p, { version: 1 });
    const baseline = initial.plan;
    let target;
    if (scope === "model") {
      target = effort.resolveTarget(baseline, args.model);
      if (action === "set") {
        const cap = baseline.effort.models.find(m => m.target === target);
        if (!cap.supportedEfforts.includes(args.level)) fail(`model ${target} does not support requested effort; supported: ${cap.supportedEfforts.join(", ") || "none"}`);
        local.models = { ...local.models, [target]: args.level };
      } else if (local.models) delete local.models[target];
    } else if (scope === "default") {
      if (action === "set") local.default = args.level; else delete local.default;
    }
    if (local.models && !Object.keys(local.models).length) delete local.models;
    const { cfg, sw, plan, capabilityWarning } = await effortContext(p, local);
    // Prepare the secret-free response before writing; reporting must not turn a
    // successful routing commit into an apparent failure with an incorrect rollback.
    const report = { ...effortReport(plan, cfg, local, sw, current, state, target), ...(capabilityWarning ? { capabilityWarning } : {}) };
    let result;
    try {
      if (previous !== null && !fs.existsSync(p.effort + ".bak-workbuddy-3p")) {
        fs.copyFileSync(p.effort, p.effort + ".bak-workbuddy-3p");
        fs.chmodSync(p.effort + ".bak-workbuddy-3p", 0o600);
      }
      if (Object.keys(local).length === 1) fs.rmSync(p.effort, { force: true });
      else writeAtomic(p.effort, JSON.stringify(local, null, 2) + "\n");
      result = await syncUnlocked({}, p);
    } catch (e) {
      try {
        if (previous === null) fs.rmSync(p.effort, { force: true }); else writeAtomic(p.effort, previous);
      } catch { fail("effort update failed and preferences rollback incomplete; restore the backup"); }
      recordError(p, e); throw e;
    }
    // Commit has succeeded. A stale diagnostic cleanup failure is not a routing
    // failure and must never roll just the preferences back after that commit.
    let cleanupWarning;
    try { fs.rmSync(p.lastError, { force: true }); } catch { cleanupWarning = "routing committed; stale error record could not be cleared"; }
    for (const m of report.models) delete m.onDiskEffort;
    const requiresModelReselection = sw.mode !== "official" || result.changed === true;
    return { ...report, changed: result.changed, preferencesChanged: previous !== (Object.keys(local).length === 1 ? null : JSON.stringify(local, null, 2) + "\n"), routingWarnings: result.warnings || [],
      ...(cleanupWarning ? { cleanupWarning } : {}), deferred: sw.mode === "official", requiresModelReselection,
      note: report.note + (requiresModelReselection ? " After the host reloads, reselect the model before the next message." : " Official routing is unchanged; no model reselection is required for this deferred preference.") + " Reset removes local overrides and falls back to config/preset defaults." };
  });
}

// ---------- api keys ----------
function keyFromFile(p) {
  if (!p) return "";
  const j = readJsonLoose(p); if (j && j.apiKey) return String(j.apiKey).trim();
  const s = readText(p); return s && !s.startsWith("{") && !/\s/.test(s) ? s : "";
}
async function keyFromUrl(url) {
  if (!url) return "";
  if (!/^https:\/\//i.test(url)) fail("apiKeyUrl must use https");
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (r.ok) { const j = await r.json(); return j && j.apiKey ? String(j.apiKey).trim() : ""; }
  } catch {}
  return "";
}
async function resolveKey(name, p, isDefault, dir, previous) {
  const E = envName(name);
  const tries = [
    ["config", () => p.apiKey],
    ["env", () => p.apiKeyEnv && ENV[p.apiKeyEnv]],
    ["env", () => ENV[`WB3P_${E}_API_KEY`]],
    ["env/option", () => isDefault && (ENV.WB3P_API_KEY || opt("API_KEY"))],
    ["file", () => keyFromFile(p.apiKeyFile)],
    ["file", () => keyFromFile(path.join(dir, "workbuddy-3p.secrets", name))],
    ["file", () => isDefault && keyFromFile(ENV.WB3P_API_KEY_FILE)],
  ];
  for (const [src, t] of tries) { const k = t(); if (k) return { key: String(k).trim(), source: src }; }
  const u = await keyFromUrl(p.apiKeyUrl || (isDefault ? ENV.WB3P_API_KEY_URL : ""));
  if (u) return { key: u, source: "url" };
  // Offline fallback: only the key this plugin previously wrote for this same provider name and URL.
  if (previous) return { key: previous, source: "previous sync" };
  return { key: "", source: "missing" };
}

// ---------- url ----------
function chatUrl(base, provider, allowHttp) {
  let u;
  try { u = new URL(String(base)); } catch { fail(`provider ${provider}: invalid baseUrl`); }
  if (u.username || u.password || u.search || u.hash) fail(`provider ${provider}: baseUrl must not include credentials, query or fragment`);
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (local || allowHttp)))
    fail(`provider ${provider}: baseUrl must use https (http is only allowed for localhost or with allowInsecureHttp)`);
  const b = String(base).replace(/\/+$/, "");
  return /\/chat\/completions$/.test(b) ? b : b + "/chat/completions";
}

// ---------- routes ----------
// Targets: "official" | "<provider>:<model>" | "<provider>" | "<model>" | { provider, model }.
function parseTarget(t, cfg, officialId, warnings) {
  if (t === "official" || t === false || t === null) return null;
  if (t === true || t === "") return { provider: cfg.default, model: officialId };
  if (isObj(t)) {
    if (t.provider !== undefined && (typeof t.provider !== "string" || !t.provider.trim())) fail(`route ${officialId}: provider must be a non-empty string`);
    if (t.model !== undefined && (typeof t.model !== "string" || !t.model.trim())) fail(`route ${officialId}: model must be a non-empty string`);
    const provider = t.provider || cfg.default;
    if (!cfg.providers[provider]) fail(`route ${officialId}: unknown provider ${provider}`);
    return { provider, model: t.model || officialId };
  }
  if (typeof t !== "string") fail(`route ${officialId}: invalid target`);
  const i = t.indexOf(":");
  if (i > 0 && cfg.providers[t.slice(0, i)]) {
    if (!t.slice(i + 1).trim()) fail(`route ${officialId}: model must not be empty`);
    return { provider: t.slice(0, i), model: t.slice(i + 1) };
  }
  if (cfg.providers[t]) return { provider: t, model: officialId };
  if (i > 0 && /^[A-Za-z][\w.-]*$/.test(t.slice(0, i)) && !t.slice(0, i).includes("/"))
    warnings.push(`route ${officialId}: "${t.slice(0, i)}" is not a configured provider; sending "${t}" as a model id to ${cfg.default}. Use {"provider":..,"model":..} to be explicit.`);
  return { provider: cfg.default, model: t };
}

// ---------- plan ----------
async function buildPlan(cfg, dir, prev, opts = {}) {
  validateConfig(cfg);
  const names = Object.keys(cfg.providers);
  cfg.default = cfg.default || names[0];
  const warnings = [];
  const P = {};
  for (const n of names) {
    const p = cfg.providers[n], preset = loadPreset(p.preset);
    const baseUrl = p.baseUrl || preset?.baseUrl;
    if (!baseUrl) fail(`provider ${n}: baseUrl missing`);
    const url = chatUrl(baseUrl, n, p.allowInsecureHttp === true);
    const prevKey = prev.providers?.[n]?.url === url ? prev.keys[n] || "" : "";
    P[n] = { ...p, name: n, preset, url, label: p.label || preset?.label || n,
      ...(opts.metadataOnly ? { key: "", source: "not resolved" } : await resolveKey(n, p, n === cfg.default, dir, prevKey)) };
  }

  const mode = cfg.mode || "same-name";
  const dp = P[cfg.default];
  const keepOfficial = new Set(cfg.keepOfficial || []);
  const routes = {};
  if (mode !== "explicit") {
    for (const id of OFFICIAL.routable || []) {
      if (dp.preset?.routes?.[id]) routes[id] = { provider: dp.name, model: dp.preset.routes[id] };
      else if (mode === "same-name" && !(dp.preset?.unsupported || []).includes(id)) routes[id] = { provider: dp.name, model: id };
    }
  }
  for (const id of keepOfficial) delete routes[id];                  // keepOfficial beats inferred routes
  for (const [id, t] of Object.entries(cfg.routes || {})) {          // explicit routes beat everything
    const r = parseTarget(t, cfg, id, warnings);
    if (r) routes[id] = r; else delete routes[id];
  }

  // One custom model per upstream model id; an id can belong to exactly one provider.
  const entries = new Map(), routed = {}, owner = new Map(), extra = [];
  const add = (provider, model, alias) => {
    const p = P[provider];
    if (!p.key && !opts.metadataOnly) { warnings.push(`provider ${provider}: no API key; ${alias || model} not added`); return false; }
    const own = owner.get(model);
    if (own && own !== provider) { warnings.push(`model id ${model} already belongs to provider ${own}; ${alias || model} via ${provider} skipped`); return false; }
    let e = entries.get(model);
    if (!e) {
      const pm = effort.mergeModel(p.preset?.models?.[model], p.models?.[model], cfg.models?.[`${provider}:${model}`]);
      const tpl = clone(p.preset?.templates?.[pm.template] || p.defaults || cfg.defaults ||
        { maxInputTokens: 128000, maxOutputTokens: 32768, supportsToolCall: true, supportsImages: false, supportsReasoning: false });
      delete pm.template;
      e = { ...effort.mergeModel(tpl, pm), id: model, name: `${p.label} / ${model}`, url: p.url, apiKey: p.key, aliases: [] };
      entries.set(model, e); owner.set(model, provider);
    }
    if (alias) { routed[alias] = { provider, model, label: `${p.label} / ${model}` }; if (alias !== model && !e.aliases.includes(alias)) e.aliases.push(alias); }
    return true;
  };
  for (const [id, r] of Object.entries(routes)) add(r.provider, r.model, id);
  for (const n of names) {
    const ids = [...(P[n].extraModels || []), ...(n === cfg.default && mode !== "explicit" ? Object.keys(dp.preset?.models || {}) : [])];
    for (const m of ids) {
      if (entries.has(m)) { if (owner.get(m) !== n) warnings.push(`model id ${m} already belongs to provider ${owner.get(m)}; extra model via ${n} skipped`); continue; }
      if (add(n, m, null)) extra.push(m);
    }
  }

  const hideOfficial = new Set(Object.keys(routed));                 // only official ids that were actually routed
  const keep = [...new Set([...(OFFICIAL.keepOfficial || []), ...(OFFICIAL.routable || []), ...keepOfficial])].filter(id => !hideOfficial.has(id));
  const models = [...entries.values()];
  const local = opts.preferences ?? readEffort(paths(dir));
  const appliedEffort = effort.applyEfforts(models, owner, local, cfg.effort || {});
  return { models, owner, routed, extra, keep, hideOfficial: [...hideOfficial], warnings, providers: P, mode, effort: appliedEffort };
}

function publicSummary(plan) {
  return {
    providers: Object.values(plan.providers).map(p => ({ name: p.name, host: new URL(p.url).host, key: p.source })),
    routed: Object.fromEntries(Object.entries(plan.routed).map(([k, v]) => [k, v.label])),
    extra: plan.extra, keptOfficial: plan.keep.length, warnings: plan.warnings,
    effort: plan.effort,
  };
}

// ---------- apply ----------
function readState(p) {
  const s = readJsonStrict(p.state, "ownership state");
  if (s === null && !fs.existsSync(p.state)) return { managed: [], allow: [], hidden: [], displaced: [], providers: {}, missing: true };
  const strings = x => Array.isArray(x) && x.every(v => typeof v === "string");
  if (!isObj(s) || !strings(s.managed) || !strings(s.allow) || !strings(s.hidden) ||
      !Array.isArray(s.displaced) || !s.displaced.every(m => isObj(m) && typeof m.id === "string") ||
      !isObj(s.providers) || !Object.values(s.providers).every(v => isObj(v) && typeof v.url === "string" && strings(v.modelIds)) ||
      (s.hadAllowlist !== undefined && typeof s.hadAllowlist !== "boolean"))
    fail("invalid ownership state; restore a backup before changing routing");
  return { managed: s.managed || [], allow: s.allow || [], hidden: s.hidden || [], displaced: s.displaced || [], providers: s.providers || {}, hadAllowlist: s.hadAllowlist };
}
function prevKeys(cur, state) {
  const keys = {};
  for (const [n, info] of Object.entries(state.providers)) {
    const m = (cur.models || []).find(x => x && (info.modelIds || []).includes(x.id) && x.url === info.url && x.apiKey);
    if (m) keys[n] = m.apiKey;
  }
  return { providers: state.providers, keys };
}

// Build the models.json content that removes everything we own and restores what we displaced.
function stripManaged(cur, state) {
  const managed = new Set(state.managed), allow = new Set(state.allow);
  const out = { ...cur, models: (cur.models || []).filter(m => !(m && managed.has(m.id))) };
  delete out.workbuddy3pManaged;
  for (const m of state.displaced) if (!out.models.some(x => x && x.id === m.id)) out.models.push(m);
  if (Array.isArray(cur.availableModels) || state.hidden.length) {
    const list = (cur.availableModels || []).filter(x => !allow.has(x));
    for (const id of state.hidden) if (!list.includes(id)) list.push(id);
    out.availableModels = list;
    // An empty allowlist would hide every model; only keep one if the user explicitly had it.
    if (!list.length && state.hadAllowlist !== true) delete out.availableModels;
  }
  return out;
}

function writeModels(p, before, text) {
  if (before === text) return false;
  if (before === null) {
    writeAtomic(p.models, text);
  } else {
    if (!fs.existsSync(p.backup)) { fs.copyFileSync(p.models, p.backup); fs.chmodSync(p.backup, 0o600); }
    // CodeBuddy 2.155 watches the inode, not the parent directory. Rename replacement
    // fires once then leaves its watcher attached to an unlinked inode. Preserve it
    // for every subsequent switch; sync/uninstall share the cross-process lock.
    const fd = fs.openSync(p.models, "r+");
    try {
      fs.fchmodSync(fd, 0o600);
      const bytes = Buffer.from(text);
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      fs.ftruncateSync(fd, bytes.length);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  return true;
}

function parseModels(text) {
  if (text === null) return {};
  let cur;
  try { cur = JSON.parse(text); } catch { fail("models.json is not valid JSON"); }
  if (!isObj(cur) || (cur.models !== undefined && (!Array.isArray(cur.models) || !cur.models.every(m => isObj(m) && typeof m.id === "string"))) ||
      (cur.availableModels !== undefined && (!Array.isArray(cur.availableModels) || !cur.availableModels.every(x => typeof x === "string"))))
    fail("invalid models.json schema");
  return cur;
}
function checkOwnership(cur, state) {
  if (cur.workbuddy3pManaged) {
    const marker = cur.workbuddy3pManaged;
    if (state.missing) fail("ownership state missing; routing state unknown; restore a backup");
    if (!isObj(marker) || marker.version !== 1 || !Array.isArray(marker.ids) ||
        JSON.stringify([...marker.ids].sort()) !== JSON.stringify([...state.managed].sort()))
      fail("ownership state does not match models.json; restore a backup");
  }
}

function recordError(p, e) {
  try { writeAtomic(p.lastError, JSON.stringify({ at: new Date().toISOString(), error: String(e && e.message || e) }, null, 2) + "\n"); } catch {}
}

// Roll back ordinary I/O failures. This is not crash-atomic across two files.
function commitRouting(p, before, out, state) {
  const previousState = fs.existsSync(p.state) ? fs.readFileSync(p.state, "utf8") : null;
  const text = JSON.stringify(out, null, 2) + "\n";
  try {
    const changed = writeModels(p, before, text);
    if (state) writeAtomic(p.state, JSON.stringify(state, null, 2) + "\n"); else fs.rmSync(p.state, { force: true });
    return changed;
  } catch {
    try {
      const current = fs.existsSync(p.models) ? fs.readFileSync(p.models, "utf8") : null;
      if (before === null) fs.rmSync(p.models, { force: true }); else writeModels(p, current, before);
      const currentState = fs.existsSync(p.state) ? fs.readFileSync(p.state, "utf8") : null;
      if (currentState !== previousState) {
        if (previousState === null) fs.rmSync(p.state, { force: true }); else writeAtomic(p.state, previousState);
      }
    } catch { fail("routing write failed and rollback incomplete; restore a backup before further changes"); }
    fail("routing write failed; previous routing restored");
  }
}

async function syncUnlocked(opts, p) {
  const before = fs.existsSync(p.models) ? fs.readFileSync(p.models, "utf8") : null;
  const cur = parseModels(before);
  const state = readState(p);
  checkOwnership(cur, state);
  const override = resolveSwitch(p.dir, null);
  const { cfg, from } = override.mode === "official" ? { cfg: null, from: "not loaded (official override)" } : loadConfig(p.dir);
  const sw = override.mode === "official" ? override : resolveSwitch(p.dir, cfg);
  if (from !== "none" && override.mode !== "official") validateConfig(cfg);
  const base = { config: from, switch: sw.mode, switchFrom: sw.from, disabled: sw.mode === "official" };

  if (!cfg || sw.mode === "official") {
    const reason = sw.mode === "official" ? "switched to official" : "no provider configured (set BASE_URL or PRESET)";
    if (opts.dryRun || !state.managed.length && !state.hidden.length && !state.displaced.length)
      return { ok: true, ...base, active: false, reason, changed: false };
    const out = stripManaged(cur, state);
    const changed = commitRouting(p, before, out, null);
    return { ok: true, ...base, active: false, reason, changed };
  }

  const plan = await buildPlan(clone(cfg), p.dir, prevKeys(cur, state));
  const summary = { ok: plan.warnings.length === 0, partial: plan.warnings.length > 0 && plan.models.length > 0, ...base, active: plan.models.length > 0, ...publicSummary(plan) };
  if (opts.dryRun) return { ...summary, plan };

  // Start from a clean baseline (our previous changes undone), then apply the new plan.
  const baseCur = stripManaged(cur, state);
  const hadAllowlist = Array.isArray(baseCur.availableModels);
  const mineIds = new Set(plan.models.map(m => m.id));
  const displaced = (baseCur.models || []).filter(m => m && mineIds.has(m.id));
  const user = (baseCur.models || []).filter(m => !(m && mineIds.has(m.id)));
  for (const m of displaced) summary.warnings.push(`user model ${m.id} is replaced while the plugin is active (restored on uninstall/official)`);
  if (displaced.length) summary.ok = false;

  const out = { ...baseCur, models: [...user, ...plan.models] };
  if (plan.models.length) out.workbuddy3pManaged = { version: 1, ids: [...mineIds] };
  const hide = new Set(plan.hideOfficial);
  const userAllow = hadAllowlist ? baseCur.availableModels : [];
  const hidden = userAllow.filter(x => hide.has(x));
  const keptUser = userAllow.filter(x => !hide.has(x));
  const allow = [...new Set([...keptUser, ...plan.keep, ...out.models.map(m => "custom-local:" + m.id)])];
  if (plan.models.length) out.availableModels = allow;

  const providersState = {};
  for (const [id, prov] of plan.owner) (providersState[prov] = providersState[prov] || { url: plan.providers[prov].url, modelIds: [] }).modelIds.push(id);
  const newState = plan.models.length ? {
    managed: [...mineIds], allow: allow.filter(x => !keptUser.includes(x)), hidden, displaced, providers: providersState,
    hadAllowlist, updatedAt: new Date().toISOString(),
  } : null;
  const changed = commitRouting(p, before, out, newState);
  return { ...summary, changed };
}

async function sync(opts = {}) {
  const p = paths();
  try {
    const r = await (opts.dryRun ? syncUnlocked(opts, p) : withLock(p.dir, () => syncUnlocked(opts, p)));
    if (!opts.dryRun) fs.rmSync(p.lastError, { force: true });
    return r;
  } catch (e) { if (!opts.dryRun) recordError(p, e); throw e; }
}

function uninstall() {
  const p = paths();
  return withLock(p.dir, () => {
    const before = fs.existsSync(p.models) ? fs.readFileSync(p.models, "utf8") : null;
    const state = readState(p);
    const cur = parseModels(before);
    checkOwnership(cur, state);
    if (before === null || !fs.existsSync(p.state)) return { ok: true, changed: false };
    const out = stripManaged(cur, state);
    const changed = commitRouting(p, before, out, null);
    return { ok: true, changed, remainingModels: out.models.length };
  });
}

function status() {
  const p = paths();
  let state, current, cfg = null, from = "none", sw = null, err = null, active = null;
  let managedModels = null;
  try {
    sw = resolveSwitch(p.dir, null);
    state = readState(p); current = parseModels(fs.existsSync(p.models) ? fs.readFileSync(p.models, "utf8") : null);
    checkOwnership(current, state);
    active = (current.models || []).some(m => state.managed.includes(m.id));
    managedModels = (current.models || []).filter(m => state.managed.includes(m.id)).length;
    if (sw.mode !== "official") { ({ cfg, from } = loadConfig(p.dir)); if (from !== "none") validateConfig(cfg); sw = resolveSwitch(p.dir, cfg); }
  } catch (e) { err = e.message; }
  return { ok: !err, configuredMode: sw?.mode, switch: sw?.mode, switchFrom: sw?.from, config: from,
           active, modelsJsonActive: active, runtimeVerified: false,
           managedModels,
           hiddenOfficial: state?.hidden || [], lastError: err ? { error: err } : readJsonLoose(p.lastError) };
}

// Probe every model of the current plan (not the last written file). Response bodies are not returned.
async function doctor() {
  const p = paths();
  if (resolveSwitch(p.dir, null).mode === "official") return { ok: true, skipped: true, reason: "official mode", results: [] };
  const cur = readJsonLoose(p.models) || {};
  const { cfg } = loadConfig(p.dir);
  if (!cfg) return { ok: false, reason: "no provider configured", results: [] };
  if (resolveSwitch(p.dir, cfg).mode === "official") return { ok: true, skipped: true, reason: "official mode", results: [] };
  const plan = await buildPlan(clone(cfg), p.dir, prevKeys(cur, readState(p)));
  const res = [];
  for (const m of plan.models) {
    const t0 = Date.now();
    try {
      const r = await fetch(m.url, { method: "POST", signal: AbortSignal.timeout(30000),
        headers: { "content-type": "application/json", authorization: `Bearer ${m.apiKey}` },
        body: JSON.stringify({ model: m.id, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 16, stream: false }) });
      await r.arrayBuffer().catch(() => {});
      res.push({ model: m.id, provider: plan.owner.get(m.id), status: r.status, ok: r.ok, ms: Date.now() - t0 });
    } catch (e) { res.push({ model: m.id, provider: plan.owner.get(m.id), status: "error", ok: false, error: e.name || "request failed" }); }
  }
  return { ok: res.every(r => r.ok), warnings: plan.warnings, results: res };
}

module.exports = { sync, uninstall, doctor, status, setSwitch, effortStatus, setEffort, ConfigError };

if (require.main === module) {
  const a = process.argv.slice(2), quiet = a.includes("--quiet");
  const val = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
  const effortFlags = ["--effort-status", "--effort-reset", "--effort"].filter(f => a.includes(f));
  // Reject the entire effort argv before any I/O. A misspelled --model must
  // never silently widen a single-model operation into a sandbox default.
  let badEffortArgs = false;
  if (effortFlags.length) {
    const allowed = new Set([effortFlags[0], "--model", "--quiet"]);
    if (effortFlags[0] === "--effort-reset") allowed.add("--all");
    const seen = new Set();
    badEffortArgs = effortFlags.length !== 1;
    for (let i = 0; i < a.length && !badEffortArgs; i++) {
      const flag = a[i];
      if (!allowed.has(flag) || seen.has(flag)) { badEffortArgs = true; break; }
      seen.add(flag);
      if (flag === "--effort" || flag === "--model") {
        const value = a[++i];
        if (!value || value.startsWith("-")) badEffortArgs = true;
      }
    }
    if (seen.has("--all") && seen.has("--model")) badEffortArgs = true;
  }
  let run;
  if (badEffortArgs) run = Promise.reject(new ConfigError("invalid or incomplete effort CLI arguments"));
  else if (a.includes("--effort-status")) run = effortStatus({ model: val("--model") });
  else if (a.includes("--effort-reset")) run = setEffort({ action: "reset", scope: a.includes("--all") ? "all" : val("--model") ? "model" : "default", model: val("--model") });
  else if (a.includes("--effort")) run = setEffort({ action: "set", level: val("--effort"), model: val("--model") });
  else if (a.includes("--uninstall")) run = Promise.resolve().then(uninstall);
  else if (a.includes("--doctor")) run = doctor();
  else if (a.includes("--status")) run = Promise.resolve().then(status);
  else if (a.includes("--official")) run = setSwitch("official");
  else if (a.includes("--third-party")) run = setSwitch("third-party");
  else if (a.includes("--switch")) run = setSwitch(val("--switch") === "clear" ? "" : val("--switch"));
  else run = sync({ dryRun: a.includes("--dry-run") }).then(r => { if (r.plan) delete r.plan; return r; });
  run.then(r => { if (!quiet) console.log(JSON.stringify(r, null, 2)); },
           e => { console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exitCode = effortFlags.length ? 1 : quiet ? 0 : 1; });
}
