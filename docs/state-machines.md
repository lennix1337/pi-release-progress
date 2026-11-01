# Implicit state machines in pi-release-progress

Catalog made on `origin/main` (80ae036). Line numbers refer to `src/index.ts` after this PR unless a file is named.

Severity: P1 wrong behaviour with real impact, P2 wrong behaviour in a reachable situation, P3 latent or cosmetic.

## Unmerged branches that touch these machines

`origin/fix/process-gone-expiry` (not merged; it also carries "label CI runs as CI" and the gitwatch PR line) changes machine 1 and machine 3:

- adds `Watch.processGoneAt` and a dismiss rule `dismissAt = finishedAt ?? processGoneAt`, which fixes finding RP-3 below (a run whose process died stays `stalled` on screen forever);
- threads a `sha` through `Watch.auto`, `attachAuto`, `advanceAuto` and `followPush`.

This PR does not duplicate that: RP-3 is catalogued as fixed there, and the explicit `phase` model of machine 1 is deliberately **not** introduced here because that branch rewrites the same `poll` and `Watch` lines. After it merges, `Watch` should become one `phase` union (see "Recommended next step" at the end). The one fix made here (RP-1) touches `attach`, `holdsScreen` and one condition in `followPush`, away from the lines that branch edits.

## 1. Widget watch lifecycle (`Watch`, `watch`, `poll`, `scan`, `ingest`)

- **States** (implicit, derived from `watch`, `pinned`, `snapshot.state`, `finishedAt`, `auto`, `dismissed`): none -> following (running) -> finished (lingering `LINGER_MS` = 60 s) -> dismissed (id in `dismissed`, widget hidden). Pinned watches never dismiss. `stalled` is a view state computed at render (`computeProgress`: running but `processAlive` false).
- **Events:** `session_start` (scan + two intervals), file mtime change or gh poll (`ingest`), `/release [file|gh|auto|off]`, CI follow attach, `scan` every 5 s, `session_shutdown`.
- **Transitions:** `attach` (the single writer of `watch`), `ingest` (step change, learn timings, `finishedAt` set once), `poll` (linger check -> `dismissed.add`, `watch = undefined`, `hide`).
- **Lives in:** closure memory; learned step durations in `history.json` (`PI_RELEASE_HISTORY`, atomic write, best effort); status files written by the release script.
- **Invariants:** `finishedAt` is set exactly once per run and notifies once; a new run (`restarted` or different `startedAt`) resets index, learned and `finishedAt`; history is only learned from a succeeded run.
- **Findings**
  - **RP-1 (P2, fixed).** A background CI follow fetched its run (`gh run view`, up to 30 s) and then called `attach` unconditionally. The guards (`pinned`, running release, `autoFollow`, `followSeq`) were checked only *before* the fetch. If the user ran `/release gh <run>` (pinned), `/release off` or the session shut down during that fetch, the late attach replaced the pinned watch, re-showed a widget the user had hidden, or set `watch` after `session_shutdown`. Fix: `holdsScreen()` and a check in `attach` for `auto` attaches (`!ctx || !autoFollow || holdsScreen()`); `followPush` uses the same predicate. Test: `extension: a CI run fetched after the user pinned another run does not replace it`.
  - RP-2 (P3, catalogued). `ingest` never leaves "finished": if a status file flips from `failed`/`succeeded` back to `running` without a new `startedAt`/`restarted`, `finishedAt` stays set, the view renders with `now = finishedAt` (frozen) and the watch is dismissed 60 s later. A gh run re-run with the same id behaves the same way because `pollGh` stops at `finishedAt`. Release scripts normally write a new `startedAt`, so left alone.
  - RP-3 (P2, fixed in unmerged `fix/process-gone-expiry`). A running run whose `pid` died stayed `stalled` forever (no `finishedAt`, so the linger rule never fired). Not touched here.
  - RP-4 (P3, catalogued). `session_start` arms `pollTimer` and `discoverTimer` without clearing earlier ones; only `session_shutdown` clears them. A second `session_start` without a shutdown would leak a pair of intervals. Pi emits shutdown first, so unreachable today.
  - RP-5 (P3, catalogued). `processAlive` is evaluated on every render frame (every 250 ms) and again in `poll`; two readers of one fact, harmless (`kill -0`), but the branch above makes `poll` the owner.

## 2. Background CI follow chain (`followPush`, `attachAuto`, `advanceAuto`, `followSeq`, `advancing`)

- **States:** idle -> looking up (`findCiRuns`, epoch `followSeq`) -> fetching the first run -> following run k of n (`auto.rest`) -> advancing to run k+1 (`advancing`) -> finished (`auto.rest` empty, lingers).
- **Cancellation:** `followSeq` is an epoch bumped by every push, `/release off`, `/release auto on|off` and shutdown; `findCiRuns` polls `cancelled()` between sleeps. This is already an explicit and correct pattern; RP-1 closes the one gap after the lookup (the fetch).
- **Findings**
  - RP-6 (P3, catalogued). `advanceAuto` does not re-check `watch === target` after its fetch. If a newer push attached another auto watch meanwhile, the older chain's next run replaces it. Needs two pushes inside one `gh run view`; RP-1's `holdsScreen` does not cover it because both are `auto`. Left for the explicit `phase` refactor.
  - RP-7 (P3, catalogued). When advancing fails, `target.auto = undefined` is applied even if `target` is no longer the shown watch; harmless.

## 3. Run progress inside one watch (`index`, `partialIndex`, `stepStartedAt`, `learned`, `runStartedAt`)

Step location is monotone-or-hold (`locateStep` returns `previous` when unknown); a step that was already running at attach time (`partialIndex`) is never learned because its time would be short. A failed run does not teach the failed step. Tested in `test/progress.test.ts`. No findings.

## 4. gh poll gate (`ghInFlight`, `lastGhPoll`, `GH_POLL_MS`)

One request at a time, at least 5 s apart, result applied only if `watch === target`. A stale in-flight request for a replaced watch delays the next watch's first poll by at most its duration. Correct.

## 5. Timers and frame loop (`pollTimer`, `discoverTimer`, `frameTimer`, `shown`, `requestRender`)

`show()` and `hide()` are the only writers of `shown`, `frameTimer` and `requestRender`; `shown` guards a double show. See RP-4 for the only gap.

## 6. CI lookup retry loop (`src/autofollow.ts:86-120`, `findCiRuns`)

Bounded loop: 12 attempts, 3 consecutive errors abort, a sibling listing after the first hit, `cancelled()` after every sleep. Explicit and tested. No findings.

## 7. Status file protocol (`bin/release-status.mjs`, adapters)

The status JSON carries `state: running|succeeded|failed`. The generic adapter coerces any other value to `running` (`state === 'succeeded' || 'failed' ? state : 'running'`); the gx adapter likewise; the github adapter maps `status`/`conclusion`. The CLI is the only writer of the generic format and writes through tmp + rename. Invalid transitions (`succeed` after `fail`) are not rejected by the CLI: the last write wins, which the widget handles through RP-2's rules.

## Summary

| machine | states | explicitness before | after | findings |
| --- | --- | --- | --- | --- |
| Widget watch lifecycle | none / following / finished / dismissed (+ stalled view) | implicit: `watch`, `pinned`, `finishedAt`, `auto`, `dismissed` | unchanged (blocked by unmerged branch) | RP-1 P2 fixed, RP-2 P3, RP-3 P2 fixed upstream branch, RP-4 P3, RP-5 P3 |
| Background CI follow chain | idle / lookup / fetch / following / advancing | `followSeq` epoch + `advancing` flag | epoch + `holdsScreen` guard in `attach` | RP-1 (shared), RP-6 P3, RP-7 P3 |
| Run progress in a watch | step index, learned timings | explicit counters | unchanged | none |
| gh poll gate | idle / in flight | two fields, one writer | unchanged | none |
| Timers and frame loop | hidden / shown | `shown` + three handles | unchanged | RP-4 P3 |
| CI lookup retry loop | attempts / errors | bounded loop | unchanged | none |
| Status file protocol | running / succeeded / failed | string coerced at read | unchanged | none |

## Recommended next step

After `fix/process-gone-expiry` merges, replace `finishedAt` / `processGoneAt` / `pinned` / `auto` with one `phase: 'following' | 'finished' | 'gone'` field on `Watch` and a single `endWatch()` transition, which also gives RP-2 and RP-6 one place to be handled.
