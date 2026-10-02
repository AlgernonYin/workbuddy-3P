# Bailian preset model capability matrix

本文件核对 `plugins/custom-api-models/presets/bailian.json` 的思考强度/开关声明。范围是 preset 中的 20 个上游模型和 24 个 WorkBuddy 官方路由别名；`glm-5v-turbo`、`glm-5.3-flash` 明确列为 unsupported。

本文分成两个维度：一是厂商/百炼的公开能力与正确 protocol 声明；二是 Native 2.161.1 宿主当前是否真正把该声明送到 outbound payload。宿主未生效不改变 preset 中按实际端点规范写下的声明。文档本身不再发送模型请求，但会优先记录已有 VM 实际请求证据；未重测的组合仍以 `runtimeVerified` 为准。

## 端点差异

- preset 的 `baseUrl` 是百炼 OpenAI 兼容端点，故首先采用百炼 `enable_thinking`、`reasoning_effort`、`thinking_budget` 的约束，而非直接照抄厂商原生 `thinking` 对象。
- DeepSeek V4、GLM effort、Kimi K3 在百炼端点使用顶层 `enable_thinking` 加 `reasoning_effort`。
- MiniMax M3 在百炼端点不使用 `enable_thinking`，而使用 `thinking` 对象。厂商支持 `adaptive`/`disabled`，但当前宿主的通用 `thinkingFormat` 没有 `adaptive` 映射，故 preset 暂不能声称可关闭。
- 仅开关模型采用 `supportedEfforts=[]`、`defaultEffort='high'` 表示默认开启；`high` 这里不是可调档位。`canDisableThinking=true`、`thinkingLevelMap.off='none'`、`thinkingLevelMap.high='high'` 表示 off/on 二元开关。
- 上述 off/on 是按百炼协议写下的正确声明；宿主是否真的关闭必须逐模型看 Native payload 与上游响应。DeepSeek V3.2 已由 `supportsReasoning=false` 得到 `enable_thinking=false`，其他模型不能套用“全部成功”或“全部失败”的结论。

## VM 实际请求修正（优先于泛化参数表）

在本次 preset 修正前，2026-10-02 在 VM 对百炼 20 个模型最高声明档直接请求：18 个 HTTP 200，`glm-5.1` 与 `glm-5` 的 `max` 返回 HTTP 400。随后对两者做 8 个定点请求，确认 `max` 拒绝，而 `high`、`low` 和不传 effort 均为 HTTP 200 并产生 stop marker。又补 6 个请求，两个模型的 `xhigh/medium/minimal` 均 HTTP 200 + stop + WB3P_OK；至此两模型五个可调档位已全覆盖，`max` 仍拒绝。

供应商原始错误枚举：“`'reasoning_effort' must be one of: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'`”。因此 `glm-5.1`/`glm-5` 不能再继承 `glm-5.2` 的 `max` 声明；preset 改为五档 literal 映射。错误枚举给出了五档，但最终可用性以实际请求为准：本次补测已确认 `xhigh/medium/minimal` 均 HTTP 200，连同此前 `low/high/no-effort` 成功，五项档位全部实测通过；`max` 仍拒绝。

## 官方短引用

### 百炼 OpenAI 兼容参数页

来源：<https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions>。

- `enable_thinking`：“适用于 Qwen3.7、Qwen3.6、Qwen3.5、Qwen3、Qwen3-Omni-Flash、Qwen3-VL 模型，以及 DeepSeek-V4.1-Flash、DeepSeek-V4-Pro/V4-Flash 系列、DeepSeek-V3.2/V3.2-exp/V3.1 系列、Kimi-K2.7-code、Kimi-K2.6/K2.5 系列、GLM 系列。”
- `reasoning_effort`：DeepSeek V4、GLM 系列与 `kimi/kimi-k3` 默认值为 `high`；可选 `high`、`max`，`low`/`medium` 映射为 `high`，`xhigh` 映射为 `max`。
  该泛化表把 GLM 5.1/5 与 5.2 并列，但 VM 实际端点已拒绝 5.1/5 的 `max`；本文按实际证据将 5.1/5 与 5.2 分开。
- `glm-5.3`、`ZHIPU/GLM-5.3`、`kimi-k3` 阿里云直供：默认值为 `max`；可选 `max`、`high`、`low`。`glm-5.3` 始终开启思考，`enable_thinking` 仅支持 `true`；`kimi-k3` 支持 `enable_thinking:false` 关闭思考。
- `qwen3.8-max`、`qwen3.8-flash`：默认值为 `xhigh`；直接可选 `xhigh`、`medium`、`low`。`max`/`high` 映射为 `xhigh`，`none` 映射为 `enable_thinking:false`。`reasoning_effort` 与 `thinking_budget` 不能同时设置。
- `thinking_budget`：适用于 Qwen3.8、GLM 阿里云直供、Kimi 阿里云直供系列，其中 `kimi-k3` 不支持；`glm-5.3` 忽略该参数，`glm-5.2` 传入时思考长度由该参数单独控制。
- MiniMax：“稀宇科技直供的 MiniMax/MiniMax-M3 不使用此参数，请使用 thinking 参数。thinking.type 可选值：adaptive、disabled。”

### 厂商原生接口

- Kimi K3 官方短引用：“`kimi-k3` 始终进行推理，使用顶层 `reasoning_effort`（支持 `low`、`high`、`max`，默认 `max`）。” 来源：<https://platform.moonshot.cn/docs/api/chat.md>。
- Kimi K2.x：`thinking.type` 为 `enabled|disabled`；`kimi-k2.7-code` 始终为 `enabled`，不可关闭。来源同上。
- GLM-5.3 官方短引用：“支持三个思考强度级别：`low`、`high` 和 `max`，并不再支持禁用思考功能”；`reasoning_effort` 默认 `max`。来源：<https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md>。
- GLM 总览：`reasoning_effort` 仅 GLM-5.2 及以上支持；GLM-4.7 是开关/轮级思考，不应声明 effort。来源：<https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md>。
- DeepSeek 原生：`reasoning_effort` 取值 `none|low|high|max`，默认 `high`；`minimal→low`，`medium/xhigh→high`。来源：<https://api-docs.deepseek.com/api/create-chat-completion>。
- MiniMax OpenAPI：M3 的 `thinking.type` 为 `adaptive|disabled`；`reasoning_effort` 仅对 M3.1-Flash-Preview 生效，其他模型忽略。来源：<https://platform.minimaxi.com/docs/api-reference/text/api/openai-chat-openai.json>。

## 模型矩阵

| 上游模型 | WorkBuddy aliases | preset 当前实现 | 官方能力与默认 | 状态/缺口 |
|---|---|---|---|---|
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash` | `low/high/max`，默认 `high`，可关闭，`qwen` + effort | 百炼 `low/high/max`，默认 `high`；`enable_thinking` + `reasoning_effort` | 档位正确；未运行验证 |
| `deepseek-v4-pro` | `deepseek-v4-pro` | 同 V4.1-Flash | 同百炼 V4 组 | 档位正确；未运行验证 |
| `deepseek-v4-flash` | `deepseek-v4-flash` | 同 V4.1-Flash | 同百炼 V4 组 | 档位正确；未运行验证 |
| `deepseek-v3.2` | `deepseek-v3-2-volc` | `[]`，on 表示开启，可关闭，`qwen` 无 effort | 百炼列入 `enable_thinking` 开关组；未列入 `reasoning_effort` | 仅开关；off 已实测 Native payload `enable_thinking=false`（主代理通过 `supportsReasoning=false`）；其余路径未重测 |
| `glm-5.3` | `glm-5.3`、`glm-5.3-flashx` | `low/high/max`，默认 `max`，强制思考 | 百炼/智谱：`low/high/max`，默认 `max`，`enable_thinking:true` | 档位、默认值正确；未运行验证 |
| `glm-5.2` | `glm-5.2` | `low/medium/high/xhigh/max`，默认 `high`，可关闭；`low/medium→high`，`xhigh→max` | 百炼 `high/max`，默认 `high`，兼容 `low/medium/xhigh`；可选 `thinking_budget` | VM 最高声明档实测通过；协议映射保留；未做逐档开关验证 |
| `glm-5.1` | `glm-5.1` | `minimal/low/medium/high/xhigh`，默认 `high`，可关闭；各档 literal 映射，`max:null` | VM 百炼：`max` HTTP400；`high/low/no-effort` 与 `xhigh/medium/minimal` 均 HTTP200；后三档为 stop + WB3P_OK | 五档已全覆盖；Native xhigh capture 通过；其余字段未重测 |
| `glm-5` | `glm-5.0`、`glm-5.0-turbo` | 同 `glm-5.1` | VM 百炼：`max` HTTP400；`high/low/no-effort` 与 `xhigh/medium/minimal` 均 HTTP200；后三档为 stop + WB3P_OK | 五档已全覆盖；Native xhigh capture 通过；其余字段未重测 |
| `glm-4.7` | `glm-4.7`、`glm-4.6` | `[]`，on 表示开启，可关闭，`qwen` 无 effort | `enable_thinking`/`thinking` 开关；无 effort | 仅开关；`glm-4.6` 实际路由到 4.7；未运行验证 |
| `kimi-k3` | `kimi-k3-1`、`kimi-k3-2`、`kimi-k3` | `low/high/max`，默认 `max`，可关闭 | 百炼直供 K3：`low/high/max`，默认 `max`，允许 `enable_thinking:false`；Moonshot 原生也称 K3 始终推理 | 档位沿用百炼；Native OpenAI 路径无关闭字段，UI off 先禁用；模型可关性待一对一真实请求 |
| `kimi/kimi-k2.8-preview` | `kimi-k2.8-preview` | `[]`，强制思考，无档位 | 当前公开 Moonshot 索引和百炼参数表未给出该模型定义 | **UNKNOWN**：保持现状，不推断开关/effort；未运行验证 |
| `kimi-k2.7-code` | `kimi-k2.7` | `[]`，强制思考，无档位 | Moonshot：始终 enabled、不可关闭、无 effort；百炼将其列为仅思考模型 | 档位/开关语义正确；未运行验证 |
| `kimi-k2.6` | `kimi-k2.6` | `[]`，on 表示开启，可关闭，`qwen` 无 effort | Moonshot/Bailian：`enabled/disabled` 或 `enable_thinking`；无 effort；百炼支持 `thinking_budget` | 仅开关；未运行验证 |
| `kimi-k2.5` | `kimi-k2.5` | 同 K2.6 | 百炼：`enable_thinking` 开关；无 effort；支持 `thinking_budget` | 仅开关；未运行验证 |
| `kimi-k2-thinking` | `kimi-k2-thinking` | `[]`，强制思考，无档位 | 公开材料仅能确认模型名称/价格，未找到当前开关/effort 规范 | **UNKNOWN**：保持现状，不推断；未运行验证 |
| `MiniMax/MiniMax-M3` | `minimax-m3`、`minimax-m3-pay` | `[]`，强制思考，无档位 | 供应商支持 `thinking.type=adaptive|disabled`；无 effort | **宿主协议未实现 adaptive/disabled**；不能把“当前强制思考”表述成供应商不能关闭；未运行验证 |
| `MiniMax/MiniMax-M2.7` | `minimax-m2.7` | `[]`，强制思考，无档位 | M2.x thinking 不可关闭，`reasoning_effort` 被忽略 | 正确；未运行验证 |
| `MiniMax/MiniMax-M2.5` | `minimax-m2.5` | `[]`，强制思考，无档位 | 同 M2.x | 正确；未运行验证 |
| `qwen3.8-max` | extra model，无官方 route | `low/medium/xhigh`，默认 `xhigh`，可关闭 | 百炼：同一档位，默认 `xhigh`；`none→enable_thinking:false`；不可同时设置 `thinking_budget` | 档位/默认值正确；通用 `qwen` mapper 的 `enable_thinking` 字段仍需宿主 payload 核实；未运行验证 |
| `qwen3.8-flash` | extra model，无官方 route | 同 `qwen3.8-max` | 同百炼 Qwen3.8 | 同 `qwen3.8-max`；未运行验证 |

## Native 2.161.1 宿主可用性

本节记录主代理提供的 Native 2.161.1 实际 mock 验收，不是本次直接运行的模型请求；它用于区分“厂商支持且 preset 声明正确”与“当前宿主协议实际可用”。

| mock 场景 | 宿主实际 payload | 结论 |
|---|---|---|
| `kimi-k3` | 有 `reasoning_effort=max`，但没有 `enable_thinking` | effort 进入请求，但 custom-local 的开关映射未生效 |
| `glm-5.2` | `thinking enabled/zai` | 宿主采用官方同名 wireID 的 compat，而非 custom-local 的百炼 `qwen` 映射 |
| `kimi-k2.6` | `thinking enabled/deepseek` | 同上；开关未按 custom-local 声明转换 |
| `qwen3.8-max` / `qwen3.8-flash` | 独立 ID 路径正常 | 只有不与官方 wireID 重名的独立 ID 观察到 custom compat 生效 |
| `glm-5.1` / `glm-5` | `reasoning_effort:xhigh`、`enable_thinking:true`、exit0/marker | Native 2.161.1 两模型 xhigh capture 均通过 |

源码与现象一致，但不在此断定唯一内部根因：Native 中存在 `findCompatibleModelConfig(c.models, wireId, requestId)`；实际 mock 又观察到官方同名 wireID 的 compat 未采用 custom-local 声明。`normalizeReasoningEffort` 本身不接受 `off`，但这不等于所有关闭路径都失败：主代理已通过将 DeepSeek V3.2 entry 设为 `supportsReasoning=false`，在 Native payload 中实际得到 `enable_thinking=false`。Kimi 3 因 Native 的 OpenAI 路径没有可发送的关闭字段，UI off 仍应保持禁用；其是否可关需一对一真实请求验证。

- preset 中的 `off→none`、`canDisableThinking` 仍按各厂商/百炼规范保留，不能因为宿主差异反向改成“供应商不可关闭”。
- DeepSeek V3.2：`supportsReasoning=false` 最终在 Native payload 得到 `enable_thinking=false`，该关闭路径已有实际证据。
- GLM-5.1/GLM-5：Native 2.161.1 实际 capture 到 `reasoning_effort:xhigh`、`enable_thinking:true`，两模型 exit0/marker 均通过。
- Native 2.161.1 另外 9 个 native 案例均通过（主代理实测通报）。
- Kimi 3：Native OpenAI 路径无关闭字段，UI off 先禁用；模型本身是否可关需要单独真实请求验证。
- 其他模型不能统一宣称 off 失败或成功；需逐个以 Native payload 和上游响应验证。
- 除已列 mock 场景外，其他同名 wireID 是否受影响未逐项验证；不能据公开文档推断为已生效。

## 未决与边界

### 2026-10-02 最终运行回执

- 20 个模型逐个通过百炼直连小请求：HTTP 200、`finish_reason=stop`、完整测试标记。10 个已确认可调模型发送各自最高档，其余发送原思考默认参数；这不是当前 WorkBuddy 会话流量或云端面板验收。
- `max`：DeepSeek V4.1 Flash / V4 Pro / V4 Flash、GLM-5.3 / 5.2、Kimi-K3；`xhigh`：GLM-5.1 / 5、Qwen3.8 Max / Flash。GLM-5.1/5 的五档逐项实测通过，`max` 实测拒绝。
- 官方 Native 2.161.1 到隔离 mock 的 15 个案例通过，包含全部 10 个可调模型的最高档参数和 DeepSeek V3.2 关闭路径；不是生产云端 UI 验收。
- 11 个开放关闭开关的型号逐个取得 Native 明确关闭字段，并用相同参数到真实百炼验证 HTTP 200、stop、标记完整、无 `reasoning_content`。DeepSeek V4.1 Flash 的新 Native 关闭路径未发出明确关闭字段，和 Kimi K3 一样在插件 UI 保守禁用；MiniMax M3 的 adaptive/disabled 仍未实现。
- 输入/输出容量另经百炼 PUBLIC 模型列表逐项核对，修正了 10 个旧型号的超报，见 [model-windows.md](model-windows.md)。输入窗口写入验证不等于自动压缩策略或长上下文任务验收。
- 当前原生会话是否已刷新新模型目录、新版账号分发、官方网页面板和手机真机仍未验收。不能用本回执推出无缝热刷新。

- GLM-5.1/GLM-5：百炼泛化参数表与智谱原生 capability 页都不能覆盖本次端点实测；VM 已确认 `max` HTTP400，`high/low/no-effort` 及 `xhigh/medium/minimal` 均 HTTP200。两模型五个可调档位已全覆盖，preset 以实测为优先。
- `glm-5.3-flashx` 当前实际路由到 `glm-5.3`，`glm-4.6` 当前实际路由到 `glm-4.7`。矩阵按实际上游模型判断。
- 本文件整理阶段没有重新发送模型请求；VM 证据来自主代理实际请求。此处“未验证”仅指尚未重测的其它模型、字段或链路，不再指 GLM-5.1/GLM-5 的五个档位。其余 outbound payload、余额、鉴权、provider entitlement 或实际思考行为仍未验证。
- Native 2.161.1 的同名 wireID compat 现象与 `off` 处理需逐模型判断：DeepSeek V3.2 关闭已实测，Kimi 3 off 仍禁用，其他模型不能套用全称结论。
