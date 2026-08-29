// test/arbitration.test.ts — normalized-key arbitration: vendor truth first,
// community consensus second, disagreement abstains, lone third-party sources
// are unverified. Regression root: glm-5.3-flash matched a lone
// together_ai deployment (max=1048575) and blew past the gateway's
// real 131072 limit (incident 2026-08-29).
import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCatalogIndex,
	catalogLookup,
	mergeCatalogSources,
	parseModelsDevCatalog,
	type CatalogModelEntry,
} from "../extensions/catalog.ts";
import { buildCatalog } from "../extensions/discover.ts";
import { compileFilters } from "../extensions/filters.ts";
import type { ProviderEntry } from "../extensions/config.ts";

function entry(extra: Partial<ProviderEntry>): ProviderEntry {
	return { ...extra, baseUrl: "https://x.example" } as ProviderEntry;
}
const FILTERS = compileFilters("T", undefined, undefined);

test("arbitration: vendor entry wins over disagreeing hosted deployments", () => {
	const index = buildCatalogIndex({
		"zai/glm-4.6": { contextWindow: 200000, maxTokens: 128000, provider: "zai" },
		"together_ai/zai-org/GLM-4.6": { contextWindow: 200000, maxTokens: 200000, provider: "together_ai" },
		"deepinfra/zai-org/GLM-4.6": { contextWindow: 202752, maxTokens: 202752, provider: "deepinfra" },
		"openrouter/z-ai/glm-4.6": { contextWindow: 202800, maxTokens: 131000, provider: "openrouter" },
	});
	const hit = catalogLookup(index, "glm-4.6");
	assert.equal(hit?.maxTokens, 128000, "vendor truth beats every hosted deployment");
	assert.equal(hit?.contextWindow, 200000);
});

test("arbitration: no vendor + consensus of independent sources is kept", () => {
	const index = buildCatalogIndex({
		"hoster-a/vendor-x/gadget-pro": { contextWindow: 100000, provider: "hoster-a" },
		"hoster-b/vendor-x/gadget-pro": { contextWindow: 100000, provider: "hoster-b" },
	});
	assert.equal(catalogLookup(index, "gadget-pro")?.contextWindow, 100000);
});

test("arbitration: disagreement without vendor abstains and is recorded divergent", () => {
	const index = buildCatalogIndex({
		"hoster-a/vendor-x/gadget-pro": { contextWindow: 100000, provider: "hoster-a" },
		"hoster-b/vendor-x/gadget-pro": { contextWindow: 200000, provider: "hoster-b" },
	});
	assert.equal(catalogLookup(index, "gadget-pro"), undefined, "no basis to choose — miss");
	const sigs = index.divergent.get("gadget-pro");
	assert.ok(sigs !== undefined && sigs.length === 2);
});

test("arbitration: lone third-party candidate is unverified, silently skipped (glm-5.3-flash shape)", () => {
	const index = buildCatalogIndex({
		"together_ai/zai-org/GLM-5.3-Flash": { contextWindow: 1048575, maxTokens: 1048575, provider: "together_ai" },
	});
	assert.equal(catalogLookup(index, "glm-5.3-flash"), undefined, "nothing to cross-check — miss");
	assert.equal(index.unverified.get("glm-5.3-flash"), "ctx=1048575 max=1048575");
	assert.equal(index.divergent.size, 0, "a lone source is not a disagreement");
});

test("arbitration: conflicting vendor entries also abstain", () => {
	const index = buildCatalogIndex({
		"zai/foo": { contextWindow: 100, provider: "zai" },
		"zai/foo-20241120": { contextWindow: 200, provider: "zai" }, // dated alias of the same vendor
	});
	assert.equal(catalogLookup(index, "foo"), undefined);
	assert.ok((index.divergent.get("foo") ?? []).length === 2);
});

test("arbitration: three-segment key whose first segment matches the provider is NOT vendor", () => {
	const index = buildCatalogIndex({
		"zai/zai/glm-x": { contextWindow: 999999, provider: "zai" }, // hosted-style path
	});
	assert.equal(catalogLookup(index, "glm-x"), undefined);
	assert.ok(index.unverified.has("glm-x"));
});

test("arbitration: entries without a provider field never count as vendor (old cache)", () => {
	const index = buildCatalogIndex({
		"zai/glm-4.6": { contextWindow: 200000, maxTokens: 128000 }, // provider lost (0.3.0 cache)
		"hoster/zai-org/GLM-4.6": { contextWindow: 200000, maxTokens: 200000 },
	});
	assert.equal(catalogLookup(index, "glm-4.6"), undefined, "degrades to disagreement, never trusts a blind guess");
	assert.ok(index.divergent.has("glm-4.6"));
});

test("warnings: divergent match surfaces the disagreement with a fix hint; unverified stays silent", () => {
	const index = buildCatalogIndex({
		"hoster-a/zai-org/GLM-5.2": { contextWindow: 262144, maxTokens: 262144, provider: "hoster-a" },
		"hoster-b/zai-org/GLM-5.2": { contextWindow: 1048576, maxTokens: 131072, provider: "hoster-b" },
		"hoster-c/zai-org/GLM-5.3-Flash": { contextWindow: 1048575, maxTokens: 1048575, provider: "hoster-c" },
	});
	const result = buildCatalog(
		[
			{ id: "glm-5.2", context_length: 128000 },
			{ id: "glm-5.3-flash", context_length: 128000, max_tokens: 128000 },
		],
		{ entry: entry({}), filters: FILTERS, staticById: {}, providerId: "GLM", catalog: index },
	);
	const diverged = result.warnings.find((w: string) => w.includes("glm-5.2"));
	assert.ok(diverged !== undefined, "disagreement is surfaced");
	assert.ok(diverged.includes("providers disagree"), "explains WHY no correction applies");
	assert.ok(diverged.includes("/live-models-fix GLM glm-5.2"), "hands the decision to the user");
	const lone = result.warnings.find((w: string) => w.includes("glm-5.3-flash"));
	assert.ok(lone === undefined, "unverified single sources do not spam warnings");
	// the models fall back to the ladder below catalog (live passed the window here)
	const flash = result.liveModels.find((m: { id: string; maxTokens?: number; maxSource?: string }) => m.id === "glm-5.3-flash");
	assert.equal(flash?.maxTokens, 128000, "live value stands when the catalog abstains");
	assert.equal(flash?.maxSource, "live");
});

// ------------------------------------------------- 0.3.2: models.dev source

test("models.dev: parse maps <slug>/<id> WITHOUT provider (never vendor) ; junk skipped", () => {
	const models = parseModelsDevCatalog({
		zai: {
			models: {
				"glm-5.3-flash": { limit: { context: 1000000, output: 131072 } },
				"glm-5.2": { limit: { context: 1000000 } }, // max absent -> ctx only
				"broken": { no_limit_here: true }, // no limit block -> skipped
				"silly": { limit: { context: 7, output: 3 } }, // fails sanity windows
			},
		},
		"not-a-provider": 42, // defensive: skipped
	});
	assert.deepEqual(Object.keys(models).sort(), ["zai/glm-5.2", "zai/glm-5.3-flash"]);
	assert.equal(models["zai/glm-5.3-flash"]?.provider, undefined, "no provider field -> models.dev entries never claim vendor status");
	assert.equal(models["zai/glm-5.3-flash"]?.maxTokens, 131072);
	assert.equal(models["zai/glm-5.2"]?.maxTokens, undefined);
});

test("merge: non-conflicting entries merge; same-key entries become extras", () => {
	const litellm: Record<string, CatalogModelEntry> = {
		"zai/glm-4.6": { contextWindow: 200000, maxTokens: 128000, provider: "zai" },
		"gpt-4o": { contextWindow: 128000 },
	};
	const dev: Record<string, CatalogModelEntry> = {
		"zai/glm-4.6": { contextWindow: 204800, maxTokens: 131072, provider: "zai" },
		"zai/glm-5.3-flash": { contextWindow: 1000000, maxTokens: 131072, provider: "zai" },
	};
	const view = mergeCatalogSources(
		{ url: "https://a", fetchedAt: 100, models: litellm },
		{ url: "https://b", fetchedAt: 200, models: dev },
	)!;
	assert.equal(view.data.models["gpt-4o"]?.contextWindow, 128000);
	assert.equal(view.data.models["zai/glm-5.3-flash"]?.maxTokens, 131072);
	assert.equal(view.data.models["zai/glm-4.6"]?.contextWindow, 200000, "first source keeps the exact key");
	assert.equal(view.extraEntries.length, 1);
	assert.equal(view.extraEntries[0]?.[0], "zai/glm-4.6");
	assert.equal(view.data.fetchedAt, 200, "freshest of the two");
	assert.ok(view.data.url.includes(" + "));
	assert.equal(mergeCatalogSources(null, null), null);
});

test("vendor tolerance: same official limit in different roundings merges to the conservative minimum", () => {
	// Two litellm vendor entries (dated alias) quoting decimal vs binary
	// roundings — 2.4% apart, same official spec. Not a disagreement.
	const index = buildCatalogIndex({
		"zai/glm-4.6": { contextWindow: 200000, maxTokens: 128000, provider: "zai" },
		"zai/glm-4.6-20241120": { contextWindow: 204800, maxTokens: 131072, provider: "zai" },
	});
	const hit = catalogLookup(index, "glm-4.6");
	assert.equal(hit?.contextWindow, 200000, "conservative minimum");
	assert.equal(hit?.maxTokens, 128000, "conservative minimum");
	assert.equal(index.divergent.size, 0);
});

test("vendor tolerance: models.dev entries never claim vendor even as same-key extras", () => {
	// mergeCatalogSources keeps the models.dev copy of zai/glm-4.6 as an
	// extra — it must not become a second vendor opinion (resellers use the
	// same bare ids, e.g. vancine/glm-5.3-flash, and cannot be told apart).
	const index = buildCatalogIndex(
		{ "zai/glm-4.6": { contextWindow: 200000, maxTokens: 128000, provider: "zai" } },
		[["zai/glm-4.6", { contextWindow: 204800, maxTokens: 131072 }]],
	);
	const hit = catalogLookup(index, "glm-4.6");
	assert.equal(hit?.contextWindow, 200000, "the one real vendor decides");
	assert.equal(hit?.maxTokens, 128000);
	assert.equal(index.divergent.size, 0);
});

test("vendor tolerance: real disagreement (beyond tolerance) still abstains", () => {
	const index = buildCatalogIndex(
		{ "zai/foo": { contextWindow: 100000, maxTokens: 128000, provider: "zai" } },
		[["zai/foo", { contextWindow: 100000, maxTokens: 262144, provider: "zai" }]], // 105% apart
	);
	assert.equal(catalogLookup(index, "foo"), undefined);
	assert.ok(index.divergent.has("foo"));
});

test("vendor tolerance: context within, output beyond tolerance -> divergent (per-field check)", () => {
	const index = buildCatalogIndex(
		{ "zai/bar": { contextWindow: 200000, maxTokens: 128000, provider: "zai" } },
		[["zai/bar", { contextWindow: 202752, maxTokens: 99000, provider: "zai" }]], // max 29% apart
	);
	assert.equal(catalogLookup(index, "bar"), undefined);
	assert.ok(index.divergent.has("bar"));
});

test("dual-source end-to-end: models.dev supplies coverage; glm-5.3-flash surfaces a usable divergence", () => {
	// The exact 2026-08-29 incident shape: litellm has only the together_ai
	// deployment; models.dev adds the official zai entry — but since models.dev
	// entries never claim vendor status, the group honestly disagrees and the
	// warning hands the decision (and the values, incl. the official one) to
	// the user instead of silently trusting a platform limit.
	const litellm: Record<string, CatalogModelEntry> = {
		"together_ai/zai-org/GLM-5.3-Flash": { contextWindow: 1048575, maxTokens: 1048575, provider: "together_ai" },
	};
	const dev: Record<string, CatalogModelEntry> = {
		"zai/glm-5.3-flash": { contextWindow: 1000000, maxTokens: 131072 },
	};
	const view = mergeCatalogSources({ url: "https://a", fetchedAt: 1, models: litellm }, { url: "https://b", fetchedAt: 2, models: dev })!;
	const index = buildCatalogIndex(view.data.models, view.extraEntries);
	assert.equal(catalogLookup(index, "glm-5.3-flash"), undefined, "no proven vendor -> no silent pick");
	assert.equal(index.unverified.size, 0, "no longer a lone unverified candidate — real information now");
	const sigs = index.divergent.get("glm-5.3-flash");
	assert.ok(sigs?.includes("ctx=1000000 max=131072"), "the official-shape value is visible in the warning");
	assert.ok(sigs?.includes("ctx=1048575 max=1048575"), "the platform outlier is visible too");
});
