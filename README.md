# WorkBuddy 3P

[简体中文](README.zh-CN.md)

**Version:** 2.1.0

WorkBuddy 3P is an unofficial, MIT-licensed plugin marketplace for cloud WorkBuddy / CodeBuddy Code. It lets the model picker use an OpenAI-compatible API that you control. The web and mobile clients share the same cloud sandbox mechanism, so no client or web page changes are required.

The plugin writes only the model configuration it manages. Existing user models whose IDs are not managed by the plugin are left in place.

## How it works

- The `SessionStart` hook and the stdio MCP server both run `sync-models.cjs` when they start. Concurrent syncs are serialized with `~/.codebuddy/workbuddy-3p.lock`, and file writes are atomic replacements.
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
3. Configure a provider with either environment/plugin options or a JSON file.
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

If neither `BASE_URL` nor `PRESET` is set, the plugin does no routing. There is no default preset. Without a resolvable API key, no model is routed and no official entry is hidden.

### New sandboxes and keys

For cloud WorkBuddy, prefer the plugin option `API_KEY` (provided your platform syncs plugin options to new sandboxes; confirm with `models_status`). Otherwise use a private `apiKeyUrl` reachable from every sandbox. Do not depend on an environment variable or file that exists only in one old sandbox.

### Configure with a file

Create `~/.codebuddy/workbuddy-3p.json`:

```json
{
  "default": "main",
  "mode": "same-name",
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

The accepted modes are `third-party` and `official`. Switch in any of these ways:

- In a session, call the MCP tool `models_switch` with `{"mode":"official"}`, `{"mode":"third-party"}`, or `{"mode":"default"}`.
- Use `/models-official`, `/models-third-party`, or `/models-status` from the plugin `commands` directory.
- Run `node scripts/sync-models.cjs --official`, `--third-party`, `--switch clear`, or `--status`.
- `default` and `--switch clear` remove the per-sandbox switch file and follow the lower-priority sources.

Switching to `official` removes plugin-written models and restores hidden official `availableModels` entries and replaced user models. Switching back to `third-party` routes them again. The change takes effect after WorkBuddy reloads `models.json`; if the menu does not change, start a new session.

## Configuration reference

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

### Provider fields

| Field | Behavior |
| --- | --- |
| `preset` | Optional built-in preset name, currently `bailian`. |
| `baseUrl` | OpenAI-compatible base URL. HTTPS is required. HTTP is allowed only for `localhost`, `127.0.0.1`, or `::1`, or when the provider sets `allowInsecureHttp: true`. If the URL ends with `/chat/completions`, it is used as is; otherwise `/chat/completions` is appended. A preset can supply this value. |
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
9. A key this plugin previously wrote for the same provider name and the same normalized chat-completions URL. It never borrows another provider's key.
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

`glm-5v-turbo` and `glm-5.3-flash` are listed as unsupported and stay official by default. You can route them to Bailian's `qwen3.8-max` and `qwen3.8-flash` if you accept those substitutions:

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
```

| Option | Behavior |
| --- | --- |
| none | Apply the current config and write managed entries. |
| `--dry-run` | Print the routing plan and write nothing. |
| `--doctor` | Test the plan generated from the current config (not the last written file). It returns only HTTP status and elapsed time; response bodies are not returned. Keys are not printed. |
| `--official` / `--third-party` | Persist the per-sandbox switch and sync. |
| `--switch clear` | Remove the per-sandbox switch and follow the lower-priority sources. |
| `--status` | Show the resolved switch, its source, active state, and last error. |
| `--uninstall` | Remove plugin-managed model entries and generated allowlist entries. User models are kept. The state file is deleted. |
| `--quiet` | Suppress normal JSON output. Errors still go to stderr, but the exit code is `0`. The `SessionStart` hook uses this mode. |

The stdio MCP server provides:

| Tool | Behavior |
| --- | --- |
| `models_status` | Show the current switch, its source, the last sync summary, and the last error. |
| `models_switch` | Set this sandbox to `official` or `third-party`, or use `default` to clear the switch. |
| `models_resync` | Re-read the config and rewrite `models.json`. |
| `models_doctor` | Test every model in the current config-generated plan and report HTTP status and elapsed time. |

### Sync summary

| Field | Meaning |
| --- | --- |
| `ok` | `true` only when there are no warnings. |
| `partial` | Planning produced warnings but at least one model is still active. |
| `active` | At least one third-party model is active. |
| `switch` | Resolved mode: `official` or `third-party`. |
| `switchFrom` | Source: `switch file`, `WB3P_ENABLED`, `plugin option ENABLED`, `config`, or `default`. |
| `warnings` | Non-fatal issues, such as a missing provider key, a duplicate upstream model ID, or a replaced user model. |

A normal sync also writes configuration failures to `~/.codebuddy/workbuddy-3p.last-error.json`; `models_status` exposes that error. Fail-closed errors include invalid JSON in `WB3P_CONFIG_JSON`, `ROUTES`, or a config file; an illegal `mode`; and `providers` that is not a non-empty object. On failure, `models.json` is not changed.

## Security

- Never commit API keys or put them at a public URL.
- Protect `models.json`, `workbuddy-3p.json`, secret files, and backups with `chmod 600` where the platform supports POSIX modes. The sync script writes `models.json` with mode `600`; atomic writes for state, switch, and last-error files also request mode `600`.
- `baseUrl` must use HTTPS. HTTP is allowed only for `localhost`, `127.0.0.1`, or `::1`, or with `allowInsecureHttp: true`.
- `apiKeyUrl` must use HTTPS. The code cannot tell whether an address is private, so keep that URL on a private, controlled host.
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
- New sessions may run in a fresh sandbox. Prefer the plugin option `API_KEY` when your platform syncs plugin options to new sandboxes and confirm it with `models_status`; otherwise use a private `apiKeyUrl` reachable from every sandbox. Do not rely on an environment variable or file that exists only in an old sandbox.

## Uninstall and rollback

Switching to `official` with `models_switch`, `/models-official`, or `--official` restores plugin-managed models without uninstalling the plugin. To remove the plugin, uninstall `custom-api-models` in WorkBuddy, then either:

```bash
node scripts/sync-models.cjs --uninstall
```

or restore the first pre-change backup:

```text
~/.codebuddy/models.json.bak-workbuddy-3p
```

`--uninstall` removes only entries recorded in `workbuddy-3p.state.json`; user models remain. If the state file is missing, restore the backup or remove the generated entries manually.

## Tests

From the repository root:

```bash
node --test tests/sync-models.test.cjs
```

## License

MIT
