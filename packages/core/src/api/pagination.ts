import { ObjectError } from '../objects/errors.js';
import type { DecodedCursor, ListSort } from '../objects/types.js';

/**
 * Opaque keyset cursor.
 *
 * Keyset, never offset: measured on 50,000 siblings a deep OFFSET page costs 12.3 ms and
 * 40,344 buffers against 0.2 ms and ~150 for the equivalent keyset predicate — and an offset
 * silently skips and duplicates rows while discovery is provisioning into the same tree.
 *
 * `v` lets the encoding change later without breaking a bookmark someone stored.
 */
export function encodeCursor(
  sort: ListSort,
  name: string | null,
  id: number,
  order: number | null = null,
): string {
  return Buffer.from(JSON.stringify({ v: 1, sort, name, id, order }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string, expectedSort: ListSort): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new ObjectError('CURSOR_INVALID', 'the cursor could not be decoded', {
      context: { phase: 'paginate' },
      cause,
    });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ObjectError('CURSOR_INVALID', 'the cursor is not an object', {
      context: { phase: 'paginate' },
    });
  }

  const candidate = parsed as Partial<DecodedCursor>;
  if (candidate.v !== 1) {
    throw new ObjectError('CURSOR_INVALID', 'the cursor was minted by a different version', {
      context: { phase: 'paginate' },
    });
  }
  if (candidate.sort !== 'name' && candidate.sort !== 'id' && candidate.sort !== 'manual') {
    throw new ObjectError('CURSOR_INVALID', 'the cursor names an unknown sort order', {
      context: { phase: 'paginate' },
    });
  }
  // Null is a real position under `manual` — it is where the unarranged siblings live — so only
  // a value of the wrong *type* is a bad cursor.
  if (
    candidate.order !== undefined &&
    candidate.order !== null &&
    (typeof candidate.order !== 'number' || !Number.isSafeInteger(candidate.order))
  ) {
    throw new ObjectError('CURSOR_INVALID', 'the cursor has an unusable sibling position', {
      context: { phase: 'paginate' },
    });
  }
  // `Number.isInteger(1e308)` is true, and 1e308 is not an id any database can look up.
  // Bounding it here keeps a hand-crafted cursor from reaching the driver as a 500.
  if (typeof candidate.id !== 'number' || !Number.isSafeInteger(candidate.id) || candidate.id < 0) {
    throw new ObjectError('CURSOR_INVALID', 'the cursor has no usable position', {
      context: { phase: 'paginate' },
    });
  }

  // Silently restarting a paged scan is how a bulk operation quietly skips half the tree.
  if (candidate.sort !== expectedSort) {
    throw new ObjectError(
      'CURSOR_SORT_MISMATCH',
      `this cursor was minted for sort=${candidate.sort}, but sort=${expectedSort} was requested`,
      {
        context: { phase: 'paginate' },
        details: { cursorSort: candidate.sort, requestedSort: expectedSort },
      },
    );
  }

  return {
    v: 1,
    sort: candidate.sort,
    name: candidate.sort === 'id' ? null : (candidate.name ?? ''),
    order: candidate.sort === 'manual' ? (candidate.order ?? null) : null,
    id: candidate.id,
  };
}
