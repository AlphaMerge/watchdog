import type { ReceivedBatch } from '../contract.js';

/**
 * What a listener sensor's message says about `ReceivedBatch.earlier` (`P-254`), or nothing.
 *
 * On the first scan after a probe restart, or after a cut configuration push took the sensor off
 * the scheduler for a while, the listener hands one interval of what it heard and counts what came
 * before that as `earlier`: not this scan's reading, not a loss. Said in the
 * message so it is not lost silently, and only there, so it moves no channel and no limit. Each
 * is also in Probe Health's received count for its listener.
 */
export function earlierNote(batch: ReceivedBatch, noun: string): string {
  const earlier = batch.earlier ?? 0;
  if (earlier <= 0) return '';
  return (
    `; ${String(earlier)} ${noun} the probe received before ${batch.since} are not in this ` +
    'reading: no scan of this sensor covered that time'
  );
}
