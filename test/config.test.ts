import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfigFile, parseConfig } from "../extensions/config.ts";

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
