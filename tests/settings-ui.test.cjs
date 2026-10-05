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
    document: { readyState: "loading", addEventListener() {} },
    URL,
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(source, sandbox, { filename: htmlPath });
  return sandbox.window.__wb3pSettingsInternals;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureState() {
  return {
    revision: "rev-7",
    readOnly: false,
    accountSync: { available: true, revision: "account-3", status: "ready" },
    providers: [{
      id: "provider-a",
      protocol: "openai-chat",
      nativeSessionSupported: true,
      label: "Provider A",
      baseUrl: "https://api.example.invalid/v1",
      apiKeyEnv: "PROVIDER_A_KEY",
      extraModels: ["model-a"],
      credential: { configured: true, kind: "environment" },
      models: {
        "model-a": {
          maxInputTokens: 128000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsImages: false,
          supportedEfforts: ["low", "high"],
          canDisableThinking: true,
          defaultEffort: "high",
          protocolCompat: ["openai-chat"],
        },
      },
    }],
    routes: {
      "official-model": "provider-a:model-a",
      restored: "official",
    },
    officialModels: ["official-model"],
  };
}

test("template keeps bridge placeholders and no external or credential-bearing resources", () => {
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
  assert.doesNotMatch(html, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
  assert.doesNotMatch(html, /type=["']password["']/i);
  assert.doesNotMatch(html, /<textarea\b/i);
  assert.doesNotMatch(html, /name=["']apiKey["']/i);
  assert.match(html, /凭据环境变量名/);
  assert.match(html, /只填写环境变量名称，不要填写密钥值/);
});

test("public template removes personal defaults and dangerous convenience controls", () => {
  assert.doesNotMatch(html, /maxEffort/i);
  assert.doesNotMatch(html, /highest/i);
  assert.doesNotMatch(html, /最高/);
  assert.doesNotMatch(html, /new-provider-preset/i);
  assert.doesNotMatch(html, /name=["']preset["']/i);
  assert.doesNotMatch(html, /same-name/i);
  assert.doesNotMatch(html, /routing-mode/i);
  assert.doesNotMatch(html, /bailian|百炼/i);
  assert.doesNotMatch(html, /全部设为各自最高可用档/);
  assert.doesNotMatch(html, /apiType|useCustomProtocol/i);
  assert.match(html, /仅支持 OpenAI 兼容的 Chat Completions API/);
  assert.doesNotMatch(html, /协议必须显式选择|多协议|协议转换由后端负责/);
  assert.match(html, /Native 会话固定 ChatCompletions/);
  assert.match(html, /不执行协议转换/);
  assert.match(html, /不能成为 Native 会话映射/);
  assert.match(html, /global draft/);
});

test("native session support is explicit and metadata-only providers cannot be routed", () => {
  const internals = loadInternals();
  const state = internals.normalizeState({
    revision: "r",
    providers: [
      { id: "chat", protocol: "openai-chat", nativeSessionSupported: true, models: { m: {} } },
      { id: "anthropic", protocol: "anthropic-messages", nativeSessionSupported: false, hostProtocolReason: "host is chat-completions only", models: { m: {} } },
    ],
    routes: {},
  });
  assert.deepEqual(Array.from(internals.importedTargets(state), item => item.target), ["chat:m"]);
  assert.equal(state.providers[1].hostProtocolReason, "host is chat-completions only");
});
test("management tabs and single OpenAI-compatible Chat Completions provider controls are present", () => {
  assert.match(html, /role="tablist"/);
  assert.match(html, /供应商及模型/);
  assert.match(html, />路由</);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-controls="panel-providers"/);
  assert.match(html, /aria-controls="panel-routing"/);
  for (const label of [
    "仅支持 OpenAI 兼容的 Chat Completions API", "Base URL", "显示名称 label", "凭据环境变量名",
    "拉取支持的模型", "测试该模型连通性", "导入所选（尚未保存）",
    "ctx / maxInputTokens", "maxOutputTokens", "supportsTools", "supportsImages",
    "reasoning supportedEfforts（逗号声明）", "canDisableThinking", "defaultEffort",
    "官方模型名或输入别名", "目标 provider:model", "恢复官方", "删除路由（提交 null）",
  ]) assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /value="openai-chat"/);
  assert.doesNotMatch(html, /value="openai-responses"/);
  assert.doesNotMatch(html, /value="anthropic-messages"/);
  assert.doesNotMatch(html, /<select id="new-provider-protocol"/);
  assert.match(html, /route-target/);
});

test("scope defaults to account, exposes session only as advanced, and fails closed when account sync is unavailable", () => {
  assert.match(html, /name="save-scope" value="account" checked/);
  assert.match(html, /scope=account，默认/);
  assert.match(html, /高级选项：仅当前会话/);
  assert.match(html, /scope=session/);
  assert.match(html, /state\.accountSync\.available 缺失或为 false/);
  assert.match(html, /不会把不可用状态伪装成本地保存成功/);
  assert.match(html, /页面不会自动改成本地成功/);
  const internals = loadInternals();
  const state = internals.normalizeState({ revision: "r", providers: [], routes: {} });
  assert.equal(state.accountSync.available, false);
});

test("discover and probe arguments match the backend contract; billable is click-only probe data", () => {
  const internals = loadInternals();
  assert.deepEqual(JSON.parse(JSON.stringify(internals.discoverRequest("p"))), { action: "discover", providerId: "p" });
  assert.deepEqual(JSON.parse(JSON.stringify(internals.probeRequest("p", "m"))), { action: "probe", providerId: "p", model: "m", allowBillable: true });
  assert.equal(count(html, "allowBillable: true"), 1);
  assert.match(html, /只证明原生端点/);
  assert.match(html, /不证明宿主协议支持/);
  assert.match(html, /不会修改配置/);
  assert.match(html, /保存并收到回执后才能执行/);
});

test("unknown capabilities stay unknown instead of receiving guessed defaults", () => {
  const internals = loadInternals();
  const unknown = internals.normalizeCapability({});
  assert.equal(unknown.maxInputTokens, null);
  assert.equal(unknown.maxOutputTokens, null);
  assert.equal(unknown.supportsTools, null);
  assert.equal(unknown.supportsImages, null);
  assert.equal(unknown.supportedEfforts, null);
  assert.equal(unknown.canDisableThinking, null);
  assert.equal(unknown.defaultEffort, null);
  assert.equal(unknown.protocolCompat, null);

  const discovered = internals.normalizeCapability({ id: "m", ctx: 64000, capabilities: { tools: true, images: false } });
  assert.equal(discovered.maxInputTokens, 64000);
  assert.equal(discovered.supportsTools, true);
  assert.equal(discovered.supportsImages, false);
  assert.equal(discovered.maxOutputTokens, null);
  assert.equal(discovered.supportedEfforts, null);
  assert.equal(internals.normalizeCapability({ supportsToolCall: true }).supportsTools, true);
});

test("legacy string routes are read without creating destructive patches", () => {
  const internals = loadInternals();
  const state = internals.normalizeState(fixtureState());
  assert.equal(state.routes["official-model"].kind, "target");
  assert.equal(state.routes["official-model"].provider, "provider-a");
  assert.equal(state.routes.restored.kind, "official");
  assert.deepEqual(JSON.parse(JSON.stringify(internals.makePatch(state, clone(state)))), {});

  const draft = clone(state);
  delete draft.routes["official-model"];
  draft.routes["new-route"] = { kind: "target", provider: "provider-a", model: "model-a", effort: "low" };
  const patch = JSON.parse(JSON.stringify(internals.makePatch(state, draft)));
  assert.deepEqual(patch.routes, {
    "official-model": null,
    restored: "official",
    "new-route": { provider: "provider-a", model: "model-a", effort: "low" },
  });
});

test("apply request defaults to account scope and carries the expected revision", () => {
  const internals = loadInternals();
  const original = internals.normalizeState(fixtureState());
  const draft = clone(original);
  const account = JSON.parse(JSON.stringify(internals.createApplyRequest(original, draft)));
  assert.equal(account.action, "apply");
  assert.equal(account.scope, "account");
  assert.equal(account.expectedRevision, "rev-7");
  assert.deepEqual(account.patch, {});
  draft.scope = "session";
  assert.equal(internals.createApplyRequest(original, draft).scope, "session");
});

test("route effort options only expose declared effort levels and model default", () => {
  const internals = loadInternals();
  assert.deepEqual(Array.from(internals.effortOptionValues({ defaultEffort: "high", supportedEfforts: ["low", "high"], canDisableThinking: false })), ["high", "low"]);
  assert.deepEqual(Array.from(internals.effortOptionValues({ supportedEfforts: [], canDisableThinking: true })), ["off", "on"]);
  assert.deepEqual(Array.from(internals.effortOptionValues({ defaultEffort: "medium", supportedEfforts: ["xhigh", "medium"] })), ["medium", "xhigh"]);
});

test("offline instruction carries scope and revision but no credential material", () => {
  const internals = loadInternals();
  const request = {
    action: "apply",
    scope: "session",
    expectedRevision: "rev-7",
    patch: { providers: { p: { apiKeyEnv: "PROVIDER_A_KEY" } } },
  };
  const text = internals.createOfflineInstruction(request);
  assert.match(text, /scope=session/);
  assert.match(text, /expectedRevision=rev-7/);
  assert.match(text, /尚未应用/);
  assert.doesNotMatch(text, /sk-secret/);
  assert.doesNotMatch(text, /apiKey"\s*:/);
});

test("bridge receipts require committed plus session or accountCommitted confirmation", () => {
  const internals = loadInternals();
  assert.equal(internals.hasCommitReceipt({ committed: true, revision: "new" }, "session"), false);
  assert.equal(internals.hasCommitReceipt({ committed: false, session: true, revision: "new" }, "session"), false);
  assert.equal(internals.hasCommitReceipt({ committed: true, session: true, revision: "new" }, "session"), true);
  assert.equal(internals.hasCommitReceipt({ committed: true, accountCommitted: true, revision: "new" }, "account"), true);
  assert.equal(internals.hasCommitReceipt({ committed: true, session: true, revision: "new" }, "account"), false);
});

test("state extraction accepts direct, nested, structured and tool-result shapes only when state-shaped", () => {
  const internals = loadInternals();
  const state = fixtureState();
  assert.equal(internals.extractState(state).revision, state.revision);
  assert.equal(internals.extractState({ state }).revision, state.revision);
  assert.equal(internals.extractState({ structuredContent: { state } }).revision, state.revision);
  assert.equal(internals.extractState({ result: { structuredContent: { state } } }).revision, state.revision);
  assert.equal(internals.extractState({ params: { structuredContent: { state } } }).revision, state.revision);
  assert.equal(internals.extractState({ hello: "world" }), null);
  assert.equal(internals.extractState({ ok: true }), null);
  assert.equal(internals.extractState({ ok: true, committed: true, accountCommitted: true, revision: "account-revision" }), null);
  assert.equal(internals.extractState({ ok: true, loginRequired: true, authorizationUrl: "https://www.workbuddy.cn/auth" }), null);
});

test("configured mode and parameter priority round-trip into their apply patch fields", () => {
  const internals = loadInternals();
  const original = internals.normalizeState({
    revision: "rev-mode",
    configuredMode: "third-party",
    parameterPriority: "native",
    accountSync: { available: true, status: "synced", revision: "account-mode" },
    providers: [],
    routes: {},
  });
  assert.equal(original.configuredMode, "third-party");
  assert.equal(original.parameterPriority, "native");
  assert.equal(internals.normalizeConfiguredMode("official"), "official");
  assert.equal(internals.normalizeConfiguredMode("unexpected"), "official");
  assert.equal(internals.normalizeParameterPriority("3p"), "3p");
  assert.equal(internals.normalizeParameterPriority("unexpected"), "3p");

  const draft = clone(original);
  draft.configuredMode = "official";
  draft.parameterPriority = "3p";
  const patch = JSON.parse(JSON.stringify(internals.makePatch(original, draft)));
  assert.deepEqual(patch, { switchMode: "official", parameterPriority: "3p" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(internals.createApplyRequest(original, draft).patch)),
    { switchMode: "official", parameterPriority: "3p" },
  );
  assert.match(html, /<option value="official">官方<\/option>/);
  assert.match(html, /<option value="third-party">第三方 API<\/option>/);
});

test("account connection only accepts the official WorkBuddy HTTPS URL and offline guidance is explicit", () => {
  const internals = loadInternals();
  assert.equal(internals.isAllowedWorkBuddyUrl("https://www.workbuddy.cn/path?q=1"), true);
  assert.equal(internals.isAllowedWorkBuddyUrl("http://www.workbuddy.cn/path"), false);
  assert.equal(internals.isAllowedWorkBuddyUrl("https://workbuddy.cn/path"), false);
  assert.equal(internals.isAllowedWorkBuddyUrl("https://www.workbuddy.cn.evil.test/path"), false);
  assert.equal(internals.isAllowedWorkBuddyUrl("https://user:pass@www.workbuddy.cn/path"), false);
  assert.equal(internals.isAllowedWorkBuddyUrl("https://www.workbuddy.cn:444/path"), false);

  const text = internals.createAccountInstruction("connect");
  assert.match(text, /"action": "connect"/);
  assert.match(text, /https:\/\/www\.workbuddy\.cn/);
  assert.match(text, /尚未执行/);
  assert.doesNotMatch(text, /连接成功/);
  assert.match(html, /bridge\.callTool\(\{ action: "connect" \}\)/);
  assert.match(html, /bridge\.callTool\(\{ action: "finish-connect" \}\)/);
  assert.match(html, /bridge\.callTool\(\{ action: "status" \}\)/);
  assert.match(html, /id="account-connect-button"/);
  assert.match(html, /id="account-finish-button"/);
});

test("confirmation-required is text-only, user-triggered, and retries with the exact type array", () => {
  const internals = loadInternals();
  const types = ["account-publish-confirm", "overwrite-remote-profile"];
  const outcome = internals.classifyApplyResult({
    ok: false,
    confirmationRequired: true,
    confirmationTypes: types,
  }, "account");
  assert.equal(outcome.kind, "confirmation-required");
  assert.deepEqual(Array.from(outcome.confirmationTypes), types);

  const request = { action: "apply", scope: "account", expectedRevision: "rev-7", patch: { switchMode: "third-party" } };
  const retry = internals.withConfirmedConfirmationTypes(request, types);
  assert.deepEqual(JSON.parse(JSON.stringify(retry.confirmedConfirmationTypes)), types);
  assert.equal(Object.prototype.hasOwnProperty.call(request, "confirmedConfirmationTypes"), false);
  assert.match(html, /id="confirm-apply-button"/);
  assert.match(html, /document\.getElementById\("confirm-apply-button"\)\.addEventListener\("click", confirmApply\)/);
  assert.match(html, /typesNode\.appendChild\(createElement\("div", "", type\)\)/);
});

test("outcomeUnknown, publicationPending, and account-unsynced commits block duplicate apply", () => {
  const internals = loadInternals();
  assert.deepEqual(
    JSON.parse(JSON.stringify(internals.classifyApplyResult({ ok: false, outcomeUnknown: true }, "account"))),
    { kind: "publication-blocked", reason: "outcomeUnknown" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(internals.classifyApplyResult({ ok: false, publicationPending: true }, "account"))),
    { kind: "publication-blocked", reason: "publicationPending" },
  );
  assert.equal(internals.classifyApplyResult({ ok: true, committed: true, accountCommitted: true, localSyncPending: true }, "account").kind, "account-unsynced");
  assert.equal(internals.classifyApplyResult({ ok: true, accountCommitted: true, localSyncPending: true }, "account").kind, "account-unsynced");
  assert.equal(internals.classifyApplyResult({ ok: true, committed: true, accountCommitted: true, partial: true }, "account").kind, "account-unsynced");
  const unavailable = internals.classifyApplyResult({ ok: true, committed: true, accountCommitted: true, stateUnavailable: true }, "account");
  assert.equal(unavailable.kind, "account-unsynced");
  assert.equal(unavailable.reason, "accountStateUnavailable");
  assert.deepEqual(
    JSON.parse(JSON.stringify(internals.classifyApplyResult({ ok: true, committed: true, session: true, stateUnavailable: true }, "session"))),
    { kind: "publication-blocked", reason: "stateUnavailable" },
  );
  assert.match(html, /id="publication-block-panel"/);
  assert.match(html, /id="status-recheck-button"/);
  assert.match(html, /账号已保存，当前会话未同步；不要重发/);
  assert.match(html, /已阻止自动发布和重复发布/);
});
test("status refresh only clears publication blocking after an explicit available sync state", () => {
  const internals = loadInternals();
  const unresolved = internals.normalizeState({
    revision: "r",
    providers: [],
    routes: {},
    accountSync: { available: true, status: "publication-unresolved", retryBlocked: true, outcomeUnknown: true, publicationPending: true },
  });
  assert.equal(unresolved.accountSync.retryBlocked, true);
  assert.equal(unresolved.accountSync.outcomeUnknown, true);
  assert.equal(unresolved.accountSync.publicationPending, true);
  assert.equal(internals.extractState({ structuredContent: unresolved }).accountSync.retryBlocked, true);
  assert.equal(internals.publicationStatusResolved(unresolved), false);
  assert.equal(internals.publicationStatusResolved({ accountSync: { available: true, status: "synced", retryBlocked: false } }), true);
  assert.equal(internals.publicationStatusResolved({ accountSync: { available: true, status: "not-published", retryBlocked: false } }), true);
  assert.equal(internals.publicationStatusResolved({ accountSync: { available: true, status: "publication-pending", retryBlocked: false } }), false);
  assert.equal(internals.publicationStatusResolved({ accountSync: { available: true, status: "sync-error", retryBlocked: false } }), false);
  assert.equal(internals.publicationStatusResolved({ accountSync: { available: true, status: "synced", retryBlocked: false, outcomeUnknown: true } }), false);
  assert.equal(internals.publicationStatusResolved({ accountSync: { available: true, status: "synced", retryBlocked: false, publicationPending: true } }), false);
  assert.equal(internals.publicationStatusResolved({ accountSync: { available: false, status: "synced", retryBlocked: false } }), false);
  assert.match(html, /retryBlocked: item\.retryBlocked === true/);
  assert.match(html, /publicationStatusResolved\(state\)/);
  assert.match(html, /重复发布继续被阻止/);
});
test("mobile layout declares bounded grid and no horizontal overflow", () => {
  assert.match(html, /html,\s*body\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*hidden/s);
  assert.match(html, /\.shell\s*\{[^}]*max-width:\s*100%[^}]*min-width:\s*0/s);
  assert.match(html, /@media\s*\(max-width:\s*760px\)[\s\S]*?grid-template-columns:\s*1fr;/);
});

test("bridge and offline copy remain explicit and non-committal", () => {
  assert.match(html, /window\.wb3pBridge/);
  assert.match(html, /await bridge\.connect\(\)/);
  assert.match(html, /bridge\.subscribe\(onBridgeNotification\)/);
  assert.match(html, /bridge\.callTool\(request\)/);
  assert.match(html, /bridge\.notifySize\(\)/);
  assert.match(html, /ui\/notifications\/tool-result/);
  assert.match(html, /尚未应用/);
  assert.match(html, /复制成功也不代表宿主已写入/);
  assert.match(html, /下载无密钥 JSON 草案/);
  assert.match(html, /DOMContentLoaded/);
  assert.match(html, /等待模型配置/);
});
