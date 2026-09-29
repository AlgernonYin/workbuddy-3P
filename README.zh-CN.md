# WorkBuddy 3P

[English](README.md)

**版本：** 2.2.1

WorkBuddy 3P 是一个非官方、MIT 许可的插件市场，面向云端 WorkBuddy / CodeBuddy Code。它让模型选择使用你自己的 OpenAI 兼容 API。网页端和手机端共用同一套云沙箱机制，因此不需要修改网页或客户端。

插件只改写自己管理的模型配置，ID 不由插件管理的用户模型会保留。

## 原理

- `SessionStart` hook 和 stdio MCP server 启动时都会运行 `sync-models.cjs`。并发同步会用 `~/.codebuddy/workbuddy-3p.lock` 串行化。已有 `models.json` 保留 inode 原位写入，以兼容宿主的文件监视器；状态文件原子替换。
- 同步脚本写入 `~/.codebuddy/models.json`，权限为 `600`。
- 每条第三方模型以目标上游模型 ID 作为自定义模型 ID，`aliases` 中保存需要解析到它的 WorkBuddy 官方 ID。WorkBuddy 将这些自定义槽位显示为 `custom-local:<model-id>`。
- `availableModels` 只隐藏实际被路由的官方 ID；上游模型 ID 不会仅因为它是自定义模型 ID 而被隐藏。如果用户原有 allowlist 含被路由的官方 ID，插件会暂时移除，卸载或切回官方时恢复。
- `keepOfficial` 中的官方 ID，以及未能路由的 ID，继续使用官方后端，包括 `auto`、混元模型和其他列出的官方条目。
- 与插件生成模型同 ID 的用户模型会在插件激活期间被替换，并输出 warning；卸载或切回官方时恢复。
- `~/.codebuddy/workbuddy-3p.state.json` 记录插件管理的模型 ID 和 allowlist 条目。后续同步会保留 ID 不在管理列表中的用户模型。

## 快速开始

1. 在 WorkBuddy 中添加插件来源，类型选 GitHub，地址填 `https://github.com/AlgernonYin/workbuddy-3P`。
   - 中国大陆云沙箱无法访问 GitHub 时，使用维护者镜像 `https://cnb.cool/AlgernonYin/workbuddy-3P`（镜像，内容与 GitHub `main` 同步）。
2. 安装 `custom-api-models` 插件。
3. 用环境变量/插件选项或 JSON 文件配置 provider。
4. 新建 WorkBuddy 会话，在菜单中选择已路由的官方模型名称。

### 零配置文件

设置以下环境变量，或使用同名的插件选项。

#### 通用 OpenAI 兼容

```text
WB3P_BASE_URL=https://api.example.com/v1
WB3P_API_KEY=<your-api-key>
```

#### 百炼

```text
WB3P_PRESET=bailian
WB3P_API_KEY=<your-api-key>
```

插件选项名称为 `ENABLED`、`BASE_URL`、`API_KEY`、`PRESET` 和 `ROUTES`。`WB3P_ROUTES` 必须是 JSON 对象。

既没有 `BASE_URL` 也没有 `PRESET` 时，插件不做任何路由，也没有默认 preset。没有可解析的 API key 时，不会添加路由模型，也不会隐藏官方条目。

### 新沙箱与密钥

云端网页在当前实测版本没有可用的插件选项保存入口；自定义 MCP 保存也会报 `saveConfiguration` 未定义。推荐将配置打成**个人私有技能包**，通过 WorkBuddy 的个人技能上传入口同步到新沙箱：

```bash
python scripts/make-private-profile.py --config /opt/workbuddy-3p/config.json --output /tmp/account-private-profile.zip --embed-keys
```

上传得到的 ZIP 至自己的个人技能资产，切勿发布到技能市场、分享下载链接或提交 Git。这个包含 `SKILL.md`（无密钥）和 `workbuddy-3p.profile.json`（含私密配置）；平台上传预检会要求确认凭据风险。它不是加密的密钥保险库，账号和沙箱内有权限的进程可以读取。

插件只在本机配置和显式环境变量都未设置时，读取 `<config-dir>/skills/*/workbuddy-3p.profile.json`。文件必须带固定格式标记；多个配置包会报错以避免选错账户。用 `models_status` 确认实际读取路径和路由状态。更新配置需要重新上传私有包；沙箱本地开关只影响该沙箱。

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

对自托管或固定机器用法，可把配置放在 `/opt/workbuddy-3p/config.json` 或 `/etc/workbuddy-3p/config.json`，并用 `apiKeyFile` 指向本机权限为 `600` 的密钥文件。

脚本按以下顺序查找配置，使用第一个已存在的 JSON 对象：

1. `$WB3P_CONFIG_JSON`
2. `$WB3P_CONFIG`
3. `$CODEBUDDY_CONFIG_DIR/workbuddy-3p.json`；未设置 `CODEBUDDY_CONFIG_DIR` 时使用 `~/.codebuddy/workbuddy-3p.json`
4. `/etc/workbuddy-3p/config.json`
5. `/opt/workbuddy-3p/config.json`
6. `<plugin-root>/config.json`

JSON 损坏或文件不可读时会报错，不会跳过该来源继续查找。如果没有可用文件，则使用上一节的环境变量/插件选项配置方式。

## 官方 / 第三方开关

`resolveSwitch` 使用以下顺序：

| 优先级 | 来源 |
| --- | --- |
| 1 | `<config-dir>/workbuddy-3p.switch`（默认 `~/.codebuddy/workbuddy-3p.switch`） |
| 2 | 环境变量 `WB3P_ENABLED` |
| 3 | 插件选项 `ENABLED`（留空则继续向下判断） |
| 4 | 配置文件中的 `enabled` |
| 5 | 内置默认值：`third-party` |

开关取值为 `third-party` 和 `official`。切换方式：

- 在会话中调用 MCP 工具 `models_switch`，参数为 `{"mode":"official"}`、`{"mode":"third-party"}` 或 `{"mode":"default"}`。
- 使用插件 `commands` 目录中的 `/models-official`、`/models-third-party` 或 `/models-status`。
- 运行 `node scripts/sync-models.cjs --official`、`--third-party`、`--switch clear` 或 `--status`。
- `default` 和 `--switch clear` 会删除当前沙箱的开关文件，并回到较低优先级的来源。

切到 `official` 会移除插件写入的模型，恢复被隐藏的官方 `availableModels` 条目和被替换的用户模型；再切回 `third-party` 会重新路由。WorkBuddy 重新加载 `models.json` 后生效；菜单未变化时，新建会话。

## 配置参考

### 顶层字段

| 字段 | 行为 |
| --- | --- |
| `providers` | 必填非空对象，键为 provider 名称。 |
| `default` | 默认 provider 名称，必须存在；省略时使用第一个 provider。 |
| `mode` | 路由模式，默认 `same-name`。 |
| `routes` | 可选对象，将官方模型 ID 映射到路由目标。显式路由在推导路由和 `keepOfficial` 之后应用。 |
| `keepOfficial` | 可选官方 ID 数组，用于保留官方后端。它会从 preset/同名推导路由中移除这些 ID，但显式 `routes` 仍可再次路由它们。 |
| `models` | 可选的能力覆盖，键格式为 `"<provider>:<upstream-model>"`。 |
| `defaults` | 可选能力默认值；provider 没有 `defaults` 且模型没有 preset template 时使用。 |
| `enabled` | `official`/`false` 选择官方后端；`third-party`/`true` 启用路由。开关文件、`WB3P_ENABLED` 和插件选项 `ENABLED` 优先于它。 |

### Provider 字段

| 字段 | 行为 |
| --- | --- |
| `preset` | 可选内置 preset 名称，目前为 `bailian`。 |
| `baseUrl` | OpenAI 兼容 base URL。必须使用 HTTPS；仅 `localhost`、`127.0.0.1`、`::1` 或 provider 设置 `allowInsecureHttp: true` 时允许 HTTP。已经以 `/chat/completions` 结尾时直接使用，否则追加 `/chat/completions`。preset 也可以提供该值。 |
| `allowInsecureHttp` | 可选布尔值，允许非本机 HTTP `baseUrl`；默认 `false`。 |
| `label` | 生成的自定义模型显示名前缀：`<label> / <upstream-model>`。默认依次使用 preset 的 label、provider 名称。 |
| `apiKey` | 直接写入的 API key。为避免配置中保存密钥，优先使用环境变量或文件。 |
| `apiKeyEnv` | 保存密钥的环境变量名。 |
| `apiKeyFile` | 密钥文件，内容可以是 `{"apiKey":"..."}`，也可以是不含空白字符的原始 key。本机密钥文件建议使用 `600` 权限。 |
| `apiKeyUrl` | 返回 `{"apiKey":"..."}` 的私有 HTTPS 地址。非 HTTPS 地址会报错。 |
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

路由优先级为：preset/同名推导 → `keepOfficial` 移除 → 显式 `routes`。

### 路由目标

| 目标 | 含义 |
| --- | --- |
| `"official"` | 删除该路由，继续使用官方模型。 |
| `"<provider>:<model>"` | 将官方 ID 发给指定 provider 的指定上游模型。如果前缀不是已配置 provider，插件会输出 warning，并把整个字符串作为模型名发给默认 provider。 |
| `"<provider>"` | 将官方 ID 发给指定 provider 的同名模型。 |
| `"<model>"` | 将官方 ID 发给默认 provider 的指定模型。 |
| `{"provider":"p","model":"m"}` | 对象形式。省略 `provider` 或 `model` 时，分别回退到默认 provider 或官方 ID。 |

provider 形式的写法应使用已配置的 provider 名称。显式路由优先于推导路由和 `keepOfficial`。

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
9. 本插件上次为同名 provider 且同一规范化 chat-completions URL 写入的 key。不会跨 provider 借用 key。
10. 未找到。没有 key 的路由不会启用，对应模型继续使用官方后端。

`apiKeyUrl` 只接受 HTTPS，并要求响应 JSON 中存在 `apiKey` 字段。非 HTTPS 地址会报错。它应指向私有地址。URL 请求超时为 8 秒。

## 预设

没有默认 preset。只有通过 `PRESET` 或 `providers.<name>.preset` 选择时才会使用 preset。

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
node scripts/sync-models.cjs --official
node scripts/sync-models.cjs --third-party
node scripts/sync-models.cjs --switch clear
node scripts/sync-models.cjs --status
node scripts/sync-models.cjs --uninstall
node scripts/sync-models.cjs --quiet
```

| 选项 | 行为 |
| --- | --- |
| 无 | 应用当前配置并写入管理条目。 |
| `--dry-run` | 输出路由计划，不写文件。 |
| `--doctor` | 测试当前配置生成的计划（不是上次写入的文件），只返回 HTTP 状态和耗时，不返回上游响应体。不会输出 key。 |
| `--official` / `--third-party` | 为当前沙箱写入开关文件并同步。 |
| `--switch clear` | 删除当前沙箱的开关文件，并回到较低优先级的来源。 |
| `--status` | 显示解析后的开关、来源、激活状态和最近错误。 |
| `--uninstall` | 删除插件管理的模型条目和生成的 allowlist 条目，保留用户模型，并删除状态文件。 |
| `--quiet` | 不输出正常 JSON。错误仍写入 stderr，但退出码为 `0`。`SessionStart` hook 使用该模式。 |

stdio MCP server 提供：

| 工具 | 行为 |
| --- | --- |
| `models_status` | 显示当前开关、来源、最近一次同步摘要和最近错误。 |
| `models_switch` | 将当前沙箱切到 `official` 或 `third-party`，或用 `default` 清除开关。 |
| `models_resync` | 重新读取配置并改写 `models.json`。 |
| `models_doctor` | 测试当前配置生成的计划中的每个模型，并报告 HTTP 状态和耗时。 |

### 同步摘要

| 字段 | 含义 |
| --- | --- |
| `ok` | 只有没有 warning 时才为 `true`。 |
| `partial` | 规划阶段出现 warning，但仍有至少一个模型激活。 |
| `active` | 至少有一个第三方模型激活。 |
| `switch` | 解析后的模式：`official` 或 `third-party`。 |
| `switchFrom` | 来源：`switch file`、`WB3P_ENABLED`、`plugin option ENABLED`、`config` 或 `default`。 |
| `warnings` | 非致命问题，例如 provider 缺 key、上游模型 ID 冲突或用户模型被替换。 |

正常同步还会把配置错误写入 `~/.codebuddy/workbuddy-3p.last-error.json`，`models_status` 可见该错误。fail closed 的典型情况包括：`WB3P_CONFIG_JSON`、`ROUTES` 或配置文件 JSON 损坏，`mode` 非法，`providers` 不是非空对象；失败时不改动 `models.json`。

## 安全

- 不要把 API key 提交到仓库，也不要把它放在公开 URL。
- 在支持 POSIX 权限的平台上，对 `models.json`、`workbuddy-3p.json`、密钥文件和备份执行 `chmod 600`。同步脚本会以 `600` 写入 `models.json`；state、switch 和 last-error 文件的原子写入也请求 `600`。
- `baseUrl` 必须使用 HTTPS。仅 `localhost`、`127.0.0.1`、`::1` 或 `allowInsecureHttp: true` 时允许 HTTP。
- `apiKeyUrl` 必须使用 HTTPS。代码无法判断地址是否私有，所以应把它放在自己控制的私有主机上。
- 官方模型完成路由后，提示词和响应会发往配置的第三方 API。
- 已路由槽位在 WorkBuddy 菜单中仍可能显示官方模型名，实际请求发往第三方 provider。
- 第三方 API 的使用和计费由你承担。
- 这是非官方插件。WorkBuddy 或 CodeBuddy Code 更新后，模型文件格式或插件行为变化可能导致失效。

## 已知限制

- 云沙箱是否执行用户插件取决于平台同步。新会话才会生效；已经运行的会话可能需要新建会话。
- 路由后的官方槽位在菜单中仍显示官方名称。
- 在 `same-name` 模式下，如果路由到上游不存在的同名模型，会返回上游错误。可对当前配置生成的计划运行 `--doctor`。
- 同一上游模型 ID 只能属于一个 provider，与 URL 是否相同无关。冲突的路由或额外模型会被跳过并输出 warning；被跳过的官方 alias 会继续作为官方模型可选，除非另有路由处理它。
- 2026-09 实测的云沙箱（中国大陆区域）无法访问 `github.com`（TLS 被重置）：账号接口能添加 GitHub 来源，但沙箱内 `git clone` 会失败。GitHub 不可访问时使用维护者镜像 `https://cnb.cool/AlgernonYin/workbuddy-3P`（与 GitHub `main` 同步）。
- 新会话可能运行在全新的沙箱。平台会把插件选项同步到新沙箱时，优先使用插件选项 `API_KEY`，并用 `models_status` 确认；否则使用每个沙箱都能访问的私有 `apiKeyUrl`。不要依赖只存在于旧沙箱的环境变量或文件。

## 卸载与回滚

用 `models_switch`、`/models-official` 或 `--official` 切到 `official`，可在不卸载插件的情况下恢复插件管理的模型。若要移除插件，在 WorkBuddy 中卸载 `custom-api-models`，然后选择一种方式：

```bash
node scripts/sync-models.cjs --uninstall
```

或恢复第一次修改前的备份：

```text
~/.codebuddy/models.json.bak-workbuddy-3p
```

`--uninstall` 只删除 `workbuddy-3p.state.json` 中记录的条目，用户模型会保留。如果状态文件已经丢失，请恢复备份或手动删除生成的条目。

## 测试

在仓库根目录运行：

```bash
node --test tests/*.test.cjs
```

## License

MIT
