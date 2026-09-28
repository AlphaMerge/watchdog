import { strict as assert } from 'node:assert';
import {
  appendFile,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it, type TestContext } from 'node:test';
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
    // Counted when the cursor moves past it, not when it is read (`P-80`). A `peek` is
    // provisional — the drain re-reads the same bytes until the core acknowledges them — so
    // counting at read turned one torn record into a per-second rate during any outage that
    // nacked. Passing it is what makes it definitively unreadable, and passing it is `commit`.
    assert.equal(second.stats().corrupt, 0, 'not yet: this batch is unconfirmed');
    await second.commit();
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

  /** Peeks and commits until the spool hands back nothing, and returns every sensor it saw. */
  async function drainAll(spool: ResultSpool): Promise<number[]> {
    const seen: number[] = [];
    for (let round = 0; round < 50; round += 1) {
      const batch = await spool.peek(100);
      if (batch.length === 0) break;
      seen.push(...batch.map((r) => r.sensorId));
      await spool.commit();
    }
    return seen;
  }

  it('keeps draining when the segment a batch came from is evicted before the ack', async () => {
    // **`P-227`.** The drain peeks, waits for the core, then commits, and appends arrive in
    // between. At the cap, one of them evicts the segment the batch was read from. `commit` put
    // the cursor back on that deleted segment, and from then on every `peek` found nothing: the
    // link up, the probe heartbeating, and not one more result delivered until a restart.
    // About 125 bytes a record: two to a 300-byte segment, and a third segment tips 600.
    const spool = await openSpool(dir, { maxBytes: 600, segmentMaxBytes: 300 });
    for (let id = 1; id <= 4; id += 1) await spool.append([result(id)]);

    assert.deepEqual(
      (await spool.peek(1)).map((r) => r.sensorId),
      [1],
    );
    // While the core is still answering: the spool fills and evicts the oldest segment, [1, 2].
    await spool.append([result(5)]);
    assert.equal(spool.stats().dropped, 1, 'only 2 is dropped; 1 is in flight and may yet arrive');

    await spool.commit();
    assert.deepEqual(await drainAll(spool), [3, 4, 5], 'and the drain carries on after it');
    assert.equal(spool.stats().pending, 0);
    assert.equal(spool.stats().dropped, 1, 'the acknowledged 1 was delivered, not dropped');
    await spool.close();
  });

  it('counts an evicted in-flight result as dropped once its batch is never confirmed', async () => {
    const spool = await openSpool(dir, { maxBytes: 600, segmentMaxBytes: 300 });
    for (let id = 1; id <= 4; id += 1) await spool.append([result(id)]);
    await spool.peek(1);
    await spool.append([result(5)]);

    // The core asked for a retry, so the drain peeks again without committing: 1 is on no disk
    // and was never acknowledged.
    assert.deepEqual(
      (await spool.peek(100)).map((r) => r.sensorId),
      [3, 4, 5],
    );
    assert.equal(spool.stats().dropped, 2, '2 at eviction, and 1 now that its batch is gone');
    await spool.commit();
    assert.equal(spool.stats().pending, 0);
    await spool.close();
  });

  /** The prototype every `FileHandle` shares, so a test can intercept the spool's own writes. */
  async function fileHandlePrototype(): Promise<FileHandle> {
    const handle = await open(join(dir, 'prototype-probe'), 'w');
    await handle.close();
    await rm(join(dir, 'prototype-probe'));
    return Object.getPrototypeOf(handle) as FileHandle;
  }

  /**
   * The next write lands half its bytes and reports it, and the one after fails with ENOSPC: a
   * disk that fills in the middle of a record.
   */
  async function fillDiskMidRecord(t: TestContext): Promise<FileHandle> {
    const prototype = await fileHandlePrototype();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below to the handle it belongs to
    const original = prototype.write;
    const plan: ('short' | 'full')[] = ['short', 'full'];
    t.mock.method(prototype, 'write', function (this: FileHandle, ...args: unknown[]) {
      const step = plan.shift();
      if (step === 'full') {
        return Promise.reject(
          Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }),
        );
      }
      if (step === 'short') {
        const buffer = args[0] as Buffer;
        const from = (args[1] as number | undefined) ?? 0;
        const half = buffer.subarray(from, from + Math.floor((buffer.byteLength - from) / 2));
        return (Reflect.apply(original, this, [half]) as Promise<unknown>).then(() => ({
          bytesWritten: half.byteLength,
          buffer,
        }));
      }
      return Reflect.apply(original, this, args) as Promise<unknown>;
    });
    return prototype;
  }

  it('takes back a record a full disk half-wrote, and counts it as unwritten', async (t) => {
    // **`P-227`.** A write on a filling disk returns a short count rather than an error, and the
    // spool ignored the count. The fragment joined the next record into one unparseable line,
    // two results were lost and counted as crash corruption, and the segment's counted size ran
    // past the file, so once it rolled `peek` waited at its real end for good.
    const spool = await openSpool(dir, { segmentMaxBytes: 300 });
    await spool.append([result(1)]);
    await fillDiskMidRecord(t);
    await assert.rejects(spool.append([result(2)]), /ENOSPC/, 'the caller hears about it');
    t.mock.restoreAll();

    for (let id = 3; id <= 7; id += 1) await spool.append([result(id)]);
    assert.deepEqual(await drainAll(spool), [1, 3, 4, 5, 6, 7], 'everything written arrives');
    const stats = spool.stats();
    assert.equal(stats.unwritten, 1, 'the half-written result is counted as never written');
    assert.equal(stats.corrupt, 0, 'and it tore nothing: the fragment was taken back');
    assert.equal(stats.pending, 0);
    await spool.close();
  });

  it('seals a segment round a fragment it cannot take back, and drains past it', async (t) => {
    const spool = await openSpool(dir, { segmentMaxBytes: 300 });
    await spool.append([result(1)]);
    const prototype = await fillDiskMidRecord(t);
    t.mock.method(prototype, 'truncate', () =>
      Promise.reject(Object.assign(new Error('EIO: i/o error, ftruncate'), { code: 'EIO' })),
    );
    await assert.rejects(spool.append([result(2)]));
    t.mock.restoreAll();

    for (let id = 3; id <= 7; id += 1) await spool.append([result(id)]);
    assert.deepEqual(await drainAll(spool), [1, 3, 4, 5, 6, 7], 'the drain does not stall');
    const stats = spool.stats();
    assert.equal(stats.unwritten, 1);
    assert.equal(stats.corrupt, 1, 'the fragment left behind is one torn record');
    assert.equal(stats.pending, 0);
    await spool.close();
  });

  it('loses nothing to a clock stepped back before a restart', async (t) => {
    // **`P-227`.** Segments were named for `Date.now()`, and `#load` reads them in name order.
    // One rolled after a backward step sorted in front of the cursor's segment on restart, so
    // nothing read it, and the first commit reclaimed it as confirmed: lost, and counted nowhere.
    let clock = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => clock);
    const spool = await openSpool(dir, { segmentMaxBytes: 300 });
    for (let id = 1; id <= 2; id += 1) await spool.append([result(id)]);
    clock -= 3_600_000;
    for (let id = 3; id <= 6; id += 1) await spool.append([result(id)]);
    await spool.close();

    const reopened = await openSpool(dir, { segmentMaxBytes: 300 });
    assert.equal(reopened.stats().pending, 6, 'every result is counted after the restart');
    assert.deepEqual(await drainAll(reopened), [1, 2, 3, 4, 5, 6], 'and delivered, in order');
    assert.equal(reopened.stats().dropped, 0);
    await reopened.close();
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

  it('refuses to write after it is closed, instead of silently succeeding', async () => {
    // **The hole in `P-78`'s own promise.** `#appendNow` wrote with `await this.#handle?.write` —
    // an optional chain — and `close()` sets `#handle = undefined` while leaving `#segments`
    // populated. A later append therefore took the no-roll branch, short-circuited the write to a
    // no-op, incremented `pending` and `bytes` for records on no disk, and RESOLVED. Because it
    // resolved, `P-78`'s counter never fired: `unwritten` stayed 0. Drop without counting, in the
    // ticket written to stop dropping without counting.
    //
    // It is reachable on every shutdown: the spool-drain hook runs first (hooks run in reverse
    // registration order), so `close()` happens while the runners are still settling checks into
    // `spoolResult`.
    const spool = await openSpool(dir);
    await spool.append([result(1)]);
    await spool.close();

    await assert.rejects(spool.append([result(2)]), 'a closed spool must not accept results');
    assert.equal(spool.stats().unwritten, 1, 'and what it refused is counted');

    const reopened = await openSpool(dir);
    assert.equal(reopened.stats().pending, 1, 'only the pre-close result is on disk');
    await reopened.close();
  });

  it('subtracts a line it could not parse, so the spool can still reach empty', async () => {
    // `peek` advanced `consumed` past an unparseable line but counted only parseable ones into
    // `#peeked.records`, and `commit` subtracts `records` from `segment.pending` — while
    // `#countPending` had counted that line at load, because it counts newlines. Every torn line
    // left a permanent +1 residue that nothing could remove.
    //
    // The consequence is three false alarms, not one lost byte: `#reclaim` breaks on
    // `oldest.pending > 0`, so drained segments are never deleted and the spool grows to its cap;
    // `#evict` then reports `spoolDropped` for results that were delivered; and `peek` returning
    // empty while `pending` is non-zero drives the drain's stall detector.
    const spool = await openSpool(dir);
    await spool.append([result(1), result(2)]);
    await spool.close();
    await appendFile(
      join(dir, (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))[0] ?? ''),
      'not json\n',
    );

    const second = await openSpool(dir);
    assert.equal(second.stats().pending, 3, 'the torn line is counted at load');
    const batch = await second.peek(10);
    assert.equal(batch.length, 2, 'and skipped when read');
    await second.commit();

    assert.equal(second.stats().pending, 0, 'a line that will never parse is not still pending');
    assert.deepEqual(await second.peek(10), [], 'and there is nothing left to offer');
    await second.close();
  });

  it('counts one torn record once, however many times the drain re-reads it', async () => {
    // `spoolCorrupt` became a counter channel in `P-79`, which turns it into a rate. But
    // `#corrupt` was incremented inside `peek`, and `peek` re-reads from the cursor until the
    // batch is committed — and the drain does NOT commit on a retryable nack (`queue-full`,
    // `storage-error`, `unavailable`, `shutting-down`). So one torn line during a core outage was
    // re-counted once a second, and the graph showed a sustained rate of unreadable results on a
    // probe that had not crashed since — inverting the exact diagnostic the channel exists for.
    const spool = await openSpool(dir);
    await spool.append([result(1)]);
    await spool.close();
    await appendFile(
      join(dir, (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))[0] ?? ''),
      '{tor\n',
    );

    const second = await openSpool(dir);
    await second.peek(10);
    await second.peek(10);
    await second.peek(10);
    assert.equal(second.stats().corrupt, 0, 're-reading unconfirmed bytes counts nothing');

    await second.commit();
    assert.equal(second.stats().corrupt, 1, 'one torn line, counted once when it was passed');

    await second.peek(10);
    await second.commit();
    assert.equal(second.stats().corrupt, 1, 'and not again afterwards');
    await second.close();
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
