# Bailian preset model window matrix

本文件核对 `plugins/custom-api-models/presets/bailian.json` 中 20 个上游模型的 context window、input limit 与 output budget。它只记录公开模型元数据，不发模型请求，不读取账号私有数据。

## 语义边界

- `total context`：模型总上下文窗口，官方公开接口字段为 `contextWindow`。
- `input limit`：单次请求最大输入 token，官方字段为 `maxInputTokens`；设置面板用它限制可调输入窗口。
- `reasoning input limit`：思考模式下的输入上限，官方字段为 `reasoningMaxInputTokens`；没有该字段的模型不额外推断。
- `output budget`：preset 允许配置的最大输出预算，优先取官方 `maxOutputTokens`。它不是“厂商绝对最大输出”的同义词；正文会分别标注保守预算与官方最大值。
- preset/LanguageModel 不新增原始 `contextWindow` 数值字段，避免宿主已有的 `contextWindow` 语义与 total context 混用。UI 继续显示“最大输入窗口”。

## 官方来源

公开模型列表接口（百炼模型广场调用；未登录、无凭据，响应含 `scope: PUBLIC`）：

<https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels>

接口 `modelInfo` 使用以下字段：

```json
{"contextWindow":0,"maxInputTokens":0,"maxOutputTokens":0,
 "reasoningMaxInputTokens":0,"reasoningMaxOutputTokens":0}
```

模型详情页 URL 形态：

`https://bailian.console.aliyun.com/cn-beijing/model/market/detail/<URL-encoded-model>`

官方文档：

- DeepSeek：<https://help.aliyun.com/zh/model-studio/deepseek-api>
- GLM：<https://help.aliyun.com/zh/model-studio/glm>
- Kimi：<https://help.aliyun.com/zh/model-studio/kimi-api>
- Kimi 直供：<https://docs.bailian.console.aliyun.com/zh/model-studio/kimi-api-by-moonshot-ai>
- MiniMax：<https://help.aliyun.com/zh/model-studio/minimax-api>
- MiniMax 直供：<https://docs.bailian.console.aliyun.com/zh/model-studio/minimax-api-by-minimax>
- Qwen：<https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions>

## 精确值矩阵

下表除特别标注外，均来自公开 `listFoundationModels` 响应的 `modelInfo`。数值单位为 token。

| 上游模型 | total context | input limit | reasoning input limit | official max output | preset output budget |
|---|---:|---:|---:|---:|---:|
| `deepseek-v4.1-flash` | 1,000,000 | 1,000,000 | 1,000,000 | 393,216 | 393,216 |
| `deepseek-v4-pro` | 1,000,000 | 1,000,000 | 未单独声明 | 393,216 | 393,216 |
| `deepseek-v4-flash` | 1,000,000 | 1,000,000 | 未单独声明 | 393,216 | 393,216 |
| `deepseek-v3.2` | 131,072 | 98,304 | 未单独声明 | 65,536 | 65,536 |
| `glm-5.3` | 1,000,000 | 1,048,576 | 1,048,576 | 131,072 | 131,072 |
| `glm-5.2` | 1,000,000 | 1,048,576 | 1,048,576 | 131,072 | 131,072 |
| `glm-5.1` | 202,745 | 202,745 | 169,984 | 131,072 | 131,072 |
| `glm-5` | 202,752 | 169,984 | 169,984 | 16,384 | 16,384 |
| `glm-4.7` | 202,752 | 169,984 | 未单独声明 | 16,384 | 16,384 |
| `kimi-k3` | 1,000,000 | 1,048,576 | 1,048,576 | 1,048,576 | 131,072 |
| `kimi/kimi-k2.8-preview` | 1,048,576 | 1,048,576 | 1,048,576 | 1,048,576 | 131,072 |
| `kimi-k2.7-code` | 262,144 | 229,376 | 未单独声明 | 16,384 | 16,384 |
| `kimi-k2.6` | 262,144 | 229,376 | 未单独声明 | 16,384 | 16,384 |
| `kimi-k2.5` | 262,144 | 229,376 | 未单独声明 | 16,384 | 16,384 |
| `kimi-k2-thinking` | 262,144 | 229,376 | 未单独声明 | 16,384 | 16,384 |
| `MiniMax/MiniMax-M3` | 1,000,000 | 1,048,576 | 1,048,576 | UNKNOWN | 128,000 |
| `MiniMax/MiniMax-M2.7` | 204,800 | 204,800 | 204,800 | 131,072 | 131,072 |
| `MiniMax/MiniMax-M2.5` | 204,800 | 204,800 | 204,800 | 131,072 | 131,072 |
| `qwen3.8-max` | 1,000,000 | 991,808 | 983,616 | 131,072 | 131,072 |
| `qwen3.8-flash` | 1,000,000 | 991,808 | 983,616 | 131,072 | 131,072 |

## 保守预算说明

- `deepseek-v3.2`：旧模板给了 1,000,000 / 393,216，公开接口精确值为 131,072 total context、98,304 input、65,536 output；preset 使用 98,304 / 65,536。
- `glm-5.1`：普通 input 为 202,745，思考 input 为 169,984；preset 使用较低的 169,984，保证一个 `maxInputTokens` 字段在思考模式下也不超报。
- `glm-5`、`glm-4.7`：input 为 169,984，output 为 16,384；preset 使用这两个值。`glm-5` 的 max reasoning tokens 为 32,768，不改变 output budget。
- `kimi-k2.7-code`、`kimi-k2.6`、`kimi-k2.5`、`kimi-k2-thinking`：input 229,376、output 16,384；preset 使用这两个值。
- `MiniMax/MiniMax-M2.7`、`MiniMax/MiniMax-M2.5`：input 204,800、output 131,072；preset 使用真实官方值。
- `kimi-k3`、`kimi/kimi-k2.8-preview`：input 1,048,576 保留；官方 max output 为 1,048,576，但 preset 默认 output 预算保持 131,072。这里是配置预算与厂商最大值的区别，不把 131,072 写成官方最大输出。
- `MiniMax/MiniMax-M3`：input 1,048,576 保留；公开模型页的“最大输出长度”显示 `-`，接口没有 `maxOutputTokens`。preset 的 128,000 只作为旧版保守配置预算，官方最大输出为 **UNKNOWN**。
- `qwen3.8-max`、`qwen3.8-flash`：普通 input 为 991,808，思考 input 为 983,616；preset 使用 983,616，属于保守值。如果未来要放开普通模式输入上限，必须同时保留思考模式的 983,616 约束。
- `glm-5.3`、`glm-5.2`：total context 为 1,000,000，input limit 为 1,048,576，两者不是同一字段；preset 只使用 `maxInputTokens`，不新增 `contextWindow`。
- `deepseek-v4.1-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`：public 接口的 context/input/output 与 preset 一致。

## 官方短引用

- GLM 文档：`glm-5.3、glm-5.2 和 glm-5.2-fast-preview 是 GLM 系列最新模型，上下文长度 1M。`
- DeepSeek 文档：`模型上下文长度与价格信息请参见百炼控制台。`
- DeepSeek V3.2 参数表：`max_tokens 65,536`、`thinking_budget 32,768`。
- Kimi 文档：`模型上下文长度与价格信息请参见百炼控制台。`
- MiniMax 文档：`模型上下文长度与价格信息请参见百炼控制台。`
- 公开模型页短原文示例：
  - `deepseek-v3.2`：`最大输入长度 96K；上下文长度 128K；最大输出长度 64K`
  - `glm-5.1`：`最大输入长度 202K；最大输入长度(思考模式下) 166K；上下文长度 202K；最大输出长度 128K`
  - `kimi-k2.5`：`最大输入长度 224K；上下文长度 256K；最大输出长度 16K`
  - `MiniMax/MiniMax-M2.5`：`最大输入长度 200K；上下文长度 200K；最大输出长度 128K`
  - `MiniMax/MiniMax-M3`：`最大输入长度 1M；上下文长度 1M；最大输出长度 -`
  - `qwen3.8-max`：`最大输入长度 991K；最大输入长度(思考模式下) 983K；上下文长度 1M；最大输出长度 128K`

## UNKNOWN

- `MiniMax/MiniMax-M3` 官方最大输出：公开模型页显示 `-`，接口没有 `maxOutputTokens`；preset 的 128,000 不是官方上限声明。
- 未观察到 `deepseek-v4-pro`、`deepseek-v4-flash` 的独立 reasoning input/output 字段；本文不推测其思考模式额外上限。
- `kimi-k2.7-code`、`kimi-k2.6`、`kimi-k2.5`、`kimi-k2-thinking` 未观察到独立 reasoning input 字段；本文按官方 `maxInputTokens` 记录。