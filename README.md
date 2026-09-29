# WorkBuddy 3P

[简体中文](README.zh-CN.md)

WorkBuddy 3P is an unofficial, MIT-licensed plugin marketplace for cloud WorkBuddy / CodeBuddy Code. It lets the model picker use an OpenAI-compatible API that you control. The web and mobile clients share the same cloud sandbox mechanism, so no client or web page changes are required.

The plugin writes only the model configuration it manages. Existing user models whose IDs are not managed by the plugin are left in place.

## How it works

- The `SessionStart` hook and the stdio MCP server both run `sync-models.cjs` when they start.
- The sync script writes `~/.codebuddy/models.json` with mode `600`.
- A routed model is a custom model using an upstream model ID. Its `aliases` contain the official WorkBuddy IDs that should resolve to it. WorkBuddy exposes these custom slots as `custom-local:<model-id>`.
- The generated `availableModels` list hides official entries that have the same IDs, so choosing an official name resolves to the third-party model.
- Official IDs in `keepOfficial` and IDs that could not be routed remain on the official backend. This includes `auto`, Hunyuan models, and other listed official entries.
- `~/.codebuddy/workbuddy-3p.state.json` records which model IDs and allowlist entries the plugin manages. User models with other IDs are preserved on later syncs.

## Quick start

1. In WorkBuddy, add a plugin source of type GitHub with `https://github.com/AlgernonYin/workbuddy-3P`.
2. Install the `custom-api-models` plugin.
3. Configure a provider with either environment/plugin options or a JSON file.
4. Start a new WorkBuddy session and select a routed official model name.

### Configure without a file

Set environment variables, or use the plugin options with the same names:

```text
WB3P_BASE_URL=https://api.example.com/v1
WB3P_API_KEY=<your-api-key>
WB3P_PRESET=bailian
WB3P_ROUTES={"glm-5.3":"my-model","kimi-k3":"official"}
```

Plugin option names are `BASE_URL`, `API_KEY`, `PRESET`, and `ROUTES`. `WB3P_ROUTES` must be a JSON object.

If neither a configuration file nor an explicit base URL is present, the default preset is `bailian`. Without a resolvable API key, no model is routed and no official entry is hidden.

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

The script checks these sources in order and uses the first valid JSON object:

1. `$WB3P_CONFIG_JSON`
2. `$WB3P_CONFIG`
3. `$CODEBUDDY_CONFIG_DIR/workbuddy-3p.json`, or `~/.codebuddy/workbuddy-3p.json` when `CODEBUDDY_CONFIG_DIR` is unset
4. `/etc/workbuddy-3p/config.json`
5. `/opt/workbuddy-3p/config.json`
6. `<plugin-root>/config.json`

If no file is available, the environment/plugin option path above is used.

## Configuration reference

### Top-level fields

| Field | Behavior |
| --- | --- |
| `providers` | Required object. Keys are provider names. If empty, sync fails. |
| `default` | Name of the default provider. If it does not exist, the first provider is used. |
| `mode` | Routing mode. Default: `same-name`. |
| `routes` | Optional object that maps an official model ID to a route target. These entries override routes inferred from the mode and preset. |
| `keepOfficial` | Optional array of additional official IDs to keep on the official backend. A routed ID is not kept because it is already handled by an alias. |
| `models` | Optional capability overrides keyed by `"<provider>:<upstream-model>"`. |
| `defaults` | Optional capability defaults used when a provider has no `defaults` and the model has no preset template. |
| `enabled` | Set to `false` to uninstall plugin-managed entries on the next normal sync. `--dry-run` only reports the disabled state. |

### Provider fields

| Field | Behavior |
| --- | --- |
| `preset` | Optional built-in preset name, currently `bailian`. |
| `baseUrl` | OpenAI-compatible base URL. If it already ends with `/chat/completions`, it is used as is; otherwise `/chat/completions` is appended. A preset can supply this value. |
| `label` | Label used in the generated custom model name: `<label> / <upstream-model>`. Defaults to the preset label, then the provider name. |
| `apiKey` | Literal API key. Prefer an environment variable or file to avoid storing a secret in the config. |
| `apiKeyEnv` | Name of an environment variable containing the key. |
| `apiKeyFile` | File containing either `{"apiKey":"..."}` or a raw key with no whitespace. |
| `apiKeyUrl` | Private HTTPS URL returning `{"apiKey":"..."}`. |
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

### Route targets

| Target | Meaning |
| --- | --- |
| `"official"` | Remove the route and keep the official model. |
| `"<provider>:<model>"` | Send the official ID to the named provider and upstream model. |
| `"<provider>"` | Send the official ID to the same model ID on the named provider. |
| `"<model>"` | Send the official ID to that model on the default provider. |

Use a configured provider name in the first two target forms. Explicit routes take precedence over inferred routes.

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
9. A key already stored in `models.json` for the same chat-completions URL
10. Missing. A route without a key is not activated and remains official.

`apiKeyUrl` accepts HTTPS URLs only and expects a JSON response with an `apiKey` field. It should point to a private address. The URL fetch has an 8-second timeout.

## Presets

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
node scripts/sync-models.cjs --uninstall
node scripts/sync-models.cjs --quiet
```

| Option | Behavior |
| --- | --- |
| none | Apply the current config and write managed entries. |
| `--dry-run` | Print the routing plan and write nothing. |
| `--doctor` | Build a dry-run plan, then send a small request to each currently managed upstream model and report its HTTP status. Keys are not printed. |
| `--uninstall` | Remove plugin-managed model entries and generated allowlist entries. User models are kept. The state file is deleted. |
| `--quiet` | Suppress normal JSON output. The `SessionStart` hook uses this mode. |

The stdio MCP server provides:

| Tool | Behavior |
| --- | --- |
| `models_status` | Show the latest sync status and route summary. |
| `models_resync` | Re-read the config and rewrite `models.json`. |
| `models_doctor` | Send a small request to every managed upstream model and report status. |

## Security

- Never commit API keys or put them at a public URL.
- Protect `models.json`, `workbuddy-3p.json`, secret files, and backups with `chmod 600` where the platform supports POSIX modes. The sync script writes `models.json` and its state file with mode `600`.
- `apiKeyUrl` must use HTTPS. The code enforces HTTPS but cannot tell whether an address is private, so keep that URL on a private, controlled host.
- When an official model is routed, prompts and responses go to the configured third-party API.
- The WorkBuddy menu can still show the official model name for a routed slot. The selected request goes to the third-party provider.
- Third-party API usage and billing are your responsibility.
- This is an unofficial plugin. A WorkBuddy or CodeBuddy Code update can change the model file format or plugin behavior and break compatibility.

## Known limitations

- Whether a cloud sandbox runs the user plugin depends on platform synchronization. A new session is required to pick up the generated models; an already running session may need to be created again.
- Routed official slots keep their official display names in the menu.
- In `same-name` mode, routing an official ID to an upstream model that does not exist causes an upstream error. Run `--doctor` to check the managed models.
- Two providers cannot generate the same upstream model ID because the generated model object is keyed by that ID. The conflicting alias is skipped with a warning.
- Cloud sandboxes observed in 2026-09 (mainland China region) could not reach `github.com` (TLS reset), so a GitHub source can be accepted by the account API but the sandbox fails to `git clone` it. Mainland hosts such as `cnb.cool`, `gitee.com` and `gitcode.com` were reachable. If your sandbox has the same restriction, mirror this repository to a reachable host and add that URL as the plugin source.
- New sessions may run in a fresh sandbox rather than on a machine you control. A key stored only in one sandbox (for example a file on a long-lived VM) is not visible to other sandboxes; use a source that every sandbox can resolve, such as the plugin `API_KEY` option or a private `apiKeyUrl`.

## Uninstall and rollback

Uninstall `custom-api-models` in WorkBuddy, then either:

```bash
node scripts/sync-models.cjs --uninstall
```

or restore the first pre-change backup:

```text
~/.codebuddy/models.json.bak-workbuddy-3p
```

`--uninstall` removes only entries recorded in `workbuddy-3p.state.json`; user models remain. If the state file is missing, restore the backup or remove the generated entries manually.

## License

MIT
