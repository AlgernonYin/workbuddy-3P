"use strict";
// Settings mutation runs under the routing lock; no HTTP settings/control API.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const effort = require("./effort.cjs"), context = require("./context.cjs");
const imported = require("./provider-models.cjs"), providerApi = require("./provider-discovery.cjs");
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
  function baselineFor(p) {
    if (typeof core.accountBaseline !== "function") return null;
    const baseline = core.accountBaseline(p);
    if (baseline === null || baseline === undefined) return null;
    if (!object(baseline) || !object(baseline.cfg)) reject("invalid published account baseline");
    // connectionOnly controls runtime adoption, not account editing. A verified
    // downloaded profile remains the baseline even before a source switch.
    return baseline;
  }
  function sourceKind(from) {
    if (!from || from === "none") return "none";
    return from === "env" || from === "$WB3P_CONFIG_JSON" ? "environment" :
      from.endsWith("workbuddy-3p.profile.json") ? "private-profile" :
      from.endsWith("workbuddy-3p.account-cache.json") ? "account" : "file";
  }
  const SWITCH_OFF = new Set(["official", "off", "0", "false", "no", "disabled"]);
  const SWITCH_ON = new Set(["third-party", "thirdparty", "3p", "on", "1", "true", "yes", "enabled"]);
  function configuredMode(cfg, fallback = "third-party") {
    const value = cfg?.enabled;
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value ? "third-party" : "official";
    const normalized = String(value).trim().toLowerCase();
    if (SWITCH_OFF.has(normalized)) return "official";
    if (SWITCH_ON.has(normalized)) return "third-party";
    reject("invalid account baseline model source");
  }
  function accountEffort(value) {
    const out = clone(value || {});
    delete out.version;
    return out;
  }
  function mergeAccountEffort(config, local) {
    const out = accountEffort(config);
    if (local.default !== undefined) out.default = local.default;
    const models = local.default !== undefined ? (local.models || {}) : { ...(out.models || {}), ...(local.models || {}) };
    out.models = { ...models };
    return out;
  }
  function snapshot(p) {
    const baseline = baselineFor(p);
    const { cfg, from } = core.loadConfig(p.dir);
    const raw = from && !["none", "env", "$WB3P_CONFIG_JSON"].includes(from) ? bytes(from) : JSON.stringify(cfg);
    const baselineRaw = baseline ? (baseline.from && !["none", "env", "$WB3P_CONFIG_JSON"].includes(baseline.from)
      ? (bytes(baseline.from) ?? JSON.stringify(baseline.cfg)) : JSON.stringify(baseline.cfg)) : null;
    const files = Object.fromEntries(["models", "state", "effort", "context", "switch", "parameters", "scope"].map(k => [k, bytes(p[k] || path.join(p.dir, "workbuddy-3p.scope.json"))]));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)));
    return { cfg, from, raw, files, baseline, revision: revision(JSON.stringify([from, raw, baseline?.from || null, baselineRaw, files, core.resolveSwitch(p.dir, cfg), environment, core.presetFingerprint()])) };
  }
  async function viewUnlocked(p, options = {}) {
    const scope = options?.scope || "account";
    if (!["account", "session"].includes(scope)) reject("invalid settings scope");
    const snap = snapshot(p);
    // Account editing must never implicitly promote session-only preferences.
    const accountView = scope === "account" && typeof core.accountBaseline === "function";
    const cfg = accountView ? clone(snap.baseline?.cfg || { mode: "explicit", enabled: "official", providers: {} }) : snap.cfg;
    if (accountView) cfg.effort = accountEffort(cfg.effort);
    const from = accountView ? (snap.baseline?.from || "none") : snap.from;
    const sw = accountView ? { mode: configuredMode(cfg) } : core.resolveSwitch(p.dir, cfg);
    const local = accountView ? { version: 1 } : core.readEffort(p);
    const ctx = accountView ? clone(cfg?.context || { version: 1 }) : core.readContext(p);
    const parameters = accountView ? { version: 1, priority: cfg?.parameterPriority || "3p" } : core.readParameters(p);
    if (!["3p", "native"].includes(parameters.priority)) reject("invalid parameter priority");
    const plan = cfg ? await core.buildPlan(clone(cfg), p.dir, { providers: {}, keys: {} },
      { metadataOnly: true, preferences: local, contextPreferences: ctx, parameterPriority: parameters.priority }) : null;
    const state = {
      ok: true, revision: snap.revision, configuredMode: sw.mode, runtimeVerified: false,
      scope, accountSync: core.accountMeta(),
      hasAccountBaseline: !!snap.baseline, canImportSession: typeof core.accountBaseline === "function" && !snap.baseline,
      sourceKind: sourceKind(from),
      readOnly: from === "$WB3P_CONFIG_JSON", defaultProvider: cfg?.default || Object.keys(cfg?.providers || {})[0] || "",
      routingMode: cfg?.mode || "explicit",
      parameterPriority: parameters.priority,
      providers: Object.entries(cfg?.providers || {}).map(([id, v]) => ({ id, label: v.label || "", preset: v.preset || "",
        protocol: providerApi.normalizeProtocol(v.protocol || "openai-chat"), models: imported.safeModels(Object.fromEntries(
          [...new Set([...(v.extraModels||[]),...Object.keys(v.models||{}),...(plan?.models||[]).filter(m=>plan.owner.get(m.id)===id).map(m=>m.workbuddy3pBinding?.model||m.id)])]
          .map(model=>[model,imported.declaredModel(v,model,plan?.providers[id]?.preset)]))),
        nativeSessionSupported: providerApi.normalizeProtocol(v.protocol || "openai-chat") === "openai-chat",
        ...(providerApi.normalizeProtocol(v.protocol || "openai-chat") !== "openai-chat"
          ? { hostProtocolReason: "The tested WorkBuddy custom-model host sends Chat Completions only. Configure the backend's Chat Completions endpoint for session routing; this plugin does not translate protocols." } : {}),
         baseUrl: v.baseUrl || plan?.providers[id]?.preset?.baseUrl || "", extraModels: v.extraModels || [],
         ...(typeof v.apiKeyEnv==="string"&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.apiKeyEnv)?{apiKeyEnv:v.apiKeyEnv}:{}),
        credential: { configured: v.apiKey || v.apiKeyEnv || v.apiKeyFile || v.apiKeyUrl ? true : null,
          kind: v.apiKey ? "inline" : v.apiKeyEnv ? "environment" : v.apiKeyFile ? "file" : v.apiKeyUrl ? "private-url" : "runtime" } })),
      routes: cfg?.routes || {},
      officialModels: (core.officialModels || []),
      models: (plan?.models || []).map(m => ({ target: `${plan.owner.get(m.id)}:${m.workbuddy3pBinding?.model||m.id}`, id: m.id,
        aliases: m.aliases, ...plan.effort.models.find(e => e.model === m.id),
        ...plan.contexts.find(c => c.target === `${plan.owner.get(m.id)}:${m.workbuddy3pBinding?.model||m.id}`), maxOutputTokens: m.maxOutputTokens })),
      note: "Save scope defaults to account. Authorized account defaults sync through private WorkBuddy assets; session overrides require an explicit choice. Existing hosts need the new plugin and connection, then catalog refresh/model reselection. Protocols are not translated. Context is host metadata, not provider capacity expansion. Saved settings are not runtime proof. Credentials are never returned."
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
        fields(edit, ["label", "preset", "protocol", "baseUrl", "extraModels", "models", "apiKeyEnv", "reuseCredential"]);
        const before = cfg.providers[id] || {};
        const after = { ...before };
        for (const k of ["label", "preset", "protocol", "baseUrl", "apiKeyEnv"]) if (edit[k] !== undefined) {
          if (typeof edit[k] !== "string" || edit[k].length > 2048) reject("invalid provider text field");
          if (edit[k]) after[k] = edit[k]; else delete after[k];
        }
        if (edit.extraModels !== undefined) { if (!strings(edit.extraModels)) reject("invalid extra models"); after.extraModels = [...new Set(edit.extraModels)]; }
        if (edit.models !== undefined) after.models = imported.patchModels(edit.models,Object.fromEntries(Object.keys(edit.models).map(model=>[model,imported.declaredModel(before,model,core.loadPreset(before.preset))])));
        if (edit.protocol !== undefined) {after.protocol = providerApi.normalizeProtocol(edit.protocol);if(after.protocol!=="openai-chat")reject("Only OpenAI-compatible Chat Completions API is supported by this WorkBuddy host");}
        if (edit.reuseCredential !== undefined && typeof edit.reuseCredential !== "boolean") reject("invalid credential reuse choice");
        if (edit.apiKeyEnv) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(edit.apiKeyEnv)) reject("invalid credential environment name");
          for (const k of ["apiKey", "apiKeyFile", "apiKeyUrl"]) delete after[k];
        } else if ((after.baseUrl !== before.baseUrl || after.preset !== before.preset || after.protocol !== before.protocol) && Object.keys(before).length && edit.reuseCredential !== true) {
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
        else { if (object(target)) cfg.routes[id] = imported.route(target,cfg.providers);
          else { if (typeof target !== "string" || !target.trim() || target.length > 512) reject("invalid route target"); cfg.routes[id] = target; } }
      }
    }
  }
  async function applyUnlocked(p, args) {
    fields(args, ["action", "scope", "expectedRevision", "patch"]);
    if (args.action !== "apply" || typeof args.expectedRevision !== "string") reject("settings apply requires expectedRevision");
    fields(args.patch, ["switchMode", "effortDefault", "efforts", "contexts", "maxEffort", "providers", "routes", "defaultProvider", "routingMode", "parameterPriority"]);
    const patch = args.patch, snap = snapshot(p);
    if (snap.revision !== args.expectedRevision) reject("settings changed; reopen the panel before applying");
    const parameters = patch.parameterPriority === undefined ? core.readParameters(p) : { version: 1, priority: patch.parameterPriority };
    if (!["3p", "native"].includes(parameters.priority)) reject("invalid parameter priority");
    const configChange = snap.from.endsWith("workbuddy-3p.account-cache.json") || ["providers", "routes", "defaultProvider", "routingMode"].some(k => patch[k] !== undefined);
    if (configChange && snap.from === "$WB3P_CONFIG_JSON") reject("WB3P_CONFIG_JSON is read-only; edit its owner, not a lower-priority file");
    const cfg = clone(snap.cfg || { providers: {}, mode: "explicit" });
    patchConfig(cfg, patch);
    const prefs = clone(core.readEffort(p)), limits = core.readContext(p);
    if(patch.effortDefault!==undefined){if(patch.effortDefault===null)delete prefs.default;else prefs.default=patch.effortDefault;effort.validatePreferences(prefs,true);}
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
    if (plan?.warnings.length) reject("provider keys or routes incomplete; previous configuration retained");
    if (snapshot(p).revision !== args.expectedRevision) reject("settings changed during validation; reopen the panel");
    const dest = snap.from && !["none", "env", "$WB3P_CONFIG_JSON"].includes(snap.from) && !snap.from.endsWith("workbuddy-3p.account-cache.json")
      ? snap.from : path.join(p.dir, "workbuddy-3p.json");
    const changedFiles = new Map();
    const scopeFile=path.join(p.dir,"workbuddy-3p.scope.json"),scopeBefore=bytes(scopeFile);
    changedFiles.set(scopeFile,JSON.stringify({version:1,scope:"session"})+"\n");
    if (configChange) {
      const data = dest.endsWith("workbuddy-3p.profile.json") ? { ...json(dest), config: cfg } : cfg;
      changedFiles.set(dest, JSON.stringify(data, null, 2) + "\n");
    }
    const exportingAccount=snap.from.endsWith("workbuddy-3p.account-cache.json");
    if (effortEdits !== undefined || patch.effortDefault!==undefined || exportingAccount) changedFiles.set(p.effort, Object.keys(prefs).length === 1 ? null : JSON.stringify(prefs, null, 2) + "\n");
    if (patch.contexts !== undefined || exportingAccount) changedFiles.set(p.context, Object.keys(limits).length === 1 ? null : JSON.stringify(limits, null, 2) + "\n");
    if (patch.switchMode !== undefined || exportingAccount) changedFiles.set(p.switch, patch.switchMode === "default" ? null : sw.mode + "\n");
    if (patch.parameterPriority !== undefined || exportingAccount) changedFiles.set(p.parameters, JSON.stringify(parameters, null, 2) + "\n");
    const backupDir = path.join(p.dir, "workbuddy-3p.backups", `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
    const previous = new Map([...changedFiles.keys()].map(file => [file, file===scopeFile?scopeBefore:file === dest && configChange
      ? bytes(dest) : snap.files[Object.keys(p).find(k => p[k] === file)]]));
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
      if(result.ok!==true||result.partial)reject("local routing incomplete");
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
    try { view = await viewUnlocked(p, { scope: "session" }); }
    catch { return { ok: true, committed: true, sessionCommitted: true, session: true, scope:"session", stateUnavailable: true, backup: backupDir,
      note: "Settings committed but readback failed; do not automatically retry. Reopen status before further edits." }; }
    return { ...view, committed: true, sessionCommitted: true, session:true, scope: "session", backup: backupDir, changed: result.changed, requiresModelReselection: sw.mode !== "official" || result.changed === true,
      requiresHostRefresh: sw.mode !== "official" || result.changed === true || result.fallbackUnavailable === true, deferred: sw.mode === "official",
      ...Object.fromEntries(["officialCatalogFallback", "officialCatalogConflicts", "catalogWarning", "fallbackUnavailable"]
        .filter(k => result[k] !== undefined).map(k => [k, result[k]])), ...(cleanupWarning ? { cleanupWarning } : {}) };
  }
  async function prepareAccount(p,args){
    fields(args,["action","scope","expectedRevision","patch","confirmedConfirmationTypes","importSession"]);
    if(args.action!=="apply"||typeof args.expectedRevision!=="string")reject("settings apply requires expectedRevision");
    if(args.importSession!==undefined&&typeof args.importSession!=="boolean")reject("invalid importSession setting");
    fields(args.patch,["switchMode","effortDefault","efforts","contexts","maxEffort","providers","routes","defaultProvider","routingMode","parameterPriority"]);
    const snap=snapshot(p);if(snap.revision!==args.expectedRevision)reject("settings changed; reopen the panel before applying");
    const patch=args.patch,hasBaseline=!!snap.baseline;
    let cfg;
    if(hasBaseline){
      if(args.importSession===true)reject("account baseline already exists; importSession is only for first publication");
      cfg=clone(snap.baseline.cfg);cfg.providers||={};cfg.effort=accountEffort(cfg.effort);
    }else if(typeof core.accountBaseline==="function"&&args.importSession!==true){
      // Without a published baseline, ordinary account apply is patch-only.
      cfg={mode:"explicit",enabled:"official",providers:{}};
    }else{
      // Explicit first migration may absorb the current session only when
      // importSession=true. A local default masks config per-model defaults.
      cfg=clone(snap.cfg||{mode:"explicit",enabled:"official",providers:{}});
      cfg.enabled=core.resolveSwitch(p.dir,snap.cfg).mode;
      cfg.parameterPriority=core.readParameters(p).priority;
      cfg.effort=mergeAccountEffort(cfg.effort,core.readEffort(p));
      cfg.context=clone(core.readContext(p));
    }
    patchConfig(cfg,patch);
    if(patch.switchMode!==undefined){if(!["official","third-party","default"].includes(patch.switchMode))reject("invalid model source");if(patch.switchMode==="default")delete cfg.enabled;else cfg.enabled=patch.switchMode;}
    if(patch.parameterPriority!==undefined){if(!["3p","native"].includes(patch.parameterPriority))reject("invalid parameter priority");cfg.parameterPriority=patch.parameterPriority;}
    if(patch.maxEffort!==undefined)reject("bulk personal effort preferences are not part of the public account settings");
    cfg.effort ||= {};
    if(patch.effortDefault!==undefined){if(patch.effortDefault===null)delete cfg.effort.default;else cfg.effort.default=patch.effortDefault;}
    if(patch.efforts!==undefined){if(!safeObject(patch.efforts))reject("invalid effort patch");cfg.effort.models ||= {};for(const [target,value]of Object.entries(patch.efforts)){if(value===null)delete cfg.effort.models[target];else cfg.effort.models[target]=value;}}
    cfg.context ||= {version:1};
    if(patch.contexts!==undefined){if(!safeObject(patch.contexts))reject("invalid context patch");cfg.context.models ||= {};for(const [target,value]of Object.entries(patch.contexts)){if(value===null)delete cfg.context.models[target];else cfg.context.models[target]=value;}}
    effort.validatePreferences(cfg.effort);context.validate(cfg.context);
    cfg.providers||={};
    if(Object.keys(cfg.providers).length){
      await core.buildPlan(clone(cfg),p.dir,{providers:{},keys:{}},{metadataOnly:true,preferences:{version:1},contextPreferences:cfg.context,parameterPriority:cfg.parameterPriority||"3p"});
      // Host-only env/file references are not portable account defaults. Resolve
      // privately, embed only in the authorized private asset, never in a view.
      for(const [id,provider]of Object.entries(cfg.providers))if(provider.apiKeyEnv||provider.apiKeyFile||provider.apiKeyUrl){
        const source={...provider,baseUrl:provider.baseUrl||core.loadPreset(provider.preset)?.baseUrl};
        const {key}=await core.resolveKey(id,source,cfg.default===id||!cfg.default&&Object.keys(cfg.providers)[0]===id,p.dir,"");
        if(!key)reject("provider credential reference is unavailable on this host; account settings not published");
        provider.apiKey=key;for(const k of ["apiKeyEnv","apiKeyFile","apiKeyUrl"])delete provider[k];
      }
      if(cfg.enabled!=="official"){
        const plan=await core.buildPlan(clone(cfg),p.dir,{providers:{},keys:{}},{preferences:{version:1},contextPreferences:cfg.context,parameterPriority:cfg.parameterPriority});
        if(plan.warnings.length)reject("provider keys or routes incomplete; account settings not published");
      }
    }
    if(snapshot(p).revision!==args.expectedRevision)reject("settings changed during validation");
    return {cfg,accountRevision:core.accountMeta().revision??null,expectedLocalRevision:args.expectedRevision,localFiles:snap.files,
      sourceFiles:Object.fromEntries([...new Set([...core.configCandidates(p.dir),...(snap.from.endsWith("workbuddy-3p.profile.json")?[snap.from]:[])])].map(f=>[f,bytes(f)])),
      environment:JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)))),
      scopeBytes:bytes(path.join(p.dir,"workbuddy-3p.scope.json"))};
  }
  async function adoptAccount(p,prepared){
    if(Object.entries(prepared.localFiles).some(([k,v])=>bytes(p[k] || path.join(p.dir,"workbuddy-3p.scope.json"))!==v)||Object.entries(prepared.sourceFiles).some(([f,v])=>bytes(f)!==v)||
      JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k))))!==prepared.environment||bytes(path.join(p.dir,"workbuddy-3p.scope.json"))!==prepared.scopeBytes)
      reject("local configuration changed during account publication; resync explicitly");
    const scope=path.join(p.dir,"workbuddy-3p.scope.json");core.writeAtomic(scope,JSON.stringify({version:1,scope:"account"})+"\n");
    return core.syncUnlocked({},p);
  }
  return { viewUnlocked, applyUnlocked, prepareAccount, adoptAccount };
};
