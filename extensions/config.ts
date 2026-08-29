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
}

/** Top-level global filters. Only blacklists are supported here (unioned with per-entry excludes). */
export interface DefaultFilters {
	exclude?: string[];
	excludeRegex?: string[];
}

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
}

export interface LiveModelsConfig {
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

	// --- global defaultFilters (blacklist union only) ---
	if (raw.defaultFilters !== undefined) {
		const df = raw.defaultFilters;
		const parsed: DefaultFilters = {};
		if (!isPlainObject(df)) {
			issues.push({ field: "defaultFilters", message: "defaultFilters must be an object" });
		} else {
			if (df.exclude !== undefined) {
				const exclude = stringArray(df.exclude);
				if (!exclude) issues.push({ field: "defaultFilters.exclude", message: "must be an array of strings" });
				else parsed.exclude = exclude;
			}
			if (df.excludeRegex !== undefined) {
				const excludeRegex = stringArray(df.excludeRegex);
				if (!excludeRegex) issues.push({ field: "defaultFilters.excludeRegex", message: "must be an array of strings" });
				else parsed.excludeRegex = excludeRegex;
			}
		}
		if (parsed.exclude || parsed.excludeRegex) config.defaultFilters = parsed;
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

		// filters
		if (entryRaw.filters !== undefined) {
			const filtersRaw = entryRaw.filters;
			if (!isPlainObject(filtersRaw)) {
				issues.push({ provider: id, field: "filters", message: `providers.${id}.filters must be an object — ignored (no filtering)` });
			} else {
				const filters: FiltersSpec = {};
				let any = false;
				for (const field of ["include", "exclude", "includeRegex", "excludeRegex"] as const) {
					const value = filtersRaw[field];
					if (value === undefined) continue;
					const list = stringArray(value);
					if (!list) {
						issues.push({ provider: id, field: `filters.${field}`, message: `providers.${id}.filters.${field} must be an array of strings — field ignored` });
						continue;
					}
					filters[field] = list;
					any = true;
				}
				if (any) entry.filters = filters;
			}
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
