# WorkBuddy 3P

[English](README.md)

WorkBuddy 3P 是一个非官方、MIT 许可的插件市场，面向云端 WorkBuddy / CodeBuddy Code。它让模型选择使用你自己的 OpenAI 兼容 API。网页端和手机端共用同一套云沙箱机制，因此不需要修改网页或客户端。

插件只改写自己管理的模型配置，ID 不由插件管理的用户模型会保留。

## 原理

- `SessionStart` hook 和 stdio MCP server 启动时都会运行 `sync-models.cjs`。
- 同步脚本写入 `~/.codebuddy/models.json`，权限为 `600`。
- 每条第三方模型以目标上游模型 ID 作为自定义模型 ID，`aliases` 中保存需要解析到它的 WorkBuddy 官方 ID。WorkBuddy 将这些自定义槽位显示为 `custom-local:<model-id>`。
- 生成的 `availableModels` 会隐藏同 ID 的官方条目，所以在菜单中选择官方名称时，请求会解析到第三方模型。
- `keepOfficial` 中的官方 ID，以及未能路由的 ID，继续使用官方后端，包括 `auto`、混元模型和其他列出的官方条目。
- `~/.codebuddy/workbuddy-3p.state.json` 记录插件管理的模型 ID 和 allowlist 条目。后续同步会保留 ID 不在管理列表中的用户模型。

## 快速开始

1. 在 WorkBuddy 中添加插件来源，类型选 GitHub，地址填 `https://github.com/AlgernonYin/workbuddy-3P`。
2. 安装 `custom-api-models` 插件。
3. 用环境变量/插件选项或 JSON 文件配置 provider。
4. 新建 WorkBuddy 会话，在菜单中选择已路由的官方模型名称。

### 零配置文件

设置以下环境变量，或使用同名的插件选项：

```text
WB3P_BASE_URL=https://api.example.com/v1
WB3P_API_KEY=<your-api-key>
WB3P_PRESET=bailian
WB3P_ROUTES={"glm-5.3":"my-model","kimi-k3":"official"}
```

插件选项名称为 `BASE_URL`、`API_KEY`、`PRESET` 和 `ROUTES`。`WB3P_ROUTES` 必须是 JSON 对象。

如果没有配置文件和显式 base URL，默认使用 `bailian` preset。没有可解析的 API key 时，不会添加路由模型，也不会隐藏官方条目。

### 使用配置文件

创建 `~/.codebuddy/workbuddy-3p.json`：

```json
{
  "default": "main",
  "mode": "same-name",
  "providers": {
    "main": {
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MY_API_KEY"
    }
  },
  "routes": {
    "glm-5.3": "my-upstream-model",
    "kimi-k3": "official"
  },
  "keepOfficial": []
}
```

脚本按以下顺序查找配置，使用第一个有效的 JSON 对象：

1. `$WB3P_CONFIG_JSON`
2. `$WB3P_CONFIG`
3. `$CODEBUDDY_CONFIG_DIR/workbuddy-3p.json`；未设置 `CODEBUDDY_CONFIG_DIR` 时使用 `~/.codebuddy/workbuddy-3p.json`
4. `/etc/workbuddy-3p/config.json`
5. `/opt/workbuddy-3p/config.json`
6. `<plugin-root>/config.json`

如果没有可用文件，则使用上一节的环境变量/插件选项配置方式。

## 配置参考

### 顶层字段

| 字段 | 行为 |
| --- | --- |
| `providers` | 必填对象，键为 provider 名称。为空时同步失败。 |
| `default` | 默认 provider 名称。该名称不存在时使用第一个 provider。 |
| `mode` | 路由模式，默认 `same-name`。 |
| `routes` | 可选对象，将官方模型 ID 映射到路由目标。这里会覆盖模式和 preset 推导出的路由。 |
| `keepOfficial` | 额外保留在官方后端的官方 ID 数组。已经路由的 ID 由 alias 处理，不会因这里而保留。 |
| `models` | 可选的能力覆盖，键格式为 `"<provider>:<upstream-model>"`。 |
| `defaults` | 可选能力默认值；provider 没有 `defaults` 且模型没有 preset template 时使用。 |
| `enabled` | 设为 `false` 后，下次正常同步会执行卸载。`--dry-run` 只报告禁用状态。 |

### Provider 字段

| 字段 | 行为 |
| --- | --- |
| `preset` | 可选内置 preset 名称，目前为 `bailian`。 |
| `baseUrl` | OpenAI 兼容 base URL。已经以 `/chat/completions` 结尾时直接使用，否则追加 `/chat/completions`。preset 也可以提供该值。 |
| `label` | 生成的自定义模型显示名前缀：`<label> / <upstream-model>`。默认依次使用 preset 的 label、provider 名称。 |
| `apiKey` | 直接写入的 API key。为避免配置中保存密钥，优先使用环境变量或文件。 |
| `apiKeyEnv` | 保存密钥的环境变量名。 |
| `apiKeyFile` | 密钥文件，内容可以是 `{"apiKey":"..."}`，也可以是不含空白字符的原始 key。 |
| `apiKeyUrl` | 返回 `{"apiKey":"..."}` 的私有 HTTPS 地址。 |
| `models` | 上游模型 ID 到能力设置的映射，会覆盖 preset 中的同名模型设置。 |
| `defaults` | 当前 provider 模型的能力默认值。 |
| `extraModels` | 额外暴露为自定义模型的上游模型 ID 数组，不映射官方槽位。 |

Provider 必须直接提供 `baseUrl`，或由 preset 提供。

### 路由模式

| 模式 | 行为 |
| --- | --- |
| `same-name` | 默认模式。对每个已知可路由的官方 ID，优先使用 preset 的映射；没有映射时，在默认 provider 上使用同名模型，除非 preset 把它列入 `unsupported`。显式 `routes` 仍会覆盖结果。 |
| `preset-only` | 只根据默认 provider 的 preset 生成路由。显式 `routes` 仍会覆盖结果。 |
| `explicit` | 不生成 preset 或同名路由，只使用显式 `routes` 和 `extraModels`。 |

`same-name` 和 `preset-only` 还会把 preset 中的模型 ID 暴露为额外自定义模型。因此百炼 preset 会暴露 `qwen3.8-max` 和 `qwen3.8-flash`，即使它们默认不替换官方槽位。

### 路由目标

| 目标 | 含义 |
| --- | --- |
| `"official"` | 删除该路由，继续使用官方模型。 |
| `"<provider>:<model>"` | 将官方 ID 发给指定 provider 的指定上游模型。 |
| `"<provider>"` | 将官方 ID 发给指定 provider 的同名模型。 |
| `"<model>"` | 将官方 ID 发给默认 provider 的指定模型。 |

前两种写法必须使用已配置的 provider 名称。显式路由优先于推导路由。

### 能力参数覆盖

越具体的设置优先级越高：

1. `models["<provider>:<upstream-model>"]`
2. `providers.<name>.models["<upstream-model>"]`
3. preset 的模型设置和 template
4. provider 或顶层 defaults
5. 内置回退值

示例：

```json
{
  "models": {
    "main:my-upstream-model": {
      "maxInputTokens": 200000,
      "maxOutputTokens": 32768,
      "supportsToolCall": true,
      "supportsImages": true,
      "supportsReasoning": true
    }
  }
}
```

上游 API 需要时，preset template 还可以使用 `onlyReasoning`、`useCustomProtocol`、`compat`、`thinkingLevelMap` 和 `reasoning` 等字段。

### API key 解析顺序

使用第一个非空值：

1. `providers.<name>.apiKey`
2. `providers.<name>.apiKeyEnv` 指向的环境变量
3. `WB3P_<NORMALIZED_PROVIDER>_API_KEY`，provider 名称中的非字母数字字符会替换为 `_`
4. 仅默认 provider：`WB3P_API_KEY` 或插件选项 `API_KEY`
5. `providers.<name>.apiKeyFile`
6. `<config-dir>/workbuddy-3p.secrets/<provider-name>`
7. 仅默认 provider：`WB3P_API_KEY_FILE`
8. `providers.<name>.apiKeyUrl`；默认 provider 还可使用 `WB3P_API_KEY_URL`
9. `models.json` 中相同 chat-completions URL 已保存的 key
10. 未找到。没有 key 的路由不会启用，对应模型继续使用官方后端。

`apiKeyUrl` 只接受 HTTPS，并要求响应 JSON 中存在 `apiKey` 字段。它应指向私有地址。URL 请求超时为 8 秒。

## 预设

### 百炼

`bailian` preset 使用：

```text
https://dashscope.aliyuncs.com/compatible-mode/v1
```

映射表：

| 官方 ID | 百炼模型 ID |
| --- | --- |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash` |
| `deepseek-v4-pro` | `deepseek-v4-pro` |
| `deepseek-v4-flash` | `deepseek-v4-flash` |
| `deepseek-v3-2-volc` | `deepseek-v3.2` |
| `glm-5.3` | `glm-5.3` |
| `glm-5.3-flashx` | `glm-5.3` |
| `glm-5.2` | `glm-5.2` |
| `glm-5.1` | `glm-5.1` |
| `glm-5.0` | `glm-5` |
| `glm-5.0-turbo` | `glm-5` |
| `glm-4.7` | `glm-4.7` |
| `glm-4.6` | `glm-4.7` |
| `kimi-k3-1` | `kimi-k3` |
| `kimi-k3-2` | `kimi-k3` |
| `kimi-k3` | `kimi-k3` |
| `kimi-k2.8-preview` | `kimi/kimi-k2.8-preview` |
| `kimi-k2.7` | `kimi-k2.7-code` |
| `kimi-k2.6` | `kimi-k2.6` |
| `kimi-k2.5` | `kimi-k2.5` |
| `kimi-k2-thinking` | `kimi-k2-thinking` |
| `minimax-m3` | `MiniMax/MiniMax-M3` |
| `minimax-m3-pay` | `MiniMax/MiniMax-M3` |
| `minimax-m2.7` | `MiniMax/MiniMax-M2.7` |
| `minimax-m2.5` | `MiniMax/MiniMax-M2.5` |

`glm-5v-turbo` 和 `glm-5.3-flash` 被列为不支持的模型，默认保留官方后端。如果接受模型替换，可以手动路由到百炼的 `qwen3.8-max` 和 `qwen3.8-flash`：

```json
{
  "providers": {
    "main": {
      "preset": "bailian",
      "apiKeyEnv": "BAILIAN_API_KEY"
    }
  },
  "routes": {
    "glm-5v-turbo": "qwen3.8-max",
    "glm-5.3-flash": "qwen3.8-flash"
  }
}
```

欢迎提交新 preset 的 PR。

## 命令与 MCP 工具

在插件根目录运行：

```bash
cd plugins/custom-api-models

node scripts/sync-models.cjs
node scripts/sync-models.cjs --dry-run
node scripts/sync-models.cjs --doctor
node scripts/sync-models.cjs --uninstall
node scripts/sync-models.cjs --quiet
```

| 选项 | 行为 |
| --- | --- |
| 无 | 应用当前配置并写入管理条目。 |
| `--dry-run` | 输出路由计划，不写文件。 |
| `--doctor` | 先生成 dry-run 计划，再向当前每条受管理上游模型发送一个小请求并报告 HTTP 状态。不会输出 key。 |
| `--uninstall` | 删除插件管理的模型条目和生成的 allowlist 条目，保留用户模型，并删除状态文件。 |
| `--quiet` | 不输出正常 JSON。`SessionStart` hook 使用该模式。 |

stdio MCP server 提供：

| 工具 | 行为 |
| --- | --- |
| `models_status` | 显示最近一次同步状态和路由摘要。 |
| `models_resync` | 重新读取配置并改写 `models.json`。 |
| `models_doctor` | 向每条受管理的上游模型发送小请求并报告状态。 |

## 安全

- 不要把 API key 提交到仓库，也不要把它放在公开 URL。
- 在支持 POSIX 权限的平台上，对 `models.json`、`workbuddy-3p.json`、密钥文件和备份执行 `chmod 600`。同步脚本会以 `600` 写入 `models.json` 和状态文件。
- `apiKeyUrl` 必须使用 HTTPS。代码只能检查协议，无法判断地址是否私有，所以应把它放在自己控制的私有主机上。
- 官方模型完成路由后，提示词和响应会发往配置的第三方 API。
- 已路由槽位在 WorkBuddy 菜单中仍可能显示官方模型名，实际请求发往第三方 provider。
- 第三方 API 的使用和计费由你承担。
- 这是非官方插件。WorkBuddy 或 CodeBuddy Code 更新后，模型文件格式或插件行为变化可能导致失效。

## 已知限制

- 云沙箱是否执行用户插件取决于平台同步。新会话才会生效；已经运行的会话可能需要新建会话。
- 路由后的官方槽位在菜单中仍显示官方名称。
- 在 `same-name` 模式下，如果路由到上游不存在的同名模型，会返回上游错误。可用 `--doctor` 检查受管理模型。
- 两个 provider 不能生成相同的上游模型 ID，因为生成的模型对象以该 ID 为键。发生冲突时会跳过对应 alias，并输出 warning。
- 2026-09 实测的云沙箱（中国大陆区域）无法访问 `github.com`（TLS 被重置）：账号接口能添加 GitHub 来源，但沙箱内 `git clone` 会失败；`cnb.cool`、`gitee.com`、`gitcode.com` 可以访问。遇到同样限制时，请把本仓库镜像到可访问的托管平台，再用该地址添加插件来源。
- 新会话可能运行在全新的沙箱，而不是你控制的机器上。只存放在某一个沙箱（例如长期运行的 VM 上的文件）的 key，其他沙箱读不到；请使用每个沙箱都能取到的方式，例如插件选项 `API_KEY` 或私有的 `apiKeyUrl`。

## 卸载与回滚

在 WorkBuddy 中卸载 `custom-api-models`，然后选择一种方式：

```bash
node scripts/sync-models.cjs --uninstall
```

或恢复第一次修改前的备份：

```text
~/.codebuddy/models.json.bak-workbuddy-3p
```

`--uninstall` 只删除 `workbuddy-3p.state.json` 中记录的条目，用户模型会保留。如果状态文件已经丢失，请恢复备份或手动删除生成的条目。

## License

MIT
