---
description: Show the configured and on-disk WorkBuddy model routing state (custom-api-models)
---
Call the MCP tool `models_status` of the `custom-api-models` server and summarise `configuredMode`, `switchFrom`, `modelsJsonActive`/`active`, `managedModels`, `runtimeVerified`, and `lastError`. Explain that `configuredMode` is configuration intent and the active/model fields are on-disk state only, so they do not prove live traffic switched; `runtimeVerified` is false. If a provider endpoint is shown, report only `host`. Never print API keys or full base URLs.
