/**
 * Config loading and validation for pi-live-models.
 *
 * Config file: `<agentDir>/live-models.json` where agentDir is
 * `$PI_CODING_AGENT_DIR` or `~/.pi/agent`.
 *
 * Validation philosophy: field-precise, graceful degradation — an invalid
 * field produces a warning and is dropped; only entries without a usable
 * `baseUrl` are skipped entirely. The extension must never crash pi startup
 * because of a config typo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ModelDefaults {
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, number>;
}

export interface ModelOverride extends ModelDefaults {
	name?: string;
	compat?: Record<string, unknown>;
	api?: string;
}

export interface FiltersSpec {
	/** Glob whitelist on model id, case-insensitive (`*` wildcard). */
	include?: string[];
	/** Glob blacklist on model id, case-insensitive. Always wins over include. */
	exclude?: string[];
	/** Regex whitelist on model id, case-sensitive. */
	includeRegex?: string[];
	/** Regex blacklist on model id, case-sensitive. Always wins over include. */
	excludeRegex?: string[];
	/** Field-level glob whitelist keyed by dotted path into the live item, e.g. `{ "architecture.input_modalities": ["*text*"] }`. Every key must match (AND); missing field = drop. Globs are case-insensitive. */
	includeBy?: Record<string, string[]>;
	/** Field-level glob blacklist, same syntax. Any hit drops the model (OR). Wins over all include rules. */
	excludeBy?: Record<string, string[]>;
	/** Preset names (top-level `presets`) unioned into this spec. Flattened during parsing; raw configs only. */
	use?: string[];
}

/** Top-level global filters. Only blacklists are supported here (unioned with per-entry excludes). */
export interface DefaultFilters {
	exclude?: string[];
	excludeRegex?: string[];
	excludeBy?: Record<string, string[]>;
	use?: string[];
}

/** How live pricing hints (OpenRouter-style `pricing.*`, $/token) fill model cost. */
export type CostFromLive = "fill-zero" | "always" | "off";

/** Static catalog participation in the model list. */
export type MergeStatic = "live" | "union";

export interface ProviderEntry {
	name?: string;
	baseUrl: string;
	modelsUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	/** Fetch timeout for discovery requests, ms. Default 10000. */
	timeoutMs?: number;
	/** Minimum spacing between real fetches, ms. 0 (default) = refresh on every /model open. */
	refreshIntervalMs?: number;
	compat?: Record<string, unknown>;
	filters?: FiltersSpec;
	defaults?: ModelDefaults;
	overrides?: Record<string, ModelOverride>;
	/** Live pricing fill strategy. Default "fill-zero": use live pricing only when no other source (override/static/defaults) defines cost. */
	costFromLive?: CostFromLive;
	/** Enrich metadata from the public catalog (LiteLLM community data) for well-known models. Default true. */
	catalog?: boolean;
	/** "live" (default): only live-listed models, static defs only enrich metadata. "union": also register static-only models. */
	mergeStatic?: MergeStatic;
}

export interface LiveModelsConfig {
	/** Named reusable filter presets, referenced via `filters.use` / `defaultFilters.use`. */
	presets?: Record<string, FiltersSpec>;
	defaultFilters?: DefaultFilters;
	providers: Record<string, ProviderEntry>;
}

export interface ConfigIssue {
	/** Provider id the issue belongs to; absent for global fields. */
	provider?: string;
	field: string;
	message: string;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function configPath(): string {
	return path.join(agentDir(), "live-models.json");
}

export function cachePath(): string {
	return path.join(agentDir(), "live-models-cache.json");
}

export function catalogPath(): string {
	return path.join(agentDir(), "live-models-catalog.json");
}

export function modelsJsonPath(): string {
	return path.join(agentDir(), "models.json");
}

export function modelsStorePath(): string {
	return path.join(agentDir(), "models-store.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((item) => typeof item === "string") ? value : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
	if (!isPlainObject(value)) return null;
	for (const v of Object.values(value)) {
		if (typeof v !== "string") return null;
	}
	return value as Record<string, string>;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringArrayRecord(value: unknown): Record<string, string[]> | null {
	if (!isPlainObject(value)) return null;
	for (const v of Object.values(value)) {
		if (!Array.isArray(v) || !v.every((item) => typeof item === "string")) return null;
	}
	return value as Record<string, string[]>;
}

const LIST_FIELDS = ["include", "exclude", "includeRegex", "excludeRegex"] as const;
const BY_FIELDS = ["includeBy", "excludeBy"] as const;
const INCLUDE_FIELDS = ["include", "includeRegex", "includeBy"] as const;

/**
 * Parse + flatten one filter spec object (a preset body, defaultFilters, or a
 * provider's filters). `use` references are resolved against `presets` and
 * unioned field by field. In `blacklistOnly` mode include-style fields are
 * rejected — both written directly and contributed by presets — so a global
 * default can never create a whitelist.
 */
function parseFilterSpec(
	raw: unknown,
	where: string,
	issues: ConfigIssue[],
	presets: Record<string, FiltersSpec>,
	options: { allowUse: boolean; blacklistOnly?: boolean; provider?: string },
): FiltersSpec | undefined {
	if (!isPlainObject(raw)) {
		issues.push({ provider: options.provider, field: where, message: `${where} must be an object — ignored` });
		return undefined;
	}
	const spec: FiltersSpec = {};
	let any = false;

	const mergeLists = (source: FiltersSpec, label: string): void => {
		for (const field of LIST_FIELDS) {
			if (!source[field]?.length) continue;
			if (options.blacklistOnly && (INCLUDE_FIELDS as readonly string[]).includes(field)) {
				issues.push({ provider: options.provider, field: `${where}.use`, message: `preset "${label}" contributes ${field}() to ${where} — only blacklists apply here, include ignored` });
				continue;
			}
			spec[field] = [...(spec[field] ?? []), ...source[field]!];
			any = true;
		}
		for (const field of BY_FIELDS) {
			if (!source[field]) continue;
			if (options.blacklistOnly && (INCLUDE_FIELDS as readonly string[]).includes(field)) {
				issues.push({ provider: options.provider, field: `${where}.use`, message: `preset "${label}" contributes ${field} to ${where} — only blacklists apply here, include ignored` });
				continue;
			}
			const target: Record<string, string[]> = { ...(spec[field] ?? {}) };
			for (const [key, list] of Object.entries(source[field]!)) {
				target[key] = [...(target[key] ?? []), ...list];
			}
			spec[field] = target;
			any = true;
		}
	};

	for (const field of LIST_FIELDS) {
		const value = raw[field];
		if (value === undefined) continue;
		if (options.blacklistOnly && (INCLUDE_FIELDS as readonly string[]).includes(field)) {
			issues.push({ provider: options.provider, field: `${where}.${field}`, message: `${where}.${field} is not allowed here (global blacklists only) — ignored` });
			continue;
		}
		const list = stringArray(value);
		if (!list) {
			issues.push({ provider: options.provider, field: `${where}.${field}`, message: `${where}.${field} must be an array of strings — field ignored` });
			continue;
		}
		spec[field] = list;
		any = true;
	}
	for (const field of BY_FIELDS) {
		const value = raw[field];
		if (value === undefined) continue;
		if (options.blacklistOnly && (INCLUDE_FIELDS as readonly string[]).includes(field)) {
			issues.push({ provider: options.provider, field: `${where}.${field}`, message: `${where}.${field} is not allowed here (global blacklists only) — ignored` });
			continue;
		}
		const map = stringArrayRecord(value);
		if (!map) {
			issues.push({ provider: options.provider, field: `${where}.${field}`, message: `${where}.${field} must be an object of field -> array of strings — field ignored` });
			continue;
		}
		spec[field] = map;
		any = true;
	}

	if (raw.use !== undefined) {
		const useList = stringArray(raw.use);
		if (!options.allowUse) {
			issues.push({ provider: options.provider, field: `${where}.use`, message: `${where}.use is not allowed here (presets cannot reference presets) — ignored` });
		} else if (!useList) {
			issues.push({ provider: options.provider, field: `${where}.use`, message: `${where}.use must be an array of strings — ignored` });
		} else {
			for (const name of useList) {
				const preset = presets[name];
				if (!preset) {
					issues.push({ provider: options.provider, field: `${where}.use`, message: `${where}.use references unknown preset "${name}" — ignored` });
					continue;
				}
				mergeLists(preset, name);
			}
		}
	}

	return any ? spec : undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Parse + validate a raw config object.
 *
 * @param raw contents of live-models.json (already JSON.parse'd)
 * @returns the sanitized config, per-field issues, and the ids of providers
 *          that had to be skipped entirely (unusable baseUrl).
 */
export function parseConfig(
	raw: unknown,
): { config: LiveModelsConfig; issues: ConfigIssue[]; skipped: string[] } {
	const issues: ConfigIssue[] = [];
	const skipped: string[] = [];
	const config: LiveModelsConfig = { providers: {} };

	if (!isPlainObject(raw)) {
		issues.push({ field: "(root)", message: "config root must be a JSON object" });
		return { config, issues, skipped };
	}

	// --- global presets (parsed first so defaultFilters/providers can reference them) ---
	const presets: Record<string, FiltersSpec> = {};
	if (raw.presets !== undefined) {
		const rawPresets = raw.presets;
		if (!isPlainObject(rawPresets)) {
			issues.push({ field: "presets", message: "presets must be an object mapping name -> filter spec — ignored" });
		} else {
			for (const [name, body] of Object.entries(rawPresets)) {
				const spec = parseFilterSpec(body, `presets.${name}`, issues, {}, { allowUse: false });
				if (spec) presets[name] = spec;
			}
			if (Object.keys(presets).length) config.presets = presets;
		}
	}

	// --- global defaultFilters (blacklist union only) ---
	if (raw.defaultFilters !== undefined) {
		const parsed = parseFilterSpec(raw.defaultFilters, "defaultFilters", issues, presets, { allowUse: true, blacklistOnly: true });
		if (parsed) config.defaultFilters = parsed;
	}

	// --- providers ---
	const providers = raw.providers;
	if (!isPlainObject(providers)) {
		issues.push({ field: "providers", message: "providers must be an object mapping provider id -> entry" });
		return { config, issues, skipped };
	}

	for (const [id, entryRaw] of Object.entries(providers)) {
		if (!isPlainObject(entryRaw)) {
			issues.push({ provider: id, field: "(entry)", message: `providers.${id} must be an object — entry skipped` });
			skipped.push(id);
			continue;
		}
		const entry: ProviderEntry = {} as ProviderEntry;

		// baseUrl: required, http(s)
		const baseUrl = optionalString(entryRaw.baseUrl);
		if (!baseUrl) {
			issues.push({ provider: id, field: "baseUrl", message: `providers.${id}.baseUrl is required — entry skipped` });
			skipped.push(id);
			continue;
		}
		if (!isHttpUrl(baseUrl)) {
			issues.push({ provider: id, field: "baseUrl", message: `providers.${id}.baseUrl must be an http(s) URL — entry skipped` });
			skipped.push(id);
			continue;
		}
		entry.baseUrl = baseUrl;

		// optional plain strings
		for (const field of ["name", "modelsUrl", "api", "apiKey"] as const) {
			const value = optionalString(entryRaw[field]);
			if (value !== undefined) entry[field] = value;
			else if (entryRaw[field] !== undefined) {
				issues.push({ provider: id, field, message: `providers.${id}.${field} must be a string — ignored` });
			}
		}

		// headers
		if (entryRaw.headers !== undefined) {
			const headers = stringRecord(entryRaw.headers);
			if (!headers) issues.push({ provider: id, field: "headers", message: `providers.${id}.headers must be an object of string -> string — ignored` });
			else entry.headers = headers;
		}

		// numeric knobs
		if (entryRaw.timeoutMs !== undefined) {
			const timeoutMs = optionalPositiveNumber(entryRaw.timeoutMs);
			if (timeoutMs === undefined) issues.push({ provider: id, field: "timeoutMs", message: `providers.${id}.timeoutMs must be a positive number — ignored (default 10000)` });
			else entry.timeoutMs = timeoutMs;
		}
		if (entryRaw.refreshIntervalMs !== undefined) {
			const refreshIntervalMs = optionalPositiveNumber(entryRaw.refreshIntervalMs);
			if (refreshIntervalMs === undefined) issues.push({ provider: id, field: "refreshIntervalMs", message: `providers.${id}.refreshIntervalMs must be a positive number — ignored (default 0 = refresh every time)` });
			else entry.refreshIntervalMs = refreshIntervalMs;
		}

		// enum knobs
		if (entryRaw.costFromLive !== undefined) {
			const value = entryRaw.costFromLive;
			if (value === "fill-zero" || value === "always" || value === "off") entry.costFromLive = value;
			else issues.push({ provider: id, field: "costFromLive", message: `providers.${id}.costFromLive must be one of "fill-zero" | "always" | "off" — ignored (default fill-zero)` });
		}
		if (entryRaw.mergeStatic !== undefined) {
			const value = entryRaw.mergeStatic;
			if (value === "live" || value === "union") entry.mergeStatic = value;
			else issues.push({ provider: id, field: "mergeStatic", message: `providers.${id}.mergeStatic must be "live" or "union" — ignored (default live)` });
		}
		if (entryRaw.catalog !== undefined) {
			if (typeof entryRaw.catalog === "boolean") entry.catalog = entryRaw.catalog;
			else issues.push({ provider: id, field: "catalog", message: `providers.${id}.catalog must be a boolean — ignored (default true)` });
		}

		// filters (presets resolved and flattened here)
		if (entryRaw.filters !== undefined) {
			const filters = parseFilterSpec(entryRaw.filters, `providers.${id}.filters`, issues, presets, { allowUse: true, provider: id });
			if (filters) entry.filters = filters;
		}

		// compat / defaults / overrides: passed through as opaque objects
		if (isPlainObject(entryRaw.compat)) entry.compat = entryRaw.compat;
		else if (entryRaw.compat !== undefined) issues.push({ provider: id, field: "compat", message: `providers.${id}.compat must be an object — ignored` });

		if (isPlainObject(entryRaw.defaults)) entry.defaults = entryRaw.defaults as ModelDefaults;
		else if (entryRaw.defaults !== undefined) issues.push({ provider: id, field: "defaults", message: `providers.${id}.defaults must be an object — ignored` });

		if (isPlainObject(entryRaw.overrides)) entry.overrides = entryRaw.overrides as Record<string, ModelOverride>;
		else if (entryRaw.overrides !== undefined) issues.push({ provider: id, field: "overrides", message: `providers.${id}.overrides must be an object — ignored` });

		config.providers[id] = entry;
	}

	return { config, issues, skipped };
}

export interface FixPatch {
	contextWindow?: number;
	maxTokens?: number;
}

/**
 * Apply an override patch to the RAW config object (as JSON.parse'd from
 * live-models.json), preserving every other field and the original key order.
 * Mutates `raw` in place; the caller persists it. Never throws.
 */
export function applyFixToRawConfig(
	raw: unknown,
	providerId: string,
	modelId: string,
	patch: FixPatch,
): { ok: boolean; error?: string } {
	if (!isPlainObject(raw)) return { ok: false, error: "config root is not an object" };
	// Reject prototype-reserved ids: obj["__proto__"] hits the inherited
	// getter (not an own property), which would let a fix write into
	// Object.prototype and "succeed" without changing the file.
	const reserved = new Set(["__proto__", "constructor", "prototype"]);
	if (reserved.has(providerId) || reserved.has(modelId)) {
		return { ok: false, error: `"${reserved.has(providerId) ? providerId : modelId}" is not a valid id` };
	}
	const providers = raw.providers;
	if (!isPlainObject(providers) || !isPlainObject(providers[providerId])) {
		return { ok: false, error: `provider "${providerId}" not found in config` };
	}
	const entry = providers[providerId] as Record<string, unknown>;
	if (!isPlainObject(entry.overrides)) entry.overrides = {};
	const overrides = entry.overrides as Record<string, unknown>;
	if (!isPlainObject(overrides[modelId])) overrides[modelId] = {};
	const model = overrides[modelId] as Record<string, unknown>;
	if (patch.contextWindow !== undefined) model.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) model.maxTokens = patch.maxTokens;
	return { ok: true };
}

/**
 * Read + parse the config file from disk. Missing file or broken JSON
 * degrades to an empty config with an issue (never throws).
 */
export function loadConfigFile(): { config: LiveModelsConfig; issues: ConfigIssue[]; skipped: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { config: { providers: {} }, issues: [], skipped: [] };
		}
		const message = err instanceof Error ? err.message : String(err);
		return { config: { providers: {} }, issues: [{ field: "(file)", message: `failed to parse ${configPath()}: ${message}` }], skipped: [] };
	}
	return parseConfig(raw);
}
