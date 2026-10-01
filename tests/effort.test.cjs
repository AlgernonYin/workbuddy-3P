"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BASE = path.resolve(__dirname, "..");
const SCRIPT = path.join(BASE, "plugins", "custom-api-models", "scripts", "sync-models.cjs");
const FAKE_KEY = "sk-test-effort-fake-key";
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const UNSUPPORTED_LEVELS = ["off", "ultracode"];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-effort-test-"));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function makeEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_|SYNC_MODELS_TEST_)/i.test(name)) {
      delete env[name];
    }
  }
  delete env.NODE_OPTIONS;

  const fakeHome = path.join(dir, ".home");
  fs.mkdirSync(fakeHome, { recursive: true });
  env.CODEBUDDY_CONFIG_DIR = dir;
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  env.APPDATA = path.join(fakeHome, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(fakeHome, "AppData", "Local");

  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined || value === null) delete env[name];
    else env[name] = String(value);
  }
  return env;
}

function runCliRaw(dir, args = [], extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.dirname(SCRIPT),
    env: makeEnv(dir, extra),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20000,
  });
}

function runCliOk(dir, args = [], extra = {}) {
  const result = runCliRaw(dir, args, extra);
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${args.join(" ") || "sync"} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runApiRaw(dir, expression, extra = {}) {
  const code = [
    "(async()=>{",
    "const api=require(process.env.EFFORT_TEST_SCRIPT);",
    `const result=await (${expression});`,
    "process.stdout.write(JSON.stringify(result));",
    "})().catch((error)=>{",
    "process.stderr.write(String(error && error.message || error));",
    "process.exit(1);",
    "});",
  ].join("");
  return spawnSync(process.execPath, ["-e", code], {
    cwd: path.dirname(SCRIPT),
    env: makeEnv(dir, { ...extra, EFFORT_TEST_SCRIPT: SCRIPT }),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20000,
  });
}

function runApiOk(dir, expression, extra = {}) {
  const result = runApiRaw(dir, expression, extra);
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `API call failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.notEqual(result.stdout.trim(), "", "API call emitted no JSON");
  return JSON.parse(result.stdout);
}

function jsonOut(result) {
  assert.notEqual(result.stdout.trim(), "", "CLI emitted no stdout JSON");
  return JSON.parse(result.stdout);
}

const configPath = (dir) => path.join(dir, "workbuddy-3p.json");
const modelsPath = (dir) => path.join(dir, "models.json");
const effortPath = (dir) => path.join(dir, "workbuddy-3p.effort.json");
const switchPath = (dir) => path.join(dir, "workbuddy-3p.switch");

function findModel(out, id) {
  return (out && out.models || []).find((model) => model && model.id === id) || null;
}

function findStatus(result, target) {
  return (result && result.models || []).find((model) => model && model.target === target) || null;
}

function baseConfig(effort) {
  const config = {
    mode: "explicit",
    default: "lab",
    providers: {
      lab: {
        baseUrl: "http://127.0.0.1:9/v1",
        allowInsecureHttp: true,
        apiKey: FAKE_KEY,
        extraModels: ["alpha", "beta", "plain"],
        models: {
          alpha: {
            supportsReasoning: true,
            compat: {
              supportsReasoningEffort: true,
              thinkingFormat: "openai",
              maxTokensField: "max_tokens",
              supportsTemperature: true,
            },
            thinkingLevelMap: {
              off: null,
              minimal: "minimal",
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            },
            reasoning: {
              supportedEfforts: [...EFFORT_LEVELS],
              defaultEffort: "minimal",
              effort: "minimal",
              canDisableThinking: true,
              summary: "auto",
            },
          },
          beta: {
            supportsReasoning: true,
            compat: {
              supportsReasoningEffort: true,
              thinkingFormat: "openai",
              maxTokensField: "max_tokens",
            },
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: "low",
              medium: "medium",
              high: null,
              xhigh: null,
              max: null,
            },
            reasoning: {
              supportedEfforts: ["low", "medium"],
              defaultEffort: "low",
              effort: "low",
              canDisableThinking: false,
            },
          },
          plain: {
            supportsReasoning: false,
            compat: { supportsReasoningEffort: false },
            thinkingLevelMap: {},
            reasoning: { supportedEfforts: [], canDisableThinking: false },
          },
        },
      },
    },
  };
  if (effort !== undefined) config.effort = clone(effort);
  return config;
}

function nestedConfig() {
  return {
    mode: "explicit",
    default: "lab",
    providers: {
      lab: {
        preset: "bailian",
        apiKey: FAKE_KEY,
        extraModels: ["deepseek-v4.1-flash"],
        models: {
          "deepseek-v4.1-flash": {
            compat: { supportsTemperature: true },
            reasoning: { defaultEffort: "medium" },
          },
        },
      },
    },
    models: {
      "lab:deepseek-v4.1-flash": {
        thinkingLevelMap: { medium: "middle" },
        reasoning: { canDisableThinking: false },
      },
    },
  };
}

function assertStatusShape(result, expectedMode = "third-party") {
  assert.ok(result && typeof result === "object");
  assert.equal(result.ok, true);
  assert.equal(result.configuredMode, expectedMode);
  assert.equal(result.runtimeVerified, false);
  assert.ok(result.preferences && typeof result.preferences === "object");
  assert.ok(result.preferences.local && typeof result.preferences.local === "object");
  assert.ok(result.preferences.config && typeof result.preferences.config === "object");
  assert.ok(Array.isArray(result.models));
  for (const model of result.models) {
    assert.equal(typeof model.target, "string");
    assert.ok(model.target.includes(":"), `target must be provider:model, got ${model.target}`);
    assert.ok(Array.isArray(model.supportedEfforts));
    assert.ok(Object.prototype.hasOwnProperty.call(model, "configuredEffort"));
    assert.ok(Object.prototype.hasOwnProperty.call(model, "baseEffort"));
    assert.equal(typeof model.source, "string");
    assert.ok(model.source.length > 0, "source must identify the winning preference");
    assert.equal(typeof model.applied, "boolean");
    if (model.reason !== undefined) assert.equal(typeof model.reason, "string");
  }
}

function assertFilesUnchanged(dir, snapshots) {
  assert.equal(readTextOrNull(effortPath(dir)), snapshots.effort);
  assert.equal(readTextOrNull(modelsPath(dir)), snapshots.models);
}

function snapshots(dir) {
  return {
    effort: readTextOrNull(effortPath(dir)),
    models: readTextOrNull(modelsPath(dir)),
  };
}

function setExpression(args) {
  return `api.setEffort(${JSON.stringify(args)})`;
}

test("effort-status resolves local model > local default > config model > config default > original", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), baseConfig({ default: "low", models: { "lab:alpha": "medium" } }));
    writeJson(effortPath(dir), { version: 1, default: "high", models: { "lab:alpha": "xhigh" } });
    runCliOk(dir);

    let result = jsonOut(runCliOk(dir, ["--effort-status", "--model", "lab:alpha"]));
    assertStatusShape(result);
    assert.equal(Object.prototype.hasOwnProperty.call(result.preferences.config, "version"), false);
    assert.equal(result.preferences.config.default, "low");
    assert.equal(result.preferences.config.models["lab:alpha"], "medium");
    assert.equal(result.models.length, 1);
    let alpha = findStatus(result, "lab:alpha");
    assert.ok(alpha, "filtered status omitted lab:alpha");
    assert.deepEqual([...alpha.supportedEfforts].sort(), [...EFFORT_LEVELS].sort());
    assert.equal(alpha.baseEffort, "minimal");
    assert.equal(alpha.configuredEffort, "xhigh");
    assert.equal(alpha.applied, true);

    writeJson(effortPath(dir), { version: 1, default: "high", models: {} });
    runCliOk(dir);
    result = jsonOut(runCliOk(dir, ["--effort-status", "--model", "lab:alpha"]));
    alpha = findStatus(result, "lab:alpha");
    assert.equal(alpha.configuredEffort, "high", "local default should beat config model");

    writeJson(effortPath(dir), { version: 1, models: {} });
    runCliOk(dir);
    result = jsonOut(runCliOk(dir, ["--effort-status", "--model", "lab:alpha"]));
    alpha = findStatus(result, "lab:alpha");
    assert.equal(alpha.configuredEffort, "medium", "config model should beat config default");

    writeJson(configPath(dir), baseConfig({ default: "low" }));
    runCliOk(dir);
    result = jsonOut(runCliOk(dir, ["--effort-status", "--model", "lab:alpha"]));
    alpha = findStatus(result, "lab:alpha");
    assert.equal(alpha.configuredEffort, "low", "config default should beat the model original");

    writeJson(configPath(dir), baseConfig());
    runCliOk(dir);
    result = jsonOut(runCliOk(dir, ["--effort-status", "--model", "lab:alpha"]));
    alpha = findStatus(result, "lab:alpha");
    assert.equal(alpha.configuredEffort, "minimal", "model original should be the last fallback");
  } finally {
    rmDir(dir);
  }
});

test("exported setEffort sets default/model preferences and reset scopes", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), baseConfig());
    runCliOk(dir);
    const configBefore = readTextOrNull(configPath(dir));

    let result = runApiOk(dir, setExpression({ action: "set", scope: "default", level: "high" }));
    assertStatusShape(result);
    assert.equal(result.requiresModelReselection, true);
    assert.equal(result.preferences.local.default, "high");

    let local = readJson(effortPath(dir));
    assert.ok(local, "local effort file was not written");
    assert.equal(local.version, 1);
    assert.equal(local.default, "high");
    assert.deepEqual(local.models || {}, {});

    let alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.ok(alpha, "alpha missing after setting default effort");
    assert.equal(alpha.reasoning.defaultEffort, "high");
    assert.equal(alpha.compat.supportsReasoningEffort, true);
    assert.deepEqual([...alpha.reasoning.supportedEfforts].sort(), [...EFFORT_LEVELS].sort());

    const beta = findStatus(result, "lab:beta");
    assert.ok(beta, "beta status missing");
    assert.equal(beta.applied, false, "unsupported model must be skipped for a global default");
    assert.ok(beta.reason, "skipped model must explain why");

    result = runApiOk(dir, setExpression({ action: "set", scope: "model", level: "xhigh", model: "lab:alpha" }));
    assertStatusShape(result);
    assert.equal(result.requiresModelReselection, true);
    local = readJson(effortPath(dir));
    assert.equal(local.default, "high");
    assert.equal(local.models["lab:alpha"], "xhigh");
    alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.equal(alpha.reasoning.defaultEffort, "xhigh");

    result = runApiOk(dir, setExpression({ action: "reset", scope: "model", model: "lab:alpha" }));
    assertStatusShape(result);
    assert.equal(result.requiresModelReselection, true);
    local = readJson(effortPath(dir));
    assert.equal((local.models || {})["lab:alpha"], undefined);
    alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.equal(alpha.reasoning.defaultEffort, "high", "reset model must fall back to local default");

    result = runApiOk(dir, setExpression({ action: "reset", scope: "default" }));
    assertStatusShape(result);
    assert.equal(result.requiresModelReselection, true);
    local = readJson(effortPath(dir));
    assert.equal(local?.default, undefined);
    alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.equal(alpha.reasoning.defaultEffort, "minimal", "reset default must fall back to model original");

    runApiOk(dir, setExpression({ action: "set", scope: "default", level: "medium" }));
    runApiOk(dir, setExpression({ action: "set", scope: "model", level: "max", model: "lab:alpha" }));
    result = runApiOk(dir, setExpression({ action: "reset", scope: "all" }));
    assertStatusShape(result);
    assert.equal(result.requiresModelReselection, true);
    local = readJson(effortPath(dir));
    if (local !== null) {
      assert.equal(local.version, 1);
      assert.equal(local.default, undefined);
      assert.deepEqual(local.models || {}, {});
    }
    alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.equal(alpha.reasoning.defaultEffort, "minimal");
    assert.equal(readTextOrNull(configPath(dir)), configBefore, "setEffort must not rewrite account config");
  } finally {
    rmDir(dir);
  }
});

test("CLI effort settings persist across resync and reset by model/all", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), baseConfig());
    runCliOk(dir);

    let result = jsonOut(runCliOk(dir, ["--effort", "high"]));
    assertStatusShape(result);
    assert.equal(result.requiresModelReselection, true);

    result = jsonOut(runCliOk(dir, ["--effort", "xhigh", "--model", "lab:alpha"]));
    assertStatusShape(result);
    assert.equal(result.requiresModelReselection, true);

    let local = readJson(effortPath(dir));
    assert.equal(local.default, "high");
    assert.equal(local.models["lab:alpha"], "xhigh");

    runCliOk(dir);
    let alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.equal(alpha.reasoning.defaultEffort, "xhigh", "resync lost the persisted model effort");

    let status = jsonOut(runCliOk(dir, ["--effort-status", "--model", "lab:alpha"]));
    assertStatusShape(status);
    assert.equal(findStatus(status, "lab:alpha").configuredEffort, "xhigh");

    result = jsonOut(runCliOk(dir, ["--effort-reset", "--model", "lab:alpha"]));
    assertStatusShape(result);
    assert.equal(result.requiresModelReselection, true);
    local = readJson(effortPath(dir));
    assert.equal((local.models || {})["lab:alpha"], undefined);
    alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.equal(alpha.reasoning.defaultEffort, "high", "model reset should fall back to the local default");

    result = jsonOut(runCliOk(dir, ["--effort-reset"]));
    assertStatusShape(result);
    local = readJson(effortPath(dir));
    assert.equal(local?.default, undefined);
    alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.equal(alpha.reasoning.defaultEffort, "minimal");

    runCliOk(dir, ["--effort", "medium"]);
    runCliOk(dir, ["--effort", "max", "--model", "lab:alpha"]);
    result = jsonOut(runCliOk(dir, ["--effort-reset", "--all"]));
    assertStatusShape(result);
    local = readJson(effortPath(dir));
    if (local !== null) {
      assert.equal(local.version, 1);
      assert.equal(local.default, undefined);
      assert.deepEqual(local.models || {}, {});
    }
    alpha = findModel(readJson(modelsPath(dir)), "alpha");
    assert.equal(alpha.reasoning.defaultEffort, "minimal");
  } finally {
    rmDir(dir);
  }
});

test("illegal and model-unsupported effort levels reject without file changes", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), baseConfig());
    runCliOk(dir);
    runCliOk(dir, ["--effort", "medium", "--model", "lab:alpha"]);

    const beforeRejectedGlobal = snapshots(dir);
    for (const level of [...UNSUPPORTED_LEVELS, "bogus"]) {
      const result = runCliRaw(dir, ["--effort", level]);
      assert.notEqual(result.status, 0, `--effort ${level} should fail`);
      assertFilesUnchanged(dir, beforeRejectedGlobal);
    }

    let result = runApiRaw(dir, setExpression({ action: "set", scope: "default", level: "off" }));
    assert.notEqual(result.status, 0, "API must reject off");
    assertFilesUnchanged(dir, beforeRejectedGlobal);

    for (const level of EFFORT_LEVELS) {
      result = runApiOk(dir, setExpression({ action: "set", scope: "model", level, model: "lab:alpha" }));
      assertStatusShape(result);
      assert.equal(readJson(effortPath(dir)).models["lab:alpha"], level);
    }

    const beforeRejectedModel = snapshots(dir);
    result = runApiRaw(dir, setExpression({ action: "set", scope: "model", level: "xhigh", model: "lab:beta" }));
    assert.notEqual(result.status, 0, "xhigh must be rejected for a model that does not support it");
    assertFilesUnchanged(dir, beforeRejectedModel);
  } finally {
    rmDir(dir);
  }
});

test("official mode saves effort preference but leaves official models.json untouched", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), baseConfig());
    fs.writeFileSync(switchPath(dir), "official\n");
    writeJson(modelsPath(dir), {
      models: [{
        id: "official-a",
        url: "http://127.0.0.1:9/official",
        apiKey: "sk-test-official-fake",
        supportsReasoning: true,
        compat: { supportsReasoningEffort: true },
        reasoning: { supportedEfforts: ["low", "medium", "high"], defaultEffort: "low" },
      }],
      availableModels: ["official-a"],
    });
    const modelsBefore = readTextOrNull(modelsPath(dir));

    let result = runApiOk(dir, setExpression({ action: "set", scope: "default", level: "high" }));
    assertStatusShape(result, "official");
    assert.equal(result.deferred, true, "official mode must report deferred application");
    assert.equal(result.requiresModelReselection, false, "official mode needs no model reselection");
    assert.equal(readTextOrNull(modelsPath(dir)), modelsBefore, "official models.json was modified");

    const local = readJson(effortPath(dir));
    assert.ok(local, "official mode must still save the local preference");
    assert.equal(local.version, 1);
    assert.equal(local.default, "high");

    result = runApiOk(dir, "api.effortStatus()");
    assertStatusShape(result, "official");
    assert.equal(readTextOrNull(modelsPath(dir)), modelsBefore, "effortStatus modified official models.json");
  } finally {
    rmDir(dir);
  }
});

test("account profile config default applies in a fresh sandbox", () => {
  const dir = tempDir();
  try {
    const skillDir = path.join(dir, "skills", "account-effort");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: workbuddy-3p-profile\n---\n");
    const profileConfig = baseConfig({ default: "medium" });
    writeJson(path.join(skillDir, "workbuddy-3p.profile.json"), {
      kind: "workbuddy-3p-private-profile",
      version: 1,
      config: profileConfig,
    });

    assert.equal(fs.existsSync(configPath(dir)), false, "fixture unexpectedly has a local user config");
    let result = jsonOut(runCliOk(dir, ["--effort-status"]));
    assertStatusShape(result);
    assert.equal(result.preferences.config.default, "medium");
    let alpha = findStatus(result, "lab:alpha");
    assert.ok(alpha, "alpha status missing in fresh sandbox");
    assert.equal(alpha.configuredEffort, "medium", "account config default was not applied");
    assert.equal(alpha.applied, true);

    const initialized = readJson(effortPath(dir));
    if (initialized !== null) assert.equal(initialized.version, 1);

    profileConfig.effort = { default: "medium", models: { "lab:alpha": "high" } };
    writeJson(path.join(skillDir, "workbuddy-3p.profile.json"), {
      kind: "workbuddy-3p-private-profile",
      version: 1,
      config: profileConfig,
    });
    runCliOk(dir);
    result = jsonOut(runCliOk(dir, ["--effort-status", "--model", "lab:alpha"]));
    assertStatusShape(result);
    alpha = findStatus(result, "lab:alpha");
    assert.equal(alpha.configuredEffort, "high", "config model must still outrank config default in a fresh sandbox");
  } finally {
    rmDir(dir);
  }
});

test("nested compat/reasoning/thinkingLevelMap overrides preserve capability", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), nestedConfig());
    const result = runApiOk(dir, setExpression({ action: "set", scope: "default", level: "max" }));
    assertStatusShape(result);

    const model = findModel(readJson(modelsPath(dir)), "deepseek-v4.1-flash");
    assert.ok(model, "nested preset model missing");
    assert.equal(model.supportsReasoning, true);
    assert.equal(model.compat.supportsReasoningEffort, true);
    assert.equal(model.compat.thinkingFormat, "qwen");
    assert.equal(model.compat.maxTokensField, "max_tokens");
    assert.equal(model.compat.supportsTemperature, true);
    assert.deepEqual(model.reasoning.supportedEfforts, ["low", "high", "max"]);
    assert.equal(model.reasoning.defaultEffort, "max");
    assert.equal(model.reasoning.canDisableThinking, false);
    assert.equal(model.thinkingLevelMap.off, "none");
    assert.equal(model.thinkingLevelMap.medium, "middle");
    assert.equal(model.thinkingLevelMap.max, "max");

    const status = findStatus(result, "lab:deepseek-v4.1-flash");
    assert.ok(status, "nested model status missing");
    assert.equal(status.configuredEffort, "max");
    assert.equal(status.applied, true);
    assert.deepEqual(status.supportedEfforts, ["low", "high", "max"]);
  } finally {
    rmDir(dir);
  }
});
