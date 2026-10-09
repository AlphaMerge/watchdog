import { AppError } from '@ms/shared';
import { ROLLUP_TIERS, type RollupTierId } from './tiers.js';

/** Every table a series can be read from, coarsest first. Raw is last because it is finest. */
export type SeriesSource = RollupTierId | 'sample';

const CHAIN: readonly SeriesSource[] = ['sample_1d', 'sample_1h', 'sample_5m', 'sample'];

const DAY_SECONDS = 86_400;

/** Ranges longer than this are refused and shortened (CAPABILITIES.MD §9, WORKFLOW.MD §9). */
export const MAX_RANGE_DAYS = 500;
/** What an over-long range is shortened to. */
export const SHORTENED_RANGE_DAYS = 365;
/** Beyond this, sub-hourly detail is refused — the point PRTG stops serving raw data. */
export const FORCED_AVERAGING_FROM_DAYS = 40;
export const FORCED_AVERAGING_MIN_SECONDS = 3_600;

/**
 * The most buckets one answer may contain.
 *
 * Not a PRTG rule — a bound on the response. The rules above already keep realistic queries near
 * 12,000 buckets (40 days at five minutes, or two days at fifteen seconds), so this only bites
 * on something pathological, and it coarsens rather than truncating: a shorter answer that says
 * so beats a silently clipped one.
 */
export const MAX_BUCKETS = 20_000;

/** Buckets a query with no stated resolution aims for — roughly a graph's worth of pixels. */
export const DEFAULT_BUCKETS = 1_000;

/**
 * Averaging intervals PRTG offers (CAPABILITIES.MD §9): 15/30/60 seconds, 2–60 minutes, 2–24
 * hours. A requested resolution is snapped **up** to one of these, so every bucket in an answer
 * is a width the product actually supports and two clients asking for "about a minute" get the
 * same buckets rather than nearly-aligned ones.
 */
export const ALLOWED_RESOLUTIONS: readonly number[] = [
  15,
  30,
  ...Array.from({ length: 60 }, (_, index) => (index + 1) * 60), // 1..60 minutes
  ...Array.from({ length: 23 }, (_, index) => (index + 2) * 3_600), // 2..24 hours
];

/**
 * What a query rule can change about a request (`P-351`). Computed per request and never stored,
 * so this list is the whole set: `range-shortened` (rule 1, and a report span's own) and
 * `resolution-coarsened` (rules 2 and 3).
 */
export const QUERY_ADJUSTMENT_KINDS = ['range-shortened', 'resolution-coarsened'] as const;
export type QueryAdjustmentKind = (typeof QUERY_ADJUSTMENT_KINDS)[number];

/** `reason` is a sentence for a person, built from the rule's numbers: free text, not a code. */
export type QueryAdjustment =
  | {
      kind: 'range-shortened';
      reason: string;
      requestedDays: number;
      effectiveDays: number;
    }
  | {
      kind: 'resolution-coarsened';
      reason: string;
      requestedSeconds: number;
      effectiveSeconds: number;
    };

/** Compiles only while `QUERY_ADJUSTMENT_KINDS` and the union name the same kinds. */
const adjustmentKindsMatch: [
  Exclude<QueryAdjustmentKind, QueryAdjustment['kind']>,
  Exclude<QueryAdjustment['kind'], QueryAdjustmentKind>,
] extends [never, never]
  ? true
  : never = true;
void adjustmentKindsMatch;

export interface SeriesRequest {
  from: Date;
  to: Date;
  /** Bucket width in seconds. Omitted means "whatever suits the range". */
  resolutionSeconds?: number;
}

export interface QuerySegment {
  table: SeriesSource;
  from: Date;
  to: Date;
}

export interface SeriesPlan {
  from: Date;
  to: Date;
  bucketSeconds: number;
  bucketCount: number;
  /** The coarsest source that satisfies the resolution — where most of the range comes from. */
  source: SeriesSource;
  /** What was changed about the request, and why. Never silent. */
  adjustments: QueryAdjustment[];
}

export class QueryError extends AppError {
  readonly status = 400;
  constructor(message: string, context: Record<string, string | number> = {}) {
    super('QUERY_INVALID', message, { context });
    this.name = 'QueryError';
  }
}

/**
 * Applies PRTG's query rules and picks a source. Pure: no database, no clock.
 *
 * The rules are reproduced rather than invented (WORKFLOW.MD §9). They exist because a
 * monitoring UI that lets someone ask for a year of raw data will be asked for a year of raw
 * data, and the honest answer — a coarser series, with a note saying so — is better than a
 * query that runs for a minute or an answer that quietly covers a different range.
 */
export function planSeries(request: SeriesRequest): SeriesPlan {
  const adjustments: QueryAdjustment[] = [];

  if (!Number.isFinite(request.from.getTime()) || !Number.isFinite(request.to.getTime())) {
    throw new QueryError('from and to must both be valid timestamps');
  }
  if (request.to.getTime() <= request.from.getTime()) {
    throw new QueryError('to must be after from', {
      from: request.from.toISOString(),
      to: request.to.toISOString(),
    });
  }

  let from = request.from;
  const to = request.to;
  let rangeSeconds = (to.getTime() - from.getTime()) / 1_000;

  // Rule 1: over 500 days is shortened to 365, counted back from the end. Keeping the end is
  // what makes it useful — someone asking for "everything" wants the recent part.
  if (rangeSeconds > MAX_RANGE_DAYS * DAY_SECONDS) {
    const requestedDays = rangeSeconds / DAY_SECONDS;
    from = new Date(to.getTime() - SHORTENED_RANGE_DAYS * DAY_SECONDS * 1_000);
    rangeSeconds = SHORTENED_RANGE_DAYS * DAY_SECONDS;
    adjustments.push({
      kind: 'range-shortened',
      reason: `ranges longer than ${String(MAX_RANGE_DAYS)} days are shortened to ${String(SHORTENED_RANGE_DAYS)}`,
      requestedDays: round(requestedDays),
      effectiveDays: SHORTENED_RANGE_DAYS,
    });
  }

  // An explicit resolution is honoured as asked for, snapped only to a supported interval. A
  // default one is additionally steered onto a width a rollup tier can compose, because there
  // is no reason to scan a month of raw readings to answer a question nobody phrased that
  // precisely. Asking for 44-minute buckets over a month still reads raw, and still says so in
  // `source`: an explicit request is a decision, and quietly overruling it would be worse than
  // the scan.
  const explicit = request.resolutionSeconds !== undefined;
  const requested = request.resolutionSeconds ?? Math.ceil(rangeSeconds / DEFAULT_BUCKETS);
  let bucketSeconds = requested;

  // Rule 2: 40 days or more forces hourly averaging or coarser. This is also what keeps such a
  // query off the raw table, which retention has usually emptied that far back anyway.
  if (rangeSeconds >= FORCED_AVERAGING_FROM_DAYS * DAY_SECONDS) {
    bucketSeconds = Math.max(bucketSeconds, FORCED_AVERAGING_MIN_SECONDS);
  }

  const snap = explicit ? snapUp : snapUpComposable;
  bucketSeconds = snap(bucketSeconds);

  // Rule 3, ours: keep the answer a sane size, by coarsening rather than by truncating.
  if (rangeSeconds / bucketSeconds > MAX_BUCKETS) {
    bucketSeconds = snap(Math.ceil(rangeSeconds / MAX_BUCKETS));
  }

  // Reported only when there was a request to change. A default resolution already obeys every
  // rule, so announcing that it was "coarsened" from a number nobody asked for is noise.
  if (explicit && bucketSeconds !== requested) {
    adjustments.push({
      kind: 'resolution-coarsened',
      reason:
        rangeSeconds >= FORCED_AVERAGING_FROM_DAYS * DAY_SECONDS &&
        requested < FORCED_AVERAGING_MIN_SECONDS
          ? `ranges of ${String(FORCED_AVERAGING_FROM_DAYS)} days or more are averaged over at least ${String(FORCED_AVERAGING_MIN_SECONDS / 60)} minutes`
          : 'the requested resolution was rounded up to a supported averaging interval',
      requestedSeconds: requested,
      effectiveSeconds: bucketSeconds,
    });
  }

  // Whole buckets at both ends, so the first and last are not fractions of the ones beside them.
  const size = bucketSeconds * 1_000;
  const alignedFrom = new Date(Math.floor(from.getTime() / size) * size);
  const alignedTo = new Date(Math.ceil(to.getTime() / size) * size);

  return {
    from: alignedFrom,
    to: alignedTo,
    bucketSeconds,
    bucketCount: (alignedTo.getTime() - alignedFrom.getTime()) / size,
    source: sourceFor(bucketSeconds),
    adjustments,
  };
}

/**
 * The coarsest source whose buckets compose exactly into the requested ones.
 *
 * "Compose exactly" is the whole condition: five-minute rows can build a ten-minute bucket but
 * not a seven-minute one, and reading them for a seven-minute bucket would split rows across
 * boundaries that do not exist. Anything that does not divide falls back to raw, which has no
 * boundaries of its own.
 */
export function sourceFor(bucketSeconds: number): SeriesSource {
  for (const tier of [...ROLLUP_TIERS].reverse()) {
    if (bucketSeconds >= tier.bucketSeconds && bucketSeconds % tier.bucketSeconds === 0) {
      return tier.id;
    }
  }
  return 'sample';
}

/**
 * Splits the plan's range across the sources that actually hold it.
 *
 * There is no real-time aggregation here — that was the price of writing the rollups ourselves
 * rather than as continuous aggregates (ADR-001 Decision 4 amendment) — so a tier is only
 * authoritative up to its watermark. Everything after it still lives one tier down, and
 * eventually in raw. Reading the chosen tier alone would silently drop the newest few minutes
 * of a five-minute query, or the newest day of a daily one, which is exactly the window someone
 * looking at a graph cares most about.
 *
 * Segments never overlap, so the union can be summed without double counting.
 */
export function segmentsFor(
  plan: SeriesPlan,
  watermarks: ReadonlyMap<RollupTierId, Date>,
): QuerySegment[] {
  const segments: QuerySegment[] = [];
  let cursor = plan.from.getTime();
  const end = plan.to.getTime();

  for (const table of CHAIN.slice(CHAIN.indexOf(plan.source))) {
    if (cursor >= end) break;

    // Raw is always current; it is the bottom of the chain and has no watermark.
    const limit =
      table === 'sample' ? end : Math.min(end, watermarks.get(table)?.getTime() ?? cursor);
    if (limit <= cursor) continue;

    segments.push({ table, from: new Date(cursor), to: new Date(limit) });
    cursor = limit;
  }

  return segments;
}

/** The smallest supported interval that is at least this wide. */
export function snapUp(seconds: number): number {
  for (const allowed of ALLOWED_RESOLUTIONS) {
    if (allowed >= seconds) return allowed;
  }
  return DAY_SECONDS;
}

/**
 * As `snapUp`, but skipping widths no rollup tier can compose.
 *
 * Most supported intervals are not multiples of five minutes — 44 minutes, 7 minutes — and a
 * bucket that does not divide has to be built from raw. For a default resolution that is a poor
 * trade: 45 minutes answers the same question as 44 and reads a thirtieth of the rows.
 */
export function snapUpComposable(seconds: number): number {
  // Below the finest tier's width nothing but raw can serve it anyway.
  const finest = ROLLUP_TIERS[0]?.bucketSeconds ?? 300;
  if (seconds <= finest) return snapUp(seconds);
  for (const allowed of ALLOWED_RESOLUTIONS) {
    if (allowed >= seconds && sourceFor(allowed) !== 'sample') return allowed;
  }
  return DAY_SECONDS;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
