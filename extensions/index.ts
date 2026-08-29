/**
 * pi-live-models — live /v1/models discovery for pi providers.
 *
 * For every provider declared in `<agentDir>/live-models.json`, registers a
 * provider whose model list is refreshed live from the endpoint's
 * OpenAI-compatible GET /v1/models (or an explicit modelsUrl) whenever pi
 * opens /model. Works for custom gateways (models.json providers) and for
 * overriding built-in provider catalogs, because registerProvider() with the
 * same id layers on top of the composed base and a non-empty refreshModels()
 * result fully replaces the composed list.
 *
 * Key behaviors:
 *   - zero filtering by default; filters (glob + regex, per-entry and global
 *     blacklist union) are pure user config — see filters.ts;
 *   - credentials: /login stored key (context) -> entry apiKey spec ->
 *     models.json apiKey -> <PROVIDER>_API_KEY env; never logged;
 *   - metadata merge ladder: defaults < static (models.json/models-store.json)
 *     < live hints < public catalog (LiteLLM community data) < overrides[id]
 *     — see discover.ts; gateway-reported windows pass a sanity check first;
 *   - network failure falls back to the persisted last-good cache (re-filtered
 *     with current rules); a filter-empty result is a config intent error and
 *     never silently serves stale models;
 *   - a refresh that ends with 0 usable models throws, so pi keeps the
 *     previous catalog — /model is never emptied by accident.
 *
 * Commands:
 *   /live-models             provider + filter + last-discovery status
 *   /live-models-reload      re-read config and re-register immediately
 *   /live-models-test <id>   dry-run discovery with per-model keep/drop reasons
 *   /live-models-refresh [ids...] force an immediate refresh (bypasses throttling)
 *   /live-models-catalog     public metadata catalog status
 *   /live-models-catalog-refresh  force a catalog refetch
 *   /live-models-fix <id> <model> ctx=<n> [max=<n>]
 *                            write a metadata correction into overrides
 */
import fs from "node:fs";
import {
	applyFixToRawConfig,
	cachePath,
	catalogPath,
	configPath,
	loadConfigFile,
	type LiveModelsConfig,
	type ProviderEntry,
} from "./config.ts";
import { applyFilters, compileFilters, summarizeDrops, type CompiledFilters, type FilterOutcome } from "./filters.ts";
import {
	CONTEXT_WINDOW_MAX,
	CONTEXT_WINDOW_MIN,
	MAX_TOKENS_MAX,
	MAX_TOKENS_MIN,
	CATALOG_TTL_MS,
	buildCatalogIndex,
	createCatalogManager,
	ensureCatalogSoft,
	readCatalogCache,
	refreshCatalogNow,
	saneWindow,
	type CatalogManager,
} from "./catalog.ts";
import { buildCatalog, buildModelsUrl, collectStaticById, resolveApiKey, type ModelDef, type RefreshContext } from "./discover.ts";

/** Structural subset of pi's ExtensionAPI used by this extension. */
interface ExtensionAPI {
	registerProvider(id: string, config: Record<string, unknown>): unknown;
	registerCommand(name: string, definition: { description: string; handler: (args: string, ctx: CommandContext) => void | Promise<void> }): unknown;
	log?(message: string): void;
}

interface CommandContext {
	ui: { notify(message: string): unknown };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const LOG = "[pi-live-models]";
/** Cap for per-model lines in /live-models-test output. */
const TEST_LIST_LIMIT = 80;

interface ProviderRuntime {
	id: string;
	entry: ProviderEntry;
	filters: CompiledFilters;
	lastModels: ModelDef[] | null;
	lastSuccessAt: number;
	lastResult: { ok: boolean; at: string; detail: string } | null;
}

interface CacheEntry {
	at: string;
	url: string;
	/** v1 entries: merged ModelDef list (id-only re-filter on fallback). */
	models?: ModelDef[];
	/** v2 entries: raw endpoint items — fallback rebuilds through the full filter+merge pipeline. */
	raw?: unknown[];
}

interface CacheFile {
	version: 1 | 2;
	providers: Record<string, CacheEntry>;
}

/** Thrown when discovery succeeded but produced zero usable models — config intent, never cache-served. */
class FilterEmptyError extends Error {}

function readCache(): CacheFile {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
		if (raw && typeof raw === "object") {
			const version = (raw as { version?: unknown }).version;
			if (version === 1 || version === 2) {
				const providers = (raw as { providers?: unknown }).providers;
				if (providers && typeof providers === "object" && !Array.isArray(providers)) {
					return raw as CacheFile;
				}
			}
		}
	} catch {
		// missing or malformed cache — start fresh
	}
	return { version: 2, providers: {} };
}

function writeCache(cache: CacheFile): void {
	try {
		// Always persist as v2 (raw-items format), even when the in-memory file
		// was read from a v1 cache — the version marker must not lag behind.
		fs.writeFileSync(cachePath(), JSON.stringify({ version: 2, providers: cache.providers }, null, 2), "utf8");
	} catch (err) {
		console.warn(`${LOG} cache write failed:`, err instanceof Error ? err.message : err);
	}
}

function signalWithTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function modelsUrlOf(entry: ProviderEntry): string {
	return entry.modelsUrl ?? buildModelsUrl(entry.baseUrl);
}

/** One live discovery pass: fetch, filter, merge metadata, union static. Throws on any failure. */
async function discoverOnce(
	rt: ProviderRuntime,
	state: ExtensionState,
	context: RefreshContext | undefined,
): Promise<{ models: ModelDef[]; outcomes: FilterOutcome[]; url: string; raw: unknown[]; staticCount: number; warnings: string[] }> {
	const url = modelsUrlOf(rt.entry);
	const key = context?.credential?.key ?? resolveApiKey(rt.id, rt.entry);
	const headers: Record<string, string> = { ...(rt.entry.headers ?? {}) };
	if (key) headers.Authorization = `Bearer ${key}`;

	let response: Response;
	try {
		response = await fetch(url, {
			headers,
			signal: signalWithTimeout(rt.entry.timeoutMs ?? DEFAULT_TIMEOUT_MS, context?.signal),
		});
	} catch (err) {
		throw new Error(`fetch ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		const hint = response.status === 401 || response.status === 403
			? " (auth failed — check apiKey / /login credential)"
			: "";
		throw new Error(`GET ${url} -> HTTP ${response.status}${hint}`);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error(`GET ${url} -> response body is not valid JSON`);
	}
	const envelope = payload as { data?: unknown; models?: unknown };
	const items: unknown[] = Array.isArray(envelope?.data)
		? envelope.data
		: Array.isArray(envelope?.models)
			? envelope.models
			: Array.isArray(payload)
				? payload
				: [];

	const staticById = collectStaticById(rt.id);
	// Public catalog enrichment: soft-ensure (disk load + background refresh,
	// never blocking on the network), then exact-normalized lookup per model.
	const catalogData = rt.entry.catalog !== false ? ensureCatalogSoft(state.cat) : null;
	const catalogIndex = catalogData ? buildCatalogIndex(catalogData.models) : undefined;
	const { liveModels, outcomes, staticModels, warnings } = buildCatalog(items, {
		entry: rt.entry,
		filters: rt.filters,
		staticById,
		providerId: rt.id,
		catalog: catalogIndex,
	});

	// A zero-model LIVE result is a gateway/filter problem — static-only models
	// from mergeStatic:"union" must never paper over it.
	if (liveModels.length === 0) {
		if (outcomes.length === 0) {
			throw new FilterEmptyError(`0 usable models returned by ${url} — keeping previous catalog`);
		}
		const summary = summarizeDrops(outcomes);
		const drops = summary.drops.map((d) => `${d.reason} ×${d.count}`).join(", ");
		throw new FilterEmptyError(`0 models survived filters from ${url} — dropped: ${drops} — keeping previous catalog`);
	}
	return { models: [...liveModels, ...staticModels], outcomes, url, raw: items, staticCount: staticModels.length, warnings };
}

function makeRefreshModels(rt: ProviderRuntime, state: ExtensionState): (context: RefreshContext) => Promise<ModelDef[]> {
	return async (context: RefreshContext) => {
		// Captures `state` (not a cache instance): /live-models-reload swaps
		// state.cache in place, so even in-flight closures created before the
		// reload read+write the CURRENT cache instance — no stale-instance
		// full-file write can roll back newer entries.
		const interval = rt.entry.refreshIntervalMs ?? 0;
		if (interval > 0 && rt.lastModels && Date.now() - rt.lastSuccessAt < interval) {
			return rt.lastModels;
		}
		try {
			const { models, outcomes, url, raw, staticCount } = await discoverOnce(rt, state, context);
			rt.lastModels = models;
			rt.lastSuccessAt = Date.now();
			const summary = summarizeDrops(outcomes);
			const filterNote = summary.raw > summary.kept ? ` (filters: ${summary.raw} raw -> ${summary.kept} kept)` : "";
			const staticNote = staticCount > 0 ? ` (+${staticCount} static-only)` : "";
			rt.lastResult = { ok: true, at: new Date().toISOString(), detail: `${models.length} models${staticNote}${filterNote}` };
			state.cache.providers[rt.id] = { at: rt.lastResult.at, url, raw };
			writeCache(state.cache);
			return models;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Caller-aborted refresh (e.g. list mode, /model closed mid-flight):
			// not a provider failure — rethrow without cache fallback or warnings.
			if (context?.signal?.aborted) {
				rt.lastResult = { ok: false, at: new Date().toISOString(), detail: `aborted: ${message}` };
				throw err;
			}
			rt.lastResult = { ok: false, at: new Date().toISOString(), detail: message };
			if (err instanceof FilterEmptyError) throw err;
			// Network/HTTP/JSON failure: serve the persisted last-good list,
			// re-filtered with the CURRENT rules so config changes are honored.
			const cached = state.cache.providers[rt.id];
			if (cached?.raw?.length) {
				// v2 cache: rebuild through the full pipeline (field filters,
				// merge ladder, union) from the raw items.
				const { liveModels, staticModels } = buildCatalog(cached.raw, { entry: rt.entry, filters: rt.filters, staticById: collectStaticById(rt.id), providerId: rt.id, catalog: rt.entry.catalog !== false && state.cat.data ? buildCatalogIndex(state.cat.data.models) : undefined });
				if (liveModels.length) {
					const models = [...liveModels, ...staticModels];
					rt.lastModels = models;
					rt.lastResult = { ok: true, at: new Date().toISOString(), detail: `serving cached ${models.length} models from ${cached.at} (${message})` };
					console.warn(`${LOG} ${rt.id}: ${message} -> serving cached ${models.length} models from ${cached.at}`);
					return models;
				}
			}
			if (cached?.models?.length) {
				// v1 cache: merged defs only — re-filter by id, best effort.
				const models = cached.models.filter((m) => applyFilters(m.id, rt.filters).kept);
				if (models.length) {
					rt.lastModels = models;
					rt.lastResult = { ok: true, at: new Date().toISOString(), detail: `serving cached ${models.length} models from ${cached.at} (${message})` };
					console.warn(`${LOG} ${rt.id}: ${message} -> serving cached ${models.length} models from ${cached.at}`);
					return models;
				}
			}
			throw err;
		}
	};
}

interface ExtensionState {
	config: LiveModelsConfig;
	runtimes: Map<string, ProviderRuntime>;
	/** Single shared cache instance — re-read on /live-models-reload. */
	cache: CacheFile;
	/** Public metadata catalog — disk-backed, survives reloads (not swapped). */
	cat: CatalogManager;
}

function buildState() {
	const { config, issues, skipped } = loadConfigFile();
	for (const issue of issues) console.warn(`${LOG} config: ${issue.message}`);
	if (skipped.length) console.warn(`${LOG} skipped provider(s): ${skipped.join(", ")}`);
	const runtimes = new Map<string, ProviderRuntime>();
	for (const [id, entry] of Object.entries(config.providers)) {
		const filters = compileFilters(`${id}.filters`, entry.filters, config.defaultFilters);
		for (const bad of filters.invalid) {
			console.warn(`${LOG} invalid regex in ${bad.where}: "${bad.pattern}" (${bad.error}) — pattern ignored`);
		}
		runtimes.set(id, { id, entry, filters, lastModels: null, lastSuccessAt: 0, lastResult: null });
	}
	return { config, runtimes };
}

function registerAll(pi: ExtensionAPI, state: ExtensionState): void {
	for (const rt of state.runtimes.values()) {
		const cfg: Record<string, unknown> = {
			baseUrl: rt.entry.baseUrl,
			refreshModels: makeRefreshModels(rt, state),
		};
		if (rt.entry.api) cfg.api = rt.entry.api;
		if (rt.entry.name) cfg.name = rt.entry.name;
		pi.registerProvider(rt.id, cfg);
	}
	pi.log?.(`${LOG} registered ${state.runtimes.size} provider(s): ${[...state.runtimes.keys()].join(", ") || "(none)"}`);
}

function filtersSummaryLine(rt: ProviderRuntime): string {
	const includeCount = rt.filters.patterns.filter((p) => p.list === "include").length;
	const excludeCount = rt.filters.patterns.filter((p) => p.list === "exclude").length;
	const byParts: string[] = [];
	if (rt.filters.includeBy.length) byParts.push(`includeBy[${rt.filters.includeBy.map((r) => r.field).join(",")}]`);
	if (rt.filters.excludeBy.length) byParts.push(`excludeBy[${rt.filters.excludeBy.map((r) => r.field).join(",")}]`);
	if (!includeCount && !excludeCount && !byParts.length) return "filters: none (all models pass)";
	return `filters: ${includeCount} include / ${excludeCount} exclude pattern(s)${byParts.length ? ` + ${byParts.join(" + ")}` : ""}${rt.filters.invalid.length ? ` (+${rt.filters.invalid.length} invalid ignored)` : ""}`;
}

function statusLine(rt: ProviderRuntime): string {
	const url = modelsUrlOf(rt.entry);
	const api = rt.entry.api ? ` (${rt.entry.api})` : "";
	const modes: string[] = [];
	if (rt.entry.mergeStatic === "union") modes.push("mergeStatic=union");
	if (rt.entry.costFromLive && rt.entry.costFromLive !== "fill-zero") modes.push(`costFromLive=${rt.entry.costFromLive}`);
	const lines = [`${rt.id}${api}`, `  ${url}`];
	if (modes.length) lines.push(`  mode: ${modes.join(" ")}`);
	lines.push(`  ${filtersSummaryLine(rt)}`);
	if (!rt.lastResult) {
		lines.push("  (not refreshed yet — open /model or restart pi)");
	} else if (rt.lastResult.ok) {
		lines.push(`  OK: ${rt.lastResult.detail} @ ${rt.lastResult.at}`);
	} else {
		lines.push(`  ERROR: ${rt.lastResult.detail} @ ${rt.lastResult.at}`);
	}
	return lines.join("\n");
}

export default function liveModelsExtension(pi: ExtensionAPI): void {
	const state: ExtensionState = { ...buildState(), cache: readCache(), cat: createCatalogManager() };
	registerAll(pi, state);

	pi.registerCommand("live-models", {
		description: "Show pi-live-models providers, filters, and last live-discovery status",
		handler: (_args, ctx) => {
			const ids = [...state.runtimes.keys()];
			if (!ids.length) {
				ctx.ui.notify(`${LOG} No providers configured in ${configPath()}`);
				return;
			}
			ctx.ui.notify([`${LOG} status`, ...ids.map((id) => statusLine(state.runtimes.get(id)!))].join("\n\n"));
		},
	});

	pi.registerCommand("live-models-reload", {
		description: "Reload live-models.json and re-register providers (takes effect immediately)",
		handler: async (_args, ctx) => {
			const next: ExtensionState = { ...buildState(), cache: readCache(), cat: state.cat };
			// Mutate the long-lived `state` in place BEFORE registering, so every
			// closure (including ones from earlier reloads) keeps reading the
			// same state object — passing `next` itself would strand prior
			// generations on stale cache instances. `cat` is deliberately kept:
			// the catalog manager is disk-backed and has no per-config lifetime.
			state.config = next.config;
			state.runtimes = next.runtimes;
			state.cache = next.cache;
			registerAll(pi, state);
			ctx.ui.notify(`${LOG} reloaded ${configPath()}\n${state.runtimes.size} provider(s) re-registered. Open /model to trigger live discovery.`);
		},
	});

	pi.registerCommand("live-models-test", {
		description: "Dry-run live discovery for one provider and show per-model keep/drop reasons",
		handler: async (args, ctx) => {
			const id = args.trim().split(/\s+/)[0] ?? "";
			if (!id) {
				ctx.ui.notify(`Usage: /live-models-test <provider>\nConfigured: ${[...state.runtimes.keys()].join(", ") || "(none)"}`);
				return;
			}
			const rt = state.runtimes.get(id);
			if (!rt) {
				ctx.ui.notify(`${LOG} provider "${id}" is not configured.\nConfigured: ${[...state.runtimes.keys()].join(", ") || "(none)"}`);
				return;
			}
			ctx.ui.notify(`${LOG} testing ${id} — ${modelsUrlOf(rt.entry)} ...`);
			try {
				const { models, outcomes, url, staticCount, warnings } = await discoverOnce(rt, state, undefined);
				const summary = summarizeDrops(outcomes);
				const lines = outcomes.slice(0, TEST_LIST_LIMIT).map((outcome) => {
					if (outcome.kept) return outcome.reason ? `  + ${outcome.id}  (kept by ${outcome.reason})` : `  + ${outcome.id}`;
					return `  - ${outcome.id}  -> dropped by ${outcome.reason}`;
				});
				if (outcomes.length > TEST_LIST_LIMIT) lines.push(`  ... and ${outcomes.length - TEST_LIST_LIMIT} more`);
				const preview = models.slice(0, 3).map((m) => `  ${m.id}: ctx=${m.contextWindow} (${m.ctxSource ?? "?"}) max=${m.maxTokens} (${m.maxSource ?? "?"}) cost=${m.cost.input}/${m.cost.output} $/1M input=${m.input.join("+")}`);
				ctx.ui.notify(
					[
						`${LOG} ${id} dry-run — ${url}`,
						...lines,
						`summary: ${summary.raw} raw -> ${summary.kept} kept (${summary.raw - summary.kept} dropped)`,
						...(staticCount > 0 ? [`+${staticCount} static-only model(s) added by mergeStatic=union`] : []),
						...(preview.length ? ["metadata preview:", ...preview] : []),
						...(warnings.length ? ["warnings:", ...warnings] : []),
					].join("\n"),
				);
			} catch (err) {
				ctx.ui.notify(`${LOG} ${id} dry-run failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerCommand("live-models-refresh", {
		description: "Force an immediate live refresh, bypassing refreshIntervalMs (no argument = all providers)",
		handler: async (args, ctx) => {
			const wanted = args.trim().split(/\s+/).filter(Boolean);
			const unknown = wanted.filter((id) => !state.runtimes.has(id));
			if (unknown.length) {
				ctx.ui.notify(`${LOG} unknown provider(s): ${unknown.join(", ")}\nConfigured: ${[...state.runtimes.keys()].join(", ") || "(none)"}`);
				return;
			}
			const targets = (wanted.length ? wanted : [...state.runtimes.keys()]).map((id) => state.runtimes.get(id)!);
			if (!targets.length) {
				ctx.ui.notify(`${LOG} No providers configured in ${configPath()}`);
				return;
			}
			const lines: string[] = [];
			for (const rt of targets) {
				try {
					const { models, raw, url, staticCount, warnings } = await discoverOnce(rt, state, undefined);
					rt.lastModels = models;
					rt.lastSuccessAt = Date.now();
					rt.lastResult = { ok: true, at: new Date().toISOString(), detail: `${models.length} models${staticCount > 0 ? ` (+${staticCount} static-only)` : ""}` };
					state.cache.providers[rt.id] = { at: rt.lastResult.at, url, raw };
					lines.push(`  OK   ${rt.id}: ${rt.lastResult.detail}`);
					for (const w of warnings) lines.push(`  ⚠    ${w}`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					rt.lastResult = { ok: false, at: new Date().toISOString(), detail: msg };
					lines.push(`  FAIL ${rt.id}: ${msg}`);
				}
			}
			writeCache(state.cache);
			ctx.ui.notify(`${LOG} forced refresh\n${lines.join("\n")}`);
		},
	});

	pi.registerCommand("live-models-catalog", {
		description: "Show public metadata catalog status (source, cache age, entries)",
		handler: (_args, ctx) => {
			const data = state.cat.data ?? readCatalogCache();
			if (!data) {
				ctx.ui.notify(`${LOG} catalog: not loaded yet — fetched in the background on first discovery.\nRun /live-models-catalog-refresh to fetch it now.`);
				return;
			}
			const ageH = Math.round((Date.now() - data.fetchedAt) / 3_600_000);
			const idx = buildCatalogIndex(data.models);
			ctx.ui.notify(
				[
					`${LOG} catalog`,
					`  source: ${data.url}`,
					`  fetched: ${new Date(data.fetchedAt).toISOString()} (${ageH < 1 ? "<1h" : `${ageH}h`} ago)`,
					`  entries: ${Object.keys(data.models).length} models`,
				`  arbitration: ${idx.byKey.size} matchable / ${idx.divergent.size} divergent (skipped+warned) / ${idx.unverified.size} unverified (lone third-party, silent)`,
					`  cache: ${catalogPath()}`,
					`  refreshed in the background every ${Math.round(CATALOG_TTL_MS / 86_400_000)}d`,
				].join("\n"),
			);
		},
	});

	pi.registerCommand("live-models-catalog-refresh", {
		description: "Force a refetch of the public metadata catalog",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${LOG} refreshing catalog ...`);
			try {
				const data = await refreshCatalogNow(state.cat);
				ctx.ui.notify(`${LOG} catalog refreshed\n  source: ${data.url}\n  entries: ${Object.keys(data.models).length} models\n  cache: ${catalogPath()}`);
			} catch (err) {
				ctx.ui.notify(`${LOG} catalog refresh failed: ${err instanceof Error ? err.message : err}`);
			}
		},
	});

	pi.registerCommand("live-models-fix", {
		description: "Write a metadata correction into overrides: /live-models-fix <provider> <model> ctx=<n> [max=<n>]",
		handler: (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [providerId, modelId, ...kvArgs] = tokens;
			if (!providerId || !modelId || !kvArgs.length) {
				ctx.ui.notify(`Usage: /live-models-fix <provider> <model> ctx=<n> [max=<n>]\nExample: /live-models-fix GLM glm-4.6 ctx=200000\nConfigured: ${[...state.runtimes.keys()].join(", ") || "(none)"}`);
				return;
			}
			if (!state.runtimes.has(providerId)) {
				ctx.ui.notify(`${LOG} provider "${providerId}" is not configured.\nConfigured: ${[...state.runtimes.keys()].join(", ") || "(none)"}`);
				return;
			}
			const patch: { contextWindow?: number; maxTokens?: number } = {};
			for (const kv of kvArgs) {
				const match = /^(ctx|max)=(\d+)$/.exec(kv);
				if (!match) {
					ctx.ui.notify(`${LOG} bad argument "${kv}" — expected ctx=<n> or max=<n> (positive integers)`);
					return;
				}
				const value = Number(match[2]);
				if (match[1] === "ctx") {
					if (!saneWindow(value, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX)) {
						ctx.ui.notify(`${LOG} ctx must be an integer in [${CONTEXT_WINDOW_MIN}, ${CONTEXT_WINDOW_MAX}]`);
						return;
					}
					patch.contextWindow = value;
				} else {
					if (!saneWindow(value, MAX_TOKENS_MIN, MAX_TOKENS_MAX)) {
						ctx.ui.notify(`${LOG} max must be an integer in [${MAX_TOKENS_MIN}, ${MAX_TOKENS_MAX}]`);
						return;
					}
					patch.maxTokens = value;
				}
			}
			// The model must be known to this provider (last live list or cache) —
			// unless nothing has been discovered yet, in which case trust the user.
			const known = new Set((state.runtimes.get(providerId)!.lastModels ?? []).map((m) => m.id));
			for (const item of state.cache.providers[providerId]?.raw ?? []) {
				const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
				if (typeof id === "string") known.add(id);
			}
			if (known.size > 0 && !known.has(modelId)) {
				ctx.ui.notify(`${LOG} model "${modelId}" is not in ${providerId}'s list — run /live-models-test ${providerId} to see the ids.`);
				return;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
			} catch (err) {
				ctx.ui.notify(`${LOG} cannot read ${configPath()}: ${err instanceof Error ? err.message : err}`);
				return;
			}
			const result = applyFixToRawConfig(raw, providerId, modelId, patch);
			if (!result.ok) {
				ctx.ui.notify(`${LOG} ${result.error}`);
				return;
			}
			try {
				const tmp = `${configPath()}.tmp`;
				fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
				fs.renameSync(tmp, configPath());
			} catch (err) {
				try {
					fs.rmSync(`${configPath()}.tmp`, { force: true });
				} catch {
					/* best effort */
				}
				ctx.ui.notify(`${LOG} failed to write ${configPath()}: ${err instanceof Error ? err.message : err}`);
				return;
			}
			const parts: string[] = [];
			if (patch.contextWindow !== undefined) parts.push(`contextWindow=${patch.contextWindow}`);
			if (patch.maxTokens !== undefined) parts.push(`maxTokens=${patch.maxTokens}`);
			ctx.ui.notify(`${LOG} wrote ${providerId}.overrides.${modelId} (${parts.join(", ")})\nRun /live-models-reload to apply.`);
		},
	});
}