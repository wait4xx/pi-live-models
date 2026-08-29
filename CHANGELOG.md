# Changelog

## [0.2.0] - 2026-08-29

Filter presets, field-level filtering, live pricing, static union, and a forced-refresh command.

### Added

- **Filter presets** — top-level `presets` map + `filters.use` / `defaultFilters.use`: reusable named filter specs, unioned field-by-field during parsing. Presets cannot reference presets (warned + ignored). `defaultFilters` accepts blacklist contributions only — include-style fields written directly or contributed by a preset are warned + ignored, so a global default can never create a whitelist.
- **Field-level filtering** — `filters.includeBy` / `filters.excludeBy`: case-insensitive globs keyed by dotted paths into the live `/v1/models` item (e.g. `owned_by`, `architecture.input_modalities`). Exclude rules OR; include rules AND with each other and with id includes; missing fields / non-string values never match excludes and always fail includes (`includeBy-miss:<field>` drop reason). String globs only in v0.2 — no numeric ranges. `defaultFilters.excludeBy` joins the global blacklist union.
- **Live pricing → cost** (`costFromLive`) — OpenRouter-style `pricing.prompt` / `pricing.completion` / `pricing.prompt_cache_read` ($/token strings) are converted to $/1M and fill `cost`. `"fill-zero"` (default) fills only when no other source (override/static/defaults) defines cost; `"always"` lets live pricing beat static/defaults (overrides still win); `"off"` ignores it. Explicit `"0"` (free tier) is a valid live cost. `/live-models-test` preview now shows cost.
- **`mergeStatic: "union"`** — also register models that exist in `models.json`/`models-store.json` but are missing from the gateway's live list (same filters apply, static def acts as the field source for `*By` rules). A zero-model live result still throws — union supplements, never papers over a broken gateway. Status shows `+N static-only`.
- **`/live-models-refresh [ids...]`** — force an immediate refresh bypassing `refreshIntervalMs` (no argument = all providers). Success updates the in-memory catalog and persisted cache; failures are reported verbatim without cache fallback.

### Changed

- Offline cache format v2: entries now persist the **raw endpoint items** so the fallback path rebuilds through the full pipeline (field filters, merge ladder, union) with current rules, instead of re-filtering merged defs by id only. v1 caches remain readable (best-effort id-only re-filter) and are upgraded on the next successful refresh.
- Single shared cache instance across the extension lifetime (fixes a potential lost-update between `/live-models-reload` and background refreshes).
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
