/** Per-project config loading for the commit guard. No pi imports, so tests run without the runtime. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Per-project config file: <cwd>/.pi/commit-guard.json. */
export const CONFIG_FILENAME = "commit-guard.json";

export interface GuardConfig {
	/** Master switch. */
	enabled: boolean;
	/** Max changed files vs HEAD allowed before the guard flags "over". */
	maxFiles: number;
	/** Max added+deleted lines vs HEAD allowed before the guard flags "over". */
	maxLines: number;
	/** gitignore-style patterns ignored when counting (lockfiles, bundles, ...). */
	ignorePaths: string[];
	/** Inject the "split your work" discipline into the system prompt each run. */
	coach: boolean;
}

export const DEFAULT_CONFIG: GuardConfig = {
	enabled: true,
	maxFiles: 10,
	maxLines: 400,
	ignorePaths: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "*.lock", "*.min.js"],
	coach: true,
};

/**
 * Read .pi/commit-guard.json in the project and merge it over the defaults.
 * Unknown keys are ignored; invalid types fall back per-field; a missing or broken file yields defaults.
 */
export async function loadConfig(cwd: string): Promise<GuardConfig> {
	const config = { ...DEFAULT_CONFIG };
	try {
		const raw = await readFile(join(cwd, ".pi", CONFIG_FILENAME), "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
		if (typeof parsed.maxFiles === "number" && parsed.maxFiles > 0 && Number.isFinite(parsed.maxFiles)) {
			config.maxFiles = Math.floor(parsed.maxFiles);
		}
		if (typeof parsed.maxLines === "number" && parsed.maxLines > 0 && Number.isFinite(parsed.maxLines)) {
			config.maxLines = Math.floor(parsed.maxLines);
		}
		if (Array.isArray(parsed.ignorePaths)) {
			const paths = parsed.ignorePaths.filter((p): p is string => typeof p === "string");
			if (paths.length > 0) config.ignorePaths = paths;
		}
		if (typeof parsed.coach === "boolean") config.coach = parsed.coach;
	} catch {
		// Missing or malformed config: defaults apply.
	}
	return config;
}
