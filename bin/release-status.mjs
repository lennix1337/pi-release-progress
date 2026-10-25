#!/usr/bin/env node
// Writes the pi-release-progress/1 status file, so any release script (bash, PowerShell,
// make, npm scripts...) can drive the Pi widget with one line per step.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const USAGE = `usage: release-status <command> [args] [--file PATH]
  start <name> [version] [--steps "Build,Test,Publish"] [--pid N]
  step <label> [--done N --total M --unit UNIT]
  progress <done> <total> [unit]
  succeed [--url URL]
  fail <message>
File: --file, else $RELEASE_STATUS_FILE, else ${join(tmpdir(), 'pi-release-status.json')}.
pid defaults to the calling process (the script running the release).`;

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`release-status: ${message}\n${USAGE}\n`);
  process.exit(2);
}

const number = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${name} must be a non-negative number, got "${value}"`);
  return n;
};

const { positional: [command, ...args], flags } = parse(process.argv.slice(2));
const file = flags.file ?? process.env.RELEASE_STATUS_FILE ?? join(tmpdir(), 'pi-release-status.json');

let status;
if (command === 'start') {
  if (!args[0]) fail('start needs a name');
  status = {
    schema: 'pi-release-progress/1',
    name: args[0],
    ...(args[1] ? { version: args[1] } : {}),
    state: 'running',
    pid: flags.pid ? number(flags.pid, '--pid') : process.ppid,
    startedAt: new Date().toISOString(),
    ...(flags.steps ? { steps: flags.steps.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  };
} else {
  try { status = JSON.parse(readFileSync(file, 'utf8')); } catch { fail(`no run started in ${file}; call "start" first`); }
  if (command === 'step') {
    if (!args[0]) fail('step needs a label');
    status.step = args[0];
    delete status.progress;
    if (flags.total !== undefined) status.progress = { done: number(flags.done ?? 0, '--done'), total: number(flags.total, '--total'), ...(flags.unit ? { unit: flags.unit } : {}) };
  } else if (command === 'progress') {
    status.progress = { done: number(args[0], 'done'), total: number(args[1], 'total'), ...(args[2] ? { unit: args[2] } : {}) };
  } else if (command === 'succeed') {
    status.state = 'succeeded';
    if (flags.url) status.url = flags.url;
  } else if (command === 'fail') {
    status.state = 'failed';
    status.error = args.join(' ') || 'failed';
  } else {
    fail(command ? `unknown command "${command}"` : 'missing command');
  }
}
status.updatedAt = new Date().toISOString();

// Write then rename, so the widget never reads half a file.
mkdirSync(dirname(file), { recursive: true });
const tmp = `${file}.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
renameSync(tmp, file);
