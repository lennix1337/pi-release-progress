// A GitHub Actions run (`gh run view --json`): each job is a step, the running
// job's own steps are the sub-progress. Covers releases that publish from CI
// (semantic-release, changesets, npm publish workflows...).
import type { Adapter, Step } from '../progress.ts';

export const RUN_FIELDS = 'databaseId,name,displayTitle,workflowName,status,conclusion,url,createdAt,jobs';

interface GhStep { name: string; status: string; conclusion: string }
interface GhJob { name: string; status: string; conclusion: string; startedAt?: string; completedAt?: string; steps?: GhStep[] }
export interface GhRun {
  name?: string;
  workflowName?: string;
  displayTitle?: string;
  status: string;
  conclusion: string;
  url: string;
  createdAt?: string;
  jobs: GhJob[];
}

const time = (iso?: string) => {
  const value = Date.parse(iso ?? '');
  return Number.isFinite(value) && value > 0 ? value : undefined;
};
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);

/** `{repo, id}` from a run URL, `owner/repo#id`, or a bare id (repo from the cwd). */
export function parseRunSpec(spec: string): { repo?: string; id?: string } {
  const url = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/.exec(spec);
  if (url) return { repo: url[1], id: url[2] };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(spec);
  if (short) return { repo: short[1], id: short[2] };
  if (/^\d+$/.test(spec)) return { id: spec };
  return /^[\w.-]+\/[\w.-]+$/.test(spec) ? { repo: spec } : {};
}

export const githubAdapter: Adapter<GhRun> = {
  id: 'github',
  detect: (raw) => Array.isArray(raw.jobs) && typeof raw.url === 'string' && raw.url.includes('/actions/runs/'),
  key: (run) => `github:${/github\.com\/([^/]+\/[^/]+)/.exec(run.url)?.[1] ?? '?'}:${run.workflowName ?? run.name}`,
  read(run, history) {
    const steps: Step[] = run.jobs.map((job) => ({ label: job.name, weight: 60, done: job.status === 'completed', startedAt: time(job.startedAt) }));
    // Jobs that wait on `needs` are absent until they are queued; earlier runs know them.
    for (const label of history.steps ?? []) if (!steps.some((s) => s.label === label)) steps.push({ label, weight: 60 });
    const active = run.jobs.find((job) => job.status === 'in_progress') ?? run.jobs.find((job) => job.status !== 'completed');
    const jobSteps = active?.steps ?? [];
    const failedJob = run.jobs.find((job) => FAILED.has(job.conclusion));
    const failedStep = failedJob?.steps?.find((s) => FAILED.has(s.conclusion));
    const state = run.status !== 'completed' ? 'running' : run.conclusion === 'success' ? 'succeeded' : 'failed';
    const ends = run.jobs.map((job) => time(job.completedAt)).filter((t): t is number => t !== undefined);
    return {
      title: [run.workflowName ?? run.name, run.displayTitle].filter(Boolean).join(' · '),
      state,
      phase: active?.name ?? '',
      steps,
      sub: jobSteps.length ? { done: jobSteps.filter((s) => s.status === 'completed').length, total: jobSteps.length, unit: 'steps' } : undefined,
      error: state === 'failed' ? `${failedJob ? `${failedJob.name}${failedStep ? ` › ${failedStep.name}` : ''}: ` : ''}${run.conclusion}` : undefined,
      url: run.url,
      startedAt: time(run.createdAt),
      endedAt: state !== 'running' && ends.length ? Math.max(...ends) : undefined,
    };
  },
  durations(run) {
    const out: Record<string, number> = {};
    for (const job of run.jobs) {
      const start = time(job.startedAt);
      const end = time(job.completedAt);
      if (start && end && end >= start) out[job.name] = (end - start) / 1000;
    }
    return out;
  },
};
