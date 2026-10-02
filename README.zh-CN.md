# WorkBuddy 3P

[English](README.md)

**版本：** 2.4.0

WorkBuddy 3P 是一个非官方、MIT 许可的插件市场，面向云端 WorkBuddy / CodeBuddy Code。它让模型选择使用你自己的 OpenAI 兼容 API。网页端和手机端共用同一套云沙箱机制，因此不需要修改网页或客户端。

插件只改写自己管理的模型配置，ID 不由插件管理的用户模型会保留。

## 设置入口（2.4）

在会话中说 **“打开 WorkBuddy 3P 设置”**，或调用 `/models-settings`。支持 MCP Apps 的宿主会显示交互面板：

- 官方/第三方切换；选择模型后调整其实际支持的思考档位。
- 输入窗口可调小并恢复默认，不能扩大上游模型容量。
- 编辑 API 地址、Provider、额外模型和官方槽位路由；现有凭据保留，面板不回显密钥。
- “全部最高”逐模型选择最高合法档，不会把 Qwen 等模型硬设为 `max`。

工具入口为 `models_settings`（`status` / `panel` / `apply`）。直接保存只走标准 MCP Apps 宿主桥，不开公网端口、不改网页。宿主不渲染 MCP Apps 时，使用会话选项向导；HTML 产物是**草案编辑器**，需将生成的无密钥指令发回原会话，不能把预览或复制当成已保存。浏览器隔离夹具已验证桥接保存和手机尺寸布局；官方云端面板、新会话和手机真机仍须独立验收，不能把宿主源码含接口当成通过。

保存会检查配置 revision，创建私有备份，并在原路由锁内提交；旧面板不能覆盖新配置。普通写失败会回滚，检测到的外部并发变更不会在回滚时被覆盖。所有写者应遵守同一路由锁：对不协作的外部编辑器，最后比较到替换之间仍有极窄竞争窗口，不能保证 OS 级 compare-and-swap；这也不是多文件 crash-atomic 事务。账号私有 profile 的修改只改当前沙箱的本地副本，不会创建遮蔽它的 `workbuddy-3p.json`，也不会自动上传账号。沙箱独立状态仍需更新并上传私有 profile 才影响未来新沙箱。

固定宿主凭据使用私有文件/环境；新 Provider 表单只接受环境变量名，不接受 API Key 文本。更换地址须提供新引用或明确勾选复用原凭据，避免把原密钥偷偷发给新服务。密钥设置仍通过私有运行时或账号私有包完成。

模型档位请看[逐模型能力矩阵](docs/model-capabilities.md)，输入窗口请看[官方容量核对表](docs/model-windows.md)。2026-10-02 百炼实测：GLM-5/5.1 拒绝 `max`，最高可用是 `xhigh`；不能照抄泛化的 GLM 参数表。Kimi K3 已补齐 `low/high/max`。10 个旧型号的容量超报也已纠正。关闭思考仅在已验证的宿主路径开放；Kimi K3、DeepSeek V4.1 Flash 和 MiniMax M3 暂不提供未实现的关闭开关。`thinking_budget` 和 `ultracode` 不在本功能内。

**生效边界：** 思考档位保存为模型默认值，启用思考的模型仍遵从原生用户/会话强度覆盖。`off` 通过禁用该自定义槽位的 reasoning 能力实现，不修改全局设置；需在插件中开启或重置才恢复该槽位的思考能力。宿主缓存旧目录时仍需刷新模型目录再重选；单纯刷新页面、resync 或保存成功不是运行时证据。上下文设置保存到 `workbuddy-3p.context.json`，只改变宿主模型的输入限制；上游 API 没有通用的 `context_window` 参数。面板 revision 是进程内随机密钥 HMAC，不暴露确定性的凭据摘要；MCP 重启后旧面板/草案必须重新读取。

私有备份在 Linux 上使用目录 `700`、文件 `600`；Windows 的 `chmod` 不等于 NTFS ACL，请将配置目录放在仅自己的账户可访问的位置，不要同步/共享备份目录。

## 原理

- `SessionStart` hook 和 stdio MCP server 启动时都会运行 `sync-models.cjs`。同步、切换和卸载操作会用 `~/.codebuddy/workbuddy-3p.lock` 串行化。已有 `models.json` 保留 inode 原位写入，以兼容宿主的文件监视器；状态文件原子替换。普通写失败会回滚，但这不是跨文件 crash-atomic 事务，原位更新期间宿主仍可能看到短暂的读取窗口。
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
3. 云端会话使用下文的账号私有配置包；固定宿主可用 JSON 文件或环境变量。插件选项仅适用于能保存并同步它们的宿主。
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

没有设置 `BASE_URL`、`PRESET`，且没有本地配置或私有 profile 时，插件不做任何路由，也没有默认 preset。没有可解析的 API key 时，不会添加路由模型，也不会隐藏官方条目。

### 新沙箱与密钥

云端网页在当前实测版本没有可用的插件选项保存入口；自定义 MCP 保存也会报 `saveConfiguration` 未定义。新沙箱应以**账号私有技能包**为主方案，通过 WorkBuddy 的个人技能上传入口同步：

```bash
python scripts/make-private-profile.py --config /opt/workbuddy-3p/config.json --output /tmp/account-private-profile.zip --embed-keys
```

上传得到的 ZIP 至自己的个人技能资产，切勿发布到技能市场、分享下载链接或提交 Git。这个包含无密钥的 `SKILL.md` 和私密的 `workbuddy-3p.profile.json`；profile 含配置，并在使用 `--embed-keys` 时含 API key。平台上传预检会要求确认凭据风险。它不是加密的密钥保险库，账号和沙箱内有权限的进程可以读取。

插件只在本机配置和显式环境变量都未设置时，读取 `<config-dir>/skills/*/workbuddy-3p.profile.json`。profile 必须与 `SKILL.md` 位于同一技能目录，且其 YAML frontmatter 含 `name: workbuddy-3p-profile`；多个配置包会报错。schema 标记只用于防误配置，不是签名或身份认证。已安装技能和用户目录必须可信。

用 `models_status` 确认 `configuredMode` 和磁盘路由状态。重新上传私有包会改变未来沙箱的默认值，但不会覆盖已有本地开关；开关本身只作用于当前沙箱，不是账号全局。

### 使用配置文件

创建 `~/.codebuddy/workbuddy-3p.json`：

```json
{
  "default": "main",
  "mode": "same-name",
  "effort": {
    "default": "high",
    "models": {
      "main:qwen3.8-max": "xhigh"
    }
  },
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

第 1-3 行的高优先级来源选择 `official` 时，会绕过 provider/profile 配置，即使配置损坏也可使用；但移除/恢复插件条目仍依赖 `workbuddy-3p.state.json` 中的完整归属记录。state 损坏，或存在 2.2.2 归属标记但 state 丢失时，状态报 unknown 并拒绝改动。旧版没有标记的遗留条目无法自动识别；应恢复已知良好的备份，不要盲删。

开关是 per-sandbox，不跨账号全局。修改私有 profile 的 `enabled` 只改变尚无更高优先级本地开关的未来沙箱默认行为，不会强制覆盖已有本地开关。

开关取值为 `third-party` 和 `official`。切换方式：

- 在会话中调用 MCP 工具 `models_switch`，参数为 `{"mode":"official"}`、`{"mode":"third-party"}` 或 `{"mode":"default"}`。
- 使用插件 `commands` 目录中的 `/models-official`、`/models-third-party` 或 `/models-status`。
- 运行 `node scripts/sync-models.cjs --official`、`--third-party`、`--switch clear` 或 `--status`。
- `default` 和 `--switch clear` 会删除当前沙箱的开关文件，并回到较低优先级的来源。

切到 `official` 会移除插件写入的模型，恢复被隐藏的官方条目和被替换的用户模型；再切回 `third-party` 会重新路由。WorkBuddy 重新加载文件后，新请求才会采用这些路由，菜单名称可能不变。`models_status` 只报告配置意图和磁盘状态，不证明实际流量（`runtimeVerified: false`）。宿主未重新加载时，重新打开同一沙箱/会话；全新沙箱会采用账号默认值，需要再次设置所需开关。

## 配置参考

### 切换后必须重新选模型（云端宿主限制）

开关修改路由配置，不会修改云端会话内存中的当前模型。2026-09-30 实测：切到官方后不重新选模型，会出现 `Custom model custom-local:... has no endpoint url configured`。重复写配置不能消除旧选择。

网页和手机操作：先选择未路由的官方模型（默认 `Hy3`），调用 `models_switch` 或斜杠命令，再选择目标模型后发送下一条消息。如果菜单已选中同名项，先切到 `Hy3` 再选目标，确保触发重新选择。全新沙箱采用账号默认值，不继承旧沙箱的开关。工具返回 `requiresModelReselection: true`；插件不会偷偷修改网页，也不承诺无缝热切换。

全新沙箱的插件/私有配置初始化可能晚于模型选择；插件就绪后重新选择目标，不能假定启动后的第一条请求已走自定义 API。手机端共用云端配置，但尚未进行真机验收。

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
| `effort` | 可选的路由模型 reasoning effort 默认值。`effort.default` 是默认档位，`effort.models["<provider>:<upstream-model>"]` 设置单模型档位；沙箱本地覆盖优先于配置。 |

### Provider 字段

| 字段 | 行为 |
| --- | --- |
| `preset` | 可选内置 preset 名称，目前为 `bailian`。 |
| `baseUrl` | OpenAI 兼容 base URL。必须使用 HTTPS；仅 `localhost`、`127.0.0.1`、`::1` 或 provider 设置 `allowInsecureHttp: true` 时允许 HTTP。URL 含 userinfo、query 或 fragment 会报错。已经以 `/chat/completions` 结尾时直接使用，否则追加 `/chat/completions`。preset 也可以提供该值。 |
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

### reasoning effort 默认值

2.3.0 起支持路由模型的 reasoning effort 默认值。2.4 按模型校验 `minimal`、`low`、`medium`、`high`、`xhigh`、`max`，并在受支持的路径提供 `on/off` 思考开关；并非每个模型都支持这些值。`ultracode` 和 token 预算不属于此功能。

在顶层 `effort` 对象中配置默认值：

```json
{
  "effort": {
    "default": "high",
    "models": {
      "main:qwen3.8-max": "xhigh"
    }
  }
}
```

沙箱本地覆盖文件为 `~/.codebuddy/workbuddy-3p.effort.json`，含 `version: 1`，只保存 effort 选择，不保存 API key。生效优先级为：

1. 本地 per-model 覆盖
2. 本地 default
3. 配置中的 per-model
4. 配置中的 default
5. 模型原默认值

`models_effort` 支持 `{ action: "set" | "reset", scope: "default" | "model" | "all", level?, model? }` 和 `{ action: "status", model? }`。`status` 只接受可选 `model`，不接受 `scope` 或 `level`。未指定模型时，`set` 默认使用 `scope: "default"`。指定单模型时，传 `scope: "model"` 和 `model: "<provider>:<upstream-model>"`；唯一官方别名或 upstream ID 也可能解析成功，但建议始终使用完整的 `provider:upstream-model`。`reset` 配合 `scope: "all"` 会删除所有本地覆盖；配合 `scope: "model"` 会删除该模型的本地覆盖，再回落到剩余来源，但不保证回到 preset 原值。

请求的档位会按模型能力元数据校验。默认/全局档位会跳过不支持的模型并列明；单模型档位不支持时会拒绝。本文不提供固定的 provider 支持表，因为支持情况取决于模型和配置；应使用 `models_effort` status 查看当前配置集，不要据此推断整个 provider 的能力。

这些值是模型默认值，原生会话或用户侧 `reasoningEffort` 仍可优先覆盖。官方模式下，插件不修改宿主原生的全局 `reasoningEffort` 或官方参数；设置会以 deferred 配置保存，切回第三方后再应用。status 只表示配置/磁盘状态，不证明实际请求已使用该档位（`runtimeVerified: false`）。宿主重新加载后，可能还需要重新选择模型。

本地 effort 设置只持久化到当前沙箱，不会自动同步到账号。若要让新沙箱使用相同默认值，应把 `effort` 放入账号私有 profile 的 `config`，再打包并上传该 profile；不要把 API key 或 profile 放到公网。手机端共用云端机制，但尚未进行真机验收。

**先刷新宿主模型目录，再重新选模型。** 2026-10-01 云端网页实测发现：保存 `xhigh`、执行 `models_resync` 并重选模型后，宿主仍发出 `medium`，表现与宿主模型目录中的旧元数据/缓存状态一致。同一会话经官方宿主模型目录刷新并重选后，实际发出 `xhigh`，百炼返回 HTTP 200 和完整回复。插件 MCP 工具不能强制执行该宿主刷新；需使用宿主官方模型目录刷新/重载入口，再重选模型，宿主要求时再重开。单纯重开网页是否等价尚未验证。不要以为在网页聊天里输入 `/reload-plugins` 就执行了原生命令，也不能仅凭磁盘状态或正常回复判断强度已生效。手机仍未真机验收。

工具返回的 `profileConfigPatch.effort` 不含密钥，可用于**替换**私有配置中完整的 `effort` 对象；不要与旧 `effort.models` 逐字段合并，否则可能改变覆盖优先级。

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
9. 上一次同步为同名 provider 且同一规范化 chat-completions URL 保存的 key。不会跨 provider 借用 key。
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

`glm-5v-turbo` 和 `glm-5.3-flash` 被列为不支持的模型，默认保留官方后端。下面的手动映射只是示例，不设为公共默认；只有接受模型替换时才使用：

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
node scripts/sync-models.cjs --effort-status
node scripts/sync-models.cjs --effort-status --model main:qwen3.8-max
node scripts/sync-models.cjs --effort high
node scripts/sync-models.cjs --effort xhigh --model main:qwen3.8-max
node scripts/sync-models.cjs --effort-reset --model main:qwen3.8-max
node scripts/sync-models.cjs --effort-reset --all
```

| 选项 | 行为 |
| --- | --- |
| 无 | 应用当前配置并写入管理条目。 |
| `--dry-run` | 输出路由计划，不写文件。 |
| `--doctor` | `official` 模式直接跳过，不会请求第三方；高优先级 `official` 开关甚至不会加载损坏的 provider/profile 配置。`third-party` 模式会对计划中的每个模型发送一次小额计费测试请求，可能消耗额度。只返回 HTTP 状态和耗时，不返回响应体或 key。 |
| `--official` / `--third-party` | 为当前沙箱写入开关文件并同步。 |
| `--switch clear` | 删除当前沙箱的开关文件，并回到较低优先级的来源。 |
| `--status` | 返回 `configuredMode`、来源、`modelsJsonActive`/`active`（磁盘条目）、`runtimeVerified`（恒为 `false`）和最近错误；provider endpoint 只报告 `host`。 |
| `--uninstall` | 删除归属记录和生成的 allowlist 条目，保留其它用户模型。state 损坏，或存在归属标记但 state 丢失时拒绝改动。 |
| `--quiet` | 不输出正常 JSON，错误仍写入 stderr。思考强度命令失败时保留非零退出码；其它命令按 `SessionStart` hook 的兼容行为返回 `0`。 |
| `--effort-status [--model ...]` | 返回全部已配置模型的 effort 配置和实际来源，或只返回指定模型。这里只是配置/磁盘状态，不证明实际请求已采用该值（`runtimeVerified: false`）。 |
| `--effort <level> [--model ...]` | 设置本地默认档位；带 `--model` 时设置本地单模型覆盖。支持 `minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`；对不支持的默认/全局目标会跳过并列明，对不支持的单个模型会拒绝。 |
| `--effort-reset [--model ... \| --all]` | 删除指定模型的本地覆盖；带 `--all` 时删除所有本地覆盖。单模型重置会依次回落到本地默认、配置 per-model、配置 default 和模型原默认值，不保证回到 preset 原值。 |

stdio MCP server 提供：

| 工具 | 行为 |
| --- | --- |
| `models_status` | 返回 `configuredMode`、来源、磁盘 `modelsJsonActive`/`active`、`runtimeVerified`（恒为 `false`）、管理条目数和最近错误；provider endpoint 只报告 `host`。 |
| `models_switch` | 将当前沙箱切到 `official` 或 `third-party`，或用 `default` 清除开关。 |
| `models_resync` | 重新读取配置并改写 `models.json`。 |
| `models_doctor` | `official` 模式跳过且不请求第三方；`third-party` 模式对计划中的每个模型发送一次小额计费请求，并报告 HTTP 状态和耗时。 |
| `models_effort` | 查看或修改 reasoning effort 默认值。参数为 `{action:"set"\|"reset", scope:"default"\|"model"\|"all", level?, model?}` 或 `{action:"status", model?}`。未指定模型时，`set` 默认使用 `scope:"default"`。指定单模型时使用 `provider:upstream-model`；唯一官方别名或 upstream ID 也可能解析，但建议使用完整写法。 |

可用插件 `commands` 目录中的 `/models-effort` 调用 `models_effort`。status 指令不得猜测当前选中的模型：应使用用户明确给出的模型，或先列出已配置能力。set/reset 必须严格按用户明确给出的模型和档位执行，不要替用户选择档位。

### 同步摘要

| 字段 | 含义 |
| --- | --- |
| `ok` | 只有没有 warning 时才为 `true`。 |
| `partial` | 规划阶段出现 warning，但仍有至少一个模型激活。 |
| `active` | 当前计划或磁盘中至少有一个第三方模型条目（取决于命令）；不代表真实流量已验证。 |
| `switch` | 解析后的模式：`official` 或 `third-party`。 |
| `switchFrom` | 来源：`switch file`、`WB3P_ENABLED`、`plugin option ENABLED`、`config` 或 `default`。 |
| `warnings` | 非致命问题，例如 provider 缺 key、上游模型 ID 冲突或用户模型被替换。 |

`models_status` 只报告配置和磁盘状态：`configuredMode` 是配置意图，`modelsJsonActive`/`active` 是磁盘 `models.json` 中的第三方条目，`runtimeVerified` 恒为 `false`。不能凭此声称真实流量已切换。

正常同步还会把配置错误写入 `~/.codebuddy/workbuddy-3p.last-error.json`，`models_status` 可见该错误。配置校验失败会拒绝本次更新并保留 last-good `models.json`，不会自动切到 `official`。典型情况包括：`WB3P_CONFIG_JSON`、`ROUTES` 或配置文件 JSON 损坏，`mode` 非法，`providers` 不是非空对象。高优先级 `official` 开关可按上文绕过损坏配置，但仍依赖完整 ownership state。

## 安全

- 不要把 API key 提交到仓库，也不要把它放在公开 URL。
- 在支持 POSIX 权限的平台上，对 `models.json`、`workbuddy-3p.json`、密钥文件和备份执行 `chmod 600`。同步脚本会以 `600` 写入 `models.json`；state、switch 和 last-error 文件的原子写入也请求 `600`。
- `baseUrl` 必须使用 HTTPS。仅 `localhost`、`127.0.0.1`、`::1` 或 `allowInsecureHttp: true` 时允许 HTTP。URL 不得含 userinfo、query 或 fragment。
- `apiKeyUrl` 必须使用 HTTPS。代码无法判断地址是否私有，所以应把它放在自己控制的私有主机上。
- `models_status` 和公开同步摘要不会返回完整 `baseUrl`；需要报告 endpoint 时只返回 `host`。
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
- 新会话可能运行在全新的沙箱。实测云端网页无法保存插件选项，自定义 MCP 保存也会失败；应以账号私有技能包为主方案。它不是加密保险库：`SKILL.md` 无 key，`workbuddy-3p.profile.json` 可能含配置和嵌入 key。已安装技能和用户目录必须可信。

- `models_status` 不能证明真实流量；`runtimeVerified` 恒为 `false`。需要确认实际路由时，应做真实请求或观察宿主行为。

## 卸载与回滚

用 `models_switch`、`/models-official` 或 `--official` 切到 `official`，可在不卸载插件的情况下恢复插件管理的模型。若要移除插件，在 WorkBuddy 中卸载 `custom-api-models`，然后选择一种方式：

```bash
node scripts/sync-models.cjs --uninstall
```

或恢复第一次修改前的备份：

```text
~/.codebuddy/models.json.bak-workbuddy-3p
```

`--uninstall` 只删除 `workbuddy-3p.state.json` 中记录的条目，其它用户模型会保留。state 损坏，或存在 2.2.2 归属标记但 state 丢失时拒绝改动。旧版没有标记的遗留条目无法自动识别；请恢复已知良好的备份，不要盲删。

## 测试

在仓库根目录运行：

```bash
node --test tests/*.test.cjs
```

## License

MIT
