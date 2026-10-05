---
description: Inspect or change custom-api-models reasoning-effort preferences (custom-api-models)
---
Use the `models_effort` MCP tool. Parse the user's request but do not invent a model, level, target scope, or save scope.

Accepted command shapes:

- `status [model]`: call `{"action":"status"}` or `{"action":"status","model":"<provider>:<upstream-model>"}`. Do not guess the selected model. If no model was named, list configured capabilities. Do not provide a fixed provider support table.
- `set <level> [model]`: without a model, use `scope:"default"`; with a model, use `scope:"model"` and the full `provider:upstream-model` form when possible. `saveScope` defaults to `account`; use `saveScope:"session"` only when the user explicitly asks for a local override.
- `reset [model|--all]`: use `scope:"model"` or `scope:"all"`; with no model, reset the default. A model reset removes that model's local per-model override and falls back through the remaining sources; do not promise a return to a preset value.

`scope` remains `default` / `model` / `all` (`all` is reset-only). `saveScope` is `account` by default or `session` when explicitly chosen; never silently fall back from account to session. A route-level effort wins over the model/default effort for that route.

Supported strength names are `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, validated per model. `on/off` are thinking toggles, not strength levels, and only accepted where the plugin declares the host path supported. Do not provide a highest-for-all operation in the public account flow.

Report status as configuration/disk state, not proof of an actual request (`runtimeVerified: false`). After the host reloads, the user may need to reselect the model. In official mode, third-party preferences are deferred until the source changes back. Never publish API keys or private profiles. Mobile has not been device-verified.

When changing a setting, state the exact model (or target scope), level, and save scope being applied. If the user has not supplied the level or model needed to disambiguate, ask instead of choosing for them. Never claim provider support that was not checked.
