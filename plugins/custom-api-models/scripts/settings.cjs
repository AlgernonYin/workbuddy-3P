"use strict";
// Settings mutation runs under the routing lock; no HTTP settings/control API.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const effort = require("./effort.cjs"), context = require("./context.cjs");
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));
const reject = message => { throw Error(message); };
const fields = (v, allowed) => { if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) reject("unknown or invalid settings field"); };
const strings = v => Array.isArray(v) && v.every(s => typeof s === "string" && s.trim() && s.length < 512);
const hash = v => crypto.createHash("sha256").update(v).digest("hex");
const bytes = p => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
const json = p => { const s = bytes(p); return s === null ? null : JSON.parse(s); };
const safeObject = v => object(v) && !Object.keys(v).some(k => ["__proto__", "constructor", "prototype"].includes(k));

module.exports = function create(core) {
  // Opaque process-local revision: credential changes remain detectable without
  // exposing a deterministic digest usable to guess a low-entropy proxy token.
  const revisionKey = crypto.randomBytes(32);
  const revision = v => crypto.createHmac("sha256", revisionKey).update(v).digest("hex");
  function snapshot(p) {
    const { cfg, from } = core.loadConfig(p.dir);
    const raw = from && !["none", "env", "$WB3P_CONFIG_JSON"].includes(from) ? bytes(from) : JSON.stringify(cfg);
    const files = Object.fromEntries(["models", "state", "effort", "context", "switch", "parameters"].map(k => [k, bytes(p[k])]));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)));
    return { cfg, from, raw, files, revision: revision(JSON.stringify([from, raw, files, core.resolveSwitch(p.dir, cfg), environment, core.presetFingerprint()])) };
  }
  async function viewUnlocked(p) {
    const snap = snapshot(p), cfg = snap.cfg;
    const sw = core.resolveSwitch(p.dir, cfg);
    const local = core.readEffort(p), ctx = context.validate(json(p.context) || { version: 1 });
    const plan = cfg ? await core.buildPlan(clone(cfg), p.dir, { providers: {}, keys: {} },
      { metadataOnly: true, preferences: local, contextPreferences: ctx }) : null;
    const state = {
      ok: true, revision: snap.revision, configuredMode: sw.mode, runtimeVerified: false,
      sourceKind: !cfg ? "none" : snap.from === "env" || snap.from === "$WB3P_CONFIG_JSON" ? "environment" :
        snap.from.endsWith("workbuddy-3p.profile.json") ? "private-profile" : "file",
      readOnly: snap.from === "$WB3P_CONFIG_JSON", defaultProvider: cfg?.default || Object.keys(cfg?.providers || {})[0] || "",
      routingMode: cfg?.mode || "same-name",
      parameterPriority: core.readParameters(p).priority,
      providers: Object.entries(cfg?.providers || {}).map(([id, v]) => ({ id, label: v.label || "", preset: v.preset || "",
        baseUrl: v.baseUrl || plan?.providers[id]?.preset?.baseUrl || "", extraModels: v.extraModels || [],
        credential: { configured: v.apiKey || v.apiKeyEnv || v.apiKeyFile || v.apiKeyUrl ? true : null,
          kind: v.apiKey ? "inline" : v.apiKeyEnv ? "environment" : v.apiKeyFile ? "file" : v.apiKeyUrl ? "private-url" : "runtime" } })),
      routes: cfg?.routes || {},
      models: (plan?.models || []).map(m => ({ target: `${plan.owner.get(m.id)}:${m.id}`, id: m.id,
        aliases: m.aliases, ...plan.effort.models.find(e => e.model === m.id),
        ...plan.contexts.find(c => c.target === `${plan.owner.get(m.id)}:${m.id}`), maxOutputTokens: m.maxOutputTokens })),
      note: "Current sandbox only; account defaults require re-uploading your private profile. 3p priority enforces declared thinking parameters in a loopback adapter on THIS plugin host; native priority uses host parameters. Official models bypass it. Values are configuration, not runtime proof. Refresh the host catalog then reselect the model. Context is a host input limit, not a provider capacity expansion. API keys are never returned."
    };
    return state;
  }
  function patchConfig(cfg, patch) {
    for (const key of ["defaultProvider", "routingMode"]) if (patch[key] !== undefined && typeof patch[key] !== "string") reject("invalid provider or routing mode");
    if (patch.defaultProvider !== undefined) cfg.default = patch.defaultProvider;
    if (patch.routingMode !== undefined) cfg.mode = patch.routingMode;
    if (patch.providers !== undefined) {
      if (!safeObject(patch.providers)) reject("invalid provider patch");
      cfg.providers ||= {};
      for (const [id, edit] of Object.entries(patch.providers)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) reject("invalid provider name");
        if (edit === null) { delete cfg.providers[id]; continue; }
        fields(edit, ["label", "preset", "baseUrl", "extraModels", "apiKeyEnv", "reuseCredential"]);
        const before = cfg.providers[id] || {};
        const after = { ...before };
        for (const k of ["label", "preset", "baseUrl", "apiKeyEnv"]) if (edit[k] !== undefined) {
          if (typeof edit[k] !== "string" || edit[k].length > 2048) reject("invalid provider text field");
          if (edit[k]) after[k] = edit[k]; else delete after[k];
        }
        if (edit.extraModels !== undefined) { if (!strings(edit.extraModels)) reject("invalid extra models"); after.extraModels = [...new Set(edit.extraModels)]; }
        if (edit.reuseCredential !== undefined && typeof edit.reuseCredential !== "boolean") reject("invalid credential reuse choice");
        if (edit.apiKeyEnv) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(edit.apiKeyEnv)) reject("invalid credential environment name");
          for (const k of ["apiKey", "apiKeyFile", "apiKeyUrl"]) delete after[k];
        } else if ((after.baseUrl !== before.baseUrl || after.preset !== before.preset) && Object.keys(before).length && edit.reuseCredential !== true) {
          reject("endpoint change requires an explicit credential reference or reuseCredential=true; existing keys are not silently forwarded");
        }
        cfg.providers[id] = after;
      }
    }
    if (patch.routes !== undefined) {
      if (!safeObject(patch.routes)) reject("invalid routes patch");
      cfg.routes ||= {};
      for (const [id, target] of Object.entries(patch.routes)) {
        if (!id.trim() || id.length > 512) reject("invalid route name");
        if (target === null) delete cfg.routes[id];
        else { if (typeof target !== "string" || !target.trim() || target.length > 512) reject("invalid route target"); cfg.routes[id] = target; }
      }
    }
  }
  async function applyUnlocked(p, args) {
    fields(args, ["action", "expectedRevision", "patch"]);
    if (args.action !== "apply" || typeof args.expectedRevision !== "string") reject("settings apply requires expectedRevision");
    fields(args.patch, ["switchMode", "efforts", "contexts", "maxEffort", "providers", "routes", "defaultProvider", "routingMode", "parameterPriority"]);
    const patch = args.patch, snap = snapshot(p);
    if (snap.revision !== args.expectedRevision) reject("settings changed; reopen the panel before applying");
    const parameters = patch.parameterPriority === undefined ? core.readParameters(p) : { version: 1, priority: patch.parameterPriority };
    if (!["3p", "native"].includes(parameters.priority)) reject("invalid parameter priority");
    const configChange = ["providers", "routes", "defaultProvider", "routingMode"].some(k => patch[k] !== undefined);
    if (configChange && snap.from === "$WB3P_CONFIG_JSON") reject("WB3P_CONFIG_JSON is read-only; edit its owner, not a lower-priority file");
    const cfg = clone(snap.cfg || { providers: {} });
    patchConfig(cfg, patch);
    const prefs = clone(core.readEffort(p)), limits = context.validate(json(p.context) || { version: 1 });
    const sw = patch.switchMode === undefined ? core.resolveSwitch(p.dir, cfg) : patch.switchMode === "default"
      ? core.resolveSwitch(p.dir, cfg, true) : { mode: patch.switchMode };
    if (patch.switchMode !== undefined && !["official", "third-party", "default"].includes(patch.switchMode)) reject("invalid model source");
    if (patch.maxEffort !== undefined && typeof patch.maxEffort !== "boolean") reject("invalid maximum effort choice");
    if (patch.maxEffort && patch.efforts !== undefined) reject("choose maximum efforts or explicit efforts, not both");
    const original = core.parseModels(snap.files.models), ownership = core.readState(p);
    core.checkOwnership(original, ownership);
    const base = Object.keys(cfg.providers || {}).length ? await core.buildPlan(clone(cfg), p.dir, { providers: {}, keys: {} },
      { metadataOnly: true, preferences: { version: 1 }, contextPreferences: { version: 1 }, parameterPriority: parameters.priority }) : null;
    const effortEdits = patch.maxEffort ? Object.fromEntries((base?.effort.models || []).filter(m => m.supportedEfforts.length || m.canDisableThinking)
      .map(m => [m.target, m.supportedEfforts.at(-1) || "on"])) : patch.efforts;
    if (effortEdits !== undefined) {
      if (!safeObject(effortEdits)) reject("invalid effort patch");
      prefs.models ||= {};
      for (const [selector, level] of Object.entries(effortEdits)) {
        if (!base) reject("no model capabilities available");
        const target = effort.resolveTarget(base, selector);
        if (level === null) delete prefs.models[target];
        else {
          const cap = base.effort.models.find(m => m.target === target);
          if (!cap.supportedEfforts.includes(level) && !(["off", "on"].includes(level) && cap.canDisableThinking)) reject(`unsupported effort for ${target}`);
          prefs.models[target] = level;
        }
      }
      if (!Object.keys(prefs.models).length) delete prefs.models;
    }
    if (patch.contexts !== undefined) {
      if (!safeObject(patch.contexts)) reject("invalid context patch");
      limits.models ||= {};
      for (const [selector, n] of Object.entries(patch.contexts)) {
        if (!base) reject("no model capabilities available");
        const target = effort.resolveTarget(base, selector);
        if (n === null) delete limits.models[target]; else limits.models[target] = n;
      }
      if (!Object.keys(limits.models).length) delete limits.models;
    }
    context.validate(limits); effort.validatePreferences(prefs, true);
    // Metadata validation first; credential resolution is apply-only, never a provider inference request.
    if (base) await core.buildPlan(clone(cfg), p.dir, { providers: {}, keys: {} },
      { metadataOnly: true, preferences: prefs, contextPreferences: limits, parameterPriority: parameters.priority });
    else if (sw.mode !== "official") reject("configure a provider before enabling third-party models");
    const plan = base && sw.mode !== "official" ? await core.buildPlan(clone(cfg), p.dir, core.prevKeys(original, ownership),
      { preferences: prefs, contextPreferences: limits, parameterPriority: parameters.priority }) : null;
    if (plan && (!plan.models.length || plan.warnings.length)) reject("provider keys or routes incomplete; previous configuration retained");
    if (snapshot(p).revision !== args.expectedRevision) reject("settings changed during validation; reopen the panel");
    const dest = snap.from && !["none", "env", "$WB3P_CONFIG_JSON"].includes(snap.from)
      ? snap.from : path.join(p.dir, "workbuddy-3p.json");
    const changedFiles = new Map();
    if (configChange) {
      const data = dest.endsWith("workbuddy-3p.profile.json") ? { ...json(dest), config: cfg } : cfg;
      changedFiles.set(dest, JSON.stringify(data, null, 2) + "\n");
    }
    if (effortEdits !== undefined) changedFiles.set(p.effort, Object.keys(prefs).length === 1 ? null : JSON.stringify(prefs, null, 2) + "\n");
    if (patch.contexts !== undefined) changedFiles.set(p.context, Object.keys(limits).length === 1 ? null : JSON.stringify(limits, null, 2) + "\n");
    if (patch.switchMode !== undefined) changedFiles.set(p.switch, patch.switchMode === "default" ? null : patch.switchMode + "\n");
    if (patch.parameterPriority !== undefined) changedFiles.set(p.parameters, JSON.stringify(parameters, null, 2) + "\n");
    const backupDir = path.join(p.dir, "workbuddy-3p.backups", `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
    const previous = new Map([...changedFiles.keys()].map(file => [file, file === dest && configChange
      ? (dest === snap.from ? snap.raw : null) : snap.files[Object.keys(p).find(k => p[k] === file)]]));
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 }); fs.chmodSync(backupDir, 0o700);
    const manifest = [];
    for (const [file, before] of new Map([...previous, [p.models, snap.files.models], [p.state, snap.files.state]])) {
      const name = `${manifest.length}-${path.basename(file)}`;
      if (before !== null) fs.writeFileSync(path.join(backupDir, name), before, { mode: 0o600 });
      manifest.push({ file, backup: before === null ? null : name, sha256: before === null ? null : hash(before) });
    }
    fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    let result;
    try {
      if (snapshot(p).revision !== args.expectedRevision) reject("settings changed while preparing backups");
      for (const [file, text] of changedFiles) {
        if (bytes(file) !== previous.get(file)) reject("settings target changed before write");
        if (text === null) fs.rmSync(file, { force: true }); else core.writeAtomicChecked(file, text, previous.get(file));
      }
      // The prepared plan avoids repeated private credential URL access.
      result = await core.syncUnlocked({ preparedPlan: plan, preparedFingerprint: core.fingerprint(cfg, sw.mode, prefs, limits, parameters) }, p);
    } catch {
      let restored = true;
      for (const [file, text] of previous) try {
        const current = bytes(file);
        if (current !== changedFiles.get(file) && current !== text) { restored = false; continue; }
        if (text === null) fs.rmSync(file, { force: true }); else core.writeAtomic(file, text);
      } catch { restored = false; }
      reject(restored ? "settings update failed; previous preferences restored; keep backup for routing recovery" : "settings update failed; rollback incomplete; restore private backup");
    }
    let cleanupWarning;
    try { fs.rmSync(p.lastError, { force: true }); } catch { cleanupWarning = "settings committed; stale error record remains"; }
    let view;
    try { view = await viewUnlocked(p); }
    catch { return { ok: true, committed: true, stateUnavailable: true, backup: backupDir,
      note: "Settings committed but readback failed; do not automatically retry. Reopen status before further edits." }; }
    return { ...view, committed: true, backup: backupDir, changed: result.changed, requiresModelReselection: sw.mode !== "official" || result.changed === true,
      requiresHostRefresh: sw.mode !== "official", deferred: sw.mode === "official", ...(cleanupWarning ? { cleanupWarning } : {}) };
  }
  return { viewUnlocked, applyUnlocked };
};
