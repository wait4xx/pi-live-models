# pi-live-models

[![npm](https://img.shields.io/npm/v/pi-live-models)](https://www.npmjs.com/package/pi-live-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built for pi](https://img.shields.io/badge/Built%20for%20pi-green)](https://github.com/earendil-works/pi)
[![CI](https://github.com/wait4xx/pi-live-models/actions/workflows/ci.yml/badge.svg)](https://github.com/wait4xx/pi-live-models/actions/workflows/ci.yml)

**English** · [简体中文](README.zh-CN.md)

Live `/v1/models` discovery for [pi](https://github.com/earendil-works/pi) — make every provider's model list reflect what the endpoint **actually serves**, refreshed every time you open `/model`.

Works with **any** OpenAI-compatible or Anthropic-protocol gateway (OpenRouter, relay services, vLLM, LiteLLM, LM Studio, cloud vendors, …), **and** overrides the static catalogs of pi's **built-in** providers — `registerProvider()` with the same id layers on top of the composed base, and a non-empty live list fully replaces it.

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
