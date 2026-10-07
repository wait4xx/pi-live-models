/**
 * Config loading and validation for pi-live-models.
 *
 * Config file: `<agentDir>/live-models.json` where agentDir is
 * `$PI_CODING_AGENT_DIR` or `~/.pi/agent`.
 *
 * Validation philosophy: field-precise, graceful degradation — an invalid
 * field produces a warning and is dropped; only entries without a usable
 * `baseUrl` (explicit or inherited from the same-id models.json provider)
 * are skipped entirely. The extension must never crash pi startup
 * because of a config typo.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ModelDefaults {
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, number>;
	/** pi thinking-level -> provider effort string (or null = level unavailable). Applied to every model unless overridden per id. */
	thinkingLevelMap?: Record<string, string | null>;
	/** Extra sampling params merged into requests (pi model-level `samplingParams`). */
	samplingParams?: Record<string, unknown>;
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
	/** http(s) API root. Inline `$VAR`/`${VAR}` references and a leading `!command` resolve once at config load; the resolved URL is registered with pi and fetched by discovery. Inherited models.json baseUrls resolve the same way. */
	baseUrl: string;
	/** Explicit models-endpoint override. Same env/command resolution as {@link ProviderEntry.baseUrl}, at config load; an unresolvable spec is ignored with a warning (discovery then derives the endpoint from baseUrl). */
	modelsUrl?: string;
	api?: string;
	apiKey?: string;
	/** Force an `Authorization: Bearer <key>` header on every chat request (pi's `authHeader`). Default false (pi's default). Discovery/probe fetches mirror chat auth per api family (anthropic → `x-api-key`); an explicit `false` additionally suppresses the synthesized `Authorization` there — escape hatch for custom-header auth (e.g. `x-goog-api-key`). */
	authHeader?: boolean;
	/** Extra headers for this extension's own fetches and pi's chat registration (specs passed through raw; pi resolves them per chat request). Values may use `$VAR`/`${VAR}`/`!command`; a value whose env var is unset is skipped with a warning, never sent as an empty string. */
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
	/** Enrich metadata from the public catalogs (LiteLLM + Models.dev community data) for well-known models. Default true. */
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

/** The shape of a models.json provider entry, as used for baseUrl inheritance. */
export interface StaticProviderRef {
	baseUrl?: unknown;
}

/** Options for {@link parseConfig}. */
export interface ParseOptions {
	/**
	 * models.json `providers` map. An entry that omits `baseUrl` inherits it
	 * from the same-id provider here; an entry with no usable match is
	 * skipped. Passing `null`/`undefined` disables inheritance entirely.
	 */
	staticProviders?: Record<string, StaticProviderRef> | null;
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

export function modelsDevCatalogPath(): string {
	return path.join(agentDir(), "live-models-catalog-modelsdev.json");
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

/** Provider ids that must never be written into a config file. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/** One piece of a parsed config-value template: literal text or an env reference. */
type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/** A config-value spec parsed into either a shell command or template parts. */
type ParsedConfigValue = { kind: "command"; command: string } | { kind: "template"; parts: TemplatePart[] };

/**
 * Parse a config-value spec with pi's own resolution rules (pi core
 * resolve-config-value): a leading `!` marks the whole value as a shell
 * command; otherwise inline `$VAR` and `${VAR}` interpolate, `$$`/`$!`
 * escape a literal `$`/`!`, and `${not-a-name}`/stray `$` stay literal.
 */
function parseConfigValueTemplate(spec: string): ParsedConfigValue {
	if (spec.startsWith("!")) return { kind: "command", command: spec.slice(1) };
	const parts: TemplatePart[] = [];
	const appendLiteral = (value: string): void => {
		if (!value) return;
		const previous = parts[parts.length - 1];
		if (previous?.type === "literal") previous.value += value;
		else parts.push({ type: "literal", value });
	};
	let index = 0;
	while (index < spec.length) {
		const dollarIndex = spec.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(spec.slice(index));
			break;
		}
		appendLiteral(spec.slice(index, dollarIndex));
		const next = spec[dollarIndex + 1];
		if (next === "$" || next === "!") {
			appendLiteral(next);
			index = dollarIndex + 2;
			continue;
		}
		if (next === "{") {
			const endIndex = spec.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral("$");
				index = dollarIndex + 1;
				continue;
			}
			const name = spec.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: "env", name });
			else appendLiteral(spec.slice(dollarIndex, endIndex + 1));
			index = endIndex + 1;
			continue;
		}
		const match = spec.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}
		appendLiteral("$");
		index = dollarIndex + 1;
	}
	return { kind: "template", parts };
}

/**
 * Resolve a config-value spec the way pi resolves its own: a leading `!`
 * runs a shell command and uses its trimmed stdout; otherwise interpolate
 * inline `$VAR`/`${VAR}` (`$$`/`$!` escape literals). An env var that is
 * unset (or set to an empty string, pi's convention) or a failing/empty
 * command makes the whole value undefined — never an empty interpolation.
 *
 * @param spec raw config string
 * @returns the resolved value, or undefined when a reference cannot be
 *          resolved (unset env var, failed or empty command)
 */
export function resolveConfigValue(spec: string): string | undefined {
	const parsed = parseConfigValueTemplate(spec);
	if (parsed.kind === "command") {
		try {
			// stdin ignored like pi's executeCommand — a spec that reads stdin
		// fails fast instead of hanging until the timeout.
			return execSync(parsed.command, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	let resolved = "";
	for (const part of parsed.parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		// pi treats empty-string env vars as unset (env[name] || undefined).
		const value = process.env[part.name] || undefined;
		if (value === undefined) return undefined;
		resolved += value;
	}
	return resolved;
}

/**
 * Env var names a spec references that are currently unset (empty-string
 * values count as unset, matching {@link resolveConfigValue}). Command
 * specs reference nothing.
 */
export function missingEnvNames(spec: string): string[] {
	const parsed = parseConfigValueTemplate(spec);
	if (parsed.kind !== "template") return [];
	const names = new Set<string>();
	for (const part of parsed.parts) {
		if (part.type === "env" && !(process.env[part.name] || undefined)) names.add(part.name);
	}
	return [...names];
}

/**
 * Parse + validate a raw config object.
 *
 * @param raw contents of live-models.json (already JSON.parse'd)
 * @param opts pass `staticProviders` (models.json providers) to let entries
 *             without an explicit `baseUrl` inherit it from the same-id
 *             models.json provider
 * @returns the sanitized config, per-field issues, and the ids of providers
 *          that had to be skipped entirely (no usable baseUrl).
 */
export function parseConfig(
	raw: unknown,
	opts?: ParseOptions,
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
		// A providers key naming an Object.prototype member (JSON.parse can
		// create an own "__proto__" key) would either re-[[Prototype]] the map
		// below or silently shadow an inherited member — reject it explicitly,
		// like every other invalid entry.
		if (RESERVED_IDS.has(id)) {
			issues.push({ provider: id, field: "(entry)", message: `providers.${id} is not a valid provider id — entry skipped` });
			skipped.push(id);
			continue;
		}
		if (!isPlainObject(entryRaw)) {
			issues.push({ provider: id, field: "(entry)", message: `providers.${id} must be an object — entry skipped` });
			skipped.push(id);
			continue;
		}
		const entry: ProviderEntry = {} as ProviderEntry;

		// baseUrl: explicit value wins; an omitted baseUrl is inherited from
		// the same-id models.json provider (when a staticProviders map was
		// given); no usable source -> skip the entry entirely. Env/command
		// specs resolve BEFORE the http(s) check so an unset variable is
		// reported by name instead of as an invalid URL.
		const inheritedSpec = entryRaw.baseUrl === undefined && opts?.staticProviders
			? optionalString(opts.staticProviders[id]?.baseUrl)
			: undefined;
		const baseUrlSpec = entryRaw.baseUrl !== undefined ? optionalString(entryRaw.baseUrl) : inheritedSpec;
		const baseUrl = baseUrlSpec !== undefined ? resolveConfigValue(baseUrlSpec) : undefined;
		if (baseUrl !== undefined && isHttpUrl(baseUrl)) {
			entry.baseUrl = baseUrl;
		} else if (baseUrlSpec !== undefined && baseUrl === undefined) {
			const names = missingEnvNames(baseUrlSpec);
			const reason = names.length ? `references undefined environment variable(s) ${names.join(", ")}` : "could not be resolved from its env/command spec";
			const origin = entryRaw.baseUrl === undefined ? " (inherited from models.json)" : "";
			issues.push({ provider: id, field: "baseUrl", message: `providers.${id}.baseUrl${origin} ${reason} — entry skipped` });
			skipped.push(id);
			continue;
		} else if (entryRaw.baseUrl === undefined && inheritedSpec === undefined) {
			const hint = opts?.staticProviders
				? ` — entry skipped (no usable "${id}" provider in models.json to inherit from)`
				: " — entry skipped";
			issues.push({ provider: id, field: "baseUrl", message: `providers.${id}.baseUrl is required${hint}` });
			skipped.push(id);
			continue;
		} else {
			const hint = entryRaw.baseUrl === undefined
				? ` — entry skipped (no usable "${id}" provider in models.json to inherit from)`
				: " — entry skipped";
			issues.push({ provider: id, field: "baseUrl", message: `providers.${id}.baseUrl must be an http(s) URL${hint}` });
			skipped.push(id);
			continue;
		}

		// optional plain strings (modelsUrl is handled below: env resolution)
		for (const field of ["name", "api", "apiKey"] as const) {
			const value = optionalString(entryRaw[field]);
			if (value !== undefined) entry[field] = value;
			else if (entryRaw[field] !== undefined) {
				issues.push({ provider: id, field, message: `providers.${id}.${field} must be a string — ignored` });
			}
		}

		// modelsUrl: env/command specs resolve at load; an unresolvable,
		// empty, or non-http(s) spec degrades to the baseUrl-derived
		// derivation, never to a broken fetch URL.
		if (entryRaw.modelsUrl !== undefined) {
			const spec = optionalString(entryRaw.modelsUrl);
			if (spec === undefined) {
				issues.push({ provider: id, field: "modelsUrl", message: `providers.${id}.modelsUrl must be a string — ignored` });
			} else {
				const resolved = resolveConfigValue(spec);
				if (!resolved) {
					const names = missingEnvNames(spec);
					const reason = names.length ? `references undefined environment variable(s) ${names.join(", ")}` : "could not be resolved from its env/command spec";
					issues.push({ provider: id, field: "modelsUrl", message: `providers.${id}.modelsUrl ${reason} — field ignored, discovery falls back to the baseUrl-derived URL` });
				} else if (!isHttpUrl(resolved)) {
					issues.push({ provider: id, field: "modelsUrl", message: `providers.${id}.modelsUrl must resolve to an http(s) URL — field ignored, discovery falls back to the baseUrl-derived URL` });
				} else {
					entry.modelsUrl = resolved;
				}
			}
		}

		// headers
		if (entryRaw.headers !== undefined) {
			const headers = stringRecord(entryRaw.headers);
			if (!headers) issues.push({ provider: id, field: "headers", message: `providers.${id}.headers must be an object of string -> string — ignored` });
			else entry.headers = headers;
		}

		// authHeader (forwarded to pi's provider registration)
		if (entryRaw.authHeader !== undefined) {
			if (typeof entryRaw.authHeader === "boolean") entry.authHeader = entryRaw.authHeader;
			else issues.push({ provider: id, field: "authHeader", message: `providers.${id}.authHeader must be a boolean — ignored` });
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
 * Build the provider registration config handed to pi's `registerProvider`:
 * everything the extension knows that pi's provider composer understands
 * (baseUrl/api/name/apiKey/headers/authHeader). Pure — kept here so the
 * field-forwarding contract is unit-testable without an ExtensionAPI.
 */
export function providerRegistrationConfig(entry: ProviderEntry): Record<string, unknown> {
	const cfg: Record<string, unknown> = { baseUrl: entry.baseUrl };
	if (entry.api !== undefined) cfg.api = entry.api;
	if (entry.name !== undefined) cfg.name = entry.name;
	if (entry.apiKey !== undefined) cfg.apiKey = entry.apiKey;
	if (entry.headers !== undefined) cfg.headers = entry.headers;
	if (entry.authHeader !== undefined) cfg.authHeader = entry.authHeader;
	return cfg;
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
	if (RESERVED_IDS.has(providerId) || RESERVED_IDS.has(modelId)) {
		return { ok: false, error: `"${RESERVED_IDS.has(providerId) ? providerId : modelId}" is not a valid id` };
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

/** Patch produced by /live-models-probe — see extensions/probe.ts. */
export interface ProbePatch {
	/** Complete 7-level pi thinking map (replaces any existing one). */
	thinkingLevelMap?: Record<string, string | null>;
	/** Model-level compat keys — merged onto any existing override compat. */
	compat?: Record<string, unknown>;
	/** Only ever true: an observed reasoning model. Never writes false. */
	reasoning?: boolean;
}

/**
 * Apply a probe patch to the RAW config object (as JSON.parse'd from
 * live-models.json), preserving every other field and the original key
 * order. thinkingLevelMap replaces wholesale (the suggestion is complete);
 * compat merges per key (suggested keys win); reasoning is set only when
 * the patch says true. Mutates `raw` in place; the caller persists it.
 * Never throws.
 */
export function applyProbeToRawConfig(
	raw: unknown,
	providerId: string,
	modelId: string,
	patch: ProbePatch,
): { ok: boolean; error?: string; fields: string[] } {
	if (!isPlainObject(raw)) return { ok: false, error: "config root is not an object", fields: [] };
	if (RESERVED_IDS.has(providerId) || RESERVED_IDS.has(modelId)) {
		return { ok: false, error: `"${RESERVED_IDS.has(providerId) ? providerId : modelId}" is not a valid id`, fields: [] };
	}
	const providers = raw.providers;
	if (!isPlainObject(providers) || !isPlainObject(providers[providerId])) {
		return { ok: false, error: `provider "${providerId}" not found in config`, fields: [] };
	}
	const entry = providers[providerId] as Record<string, unknown>;
	if (!isPlainObject(entry.overrides)) entry.overrides = {};
	const overrides = entry.overrides as Record<string, unknown>;
	if (!isPlainObject(overrides[modelId])) overrides[modelId] = {};
	const model = overrides[modelId] as Record<string, unknown>;
	const fields: string[] = [];
	if (patch.thinkingLevelMap !== undefined) {
		model.thinkingLevelMap = patch.thinkingLevelMap;
		fields.push("thinkingLevelMap");
	}
	if (patch.compat !== undefined) {
		const existing = isPlainObject(model.compat) ? (model.compat as Record<string, unknown>) : {};
		model.compat = { ...existing, ...patch.compat };
		fields.push("compat");
	}
	if (patch.reasoning === true) {
		model.reasoning = true;
		fields.push("reasoning");
	}
	return { ok: true, fields };
}

export interface InitStub {
	id: string;
	baseUrl: string;
}
export interface InitPlan {
	/** Provider ids absent from live-models.json that init would add, with their models.json baseUrl. */
	toAdd: InitStub[];
	/** Provider ids already configured in live-models.json — untouched. */
	existing: string[];
	/** models.json provider ids that cannot be adopted (reserved id, or no http(s) baseUrl). */
	unusable: string[];
}

/**
 * Plan a `/live-models-init`: which models.json providers would be added as
 * `{ baseUrl }` stubs, which are already configured, and which cannot be
 * adopted. Pure function over its inputs (no fs).
 */
export function computeInitPlan(
	staticProviders: Record<string, StaticProviderRef> | null | undefined,
	currentProviders: Record<string, unknown> | null | undefined,
): InitPlan {
	const plan: InitPlan = { toAdd: [], existing: [], unusable: [] };
	if (!staticProviders) return plan;
	for (const [id, entry] of Object.entries(staticProviders)) {
		if (RESERVED_IDS.has(id)) {
			plan.unusable.push(id);
			continue;
		}
		if (currentProviders && Object.prototype.hasOwnProperty.call(currentProviders, id)) {
			plan.existing.push(id);
			continue;
		}
		const baseUrl = optionalString(entry?.baseUrl);
		if (baseUrl !== undefined && isHttpUrl(baseUrl)) plan.toAdd.push({ id, baseUrl });
		else plan.unusable.push(id);
	}
	return plan;
}

/**
 * Merge init stubs into the RAW config object (as JSON.parse'd from
 * live-models.json), preserving every other field and the original key
 * order; stubs are appended after existing providers and never overwrite
 * them. Mutates `raw` in place; the caller persists it. Never throws.
 */
export function applyInitToRawConfig(raw: unknown, stubs: ReadonlyArray<InitStub>): { ok: boolean; error?: string } {
	if (!isPlainObject(raw)) return { ok: false, error: "config root is not an object" };
	const providers: Record<string, unknown> = isPlainObject(raw.providers) ? raw.providers : {};
	raw.providers = providers;
	for (const { id, baseUrl } of stubs) {
		if (RESERVED_IDS.has(id)) return { ok: false, error: `"${id}" is not a valid provider id` };
		if (Object.prototype.hasOwnProperty.call(providers, id)) continue; // never overwrite an existing entry (own keys only)
		providers[id] = { baseUrl };
	}
	return { ok: true };
}

/**
 * Read + parse the config file from disk. Missing file or broken JSON
 * degrades to an empty config with an issue (never throws). Entries that
 * omit `baseUrl` inherit it from the same-id models.json provider.
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
	return parseConfig(raw, { staticProviders: readStaticProviders() });
}

/**
 * Read the models.json `providers` map as a baseUrl-inheritance source.
 * Returns null when the file is missing, unreadable, or not the expected
 * shape — inheritance is then simply unavailable. Never throws.
 */
export function readStaticProviders(): Record<string, StaticProviderRef> | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
		if (!isPlainObject(raw)) return null;
		const providers = raw.providers;
		if (!isPlainObject(providers)) return null;
		return providers as Record<string, StaticProviderRef>;
	} catch {
		return null;
	}
}
