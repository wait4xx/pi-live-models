/**
 * Filter subsystem for pi-live-models.
 *
 * Principles (pinned by unit tests):
 *   1. Zero filtering by default — an unconfigured provider passes every model.
 *   2. Exclude always wins: a model matching any exclude pattern is dropped,
 *      even if it also matches an include pattern.
 *   3. Non-empty include set (glob OR regex, unioned) acts as a whitelist:
 *      a model must match at least one include pattern to survive.
 *   4. Globs are case-insensitive; regexes are case-sensitive (use `(?i)` if
 *      you need insensitivity).
 *   5. Invalid regexes are collected as warnings and ignored — they never
 *      break the config or silently filter everything.
 *
 * No filtering knowledge is hardcoded: this extension has zero opinions about
 * which models are "good" — every opinion belongs to user config.
 */
import type { DefaultFilters, FiltersSpec } from "./config.ts";

export interface CompiledPattern {
	kind: "glob" | "regex";
	list: "include" | "exclude";
	/** Original pattern as written in config (used in drop reasons). */
	pattern: string;
	re: RegExp;
}

export interface InvalidPattern {
	/** Config location, e.g. `GLM.filters.includeRegex`. */
	where: string;
	pattern: string;
	error: string;
}

/** Field-level glob rule: dotted path into the live item -> compiled globs. */
export interface CompiledFieldRule {
	field: string;
	patterns: Array<{ pattern: string; re: RegExp }>;
}

export interface CompiledFilters {
	patterns: CompiledPattern[];
	invalid: InvalidPattern[];
	/** True when any include rule exists (id patterns or includeBy fields) — whitelist mode. */
	hasWhitelist: boolean;
	/** True when id include patterns exist (subset of whitelist mode). */
	hasIdInclude: boolean;
	/** Field whitelists — every rule must match (AND). Empty when unconfigured. */
	includeBy: CompiledFieldRule[];
	/** Field blacklists — any hit drops (OR). Empty when unconfigured. */
	excludeBy: CompiledFieldRule[];
}

export interface FilterOutcome {
	id: string;
	kept: boolean;
	/** Which rule decided the outcome, e.g. `exclude:*audio*` or `whitelist-miss`. */
	reason?: string;
}

export interface DropSummary {
	raw: number;
	kept: number;
	drops: Array<{ reason: string; count: number }>;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `*`-wildcard glob anchored at both ends, case-insensitive (legacy semantics). */
export function globToRegExp(glob: string): RegExp {
	return new RegExp(`^${glob.split("*").map(escapeRegExp).join(".*")}$`, "i");
}

/** Walk a dotted path (`a.b.c`) over a plain object; undefined when any hop is not an object. */
export function walkPath(item: Record<string, unknown> | undefined, fieldPath: string): unknown {
	let value: unknown = item;
	for (const part of fieldPath.split(".")) {
		if (typeof value !== "object" || value === null) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

/** Test one field rule against a live item. Returns the hitting pattern, or undefined. Array values match if any element hits. */
function fieldMatch(item: Record<string, unknown> | undefined, rule: CompiledFieldRule): string | undefined {
	const value = walkPath(item, rule.field);
	const values = Array.isArray(value) ? value : [value];
	for (const v of values) {
		if (typeof v !== "string") continue;
		for (const { pattern, re } of rule.patterns) {
			if (re.test(v)) return pattern;
		}
	}
	return undefined;
}

/**
 * Compile per-entry filters + global default filters.
 *
 * Global defaults contribute ONLY blacklists (exclude union); whitelists are
 * intentionally per-entry so a global include can never silently starve a
 * provider that uses different naming.
 */
export function compileFilters(
	where: string,
	spec: FiltersSpec | undefined,
	defaults: DefaultFilters | undefined,
): CompiledFilters {
	const patterns: CompiledPattern[] = [];
	const invalid: InvalidPattern[] = [];
	const includeBy: CompiledFieldRule[] = [];
	const excludeBy: CompiledFieldRule[] = [];

	const addGlob = (list: "include" | "exclude", items: string[] | undefined): void => {
		for (const pattern of items ?? []) patterns.push({ kind: "glob", list, pattern, re: globToRegExp(pattern) });
	};
	const addRegex = (list: "include" | "exclude", items: string[] | undefined): void => {
		for (const pattern of items ?? []) {
			try {
				patterns.push({ kind: "regex", list, pattern, re: new RegExp(pattern) });
			} catch (err) {
				invalid.push({ where, pattern, error: err instanceof Error ? err.message : String(err) });
			}
		}
	};
	const addFieldRules = (target: CompiledFieldRule[], map: Record<string, string[]> | undefined): void => {
		for (const [field, globs] of Object.entries(map ?? {})) {
			if (!globs.length) continue;
			target.push({ field, patterns: globs.map((pattern) => ({ pattern, re: globToRegExp(pattern) })) });
		}
	};

	addGlob("include", spec?.include);
	addRegex("include", spec?.includeRegex);
	addGlob("exclude", spec?.exclude);
	addRegex("exclude", spec?.excludeRegex);
	addFieldRules(includeBy, spec?.includeBy);
	addFieldRules(excludeBy, spec?.excludeBy);
	// global blacklist union
	addGlob("exclude", defaults?.exclude);
	addRegex("exclude", defaults?.excludeRegex);
	addFieldRules(excludeBy, defaults?.excludeBy);

	const hasIdInclude = patterns.some((p) => p.list === "include");
	return {
		patterns,
		invalid,
		hasIdInclude,
		hasWhitelist: hasIdInclude || includeBy.length > 0,
		includeBy,
		excludeBy,
	};
}

/**
 * Apply compiled filters to one model: id excludes, then field excludes, then
 * whitelist (id includes and/or includeBy fields — both must pass when both
 * are configured; includeBy rules are ANDed among themselves).
 * `item` is the raw live endpoint entry (or a static def during union merges);
 * when absent, field rules simply cannot match.
 */
export function applyFilters(id: string, filters: CompiledFilters, item?: Record<string, unknown>): FilterOutcome {
	for (const p of filters.patterns) {
		if (p.list === "exclude" && p.re.test(id)) {
			return { id, kept: false, reason: `${p.kind === "glob" ? "exclude" : "excludeRegex"}:${p.pattern}` };
		}
	}
	for (const rule of filters.excludeBy) {
		const hit = fieldMatch(item, rule);
		if (hit !== undefined) {
			return { id, kept: false, reason: `excludeBy:${rule.field}:${hit}` };
		}
	}
	if (filters.hasIdInclude) {
		for (const p of filters.patterns) {
			if (p.list === "include" && p.re.test(id)) {
				const drop = includeByDrop(id, filters, item);
				if (drop) return drop;
				return { id, kept: true, reason: `${p.kind === "glob" ? "include" : "includeRegex"}:${p.pattern}` };
			}
		}
		return { id, kept: false, reason: "whitelist-miss" };
	}
	if (filters.includeBy.length) {
		const drop = includeByDrop(id, filters, item);
		if (drop) return drop;
	}
	return { id, kept: true };
}

/** Every includeBy rule must hit; returns the drop outcome for the first miss. */
function includeByDrop(id: string, filters: CompiledFilters, item: Record<string, unknown> | undefined): FilterOutcome | undefined {
	for (const rule of filters.includeBy) {
		const hit = fieldMatch(item, rule);
		if (hit === undefined) {
			return { id, kept: false, reason: `includeBy-miss:${rule.field}` };
		}
	}
	return undefined;
}

/** Aggregate outcomes into counts, biggest drops first. */
export function summarizeDrops(outcomes: FilterOutcome[]): DropSummary {
	const byReason = new Map<string, number>();
	let kept = 0;
	for (const outcome of outcomes) {
		if (outcome.kept) {
			kept++;
			continue;
		}
		const reason = outcome.reason ?? "unknown";
		byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
	}
	return {
		raw: outcomes.length,
		kept,
		drops: [...byReason.entries()]
			.map(([reason, count]) => ({ reason, count }))
			.sort((a, b) => b.count - a.count),
	};
}
