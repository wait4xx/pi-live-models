# pi-live-models

[![npm](https://img.shields.io/npm/v/pi-live-models)](https://www.npmjs.com/package/pi-live-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built for pi](https://img.shields.io/badge/Built%20for%20pi-green)](https://github.com/earendil-works/pi)

Live `/v1/models` discovery for [pi](https://github.com/earendil-works/pi) — make every provider's model list reflect what the endpoint **actually serves**, refreshed every time you open `/model`.

Works with **any** OpenAI-compatible or Anthropic-protocol gateway (OpenRouter, relay/gateway services, vLLM, LiteLLM, LM Studio, cloud vendors, …), **and** overrides the static catalogs of pi's **built-in** providers — because `registerProvider()` with the same id layers on top of the composed base and a non-empty live list fully replaces it.

## Why

- Custom providers in `models.json` are static: new models appear only after you edit the file by hand.
- Built-in provider catalogs go stale between pi releases.
- Gateway model lists drift (models added, retired, renamed) — your `/model` picker should know.

pi-live-models solves all three with one config file and zero code.

## Highlights

- **Zero filtering by default** — the extension has no opinions about which models are "good". Every filter is yours: glob (`*audio*`), regex (`^glm-4\.`), per-entry or global blacklist union, and field-level rules (`includeBy`/`excludeBy` on any dotted path into the live item, e.g. `owned_by`, `architecture.input_modalities`). Exclude always wins; a non-empty include set acts as a whitelist. Reusable **presets** deduplicate common rules across providers.
- **Filter observability** — `/live-models` shows `raw -> kept` statistics; `/live-models-test <provider>` dry-runs discovery and annotates every model with its keep/drop reason; `/live-models-refresh [ids...]` forces an immediate refresh bypassing `refreshIntervalMs`.
- **Credential reuse** — discovery reuses the key you already have: `/login` stored credential → entry `apiKey` → `models.json` `apiKey` → `<PROVIDER>_API_KEY` env. Keys never appear in logs or errors.
- **Metadata merge ladder** — `defaults` < static definitions (`models.json` + `models-store.json`, by id) < live endpoint hints (`context_length`, `max_completion_tokens`, OpenRouter `top_provider.*` and `pricing.*` cost) < `overrides[id]`. New models get sane fallbacks instead of blank metadata. `mergeStatic: "union"` can additionally register static-only models the gateway forgot to list.
- **Never empties your catalog** — a refresh that yields 0 usable models throws and pi keeps the previous list; network failures fall back to a persisted last-good cache (raw items are re-filtered and re-merged with your *current* rules), so a gateway outage never blanks `/model` after a restart.
- Zero runtime dependencies.

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

File: `~/.pi/agent/live-models.json` (respects `$PI_CODING_AGENT_DIR`).

Top level:

| Field | Type | Description |
|---|---|---|
| `presets` | object | Named reusable filter specs (`"chat-only": { "excludeRegex": ["-embedding$"] }`), referenced via `filters.use` / `defaultFilters.use`. Resolved (flattened) during parsing; presets cannot reference other presets. |
| `defaultFilters` | object | Global filters. Only blacklists are supported (`exclude`, `excludeRegex`, `excludeBy`) — unioned with every provider's excludes. A global whitelist is intentionally not offered (include-style fields and preset contributions are warned + ignored). |
| `providers` | object | Map of provider id → entry. The id must match the provider you want to register/override (e.g. the `models.json` key or a built-in provider id). |

Provider entry:

| Field | Required | Description |
|---|---|---|
| `baseUrl` | ✅ | API root. Models endpoint is derived: ends with `/v1` → `{base}/models`, otherwise → `{base}/v1/models`. |
| `modelsUrl` | — | Explicit models-endpoint override when the derivation rule does not fit. |
| `api` | — | `openai-completions` / `openai-responses` / `anthropic-messages`. Can be omitted when overriding a built-in provider (the definition is inherited). |
| `name` | — | Display name. |
| `apiKey` | — | Credential for the discovery request: `"$ENV"`, `"${ENV}"`, `"!shell command"`, or literal. See also Auth chain below. |
| `headers` | — | Extra request headers for the discovery request. |
| `timeoutMs` | — | Discovery fetch timeout, default `10000`. |
| `refreshIntervalMs` | — | Throttle real fetches to at most one per interval. `0` (default) = fetch on every `/model` open. |
| `compat` | — | Provider-level compat fallback for models without one (e.g. `{"thinkingFormat":"qwen"}`). |
| `filters` | — | See Filters below. |
| `costFromLive` | — | Live pricing fill strategy (OpenRouter-style `pricing.*`, $/token → $/1M): `"fill-zero"` (default — only when no other source defines cost), `"always"` (live pricing beats static/defaults; overrides still win), `"off"`. |
| `mergeStatic` | — | `"live"` (default — only live-listed models; static defs only enrich metadata) or `"union"` (also register static-only models from `models.json`/`models-store.json`, passed through the same filters; a zero-model *live* result still throws — union is a supplement, not a fallback). |
| `defaults` | — | Metadata fallback for all models: `reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`. |
| `overrides` | — | Per-model-id metadata overrides: `{"qwen3.8-max":{"contextWindow":1000000}}`. |

### Filters

```jsonc
"filters": {
  "include":      ["*glm*"],            // glob whitelist, case-insensitive
  "exclude":      ["*audio*", "*tts*"], // glob blacklist
  "includeRegex": ["^glm-[\\d.]"],      // regex whitelist, case-sensitive
  "excludeRegex": ["^gpt-5\\.6$"],
  "includeBy":    { "owned_by": ["openai"] },                    // field whitelist (AND across fields)
  "excludeBy":    { "architecture.input_modalities": ["*image*"] }, // field blacklist (OR)
  "use":          ["chat-only"]          // presets, see below
}
```

Semantics (pinned by unit tests):

| Rule | Behavior |
|---|---|
| Nothing configured | **Every model passes.** Zero filtering is the default. |
| `exclude` / `excludeRegex` / `excludeBy` | A match on any exclude rule (entry-level **or** global `defaultFilters`, unioned) drops the model. |
| Exclude precedence | Exclude always wins — an excluded model cannot be rescued by include. |
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
    "chat-only":   { "excludeRegex": ["-embedding$", "-rerank$", "-tts$", "-realtime$"] },
    "no-legacy":   { "excludeRegex": ["^glm-4\\."] }
  },
  "providers": {
    "GLM": { "baseUrl": "https://gw.example.com", "filters": { "use": ["no-legacy"], "include": ["*glm*"] } }
  }
}
```

Unknown preset names are warned + ignored, like every other config typo.

### Auth chain (discovery request)

1. `/login` stored credential (pi passes it in the refresh context)
2. entry `apiKey` spec — `$ENV` / `${ENV}` / `!command` / literal
3. `~/.pi/agent/models.json` → `providers[id].apiKey` (same spec syntax)
4. env `<PROVIDER_ID>` upper-cased, non-alnum → `_`, suffixed `_API_KEY`

⚠️ The `!command` form executes a shell command — only use it if you understand what it runs. Keys never appear in logs or errors; the cache file stores model metadata only, never credentials.

### Metadata merge ladder (low → high)

`entry.defaults` < static definitions (`models.json` entry + `models-store.json` cache, matched by id) < live endpoint hints (`context_length`, `context_window`, `max_model_len`, `max_completion_tokens`, `max_tokens`, OpenRouter `top_provider.*`) < `entry.overrides[id]`

Cost follows the same ladder, moderated by `costFromLive`: live `pricing.*` hints (converted from $/token to $/1M) fill in cost only when nothing else defines it (`fill-zero`, default), beat static/defaults when `always`, and are ignored when `off`. Explicit `overrides[id].cost` always wins over every policy. Explicit "0" pricing (free tier) is a valid live cost.

Live-only models fall back to `defaults`, then to pi-safe values (`reasoning: true`, `input: ["text"]`, `contextWindow: 128000`, `maxTokens: 32768`, zero cost).

## Commands

| Command | Purpose |
|---|---|
| `/live-models` | Configured providers, models endpoint, filter summary, last discovery result (`raw -> kept` statistics). |
| `/live-models-reload` | Re-read the config file and re-register immediately (no restart). |
| `/live-models-test <provider>` | Dry-run one discovery: per-model `kept by …` / `dropped by …` annotation plus a metadata preview. |
| `/live-models-refresh [ids...]` | Force an immediate live refresh, bypassing `refreshIntervalMs` (no argument = all providers). Updates the in-memory catalog and the persisted cache; failures are shown verbatim (no cache fallback for manual actions). |

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

**Relay gateway with known-bad legacy line** (drop old `glm-4.*`, one broken bare id, audio/realtime variants):

```jsonc
"GLM": {
  "baseUrl": "https://gw.example.com",
  "api": "anthropic-messages",
  "filters": {
    "includeRegex": ["^glm-[\\d.]"],
    "excludeRegex": ["^glm-4\\."]
  }
},
"GPT": {
  "baseUrl": "https://gw.example.com",
  "api": "openai-responses",
  "filters": { "excludeRegex": ["^gpt-5\\.6$", "-audio-", "-realtime-"] }
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
- The cache file (`~/.pi/agent/live-models-cache.json`) stores model metadata only — never credentials.
- Invalid config fields degrade gracefully (warned and ignored); only entries without a usable `baseUrl` are skipped. Config typos never crash pi startup.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx
npm run smoke       # register against the real config (no TUI)
npx tsx scripts/smoke.ts GLM   # + one live refreshModels pass for GLM
```

CI: Windows + Ubuntu × Node 22/24.

## License

MIT © wait4xx

---

# pi-live-models（中文说明）

让 pi 每个 provider 的模型列表**实时反映端点真实可用模型**——每次打开 `/model` 自动刷新。适用于任意 OpenAI 兼容 / Anthropic 协议网关（OpenRouter、各类中转、vLLM、LiteLLM、LM Studio、云厂商…），也能覆盖 pi **内置 provider** 的静态目录（同名 `registerProvider` 叠加，非空实时列表整体替换）。

**核心特性**

- **默认零过滤**：扩展对模型列表没有任何预设观点，过滤规则全部来自用户配置（glob / 正则、条目级 + 全局黑名单并集、exclude 永远优先、include 非空即白名单），并支持**字段级过滤** `includeBy`/`excludeBy`（对 live item 任意点路径做 glob 匹配，如 `owned_by`、`architecture.input_modalities`）与**可复用预设** `presets` + `filters.use`；
- **过滤可观测**：`/live-models` 显示 `raw -> kept` 统计，`/live-models-test <provider>` 干跑并逐模型标注保留/丢弃原因，`/live-models-refresh [ids...]` 绕过节流强制立即刷新；
- **凭据复用**：`/login` 存储凭据 → 条目 `apiKey` → `models.json` → `<PROVIDER>_API_KEY` 环境变量，四级链式解析，key 永不落日志；
- **元数据合并阶梯**：`defaults` < 静态定义 < 端点提示（含 OpenRouter `pricing.*` 价格，$/token 自动换算 $/1M；策略 `costFromLive`=`fill-zero`（默认，只补零不覆盖手写价格）/`always`/`off`）< `overrides[id]`；`mergeStatic: "union"` 可把 `models.json` 里定义但网关列表缺的模型也注册进来（同一套过滤，live 0 模型仍报错不顶包）；
- **永不清空目录**：过滤后 0 模型即报错保留原目录；网络故障回落磁盘缓存（v2 缓存存全量 raw items，按当前规则完整重建），网关挂掉重启也不会空白 `/model`；
- 零运行时依赖。

**安装**：`pi install npm:pi-live-models`，写好 `~/.pi/agent/live-models.json` 后重启 pi。配置字段、过滤语义、凭据链、配方示例见上方英文部分（表格与 Recipes 一一对应）。

**命令**：`/live-models`（状态）、`/live-models-reload`（重载配置）、`/live-models-test <provider>`（过滤干跑调参）、`/live-models-refresh [ids...]`（强制刷新）。

许可证：MIT。
