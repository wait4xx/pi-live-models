#!/usr/bin/env node
/**
 * render-stats.mjs — zero-dependency README stats charts (SVG).
 *
 * Generates:
 *   docs/stats/npm-downloads.svg  — daily npm downloads over the last 180 days
 *   docs/stats/stars.svg          — cumulative GitHub stargazers (full history)
 *
 * Data sources:
 *   npm:     https://api.npmjs.org/downloads/range/{from}:{to}/{pkg}   (public, no auth)
 *   GitHub:  /repos/{repo}/stargazers with the star+json preview       (needs a token
 *            that may read the repo — since 2026-06-30 GitHub limits stargazer access
 *            to repo admins/collaborators, which the repo's own Actions token is)
 *
 * Env:
 *   GH_TOKEN  optional; without it (or on any GitHub failure) the stars chart is
 *             skipped with a notice and the run still succeeds — npm is the point.
 *
 * Runs anywhere with plain Node >= 18. Never throws on missing data: a chart with
 * zero points renders a readable "no data yet" placeholder.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const STATS_DIR = path.join(process.cwd(), "docs", "stats");
const NPM_WINDOW_DAYS = 180;

// ---------------------------------------------------------------- data fetch

async function fetchJson(url, headers = {}) {
	const res = await fetch(url, { headers: { "User-Agent": "stats-renderer", ...headers } });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${url}`);
	return res.json();
}

async function fetchNpmDownloads(pkg, days) {
	const to = new Date(Date.now() - 86400_000); // full days only — today is still in progress
	const from = new Date(to.getTime() - days * 86400_000);
	const fmt = (d) => d.toISOString().slice(0, 10);
	const data = await fetchJson(`https://api.npmjs.org/downloads/range/${fmt(from)}:${fmt(to)}/${pkg}`);
	// { downloads: [{ day, downloads }...] } — days before first publish come back as 0;
	// trim that zero prefix (keep one zero day of padding) so a young package's
	// chart isn't flattened into its baseline. Returns the effective start date.
	const all = (data.downloads ?? []).map((d) => ({ date: d.day, value: d.downloads }));
	let first = all.findIndex((p) => p.value > 0);
	if (first < 0) return { start: all[0]?.date, trimmed: false, series: all };
	first = Math.max(0, first - 1);
	return { start: all[first].date, trimmed: true, series: all.slice(first) };
}

async function fetchStargazers(repo, token) {
	const out = [];
	let page = 1;
	for (;;) {
		const batch = await fetchJson(`https://api.github.com/repos/${repo}/stargazers?per_page=100&page=${page}`, {
			Accept: "application/vnd.github.star+json",
			Authorization: `Bearer ${token}`,
		});
		if (!Array.isArray(batch) || batch.length === 0) break;
		for (const s of batch) if (s?.starred_at) out.push({ date: s.starred_at.slice(0, 10), value: 1 });
		if (batch.length < 100) break;
		page += 1;
	}
	// cumulative count per date
	let total = 0;
	return out
		.sort((a, b) => (a.date < b.date ? -1 : 1))
		.map((p) => ({ date: p.date, value: (total += 1) }));
}

// ---------------------------------------------------------------- svg chart

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmtNum(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

/**
 * Simple, readable line/area chart. points: [{date: "YYYY-MM-DD", value}] in
 * chronological order (dates may repeat — both points get drawn).
 */
function lineChart({ title, subtitle, points, color, fill }) {
	const W = 820;
	const H = 240;
	const M = { top: 34, right: 16, bottom: 26, left: 46 };
	const iw = W - M.left - M.right;
	const ih = H - M.top - M.bottom;

	const noData = points.length === 0;
	const maxValue = noData ? 1 : Math.max(...points.map((p) => p.value), 1);
	const spanMs = noData ? 1 : Math.max(new Date(points.at(-1).date) - new Date(points[0].date), 86400_000);
	const x = (p) => M.left + ((new Date(p.date) - new Date(points[0].date)) / spanMs) * iw;
	const y = (v) => M.top + ih - (v / maxValue) * ih;

	const poly = points.map((p) => `${x(p).toFixed(1)},${y(p.value).toFixed(1)}`);
	const area = noData ? "" : `${M.left},${M.top + ih} ${poly.join(" ")} ${M.left + iw},${M.top + ih}`;
	const gridYs = [0, 0.25, 0.5, 0.75, 1];
	const dateLabel = (frac) => {
		if (noData) return "";
		const d = new Date(new Date(points[0].date).getTime() + frac * spanMs);
		return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
	};

	// series — no data -> readable placeholder; a single point renders as a
	// centered marker (a lone polyline vertex is invisible in most renderers)
	const seriesSvg = noData
		? `<text x="${M.left + iw / 2}" y="${M.top + ih / 2}" text-anchor="middle" font-size="13" fill="#57606a">no data yet</text>`
		: points.length === 1
			? `<circle cx="${(M.left + iw / 2).toFixed(1)}" cy="${y(points[0].value).toFixed(1)}" r="3" fill="${color}"/>`
			: `<polygon points="${area}" fill="${fill}"/><polyline points="${poly.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">`,
		`<rect width="${W}" height="${H}" fill="#ffffff"/>`,
		// grid + y labels
		...gridYs.map((f) => {
			const gy = M.top + ih - f * ih;
			return `<line x1="${M.left}" y1="${gy.toFixed(1)}" x2="${M.left + iw}" y2="${gy.toFixed(1)}" stroke="#d0d7de" stroke-width="1" stroke-dasharray="${f === 0 ? "0" : "3 4"}"/><text x="${M.left - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#57606a">${fmtNum(Math.round(maxValue * f))}</text>`;
		}),
		// x labels
		`<text x="${M.left}" y="${H - 8}" font-size="11" fill="#57606a">${esc(dateLabel(0))}</text>`,
		`<text x="${M.left + iw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#57606a">${esc(dateLabel(0.5))}</text>`,
		`<text x="${M.left + iw}" y="${H - 8}" text-anchor="end" font-size="11" fill="#57606a">${esc(dateLabel(1))}</text>`,
		// series svg (placeholder / single-point marker / area+line)
		seriesSvg,
		// titles
		`<text x="${M.left}" y="20" font-size="14" font-weight="600" fill="#1f2328">${esc(title)}</text>`,
		`<text x="${W - M.right}" y="20" text-anchor="end" font-size="12" fill="#57606a">${esc(subtitle)}</text>`,
		`</svg>`,
	].join("\n");
}

// ---------------------------------------------------------------- main

function pkgName() {
	return JSON.parse(fs.readFileSync("package.json", "utf8")).name;
}

function gitRepo() {
	try {
		const url = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
		const m = url.match(/(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
		return m?.[1];
	} catch {
		return undefined;
	}
}

async function main() {
	fs.mkdirSync(STATS_DIR, { recursive: true });
	const results = [];

	// npm downloads — the primary chart
	try {
		const pkg = pkgName();
		const { start, trimmed, series } = await fetchNpmDownloads(pkg, NPM_WINDOW_DAYS);
		const total = series.reduce((s, p) => s + p.value, 0);
		const last30 = series.slice(-30).reduce((s, p) => s + p.value, 0);
		const subtitle = `${trimmed ? `since ${start}` : `last ${NPM_WINDOW_DAYS}d`}: ${total}${series.length > 30 ? ` · last 30d: ${last30}` : ""}`;
		fs.writeFileSync(
			path.join(STATS_DIR, "npm-downloads.svg"),
			lineChart({
				title: `${pkg} — npm downloads / day`,
				subtitle,
				points: series,
				color: "#1f883d",
				fill: "rgba(31,136,61,0.12)",
			}),
		);
		results.push(`npm-downloads.svg: ${series.length} days, ${total} total`);
	} catch (err) {
		// Keep the previous chart on transient npm API failures — a 5xx/429
		// blip must not replace a good README chart with "unavailable" for a day.
		console.error(`[stats] npm chart failed: ${err.message}`);
		const target = path.join(STATS_DIR, "npm-downloads.svg");
		if (!fs.existsSync(target)) {
			fs.writeFileSync(
				target,
				lineChart({ title: `${pkgName()} — npm downloads / day`, subtitle: "unavailable", points: [], color: "#1f883d", fill: "rgba(31,136,61,0.12)" }),
			);
		} else {
			console.error("[stats] keeping previous npm chart");
		}
		results.push("npm-downloads.svg: FAILED");
	}

	// stars — best effort, needs GH_TOKEN
	const repo = process.env.GH_REPO?.replace(/^.*github\.com\//, "") || gitRepo();
	const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (!repo || !token) {
		console.error(`[stats] stars chart skipped (${!repo ? "no repo" : "no GH_TOKEN"})`);
		return results;
	}
	try {
		const series = await fetchStargazers(repo, token);
		const total = series.at(-1)?.value ?? 0;
		fs.writeFileSync(
			path.join(STATS_DIR, "stars.svg"),
			lineChart({
				title: `${repo} — GitHub stars`,
				subtitle: `${total} total`,
				points: series,
				color: "#0969da",
				fill: "rgba(9,105,218,0.10)",
			}),
		);
		results.push(`stars.svg: ${total} stars`);
	} catch (err) {
		console.error(`[stats] stars chart failed: ${err.message} — writing placeholder, keeping any previous chart`);
		if (!fs.existsSync(path.join(STATS_DIR, "stars.svg"))) {
			fs.writeFileSync(path.join(STATS_DIR, "stars.svg"), lineChart({ title: `${repo} — GitHub stars`, subtitle: "unavailable", points: [], color: "#0969da", fill: "rgba(9,105,218,0.10)" }));
		}
		results.push("stars.svg: FAILED");
	}
	return results;
}

main()
	.then((results) => {
		for (const line of results) console.log(`[stats] ${line}`);
	})
	.catch((err) => {
		console.error(`[stats] fatal: ${err.message}`);
		process.exit(1);
	});
