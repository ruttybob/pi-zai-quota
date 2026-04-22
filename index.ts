import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────

interface UsageDetail {
	modelCode: string;
	usage: number;
}

interface Limit {
	type: string;
	unit: number;       // 5=monthly, 3=daily (from API)
	number: number;
	usage?: number;
	currentValue?: number;
	remaining?: number;
	percentage: number;
	nextResetTime: number; // ms epoch
	usageDetails?: UsageDetail[];
}

interface QuotaResponse {
	code: number;
	data: {
		limits: Limit[];
		level: string;
	};
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatResetTime(ms: number): string {
	const d = new Date(ms);
	const now = Date.now();
	const diffMs = ms - now;
	if (diffMs <= 0) return "now";

	const diffMin = Math.floor(diffMs / 60_000);
	const diffH = Math.floor(diffMin / 60);
	const diffD = Math.floor(diffH / 24);

	if (diffD > 0) return `${diffD}d ${diffH % 24}h`;
	if (diffH > 0) return `${diffH}h ${diffMin % 60}m`;
	return `${diffMin}m`;
}

function unitLabel(unit: number): string {
	switch (unit) {
		case 5:
			return "monthly";
		case 3:
			return "daily";
		default:
			return `unit-${unit}`;
	}
}

function typeLabel(type: string): string {
	switch (type) {
		case "TIME_LIMIT":
			return "⏱  Time Limit";
		case "TOKENS_LIMIT":
			return "🔤 Tokens Limit";
		default:
			return type;
	}
}

// ── Progress bar ─────────────────────────────────────────────────────────

function progressBar(pct: number, width: number, theme: Theme): string {
	const filled = Math.round((pct / 100) * width);
	const empty = width - filled;

	const bar =
		theme.fg(pct > 85 ? "error" : pct > 60 ? "warning" : "success", "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(empty));
	return bar;
}

// ── Component ────────────────────────────────────────────────────────────

class QuotaComponent {
	private data: QuotaResponse;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(data: QuotaResponse, theme: Theme, onClose: () => void) {
		this.data = data;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];
		const { limits, level } = this.data.data;
		const barWidth = Math.min(30, width - 30);

		// Header
		lines.push("");
		const title = th.fg("accent", th.bold(" ZAI Quota "));
		const pad = Math.max(0, width - 12);
		lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(pad)), width));

		// Level badge
		const levelBadge = th.fg("accent", th.bold(` ${level.toUpperCase()} `));
		lines.push(truncateToWidth(`  Plan: ${levelBadge}`, width));
		lines.push("");

		for (const limit of limits) {
			// Section title
			lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(typeLabel(limit.type)))}  ${th.fg("dim", `(${unitLabel(limit.unit)})`)}`, width));
			lines.push("");

			if (limit.type === "TIME_LIMIT") {
				// Main stats
				const used = limit.currentValue ?? 0;
				const total = limit.usage ?? 0;
				const rem = limit.remaining ?? 0;
				const pct = limit.percentage;

				// Progress bar
				const bar = progressBar(pct, barWidth, th);
				lines.push(truncateToWidth(`    ${bar}  ${th.fg("accent", `${pct}%`)}`, width));

				// Numbers
				lines.push(
					truncateToWidth(
						`    ${th.fg("text", "Used:")} ${th.fg("warning", `${used}`)}  ` +
							`${th.fg("text", "Total:")} ${th.fg("muted", `${total}`)}  ` +
							`${th.fg("text", "Remaining:")} ${th.fg("success", `${rem}`)}`,
						width,
					),
				);

				// Reset time
				lines.push(
					truncateToWidth(`    ${th.fg("text", "Resets in:")} ${th.fg("accent", formatResetTime(limit.nextResetTime))}`, width),
				);

				// Usage details by model
				if (limit.usageDetails && limit.usageDetails.length > 0) {
					lines.push("");
					lines.push(truncateToWidth(`    ${th.fg("dim", "Breakdown by model:")}`, width));
					for (const detail of limit.usageDetails) {
						const modelPct = total > 0 ? Math.round((detail.usage / total) * 100) : 0;
						const miniBarW = Math.min(15, barWidth - 10);
						const miniBar = progressBar(modelPct, miniBarW, th);
						lines.push(
							truncateToWidth(
								`      ${th.fg("muted", detail.modelCode.padEnd(14))} ${miniBar} ${th.fg("dim", `${detail.usage} (${modelPct}%)`)}`,
								width,
							),
						);
					}
				}
			} else if (limit.type === "TOKENS_LIMIT") {
				// Tokens limit (usually less detail)
				const pct = limit.percentage;
				const bar = progressBar(pct, barWidth, th);
				lines.push(truncateToWidth(`    ${bar}  ${th.fg("accent", `${pct}%`)}`, width));
				lines.push(
					truncateToWidth(`    ${th.fg("text", "Resets in:")} ${th.fg("accent", formatResetTime(limit.nextResetTime))}`, width),
				);
			}

			lines.push("");
		}

		// Footer
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape or q to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("zai-quota", {
		description: "Show ZAI API quota usage with a nice TUI dashboard",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				// Fallback for non-interactive: just fetch and notify
				try {
					const apiKey = process.env.ZAI_API_KEY;
					if (!apiKey) {
						ctx.ui.notify("ZAI_API_KEY env var not set", "error");
						return;
					}
					const resp = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
						headers: {
							Authorization: apiKey,
							"Content-Type": "application/json",
							"Accept-Language": "en-US,en",
						},
					});
					const data = (await resp.json()) as QuotaResponse;
					ctx.ui.notify(`ZAI quota: ${JSON.stringify(data)}`, "info");
				} catch (e: any) {
					ctx.ui.notify(`Failed to fetch quota: ${e.message}`, "error");
				}
				return;
			}

			// Interactive mode: show loading overlay, then quota dashboard
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let closed = false;

				// Fetch data
				const apiKey = process.env.ZAI_API_KEY;
				if (!apiKey) {
					// Show error inline
					const lines = [
						"",
						theme.fg("error", "  ✗ ZAI_API_KEY environment variable is not set"),
						"",
						theme.fg("dim", "  Set it in your shell profile:"),
						theme.fg("muted", "    export ZAI_API_KEY=your-api-key"),
						"",
						theme.fg("dim", "  Press Escape to close"),
						"",
					];
					return {
						render: (w: number) => lines.map((l) => truncateToWidth(l, w)),
						invalidate: () => {},
						handleInput: (data: string) => {
							if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
								done();
							}
						},
					};
				}

				// Show loading state
				let currentLines: string[] = [
					"",
					theme.fg("muted", "  ⏳ Fetching quota..."),
					"",
				];
				let component: QuotaComponent | null = null;

				fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
					headers: {
						Authorization: apiKey,
						"Content-Type": "application/json",
						"Accept-Language": "en-US,en",
					},
				})
					.then((resp) => resp.json())
					.then((data: QuotaResponse) => {
						if (closed) return;
						component = new QuotaComponent(data, theme, () => {
							closed = true;
							done();
						});
						tui.requestRender();
					})
					.catch((err) => {
						if (closed) return;
						currentLines = [
							"",
							theme.fg("error", `  ✗ Failed to fetch: ${err.message}`),
							"",
							theme.fg("dim", "  Press Escape to close"),
							"",
						];
						component = null;
						tui.requestRender();
					});

				return {
					render: (w: number) => {
						if (component) return component.render(w);
						return currentLines.map((l) => truncateToWidth(l, w));
					},
					invalidate: () => {
						component?.invalidate();
					},
					handleInput: (data: string) => {
						if (component) {
							component.handleInput(data);
						} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							closed = true;
							done();
						}
					},
				};
			}, { overlay: true });
		},
	});
}
