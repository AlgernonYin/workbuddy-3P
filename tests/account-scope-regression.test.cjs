"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const effort = require("../plugins/custom-api-models/scripts/effort.cjs");
const createSettings = require("../plugins/custom-api-models/scripts/settings.cjs");

function fakeModel() {
  return {
    maxInputTokens: 64000,
    supportsReasoning: true,
    reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "low", canDisableThinking: true },
    thinkingLevelMap: { off: "none", low: "low", high: "high" },
    compat: { thinkingFormat: "openai", supportsReasoningEffort: true }
  };
}

function fakeConfig({ enabled = "third-party", parameterPriority = "3p", label = "Session", effortPrefs = {}, contextPrefs = { version: 1 }, apiKeyEnv } = {}) {
  const provider = {
    label,
    baseUrl: "https://fake.invalid/v1",
    extraModels: ["m"],
    models: { m: fakeModel() },
    ...(apiKeyEnv ? { apiKeyEnv } : { apiKey: "fake-inline-key" })
  };
  return { mode: "explicit", enabled, parameterPriority, providers: { p: provider }, routes: {}, effort: effortPrefs, context: contextPrefs };
}

function fakePaths(dir) {
  return {
    dir,
    models: path.join(dir, "models.json"),
    state: path.join(dir, "workbuddy-3p.state.json"),
    effort: path.join(dir, "workbuddy-3p.effort.json"),
    context: path.join(dir, "workbuddy-3p.context.json"),
    switch: path.join(dir, "workbuddy-3p.switch"),
    parameters: path.join(dir, "workbuddy-3p.parameters.json"),
    lastError: path.join(dir, "workbuddy-3p.last-error.json")
  };
}

function harness(t, { baseline, sessionCfg, sessionEffort, sessionContext, sessionParameters, accountBaselineApi = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb3p-account-scope-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = fakePaths(dir);
  const cfg = sessionCfg || fakeConfig({
    enabled: "third-party",
    parameterPriority: "3p",
    label: "Session",
    effortPrefs: { default: "low", models: { "p:m": "low" } },
    contextPrefs: { version: 1, models: { "p:m": 64000 } }
  });
  const localEffort = sessionEffort || { version: 1, default: "low", models: { "p:m": "low" } };
  const localContext = sessionContext || { version: 1, models: { "p:m": 64000 } };
  const localParameters = sessionParameters || { version: 1, priority: "3p" };
  const core = {
    loadConfig: () => ({ cfg, from: path.join(dir, "workbuddy-3p.json") }),
    resolveSwitch: (_dir, value) => ({ mode: value?.enabled === "official" ? "official" : "third-party" }),
    readEffort: () => localEffort,
    readContext: () => localContext,
    readParameters: () => localParameters,
    buildPlan: async (value, _dir, _prev, options = {}) => {
      const preferences = options.preferences || {};
      const configured = value.effort || {};
      const contexts = options.contextPreferences || {};
      const configuredEffort = preferences.models?.["p:m"] || preferences.default || configured.models?.["p:m"] || configured.default || "low";
      const maxInputTokens = contexts.models?.["p:m"] || 64000;
      return {
        models: [{ id: "m", aliases: [], maxOutputTokens: 2048 }],
        owner: new Map([["m", "p"]]),
        providers: { p: { preset: null } },
        effort: { models: [{ target: "p:m", model: "m", supportedEfforts: ["low", "high"], canDisableThinking: true, configuredEffort, applied: true }] },
        contexts: [{ target: "p:m", baseInputTokens: 64000, maxInputTokens, source: "local:model" }],
        warnings: []
      };
    },
    accountMeta: () => ({ available: true, status: "synced", revision: "fake-account-revision" }),
    accountBaseline: () => baseline || null,
    presetFingerprint: () => "fake-preset-fingerprint",
    configCandidates: () => [],
    loadPreset: () => null,
    resolveKey: async () => ({ key: "fake-private-key" }),
    writeAtomic: (file, text) => fs.writeFileSync(file, text),
    writeAtomicChecked: (file, text) => fs.writeFileSync(file, text),
    syncUnlocked: async () => ({ ok: true, changed: false }),
    parseModels: () => ({}),
    readState: () => ({ managed: [], missing: true }),
    checkOwnership: () => {},
    fingerprint: () => "fake-fingerprint",
    officialModels: ["official"]
  };
  if (!accountBaselineApi) delete core.accountBaseline;
  return { p, settings: createSettings(core) };
}

test("importSession removes masked config models so effective high is not downgraded to low", async t => {
  const h = harness(t, {
    baseline: null,
    sessionCfg: fakeConfig({ effortPrefs: { models: { "p:m": "low" } } }),
    sessionEffort: { version: 1, default: "high" },
    sessionContext: { version: 1 }
  });
  const state = await h.settings.viewUnlocked(h.p);
  const prepared = await h.settings.prepareAccount(h.p, {
    action: "apply", scope: "account", expectedRevision: state.revision, patch: {}, importSession: true
  });
  assert.deepEqual(prepared.cfg.effort, { default: "high", models: {} });
  const applied = effort.applyEfforts(
    [{ id: "m", supportsReasoning: true, reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "low", canDisableThinking: true }, compat: { supportsReasoningEffort: true, thinkingFormat: "openai" }, thinkingLevelMap: { off: "none", low: "low", high: "high" } }],
    new Map([["m", "p"]]), { version: 1 }, prepared.cfg.effort, true
  );
  assert.equal(applied.models[0].configuredEffort, "high");
});

test("account label patch preserves the published baseline mode, priority, effort and context", async t => {
  const baseline = fakeConfig({
    enabled: "official",
    parameterPriority: "native",
    label: "Account",
    effortPrefs: { default: "high", models: { "p:m": "high" } },
    contextPrefs: { version: 1, models: { "p:m": 32000 } },
    apiKeyEnv: "FAKE_ACCOUNT_KEY"
  });
  const h = harness(t, { baseline: { cfg: baseline, from: "fake-account-cache" } });
  const state = await h.settings.viewUnlocked(h.p);
  assert.equal(state.scope, "account");
  assert.equal(state.configuredMode, "official");
  assert.equal(state.parameterPriority, "native");
  const prepared = await h.settings.prepareAccount(h.p, {
    action: "apply", scope: "account", expectedRevision: state.revision, patch: { providers: { p: { label: "Account label" } } }
  });
  assert.equal(prepared.cfg.providers.p.label, "Account label");
  assert.equal(prepared.cfg.providers.p.apiKeyEnv, undefined);
  assert.equal(prepared.cfg.providers.p.apiKey, "fake-private-key");
  assert.equal(prepared.cfg.enabled, "official");
  assert.equal(prepared.cfg.parameterPriority, "native");
  assert.deepEqual(prepared.cfg.effort, { default: "high", models: { "p:m": "high" } });
  assert.deepEqual(prepared.cfg.context, { version: 1, models: { "p:m": 32000 } });
});

test("session view remains session-scoped while the default view uses the account baseline", async t => {
  const baseline = fakeConfig({
    enabled: "official",
    parameterPriority: "native",
    label: "Account",
    effortPrefs: { default: "high", models: { "p:m": "high" } },
    contextPrefs: { version: 1, models: { "p:m": 32000 } }
  });
  const session = fakeConfig({
    enabled: "third-party",
    parameterPriority: "3p",
    label: "Session",
    effortPrefs: { default: "low", models: { "p:m": "low" } },
    contextPrefs: { version: 1, models: { "p:m": 64000 } }
  });
  const h = harness(t, { baseline: { cfg: baseline, from: "fake-account-cache" }, sessionCfg: session });
  const account = await h.settings.viewUnlocked(h.p, { scope: "account" });
  const sessionView = await h.settings.viewUnlocked(h.p, { scope: "session" });
  assert.equal(account.providers[0].label, "Account");
  assert.equal(account.configuredMode, "official");
  assert.equal(account.parameterPriority, "native");
  assert.equal(account.models.find(m => m.id === "m").configuredEffort, "high");
  assert.equal(account.models.find(m => m.id === "m").maxInputTokens, 32000);
  assert.equal(sessionView.providers[0].label, "Session");
  assert.equal(sessionView.configuredMode, "third-party");
  assert.equal(sessionView.parameterPriority, "3p");
  assert.equal(sessionView.models.find(m => m.id === "m").configuredEffort, "low");
  assert.equal(sessionView.models.find(m => m.id === "m").maxInputTokens, 64000);
});

test("no baseline without importSession is patch-only and never absorbs session parameters", async t => {
  const h = harness(t, { baseline: null });
  const state = await h.settings.viewUnlocked(h.p);
  const prepared = await h.settings.prepareAccount(h.p, {
    action: "apply",
    scope: "account",
    expectedRevision: state.revision,
    patch: { providers: { p: { label: "Explicit account", baseUrl: "https://fake.invalid/v1", extraModels: ["m"], models: { m: fakeModel() } } } }
  });
  assert.equal(prepared.cfg.providers.p.label, "Explicit account");
  assert.equal(prepared.cfg.enabled, "official");
  assert.equal(prepared.cfg.parameterPriority, undefined);
  assert.deepEqual(prepared.cfg.effort, {});
  assert.deepEqual(prepared.cfg.context, { version: 1 });
  assert.equal(prepared.cfg.routes, undefined);
});

test("revision tracks the account baseline independently of session runtime files", async t => {
  const baseline = fakeConfig({ enabled: "official", parameterPriority: "native", label: "Account" });
  const h = harness(t, { baseline: { cfg: baseline, from: "fake-account-cache" } });
  const before = await h.settings.viewUnlocked(h.p);
  baseline.providers.p.label = "Account changed";
  const after = await h.settings.viewUnlocked(h.p);
  assert.notEqual(before.revision, after.revision);
  assert.equal(after.providers[0].label, "Account changed");
});
