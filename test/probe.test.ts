import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProbeToRawConfig } from "../extensions/config.ts";
import {
	PROBE_APIS,
	buildProbeBody,
	chatEndpointUrl,
	interpretProbes,
	planProbeShots,
	reduceResponse,
	type ProbeOutcome,
} from "../extensions/probe.ts";

// ---------------------------------------------------------------------------
// chatEndpointUrl
// ---------------------------------------------------------------------------

test("chatEndpointUrl is version-suffix aware for every api", () => {
	assert.equal(chatEndpointUrl("https://x.example", "anthropic-messages"), "https://x.example/v1/messages");
	assert.equal(chatEndpointUrl("https://x.example/v1", "anthropic-messages"), "https://x.example/v1/messages");
	assert.equal(chatEndpointUrl("https://x.example/api/v3/", "openai-responses"), "https://x.example/api/v3/responses");
	assert.equal(chatEndpointUrl("https://x.example", "openai-responses"), "https://x.example/v1/responses");
	assert.equal(chatEndpointUrl("https://x.example/v1", "openai-completions"), "https://x.example/v1/chat/completions");
});

// ---------------------------------------------------------------------------
// planProbeShots / buildProbeBody
// ---------------------------------------------------------------------------

test("planProbeShots: off first, then every effort level, for each api", () => {
	for (const api of PROBE_APIS) {
		const shots = planProbeShots(api);
		assert.equal(shots.length, 7);
		assert.equal(shots[0].label, "off");
		assert.deepEqual(
			shots.slice(1).map((s) => s.label),
			["minimal", "low", "medium", "high", "xhigh", "max"],
		);
	}
});

test("planProbeShots: payloads carry the right protocol shape per api", () => {
	const anth = planProbeShots("anthropic-messages");
	assert.deepEqual(anth[0].payload, { thinking: { type: "disabled" } });
	assert.deepEqual(anth[1].payload, { thinking: { type: "adaptive" }, output_config: { effort: "minimal" } });
	assert.deepEqual(anth[6].payload, { thinking: { type: "adaptive" }, output_config: { effort: "max" } });

	const responses = planProbeShots("openai-responses");
	assert.deepEqual(responses[0].payload, { reasoning: { effort: "none" } });
	assert.deepEqual(responses[4].payload, { reasoning: { effort: "high" } });

	const completions = planProbeShots("openai-completions");
	assert.deepEqual(completions[0].payload, { reasoning_effort: "none" });
	assert.deepEqual(completions[3].payload, { reasoning_effort: "medium" });
});

test("buildProbeBody: api boilerplate with shot payload merged on top", () => {
	const anth = buildProbeBody("anthropic-messages", "m1", { label: "off", purpose: "", payload: { thinking: { type: "disabled" } } });
	assert.equal((anth as { model?: string }).model, "m1");
	assert.deepEqual((anth as { messages?: unknown[] }).messages, [{ role: "user", content: "How many three-digit prime numbers are there? Answer with just the number." }]);
	assert.deepEqual((anth as { thinking?: unknown }).thinking, { type: "disabled" });

	const responses = buildProbeBody("openai-responses", "m1", { label: "high", purpose: "", payload: { reasoning: { effort: "high" } } });
	assert.equal((responses as { input?: string }).input, "How many three-digit prime numbers are there? Answer with just the number.");
	assert.equal((responses as { max_output_tokens?: number }).max_output_tokens, 512);
	assert.deepEqual((responses as { reasoning?: unknown }).reasoning, { effort: "high" });
});

// ---------------------------------------------------------------------------
// reduceResponse
// ---------------------------------------------------------------------------

test("reduceResponse: anthropic thinking blocks and usage", () => {
	const signal = reduceResponse(
		"anthropic-messages",
		{ content: [{ type: "thinking", thinking: "abc" }, { type: "text", text: "143" }], usage: { output_tokens: 9 } },
	);
	assert.deepEqual(signal, { hasThinking: true, thinkingChars: 3, outputTokens: 9 });

	const bare = reduceResponse("anthropic-messages", { content: [{ type: "text", text: "143" }], usage: {} });
	assert.deepEqual(bare, { hasThinking: false, thinkingChars: 0, outputTokens: null });

	const broken = reduceResponse("anthropic-messages", "not an object");
	assert.deepEqual(broken, { hasThinking: false, thinkingChars: 0, outputTokens: null });
});

test("reduceResponse: responses reasoning items and reasoning_tokens", () => {
	const viaBlocks = reduceResponse("openai-responses", { output: [{ type: "reasoning" }, { type: "message" }], usage: { output_tokens: 20 } });
	assert.deepEqual(viaBlocks, { hasThinking: true, thinkingChars: 1, outputTokens: 20 });

	const viaUsage = reduceResponse("openai-responses", { output: [{ type: "message" }], usage: { output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } } });
	assert.deepEqual(viaUsage, { hasThinking: true, thinkingChars: 7, outputTokens: 20 });
});

test("reduceResponse: completions reasoning_content", () => {
	const signal = reduceResponse("openai-completions", { choices: [{ message: { content: "143", reasoning_content: "xx" } }], usage: { completion_tokens: 5 } });
	assert.deepEqual(signal, { hasThinking: true, thinkingChars: 2, outputTokens: 5 });
});

// ---------------------------------------------------------------------------
// interpretProbes
// ---------------------------------------------------------------------------

function outcome(label: string, over: Partial<ProbeOutcome> = {}): ProbeOutcome {
	return { label, ok: true, status: 200, hasThinking: false, thinkingChars: 0, outputTokens: null, error: undefined, ...over };
}

function fullSet(over: Record<string, Partial<ProbeOutcome>>): ProbeOutcome[] {
	const labels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return labels.map((label) => outcome(label, over[label] ?? {}));
}

test("interpretProbes: null when every probe failed", () => {
	const outcomes = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((label) =>
		outcome(label, { ok: false, status: 400, error: `bad value: ${label}` }),
	);
	assert.equal(interpretProbes("anthropic-messages", outcomes), null);
	assert.equal(interpretProbes("openai-responses", outcomes), null);
});

test("interpretProbes: anthropic — all accepted, off honored", () => {
	const suggestion = interpretProbes("anthropic-messages", fullSet({ off: { hasThinking: false }, low: { hasThinking: true, thinkingChars: 40, outputTokens: 10 }, max: { hasThinking: true, thinkingChars: 90, outputTokens: 30 } }));
	assert.deepEqual(suggestion?.thinkingLevelMap, { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
	assert.deepEqual(suggestion?.compat, { forceAdaptiveThinking: true });
	assert.equal(suggestion?.reasoning, true);
	assert.deepEqual(suggestion?.notes, []);
});

test("interpretProbes: anthropic — off swallowed (200 but thinking present)", () => {
	const suggestion = interpretProbes("anthropic-messages", fullSet({ off: { hasThinking: true, thinkingChars: 12 } }));
	assert.equal(suggestion?.thinkingLevelMap?.off, null);
	assert.ok(suggestion?.notes.some((n) => n.includes("swallows it")));
});

test("interpretProbes: anthropic — off rejected (400)", () => {
	const suggestion = interpretProbes("anthropic-messages", fullSet({ off: { ok: false, status: 400, error: "disabled not supported" } }));
	assert.equal(suggestion?.thinkingLevelMap?.off, null);
	assert.ok(suggestion?.notes.some((n) => n.includes("disabling rejected")));
});

test("interpretProbes: anthropic — off flip-flopped across confirmation pair => null with dedicated note", () => {
	const base = fullSet({ low: { hasThinking: true, outputTokens: 8 }, high: { hasThinking: true, outputTokens: 40 } });
	const outcomes = [...base, { label: "off·2", ok: true, status: 200, hasThinking: true, thinkingChars: 9, outputTokens: 20, error: undefined } as ProbeOutcome];
	const suggestion = interpretProbes("anthropic-messages", outcomes);
	assert.equal(suggestion?.thinkingLevelMap?.off, null);
	assert.ok(suggestion?.notes.some((n) => n.includes("flip-flops")));
});

test("interpretProbes: anthropic — clean off pair keeps off available", () => {
	const base = fullSet({ low: { hasThinking: true, outputTokens: 8 } });
	const outcomes = [...base, { label: "off·2", ok: true, status: 200, hasThinking: false, thinkingChars: 0, outputTokens: 4, error: undefined } as ProbeOutcome];
	const suggestion = interpretProbes("anthropic-messages", outcomes);
	assert.equal(suggestion?.thinkingLevelMap?.off, "off");
});

test("planProbeShots: off shot requests a confirmation repeat", () => {
	for (const api of PROBE_APIS) {
		const shots = planProbeShots(api);
		assert.equal(shots[0].label, "off");
		assert.equal(shots[0].confirm, true);
		assert.equal(shots.slice(1).every((s) => s.confirm === undefined), true);
	}
});

test("interpretProbes: anthropic — rejected levels become null, accepted keep themselves", () => {
	const suggestion = interpretProbes("anthropic-messages", fullSet({ medium: { ok: false, status: 400, error: "invalid effort" }, xhigh: { ok: false, status: 400, error: "invalid effort" }, low: { hasThinking: true, outputTokens: 8 }, high: { hasThinking: true, outputTokens: 40 }, max: { hasThinking: true, outputTokens: 99 } }));
	assert.deepEqual(suggestion?.thinkingLevelMap, { off: "off", minimal: "minimal", low: "low", medium: null, high: "high", xhigh: null, max: "max" });
});

test("interpretProbes: anthropic — adaptive entirely rejected => notes only, no map, no compat", () => {
	const over: Record<string, Partial<ProbeOutcome>> = { off: { hasThinking: false } };
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) over[level] = { ok: false, status: 400, error: "thinking.type invalid" };
	const suggestion = interpretProbes("anthropic-messages", fullSet(over));
	assert.equal(suggestion?.thinkingLevelMap, undefined);
	assert.equal(suggestion?.compat, undefined);
	assert.ok(suggestion?.notes.some((n) => n.includes("no effort control detected")));
});

test("interpretProbes: responses — none rejected => off null with omit note", () => {
	const suggestion = interpretProbes("openai-responses", fullSet({ off: { ok: false, status: 400, error: "invalid effort" }, low: { hasThinking: true, outputTokens: 5 }, max: { hasThinking: true, outputTokens: 40 } }));
	assert.equal(suggestion?.thinkingLevelMap?.off, null);
	assert.equal(suggestion?.thinkingLevelMap?.minimal, "minimal");
	assert.equal(suggestion?.compat, undefined);
	assert.ok(suggestion?.notes.some((n) => n.includes("pi omits the reasoning parameter")));
});

test("interpretProbes: flat accepted efforts are flagged as possibly ignored", () => {
	const suggestion = interpretProbes("openai-completions", fullSet({ off: { ok: false, status: 400, error: "x" }, low: { outputTokens: 4 }, medium: { outputTokens: 4 }, high: { outputTokens: 5 }, xhigh: { outputTokens: 5 }, max: { outputTokens: 6 } }));
	assert.ok(suggestion?.notes.some((n) => n.includes("may accept but ignore effort values")));
	assert.equal(suggestion?.reasoning, undefined); // no thinking observed -> not forced
	assert.ok(suggestion?.notes.some((n) => n.includes("reasoning:true manually")));
});

// ---------------------------------------------------------------------------
// applyProbeToRawConfig
// ---------------------------------------------------------------------------

test("applyProbeToRawConfig: creates nested overrides, preserves siblings and order", () => {
	const raw = { providers: { GLM: { baseUrl: "https://x", filters: { include: ["glm-*"] } } } } as Record<string, unknown>;
	const result = applyProbeToRawConfig(raw, "GLM", "glm-5.3", { thinkingLevelMap: { off: null, low: "low" }, compat: { forceAdaptiveThinking: true }, reasoning: true });
	assert.equal(result.ok, true);
	assert.deepEqual(result.fields, ["thinkingLevelMap", "compat", "reasoning"]);
	const entry = (raw.providers as Record<string, Record<string, unknown>>).GLM;
	assert.deepEqual(entry.filters, { include: ["glm-*"] }); // untouched sibling
	assert.deepEqual(entry.overrides, { "glm-5.3": { thinkingLevelMap: { off: null, low: "low" }, compat: { forceAdaptiveThinking: true }, reasoning: true } });
});

test("applyProbeToRawConfig: compat merges per key, map replaces wholesale, reasoning never writes false", () => {
	const raw = {
		providers: {
			GLM: {
				baseUrl: "https://x",
				overrides: {
					"glm-5.3": { contextWindow: 1000000, compat: { supportsTemperature: false }, thinkingLevelMap: { off: "off" } },
				},
			},
		},
	} as Record<string, unknown>;
	const result = applyProbeToRawConfig(raw, "GLM", "glm-5.3", { thinkingLevelMap: { off: null, low: "low" }, compat: { forceAdaptiveThinking: true }, reasoning: false });
	assert.equal(result.ok, true);
	assert.deepEqual(result.fields, ["thinkingLevelMap", "compat"]);
	const model = ((raw.providers as Record<string, Record<string, unknown>>).GLM.overrides as Record<string, Record<string, unknown>>)["glm-5.3"];
	assert.equal(model.contextWindow, 1000000); // existing override key untouched
	assert.deepEqual(model.compat, { supportsTemperature: false, forceAdaptiveThinking: true }); // merged, not replaced
	assert.deepEqual(model.thinkingLevelMap, { off: null, low: "low" }); // replaced wholesale
	assert.equal(model.reasoning, undefined); // reasoning:false never written
});

test("applyProbeToRawConfig: rejects reserved ids and missing providers", () => {
	const raw = { providers: { A: { baseUrl: "https://x" } } } as Record<string, unknown>;
	assert.equal(applyProbeToRawConfig(raw, "__proto__", "m", {}).ok, false);
	assert.equal(applyProbeToRawConfig(raw, "A", "constructor", {}).ok, false);
	assert.equal(applyProbeToRawConfig({ providers: {} }, "A", "m", {}).ok, false);
	assert.equal(applyProbeToRawConfig(null, "A", "m", {}).ok, false);
});
