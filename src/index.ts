import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { mixColors, truncateToWidth } from '@earendil-works/pi-tui';
import { findCiRuns, parsePush, type CiRun, type Runner } from './autofollow.ts';
import { genericAdapter } from './adapters/generic.ts';
import { githubAdapter, parseRunSpec, RUN_FIELDS } from './adapters/github.ts';
import { gxmcpAdapter } from './adapters/gxmcp.ts';
import { computeProgress, learnRun, locateStep, type Adapter, type History, type Snapshot } from './progress.ts';
import { renderLines, type Paint } from './render.ts';

const KEY = 'release-progress';
const POLL_MS = 1000;
const GH_POLL_MS = 5000;
const FRAME_MS = 250;
const DISCOVER_MS = 5000;
const FRESH_MS = 10 * 60_000; // a status file untouched this long is not a live run
const LINGER_MS = 60_000; // how long a finished run stays on screen
const STATUS_FILE = /release.*status.*\.json$/i;

const statusDirs = (process.env.PI_RELEASE_STATUS_DIRS?.split(delimiter) ?? ['C:/tmp', tmpdir()]).filter(Boolean);
const historyPath = process.env.PI_RELEASE_HISTORY ?? join(process.env.LOCALAPPDATA ?? tmpdir(), 'pi-release-progress', 'history.json');
const adapters: Adapter<any>[] = [genericAdapter, gxmcpAdapter(process.env.PI_RELEASE_PROJECTS ?? 'C:/projetos'), githubAdapter];

type Source = { kind: 'file'; file: string; mtime: number } | { kind: 'gh'; id: string; repo?: string };

interface Watch {
  source: Source;
  pinned: boolean;
  adapter: Adapter<any>;
  key: string;
  raw: Record<string, unknown>;
  snapshot: Snapshot;
  index: number;
  stepStartedAt: number;
  /** Step that was already running when the watch attached: its measured time would be short. */
  partialIndex: number;
  /** Set when started by a push: the repo and the other CI runs of that commit still to follow. */
  auto?: { repo: string; rest: CiRun[] };
  runStartedAt?: number;
  finishedAt?: number;
  learned: Record<string, number>;
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as T; } catch { return undefined; }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return true; // nothing to check against
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const adapterFor = (raw: unknown) => (raw && typeof raw === 'object' ? adapters.find((a) => a.detect(raw as Record<string, unknown>)) : undefined);
const sourceId = (source: Source) => (source.kind === 'file' ? `${source.file}@${source.mtime}` : `gh:${source.repo ?? ''}#${source.id}`);

function loadHistory(key: string): History {
  return readJson<Record<string, History>>(historyPath)?.[key] ?? { seconds: {} };
}

function saveHistory(key: string, history: History): void {
  try {
    const all = readJson<Record<string, History>>(historyPath) ?? {};
    all[key] = history;
    mkdirSync(dirname(historyPath), { recursive: true });
    const tmp = `${historyPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, historyPath);
  } catch { /* history is best effort */ }
}

const execRunner: Runner = (file, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: file === 'gh' ? 30_000 : 15_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** External effects of the extension; tests inject fakes. */
export interface Deps {
  run: Runner;
  sleep: (ms: number) => Promise<void>;
}

const autoFollowDefault = !/^(off|0|false|no)$/i.test(process.env.PI_RELEASE_AUTO ?? '');

/** Newest fresh status file any adapter understands, if its run is live or just finished. */
function discover(dismissed: Set<string>): Source | undefined {
  const now = Date.now();
  const found: { file: string; mtime: number }[] = [];
  for (const dir of statusDirs) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!STATUS_FILE.test(entry) || entry.endsWith('.publication.json')) continue;
      const file = join(dir, entry);
      try {
        const mtime = statSync(file).mtimeMs;
        if (now - mtime <= FRESH_MS && !dismissed.has(`${file}@${mtime}`)) found.push({ file, mtime });
      } catch { /* vanished */ }
    }
  }
  for (const { file, mtime } of found.sort((a, b) => b.mtime - a.mtime)) {
    const raw = readJson<Record<string, unknown>>(file);
    if (!adapterFor(raw)) continue;
    if (raw?.state === 'running' || now - mtime < LINGER_MS) return { kind: 'file', file, mtime };
  }
  return undefined;
}

function themePaint(theme: Theme): Paint {
  const from = theme.colors.accent;
  const to = theme.colors.success;
  return {
    fg: (token, text) => theme.fg(token, text),
    bold: (text) => theme.style(text, { bold: true }),
    cell: (text, position, state) => {
      if (state === 'failed') return theme.fg('error', text);
      if (state === 'stalled') return theme.fg('warning', text);
      return theme.style(text, { fg: mixColors(from, to, position) });
    },
    fit: (line, width) => truncateToWidth(line, width),
  };
}

export default function releaseProgress(pi: ExtensionAPI) {
  createReleaseProgress({ run: execRunner, sleep: realSleep })(pi);
}

export function createReleaseProgress({ run, sleep }: Deps) {
  return (pi: ExtensionAPI) => register(pi, run, sleep);
}

function register(pi: ExtensionAPI, run: Runner, sleep: (ms: number) => Promise<void>) {
  const gh = (args: string[], cwd: string | undefined) => run('gh', args, cwd ?? process.cwd());
  let autoFollow = autoFollowDefault;
  let followSeq = 0; // bumped by every push and by /release off: a lookup that sees a newer value gives up
  let ctx: ExtensionContext | undefined;
  let watch: Watch | undefined;
  let history: History = { seconds: {} };
  const dismissed = new Set<string>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let discoverTimer: ReturnType<typeof setInterval> | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let ghInFlight = false;
  let lastGhPoll = 0;
  let shown = false;
  let tick = 0;

  const hide = () => {
    clearInterval(frameTimer);
    frameTimer = undefined;
    requestRender = undefined;
    shown = false;
    ctx?.ui.setWidget(KEY, undefined);
  };

  const show = () => {
    if (!ctx?.hasUI || shown) return;
    shown = true;
    ctx.ui.setWidget(KEY, (tui, theme) => {
      const paint = themePaint(theme);
      requestRender = () => tui.requestRender();
      return {
        render(width: number): string[] {
          if (!watch) return [];
          const view = computeProgress({
            snapshot: watch.snapshot, index: watch.index, history,
            stepStartedAt: watch.stepStartedAt, runStartedAt: watch.runStartedAt,
            processAlive: watch.snapshot.state !== 'running' || processAlive(watch.snapshot.pid), now: watch.finishedAt ?? Date.now(),
          });
          return renderLines(view, width, tick, paint);
        },
        invalidate() {},
      };
    });
    frameTimer = setInterval(() => { tick++; requestRender?.(); }, FRAME_MS);
  };

  const resolveStart = (target: Watch) => {
    const pid = target.snapshot.pid;
    if (target.snapshot.startedAt || !pid || !processAlive(pid)) return;
    const script = `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`;
    execFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      const started = Date.parse(stdout.trim());
      if (!error && Number.isFinite(started) && watch === target) target.runStartedAt = started;
    });
  };

  /** Fold a new status document into the watch: step changes, learned durations, completion. */
  const ingest = (target: Watch, raw: Record<string, unknown>) => {
    const now = Date.now();
    const previous = target.snapshot;
    let snapshot = target.adapter.read(raw, history, previous);
    const newRun = (snapshot.restarted && !previous.restarted)
      || (!!snapshot.startedAt && !!previous.startedAt && snapshot.startedAt !== previous.startedAt);
    if (newRun) {
      Object.assign(target, { index: -1, partialIndex: -1, stepStartedAt: now, runStartedAt: now, finishedAt: undefined, learned: {} });
      history = loadHistory(target.key);
      snapshot = target.adapter.read(raw, history);
    }
    const index = (target.adapter.locate ?? locateStep)(snapshot.phase, snapshot.steps, target.index);
    if (index !== target.index) {
      const left = target.snapshot.steps[target.index];
      if (left && target.index !== target.partialIndex && snapshot.state !== 'failed') target.learned[left.label] = (now - target.stepStartedAt) / 1000;
      target.index = index;
      target.stepStartedAt = now;
    }
    target.raw = raw;
    target.snapshot = snapshot;
    if (snapshot.state !== 'running' && !target.finishedAt) {
      target.finishedAt = snapshot.endedAt ?? now;
      if (snapshot.state === 'succeeded') {
        const current = snapshot.steps[index];
        const measured = target.adapter.durations?.(raw)
          ?? { ...target.learned, ...(current && index !== target.partialIndex ? { [current.label]: (now - target.stepStartedAt) / 1000 } : {}) };
        history = learnRun(history, snapshot.steps, measured);
        saveHistory(target.key, history);
      }
      ctx?.ui.notify(
        snapshot.state === 'succeeded' ? `${snapshot.title} released` : `${snapshot.title} failed: ${snapshot.error ?? snapshot.phase}`,
        snapshot.state === 'succeeded' ? 'info' : 'error',
      );
    }
    requestRender?.();
  };

  const attach = (source: Source, raw: Record<string, unknown>, pinned: boolean, auto?: Watch['auto']): string | undefined => {
    const adapter = adapterFor(raw);
    if (!adapter) return 'unknown status format';
    const key = adapter.key(raw);
    history = loadHistory(key);
    const snapshot = adapter.read(raw, history);
    const index = (adapter.locate ?? locateStep)(snapshot.phase, snapshot.steps, -1);
    const updated = Date.parse(String(raw.updatedAtUtc ?? raw.updatedAt ?? '')) || (source.kind === 'file' ? source.mtime : Date.now());
    const atStart = snapshot.restarted || index <= 0;
    watch = {
      source, pinned, auto, adapter, key, raw, snapshot, index, learned: {},
      stepStartedAt: updated,
      partialIndex: atStart ? -1 : index,
      runStartedAt: snapshot.restarted ? updated : undefined,
      finishedAt: snapshot.state === 'running' ? undefined : snapshot.endedAt ?? updated,
    };
    resolveStart(watch);
    show();
    requestRender?.();
    return undefined;
  };

  const attachFile = (file: string, pinned: boolean) => {
    const raw = readJson<Record<string, unknown>>(file);
    if (!raw) return `cannot read ${file}`;
    return attach({ kind: 'file', file, mtime: statSync(file).mtimeMs }, raw, pinned);
  };

  const fetchRun = async (source: Extract<Source, { kind: 'gh' }>) =>
    JSON.parse(await gh(['run', 'view', source.id, ...(source.repo ? ['--repo', source.repo] : []), '--json', RUN_FIELDS], ctx?.cwd)) as Record<string, unknown>;

  const pollGh = (target: Watch) => {
    if (ghInFlight || target.finishedAt || Date.now() - lastGhPoll < GH_POLL_MS || target.source.kind !== 'gh') return;
    ghInFlight = true;
    lastGhPoll = Date.now();
    fetchRun(target.source)
      .then((raw) => { if (watch === target) ingest(target, raw); })
      .catch(() => { /* transient; next poll */ })
      .finally(() => { ghInFlight = false; });
  };

  /** Attach the next CI run of a push; the rest of the queue goes with it. */
  const attachAuto = async (repo: string, runs: CiRun[]) => {
    const [next, ...rest] = runs;
    const source: Extract<Source, { kind: 'gh' }> = { kind: 'gh', id: next.id, repo };
    attach(source, await fetchRun(source), false, { repo, rest });
  };

  let advancing = false;
  const advanceAuto = (target: Watch) => {
    if (advancing || !target.auto?.rest.length || !target.finishedAt) return;
    advancing = true;
    attachAuto(target.auto.repo, target.auto.rest)
      .catch(() => { target.auto = undefined; }) // stay on the finished run; it lingers and hides as usual
      .finally(() => { advancing = false; });
  };

  /** Look for the CI runs of a push in the background and show them unless something more important is on screen. */
  const followPush = async (push: { dir: string }, output: string, context: ExtensionContext) => {
    const seq = ++followSeq;
    const cancelled = () => seq !== followSeq || !autoFollow;
    try {
      const found = await findCiRuns(push, output, { run, sleep, cancelled });
      if (!found || cancelled()) return;
      if (watch && (watch.pinned || (watch.snapshot.state === 'running' && !watch.auto))) return;
      if (found.runs.length > 1) context.ui.notify(`Following ${found.runs.length} CI runs for ${found.sha.slice(0, 7)} (${found.repo})`, 'info');
      await attachAuto(found.repo, found.runs);
    } catch (error) {
      if (!cancelled()) context.ui.notify(`CI follow failed: ${(error as Error).message}`, 'warning');
    }
  };

  const poll = () => {
    const target = watch;
    if (!target) return;
    if (target.source.kind === 'gh') pollGh(target);
    else {
      let mtime: number;
      try { mtime = statSync(target.source.file).mtimeMs; } catch { return; }
      if (mtime !== target.source.mtime) {
        const raw = readJson<Record<string, unknown>>(target.source.file);
        if (raw) { // otherwise mid-write; next poll
          target.source.mtime = mtime;
          ingest(target, raw);
        }
      }
    }
    advanceAuto(target);
    if (!target.pinned && target.finishedAt && !target.auto?.rest.length && Date.now() - target.finishedAt > LINGER_MS) {
      dismissed.add(sourceId(target.source));
      watch = undefined;
      hide();
    }
  };

  const scan = () => {
    if (watch && (watch.pinned || watch.snapshot.state === 'running')) return;
    const source = discover(dismissed);
    if (source?.kind === 'file' && (watch?.source.kind !== 'file' || source.file !== watch.source.file)) attachFile(source.file, false);
  };

  pi.on('session_start', (_event, context) => {
    ctx = context;
    if (!context.hasUI) return;
    scan();
    pollTimer = setInterval(poll, POLL_MS);
    discoverTimer = setInterval(scan, DISCOVER_MS);
  });

  pi.on('tool_result', (event, context) => {
    if (!autoFollow || !context.hasUI || event.isError) return;
    if ((event.toolName !== 'bash' && event.toolName !== 'powershell') || typeof event.input.command !== 'string') return;
    const push = parsePush(event.input.command, context.cwd);
    if (!push) return;
    ctx = context;
    const output = event.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    void followPush(push, output, context);
  });

  pi.on('session_shutdown', () => {
    followSeq++;
    clearInterval(pollTimer);
    clearInterval(discoverTimer);
    hide();
    watch = undefined;
    ctx = undefined;
  });

  pi.registerCommand('release', {
    description: 'Live release progress: /release [status-file | gh [run-url | owner/repo#id | id | owner/repo] | auto [on|off] | off]',
    handler: async (args, context) => {
      ctx = context;
      const arg = args.trim().replace(/^["']|["']$/g, '');
      if (arg === 'auto' || arg.startsWith('auto ')) {
        const mode = arg.slice(4).trim();
        if (mode === 'on' || mode === 'off') {
          autoFollow = mode === 'on';
          followSeq++;
        } else if (mode) {
          context.ui.notify('Usage: /release auto [on|off]', 'error');
          return;
        }
        context.ui.notify(`Following CI after a push: ${autoFollow ? 'on' : 'off'}.`, 'info');
        return;
      }
      if (arg === 'off') {
        autoFollow = false;
        followSeq++;
        if (watch) dismissed.add(sourceId(watch.source));
        watch = undefined;
        hide();
        context.ui.notify('Release progress hidden until the next run; CI follow after a push is off (/release auto on to resume).', 'info');
        return;
      }
      if (arg === 'gh' || arg.startsWith('gh ')) {
        const spec = parseRunSpec(arg.slice(2).trim());
        try {
          let id = spec.id;
          if (!id) {
            const runs = JSON.parse(await gh(['run', 'list', ...(spec.repo ? ['--repo', spec.repo] : []), '--status', 'in_progress', '--limit', '1', '--json', 'databaseId'], context.cwd)) as { databaseId: number }[];
            if (!runs.length) { context.ui.notify(`No workflow run in progress${spec.repo ? ` in ${spec.repo}` : ''}.`, 'info'); return; }
            id = String(runs[0].databaseId);
          }
          const source: Source = { kind: 'gh', id, repo: spec.repo };
          const error = attach(source, await fetchRun(source), true);
          if (error) context.ui.notify(`Cannot follow run ${id}: ${error}`, 'error');
        } catch (error) {
          context.ui.notify(`gh: ${(error as Error).message}`, 'error');
        }
        return;
      }
      if (arg) {
        const error = attachFile(arg, true);
        if (error) context.ui.notify(`Cannot follow ${arg}: ${error}`, 'error');
        return;
      }
      const source = watch?.source ?? discover(new Set());
      if (!source) {
        context.ui.notify(`No release running. Watching ${statusDirs.join(', ')} for *release*status*.json; /release gh follows a GitHub Actions run.`, 'info');
        return;
      }
      if (watch) { watch.pinned = true; show(); return; }
      if (source.kind === 'file') attachFile(source.file, true);
    },
  });
}
