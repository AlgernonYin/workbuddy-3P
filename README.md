# workbuddy-3P

WorkBuddy / CodeBuddy Code plugin marketplace that routes official model names in the model menu to a third-party
OpenAI-compatible API (currently Alibaba Bailian / DashScope). Hunyuan models and `auto` keep using the official backend.

## How it works

The `bailian-models` plugin writes `~/.codebuddy/models.json` (mode 600) at session start (SessionStart hook) and when its
stdio MCP server starts. The CLI watches that file / reloads models on MCP status changes, so no restart is needed.

- Each Bailian model is a custom model whose `aliases` contain the official ids (e.g. `glm-5.3`).
- `availableModels` hides the official entries with the same ids, so selecting the official name resolves to
  `custom-local:<bailian-id>` and the request goes to `dashscope.aliyuncs.com`.
- Slots `glm-5v-turbo` and `glm-5.3-flash` are borrowed for `qwen3.8-max` and `qwen3.8-flash`.

See `MAP` / `KEEP` in `plugins/bailian-models/scripts/sync-models.cjs`.

## API key (never commit it)

The key is read from the host, first hit wins:

1. `$BAILIAN_API_KEY`
2. file in `$BAILIAN_KEY_FILE`
3. `<plugin>/secret.json`
4. `~/.codebuddy/bailian-secret.json`
5. `/opt/keepalive/workbuddy-models/secret.json`
6. private HTTPS URL in `$BAILIAN_KEY_URL` or `~/.codebuddy/bailian-key-url` returning `{"apiKey":"..."}`
7. the key already present in `models.json`

Files contain `{"apiKey":"sk-..."}` or just the raw key. Use `chmod 600`.

## Install

In WorkBuddy: add plugin source `https://github.com/AlgernonYin/workbuddy-3P` (GitHub), then install `bailian-models`.

## Uninstall / rollback

Uninstall the plugin, then restore `~/.codebuddy/models.json.bak-bailian-plugin` or delete `~/.codebuddy/models.json`.

## License

MIT
