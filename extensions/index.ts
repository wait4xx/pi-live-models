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
 *     < live hints < overrides[id] — see discover.ts;
 *   - network failure falls back to the persisted last-good cache (re-filtered
 *     with current rules); a filter-empty result is a config intent error and
 *     never silently serves stale models;
 *   - a refresh that ends with 0 usable models throws, so pi keeps the
 *     previous catalog — /model is never emptied by accident.
 *
 * Commands:
 *   /live-models            provider + filter + last-discovery status
 *   /live-models-reload     re-read config and re-register immediately
 *   /live-models-test <id>  dry-run discovery with per-model keep/drop reasons
 */
import fs from "node:fs";
import { cachePath, configPath, loadConfigFile, type LiveModelsConfig, type ProviderEntry } from "./config.ts";
import { applyFilters, compileFilters, summarizeDrops, type CompiledFilters, type FilterOutcome } from "./filters.ts";
import { buildModel, buildModelsUrl, collectStaticById, resolveApiKey, type ModelDef, type RefreshContext } from "./discover.ts";

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
	models: ModelDef[];
}

interface CacheFile {
	version: 1;
	providers: Record<string, CacheEntry>;
}

/** Thrown when discovery succeeded but produced zero usable models — config intent, never cache-served. */
class FilterEmptyError extends Error {}

function readCache(): CacheFile {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
		if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === 1) {
			const providers = (raw as { providers?: unknown }).providers;
			if (providers && typeof providers === "object" && !Array.isArray(providers)) {
				return raw as CacheFile;
			}
		}
	} catch {
		// missing or malformed cache — start fresh
	}
	return { version: 1, providers: {} };
}

function writeCache(cache: CacheFile): void {
	try {
		fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2), "utf8");
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

/** One live discovery pass: fetch, filter, merge metadata. Throws on any failure. */
async function discoverOnce(rt: ProviderRuntime, context: RefreshContext | undefined): Promise<{ models: ModelDef[]; outcomes: FilterOutcome[]; url: string }> {
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
	const outcomes: FilterOutcome[] = [];
	const models: ModelDef[] = [];
	for (const item of items) {
		const record: Record<string, unknown> = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		const id = typeof record.id === "string" && record.id
			? record.id
			: typeof record.name === "string" && record.name
				? record.name
				: "";
		if (!id) continue;
		const outcome = applyFilters(id, rt.filters);
		outcomes.push(outcome);
		if (outcome.kept) models.push(buildModel(id, record, rt.entry, staticById[id]));
	}

	if (models.length === 0) {
		if (outcomes.length === 0) {
			throw new FilterEmptyError(`0 usable models returned by ${url} — keeping previous catalog`);
		}
		const summary = summarizeDrops(outcomes);
		const drops = summary.drops.map((d) => `${d.reason} ×${d.count}`).join(", ");
		throw new FilterEmptyError(`0 models survived filters from ${url} — dropped: ${drops} — keeping previous catalog`);
	}
	return { models, outcomes, url };
}

function makeRefreshModels(rt: ProviderRuntime, cache: CacheFile): (context: RefreshContext) => Promise<ModelDef[]> {
	return async (context: RefreshContext) => {
		const interval = rt.entry.refreshIntervalMs ?? 0;
		if (interval > 0 && rt.lastModels && Date.now() - rt.lastSuccessAt < interval) {
			return rt.lastModels;
		}
		try {
			const { models, outcomes, url } = await discoverOnce(rt, context);
			rt.lastModels = models;
			rt.lastSuccessAt = Date.now();
			const summary = summarizeDrops(outcomes);
			const filterNote = summary.raw > summary.kept ? ` (filters: ${summary.raw} raw -> ${summary.kept} kept)` : "";
			rt.lastResult = { ok: true, at: new Date().toISOString(), detail: `${models.length} models${filterNote}` };
			cache.providers[rt.id] = { at: rt.lastResult.at, url, models };
			writeCache(cache);
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
			const cached = cache.providers[rt.id];
			if (cached?.models?.length) {
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
}

function buildState(): ExtensionState {
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

function registerAll(pi: ExtensionAPI, state: ExtensionState, cache: CacheFile): void {
	for (const rt of state.runtimes.values()) {
		const cfg: Record<string, unknown> = {
			baseUrl: rt.entry.baseUrl,
			refreshModels: makeRefreshModels(rt, cache),
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
	if (!includeCount && !excludeCount) return "filters: none (all models pass)";
	return `filters: ${includeCount} include / ${excludeCount} exclude pattern(s)${rt.filters.invalid.length ? ` (+${rt.filters.invalid.length} invalid ignored)` : ""}`;
}

function statusLine(rt: ProviderRuntime): string {
	const url = modelsUrlOf(rt.entry);
	const api = rt.entry.api ? ` (${rt.entry.api})` : "";
	const lines = [`${rt.id}${api}`, `  ${url}`, `  ${filtersSummaryLine(rt)}`];
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
	const cache = readCache();
	const state = buildState();
	registerAll(pi, state, cache);

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
			const next = buildState();
			registerAll(pi, next, readCache());
			state.config = next.config;
			state.runtimes = next.runtimes;
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
				const { models, outcomes, url } = await discoverOnce(rt, undefined);
				const summary = summarizeDrops(outcomes);
				const lines = outcomes.slice(0, TEST_LIST_LIMIT).map((outcome) => {
					if (outcome.kept) return outcome.reason ? `  + ${outcome.id}  (kept by ${outcome.reason})` : `  + ${outcome.id}`;
					return `  - ${outcome.id}  -> dropped by ${outcome.reason}`;
				});
				if (outcomes.length > TEST_LIST_LIMIT) lines.push(`  ... and ${outcomes.length - TEST_LIST_LIMIT} more`);
				const preview = models.slice(0, 3).map((m) => `  ${m.id}: ctx=${m.contextWindow} max=${m.maxTokens} input=${m.input.join("+")}`);
				ctx.ui.notify(
					[
						`${LOG} ${id} dry-run — ${url}`,
						...lines,
						`summary: ${summary.raw} raw -> ${summary.kept} kept (${summary.raw - summary.kept} dropped)`,
						...(preview.length ? ["metadata preview:", ...preview] : []),
					].join("\n"),
				);
			} catch (err) {
				ctx.ui.notify(`${LOG} ${id} dry-run failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
