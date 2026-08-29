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

/** Fill missing cost keys with 0 so downstream consumers always see four finite numbers. */
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
	const add = (key: string, path: string): void => {
		const raw = walkPath(item, path);
		if (typeof raw !== "string" && typeof raw !== "number") return;
		const value = typeof raw === "number" ? raw : Number.parseFloat(raw);
		if (!Number.isFinite(value) || value < 0) return;
		cost[key] = value * 1e6;
	};
	add("input", "pricing.prompt");
	add("output", "pricing.completion");
	add("cacheRead", "pricing.prompt_cache_read");
	return Object.keys(cost).length ? cost : undefined;
}

/**
 * Build one ModelDef. Merge ladder (low -> high):
 *   entry.defaults  <  static definition (models.json / models-store.json, by id)
 *   <  live endpoint hints  <  entry.overrides[id]
 *
 * (Machine-fresh beats machine-stale: gateway-reported limits take precedence
 * over possibly outdated static catalogs; explicit overrides beat both.)
 */
export function buildModel(
	id: string,
	liveItem: Record<string, unknown> | undefined,
	entry: Pick<ProviderEntry, "defaults" | "overrides" | "compat" | "api" | "costFromLive">,
	base: Record<string, unknown> | undefined,
): ModelDef {
	const defaults = (entry.defaults ?? {}) as ModelDefaults;
	const override = (entry.overrides?.[id] ?? {}) as ModelOverride;

	// Cost ladder — override always wins; below that the costFromLive policy decides:
	//   fill-zero (default): live pricing only when no other source defines cost;
	//   always: live pricing beats static/defaults (machine-fresh beats stale);
	//   off: live pricing ignored entirely.
	const policy = entry.costFromLive ?? "fill-zero";
	const liveCost = policy === "off" ? undefined : liveCostFrom(liveItem);
	const normalizedLive = liveCost ? normalizeCost(liveCost) : undefined;
	const explicit = pick<Record<string, number>>(override.cost, base?.cost as Record<string, number> | undefined, defaults.cost);
	const cost = policy === "always"
		? (pick<Record<string, number>>(override.cost, normalizedLive, base?.cost as Record<string, number> | undefined, defaults.cost) ?? ZERO_COST)
		: (explicit ?? normalizedLive ?? ZERO_COST);

	const model: ModelDef = {
		id,
		name: pick<string>(override.name, base?.name as string | undefined, liveItem?.name as string | undefined, liveItem?.display_name as string | undefined, id) as string,
		reasoning: pick<boolean>(override.reasoning, base?.reasoning as boolean | undefined, defaults.reasoning, true) as boolean,
		input: pick<string[]>(override.input, base?.input as string[] | undefined, defaults.input, ["text"]) as string[],
		contextWindow: pick<number>(
			override.contextWindow,
			liveNumber(liveItem, CONTEXT_KEYS),
			base?.contextWindow as number | undefined,
			defaults.contextWindow,
			128_000,
		) as number,
		maxTokens: pick<number>(
			override.maxTokens,
			liveNumber(liveItem, MAX_TOKENS_KEYS),
			base?.maxTokens as number | undefined,
			defaults.maxTokens,
			32_768,
		) as number,
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
}

/**
 * Filter + merge the raw live items into a catalog. Pure function over its
 * inputs (no fs/network) — shared by live discovery, the offline-cache
 * rebuild path, and unit tests.
 */
export function buildCatalog(
	items: unknown[],
	opts: { entry: ProviderEntry; filters: CompiledFilters; staticById: Record<string, Record<string, unknown>> },
): CatalogResult {
	const { entry, filters, staticById } = opts;
	const outcomes: FilterOutcome[] = [];
	const liveModels: ModelDef[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const record: Record<string, unknown> = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		const id = modelIdOf(record);
		if (!id) continue;
		seen.add(id);
		const outcome = applyFilters(id, filters, record);
		outcomes.push(outcome);
		if (outcome.kept) liveModels.push(buildModel(id, record, entry, staticById[id]));
	}
	const staticModels: ModelDef[] = [];
	if (entry.mergeStatic === "union") {
		for (const [id, def] of Object.entries(staticById)) {
			if (seen.has(id)) continue;
			if (applyFilters(id, filters, def).kept) staticModels.push(buildModel(id, undefined, entry, def));
		}
	}
	return { liveModels, outcomes, staticModels };
}
