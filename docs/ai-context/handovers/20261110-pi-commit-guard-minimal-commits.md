---
created_at: 2026-11-10
updated_at: 2026-11-10
topic: pi-commit-guard-minimal-commits
status: resolved
affected_modules: [pi-commit-guard]
tags: [pi-extension, git, commit, diff-measure, widget, coach, no-blocking]
---

# pi-commit-guard: force minimal commits by watching working diff vs HEAD

## 1. Context & Problem
User wants small-step commits in pi coding agent sessions: stop the agent from accumulating a huge working diff before any commit. Requirement evolved through grilling into: coach the model up front, measure the diff continuously, alert the user after the run — never block or interrupt the agent.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)
- **Attempt**: Block edits when tree is dirty ("intercept before modification").
  - **Failure Reason**: Wrong invariant. Within one task the agent must edit freely; blocking on dirtiness makes work impossible and confuses "commit small" with "commit clean".
- **Attempt**: Block edits when accumulated diff exceeds maxFiles/maxLines (hard gate mid-run).
  - **Failure Reason**: User rejected: mid-run blocking kills the current turn; parallel tool batches preflight against the pre-batch diff so one batch can overshoot anyway; an un-splittable lockfile can deadlock the gate. Settled design: let the LLM finish its work this run, THEN tell the user.
- **Attempt**: "Commit soon" nudge in warn zone.
  - **Failure Reason**: User rejected: the model should finish the current task, not rush a commit. Reminder text says "finish the current task; user handles commit after this run".
- **Attempt**: Skip/escape-hatch entries (`/wip`, one-shot override dialogs).
  - **Failure Reason**: User rejected all skip entry points; exceptions are handled by the user manually, outside the plugin.
- **Attempt**: size-gate at commit time (commit tool rejects oversized staged diff).
  - **Failure Reason**: User decided commits are user-manual; no agent commit tool at all. All "interception" happens BEFORE any commit: over-limit detection + alert lands at agent_settled.
- **Bug**: `/** ... **/name) ... */` JSDoc comment: the `**/` inside the text closed the comment early → esbuild parse error at the next `*/`.
- **Bug**: `matchesIgnore` with suffix glob `*.lock`: naive `path.split("*")` + `startsWith("")` matched EVERY file (empty head is always true). Fix: anchor non-empty head/tail at string boundaries.
- **Bug**: plain-name ignore matched raw prefixes ("dist" matched "distx/"). Fix: segment matching (`path === p || startsWith(p + "/") || endsWith("/" + p) || includes("/" + p + "/")`).
- **Bug**: `measureDiff` typed param as `ExecLike` object but called it as a bare function (`exec(...)` instead of `pi.exec(...)`). pi.exec signature: `exec(command, args, {cwd, timeout, signal})` → `ExecResult {stdout, stderr, code, killed}`.
- **Gotcha**: fake-exec test helper must key responses by `command + " " + args.join(" ")` — `wc -l f.ts` vs `git ls-files` share args if keyed by args alone.
- **Gotcha**: `grep -rn` inside a `/** */` doc comment: never write `**/` in comment text.

## 3. Decision & Verified Solution
- **Chosen Approach**: Four hooks, zero blocking. (1) Coach: `before_agent_start` injects a `[COMMIT SIZE GUARD]` discipline block once per session (persisted via `pi.appendEntry(customType)` marker, survives /resume). (2) Measure: `git diff HEAD --numstat` + `git ls-files --others --exclude-standard` (+ `wc -l` per untracked file), ignorePaths filtering, binary = 1 file 0 lines, rename syntax normalized to post-arrow path. (3) Widget `ctx.ui.setWidget("commit-guard", ...)` after each `turn_end`: `·`/`⚠`/`✗` + dominant-resource fraction. (4) Soft reminder appended to `tool_result.content` of edit/write/bash/powershell once per level transition (clean→ok→warn@60%→over). Report: `ctx.ui.notify(..., "warning")` at `agent_settled` and `session_shutdown` when over.
- **Key Changes**: Repo `~/projects/pi-commit-guard`: src/{index,measure,config,coach}.ts, tests (22 vitest), wired in `~/.pi/agent/settings.json` packages as `"../../projects/pi-commit-guard"`. Config per project: `.pi/commit-guard.json` `{enabled, maxFiles:10, maxLines:400, ignorePaths:[lockfiles,*.min.js], coach:true}`; malformed JSON or wrong-typed fields fall back per-field to defaults. Verified by adversarial sub-agent: end-to-end jiti simulation against real git in /tmp, 20 probes, all pass; contract audit against pi type declarations; grep audit confirmed no block/abort/dialog/commit-interception.
- **Minimal Code / Command Reference**:
```ts
// level transition reminder, once per transition
const level = guardLevel(sumStats(stats.files), config); // clean|ok|warn|over
if (newLevel === "none" || newLevel === previous) return undefined;
return { content: [...event.content, { type: "text", text: `\n\n${reminder}` }] };
```

## 4. Hard Constraints for Future AI
- NEVER block, terminate, or dialog mid-run in this extension; the agent always finishes its work, the user handles commits manually.
- NEVER intercept `git commit` or add an agent commit tool; no skip/escape-hatch commands.
- ALWAYS key fake exec responses by command+args; ALWAYS avoid `**/` inside JSDoc text.
- Verify with behavior tests on pure modules (no pi imports in measure/config/coach) + jiti end-to-end simulation, not by booting the TUI.
