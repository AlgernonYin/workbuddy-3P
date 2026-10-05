---
name: workbuddy-3p-settings
description: Configure explicit WorkBuddy 3P providers, models, routes, account defaults, and per-route effort from a visual panel or chat. Never requests API keys in chat and never treats a draft, preflight, or on-disk write as live routing proof.
---

Read `../../commands/models-settings.md` and follow its workflow. Prefer the native `models_settings` MCP Apps panel; when the host does not render MCP Apps, use the tested host question-tool wizard such as `AskUserQuestion`. Do not modify webpage code, native global/session settings, or unrelated services.

Use explicit routes only. Only an OpenAI Chat Completions-compatible endpoint is supported for session routing; do not offer a protocol selector or protocol translation. Read live status, reread the revision, validate the model's declared capabilities, and change only the requested fields. Default to `scope: "account"` for `models_settings` and `models_switch`; `scope: "session"` is an explicit local override and account unavailability must never silently fall back to it. Legacy preset/inference modes and built-in presets are advanced compatibility for old explicit configs only.

Connect/finish-connect only authorize the account; they do not switch the source or change routing. The first private credential sync requires the owner's explicit authorization. Host-only `apiKeyEnv`, `apiKeyFile`, or `apiKeyUrl` references are resolved privately into the authorized private account package; never return, print, or publish the resolved value. Keep runtime connection/cache files gitignored. Do not hand-merge or use a manual `mergeProfile` workflow.

For account publication, require a fresh `expectedRevision`, stop for exact `confirmationTypes`, and only report `accountCommitted:true` after ready/readback. Treat `publicationPending`, `outcomeUnknown`, `localSyncPending`, `stateUnavailable`, partial, or unknown as pending and reconcile with status before any retry; never automatically resubmit. Unknown/timed-out publication is persistently `retryBlocked`. There is no verified server-side CAS across sandboxes, so concurrent changes may conflict or lose updates; revision checks and readback are not an atomic multi-file transaction. Missing remote assets retain last-good cached routes rather than revoking them.

For effort preferences, use `models_effort` with `scope` remaining `default` / `model` / `all` and `saveScope` defaulting to `account`; use `saveScope: "session"` only when explicitly requested. Route-level effort wins over model/default effort. Do not offer a highest-for-all tutorial. Validate levels from `supportedEfforts` / `canDisableThinking`; never infer them from `onlyReasoning`.

`3p` uses the target-cloud-host adapter and enforces declared parameters. `native` disables 3P-forced parameters but may still use an adapter for model-ID mapping when an explicit route binding requires it, so do not promise direct connectivity in every case. The upstream key remains private and is used only on the upstream Authorization request. Official mode fails closed for proxy forwarding.

A standalone HTML preview is only a draft. Do not claim HTTP success, physical-phone acceptance, context compression, or live traffic from a saved/draft/configured state; `runtimeVerified:false` remains configuration/disk evidence only.
