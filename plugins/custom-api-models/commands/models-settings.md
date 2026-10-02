---
description: Open the WorkBuddy 3P settings panel or a mobile-friendly chat wizard
---

Use `models_settings` with `action: status` to open the native MCP Apps settings panel. Tell the user this panel adjusts third-party model defaults in the current sandbox, not the account or native global settings. Do not ask them to write JSON or shell commands.

If the host does not render the native panel, call `models_settings` with `action: panel` and pass ONLY its `artifactPath` to the host's `present_files` tool. That standalone HTML is a visual draft editor: it cannot directly write files. Its generated secret-free instruction must be sent to the ORIGINAL chat to apply. Do not describe preview or clipboard success as saved settings.

If HTML preview is unavailable or the user prefers chat/mobile, use the host's interactive question tool (e.g. `AskUserQuestion`) to offer: thinking strength/context; providers/custom routes; official/third-party source. Read the live status, offer only that model's declared supportedEfforts, and validate the requested input context against baseInputTokens. Context is a local input/compaction limit; it cannot increase upstream capacity. A thinking-only model does not have adjustable effort levels. Unsupported native thinking toggles must not be offered.

For "highest for every model", call status again then apply `{maxEffort:true}` using that fresh revision; do not set every model to the literal `max`. For individual changes, apply only the selected fields. Keep credentials when editing labels/routes. A changed endpoint requires an explicit new `apiKeyEnv` reference or user consent to `reuseCredential:true`. Never ask for keys in chat, read secrets into the model context, or return inline keys. Use private runtime credential files/environment/account-private profile for credentials.

Before applying a draft, match the intended changes against the user's request. If revision is stale, reopen status and show differences before constructing a new patch; never silently replace its revision. After success state that private backups exist and host model-catalog refresh/reselection may still be required. `runtimeVerified:false` is disk state only. Never claim new sandboxes inherit local changes; private profile must be separately updated/uploaded by its owner.
