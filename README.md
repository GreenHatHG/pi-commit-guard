# pi-commit-guard

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that keeps commits minimal by watching the working diff vs `HEAD`.

It never blocks or interrupts the agent. It coaches before, watches during, and reports after:

1. **Coach** — before the first agent run of a session, injects a short discipline block into the model's context: limits exist, split work into minimal well-separated batches, the user reviews and commits after each run. Delivered once per session (persisted via a custom entry, so `/resume` doesn't re-inject it).
2. **Watch** — measures `git diff HEAD --numstat` plus untracked files after file-touching tool results and each turn. Shows the numbers in a widget above the editor (`· ok` / `⚠ approaching` / `✗ over`).
3. **Remind** — when the diff enters the warn zone (60% of a limit) or crosses the limit, appends one line to the tool result: finish the current task; the user handles the commit. Fires once per level transition, not on every tool call.
4. **Report** — at run end (`agent_settled`) and on session shutdown, if the diff is over the limit, notifies the user with the stats. The alert always lands before any commit happens.

Committing stays a **manual** job: no `git commit` interception, no commit tool, no dialogs, no skip commands.

## Why no hard gate?

By design (settled in a review with the author): mid-run blocking creates deadlocks and friction (parallel edit batches preflight against the pre-batch diff, an un-splittable lockfile can trap the gate). The counter-forces against accumulation are the upfront coaching, the always-visible widget, and the end-of-run alert.

## Install (global)

```bash
pi install /path/to/pi-commit-guard
```

Or add to `~/.pi/agent/settings.json`:

```json
{
	"packages": ["/path/to/pi-commit-guard"]
}
```

## Configure (per project)

Create `.pi/commit-guard.json` in the project root. Missing file = defaults.

```json
{
	"enabled": true,
	"maxFiles": 10,
	"maxLines": 400,
	"ignorePaths": ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "*.lock", "*.min.js"],
	"coach": true
}
```

| Field        | Default                                       | Meaning                                                        |
| ------------ | --------------------------------------------- | -------------------------------------------------------------- |
| `enabled`    | `true`                                        | Master switch                                                  |
| `maxFiles`   | `10`                                          | Max changed files vs `HEAD` before the guard flags "over"      |
| `maxLines`   | `400`                                         | Max added+deleted lines vs `HEAD` before the guard flags "over" |
| `ignorePaths`| lockfiles + `*.min.js`                        | gitignore-style patterns excluded from counting                 |
| `coach`      | `true`                                        | Inject the split-work discipline before the first run           |

Counting: staged + unstaged changes vs `HEAD`, plus untracked files (line counts via `wc -l`; binaries count as 1 file, 0 lines). Git rename syntax in `--numstat` output is normalized to the post-rename path. Non-git directories: the extension silently does nothing.

## Known limits

- Parallel tool batches preflight before execution; a single batch can overshoot the limit before the reminder fires (the next measurement catches it).
- Bash mutations (e.g. `sed -i`) are measured like any other change — attribution of *who* changed what is out of scope.
- The guard informs, never enforces; a stubborn model can still overshoot. The system-prompt coach and the end-of-run alert are the counter-pressure.

## Development

```bash
pnpm install
pnpm test        # vitest, behavior tests for counting/thresholds/config
pnpm typecheck   # tsc --noEmit
pnpm check:biome # lint + format
```

## License

MIT
