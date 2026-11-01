import type { PrLine } from './gitwatch.ts';
import { formatSpan, type ProgressView } from './progress.ts';

/** Colouring hooks; the extension backs them with Pi's theme, the tests with identity functions. */
export interface Paint {
  fg(token: 'accent' | 'success' | 'error' | 'warning' | 'muted' | 'dim', text: string): string;
  bold(text: string): string;
  /** Colour of bar cell `position` (0..1) for a run in `state`. */
  cell(text: string, position: number, state: ProgressView['state']): string;
  /** Trim a styled line to `width` visible columns. */
  fit(line: string, width: number): string;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PARTIALS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function renderBar(view: ProgressView, width: number, paint: Paint, tick = 0): string {
  if (view.indeterminate) {
    // Unknown plan: a block sweeping back and forth shows activity without inventing a percentage.
    const size = Math.max(3, Math.floor(width / 6));
    const span = Math.max(1, width - size);
    const phase = tick % (2 * span);
    const start = phase < span ? phase : 2 * span - phase;
    let out = '';
    for (let i = 0; i < width; i++) out += i >= start && i < start + size ? paint.cell('█', i / Math.max(1, width - 1), view.state) : paint.fg('dim', '░');
    return out;
  }
  const cells = view.fraction * width;
  const full = Math.floor(cells);
  let out = '';
  for (let i = 0; i < width; i++) {
    const position = width > 1 ? i / (width - 1) : 0;
    if (i < full) out += paint.cell('█', position, view.state);
    else if (i === full && view.fraction < 1) out += paint.cell(PARTIALS[Math.floor((cells - full) * 8)], position, view.state);
    else out += paint.fg('dim', '░');
  }
  return out;
}

function badge(view: ProgressView, tick: number, paint: Paint): string {
  switch (view.state) {
    case 'succeeded': return paint.fg('success', view.kind === 'ci' ? '✔ CI passed' : '✔ released');
    case 'failed': return paint.fg('error', view.kind === 'ci' ? '✖ CI failed' : '✖ failed');
    case 'stalled': return paint.fg('warning', '⚠ process gone');
    default: return paint.fg('accent', `${SPINNER[tick % SPINNER.length]} ${view.kind === 'ci' ? 'CI running' : 'releasing'}`);
  }
}

/** Compact widget: title line, bar line, current/next step line. */
export function renderLines(view: ProgressView, width: number, tick: number, paint: Paint, pr?: PrLine): string[] {
  const pct = view.indeterminate ? '' : `${Math.round(view.fraction * 100)}%`.padStart(4);
  const meta = [
    view.state === 'running' && view.remainingSeconds !== undefined ? `~${formatSpan(view.remainingSeconds)} left` : '',
    view.elapsedSeconds !== undefined ? `${formatSpan(view.elapsedSeconds)} elapsed` : '',
  ].filter(Boolean).join(' · ');
  const head = `${paint.bold(view.title)}  ${badge(view, tick, paint)}${meta ? paint.fg('muted', `  ${meta}`) : ''}`;

  const barWidth = Math.max(10, Math.min(60, width - pct.length - 3));
  const bar = `${renderBar(view, barWidth, paint, tick)}${pct ? ` ${paint.bold(pct)}` : ''}`;

  const sub = view.sub ? `  ${view.sub.done}/${view.sub.total}${view.sub.unit ? ` ${view.sub.unit}` : ''}` : '';
  let step: string;
  if (view.state === 'succeeded') step = paint.fg('success', `${view.kind === 'ci' ? 'CI passed' : 'Released'}${sub}`) + (view.detail ? paint.fg('muted', `  ${view.detail}`) : '');
  else if (view.state === 'failed') step = paint.fg('error', `✖ ${view.detail ?? view.currentLabel}`);
  else {
    const position = view.indeterminate ? `step ${view.stepNumber} ` : `${view.stepNumber}/${view.stepCount} `;
    const counter = view.stepNumber > 0 ? paint.fg('muted', position) : '';
    const next = view.nextLabel ? paint.fg('dim', `  → ${view.nextLabel}`) : '';
    step = `${counter}${view.currentLabel}${sub}${next}`;
  }
  const prRow = pr ? paint.fg(pr.tone, pr.text) : undefined;
  return [head, bar, step, ...(prRow ? [prRow] : [])].map((line) => paint.fit(line, width));
}
