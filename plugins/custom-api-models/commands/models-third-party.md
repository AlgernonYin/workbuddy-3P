---
description: Configure WorkBuddy models in this sandbox for the configured third-party API (custom-api-models)
---
Call the MCP tool `models_switch` of the `custom-api-models` server with `{"mode":"third-party","scope":"account"}` by default, then call `models_status`. `scope:"session"` is only an explicit local override and is never used as a silent fallback; if account sync is unavailable, authorize it first or ask, rather than falling back locally.
Tell the user to reselect the target model before the next message (choose a non-routed official model and then the target if the same label remains). This refreshes the host's active model ID; the plugin cannot change that selection itself. Prefer a non-routed official model such as Hy4 preview while switching.
Report in one or two short sentences: `configuredMode`, `switchFrom`, `modelsJsonActive`/`active`, and any warnings. Say `runtimeVerified` is false and this report does not prove that live traffic has switched. Never print API keys or full base URLs.
If the result is pending, retry-blocked, partial, or unknown, report it as pending and reconcile with `models_status`; do not automatically resubmit.
