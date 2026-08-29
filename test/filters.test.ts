import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFilters, compileFilters, summarizeDrops, type CompiledFilters } from "../extensions/filters.ts";
import type { DefaultFilters, FiltersSpec } from "../extensions/config.ts";

function compile(spec?: FiltersSpec, defaults?: DefaultFilters): CompiledFilters {
	return compileFilters("TEST.filters", spec, defaults);
}

test("no filters configured -> every model passes (zero filtering by default)", () => {
	const f = compile(undefined, undefined);
	assert.equal(f.hasWhitelist, false);
	assert.deepEqual(applyFilters("gpt-4o-audio-preview", f), { id: "gpt-4o-audio-preview", kept: true });
	assert.equal(applyFilters("anything-at-all", f).kept, true);
});

test("glob exclude drops matching ids with a named reason", () => {
	const f = compile({ exclude: ["*audio*"] });
	const outcome = applyFilters("gpt-4o-audio-preview", f);
	assert.equal(outcome.kept, false);
	assert.equal(outcome.reason, "exclude:*audio*");
	assert.equal(applyFilters("gpt-4o", f).kept, true);
});

test("glob is case-insensitive and dot is literal (no regex semantics)", () => {
	const f = compile({ exclude: ["GPT-5.6"] });
	assert.equal(applyFilters("gpt-5.6", f).kept, false); // case-insensitive
	assert.equal(applyFilters("gpt-5x6", f).kept, true); // '.' is literal, not any-char
});

test("exclude always wins over include", () => {
	const f = compile({ include: ["gpt-*"], exclude: ["*audio*"] });
	assert.equal(applyFilters("gpt-4o", f).kept, true);
	assert.equal(applyFilters("gpt-4o-audio", f).kept, false);
	assert.equal(applyFilters("claude-3", f).kept, false); // whitelist-miss
});

test("non-empty include set acts as whitelist (glob or regex, unioned)", () => {
	const f = compile({ include: ["*glm*"], includeRegex: ["^qwen"] });
	assert.equal(applyFilters("glm-5.3", f).reason, "include:*glm*");
	assert.equal(applyFilters("qwen3.8-max", f).reason, "includeRegex:^qwen");
	const miss = applyFilters("gpt-5.2", f);
	assert.equal(miss.kept, false);
	assert.equal(miss.reason, "whitelist-miss");
});

test("regex is case-sensitive; glob is not", () => {
	const f = compile({ includeRegex: ["^GLM"] });
	assert.equal(applyFilters("GLM-5.3", f).kept, true);
	assert.equal(applyFilters("glm-5.3", f).kept, false);

	const g = compile({ include: ["GLM*"] });
	assert.equal(applyFilters("glm-5.3", g).kept, true);
});

test("invalid regex is reported and ignored, valid siblings still work", () => {
	const f = compile({ includeRegex: ["^ok-[\\d", "^fine"] });
	assert.equal(f.invalid.length, 1);
	assert.equal(f.invalid[0].pattern, "^ok-[\\d");
	assert.equal(applyFilters("fine-1", f).kept, true);
	assert.equal(applyFilters("ok-1", f).reason, "whitelist-miss");
});

test("global defaultFilters union with entry excludes but never create a whitelist", () => {
	const f = compile({ exclude: ["*audio*"] }, { exclude: ["*tts*"], excludeRegex: ["^embed$"] });
	assert.equal(applyFilters("tts-1", f).kept, false);
	assert.equal(applyFilters("embed", f).kept, false);
	assert.equal(applyFilters("audio-1", f).kept, false);
	assert.equal(f.hasWhitelist, false);
	assert.equal(applyFilters("whatever", f).kept, true);
});

test("summarizeDrops aggregates counts, biggest first", () => {
	const f = compile({ exclude: ["*audio*"] });
	const outcomes = ["a", "b", "audio-1", "audio-2", "c"].map((id) => applyFilters(id, f));
	const summary = summarizeDrops(outcomes);
	assert.equal(summary.raw, 5);
	assert.equal(summary.kept, 3);
	assert.deepEqual(summary.drops, [{ reason: "exclude:*audio*", count: 2 }]);
});
