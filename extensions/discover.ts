/**
 * Discovery helpers for pi-live-models: endpoint URL derivation, credential
 * resolution, static metadata lookup, and the model metadata merge ladder.
 *
 * Pure functions are exported for unit tests; the fs-backed lookups read
 * `models.json` / `models-store.json` from the pi agent directory.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { modelsJsonPath, modelsStorePath, type ModelDefaults, type ModelOverride, type ProviderEntry } from "./config.ts";
import { applyFilters, walkPath, type CompiledFilters, type FilterOutcome } from "./filters.ts";
import {
	CONTEXT_WINDOW_MAX,
	CONTEXT_WINDOW_MIN,
	MAX_TOKENS_MAX,
	MAX_TOKENS_MIN,
	normalizeModelKey,
	saneWindow,
	catalogLookup,
	type CatalogIndex,
	type CatalogModelEntry,
	type MetaSource,
} from "./catalog.ts";

export interface ModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost: Record<string, number>;
	compat?: Record<string, unknown>;
	api?: string;
	/** Where contextWindow came from — surfaced by /live-models-test. */
	ctxSource?: MetaSource;
	/** Where maxTokens came from — surfaced by /live-models-test. */
	maxSource?: MetaSource;
}

/** Context pi passes to refreshModels(). */
export interface RefreshContext {
	signal?: AbortSignal;
	credential?: { key?: string };
}

const ZERO_COST: Record<string, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Derive the models endpoint from a base URL:
 *   https://x          -> https://x/v1/models
 *   https://x/v1       -> https://x/v1/models
 *   https://x/api/v3/  -> https://x/api/v3/models
 */
export function buildModelsUrl(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Resolve an apiKey spec: `$ENV` | `${ENV}` | `!shell command` | literal.
 * Returns undefined when the spec is absent, the env var is unset, or the
 * command fails (never throws).
 */
export function resolveKeySpec(spec: unknown): string | undefined {
	if (typeof spec !== "string" || !spec) return undefined;
	const envMatch = spec.match(/^\$\{(\w+)\}$/) ?? spec.match(/^\$(\w+)$/);
	if (envMatch) return process.env[envMatch[1]];
	if (spec.startsWith("!")) {
		try {
			return execSync(spec.slice(1), { encoding: "utf8", timeout: 10_000 }).trim();
		} catch {
			return undefined;
		}
	}
	return spec;
}

/** `<PROVIDER_ID>` upper-cased, non-alnum -> `_`, suffixed `_API_KEY`. */
export function envKeyVarName(providerId: string): string {
	return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function envKeyFor(providerId: string): string | undefined {
	return process.env[envKeyVarName(providerId)];
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Credential resolution for the discovery request, in order:
 *   1. entry `apiKey` spec
 *   2. `models.json` providers[id].apiKey (same spec syntax)
 *   3. env `<PROVIDER>_API_KEY`
 * (Level 0 — the /login credential from context — is checked by the caller.)
 */
export function resolveApiKey(providerId: string, entry: Pick<ProviderEntry, "apiKey">): string | undefined {
	const fromConfig = resolveKeySpec(entry.apiKey);
	if (fromConfig) return fromConfig;
	const modelsJson = readJsonSafe(modelsJsonPath());
	const providers = modelsJson?.providers as Record<string, { apiKey?: unknown }> | undefined;
	const fromModelsJson = resolveKeySpec(providers?.[providerId]?.apiKey);
	if (fromModelsJson) return fromModelsJson;
	return envKeyFor(providerId);
}

/** Static per-id metadata: models-store.json cache first, models.json wins. */
export function collectStaticById(providerId: string): Record<string, Record<string, unknown>> {
	const byId: Record<string, Record<string, unknown>> = {};
	const store = readJsonSafe(modelsStorePath());
	const storeModels = (store?.[providerId] as { models?: unknown[] } | undefined)?.models;
	for (const m of Array.isArray(storeModels) ? storeModels : []) {
		if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
			byId[(m as { id: string }).id] = m as Record<string, unknown>;
		}
	}
	const modelsJson = readJsonSafe(modelsJsonPath());
	const jsonModels = (modelsJson?.providers as Record<string, { models?: unknown[] }> | undefined)?.[providerId]?.models;
	for (const m of Array.isArray(jsonModels) ? jsonModels : []) {
		if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
			byId[(m as { id: string }).id] = m as Record<string, unknown>;
		}
	}
	return byId;
}

function pick<T>(...values: unknown[]): T | undefined {
	for (const value of values) {
		if (value !== undefined && value !== null) return value as T;
	}
	return undefined;
}

/** Walk dotted key paths over the live endpoint item; first numeric hit wins. */
export function liveNumber(item: Record<string, unknown> | undefined, keyPaths: string[]): number | undefined {
	for (const keyPath of keyPaths) {
		const value = walkPath(item, keyPath);
		if (typeof value === "number") return value;
	}
	return undefined;
}

const CONTEXT_KEYS = ["context_length", "context_window", "max_context_tokens", "max_model_len", "maximum_context_length"];
const MAX_TOKENS_KEYS = ["max_completion_tokens", "max_tokens", "top_provider.max_completion_tokens", "top_provider.max_tokens"];

/** Fill missing/invalid cost keys with 0 for live-derived costs. Explicit config costs (override/static/defaults) pass through unchanged, preserving v0.1.0 semantics. */
function normalizeCost(cost: Record<string, number>): Record<string, number> {
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
	return { input: num(cost.input), output: num(cost.output), cacheRead: num(cost.cacheRead), cacheWrite: num(cost.cacheWrite) };
}

/**
 * Extract OpenRouter-style live pricing into pi cost units ($/1M tokens).
 * `pricing.prompt` -> input, `pricing.completion` -> output,
 * `pricing.prompt_cache_read` -> cacheRead. Values are $/token strings
 * (numbers tolerated); non-finite/negative entries are ignored. A model
 * explicitly priced at "0" (free tier) is a valid live cost.
 */
export function liveCostFrom(item: Record<string, unknown> | undefined): Record<string, number> | undefined {
	const cost: Record<string, number> = {};
	// Strict decimal syntax — parseFloat would silently accept trailing garbage
	// ("0.5/token") and hex ("0x2") as valid prices.
	const NUMERIC = /^\d*\.?\d+(?:[eE][+-]?\d+)?$/;
	const add = (key: string, path: string): void => {
		const raw = walkPath(item, path);
		if (typeof raw !== "string" && typeof raw !== "number") return;
		const value = typeof raw === "number" ? raw : (NUMERIC.test(raw) ? Number.parseFloat(raw) : NaN);
		if (!Number.isFinite(value) || value < 0) return;
		cost[key] = value * 1e6;
	};
	add("input", "pricing.prompt");
	add("output", "pricing.completion");
	add("cacheRead", "pricing.prompt_cache_read");
	return Object.keys(cost).length ? cost : undefined;
}

/** First defined numeric candidate wins; records which layer it came from. */
function pickNumberWithSource(
	candidates: Array<[number | undefined, MetaSource]>,
	fallback: [number, MetaSource],
): { value: number; source: MetaSource } {
	for (const [value, source] of candidates) {
		if (typeof value === "number") return { value, source };
	}
	return { value: fallback[0], source: fallback[1] };
}

/**
 * Build one ModelDef. Merge ladder (low -> high):
 *   entry.defaults  <  static definition (models.json / models-store.json, by id)
 *   <  live endpoint hints  <  public catalog  <  entry.overrides[id]
 *
 * (Machine-fresh beats machine-stale: gateway-reported limits take precedence
 * over possibly outdated static catalogs; the community catalog beats gateways
 * because relays often stamp placeholder context lengths; explicit overrides
 * beat everything. Gateway values only pass through a sanity window —
 * non-integers, 0/negatives, and absurd magnitudes are treated as missing.)
 */
export function buildModel(
	id: string,
	liveItem: Record<string, unknown> | undefined,
	entry: Pick<ProviderEntry, "defaults" | "overrides" | "compat" | "api" | "costFromLive">,
	base: Record<string, unknown> | undefined,
	catalogEntry?: CatalogModelEntry,
): ModelDef {
	const defaults = (entry.defaults ?? {}) as ModelDefaults;
	const override = (entry.overrides?.[id] ?? {}) as ModelOverride;

	// Cost ladder — override always wins (key-level, highest); below that the
	// costFromLive policy decides:
	//   fill-zero (default): live pricing only when no other source defines cost;
	//   always: live pricing beats static/defaults KEY BY KEY — a live entry
	//          reporting only pricing.prompt keeps static output/cache prices;
	//   off: live pricing ignored entirely.
	const policy = entry.costFromLive ?? "fill-zero";
	const liveCost = policy === "off" ? undefined : liveCostFrom(liveItem);
	const explicit = pick<Record<string, number>>(override.cost, base?.cost as Record<string, number> | undefined, defaults.cost);
	let cost: Record<string, number>;
	if (policy === "always" && liveCost) {
		const lower = normalizeCost((base?.cost as Record<string, number> | undefined) ?? defaults.cost ?? {});
		cost = { ...lower, ...liveCost, ...(override.cost ?? {}) };
	} else {
		cost = explicit ?? (liveCost ? normalizeCost(liveCost) : undefined) ?? ZERO_COST;
	}

	const liveCtx = liveNumber(liveItem, CONTEXT_KEYS);
	const liveMax = liveNumber(liveItem, MAX_TOKENS_KEYS);
	const ctx = pickNumberWithSource(
		[
			[override.contextWindow, "override"],
			[catalogEntry?.contextWindow, "catalog"],
			[saneWindow(liveCtx, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX) ? liveCtx : undefined, "live"],
			[base?.contextWindow as number | undefined, "static"],
			[defaults.contextWindow, "defaults"],
		],
		[128_000, "fallback"],
	);
	const max = pickNumberWithSource(
		[
			[override.maxTokens, "override"],
			[catalogEntry?.maxTokens, "catalog"],
			[saneWindow(liveMax, MAX_TOKENS_MIN, MAX_TOKENS_MAX) ? liveMax : undefined, "live"],
			[base?.maxTokens as number | undefined, "static"],
			[defaults.maxTokens, "defaults"],
		],
		[32_768, "fallback"],
	);

	const model: ModelDef = {
		id,
		name: pick<string>(override.name, base?.name as string | undefined, liveItem?.name as string | undefined, liveItem?.display_name as string | undefined, id) as string,
		reasoning: pick<boolean>(override.reasoning, base?.reasoning as boolean | undefined, defaults.reasoning, true) as boolean,
		input: pick<string[]>(override.input, base?.input as string[] | undefined, defaults.input, ["text"]) as string[],
		contextWindow: ctx.value,
		ctxSource: ctx.source,
		maxTokens: max.value,
		maxSource: max.source,
		cost,
	};

	const compat = pick<Record<string, unknown>>(override.compat, base?.compat as Record<string, unknown> | undefined, entry.compat);
	if (compat) model.compat = compat;

	const api = pick<string>(override.api, base?.api as string | undefined, entry.api);
	if (api) model.api = api;

	return model;
}

/** Extract a model id from a live endpoint item (`id` preferred, `name` fallback). */
function modelIdOf(record: Record<string, unknown>): string {
	if (typeof record.id === "string" && record.id) return record.id;
	if (typeof record.name === "string" && record.name) return record.name;
	return "";
}

export interface CatalogResult {
	/** Live-listed models that survived filters (metadata merged). */
	liveModels: ModelDef[];
	/** Filter outcomes for live items only (raw -> kept statistics). */
	outcomes: FilterOutcome[];
	/** Static-only models added by mergeStatic:"union" (already filtered). Empty otherwise. */
	staticModels: ModelDef[];
	/** Suspicious-metadata warnings (gateway vs catalog divergence, uniform gateway values). */
	warnings: string[];
}

/** Per-model metadata warnings shown by the commands are capped at this many lines. */
const WARNING_LIMIT = 6;

/** Gateway vs catalog context divergence at or above this ratio is flagged. */
const DIVERGENCE_RATIO = 4;

/**
 * Filter + merge the raw live items into a catalog. Pure function over its
 * inputs (no fs/network) — shared by live discovery, the offline-cache
 * rebuild path, and unit tests.
 */
export function buildCatalog(
	items: unknown[],
	opts: {
		entry: ProviderEntry;
		filters: CompiledFilters;
		staticById: Record<string, Record<string, unknown>>;
		/** Provider id, used in warning text. Defaults to "provider". */
		providerId?: string;
		/** Public catalog index; ignored when entry.catalog === false. */
		catalog?: CatalogIndex;
	},
): CatalogResult {
	const { entry, filters, staticById, providerId = "provider", catalog } = opts;
	const useCatalog = entry.catalog !== false && catalog !== undefined;
	const outcomes: FilterOutcome[] = [];
	const liveModels: ModelDef[] = [];
	const keptItems: Array<{ id: string; record: Record<string, unknown> }> = [];
	const seen = new Set<string>();
	for (const item of items) {
		const record: Record<string, unknown> = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		const id = modelIdOf(record);
		if (!id) continue;
		if (seen.has(id)) continue; // duplicate live id (gateway alias): first wins
		seen.add(id);
		const outcome = applyFilters(id, filters, record);
		outcomes.push(outcome);
		if (outcome.kept) {
			keptItems.push({ id, record });
			liveModels.push(buildModel(id, record, entry, staticById[id], useCatalog ? catalogLookup(catalog!, id) : undefined));
		}
	}
	const warnings = collectWarnings(providerId, keptItems, useCatalog ? catalog : undefined);
	const staticModels: ModelDef[] = [];
	if (entry.mergeStatic === "union") {
		for (const [id, def] of Object.entries(staticById)) {
			if (seen.has(id)) continue;
			if (applyFilters(id, filters, def).kept) {
				staticModels.push(buildModel(id, undefined, entry, def, useCatalog ? catalogLookup(catalog!, id) : undefined));
			}
		}
	}
	return { liveModels, outcomes, staticModels, warnings };
}

/**
 * Flag suspicious gateway-reported context values. Two detectors:
 *   - divergence: gateway ctx vs public catalog ctx at >=4x (catalog on only);
 *   - uniform placeholder: >=3 kept models reporting the exact same ctx —
 *     the classic relay stamp. Both point the user at /live-models-fix.
 */
function collectWarnings(
	providerId: string,
	keptItems: Array<{ id: string; record: Record<string, unknown> }>,
	catalog: CatalogIndex | undefined,
): string[] {
	const warnings: string[] = [];
	// Abstained catalog matches first — they explain why no catalog
	// correction applies and hand the decision to the user.
	if (catalog) {
		for (const { id } of keptItems) {
			const signatures = catalog.divergent.get(normalizeModelKey(id));
			if (signatures === undefined) continue;
			const shown = signatures.slice(0, 3).join(" / ");
			const extra = signatures.length > 3 ? ` (+${signatures.length - 3} more)` : "";
			warnings.push(`⚠ ${id}: catalog match skipped — providers disagree (${shown}${extra}) — pin the correct value with /live-models-fix ${providerId} ${id} ctx=<n> [max=<n>]`);
		}
	}
	const ctxCounts = new Map<number, number>();
	for (const { id, record } of keptItems) {
		const liveCtx = liveNumber(record, CONTEXT_KEYS);
		if (!saneWindow(liveCtx, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX)) continue;
		ctxCounts.set(liveCtx, (ctxCounts.get(liveCtx) ?? 0) + 1);
		if (catalog) {
			const catCtx = catalogLookup(catalog, id)?.contextWindow;
			if (catCtx !== undefined) {
				const ratio = Math.max(liveCtx, catCtx) / Math.min(liveCtx, catCtx);
				if (ratio >= DIVERGENCE_RATIO) {
					warnings.push(`⚠ ${id}: gateway ctx=${liveCtx} vs public catalog ${catCtx} — fix: /live-models-fix ${providerId} ${id} ctx=${catCtx}`);
				}
			}
		}
	}
	for (const [value, count] of ctxCounts) {
		if (count >= 3) {
			warnings.push(`⚠ ${providerId}: ${count} model(s) share gateway ctx=${value} — likely a gateway placeholder (verify with /live-models-test, fix with /live-models-fix)`);
		}
	}
	if (warnings.length > WARNING_LIMIT) {
		warnings.length = WARNING_LIMIT;
		warnings.push(`... more warnings omitted`);
	}
	return warnings;
}
