---
description: Inspect or change custom-api-models reasoning-effort defaults (custom-api-models)
---
Use the `models_effort` MCP tool of the `custom-api-models` server. Parse the user's request but do not invent a model, level, or scope. Accepted command shapes are `status [model]`, `set <level> [model]`, and `reset [model|--all]`.

- Status: call `{"action":"status"}`. If the user named a model, call `{"action":"status","model":"<provider>:<upstream-model>"}`. Do not guess the currently selected model. If no model was named, list the configured capabilities. Do not provide a fixed provider support table.
- Set: require a level explicitly supplied by the user. Without a model, call `{"action":"set","scope":"default","level":"<level>"}`. With a model, use `scope:"model"` and the full `provider:upstream-model` form when possible. A unique official alias or upstream ID may also resolve, but do not rely on an ambiguous short name.
- Reset: call `{"action":"reset","scope":"all"}` for `--all`. With an explicit model, use `scope:"model"`. Otherwise reset the local default. A model reset removes that model's local per-model override and falls back through local default, config per-model, config default, then the model's original default; do not promise a return to the preset value.

Supported strength names are `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, validated per model. `on/off` are thinking toggles, not strength levels, and only accepted where the plugin declares the host path supported; Kimi K3, DeepSeek V4.1 Flash and MiniMax M3 must not be offered unimplemented off toggles. `ultracode` and token budgets are not supported. A default/global change skips unsupported models and lists them; an unsupported single-model setting is rejected.

Prefer `/models-settings` for the visual panel or chat wizard. For a user-requested highest level across models, read `models_settings` status and apply `maxEffort:true` with a fresh revision instead of setting every target to literal max.

Report status as configuration/disk state, not proof of an actual request (`runtimeVerified: false`). After the host reloads, the user may need to reselect the model. In official mode, the plugin does not modify the native global `reasoningEffort` or official parameters; settings are saved as deferred configuration and applied after switching back to third-party.

Local effort settings persist only in this sandbox and are not automatically account-synced. To make the same default apply to new sandboxes, put `effort` under the account-private profile's `config`, then package and upload the profile. Never publish API keys or the profile. Mobile shares the cloud mechanism, but has not been device-verified.

When changing a setting, state the exact model (or the default scope) and level being applied. If the user has not supplied the level or model needed to disambiguate, ask instead of choosing for them. Never claim provider support that was not checked.
