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

test("global defaultFilters.excludeBy joins the blacklist union (field-level)", () => {
	const f = compile(undefined, { excludeBy: { owned_by: ["system"] } });
	assert.equal(applyFilters("m-1", f, { owned_by: "system" }).kept, false);
	assert.equal(applyFilters("m-1", f, { owned_by: "system" }).reason, "excludeBy:owned_by:system");
	assert.equal(applyFilters("m-1", f, { owned_by: "openai" }).kept, true);
	assert.equal(applyFilters("m-1", f, { owned_by: "openai" }).reason, undefined);
	// combined with entry-level id excludes
	const g = compile({ exclude: ["bad-*"] }, { excludeBy: { owned_by: ["system"] } });
	assert.equal(applyFilters("m-1", g, { owned_by: "system" }).kept, false);
	assert.equal(applyFilters("bad-1", g, { owned_by: "openai" }).kept, false);
	assert.equal(applyFilters("m-1", g, { owned_by: "openai" }).kept, true);
});

test("summarizeDrops aggregates counts, biggest first", () => {
	const f = compile({ exclude: ["*audio*"] });
	const outcomes = ["a", "b", "audio-1", "audio-2", "c"].map((id) => applyFilters(id, f));
	const summary = summarizeDrops(outcomes);
	assert.equal(summary.raw, 5);
	assert.equal(summary.kept, 3);
	assert.deepEqual(summary.drops, [{ reason: "exclude:*audio*", count: 2 }]);
});

test("excludeBy drops models whose field value matches a glob (case-insensitive)", () => {
	const f = compile({ excludeBy: { owned_by: ["system", "*-internal"] } });
	assert.equal(applyFilters("m-1", f, { owned_by: "system" }).kept, false);
	assert.equal(applyFilters("m-1", f, { owned_by: "X-INTERNAL" }).reason, "excludeBy:owned_by:*-internal");
	assert.equal(applyFilters("m-1", f, { owned_by: "openai" }).kept, true);
	assert.equal(applyFilters("m-1", f, {}).kept, true); // field missing -> cannot match
	assert.equal(applyFilters("m-1", f).kept, true); // no item at all -> cannot match
});

test("excludeBy walks dotted paths; array values match when any element hits", () => {
	const f = compile({ excludeBy: { "architecture.input_modalities": ["*image*"] } });
	assert.equal(applyFilters("m-1", f, { architecture: { input_modalities: ["text", "image"] } }).kept, false);
	assert.equal(applyFilters("m-1", f, { architecture: { input_modalities: ["text"] } }).kept, true);
	assert.equal(applyFilters("m-1", f, { architecture: {} }).kept, true);
	// non-string values never match
	assert.equal(applyFilters("m-1", f, { architecture: { input_modalities: [42, null] } }).kept, true);
});

test("includeBy requires every field to hit (AND); misses get a field-precise reason", () => {
	const f = compile({ includeBy: { owned_by: ["openai"], "architecture.input_modalities": ["text*"] } });
	assert.equal(applyFilters("m-1", f, { owned_by: "openai", architecture: { input_modalities: ["text"] } }).kept, true);
	const missField = applyFilters("m-1", f, { owned_by: "openai" }); // second field missing
	assert.equal(missField.kept, false);
	assert.equal(missField.reason, "includeBy-miss:architecture.input_modalities");
	assert.equal(applyFilters("m-1", f, { owned_by: "anthropic", architecture: { input_modalities: ["text"] } }).reason, "includeBy-miss:owned_by");
});

test("includeBy alone is whitelist mode; includeBy AND id-include combine", () => {
	const f = compile({ includeBy: { owned_by: ["openai"] } });
	assert.equal(f.hasWhitelist, true);
	assert.equal(f.hasIdInclude, false);
	assert.equal(applyFilters("m-1", f, { owned_by: 42 }).kept, false); // non-string never matches

	const g = compile({ include: ["gpt-*"], includeBy: { owned_by: ["openai"] } });
	const both = applyFilters("gpt-4o", g, { owned_by: "openai" });
	assert.equal(both.kept, true);
	assert.equal(both.reason, "include:gpt-*");
	assert.equal(applyFilters("gpt-4o", g, { owned_by: "system" }).reason, "includeBy-miss:owned_by");
	assert.equal(applyFilters("claude-3", g, { owned_by: "openai" }).reason, "whitelist-miss");
});

test("exclude always wins over field rules too", () => {
	const f = compile({ includeBy: { owned_by: ["openai"] }, exclude: ["secret-*"] });
	assert.equal(applyFilters("secret-1", f, { owned_by: "openai" }).kept, false);
	const g = compile({ include: ["m-*"], excludeBy: { owned_by: ["system"] } });
	assert.equal(applyFilters("m-1", g, { owned_by: "system" }).kept, false);
	assert.equal(applyFilters("m-1", g, { owned_by: "openai" }).reason, "include:m-*");
});
