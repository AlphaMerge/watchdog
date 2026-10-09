import { INVALID_PARAMS } from './invalid-params';

/**
 * The tree's filters (`U-70`): the search, the tag and *Invalid parameters only*, held in the
 * address under the names `GET /objects` gives them, so a filtered tree is a link somebody can
 * send, and reload and *Back* bring it back.
 */
export interface TreeFilters {
  /** As typed: the box shows exactly this, and the request trims it. */
  readonly query: string;
  readonly tag: string;
  readonly invalidParams: boolean;
}

/** The URL parameters, on `/tree` as on `GET /objects`. */
export const QUERY = 'q';
export const TAG = 'tag';

/** The filters an address holds. */
export function filtersOf(params: URLSearchParams): TreeFilters {
  return {
    query: params.get(QUERY) ?? '',
    tag: params.get(TAG) ?? '',
    invalidParams: params.get(INVALID_PARAMS) === 'true',
  };
}

/** One string per set of filters, to tell whether the address has changed them. */
export function filtersKey(filters: TreeFilters): string {
  return JSON.stringify([filters.query, filters.tag, filters.invalidParams]);
}

/**
 * `params` with the filters written into it, each in the same place every time and each left out
 * when it is off or blank, so an unfiltered tree is `/tree` and nothing more. Any other parameter
 * is kept as it was.
 */
export function withFilters(params: URLSearchParams, filters: TreeFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of [QUERY, TAG, INVALID_PARAMS]) next.delete(key);
  if (filters.query.trim() !== '') next.set(QUERY, filters.query);
  if (filters.tag.trim() !== '') next.set(TAG, filters.tag);
  if (filters.invalidParams) next.set(INVALID_PARAMS, 'true');
  return next;
}
