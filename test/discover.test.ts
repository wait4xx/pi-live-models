import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelsUrl, buildModel, envKeyVarName, liveNumber, resolveKeySpec } from "../extensions/discover.ts";

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
