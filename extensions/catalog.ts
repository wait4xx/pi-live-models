/**
 * Public model metadata catalog for pi-live-models.
 *
 * Gateway-reported context lengths are frequently wrong — relay/aggregator
 * services often stamp every model with the same placeholder value. This
 * module layers a community-maintained catalog (LiteLLM's
 * model_prices_and_context_window.json, 3.3k+ models) into the metadata
 * merge ladder as a value ABOVE live hints and BELOW explicit overrides:
 *
 *   defaults < static < live < catalog < overrides[id]
 *
 * Sources are tried in order (jsdelivr CDN first — reachable where
 * raw.githubusercontent.com is not). The catalog is cached on disk for
 * CATALOG_TTL_MS and refreshed in the background so discovery never blocks
 * on it. Every failure (fetch, parse, disk) degrades to "no catalog" —
 * this is best-effort enrichment and must never break a refresh.
 */
import fs from "node:fs";
import { catalogPath } from "./config.ts";

const LOG = "[pi-live-models]";

/** Disk cache lifetime. Public catalogs move slowly; a week is plenty. */
export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** After a failed refresh, wait this long before another background attempt. */
export const CATALOG_RETRY_BACKOFF_MS = 30 * 60 * 1000;

/** Fetch timeout per source URL, ms. */
const FETCH_TIMEOUT_MS = 20_000;

/** Source URLs tried in order. */
const SOURCE_URLS = [
	"https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
];

/** Sanity bounds for context windows / output limits (tokens). */
export const CONTEXT_WINDOW_MIN = 1024;
export const CONTEXT_WINDOW_MAX = 10_000_000;
export const MAX_TOKENS_MIN = 128;
export const MAX_TOKENS_MAX = 10_000_000;

export interface CatalogModelEntry {
	/** Community value for the model's context window (tokens). */
	contextWindow?: number;
	/** Community value for the max output/completion tokens. */
	maxTokens?: number;
}

export interface CatalogData {
	/** Source URL the data was fetched from. */
	url: string;
	/** Epoch ms when the data was fetched. */
	fetchedAt: number;
	/** Community entries keyed by their original catalog name. */
	models: Record<string, CatalogModelEntry>;
}

/** Where a metadata value came from — surfaced by /live-models-test. */
export type MetaSource = "override" | "catalog" | "live" | "static" | "defaults" | "fallback";

/** Runtime catalog holder. Survives /live-models-reload (module-independent, disk-backed). */
export interface CatalogManager {
	data: CatalogData | null;
	/** Deduplicated background refresh in flight, if any. */
	inflight: Promise<void> | null;
	/** Epoch ms of the last failed refresh — backoff marker. */
	lastFailureAt: number | null;
}

export function createCatalogManager(): CatalogManager {
	return { data: null, inflight: null, lastFailureAt: null };
}

/** Backoff gate: skip background attempts shortly after a failure (manual refresh ignores this). */
export function shouldAttemptRefresh(mgr: CatalogManager, now: number): boolean {
	if (mgr.inflight) return false;
	if (mgr.lastFailureAt !== null && now - mgr.lastFailureAt < CATALOG_RETRY_BACKOFF_MS) return false;
	return true;
}

/** Integer within [min, max] — the only values trusted for windows. */
export function saneWindow(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Normalize a model id / catalog key for matching:
 *   lower-case -> strip `:suffix` (:latest, :free) -> strip provider prefix
 *   (basename) -> strip date suffix (-20241120, -251222, -2024-11-20).
 * Conservative by design: no fuzzy or prefix matching — a wrong context
 * length is worse than none.
 */
export function normalizeModelKey(raw: string): string {
	let key = raw.toLowerCase().trim();
	const colon = key.indexOf(":");
	if (colon > 0) key = key.slice(0, colon);
	const slash = key.lastIndexOf("/");
	if (slash >= 0) key = key.slice(slash + 1);
	key = key.replace(/-(?:\d{8}|\d{6}|\d{4}-\d{2}-\d{2})$/, "");
	return key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a LiteLLM catalog JSON into community entries. Only chat-mode entries
 * with at least one sane window value are kept (embeddings/rerankers and
 * garbage values are skipped).
 */
export function parseLiteLLMCatalog(json: unknown): Record<string, CatalogModelEntry> {
	const out: Record<string, CatalogModelEntry> = {};
	if (!isPlainObject(json)) return out;
	for (const [key, value] of Object.entries(json)) {
		if (!key || !isPlainObject(value)) continue;
		if (value.mode !== undefined && value.mode !== "chat") continue;
		const entry: CatalogModelEntry = {};
		if (saneWindow(value.max_input_tokens, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX)) {
			entry.contextWindow = value.max_input_tokens;
		}
		const maxOut = value.max_output_tokens ?? value.max_tokens;
		if (saneWindow(maxOut, MAX_TOKENS_MIN, MAX_TOKENS_MAX)) {
			entry.maxTokens = maxOut;
		}
		if (entry.contextWindow !== undefined || entry.maxTokens !== undefined) out[key] = entry;
	}
	return out;
}

export interface CatalogIndex {
	data: CatalogData;
	/** raw-lowercase and normalized keys -> entry (exact keys registered first, so they win). */
	byKey: Map<string, CatalogModelEntry>;
}

/**
 * Build the lookup index. Raw lower-cased keys are registered before
 * normalized ones, so `gpt-4o` (the maintained primary entry) wins over a
 * dated alias `gpt-4o-2024-11-20` when both normalize to the same key.
 */
export function buildCatalogIndex(models: Record<string, CatalogModelEntry>): CatalogIndex {
	const byKey = new Map<string, CatalogModelEntry>();
	const raw: Array<[string, CatalogModelEntry]> = Object.entries(models).map(([k, v]) => [k.toLowerCase(), v]);
	for (const [key, entry] of raw) {
		if (!byKey.has(key)) byKey.set(key, entry);
	}
	for (const [key, entry] of raw) {
		const norm = normalizeModelKey(key);
		if (norm && !byKey.has(norm)) byKey.set(norm, entry);
	}
	return { data: { url: "", fetchedAt: 0, models }, byKey };
}

/** Exact-normalized lookup only — never fuzzy. */
export function catalogLookup(index: CatalogIndex, id: string): CatalogModelEntry | undefined {
	return index.byKey.get(id.toLowerCase()) ?? index.byKey.get(normalizeModelKey(id));
}

// ---------------------------------------------------------------- disk cache

/** Read the disk cache; null when missing/malformed. Never throws. */
export function readCatalogCache(): CatalogData | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(catalogPath(), "utf8"));
		if (
			isPlainObject(raw) &&
			typeof raw.url === "string" &&
			typeof raw.fetchedAt === "number" &&
			isPlainObject(raw.models)
		) {
			return raw as unknown as CatalogData;
		}
	} catch {
		// missing or malformed — treated as absent
	}
	return null;
}

/** Persist the cache; failures are warnings (enrichment must not crash pi). */
export function writeCatalogCache(data: CatalogData): void {
	try {
		fs.writeFileSync(catalogPath(), JSON.stringify(data), "utf8");
	} catch (err) {
		console.warn(`${LOG} catalog cache write failed:`, err instanceof Error ? err.message : err);
	}
}

// -------------------------------------------------------------------- fetch

/** Fetch + parse the catalog, trying each source URL in order. */
export async function fetchCatalogData(signal?: AbortSignal): Promise<CatalogData> {
	let lastError: unknown;
	for (const url of SOURCE_URLS) {
		try {
			const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
			const res = await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const models = parseLiteLLMCatalog(await res.json());
			if (!Object.keys(models).length) throw new Error("no usable entries in response");
			return { url, fetchedAt: Date.now(), models };
		} catch (err) {
			if (signal?.aborted) throw err;
			lastError = err;
		}
	}
	throw new Error(`all catalog sources failed (last: ${lastError instanceof Error ? lastError.message : String(lastError)})`);
}

/**
 * Soft ensure: load the disk cache once; if it is missing or stale, kick a
 * deduplicated background refresh and return whatever is available now
 * (possibly null/stale). Never throws, never blocks on the network.
 */
export function ensureCatalogSoft(mgr: CatalogManager): CatalogData | null {
	if (!mgr.data) mgr.data = readCatalogCache();
	if (!mgr.data || Date.now() - mgr.data.fetchedAt >= CATALOG_TTL_MS) {
		if (shouldAttemptRefresh(mgr, Date.now())) kickRefresh(mgr);
	}
	return mgr.data;
}

function kickRefresh(mgr: CatalogManager): void {
	if (mgr.inflight) return;
	mgr.inflight = fetchCatalogData()
		.then((data) => {
			mgr.data = data;
			mgr.lastFailureAt = null;
			writeCatalogCache(data);
		})
		.catch((err) => {
			mgr.lastFailureAt = Date.now();
			console.warn(`${LOG} catalog refresh failed (will retry in ${Math.round(CATALOG_RETRY_BACKOFF_MS / 60_000)}min): ${err instanceof Error ? err.message : err}`);
		})
		.finally(() => {
			mgr.inflight = null;
		});
}

/** Blocking refresh — used by /live-models-catalog-refresh. Throws on failure. */
export async function refreshCatalogNow(mgr: CatalogManager): Promise<CatalogData> {
	const data = await fetchCatalogData();
	mgr.data = data;
	mgr.lastFailureAt = null;
	writeCatalogCache(data);
	return data;
}
