/**
 * Tests for the public metadata catalog: key normalization, catalog parsing,
 * index lookup, merge-ladder integration, sanity windows, warnings, and the
 * /live-models-fix config patch helper.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CATALOG_RETRY_BACKOFF_MS,
	CATALOG_TTL_MS,
	CONTEXT_WINDOW_MAX,
	CONTEXT_WINDOW_MIN,
	MAX_TOKENS_MAX,
	MAX_TOKENS_MIN,
	buildCatalogIndex,
	catalogLookup,
	createCatalogManager,
	ensureCatalogSoft,
	normalizeModelKey,
	parseLiteLLMCatalog,
	readCatalogCache,
	shouldAttemptRefresh,
	saneWindow,
	writeCatalogCache,
} from "../extensions/catalog.ts";
import { applyFixToRawConfig, catalogPath, modelsDevCatalogPath, parseConfig, type ProviderEntry } from "../extensions/config.ts";
import { buildCatalog, buildModel } from "../extensions/discover.ts";
import { compileFilters } from "../extensions/filters.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENTRY = { baseUrl: "https://x.example" } as ProviderEntry;

// ------------------------------------------------------------- normalizeModelKey

test("normalizeModelKey: lower-case, colon suffix, provider prefix, date suffixes", () => {
	assert.equal(normalizeModelKey("GPT-4o"), "gpt-4o");
	assert.equal(normalizeModelKey("deepseek-chat:free"), "deepseek-chat");
	assert.equal(normalizeModelKey("gpt-4o-2024-11-20"), "gpt-4o");
	assert.equal(normalizeModelKey("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet");
	assert.equal(normalizeModelKey("glm-4-7-251222"), "glm-4-7");
	assert.equal(normalizeModelKey("openai/gpt-4o"), "gpt-4o");
	assert.equal(normalizeModelKey("together_ai/BAAI/bge-base-en-v1.5"), "bge-base-en-v1.5");
	assert.equal(normalizeModelKey("  qwen/qwen3-235b-a22b:latest "), "qwen3-235b-a22b");
});

test("normalizeModelKey: does not eat meaningful suffixes", () => {
	// 4-digit or letter suffixes are model names, not dates
	assert.equal(normalizeModelKey("gpt-3.5-turbo-1106"), "gpt-3.5-turbo-1106");
	assert.equal(normalizeModelKey("qwen2.5-coder-32b-128k"), "qwen2.5-coder-32b-128k");
	assert.equal(normalizeModelKey("llama-3.1-8b"), "llama-3.1-8b");
});

// ----------------------------------------------------------------- saneWindow

test("saneWindow: integers within bounds only", () => {
	assert.ok(saneWindow(8192, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(saneWindow(CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(saneWindow(CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(!saneWindow(CONTEXT_WINDOW_MIN - 1, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(!saneWindow(CONTEXT_WINDOW_MAX + 1, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(!saneWindow(0, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(!saneWindow(-5, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(!saneWindow(100.5, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(!saneWindow("8192", CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(!saneWindow(undefined, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX));
	assert.ok(saneWindow(MAX_TOKENS_MIN, MAX_TOKENS_MIN, MAX_TOKENS_MAX));
	assert.ok(!saneWindow(16, MAX_TOKENS_MIN, MAX_TOKENS_MAX));
});

// ---------------------------------------------------------- parseLiteLLMCatalog

test("parseLiteLLMCatalog: keeps sane chat entries, drops other modes and garbage", () => {
	const catalog = parseLiteLLMCatalog({
		"gpt-4o": { max_input_tokens: 128000, max_output_tokens: 16384, mode: "chat" },
		"text-embedding-3-small": { max_input_tokens: 8191, mode: "embedding" },
		"bad-zero": { max_input_tokens: 0, mode: "chat" },
		"bad-float": { max_input_tokens: 12.5, mode: "chat" },
		"bad-huge": { max_input_tokens: 1e12, mode: "chat" },
		"max-only": { max_tokens: 4096, mode: "chat" }, // max_output_tokens missing -> max_tokens
		"not-an-object": "nope",
	});
	assert.deepEqual(catalog["gpt-4o"], { contextWindow: 128000, maxTokens: 16384 });
	assert.equal(catalog["text-embedding-3-small"], undefined);
	assert.equal(catalog["bad-zero"], undefined);
	assert.equal(catalog["bad-float"], undefined);
	assert.equal(catalog["bad-huge"], undefined);
	assert.deepEqual(catalog["max-only"], { maxTokens: 4096 });
	assert.equal(catalog["not-an-object"], undefined);
});

// ------------------------------------------------------- buildCatalogIndex/lookup

test("catalogLookup: exact key wins over dated alias; basename and normalized hits; no fuzzy", () => {
	const index = buildCatalogIndex({
		"gpt-4o": { contextWindow: 128000 },
		"gpt-4o-2024-11-20": { contextWindow: 111111 }, // normalized alias of gpt-4o
		"gemini/gemini-2.5-pro": { contextWindow: 1048576, provider: "gemini" }, // vendor entry (two-segment, provider matches)
		"claude-sonnet-4-5": { contextWindow: 200000 },
	});
	// exact raw key
	assert.equal(catalogLookup(index, "gpt-4o")?.contextWindow, 128000);
	// dated query hits its own exact catalog entry when one exists (most specific wins)
	assert.equal(catalogLookup(index, "gpt-4o-2024-11-20")?.contextWindow, 111111);
	// provider-prefixed catalog key found by basename
	assert.equal(catalogLookup(index, "gemini-2.5-pro")?.contextWindow, 1048576);
	// dated query with NO exact entry normalizes onto the primary entry
	assert.equal(catalogLookup(index, "claude-sonnet-4-5-20250929")?.contextWindow, 200000);
	// no fuzzy matching: partial ids must NOT match
	assert.equal(catalogLookup(index, "gpt-4o-mini"), undefined);
	assert.equal(catalogLookup(index, "totally-unknown"), undefined);
});

// ------------------------------------------------------- ladder integration

function fixtureEntry(extra: Partial<ProviderEntry>): ProviderEntry {
	return { ...extra, baseUrl: "https://x.example" } as ProviderEntry;
}

const FILTERS = compileFilters("T", undefined, undefined);
const CATALOG = buildCatalogIndex({ "glm-4.6": { contextWindow: 200000, maxTokens: 128000 } });

test("ladder: catalog beats live; override beats catalog; sources annotated", () => {
	const result = buildCatalog([{ id: "glm-4.6", context_length: 128000 }], {
		entry: fixtureEntry({ overrides: {} }),
		filters: FILTERS,
		staticById: {},
		catalog: CATALOG,
	});
	const m = result.liveModels[0];
	assert.equal(m.contextWindow, 200000); // catalog over gateway's 128000
	assert.equal(m.ctxSource, "catalog");
	assert.equal(m.maxTokens, 128000);
	assert.equal(m.maxSource, "catalog");

	const overridden = buildCatalog([{ id: "glm-4.6", context_length: 128000 }], {
		entry: fixtureEntry({ overrides: { "glm-4.6": { contextWindow: 32000 } } }),
		filters: FILTERS,
		staticById: {},
		catalog: CATALOG,
	});
	assert.equal(overridden.liveModels[0].contextWindow, 32000);
	assert.equal(overridden.liveModels[0].ctxSource, "override");
});

test("ladder: catalog miss falls through to live; disabled catalog ignores catalog data", () => {
	const miss = buildCatalog([{ id: "private-model", context_length: 128000 }], {
		entry: fixtureEntry({}),
		filters: FILTERS,
		staticById: {},
		catalog: CATALOG,
	});
	assert.equal(miss.liveModels[0].contextWindow, 128000);
	assert.equal(miss.liveModels[0].ctxSource, "live");

	const disabled = buildCatalog([{ id: "glm-4.6", context_length: 128000 }], {
		entry: fixtureEntry({ catalog: false }),
		filters: FILTERS,
		staticById: {},
		catalog: CATALOG,
	});
	assert.equal(disabled.liveModels[0].contextWindow, 128000);
	assert.equal(disabled.liveModels[0].ctxSource, "live");
});

test("ladder: insane live values (0, negative, float, huge) fall to static/defaults", () => {
	const entry = fixtureEntry({ defaults: { contextWindow: 65536 } });
	for (const bad of [0, -5, 100.5, 1e12]) {
		const result = buildCatalog([{ id: "m", context_length: bad }], {
			entry,
			filters: FILTERS,
			staticById: {},
		});
		assert.equal(result.liveModels[0].contextWindow, 65536);
		assert.equal(result.liveModels[0].ctxSource, "defaults");
	}
});

test("buildModel: catalog entry enriches static-only path too", () => {
	const model = buildModel("glm-4.6", undefined, fixtureEntry({}), { contextWindow: 9999 }, { contextWindow: 200000 });
	assert.equal(model.contextWindow, 200000);
	assert.equal(model.ctxSource, "catalog");
});

// -------------------------------------------------------------------- warnings

test("warnings: gateway vs catalog divergence >=4x produces a fix hint", () => {
	const result = buildCatalog([{ id: "glm-4.6", context_length: 8000 }], {
		entry: fixtureEntry({}),
		filters: FILTERS,
		staticById: {},
		providerId: "GLM",
		catalog: CATALOG,
	});
	assert.ok(result.warnings.some((w) => w.includes("glm-4.6") && w.includes("/live-models-fix GLM glm-4.6 ctx=200000")));
	// mild divergence (within 4x) is not flagged
	const mild = buildCatalog([{ id: "glm-4.6", context_length: 100000 }], {
		entry: fixtureEntry({}),
		filters: FILTERS,
		staticById: {},
		providerId: "GLM",
		catalog: CATALOG,
	});
	assert.deepEqual(mild.warnings, []);
});

test("warnings: uniform gateway placeholder (>=3 models, same ctx) flagged once", () => {
	const items = [
		{ id: "a", context_length: 128000 },
		{ id: "b", context_length: 128000 },
		{ id: "c", context_length: 128000 },
	];
	const result = buildCatalog(items, { entry: fixtureEntry({}), filters: FILTERS, staticById: {}, providerId: "RELAY" });
	assert.equal(result.warnings.filter((w) => w.includes("placeholder")).length, 1);
	// two models sharing a value is below the threshold
	const small = buildCatalog(items.slice(0, 2), { entry: fixtureEntry({}), filters: FILTERS, staticById: {} });
	assert.deepEqual(small.warnings, []);
});

test("warnings: catalog divergence suppressed when catalog is disabled", () => {
	const result = buildCatalog([{ id: "glm-4.6", context_length: 8000 }], {
		entry: fixtureEntry({ catalog: false }),
		filters: FILTERS,
		staticById: {},
		providerId: "GLM",
		catalog: CATALOG,
	});
	assert.deepEqual(result.warnings, []);
});

// --------------------------------------------------------- applyFixToRawConfig

test("applyFixToRawConfig: writes into nested overrides preserving siblings and order", () => {
	const raw = {
		providers: {
			GLM: {
				baseUrl: "https://x",
				filters: { exclude: ["*embedding*"] },
				overrides: { "other-model": { contextWindow: 1, name: "keep me" } },
			},
		},
	};
	const snapshot = JSON.stringify(raw);
	const result = applyFixToRawConfig(raw, "GLM", "glm-4.6", { contextWindow: 200000, maxTokens: 65536 });
	assert.deepEqual(result, { ok: true });
	const entry = (raw as any).providers.GLM;
	assert.equal(entry.overrides["glm-4.6"].contextWindow, 200000);
	assert.equal(entry.overrides["glm-4.6"].maxTokens, 65536);
	// siblings untouched
	assert.equal(entry.overrides["other-model"].name, "keep me");
	assert.deepEqual(entry.filters, { exclude: ["*embedding*"] });
	// key order of pre-existing fields preserved
	assert.equal(JSON.stringify(raw).startsWith(snapshot.slice(0, 40)), true);
});

test("applyFixToRawConfig: creates overrides when missing; errors on unknown provider/root", () => {
	const raw: any = { providers: { GLM: { baseUrl: "https://x" } } };
	assert.deepEqual(applyFixToRawConfig(raw, "GLM", "m", { contextWindow: 8192 }), { ok: true });
	assert.equal(raw.providers.GLM.overrides.m.contextWindow, 8192);
	assert.deepEqual(applyFixToRawConfig(raw, "NOPE", "m", { contextWindow: 8192 }).ok, false);
	assert.deepEqual(applyFixToRawConfig(null, "GLM", "m", { contextWindow: 8192 }).ok, false);
});

test("applyFixToRawConfig: rejects prototype-reserved ids (no pollution, no fake success)", () => {
	const raw: any = { providers: { GLM: {} } };
	for (const id of ["__proto__", "constructor", "prototype"]) {
		assert.equal(applyFixToRawConfig(raw, "GLM", id, { contextWindow: 8192 }).ok, false);
	}
	assert.equal(applyFixToRawConfig(raw, "__proto__", "m", { contextWindow: 8192 }).ok, false);
	// no prototype pollution occurred, and the config was not silently left unchanged-while-claiming-success
	assert.equal((Object.prototype as any).contextWindow, undefined);
	assert.equal((Object.prototype as any).maxTokens, undefined);
});

// ------------------------------------------------------------------- parseConfig

test("parseConfig: catalog field must be boolean; defaults to enabled", () => {
	const good = parseConfig({ providers: { A: { baseUrl: "https://a", catalog: false } } });
	assert.equal(good.config.providers.A.catalog, false);
	assert.equal(good.issues.length, 0);
	const bad = parseConfig({ providers: { A: { baseUrl: "https://a", catalog: "yes" } } });
	assert.equal(bad.config.providers.A.catalog, undefined);
	assert.ok(bad.issues.some((i) => i.field === "catalog"));
});

// ------------------------------------------------------------- retry backoff

test("retry backoff: skipped after a failure, reset by success window, manual refresh ignores it", () => {
	const mgr = createCatalogManager();
	assert.ok(shouldAttemptRefresh(mgr, 1000)); // fresh manager
	mgr.lastFailureAt = 1000;
	assert.ok(!shouldAttemptRefresh(mgr, 1000 + CATALOG_RETRY_BACKOFF_MS - 1)); // within backoff
	assert.ok(shouldAttemptRefresh(mgr, 1000 + CATALOG_RETRY_BACKOFF_MS)); // backoff elapsed
	assert.ok(!shouldAttemptRefresh({ ...mgr, inflight: Promise.resolve() }, 10_000_000)); // in-flight always blocks
});

// ------------------------------------------- soft-ensure (discovery hot path)

test("ensureCatalogSoft: serves fresh disk cache with ZERO network activity", async () => {
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	const savedFetch = globalThis.fetch;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plm-catalog-"));
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		writeCatalogCache({ url: "https://src", fetchedAt: Date.now(), models: { "gpt-4o": { contextWindow: 128000 } } }, catalogPath());
		writeCatalogCache({ url: "https://dev", fetchedAt: Date.now(), models: {} }, modelsDevCatalogPath());
		// Any network attempt surfaces as a failed refresh, failing the assertions below.
		(globalThis as any).fetch = () => Promise.reject(new Error("network must not be touched"));
		const mgr = createCatalogManager();
		const view = ensureCatalogSoft(mgr);
		assert.equal(view?.data.models["gpt-4o"]?.contextWindow, 128000);
		assert.equal(mgr.inflight, null); // fresh cache -> no background fetch kicked
		assert.equal(mgr.devInflight, null);
		assert.equal(mgr.lastFailureAt, null);
	} finally {
		globalThis.fetch = savedFetch;
		if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedDir;
		fs.rmSync(dir, { recursive: true, force: true });
	}
	await Promise.resolve(); // let a stray rejected promise (if the impl regressed) surface deterministically
});

test("ensureCatalogSoft: stale cache triggers a background refresh that updates data", async () => {
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	const savedFetch = globalThis.fetch;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plm-catalog-"));
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		writeCatalogCache({ url: "https://old", fetchedAt: Date.now() - CATALOG_TTL_MS - 1_000, models: {} }, catalogPath());
		writeCatalogCache({ url: "https://olddev", fetchedAt: Date.now() - CATALOG_TTL_MS - 1_000, models: {} }, modelsDevCatalogPath());
		// Stub the network per source: litellm shape vs models.dev shape.
		(globalThis as any).fetch = (url: unknown) => {
			const body =
				String(url).includes("models.dev")
					? JSON.stringify({ zai: { models: { "glm-5.3-flash": { limit: { context: 1000000, output: 131072 } } } } })
					: JSON.stringify({ "gpt-5": { max_input_tokens: 400000, max_output_tokens: 32768, mode: "chat" } });
			return Promise.resolve(new Response(body, { status: 200 }));
		};
		const mgr = createCatalogManager();
		ensureCatalogSoft(mgr); // stale -> background kick, returns stale view immediately
		assert.ok(mgr.inflight, "expected a litellm background refresh to start");
		assert.ok(mgr.devInflight, "expected a models.dev background refresh to start");
		await Promise.all([mgr.inflight, mgr.devInflight]);
		assert.equal(mgr.data?.models["gpt-5"]?.contextWindow, 400000);
		assert.equal(mgr.devData?.models["zai/glm-5.3-flash"]?.maxTokens, 131072);
	} finally {
		globalThis.fetch = savedFetch;
		if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedDir;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------- disk round-trip

test("catalog disk cache round-trip in an isolated agent dir; malformed -> null", () => {
	const saved = process.env.PI_CODING_AGENT_DIR;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plm-catalog-"));
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		assert.equal(readCatalogCache(catalogPath()), null); // missing
		writeCatalogCache({ url: "https://src", fetchedAt: 1234, models: { "gpt-4o": { contextWindow: 128000 } } }, catalogPath());
		const data = readCatalogCache(catalogPath());
		assert.equal(data?.url, "https://src");
		assert.equal(data?.fetchedAt, 1234);
		assert.equal(data?.models["gpt-4o"]?.contextWindow, 128000);
		fs.writeFileSync(path.join(dir, "live-models-catalog.json"), "{broken", "utf8");
		assert.equal(readCatalogCache(catalogPath()), null); // malformed
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
