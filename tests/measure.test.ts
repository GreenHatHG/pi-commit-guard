import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, type GuardConfig } from "../src/config";
import {
	applyIgnorePaths,
	cleanRenamePath,
	formatStats,
	formatWidgetLine,
	guardLevel,
	matchesIgnore,
	measureDiff,
	sumStats,
} from "../src/measure";
import type { ExecLike, FileDelta } from "../src/measure";

function cfg(overrides: Partial<GuardConfig> = {}): GuardConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

describe("matchesIgnore", () => {
	it("matches exact file names", () => {
		expect(matchesIgnore("pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(true);
		expect(matchesIgnore("src/pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(true);
	});

	it("matches glob suffixes like *.lock", () => {
		expect(matchesIgnore("a/b/c.lock", "*.lock")).toBe(true);
		expect(matchesIgnore("a/b/c.yaml", "*.lock")).toBe(false);
	});

	it("matches directory prefixes and segments", () => {
		expect(matchesIgnore("dist/main.js", "dist")).toBe(true);
		expect(matchesIgnore("sub/dist", "dist")).toBe(true);
		expect(matchesIgnore("sub/dist/x.js", "dist")).toBe(true);
		expect(matchesIgnore("distx/main.js", "dist")).toBe(false);
	});
});

describe("applyIgnorePaths", () => {
	it("filters out lockfiles and minified bundles", () => {
		const files: FileDelta[] = [
			{ path: "pnpm-lock.yaml", added: 500, deleted: 20, untracked: false },
			{ path: "dist/app.min.js", added: 900, deleted: 0, untracked: true },
			{ path: "src/main.ts", added: 30, deleted: 5, untracked: false },
		];
		const kept = applyIgnorePaths(files, cfg().ignorePaths);
		expect(kept.map((f) => f.path)).toEqual(["src/main.ts"]);
	});
});

describe("sumStats", () => {
	it("sums files, added and deleted across deltas", () => {
		const files: FileDelta[] = [
			{ path: "a.ts", added: 10, deleted: 2, untracked: false },
			{ path: "b.ts", added: 5, deleted: 8, untracked: false },
		];
		expect(sumStats(files)).toEqual({ files: 2, added: 15, deleted: 10 });
	});
});

describe("guardLevel", () => {
	it("returns clean when nothing changed", () => {
		expect(guardLevel({ files: 0, added: 0, deleted: 0 }, cfg())).toBe("clean");
	});

	it("returns ok under the warn zone", () => {
		expect(guardLevel({ files: 2, added: 30, deleted: 10 }, cfg())).toBe("ok");
	});

	it("returns warn at 60% of either limit", () => {
		expect(guardLevel({ files: 6, added: 10, deleted: 10 }, cfg())).toBe("warn");
		expect(guardLevel({ files: 2, added: 240, deleted: 0 }, cfg())).toBe("warn");
	});

	it("returns over when the file limit is exceeded", () => {
		expect(guardLevel({ files: 11, added: 20, deleted: 5 }, cfg())).toBe("over");
	});

	it("returns over when the line limit is exceeded", () => {
		expect(guardLevel({ files: 3, added: 350, deleted: 60 }, cfg())).toBe("over");
	});
});

describe("formatStats / formatWidgetLine", () => {
	it("formats stats with limits", () => {
		expect(formatStats({ files: 14, added: 620, deleted: 130 }, cfg())).toBe(
			"14 files, +620/−130 (limit 10 files / 400 lines)",
		);
	});

	it("uses singular for one file", () => {
		expect(formatStats({ files: 1, added: 5, deleted: 0 }, cfg())).toBe("1 file, +5/−0 (limit 10 files / 400 lines)");
	});

	it("shows the dominant resource in the widget line", () => {
		const line = formatWidgetLine({ files: 14, added: 620, deleted: 130 }, cfg());
		expect(line).toContain("+620/−130");
		expect(line).toContain("lines");
	});
});

describe("cleanRenamePath", () => {
	it("keeps plain paths as-is", () => {
		expect(cleanRenamePath("src/main.ts")).toBe("src/main.ts");
	});

	it("takes the post-arrow side of a rename", () => {
		expect(cleanRenamePath("src/{old.ts => new.ts}")).toBe("new.ts");
		expect(cleanRenamePath("a/{b => c}/d.ts")).toBe("c/d.ts");
	});
});

describe("measureDiff", () => {
	function fakeExec(responses: Record<string, { stdout?: string; code?: number }>): ExecLike & { calls: string[] } {
		const calls: string[] = [];
		return {
			calls,
			async exec(command: string, args: string[]) {
				calls.push(`${command} ${args.join(" ")}`);
				const key = `${command} ${args.join(" ")}`;
				const r = responses[key] ?? { stdout: "", code: 0 };
				return { stdout: r.stdout ?? "", stderr: "", code: r.code ?? 0, killed: false };
			},
		};
	}

	it("parses numstat plus untracked files, applying ignorePaths", async () => {
		const ex = fakeExec({
			"git diff HEAD --numstat": { stdout: "10\t2\tsrc/main.ts\n-\t-\tlogo.png\n500\t20\tpnpm-lock.yaml\n" },
			"git ls-files --others --exclude-standard": { stdout: "new-file.ts\nassets/app.min.js\n" },
			"wc -l new-file.ts": { stdout: "42 new-file.ts" },
			"wc -l assets/app.min.js": { stdout: "900 assets/app.min.js" },
		});
		const stats = await measureDiff("/repo", cfg(), ex);
		expect(stats.unavailable).toBe(false);
		expect(sumStats(stats.files)).toEqual({ files: 3, added: 52, deleted: 2 });
		const paths = stats.files.map((f) => f.path).sort();
		expect(paths).toEqual(["logo.png", "new-file.ts", "src/main.ts"]);
	});

	it("marks unavailable when git fails (not a repo)", async () => {
		const ex = fakeExec({ "git diff HEAD --numstat": { code: 128, stdout: "" } });
		const stats = await measureDiff("/repo", cfg(), ex);
		expect(stats.unavailable).toBe(true);
	});
});

describe("loadConfig", () => {
	it("returns defaults when the config file is missing", async () => {
		const merged = await loadConfig("/nonexistent-project");
		expect(merged).toEqual(DEFAULT_CONFIG);
	});
});
