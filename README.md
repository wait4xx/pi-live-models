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

- **Zero filtering by default** — the extension has no opinions about which models are "good". Every filter is yours: glob (`*audio*`), regex (`^glm-4\.`), per-entry or global blacklist union. Exclude always wins; a non-empty include set acts as a whitelist.
- **Filter observability** — `/live-models` shows `raw -> kept` statistics; `/live-models-test <provider>` dry-runs discovery and annotates every model with its keep/drop reason.
- **Credential reuse** — discovery reuses the key you already have: `/login` stored credential → entry `apiKey` → `models.json` `apiKey` → `<PROVIDER>_API_KEY` env. Keys never appear in logs or errors.
- **Metadata merge ladder** — `defaults` < static definitions (`models.json` + `models-store.json`, by id) < live endpoint hints (`context_length`, `max_completion_tokens`, OpenRouter `top_provider.*`) < `overrides[id]`. New models get sane fallbacks instead of blank metadata.
- **Never empties your catalog** — a refresh that yields 0 usable models throws and pi keeps the previous list; network failures fall back to a persisted last-good cache (re-filtered with your *current* rules), so a gateway outage never blanks `/model` after a restart.
- Zero runtime dependencies.

## Install

```bash
pi install npm:pi-live-models
# or from git:
pi install git:github.com/<you>/pi-live-models
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
| `defaultFilters` | object | Global filters. Only blacklists are supported (`exclude`, `excludeRegex`) — unioned with every provider's excludes. A global whitelist is intentionally not offered. |
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
| `defaults` | — | Metadata fallback for all models: `reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`. |
| `overrides` | — | Per-model-id metadata overrides: `{"qwen3.8-max":{"contextWindow":1000000}}`. |

### Filters

```jsonc
"filters": {
  "include":      ["*glm*"],            // glob whitelist, case-insensitive
  "exclude":      ["*audio*", "*tts*"], // glob blacklist
  "includeRegex": ["^glm-[\\d.]"],      // regex whitelist, case-sensitive
  "excludeRegex": ["^gpt-5\\.6$"]
}
```

Semantics (pinned by unit tests):

| Rule | Behavior |
|---|---|
| Nothing configured | **Every model passes.** Zero filtering is the default. |
| `exclude` / `excludeRegex` | A match on any exclude pattern (entry-level **or** global `defaultFilters`, unioned) drops the model. |
| Exclude precedence | Exclude always wins — an excluded model cannot be rescued by include. |
| Whitelist | If any include pattern exists (glob or regex, unioned), a model must match at least one to survive. |
| Case | Globs case-insensitive; regexes case-sensitive (use `(?i)` if needed). |
| Invalid regex | Reported at startup with its config location, then ignored — never breaks the config. |
| Everything filtered out | The refresh throws (pi keeps the previous catalog) and the error names the rules responsible. |

### Auth chain (discovery request)

1. `/login` stored credential (pi passes it in the refresh context)
2. entry `apiKey` spec — `$ENV` / `${ENV}` / `!command` / literal
3. `~/.pi/agent/models.json` → `providers[id].apiKey` (same spec syntax)
4. env `<PROVIDER_ID>` upper-cased, non-alnum → `_`, suffixed `_API_KEY`

⚠️ The `!command` form executes a shell command — only use it if you understand what it runs. Keys never appear in logs or errors; the cache file stores model metadata only, never credentials.

### Metadata merge ladder (low → high)

`entry.defaults` < static definitions (`models.json` entry + `models-store.json` cache, matched by id) < live endpoint hints (`context_length`, `context_window`, `max_model_len`, `max_completion_tokens`, `max_tokens`, OpenRouter `top_provider.*`) < `entry.overrides[id]`

Live-only models fall back to `defaults`, then to pi-safe values (`reasoning: true`, `input: ["text"]`, `contextWindow: 128000`, `maxTokens: 32768`, zero cost).

## Commands

| Command | Purpose |
|---|---|
| `/live-models` | Configured providers, models endpoint, filter summary, last discovery result (`raw -> kept` statistics). |
| `/live-models-reload` | Re-read the config file and re-register immediately (no restart). |
| `/live-models-test <provider>` | Dry-run one discovery: per-model `kept by …` / `dropped by …` annotation plus a metadata preview. |

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

- **默认零过滤**：扩展对模型列表没有任何预设观点，过滤规则全部来自用户配置（glob / 正则、条目级 + 全局黑名单并集、exclude 永远优先、include 非空即白名单）；
- **过滤可观测**：`/live-models` 显示 `raw -> kept` 统计，`/live-models-test <provider>` 干跑并逐模型标注保留/丢弃原因；
- **凭据复用**：`/login` 存储凭据 → 条目 `apiKey` → `models.json` → `<PROVIDER>_API_KEY` 环境变量，四级链式解析，key 永不落日志；
- **元数据合并阶梯**：`defaults` < 静态定义 < 端点提示 < `overrides[id]`，新模型也有合理兜底值；
- **永不清空目录**：过滤后 0 模型即报错保留原目录；网络故障回落磁盘缓存（按当前规则重过滤），网关挂掉重启也不会空白 `/model`；
- 零运行时依赖。

**安装**：`pi install npm:pi-live-models`，写好 `~/.pi/agent/live-models.json` 后重启 pi。配置字段、过滤语义、凭据链、配方示例见上方英文部分（表格与 Recipes 一一对应）。

**命令**：`/live-models`（状态）、`/live-models-reload`（重载配置）、`/live-models-test <provider>`（过滤干跑调参）。

许可证：MIT。
