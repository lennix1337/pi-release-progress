// The open format: any release script, in any language, writes this JSON
// (directly or through bin/release-status.mjs) and gets the widget.
import { locateStep, type Adapter, type Step, type SubProgress } from '../progress.ts';

export const SCHEMA = 'pi-release-progress/1';

export interface GenericStatus {
  schema: typeof SCHEMA;
  /** Project or package being released. */
  name: string;
  version?: string;
  state: 'running' | 'succeeded' | 'failed';
  /** Label of the step running now. */
  step?: string;
  /** Planned steps in order, optionally with expected seconds. Omit them and the plan is learned from earlier runs. */
  steps?: (string | { label: string; weight?: number })[];
  /** Countable progress inside the current step. */
  progress?: SubProgress;
  /** Process doing the release; the widget flags the run as stalled when it dies without finishing. */
  pid?: number;
  /** ISO time the run started; a new value means a new run. */
  startedAt?: string;
  /** ISO time of this write; ends the elapsed clock of a finished run. */
  updatedAt?: string;
  error?: string;
  url?: string;
}

const time = (iso?: string) => {
  const value = Date.parse(iso ?? '');
  return Number.isFinite(value) ? value : undefined;
};

export const genericAdapter: Adapter<GenericStatus> = {
  id: 'generic',
  detect: (raw) => raw.schema === SCHEMA && typeof raw.name === 'string',
  key: (s) => `generic:${s.name}`,
  read(s, history, previous) {
    const declared = s.steps?.map((st): Step => (typeof st === 'string' ? { label: st } : { label: st.label, weight: st.weight }));
    // Without a declared plan, keep the steps already seen in this run, else what earlier runs taught.
    const known = previous?.steps.map((st) => st.label) ?? history.steps ?? [];
    const steps = declared ?? known.map((label): Step => ({ label }));
    const phase = s.step ?? '';
    if (phase && locateStep(phase, steps, -1) < 0) steps.push({ label: phase });
    const state = s.state === 'succeeded' || s.state === 'failed' ? s.state : 'running';
    return {
      title: [s.name, s.version].filter(Boolean).join(' '),
      state,
      phase,
      steps,
      sub: s.progress && s.progress.total > 0 ? s.progress : undefined,
      pid: s.pid,
      error: s.error,
      url: s.url,
      startedAt: time(s.startedAt),
      endedAt: state === 'running' ? undefined : time(s.updatedAt),
      indeterminate: !declared && !history.steps?.length,
    };
  },
};
