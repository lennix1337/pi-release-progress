// Manual smoke: loads the real extension with a fake Pi and prints widget frames for
// three sources: a release.ps1-style status file, a generic script driven by the
// release-status CLI, and (with `gh` signed in) a real GitHub Actions run.
// Run: node test/smoke.replay.ts [run-url]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rgbColor } from '@earendil-works/pi-tui';

const dir = mkdtempSync(join(tmpdir(), 'pi-release-smoke-'));
process.env.PI_RELEASE_STATUS_DIRS = dir;
process.env.PI_RELEASE_HISTORY = join(dir, 'history.json');

const { default: extension } = await import('../src/index.ts');
const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
let widget: { render(width: number): string[] } | undefined;
const notes: string[] = [];
const theme = {
  colors: { accent: rgbColor(90, 120, 230), success: rgbColor(130, 220, 110) },
  fg: (_t: string, s: string) => s,
  style: (s: string) => s,
};
const ctx = {
  hasUI: true,
  cwd: process.cwd(),
  ui: {
    setWidget: (_k: string, factory: unknown) => { widget = typeof factory === 'function' ? factory({ requestRender() {} }, theme) : undefined; },
    notify: (m: string) => notes.push(m),
  },
};
extension({
  on: (name: string, h: never) => { handlers[name] = h; },
  registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
} as never);

const frame = (label: string) => console.log(`--- ${label}\n${widget ? widget.render(90).join('\n') : '(no widget)'}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Genexus18MCP release.ps1 status file.
const gxFile = join(dir, 'gx-release-999-status.json');
const gx = (phase: string, state = 'running', extra: object = {}) =>
  writeFileSync(gxFile, JSON.stringify({ version: '9.9.9', tag: 'v9.9.9', repository: 'lennix1337/Genexus18MCP', phase, state, pid: process.pid, publicationState: 'not-started', updatedAtUtc: new Date().toISOString(), ...extra }));
gx('Building (build.ps1)');
handlers.session_start({}, ctx);
frame('gx build');
for (const [phase, extra] of [
  ['Creating GitHub release v9.9.9 (with publish.zip)', {}],
  ['issue-1-closed', { issues: { validated: [1, 2], closed: [1] } }],
  ['complete', { issues: { validated: [1, 2], closed: [1, 2] } }],
] as const) {
  await wait(1200);
  gx(phase, phase === 'complete' ? 'succeeded' : 'running', extra);
  await wait(1200);
  frame(`gx ${phase}`);
}
await command?.('off', ctx);

// 2. Any script, through the CLI: first run has no plan (indeterminate), second run learned it.
const file = join(dir, 'my-app-release-status.json');
const cli = (...args: string[]) => execFileSync(process.execPath, ['bin/release-status.mjs', ...args, '--file', file]);
for (const runNumber of [1, 2]) {
  cli('start', 'my-app', `1.0.${runNumber}`);
  await command?.(file, ctx);
  for (const step of ['Build', 'Test', 'Publish']) {
    cli('step', step);
    await wait(1200);
    frame(`generic run ${runNumber} ${step}`);
  }
  cli('succeed', '--url', 'https://example.com/my-app');
  await wait(1200);
  frame(`generic run ${runNumber} done`);
}
await command?.('off', ctx);

// 3. A GitHub Actions run (read-only `gh run view`).
const runUrl = process.argv[2] ?? 'https://github.com/lennix1337/Genexus18MCP/actions/runs/40207706430';
await command?.(`gh ${runUrl}`, ctx);
frame(`gh ${runUrl}`);

console.log('notes:', notes);
handlers.session_shutdown({}, ctx);
