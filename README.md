# pi-live-models

[![npm](https://img.shields.io/npm/v/pi-live-models)](https://www.npmjs.com/package/pi-live-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built for pi](https://img.shields.io/badge/Built%20for%20pi-green)](https://github.com/earendil-works/pi)
[![CI](https://github.com/wait4xx/pi-live-models/actions/workflows/ci.yml/badge.svg)](https://github.com/wait4xx/pi-live-models/actions/workflows/ci.yml)

Live `/v1/models` discovery for [pi](https://github.com/earendil-works/pi) — make every provider's model list reflect what the endpoint **actually serves**, refreshed every time you open `/model`.

Works with **any** OpenAI-compatible or Anthropic-protocol gateway (OpenRouter, relay services, vLLM, LiteLLM, LM Studio, cloud vendors, …), **and** overrides the static catalogs of pi's **built-in** providers — `registerProvider()` with the same id layers on top of the composed base, and a non-empty live list fully replaces it.

> 📖 中文文档在[下方](#pi-live-models中文文档)，与英文版内容完整对照。

## Contents

- [Why](#why)
- [Highlights](#highlights)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
  - [Filters](#filters)
  - [Presets](#presets)
  - [Auth chain](#auth-chain-discovery-request)
  - [Metadata merge ladder](#metadata-merge-ladder-low--high)
- [Commands](#commands)
- [Offline cache & failure behavior](#offline-cache--failure-behavior)
- [Recipes](#recipes)
- [Safety notes](#safety-notes)
- [Development](#development)
- [License](#license)

## Why

| Pain | With pi-live-models |
|---|---|
| Custom providers in `models.json` are static — new models appear only after hand-editing the file | The list refreshes from `GET /v1/models` every time you open `/model` |
| Built-in provider catalogs go stale between pi releases | Same-id `registerProvider` overrides the built-in catalog with live truth |
| Gateway lists drift (models added, retired, renamed) | Your `/model` picker always mirrors the endpoint — filters decide what you see |

One config file, zero code, zero runtime dependencies.

## Highlights

- 🚫 **Zero filtering by default** — the extension has no opinions about which models are "good". Every filter is yours: glob (`*audio*`), regex (`^glm-4\.`), field-level rules (`includeBy`/`excludeBy` on dotted paths into the live item, e.g. `owned_by`, `architecture.input_modalities`), and reusable **presets**. Exclude always wins; a non-empty include set acts as a whitelist.
- 🔍 **Filter observability** — `/live-models` shows `raw -> kept` statistics; `/live-models-test <provider>` dry-runs discovery and annotates **every** model with its keep/drop reason; `/live-models-refresh [ids...]` forces an immediate refresh bypassing `refreshIntervalMs`.
- 🔑 **Credential reuse** — discovery reuses the key you already have: `/login` stored credential → entry `apiKey` (`$ENV` / `${ENV}` / `!command` / literal) → `models.json` → `<PROVIDER>_API_KEY` env. Keys never appear in logs or errors.
- 🪜 **Metadata merge ladder** — `defaults` < static definitions (`models.json` + `models-store.json`, by id) < live endpoint hints (`context_length`, `max_completion_tokens`, OpenRouter `top_provider.*` and `pricing.*` cost) < `overrides[id]`. New models get sane fallbacks instead of blank metadata. `mergeStatic: "union"` can additionally register static-only models the gateway forgot to list.
- 🛡️ **Never empties your catalog** — a refresh that yields 0 usable models throws and pi keeps the previous list; network failures fall back to a persisted last-good cache (raw items re-filtered and re-merged with your *current* rules), so a gateway outage never blanks `/model` after a restart.
- 📦 Zero runtime dependencies · TypeScript · unit-tested · CI on Windows + Ubuntu.

## Install

```bash
pi install npm:pi-live-models
# or from git:
pi install git:github.com/wait4xx/pi-live-models
```

Then create `~/.pi/agent/live-models.json` (see below) and restart pi.

## Quick start

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

Open `/model` in pi — the list now mirrors `GET https://gw.example.com/v1/models`, minus your excluded patterns. Check status with `/live-models`, tune filters with `/live-models-test MYGATEWAY`.

## Configuration reference

File: `~/.pi/agent/live-models.json` (respects `$PI_CODING_AGENT_DIR`). Validation is field-precise with graceful degradation: an invalid field is warned and ignored; only entries without a usable `baseUrl` are skipped. Config typos never crash pi startup.

**Top level**

| Field | Type | Description |
|---|---|---|
| `presets` | object | Named reusable filter specs, e.g. `"chat-only": { "excludeRegex": ["-embedding$"] }`. Referenced via `filters.use` / `defaultFilters.use`; flattened (unioned per field) during parsing. See [Presets](#presets). |
| `defaultFilters` | object | Global filters — **blacklists only** (`exclude`, `excludeRegex`, `excludeBy`), unioned with every provider's excludes. A global whitelist is intentionally not offered: include-style fields (written directly or contributed by a preset) are warned + ignored. |
| `providers` | object | Map of provider id → entry. The id must match the provider you want to register/override (the `models.json` key or a built-in provider id). |

**Provider entry**

| Field | Required | Description |
|---|---|---|
| `baseUrl` | ✅ | API root. Models endpoint is derived: ends with `/v1` → `{base}/models`, otherwise → `{base}/v1/models`. |
| `modelsUrl` | — | Explicit models-endpoint override when the derivation rule does not fit. |
| `api` | — | `openai-completions` / `openai-responses` / `anthropic-messages`. Can be omitted when overriding a built-in provider (the definition is inherited). |
| `name` | — | Display name. |
| `apiKey` | — | Credential for the discovery request: `"$ENV"`, `"${ENV}"`, `"!shell command"`, or literal. See [Auth chain](#auth-chain-discovery-request). |
| `headers` | — | Extra request headers for the discovery request. |
| `timeoutMs` | — | Discovery fetch timeout, default `10000`. |
| `refreshIntervalMs` | — | Throttle real fetches to at most one per interval. `0` (default) = fetch on every `/model` open. |
| `compat` | — | Provider-level compat fallback for models without one (e.g. `{"thinkingFormat":"qwen"}`). |
| `filters` | — | See [Filters](#filters). |
| `costFromLive` | — | Live pricing fill strategy (OpenRouter-style `pricing.*`, $/token → $/1M): `"fill-zero"` (default) / `"always"` / `"off"`. Details in the [merge ladder](#metadata-merge-ladder-low--high). |
| `mergeStatic` | — | `"live"` (default) or `"union"` — also register static-only models from `models.json`/`models-store.json`. |
| `defaults` | — | Metadata fallback for all models: `reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`. |
| `overrides` | — | Per-model-id metadata overrides: `{"qwen3.8-max":{"contextWindow":1000000}}`. |

### Filters

```jsonc
"filters": {
  "include":      ["*glm*"],            // glob whitelist on id, case-insensitive
  "exclude":      ["*audio*", "*tts*"], // glob blacklist on id
  "includeRegex": ["^glm-[\\d.]"],      // regex whitelist on id, case-sensitive
  "excludeRegex": ["^gpt-5\\.6$"],
  "includeBy":    { "owned_by": ["openai"] },                     // field whitelist (AND across fields)
  "excludeBy":    { "architecture.input_modalities": ["*image*"] }, // field blacklist (OR)
  "use":          ["chat-only"]         // preset references, see below
}
```

Semantics (pinned by unit tests):

| Rule | Behavior |
|---|---|
| Nothing configured | **Every model passes.** Zero filtering is the default. |
| `exclude` / `excludeRegex` / `excludeBy` | A match on any exclude rule (entry-level **or** global `defaultFilters`, unioned) drops the model. |
| Exclude precedence | Exclude always wins — an excluded model cannot be rescued by any include rule. |
| Whitelist | If any include rule exists, a model must satisfy all of them: match ≥1 id pattern (`include`/`includeRegex`, unioned) **and** hit every `includeBy` field (AND). |
| Field rules (`*By`) | Dotted paths into the live `/v1/models` item. String values match case-insensitive globs; array values match if **any** element hits; missing fields / non-string values never match excludes and always fail includes (`includeBy-miss:<field>`). v0.2 is string-glob only — no numeric ranges. |
| Case | Globs case-insensitive; regexes case-sensitive (use `(?i)` if needed). |
| Invalid regex | Reported at startup with its config location, then ignored — never breaks the config. |
| Everything filtered out | The refresh throws (pi keeps the previous catalog) and the error names the rules responsible. |

### Presets

Define once at the top level, reuse everywhere (`filters.use`, `defaultFilters.use`). Preset lists are **unioned** with the spec's own lists during parsing; a preset referenced by `defaultFilters` contributes blacklists only:

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

Presets cannot reference other presets; unknown preset names are warned + ignored — same graceful degradation as every other config field.

### Auth chain (discovery request)

1. `/login` stored credential (pi passes it in the refresh context)
2. entry `apiKey` spec — `$ENV` / `${ENV}` / `!command` / literal
3. `~/.pi/agent/models.json` → `providers[id].apiKey` (same spec syntax)
4. env `<PROVIDER_ID>` upper-cased, non-alnum → `_`, suffixed `_API_KEY`

⚠️ The `!command` form executes a shell command — only use it if you understand what it runs. Keys never appear in logs or errors; the cache file stores model metadata only, never credentials.

### Metadata merge ladder (low → high)

`entry.defaults` < static definitions (`models.json` entry + `models-store.json` cache, matched by id) < live endpoint hints (`context_length`, `context_window`, `max_model_len`, `max_completion_tokens`, `max_tokens`, OpenRouter `top_provider.*`) < `entry.overrides[id]`

**Cost** follows the same ladder, moderated by `costFromLive`:

| Policy | Behavior |
|---|---|
| `"fill-zero"` (default) | Live `pricing.*` hints (converted $/token → $/1M) fill cost **only when nothing else defines it** — hand-written prices always win. |
| `"always"` | Live pricing beats static/defaults **key by key** — a live entry reporting only `pricing.prompt` keeps static output prices. `overrides[id].cost` still wins on every key. |
| `"off"` | Live pricing ignored entirely. |

Explicit `"0"` (free tier) is a valid live cost; strict decimal strings only.

`mergeStatic: "union"` additionally registers models that exist in `models.json`/`models-store.json` but are missing from the gateway's live list (same filters apply, static def acts as the field source for `*By` rules). A zero-model **live** result still throws — union supplements, never papers over a broken gateway.

Live-only models fall back to `defaults`, then to pi-safe values (`reasoning: true`, `input: ["text"]`, `contextWindow: 128000`, `maxTokens: 32768`, zero cost).

## Commands

| Command | Purpose |
|---|---|
| `/live-models` | Configured providers, models endpoint, filter summary, last discovery result (`raw -> kept` statistics). |
| `/live-models-reload` | Re-read the config file and re-register immediately (no restart). |
| `/live-models-test <provider>` | Dry-run one discovery: per-model `kept by …` / `dropped by …` annotation plus a metadata preview (context window, cost, input types). |
| `/live-models-refresh [ids...]` | Force an immediate live refresh, bypassing `refreshIntervalMs` (no argument = all providers). Updates the in-memory catalog and the persisted cache; failures are shown verbatim (no cache fallback for manual actions). |

## Offline cache & failure behavior

| Situation | Behavior |
|---|---|
| Refresh succeeds | Models update; the **raw endpoint items** are persisted to `~/.pi/agent/live-models-cache.json` (format v2). |
| Network / HTTP / JSON failure | Falls back to the last-good cache — rebuilt through the **full pipeline** (current filters, merge ladder, union) from the raw items, so config changes are honored mid-outage. v1 caches (pre-0.2) are still readable and used best-effort (id-only re-filter) until the next successful refresh upgrades them. |
| Filters drop everything (0 models) | Config intent error — the refresh **throws**, pi keeps the previous catalog, and the error names the responsible rules. Never silently serves stale models. |
| Live endpoint returns 0 models | Same as above — `mergeStatic: "union"` is a supplement, not a fallback. |
| Caller aborts (list mode, `/model` closed mid-flight) | Rethrown as-is — no warnings, no cache fallback. |
| Manual `/live-models-refresh` fails | Verbatim error report — manual actions never mask failures with cached data. |

## Recipes

**OpenRouter (free models only):**

```jsonc
"OPENROUTER": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "filters": { "include": ["openrouter/free"] },
  "compat": { "thinkingFormat": "openrouter" }
}
```

**Relay gateway with known-bad legacy line** (drop old `glm-4.*`, audio/realtime variants):

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

**Override a built-in provider's stale catalog:**

```jsonc
"qwen-token-plan-cn": {
  "baseUrl": "https://token-plan.example.com/compatible-mode/v1",
  "api": "openai-completions",
  "exclude": ["qwen-audio-*", "wan*"],
  "compat": { "thinkingFormat": "qwen", "supportsDeveloperRole": false }
}
```

**Gateway list is incomplete** (models defined in `models.json` missing from `/v1/models`):

```jsonc
"GLM": {
  "baseUrl": "https://gw.example.com",
  "api": "anthropic-messages",
  "mergeStatic": "union"   // static-only models are registered too (same filters apply)
}
```

**Let OpenRouter pricing fill the cost fields** instead of hand-writing `overrides`:

```jsonc
"OPENROUTER": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "costFromLive": "always",   // default "fill-zero" only fills models with no cost source
  "filters": { "use": ["chat-only"] }
}
```

## Safety notes

- The extension performs `GET` requests only against URLs **you** configure; no bundled endpoints, no telemetry.
- The cache file stores model metadata only — never credentials.
- Invalid config fields degrade gracefully (warned and ignored); config typos never crash pi startup.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx (42 tests)
npm run smoke       # register against the real config (no TUI)
npx tsx scripts/smoke.ts GLM   # + one live refreshModels pass for GLM
```

CI: Windows + Ubuntu × Node 22/24.

## License

MIT © wait4xx

---

# pi-live-models（中文文档）

[![npm](https://img.shields.io/npm/v/pi-live-models)](https://www.npmjs.com/package/pi-live-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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
- 🪜 **元数据合并阶梯**——`defaults` < 静态定义（`models.json` + `models-store.json`，按 id 匹配）< 端点提示（`context_length`、`max_completion_tokens`、OpenRouter `top_provider.*` 与 `pricing.*` 价格）< `overrides[id]`。新模型也有合理兜底值而非空白元数据。`mergeStatic: "union"` 还能把网关列表里缺失的静态模型补注册进来。
- 🛡️ **永不清空目录**——过滤后 0 模型即报错，pi 保留上一份列表；网络故障回落磁盘缓存（按**当前**规则完整重建），网关挂掉重启也不会空白 `/model`。
- 📦 零运行时依赖 · TypeScript · 单元测试 · Windows + Ubuntu 双平台 CI。

## 安装

```bash
pi install npm:pi-live-models
# 或从 git 安装：
pi install git:github.com/wait4xx/pi-live-models
```

然后创建 `~/.pi/agent/live-models.json`（见下文）并重启 pi。

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

## 配置参考

文件：`~/.pi/agent/live-models.json`（尊重 `$PI_CODING_AGENT_DIR`）。校验按字段精确定位、优雅降级：非法字段警告并忽略；只有 `baseUrl` 不可用的条目才会整条跳过。配置手误永远不会弄崩 pi 启动。

**顶层字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `presets` | object | 命名的可复用过滤预设，如 `"chat-only": { "excludeRegex": ["-embedding$"] }`。经 `filters.use` / `defaultFilters.use` 引用，解析期按字段并集展开。见[预设](#预设)。 |
| `defaultFilters` | object | 全局过滤——**仅黑名单**（`exclude`、`excludeRegex`、`excludeBy`），与每个 provider 的排除规则取并集。刻意不提供全局白名单：include 类字段（直接写或由预设贡献）一律警告 + 忽略。 |
| `providers` | object | provider id → 条目的映射。id 必须与要注册/覆盖的 provider 一致（`models.json` 的键或内置 provider id）。 |

**Provider 条目**

| 字段 | 必填 | 说明 |
|---|---|---|
| `baseUrl` | ✅ | API 根地址。模型端点自动推导：以 `/v1` 结尾 → `{base}/models`，否则 → `{base}/v1/models`。 |
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

### 元数据合并阶梯（低 → 高）

`entry.defaults` < 静态定义（`models.json` 条目 + `models-store.json` 缓存，按 id 匹配）< 端点提示（`context_length`、`context_window`、`max_model_len`、`max_completion_tokens`、`max_tokens`、OpenRouter `top_provider.*`）< `entry.overrides[id]`

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
| `/live-models-test <provider>` | 干跑一次发现：逐模型 `kept by …` / `dropped by …` 标注 + 元数据预览（上下文窗口、价格、输入类型）。 |
| `/live-models-refresh [ids...]` | 绕过 `refreshIntervalMs` 强制立即刷新（无参数 = 全部 provider）。更新内存目录与持久缓存；失败原样展示（手动动作不走缓存回落）。 |

## 离线缓存与故障行为

| 场景 | 行为 |
|---|---|
| 刷新成功 | 模型更新；**原始端点条目**（raw items）持久化到 `~/.pi/agent/live-models-cache.json`（v2 格式）。 |
| 网络 / HTTP / JSON 失败 | 回落最近一次好缓存——用 raw items 走**完整管线**重建（当前过滤规则、合并阶梯、union），断网期间改配置也即时生效。v1 旧缓存（0.2 之前）仍可读、尽力而为（仅按 id 重过滤），下次成功刷新自动升级。 |
| 过滤后 0 模型 | 配置意图错误——刷新**抛错**，pi 保留原目录，错误信息点名责任规则。绝不静默供陈旧模型。 |
| live 端点返回 0 模型 | 同上——`mergeStatic: "union"` 是补充不是兜底。 |
| 调用方中止（list 模式、`/model` 中途关闭） | 原样重抛——不告警、不走缓存回落。 |
| 手动 `/live-models-refresh` 失败 | 原样报错——手动动作绝不用缓存数据掩盖故障。 |

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

## 安全说明

- 扩展只对你**自己配置**的 URL 发 `GET` 请求；不内置任何端点，无遥测。
- 缓存文件只存模型元数据——绝不存凭据。
- 非法配置字段优雅降级（警告 + 忽略）；配置手误永远不会弄崩 pi 启动。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx（42 个用例）
npm run smoke       # 对真实配置注册（不进 TUI）
npx tsx scripts/smoke.ts GLM   # + GLM 真实刷新一轮
```

CI：Windows + Ubuntu × Node 22/24。

## 许可证

MIT © wait4xx
