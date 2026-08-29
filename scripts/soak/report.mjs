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
};

const elapsedHours = hours(samples[samples.length - 1]);

// **The thresholds, and why each is where it is.**
//
// Memory: 1% of the mean per hour. Over 24 hours that is a quarter of the footprint, which is
// growth anybody would call growth, and it is well above the sawtooth a garbage-collected heap
// produces at a steady workload.
//
// Scheduler lag: 1% of the *budget* per hour, not of the mean. `P-15` set the budget at 1,000 ms
// p95, so this permits 10 ms an hour — 240 ms over a day, a quarter of the budget. Scaling to the
// mean instead would make a healthy installation running at 5 ms lag fail on a 2 ms rise.
//
// Counters that are supposed to be flat — queue depth, rollup lag — are checked the same way as
// memory, because an installation that is keeping up has no reason for any of them to trend.
const BUDGET_LAG_MS = 1000;
const verdicts = [];
const check = (name, result, limitPerHour, unit) => {
  if (result === null) {
    verdicts.push({ name, ok: false, detail: 'no data' });
    return;
  }
  const ok = Math.abs(result.slopePerHour) <= limitPerHour;
  verdicts.push({
    name,
    ok,
    detail: `${result.slopePerHour >= 0 ? '+' : ''}${result.slopePerHour.toFixed(3)} ${unit}/h against ±${limitPerHour.toFixed(3)}`,
  });
};

for (const [name, key] of [
  ['core RSS (MB)', 'core RSS (MB)'],
  ['core heap (MB)', 'core heap (MB)'],
  ['probe RSS (MB)', 'probe RSS (MB)'],
]) {
  const result = measured[key];
  check(name, result, result === null ? 0 : Math.abs(result.mean) * 0.01, 'MB');
}
check('scheduler lag p95 (ms)', measured['scheduler lag p95 (ms)'], BUDGET_LAG_MS * 0.01, 'ms');
for (const key of ['ingestion queue (readings)', 'rollup lag (s)']) {
  const result = measured[key];
  check(key, result, result === null ? 0 : Math.max(Math.abs(result.mean) * 0.01, 0.5), '');
}

const windowHours = elapsedHours - WARMUP_MINUTES / 60;
const tooShort = windowHours < MIN_WINDOW_HOURS;
const passed = !tooShort && verdicts.every((one) => one.ok);

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
  stdout.write(
    `started ${String(meta.startedAt)} · ${String(samples[0]?.sensorCount ?? '?')} sensors\n\n`,
  );
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

exit(passed ? 0 : 1);
