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
 *
 * Said in every failure a scan reaches once it holds its own listener's batch, as well as in a
 * passing scan's message (`P-274`). The listener has already moved the sensor's cursor, so a
 * failure that left it out would lose the count for good. A batch with `undated` always has a
 * full buffer `dropped`, so a type that fails on `dropped` would otherwise never name the much
 * larger number the ring could not date. And a flow sensor that fails on silence after a restart
 * is exactly where `earlier` says the exporter stopped recently rather than long ago.
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

/**
 * Runs a step that can fail for a reason of its own, such as a device name that resolves to
 * nothing, and adds the note to its failure (`P-274`). The step's message comes first and the
 * original error is the cause, so the failure still says what went wrong and where.
 */
export async function withEarlierNote<T>(
  batch: ReceivedBatch,
  noun: string,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const note = earlierNote(batch, noun);
    if (note === '' || !(error instanceof Error)) throw error;
    throw new Error(error.message + note, { cause: error });
  }
}
