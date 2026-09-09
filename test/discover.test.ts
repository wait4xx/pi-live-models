import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, buildModelsUrl, buildModel, collectStaticById, envKeyVarName, hoistProviderFields, liveCostFrom, liveNumber, resolveKeySpec } from "../extensions/discover.ts";
import { compileFilters } from "../extensions/filters.ts";
import type { ProviderEntry } from "../extensions/config.ts";

test("buildModelsUrl derives the endpoint for common base URL shapes", () => {
	assert.equal(buildModelsUrl("https://x.example"), "https://x.example/v1/models");
	assert.equal(buildModelsUrl("https://x.example/"), "https://x.example/v1/models");
	assert.equal(buildModelsUrl("https://x.example/v1"), "https://x.example/v1/models");
	assert.equal(buildModelsUrl("https://x.example/v1/"), "https://x.example/v1/models");
	assert.equal(buildModelsUrl("https://x.example/api/v3/"), "https://x.example/api/v3/models");
});

test("resolveKeySpec: literal, $ENV, ${ENV}, unset env, !command", () => {
	process.env.PLM_TEST_KEY = "env-value";
	try {
		assert.equal(resolveKeySpec("literal-key"), "literal-key");
		assert.equal(resolveKeySpec("$PLM_TEST_KEY"), "env-value");
		assert.equal(resolveKeySpec("${PLM_TEST_KEY}"), "env-value");
		assert.equal(resolveKeySpec("$PLM_TEST_UNSET_XYZ"), undefined);
		assert.equal(resolveKeySpec("!echo plm-test"), "plm-test");
		assert.equal(resolveKeySpec(42), undefined);
		assert.equal(resolveKeySpec(""), undefined);
	} finally {
		delete process.env.PLM_TEST_KEY;
	}
});

test("envKeyVarName maps provider ids to conventional env var names", () => {
	assert.equal(envKeyVarName("qwen-token-plan-cn"), "QWEN_TOKEN_PLAN_CN_API_KEY");
	assert.equal(envKeyVarName("GLM"), "GLM_API_KEY");
});

test("liveNumber walks dotted paths and returns the first numeric hit", () => {
	const item = { max_tokens: 8192, top_provider: { max_completion_tokens: 4096 } };
	assert.equal(liveNumber(item, ["max_completion_tokens", "max_tokens"]), 8192); // top-level precedence order
	assert.equal(liveNumber(item, ["top_provider.max_completion_tokens"]), 4096);
	assert.equal(liveNumber(item, ["missing", "also.missing"]), undefined);
	assert.equal(liveNumber(undefined, ["max_tokens"]), undefined);
});

test("buildModel merge ladder: defaults < static < live hints < overrides", () => {
	const entry = {
		defaults: { contextWindow: 1000, maxTokens: 111, input: ["text"], reasoning: false },
		overrides: { "m-1": { contextWindow: 4000 } },
	};
	// defaults only
	const plain = buildModel("m-0", undefined, entry, undefined);
	assert.equal(plain.contextWindow, 1000);
	assert.equal(plain.maxTokens, 111);
	assert.equal(plain.reasoning, false);
	assert.deepEqual(plain.input, ["text"]);
	assert.equal(plain.name, "m-0");
	assert.deepEqual(plain.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

	// static base beats defaults
	const withBase = buildModel("m-0", undefined, entry, { contextWindow: 2000, name: "Static Name" });
	assert.equal(withBase.contextWindow, 2000);
	assert.equal(withBase.name, "Static Name");

	// live hints beat static
	const withLive = buildModel("m-0", { context_length: 3000, display_name: "Live Name" }, entry, { contextWindow: 2000 });
	assert.equal(withLive.contextWindow, 3000);
	assert.equal(withLive.name, "Live Name");

	// overrides beat everything
	const withOverride = buildModel("m-1", { context_length: 3000 }, entry, { contextWindow: 2000 });
	assert.equal(withOverride.contextWindow, 4000);
});

test("buildModel falls back to pi-safe defaults when nothing is configured", () => {
	const model = buildModel("solo", undefined, {}, undefined);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text"]);
	assert.equal(model.contextWindow, 128_000);
	assert.equal(model.maxTokens, 32_768);
});

test("buildModel applies provider-level compat/api as fallback, override wins", () => {
	const entry = { compat: { thinkingFormat: "qwen" }, api: "openai-completions", overrides: { "m-1": { compat: { thinkingFormat: "custom" } } } };
	const plain = buildModel("m-0", undefined, entry, undefined);
	assert.deepEqual(plain.compat, { thinkingFormat: "qwen" });
	assert.equal(plain.api, "openai-completions");

	const overridden = buildModel("m-1", undefined, entry, undefined);
	assert.deepEqual(overridden.compat, { thinkingFormat: "custom" });

	const staticWins = buildModel("m-0", undefined, entry, { compat: { thinkingFormat: "static" } });
	assert.deepEqual(staticWins.compat, { thinkingFormat: "static" });
});

test("liveCostFrom extracts OpenRouter-style $/token strings into $/1M numbers", () => {
	const item = { pricing: { prompt: "0.0000015", completion: "0.00000225", prompt_cache_read: "0.0000002" } };
	const cost = liveCostFrom(item)!;
	assert.ok(Math.abs(cost.input - 1.5) < 1e-9);
	assert.ok(Math.abs(cost.output - 2.25) < 1e-9);
	assert.ok(Math.abs(cost.cacheRead - 0.2) < 1e-9);
	// explicit free tier is a valid live cost
	assert.deepEqual(liveCostFrom({ pricing: { prompt: "0" } }), { input: 0 });
	// junk / missing
	assert.equal(liveCostFrom({ pricing: { prompt: "free" } }), undefined);
	assert.equal(liveCostFrom({}), undefined);
	assert.equal(liveCostFrom(undefined), undefined);
	// negative numbers ignored
	assert.equal(liveCostFrom({ pricing: { prompt: -1 } }), undefined);
});

test("buildModel cost policy: fill-zero (default) / always / off, override wins all", () => {
	const live = { pricing: { prompt: "0.000002", completion: "0.000004" } };
	const staticDef = { cost: { input: 3, output: 6 } };

	// fill-zero: an explicit static cost wins as-is
	assert.deepEqual(buildModel("m", live, {}, staticDef).cost, { input: 3, output: 6 });
	// fill-zero: nothing else defines cost -> live fills, missing cache keys become 0
	const filled = buildModel("m", live, {}, undefined).cost;
	assert.equal(filled.input, 2);
	assert.equal(filled.output, 4);
	assert.equal(filled.cacheRead, 0);
	assert.equal(filled.cacheWrite, 0);
	// always: live pricing beats static
	assert.equal(buildModel("m", live, { costFromLive: "always" }, staticDef).cost.input, 2);
	// always merges KEY BY KEY: a live entry reporting only pricing.prompt keeps static output
	const promptOnly = { pricing: { prompt: "0.000002" } };
	assert.deepEqual(buildModel("m", promptOnly, { costFromLive: "always" }, staticDef).cost, { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 });
	// off: live pricing ignored entirely
	assert.deepEqual(buildModel("m", live, { costFromLive: "off" }, undefined).cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	// override beats every policy
	assert.equal(buildModel("m", live, { costFromLive: "always", overrides: { m: { cost: { input: 9 } } } }, staticDef).cost.input, 9);
});

test("buildCatalog: filters live items, merges metadata, union adds filtered static-only models", () => {
	const filters = compileFilters("T.filters", { exclude: ["bad-*"] }, undefined);
	const entry = { baseUrl: "https://x.example", mergeStatic: "union" } as ProviderEntry;
	const staticById = {
		"ghost-1": { contextWindow: 9999 },
		"bad-ghost": {},
		"live-1": { contextWindow: 4096 }, // also static — must not duplicate
	};
	const items = [
		{ id: "live-1", context_length: 8192 },
		{ id: "bad-live" },
		{ name: "unnamed" }, // id via name fallback
	];
	const result = buildCatalog(items, { entry, filters, staticById });
	assert.deepEqual(result.liveModels.map((m) => m.id), ["live-1", "unnamed"]);
	assert.deepEqual(result.staticModels.map((m) => m.id), ["ghost-1"]); // bad-ghost filtered, live-1 not duplicated
	assert.equal(result.liveModels[0].contextWindow, 8192); // live hint beats static
	assert.equal(result.staticModels[0].contextWindow, 9999);
	assert.equal(result.outcomes.length, 3);

	// default mergeStatic: static-only models not added
	const plain = buildCatalog(items, { entry: { baseUrl: "https://x.example" } as ProviderEntry, filters, staticById });
	assert.deepEqual(plain.staticModels, []);
});

test("buildCatalog: duplicate live ids (gateway alias) yield one entry, first wins", () => {
	const filters = compileFilters("T.filters", undefined, undefined);
	const result = buildCatalog(
		[
			{ id: "m-1", context_length: 8192 },
			{ id: "m-1", context_length: 16384 },
		],
		{ entry: { baseUrl: "https://x.example" } as ProviderEntry, filters, staticById: {} },
	);
	assert.equal(result.liveModels.length, 1);
	assert.equal(result.liveModels[0].contextWindow, 8192);
	assert.equal(result.outcomes.length, 1);
});

test("buildCatalog: includeBy fields apply to live items during catalog build", () => {
	const filters = compileFilters("T.filters", { includeBy: { owned_by: ["openai"] } }, undefined);
	const entry = { baseUrl: "https://x.example" } as ProviderEntry;
	const result = buildCatalog(
		[
			{ id: "m-1", owned_by: "openai" },
			{ id: "m-2", owned_by: "system" },
			{ id: "m-3" }, // field missing -> includeBy-miss
		],
		{ entry, filters, staticById: {} },
	);
	assert.deepEqual(result.liveModels.map((m) => m.id), ["m-1"]);
	assert.equal(result.outcomes.find((o) => o.id === "m-3")!.reason, "includeBy-miss:owned_by");
});

test("buildModel carries thinkingLevelMap: defaults < static < overrides, absent when unset", () => {
	const staticMap = { off: null, low: "low", high: "max" };
	const overrideMap = { off: null, low: "low" };

	// absent everywhere -> field omitted
	const none = buildModel("m", undefined, {}, undefined);
	assert.equal("thinkingLevelMap" in none, false);

	// entry.defaults only
	const viaDefaults = buildModel("m", undefined, { defaults: { thinkingLevelMap: staticMap } }, undefined);
	assert.deepEqual(viaDefaults.thinkingLevelMap, staticMap);

	// static base beats defaults
	const viaBase = buildModel(
		"m",
		undefined,
		{ defaults: { thinkingLevelMap: { low: "defaults" } } },
		{ thinkingLevelMap: staticMap },
	);
	assert.deepEqual(viaBase.thinkingLevelMap, staticMap);

	// overrides beat static
	const viaOverride = buildModel("m", undefined, { overrides: { m: { thinkingLevelMap: overrideMap } } }, { thinkingLevelMap: staticMap });
	assert.deepEqual(viaOverride.thinkingLevelMap, overrideMap);
});

test("buildModel carries samplingParams: defaults < static < overrides, absent when unset", () => {
	const staticParams = { temperature: 0.7 };
	const overrideParams = { temperature: 0.2, top_p: 0.9 };

	const none = buildModel("m", undefined, {}, undefined);
	assert.equal("samplingParams" in none, false);

	const viaDefaults = buildModel("m", undefined, { defaults: { samplingParams: staticParams } }, undefined);
	assert.deepEqual(viaDefaults.samplingParams, staticParams);

	const viaBase = buildModel("m", undefined, {}, { samplingParams: staticParams });
	assert.deepEqual(viaBase.samplingParams, staticParams);

	const viaOverride = buildModel("m", undefined, { overrides: { m: { samplingParams: overrideParams } } }, { samplingParams: staticParams });
	assert.deepEqual(viaOverride.samplingParams, overrideParams);
});

test("hoistProviderFields merges provider-level api/compat into static models, model level wins", () => {
	const provider = { api: "openai-completions", compat: { thinkingFormat: "zai", supportsReasoningEffort: true } };

	// both hoisted when the model has neither
	const hoisted = hoistProviderFields({ id: "glm-5.3" }, provider);
	assert.equal(hoisted.api, "openai-completions");
	assert.deepEqual(hoisted.compat, provider.compat);

	// model-level api/compat win over provider level
	const kept = hoistProviderFields(
		{ id: "glm-5.3", api: "anthropic-messages", compat: { thinkingFormat: "zai" } },
		provider,
	);
	assert.equal(kept.api, "anthropic-messages");
	assert.deepEqual(kept.compat, { thinkingFormat: "zai", supportsReasoningEffort: true });

	// no provider entry / no provider fields -> model untouched
	assert.deepEqual(hoistProviderFields({ id: "m" }, undefined), { id: "m" });
	assert.deepEqual(hoistProviderFields({ id: "m" }, { api: 42, compat: "nope" }), { id: "m" });

	// original model object is never mutated
	const original = { id: "m" };
	hoistProviderFields(original, provider);
	assert.deepEqual(original, { id: "m" });
});

test("hoistProviderFields deep-merges pi's special compat keys, one level", () => {
	const provider = { compat: { openRouterRouting: { provider: {order: ["A"]} }, chatTemplateKwargs: { top_p: 0.9 } } };
	const model = { compat: { openRouterRouting: { provider: {order: ["B"], allow_fallbacks: false} } } };
	const hoisted = hoistProviderFields(model, provider);
	assert.deepEqual(hoisted.compat, {
		openRouterRouting: { provider: { order: ["B"], allow_fallbacks: false } },
		chatTemplateKwargs: { top_p: 0.9 },
	});
	// non-object values on either side keep per-key override semantics
	const hoisted2 = hoistProviderFields({ compat: { chatTemplateKwargs: "flat" } }, provider);
	assert.deepEqual(hoisted2.compat, { openRouterRouting: { provider: { order: ["A"] } }, chatTemplateKwargs: "flat" });
});

test("collectStaticById hoists provider fields into both static sources, models.json wins on id clashes", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plm-static-"));
	try {
		process.env.PI_CODING_AGENT_DIR = tmp;
		fs.writeFileSync(path.join(tmp, "models.json"), JSON.stringify({
			providers: {
				DEMO: {
					api: "openai-completions",
					compat: { thinkingFormat: "zai", supportsReasoningEffort: true },
					models: [
						{ id: "m-json", name: "From models.json", compat: { thinkingFormat: "zai" } },
						{ id: "m-both", name: "models.json version" },
					],
				},
			},
		}), "utf8");
		fs.writeFileSync(path.join(tmp, "models-store.json"), JSON.stringify({
			DEMO: { models: [
				{ id: "m-store", name: "From store" },
				{ id: "m-both", name: "store version" },
				{ id: 42 },
			] },
		}), "utf8");

		const byId = collectStaticById("DEMO");

		// store-only id: provider-level api/compat hoisted in
		assert.equal(byId["m-store"].api, "openai-completions");
		assert.deepEqual(byId["m-store"].compat, { thinkingFormat: "zai", supportsReasoningEffort: true });

		// models.json model: api hoisted, model-level compat beats provider level per key,
		// provider fills keys the model compat lacks
		assert.equal(byId["m-json"].api, "openai-completions");
		assert.deepEqual(byId["m-json"].compat, { thinkingFormat: "zai", supportsReasoningEffort: true });

		// same id in both: models.json entry wins over the store snapshot
		assert.equal(byId["m-both"].name, "models.json version");
		assert.equal(byId["m-both"].api, "openai-completions");

		// non-string ids never enter the map
		assert.equal(Object.keys(byId).length, 3);
	} finally {
		process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
