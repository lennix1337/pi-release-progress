// Genexus18MCP release.ps1 -StatusFile: steps parsed from its `Step "..."` calls,
// sub-phases (issue-649-closed...) mapped to their step, issues closed as sub-progress.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { escapeRegExp, locateStep, type Adapter, type Step } from '../progress.ts';

export interface GxStatus {
  version?: string;
  tag?: string;
  repository?: string;
  phase?: string;
  state?: string;
  pid?: number;
  updatedAtUtc?: string;
  error?: string | null;
  releaseUrl?: string;
  issues?: { validated?: number[]; closed?: number[]; failed?: number[] };
}

const BUMP_PATTERN = /^(Bumping version|Synchronizing release metadata for|Realigning release metadata)/;

// Seconds per step before any measured history. Steps a normal run skips weigh 0.
const DEFAULT_SECONDS: [RegExp, number][] = [
  [/^Building \(build\.ps1\)/, 240],
  [/^Building Nexus IDE VSIX/, 90],
  [/^Running complete release preflight/, 190],
  [/^Checking Release warning baseline/, 30],
  [/^Checking required CI/, 15],
  [/^Packing publish\.zip/, 20],
  [/^Verifying publish\.zip/, 10],
  [/^Pushing main/, 15],
  [/^Creating GitHub release/, 30],
  [/^Verifying GitHub Release and npm publication/, 300],
  [/^Closing released issues/, 60],
  [/^(Verifying existing|Reusing existing tag|Uploading assets to existing)/, 0],
];

// Sub-phases release.ps1 writes between Steps, mapped to the Step they belong to.
const SUB_PHASES: [RegExp, RegExp][] = [
  [/^release-issues-(collected|validated)$/, /^Snapshotting release issues$/],
  [/^artifacts-ready$/, /^Building Nexus IDE VSIX$/],
  [/^tests-skipped$/, /^Running complete release preflight$/],
  [/^release-(assets-reused|assets-uploaded)$/, /^Uploading assets/],
  [/^release-created$/, /^Creating GitHub release/],
  [/^publication-verified$/, /^Verifying GitHub Release and npm publication$/],
  [/^(release-issues-prevalidated|issue-\d+-(commented|closed))$/, /^Closing released issues$/],
];
const CLOSING = /^(release-issues-prevalidated|issue-\d+-(commented|closed)|Closing released issues)$/;

function step(label: string, pattern?: RegExp): Step {
  return {
    label,
    pattern: pattern ?? new RegExp(`^${label.split(/\$\w+/).map(escapeRegExp).join('.+')}$`),
    weight: DEFAULT_SECONDS.find(([p]) => p.test(label))?.[1] ?? 5,
  };
}

/** Ordered Step list of release.ps1, parsed from its `Step "..."` calls. */
export function parseSteps(script: string): Step[] {
  const steps: Step[] = [];
  for (const line of script.split(/\r?\n/)) {
    if (/^\s*Step\s+\$stepLabel\b/.test(line)) {
      steps.push(step('Bumping / synchronizing version', BUMP_PATTERN));
      continue;
    }
    const match = /^\s*Step\s+["'](.+)["']\s*$/.exec(line);
    if (match && !steps.some((s) => s.label === match[1])) steps.push(step(match[1]));
  }
  return steps;
}

/** Fallback when no release.ps1 is found: the Step list of Genexus18MCP v4.0.2. */
export const DEFAULT_STEPS: Step[] = parseSteps([
  'Resolving version', 'Checking release base freshness', 'Snapshotting release issues',
  'Synchronizing release-facing metadata', 'Checking git working tree', '$stepLabel',
  'Committing release source state', 'Validating release metadata parity',
  'Checking required CI on the release source commit', 'Building (build.ps1)', 'Building Nexus IDE VSIX',
  'Running complete release preflight', 'Checking Release warning baseline', 'Validating artefact version stamps',
  'Verifying existing release manifest', 'Writing release manifest', 'Verifying release manifest',
  'Packing publish.zip', 'Verifying publish.zip against the release manifest',
  'Verifying existing tag and source state', 'Reusing existing tag $tag', 'Verifying pre-publication freshness',
  'Tagging $tag', 'Pushing main + $tag to origin', 'Uploading assets to existing GitHub release $tag',
  'Creating GitHub release $tag (with publish.zip)', 'Verifying GitHub Release and npm publication',
  'Closing released issues',
].map((label) => (label === '$stepLabel' ? 'Step $stepLabel' : `Step "${label}"`)).join('\n'));

const parsed = new Map<string, { mtime: number; steps: Step[] }>();

/** Newest release.ps1 of the repository, in its checkout or one of its worktrees. */
function findSteps(repository: string | undefined, projectsRoot: string): Step[] {
  const name = repository?.split('/').pop();
  if (!name) return DEFAULT_STEPS;
  const root = join(projectsRoot, name);
  const candidates = [join(root, 'release.ps1')];
  try {
    for (const entry of readdirSync(join(root, 'worktrees'))) candidates.push(join(root, 'worktrees', entry, 'release.ps1'));
  } catch { /* no worktrees */ }
  const newest = candidates.filter(existsSync).map((file) => ({ file, mtime: statSync(file).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return DEFAULT_STEPS;
  const cached = parsed.get(newest.file);
  if (cached?.mtime === newest.mtime) return cached.steps;
  const steps = parseSteps(readFileSync(newest.file, 'utf8'));
  const result = steps.length ? steps : DEFAULT_STEPS;
  parsed.set(newest.file, { mtime: newest.mtime, steps: result });
  return result;
}

export function locateGx(phase: string, steps: Step[], previous: number): number {
  const direct = locateStep(phase, steps, -1);
  if (direct >= 0) return direct;
  const owner = SUB_PHASES.find(([sub]) => sub.test(phase))?.[1];
  const index = owner ? steps.findIndex((s) => owner.test(s.label)) : -1;
  return index >= 0 ? index : previous;
}

export function gxmcpAdapter(projectsRoot: string): Adapter<GxStatus> {
  return {
    id: 'gxmcp',
    detect: (raw) => typeof raw.phase === 'string' && typeof raw.state === 'string' && 'publicationState' in raw,
    key: (s) => `gxmcp:${s.repository ?? 'release'}`,
    locate: locateGx,
    read(s) {
      const tag = s.tag ?? (s.version ? `v${s.version}` : '?');
      const steps = findSteps(s.repository, projectsRoot).map((st) => ({ ...st, display: st.label.replace(/\$tag\b/g, tag) }));
      const validated = s.issues?.validated?.length ?? 0;
      const closing = CLOSING.test(s.phase ?? '') || s.state === 'succeeded';
      const state = s.state === 'succeeded' || s.state === 'failed' ? s.state : 'running';
      const updated = Date.parse(s.updatedAtUtc ?? '');
      return {
        title: `${s.repository?.split('/').pop() ?? 'release'} ${tag}`,
        state,
        endedAt: state !== 'running' && Number.isFinite(updated) ? updated : undefined,
        phase: s.phase ?? '',
        steps,
        sub: validated && closing ? { done: s.issues?.closed?.length ?? 0, total: validated, unit: 'issues closed' } : undefined,
        pid: s.pid,
        error: s.error ?? undefined,
        url: s.releaseUrl,
        restarted: s.phase === 'starting',
      };
    },
  };
}
