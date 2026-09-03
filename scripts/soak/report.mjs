#!/usr/bin/env node
// Turn a soak's samples into a verdict (TASKS.md H-01).
//
//     node scripts/soak/report.mjs soak.jsonl [--markdown]
//
// H-01 asks three questions — no memory growth, no scheduler lag drift, rollups correct
// throughout — and the first two are questions about a *trend*, not about a maximum. A run whose
// memory ended at 400 MB tells you nothing on its own; a run whose memory rose 4 MB an hour for
// twenty-four hours tells you it will fall over in a fortnight.
//
// So each series gets a least-squares slope, and the verdict is on the slope. The comparison of
// the first and last quarters is reported beside it because a slope can be dragged by a single
// spike, and two numbers that disagree are worth seeing rather than averaging.
import { readFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

const path = argv[2];
if (path === undefined) {
  stdout.write('usage: report.mjs <soak.jsonl> [--markdown]\n');
  exit(2);
}
const asMarkdown = argv.includes('--markdown');

/**
 * **Warm-up is dropped, and the window has a floor. Both are methodology, not convenience.**
 *
 * The minutes after five thousand sensors are provisioned are the configuration load, the first
 * scan of everything at once, and a JIT that has not seen the hot path yet. Resident memory in
 * that stretch falls by hundreds of megabytes as the initial allocation is collected. Fitting a
 * line through it and reporting the gradient "per hour" produced −251 MB/h and +2,607 MB/h in the
 * same run, from the same five minutes — numbers that describe a transient and nothing else.
 *
 * The floor is the other half of the same point: a slope per hour taken from a window shorter
 * than an hour is extrapolation, and this reports no verdict at all rather than a confident one
 * drawn from twelve times less evidence than it claims.
 */
const WARMUP_MINUTES = Number(argv.includes('--warmup') ? argv[argv.indexOf('--warmup') + 1] : 15);
const MIN_WINDOW_HOURS = 1;

const lines = readFileSync(path, 'utf8')
  .split('\n')
  .filter((one) => one !== '');
const records = lines.map((one) => JSON.parse(one));
const meta = records.find((one) => one.kind === 'meta') ?? {};
const all = records.filter((one) => one.kind === 'sample');
const samples = all.filter((one) => one.elapsedS >= WARMUP_MINUTES * 60);
const errors = records.filter((one) => one.kind === 'error');

if (samples.length < 4) {
  stdout.write(
    `${String(all.length)} samples in ${path}, ${String(samples.length)} of them past the ` +
      `${String(WARMUP_MINUTES)}-minute warm-up. Nothing to conclude yet.\n`,
  );
  exit(2);
}

/** Least-squares slope of y against elapsed hours, and the mean, for one series. */
function trend(series) {
  const points = series.filter(([, y]) => typeof y === 'number' && Number.isFinite(y));
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let top = 0;
  let bottom = 0;
  for (const [x, y] of points) {
    top += (x - meanX) * (y - meanY);
    bottom += (x - meanX) ** 2;
  }
  const slope = bottom === 0 ? 0 : top / bottom;

  const quarter = Math.max(1, Math.floor(n / 4));
  const firstQuarter = points.slice(0, quarter).reduce((sum, [, y]) => sum + y, 0) / quarter;
  const lastQuarter = points.slice(-quarter).reduce((sum, [, y]) => sum + y, 0) / quarter;

  return {
    n,
    mean: meanY,
    min: Math.min(...points.map(([, y]) => y)),
    max: Math.max(...points.map(([, y]) => y)),
    slopePerHour: slope,
    firstQuarter,
    lastQuarter,
    driftPercent:
      firstQuarter === 0 ? 0 : ((lastQuarter - firstQuarter) / Math.abs(firstQuarter)) * 100,
  };
}

/**
 * The load the run was measured under, taken from the probe rather than from a sensor listing.
 *
 * The first version asked `/objects?kind=sensor&limit=1` for a `total` the endpoint does not
 * have — it is keyset-paginated and answers `{items, nextCursor}` — so every one of the first
 * run's 1,439 samples recorded `sensorCount: null` and the report said "? sensors". A record of a
 * measurement that cannot say what it measured is most of the way to not being a record.
 *
 * `scheduled` is what the probe's wheel actually holds, which is the number that matters and is
 * already in every sample. The median ignores the first sample or two, taken while the core is
 * still pushing the configuration and the wheel is part-filled.
 */
function loadOf(samples) {
  const values = samples
    .map((one) => one.probe?.scheduled)
    .filter((one) => typeof one === 'number')
    .sort((a, b) => a - b);
  if (values.length === 0) return '?';
  return values[Math.floor(values.length / 2)];
}

const hours = (sample) => sample.elapsedS / 3600;
const series = (side, key) => samples.map((one) => [hours(one), one[side]?.[key]]);

const measured = {
  'core RSS (MB)': trend(series('core', 'memory')),
  'core heap (MB)': trend(series('core', 'heap')),
  'probe RSS (MB)': trend(series('probe', 'memory')),
  'scheduler lag p95 (ms)': trend(series('probe', 'schedulerLag')),
  'ingestion queue (readings)': trend(series('core', 'ingestQueue')),
  'rollup lag (s)': trend(series('core', 'rollupLag')),
  'pool in use (%)': trend(series('probe', 'poolUsage')),
  'checks waiting': trend(series('probe', 'queued')),
  // Session pools (`P-36`). `sessionsOpen` is a gauge that should settle, not climb — a probe
  // steadily opening more sessions than it closes is the shape that ends in `EMFILE`, and it is
  // exactly what a long run is for. `sessionOverflows` is cumulative and must simply stay flat:
  // the pools open past their bound rather than fail a check, and doing that on a *simulated*
  // workload with nothing else moving would be a defect rather than a busy afternoon.
  'device sessions held': trend(series('probe', 'sessionsOpen')),
  'session overflows': trend(series('probe', 'sessionOverflows')),
};

const elapsedHours = hours(samples[samples.length - 1]);

// **The thresholds, and why each is where it is.**
//
// **Every check is one-sided.** Only growth is a finding. The first version compared the absolute
// slope, and duly reported FAIL for an ingestion queue that was *draining* — which is the system
// working, described as a fault. A soak that cries wolf on a healthy run is worse than no soak,
// because the next person reads past it.
//
// **Where a channel declares limits, those are the yardstick** (`S-18`). Judging rollup lag
// against 1% of its own mean called +4.6 s/h a failure on a run whose lag never exceeded 226 s
// against a declared warning threshold of 3,600 — stricter than the product's own definition of
// "bad" by a factor of forty. The question an operator actually has is whether the trend takes a
// channel to the threshold it already has, so that is the question this asks: at this slope, is
// the channel still below its declared warning bound after twenty-four hours?
//
// Memory has no declared limits — a footprint is whatever the installation's hardware allows — so
// it keeps a proportional test: 1% of the mean per hour, which over a day is a quarter of the
// footprint. That is growth anybody would call growth, and well above the sawtooth a
// garbage-collected heap produces at a steady workload.
const PROJECT_HOURS = 24;

/** The declared warning bound for the channels that have one, from `ms.*.health`. */
const DECLARED_WARNING = {
  'scheduler lag p95 (ms)': 1000,
  'ingestion queue (readings)': 40_000,
  'rollup lag (s)': 3600,
  'pool in use (%)': 80,
  // `sessionOverflows` errors above 0.5 (`S-18`), which makes the headroom tiny on purpose:
  // this is a counter that should not move at all on a soak, and the budget should say so.
  'session overflows': 0.5,
};

const verdicts = [];

/** Growth this series may show per hour before it is a finding, and the reason in words. */
function budgetFor(name, result) {
  const declared = DECLARED_WARNING[name];
  if (declared !== undefined) {
    // Headroom to the declared bound, spread over a day. Floored so a channel already sitting at
    // its threshold does not get a budget of zero and fail on rounding.
    const headroom = Math.max(declared - result.mean, declared * 0.01);
    return {
      limit: headroom / PROJECT_HOURS,
      why: `reaches ${String(declared)} in ${String(PROJECT_HOURS)} h`,
    };
  }
  return { limit: Math.abs(result.mean) * 0.01, why: '1%/h of the mean' };
}

for (const [name, result] of Object.entries(measured)) {
  if (result === null) {
    verdicts.push({ name, ok: false, detail: 'no data' });
    continue;
  }
  const { limit, why } = budgetFor(name, result);
  const slope = result.slopePerHour;
  // **A series that ended no higher than it started is not drifting upward**, whatever a line
  // fitted through it says. `checks waiting` was above zero in five samples out of 1,439 across
  // the first 24-hour run, spent its whole last quarter at exactly zero, and still produced a
  // positive slope — a least-squares fit dragged by two early spikes. A proportional budget
  // cannot help there either: 1% of a mean of 0.08 is a threshold no real measurement clears.
  // Requiring both signals to agree costs nothing on a genuine leak, where they always do.
  const roseAcrossTheRun = result.lastQuarter > result.firstQuarter;
  const ok = slope <= limit || !roseAcrossTheRun;
  verdicts.push({
    name,
    ok,
    detail:
      `${slope >= 0 ? '+' : ''}${slope.toFixed(3)}/h against +${limit.toFixed(3)} (${why})` +
      (slope < 0 ? ' — falling' : '') +
      (slope > limit && !roseAcrossTheRun ? ' — but ended no higher than it started' : ''),
  });
}

const windowHours = elapsedHours - WARMUP_MINUTES / 60;
const tooShort = windowHours < MIN_WINDOW_HOURS;

/**
 * How much of the run the probe was actually connected for.
 *
 * **A soak across a dropped link measures nothing, and used to say so eight times instead of
 * once.** A run on 2026-09-03 lost its probe eight minutes in — the dev core was restarted
 * underneath it — and every probe series then read "no data", which the report printed as eight
 * separate FAIL lines. "FAIL probe RSS (MB): no data" reads as a memory finding. It was one
 * fact about the run, not eight about the software, and the run had earned no verdict at all.
 *
 * Same shape as the defect `P-32` turned on: an absence reported as a property of the thing
 * measured rather than of the measurement.
 */
const connectedSamples = samples.filter((one) => one.probe?.connected === 1).length;
const connectedFraction = samples.length === 0 ? 0 : connectedSamples / samples.length;
const linkDropped = connectedFraction < 0.99;

const passed = !tooShort && !linkDropped && verdicts.every((one) => one.ok);

if (asMarkdown) {
  stdout.write(`| Series | n | mean | min | max | slope/h | first ¼ → last ¼ |\n`);
  stdout.write(`| --- | --- | --- | --- | --- | --- | --- |\n`);
  for (const [name, result] of Object.entries(measured)) {
    if (result === null) {
      stdout.write(`| ${name} | — | — | — | — | — | — |\n`);
      continue;
    }
    stdout.write(
      `| ${name} | ${String(result.n)} | ${result.mean.toFixed(1)} | ${result.min.toFixed(1)} | ` +
        `${result.max.toFixed(1)} | ${result.slopePerHour >= 0 ? '+' : ''}${result.slopePerHour.toFixed(3)} | ` +
        `${result.firstQuarter.toFixed(1)} → ${result.lastQuarter.toFixed(1)} ` +
        `(${result.driftPercent >= 0 ? '+' : ''}${result.driftPercent.toFixed(1)}%) |\n`,
    );
  }
  stdout.write('\n');
  for (const verdict of verdicts) {
    stdout.write(
      `- ${verdict.ok ? '**pass**' : '**FAIL**'} — ${verdict.name}: ${verdict.detail}\n`,
    );
  }
  if (linkDropped) {
    stdout.write(
      `\n**No verdict**: the probe was connected for ${(connectedFraction * 100).toFixed(0)}% ` +
        `of the run (${String(connectedSamples)} of ${String(samples.length)} samples). Every ` +
        `probe series above is a gap in the sampling, not a measurement of the probe.\n`,
    );
  }
  if (tooShort) {
    stdout.write(
      `\n**No verdict**: ${windowHours.toFixed(2)} h of steady state, against a ` +
        `${String(MIN_WINDOW_HOURS)} h minimum.\n`,
    );
  }
} else {
  stdout.write(
    `soak of ${elapsedHours.toFixed(2)} h · ${String(samples.length)} samples past warm-up ` +
      `(of ${String(all.length)}) · ${String(errors.length)} errors\n`,
  );
  stdout.write(`started ${String(meta.startedAt)} · ${String(loadOf(samples))} sensors\n\n`);
  for (const [name, result] of Object.entries(measured)) {
    if (result === null) continue;
    stdout.write(
      `${name.padEnd(28)} mean ${result.mean.toFixed(1).padStart(8)}  ` +
        `slope ${(result.slopePerHour >= 0 ? '+' : '') + result.slopePerHour.toFixed(3)}/h  ` +
        `¼→¼ ${result.driftPercent >= 0 ? '+' : ''}${result.driftPercent.toFixed(1)}%\n`,
    );
  }
  stdout.write('\n');
  for (const verdict of verdicts) {
    stdout.write(`${verdict.ok ? 'pass' : 'FAIL'}  ${verdict.name}: ${verdict.detail}\n`);
  }
  if (linkDropped) {
    stdout.write(
      `\nNO VERDICT: the probe was connected for ${(connectedFraction * 100).toFixed(0)}% of the ` +
        `run (${String(connectedSamples)} of ${String(samples.length)} samples). The probe series ` +
        `above are gaps in the sampling, not measurements of the probe — read them as "the run ` +
        `lost its link", not as findings.\n`,
    );
  }
  if (tooShort) {
    stdout.write(
      `\nNO VERDICT: ${windowHours.toFixed(2)} h of steady state, and a slope per hour needs at ` +
        `least ${String(MIN_WINDOW_HOURS)}. The pass/fail lines above are what the fit says, not ` +
        `what the run has earned.\n`,
    );
  }
  if (errors.length > 0) {
    stdout.write(
      `\n${String(errors.length)} sampling error(s); first: ${String(errors[0].error)}\n`,
    );
  }
}

// **Three outcomes, not two.** 0 passed, 1 failed, 2 could not conclude — too few samples past
// warm-up, or a window shorter than the minimum. Collapsing "no verdict" into "failed" is how a
// soak that has not run long enough gets read as a soak that found something.
exit(tooShort ? 2 : passed ? 0 : 1);
