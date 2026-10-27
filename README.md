# pi-release-progress

Pi widget with a live progress bar, current/next step, ETA and elapsed time for any running release.
It learns how long each step takes, so the ETA gets better with every run.

```
my-app 1.0.2  ⠦ releasing  ~0m41s left · 1m12s elapsed
████████████████████████████████▌░░░░░░░░░░░░░░░░░░░░░░░░░░░  54%
2/3 Publish  3/5 packages  → Announce
```

## Sources

| Source | How it is found | Plan |
|---|---|---|
| **Any script** (generic format below) | `*release*status*.json` in the watched dirs, automatically | declared `steps`, or learned from earlier runs (first run shows an activity bar, no %) |
| **Genexus18MCP `release.ps1 -StatusFile`** | same, automatically | parsed from the script's `Step "..."` calls |
| **GitHub Actions run** | `/release gh [run-url \| owner/repo#id \| id \| owner/repo]` (no id: newest in-progress run) | jobs are steps, the running job's steps are sub-progress |

Commands: `/release` pins the current/latest run, `/release <status-file>` follows a file, `/release off` hides it until the next run and turns CI follow after a push off for the rest of the session, `/release auto [on|off]` shows or sets that CI follow.

## CI follow after a push

When a `git push` run through Pi's `bash` (or `powershell`) tool succeeds, the widget follows the GitHub Actions run(s) of the pushed commit, so there is no need for a `gh run watch` background shell.

- **Detection**: a successful `tool_result` whose `command` contains `git push` (not `--dry-run`, `--delete`). The repository directory is the last `cd <dir> &&` before the push, or `git -C <dir>`, else the session cwd. The repo is the `To <url>` line of the push output (github.com only; without it, `origin`); the commit is the new end of `old..new  branch -> branch` in that output, else `HEAD`. Pushes typed by the user in the `!`/`!!` shell are not seen (only agent tool calls are).
- **Lookup**: `gh run list -R owner/repo --commit <sha>` after 3 s, then every 5 s for about a minute, because the run appears a moment after the push. No run (a repo without CI) means nothing is shown. If `gh` keeps failing, one warning is notified.
- **Following**: the first unfinished run is shown with the usual job bar; with several workflows they are followed one after another and a notice gives the count. A newer push replaces the previous auto-followed run.
- **Never steals** the widget from a pinned run (`/release ...`) or a release status file that is still running.
- **Off**: `/release auto off`, `/release off` (session-wide), or `PI_RELEASE_AUTO=off` for the default. Nothing polls while idle; the lookup only runs for a few seconds after a push and `gh run view` only while a run is shown.

## Integrate a release script

Call the CLI once per step; nothing else changes in the script.

```bash
rs="node C:/projetos/pi-release-progress/bin/release-status.mjs"
$rs start my-app 1.2.3 --steps "Build,Test,Publish"   # --steps is optional
$rs step Build
$rs step Publish --done 0 --total 5 --unit packages
$rs progress 3 5 packages                              # countable progress inside a step
$rs succeed --url https://github.com/me/my-app/releases/tag/v1.2.3
# on error:  $rs fail "npm publish returned 403"
```

```powershell
$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true  # so a failing npm/build throws
$rs = 'C:/projetos/pi-release-progress/bin/release-status.mjs'
node $rs start my-app 1.2.3
try { node $rs step Build; ./build.ps1; node $rs step Publish; npm publish; node $rs succeed }
catch { node $rs fail $_.Exception.Message; throw }
```

The file defaults to `%TEMP%/pi-release-status.json` (`--file` or `$RELEASE_STATUS_FILE` to change it).
`pid` defaults to the calling process, so a release that dies without `succeed`/`fail` shows as stalled (`process gone`). Automatically discovered runs hide 60 seconds after success, failure, or detecting a dead process; unchanged status files stay dismissed. A live process (or a status without a PID) does not expire. Runs pinned with `/release ...` stay visible until `/release off`.

Or write the JSON yourself (write to a temp file and rename it over the old one):

```json
{
  "schema": "pi-release-progress/1",
  "name": "my-app", "version": "1.2.3",
  "state": "running",
  "step": "Publish",
  "steps": ["Build", {"label": "Test", "weight": 120}, "Publish"],
  "progress": {"done": 3, "total": 5, "unit": "packages"},
  "pid": 1234, "startedAt": "2026-10-25T15:00:00Z", "updatedAt": "2026-10-25T15:03:10Z",
  "error": null, "url": null
}
```

`state` is `running`, `succeeded` or `failed`; a new `startedAt` in the same file starts a new run.

## Add a source format

Write an `Adapter` (`src/progress.ts`): `detect(raw)`, `key(raw)` (history bucket), `read(raw, history, previous) → Snapshot`,
and optionally `locate` (map phase text to a step) and `durations` (exact step times). Register it in `adapters` in `src/index.ts`.
The GitHub adapter (`src/adapters/github.ts`) is the smallest example.

## Settings

| Env | Default |
|---|---|
| `PI_RELEASE_STATUS_DIRS` | `C:/tmp` and the OS temp dir (`;`-separated on Windows) |
| `PI_RELEASE_HISTORY` | `%LOCALAPPDATA%/pi-release-progress/history.json` |
| `PI_RELEASE_PROJECTS` | `C:/projetos` (where the GX adapter looks for `release.ps1`) |
| `PI_RELEASE_AUTO` | on; `off` stops following CI after a push (`/release auto on` re-enables it) |

## Develop

`npm test` (unit, plus the CI follow with a faked git/gh layer: no network), `npm run typecheck`.

- `node test/smoke.replay.ts --offline` replays GX and generic status files through the real extension with a fake Pi host. A supplied run URL explicitly enables the optional read-only `gh run view`; no live lookup runs by default.
- `node test/smoke.process-gone.ts` uses a disposable process and real timers to check the GX warning stays visible before 60 seconds, disappears afterward, and is not rediscovered. Add `--remove-status` to verify the same lifecycle when the watched status file is deleted. Each run takes about 70 seconds; no GitHub/provider calls or real release. Status files are isolated and cleaned up.

All smoke variants are available through `.pi/checks.json`. They validate the extension/widget chain, not visibility in an existing Pi session; `/reload` or a fresh session is still needed to activate source changes.
