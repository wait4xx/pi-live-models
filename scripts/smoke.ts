/**
 * Smoke test: load the extension with a fake pi, optionally run a real
 * refreshModels pass for one provider.
 *
 *   npx tsx scripts/smoke.ts            # registration only
 *   npx tsx scripts/smoke.ts GLM        # registration + live refresh of GLM
 *
 * Reads the real ~/.pi/agent/live-models.json (or $PI_CODING_AGENT_DIR).
 */
interface Registered {
	id: string;
	cfg: Record<string, unknown>;
}

const registered: Registered[] = [];
const fakePi = {
	registerProvider(id: string, cfg: Record<string, unknown>) {
		registered.push({ id, cfg });
	},
	registerCommand(_name: string, _def: unknown) {
		// commands need a TUI; not exercised here
	},
	log(message: string) {
		console.log(message);
	},
};

const { default: extension } = await import("../extensions/index.ts");
extension(fakePi as never);

console.log(`registered ${registered.length} provider(s): ${registered.map((r) => r.id).join(", ") || "(none)"}`);

const target = process.argv[2];
if (target) {
	const found = registered.find((r) => r.id === target);
	if (!found) {
		console.error(`provider "${target}" is not registered`);
		process.exit(1);
	}
	const refresh = found.cfg.refreshModels as (context: unknown) => Promise<Array<{ id: string; contextWindow: number }>>;
	const models = await refresh({});
	console.log(`${target}: ${models.length} models`);
	for (const m of models.slice(0, 10)) console.log(`  - ${m.id} (ctx=${m.contextWindow})`);
	if (models.length > 10) console.log(`  ... and ${models.length - 10} more`);
}
