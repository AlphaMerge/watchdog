import type { ApiError } from '../api/client';

/**
 * The tree's **invalid parameters** filter (`U-63`): the sensors whose stored parameters their
 * type now refuses (`P-358`), which `GET /objects?invalidParams=true` lists (`P-375`) and Core
 * Health counts as `sensorsWithInvalidParams`. The sentences here, apart from the view.
 *
 * **Every sentence is about the list, never about a sensor.** The listing carries no parameter,
 * path or problem message, and nothing here adds one: why a sensor fails is in the core log and
 * in the 400 an edit of it gets.
 */

/** The URL parameter the filter is held in, on `/tree` as on `GET /objects`. */
export const INVALID_PARAMS = 'invalidParams';

/** Where the list is: the tree, filtered. Core Health's channel links here. */
export const INVALID_PARAMS_PATH = `/tree?${INVALID_PARAMS}=true`;

/**
 * Why the core could not answer with the list, when that is the reason it did not.
 *
 * The core answers 503 `OBJECT_PARAMS_NOT_CHECKED` rather than a partial list until its start-up
 * pass has read every sensor: `checking` while it reads, `stopped` when it ended short and will
 * not finish before the next start. Anything else that went wrong is a failed read like any other,
 * and `null` here.
 */
export function notChecked(error: ApiError): 'checking' | 'stopped' | null {
  if (error.status !== 503 || error.code !== 'OBJECT_PARAMS_NOT_CHECKED') return null;
  // Only `checking` promises that asking again soon will help; anything else is said as the
  // stopped pass is, which promises nothing before the next start.
  return error.details['pass'] === 'checking' ? 'checking' : 'stopped';
}

/** What the filtered list's status region says about why there is no list yet. */
export function notCheckedSentence(pass: 'checking' | 'stopped'): string {
  return pass === 'checking'
    ? 'Stored sensor parameters are still being checked after the core’s start, so which ' +
        'sensors fail is not known yet. Try again shortly.'
    : 'Stored sensor parameters have not been checked since the core last started, so which ' +
        'sensors fail is not known. They are checked again at the next start.';
}

/**
 * What the filtered list's status region says once the core has answered with the list.
 *
 * `more` is a page with another after it, so the count is the first page's and said as a floor.
 * `narrowed` is a search or a tag beside the filter, so an empty answer is about the matches and
 * not every sensor.
 */
export function knownSentence(count: number, more: boolean, narrowed: boolean): string {
  if (count === 0) {
    return narrowed
      ? 'No sensor matching the search has parameters its type now refuses.'
      : 'No sensor you can see has parameters its type now refuses.';
  }
  const among = 'among those you can see.';
  if (more) {
    return `At least ${String(count)} sensors have parameters their type now refuses, ${among}`;
  }
  return count === 1
    ? `1 sensor has parameters its type now refuses, ${among}`
    : `${String(count)} sensors have parameters their type now refuses, ${among}`;
}
