"use strict";
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
function validate(value) {
  if (!object(value) || value.version !== 1 || Object.keys(value).some(k => !["version", "models"].includes(k)) ||
      value.models !== undefined && !object(value.models)) throw Error("invalid context preferences");
  for (const [target, n] of Object.entries(value.models || {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*:.+$/.test(target) || !Number.isSafeInteger(n) || n < 1024)
      throw Error("context requires provider:model and an integer token limit >= 1024");
  }
  return value;
}
function apply(models, owner, local) {
  validate(local);
  return models.map(m => {
    const target = `${owner.get(m.id)}:${m.id}`, base = Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0
      ? Math.min(m.maxInputTokens, m.contextWindow) : m.maxInputTokens, value = local.models?.[target];
    if (value !== undefined) {
      if (!Number.isSafeInteger(base) || value > base) throw Error(`context limit exceeds declared input capacity for ${target}`);
      m.maxInputTokens = value;
      // Some host versions prefer contextWindow over maxInputTokens.
      if (Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0) m.contextWindow = Math.min(m.contextWindow, value);
    }
    return { target, baseInputTokens: base, maxInputTokens: m.maxInputTokens,
      source: value === undefined ? "model" : "local:model" };
  });
}
module.exports = { validate, apply };
