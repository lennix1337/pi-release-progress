import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { findCiRuns, parseGithubRemote, parsePush, parsePushOutput, type Runner } from '../src/autofollow.ts';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(7);
const NEW = 'c'.repeat(7);
const PUSH_OUTPUT = `remote: Resolving deltas: 100% (3/3), completed with 3 local objects.\nTo https://github.com/lennix1337/pi-release-progress.git\n   ${OLD}..${NEW}  main -> main\n`;

test('parsePush: finds git push in plain, chained and option-laden commands', () => {
  const cwd = resolve('/work/app');
  assert.deepEqual(parsePush('git push', cwd), { dir: cwd });
  assert.deepEqual(parsePush('git push origin main', cwd), { dir: cwd });
  assert.deepEqual(parsePush('git add -A && git commit -m x && git push -u origin HEAD', cwd), { dir: cwd });
  assert.deepEqual(parsePush('git -c core.x=1 push --force-with-lease', cwd), { dir: cwd });
  assert.equal(parsePush('git pull && git status', cwd), undefined);
  assert.equal(parsePush('git pushd', cwd), undefined);
  assert.equal(parsePush('echo digit push', cwd), undefined);
});

test('parsePush: dry runs and deletions are not pushes of new code', () => {
  assert.equal(parsePush('git push --dry-run', '/w'), undefined);
  assert.equal(parsePush('git push -n origin main', '/w'), undefined);
  assert.equal(parsePush('git push origin --delete old-branch', '/w'), undefined);
  assert.deepEqual(parsePush('git push origin main && git branch -d old', '/w'), { dir: resolve('/w') });
});

test('parsePush: directory comes from cd prefixes (last wins, relative ones stack) or git -C', () => {
  assert.deepEqual(parsePush('cd /srv/repo && git push', '/w'), { dir: resolve('/srv/repo') });
  assert.deepEqual(parsePush('cd "/srv/my repo" && git push origin main', '/w'), { dir: resolve('/srv/my repo') });
  assert.deepEqual(parsePush("cd '/srv/a'; cd b && git push", '/w'), { dir: resolve('/srv/a/b') });
  assert.deepEqual(parsePush('git -C /srv/other push', '/w'), { dir: resolve('/srv/other') });
  assert.deepEqual(parsePush('git -C "sub dir" push', '/w/base'), { dir: resolve('/w/base/sub dir') });
  assert.deepEqual(parsePush('cd /srv/repo && git -C pkg push', '/w'), { dir: resolve('/srv/repo/pkg') });
  assert.deepEqual(parsePush('git push && cd /elsewhere', '/w'), { dir: resolve('/w') }); // cd after the push does not count
});

test('parseGithubRemote: github.com only', () => {
  assert.equal(parseGithubRemote('https://github.com/lennix1337/pi-release-progress.git'), 'lennix1337/pi-release-progress');
  assert.equal(parseGithubRemote('https://user@github.com/o/r'), 'o/r');
  assert.equal(parseGithubRemote('git@github.com:o/r.git'), 'o/r');
  assert.equal(parseGithubRemote('ssh://git@github.com/o/r.git'), 'o/r');
  assert.equal(parseGithubRemote('https://github.com/o/my.repo.git\n'), 'o/my.repo');
  assert.equal(parseGithubRemote('https://gitlab.com/o/r.git'), undefined);
  assert.equal(parseGithubRemote('https://github.com.evil.example/o/r.git'), undefined);
  assert.equal(parseGithubRemote('/local/path/repo.git'), undefined);
});

test('parsePushOutput: remote URL and new commit of the updated ref', () => {
  assert.deepEqual(parsePushOutput(PUSH_OUTPUT), { remote: 'https://github.com/lennix1337/pi-release-progress.git', commit: NEW });
  assert.deepEqual(parsePushOutput(`To github.com:o/r.git\n + ${OLD}...${NEW} topic -> topic (forced update)\n`), { remote: 'github.com:o/r.git', commit: NEW });
  assert.deepEqual(parsePushOutput('To https://github.com/o/r.git\n * [new branch]      topic -> topic\n'), { remote: 'https://github.com/o/r.git', commit: undefined });
  assert.deepEqual(parsePushOutput('Everything up-to-date'), { remote: undefined, commit: undefined });
});

interface Call { file: string; args: string[]; cwd: string }

function fakeRunner(handlers: { gh: (args: string[], call: number) => string | Error; git?: (args: string[]) => string | Error }): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  let ghCalls = 0;
  const run: Runner = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    const result = file === 'gh'
      ? handlers.gh(args, ghCalls++)
      : (handlers.git ?? ((a) => (a[0] === 'remote' ? 'https://github.com/o/r.git\n' : `${SHA}\n`)))(args);
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}

const runsJson = (...runs: [number, string, string?][]) => JSON.stringify(runs.map(([databaseId, status, workflowName]) => ({ databaseId, status, workflowName })));

function options(run: Runner, cancelled = () => false) {
  const sleeps: number[] = [];
  return { sleeps, options: { run, cancelled, sleep: async (ms: number) => { sleeps.push(ms); } } };
}

test('findCiRuns: repo and commit come from the push output, runs from gh run list --commit', async () => {
  const { run, calls } = fakeRunner({ gh: () => runsJson([11, 'in_progress', 'CI']) });
  const { options: opts } = options(run);
  const found = await findCiRuns({ dir: '/repo' }, PUSH_OUTPUT, opts);
  assert.deepEqual(found, { repo: 'lennix1337/pi-release-progress', sha: SHA, runs: [{ id: '11', status: 'in_progress', workflow: 'CI' }] });
  assert.deepEqual(calls[0], { file: 'git', args: ['rev-parse', '--verify', `${NEW}^{commit}`], cwd: '/repo' });
  const list = calls.find((call) => call.file === 'gh');
  assert.deepEqual(list?.args.slice(0, 6), ['run', 'list', '-R', 'lennix1337/pi-release-progress', '--commit', SHA]);
  assert.equal(list?.cwd, '/repo');
});

test('findCiRuns: without push output it uses origin and HEAD', async () => {
  const { run, calls } = fakeRunner({ gh: () => runsJson([5, 'queued']) });
  const found = await findCiRuns({ dir: '/repo' }, '', options(run).options);
  assert.equal(found?.repo, 'o/r');
  assert.deepEqual(calls.slice(0, 2).map((c) => c.args), [['remote', 'get-url', 'origin'], ['rev-parse', '--verify', 'HEAD^{commit}']]);
});

test('findCiRuns: retries until the run appears, then picks up sibling workflows, unfinished first', async () => {
  const { run, calls } = fakeRunner({
    gh: (_args, call) => (call < 2 ? '[]' : call === 2 ? runsJson([30, 'completed', 'Lint']) : runsJson([30, 'completed', 'Lint'], [31, 'in_progress', 'CI'])),
  });
  const { options: opts, sleeps } = options(run);
  const found = await findCiRuns({ dir: '/repo' }, PUSH_OUTPUT, opts);
  assert.deepEqual(found?.runs.map((r) => r.id), ['31', '30']);
  assert.equal(calls.filter((c) => c.file === 'gh').length, 4);
  assert.deepEqual(sleeps, [3000, 5000, 5000, 3000]);
});

test('findCiRuns: a repo without CI gives up after about a minute without throwing', async () => {
  const { run, calls } = fakeRunner({ gh: () => '[]' });
  const { options: opts, sleeps } = options(run);
  assert.equal(await findCiRuns({ dir: '/repo' }, PUSH_OUTPUT, opts), undefined);
  assert.equal(calls.filter((c) => c.file === 'gh').length, 12);
  const total = sleeps.reduce((a, b) => a + b, 0);
  assert.ok(total >= 50_000 && total <= 65_000, `waited ${total} ms`);
});

test('findCiRuns: other hosts do nothing and never call gh', async () => {
  const { run, calls } = fakeRunner({ gh: () => '[]' });
  assert.equal(await findCiRuns({ dir: '/repo' }, 'To https://gitlab.com/o/r.git\n', options(run).options), undefined);
  assert.equal(calls.length, 0);
});

test('findCiRuns: stops as soon as it is cancelled', async () => {
  const { run, calls } = fakeRunner({ gh: () => '[]' });
  let cancel = false;
  const { options: opts } = options(run, () => cancel);
  const slow = { ...opts, sleep: async () => { cancel = true; } };
  assert.equal(await findCiRuns({ dir: '/repo' }, PUSH_OUTPUT, slow), undefined);
  assert.equal(calls.filter((c) => c.file === 'gh').length, 0);
});

test('findCiRuns: transient gh errors are retried, persistent ones surface', async () => {
  const flaky = fakeRunner({ gh: (_a, call) => (call === 0 ? new Error('HTTP 502') : runsJson([7, 'queued'])) });
  assert.equal((await findCiRuns({ dir: '/repo' }, PUSH_OUTPUT, options(flaky.run).options))?.runs[0].id, '7');
  const broken = fakeRunner({ gh: () => new Error('gh auth login required') });
  await assert.rejects(findCiRuns({ dir: '/repo' }, PUSH_OUTPUT, options(broken.run).options), /auth login/);
  assert.equal(broken.calls.filter((c) => c.file === 'gh').length, 3);
});

// ---- the extension wired to Pi's tool_result event, with fake git/gh and fake timers ----

const dir = mkdtempSync(join(tmpdir(), 'pi-release-auto-'));
process.env.PI_RELEASE_STATUS_DIRS = dir;
process.env.PI_RELEASE_HISTORY = join(dir, 'history.json');
const { createReleaseProgress } = await import('../src/index.ts');
const { rgbColor } = await import('@earendil-works/pi-tui');

const theme = { colors: { accent: rgbColor(90, 120, 230), success: rgbColor(130, 220, 110) }, fg: (_t: string, s: string) => s, style: (s: string) => s };
const ghRun = (id: number, status: string, conclusion = '', workflowName = 'CI') => JSON.stringify({
  databaseId: id, name: workflowName, workflowName, displayTitle: 'push', status, conclusion, createdAt: new Date().toISOString(),
  url: `https://github.com/lennix1337/pi-release-progress/actions/runs/${id}`,
  jobs: [{ name: 'build', status, conclusion, startedAt: new Date().toISOString(), steps: [] }],
});

async function session(gh: (args: string[]) => string, options: { hasUI?: boolean } = {}) {
  const calls: Call[] = [];
  const run: Runner = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    if (file === 'gh') return gh(args);
    return args[0] === 'remote' ? 'https://github.com/lennix1337/pi-release-progress.git\n' : `${SHA}\n`;
  };
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let widget: { render(width: number): string[] } | undefined;
  const notes: string[] = [];
  const ctx = {
    hasUI: options.hasUI ?? true, cwd: resolve('/work/app'),
    ui: {
      setWidget: (_key: string, factory: unknown) => { widget = typeof factory === 'function' ? factory({ requestRender() {} }, theme) : undefined; },
      notify: (message: string) => notes.push(message),
    },
  };
  createReleaseProgress({ run, sleep: async () => {} })({
    on: (name: string, handler: never) => { handlers[name] = handler; },
    registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
  } as never);
  handlers.session_start({}, ctx);
  const toolResult = (input: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    handlers.tool_result({ type: 'tool_result', toolName: 'bash', toolCallId: '1', input, content: [{ type: 'text', text: PUSH_OUTPUT }], isError: false, ...over }, ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return {
    calls, notes, toolResult, flush, ctx,
    widget: () => widget,
    command: (args: string) => command!(args, ctx),
    shutdown: () => handlers.session_shutdown({}, ctx),
  };
}
const ghCalls = (calls: Call[]) => calls.filter((c) => c.file === 'gh').map((c) => c.args.join(' '));

test('extension: a successful git push makes the widget follow the CI run of the pushed commit', async () => {
  const s = await session((args) => (args[0] === 'run' && args[1] === 'list' ? runsJson([77, 'in_progress']) : ghRun(77, 'in_progress')));
  try {
    s.toolResult({ command: 'git push origin main' });
    await s.flush();
    assert.ok(ghCalls(s.calls).some((c) => c.startsWith('run view 77 --repo lennix1337/pi-release-progress')), ghCalls(s.calls).join('\n'));
    assert.match(s.widget()?.render(80).join('\n') ?? '', /CI/);
  } finally { s.shutdown(); }
});

test('extension: failed pushes, other tools and non-push commands are ignored', async () => {
  const s = await session(() => runsJson([1, 'in_progress']));
  try {
    s.toolResult({ command: 'git push' }, { isError: true });
    s.toolResult({ command: 'git status' });
    s.toolResult({ command: 'git push' }, { toolName: 'read' });
    s.toolResult({ command: 'git push --dry-run' });
    await s.flush();
    assert.equal(s.calls.length, 0);
    assert.equal(s.widget(), undefined);
  } finally { s.shutdown(); }
});

test('extension: no workflow run for the commit leaves the widget alone', async () => {
  const s = await session(() => '[]');
  try {
    s.toolResult({ command: 'git push' });
    await s.flush();
    assert.equal(s.widget(), undefined);
    assert.deepEqual(s.notes, []);
  } finally { s.shutdown(); }
});

test('extension: /release auto off stops following, /release auto on resumes; /release off disables for the session', async () => {
  const gh = (args: string[]) => (args[1] === 'list' ? runsJson([9, 'in_progress']) : ghRun(9, 'in_progress'));
  const s = await session(gh);
  try {
    await s.command('auto off');
    s.toolResult({ command: 'git push' });
    await s.flush();
    assert.equal(s.calls.length, 0);
    await s.command('auto on');
    s.toolResult({ command: 'git push' });
    await s.flush();
    assert.ok(s.widget());
    await s.command('off');
    assert.equal(s.widget(), undefined);
    s.calls.length = 0;
    s.toolResult({ command: 'git push' });
    await s.flush();
    assert.equal(s.calls.length, 0, '/release off stops auto-follow for the session');
    assert.equal(s.widget(), undefined);
    await s.command('auto');
    assert.match(s.notes.at(-1) ?? '', /off/);
  } finally { s.shutdown(); }
});

test('extension: /release off while the run is still being looked up cancels the lookup', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: Call[] = [];
  const run: Runner = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    if (file === 'gh') return args[1] === 'list' ? runsJson([4, 'in_progress']) : ghRun(4, 'in_progress');
    return `${SHA}\n`;
  };
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  let command!: (args: string, ctx: unknown) => Promise<void>;
  let widget: unknown;
  const ctx = { hasUI: true, cwd: resolve('/w'), ui: { setWidget: (_k: string, f: unknown) => { widget = f; }, notify() {} } };
  createReleaseProgress({ run, sleep: () => gate })({
    on: (name: string, handler: never) => { handlers[name] = handler; },
    registerCommand: (_n: string, spec: { handler: typeof command }) => { command = spec.handler; },
  } as never);
  handlers.session_start({}, ctx);
  handlers.tool_result({ toolName: 'bash', input: { command: 'git push' }, content: [{ type: 'text', text: PUSH_OUTPUT }], isError: false }, ctx);
  await command('off', ctx);
  release();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(widget, undefined);
  assert.equal(calls.filter((c) => c.file === 'gh').length, 0);
  handlers.session_shutdown({}, ctx);
});

test('extension: does not steal the widget from a pinned or running release', async () => {
  const gh = (args: string[]) => (args[1] === 'list' ? runsJson([21, 'in_progress']) : ghRun(21, 'in_progress', '', 'Auto'));
  const s = await session(gh);
  try {
    await s.command('gh lennix1337/pi-release-progress#5'); // pinned manual follow
    await s.flush();
    const before = ghCalls(s.calls).length;
    s.toolResult({ command: 'git push' });
    await s.flush();
    assert.ok(ghCalls(s.calls).length > before, 'it still looked for runs');
    assert.ok(!ghCalls(s.calls).some((c) => c.startsWith('run view 21')), 'but did not attach');
  } finally { s.shutdown(); }
});

test('extension: several runs are followed one after another, with a count', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const state: Record<number, string> = { 1: 'in_progress', 2: 'in_progress' };
  const gh = (args: string[]) => {
    if (args[1] === 'list') return runsJson([1, state[1]], [2, state[2]]);
    const id = Number(args[2]);
    return ghRun(id, state[id], state[id] === 'completed' ? 'success' : '', id === 1 ? 'CI' : 'Docs');
  };
  const s = await session(gh);
  try {
    s.toolResult({ command: 'git push' });
    await s.flush();
    assert.match(s.notes.join('\n'), /2 CI runs/);
    assert.match(s.widget()?.render(80).join('\n') ?? '', /CI/);
    state[1] = 'completed';
    for (let i = 0; i < 8; i++) { t.mock.timers.tick(1000); await s.flush(); }
    assert.ok(ghCalls(s.calls).some((c) => c.startsWith('run view 2 ')), ghCalls(s.calls).join('\n'));
    assert.match(s.widget()?.render(80).join('\n') ?? '', /Docs/);
  } finally { s.shutdown(); }
});

for (const format of ['generic', 'gxmcp']) {
  test(`extension: ${format} process gone hides after 60 seconds without rediscovery`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const file = join(dir, `${format}-release-status.json`);
    const raw = format === 'generic'
      ? { schema: 'pi-release-progress/1', name: 'Test release', state: 'running', step: 'Publish', steps: ['Publish'], pid: child.pid }
      : { version: '3.0.1', phase: 'complete', state: 'running', publicationState: 'pending', pid: child.pid };
    writeFileSync(file, JSON.stringify(raw));
    const s = await session(() => { throw new Error('unexpected network request'); });
    try {
      assert.ok(s.widget(), 'a live release is discovered');
      assert.doesNotMatch(s.widget()!.render(80).join('\n'), /process gone/);
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
      t.mock.timers.tick(1000);
      assert.match(s.widget()!.render(80).join('\n'), /process gone/);
      t.mock.timers.tick(59_000);
      assert.ok(s.widget(), 'keep the warning visible for the linger period');
      t.mock.timers.tick(2000);
      assert.equal(s.widget(), undefined, 'dismiss after the same 60-second delay as completion');
      t.mock.timers.tick(10_000);
      assert.equal(s.widget(), undefined, 'the unchanged running status must not reappear');
      assert.deepEqual(s.notes, [], 'process disappearance must not be reported as release success or failure');
    } finally {
      s.shutdown();
      rmSync(file);
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
    }
  });
}

for (const state of ['succeeded', 'failed']) {
  test(`extension: ${state} status still hides after 60 seconds`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const file = join(dir, 'finished-release-status.json');
    writeFileSync(file, JSON.stringify({ schema: 'pi-release-progress/1', name: 'Finished release', state, updatedAt: new Date().toISOString() }));
    const s = await session(() => { throw new Error('unexpected network request'); });
    try {
      t.mock.timers.tick(59_000);
      assert.ok(s.widget());
      t.mock.timers.tick(2000);
      assert.equal(s.widget(), undefined);
    } finally { s.shutdown(); rmSync(file); }
  });
}

for (const pid of [process.pid, undefined]) {
  test(`extension: running status with ${pid ? 'live' : 'unknown'} PID does not expire`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const file = join(dir, 'live-release-status.json');
    writeFileSync(file, JSON.stringify({ schema: 'pi-release-progress/1', name: 'Live release', state: 'running', pid, startedAt: new Date().toISOString() }));
    const s = await session(() => { throw new Error('unexpected network request'); });
    try {
      t.mock.timers.tick(120_000);
      assert.ok(s.widget());
      assert.doesNotMatch(s.widget()!.render(80).join('\n'), /process gone/);
    } finally { s.shutdown(); rmSync(file); }
  });
}

test('extension: no UI, no auto-follow', async () => {
  const s = await session(() => runsJson([1, 'in_progress']), { hasUI: false });
  s.toolResult({ command: 'git push' });
  await s.flush();
  assert.equal(s.calls.length, 0);
  s.shutdown();
  mock.reset();
});
