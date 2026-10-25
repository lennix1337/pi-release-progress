import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { genericAdapter, SCHEMA, type GenericStatus } from '../src/adapters/generic.ts';
import { githubAdapter, parseRunSpec, type GhRun } from '../src/adapters/github.ts';
import { DEFAULT_STEPS, gxmcpAdapter, locateGx, parseSteps, type GxStatus } from '../src/adapters/gxmcp.ts';
import { computeProgress, learnRun, learnTiming, locateStep, type History, type ProgressInput, type Snapshot } from '../src/progress.ts';
import { renderLines, type Paint } from '../src/render.ts';

const plain: Paint = {
  fg: (_token, text) => text,
  bold: (text) => text,
  cell: (text) => text,
  fit: (line, width) => [...line].slice(0, width).join(''),
};
const empty: History = { seconds: {} };

// The GX adapter, with a projects root that has no checkout, so it uses DEFAULT_STEPS.
const gx = gxmcpAdapter(join(tmpdir(), 'no-such-projects-root'));

function gxInput(over: { phase: string; state?: string; status?: Partial<GxStatus>; history?: History; now?: number; processAlive?: boolean; index?: number }): ProgressInput {
  const snapshot = gx.read({ repository: 'lennix1337/Genexus18MCP', version: '4.0.2', tag: 'v4.0.2', phase: over.phase, state: over.state ?? 'running', ...over.status }, empty);
  return {
    snapshot, history: over.history ?? empty, index: over.index ?? locateGx(over.phase, snapshot.steps, -1),
    stepStartedAt: 0, processAlive: over.processAlive ?? true, now: over.now ?? 0,
  };
}

const view = (input: ProgressInput) => computeProgress(input);

test('gx: parseSteps reads Step calls in order, deduplicated, with variables as wildcards', () => {
  const steps = parseSteps([
    'Step "Resolving version"',
    '    Step $stepLabel',
    "    Step 'Verifying publish.zip against the release manifest'",
    '    Step "Tagging $tag"',
    '    Step "Resolving version"',
    'function Step([string]$msg) { Write-Host $msg }',
  ].join('\r\n'));
  assert.deepEqual(steps.map((s) => s.label), [
    'Resolving version', 'Bumping / synchronizing version', 'Verifying publish.zip against the release manifest', 'Tagging $tag',
  ]);
  assert.ok(steps[3].pattern?.test('Tagging v4.0.2'));
  assert.ok(steps[1].pattern?.test('Bumping version 4.0.1 -> 4.0.2'));
  assert.ok(!steps[2].pattern?.test('Verifying publishXzip against the release manifest'));
});

test('gx: sub-phases map to their step and unknown phases keep the last step', () => {
  const closing = DEFAULT_STEPS.findIndex((s) => s.label === 'Closing released issues');
  assert.equal(locateGx('issue-649-closed', DEFAULT_STEPS, 3), closing);
  assert.equal(locateGx('Pushing main + v4.0.2 to origin', DEFAULT_STEPS, 0), DEFAULT_STEPS.findIndex((s) => s.label.startsWith('Pushing main')));
  assert.equal(locateGx('something-new', DEFAULT_STEPS, 7), 7);
});

test('gx: detect needs the release.ps1 shape, not just any phase/state pair', () => {
  assert.ok(gx.detect({ phase: 'starting', state: 'running', publicationState: 'not-started' }));
  assert.ok(!gx.detect({ phase: 'x', state: 'running' }));
  assert.ok(!gx.detect({ schema: SCHEMA, name: 'a', state: 'running' }));
});

test('progress grows with steps, never reaches 100% while running, and is 100% on success', () => {
  const early = view(gxInput({ phase: 'Building (build.ps1)' }));
  const late = view(gxInput({ phase: 'Verifying GitHub Release and npm publication' }));
  const overrun = view(gxInput({ phase: 'Closing released issues', now: 1e9 }));
  const done = view(gxInput({ phase: 'complete', state: 'succeeded', index: DEFAULT_STEPS.length - 1 }));
  assert.ok(early.fraction < late.fraction);
  assert.ok(overrun.fraction <= 0.99);
  assert.equal(done.fraction, 1);
  assert.equal(done.state, 'succeeded');
  assert.equal(late.currentLabel, 'Verifying GitHub Release and npm publication');
  assert.equal(late.nextLabel, 'Closing released issues');
});

test('gx: closing issues is sub-progress of its step', () => {
  const issues = { validated: [1, 2, 3, 4], closed: [1, 2] };
  const half = view(gxInput({ phase: 'issue-2-closed', status: { issues } }));
  const none = view(gxInput({ phase: 'issue-2-closed', status: { issues: { ...issues, closed: [] } } }));
  assert.ok(half.fraction > none.fraction);
  assert.deepEqual(half.sub, { done: 2, total: 4, unit: 'issues closed' });
  assert.equal(view(gxInput({ phase: 'Building (build.ps1)', status: { issues } })).sub, undefined);
});

test('a running run whose process is gone is reported as stalled', () => {
  assert.equal(view(gxInput({ phase: 'Building (build.ps1)', processAlive: false })).state, 'stalled');
});

test('gx: labels show the tag but stay keyed by the template', () => {
  const input = gxInput({ phase: 'Tagging v4.0.2' });
  assert.equal(view(input).currentLabel, 'Tagging v4.0.2');
  assert.equal(input.snapshot.steps[input.index].label, 'Tagging $tag');
});

test('measured timings change the weights and blend over runs', () => {
  const slow = view(gxInput({ phase: 'Building Nexus IDE VSIX', history: { seconds: { 'Building (build.ps1)': 2000 } } }));
  const base = view(gxInput({ phase: 'Building Nexus IDE VSIX' }));
  assert.ok(slow.fraction > base.fraction);
  assert.deepEqual(learnTiming({ a: 100 }, 'a', 200), { a: 150 });
  assert.deepEqual(learnTiming({}, 'b', 12.34), { b: 12.3 });
  assert.deepEqual(learnRun({ seconds: { a: 10 } }, [{ label: 'a' }, { label: 'b' }], { a: 20, b: 5 }), { steps: ['a', 'b'], seconds: { a: 15, b: 5 } });
});

function generic(status: Partial<GenericStatus>, history: History = empty): Snapshot {
  return genericAdapter.read({ schema: SCHEMA, name: 'my-app', version: '1.2.3', state: 'running', ...status }, history);
}

test('generic: declared steps give a determinate bar, weights included', () => {
  const snapshot = generic({ step: 'Test', steps: ['Build', { label: 'Test', weight: 30 }, 'Publish'] });
  assert.equal(snapshot.indeterminate, false);
  assert.equal(snapshot.title, 'my-app 1.2.3');
  const index = locateStep(snapshot.phase, snapshot.steps, -1);
  assert.equal(index, 1);
  const v = view({ snapshot, index, history: empty, stepStartedAt: 0, processAlive: true, now: 0 });
  assert.equal(v.stepCount, 3);
  assert.equal(v.nextLabel, 'Publish');
  assert.ok(Math.abs(v.fraction - 10 / 50) < 1e-9);
});

test('generic: without a plan the first run is indeterminate and learns the order', () => {
  const first = generic({ step: 'Build' });
  assert.equal(first.indeterminate, true);
  assert.deepEqual(first.steps.map((s) => s.label), ['Build']);
  const lines = renderLines(view({ snapshot: first, index: 0, history: empty, stepStartedAt: 0, processAlive: true, now: 0 }), 80, 5, plain);
  assert.doesNotMatch(lines[1], /%/);
  assert.match(lines[2], /^step 1 Build/);

  const learned = learnRun(empty, [{ label: 'Build' }, { label: 'Publish' }], { Build: 100, Publish: 20 });
  const second = generic({ step: 'Publish' }, learned);
  assert.equal(second.indeterminate, false);
  const v = view({ snapshot: second, index: 1, history: learned, stepStartedAt: 0, processAlive: true, now: 0 });
  assert.ok(Math.abs(v.fraction - 100 / 120) < 1e-9);
  assert.equal(v.remainingSeconds, 20);
});

test('generic: an undeclared plan accumulates the steps seen in this run', () => {
  let snapshot: Snapshot | undefined;
  for (const step of ['Build', 'Test', 'Publish']) {
    snapshot = genericAdapter.read({ schema: SCHEMA, name: 'my-app', state: 'running', step }, empty, snapshot);
  }
  assert.deepEqual(snapshot?.steps.map((s) => s.label), ['Build', 'Test', 'Publish']);
  assert.equal(snapshot?.indeterminate, true);
});

test('a finished run reports elapsed time up to its end, not up to now', () => {
  const done = githubAdapter.read(run({ status: 'completed', conclusion: 'success', jobs: [
    { name: 'publish', status: 'completed', conclusion: 'success', startedAt: '2026-10-25T15:00:05Z', completedAt: '2026-10-25T15:02:25Z' },
  ] }), empty);
  assert.equal(done.endedAt, Date.parse('2026-10-25T15:02:25Z'));
  assert.equal(githubAdapter.read(run({}), empty).endedAt, undefined);
  const finished = generic({ state: 'succeeded', updatedAt: '2026-10-25T16:00:00Z' } as Partial<GenericStatus>);
  assert.equal(finished.endedAt, Date.parse('2026-10-25T16:00:00Z'));
});

test('generic: sub-progress, failure and success', () => {
  const snap = generic({ step: 'Upload', steps: ['Upload'], progress: { done: 3, total: 4, unit: 'files' } });
  const running = renderLines(view({ snapshot: snap, index: 0, history: empty, stepStartedAt: 0, processAlive: true, now: 0 }), 80, 0, plain);
  assert.match(running[1], /75%/);
  assert.match(running[2], /3\/4 files/);
  const failed = renderLines(view({ snapshot: generic({ state: 'failed', step: 'Upload', error: 'npm 403' }), index: 0, history: empty, stepStartedAt: 0, processAlive: true, now: 0 }), 80, 0, plain);
  assert.match(failed[2], /npm 403/);
  const done = view({ snapshot: generic({ state: 'succeeded', step: 'Upload', url: 'https://x' }), index: 0, history: empty, stepStartedAt: 0, processAlive: true, now: 0 });
  assert.equal(done.fraction, 1);
  assert.equal(done.detail, 'https://x');
});

const run = (over: Partial<GhRun>): GhRun => ({
  name: 'Release', workflowName: 'Release', displayTitle: 'v1.0.0', status: 'in_progress', conclusion: '',
  url: 'https://github.com/o/r/actions/runs/42', createdAt: '2026-10-25T15:00:00Z', jobs: [], ...over,
});

test('github: jobs are steps, parallel finished jobs count, running job steps are sub-progress', () => {
  const snapshot = githubAdapter.read(run({
    jobs: [
      { name: 'build', status: 'completed', conclusion: 'success', startedAt: '2026-10-25T15:00:05Z', completedAt: '2026-10-25T15:02:05Z', steps: [] },
      { name: 'lint', status: 'completed', conclusion: 'success', startedAt: '2026-10-25T15:00:05Z', completedAt: '2026-10-25T15:00:35Z', steps: [] },
      { name: 'publish', status: 'in_progress', conclusion: '', startedAt: '2026-10-25T15:02:10Z', steps: [
        { name: 'checkout', status: 'completed', conclusion: 'success' }, { name: 'npm publish', status: 'in_progress', conclusion: '' },
      ] },
    ],
  }), { steps: ['build', 'lint', 'publish', 'announce'], seconds: {} });
  assert.equal(snapshot.title, 'Release · v1.0.0');
  assert.deepEqual(snapshot.steps.map((s) => s.label), ['build', 'lint', 'publish', 'announce']);
  assert.equal(snapshot.phase, 'publish');
  assert.deepEqual(snapshot.sub, { done: 1, total: 2, unit: 'steps' });
  const v = view({ snapshot, index: locateStep(snapshot.phase, snapshot.steps, -1), history: empty, stepStartedAt: 0, processAlive: true, now: 0 });
  assert.ok(Math.abs(v.fraction - (60 + 60 + 30) / 240) < 1e-9);
  assert.deepEqual(githubAdapter.durations?.(run({ jobs: [
    { name: 'build', status: 'completed', conclusion: 'success', startedAt: '2026-10-25T15:00:05Z', completedAt: '2026-10-25T15:02:05Z' },
  ] })), { build: 120 });
  assert.equal(githubAdapter.key(run({})), 'github:o/r:Release');
});

test('github: a failed run names the job and step', () => {
  const snapshot = githubAdapter.read(run({ status: 'completed', conclusion: 'failure', jobs: [
    { name: 'publish', status: 'completed', conclusion: 'failure', steps: [{ name: 'npm publish', status: 'completed', conclusion: 'failure' }] },
  ] }), empty);
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.error, 'publish › npm publish: failure');
});

test('github: run specs', () => {
  assert.deepEqual(parseRunSpec('https://github.com/lennix1337/Genexus18MCP/actions/runs/40207706430/job/1'), { repo: 'lennix1337/Genexus18MCP', id: '40207706430' });
  assert.deepEqual(parseRunSpec('o/r#12'), { repo: 'o/r', id: '12' });
  assert.deepEqual(parseRunSpec('12'), { id: '12' });
  assert.deepEqual(parseRunSpec('o/r'), { repo: 'o/r' });
  assert.deepEqual(parseRunSpec(''), {});
});

test('renderLines keeps every line within the width', () => {
  for (const width of [20, 50, 120]) {
    for (const input of [gxInput({ phase: 'Running complete release preflight' }), { ...gxInput({ phase: 'x' }), snapshot: generic({ step: 'Build' }) }]) {
      const lines = renderLines(view(input), width, 3, plain);
      assert.equal(lines.length, 3);
      for (const line of lines) assert.ok([...line].length <= width, `${width}: ${line}`);
    }
  }
});

test('release-status CLI writes a status the generic adapter reads', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rs-')), 'status.json');
  const cli = (...args: string[]) => execFileSync(process.execPath, ['bin/release-status.mjs', ...args, '--file', file], { encoding: 'utf8' });
  cli('start', 'my-app', '2.0.0', '--steps', 'Build, Publish');
  cli('step', 'Publish', '--done', '1', '--total', '3', '--unit', 'packages');
  let raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(genericAdapter.detect(raw));
  assert.equal(raw.pid, process.pid);
  const snapshot = genericAdapter.read(raw, empty);
  assert.deepEqual(snapshot.steps.map((s) => s.label), ['Build', 'Publish']);
  assert.deepEqual(snapshot.sub, { done: 1, total: 3, unit: 'packages' });
  cli('progress', '3', '3', 'packages');
  cli('succeed', '--url', 'https://example.com/r');
  raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.state, 'succeeded');
  assert.equal(raw.url, 'https://example.com/r');
  assert.throws(() => cli('progress', 'x', '3'), /non-negative number/);
});
