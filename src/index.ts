/**
 * pi-commit-guard
 *
 * Keeps commits minimal by watching the working diff vs HEAD. Never blocks or interrupts the
 * agent mid-run (per design discussion with the user):
 *
 * 1. Coach: before the first agent run of a session, inject a discipline block ("split work into
 *    minimal batches; the user reviews and commits after each run") — so the model knows the
 *    limits before it starts modifying anything. Persisted via a custom entry, so a resumed
 *    session does not inject it twice.
 * 2. Measure: after each tool result / turn, measure `git diff HEAD --numstat` + untracked files
 *    (ignorePaths filters out lockfiles etc.) and show the numbers in a widget above the editor.
 * 3. Soft reminder: when the diff enters the warn zone (60% of limits) or crosses the limit,
 *    append one line to tool results: "finish the current task; the user handles the commit".
 *    Fires once per level transition, so it does not spam every tool call.
 * 4. Report: at run end (agent_settled) and on session shutdown, if the diff is over the limit,
 *    notify the user with the stats — the alert always lands before any commit happens.
 *
 * No interception of `git commit`, no commit tool, no dialogs, no skip commands: committing is
 * the user's manual job; the guard only informs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCoachText } from "./coach";
import { loadConfig, type GuardConfig } from "./config";
import {
	buildMidrunReminder,
	formatStats,
	formatWidgetLine,
	guardLevel,
	measureDiff,
	sumStats,
	type DiffStats,
} from "./measure";

/** Widget key for ctx.ui.setWidget. */
const WIDGET_KEY = "commit-guard";
/** customType for the persisted coach marker entry. */
const COACH_CUSTOM_TYPE = "commit-guard-coach";
/** Tools whose results can carry the soft reminder. */
const GUARDED_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

/** True when the session branch already carries a coach entry (survives /resume). */
function hasCoachEntry(branch: Array<{ type?: string; customType?: string }>): boolean {
	return branch.some((entry) => entry?.type === "custom" && entry.customType === COACH_CUSTOM_TYPE);
}

export default function (pi: ExtensionAPI) {
	/** Resolved config; undefined until session_start, or when the project disables the guard. */
	let config: GuardConfig | undefined;
	/** True while cwd is a usable git work tree. */
	let gitAvailable = false;
	/** Last reminder level appended to tool results, so each level transition fires once. */
	let reminderLevel: "none" | "warn" | "over" = "none";

	/** Run one git command in the project cwd; null when git fails or is missing. */
	async function git(args: string[], ctx: ExtensionContext) {
		try {
			const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 5000 });
			if (result.code !== 0) return null;
			return result;
		} catch {
			return null;
		}
	}

	/** Measure the working diff and update the widget. Returns stats, or undefined when N/A. */
	async function refreshWidget(ctx: ExtensionContext): Promise<DiffStats | undefined> {
		if (!config?.enabled || !gitAvailable) return undefined;
		try {
			const stats = await measureDiff(ctx.cwd, config, pi);
			if (stats.unavailable) {
				gitAvailable = false;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return undefined;
			}
			const summed = sumStats(stats.files);
			const level = guardLevel(summed, config);
			if (level === "clean") {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} else {
				const icon = level === "over" ? "✗" : level === "warn" ? "⚠" : "·";
				ctx.ui.setWidget(WIDGET_KEY, [`${icon} ${formatWidgetLine(summed, config)}`]);
			}
			return stats;
		} catch {
			return undefined;
		}
	}

	/** Measure + level; shared by tool_result and the end-of-run report. */
	async function measureNow(
		ctx: ExtensionContext,
	): Promise<{ summed: { files: number; added: number; deleted: number }; level: string } | undefined> {
		if (!config?.enabled || !gitAvailable) return undefined;
		try {
			const stats = await measureDiff(ctx.cwd, config, pi);
			if (stats.unavailable) return undefined;
			const summed = sumStats(stats.files);
			return { summed, level: guardLevel(summed, config) };
		} catch {
			return undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx.cwd);
		reminderLevel = "none";
		gitAvailable = (await git(["rev-parse", "--is-inside-work-tree"], ctx)) !== null;
		await refreshWidget(ctx);
	});

	// Coach: tell the model the limits up front, before it modifies anything in this session.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!config?.enabled || !config.coach) return undefined;
		if (hasCoachEntry(ctx.sessionManager.getBranch())) return undefined;
		try {
			pi.appendEntry(COACH_CUSTOM_TYPE, { delivered: true });
		} catch {
			// Marker persistence is best-effort; worst case the coach text appears again on resume.
		}
		return {
			message: {
				customType: COACH_CUSTOM_TYPE,
				content: buildCoachText(config),
				display: false,
			},
		};
	});

	// Soft reminder: measure after file-touching tool results; append one line on level transitions.
	pi.on("tool_result", async (event, ctx) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
		const measured = await measureNow(ctx);
		if (!measured || !config) return undefined;
		const { summed, level } = measured;
		const newLevel = level === "over" ? "over" : level === "warn" ? "warn" : "none";
		const previous = reminderLevel;
		reminderLevel = newLevel;
		if (newLevel === "none" || newLevel === previous) return undefined;
		const reminder = buildMidrunReminder(summed, config);
		if (!reminder) return undefined;
		return {
			content: [...event.content, { type: "text", text: `\n\n${reminder}` }],
		};
	});

	// Widget refresh after each turn.
	pi.on("turn_end", async (_event, ctx) => {
		await refreshWidget(ctx);
	});

	// Report at run end: the LLM has finished its work; now tell the user to handle the commit.
	pi.on("agent_settled", async (_event, ctx) => {
		await refreshWidget(ctx);
		const measured = await measureNow(ctx);
		if (measured?.level !== "over" || !config) return;
		ctx.ui.notify(
			`Commit guard: over limit — ${formatStats(measured.summed, config)}. Review the changes, then split or commit manually.`,
			"warning",
		);
	});

	// Last chance visibility: still over the limit when the session ends.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!config?.enabled || !gitAvailable) return;
		try {
			const stats = await measureDiff(ctx.cwd, config, pi);
			if (stats.unavailable) return;
			const summed = sumStats(stats.files);
			if (guardLevel(summed, config) !== "over") return;
			ctx.ui.notify(
				`Commit guard: session ended over limit — ${formatStats(summed, config)}. Handle the commit manually.`,
				"warning",
			);
		} catch {
			// Shutdown must never fail because of the guard.
		}
	});
}
