---
description: Configure WorkBuddy models in this sandbox for the official backend (custom-api-models)
---
Call the MCP tool `models_switch` of the `custom-api-models` server with `{"mode": "official"}`, then call `models_status`.
Report in one or two short sentences: `configuredMode`, `switchFrom`, and whether managed third-party entries remain in `modelsJsonActive`/`active`. Say `runtimeVerified` is false and this is configured/on-disk state, not proof that live traffic has switched. Never print API keys or full base URLs.
If the host has not reloaded, reopen the same sandbox/session. A new sandbox follows account defaults; set official there again. Menu labels alone do not prove the route.
