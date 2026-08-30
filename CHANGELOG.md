# Changelog

## [0.3.3] - 2026-08-30

Bootstrap UX: stop re-typing what `models.json` already knows.

### Added

- **`baseUrl` inheritance** — a provider entry may omit `baseUrl` and inherits it from the same-id provider in `models.json`. Explicit values always win; a present-but-invalid `baseUrl` is never silently inherited (you get the field-precise error instead). Together with the existing credential ladder (`/login` → entry `apiKey` → `models.json` → env), a minimal declaration is now `{ "providers": { "MYGATEWAY": {} } }`.
- **`/live-models-init`** — one-command bootstrap on a new machine: writes a `{ baseUrl }` stub for every `models.json` provider not yet configured (idempotent — existing entries are never overwritten, a broken config file is never clobbered, prototype-reserved ids are rejected), then re-registers immediately. Pure planning logic (`computeInitPlan` / `applyInitToRawConfig`) is exported and unit-tested.

### Changed

- `/live-models-reload` and `/live-models-init` share one reload path (`reloadState`) — the mutate-in-place state semantics documented for reload now apply verbatim to post-init re-registration.
- Missing-`baseUrl` skip messages now name the inheritance source when a `models.json` lookup was attempted (`no usable "X" provider in models.json to inherit from`).

### Fixed

- A `providers` key naming `__proto__` / `constructor` / `prototype` in `live-models.json` (possible via `JSON.parse`) used to re-`[[Prototype]]` the parsed map and silently vanish — it now gets a field-precise issue and is skipped like any other invalid entry. Init's plan and apply existence checks are aligned on `hasOwnProperty` so a pathological models.json provider id can never make the success notice over-report.

## [0.3.2] - 2026-08-29

Second catalog source (Models.dev) + tolerance-based merging.

### Added

- **Models.dev as a second, independent catalog source** (~7300 entries from 200+ providers, indexed from official documentation with fast coverage of new releases — observed: a model indexed 3 days after launch). Each source has its own fetch path, disk cache (`live-models-catalog-modelsdev.json`), 7-day staleness clock and failure backoff; one source being down never affects the other. `/live-models-catalog` shows both sources; `/live-models-catalog-refresh` refetches both (partial failure still applies the successful one). Real-data effect: normalized coverage grew from ~3000 to ~10300 matchable keys.

### Changed

- **Tolerance-based merging**: vendor candidates and the no-vendor consensus tier now compare values per field within a 5% relative tolerance — rounding differences between catalogs (litellm's decimal `200000/128000` vs models.dev's binary-exact `204800/131072`) are not disagreements — and merge to the conservative minimum (a too-small cap merely limits output; a too-large one hard-fails gateways). Real-data effect: `glm-5.1` and `glm-4.7-flash` went from divergent to matched.
- **Models.dev entries never claim vendor status**: its 200+ namespaces include many resellers listing the same bare ids as the vendor's own namespace (`vancine/glm-5.3-flash` vs `zai/glm-5.3-flash`) and nothing in the data distinguishes vendor from reseller. Models.dev contributes consensus/divergence signals and new-model coverage, never unvetted authority — `glm-5.3-flash` therefore surfaces an honest divergence warning (showing the official-shape value) instead of silently trusting any single platform limit.
- README: dual-source documentation + an Acknowledgments section crediting both catalog projects.

## [0.3.1] - 2026-08-29

Catalog arbitration: vendor truth first, consensus second, disagreement warns.

### Fixed

- **Normalized-key arbitration** (incident: `glm-5.3-flash` matched a lone hosted deployment and reported `maxTokens=1048575`, blowing past gateways that cap `max_tokens` at 131072 → hard 400s). Normalized lookups are now arbitrated in tiers:
  1. **Vendor entry wins** — a two-segment `vendor/model` catalog key whose `litellm_provider` matches the prefix (e.g. `zai/glm-4.6`) is the vendor's own number and beats every hosted deployment; conflicting vendor entries abstain.
  2. **No vendor → consensus** — independent sources must agree on the values.
  3. **Disagreement → abstain + warn** — the model falls back to the static/live ladder; the warning lists the competing values with a ready-made `/live-models-fix` hint.
  4. A **lone third-party deployment** (no vendor entry, nothing to cross-check) is silently skipped and counted.
- Catalog entries now retain `litellm_provider` (the catalog's own source attribution). Old 0.3.0 disk caches lack it and simply degrade to consensus/arbitration until the next background refresh.
- `/live-models-catalog` shows arbitration totals (matchable / divergent / unverified).

## [0.3.0] - 2026-08-29

Public metadata catalog (gateway cross-check), README preview image, and three new commands.

### Added

- **Public metadata catalog** — a background-fetched community catalog (LiteLLM's `model_prices_and_context_window.json`, ~2500 chat models) cross-checks gateway-reported metadata. Sources: jsDelivr CDN → raw.githubusercontent.com fallback (20 s timeout each); disk cache `~/.pi/agent/live-models-catalog.json` with a 7-day TTL and a 30-minute retry backoff after failures; never blocks discovery. Matching is exact-name only (provider prefixes, `:suffix` tags and date suffixes normalized for lookup; an exact catalog key always beats a normalized one); chat-mode entries (entries without a `mode` field are kept); values must pass sanity windows. New merge-ladder layer between live hints and overrides — a catalog value beats the gateway's claim, and your `overrides[id]` still win. Opt out per provider with `"catalog": false` (also suppresses catalog warnings).
- **Sanity windows on live metadata** — live `context_length`/`max_tokens`-family values must be integers in 1,024–10,000,000 (context) / 128–10,000,000 (max output) to win a ladder layer; implausible values (`0`, `100`, `1e12`, floats) fall through instead of poisoning metadata.
- **Catalog warnings** — surfaced by `/live-models-test` and `/live-models-refresh` (capped at 6 warnings, plus an omission notice): gateway context diverging ≥4× from the catalog in either direction (with a ready-made `/live-models-fix <provider> <model> ctx=<catalog value>` hint), and uniform placeholder detection (≥3 kept models sharing one identical live context value — the classic relay stamp).
- **`/live-models-catalog`** — catalog status: source URL, cache age, entry count, cache path.
- **`/live-models-catalog-refresh`** — force a blocking catalog refetch.
- **`/live-models-fix <provider> <model> ctx=<n> [max=<n>]`** — write a metadata correction into `overrides` in `live-models.json` (JSON-preserve write via tmp+rename; sibling fields and key order untouched). Validates the provider, sanity windows, and the provider's known model ids (last live list ∪ persisted cache; skipped when nothing has been discovered yet).
- **`pi.image`** — package preview image on the pi package gallery.
- README preview image (en/zh).

### Changed

- Metadata merge ladder is now six layers (low → high): `entry.defaults` < static definitions < live hints < **public catalog** < `entry.overrides[id]` < pi-safe fallback, with sanity windows guarding the live layer.
- `/live-models-test` metadata preview now annotates each field's winning source: `ctx=202800 (catalog)`, `max=… (live)`.

## [0.2.0] - 2026-08-29

Filter presets, field-level filtering, live pricing, static union, and a forced-refresh command.

### Added

- **Filter presets** — top-level `presets` map + `filters.use` / `defaultFilters.use`: reusable named filter specs, unioned field-by-field during parsing. Presets cannot reference presets (warned + ignored). `defaultFilters` accepts blacklist contributions only — include-style fields written directly or contributed by a preset are warned + ignored, so a global default can never create a whitelist.
- **Field-level filtering** — `filters.includeBy` / `filters.excludeBy`: case-insensitive globs keyed by dotted paths into the live `/v1/models` item (e.g. `owned_by`, `architecture.input_modalities`). Exclude rules OR; include rules AND with each other and with id includes; missing fields / non-string values never match excludes and always fail includes (`includeBy-miss:<field>` drop reason). String globs only in v0.2 — no numeric ranges. `defaultFilters.excludeBy` joins the global blacklist union.
- **Live pricing → cost** (`costFromLive`) — OpenRouter-style `pricing.prompt` / `pricing.completion` / `pricing.prompt_cache_read` (strict decimal $/token strings) are converted to $/1M and fill `cost`. `"fill-zero"` (default) fills only when no other source (override/static/defaults) defines cost; `"always"` lets live pricing beat static/defaults key by key (a live entry reporting only `pricing.prompt` keeps static output prices; overrides still win); `"off"` ignores it. Explicit `"0"` (free tier) is a valid live cost. `/live-models-test` preview now shows cost.
- **`mergeStatic: "union"`** — also register models that exist in `models.json`/`models-store.json` but are missing from the gateway's live list (same filters apply, static def acts as the field source for `*By` rules). A zero-model live result still throws — union supplements, never papers over a broken gateway. Status shows `+N static-only`.
- **`/live-models-refresh [ids...]`** — force an immediate refresh bypassing `refreshIntervalMs` (no argument = all providers). Success updates the in-memory catalog and persisted cache; failures are reported verbatim without cache fallback.

### Changed

- Offline cache format v2: entries now persist the **raw endpoint items** so the fallback path rebuilds through the full pipeline (field filters, merge ladder, union) with current rules, instead of re-filtering merged defs by id only. v1 caches remain readable (best-effort id-only re-filter) and entries upgrade to v2 on the next successful refresh (the version marker is rewritten on the first cache write).
- Single shared cache instance across the extension lifetime; refresh closures capture the long-lived state object (swapped in place on reload), so entries written by in-flight refreshes cannot be rolled back by a stale full-file write across reloads. (Providers removed from the config in a later reload cannot be un-registered — a pi `registerProvider` limitation — their stale closures simply keep the previous catalog.)
- Duplicate live ids (gateway aliasing) are deduplicated — first occurrence wins.
- `buildCatalog()` extracted as a pure function (live discovery, cache rebuild, and tests share one pipeline).

## [0.1.0] - 2026-08-29

Initial release.

### Added

- Live `/v1/models` discovery for any config-declared provider: custom OpenAI-compatible / Anthropic gateways from `models.json`, and built-in provider catalog overrides (same-id `registerProvider` layering).
- Config-driven filter subsystem — zero filtering by default:
  - `filters.include` / `filters.exclude` — glob patterns on model id, case-insensitive;
  - `filters.includeRegex` / `filters.excludeRegex` — regular expressions, case-sensitive;
  - top-level `defaultFilters.exclude` / `defaultFilters.excludeRegex` — global blacklist, unioned with per-provider excludes;
  - exclude always wins over include; non-empty include set acts as whitelist; invalid regexes are reported and ignored instead of breaking the config.
- Filter observability: `/live-models` shows `raw → kept` statistics per provider; `/live-models-test <provider>` performs a dry-run discovery and annotates every model with keep/drop reason.
- Four-level credential resolution for discovery requests: `/login` stored credential → entry `apiKey` (`$ENV` / `${ENV}` / `!command` / literal) → `models.json` provider `apiKey` → `<PROVIDER>_API_KEY` environment fallback. Keys are never written to logs or errors.
- Metadata merge ladder (low → high): entry `defaults` < static definitions (`models.json` + `models-store.json`, matched by id) < live endpoint hints (`context_length`, `max_completion_tokens`, OpenRouter `top_provider.*`) < entry `overrides[id]`.
- Offline cache (`~/.pi/agent/live-models-cache.json`): last good list per provider is persisted and re-filtered with current rules on network failure, so a gateway outage never empties the catalog after a restart.
- Per-entry `timeoutMs` (default 10 s) and optional `refreshIntervalMs` throttling (default 0 = refresh on every `/model` open).
- Strict config validation with field-precise warnings; invalid fields degrade gracefully, only entries without a usable `baseUrl` are skipped.
- Caller-aborted refreshes (list mode, `/model` closed mid-flight) are rethrown as-is — no warnings, no cache fallback — instead of masquerading as provider failures.
- Zero runtime dependencies; TypeScript; unit tests (`node:test` via tsx) and CI matrix (Windows + Ubuntu).

### Migration

Supersedes the single-file `~/.pi/agent/extensions/pi-live-models/` extension and the tvt-specific `pi-tvt-models` factory extension. Existing `~/.pi/agent/live-models.json` configs keep working unchanged.
