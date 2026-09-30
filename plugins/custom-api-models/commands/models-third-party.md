---
description: Configure WorkBuddy models in this sandbox for the configured third-party API (custom-api-models)
---
Call the MCP tool `models_switch` of the `custom-api-models` server with `{"mode": "third-party"}`, then call `models_status`.
Tell the user to reselect the target model before the next message (choose Hy3 and then the target if the same label remains). This refreshes the host's active model ID; the plugin cannot change that selection itself. Prefer a non-routed official model such as default Hy3 while switching.
Report in one or two short sentences: `configuredMode`, `switchFrom`, `modelsJsonActive`/`active`, and any warnings. Say `runtimeVerified` is false and this report does not prove that live traffic has switched. Never print API keys or full base URLs.
