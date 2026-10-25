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

Commands: `/release` pins the current/latest run, `/release <status-file>` follows a file, `/release off` hides it until the next run.

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
`pid` defaults to the calling process, so a release that dies without `succeed`/`fail` shows as stalled.

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

## Develop

`npm test` (unit), `npm run typecheck`, `node test/smoke.replay.ts [run-url]` (drives the real extension with a fake Pi through all three sources; the GitHub part calls `gh run view`, read-only).
