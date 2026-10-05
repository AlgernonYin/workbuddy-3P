# WorkBuddy 3P

[简体中文](README.zh-CN.md)

**Version:** 3.0.0. The reviewed runtime (`1f1a103`) passed 264/264 tests on Windows and Linux. Official Native CLI verified a real DeepSeek V4.1 `max` request; explicit official mode rejected stale third-party loopback requests with HTTP 410. Cross-sandbox private global save/restore (`1.0.3`) and fresh private-asset retrieval were verified. Automatic installation of the released 3.0 plugin, the cloud MCP Apps panel, a physical phone, long-context behavior, and long-term refresh-token portability require separate acceptance; these checks do not guarantee a completed deployment.

WorkBuddy 3P is an unofficial, MIT-licensed plugin marketplace for cloud WorkBuddy / CodeBuddy Code. It lets WorkBuddy use an OpenAI Chat Completions-compatible API that you control. Web and mobile clients share the cloud sandbox mechanism, so the documented flow does not require client or web-page changes; physical-phone acceptance remains unverified. Routed slots can still appear under their WorkBuddy names; opening the menu is not proof that live traffic is routed.

The plugin manages only the model configuration it owns. Existing user models that it does not manage are preserved.

## Two settings layers

### 1. Provider and model

- Session routing supports OpenAI Chat Completions-compatible providers only. There is no protocol selector, and the plugin does not translate another wire protocol into Chat Completions.
- Configure a provider name, an HTTPS `baseUrl`, and a credential reference such as `apiKeyEnv`. Never place an API key in README examples, chat, or a public profile.
- Use `GET /models` discovery when the provider supports a model-list endpoint. If it returns 404, 405, or 501, import model IDs manually. A model name does not prove context, tools, images, or reasoning support.
- For each imported model, declare only what you know: input CTX, output limit, tool/image support, reasoning support, and `supportedEfforts`. Unknown values stay unknown. Do not guess 128K, and do not treat an input limit as provider capacity or as verified context compression.
- Run a small connectivity probe only when needed. It sends a fixed marker with `max_tokens` set to 16 and may incur charges. `HTTP 200` is not enough: the probe is successful only when the response completes and contains the marker. It verifies the endpoint/model only, not the host route, protocol translation, or current session traffic.

### 2. Routing

A route is explicit: an official WorkBuddy slot points to `provider:model`, with an optional per-route effort.

```json
{
  "routes": {
    "official-slot": {
      "provider": "example",
      "model": "upstream-model-id",
      "effort": "high"
    }
  }
}
```

- New configurations use explicit routes and no routes are created automatically. No provider, vendor preset, highest-tier, or same-name routing preference is selected by default. No highest-effort default is offered.
- Legacy preset/inference modes and built-in presets are advanced compatibility paths for old configurations only. They are recognized only when an old configuration explicitly contains them; they are not the public default or onboarding flow.
- Set effort per route from the model's declared `supportedEfforts`. A route-level effort wins over that model's default effort. Do not infer adjustable effort from `onlyReasoning`, and do not provide a highest-for-all bulk operation in the public account flow.

## Install and first connection

1. Add this repository as a marketplace source (GitHub or a mirror you trust) and install `custom-api-models`.
2. In a WorkBuddy session, open `/models-settings` or ask to open the WorkBuddy 3P settings panel.
3. For account defaults, call `models_settings` with `{ "action": "connect" }`. This returns the official WorkBuddy CLI/web login URL. Complete the login in your own account.
4. Call `models_settings` with `{ "action": "finish-connect" }`. It verifies the account and the private profile. `accountConnected: true` and `accountCommitted: false` mean authorization succeeded; connecting does not switch the source or change routing.
   An existing remote profile still appears in the account editor; the connection-only runtime state never hides or replaces the published editing baseline.
5. Apply settings with the default `scope: "account"`. Use `scope: "session"` only as an explicit advanced override for the current sandbox.

## Account defaults and synchronization

- In the default `account` scope, the panel view and `apply` use the last published account baseline. Ordinary account label edits update only that baseline; they do not globalize session parameters. If no baseline exists, the account view starts from an empty configuration. The first migration requires an explicit `importSession: true`; the panel exposes this as the advanced action **Import current session into account for the first time (explicit save required)** (`首次导入当前会话到账号（需明确保存）`).
- Switching scope reloads that scope's independent view. Unsaved drafts from one scope are not copied automatically into the other.
- Account saves go through the private WorkBuddy asset/profile route. Account credentials are the official Bearer access token plus refresh token, not a runtime model token. They belong only in the owner-side mode-600 runtime cache and the private profile; they are never returned to the panel, chat, or a public URL.
- The first private credential sync must be explicitly authorized by the account owner. Its runtime connection/cache files remain gitignored and must not be committed, published, or copied into public manifests.
- Host-only `apiKeyEnv`, `apiKeyFile`, and `apiKeyUrl` references are resolved privately during account apply and embedded only in the authorized private account package. The resolved value is never returned to the panel or written to a public view.
- Do not hand-merge profile/config files or use a manual `mergeProfile` workflow. Use `models_settings` status/apply with a fresh revision and the account connect/finish-connect flow.
- Publish preflight responses may require confirmation types. Show the exact types to the user and stop until the user explicitly confirms them. A preflight response is not a local or account success. Retry only the same logical apply with `confirmedConfirmationTypes`; never treat confirmation as a completed upload.
- `accountCommitted: true` is reported only after the uploaded profile is read back with status `ready`. `publicationPending` and `outcomeUnknown` are not success. Reopen status before deciding whether to retry; do not upload again automatically.
- An unknown or timed-out publication persists `retryBlocked: true`; inspect `models_settings`/`models_status` to reconcile the account state. Do not submit the same upload again.
- There is no verified server-side compare-and-swap (CAS). Version checks and ready/readback reduce some races, but concurrent edits from different sandboxes can still conflict or lose updates. Do not describe this as an atomic multi-file transaction.
- If the remote account asset is missing, keep the last-good cached routes. A missing remote asset is not evidence that the routes were revoked.
- A session apply that returns `localSyncPending`, `stateUnavailable`, partial, or otherwise incomplete is pending. Inspect status before any retry and do not automatically resend it.
- After a committed account save, the plugin may report `requiresHostRefresh` or `requiresModelReselection`. A global account change is not an instant native model switch on the current host. Existing hosts need the upgraded plugin, a refreshed catalog, and a fresh model selection.
- Active MCP sessions poll the private profile revision every 45 seconds and synchronize a changed account default. Synchronization is eventual and can be delayed by host sleep, reclamation, or process restart.
- A fresh sandbox adopts the published account configuration by default. Non-empty SDK options are not by themselves an explicit session-source selection, and connecting an account alone does not switch the source. An old plugin instance must be upgraded before it can consume the current profile; reselect the model after upgrading.
- A read-only volume does not become writable because settings are account-scoped. `WB3P_CONFIG_JSON` remains an owner-controlled read-only source.

## Settings panel, draft mode, and discovery

- The native MCP Apps panel uses the host bridge to apply settings directly. The standalone HTML artifact is only a draft editor. It does not write files; its secret-free instruction contains `scope`, `expectedRevision`, and a structured patch and must be sent back to the original chat before it can be applied. Preview or clipboard success is not a save receipt.
- The public flow does not provide a manual merge or "highest for all" tutorial. Use per-route effort, or use `models_effort` for explicit model/default preferences.
- Without a bridge, the standalone HTML cannot run model discovery or connectivity probes. Describe the **Discover models** and **Test model connectivity** buttons as draft-only: generate the draft, send it to the original chat, apply the provider there, and then call `discover` / `probe` from that chat, or manually import model IDs and declare capabilities.
- On a bridge-enabled panel, `discover` calls the provider's `GET /models` endpoint. Manual import remains the fallback when discovery is unsupported. `probe` requires an explicit model and `allowBillable: true`.
- Never treat a probe's HTTP 200, a preview, a preflight, or a local write as account success. `runtimeVerified: false` remains disk/configuration evidence only.

## Routing, credentials, and parameter priority

- `3p` is the default advanced parameter priority. Inside the target cloud sandbox, the adapter changes the routed upstream model ID and the user's effort only. It does not translate request content, tools, images, streaming, or SSE protocols; the provider must accept the Chat Completions shape used by the host.
- The original upstream key stays private. The adapter reads it from mode-600 private runtime state and uses it only in the upstream Authorization request. Official mode fails closed for proxy forwarding and sends no third-party traffic.
- `native` disables 3P forced parameters and lets host/session overrides win. It may still use an adapter for model-ID mapping when an explicit route binding requires it, so it is not a promise of direct connectivity in every configuration.
- Input context and effort are host metadata/preferences, not proof of upstream capacity or actual request behavior. This documentation does not claim physical-phone acceptance or context compression.

For implementation details, see the [parameter priority and loopback contract](docs/parameter-priority.md). It is an advanced reference; the public panel remains explicit-routes-first.

## Generic configuration example

Use reserved `example.invalid` values and a referenced environment variable. This example is illustrative, not a recommendation for a provider or model.

```json
{
  "providers": {
    "example": {
      "label": "Example",
      "baseUrl": "https://api.example.invalid/v1",
      "apiKeyEnv": "MODEL_API_KEY",
      "extraModels": ["upstream-model-id"],
      "models": {
        "upstream-model-id": {
          "maxInputTokens": 32768,
          "maxOutputTokens": 4096,
          "supportsToolCall": true,
          "supportsImages": false,
          "supportsReasoning": true,
          "reasoning": {
            "supportedEfforts": ["low", "medium", "high"],
            "defaultEffort": "medium"
          }
        }
      }
    }
  },
  "mode": "explicit",
  "routes": {
    "official-slot": {
      "provider": "example",
      "model": "upstream-model-id",
      "effort": "high"
    }
  }
}
```

Fill CTX manually for your own model; the `32768` in the example is illustrative only. In a local source config, `apiKeyEnv` is only a reference. During account apply, the plugin resolves it privately and embeds the resulting value only in the owner's authorized private account package; it is never returned or published.

## Common MCP and CLI entry points

MCP tools:

| Tool | Purpose |
| --- | --- |
| `models_settings` | `status`, `panel`, `apply`, `discover`, `probe`, `connect`, `finish-connect`. `apply` defaults to `scope: "account"`; `scope: "session"` is an explicit advanced override. `connect`/`finish-connect` authorize only and do not switch the source. |
| `models_status` | Report configuration/disk state, pending/retry-blocked publication, and last-good cache state. `runtimeVerified: false` does not prove live traffic. |
| `models_switch` | Switch between `official`, `third-party`, and `default`; `scope` defaults to `account`, and `scope: "session"` is an explicit local override. The `{ "mode": "official", "scope": "session" }` form is the local emergency fallback for broken provider/preset/route/capability/cache state. |
| `models_resync` / `models_doctor` | Re-read configuration / run planned small requests. Doctor may incur provider charges. |
| `models_effort` | Inspect or set effort preferences. `scope` remains `default`/`model`/`all`; `saveScope` defaults to `account`, and `saveScope: "session"` is explicit. Route-level effort wins over model/default effort. |

Common plugin commands:

```bash
cd plugins/custom-api-models
node scripts/sync-models.cjs --dry-run
node scripts/sync-models.cjs --doctor
node scripts/sync-models.cjs --official
node scripts/sync-models.cjs --third-party
node scripts/sync-models.cjs --status
node scripts/sync-models.cjs --uninstall
```

When provider, preset, route, capability, or cache state is broken, the current-sandbox emergency fallback is `models_switch` with `{ "mode": "official", "scope": "session" }` or:

```bash
node scripts/sync-models.cjs --official --scope session
```

This fallback requires no account authorization, is not globalized, and does not overwrite models whose ownership is uncertain. Repair the bad configuration before restoring 3P.

Use `/models-settings` for the supported public workflow and `/models-status`, `/models-official`, `/models-third-party`, or `/models-effort` for the corresponding narrow operations.

## Security

- Do not commit, paste, print, or publish API keys, private profiles, account tokens, or credential files.
- Use environment references or private files. POSIX private runtime files and backups should be mode `600`; directories should be `700`. Windows `chmod` is not an NTFS ACL.
- HTTPS is required except for loopback development endpoints. Do not put userinfo, a query, or a fragment in `baseUrl`.
- Account sync credentials are limited to the owner's private runtime and private profile. A private profile is not an encrypted vault; anyone who can read the account/sandbox can read its contents.
- The first private credential sync requires the owner's authorization. Keep the runtime connection/cache files gitignored and out of public manifests, chat, and reports.
- When a slot is routed, the prompt and response go to the configured third-party provider. Routing and provider charges are your responsibility.

## Known limits

- A saved setting is not a live-request receipt. Host catalog refresh, model reselection, or a new session may be required.
- Account scope updates future/account-backed sandbox defaults; it does not instantly change the native selected model on the current host.
- There is no verified server-side CAS. Cross-sandbox concurrent edits can conflict or lose updates; revision checks and readback are safeguards, not an atomic multi-file transaction.
- An unresolved or pending upload is retry-blocked. Inspect `models_settings`/`models_status` before doing anything; never automatically resubmit it.
- A missing remote profile retains the last-good cached routes instead of revoking them.
- A read-only volume remains read-only. The plugin does not make a platform-owned read-only mount writable.
- Model-list discovery may be unsupported. Unknown capabilities remain unknown; the plugin does not invent 128K context, tool, image, or effort support.
- Input metadata is a host-side input limit, not provider capacity or compression evidence.
- The endpoint probe checks a small completions request only. HTTP 200 without the marker is not completion.
- Protocol translation is out of scope; configure an OpenAI Chat Completions-compatible endpoint.
- Physical-phone and long-context behavior have not been verified. Treat mobile as sharing the cloud mechanism, not as device-tested, and do not mark either area as accepted.
- Existing old plugin versions must be upgraded and the model reselected before they can consume the current account profile.

**2.5.1 historical compatibility:** the old official-catalog fallback behavior is documented separately in [official switch compatibility](docs/official-switch-compatibility.md). It is historical compatibility, not the current public default.

## License

MIT
