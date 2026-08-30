import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyInitToRawConfig, computeInitPlan, loadConfigFile, parseConfig } from "../extensions/config.ts";

test("minimal valid config parses without issues", () => {
	const { config, issues, skipped } = parseConfig({ providers: { A: { baseUrl: "https://x.example" } } });
	assert.deepEqual(issues, []);
	assert.deepEqual(skipped, []);
	assert.equal(config.providers.A.baseUrl, "https://x.example");
});

test("entry without baseUrl is skipped with a field-precise issue", () => {
	const { config, issues, skipped } = parseConfig({ providers: { A: { api: "openai-completions" } } });
	assert.equal(skipped.length, 1);
	assert.equal(config.providers.A, undefined);
	assert.ok(issues.some((i) => i.provider === "A" && i.field === "baseUrl"));
});

test("non-http baseUrl is skipped", () => {
	const { skipped } = parseConfig({ providers: { A: { baseUrl: "ftp://x" } } });
	assert.deepEqual(skipped, ["A"]);
});

test("invalid fields degrade gracefully: field dropped, entry kept", () => {
	const { config, issues, skipped } = parseConfig({
		providers: {
			A: {
				baseUrl: "https://x.example",
				filters: { include: "not-an-array" },
				timeoutMs: -5,
				headers: { ok: "yes", bad: 1 },
			},
		},
	});
	assert.deepEqual(skipped, []);
	assert.equal(config.providers.A.baseUrl, "https://x.example");
	assert.equal(config.providers.A.filters, undefined);
	assert.equal(config.providers.A.timeoutMs, undefined);
	assert.equal(config.providers.A.headers, undefined);
	assert.equal(issues.filter((i) => i.provider === "A").length, 3);
});

test("valid filters and numeric knobs are preserved", () => {
	const { config, issues } = parseConfig({
		defaultFilters: { exclude: ["*tts*"] },
		providers: {
			A: {
				baseUrl: "https://x.example",
				filters: { includeRegex: ["^glm"], excludeRegex: ["^glm-4\\."] },
				timeoutMs: 5000,
				refreshIntervalMs: 60000,
			},
		},
	});
	assert.deepEqual(issues, []);
	assert.deepEqual(config.defaultFilters?.exclude, ["*tts*"]);
	assert.deepEqual(config.providers.A.filters?.includeRegex, ["^glm"]);
	assert.equal(config.providers.A.timeoutMs, 5000);
	assert.equal(config.providers.A.refreshIntervalMs, 60000);
});

test("malformed defaultFilters produces an issue but keeps providers", () => {
	const { config, issues } = parseConfig({
		defaultFilters: { exclude: "oops" },
		providers: { A: { baseUrl: "https://x.example" } },
	});
	assert.ok(issues.some((i) => i.field === "defaultFilters.exclude"));
	assert.equal(config.providers.A.baseUrl, "https://x.example");
	assert.equal(config.defaultFilters, undefined);
});

test("root must be an object", () => {
	const { issues } = parseConfig("nope");
	assert.ok(issues.some((i) => i.field === "(root)"));
});

test("loadConfigFile: missing file -> empty config; broken JSON -> issue; valid file -> parsed", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plm-cfg-"));
	try {
		// missing
		process.env.PI_CODING_AGENT_DIR = tmp;
		let loaded = loadConfigFile();
		assert.deepEqual(loaded.config.providers, {});
		assert.deepEqual(loaded.issues, []);

		// broken JSON
		fs.writeFileSync(path.join(tmp, "live-models.json"), "{ broken", "utf8");
		loaded = loadConfigFile();
		assert.ok(loaded.issues.some((i) => i.field === "(file)"));

		// valid
		fs.writeFileSync(
			path.join(tmp, "live-models.json"),
			JSON.stringify({ providers: { A: { baseUrl: "https://x.example" } } }),
			"utf8",
		);
		loaded = loadConfigFile();
		assert.deepEqual(loaded.issues, []);
		assert.equal(loaded.config.providers.A.baseUrl, "https://x.example");
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("presets: use flattens preset lists into entry filters (union), use field dropped", () => {
	const { config, issues } = parseConfig({
		presets: { "no-legacy": { excludeRegex: ["^glm-4\\."] } },
		providers: {
			GLM: { baseUrl: "https://x.example", filters: { use: ["no-legacy"], include: ["*glm*"] } },
		},
	});
	assert.deepEqual(issues, []);
	assert.deepEqual(config.presets?.["no-legacy"]?.excludeRegex, ["^glm-4\\."]);
	assert.deepEqual(config.providers.GLM.filters?.include, ["*glm*"]);
	assert.deepEqual(config.providers.GLM.filters?.excludeRegex, ["^glm-4\\."]);
	assert.equal(config.providers.GLM.filters?.use, undefined); // flattened away
});

test("presets: By-field contributions merge key-by-key into entry filters", () => {
	const { config, issues } = parseConfig({
		presets: { drop: { excludeBy: { owned_by: ["system"] } } },
		providers: {
			A: { baseUrl: "https://x.example", filters: { use: ["drop"], includeBy: { owned_by: ["openai"], extra: ["x"] } } },
		},
	});
	assert.deepEqual(issues, []);
	assert.deepEqual(config.providers.A.filters?.excludeBy, { owned_by: ["system"] });
	assert.deepEqual(config.providers.A.filters?.includeBy, { owned_by: ["openai"], extra: ["x"] });
});

test("presets: unknown preset warns and is ignored; valid siblings still apply", () => {
	const { config, issues } = parseConfig({
		presets: { good: { exclude: ["x*"] } },
		providers: { A: { baseUrl: "https://x.example", filters: { use: ["good", "missing"], includeRegex: ["^m"] } } },
	});
	assert.ok(issues.some((i) => i.field === "providers.A.filters.use" && i.message.includes('"missing"')));
	assert.deepEqual(config.providers.A.filters?.exclude, ["x*"]);
	assert.deepEqual(config.providers.A.filters?.includeRegex, ["^m"]);
});

test("presets: presets cannot reference presets", () => {
	const { issues } = parseConfig({
		presets: { chained: { use: ["other"] } },
		providers: { A: { baseUrl: "https://x.example" } },
	});
	assert.ok(issues.some((i) => i.field === "presets.chained.use"));
});

test("defaultFilters: preset contributions limited to blacklists; direct include fields rejected", () => {
	const { config, issues } = parseConfig({
		presets: { mixed: { exclude: ["a*"], include: ["b*"] } },
		defaultFilters: { use: ["mixed"], include: ["c*"] },
		providers: { A: { baseUrl: "https://x.example" } },
	});
	// direct include rejected outright
	assert.ok(issues.some((i) => i.field === "defaultFilters.include"));
	// preset include contribution warned + ignored, exclude kept
	assert.ok(issues.some((i) => i.field === "defaultFilters.use" && i.message.includes("include")));
	assert.deepEqual(config.defaultFilters?.exclude, ["a*"]);
	assert.equal((config.defaultFilters as Record<string, unknown>)?.include, undefined);
});

test("includeBy/excludeBy validated as field -> string[] maps, bad shapes degrade", () => {
	const { config, issues } = parseConfig({
		providers: {
			A: { baseUrl: "https://x.example", filters: { includeBy: { owned_by: ["openai"] }, excludeBy: { owned_by: 5 } } },
		},
	});
	assert.deepEqual(config.providers.A.filters?.includeBy, { owned_by: ["openai"] });
	assert.equal(config.providers.A.filters?.excludeBy, undefined);
	assert.ok(issues.some((i) => i.field === "providers.A.filters.excludeBy"));
});

test("costFromLive / mergeStatic enum validation with graceful degradation", () => {
	const { config, issues } = parseConfig({
		providers: {
			A: { baseUrl: "https://x.example", costFromLive: "always", mergeStatic: "union" },
			B: { baseUrl: "https://x.example", costFromLive: "sometimes", mergeStatic: "merge" },
		},
	});
	assert.equal(config.providers.A.costFromLive, "always");
	assert.equal(config.providers.A.mergeStatic, "union");
	assert.equal(config.providers.B.costFromLive, undefined);
	assert.equal(config.providers.B.mergeStatic, undefined);
	assert.ok(issues.some((i) => i.provider === "B" && i.field === "costFromLive"));
	assert.ok(issues.some((i) => i.provider === "B" && i.field === "mergeStatic"));
});

test("baseUrl inheritance: omitted baseUrl resolves from staticProviders", () => {
	const { config, issues, skipped } = parseConfig(
		{ providers: { GLM: {}, OTHER: { baseUrl: "https://explicit.example" } } },
		{ staticProviders: { GLM: { baseUrl: "https://relay.example" }, OTHER: { baseUrl: "https://static.example" } } },
	);
	assert.deepEqual(skipped, []);
	assert.deepEqual(issues, []);
	assert.equal(config.providers.GLM.baseUrl, "https://relay.example");
	// explicit baseUrl always wins over the same-id models.json provider
	assert.equal(config.providers.OTHER.baseUrl, "https://explicit.example");
});

test("baseUrl inheritance: no usable match -> skipped with an inherit hint", () => {
	const absent = parseConfig({ providers: { A: {} } }, { staticProviders: { B: { baseUrl: "https://x.example" } } });
	assert.deepEqual(absent.skipped, ["A"]);
	assert.equal(absent.config.providers.A, undefined);
	assert.ok(absent.issues.some((i) => i.field === "baseUrl" && i.message.includes("inherit")));

	const unusable = parseConfig({ providers: { A: {} } }, { staticProviders: { A: { baseUrl: "ftp://x" } } });
	assert.deepEqual(unusable.skipped, ["A"]);
	assert.ok(unusable.issues.some((i) => i.field === "baseUrl" && i.message.includes("inherit")));
});

test("baseUrl inheritance: without staticProviders the legacy message is kept", () => {
	const { issues, skipped } = parseConfig({ providers: { A: { api: "openai-completions" } } });
	assert.deepEqual(skipped, ["A"]);
	assert.ok(issues.some((i) => i.field === "baseUrl" && i.message === "providers.A.baseUrl is required — entry skipped"));
});

test("baseUrl inheritance: present-but-invalid baseUrl never inherits", () => {
	const { config, issues, skipped } = parseConfig(
		{ providers: { A: { baseUrl: 123 } } },
		{ staticProviders: { A: { baseUrl: "https://static.example" } } },
	);
	assert.deepEqual(skipped, ["A"]);
	assert.equal(config.providers.A, undefined);
	assert.ok(issues.some((i) => i.field === "baseUrl" && i.message.includes("http(s)")));
});

test("loadConfigFile inherits baseUrl from models.json", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plm-inherit-"));
	try {
		process.env.PI_CODING_AGENT_DIR = tmp;
		fs.writeFileSync(
			path.join(tmp, "models.json"),
			JSON.stringify({ providers: { S: { baseUrl: "https://static.example", apiKey: "sk-test" } } }),
			"utf8",
		);
		fs.writeFileSync(path.join(tmp, "live-models.json"), JSON.stringify({ providers: { S: {} } }), "utf8");
		const loaded = loadConfigFile();
		assert.deepEqual(loaded.issues, []);
		assert.equal(loaded.config.providers.S.baseUrl, "https://static.example");
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("computeInitPlan categorizes models.json providers", () => {
	const plan = computeInitPlan(
		{ A: { baseUrl: "https://a.example" }, B: { baseUrl: "https://b.example" }, C: { baseUrl: "ftp://c" }, D: {} },
		{ B: { baseUrl: "https://already.configured" } },
	);
	assert.deepEqual(plan.toAdd, [{ id: "A", baseUrl: "https://a.example" }]);
	assert.deepEqual(plan.existing, ["B"]);
	assert.deepEqual(plan.unusable, ["C", "D"]);
});

test("computeInitPlan: null/undefined statics -> empty plan; reserved ids unusable", () => {
	assert.deepEqual(computeInitPlan(null, undefined), { toAdd: [], existing: [], unusable: [] });
	assert.deepEqual(computeInitPlan(undefined, { A: { baseUrl: "https://x" } }), { toAdd: [], existing: [], unusable: [] });
	// JSON.parse creates an own __proto__ property; the plan must reject it
	const statics = JSON.parse('{"__proto__":{"baseUrl":"https://x.example"}}') as Record<string, { baseUrl?: unknown }>;
	const plan = computeInitPlan(statics, undefined);
	assert.deepEqual(plan.toAdd, []);
	assert.deepEqual(plan.unusable, ["__proto__"]);
});

test("applyInitToRawConfig appends stubs without overwriting or reordering", () => {
	const raw: Record<string, unknown> = { presets: { p: { exclude: ["x"] } }, providers: { B: { baseUrl: "https://b.example", include: ["glm*"] } } };
	const res = applyInitToRawConfig(raw, [
		{ id: "A", baseUrl: "https://a.example" },
		{ id: "B", baseUrl: "https://overwrite.example" },
	]);
	assert.equal(res.ok, true);
	const providers = raw.providers as Record<string, Record<string, unknown>>;
	// existing entry untouched (idempotence)
	assert.deepEqual(providers.B, { baseUrl: "https://b.example", include: ["glm*"] });
	// stub appended after existing keys; other top-level fields preserved
	assert.deepEqual(providers.A, { baseUrl: "https://a.example" });
	assert.deepEqual(Object.keys(providers), ["B", "A"]);
	assert.deepEqual(raw.presets, { p: { exclude: ["x"] } });
});

test("applyInitToRawConfig creates providers, rejects bad roots and reserved ids", () => {
	const fresh: Record<string, unknown> = { defaultFilters: { exclude: ["y"] } };
	assert.equal(applyInitToRawConfig(fresh, [{ id: "A", baseUrl: "https://a.example" }]).ok, true);
	assert.deepEqual(fresh.providers, { A: { baseUrl: "https://a.example" } });
	assert.deepEqual(fresh.defaultFilters, { exclude: ["y"] });

	assert.equal(applyInitToRawConfig("nope" as unknown, []).ok, false);
	assert.equal(applyInitToRawConfig(null, []).ok, false);
	const protoAttempt = applyInitToRawConfig({}, [{ id: "__proto__", baseUrl: "https://x.example" }]);
	assert.equal(protoAttempt.ok, false);
	assert.equal(({} as Record<string, unknown>).providers, undefined); // nothing leaked onto Object.prototype
});

test("applyInitToRawConfig agrees with computeInitPlan on inherited-name ids", () => {
	// "toString" is an inherited (non-own) member of {}: plan adds it, and apply
	// must write it too (own property) instead of silently skipping it.
	const plan = computeInitPlan({ toString: { baseUrl: "https://x.example" } }, {});
	assert.deepEqual(plan.toAdd, [{ id: "toString", baseUrl: "https://x.example" }]);
	const raw: Record<string, unknown> = {};
	assert.equal(applyInitToRawConfig(raw, plan.toAdd).ok, true);
	assert.ok(Object.prototype.hasOwnProperty.call(raw.providers, "toString"));
	assert.deepEqual((raw.providers as Record<string, unknown>).toString, { baseUrl: "https://x.example" });
});

test("parseConfig rejects reserved provider ids instead of silently vanishing", () => {
	// JSON.parse can create an own "__proto__" key inside providers; the old
	// `config.providers[id] = entry` assignment re-[[Prototype]]d the map and
	// the provider silently disappeared.
	const raw = JSON.parse('{"providers":{"__proto__":{"baseUrl":"https://x.example"},"A":{"baseUrl":"https://a.example"}}}');
	const { config, issues, skipped } = parseConfig(raw);
	assert.deepEqual(skipped, ["__proto__"]);
	assert.equal(config.providers.A?.baseUrl, "https://a.example");
	assert.ok(issues.some((i) => i.provider === "__proto__" && i.message.includes("not a valid provider id")));
	assert.equal(Object.getPrototypeOf(config.providers), Object.prototype);
	assert.equal(Object.prototype.hasOwnProperty.call(config.providers, "__proto__"), false);
});
