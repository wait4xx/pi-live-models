# Changelog

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
- Zero runtime dependencies; TypeScript; unit tests (`node:test` via tsx) and CI matrix (Windows + Ubuntu).

### Migration

Supersedes the single-file `~/.pi/agent/extensions/pi-live-models/` extension and the tvt-specific `pi-tvt-models` factory extension. Existing `~/.pi/agent/live-models.json` configs keep working unchanged.
