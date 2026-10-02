"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BASE = path.resolve(__dirname, "..");
const SCRIPT = path.join(BASE, "plugins", "custom-api-models", "scripts", "sync-models.cjs");
const PRESETS = path.join(BASE, "plugins", "custom-api-models", "presets");
const OFFICIAL = JSON.parse(fs.readFileSync(path.join(PRESETS, "workbuddy-official.json"), "utf8"));
const KEY = "sk-test-123";
const API_ENV = "SYNC_MODELS_TEST_API_KEY";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-sync-test-"));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
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

function makeEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_|SYNC_MODELS_TEST_)/i.test(name)) {
      delete env[name];
    }
  }
  env.CODEBUDDY_CONFIG_DIR = dir;
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined || value === null) delete env[name];
    else env[name] = String(value);
  }
  env.WB3P_PARAMETER_PRIORITY = "native";
  return env;
}

function runRaw(dir, extra = {}, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.dirname(SCRIPT),
    env: makeEnv(dir, extra),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function runOk(dir, extra = {}, args = []) {
  const result = runRaw(dir, extra, args);
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${args.join(" ") || "sync"} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function jsonOut(result) {
  assert.notEqual(result.stdout.trim(), "", "CLI emitted no stdout JSON");
  return JSON.parse(result.stdout);
}

const modelsPath = (dir) => path.join(dir, "models.json");
const statePath = (dir) => path.join(dir, "workbuddy-3p.state.json");
const configPath = (dir) => path.join(dir, "workbuddy-3p.json");

function findModel(out, id) {
  return (out.models || []).find((model) => model && model.id === id) || null;
}

function expectedChatUrl(base) {
  const normalized = String(base).replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function assertMode600(file) {
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${file} must be mode 0600`);
  }
}

test("1. no config and no key does not produce managed models", () => {
  const dir = tempDir();
  try {
    runOk(dir);
    const out = readJson(modelsPath(dir));
    assert.ok(out === null || !Array.isArray(out.models) || out.models.length === 0, "models.json contains managed models");
    const state = readJson(statePath(dir));
    assert.ok(state === null || !Array.isArray(state.managed) || state.managed.length === 0, "state contains managed models");
  } finally {
    rmDir(dir);
  }
});

test("2. WB3P_BASE_URL plus key routes every official id as same-name", () => {
  const variants = [
    "https://api.example.invalid/v1",
    "https://api.example.invalid/v1/",
    "https://api.example.invalid/v1/chat/completions",
    "https://api.example.invalid/v1/chat/completions/",
  ];

  for (const baseUrl of variants) {
    const dir = tempDir();
    try {
      const result = runOk(dir, { WB3P_BASE_URL: baseUrl, WB3P_API_KEY: KEY });
      const summary = jsonOut(result);
      const out = readJson(modelsPath(dir));
      assert.ok(out, "models.json was not written");

      const byId = new Map((out.models || []).map((model) => [model.id, model]));
      assert.equal(byId.size, OFFICIAL.routable.length, `unexpected model count for ${baseUrl}`);
      assert.equal(summary.providers[0].name, "custom", `unexpected env provider name for ${baseUrl}`);
      assert.deepEqual(Object.keys(summary.routed).sort(), [...OFFICIAL.routable].sort(), `summary.routed should include every same-name route for ${baseUrl}`);
      for (const id of OFFICIAL.routable) {
        assert.equal(summary.routed[id], `custom / ${id}`, `summary.routed[${id}] should include the same-name route and custom label`);
      }
      assert.deepEqual(summary.extra, [], `same-name env routing should have no extra models for ${baseUrl}`);

      for (const id of OFFICIAL.routable) {
        const model = byId.get(id);
        assert.ok(model, `missing routable model ${id}`);
        assert.equal(model.url, expectedChatUrl(baseUrl), `wrong URL for ${id}`);
        assert.equal(model.apiKey, KEY, `wrong key for ${id}`);
        assert.deepEqual(model.aliases || [], [], `${id} should be a same-name model without aliases`);
      }

      for (const id of OFFICIAL.keepOfficial) {
        assert.ok((out.availableModels || []).includes(id), `kept official model ${id} missing from availableModels`);
      }
      assert.ok((out.availableModels || []).includes("hunyuan-chat"), "hunyuan-chat should remain official");
      for (const id of OFFICIAL.routable) {
        assert.ok((out.availableModels || []).includes(`custom-local:${id}`), `custom-local:${id} missing from availableModels`);
      }

      assertMode600(modelsPath(dir));
    } finally {
      rmDir(dir);
    }
  }
});

test("3. bailian preset maps aliases, merges Kimi ids, and keeps unsupported official models", () => {
  const dir = tempDir();
  try {
    const result = runOk(dir, { WB3P_PRESET: "bailian", WB3P_API_KEY: KEY });
    const summary = jsonOut(result);
    const out = readJson(modelsPath(dir));
    assert.ok(out, "models.json was not written");

    const byId = new Map((out.models || []).map((model) => [model.id, model]));
    assert.equal(summary.providers[0].name, "bailian", "preset should be the default provider name");
    assert.equal(summary.routed["glm-5.0"], "百炼 Bailian / glm-5", "summary.routed should use the preset label");
    assert.equal(summary.routed["kimi-k3"], "百炼 Bailian / kimi-k3", "summary.routed should include same-name preset routes");
    assert.deepEqual([...summary.extra].sort(), ["qwen3.8-flash", "qwen3.8-max"], "summary.extra should contain only models without an official slot");
    const glm5 = byId.get("glm-5");
    assert.ok(glm5, "glm-5 model missing");
    assert.ok((glm5.aliases || []).includes("glm-5.0"), "glm-5.0 alias missing");

    const kimi = byId.get("kimi-k3");
    assert.ok(kimi, "kimi-k3 model missing");
    for (const alias of ["kimi-k3-1", "kimi-k3-2"]) {
      assert.ok((kimi.aliases || []).includes(alias), `${alias} should alias kimi-k3`);
    }
    assert.equal((out.models || []).filter((model) => model.id === "kimi-k3").length, 1, "kimi-k3 must be one entry");
    assert.ok(!byId.has("kimi-k3-1"), "kimi-k3-1 must not be a separate model");
    assert.ok(!byId.has("kimi-k3-2"), "kimi-k3-2 must not be a separate model");

    for (const id of ["glm-5v-turbo", "glm-5.3-flash"]) {
      assert.ok(!byId.has(id), `${id} must not be routed`);
      assert.ok((out.availableModels || []).includes(id), `${id} must remain in availableModels as official`);
    }

    const qwen = byId.get("qwen3.8-max");
    assert.ok(qwen, "qwen3.8-max extra model missing");
    assert.deepEqual(qwen.aliases || [], [], "qwen3.8-max should have no aliases");

    assertMode600(modelsPath(dir));
  } finally {
    rmDir(dir);
  }
});

test("4. config file routes support official, provider:model, provider same-name, and bare model", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), {
      default: "p1",
      providers: {
        p1: { baseUrl: "https://p1.example.invalid/v1", apiKey: "sk-test-p1" },
        p2: { baseUrl: "https://p2.example.invalid/v1", apiKey: "sk-test-p2" },
      },
      routes: {
        "deepseek-v4.1-flash": "official",
        "glm-5.0": "p2:model-x",
        "glm-5.1": "p2",
        "glm-5.2": "bare-model",
      },
    });

    const result = runOk(dir);
    const summary = jsonOut(result);
    const out = readJson(modelsPath(dir));
    assert.ok(out, "models.json was not written");
    const byId = new Map((out.models || []).map((model) => [model.id, model]));

    assert.equal(summary.routed["glm-5.0"], "p2 / model-x", "provider:model route missing from summary.routed");
    assert.equal(summary.routed["glm-5.1"], "p2 / glm-5.1", "provider same-name route missing from summary.routed");
    assert.equal(summary.routed["glm-5.2"], "p1 / bare-model", "bare model route missing from summary.routed");
    assert.ok(!Object.prototype.hasOwnProperty.call(summary.routed, "deepseek-v4.1-flash"), "official override must not be reported as a custom route");

    assert.ok(!byId.has("deepseek-v4.1-flash"), "official override must not create a custom model");
    assert.ok((out.availableModels || []).includes("deepseek-v4.1-flash"), "official override missing from availableModels");
    assert.ok(
      !(out.models || []).some((model) => (model.aliases || []).includes("deepseek-v4.1-flash")),
      "official override must not appear in aliases",
    );

    const providerModel = byId.get("model-x");
    assert.ok(providerModel, "provider:model route did not create model-x");
    assert.equal(providerModel.url, expectedChatUrl("https://p2.example.invalid/v1"));
    assert.equal(providerModel.name, "p2 / model-x", "provider name should be the label fallback");
    assert.ok((providerModel.aliases || []).includes("glm-5.0"), "provider:model route lost its official alias");

    const sameName = byId.get("glm-5.1");
    assert.ok(sameName, "provider same-name route did not create glm-5.1");
    assert.equal(sameName.url, expectedChatUrl("https://p2.example.invalid/v1"));
    assert.equal(sameName.name, "p2 / glm-5.1", "provider same-name model should use the provider name label");
    assert.deepEqual(sameName.aliases || [], [], "same-name provider route should have no aliases");

    const bare = byId.get("bare-model");
    assert.ok(bare, "bare model route did not create bare-model");
    assert.equal(bare.url, expectedChatUrl("https://p1.example.invalid/v1"));
    assert.equal(bare.name, "p1 / bare-model", "bare model route should use the default provider name label");
    assert.ok((bare.aliases || []).includes("glm-5.2"), "bare model route lost its official alias");
  } finally {
    rmDir(dir);
  }
});

test("5. user model survives sync and uninstall", () => {
  const dir = tempDir();
  try {
    writeJson(modelsPath(dir), {
      models: [{ id: "my-own", url: "https://user.example.invalid/chat/completions", apiKey: "sk-test-user" }],
      availableModels: ["custom-local:my-own"],
    });
    const env = { WB3P_BASE_URL: "https://managed.example.invalid/v1", WB3P_API_KEY: KEY };

    runOk(dir, env);
    let out = readJson(modelsPath(dir));
    assert.ok(out, "models.json was not written by sync");
    assert.ok(findModel(out, "my-own"), "user model disappeared during sync");
    assert.ok(findModel(out, "deepseek-v4.1-flash"), "managed model missing during sync");
    assert.ok((out.availableModels || []).includes("custom-local:my-own"), "user availableModels entry disappeared during sync");

    runOk(dir, env, ["--uninstall"]);
    out = readJson(modelsPath(dir));
    assert.ok(out, "models.json was not written by uninstall");
    assert.deepEqual((out.models || []).map((model) => model.id), ["my-own"], "uninstall removed the wrong models");
    assert.deepEqual(out.availableModels || [], ["custom-local:my-own"], "uninstall removed the wrong availableModels entries");
    assert.ok(!fs.existsSync(statePath(dir)), "state file was not removed by uninstall");
  } finally {
    rmDir(dir);
  }
});

test("6. sync is idempotent and backs up only an existing models.json", () => {
  const env = { WB3P_BASE_URL: "https://managed.example.invalid/v1", WB3P_API_KEY: KEY };
  const absentDir = tempDir();
  try {
    const first = jsonOut(runOk(absentDir, env));
    assert.equal(first.changed, true, "first sync should report a change");
    assert.ok(!fs.existsSync(modelsPath(absentDir) + ".bak-workbuddy-3p"), "absent models.json must not create a backup");

    const second = jsonOut(runOk(absentDir, env));
    assert.equal(second.changed, false, "second sync should be unchanged");
    assert.ok(!fs.existsSync(modelsPath(absentDir) + ".bak-workbuddy-3p"), "unchanged second sync must not create a backup");
  } finally {
    rmDir(absentDir);
  }

  const existingDir = tempDir();
  try {
    writeJson(modelsPath(existingDir), {
      models: [{ id: "my-own", url: "https://user.example.invalid/chat/completions" }],
      availableModels: ["custom-local:my-own"],
    });
    const before = fs.readFileSync(modelsPath(existingDir), "utf8");
    const first = jsonOut(runOk(existingDir, env));
    assert.equal(first.changed, true, "first sync over an existing file should report a change");
    assert.ok(fs.existsSync(modelsPath(existingDir) + ".bak-workbuddy-3p"), "existing models.json was not backed up");
    assert.equal(fs.readFileSync(modelsPath(existingDir) + ".bak-workbuddy-3p", "utf8"), before, "backup does not match the original file");

    const second = jsonOut(runOk(existingDir, env));
    assert.equal(second.changed, false, "second sync over an existing file should be unchanged");
  } finally {
    rmDir(existingDir);
  }
});

test("7. enabled:false behaves like uninstall", () => {
  const cfg = {
    default: "main",
    providers: { main: { baseUrl: "https://managed.example.invalid/v1", apiKey: KEY } },
  };
  const disabledDir = tempDir();
  const controlDir = tempDir();
  try {
    writeJson(configPath(disabledDir), cfg);
    writeJson(configPath(controlDir), cfg);

    runOk(disabledDir);
    runOk(controlDir);
    assert.ok((readJson(modelsPath(disabledDir)).models || []).length > 0, "setup sync produced no managed models");

    writeJson(configPath(disabledDir), { ...cfg, enabled: false });
    const disabledResult = jsonOut(runOk(disabledDir));
    runOk(controlDir, {}, ["--uninstall"]);

    assert.equal(disabledResult.disabled, true, "disabled sync did not report disabled");
    assert.deepEqual(readJson(modelsPath(disabledDir)), readJson(modelsPath(controlDir)), "disabled sync differs from uninstall");
    assert.ok(!fs.existsSync(statePath(disabledDir)), "disabled sync did not remove state file");
  } finally {
    rmDir(disabledDir);
    rmDir(controlDir);
  }
});

test("8. JSON stdout does not expose the API key", () => {
  const dir = tempDir();
  try {
    const env = { WB3P_BASE_URL: "https://managed.example.invalid/v1", WB3P_API_KEY: KEY };

    const dryRun = runOk(dir, env, ["--dry-run"]);
    jsonOut(dryRun);
    assert.ok(!dryRun.stdout.includes(KEY), "dry-run stdout exposed the API key");
    assert.ok(!dryRun.stderr.includes(KEY), "dry-run stderr exposed the API key");

    const normal = runOk(dir, env);
    jsonOut(normal);
    assert.ok(!normal.stdout.includes(KEY), "sync stdout exposed the API key");
    assert.ok(!normal.stderr.includes(KEY), "sync stderr exposed the API key");
  } finally {
    rmDir(dir);
  }
});

test("9. key source priority follows provider, env, named env, default env, file, then secrets", async (t) => {
  function runCase(name, providerExtra, envExtra, expected) {
    const dir = tempDir();
    try {
      const apiKeyFile = path.join(dir, "api-key.json");
      const defaultKeyFile = path.join(dir, "default-api-key.json");
      const secretFile = path.join(dir, "workbuddy-3p.secrets", "p");
      writeJson(apiKeyFile, { apiKey: "sk-file" });
      writeJson(defaultKeyFile, { apiKey: "sk-default-file" });
      fs.mkdirSync(path.dirname(secretFile), { recursive: true });
      fs.writeFileSync(secretFile, "sk-secret");

      const provider = { baseUrl: "https://managed.example.invalid/v1", ...providerExtra };
      if (provider.apiKeyFile === "$FILE") provider.apiKeyFile = apiKeyFile;

      const env = { ...envExtra };
      if (env.WB3P_API_KEY_FILE === "$FILE") env.WB3P_API_KEY_FILE = defaultKeyFile;

      writeJson(configPath(dir), { default: "p", providers: { p: provider } });
      runOk(dir, env);

      const out = readJson(modelsPath(dir));
      const model = findModel(out, "deepseek-v4.1-flash");
      assert.ok(model, `${name}: routed model missing`);
      assert.equal(model.apiKey, expected, `${name}: wrong key source`);
    } finally {
      rmDir(dir);
    }
  }

  const cases = [
    {
      name: "provider.apiKey wins",
      provider: { apiKey: "sk-provider", apiKeyEnv: API_ENV, apiKeyFile: "$FILE" },
      env: { [API_ENV]: "sk-api-env", WB3P_P_API_KEY: "sk-named", WB3P_API_KEY: "sk-default", WB3P_API_KEY_FILE: "$FILE" },
      expected: "sk-provider",
    },
    {
      name: "apiKeyEnv wins",
      provider: { apiKeyEnv: API_ENV, apiKeyFile: "$FILE" },
      env: { [API_ENV]: "sk-api-env", WB3P_P_API_KEY: "sk-named", WB3P_API_KEY: "sk-default", WB3P_API_KEY_FILE: "$FILE" },
      expected: "sk-api-env",
    },
    {
      name: "WB3P_<NAME>_API_KEY wins",
      provider: { apiKeyFile: "$FILE" },
      env: { WB3P_P_API_KEY: "sk-named", WB3P_API_KEY: "sk-default", WB3P_API_KEY_FILE: "$FILE" },
      expected: "sk-named",
    },
    {
      name: "default WB3P_API_KEY wins over files",
      provider: { apiKeyFile: "$FILE" },
      env: { WB3P_API_KEY: "sk-default", WB3P_API_KEY_FILE: "$FILE" },
      expected: "sk-default",
    },
    {
      name: "apiKeyFile wins over secrets",
      provider: { apiKeyFile: "$FILE" },
      env: {},
      expected: "sk-file",
    },
    {
      name: "secrets file is the final fallback",
      provider: {},
      env: {},
      expected: "sk-secret",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => runCase(item.name, item.provider, item.env, item.expected));
  }
});

test("10. an illegal preset name fails without writing files", () => {
  const dir = tempDir();
  try {
    const result = runRaw(dir, { WB3P_PRESET: "../x", WB3P_API_KEY: KEY });
    assert.notEqual(result.status, 0, "illegal preset name should fail");
    assert.match(result.stderr, /bad preset name/, "stderr should explain the invalid preset");
    assert.equal(readJson(modelsPath(dir)), null, "models.json must not be written");
    assert.equal(readJson(statePath(dir)), null, "state file must not be written");
  } finally {
    rmDir(dir);
  }
});

test("11. env provider naming and label fallback follow provider, preset, then provider name", () => {
  const envDir = tempDir();
  try {
    const result = runOk(envDir, { WB3P_BASE_URL: "https://custom.example.invalid/v1", WB3P_API_KEY: KEY });
    const summary = jsonOut(result);
    assert.equal(summary.providers[0].name, "custom", "env without a preset should default the provider name to custom");
    assert.equal(summary.routed["glm-5.0"], "custom / glm-5.0", "env without a label should fall back to the provider name");
  } finally {
    rmDir(envDir);
  }

  const presetDir = tempDir();
  try {
    const result = runOk(presetDir, { WB3P_PRESET: "bailian", WB3P_API_KEY: KEY });
    const summary = jsonOut(result);
    assert.equal(summary.providers[0].name, "bailian", "env preset should become the provider name");
    assert.equal(summary.routed["glm-5.0"], "百炼 Bailian / glm-5", "preset label should be used before the provider name");
  } finally {
    rmDir(presetDir);
  }

  const presetLabelDir = tempDir();
  try {
    writeJson(configPath(presetLabelDir), {
      default: "fallback",
      providers: { fallback: { preset: "bailian", apiKey: KEY } },
    });
    const result = runOk(presetLabelDir);
    const summary = jsonOut(result);
    assert.equal(summary.providers[0].name, "fallback", "config provider name should be preserved");
    assert.equal(summary.routed["glm-5.0"], "百炼 Bailian / glm-5", "preset label should beat the provider name");
  } finally {
    rmDir(presetLabelDir);
  }

  const providerLabelDir = tempDir();
  try {
    writeJson(configPath(providerLabelDir), {
      default: "custom-provider",
      providers: { "custom-provider": { preset: "bailian", label: "Custom Label", apiKey: KEY } },
    });
    const result = runOk(providerLabelDir);
    const summary = jsonOut(result);
    assert.equal(summary.providers[0].name, "custom-provider", "provider name should be preserved with a custom label");
    assert.equal(summary.routed["glm-5.0"], "Custom Label / glm-5", "provider label should beat the preset label");
  } finally {
    rmDir(providerLabelDir);
  }
});

test("12. an extra model with an official id does not hide that official slot", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), {
      default: "p",
      mode: "explicit",
      providers: {
        p: {
          baseUrl: "https://extra.example.invalid/v1",
          apiKey: KEY,
          extraModels: ["glm-5.0"],
        },
      },
    });

    const result = runOk(dir);
    const summary = jsonOut(result);
    const out = readJson(modelsPath(dir));
    assert.ok(summary, "sync summary missing");
    assert.ok((summary.extra || []).includes("glm-5.0"), "glm-5.0 should be reported as an extra model");
    assert.ok(!Object.prototype.hasOwnProperty.call(summary.routed || {}, "glm-5.0"), "extra model must not be reported as routed");
    assert.ok(findModel(out, "glm-5.0"), "extra model should be written");
    assert.ok((out.availableModels || []).includes("custom-local:glm-5.0"), "extra custom slot missing");
    assert.ok((out.availableModels || []).includes("glm-5.0"), "extra model must not hide the official glm-5.0 slot");
  } finally {
    rmDir(dir);
  }
});
