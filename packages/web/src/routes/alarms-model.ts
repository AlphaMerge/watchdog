import type { Alarm } from '../api/types';

/**
 * The path arithmetic behind an alarm row.
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
