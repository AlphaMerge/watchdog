import type { ReceivedBatch } from '../contract.js';

/**
 * What a listener sensor's message says about `ReceivedBatch.earlier` and `undated` (`P-254`), or
 * nothing.
 *
 * On the first scan after a probe restart, or after a cut configuration push took the sensor off
 * the scheduler for a while, the listener hands one interval of what it heard and counts what came
 * before that as `earlier`: not this scan's reading, not a loss. Said in the
 * message so it is not lost silently, and only there, so it moves no channel and no limit. Each
 * is also in Probe Health's received count for its listener.
 */
export function earlierNote(batch: ReceivedBatch, noun: string): string {
  const earlier = batch.earlier ?? 0;
  const undated = batch.undated ?? 0;
  return (
    (earlier <= 0
      ? ''
      : `; ${String(earlier)} ${noun} the probe received before ${batch.since} are not in this ` +
        'reading: no scan of this sensor covered that time') +
    (undated <= 0
      ? ''
      : `; ${String(undated)} more ${noun} left the probe’s buffer before it could tell when ` +
        'they arrived, so they are neither in this reading nor counted as missed by it — the ' +
        'probe’s overwritten count has them')
  );
}
