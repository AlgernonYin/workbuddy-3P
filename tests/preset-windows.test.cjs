"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BASE = path.resolve(__dirname, "..");
const PRESET_PATH = path.join(BASE, "plugins", "custom-api-models", "presets", "bailian.json");
const DOCS_PATH = path.join(BASE, "docs", "model-windows.md");
const effort = require(path.join(BASE, "plugins", "custom-api-models", "scripts", "effort.cjs"));

const preset = JSON.parse(fs.readFileSync(PRESET_PATH, "utf8"));

const WINDOWS = {
  "deepseek-v4.1-flash": { input: 1000000, output: 393216 },
  "deepseek-v4-pro": { input: 1000000, output: 393216 },
  "deepseek-v4-flash": { input: 1000000, output: 393216 },
  "deepseek-v3.2": { input: 98304, output: 65536 },
  "glm-5.3": { input: 1048576, output: 131072 },
  "glm-5.2": { input: 1048576, output: 131072 },
  "glm-5.1": { input: 169984, output: 131072 },
  "glm-5": { input: 169984, output: 16384 },
  "glm-4.7": { input: 169984, output: 16384 },
  "kimi-k3": { input: 1048576, output: 131072 },
  "kimi/kimi-k2.8-preview": { input: 1048576, output: 131072 },
  "kimi-k2.7-code": { input: 229376, output: 16384 },
  "kimi-k2.6": { input: 229376, output: 16384 },
  "kimi-k2.5": { input: 229376, output: 16384 },
  "kimi-k2-thinking": { input: 229376, output: 16384 },
  "MiniMax/MiniMax-M3": { input: 1048576, output: 128000 },
  "MiniMax/MiniMax-M2.7": { input: 204800, output: 131072 },
  "MiniMax/MiniMax-M2.5": { input: 204800, output: 131072 },
  "qwen3.8-max": { input: 983616, output: 131072 },
  "qwen3.8-flash": { input: 983616, output: 131072 },
};

const OVERRIDDEN = [
  "deepseek-v3.2",
  "glm-5.1",
  "glm-5",
  "glm-4.7",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "kimi-k2.5",
  "kimi-k2-thinking",
  "MiniMax/MiniMax-M2.7",
  "MiniMax/MiniMax-M2.5",
];

function effectiveModel(id) {
  const model = preset.models[id];
  assert.ok(model, `missing model ${id}`);
  return effort.mergeModel(preset.templates[model.template], model);
}

test("preset windows keep the audited conservative budgets for all 20 models", () => {
  assert.equal(Object.keys(preset.models).length, Object.keys(WINDOWS).length);
  for (const [id, expected] of Object.entries(WINDOWS)) {
    const model = effectiveModel(id);
    assert.equal(model.maxInputTokens, expected.input, `${id} maxInputTokens`);
    assert.equal(model.maxOutputTokens, expected.output, `${id} maxOutputTokens`);
    assert.ok(Number.isInteger(model.maxInputTokens) && model.maxInputTokens > 0, `${id} input is a positive integer`);
    assert.ok(Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0, `${id} output is a positive integer`);
  }
});

test("the ten overclaimed models use explicit per-model window overrides", () => {
  for (const id of OVERRIDDEN) {
    const raw = preset.models[id];
    assert.ok(raw, `missing ${id}`);
    assert.equal(raw.maxInputTokens, WINDOWS[id].input, `${id} raw maxInputTokens`);
    assert.equal(raw.maxOutputTokens, WINDOWS[id].output, `${id} raw maxOutputTokens`);
    const merged = effectiveModel(id);
    assert.equal(merged.maxInputTokens, WINDOWS[id].input, `${id} merged maxInputTokens`);
    assert.equal(merged.maxOutputTokens, WINDOWS[id].output, `${id} merged maxOutputTokens`);
  }
});

test("per-model window overrides leave thinking mappings and protocol flags on the template", () => {
  for (const id of OVERRIDDEN) {
    const raw = preset.models[id];
    for (const key of ["thinkingLevelMap", "reasoning", "compat"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(raw, key), false, `${id} must not override ${key}`);
    }
    const template = preset.templates[raw.template];
    const merged = effectiveModel(id);
    assert.deepEqual(merged.thinkingLevelMap, template.thinkingLevelMap, `${id} thinkingLevelMap`);
    assert.deepEqual(merged.reasoning, template.reasoning, `${id} reasoning`);
    assert.deepEqual(merged.compat, template.compat, `${id} compat`);
  }
});

test("model-windows docs record the public source, exact values and unknown boundaries", () => {
  const docs = fs.readFileSync(DOCS_PATH, "utf8");
  for (const needle of [
    "listFoundationModels",
    "scope: PUBLIC",
    "total context",
    "input limit",
    "output budget",
    "LanguageModel 不新增原始 `contextWindow`",
    "deepseek-v3.2",
    "glm-5.1",
    "glm-5",
    "glm-4.7",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "kimi-k2.5",
    "kimi-k2-thinking",
    "MiniMax/MiniMax-M2.7",
    "MiniMax/MiniMax-M2.5",
    "MiniMax/MiniMax-M3",
    "kimi-k3",
    "kimi/kimi-k2.8-preview",
    "1,048,576",
    "131,072",
    "UNKNOWN",
  ]) {
    assert.ok(docs.includes(needle), `docs missing ${needle}`);
  }
  assert.match(docs, /MiniMax\/MiniMax-M3.*最大输出.*UNKNOWN|UNKNOWN.*MiniMax\/MiniMax-M3/s);
  assert.match(docs, /kimi-k3.*1,048,576.*131,072|kimi-k3.*131,072.*1,048,576/s);
  assert.match(docs, /qwen3\.8.*991,808.*983,616|qwen3\.8.*983,616.*991,808/s);
});