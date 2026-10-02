"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BASE = path.resolve(__dirname, "..");
const PRESET_PATH = path.join(BASE, "plugins", "custom-api-models", "presets", "bailian.json");
const OFFICIAL_PATH = path.join(BASE, "plugins", "custom-api-models", "presets", "workbuddy-official.json");
const DOCS_PATH = path.join(BASE, "docs", "model-capabilities.md");
const effort = require(path.join(BASE, "plugins", "custom-api-models", "scripts", "effort.cjs"));

const preset = JSON.parse(fs.readFileSync(PRESET_PATH, "utf8"));
const official = JSON.parse(fs.readFileSync(OFFICIAL_PATH, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

function effectiveModel(id) {
  const model = preset.models[id];
  assert.ok(model, `missing model ${id}`);
  return effort.mergeModel(preset.templates[model.template], model);
}

function assertSwitchOnly(id) {
  const model = effectiveModel(id);
  assert.equal(model.supportsReasoning, true, `${id} must support reasoning`);
  assert.equal(model.onlyReasoning, false, `${id} must not be marked thinking-only`);
  assert.deepEqual(model.reasoning.supportedEfforts, [], `${id} must not expose effort levels`);
  assert.equal(model.reasoning.defaultEffort, "high", `${id} default high means thinking on`);
  assert.equal(model.reasoning.effort, "high", `${id} effort high means thinking on`);
  assert.equal(model.reasoning.canDisableThinking, true, `${id} must allow thinking off`);
  assert.equal(model.compat.thinkingFormat, "qwen", `${id} must use Bailian enable_thinking mapping`);
  assert.equal(model.compat.supportsReasoningEffort, false, `${id} must not send reasoning_effort`);
  assert.equal(model.thinkingLevelMap.off, "none", `${id} off must map to none`);
  assert.equal(model.thinkingLevelMap.high, "high", `${id} on must map to high`);
  assert.equal(model.thinkingLevelMap.low, null, `${id} must not advertise low`);
}

test("preset keeps all official Bailian routes and the audited model count", () => {
  assert.equal(Object.keys(preset.routes).length, 24);
  assert.equal(Object.keys(preset.models).length, 20);
  assert.equal(Object.keys(preset.templates).length, 12);

  for (const id of official.routable) {
    assert.ok(
      preset.routes[id] || preset.unsupported.includes(id),
      `official routable id ${id} is neither routed nor explicitly unsupported`,
    );
  }
  for (const [alias, upstream] of Object.entries(preset.routes)) {
    assert.ok(preset.models[upstream], `route ${alias} points to missing model ${upstream}`);
  }
});

test("DeepSeek V3.2 is switch-only while DeepSeek V4 keeps effort levels", () => {
  assertSwitchOnly("deepseek-v3.2");

  for (const id of ["deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash"]) {
    const model = effectiveModel(id);
    assert.deepEqual(model.reasoning.supportedEfforts, ["low", "high", "max"]);
    assert.equal(model.reasoning.defaultEffort, "high");
    assert.equal(model.reasoning.canDisableThinking, true);
    assert.equal(model.compat.thinkingFormat, "qwen");
    assert.equal(model.compat.supportsReasoningEffort, true);
    assert.deepEqual(model.thinkingLevelMap, {
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  }
});

test("GLM models use model-specific defaults, mappings and switches", () => {
  const glm53 = effectiveModel("glm-5.3");
  assert.deepEqual(glm53.reasoning.supportedEfforts, ["low", "high", "max"]);
  assert.equal(glm53.reasoning.defaultEffort, "max");
  assert.equal(glm53.reasoning.effort, "max");
  assert.equal(glm53.reasoning.canDisableThinking, false);
  assert.equal(glm53.onlyReasoning, true);
  assert.equal(glm53.thinkingLevelMap.off, null);

  const glm52 = effectiveModel("glm-5.2");
  assert.deepEqual(glm52.reasoning.supportedEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(glm52.reasoning.defaultEffort, "high");
  assert.equal(glm52.reasoning.canDisableThinking, true);
  assert.equal(glm52.onlyReasoning, false);
  assert.equal(glm52.compat.thinkingFormat, "qwen");
  assert.equal(glm52.compat.supportsReasoningEffort, true);
  assert.deepEqual(glm52.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max",
  });

  for (const id of ["glm-5.1", "glm-5"]) {
    const model = effectiveModel(id);
    assert.deepEqual(model.reasoning.supportedEfforts, ["minimal", "low", "medium", "high", "xhigh"]);
    assert.equal(model.reasoning.defaultEffort, "high");
    assert.equal(model.reasoning.effort, "high");
    assert.equal(model.reasoning.canDisableThinking, true);
    assert.equal(model.onlyReasoning, false);
    assert.equal(model.compat.thinkingFormat, "qwen");
    assert.equal(model.compat.supportsReasoningEffort, true);
    assert.deepEqual(model.thinkingLevelMap, {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
  }

  assertSwitchOnly("glm-4.7");
});

test("GLM 5.1 and 5 use the provider error enum instead of the GLM 5.2 max mapping", () => {
  for (const id of ["glm-5.1", "glm-5"]) {
    assert.equal(preset.models[id].template, "glm-5.0-5.1-effort");
    assert.equal(effectiveModel(id).thinkingLevelMap.max, null);
  }

  const docs = fs.readFileSync(DOCS_PATH, "utf8");
  assert.match(docs, /VM 实际请求修正/);
  assert.match(docs, /max.*HTTP 400|HTTP 400.*max/s);
  assert.match(docs, /must be one of: 'none'/);
  assert.match(docs, /minimal.*medium.*xhigh/s);
});

test("Kimi K3 supports low/high/max and K2.6/K2.5 remain switch-only", () => {
  const k3 = effectiveModel("kimi-k3");
  assert.deepEqual(k3.reasoning.supportedEfforts, ["low", "high", "max"]);
  assert.equal(k3.reasoning.defaultEffort, "max");
  assert.equal(k3.reasoning.canDisableThinking, true);
  assert.equal(k3.onlyReasoning, false);
  assert.deepEqual(k3.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });

  assertSwitchOnly("kimi-k2.6");
  assertSwitchOnly("kimi-k2.5");

  for (const id of ["kimi-k2.7-code", "kimi/kimi-k2.8-preview", "kimi-k2-thinking"]) {
    const model = effectiveModel(id);
    assert.equal(model.onlyReasoning, true, `${id} must remain thinking-only in this preset`);
    assert.deepEqual(model.reasoning.supportedEfforts, [], `${id} has no adjustable effort declaration`);
    assert.equal(model.reasoning.canDisableThinking, false, `${id} cannot claim a host switch it does not implement`);
  }
});

test("MiniMax M3 is documented as provider-switchable but host protocol is not implemented", () => {
  const m3 = effectiveModel("MiniMax/MiniMax-M3");
  assert.equal(m3.onlyReasoning, true);
  assert.deepEqual(m3.reasoning.supportedEfforts, []);
  assert.equal(m3.reasoning.canDisableThinking, false);
  assert.equal(m3.thinkingLevelMap.off, null);

  const docs = fs.readFileSync(DOCS_PATH, "utf8");
  assert.match(docs, /adaptive/);
  assert.match(docs, /disabled/);
  assert.match(docs, /宿主协议未实现/);
  assert.match(docs, /不能把.*强制思考.*供应商不能关闭/);
});

test("Qwen 3.8 defaults to xhigh and keeps the Bailian direct levels", () => {
  for (const id of ["qwen3.8-max", "qwen3.8-flash"]) {
    const model = effectiveModel(id);
    assert.deepEqual(model.reasoning.supportedEfforts, ["low", "medium", "xhigh"]);
    assert.equal(model.reasoning.defaultEffort, "xhigh");
    assert.equal(model.reasoning.effort, "xhigh");
    assert.equal(model.reasoning.canDisableThinking, true);
    assert.equal(model.compat.thinkingFormat, "qwen");
    assert.equal(model.compat.supportsReasoningEffort, true);
    assert.deepEqual(model.thinkingLevelMap, {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    });
  }
});

test("switch-only off/on preferences are merged by the JS helper; effective transport is per-model", () => {
  // This exercises the JS helper only; Native 2.161.1 transport is not available here.
  const on = clone(effectiveModel("kimi-k2.6"));
  const onReport = effort.applyEfforts([on], new Map([[on.id, "bailian"]]), { version: 1, default: "on" });
  assert.equal(onReport.models[0].applied, true);
  assert.equal(onReport.models[0].canDisableThinking, true);
  assert.equal(on.reasoning.defaultEffort, "high");

  const off = clone(effectiveModel("kimi-k2.6"));
  const offReport = effort.applyEfforts([off], new Map([[off.id, "bailian"]]), { version: 1, default: "off" });
  assert.equal(offReport.models[0].applied, true);
  assert.equal(offReport.models[0].canDisableThinking, true);
  assert.equal(off.reasoning.defaultEffort, "off");
});

test("docs separate vendor support from Native 2.161.1 host availability", () => {
  const docs = fs.readFileSync(DOCS_PATH, "utf8");
  for (const needle of [
    "Native 2.161.1",
    "findCompatibleModelConfig",
    "源码与现象一致，但不在此断定唯一内部根因",
    "supportsReasoning=false",
    "enable_thinking=false",
    "Kimi 3",
    "UI off 先禁用",
    "不能统一宣称 off 失败或成功",
  ]) assert.ok(docs.includes(needle), `docs missing host-gap evidence: ${needle}`);
});

test("docs record all aliases, unknown items and lack of runtime verification", () => {
  const docs = fs.readFileSync(DOCS_PATH, "utf8");
  for (const model of Object.keys(preset.models)) assert.ok(docs.includes(model), `docs missing model ${model}`);
  for (const alias of Object.keys(preset.routes)) assert.ok(docs.includes(alias), `docs missing alias ${alias}`);
  assert.match(docs, /UNKNOWN/);
  assert.match(docs, /未运行验证/);
  assert.match(docs, /24/);
});