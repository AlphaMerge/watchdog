import type {
  ReportFrequency,
  ReportKind,
  ReportRun,
  ReportSchedule,
  ReportSummary,
} from '../api/types';

/**
 * The wording and the arithmetic behind the reports pages (`E-11`).
 *
 * Separate from the components for the reason `discovery-model.ts` gives: every decision here is
 * a judgement that can be wrong without anything failing. A rendering assertion would prove a
 * `<div>` exists; these prove the thing the operator reads — and, in one case below, stop the form
 * offering a setting the core will refuse.
 */

/* --------------------------------------------------------------------- templates */

export const REPORT_KINDS: readonly { id: ReportKind; label: string; note: string }[] = [
  {
    id: 'table_only',
    label: 'Data table',
    note: 'Channel values over the period, per sensor. Renders today.',
  },
  {
    id: 'sensor_list',
    label: 'Sensor list',
    note: 'What the report covers, without the readings. Renders today.',
  },
  { id: 'graph_and_table', label: 'Graph and data table', note: 'Needs the graph renderer.' },
  { id: 'graph_only', label: 'Graph only', note: 'Needs the graph renderer.' },
  { id: 'installation', label: 'Installation report', note: 'Not built yet.' },
  { id: 'top_values', label: 'Top 100 highest or lowest', note: 'Not built yet.' },
  { id: 'top_uptime', label: 'Top 10 or 100 by uptime', note: 'Not built yet.' },
];

/**
 * Whether this template renders anything yet.
 *
 * **Said in the form rather than discovered by running one.** `E-04` renders a data table and
 * nothing else; the graph templates are gated on an ADR and the rest are unwritten. A form that
 * offered all seven as equals would let somebody schedule a monthly report that produces an empty
 * document every month, and the first they would hear of it is a colleague asking where it is.
 */
export function rendersToday(kind: ReportKind): boolean {
  return kind === 'table_only' || kind === 'sensor_list';
}

export function labelOfKind(kind: ReportKind): string {
  return REPORT_KINDS.find((one) => one.id === kind)?.label ?? kind;
}

/* --------------------------------------------------------------------- schedules */

/**
 * Which fields a frequency actually uses.
 *
 * **This is the one piece of logic on these pages that has to be right**, and it mirrors
 * `validateSchedule` on the core rather than guessing: a weekday on a monthly report is refused
 * outright, so a form that offered the control would produce a 400 the operator cannot explain.
 * Offering only what applies is the difference between a form that teaches the rules and one that
 * enforces them by failing.
 */
export function scheduleFields(kind: ReportFrequency): {
  minute: boolean;
  weekday: boolean;
  dayOfMonth: boolean;
  month: boolean;
} {
  return {
    minute: kind !== 'manual',
    weekday: kind === 'weekly',
    dayOfMonth: kind === 'monthly' || kind === 'quarterly' || kind === 'annual',
    month: kind === 'annual',
  };
}

/**
 * A schedule document carrying only the fields its frequency uses.
 *
 * Built by dropping rather than by assembling, so a frequency changed in the form cannot leave a
 * `weekday` behind from the one before it — which is exactly how a form produces a request the
 * core refuses for a field nobody can see any more.
 */
export function scheduleFrom(draft: {
  kind: ReportFrequency;
  minute: number;
  weekday: number;
  dayOfMonth: number;
  month: number;
  timezone: string;
}): ReportSchedule {
  const fields = scheduleFields(draft.kind);
  const zone = draft.timezone.trim();
  return {
    kind: draft.kind,
    ...(fields.minute ? { minute: draft.minute } : {}),
    ...(fields.weekday ? { weekday: draft.weekday } : {}),
    ...(fields.dayOfMonth ? { dayOfMonth: draft.dayOfMonth } : {}),
    ...(fields.month ? { month: draft.month } : {}),
    ...(zone === '' ? {} : { timezone: zone }),
  };
}

/** `02:30` from minutes past midnight, and back. The form edits a clock, the API takes minutes. */
export function clockOf(minute: number): string {
  const hours = Math.floor(minute / 60);
  return `${String(hours).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function minuteOf(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':');
  const total = Number(hours) * 60 + Number(minutes);
  return Number.isFinite(total) ? Math.min(Math.max(Math.trunc(total), 0), 1_439) : 0;
}

/* ------------------------------------------------------------------- what it says */

/**
 * What to say about a report's next run.
 *
 * **A manual report has no next run, and that is not an error.** Showing an empty cell would read
 * as "we do not know"; the honest answer is that nothing will run it. The other silence worth
 * naming is a scheduled report whose next run is null anyway — a `M-09` window that never opens —
 * because that looks identical from here and is a configuration somebody should be told about.
 */
export function nextRunText(report: ReportSummary): string {
  if (report.nextRunAt !== null) return report.nextRunAt;
  return report.schedule.kind === 'manual'
    ? 'only when somebody runs it'
    : 'never — its schedule window never opens';
}

/**
 * Why this report will not run, if it will not.
 *
 * Null when nothing is wrong. **The lost security context comes first** because it stops the
 * report outright, where an unrenderable template or an unresolvable span each stop one run.
 */
export function whyItCannotRun(report: ReportSummary): string | null {
  if (!report.runAs.available) {
    return (
      `This report renders as "${report.runAs.login}", and that account has been deleted or ` +
      'disabled. It will refuse to run until it is pointed at a live account.'
    );
  }
  if (!rendersToday(report.kind)) {
    return `The "${labelOfKind(report.kind)}" template does not render yet, so a run produces nothing.`;
  }
  if (report.unresolvable !== undefined) return report.unresolvable.message;
  return null;
}

/** `4.2 kB`. Bytes, because a stored report is the one thing here measured in them. */
export function sizeText(bytes: number): string {
  if (bytes < 1_000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${String(ms)} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

/**
 * One line describing what a run did, for somebody scanning a list of them.
 *
 * **The period comes first**, because "do we have August" is the question a run history is asked.
 * A failure says its code rather than only "failed": the code is the same one the API answers
 * with, so an operator reading this and an operator reading a 422 are told the same thing.
 */
export function runSummary(run: ReportRun): string {
  if (run.state === 'running') return `${run.spanLabel} — running`;
  if (run.state === 'failed') {
    return `${run.spanLabel} — failed: ${run.errorMessage === '' ? run.errorCode : run.errorMessage}`;
  }
  const covered =
    run.sections === null
      ? ''
      : ` — ${String(run.sections)} sensor${run.sections === 1 ? '' : 's'}`;
  const missing =
    run.unavailable === null || run.unavailable === 0
      ? ''
      : `, ${String(run.unavailable)} not rendered`;
  return `${run.spanLabel}${covered}${missing}`;
}

/**
 * What a run's delivery is doing, or null when it was never going to be delivered.
 *
 * `failed` is terminal and says so: `E-09` re-arms nothing on a timer, so "will not be retried"
 * is the fact an operator has to act on rather than a status that might change on its own.
 */
export function deliveryText(run: ReportRun): string | null {
  switch (run.delivery.state) {
    case 'none':
      return null;
    case 'sent':
      return `delivered${run.delivery.deliveredAt === null ? '' : ` at ${run.delivery.deliveredAt}`}`;
    case 'pending':
      return run.delivery.attempts === 0
        ? 'waiting to be sent'
        : `not sent yet — attempt ${String(run.delivery.attempts)} failed: ${run.delivery.error}`;
    case 'failed':
      return `not delivered after ${String(run.delivery.attempts)} attempt${
        run.delivery.attempts === 1 ? '' : 's'
      } and will not be retried: ${run.delivery.error}`;
  }
}

/** Where a stored output is downloaded from (`E-09`). */
export function downloadPath(run: ReportRun, format: string): string {
  return `/api/v1/reports/${String(run.reportId)}/runs/${String(run.id)}/${format}`;
}

/**
 * Addresses the core will refuse, caught before the request.
 *
 * **A mirror of `validateOutputs`, not a second authority.** The core checks again and its answer
 * is the one that counts; this exists so somebody typing a list of twelve addresses is told which
 * one is wrong while they are still looking at it, rather than being handed one error about the
 * whole field.
 */
export function badRecipients(raw: string): string[] {
  return splitRecipients(raw).filter(
    (address) => !address.includes('@') || /[\s,;<>]/u.test(address),
  );
}

export function splitRecipients(raw: string): string[] {
  return raw
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
