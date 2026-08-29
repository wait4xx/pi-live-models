/**
 * Public model metadata catalog for pi-live-models.
 *
 * Gateway-reported context lengths are frequently wrong — relay/aggregator
 * services often stamp every model with the same placeholder value. This
 * module layers two community-maintained catalogs (LiteLLM's
 * model_prices_and_context_window.json and models.dev's api.json) into the metadata
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
import { catalogPath, modelsDevCatalogPath } from "./config.ts";

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

/** Second, independent catalog source: models.dev aggregates per-vendor
 *  model specs from official documentation — fast coverage of new releases
 *  (observed: a model indexed 3 days after launch) with limit.context /
 *  limit.output fields. Entries are keyed "<provider-slug>/<id>" so the
 *  existing normalization + vendor arbitration apply unchanged. */
const MODELSDEV_URL = "https://models.dev/api.json";

/** Vendor entries from independent catalogs may quote the same official
 *  limit in different roundings (litellm: 200000/128000 decimal approx vs
 *  models.dev: 204800/131072 binary-exact — 2.4% apart, same spec). Vendor
 *  candidates within this relative tolerance count as agreeing; the merged
 *  value is the CONSERVATIVE minimum (a too-small max_tokens merely caps
 *  output, a too-large one hard-fails the gateway). */
export const VENDOR_TOLERANCE = 0.05;

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
	/** litellm_provider of this entry ("zai", "together_ai", …) — the
	 *  catalog's own attribution of WHO serves this deployment. A two-segment
	 *  key "P/model" whose provider === P is the vendor's own entry and wins
	 *  arbitration; third-party hosted entries ("together_ai/zai-org/X",
	 *  three segments) never do. */
	provider?: string;
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
	/** Second source (models.dev) — same lifecycle, independent backoff. */
	devData: CatalogData | null;
	devInflight: Promise<void> | null;
	devLastFailureAt: number | null;
}

export function createCatalogManager(): CatalogManager {
	return { data: null, inflight: null, lastFailureAt: null, devData: null, devInflight: null, devLastFailureAt: null };
}

/** Backoff gate: skip background attempts shortly after a failure (manual refresh ignores this). */
export function shouldAttemptRefresh(mgr: CatalogManager, now: number): boolean {
	if (mgr.inflight) return false;
	if (mgr.lastFailureAt !== null && now - mgr.lastFailureAt < CATALOG_RETRY_BACKOFF_MS) return false;
	return true;
}

/** Same gate for the models.dev source. */
export function shouldAttemptDevRefresh(mgr: CatalogManager, now: number): boolean {
	if (mgr.devInflight) return false;
	if (mgr.devLastFailureAt !== null && now - mgr.devLastFailureAt < CATALOG_RETRY_BACKOFF_MS) return false;
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
 * length is worse than none. When several catalog entries normalize to
 * the SAME key but disagree on values, the key abstains entirely (see
 * buildCatalogIndex).
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
		if (typeof value.litellm_provider === "string" && value.litellm_provider !== "") {
			entry.provider = value.litellm_provider;
		}
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

/** Parse models.dev api.json: { "<provider-slug>": { models: { "<id>":
 *  { limit: { context, output }, … } } } } → entries keyed
 *  "<provider-slug>/<id>". NOTE: entries deliberately carry NO provider
 *  field — models.dev hosts 200+ gateways whose resale listings use the
 *  same bare ids as the vendor's own namespace (vancine/glm-5.3-flash vs
 *  zai/glm-5.3-flash), and nothing in the data distinguishes vendor from
 *  reseller. So models.dev entries never claim vendor status; they join
 *  the candidate pools as independent consensus/divergence signals and
 *  provide fast coverage of new releases (observed: indexed 3 days after
 *  launch). */
export function parseModelsDevCatalog(json: unknown): Record<string, CatalogModelEntry> {
	const out: Record<string, CatalogModelEntry> = {};
	if (!isPlainObject(json)) return out;
	for (const [slug, def] of Object.entries(json)) {
		if (!slug || !isPlainObject(def) || !isPlainObject(def.models)) continue;
		for (const [id, m] of Object.entries(def.models)) {
			if (!id || !isPlainObject(m) || !isPlainObject(m.limit)) continue;
			const entry: CatalogModelEntry = {};
			if (saneWindow(m.limit.context, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX)) {
				entry.contextWindow = m.limit.context;
			}
			if (saneWindow(m.limit.output, MAX_TOKENS_MIN, MAX_TOKENS_MAX)) {
				entry.maxTokens = m.limit.output;
			}
			if (entry.contextWindow !== undefined || entry.maxTokens !== undefined) {
				out[`${slug}/${id}`] = entry;
			}
		}
	}
	return out;
}

export interface CatalogIndex {
	data: CatalogData;
	/** raw-lowercase and normalized keys -> entry (exact keys registered first, so they win). */
	byKey: Map<string, CatalogModelEntry>;
	/** Normalized keys ABSTAINED from matching: candidates disagree on the
	 *  values (key -> the distinct value signatures seen). Lookups miss so
	 *  the model falls back to the static/live ladder; callers surface a
	 *  warning pointing at /live-models-fix. */
	divergent: Map<string, string[]>;
	/** Normalized keys with a single third-party candidate and no vendor
	 *  entry — nothing to cross-check, so they are silently skipped (counted
	 *  for /live-models-catalog). Observed in the wild: a lone hosted
	 *  deployment carrying its own platform limits. */
	unverified: Map<string, string>;
}

/** Value signature used for cross-source agreement checks + warning text. */
function entrySignature(entry: CatalogModelEntry): string {
	return `ctx=${entry.contextWindow ?? "?"} max=${entry.maxTokens ?? "?"}`;
}

/** A two-segment key "P/model" whose provider === P is the VENDOR's own
 *  catalog entry ("zai/glm-4.6", provider zai). Hosted deployments
 *  ("together_ai/zai-org/GLM-5.3-Flash", three segments) and bare keys
 *  (registered as exact matches earlier) never reach this check. Only litellm
 *  entries qualify: they carry litellm_provider. models.dev entries carry no
 *  provider field by design and therefore never claim vendor status — its
 *  namespaces mix vendors and resellers using identical bare ids, and the
 *  data offers no way to tell them apart. */
function isVendorEntry(rawKey: string, entry: CatalogModelEntry): boolean {
	if (entry.provider === undefined) return false;
	const slash = rawKey.indexOf("/");
	if (slash <= 0 || rawKey.indexOf("/", slash + 1) !== -1) return false; // not exactly two segments
	return rawKey.slice(0, slash) === entry.provider;
}

/** Merge candidates under tolerance: per field, all present values must
 *  lie within VENDOR_TOLERANCE of each other; the merged value is the
 *  conservative minimum. Used for vendor candidates (rounding differences
 *  between catalogs are not disagreements) and for the no-vendor consensus
 *  tier (same rule, same safety). Returns null on real disagreement. */
function mergeUnderTolerance(candidates: ReadonlyArray<[string, CatalogModelEntry]>): CatalogModelEntry | null {
	const ctxs = candidates.map(([, e]) => e.contextWindow).filter((v): v is number => v !== undefined);
	const maxs = candidates.map(([, e]) => e.maxTokens).filter((v): v is number => v !== undefined);
	const within = (nums: number[]): boolean =>
		nums.length === 0 || (Math.max(...nums) - Math.min(...nums)) / Math.min(...nums) <= VENDOR_TOLERANCE;
	if (!within(ctxs) || !within(maxs)) return null;
	const merged: CatalogModelEntry = {};
	if (ctxs.length) merged.contextWindow = Math.min(...ctxs);
	if (maxs.length) merged.maxTokens = Math.min(...maxs);
	return merged;
}

/**
 * Build the lookup index. Raw lower-cased keys are registered first (exact
 * matches keep priority). Normalized keys are then arbitrated in three
 * tiers — vendor truth first, community consensus second, silence third:
 *
 *   1. VENDOR ENTRY WINS: any two-segment "P/model" candidate whose
 *      provider === P (the vendor's own numbers) beats everyone. Vendor
 *      candidates must agree per VENDOR_TOLERANCE (rounding differences
 *      between catalogs are not disagreements); the value used is the
 *      conservative minimum. Real disagreement abstains.
 *   2. NO VENDOR -> CONSENSUS: all candidates agree on the values.
 *   3. DISAGREEMENT -> ABSTAIN: the key lands in `divergent`, lookups miss,
 *      and a warning points the user at /live-models-fix.
 *   A lone third-party candidate with no vendor entry is `unverified` —
 *   silently skipped (nothing to cross-check against; observed in the wild:
 *   a hosted deployment stamping its own platform limits, e.g.
 *   together_ai 1048575 where the vendor says 128000).
 *
 *  `extraEntries` carries same-key entries from the SECOND source that were
 *  displaced during merging (both catalogs report "zai/glm-4.6", each with
 *  its own rounding). They join the arbitration groups but never override
 *  the exact-key registration.
 */
export function buildCatalogIndex(
	models: Record<string, CatalogModelEntry>,
	extraEntries?: ReadonlyArray<[string, CatalogModelEntry]>,
): CatalogIndex {
	const byKey = new Map<string, CatalogModelEntry>();
	const divergent = new Map<string, string[]>();
	const unverified = new Map<string, string>();
	const raw: Array<[string, CatalogModelEntry]> = Object.entries(models).map(([k, v]) => [k.toLowerCase(), v]);
	for (const [key, entry] of raw) {
		if (!byKey.has(key)) byKey.set(key, entry);
	}
	const groups = new Map<string, Array<[string, CatalogModelEntry]>>();
	const collect = (pair: [string, CatalogModelEntry]): void => {
		const norm = normalizeModelKey(pair[0]);
		if (!norm || norm === pair[0]) return; // exact key already registered above
		const group = groups.get(norm);
		if (group) group.push(pair);
		else groups.set(norm, [pair]);
	};
	for (const pair of raw) collect(pair);
	for (const pair of (extraEntries ?? []).map(([k, v]) => [k.toLowerCase(), v] as [string, CatalogModelEntry])) {
		collect(pair);
	}
	for (const [norm, group] of groups) {
		if (byKey.has(norm)) continue; // an exact key owns this name — its value stands
		const vendors = group.filter(([key, entry]) => isVendorEntry(key, entry));
		if (vendors.length > 0) {
			const merged = mergeUnderTolerance(vendors);
			if (merged) {
				byKey.set(norm, merged);
			} else {
				const signatures = [...new Set(group.map(([, e]) => entrySignature(e)))];
				divergent.set(norm, signatures);
			}
			continue;
		}
		const signatures = [...new Set(group.map(([, e]) => entrySignature(e)))];
		const merged = mergeUnderTolerance(group);
		if (merged !== null && group.length >= 2) {
			byKey.set(norm, merged); // consensus of independent sources (tolerant, conservative)
		} else if (group.length === 1) {
			unverified.set(norm, (signatures as string[])[0] as string); // nothing to cross-check
		} else {
			divergent.set(norm, signatures);
		}
	}
	return { data: { url: "", fetchedAt: 0, models }, byKey, divergent, unverified };
}

/** Exact-normalized lookup only — never fuzzy. */
export function catalogLookup(index: CatalogIndex, id: string): CatalogModelEntry | undefined {
	return index.byKey.get(id.toLowerCase()) ?? index.byKey.get(normalizeModelKey(id));
}

// ---------------------------------------------------------------- disk cache

/** Read the disk cache; null when missing/malformed. Never throws. */
export function readCatalogCache(file: string): CatalogData | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
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
export function writeCatalogCache(data: CatalogData, file: string): void {
	try {
		fs.writeFileSync(file, JSON.stringify(data), "utf8");
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

/** Fetch + parse models.dev (single URL, independent failure domain). */
export async function fetchModelsDevData(signal?: AbortSignal): Promise<CatalogData> {
	try {
		const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const res = await fetch(MODELSDEV_URL, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const models = parseModelsDevCatalog(await res.json());
		if (!Object.keys(models).length) throw new Error("no usable entries in response");
		return { url: MODELSDEV_URL, fetchedAt: Date.now(), models };
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new Error(`models.dev source failed (${err instanceof Error ? err.message : String(err)})`);
	}
}

// -------------------------------------------------------------------- merge

/** Two-source view handed to callers: non-conflicting models merged, and
 *  same-key entries from the second source listed separately so they can
 *  join arbitration (both catalogs report "zai/glm-4.6", each with its own
 *  rounding — the vendor-tolerance merge settles it). */
export interface CatalogView {
	data: CatalogData;
	extraEntries: Array<[string, CatalogModelEntry]>;
}

export function mergeCatalogSources(primary: CatalogData | null, secondary: CatalogData | null): CatalogView | null {
	if (!primary && !secondary) return null;
	const models: Record<string, CatalogModelEntry> = {};
	const extraEntries: Array<[string, CatalogModelEntry]> = [];
	for (const [k, v] of Object.entries(primary?.models ?? {})) models[k] = v;
	for (const [k, v] of Object.entries(secondary?.models ?? {})) {
		if (models[k] === undefined) models[k] = v;
		else extraEntries.push([k, v]);
	}
	const data: CatalogData = {
		url: primary && secondary ? `${primary.url} + ${secondary.url}` : (primary ?? secondary)!.url,
		fetchedAt: Math.max(primary?.fetchedAt ?? 0, secondary?.fetchedAt ?? 0),
		models,
	};
	return { data, extraEntries };
}

/**
 * Soft ensure: load both disk caches once; if either is missing or stale,
 * kick a deduplicated background refresh for it and return the merged view
 * of whatever is available now (possibly null/stale). Never throws, never
 * blocks on the network. Each source backs off independently.
 */
export function ensureCatalogSoft(mgr: CatalogManager): CatalogView | null {
	if (!mgr.data) mgr.data = readCatalogCache(catalogPath());
	if (!mgr.data || Date.now() - mgr.data.fetchedAt >= CATALOG_TTL_MS) {
		if (shouldAttemptRefresh(mgr, Date.now())) kickRefresh(mgr, "litellm");
	}
	if (!mgr.devData) mgr.devData = readCatalogCache(modelsDevCatalogPath());
	if (!mgr.devData || Date.now() - mgr.devData.fetchedAt >= CATALOG_TTL_MS) {
		if (shouldAttemptDevRefresh(mgr, Date.now())) kickRefresh(mgr, "dev");
	}
	return mergeCatalogSources(mgr.data, mgr.devData);
}

function kickRefresh(mgr: CatalogManager, which: "litellm" | "dev"): void {
	const isMain = which === "litellm";
	if (isMain ? mgr.inflight : mgr.devInflight) return;
	const job = (isMain ? fetchCatalogData() : fetchModelsDevData())
		.then((data) => {
			if (isMain) {
				mgr.data = data;
				mgr.lastFailureAt = null;
				writeCatalogCache(data, catalogPath());
			} else {
				mgr.devData = data;
				mgr.devLastFailureAt = null;
				writeCatalogCache(data, modelsDevCatalogPath());
			}
		})
		.catch((err) => {
			if (isMain) mgr.lastFailureAt = Date.now();
			else mgr.devLastFailureAt = Date.now();
			console.warn(`${LOG} ${isMain ? "litellm" : "models.dev"} refresh failed (will retry in ${Math.round(CATALOG_RETRY_BACKOFF_MS / 60_000)}min): ${err instanceof Error ? err.message : err}`);
		})
		.finally(() => {
			if (isMain) mgr.inflight = null;
			else mgr.devInflight = null;
		});
	if (isMain) mgr.inflight = job;
	else mgr.devInflight = job;
}

/** Blocking refresh of both sources — used by /live-models-catalog-refresh.
 *  Throws only when BOTH sources fail; a partial refresh still applies the
 *  successful one and returns the merged view. */
export async function refreshCatalogNow(mgr: CatalogManager): Promise<CatalogView> {
	const results = await Promise.allSettled([fetchCatalogData(), fetchModelsDevData()]);
	if (results[0].status === "fulfilled") {
		mgr.data = results[0].value;
		mgr.lastFailureAt = null;
		writeCatalogCache(results[0].value, catalogPath());
	}
	if (results[1].status === "fulfilled") {
		mgr.devData = results[1].value;
		mgr.devLastFailureAt = null;
		writeCatalogCache(results[1].value, modelsDevCatalogPath());
	}
	if (results[0].status === "rejected" && results[1].status === "rejected") {
		const reason = (results[0] as PromiseRejectedResult).reason;
		throw new Error(`all catalog sources failed (${reason instanceof Error ? reason.message : String(reason)})`);
	}
	return mergeCatalogSources(mgr.data, mgr.devData) as CatalogView;
}
