import { useEffect, useRef } from 'react';
import type { Alarm, AlarmKind, AlarmPage, SensorState } from '../api/types';

/**
 * The arithmetic behind the alarm list: where a row is, what it counts as, and when a held return
 * should have ended.
 *
 * Separate from the component because it is pure and tested on its own, and because a module that
 * exports both a component and a plain function cannot Fast Refresh — every edit to the view would
 * drop the hot update and reload the page. The same split as `discovery-model` and
 * `sensor-types-model`.
 */

/**
 * The two steps above a sensor: its device and that device's parent.
 *
 * Not the whole chain. Root and probe are the same for almost every row on a single-probe
 * installation, and repeating them on forty rows turns the part that distinguishes them into
 * noise. The full path is one click away on the detail page.
 *
 * The sensor itself is dropped — its name is already the row's heading.
 */
export function whereSteps(alarm: Alarm): { id: number; name: string }[] {
  return alarm.path
    .map((id, index) => ({ id, name: alarm.pathNames[index] ?? String(id) }))
    .slice(Math.max(0, alarm.path.length - 3), Math.max(0, alarm.path.length - 1));
}

/** The five states `WORKFLOW.MD §7` names, which a row is listed under when it is in one. */
const ALARM_STATES: ReadonlySet<SensorState> = new Set([
  'down',
  'down_partial',
  'down_acknowledged',
  'warning',
  'unusual',
]);

/**
 * Which chip a row counts under: its state when that is an alarm state, and otherwise a held
 * return (`M-18`) — the same rule the core counts by.
 */
export function kindOf(alarm: Alarm): AlarmKind {
  if (ALARM_STATES.has(alarm.state)) return alarm.state;
  return alarm.recovering === null ? alarm.state : 'recovering';
}

/**
 * How long after a hold's end the list asks again.
 *
 * The alarm sweep sleeps until exactly the due time, so the end is usually recorded within
 * milliseconds of `confirmsAt`. The second is for the sweep's own work.
 */
export const CONFIRM_MARGIN_MS = 1_000;

/**
 * How long to wait when a hold on the page has already ended and its row is still there: 2 s,
 * 5 s, then every 15 s.
 *
 * The sweep can be late — a busy core, a database blink — and a list that asked again at once on
 * every such page would ask in a tight loop for as long as the sweep stayed late.
 */
export const PAST_DUE_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000];

export interface ConfirmReload {
  readonly delayMs: number;
  /** Whether the hold it waits for had already ended, by the core's clock. */
  readonly pastDue: boolean;
}

/**
 * When to ask again so that a held return leaves the list as its hold ends (`M-18`), or `null`
 * when nothing on the page is held.
 *
 * **The end of a hold is the one change to this list with no state change behind it**, so nothing
 * on the stream announces it, and the list keeps its own time. **On the core's clock**,
 * `page.now`, because the browser's can be minutes out, and a delay worked out from it would ask
 * long before the hold ended or long after the row should have gone.
 *
 * `pastDueTries` is how many pages in a row have already shown a hold past its end.
 */
export function confirmReload(page: AlarmPage, pastDueTries: number): ConfirmReload | null {
  const now = Date.parse(page.now);
  if (!Number.isFinite(now)) return null;
  let earliest = Infinity;
  for (const alarm of page.items) {
    const confirmsAt = alarm.recovering?.confirmsAt;
    if (confirmsAt === undefined || confirmsAt === null) continue;
    const at = Date.parse(confirmsAt);
    if (Number.isFinite(at) && at < earliest) earliest = at;
  }
  if (earliest === Infinity) return null;

  const until = earliest - now;
  if (until > 0) return { delayMs: until + CONFIRM_MARGIN_MS, pastDue: false };
  const last = PAST_DUE_RETRY_MS.length - 1;
  return {
    delayMs: PAST_DUE_RETRY_MS[Math.min(Math.max(pastDueTries, 0), last)] ?? 15_000,
    pastDue: true,
  };
}

/**
 * Asks again when the first held return on the page should have ended (`M-18`).
 *
 * **Planned once per page, not per render.** The plan is kept with the page it was made for, so
 * a render showing the same page — or StrictMode running the effect twice — schedules the same
 * wait and counts nothing. A page that still shows a hold past its end backs off along
 * `PAST_DUE_RETRY_MS`, and the first page that does not starts the count again.
 */
export function useConfirmReload(page: AlarmPage | null, reload: () => void): void {
  const planned = useRef<{
    page: AlarmPage | null;
    plan: ConfirmReload | null;
    pastDue: number;
  }>({ page: null, plan: null, pastDue: 0 });

  useEffect(() => {
    if (page === null) return;
    const last = planned.current;
    if (last.page !== page) {
      const plan = confirmReload(page, last.pastDue);
      planned.current = { page, plan, pastDue: plan?.pastDue === true ? last.pastDue + 1 : 0 };
    }
    const plan = planned.current.plan;
    if (plan === null) return;
    const handle = window.setTimeout(reload, plan.delayMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [page, reload]);
}
