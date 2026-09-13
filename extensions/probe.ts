/**
 * Behavior probing for pi-live-models: differential thinking-effort probes
 * that measure what a gateway ACTUALLY executes, then derive a pi
 * `thinkingLevelMap` (+ `compat`) suggestion from the evidence.
 *
 * Metadata discovery (discover.ts) answers "which models exist, what are
 * their windows and prices". No public catalog records which effort values a
 * gateway accepts, whether `thinking: disabled` is honored or silently
 * swallowed, or whether adaptive effort changes behavior at all — those are
 * per-model, per-relay implementation details (the same relay honored
 * `disabled` for one model and swallowed it for another in the wild).
 * `/live-models-probe` measures them directly:
 *
 *   - one probe per candidate level (`off`, `minimal`…`max`) with a tiny
 *     fixed prompt; each response is reduced to {status, thinking, tokens};
 *   - accepted levels map to themselves, rejected levels to `null`
 *     (pi hides/clamps them); a `disabled` probe that still returns thinking
 *     marks `off: null` (cannot disable — do not fake the level);
 *   - near-identical output across accepted levels is flagged: the gateway
 *     may accept but ignore effort values.
 *
 * Everything here is pure over its inputs (unit-tested); the fetch loop and
 * command wiring live in index.ts, like the rest of the network surface.
 */

/** The APIs the probe understands. Others degrade to an explicit error. */
export type ProbeApi = "anthropic-messages" | "openai-responses" | "openai-completions";

export const PROBE_APIS: readonly ProbeApi[] = ["anthropic-messages", "openai-responses", "openai-completions"];

/** pi effort levels (everything except `off`). */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * The probe prompt: hard enough that a reasoning model thinks at least a
 * little on most gateways, short enough that 7 requests stay cheap.
 */
export const PROBE_PROMPT = "How many three-digit prime numbers are there? Answer with just the number.";

/** Output ceiling per probe — room for a small thinking block, nothing more. */
export const PROBE_MAX_TOKENS = 512;

/** Accepted levels whose token spread stays within this are flagged as "flat". */
const FLAT_TOKEN_SPREAD = 3;

/** One planned request. */
export interface ProbeShot {
	/** Stable label: "off" or an effort level. */
	label: string;
	/** What this probe decides. */
	purpose: string;
	/** API-specific fields merged into the request body. */
	payload: Record<string, unknown>;
	/** Send this shot twice (`label` and `label·2`) and require both clean — for the `off` shot, whose relay behavior is known to flip-flop. Default false. */
	confirm?: boolean;
}

/** One measured outcome. */
export interface ProbeOutcome {
	label: string;
	/** HTTP 2xx and the body parsed (or at least did not error the request). */
	ok: boolean;
	/** HTTP status; null = network/timeout error. */
	status: number | null;
	hasThinking: boolean;
	/** Thinking volume in response-native units (chars, or reasoning tokens). */
	thinkingChars: number;
	outputTokens: number | null;
	/** Truncated error body / failure reason; failures only. */
	error: string | undefined;
}

/** What interpretProbes() derives from a full outcome set. */
export interface ProbeSuggestion {
	/** Complete 7-level pi thinking map; absent when probing found nothing to map. */
	thinkingLevelMap?: Record<string, string | null>;
	/** Model-level compat keys (e.g. forceAdaptiveThinking). Merged on apply. */
	compat?: Record<string, unknown>;
	/** Set to true (only ever true) when thinking was observed. */
	reasoning?: boolean;
	/** Human-readable caveats, shown verbatim by the command. */
	notes: string[];
}

function withVersionPath(baseUrl: string, leaf: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return /\/v\d+$/.test(base) ? `${base}/${leaf}` : `${base}/v1/${leaf}`;
}

/**
 * Chat endpoint for a base URL, version-suffix aware (same rule as
 * buildModelsUrl): `https://x` -> `https://x/v1/<leaf>`, `https://x/v1` ->
 * `https://x/v1/<leaf>`.
 */
export function chatEndpointUrl(baseUrl: string, api: ProbeApi): string {
	switch (api) {
		case "anthropic-messages":
			return withVersionPath(baseUrl, "messages");
		case "openai-responses":
			return withVersionPath(baseUrl, "responses");
		case "openai-completions":
			return withVersionPath(baseUrl, "chat/completions");
	}
}

/** Plan the probe set for an API: `off` first (sent twice — relays are known to flip-flop on disabling), then every effort level. */
export function planProbeShots(api: ProbeApi): ProbeShot[] {
	switch (api) {
		case "anthropic-messages":
			return [
				{ label: "off", purpose: "thinking.type=disabled — is disabling honored? (sent twice)", payload: { thinking: { type: "disabled" } }, confirm: true },
				...EFFORT_LEVELS.map((level) => ({
					label: level,
					purpose: `adaptive + effort=${level}`,
					payload: { thinking: { type: "adaptive" }, output_config: { effort: level } },
				})),
			];
		case "openai-responses":
			return [
				{ label: "off", purpose: "reasoning.effort=none (sent twice)", payload: { reasoning: { effort: "none" } }, confirm: true },
				...EFFORT_LEVELS.map((level) => ({
					label: level,
					purpose: `reasoning.effort=${level}`,
					payload: { reasoning: { effort: level } },
				})),
			];
		case "openai-completions":
			return [
				{ label: "off", purpose: "reasoning_effort=none (sent twice)", payload: { reasoning_effort: "none" }, confirm: true },
				...EFFORT_LEVELS.map((level) => ({
					label: level,
					purpose: `reasoning_effort=${level}`,
					payload: { reasoning_effort: level },
				})),
			];
	}
}

/** Full request body for one shot: API boilerplate + the shot payload. */
export function buildProbeBody(api: ProbeApi, modelId: string, shot: ProbeShot): Record<string, unknown> {
	const base =
		api === "openai-responses"
			? { model: modelId, max_output_tokens: PROBE_MAX_TOKENS, input: PROBE_PROMPT, store: false }
			: { model: modelId, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: PROBE_PROMPT }] };
	return { ...base, ...shot.payload };
}

/** Thinking/output signal extracted from a (parsed) response body. */
export interface ProbeSignal {
	hasThinking: boolean;
	thinkingChars: number;
	outputTokens: number | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduce one parsed response body to a signal. Pure; tolerant of missing
 * fields (missing usage -> null tokens, missing content -> no thinking).
 *
 *   anthropic-messages: content[].type === "thinking"; usage.output_tokens
 *   openai-responses:   output[].type === "reasoning" or
 *                       usage.output_tokens_details.reasoning_tokens > 0
 *   openai-completions: choices[0].message.reasoning_content / .reasoning
 */
export function reduceResponse(api: ProbeApi, parsed: unknown): ProbeSignal {
	const signal: ProbeSignal = { hasThinking: false, thinkingChars: 0, outputTokens: null };
	if (!isPlainObject(parsed)) return signal;
	const usage = isPlainObject(parsed.usage) ? parsed.usage : {};
	if (api === "anthropic-messages") {
		if (Array.isArray(parsed.content)) {
			for (const block of parsed.content) {
				// redacted_thinking carries no plaintext but is thinking all the
				// same — a level whose only thinking is redacted must still count.
				if (isPlainObject(block) && (block.type === "thinking" || block.type === "redacted_thinking")) {
					signal.hasThinking = true;
				signal.thinkingChars += typeof block.thinking === "string" ? block.thinking.length : 0;
				}
			}
		}
		signal.outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
	} else if (api === "openai-responses") {
		const details = isPlainObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
		const reasoningTokens = typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : 0;
		let reasoningBlocks = 0;
		if (Array.isArray(parsed.output)) {
			for (const item of parsed.output) {
				if (isPlainObject(item) && item.type === "reasoning") reasoningBlocks += 1;
			}
		}
		signal.hasThinking = reasoningBlocks > 0 || reasoningTokens > 0;
		signal.thinkingChars = reasoningTokens > 0 ? reasoningTokens : reasoningBlocks;
		signal.outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
	} else {
		const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
		const message = isPlainObject(choices[0]) && isPlainObject(choices[0].message) ? choices[0].message : {};
		const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : typeof message.reasoning === "string" ? message.reasoning : "";
		signal.hasThinking = reasoning.length > 0;
		signal.thinkingChars = reasoning.length;
		signal.outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
	}
	return signal;
}

/**
 * Sniff pi's auto-detected thinking wire format for an openai-completions
 * gateway from its baseUrl (mirrors pi's detectCompat host list). Gateways
 * that match none of these use the plain `reasoning_effort` shape the probe
 * sends; a configured compat.thinkingFormat overrides this sniff.
 */
export function sniffedThinkingFormat(baseUrl: string): "deepseek" | "zai" | "together" | "ant-ling" | "openrouter" | "openai" {
	const url = baseUrl.toLowerCase();
	if (url.includes("deepseek.com")) return "deepseek";
	if (url.includes("api.z.ai") || url.includes("open.bigmodel.cn")) return "zai";
	if (url.includes("api.together.ai") || url.includes("api.together.xyz")) return "together";
	if (url.includes("api.ant-ling.com")) return "ant-ling";
	if (url.includes("openrouter.ai")) return "openrouter";
	return "openai";
}

function summarizeFailures(outcomes: ProbeOutcome[]): string {
	const counts = new Map<string, number>();
	for (const o of outcomes) {
		const key = o.error ? `HTTP ${o.status}: ${o.error}` : `HTTP ${o.status ?? "network error"}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].map(([key, n]) => (n > 1 ? `${key} ×${n}` : key)).join("; ");
}

/**
 * Interpret a full outcome set into a suggestion (or null when nothing
 * succeeded — a dead key or wrong model id, not an effort question).
 *
 * Map rules:
 *   - accepted level  -> itself (pi sends the value verbatim)
 *   - rejected level  -> null (pi hides/clamps it away)
 *   - off             -> honored ("off"/"none"), swallowed or rejected (null)
 *   - anthropic + any adaptive success -> compat.forceAdaptiveThinking
 *     (without it pi never sends effort strings on anthropic-messages)
 */
export function interpretProbes(api: ProbeApi, outcomes: ProbeOutcome[]): ProbeSuggestion | null {
	const byLabel = new Map(outcomes.map((o) => [o.label, o]));
	// The `off` shot runs twice (label "off" + "off·2") — relays are known to
	// honor disabling on one request and swallow it on the next. Only a clean
	// pair counts as disableable; a swallowed or failed confirmation flips
	// the verdict to "cannot disable" with a dedicated note.
	const off = byLabel.get("off");
	const off2 = byLabel.get("off\u00b72");
	const offHonoredFirst = off !== undefined && off.ok && !off.hasThinking;
	const offCleanPair = offHonoredFirst && (off2 === undefined || (off2.ok && !off2.hasThinking));
	const offConfirmFailed = offHonoredFirst && off2 !== undefined && !off2.ok;
	const offFlipFlopped = offHonoredFirst && off2 !== undefined && off2.ok && off2.hasThinking;
	const efforts = EFFORT_LEVELS.map((level) => byLabel.get(level)).filter((o): o is ProbeOutcome => o !== undefined);

	if (!outcomes.some((o) => o.ok)) return null;

	if (!efforts.some((e) => e.ok)) {
		// No effort value was accepted at all. For anthropic this also means
		// effort strings would never be sent — writing a map would only hide
		// levels without gaining control. Report, don't configure.
		return {
			notes: [
				`every effort value was rejected (${summarizeFailures(efforts)}) — no effort control detected; nothing written`,
				...(off
					? [
							off.ok
								? off.hasThinking
									? "off: returned 200 but thinking still present (swallowed)"
									: "off: disabling works, effort does not — a thinkingLevelMap would only hide levels; not written"
								: `off: HTTP ${off.status} — disabling rejected too`,
						]
					: []),
			],
		};
	}

	const map: Record<string, string | null> = { off: null };
	// Both APIs require the clean pair: a 200-with-thinking off probe must
	// never produce a writable off level (pi would send the disable request
	// and the gateway would still reason).
	map.off = offCleanPair ? (api === "anthropic-messages" ? "off" : "none") : null;
	for (const level of EFFORT_LEVELS) {
		const o = byLabel.get(level);
		map[level] = o && o.ok ? level : null;
	}

	const notes: string[] = [];
	if (offFlipFlopped) {
		notes.push("off: disabling looked honored on the first request but the confirmation request still contains thinking — relay behavior flip-flops; off=null (cannot rely on disabling)");
	} else if (offConfirmFailed) {
		notes.push(`off: confirmation probe failed (HTTP ${off2?.status ?? "network error"}) — disabling unconfirmed; off=null`);
	} else if (off && off.ok && off.hasThinking) {
		notes.push(
			api === "anthropic-messages"
				? "off: thinking.type=disabled returned 200 but the response still contains thinking — the gateway swallows it; off=null (cannot disable)"
				: "off: effort=none returned 200 but the response still contains reasoning — treated as not disableable; off=null",
		);
	} else if (!off || !off.ok) {
		notes.push(
			api === "anthropic-messages"
				? `off: ${off ? `HTTP ${off.status}` : "probe missing"} — disabling rejected; off=null`
				: `off: ${off ? `HTTP ${off.status}` : "probe missing"} — effort=none rejected; off=null (pi omits the reasoning parameter)`,
		);
	}

	const anyThinking = outcomes.some((o) => o.hasThinking);
	const acceptedTokens = efforts.filter((e) => e.ok && e.outputTokens !== null).map((e) => e.outputTokens as number);
	if (!anyThinking && acceptedTokens.length >= 2) {
		const spread = Math.max(...acceptedTokens) - Math.min(...acceptedTokens);
		if (spread <= FLAT_TOKEN_SPREAD) {
			notes.push(`all accepted efforts produced near-identical output (Δ${spread} tokens, no thinking) — the gateway may accept but ignore effort values`);
		}
	}
	if (!anyThinking) {
		notes.push("no thinking observed on the probe prompt — set reasoning:true manually if the model is known to reason");
	}

	const suggestion: ProbeSuggestion = { thinkingLevelMap: map, notes };
	if (anyThinking) suggestion.reasoning = true;
	if (api === "anthropic-messages") suggestion.compat = { forceAdaptiveThinking: true };
	return suggestion;
}
