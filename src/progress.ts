// Pure progress model shared by every release source. No Pi or filesystem imports,
// so the tests drive it with plain objects. Adapters (src/adapters) turn each source's
// status document into a Snapshot; this file turns a Snapshot into a ProgressView.

export interface Step {
  /** Stable name; durations are learned under it. */
  label: string;
  /** Shown instead of `label` when set (for example with the tag filled in). */
  display?: string;
  /** Matches the phase text meaning "this step is running"; default: the label, case-insensitive. */
  pattern?: RegExp;
  /** Expected seconds before any history; 0 for steps a normal run skips. */
  weight?: number;
  /** Set by sources that know it, such as CI jobs that finish out of order. */
  done?: boolean;
  /** Epoch ms the step started, when the source knows it. */
  startedAt?: number;
}

export interface SubProgress { done: number; total: number; unit?: string }

export interface Snapshot {
  title: string;
  state: 'running' | 'succeeded' | 'failed';
  /** Raw text of what is running now; located in `steps` by the adapter. */
  phase: string;
  steps: Step[];
  /** Countable progress inside the current step (issues closed, CI steps done...). */
  sub?: SubProgress;
  pid?: number;
  error?: string;
  url?: string;
  /** Epoch ms the run started, when the source knows it. */
  startedAt?: number;
  /** Epoch ms a finished run ended, when the source knows it. */
  endedAt?: number;
  /** The plan is a guess (first run of an undeclared plan): show activity, not a percentage. */
  indeterminate?: boolean;
  /** The status says a new run started in the same file. */
  restarted?: boolean;
}

/** What earlier runs of the same release taught: step order and seconds per step. */
export interface History { steps?: string[]; seconds: Record<string, number> }

/** One release source format. */
export interface Adapter<Raw = Record<string, unknown>> {
  id: string;
  /** True when a status document is in this adapter's format. */
  detect(raw: Record<string, unknown>): boolean;
  /** History bucket of the run (one per project/workflow). */
  key(raw: Raw): string;
  /** `previous` is the last snapshot of the same run, for sources whose plan grows as steps appear. */
  read(raw: Raw, history: History, previous?: Snapshot): Snapshot;
  /** Index of the step `phase` belongs to; default `locateStep`. */
  locate?(phase: string, steps: Step[], previous: number): number;
  /** Exact step durations, when the source records them; otherwise they are measured live. */
  durations?(raw: Raw): Record<string, number>;
}

export const DEFAULT_WEIGHT = 10;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index of the step whose pattern (or label) matches `phase`; `previous` when none does. */
export function locateStep(phase: string, steps: Step[], previous: number): number {
  const text = phase.trim().toLowerCase();
  const index = steps.findIndex((step) => (step.pattern ? step.pattern.test(phase) : step.label.toLowerCase() === text));
  return index >= 0 ? index : previous;
}

export function stepWeight(step: Step, history: History): number {
  const learned = history.seconds[step.label];
  return Number.isFinite(learned) ? learned : step.weight ?? DEFAULT_WEIGHT;
}

export type RunState = 'running' | 'succeeded' | 'failed' | 'stalled';

export interface ProgressView {
  title: string;
  state: RunState;
  fraction: number;
  indeterminate: boolean;
  stepNumber: number;
  stepCount: number;
  currentLabel: string;
  nextLabel?: string;
  remainingSeconds?: number;
  elapsedSeconds?: number;
  sub?: SubProgress;
  detail?: string;
}

export interface ProgressInput {
  snapshot: Snapshot;
  index: number;
  history: History;
  /** Epoch ms the current step was first seen; used when the step has no `startedAt`. */
  stepStartedAt: number;
  runStartedAt?: number;
  processAlive: boolean;
  now: number;
}

const shown = (step: Step | undefined) => step?.display ?? step?.label ?? '';
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function computeProgress(input: ProgressInput): ProgressView {
  const { snapshot: snap, index, history, now } = input;
  const weights = snap.steps.map((step) => stepWeight(step, history));
  const total = sum(weights) || 1;
  const done = sum(weights.filter((_, i) => snap.steps[i].done ?? i < index));

  const step = snap.steps[index];
  const weight = weights[index] ?? 0;
  let current = 0;
  if (step && !step.done) {
    if (snap.sub && snap.sub.total > 0) current = weight * Math.min(1, snap.sub.done / snap.sub.total);
    else if (weight > 0) {
      // Approach the step weight asymptotically, so an overrun slows down instead of claiming 100%.
      current = weight * (1 - Math.exp((-1.5 * (now - (step.startedAt ?? input.stepStartedAt))) / 1000 / weight));
    }
  }

  let state: RunState = snap.state;
  if (state === 'running' && !input.processAlive) state = 'stalled';
  const indeterminate = state !== 'succeeded' && !!snap.indeterminate;
  const fraction = state === 'succeeded' ? 1 : Math.min(0.99, (done + current) / total);
  const nextStep = snap.steps.slice(index + 1).find((s) => !s.done && stepWeight(s, history) > 0);
  const runStartedAt = snap.startedAt ?? input.runStartedAt;

  return {
    title: snap.title,
    state,
    fraction,
    indeterminate,
    stepNumber: index + 1,
    stepCount: snap.steps.length,
    currentLabel: state === 'succeeded' ? 'Released' : shown(step) || snap.phase || 'starting',
    nextLabel: state === 'running' ? shown(nextStep) || undefined : undefined,
    remainingSeconds: state === 'running' && !indeterminate ? Math.max(0, total - done - current) : undefined,
    elapsedSeconds: runStartedAt ? (now - runStartedAt) / 1000 : undefined,
    sub: snap.sub,
    detail: state === 'failed' ? snap.error ?? `failed at ${snap.phase}` : state === 'succeeded' ? snap.url : undefined,
  };
}

export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Blend a finished step's measured duration into the timing history. */
export function learnTiming(seconds: Record<string, number>, label: string, measured: number): Record<string, number> {
  const previous = seconds[label];
  const value = Number.isFinite(previous) ? previous * 0.5 + measured * 0.5 : measured;
  return { ...seconds, [label]: Math.round(value * 10) / 10 };
}

/** History after a successful run: its step order, and every measured duration blended in. */
export function learnRun(history: History, steps: Step[], measured: Record<string, number>): History {
  let seconds = history.seconds;
  for (const [label, value] of Object.entries(measured)) if (Number.isFinite(value) && value >= 0) seconds = learnTiming(seconds, label, value);
  return { steps: steps.map((step) => step.label), seconds };
}
