/** Coach text injected before each agent run. Pure string building, no pi imports. */

import type { GuardConfig } from "./config";

/**
 * The "split your work" discipline, appended to the system prompt before each run.
 * Tells the model the limits exist up front, so it plans minimal, reviewable batches
 * instead of piling up changes the user has to split by hand.
 */
export function buildCoachText(config: GuardConfig): string {
	return [
		"[COMMIT SIZE GUARD]",
		`This project enforces minimal commits: at most ${config.maxFiles} changed files and ${config.maxLines} added+deleted lines vs HEAD per batch of work.`,
		"Plan your changes to stay well inside these limits. Split work into minimal, well-separated modifications, each covering one coherent concern.",
		"Do NOT pile up unrelated changes. When you finish a logical unit, stop and let the user review and commit; then continue with the next unit on a clean tree.",
		"The guard measures the working diff after each turn and reports over-limit results to the user at the end of the run.",
	].join("\n");
}
