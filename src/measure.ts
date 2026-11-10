/**
 * Pure helpers for the commit guard: measuring the working diff and formatting widget/alert text.
 * No pi imports here, so unit tests run without the pi runtime.
 */

import type { GuardConfig } from "./config";

/** One file's contribution to the working diff. */
export interface FileDelta {
	/** Path relative to repo root (untracked files included; matches `git status --porcelain` output). */
	path: string;
	/** Added lines (0 for untracked binary files). */
	added: number;
	/** Deleted lines (0 for untracked binary files). */
	deleted: number;
	/** True for untracked files (line counts taken from the file itself). */
	untracked: boolean;
}

/** Measured state of the working tree vs HEAD. */
export interface DiffStats {
	/** Files that count toward the limit (after ignorePaths filtering). */
	files: FileDelta[];
	/** Sum of added lines. */
	added: number;
	/** Sum of deleted lines. */
	deleted: number;
	/** True when `git diff HEAD --numstat` failed (not a repo, git missing). */
	unavailable: boolean;
}

/** Guard state for widget/alert rendering. */
export type GuardLevel = "clean" | "ok" | "warn" | "over";

/**
 * Measure the working diff vs HEAD: tracked changes (staged + unstaged) plus untracked files.
 * Ignores files matching config.ignorePaths (gitignore-style patterns, e.g. lockfiles).
 */
export async function measureDiff(cwd: string, config: GuardConfig, pi: ExecLike): Promise<DiffStats> {
	const numstat = await pi.exec("git", ["diff", "HEAD", "--numstat"], { cwd });
	if (numstat.code !== 0) {
		return { files: [], added: 0, deleted: 0, unavailable: true };
	}

	const files: FileDelta[] = [];
	for (const line of numstat.stdout.split("\n")) {
		if (!line.trim()) continue;
		// Format: <added>\t<deleted>\t<path>; renames show as {old => new}
		const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
		if (!m) continue;
		const [, addedRaw, deletedRaw, rawPath] = m;
		// "-\t-\t" means binary; count binary tracked changes as lines: 0, files: 1
		const added = addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10);
		const deleted = deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw, 10);
		const path = cleanRenamePath(rawPath);
		files.push({ path, added, deleted, untracked: false });
	}

	const lsFiles = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
	if (lsFiles.code === 0) {
		for (const path of lsFiles.stdout.split("\n")) {
			if (!path.trim()) continue;
			const content = await pi.exec("wc", ["-l", path], { cwd });
			let lines = 0;
			if (content.code === 0) {
				const n = Number.parseInt(content.stdout.trim().split(/\s+/)[0], 10);
				if (Number.isFinite(n)) lines = n;
			}
			files.push({ path, added: lines, deleted: 0, untracked: true });
		}
	}

	return { files: applyIgnorePaths(files, config.ignorePaths), added: 0, deleted: 0, unavailable: false };
}

/** gitignore-style match (only what we need: exact name, glob suffixes like *.lock, dir segment match). */
export function matchesIgnore(path: string, pattern: string): boolean {
	const p = pattern.trim().replace(/^\.\//, "");
	if (!p) return false;
	if (p.includes("*")) {
		// Suffix globs like "*.lock": anchor the non-empty head/tail at string boundaries.
		const idx = p.indexOf("*");
		const head = p.slice(0, idx);
		const tail = p.slice(idx + 1);
		if (head && !path.startsWith(head)) return false;
		if (tail && !path.endsWith(tail)) return false;
		return true;
	}
	// Plain name: exact path or a full path segment ("dist" matches dist/x.js but not distx/y.js).
	return path === p || path.startsWith(`${p}/`) || path.endsWith(`/${p}`) || path.includes(`/${p}/`);
}

/** Filter out ignored files. */
export function applyIgnorePaths(files: FileDelta[], ignorePaths: string[]): FileDelta[] {
	return files.filter((f) => !ignorePaths.some((pattern) => matchesIgnore(f.path, pattern)));
}

/** Sums per-file deltas into aggregate stats. */
export function sumStats(files: FileDelta[]): { files: number; added: number; deleted: number } {
	return {
		files: files.length,
		added: files.reduce((s, f) => s + f.added, 0),
		deleted: files.reduce((s, f) => s + f.deleted, 0),
	};
}

/** Level for the current measurement against config thresholds. */
export function guardLevel(stats: { files: number; added: number; deleted: number }, config: GuardConfig): GuardLevel {
	if (stats.files === 0 && stats.added === 0 && stats.deleted === 0) return "clean";
	const total = stats.added + stats.deleted;
	const warnFiles = Math.floor(config.maxFiles * 0.6);
	const warnLines = Math.floor(((config.maxLines ?? 400) as number) * 0.6);
	if (stats.files > config.maxFiles || total > (config.maxLines ?? 400)) return "over";
	if (stats.files >= warnFiles || total >= warnLines) return "warn";
	return "ok";
}

/**
 * Human summary line for notify/alert: "5 files, +120/−30 (limit 10 files / 400 lines)".
 */
export function formatStats(stats: { files: number; added: number; deleted: number }, config: GuardConfig): string {
	const maxLines = config.maxLines ?? 400;
	return `${stats.files} file${stats.files === 1 ? "" : "s"}, +${stats.added}/−${stats.deleted} (limit ${config.maxFiles} files / ${maxLines} lines)`;
}

/**
 * One-line status for the widget. Shows the dominant resource (files or lines) as a fraction.
 */
export function formatWidgetLine(
	stats: { files: number; added: number; deleted: number },
	config: GuardConfig,
): string {
	const total = stats.added + stats.deleted;
	const maxLines = config.maxLines ?? 400;
	const fileRatio = stats.files / config.maxFiles;
	const lineRatio = maxLines > 0 ? total / maxLines : 0;
	const byLines = lineRatio >= fileRatio;
	const label = byLines ? `${total}/${maxLines} lines` : `${stats.files}/${config.maxFiles} files`;
	return `commit-guard: ${label} +${stats.added}/−${stats.deleted}`;
}

/**
 * Mid-run reminder appended to tool results when the accumulated diff enters the warn/over zone.
 * Wording follows the settled design: tell the model to finish the current turn, nothing more;
 * the user handles commit/split manually after the run ends.
 */
export function buildMidrunReminder(
	stats: { files: number; added: number; deleted: number },
	config: GuardConfig,
): string {
	const level = guardLevel(stats, config);
	if (level === "clean" || level === "ok") return "";
	const head = level === "over" ? "[commit-guard] Over limit" : "[commit-guard] Approaching limit";
	return `${head}: ${formatStats(stats, config)}. Finish the current task; do not start unrelated changes. The user will review and handle the commit after this run.`;
}

/** Git rename syntax in numstat: "a/{b => c}/d" or "{a => b}" → take the side after the arrow. */
export function cleanRenamePath(rawPath: string): string {
	if (!rawPath.includes("=>")) return rawPath;
	const after = rawPath.split("=>").pop() ?? rawPath;
	return after.replace(/[{}]/g, "").trim();
}

/** Minimal exec contract used by measureDiff (matches pi.exec's shape). */
export interface ExecLike {
	exec(
		command: string,
		args: string[],
		options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
	): Promise<{
		stdout: string;
		stderr: string;
		code: number;
		killed: boolean;
	}>;
}
