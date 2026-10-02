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

test("13. routing preserves user allowlist entries and uninstall restores hidden official ids", () => {
  const dir = tempDir();
  try {
    writeJson(modelsPath(dir), {
      models: [{ id: "my-own", url: "https://user.invalid/chat/completions", apiKey: "sk-user" }],
      availableModels: ["glm-5.3", "custom-local:my-own"],
    });
    const env = { WB3P_BASE_URL: "https://managed.example.invalid/v1", WB3P_API_KEY: KEY };

    runOk(dir, env);
    let out = readJson(modelsPath(dir));
    assert.ok(out, "models.json was not written by sync");
    let allow = out.availableModels || [];
    assert.ok(!allow.includes("glm-5.3"), "routed official glm-5.3 should be hidden");
    assert.ok(allow.includes("custom-local:glm-5.3"), "plugin custom-local:glm-5.3 missing");
    assert.ok(allow.includes("custom-local:my-own"), "user custom-local:my-own missing");

    runOk(dir, env, ["--uninstall"]);
    out = readJson(modelsPath(dir));
    assert.ok(out, "models.json was not written by uninstall");
    allow = out.availableModels || [];
    assert.ok(allow.includes("glm-5.3"), "uninstall did not restore official glm-5.3");
    assert.ok(allow.includes("custom-local:my-own"), "uninstall removed user custom-local:my-own");
    assert.ok(!allow.includes("custom-local:glm-5.3"), "uninstall left plugin custom-local:glm-5.3");
  } finally {
    rmDir(dir);
  }
});

test("14. keepOfficial is bypassed by an explicit route but otherwise keeps the official id", () => {
  const dir = tempDir();
  const config = (routes) => ({
    default: "p",
    mode: "same-name",
    keepOfficial: ["glm-5.3"],
    providers: { p: { baseUrl: "https://keep.example.invalid/v1", apiKey: KEY } },
    routes,
  });
  try {
    writeJson(configPath(dir), config({ "glm-5.1": "x-model" }));
    let result = runOk(dir);
    let summary = jsonOut(result);
    let out = readJson(modelsPath(dir));
    assert.ok(out, "models.json was not written");
    const idsAndAliases = (out.models || []).flatMap((model) => [model.id, ...(model.aliases || [])]);
    assert.ok(!idsAndAliases.includes("glm-5.3"), "keepOfficial id must not be a model id or alias");
    assert.ok((out.availableModels || []).includes("glm-5.3"), "keepOfficial id missing from availableModels");
    const x = findModel(out, "x-model");
    assert.ok(x, "explicit route x-model missing");
    assert.ok((x.aliases || []).includes("glm-5.1"), "explicit route x-model lost its official alias");
    assert.equal(summary.routed["glm-5.1"], "p / x-model", "explicit glm-5.1 route was not applied");

    writeJson(configPath(dir), config({ "glm-5.1": "x-model", "glm-5.3": "y" }));
    result = runOk(dir);
    summary = jsonOut(result);
    out = readJson(modelsPath(dir));
    const y = findModel(out, "y");
    assert.ok(y, "explicit glm-5.3 route y missing");
    assert.ok((y.aliases || []).includes("glm-5.3"), "explicit route y lost its glm-5.3 alias");
    assert.ok(!(out.availableModels || []).includes("glm-5.3"), "explicit route should override keepOfficial");
    assert.equal(summary.routed["glm-5.3"], "p / y", "explicit glm-5.3 route did not override keepOfficial");
  } finally {
    rmDir(dir);
  }
});

test("15. only WB3P_API_KEY does not create a provider or models.json", () => {
  const dir = tempDir();
  try {
    const result = runOk(dir, { WB3P_API_KEY: KEY });
    const out = jsonOut(result);
    assert.equal(out.active, false, "sync should be inactive without a base URL or preset");
    assert.equal(fs.existsSync(modelsPath(dir)), false, "models.json must not be written");
    assert.equal(readJson(statePath(dir)), null, "state file must not be written");
  } finally {
    rmDir(dir);
  }
});

test("16. a provider without a key does not inherit another provider key on the same URL", () => {
  const dir = tempDir();
  const sharedUrl = "https://shared.example.invalid/v1";
  const routes = { "glm-5.0": "a:model-a", "glm-5.1": "b:model-b" };
  try {
    writeJson(configPath(dir), {
      default: "a",
      mode: "explicit",
      providers: {
        a: { baseUrl: sharedUrl, apiKey: "sk-test-a" },
        b: { baseUrl: sharedUrl, apiKey: "sk-test-b" },
      },
      routes,
    });
    runOk(dir);

    writeJson(configPath(dir), {
      default: "a",
      mode: "explicit",
      providers: {
        a: { baseUrl: sharedUrl, apiKey: "sk-test-a" },
        b: { baseUrl: sharedUrl },
      },
      routes,
    });
    runOk(dir);

    const out = readJson(modelsPath(dir));
    assert.ok(out, "models.json was not written");
    const a = findModel(out, "model-a");
    const b = findModel(out, "model-b");
    assert.ok(a, "provider A model missing");
    assert.equal(a.apiKey, "sk-test-a", "provider A model used the wrong key");
    assert.ok(!b || b.apiKey === "sk-test-b", `provider B model must keep its previous key or be absent, got ${b && b.apiKey}`);
    assert.ok(
      !(out.models || []).some((model) => model.id === "model-b" && model.apiKey === "sk-test-a"),
      "provider B model inherited provider A key",
    );
  } finally {
    rmDir(dir);
  }
});

test("17. duplicate upstream model ids are skipped with an ownership warning", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), {
      default: "a",
      mode: "explicit",
      providers: {
        a: { baseUrl: "https://shared.example.invalid/v1", apiKey: "sk-test-a" },
        b: { baseUrl: "https://shared.example.invalid/v1", apiKey: "sk-test-b" },
      },
      routes: { "glm-5.0": "a:foo", "glm-5.1": "b:foo" },
    });

    const result = runOk(dir);
    const summary = jsonOut(result);
    const out = readJson(modelsPath(dir));
    const fooModels = (out.models || []).filter((model) => model.id === "foo");
    assert.equal(fooModels.length, 1, "duplicate upstream ids must produce one model");
    assert.equal(fooModels[0].apiKey, "sk-test-a", "the first provider should own the duplicate upstream id");
    assert.ok(
      (summary.warnings || []).some((warning) => warning.includes("already belongs")),
      `expected an ownership warning, got ${JSON.stringify(summary.warnings)}`,
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(summary.routed, "glm-5.1"), "skipped route must not be reported as routed");
    assert.ok((out.availableModels || []).includes("glm-5.1"), "skipped official slot must remain available as official");
  } finally {
    rmDir(dir);
  }
});

test("18. invalid route JSON, corrupt config, and bogus mode fail without writing models", () => {
  const expectFailure = (dir, extra = {}) => {
    const result = runRaw(dir, extra);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, `expected nonzero exit, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(fs.existsSync(modelsPath(dir)), false, "models.json must not be written on failure");
    return result;
  };

  const routesDir = tempDir();
  try {
    const result = expectFailure(routesDir, {
      WB3P_BASE_URL: "https://managed.example.invalid/v1",
      WB3P_API_KEY: KEY,
      WB3P_ROUTES: "{bad",
    });
    assert.match(result.stderr, /ROUTES is not valid JSON/, "invalid ROUTES error missing");
  } finally {
    rmDir(routesDir);
  }

  const configDir = tempDir();
  try {
    fs.writeFileSync(configPath(configDir), "{bad", "utf8");
    const result = expectFailure(configDir);
    assert.match(result.stderr, /is not valid JSON/, "corrupt config error missing");
  } finally {
    rmDir(configDir);
  }

  const modeDir = tempDir();
  try {
    writeJson(configPath(modeDir), {
      default: "p",
      mode: "bogus",
      providers: { p: { baseUrl: "https://managed.example.invalid/v1", apiKey: KEY } },
    });
    const result = expectFailure(modeDir);
    assert.match(result.stderr, /mode must be one of/, "bogus mode error missing");
  } finally {
    rmDir(modeDir);
  }
});

test("19. explicit route to an official same-name model keeps the official slot", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), {
      default: "p",
      mode: "explicit",
      providers: { p: { baseUrl: "https://explicit.example.invalid/v1", apiKey: KEY } },
      routes: { "glm-5.0": "glm-5.1" },
    });

    runOk(dir);
    const out = readJson(modelsPath(dir));
    assert.ok((out.availableModels || []).includes("glm-5.1"), "official glm-5.1 slot missing");
    assert.ok(!(out.availableModels || []).includes("glm-5.0"), "routed glm-5.0 should be hidden");
    assert.ok(!findModel(out, "glm-5.0"), "glm-5.0 must not be a model id");
    const model = findModel(out, "glm-5.1");
    assert.ok(model, "explicit route should create glm-5.1");
    assert.ok((model.aliases || []).includes("glm-5.0"), "explicit route should alias glm-5.0");
  } finally {
    rmDir(dir);
  }
});

test("20. a user model with a managed id is displaced, warned, and restored on uninstall", () => {
  const dir = tempDir();
  const userUrl = "https://user.invalid/chat/completions";
  try {
    writeJson(modelsPath(dir), {
      models: [{ id: "glm-5.3", url: userUrl, apiKey: "sk-test-user" }],
      availableModels: ["glm-5.3"],
    });
    const env = { WB3P_BASE_URL: "https://managed.example.invalid/v1", WB3P_API_KEY: KEY };

    const result = runOk(dir, env);
    const summary = jsonOut(result);
    let out = readJson(modelsPath(dir));
    let model = findModel(out, "glm-5.3");
    assert.ok(model, "plugin glm-5.3 model missing");
    assert.equal(model.url, expectedChatUrl(env.WB3P_BASE_URL), "plugin should replace the user model");
    assert.equal(model.apiKey, KEY, "plugin model should use the sync key");
    assert.ok(
      (summary.warnings || []).some((warning) => warning.includes("user model glm-5.3 is replaced")),
      `missing replacement warning, got ${JSON.stringify(summary.warnings)}`,
    );

    runOk(dir, env, ["--uninstall"]);
    out = readJson(modelsPath(dir));
    model = findModel(out, "glm-5.3");
    assert.ok(model, "user glm-5.3 model was not restored");
    assert.equal(model.url, userUrl, "uninstall did not restore the user model URL");
    assert.equal(model.apiKey, "sk-test-user", "uninstall did not restore the user model key");
  } finally {
    rmDir(dir);
  }
});

test("21. insecure HTTP is rejected unless local or explicitly allowed", () => {
  const configFor = (baseUrl, allowInsecureHttp = false) => ({
    default: "p",
    mode: "explicit",
    providers: {
      p: {
        baseUrl,
        apiKey: KEY,
        ...(allowInsecureHttp ? { allowInsecureHttp: true } : {}),
      },
    },
    routes: { "glm-5.0": "glm-5.0" },
  });

  const remoteDir = tempDir();
  try {
    writeJson(configPath(remoteDir), configFor("http://remote.example.invalid/v1"));
    const result = runRaw(remoteDir);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, "remote HTTP should fail");
    assert.match(result.stderr, /must use https/, "remote HTTP failure message missing");
    assert.equal(fs.existsSync(modelsPath(remoteDir)), false, "remote HTTP must not write models.json");
  } finally {
    rmDir(remoteDir);
  }

  const localDir = tempDir();
  try {
    writeJson(configPath(localDir), configFor("http://127.0.0.1:8080/v1"));
    runOk(localDir);
    const out = readJson(modelsPath(localDir));
    assert.ok(findModel(out, "glm-5.0"), "local HTTP should be allowed");
  } finally {
    rmDir(localDir);
  }

  const allowedDir = tempDir();
  try {
    writeJson(configPath(allowedDir), configFor("http://remote.example.invalid/v1", true));
    runOk(allowedDir);
    const out = readJson(modelsPath(allowedDir));
    assert.ok(findModel(out, "glm-5.0"), "allowInsecureHttp should allow remote HTTP");
  } finally {
    rmDir(allowedDir);
  }
});

test("22. switch commands persist official mode and CLI status does not expose keys", () => {
  const writeSwitchConfig = (dir) => {
    writeJson(configPath(dir), {
      default: "p",
      mode: "same-name",
      providers: { p: { baseUrl: "https://switch.example.invalid/v1", apiKey: KEY } },
    });
    return path.join(dir, "workbuddy-3p.switch");
  };

  const dir = tempDir();
  const original = {
    models: [{ id: "my-own", url: "https://user.invalid/chat/completions", apiKey: "sk-test-user" }],
    availableModels: ["custom-local:my-own"],
  };
  try {
    writeJson(modelsPath(dir), original);
    writeSwitchConfig(dir);
    runOk(dir);
    let out = readJson(modelsPath(dir));
    assert.ok(findModel(out, "glm-5.0"), "sync did not create a routed model");

    const official = jsonOut(runOk(dir, {}, ["--official"]));
    assert.equal(official.switch, "official", "--official output should report official");
    out = readJson(modelsPath(dir));
    assert.ok(!findModel(out, "glm-5.0"), "official mode left a plugin model");
    assert.equal((out.models || []).length, 1, "official mode should preserve only the user model");
    assert.equal(out.models[0].id, "my-own", "official mode changed the user model");
    assert.deepEqual(out.availableModels || [], original.availableModels, "official mode did not restore availableModels");
    assert.equal(fs.existsSync(statePath(dir)), false, "official mode did not delete state");

    const persisted = jsonOut(runOk(dir));
    assert.equal(persisted.switch, "official", "switch file should persist official mode");
    assert.equal(persisted.active, false, "official mode should remain inactive");
    assert.ok(!findModel(readJson(modelsPath(dir)), "glm-5.0"), "official mode was not persisted");

    const thirdParty = jsonOut(runOk(dir, {}, ["--third-party"]));
    assert.equal(thirdParty.switch, "third-party", "--third-party output should report third-party");
    assert.ok(findModel(readJson(modelsPath(dir)), "glm-5.0"), "--third-party did not restore routing");

    const cleared = jsonOut(runOk(dir, {}, ["--switch", "clear"]));
    assert.equal(cleared.switch, "third-party", "--switch clear should return to default third-party mode");
    assert.ok(findModel(readJson(modelsPath(dir)), "glm-5.0"), "--switch clear should leave routing active by default");
    assert.equal(fs.existsSync(path.join(dir, "workbuddy-3p.switch")), false, "--switch clear did not remove the switch file");
  } finally {
    rmDir(dir);
  }

  const envOfficialDir = tempDir();
  try {
    writeSwitchConfig(envOfficialDir);
    const result = jsonOut(runOk(envOfficialDir, { WB3P_ENABLED: "official" }));
    const out = readJson(modelsPath(envOfficialDir));
    assert.equal(result.active, false, "WB3P_ENABLED=official should be inactive");
    assert.ok(!out || !findModel(out, "glm-5.0"), "WB3P_ENABLED=official should not route models");
  } finally {
    rmDir(envOfficialDir);
  }

  const priorityDir = tempDir();
  try {
    const switchPath = writeSwitchConfig(priorityDir);
    fs.writeFileSync(switchPath, "third-party\n", "utf8");
    const result = jsonOut(runOk(priorityDir, { WB3P_ENABLED: "official" }));
    assert.equal(result.switch, "third-party", "switch file should take priority over WB3P_ENABLED");
    assert.ok(findModel(readJson(modelsPath(priorityDir)), "glm-5.0"), "switch file priority did not route models");
  } finally {
    rmDir(priorityDir);
  }

  const statusDir = tempDir();
  try {
    const switchPath = writeSwitchConfig(statusDir);
    fs.writeFileSync(switchPath, "official\n", "utf8");
    const result = runOk(statusDir, {}, ["--status"]);
    const status = jsonOut(result);
    assert.equal(status.switch, "official", "--status should report the switch field");
    assert.ok(!result.stdout.includes(KEY), "--status exposed the API key");
    assert.ok(!JSON.stringify(status).includes(KEY), "--status JSON exposed the API key");
  } finally {
    rmDir(statusDir);
  }
});

test("23. one provider without a key produces a partial success summary", () => {
  const dir = tempDir();
  try {
    writeJson(configPath(dir), {
      default: "a",
      mode: "explicit",
      providers: {
        a: { baseUrl: "https://a.example.invalid/v1", apiKey: "sk-test-a" },
        b: { baseUrl: "https://b.example.invalid/v1" },
      },
      routes: { "glm-5.0": "a:foo", "glm-5.1": "b:bar" },
    });

    const result = runOk(dir);
    const summary = jsonOut(result);
    assert.equal(summary.ok, false, "partial sync must not report ok");
    assert.equal(summary.partial, true, "partial sync must report partial");
    assert.ok(
      (summary.warnings || []).some((warning) => warning.includes("provider b: no API key")),
      `missing key warning, got ${JSON.stringify(summary.warnings)}`,
    );
  } finally {
    rmDir(dir);
  }
});

test("24. concurrent syncs leave one valid models.json and no lock file", async () => {
  const { spawn } = require("node:child_process");
  const env = { WB3P_BASE_URL: "https://concurrent.example.invalid/v1", WB3P_API_KEY: KEY };
  const spawnAsync = (dir, extra) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: path.dirname(SCRIPT),
      env: makeEnv(dir, extra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });

  const singleDir = tempDir();
  const concurrentDir = tempDir();
  try {
    runOk(singleDir, env);
    const single = readJson(modelsPath(singleDir));
    assert.ok(single, "single sync did not produce valid JSON");
    const singleCount = (single.models || []).length;
    assert.ok(singleCount > 0, "single sync produced no models");

    const [first, second] = await Promise.all([
      spawnAsync(concurrentDir, env),
      spawnAsync(concurrentDir, env),
    ]);
    for (const result of [first, second]) {
      assert.equal(result.status, 0, `concurrent sync failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(result.signal, null, `concurrent sync was killed by ${result.signal}`);
    }

    const out = readJson(modelsPath(concurrentDir));
    assert.ok(out && Array.isArray(out.models), "concurrent sync did not leave valid models.json");
    assert.equal(out.models.length, singleCount, "concurrent sync changed the model count");
    assert.equal(fs.existsSync(path.join(concurrentDir, "workbuddy-3p.lock")), false, "lock file was left behind");
  } finally {
    rmDir(singleDir);
    rmDir(concurrentDir);
  }
});
