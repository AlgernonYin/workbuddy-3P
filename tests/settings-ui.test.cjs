"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const htmlPath = path.resolve(__dirname, "../plugins/custom-api-models/ui/settings.html");
const html = fs.readFileSync(htmlPath, "utf8");

function count(value, needle) {
  return value.split(needle).length - 1;
}

function scriptBody(id) {
  const pattern = new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>');
  const match = html.match(pattern);
  assert.ok(match, "missing script " + id);
  return match[1];
}

function loadInternals() {
  const source = scriptBody("wb3p-ui");
  const sandbox = {
    window: { addEventListener() {} },
    document: {
      readyState: "loading",
      addEventListener() {},
    },
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(source, sandbox, { filename: htmlPath });
  return sandbox.window.__wb3pSettingsInternals;
}

function fixtureState() {
  return {
    revision: 7,
    configuredMode: "third-party",
    parameterPriority: "3p",
    sourceKind: "local",
    readOnly: false,
    defaultProvider: "p",
    routingMode: "same-name",
    providers: [{
      id: "p",
      label: "Provider",
      baseUrl: "https://example.invalid/v1",
      preset: "",
      apiKeyEnv: "OLD_KEY",
      extraModels: ["m1"],
      credential: { kind: "env", configured: true },
    }],
    routes: { "agent-one": "p:m1" },
    models: [
      {
        target: "p:m1",
        id: "m1",
        aliases: ["agent-one"],
        supportedEfforts: ["minimal", "high"],
        canDisableThinking: true,
        configuredEffort: "high",
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        baseInputTokens: 64000,
      },
      {
        target: "p:m2",
        id: "m2",
        aliases: [],
        supportedEfforts: ["medium", "xhigh"],
        canDisableThinking: false,
        configuredEffort: "medium",
        maxInputTokens: 256000,
        maxOutputTokens: 8192,
        baseInputTokens: 128000,
      },
    ],
    note: "目录刷新后重选模型；未验证运行。",
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("template keeps one state placeholder, one bridge placeholder, and no external resources", () => {
  assert.equal(count(html, "__WB3P_STATE__"), 1);
  assert.equal(count(html, "__WB3P_BRIDGE__"), 1);
  assert.match(html, /<script type="application\/json" id="initial-state">__WB3P_STATE__<\/script>/);
  assert.match(html, /<script id="wb3p-bridge">__WB3P_BRIDGE__<\/script>/);

  assert.doesNotMatch(html, /<script[^>]+src\s*=/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /@import\b/i);
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i);
  assert.doesNotMatch(html, /<(?:img|iframe|object|embed)\b/i);
  assert.doesNotMatch(html, /\bfetch\s*\(/);
  assert.doesNotMatch(html, /\b(?:apiPath|apiToken|localStorage|sessionStorage)\b/);
});

test("template avoids unsafe HTML APIs and key inputs", () => {
  assert.doesNotMatch(html, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
  assert.doesNotMatch(html, /type=["']password["']/i);
  assert.doesNotMatch(html, /name=["']apiKey["']/i);
  assert.match(html, /API Key 环境变量名/);
  assert.match(html, /只填写环境变量名称，不要填写密钥值/);
});

test("UI scripts parse and expose testable effort/patch helpers", () => {
  const ui = scriptBody("wb3p-ui");
  assert.doesNotThrow(() => new Function(ui));

  const internals = loadInternals();
  assert.deepEqual(Array.from(internals.EFFORT_ORDER), ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(Array.from(internals.sortEfforts(["max", "low", "medium", "minimal", "high", "xhigh"])),
    ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(internals.highestSupportedEffort(["minimal", "high"]), "high");
  assert.equal(internals.highestSupportedEffort(["minimal", "low", "medium", "high", "xhigh", "max"]), "max");
  assert.equal(internals.highestSupportedEffort([]), null);
  assert.deepEqual(Array.from(internals.effortOptionValues({ canDisableThinking: false, supportedEfforts: ["max", "low"] })), ["low", "max"]);
  assert.deepEqual(Array.from(internals.effortOptionValues({ canDisableThinking: true, supportedEfforts: ["low", "max"] })), ["off", "on", "low", "max"]);
});

test("bridge contract and offline wording are explicit", () => {
  assert.match(html, /window\.wb3pBridge/);
  assert.match(html, /await bridge\.connect\(\)/);
  assert.match(html, /bridge\.subscribe\(onBridgeNotification\)/);
  assert.match(html, /bridge\.callTool\(request\)/);
  assert.match(html, /bridge\.notifySize\(\)/);
  assert.match(html, /ui\/notifications\/tool-result/);
  assert.match(html, /设置未应用/);
  assert.match(html, /尚未应用/);
  assert.match(html, /请调用 models_settings 工具应用以下设置/);
  assert.match(html, /下载无密钥 JSON 草案/);
  assert.match(html, /DOMContentLoaded/);
  assert.match(html, /等待模型配置/);
});

test("state extraction accepts direct, nested bridge, and tool-result shapes", () => {
  const internals = loadInternals();
  const state = fixtureState();
  assert.equal(internals.extractState(state), state);
  assert.equal(internals.extractState({ state }), state);
  assert.equal(internals.extractState({ structuredContent: { state } }), state);
  assert.equal(internals.extractState({ result: { structuredContent: { state } } }), state);
  assert.equal(internals.extractState({ params: { structuredContent: { state } } }), state);
  assert.equal(internals.extractState({ hello: "world" }), null);
});

test("parameter priority defaults to 3p and is patched only when changed", () => {
  const internals = loadInternals();
  assert.equal(internals.normalizeParameterPriority(undefined), "3p");
  assert.equal(internals.normalizeParameterPriority("native"), "native");
  assert.equal(internals.normalizeParameterPriority("unexpected"), "3p");

  const original = fixtureState();
  assert.deepEqual(JSON.parse(JSON.stringify(internals.makePatch(original, clone(original)))), {});
  const draft = clone(original);
  draft.parameterPriority = "native";
  assert.deepEqual(JSON.parse(JSON.stringify(internals.makePatch(original, draft))), { parameterPriority: "native" });
});

test("patch builder sends only changed fields and preserves null semantics", () => {
  const internals = loadInternals();
  const original = fixtureState();
  const draft = clone(original);
  draft.switchMode = "official";
  draft.models[0].configuredEffort = null;
  draft.models[1].maxInputTokens = null;
  draft.providers[0].label = "Renamed";
  draft.providers[0].apiKeyEnv = "NEW_KEY";
  draft.providers[0].apiKeyEnvTouched = true;
  draft.defaultProvider = null;
  draft.routingMode = "explicit";
  delete draft.routes["agent-one"];
  draft.routes["agent-two"] = "p:m2";
  draft.maxEffortRequested = false;

  assert.deepEqual(JSON.parse(JSON.stringify(internals.makePatch(original, draft))), {
    switchMode: "official",
    efforts: { "p:m1": null },
    contexts: { "p:m2": null },
    providers: {
      p: {
        label: "Renamed",
        baseUrl: "https://example.invalid/v1",
        preset: "",
        extraModels: ["m1"],
        apiKeyEnv: "NEW_KEY",
      },
    },
    defaultProvider: "",
    routingMode: "explicit",
    routes: { "agent-one": null, "agent-two": "p:m2" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(internals.makePatch(original, clone(original)))), {});
});

test("maximum-effort mode is exclusive with explicit effort edits", () => {
  const internals = loadInternals();
  const original = fixtureState();
  const draft = clone(original);
  draft.models[0].configuredEffort = "minimal";
  draft.models[1].configuredEffort = "xhigh";
  draft.maxEffortRequested = true;
  const patch = JSON.parse(JSON.stringify(internals.makePatch(original, draft)));
  assert.equal(patch.maxEffort, true);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "efforts"), false);
});

test("thinking switch exposes off and on without turning high into an adjustable level", () => {
  const internals = loadInternals();
  assert.deepEqual(
    Array.from(internals.effortOptionValues({ canDisableThinking: true, supportedEfforts: [] })),
    ["off", "on"],
  );
  assert.deepEqual(
    Array.from(internals.effortOptionValues({ canDisableThinking: false, supportedEfforts: ["high"] })),
    ["high"],
  );
  assert.deepEqual(
    Array.from(internals.effortOptionValues({ canDisableThinking: true, supportedEfforts: ["minimal", "high"] })),
    ["off", "on", "minimal", "high"],
  );
  assert.equal(highestSupportedOnly(internals), "high");
});

function highestSupportedOnly(internals) {
  return internals.highestSupportedEffort(["minimal", "high"]);
}

test("provider endpoint edits require explicit credential reuse or a new environment reference", () => {
  const internals = loadInternals();
  const original = fixtureState();
  const draft = clone(original);
  draft.providers[0].baseUrl = "https://changed.invalid/v2";
  draft.providers[0].reuseCredential = true;
  const patch = JSON.parse(JSON.stringify(internals.makePatch(original, draft)));
  assert.equal(patch.providers.p.baseUrl, "https://changed.invalid/v2");
  assert.equal(patch.providers.p.reuseCredential, true);
  assert.equal(Object.prototype.hasOwnProperty.call(patch.providers.p, "apiKeyEnv"), false);
});

test("provider edits do not erase an untouched environment variable name", () => {
  const internals = loadInternals();
  const original = fixtureState();
  const draft = clone(original);
  draft.providers[0].label = "Renamed";
  draft.providers[0].apiKeyEnvTouched = false;
  const patch = internals.makePatch(original, draft);
  assert.equal(patch.providers.p.label, "Renamed");
  assert.equal(Object.prototype.hasOwnProperty.call(patch.providers.p, "apiKeyEnv"), false);
});

test("mobile layout declares bounded grid and no horizontal overflow", () => {
  assert.match(html, /html,\s*body\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*hidden/s);
  assert.match(html, /\.shell\s*\{[^}]*max-width:\s*100%[^}]*min-width:\s*0/s);
  assert.match(html, /@media\s*\(max-width:\s*700px\)[\s\S]*?grid-template-columns:\s*1fr;/);
});

test("required labels and form controls are present for providers and routes", () => {
  for (const label of [
    "Provider ID", "显示名称 label", "Base URL", "Preset", "API Key 环境变量名", "额外模型",
    "参数优先级", "3P 优先", "宿主原生优先", "原生直连", "自运行回环参数适配",
    "路由别名 alias", "路由目标 target", "默认 Provider", "路由模式", "思考档位", "最大输入 token",
    "更换地址时复用原凭据",
  ]) assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /添加 Provider/);
  assert.match(html, /删除路由/);
  assert.match(html, /添加路由/);
  assert.match(html, /全部设为各自最高可用档/);
  assert.match(html, /不支持 max 的模型不会写成 max/);
  assert.match(html, /开启思考（无强度档位）/);
  assert.match(html, /更换地址时复用原凭据/);
  assert.match(html, /bridge\.callTool\(\{ action: "status" \}\)/);
  assert.match(html, /structuredContent/);
  assert.match(html, /旧缓存代理返回 410/);
});