"use strict";

// Model defaults only: never write the host's global/session reasoning settings.
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const valid = v => typeof v === "string" && (LEVELS.includes(v) || ["off", "on"].includes(v));
const error = message => { throw new Error(message); };

function validatePreferences(value, local = false) {
  if (!object(value)) error("effort preferences must be an object");
  if (local && value.version !== 1) error("unsupported local effort preferences version");
  if (Object.keys(value).some(k => !["default", "models", ...(local ? ["version"] : [])].includes(k)))
    error("unknown effort preferences field");
  if (own(value, "default") && !valid(value.default)) error("invalid default effort level");
  if (own(value, "models")) {
    if (!object(value.models)) error("effort.models must be an object");
    for (const [target, level] of Object.entries(value.models)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*:.+$/s.test(target) || target.trim() !== target || !valid(level))
        error("effort.models requires provider:model keys and supported effort names");
    }
  }
  return value;
}

// Nested capability overrides must not erase supportedEfforts or protocol flags.
function mergeModel(...layers) {
  const result = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer || {})) {
      result[key] = ["reasoning", "compat", "thinkingLevelMap"].includes(key) && object(value)
        ? { ...(object(result[key]) ? result[key] : {}), ...value } : value;
    }
  }
  return result;
}

function capability(model) {
  if (model.supportsReasoning !== true) return { supportedEfforts: [], reason: "model does not declare reasoning support" };
  const map = model.thinkingLevelMap;
  const providerCanDisableThinking = model.onlyReasoning !== true && model.reasoning?.canDisableThinking === true &&
    object(map) && map.off !== null && map.off !== undefined;
  // Native host's same-name Kimi K3 / DeepSeek V4.1 paths currently omit the provider thinking
  // toggle, so removing reasoning fields would silently keep provider thinking ON.
  const canDisableThinking = providerCanDisableThinking && !["kimi-k3", "deepseek-v4.1-flash"].includes(model.id);
  if (model.compat?.supportsReasoningEffort === false)
    return { supportedEfforts: [], canDisableThinking, providerCanDisableThinking, reason: "provider protocol declares effort unsupported; thinking toggle may still be supported" };
  const declared = model.reasoning?.supportedEfforts;
  let levels = Array.isArray(declared) ? LEVELS.filter(v => declared.includes(v))
    : object(map) ? LEVELS.filter(v => own(map, v) && map[v] !== null && map[v] !== undefined) : [];
  if (object(map)) levels = levels.filter(v => own(map, v) && map[v] !== null && map[v] !== undefined);
  return { supportedEfforts: levels, canDisableThinking, providerCanDisableThinking,
    ...(levels.length ? {} : { reason: "model has no declared adjustable effort levels" }) };
}

function preference(target, local, config, base) {
  if (own(local.models, target)) return { level: local.models[target], source: "local:model", specific: true };
  if (own(local, "default")) return { level: local.default, source: "local:default" };
  if (own(config.models, target)) return { level: config.models[target], source: "config:model", specific: true };
  if (own(config, "default")) return { level: config.default, source: "config:default" };
  return { level: base, source: "model" };
}

function applyEfforts(models, owner, local, config = {}) {
  validatePreferences(local, true); validatePreferences(config);
  const info = [];
  for (const model of models) {
    const target = `${owner.get(model.id)}:${model.id}`;
    const base = model.reasoning?.defaultEffort ?? model.reasoning?.effort ?? null;
    const cap = capability(model), pref = preference(target, local, config, base);
    const adjustable = pref.source !== "model";
    const accepted = adjustable && (cap.supportedEfforts.includes(pref.level) || ["off", "on"].includes(pref.level) && cap.canDisableThinking);
    if (adjustable && !accepted && pref.specific)
      error(`model ${target} does not support requested effort; supported: ${cap.supportedEfforts.join(", ") || "none"}`);
    if (accepted) {
      const native = pref.level === "on" ? cap.supportedEfforts.at(-1) || (base !== "off" && base) || "high" : pref.level;
      model.reasoning = { ...model.reasoning, defaultEffort: native, effort: native };
      // The host's default-effort normalizer does not accept "off". Disabling
      // this custom entry's reasoning capability is the supported per-model seam.
      if (pref.level === "off") model.supportsReasoning = false;
    }
    info.push({ target, model: model.id, supportedEfforts: cap.supportedEfforts, canDisableThinking: cap.canDisableThinking === true,
      providerCanDisableThinking: cap.providerCanDisableThinking === true, baseEffort: base,
      configuredEffort: accepted ? pref.level : base, source: accepted ? pref.source : "model",
      requestedEffort: pref.level, requestedSource: pref.source, applied: accepted,
      ...(!accepted && adjustable ? { reason: cap.reason || "requested default is not supported; original model default retained" }
        : cap.reason ? { reason: cap.reason } : {}) });
  }
  const targets = new Set(info.map(m => m.target));
  return { models: info, skipped: info.filter(m => m.requestedSource !== "model" && !m.applied),
    orphanedTargets: [...new Set([...Object.keys(local.models || {}), ...Object.keys(config.models || {})])].filter(t => !targets.has(t)) };
}

function resolveTarget(plan, selector) {
  if (typeof selector !== "string" || !selector.trim()) error("model is required; use provider:upstream-model");
  // Prefer exact provider qualification, then an unambiguous upstream id or official alias.
  const exact = plan.effort.models.find(m => m.target === selector);
  if (exact) return exact.target;
  const matches = plan.effort.models.filter(m => m.model === selector ||
    plan.models.find(x => x.id === m.model)?.aliases?.includes(selector));
  if (matches.length !== 1) error("unknown or ambiguous model; use a target returned by models_effort status");
  return matches[0].target;
}

module.exports = { LEVELS, validatePreferences, mergeModel, applyEfforts, resolveTarget };
