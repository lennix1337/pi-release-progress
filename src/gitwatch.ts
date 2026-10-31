// The pull-request side of a push: pi-gitwatch keeps one state file with every PR it follows,
// so the progress widget can say what the CI run means for the PR instead of only "passed".
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PrLine {
  text: string;
  tone: 'success' | 'error' | 'warning' | 'muted';
}

interface Checks { state?: string; pass?: number; fail?: number; pending?: number; failing?: string[] }
interface Snap { number: number; state?: string; draft?: boolean; mergeState?: string; auto?: boolean; head?: string; checks?: Checks }
export interface GitwatchState { repos?: Record<string, { prs?: number[]; snapshots?: Record<string, Snap> } | undefined> }

export const gitwatchStatePath = () => join(process.env.PI_GITWATCH_DIR ?? join(homedir(), '.pi', 'agent', 'gitwatch'), 'state.json');

export function readGitwatchState(path = gitwatchStatePath()): GitwatchState | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as GitwatchState; } catch { return undefined; }
}

/** One line about the PR whose head is `sha` in `repo`; undefined when gitwatch does not follow it. */
export function prLine(state: GitwatchState | undefined, repo: string, sha: string): PrLine | undefined {
  const snapshots = state?.repos?.[repo]?.snapshots;
  if (!snapshots || !sha) return undefined;
  const pr = Object.values(snapshots).find((s) => s.head && (sha.startsWith(s.head) || s.head.startsWith(sha)));
  if (!pr) return undefined;
  const label = `PR #${pr.number}`;
  if (pr.state === 'MERGED') return { text: `${label} merged`, tone: 'success' };
  if (pr.state === 'CLOSED') return { text: `${label} closed without merging`, tone: 'muted' };
  const c = pr.checks ?? {};
  const counts = `${c.pass ?? 0}✓ ${c.fail ?? 0}✗${c.pending ? ` ${c.pending}…` : ''}`;
  if (c.state === 'fail' || (c.fail ?? 0) > 0) return { text: `${label} · ${counts} · failing: ${(c.failing ?? []).slice(0, 2).join(', ') || 'see checks'}`, tone: 'error' };
  if (pr.draft) return { text: `${label} · draft · ${counts}`, tone: 'muted' };
  if (pr.mergeState === 'DIRTY') return { text: `${label} · ${counts} · merge conflict`, tone: 'error' };
  const next = pr.mergeState === 'CLEAN' && c.state === 'pass'
    ? (pr.auto ? 'auto-merge on' : 'ready to merge — not merged yet')
    : pr.auto ? 'auto-merge waiting' : 'waiting for checks';
  return { text: `${label} · ${counts} · ${next}`, tone: next.startsWith('ready') ? 'warning' : 'muted' };
}
