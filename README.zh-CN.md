# WorkBuddy 3P

[English](README.md)

**版本：** 3.0.0。已审查的运行时代码（`1f1a103`）在 Windows 和 Linux 通过 264/264 测试；官方 Native CLI 的真实 DeepSeek V4.1 `max` 请求成功，显式官方模式下旧第三方回环请求被 HTTP 410 拒绝。跨沙箱私有 global save/restore（`1.0.3`）和新 private asset 拉取均已验证。正式 3.0 插件的自动安装、云端 MCP Apps 面板、手机真机、长上下文行为和 refresh token 长期可移植性需独立验收；上述检查不保证已经完成部署。

WorkBuddy 3P 是面向云端 WorkBuddy / CodeBuddy Code 的非官方 MIT 插件市场。它让 WorkBuddy 使用你控制的 OpenAI Chat Completions 兼容 API。网页端和手机端共用云端沙箱机制，本说明中的流程不要求修改客户端或网页；手机真机尚未验收。路由后的槽位仍可能显示 WorkBuddy 模型名；能打开菜单并不证明实际流量已经走第三方。

插件只管理自己拥有的模型配置；不归它管理的既有用户模型保持不变。

## 两层设置

### 1. 供应商 + 模型

- 会话路由只支持 OpenAI Chat Completions 兼容供应商。没有协议选择器，插件也不会把其它传输协议翻译成 Chat Completions。
- 配置供应商名称、HTTPS `baseUrl` 和凭据引用（例如 `apiKeyEnv`）。不要把 API key 写进 README 示例、聊天或公开 profile。
- 供应商支持模型列表接口时，用 `GET /models` 发现模型。返回 404、405 或 501 时手动导入模型 ID。模型名不能证明 CTX、工具、图片或 reasoning 支持。
- 每个导入模型只声明你确实知道的内容：输入 CTX、输出上限、工具/图片支持、reasoning 支持和 `supportedEfforts`。未知值保持未知。不要猜 128K，也不要把输入上限当成供应商真实容量或已实现上下文压缩。
- 连接探针只在需要时显式执行。它会发送固定 marker，`max_tokens` 为 16，可能产生费用。`HTTP 200` 不是完成依据：只有响应完成且包含 marker 才算探针成功。探针只验证 endpoint/model，不验证宿主路由、协议翻译或当前会话真实流量。

### 2. 路由

路由必须显式：一个 WorkBuddy 官方槽位指向 `provider:model`，并可带单路由 effort。

```json
{
  "routes": {
    "official-slot": {
      "provider": "example",
      "model": "upstream-model-id",
      "effort": "high"
    }
  }
}
```

- 新配置使用显式路由，且不会自动生成任何路由。公开默认不选择任何供应商、厂商 preset、最高档或同名路由偏好，也不提供最高 effort 默认值。
- 旧 preset/推导模式和内置 preset 只作为旧配置的高级兼容路径；仅在旧配置明确写入时识别，不是公开默认或上手流程。
- 每条路由的 effort 必须来自该模型声明的 `supportedEfforts`。路由级 effort 优先于该模型默认 effort。不要从 `onlyReasoning` 推断可调 effort；公开账号流程不提供“全部最高”批量操作。

## 安装与首次连接

1. 将本仓库加入插件市场源（GitHub 或你信任的镜像），安装 `custom-api-models`。
2. 在 WorkBuddy 会话中打开 `/models-settings`，或让助手打开 WorkBuddy 3P 设置面板。
3. 要保存账号默认值，调用 `models_settings` 的 `{ "action": "connect" }`。它会返回 WorkBuddy 官方 CLI/网页登录地址；请在自己的账号中完成登录。
4. 调用 `models_settings` 的 `{ "action": "finish-connect" }`。它会验证账号和私有 profile。返回 `accountConnected: true`、`accountCommitted: false` 只表示授权成功；连接本身不切换来源，也不改变路由。
   账号面板仍显示已经存在的远端配置；仅连接状态不会把已发布的编辑基线隐藏或当作空配置覆盖。
5. 默认使用 `scope: "account"` 应用设置。只有明确需要当前沙箱高级覆盖时，才使用 `scope: "session"`。

## 账号默认值与同步

- 默认 `account` scope 下，面板视图和 `apply` 基于最近一次已发布的账号 baseline。普通账号标签修改只更新该 baseline，不会把 session 参数全球化。没有 baseline 时，account 视图从空配置开始；首次迁移必须显式传入 `importSession: true`，面板高级入口为“首次导入当前会话到账号（需明确保存）”。
- 切换 scope 会重新读取该 scope 的独立视图；未保存的其他 scope 草稿不会自动复制过来。
- 账号保存通过 WorkBuddy 私有资产/profile 通道完成。账号凭据是官方 Bearer access token + refresh token，不是运行模型 token。它们只属于本人侧的 mode-600 运行时缓存和私有 profile，绝不返回给面板、聊天或公开 URL。
- 首次私有凭据同步必须由账号所有者明确授权。运行时连接/缓存文件保持 gitignored，不得提交、发布或复制到公开 manifest。
- `apiKeyEnv`、`apiKeyFile`、`apiKeyUrl` 等仅存在于宿主的引用，会在账号 apply 时私有解析，并且只嵌入账号所有者授权的私有账号包；解析后的值不会返回面板，也不会写入公开视图。
- 不要手工合并 profile/config 文件，也不要使用手动 `mergeProfile` 流程。请使用 `models_settings` 的 status/apply（带最新 revision）以及账号 connect/finish-connect。
- 发布 preflight 可能要求确认类型。把准确的 `confirmationTypes` 展示给用户，并在用户明确确认前停止。preflight 不是本地成功，也不是账号成功。只能在用户确认后，用同一逻辑请求和 `confirmedConfirmationTypes` 重试；不要把确认当成上传完成。
- 只有上传后的读回状态为 `ready`，才报告 `accountCommitted: true`。`publicationPending` 和 `outcomeUnknown` 不是成功。先重新读取状态，再判断是否重试；不要自动再次上传。
- 上传结果未知或超时会持久记录 `retryBlocked: true`；用 `models_settings`/`models_status` 查清账号状态，不要再次提交同一上传。
- 服务端没有已验证的 compare-and-swap（CAS）。版本检查和 ready/readback 只能减少部分竞争，跨沙箱并发修改仍可能冲突或丢更新，不能把它描述成原子多文件事务。
- 如果远端账号资产缺失，保留 last-good 缓存路由；远端缺失不代表这些路由已被撤销。
- session apply 返回 `localSyncPending`、`stateUnavailable`、partial 或其它未完成状态时，一律视为 pending。先查状态，再决定是否重试；不要自动重发。
- 账号保存提交后，插件可能返回 `requiresHostRefresh` 或 `requiresModelReselection`。全局账号变更不是当前 host 的瞬时原生模型切换。已有 host 需要升级插件、刷新目录并重新选择模型。
- 活跃 MCP 会话每 45 秒轮询私有 profile revision，并在 revision 变化时同步账号默认值。同步是最终一致的，宿主休眠、回收或进程重启都可能延迟。
- 新沙箱默认采用已发布的账号配置。非空 SDK options 本身不构成显式 session 来源选择；仅连接账号也不会切换来源。已有旧 plugin 必须先升级，升级后重新选择模型。
- 只读卷不会因为改成账号 scope 就变为可写。`WB3P_CONFIG_JSON` 仍然是由所有者控制的只读来源。

## 设置面板、草稿模式与发现

- 原生 MCP Apps 面板通过宿主 bridge 直接应用设置。独立 HTML 产物只是草稿编辑器，不能直接写文件；它生成的 secret-free 指令包含 `scope`、`expectedRevision` 和结构化 patch，必须发回原 chat 后才可能应用。预览成功或复制成功不是保存回执。
- 公开流程不提供手工 merge 或“全部最高”教程。请按路由设置 effort，或在 `models_effort` 中显式设置模型/默认偏好。
- 无 bridge 时，独立 HTML 不能执行模型发现或连通探针。**拉取模型**和**测试模型连通性**按钮只能按草稿模式说明：先生成草稿，发回原 chat，在原会话应用 provider，再调用 `discover` / `probe`，或手动导入模型 ID 并声明能力。
- bridge 可用时，`discover` 调用供应商的 `GET /models`；不支持发现时仍可手动导入。`probe` 必须提供明确模型和 `allowBillable: true`。
- 不要把探针的 HTTP 200、面板预览、preflight 或本地写入当成账号成功。`runtimeVerified: false` 始终只代表磁盘/配置证据。

## 路由、凭据与参数优先级

- `3p` 是默认的高级参数优先级。适配器运行在目标云端沙箱内，只改变上游路由 model ID 和用户 effort，不转换请求内容、工具、图片、流式格式或 SSE 协议；供应商必须接受宿主使用的 Chat Completions 形状。
- 原供应商 key 保持私有。适配器从 mode-600 私有运行时状态读取，只在发往上游的 Authorization 请求中使用。官方模式对代理转发 fail closed，不发送第三方流量。
- `native` 会关闭 3P 强制参数，允许宿主/会话覆盖生效；当显式路由绑定需要 model ID 映射时，仍可能使用 adapter，因此不能一概承诺直连。
- 输入 CTX 和 effort 都是宿主元数据/偏好，不证明上游容量或实际请求行为。本文不声明手机真机验收，也不声明上下文压缩已验证。

实现细节见 [参数优先级与回环契约](docs/parameter-priority.md)。这是高级参考；公开面板仍以显式路由优先。

## 通用配置示例

示例使用保留域 `example.invalid` 和环境变量引用，仅作说明，不代表任何供应商或模型推荐。

```json
{
  "providers": {
    "example": {
      "label": "Example",
      "baseUrl": "https://api.example.invalid/v1",
      "apiKeyEnv": "MODEL_API_KEY",
      "extraModels": ["upstream-model-id"],
      "models": {
        "upstream-model-id": {
          "maxInputTokens": 32768,
          "maxOutputTokens": 4096,
          "supportsToolCall": true,
          "supportsImages": false,
          "supportsReasoning": true,
          "reasoning": {
            "supportedEfforts": ["low", "medium", "high"],
            "defaultEffort": "medium"
          }
        }
      }
    }
  },
  "mode": "explicit",
  "routes": {
    "official-slot": {
      "provider": "example",
      "model": "upstream-model-id",
      "effort": "high"
    }
  }
}
```

请为自己的模型手动填写 CTX；示例中的 `32768` 只是占位。在本地源配置中，`apiKeyEnv` 只是引用；账号 apply 时插件会私有解析，并只把结果嵌入账号所有者授权的私有账号包，绝不返回或公开发布。

## 常用 MCP 与 CLI 入口

MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `models_settings` | `status`、`panel`、`apply`、`discover`、`probe`、`connect`、`finish-connect`。`apply` 默认 `scope: "account"`；`scope: "session"` 只能作为显式高级覆盖。`connect`/`finish-connect` 只授权，不切换来源。 |
| `models_status` | 报告配置/磁盘状态、pending/retry-blocked 发布状态和 last-good 缓存状态。`runtimeVerified: false` 不证明真实流量。 |
| `models_switch` | 切换 `official`、`third-party` 或 `default`；`scope` 默认 `account`，`scope: "session"` 必须显式选择，作为本地覆盖；`{ "mode": "official", "scope": "session" }` 是 provider/preset/route/capability/cache 损坏时的本沙箱紧急回退。 |
| `models_resync` / `models_doctor` | 重新读取配置 / 对计划模型发小额请求。doctor 可能产生供应商费用。 |
| `models_effort` | 查看或设置 effort 偏好。`scope` 仍为 `default`/`model`/`all`；`saveScope` 默认 `account`，`saveScope: "session"` 必须显式选择。路由级 effort 优先于模型/default effort。 |

常用插件命令：

```bash
cd plugins/custom-api-models
node scripts/sync-models.cjs --dry-run
node scripts/sync-models.cjs --doctor
node scripts/sync-models.cjs --official
node scripts/sync-models.cjs --third-party
node scripts/sync-models.cjs --status
node scripts/sync-models.cjs --uninstall
```

当 provider、preset、route、capability 或 cache 状态损坏时，当前沙箱的紧急回退是 `models_switch` 的 `{ "mode": "official", "scope": "session" }` 或：

```bash
node scripts/sync-models.cjs --official --scope session
```

该回退不需要账号授权，不会全球化，也不会覆盖 ownership 不确定的模型。修复坏配置（bad configuration）后才能恢复 3P。

公开流程优先使用 `/models-settings`；窄操作使用 `/models-status`、`/models-official`、`/models-third-party` 或 `/models-effort`。

## 安全

- 不要把 API key、私有 profile、账号 token 或凭据文件提交、粘贴、打印或发布。
- 使用环境变量引用或私有文件。POSIX 私有运行时文件和备份应为 mode `600`，目录应为 `700`。Windows 的 `chmod` 不等于 NTFS ACL。
- 除 loopback 开发 endpoint 外必须使用 HTTPS。`baseUrl` 不得包含 userinfo、query 或 fragment。
- 账号同步凭据只能放在本人私有运行时和私有 profile 中。私有 profile 不是加密保险库；能读取账号/沙箱的人都能读取其内容。
- 首次私有凭据同步必须由所有者授权。运行时连接/缓存文件保持 gitignored，不得放入公开 manifest、聊天或报告。
- 槽位一旦路由，提示词和响应会发往配置的第三方供应商。路由和供应商费用由你承担。

## 已知限制

- 保存设置不是真实请求回执。通常需要宿主刷新目录、重新选择模型或新建会话。
- 账号 scope 更新的是新会话/账号侧默认值，不会瞬时切换当前 host 的原生已选模型。
- 服务端没有已验证 CAS；跨沙箱并发修改可能冲突或丢更新，revision 检查和 readback 只是保护措施，不是原子多文件事务。
- 上传未决或 pending 时处于 retry-blocked。先查 `models_settings`/`models_status`，不要自动重发。
- 远端 profile 缺失时保留 last-good 缓存路由，不会自动撤销。
- 只读卷仍然只读；插件不会把平台拥有的只读挂载改成可写。
- 模型列表发现可能不被支持。未知能力保持未知；插件不会凭空补 128K CTX、工具、图片或 effort 支持。
- 输入元数据是宿主侧输入上限，不是供应商容量或压缩证据。
- endpoint 探针只检查一个小 completion 请求。HTTP 200 且没有 marker 不算完成。
- 协议翻译不属于范围；请配置 OpenAI Chat Completions 兼容 endpoint。
- 手机真机和长上下文行为尚未实测。手机端只应视为共用云端机制，不能标为真机或长上下文验收成功。
- 已有旧 plugin 必须先升级并重新选择模型，才能消费当前账号 profile。

**2.5.1 历史兼容：** 旧官方目录 fallback 行为单独见 [官方切换兼容说明](docs/official-switch-compatibility.md)。它是历史兼容，不是当前公开默认。

## License

MIT
