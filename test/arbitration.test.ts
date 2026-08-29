// test/arbitration.test.ts — normalized-key arbitration: vendor truth first,
// community consensus second, disagreement abstains, lone third-party sources
// are unverified. Regression root: glm-5.3-flash matched a lone
// together_ai deployment (max=1048575) and blew past the gateway's
// real 131072 limit (incident 2026-08-29).
import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogIndex, catalogLookup } from "../extensions/catalog.ts";
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
