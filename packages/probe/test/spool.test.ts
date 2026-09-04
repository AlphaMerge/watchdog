import { strict as assert } from 'node:assert';
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { ResultSpool } from '../src/spool/spool.js';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ms-spool-'));
  dirs.push(dir);
  return dir;
}

const result = (sensorId: number): CheckResult => ({
  sensorId,
  at: new Date(1_700_000_000_000 + sensorId * 1_000).toISOString(),
  outcome: 'ok',
  message: 'fine',
  durationMs: 2,
  channels: [{ key: 'rtt', value: sensorId }],
});

const openSpool = (dir: string, over: { maxBytes?: number; segmentMaxBytes?: number } = {}) =>
  ResultSpool.open({
    dir,
    logger: silent,
    maxBytes: over.maxBytes ?? 1_000_000,
    segmentMaxBytes: over.segmentMaxBytes ?? 1_000_000,
  });

describe('result spool', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scratch();
  });

  /**
   * **Drain to empty, then write more, and the spool must still hand the new results over.**
   *
   * When a drain catches up completely, the cursor parks at the end of what was then the last
   * segment — there is no next segment to move to, so it stays at that offset. The moment the
   * writer rolls a new segment, `peek` starts at a cursor sitting exactly on a boundary: it
   * consumes nothing from the old segment, and the guard meant to stop an unproductive pass fired
   * *after* the code had already advanced to the new one. From then on `peek` returned an empty
   * batch every time while `pending` climbed into the thousands.
   *
   * The drain reads that as "no work": the link stays up, nothing is logged, nothing is counted,
   * and results accumulate on disk until the spool hits its size cap and starts dropping them.
   * It is not a rare interleaving — it is what happens to every healthy probe the first time it
   * fills a segment after catching up.
   */
  it('still delivers results written after a drain caught up and rolled a segment', async () => {
    // Segments small enough that a handful of results fills one.
    const spool = await openSpool(dir, { segmentMaxBytes: 400 });

    for (let id = 1; id <= 6; id += 1) await spool.append([result(id)]);

    // Drain to empty, exactly as `SpoolDrain` does. This is what parks the cursor.
    const seen: number[] = [];
    const drain = async (): Promise<void> => {
      for (let pass = 0; pass < 200; pass += 1) {
        const batch = await spool.peek(50);
        if (batch.length === 0) return;
        seen.push(...batch.map((one) => one.sensorId));
        await spool.commit();
      }
      assert.fail('the spool never reported itself empty');
    };
    await drain();
    assert.equal(spool.stats().pending, 0, 'the first drain should have emptied the spool');

    // More results arrive, and enough of them to roll a new segment.
    for (let id = 7; id <= 20; id += 1) await spool.append([result(id)]);
    const segments = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'));
    assert.ok(
      segments.length > 1,
      `expected the writer to have rolled a segment, saw ${String(segments.length)}`,
    );

    await drain();

    assert.equal(
      spool.stats().pending,
      0,
      `the spool still reports ${String(spool.stats().pending)} pending — peek is handing back nothing`,
    );
    assert.deepEqual(
      seen,
      Array.from({ length: 20 }, (_, at) => at + 1),
      'every appended result should come back exactly once, in order',
    );
  });

  it('keeps results until they are confirmed', async () => {
    // A lost acknowledgement costs a duplicate write, which the core makes free with its unique
    // index. An optimistic delete costs the reading, which nothing can recover.
    const spool = await openSpool(dir);
    await spool.append([result(1), result(2)]);

    assert.equal((await spool.peek(10)).length, 2);
    assert.equal((await spool.peek(10)).length, 2, 'peeking twice must not consume anything');

    await spool.commit();
    assert.deepEqual(await spool.peek(10), []);
    assert.equal(spool.stats().pending, 0);
    await spool.close();
  });

  it('returns no more than it was asked for, and resumes from there', async () => {
    const spool = await openSpool(dir);
    await spool.append([result(1), result(2), result(3), result(4)]);

    assert.deepEqual(
      (await spool.peek(2)).map((r) => r.sensorId),
      [1, 2],
    );
    await spool.commit();
    assert.deepEqual(
      (await spool.peek(2)).map((r) => r.sensorId),
      [3, 4],
    );
    await spool.commit();
    assert.deepEqual(await spool.peek(2), []);
    await spool.close();
  });

  // ── the property PRTG does not have ─────────────────────────────────────────────────────

  it('survives a restart with everything still pending', async () => {
    const first = await openSpool(dir);
    await first.append([result(1), result(2), result(3)]);
    await first.close();

    const second = await openSpool(dir);
    assert.equal(second.stats().pending, 3, 'PRTG loses all of this on a restart');
    assert.deepEqual(
      (await second.peek(10)).map((r) => r.sensorId),
      [1, 2, 3],
    );
    await second.close();
  });

  it('resumes after a restart from what had already been confirmed', async () => {
    const first = await openSpool(dir);
    await first.append([result(1), result(2), result(3)]);
    await first.peek(2);
    await first.commit();
    await first.close();

    const second = await openSpool(dir);
    assert.equal(second.stats().pending, 1);
    assert.deepEqual(
      (await second.peek(10)).map((r) => r.sensorId),
      [3],
    );
    await second.close();
  });

  it('replays from the start when the cursor is unreadable', async () => {
    // Duplicates are free — the core's unique index makes the write a no-op — so a lost cursor
    // costs bandwidth, never data.
    const first = await openSpool(dir);
    await first.append([result(1), result(2)]);
    await first.peek(2);
    await first.commit();
    await first.close();
    await writeFile(join(dir, 'cursor.json'), 'not json at all', 'utf8');

    const second = await openSpool(dir);
    assert.equal(second.stats().pending, 2, 'better to re-send than to lose');
    await second.close();
  });

  // ── crash safety ────────────────────────────────────────────────────────────────────────

  it('discards a torn record at the tail and counts it', async () => {
    const first = await openSpool(dir);
    await first.append([result(1), result(2)]);
    await first.close();

    // A power cut between the write and its newline.
    const [segment] = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'));
    assert.ok(segment);
    await appendFile(join(dir, segment), '{"sensorId":3,"at":"2026', 'utf8');

    const second = await openSpool(dir);
    const stats = second.stats();
    assert.equal(stats.pending, 2, 'the two complete records are intact');
    assert.equal(stats.corrupt, 1, 'and the torn one is counted, not hidden');

    // The heal is what matters: the next append must land on a clean boundary rather than
    // being concatenated onto half a record.
    await second.append([result(4)]);
    assert.deepEqual(
      (await second.peek(10)).map((r) => r.sensorId),
      [1, 2, 4],
    );
    await second.close();
  });

  it('skips a line that does not parse rather than stalling the drain', async () => {
    const first = await openSpool(dir);
    await first.append([result(1)]);
    await first.close();
    const [segment] = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'));
    assert.ok(segment);
    await appendFile(join(dir, segment), 'this is not json\n', 'utf8');

    const second = await openSpool(dir);
    await second.append([result(2)]);
    assert.deepEqual(
      (await second.peek(10)).map((r) => r.sensorId),
      [1, 2],
      'one bad line must not block every result behind it',
    );
    assert.equal(second.stats().corrupt, 1);
    await second.close();
  });

  // ── bounded, oldest-first, counted ──────────────────────────────────────────────────────

  it('evicts the oldest results when it is full, and counts them', async () => {
    // Small segments so eviction is observable without writing megabytes.
    const spool = await openSpool(dir, { maxBytes: 900, segmentMaxBytes: 300 });
    for (let id = 1; id <= 40; id += 1) await spool.append([result(id)]);

    const stats = spool.stats();
    assert.ok(stats.bytes <= 900 + 300, `spool grew to ${String(stats.bytes)} bytes`);
    assert.ok(stats.dropped > 0, 'nothing was evicted, so the bound did nothing');

    // Oldest-first: what survives is the newest, which is what an operator wants after an
    // outage — the recent history, not the beginning of it.
    const kept = (await spool.peek(100)).map((r) => r.sensorId);
    assert.ok(kept.length > 0);
    assert.equal(kept.at(-1), 40, 'the newest result is always kept');
    assert.ok((kept[0] ?? 0) > 1, 'and the oldest went first');
    await spool.close();
  });

  it('reclaims space as results are confirmed', async () => {
    const spool = await openSpool(dir, { segmentMaxBytes: 300 });
    for (let id = 1; id <= 20; id += 1) await spool.append([result(id)]);
    const before = (await readdir(dir)).filter((name) => name.endsWith('.ndjson')).length;
    assert.ok(before > 1, 'the test needs more than one segment to reclaim');

    for (let round = 0; round < 20; round += 1) {
      if ((await spool.peek(5)).length === 0) break;
      await spool.commit();
    }

    const afterwards = (await readdir(dir)).filter((name) => name.endsWith('.ndjson')).length;
    assert.ok(afterwards < before, 'confirmed segments must be deleted, not just skipped');
    assert.equal(spool.stats().pending, 0);
    await spool.close();
  });

  it('reads across a segment boundary in one batch', async () => {
    const spool = await openSpool(dir, { segmentMaxBytes: 200 });
    for (let id = 1; id <= 10; id += 1) await spool.append([result(id)]);

    assert.deepEqual(
      (await spool.peek(10)).map((r) => r.sensorId),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      'a batch must not be capped by where a segment happened to end',
    );
    await spool.close();
  });

  // ── edges ───────────────────────────────────────────────────────────────────────────────

  it('is empty and harmless before anything is written', async () => {
    const spool = await openSpool(dir);
    assert.deepEqual(spool.stats(), {
      pending: 0,
      bytes: 0,
      segments: 0,
      dropped: 0,
      corrupt: 0,
      unwritten: 0,
    });
    assert.deepEqual(await spool.peek(10), []);
    await spool.commit();
    await spool.close();
  });

  it('counts the results a failed write lost, and still tells the caller', async () => {
    // **`P-78`.** `main.ts` logged the rejection and the readings were gone, counted nowhere —
    // the one thing `CLAUDE.md` forbids outright: never drop without counting. This is the worse
    // of the two ways a reading stops existing, because a spool that cannot be written loses
    // *every* check the probe runs, not the oldest ones, and `spoolDropped` would read a
    // confident zero throughout.
    const spool = await openSpool(dir);
    // The directory out from under it: `#roll` opens the segment file there, so the write fails
    // with ENOENT. Deterministic, and unlike a permissions trick it fails for root too.
    await rm(dir, { recursive: true, force: true });

    await assert.rejects(
      spool.append([result(1), result(2)]),
      'the caller must still see the error — the count is in addition to it, not instead',
    );
    assert.equal(spool.stats().unwritten, 2, 'two results were handed over and two were lost');
    assert.equal(spool.stats().dropped, 0, 'and this is not eviction; the cap did nothing');
  });

  it('keeps counting across writes, and one failure does not poison the next', async () => {
    // The count is cumulative, and the existing guarantee still holds: a rejected append must not
    // reject every later one. Adding a second consumer to that promise chain is exactly the sort
    // of change that could have broken it silently.
    const spool = await openSpool(dir);
    const gone = await scratch();
    const doomed = await openSpool(gone);
    await rm(gone, { recursive: true, force: true });

    await assert.rejects(doomed.append([result(1)]));
    await assert.rejects(doomed.append([result(2), result(3)]));
    assert.equal(doomed.stats().unwritten, 3);

    await spool.append([result(4)]);
    assert.equal(spool.stats().unwritten, 0, 'a healthy spool counts nothing');
    assert.equal((await spool.peek(10)).length, 1, 'and still holds what it was given');
    await spool.close();
  });

  it('ignores an empty append', async () => {
    const spool = await openSpool(dir);
    await spool.append([]);
    assert.equal(spool.stats().segments, 0, 'an empty batch must not roll a segment');
    await spool.close();
  });

  it('writes one line per result, so the file is readable with tail', async () => {
    const spool = await openSpool(dir);
    await spool.append([result(1), result(2)]);
    await spool.close();

    const [segment] = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'));
    assert.ok(segment);
    const lines = (await readFile(join(dir, segment), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0] ?? '{}') as CheckResult).sensorId, 1);
  });
});
