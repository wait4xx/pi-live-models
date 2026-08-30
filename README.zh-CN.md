# pi-live-models（中文文档）

[![npm](https://img.shields.io/npm/v/pi-live-models)](https://www.npmjs.com/package/pi-live-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built for pi](https://img.shields.io/badge/Built%20for%20pi-green)](https://github.com/earendil-works/pi)
[![CI](https://github.com/wait4xx/pi-live-models/actions/workflows/ci.yml/badge.svg)](https://github.com/wait4xx/pi-live-models/actions/workflows/ci.yml)

[English](README.md) · **简体中文**

<p align="center">
  <img src="docs/preview.png" alt="pi-live-models — 实时模型发现预览" width="720">
</p>

让 [pi](https://github.com/earendil-works/pi) 每个 provider 的模型列表**实时反映端点真实可用模型**——每次打开 `/model` 自动刷新。

适用于**任意** OpenAI 兼容 / Anthropic 协议网关（OpenRouter、各类中转、vLLM、LiteLLM、LM Studio、云厂商…），也能覆盖 pi **内置 provider** 的静态目录——同名 `registerProvider` 叠加在既有定义之上，非空实时列表整体替换静态目录。

## 为什么需要它

| 痛点 | 用了 pi-live-models |
|---|---|
| `models.json` 里的自定义 provider 是静态的，新模型必须手改文件才会出现 | 每次打开 `/model` 自动从 `GET /v1/models` 刷新 |
| pi 内置 provider 目录在版本之间会过时 | 同名 `registerProvider` 用实时数据覆盖内置目录 |
| 网关列表随时漂移（新增、下线、改名） | `/model` 选择器始终镜像端点真实状态，过滤规则决定你看到什么 |

一个配置文件，零代码，零运行时依赖。

## 核心特性

- 🚫 **默认零过滤**——扩展对"哪些模型好"没有任何预设观点，规则全部来自你的配置：通配符（`*audio*`）、正则（`^glm-4\.`）、**字段级规则**（`includeBy`/`excludeBy`，按点路径匹配 live item 任意字段，如 `owned_by`、`architecture.input_modalities`）、可复用**预设**（`presets`）。exclude 永远优先；include 非空即白名单。
- 🔍 **过滤可观测**——`/live-models` 显示 `raw -> kept` 统计；`/live-models-test <provider>` 干跑并**逐模型**标注保留/丢弃原因；`/live-models-refresh [ids...]` 绕过节流强制立即刷新。
- 🔑 **凭据复用**——刷新复用你已有的密钥：`/login` 存储凭据 → 条目 `apiKey`（`$ENV` / `${ENV}` / `!命令` / 明文）→ `models.json` → `<PROVIDER>_API_KEY` 环境变量，四级链式解析。密钥永不落日志、永不落缓存。
- 🪜 **元数据合并阶梯**——`defaults` < 静态定义（`models.json` + `models-store.json`，按 id 匹配）< 端点提示（`context_length`、`max_completion_tokens`、OpenRouter `top_provider.*` 与 `pricing.*` 价格）< **公共目录**（LiteLLM 社区数据，仅精确匹配）< `overrides[id]`。新模型也有合理兜底值而非空白元数据。`mergeStatic: "union"` 还能把网关列表里缺失的静态模型补注册进来。
- 🌐 **公共元数据目录**——中转站常常乱报元数据（所有模型都盖一个 `context_length: 128000`）。双社区目录（LiteLLM + Models.dev）交叉校验网关：精确同名匹配纠正 `contextWindow`/`maxTokens`，离谱的 live 值被合理性窗口拦截，可疑模式（与目录相差 ≥4×、多模型同一占位值）主动告警并给出 `/live-models-fix` 现成命令。缓存支撑、后台刷新、一个字段即可按 provider 关闭。
- 🛡️ **永不清空目录**——过滤后 0 模型即报错，pi 保留上一份列表；网络故障回落磁盘缓存（按**当前**规则完整重建），网关挂掉重启也不会空白 `/model`。
- 📦 零运行时依赖 · TypeScript · 单元测试 · Windows + Ubuntu 双平台 CI。

## 安装

```bash
pi install npm:pi-live-models
# 或从 git 安装：
pi install git:github.com/wait4xx/pi-live-models
```

然后创建 `~/.pi/agent/live-models.json`（见下文）并重启 pi。`models.json` 里已有 provider？在 pi 里跑一次 `/live-models-init`——它会为每个 `models.json` provider 写入一条 stub（幂等，已有条目不动）；或者只写 id 让它继承（见下）。

## 快速上手

```jsonc
// ~/.pi/agent/live-models.json
{
  "providers": {
    "MYGATEWAY": {
      "baseUrl": "https://gw.example.com",
      "api": "openai-completions",
      "apiKey": "$MYGATEWAY_API_KEY",
      "filters": { "exclude": ["*embedding*", "*rerank*"] }
    }
  }
}
```

在 pi 里打开 `/model`——列表即刻镜像 `GET https://gw.example.com/v1/models`，再减去你排除的模式。`/live-models` 看状态，`/live-models-test MYGATEWAY` 调过滤。

条目可以省略 `baseUrl`，自动从 `models.json` 里同名 provider 继承（凭据本来就支持从 `models.json` 解析）：

```jsonc
{ "providers": { "MYGATEWAY": { "filters": { "exclude": ["*embedding*"] } } } }
```

## 配置参考

文件：`~/.pi/agent/live-models.json`（尊重 `$PI_CODING_AGENT_DIR`）。校验按字段精确定位、优雅降级：非法字段警告并忽略；只有 `baseUrl` 不可用——显式缺失且无法从 `models.json` 同名 provider 继承——的条目才会整条跳过。配置手误永远不会弄崩 pi 启动。

**顶层字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `presets` | object | 命名的可复用过滤预设，如 `"chat-only": { "excludeRegex": ["-embedding$"] }`。经 `filters.use` / `defaultFilters.use` 引用，解析期按字段并集展开。见[预设](#预设)。 |
| `defaultFilters` | object | 全局过滤——**仅黑名单**（`exclude`、`excludeRegex`、`excludeBy`），与每个 provider 的排除规则取并集。刻意不提供全局白名单：include 类字段（直接写或由预设贡献）一律警告 + 忽略。 |
| `providers` | object | provider id → 条目的映射。id 必须与要注册/覆盖的 provider 一致（`models.json` 的键或内置 provider id）。 |

**Provider 条目**

| 字段 | 必填 | 说明 |
|---|---|---|
| `baseUrl` | ✅* | API 根地址。模型端点自动推导：以版本段（`/v1`、`/v2`…）结尾 → `{base}/models`，否则 → `{base}/v1/models`。*可省略，从 `models.json` 同名 provider 继承；显式写了但非法的值绝不继承。* |
| `modelsUrl` | — | 推导规则不适用时，显式指定模型端点。 |
| `api` | — | `openai-completions` / `openai-responses` / `anthropic-messages`。覆盖内置 provider 时可省略（继承原定义）。 |
| `name` | — | 显示名。 |
| `apiKey` | — | 发起发现请求的凭据：`"$ENV"`、`"${ENV}"`、`"!shell 命令"` 或明文。见[凭据链](#凭据链发现请求)。 |
| `headers` | — | 发现请求的附加头。 |
| `timeoutMs` | — | 发现请求超时，默认 `10000`。 |
| `refreshIntervalMs` | — | 限流：真实请求的最小间隔。`0`（默认）= 每次打开 `/model` 都拉取。 |
| `compat` | — | provider 级 compat 兜底（如 `{"thinkingFormat":"qwen"}`）。 |
| `filters` | — | 见[过滤器](#过滤器)。 |
| `costFromLive` | — | live 价格填充策略（OpenRouter 风格 `pricing.*`，$/token → $/1M）：`"fill-zero"`（默认）/ `"always"` / `"off"`。详见[合并阶梯](#元数据合并阶梯低--高)。 |
| `catalog` | — | `true`（默认）/ `false`——按 provider 退出公共元数据目录。见[公共元数据目录](#公共元数据目录)。 |
| `mergeStatic` | — | `"live"`（默认）或 `"union"`——把 `models.json`/`models-store.json` 里有、网关列表里没有的静态模型也注册进来。 |
| `defaults` | — | 全部模型的元数据兜底：`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost`。 |
| `overrides` | — | 按模型 id 的元数据覆盖：`{"qwen3.8-max":{"contextWindow":1000000}}`。 |

### 过滤器

```jsonc
"filters": {
  "include":      ["*glm*"],            // id 通配符白名单，大小写不敏感
  "exclude":      ["*audio*", "*tts*"], // id 通配符黑名单
  "includeRegex": ["^glm-[\\d.]"],      // id 正则白名单，大小写敏感
  "excludeRegex": ["^gpt-5\\.6$"],
  "includeBy":    { "owned_by": ["openai"] },                     // 字段白名单（字段间 AND）
  "excludeBy":    { "architecture.input_modalities": ["*image*"] }, // 字段黑名单（OR）
  "use":          ["chat-only"]         // 引用预设，见下文
}
```

语义（全部由单元测试钉住）：

| 规则 | 行为 |
|---|---|
| 什么都不配 | **所有模型通过。** 默认零过滤。 |
| `exclude` / `excludeRegex` / `excludeBy` | 任一排除规则命中（条目级**或**全局 `defaultFilters`，取并集）即丢弃。 |
| 排除优先 | exclude 永远赢——被排除的模型无法被任何 include 规则救回。 |
| 白名单 | 只要存在任一 include 规则，模型必须全部满足：命中 ≥1 条 id 规则（`include`/`includeRegex` 并集）**且**每个 `includeBy` 字段都命中（AND）。 |
| 字段规则（`*By`） | 对 live `/v1/models` 条目的点路径取值。字符串按大小写不敏感通配符匹配；数组**任一元素**命中即算命中；字段缺失 / 非字符串值永不命中排除、必然未命中 include（`includeBy-miss:<field>`）。v0.2 仅字符串通配——不支持数值范围。 |
| 大小写 | 通配符不敏感；正则敏感（需要不敏感用 `(?i)`）。 |
| 非法正则 | 启动时报告其配置位置后忽略——绝不会弄坏配置。 |
| 全部被过滤 | 刷新抛错（pi 保留原目录），错误信息点名负责的规则。 |

### 预设

顶层定义一次，处处复用（`filters.use`、`defaultFilters.use`）。预设列表在解析期与条目自身列表**取并集**；被 `defaultFilters` 引用的预设仅贡献黑名单：

```jsonc
{
  "presets": {
    "chat-only": { "excludeRegex": ["-embedding$", "-rerank$", "-tts$", "-realtime$"] },
    "no-legacy": { "excludeRegex": ["^glm-4\\."] }
  },
  "providers": {
    "GLM": {
      "baseUrl": "https://gw.example.com",
      "filters": { "use": ["no-legacy"], "include": ["*glm*"] }
    }
  }
}
```

预设不能引用其他预设；引用不存在的预设名会警告 + 忽略——与其他所有配置字段同样优雅降级。

### 凭据链（发现请求）

1. `/login` 存储凭据（pi 在刷新上下文里传入）
2. 条目 `apiKey` 规范——`$ENV` / `${ENV}` / `!命令` / 明文
3. `~/.pi/agent/models.json` → `providers[id].apiKey`（同一规范语法）
4. 环境变量 `<PROVIDER_ID>` 大写、非字母数字转 `_`、后缀 `_API_KEY`

⚠️ `!命令` 形式会执行 shell 命令——请先弄清它跑的是什么。密钥永不落日志与错误信息；缓存文件只存模型元数据，绝不存凭据。

### 公共元数据目录

大量中转网关给所有模型盖上同一个 `context_length`（通常是 `128000`），或干脆不报元数据。公共目录是独立的交叉校验源，由**两个社区维护的数据源**构成：LiteLLM 的 [`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)（约 2500 个 chat 模型）与 [Models.dev](https://models.dev) 的 [`api.json`](https://models.dev/api.json)（约 7300 条、200+ 家 provider，从官方文档索引——新模型收录极快）。

**怎么运作**

- **数据源**：两个相互独立的目录，各自拥有独立的拉取链路、磁盘缓存、过期时钟与失败退避——一个源挂了不影响另一个。LiteLLM 走 jsDelivr CDN、raw.githubusercontent.com 兜底；Models.dev 为单一 CDN URL。均为后台拉取，绝不阻塞发现流程。失败时发现照常进行（无目录参与），30 分钟退避后自动重试。
- **缓存**：`~/.pi/agent/live-models-catalog.json`（LiteLLM）与 `~/.pi/agent/live-models-catalog-modelsdev.json`（Models.dev），各自 7 天后台刷新。`/live-models-catalog-refresh` 强制重拉两个源（部分失败时成功的源照常生效）。
- **匹配**：仅精确同名匹配——永不做模糊匹配。`provider/` 前缀、`:suffix` 标签（`:free`、`:latest`）、日期后缀（`gpt-4o-2024-11-20`）在查询时归一化；目录里的精确键永远优先于归一化键。
- **仲裁**（仅归一化键）：同一模型被多家部署时常携带各自平台的上限值，候选按层级仲裁——**厂商在 LiteLLM 的官方条目优先**（两段式 `厂商/模型` 键且 `litellm_provider` 与前缀一致，如 `zai/glm-4.6`）；多个官方条目须在 5% 容差内一致（目录间的舍入口径差异不算分歧——合并取保守最小值）；无官方时**独立来源须在同等容差内一致**；**不一致则弃用并告警**——模型落回静态/live 阶梯，告警列出主要候选值并附 `/live-models-fix` 现成命令。**仅剩单一第三方部署**时静默跳过为 unverified。Models.dev 条目永不冒认官方：其 200+ 命名空间含大 resellers，它们用与厂商相同的裸 id 上架（`vancine/glm-5.3-flash` 与 `zai/glm-5.3-flash` 键形完全相同），数据里无法区分——因此 Models.dev 只贡献共识/分歧信号与新模型覆盖，不带未经审计的权威。`/live-models-catalog` 显示双源状态与仲裁统计。
- **范围**：chat 类条目（无 `mode` 字段的条目保留）；数值须过合理性窗口（上下文 1,024–10,000,000 tokens，最大输出 128–10,000,000）。

**改变什么**

- 合并阶梯多了一层（在 live 提示与你的 overrides 之间）——可信的目录值压过网关的自报值（见[合并阶梯](#元数据合并阶梯低--高)）。
- **离谱的 live 值被隔离**：live `context_length` 为 `0`、`100` 或 `10¹²` 不再污染元数据——合理性窗口先行拦截。
- **可疑模式主动暴露**（由 `/live-models-test` 与 `/live-models-refresh` 呈现）：
  - 网关上报的上下文与目录相差 ≥4×（双向都会标注）→ 告警并附现成的 `/live-models-fix <provider> <model> ctx=<目录值>` 命令；
  - ≥3 个模型共享同一 live 上下文值 → 统一占位值告警（典型中转盖章）。

不想要这些？一个字段：provider 条目上加 `"catalog": false`——不做目录查询、不出目录告警。（live 值的合理性窗口仍然生效：离谱的 `context_length` 无论如何都不会胜出。）

### 元数据合并阶梯（低 → 高）

`entry.defaults` < 静态定义（`models.json` 条目 + `models-store.json` 缓存，按 id 匹配）< 端点提示（`context_length`、`context_window`、`max_model_len`、`max_completion_tokens`、`max_tokens`、OpenRouter `top_provider.*`）< 公共目录（精确匹配，[见上节](#公共元数据目录)）< `entry.overrides[id]`

live 值必须先过合理性窗口才能赢得所在层：上下文整数 1,024–10,000,000 tokens，最大输出 128–10,000,000。被拒的 live 值直接落到下一层，不再向上传播。`/live-models-test` 的预览会标注每个字段值的胜出来源（`ctx=202800 (catalog)`、`max=… (live)`）。

**cost** 遵循同一阶梯，由 `costFromLive` 调节：

| 策略 | 行为 |
|---|---|
| `"fill-zero"`（默认） | live `pricing.*` 提示（$/token 自动换算 $/1M）**只在没有其他来源定义 cost 时**才填充——手写价格永远优先。 |
| `"always"` | live 价格**按键**压过 static/defaults——live 只报 `pricing.prompt` 时，static 的 output 价格保留。`overrides[id].cost` 在每个键上仍然最高。 |
| `"off"` | 完全忽略 live 价格。 |

显式 `"0"`（免费档）是有效的 live 价格；仅接受严格十进制字符串。

`mergeStatic: "union"` 会额外注册存在于 `models.json`/`models-store.json` 但网关列表缺失的模型（走同一套过滤，静态定义充当 `*By` 规则的字段源）。**live 返回 0 模型仍然抛错**——union 是补充，绝不给坏网关打掩护。

仅 live 有的模型回退到 `defaults`，再回退到 pi 安全值（`reasoning: true`、`input: ["text"]`、`contextWindow: 128000`、`maxTokens: 32768`、零成本）。

## 命令

| 命令 | 用途 |
|---|---|
| `/live-models` | 已配置的 provider、模型端点、过滤摘要、最近一次发现结果（`raw -> kept` 统计）。 |
| `/live-models-reload` | 立即重读配置并重新注册（无需重启）。 |
| `/live-models-init` | 引导初始化 `live-models.json`：为每个尚未配置的 `models.json` provider 写入一条 `{ baseUrl }` stub（幂等，已有条目不动，配置文件损坏时拒绝覆写），随后立即重新注册。 |
| `/live-models-test <provider>` | 干跑一次发现：逐模型 `kept by …` / `dropped by …` 标注 + 元数据预览（上下文窗口、价格、输入类型）。 |
| `/live-models-refresh [ids...]` | 绕过 `refreshIntervalMs` 强制立即刷新（无参数 = 全部 provider）。更新内存目录与持久缓存；失败原样展示（手动动作不走缓存回落）。 |
| `/live-models-catalog` | 查看公共目录状态：双源条目数与拉取时间、合并数、仲裁统计、缓存路径。 |
| `/live-models-catalog-refresh` | 强制阻塞式重拉公共元数据目录。 |
| `/live-models-fix <provider> <model> ctx=<n> [max=<n>]` | 把元数据修正写进 `live-models.json` 的 `overrides`（原子写入，保留文件其余部分），然后 `/live-models-reload` 生效。写入前校验合理性窗口与该 provider 的已知模型 id。 |

## 离线缓存与故障行为

| 场景 | 行为 |
|---|---|
| 刷新成功 | 模型更新；**原始端点条目**（raw items）持久化到 `~/.pi/agent/live-models-cache.json`（v2 格式）。 |
| 网络 / HTTP / JSON 失败 | 回落最近一次好缓存——用 raw items 走**完整管线**重建（当前过滤规则、合并阶梯、union），断网期间改配置也即时生效。v1 旧缓存（0.2 之前）仍可读、尽力而为（仅按 id 重过滤），下次成功刷新自动升级。 |
| 过滤后 0 模型 | 配置意图错误——刷新**抛错**，pi 保留原目录，错误信息点名责任规则。绝不静默供陈旧模型。 |
| live 端点返回 0 模型 | 同上——`mergeStatic: "union"` 是补充不是兜底。 |
| 调用方中止（list 模式、`/model` 中途关闭） | 原样重抛——不告警、不走缓存回落。 |
| 手动 `/live-models-refresh` 失败 | 原样报错——手动动作绝不用缓存数据掩盖故障。 |
| 公共目录拉取失败 | 发现流程照常（无目录参与）；30 分钟退避后自动后台重试，或用 `/live-models-catalog-refresh` 强制。 |

## 配方示例

**OpenRouter（只要免费模型）：**

```jsonc
"OPENROUTER": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "filters": { "include": ["openrouter/free"] },
  "compat": { "thinkingFormat": "openrouter" }
}
```

**中转网关带已知坏旧线**（剔除旧 `glm-4.*`、audio/realtime 变体）：

```jsonc
"GLM": {
  "baseUrl": "https://gw.example.com",
  "api": "anthropic-messages",
  "filters": {
    "includeRegex": ["^glm-[\\d.]"],
    "excludeRegex": ["^glm-4\\."]
  }
}
```

**覆盖内置 provider 的过时目录：**

```jsonc
"qwen-token-plan-cn": {
  "baseUrl": "https://token-plan.example.com/compatible-mode/v1",
  "api": "openai-completions",
  "exclude": ["qwen-audio-*", "wan*"],
  "compat": { "thinkingFormat": "qwen", "supportsDeveloperRole": false }
}
```

**网关列表不全**（`models.json` 里定义的模型没出现在 `/v1/models`）：

```jsonc
"GLM": {
  "baseUrl": "https://gw.example.com",
  "api": "anthropic-messages",
  "mergeStatic": "union"   // 缺失的静态模型也注册（走同一套过滤）
}
```

**让 OpenRouter 价格自动填 cost 字段**，省得手写 `overrides`：

```jsonc
"OPENROUTER": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "costFromLive": "always",   // 默认 "fill-zero" 只填没有任何价格来源的模型
  "filters": { "use": ["chat-only"] }
}
```

**网关乱报上下文窗口**（所有模型都盖 `context_length: 128000`）：无需任何配置——公共目录自动纠正精确匹配的模型，`/live-models-test` 会标注不一致项。目录不认识的模型（或想自定值）用终端写一条覆盖：

```
/live-models-fix GLM glm-4.6 ctx=202800
/live-models-reload
```

## 安全说明

- 扩展只对你**自己配置**的 URL 发 `GET` 请求，外加两次可选的公共目录读取（LiteLLM 走 jsDelivr/raw.githubusercontent、Models.dev——无查询参数、无凭据）；不内置任何端点，无遥测。
- 缓存文件只存模型元数据——绝不存凭据。
- 公共目录数据由社区维护、仅精确匹配，可能有误或有缺失；overrides 永远优先。
- 非法配置字段优雅降级（警告 + 忽略）；配置手误永远不会弄崩 pi 启动。

## 致谢

模型元数据来自社区维护的公共目录——没有它们就没有本扩展的这些能力：

- **[LiteLLM](https://github.com/BerriAI/litellm)**——[`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) 目录：生态里覆盖最广的 provider/价格/元数据集，也是本扩展官方仲裁所依赖的厂商命名空间事实源。
- **[Models.dev](https://models.dev)**——[`api.json`](https://models.dev/api.json) 目录：从官方文档索引的结构化逐厂商模型规格，新模型收录速度极快。

感谢两个团队与全体贡献者。本扩展是独立消费者，与上述项目无隶属关系。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx（77 个用例）
npm run smoke       # 对真实配置注册（不进 TUI）
npx tsx scripts/smoke.ts GLM   # + GLM 真实刷新一轮
```

CI：Windows + Ubuntu × Node 22/24。

## 许可证

MIT © wait4xx
