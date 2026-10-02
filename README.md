# WorkBuddy 3P

[简体中文](README.zh-CN.md)

**Version:** 2.5.1

WorkBuddy 3P is an unofficial, MIT-licensed plugin marketplace for cloud WorkBuddy / CodeBuddy Code. It lets the model picker use an OpenAI-compatible API that you control. The web and mobile clients share the same cloud sandbox mechanism, so no client or web page changes are required.

The plugin writes only the model configuration it manages. Existing user models whose IDs are not managed by the plugin are left in place.

## Settings entry point (2.5)

Ask **“Open WorkBuddy 3P settings”** or use `/models-settings`. On MCP Apps hosts the interactive panel lets you select a model, adjust its supported reasoning levels/input limit, choose parameter priority (3P/native), switch official/third-party mode, and edit providers, extra models and routes. “Highest for all” chooses each model's highest valid level; it does not force the literal `max` everywhere. Input limits can be reduced/reset, not expanded beyond declared upstream capacity.

`models_settings` supports `status`, `panel` and revision-guarded `apply`. Direct saving uses the standard MCP Apps host bridge: no webpage patching or public HTTP listener. Hosts without MCP Apps can use a chat question-tool wizard. The standalone HTML artifact is a **draft editor**: send its secret-free generated instruction back to the original chat to apply it. Preview/clipboard success is not a save receipt. An isolated browser fixture has verified bridge saves and mobile-size layout; official cloud/new-session and physical-phone acceptance must be verified separately, not inferred from host source support.

Updates use the existing routing lock, private backups and rollback for ordinary I/O failures. Stale revisions reject; detected external changes are not overwritten during rollback. All writers should honor the same lock: a non-cooperating external editor can still race between the final comparison and atomic replacement. This is neither an OS-level compare-and-swap guarantee nor a multi-file crash-atomic transaction. Editing a private profile updates only its local sandbox copy, preserving the envelope and avoiding a credential-shadowing local config. Account upload/synchronization is not automatic; upload an updated private profile for future sandboxes.

The panel never displays or accepts API key values. New provider forms use credential environment-variable names; keys remain in private runtime files/environment/account profiles. Changing an endpoint requires a new reference or explicit consent to reuse existing credentials.

See the [parameter priority and loopback contract](docs/parameter-priority.md), [per-model capability matrix](docs/model-capabilities.md) and [official window audit](docs/model-windows.md). Live Bailian checks on 2026-10-02 show that GLM-5/5.1 reject `max`; their highest supported level is `xhigh`, despite generalized documentation. Kimi K3 now exposes `low/high/max`. Overstated capacity on ten older models has also been corrected. Thinking-off is exposed only on verified host paths; Kimi K3, DeepSeek V4.1 Flash and MiniMax M3 do not expose unsupported native toggles. `thinking_budget` and `ultracode` are out of scope.

**Activation limits:** in `3p` priority the cloud-host adapter enforces declared thinking parameters; in `native` priority session/user overrides can win. `off` disables the custom slot's native reasoning capability and, in `3p`, explicitly sends the supported provider toggle without changing global settings. A stale host catalog may require catalog refresh and model reselection; saving, resync or page reload alone is not runtime proof. Input limits persist in `workbuddy-3p.context.json` and change host model metadata; there is no universal provider `context_window` request parameter. Revisions use a process-local random-key HMAC. Reopen old panels/drafts after MCP restart.

Private backup directories/files use `700`/`600` on Linux. Windows `chmod` is not an NTFS ACL: use an account-private directory and do not sync/share backups.

## Parameter priority and host loopback (2.5)

`state.parameterPriority` and `patch.parameterPriority` accept `3p` or `native`; missing state defaults to `3p`. Resolution is saved `workbuddy-3p.parameters.json` > `WB3P_PARAMETER_PRIORITY` > `3p`, with no hidden CLI default.

`3p` keeps third-party requests on 3P declared parameters and starts/stops a shared Node loopback daemon inside the target cloud sandbox. The host caller uses an opaque proxy key; the proxy reads the private mode-600, gitignored state/runtime cache, uses the original upstream key only on the upstream Authorization request, and does not return it to the UI or session. Here `localhost` means that sandbox, not the assistant's Windows PC or a web/mobile client.

`native` uses a native direct connection and disables 3P forced parameters. An old cache that still points at the loopback receives HTTP 410 and must reselect the model; it is not transparently passed through. `official` rejects proxy forwarding and has no third-party traffic.

Active MCP sessions check the shared adapter every 45 seconds; an idle adapter exits after 30 minutes. A platform sleep/reclamation or forced process kill is not guaranteed to recover immediately. Request timeout defaults to 10 minutes (`WB3P_PARAMETER_TIMEOUT_MS`: 1000–1800000 ms), with 4 concurrent requests, 16 MiB per request and a shared 32 MiB upload-buffer limit. Mode changes affect newly authorized snapshots, not data already sent upstream. Keep private state/runtime/backups in a protected directory; loopback is not isolation against malicious root/same-user processes.

Reasoning levels follow live `supportedEfforts`, `canDisableThinking` and protocol declarations; do not infer levels from `onlyReasoning`. Under `3p`, DeepSeek V4.1 Flash and Kimi K3 `off` can be forced by the proxy; the 2.4 native off limitation applies only to native paths. Input windows are local host input limits, not provider capacity expansion or verified context compression. Saving configuration is not HTTP success; `runtimeVerified:false` remains.

## How it works

- The `SessionStart` hook and the stdio MCP server both run `sync-models.cjs` when they start. Sync, switch, and uninstall operations are serialized with `~/.codebuddy/workbuddy-3p.lock`. Existing `models.json` is written in place to preserve the inode watched by CodeBuddy; state files use atomic replacement. Ordinary write failures are rolled back, but this is not a crash-atomic transaction across files, and an in-place update can leave a brief read window for the host.
- The sync script writes `~/.codebuddy/models.json` with mode `600`.
- A routed model is a custom model using an upstream model ID. Its `aliases` contain the official WorkBuddy IDs that should resolve to it. WorkBuddy exposes these custom slots as `custom-local:<model-id>`.
- `availableModels` hides only official IDs that are actually routed; an upstream model ID is not hidden just because it is the custom model ID. If the user's original allowlist contains a routed official ID, it is removed temporarily and restored on uninstall or switch to official.
- Official IDs in `keepOfficial` and IDs that could not be routed remain on the official backend. This includes `auto`, Hunyuan models, and other listed official entries.
- A user model with the same ID as a generated plugin model is replaced while the plugin is active, with a warning, and restored on uninstall or switch to official.
- `~/.codebuddy/workbuddy-3p.state.json` records which model IDs and allowlist entries the plugin manages. User models with other IDs are preserved on later syncs.

## Quick start

1. In WorkBuddy, add a plugin source of type GitHub with `https://github.com/AlgernonYin/workbuddy-3P`.
   - In a mainland China cloud sandbox that cannot reach GitHub, use the maintainer mirror `https://cnb.cool/AlgernonYin/workbuddy-3P` (mirror, synchronized with GitHub `main`).
2. Install the `custom-api-models` plugin.
3. For cloud sessions, import an account-private profile as described below. Fixed hosts can use JSON files or environment variables. Plugin options require a host that can save and sync them.
4. Start a new WorkBuddy session and select a routed official model name.

### Configure without a file

Set the environment variables, or use the plugin options with the same names.

#### Generic OpenAI-compatible

```text
WB3P_BASE_URL=https://api.example.com/v1
WB3P_API_KEY=<your-api-key>
```

#### Bailian

```text
WB3P_PRESET=bailian
WB3P_API_KEY=<your-api-key>
```

Plugin option names are `ENABLED`, `BASE_URL`, `API_KEY`, `PRESET`, and `ROUTES`. `WB3P_ROUTES` must be a JSON object.

If neither `BASE_URL` nor `PRESET` is set and there is no local config or private profile, the plugin does no routing. There is no default preset. Without a resolvable API key, no model is routed and no official entry is hidden.

### New sandboxes and keys

The tested cloud web version has no working plugin-option save control; custom MCP saving also fails with `saveConfiguration` undefined. The **account-private skill package** is the primary way to distribute the profile to fresh sandboxes:

```bash
python scripts/make-private-profile.py --config /opt/workbuddy-3p/config.json --output /tmp/account-private-profile.zip --embed-keys
```

Import the ZIP into your own personal skill assets. Never publish it to a marketplace, share its download URL, or commit it. The package contains a credential-free `SKILL.md` and a private `workbuddy-3p.profile.json`; the profile contains configuration and, with `--embed-keys`, API keys. The upload preflight asks for credential confirmation. This is not an encrypted credential vault; authorized account and sandbox processes can read it.

Only when local config and explicit provider environment options are absent, the plugin reads `<config-dir>/skills/*/workbuddy-3p.profile.json`. The profile must be adjacent to a `SKILL.md` whose YAML frontmatter contains `name: workbuddy-3p-profile`. Multiple packages cause an error. The profile schema marker catches misconfiguration only; it is not signature or identity authentication. Treat the installed skill and user directory as trusted content.

Use `models_status` to confirm the configured mode and on-disk routing state. Re-uploading the private package changes the default for future sandboxes, but does not override an existing per-sandbox switch. The switch itself is per-sandbox, not account-global.

### Configure with a file

Create `~/.codebuddy/workbuddy-3p.json`:

```json
{
  "default": "main",
  "mode": "same-name",
  "effort": {
    "default": "high",
    "models": {
      "main:qwen3.8-max": "xhigh"
    }
  },
  "providers": {
    "main": {
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MY_API_KEY"
    }
  },
  "routes": {
    "glm-5.3": "my-upstream-model",
    "kimi-k3": "official"
  },
  "keepOfficial": []
}
```

For a self-hosted or fixed machine, the config can live at `/opt/workbuddy-3p/config.json` or `/etc/workbuddy-3p/config.json`, with `apiKeyFile` pointing to a local file that has mode `600`.

The script checks these sources in order and uses the first existing JSON object:

1. `$WB3P_CONFIG_JSON`
2. `$WB3P_CONFIG`
3. `$CODEBUDDY_CONFIG_DIR/workbuddy-3p.json`, or `~/.codebuddy/workbuddy-3p.json` when `CODEBUDDY_CONFIG_DIR` is unset
4. `/etc/workbuddy-3p/config.json`
5. `/opt/workbuddy-3p/config.json`
6. `<plugin-root>/config.json`

Invalid or unreadable JSON is an error; the script does not skip it and continue to the next source. If no file is available, the environment/plugin option path above is used.

## Official / third-party switch

`resolveSwitch` uses this order:

| Priority | Source |
| --- | --- |
| 1 | `<config-dir>/workbuddy-3p.switch` (default `~/.codebuddy/workbuddy-3p.switch`) |
| 2 | `WB3P_ENABLED` environment variable |
| 3 | Plugin option `ENABLED` (empty = fall through) |
| 4 | `enabled` in the config file |
| 5 | Built-in default: `third-party` |

When a high-priority source in rows 1-3 selects `official`, it bypasses provider/profile config, even if damaged. Removal and restoration still require complete ownership state in `workbuddy-3p.state.json`. Invalid state, or a missing state alongside the 2.2.2 ownership marker, produces unknown status and refuses changes. Older orphaned entries without this marker cannot be identified automatically; restore a known-good backup instead of blindly deleting entries.

Per-sandbox switches are not account-global. Changing `enabled` in a private profile changes the default for future sandboxes without a higher-priority local switch; it does not override an existing local switch.

The accepted modes are `third-party` and `official`. Switch in any of these ways:

- In a session, call the MCP tool `models_switch` with `{"mode":"official"}`, `{"mode":"third-party"}`, or `{"mode":"default"}`.
- Use `/models-official`, `/models-third-party`, or `/models-status` from the plugin `commands` directory.
- Run `node scripts/sync-models.cjs --official`, `--third-party`, `--switch clear`, or `--status`.
- `default` and `--switch clear` remove the per-sandbox switch file and follow the lower-priority sources.

Switching to `official` removes plugin-written models and restores hidden official entries and replaced user models. Switching back to `third-party` routes them again. WorkBuddy must reload the file before new requests use it; routed menu labels can remain unchanged. `models_status` reports configured intent and disk state, not live traffic (`runtimeVerified: false`). If a running host does not reload, reopen that sandbox/session. A completely new sandbox follows account defaults, so set the desired switch there again.

## Configuration reference

### Required model reselection after switching (cloud host limitation)

The switch changes routing configuration, not the cloud session's in-memory selected model. Live testing on 2026-09-30 reproduced `Custom model custom-local:... has no endpoint url configured` after switching to official without changing the selection. This is not fixed by writing the config again.

For web and mobile: select a non-routed official model (for example `Hy4 preview`), call `models_switch` or a slash command, then select the desired model before sending another message. If the label is already selected, choose a non-routed official model and then the target to force a fresh selection. A new sandbox uses account defaults, not the previous sandbox's switch. The plugin reports `requiresModelReselection: true`; it does not edit the web page or claim a seamless hot switch.

**2.5.1 official-catalog compatibility:** A 2026-10-03 cloud Native 2.155.0 test retained a stale `custom-local` binding after deleting `availableModels`, even after page reload/reselection. An explicit official list restored a real GLM-5.1 official request on the same host. When withdrawing managed routes from an originally unfiltered configuration, the plugin materializes a bundled compatibility fallback and tracks its exact projection in credential-free ownership state. This is not the host's live complete catalog. Cleanup restores field absence only if that projection is unchanged. After external additions, deletions or reordering, uninstall preserves the entire current field; directly enabling third-party mode refuses until ownership is cleaned/restored. Existing user allowlists, including `[]`, keep their meaning; same-ID user-model conflicts produce warnings, not overwrites. Missing/invalid catalogs never create an empty deny-all or pretend official rebinding succeeded. See the [compatibility contract](docs/official-switch-compatibility.md).

On a brand-new sandbox, plugin/profile initialization may finish after model selection. Reselect the target once the plugin is ready; do not assume the very first startup request used your API. Mobile shares the cloud configuration, but has not been device-tested.

### Top-level fields

| Field | Behavior |
| --- | --- |
| `providers` | Required non-empty object. Keys are provider names. |
| `default` | Name of the default provider. It must exist. If omitted, the first provider is used. |
| `mode` | Routing mode. Default: `same-name`. |
| `routes` | Optional object that maps an official model ID to a route target. Explicit routes are applied after inferred routes and `keepOfficial`. |
| `keepOfficial` | Optional array of official IDs to keep on the official backend. It removes those IDs from inferred preset/same-name routes, but an explicit `routes` entry can route them again. |
| `models` | Optional capability overrides keyed by `"<provider>:<upstream-model>"`. |
| `defaults` | Optional capability defaults used when a provider has no `defaults` and the model has no preset template. |
| `enabled` | `official`/`false` selects the official backend; `third-party`/`true` enables routing. The switch file, `WB3P_ENABLED`, and plugin option `ENABLED` take precedence. |
| `effort` | Optional reasoning-effort defaults for routed models. `effort.default` is the fallback level, and `effort.models["<provider>:<upstream-model>"]` sets per-model levels. Local sandbox overrides take precedence. |

### Provider fields

| Field | Behavior |
| --- | --- |
| `preset` | Optional built-in preset name, currently `bailian`. |
| `baseUrl` | OpenAI-compatible base URL. HTTPS is required. HTTP is allowed only for `localhost`, `127.0.0.1`, or `::1`, or when the provider sets `allowInsecureHttp: true`. A URL with userinfo, a query, or a fragment is rejected. If the URL ends with `/chat/completions`, it is used as is; otherwise `/chat/completions` is appended. A preset can supply this value. |
| `allowInsecureHttp` | Optional boolean. Allows a non-local HTTP `baseUrl`; defaults to `false`. |
| `label` | Label used in the generated custom model name: `<label> / <upstream-model>`. Defaults to the preset label, then the provider name. |
| `apiKey` | Literal API key. Prefer an environment variable or file to avoid storing a secret in the config. |
| `apiKeyEnv` | Name of an environment variable containing the key. |
| `apiKeyFile` | File containing either `{"apiKey":"..."}` or a raw key with no whitespace. Use mode `600` for a local key file. |
| `apiKeyUrl` | Private HTTPS URL returning `{"apiKey":"..."}`. A non-HTTPS URL is an error. |
| `models` | Map of upstream model ID to capability settings. Overrides preset model settings. |
| `defaults` | Capability baseline for this provider's models. |
| `extraModels` | Array of upstream model IDs to expose as extra custom models without mapping an official slot. |

A provider's default `baseUrl` must be present directly or through its preset.

### Routing modes

| Mode | Behavior |
| --- | --- |
| `same-name` | Default. For every known routable official ID, use the preset's route when one exists. Otherwise use the same ID on the default provider, unless the preset lists it in `unsupported`. Explicit `routes` still override the result. |
| `preset-only` | Generate routes only from the default provider's preset. Explicit `routes` still override the result. |
| `explicit` | Generate no preset or same-name routes. Only explicit `routes` and `extraModels` are used. |

For `same-name` and `preset-only`, preset model IDs are also exposed as extra custom models. That is why the Bailian preset exposes `qwen3.8-max` and `qwen3.8-flash` even though neither replaces an official slot by default.

Route precedence is: preset/same-name inference, then `keepOfficial` removal, then explicit `routes`.

### Route targets

| Target | Meaning |
| --- | --- |
| `"official"` | Remove the route and keep the official model. |
| `"<provider>:<model>"` | Send the official ID to the named provider and upstream model. If the prefix is not a configured provider, the plugin warns and sends the whole string as a model ID to the default provider. |
| `"<provider>"` | Send the official ID to the same model ID on the named provider. |
| `"<model>"` | Send the official ID to that model on the default provider. |
| `{"provider":"p","model":"m"}` | Object form. If `provider` or `model` is omitted, it falls back to the default provider or the official ID. |

Use a configured provider name for provider-based target forms. Explicit routes take precedence over inferred routes and `keepOfficial`.

### Capability overrides

The most specific setting wins in this order:

1. `models["<provider>:<upstream-model>"]`
2. `providers.<name>.models["<upstream-model>"]`
3. The preset's model settings and template
4. Provider or top-level defaults
5. Built-in fallback values

Example:

```json
{
  "models": {
    "main:my-upstream-model": {
      "maxInputTokens": 200000,
      "maxOutputTokens": 32768,
      "supportsToolCall": true,
      "supportsImages": true,
      "supportsReasoning": true
    }
  }
}
```

Preset templates also use fields such as `onlyReasoning`, `useCustomProtocol`, `compat`, `thinkingLevelMap`, and `reasoning` when required by the upstream API.

### Reasoning effort defaults

Since 2.3.0, routed models have configurable reasoning-effort defaults. Version 2.4 validates `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` per model, plus `on/off` toggles on supported host paths; no model is assumed to support every value. `ultracode` and token budgets are not included.

Configure defaults in the top-level `effort` object:

```json
{
  "effort": {
    "default": "high",
    "models": {
      "main:qwen3.8-max": "xhigh"
    }
  }
}
```

The sandbox-local override file is `~/.codebuddy/workbuddy-3p.effort.json`. It contains `version: 1` and effort selections only; it does not contain API keys. The effective precedence is:

1. local per-model override
2. local default
3. config per-model
4. config default
5. the model's original default

`models_effort` supports `{ action: "set" | "reset", scope: "default" | "model" | "all", level?, model? }` and `{ action: "status", model? }`. For `status`, pass only the optional model; `scope` and `level` are not accepted. `set` defaults to `scope: "default"` when no model is given. To target one model, pass `scope: "model"` and `model: "<provider>:<upstream-model>"`; a unique official alias or upstream ID may also resolve, but the full `provider:upstream-model` form is recommended. `reset` with `scope: "all"` removes all local overrides. With `scope: "model"`, it removes that model's local override and falls back through the remaining sources; this does not guarantee a return to the preset value.

Requested levels are validated against model capability metadata. A default/global change skips unsupported models and lists them; a single-model change rejects an unsupported level. No fixed provider support table is provided here because support is model- and configuration-specific. Use `models_effort` status for the configured set instead of inferring broad provider capability.

These values are model defaults. In `native` priority a session/user `reasoningEffort` can take precedence; `3p` enforces declared provider parameters in the adapter. Official mode does not modify native global settings or official parameters; effort settings are deferred until third-party mode resumes. Status is configuration/disk state, not proof of an actual request (`runtimeVerified: false`). After the host reloads, the model may need to be reselected.

**Refresh/reselect when the host retains stale metadata.** A 2026-10-01 session sent `xhigh` after an official catalog refresh. However, the latest 2.4 cloud test on 2026-10-02 still sent `medium` despite a saved `xhigh`; HTTP 202 from refresh confirmed acceptance only, not completion. That is why 2.5 adds explicit `3p` parameter priority. Do not treat a historical success, a refresh acknowledgment, disk status or a normal reply as current parameter proof. The production 2.5 web chain and a real mobile device require independent verification.

Local effort settings persist only in that sandbox and do not automatically sync to the account. To make the same default apply to new sandboxes, put `effort` under the account-private profile's `config`, then package and upload the profile. Do not put API keys or the profile in a public location. Mobile shares the cloud mechanism, but has not been verified on a real device.

The secret-free `profileConfigPatch.effort` replaces the complete `effort` object in your private config. Do not field-merge it with old `effort.models`, which can change override precedence.

### API key resolution

The first non-empty value wins:

1. `providers.<name>.apiKey`
2. The environment variable named by `providers.<name>.apiKeyEnv`
3. `WB3P_<NORMALIZED_PROVIDER>_API_KEY`, where non-alphanumeric characters in the provider name become `_`
4. For the default provider only: `WB3P_API_KEY` or plugin option `API_KEY`
5. `providers.<name>.apiKeyFile`
6. `<config-dir>/workbuddy-3p.secrets/<provider-name>`
7. For the default provider only: `WB3P_API_KEY_FILE`
8. `providers.<name>.apiKeyUrl`, or `WB3P_API_KEY_URL` for the default provider
9. A key from a previous sync for the same provider name and the same normalized chat-completions URL. It never borrows another provider's key.
10. Missing. A route without a key is not activated and remains official.

`apiKeyUrl` accepts HTTPS URLs only and expects a JSON response with an `apiKey` field. A non-HTTPS URL is an error. It should point to a private address. The URL fetch has an 8-second timeout.

## Presets

There is no default preset. A preset is used only when `PRESET` or `providers.<name>.preset` selects it.

### Bailian

The `bailian` preset uses:

```text
https://dashscope.aliyuncs.com/compatible-mode/v1
```

Route mapping:

| Official ID | Bailian model ID |
| --- | --- |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash` |
| `deepseek-v4-pro` | `deepseek-v4-pro` |
| `deepseek-v4-flash` | `deepseek-v4-flash` |
| `deepseek-v3-2-volc` | `deepseek-v3.2` |
| `glm-5.3` | `glm-5.3` |
| `glm-5.3-flashx` | `glm-5.3` |
| `glm-5.2` | `glm-5.2` |
| `glm-5.1` | `glm-5.1` |
| `glm-5.0` | `glm-5` |
| `glm-5.0-turbo` | `glm-5` |
| `glm-4.7` | `glm-4.7` |
| `glm-4.6` | `glm-4.7` |
| `kimi-k3-1` | `kimi-k3` |
| `kimi-k3-2` | `kimi-k3` |
| `kimi-k3` | `kimi-k3` |
| `kimi-k2.8-preview` | `kimi/kimi-k2.8-preview` |
| `kimi-k2.7` | `kimi-k2.7-code` |
| `kimi-k2.6` | `kimi-k2.6` |
| `kimi-k2.5` | `kimi-k2.5` |
| `kimi-k2-thinking` | `kimi-k2-thinking` |
| `minimax-m3` | `MiniMax/MiniMax-M3` |
| `minimax-m3-pay` | `MiniMax/MiniMax-M3` |
| `minimax-m2.7` | `MiniMax/MiniMax-M2.7` |
| `minimax-m2.5` | `MiniMax/MiniMax-M2.5` |

`glm-5v-turbo` and `glm-5.3-flash` are listed as unsupported and stay official by default. The following manual mapping is an example only and is not a public default; use it only if you accept the substitutions:

```json
{
  "providers": {
    "main": {
      "preset": "bailian",
      "apiKeyEnv": "BAILIAN_API_KEY"
    }
  },
  "routes": {
    "glm-5v-turbo": "qwen3.8-max",
    "glm-5.3-flash": "qwen3.8-flash"
  }
}
```

Pull requests for new presets are welcome.

## Commands and MCP tools

Run the command-line utility from the plugin root:

```bash
cd plugins/custom-api-models

node scripts/sync-models.cjs
node scripts/sync-models.cjs --dry-run
node scripts/sync-models.cjs --doctor
node scripts/sync-models.cjs --official
node scripts/sync-models.cjs --third-party
node scripts/sync-models.cjs --switch clear
node scripts/sync-models.cjs --status
node scripts/sync-models.cjs --uninstall
node scripts/sync-models.cjs --quiet
node scripts/sync-models.cjs --effort-status
node scripts/sync-models.cjs --effort-status --model main:qwen3.8-max
node scripts/sync-models.cjs --effort high
node scripts/sync-models.cjs --effort xhigh --model main:qwen3.8-max
node scripts/sync-models.cjs --effort-reset --model main:qwen3.8-max
node scripts/sync-models.cjs --effort-reset --all
```

| Option | Behavior |
| --- | --- |
| none | Apply the current config and write managed entries. |
| `--dry-run` | Print the routing plan and write nothing. |
| `--doctor` | Official mode returns skipped and sends no third-party requests; a high-priority official switch skips before damaged provider/profile config is loaded. Third-party mode sends one tiny request per planned model; those requests are billable and can consume quota. It returns only HTTP status and elapsed time, never response bodies or keys. |
| `--official` / `--third-party` | Persist the per-sandbox switch and sync. |
| `--switch clear` | Remove the per-sandbox switch and follow the lower-priority sources. |
| `--status` | Report `configuredMode`, `parameterPriority`/`parameterAdapter`, source, `modelsJsonActive`/`active` (on-disk entries), `runtimeVerified` (always `false`), and the last error. Provider endpoint reporting is limited to `host`. |
| `--uninstall` | Remove entries recorded in ownership state and generated allowlist entries; keep other user models. Refuse invalid state or a missing state alongside the ownership marker. |
| `--quiet` | Suppress normal JSON output. Errors still go to stderr. Effort commands retain a non-zero failure exit code; other commands use `0` for the `SessionStart` hook. |
| `--effort-status [--model ...]` | Report effort configuration and effective source for all configured models, or only the named model. This is config/disk state, not live request proof (`runtimeVerified: false`). |
| `--effort <level> [--model ...]` | Set the local default level, or a local per-model override when `--model` is present. Supported levels are `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; unsupported global targets are skipped and listed, while an unsupported single-model target is rejected. |
| `--effort-reset [--model ... \| --all]` | Remove the local per-model override, or all local overrides with `--all`. A model reset falls back through local default, config per-model, config default, and the model's original default; it does not guarantee a return to the preset value. |

The stdio MCP server provides:

| Tool | Behavior |
| --- | --- |
| `models_status` | Report `configuredMode`, `parameterPriority`/`parameterAdapter`, source, on-disk `modelsJsonActive`/`active`, `runtimeVerified` (always `false`), managed count, and the last error. Provider endpoint reporting is limited to `host`. |
| `models_switch` | Set this sandbox to `official` or `third-party`, or use `default` to clear the switch. |
| `models_resync` | Re-read the config and rewrite `models.json`. |
| `models_doctor` | Official mode skips with no third-party requests. Third-party mode sends one tiny billable request per planned model and reports HTTP status and elapsed time. |
| `models_effort` | Inspect or change reasoning-effort defaults. Input is `{action:"set"\|"reset", scope:"default"\|"model"\|"all", level?, model?}` or `{action:"status", model?}`. `set` defaults to `scope:"default"` when no model is given. Use `provider:upstream-model` for an explicit model; a unique official alias or upstream ID may also resolve, but the full form is recommended. |

Use `/models-effort` from the plugin `commands` directory to call `models_effort`. Status instructions must not guess the currently selected model: use a model named by the user or list the configured capabilities first. Set and reset instructions must follow the user's explicit model and level; do not choose a level on the user's behalf.

### Sync summary

| Field | Meaning |
| --- | --- |
| `ok` | `true` only when there are no warnings. |
| `partial` | Planning produced warnings but at least one model is still active. |
| `active` | At least one third-party model is present in the current plan or on disk, depending on the command; this is not runtime verification. |
| `switch` | Resolved mode: `official` or `third-party`. |
| `switchFrom` | Source: `switch file`, `WB3P_ENABLED`, `plugin option ENABLED`, `config`, or `default`. |
| `warnings` | Non-fatal issues, such as a missing provider key, a duplicate upstream model ID, or a replaced user model. |

`models_status` reports configuration and disk state, not traffic: `configuredMode` is resolved configuration intent, `modelsJsonActive`/`active` indicate third-party entries present in the on-disk `models.json`, and `runtimeVerified` is always `false`. Do not claim that live traffic switched from this output.

A normal sync also writes configuration failures to `~/.codebuddy/workbuddy-3p.last-error.json`; `models_status` exposes that error. Configuration validation failures reject the update and leave the last-good `models.json` unchanged; they do not automatically switch to official. Examples include invalid JSON in `WB3P_CONFIG_JSON`, `ROUTES`, or a config file; an illegal `mode`; and `providers` that is not a non-empty object. A high-priority official switch can bypass damaged config as described above, but still requires complete ownership state.

## Security

- Never commit API keys or put them at a public URL.
- Protect `models.json`, `workbuddy-3p.json`, secret files, and backups with `chmod 600` where the platform supports POSIX modes. The sync script writes `models.json` with mode `600`; atomic writes for state, switch, and last-error files also request mode `600`.
- `baseUrl` must use HTTPS. HTTP is allowed only for `localhost`, `127.0.0.1`, or `::1`, or with `allowInsecureHttp: true`. The URL must not contain userinfo, a query, or a fragment.
- `apiKeyUrl` must use HTTPS. The code cannot tell whether an address is private, so keep that URL on a private, controlled host.
- `models_status` and public sync summaries never return the full `baseUrl`; where an endpoint is reported, only `host` is included.
- When an official model is routed, prompts and responses go to the configured third-party API.
- The WorkBuddy menu can still show the official model name for a routed slot. The selected request goes to the third-party provider.
- Third-party API usage and billing are your responsibility.
- This is an unofficial plugin. A WorkBuddy or CodeBuddy Code update can change the model file format or plugin behavior and break compatibility.

## Known limitations

- Whether a cloud sandbox runs the user plugin depends on platform synchronization. A new session is required to pick up the generated models; an already running session may need to be created again.
- Routed official slots keep their official display names in the menu.
- In `same-name` mode, routing an official ID to an upstream model that does not exist causes an upstream error. Run `--doctor` against the current config plan.
- One upstream model ID can belong to only one provider, regardless of URL. A conflicting route or extra model is skipped with a warning; the skipped official alias remains available as an official model unless another route handles it.
- Cloud sandboxes observed in 2026-09 (mainland China region) could not reach `github.com` (TLS reset), so a GitHub source can be accepted by the account API but the sandbox fails to `git clone` it. Use the maintainer mirror `https://cnb.cool/AlgernonYin/workbuddy-3P` (synchronized with GitHub `main`) when GitHub is unreachable.
- New sessions may run in a fresh sandbox. The tested cloud options UI cannot save plugin options, and custom MCP saving fails; use the account-private skill package as the primary setup path. It is not an encrypted vault: `SKILL.md` has no key, while `workbuddy-3p.profile.json` can contain profile configuration and embedded keys. Treat the installed skill and user directory as trusted.

- `models_status` cannot prove live traffic. `runtimeVerified` is always `false`; use actual requests or host behavior when live routing must be verified.

## Uninstall and rollback

Switching to `official` with `models_switch`, `/models-official`, or `--official` restores plugin-managed models without uninstalling the plugin. To remove the plugin, uninstall `custom-api-models` in WorkBuddy, then either:

```bash
node scripts/sync-models.cjs --uninstall
```

or restore the first pre-change backup:

```text
~/.codebuddy/models.json.bak-workbuddy-3p
```

`--uninstall` removes only entries recorded in `workbuddy-3p.state.json`; other user models remain. Invalid state or a missing state alongside the 2.2.2 marker is refused. Older unmarked orphaned entries cannot be identified automatically. Restore a known-good backup instead of blindly deleting entries.

## Tests

From the repository root:

```bash
node --test --test-concurrency=2 tests/*.test.cjs
```

## License

MIT
