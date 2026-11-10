import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCoachText } from "../src/coach";
import { DEFAULT_CONFIG, loadConfig } from "../src/config";

describe("loadConfig", () => {
	it("returns defaults when the config file is missing", async () => {
		expect(await loadConfig("/nonexistent-project-for-sure")).toEqual(DEFAULT_CONFIG);
	});

	it("overrides numeric limits and flags from .pi/commit-guard.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cg-test-"));
		try {
			await mkdir(join(dir, ".pi"), { recursive: true });
			await writeFile(
				join(dir, ".pi", "commit-guard.json"),
				JSON.stringify({ maxFiles: 3, maxLines: 100, enabled: false, coach: false }),
				"utf8",
			);
			const merged = await loadConfig(dir);
			expect(merged.maxFiles).toBe(3);
			expect(merged.maxLines).toBe(100);
			expect(merged.enabled).toBe(false);
			expect(merged.coach).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back per-field on wrong types", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cg-test-"));
		try {
			await mkdir(join(dir, ".pi"), { recursive: true });
			await writeFile(
				join(dir, ".pi", "commit-guard.json"),
				JSON.stringify({ maxFiles: "ten", maxLines: -5, ignorePaths: [1, "*.lock", "ok"] }),
				"utf8",
			);
			const merged = await loadConfig(dir);
			expect(merged.maxFiles).toBe(DEFAULT_CONFIG.maxFiles);
			expect(merged.maxLines).toBe(DEFAULT_CONFIG.maxLines);
			expect(merged.ignorePaths).toEqual(["*.lock", "ok"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("buildCoachText", () => {
	it("mentions both limits and the user-commit workflow", () => {
		const text = buildCoachText(DEFAULT_CONFIG);
		expect(text).toContain("[COMMIT SIZE GUARD]");
		expect(text).toContain("10");
		expect(text).toContain("400");
		expect(text).toContain("user");
	});
});
