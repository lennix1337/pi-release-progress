// Real-clock integration smoke. Isolated status files, no GitHub or provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { rgbColor } from '@earendil-works/pi-tui';

const removeStatus = process.argv.includes('--remove-status');
const dir = mkdtempSync(join(tmpdir(), 'pi-release-gone-'));
const statusFile = join(dir, 'gx-release-status.json');
process.env.PI_RELEASE_STATUS_DIRS = dir;
process.env.PI_RELEASE_HISTORY = join(dir, 'history.json');
process.env.PI_RELEASE_PROJECTS = dir;
const { createReleaseProgress } = await import('../src/index.ts');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
let widget: { render(width: number): string[] } | undefined;
const notes: string[] = [];
const theme = {
  colors: { accent: rgbColor(90, 120, 230), success: rgbColor(130, 220, 110) },
  fg: (_token: string, text: string) => text,
  style: (text: string) => text,
};
const ctx = {
  hasUI: true,
  cwd: dir,
  ui: {
    setWidget: (_key: string, factory: unknown) => {
      widget = typeof factory === 'function' ? factory({ requestRender() {} }, theme) : undefined;
    },
    notify: (message: string) => notes.push(message),
  },
};
const render = () => widget?.render(90).join('\n') ?? '(no widget)';
createReleaseProgress({
  run: async () => { throw new Error('external commands forbidden in offline smoke'); },
  sleep: async () => {},
})({
  on: (name: string, handler: never) => { handlers[name] = handler; },
  registerCommand() {},
} as never);

try {
  await once(child, 'spawn');
  writeFileSync(statusFile, JSON.stringify({
    version: '9.9.9', phase: 'Building (build.ps1)', state: 'running', pid: child.pid,
    publicationState: 'not-started', startedAtUtc: new Date().toISOString(),
  }));
  handlers.session_start({}, ctx);
  assert.ok(widget, 'live disposable process is discovered');
  assert.doesNotMatch(render(), /process gone/);
  console.log('live process:\n' + render());
  if (removeStatus) rmSync(statusFile);
  const stopped = once(child, 'exit');
  child.kill();
  await stopped;
  await wait(1500);
  assert.match(render(), /process gone/);
  console.log('dead process:\n' + render());
  await wait(58_000);
  assert.ok(widget, 'warning is still visible before 60 seconds');
  await wait(4000);
  assert.equal(widget, undefined, 'warning expires after 60 real seconds');
  await wait(6000);
  assert.equal(widget, undefined, 'discovery must not restore the unchanged status');
  assert.deepEqual(notes, [], 'disappearance is not a release success or failure');
  console.log(`PASS: real-clock dismissal, no rediscovery, no completion notification (status ${removeStatus ? 'removed' : 'retained'})`);
} finally {
  handlers.session_shutdown({}, ctx);
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
  rmSync(dir, { recursive: true, force: true });
}
