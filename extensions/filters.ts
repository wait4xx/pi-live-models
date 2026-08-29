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

export interface CompiledFilters {
	patterns: CompiledPattern[];
	invalid: InvalidPattern[];
	/** True when any include pattern exists (whitelist mode). */
	hasWhitelist: boolean;
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

	addGlob("include", spec?.include);
	addRegex("include", spec?.includeRegex);
	addGlob("exclude", spec?.exclude);
	addRegex("exclude", spec?.excludeRegex);
	// global blacklist union
	addGlob("exclude", defaults?.exclude);
	addRegex("exclude", defaults?.excludeRegex);

	return {
		patterns,
		invalid,
		hasWhitelist: patterns.some((p) => p.list === "include"),
	};
}

/** Apply compiled filters to one model id. Excludes first, then whitelist. */
export function applyFilters(id: string, filters: CompiledFilters): FilterOutcome {
	for (const p of filters.patterns) {
		if (p.list === "exclude" && p.re.test(id)) {
			return { id, kept: false, reason: `${p.kind === "glob" ? "exclude" : "excludeRegex"}:${p.pattern}` };
		}
	}
	if (filters.hasWhitelist) {
		for (const p of filters.patterns) {
			if (p.list === "include" && p.re.test(id)) {
				return { id, kept: true, reason: `${p.kind === "glob" ? "include" : "includeRegex"}:${p.pattern}` };
			}
		}
		return { id, kept: false, reason: "whitelist-miss" };
	}
	return { id, kept: true };
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
