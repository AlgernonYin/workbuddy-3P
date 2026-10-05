---
description: Open the WorkBuddy 3P settings panel or apply explicit provider, model, route, and account settings
---

Use `models_settings` for the WorkBuddy 3P settings panel. Read `action: "status"` before any mutation and explain that account defaults affect future/account-backed sandboxes, while the current host may still need a catalog refresh and model reselection.

The public settings model has two layers:

1. **Provider + model:** only an OpenAI Chat Completions-compatible endpoint is supported for session routing. Add a provider with an HTTPS `baseUrl` and a credential reference such as `apiKeyEnv`; never ask for or return an inline key. Use `GET /models` discovery when supported, otherwise import model IDs manually. For each imported model, declare only user-confirmed CTX, output limit, tools, images, reasoning, and `supportedEfforts`. Unknown capability stays unknown: do not guess 128K context, do not infer tools or images from a model name, and do not treat an input limit as provider capacity or compression evidence.
2. **Routing:** map an official WorkBuddy slot to an explicit `provider:model` and set that route's effort. New configurations start with `mode: "explicit"` and empty routes. Do not create a provider default or a highest-effort default. Legacy preset/inference modes and built-in presets are advanced compatibility for old explicit configs only; never present them as the public workflow.

## Account connection and publishing

If `status.accountSync.available` is false, call `{ "action": "connect" }`. It returns the official WorkBuddy CLI/web login URL. The user must complete that login in their own account. Then call `{ "action": "finish-connect" }`; it verifies the account and private profile. `accountConnected: true` with `accountCommitted: false` means authorization only, not a published profile. Connecting does not switch the source or change routing.

Use `scope: "account"` by default for `apply`. Use `scope: "session"` only when the user explicitly asks for an advanced current-sandbox override. If account sync is unavailable, do not silently fall back to session scope.

Account sync credentials are the official Bearer access token plus refresh token, not a runtime model token. They belong only in owner-side mode-600 runtime storage and the private profile. Never display them, put them in a draft, or send them to a public URL. The first private credential sync requires explicit owner authorization; its runtime connection/cache files remain gitignored and must not be published. Host-only `apiKeyEnv`, `apiKeyFile`, and `apiKeyUrl` references are resolved privately during account apply and embedded only in the authorized private account package, never in a public view. Do not hand-merge and do not use a manual `mergeProfile` workflow; apply only through revision-guarded settings.

For account publish:

- Require a fresh `expectedRevision` and apply only the fields selected by the user.
- A preflight may return `confirmationRequired` with exact `confirmationTypes`. Show them to the user and stop until the user explicitly confirms those types. Re-run the same logical apply with `confirmedConfirmationTypes`. Preflight confirmation is not local or account success.
- Do not claim success from a local write, `committed: true`, a preflight response, or an upload request alone. Only `accountCommitted: true` after readback status `ready` means the account profile committed.
- If the result is `publicationPending`, `outcomeUnknown`, or `localSyncPending`, reopen status before any retry. Do not automatically upload again.
- Unknown or timed-out publication persists `retryBlocked: true`; use `models_settings`/`models_status` to reconcile. Never resubmit the same upload. There is no verified server-side CAS across sandboxes, so concurrent changes can still conflict or lose updates; revision checks and ready/readback are not an atomic multi-file transaction.
- If the remote account asset is missing, keep last-good cached routes. Report local partial/`stateUnavailable`/pending results as pending; do not automatically resend a session apply.
- After a committed save, explain `requiresHostRefresh` and `requiresModelReselection` when present. A global account change is not an instant native model switch on the current host. Active MCP sessions poll the private profile revision every 45 seconds and sync changes eventually; sleep, reclamation, or process restart can delay that.
- A fresh sandbox loads account profile data after plugin initialization. An old plugin must be upgraded, and the model must be reselected after the upgrade. A read-only volume remains read-only; account scope does not make it writable.

## Panel fallback and draft mode

The native MCP Apps panel applies through the host bridge. If the host cannot render it, call `{ "action": "panel" }` and pass only its `artifactPath` to the host's file-presentation tool. The standalone HTML is a draft editor, not a writer: its generated secret-free instruction contains `scope`, `expectedRevision`, and a structured patch, and must be sent back to the original chat before it can be applied. Preview or clipboard success is not a save receipt.

Without a bridge, the standalone HTML cannot discover or probe models. Treat the **Discover models** and **Test model connectivity** buttons as draft-only actions: generate the draft, send it to the original chat, apply the provider there, then call `discover` or `probe` from that chat. Manual model IDs and explicit capability declarations are the fallback when discovery is unsupported. Never report a draft-mode discovery/probe click as a completed request.

## Discovery and connectivity probes

With a bridge or the MCP tool, use `{ "action": "discover", "providerId": "<saved-provider>" }` for `GET /models`. A 404, 405, or 501 means discovery is unsupported; ask the user for model IDs and declare capabilities manually.

Use `{ "action": "probe", "providerId": "<saved-provider>", "model": "<model-id>", "allowBillable": true }` only after the user explicitly accepts a potentially billed request. The probe sends a fixed marker with `max_tokens: 16`; it is successful only when the response completes and contains the marker. HTTP 200 alone is not enough. It verifies the endpoint/model, not host routing, protocol translation, or current session traffic. Do not claim physical-phone acceptance or context compression from a probe.

## Routing, effort, and credentials

For each route, use `provider:model` and an optional effort from that model's declared `supportedEfforts`. A route-level effort wins over the model/default effort. Do not infer adjustable effort from `onlyReasoning`. Do not offer a bulk highest-effort operation in the public account flow.

Use `models_effort` with `scope` remaining `default` / `model` / `all` and `saveScope` defaulting to `account`; use `saveScope: "session"` only when explicitly requested. Use `models_switch` with `scope` defaulting to `account`; `scope: "session"` is an explicit local override and account unavailability must never silently fall back to it.

`3p` is the advanced default parameter priority. Inside the target cloud sandbox, routing changes only the upstream model ID and user effort; it does not translate content, tools, images, streaming, or SSE protocol. Only an OpenAI Chat Completions-compatible endpoint is supported; there is no protocol selector. The original upstream key remains private and is used only on the upstream Authorization request. Official mode fails closed for proxy forwarding and sends no third-party traffic. `native` disables 3P forced parameters but may still use an adapter for model-ID mapping when an explicit route binding requires it; do not promise direct connectivity in every configuration.

When editing labels or routes, preserve existing credentials. An endpoint change requires a new credential reference or explicit user consent to reuse the existing credential. Read the live state; do not fabricate supported efforts or context values for unknown models. `runtimeVerified: false` is configuration/disk evidence only, and a saved setting is not HTTP success.
