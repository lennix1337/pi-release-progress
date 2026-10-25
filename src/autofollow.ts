// Follow CI after `git push`: spot a successful push in a bash tool call, work out which
// GitHub repo and commit it published, and wait for the workflow runs of that commit to appear.
import { resolve } from 'node:path';

/** Runs an external command and resolves with stdout; rejects on failure or timeout. Injected so tests never hit git/gh. */
export type Runner = (file: 'git' | 'gh', args: string[], cwd: string) => Promise<string>;

export interface PushCall {
  /** Directory the push ran in: `cd <dir> &&` / `git -C <dir>`, else the session cwd. */
  dir: string;
}

export interface CiRun {
  id: string;
  status: string;
  workflow?: string;
}

export interface CiRuns {
  repo: string;
  sha: string;
  runs: CiRun[];
}

export interface FindOptions {
  run: Runner;
  sleep: (ms: number) => Promise<void>;
  cancelled: () => boolean;
}

const FIRST_WAIT_MS = 3000;
const RETRY_WAIT_MS = 5000;
const MAX_ATTEMPTS = 12; // ~58 s: the run shows up a few seconds after the push
const SIBLING_WAIT_MS = 3000; // other workflows of the same push register a moment apart
const MAX_CONSECUTIVE_ERRORS = 3;

const ARG = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const PUSH = new RegExp(String.raw`(?:^|[\s;&|(])git((?:\s+(?:-C\s+${ARG}|-c\s+${ARG}|--[\w-]+(?:=${ARG})?))*)\s+push(?=[\s;&|)]|$)`);
const CD = new RegExp(String.raw`(?:^|[;&|(]\s*)cd\s+(?:/d\s+)?(${ARG})`, 'g');
const DASH_C = new RegExp(String.raw`-C\s+(${ARG})`, 'g');

const unquote = (arg: string) => arg.replace(/^(["'])(.*)\1$/, '$2');
/** Git Bash style `/c/dir` is a drive path on Windows. */
const nativePath = (path: string) => (process.platform === 'win32' ? path.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : path);

/** `{dir}` when `command` pushes (not a dry run or a deletion); undefined otherwise. */
export function parsePush(command: string, cwd: string): PushCall | undefined {
  const match = PUSH.exec(command);
  if (!match) return undefined;
  const rest = command.slice(match.index + match[0].length).split(/[;&|\n]/)[0];
  if (/(^|\s)(--dry-run|-n|--delete|-d)(\s|$)/.test(rest)) return undefined;
  let dir = resolve(cwd);
  for (const cd of command.slice(0, match.index).matchAll(CD)) dir = resolve(dir, nativePath(unquote(cd[1])));
  for (const dashC of match[1].matchAll(DASH_C)) dir = resolve(dir, nativePath(unquote(dashC[1])));
  return { dir };
}

/** `owner/repo` for a github.com remote URL (https, ssh, scp-like); undefined for any other host. */
export function parseGithubRemote(url: string): string | undefined {
  const match = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** Remote URL and new commit from `git push` output (`To <url>` and `old..new  branch -> branch`). */
export function parsePushOutput(output: string): { remote?: string; commit?: string } {
  return {
    remote: /^To\s+(\S+)/m.exec(output)?.[1],
    commit: /^[ \t+]*[0-9a-f]{7,40}\.{2,3}([0-9a-f]{7,40})[ \t]+\S+[ \t]+->/m.exec(output)?.[1],
  };
}

function parseRuns(json: string): CiRun[] {
  const list = JSON.parse(json) as { databaseId: number; status: string; workflowName?: string }[];
  if (!Array.isArray(list)) return [];
  return list.filter((run) => run && run.databaseId).map((run) => ({ id: String(run.databaseId), status: String(run.status), workflow: run.workflowName }));
}

/** Incomplete runs first (they are what the user is waiting on), then oldest first. */
const byUrgency = (a: CiRun, b: CiRun) => Number(a.status === 'completed') - Number(b.status === 'completed') || Number(a.id) - Number(b.id);

/**
 * Repo and commit of a push, then the workflow runs of that commit, retrying for about a minute.
 * Resolves undefined when the push is not to github.com, was cancelled, or the commit has no run
 * (a repo without CI). Rejects only when git/gh keep failing, so the caller can tell the user.
 */
export async function findCiRuns(push: PushCall, output: string, options: FindOptions): Promise<CiRuns | undefined> {
  const { run, sleep, cancelled } = options;
  const printed = parsePushOutput(output);
  const remote = printed.remote ?? (await run('git', ['remote', 'get-url', 'origin'], push.dir)).trim();
  const repo = parseGithubRemote(remote);
  if (!repo) return undefined;
  let sha: string;
  try {
    sha = (await run('git', ['rev-parse', '--verify', `${printed.commit ?? 'HEAD'}^{commit}`], push.dir)).trim();
  } catch {
    sha = (await run('git', ['rev-parse', 'HEAD'], push.dir)).trim();
  }
  if (!sha) return undefined;

  const list = async () => parseRuns(await run('gh', ['run', 'list', '-R', repo, '--commit', sha, '--limit', '20', '--json', 'databaseId,status,workflowName'], push.dir));
  let errors = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await sleep(attempt === 0 ? FIRST_WAIT_MS : RETRY_WAIT_MS);
    if (cancelled()) return undefined;
    let runs: CiRun[] = [];
    try {
      runs = await list();
      errors = 0;
    } catch (error) {
      if (++errors >= MAX_CONSECUTIVE_ERRORS) throw error;
    }
    if (!runs.length) continue;
    await sleep(SIBLING_WAIT_MS);
    if (cancelled()) return undefined;
    try {
      const more = await list();
      for (const extra of more) if (!runs.some((known) => known.id === extra.id)) runs.push(extra);
    } catch { /* the first listing is enough */ }
    return { repo, sha, runs: runs.sort(byUrgency) };
  }
  return undefined;
}
