import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import type { ResolvedAddress } from '@ms/sensors';
import {
  ANSWER_FILE,
  ANSWER_FILE_FORMAT,
  ANSWER_FILE_MAX_BYTES,
  ANSWER_FILE_VERSION,
  AnswerFile,
  answerFilePath,
  linuxSinceBootMs,
  pid1AgeMs,
  SAVE_EVERY_MS,
  type AnswerFileOptions,
  type SaveCounts,
} from '../src/resolver/answer-file.js';
import {
  ANSWER_MS,
  MAX_ADDRESSES,
  NameResolver,
  STALE_MS,
  type Family,
  type KeptAnswer,
  type NameResolverOptions,
} from '../src/resolver/name-resolver.js';
import {
  FakeCore,
  generateCerts,
  opensslAvailable,
  startProbe,
  type RunningProbe,
} from './support/probe-process.js';
import { pollWithin, within } from './support/within.js';

/**
 * The probe's answer file (`P-438`): the answers its resolver keeps, written at stop and every
 * minute and loaded before the first scan, so that a probe restarted in the middle of a zone's
 * outage serves the names it had while it asks again.
 *
 * Two clocks, moved by hand together: the resolver's monotonic one, which a new process starts
 * again near zero, and the wall clock the file is written in. `getaddrinfo` is replaced by lookups
 * the test settles, as in `name-resolver.test.ts`.
 */

const silent = pino({ level: 'silent' });
/** A wall clock well away from zero, so that a time read on the wrong clock is seen. */
const WALL = Date.UTC(2026, 9, 18, 12, 0, 0);

const A: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];
const B: readonly ResolvedAddress[] = [{ address: '192.0.2.11', family: 4 }];

interface Call {
  readonly host: string;
  readonly answer: (addresses?: readonly ResolvedAddress[]) => void;
}

/** A resolver over hand-settled lookups, with a monotonic clock and a wall clock moved together. */
function make(
  options: Partial<NameResolverOptions> & { readonly mono?: number; readonly wall?: number } = {},
) {
  const { mono, wall, ...rest } = options;
  const calls: Call[] = [];
  const clock = { now: mono ?? 0, wall: wall ?? WALL };
  const resolver = new NameResolver({
    logger: silent,
    lookup: (host) =>
      new Promise((resolve) => {
        calls.push({
          host,
          answer: (addresses = A) => {
            resolve(addresses);
          },
        });
      }),
    now: () => clock.now,
    random: () => 0.5,
    // A lookup left unanswered is given up on soon, so a test that leaves one ends soon.
    stuckMs: 40,
    watch: { files: [], everyMs: 60_000 },
    ...rest,
  });
  const callsFor = (host: string): Call[] => calls.filter((call) => call.host === host);
  const ask = (host: string, family: Family = 4): Promise<readonly ResolvedAddress[]> =>
    resolver.resolve(host, family, {});
  const tick = (ms: number): void => {
    clock.now += ms;
    clock.wall += ms;
  };
  /** Asks for a name and answers the lookup it starts. */
  const answered = async (host: string, addresses: readonly ResolvedAddress[] = A) => {
    const asked = ask(host);
    await settled();
    const call = callsFor(host).at(-1);
    assert.ok(call !== undefined, `a lookup for ${host} was made`);
    call.answer(addresses);
    assert.deepEqual(await asked, addresses);
  };
  return { resolver, calls, callsFor, clock, ask, tick, answered };
}
type Made = ReturnType<typeof make>;

/** Every reaction to a settled lookup has run. */
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Whether a promise has settled yet, without waiting for it. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await settled();
  return done;
}

/** A logger whose lines the test reads. */
function captured() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
}

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ms-answers-'));
  dirs.push(dir);
  return dir;
}

/**
 * The answer file of `made`'s resolver at `path`, on its wall clock, and with no boot known unless
 * `options` gives one, so that what a file says of its age is the wall clock's alone.
 */
function fileFor(made: Made, path: string, options: Partial<AnswerFileOptions> = {}): AnswerFile {
  return new AnswerFile({
    path,
    resolver: made.resolver,
    logger: silent,
    wallNow: () => made.clock.wall,
    bootId: () => Promise.resolve(undefined),
    ...options,
  });
}

/**
 * A boot as a test says it: its id, the system's monotonic clock, and how long ago it began, or
 * `null` where that cannot be told.
 */
function boot(id: string, monotonic: number, since: number | null = monotonic) {
  const clocks = { id, monotonic, sinceBootMs: since ?? undefined };
  return {
    clocks,
    options: {
      bootId: () => Promise.resolve(clocks.id),
      monotonicNow: () => clocks.monotonic,
      sinceBootMs: () => Promise.resolve(clocks.sinceBootMs),
    } satisfies Partial<AnswerFileOptions>,
  };
}

/** A hosts file giving `text`, and an nsswitch.conf saying `hosts`, in a directory of their own. */
function hostsAndOrder(text: string, hosts = 'hosts: files dns\n') {
  const dir = scratch();
  const files = [join(dir, 'hosts'), join(dir, 'nsswitch.conf')] as const;
  writeFileSync(files[0], text);
  writeFileSync(files[1], hosts);
  return { dir, files: [...files], nsswitch: files[1] };
}

interface SavedFile {
  readonly format: string;
  readonly version: number;
  readonly writtenAt: number;
  readonly answers: readonly {
    readonly name: string;
    readonly family: number;
    readonly answeredAt: number;
    readonly expiresAt: number;
    readonly addresses: readonly string[];
  }[];
}
const readSaved = (path: string): SavedFile => JSON.parse(readFileSync(path, 'utf8')) as SavedFile;

/** One answer as the file holds it, answered `at` on the wall clock and kept the usual 30 s. */
const line = (name: string, at: number, addresses: readonly string[] = ['192.0.2.10']) => ({
  name,
  family: 4,
  answeredAt: at,
  expiresAt: at + ANSWER_MS,
  addresses,
});

/** A file as the probe writes it, from its parts, at mode 0600. */
function writeAnswers(
  path: string,
  writtenAt: number,
  answers: readonly unknown[],
  more: Record<string, unknown> = {},
): void {
  writeFileSync(
    path,
    JSON.stringify({
      format: ANSWER_FILE_FORMAT,
      version: ANSWER_FILE_VERSION,
      answers,
      writtenAt,
      ...more,
    }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

describe('the probe’s answer file (`P-438`)', () => {
  it('lives in the probe’s spool directory, beside its identity', () => {
    assert.equal(
      answerFilePath('/var/lib/ms-probe/spool'),
      '/var/lib/ms-probe/spool/name-answers.json',
    );
    assert.equal(ANSWER_FILE, 'name-answers.json');
    assert.equal(SAVE_EVERY_MS, 60_000);
    assert.equal(ANSWER_FILE_MAX_BYTES, 4 * 1024 * 1024);
  });

  describe('writing', () => {
    it('writes each answer kept, most recently asked first, with its times on the wall clock, at 0600', async () => {
      const path = join(scratch(), ANSWER_FILE);
      const made = make({ mono: 1_000 });
      await made.answered('a.test', A);
      made.tick(5_000);
      await made.answered('b.test', B);
      made.tick(1_000);
      // Asked again from what is kept: the most recently asked now.
      assert.deepEqual(await made.ask('a.test'), A);
      made.tick(2_000);
      const saved = await fileFor(made, path).save();
      assert.deepEqual(saved, { saved: 2, dropped: 0, bytes: statSync(path).size });
      assert.deepEqual(readSaved(path), {
        format: 'ms-probe-name-answers',
        version: 1,
        answers: [line('a.test', WALL), line('b.test', WALL + 5_000, ['192.0.2.11'])],
        writtenAt: WALL + 8_000,
      });
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(existsSync(`${path}.tmp`), false, 'renamed, not left beside it');
    });

    it('leaves out a name with nothing kept, one past its grace, and one the hosts file gives', async () => {
      const { dir, files } = hostsAndOrder('192.0.2.50 local.test\n');
      const path = join(dir, ANSWER_FILE);
      const made = make({ watch: { files, everyMs: 60_000 } });
      await made.resolver.checkFiles();
      await made.answered('over.test');
      made.tick(1);
      await made.answered('edge.test');
      // `over.test`'s grace ends now, and `edge.test`'s a millisecond from now.
      made.tick(ANSWER_MS + STALE_MS - 1);
      await made.answered('local.test');
      await made.answered('kept.test');
      // Asked, and not answered yet.
      made.ask('pending.test').catch(() => undefined);
      await settled();
      await fileFor(made, path).save();
      assert.deepEqual(
        readSaved(path).answers.map((one) => one.name),
        ['kept.test', 'edge.test'],
      );
    });

    it('keeps a name the hosts file gives only for another family than the one asked, or after DNS', async () => {
      // `P-438`'s review (L5): `getaddrinfo` answers these from DNS, as any other name.
      const { dir, files, nsswitch } = hostsAndOrder('192.0.2.50 local.test\n');
      const path = join(dir, ANSWER_FILE);
      const made = make({ watch: { files, everyMs: 60_000 } });
      await made.resolver.checkFiles();
      const six: readonly ResolvedAddress[] = [{ address: '2001:db8::50', family: 6 }];
      const asked = made.resolver.resolve('local.test', 6, {});
      await settled();
      made.callsFor('local.test').at(-1)?.answer(six);
      assert.deepEqual(await asked, six);
      await made.answered('local.test');
      const saved = async (): Promise<[string, number][]> => {
        await fileFor(made, path).save();
        return readSaved(path).answers.map((one) => [one.name, one.family]);
      };
      assert.deepEqual(await saved(), [['local.test', 6]], 'the file gives it for IPv4 only');
      writeFileSync(nsswitch, 'hosts: dns files\n');
      assert.equal(await made.resolver.checkFiles(), true);
      assert.deepEqual(
        await saved(),
        [
          ['local.test', 4],
          ['local.test', 6],
        ],
        'DNS is asked before the file',
      );
    });

    it('leaves out a name forgotten while its answers are being taken', async () => {
      const made = make({ maxEntries: 3 });
      await made.answered('a.test');
      await made.answered('b.test');
      await made.answered('c.test');
      const source = made.resolver.answersToSave();
      assert.deepEqual(
        source.take(1).map((one) => one.host),
        ['c.test'],
      );
      // A fourth name: the least recently asked is forgotten, after the first slice was taken.
      await made.answered('d.test');
      assert.deepEqual(
        source.take(10).map((one) => one.host),
        ['b.test'],
      );
    });

    it('keeps the file within its bound, the most recently asked kept', async () => {
      const path = join(scratch(), ANSWER_FILE);
      const made = make();
      for (const name of ['n1.test', 'n2.test', 'n3.test', 'n4.test', 'n5.test']) {
        await made.answered(name);
      }
      // Room for three lines of the same length beside the envelope.
      const size = Buffer.byteLength(JSON.stringify(line('n1.test', WALL))) + 2;
      const maxBytes = 256 + 3 * size;
      const saved = await fileFor(made, path, { maxBytes }).save();
      assert.ok(saved !== undefined);
      assert.equal(saved.saved, 3);
      assert.equal(saved.dropped, 2);
      assert.ok(
        statSync(path).size <= maxBytes,
        `${String(statSync(path).size)} > ${String(maxBytes)}`,
      );
      assert.deepEqual(
        readSaved(path).answers.map((one) => one.name),
        ['n5.test', 'n4.test', 'n3.test'],
      );
      // And a file the probe wrote within its bound is one it reads.
      const next = make();
      assert.equal(await fileFor(next, path, { maxBytes }).load(), 3);
    });

    it('takes a slice at a time, letting the event loop run between slices', async () => {
      // A write between slices lets it run too, so here nothing fits and nothing is written: what
      // lets it run is the turn the file gives it.
      const path = join(scratch(), ANSWER_FILE);
      const all: KeptAnswer[] = Array.from({ length: 1_200 }, (_, at) => ({
        host: `n${String(at)}.test`,
        family: 4,
        addresses: A,
        answeredAgoMs: 1_000,
        expiresInMs: ANSWER_MS - 1_000,
      }));
      const events: string[] = [];
      let at = 0;
      const file = new AnswerFile({
        path,
        logger: silent,
        wallNow: () => WALL,
        maxBytes: 256,
        resolver: {
          answersToSave: () => ({
            take: (count) => {
              events.push(`take ${String(count)}`);
              if (at === 0) {
                setImmediate(() => {
                  events.push('a turn of the event loop');
                });
              }
              const slice = all.slice(at, at + count);
              at += slice.length;
              return slice;
            },
          }),
          restore: () => Promise.reject(new Error('not loaded here')),
        },
      });
      const saved = await file.save();
      assert.deepEqual(saved, { saved: 0, dropped: 1_200, bytes: statSync(path).size });
      assert.deepEqual(events, [
        'take 500',
        'a turn of the event loop',
        'take 500',
        'take 500',
        'take 500',
      ]);
      assert.equal(readSaved(path).answers.length, 0);
    });

    it('makes its temporary file anew, at 0600 whatever the umask, and renames it over the last', async () => {
      const path = join(scratch(), ANSWER_FILE);
      const made = make();
      await made.answered('a.test');
      // What a write cut short by a crash leaves, and a mode the probe never writes.
      writeFileSync(`${path}.tmp`, 'a write cut short', { mode: 0o644 });
      const umask = process.umask(0o777);
      let saved: SaveCounts | undefined;
      try {
        saved = await fileFor(made, path).save();
      } finally {
        process.umask(umask);
      }
      assert.equal(saved?.saved, 1);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(existsSync(`${path}.tmp`), false);
      assert.deepEqual(
        readSaved(path).answers.map((one) => one.name),
        ['a.test'],
      );
    });

    it('keeps the file before it when a write fails, and says so in one line', async () => {
      const path = join(scratch(), ANSWER_FILE);
      const made = make();
      const { logger, lines } = captured();
      const file = fileFor(made, path, { logger });
      await made.answered('a.test');
      await file.save();
      const before = readFileSync(path);
      // A temporary file that cannot be made: the write fails before the last file is touched.
      mkdirSync(`${path}.tmp`);
      await made.answered('b.test');
      assert.equal(await file.save('periodic'), undefined);
      assert.deepEqual(readFileSync(path), before);
      const failed = lines.filter((one) => one['level'] === 40);
      assert.equal(failed.length, 1);
      assert.equal(
        failed[0]?.['msg'],
        'the probe’s answer file could not be written: the one before it stays',
      );
      assert.equal(failed[0]['when'], 'periodic');
      // And the next write, once it can, writes.
      rmSync(`${path}.tmp`, { recursive: true });
      assert.equal((await file.save())?.saved, 2);
    });

    it('writes every minute and at stop, never two at once, and not again once stopped', async (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const path = join(scratch(), ANSWER_FILE);
      const made = make();
      await made.answered('a.test');
      let writes = 0;
      const { logger, lines } = captured();
      const file = new AnswerFile({
        path,
        logger,
        wallNow: () => made.clock.wall,
        resolver: {
          answersToSave: () => {
            writes += 1;
            return made.resolver.answersToSave();
          },
          restore: (answers) => made.resolver.restore(answers),
        },
      });
      file.start();
      t.mock.timers.tick(SAVE_EVERY_MS - 1);
      await settled();
      assert.equal(writes, 0, 'nothing written before a minute');
      t.mock.timers.tick(1);
      // A minute more while that write is still under way: skipped, not queued behind it.
      t.mock.timers.tick(SAVE_EVERY_MS);
      assert.equal((await file.stop())?.saved, 1);
      assert.equal(writes, 2, 'the minute’s write and the one at stop');
      t.mock.timers.tick(SAVE_EVERY_MS * 3);
      await settled();
      assert.equal(writes, 2, 'nothing written once stopped');
      // The minute's write says nothing above debug; the one at stop says what it wrote.
      const said = lines.filter(
        (one) => one['msg'] === 'the probe’s resolver saved the answers it keeps',
      );
      assert.deepEqual(
        said.map((one) => [one['when'], one['level']]),
        [
          ['periodic', 20],
          ['stop', 30],
        ],
      );
    });
  });

  describe('loading', () => {
    it('loads before the first check, each answer served at once while it is asked again', async () => {
      const path = join(scratch(), ANSWER_FILE);
      const before = make({ mono: 50_000 });
      await before.answered('a.test', A);
      await before.answered('b.test', B);
      before.tick(10_000);
      await fileFor(before, path).save();
      // A new process 5 s later: its monotonic clock starts again, and both answers have 15 s left.
      const restarted = make({ mono: 0, wall: before.clock.wall + 5_000 });
      const { logger, lines } = captured();
      const file = fileFor(restarted, path, { logger });
      assert.equal(await file.load(), 2);
      assert.equal(file.loaded(), 2);
      const loaded = lines.filter((one) => one['level'] === 30);
      assert.equal(loaded.length, 1);
      assert.equal(
        loaded[0]?.['msg'],
        'the probe’s resolver loaded the answers it kept before it stopped: each is served while it is asked again',
      );
      assert.equal(loaded[0]['loaded'], 2);
      assert.equal(loaded[0]['writtenAgoMs'], 5_000);
      // Its ages on this process's clock, and expired now, whatever was left of it.
      assert.deepEqual(
        restarted.resolver
          .answersToSave()
          .take(10)
          .map((one) => [one.host, one.answeredAgoMs, one.expiresInMs]),
        [
          ['b.test', 15_000, 0],
          ['a.test', 15_000, 0],
        ],
      );
      // Served at once, with no lookup answered, and asked again behind it.
      const asked = restarted.ask('a.test');
      assert.equal(await isSettled(asked), true);
      assert.deepEqual(await asked, A);
      assert.equal(restarted.callsFor('a.test').length, 1, 'a refresh asks again');
      restarted.callsFor('a.test')[0]?.answer(B);
      await settled();
      assert.deepEqual(await restarted.ask('a.test'), B);
      assert.equal(restarted.callsFor('a.test').length, 1);
    });

    it('serves a loaded answer within its grace from its own expiry, and never past it', async () => {
      const path = join(scratch(), ANSWER_FILE);
      writeAnswers(path, WALL + 10_000, [
        line('late.test', WALL),
        line('fresh.test', WALL + 10_000),
      ]);
      /** A probe started at `wall` from the file, its clock then moved `ms`, asked for `name`. */
      const servedAfter = async (wall: number, ms: number, name: string): Promise<boolean> => {
        const started = make({ wall });
        await fileFor(started, path).load();
        started.tick(ms);
        const asked = started.ask(name);
        const served = await isSettled(asked);
        if (served) assert.deepEqual(await asked, A);
        else assert.equal(started.callsFor(name).length, 1, 'asked for the first time');
        return served;
      };
      // Started 100 s after it was answered: expired 70 s ago, so its grace ends in 230 s.
      assert.equal(await servedAfter(WALL + 100_000, 230_000 - 1, 'late.test'), true);
      assert.equal(await servedAfter(WALL + 100_000, 230_000, 'late.test'), false);
      // Started with 25 s of it left: expired at the start, so its grace ends 300 s from then, not
      // 325 s.
      assert.equal(await servedAfter(WALL + 15_000, STALE_MS - 1, 'fresh.test'), true);
      assert.equal(await servedAfter(WALL + 15_000, STALE_MS, 'fresh.test'), false);
    });

    it('does not load an answer whose grace is over, and loads the rest', async () => {
      const path = join(scratch(), ANSWER_FILE);
      writeAnswers(path, WALL + 1, [line('edge.test', WALL + 1), line('over.test', WALL)]);
      const made = make({ wall: WALL + ANSWER_MS + STALE_MS });
      const { logger, lines } = captured();
      assert.equal(await fileFor(made, path, { logger }).load(), 1);
      assert.equal(lines[0]?.['pastGrace'], 1);
      assert.equal(await isSettled(made.ask('edge.test')), true);
      assert.equal(await isSettled(made.ask('over.test')), false);
    });

    it('loads none of a file written in the future: the clock has gone back since', async () => {
      const path = join(scratch(), ANSWER_FILE);
      writeAnswers(path, WALL, [line('a.test', WALL)]);
      const behind = make({ wall: WALL - 1 });
      const { logger, lines } = captured();
      assert.equal(await fileFor(behind, path, { logger }).load(), 0);
      assert.equal(lines.length, 1);
      assert.match(
        String(lines[0]?.['why']),
        /^it was written 1 ms in the future: the clock has gone back/,
      );
      assert.equal(behind.resolver.stats().entries, 0);
      // Written at the clock's own time is not the future.
      assert.equal(await fileFor(make({ wall: WALL }), path).load(), 1);
    });

    it('does not load a name the hosts file gives now, for the family asked, when it is read before DNS', async () => {
      const { dir, files, nsswitch } = hostsAndOrder(
        '# moved here while the probe was stopped\n192.0.2.50 local.test\n',
      );
      const path = join(dir, ANSWER_FILE);
      const six = { ...line('local.test', WALL, ['2001:db8::50']), family: 6 };
      writeAnswers(path, WALL, [line('local.test', WALL), six, line('kept.test', WALL)]);
      const made = make({ watch: { files, everyMs: 60_000 } });
      const { logger, lines } = captured();
      assert.equal(await fileFor(made, path, { logger }).load(), 2, 'kept.test, and IPv6 for it');
      assert.equal(lines[0]?.['hostsFile'], 1);
      // `getaddrinfo` is asked, and reads the file first.
      assert.equal(await isSettled(made.ask('local.test')), false);
      assert.equal(made.callsFor('local.test').length, 1);
      // DNS asked before the file: the file's name is DNS's too.
      writeFileSync(nsswitch, 'hosts: dns files\n');
      assert.equal(await fileFor(make({ watch: { files, everyMs: 60_000 } }), path).load(), 3);
    });

    it('ages a file written since this boot by the monotonic clock, whatever the wall clock did since', async () => {
      // `P-438`'s review (AF-3): the wall clock alone is all a file from another boot has.
      const path = join(scratch(), ANSWER_FILE);
      const before = make({ mono: 50_000 });
      await before.answered('a.test', A);
      before.tick(10_000);
      const { clocks, options } = boot('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 7_000_000);
      await fileFor(before, path, options).save();
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      assert.equal(saved['bootId'], clocks.id);
      assert.equal(saved['monotonicAt'], 7_000_000);
      /** Restarted with the wall clock `wall` from when it was written, `ms` later on the system's. */
      const restartedAt = async (ms: number, wall: number) => {
        clocks.monotonic = 7_000_000 + ms;
        const restarted = make({ mono: 0, wall: before.clock.wall + wall });
        const { logger, lines } = captured();
        const loaded = await fileFor(restarted, path, { ...options, logger }).load();
        const ages = restarted.resolver
          .answersToSave()
          .take(10)
          .map((one) => one.answeredAgoMs);
        return { loaded, said: lines[0] ?? {}, ages };
      };
      const back = await restartedAt(5_000, -3_600_000);
      assert.equal(
        back.loaded,
        1,
        'the wall clock put back an hour since: not a file from the future',
      );
      assert.equal(back.said['writtenAgoMs'], 5_000);
      assert.deepEqual(back.ages, [15_000]);
      const ahead = await restartedAt(5_000, 60_000);
      assert.equal(ahead.said['writtenAgoMs'], 60_000, 'the wall clock’s, when it says longer');
      assert.deepEqual(ahead.ages, [70_000]);
      const earlier = await restartedAt(-1, 0);
      assert.equal(earlier.loaded, 0);
      assert.match(
        String(earlier.said['why']),
        /^it says it was written later in this boot than now, which the probe never writes$/,
      );
    });

    it('loads none of a file written before this boot when the wall clock says it was written since: the clock was put back at the boot', async () => {
      const path = join(scratch(), ANSWER_FILE);
      writeAnswers(path, WALL, [line('a.test', WALL)], {
        bootId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
        monotonicAt: 7_000_000,
      });
      // This boot began 40 s ago, at 500 s on its monotonic clock.
      const { options } = boot('9a8b7c6d-5e4f-3021-1203-4f5e6d7c8b9a', 500, 40_000);
      const { logger, lines } = captured();
      const behind = make({ wall: WALL + 30_000 });
      assert.equal(await fileFor(behind, path, { ...options, logger }).load(), 0);
      assert.equal(lines.length, 1);
      assert.match(
        String(lines[0]?.['why']),
        /^it was written before this boot, 40 s ago, and the clock says 30 s ago: the clock was put back at the boot, and how long the probe was off cannot be told$/,
      );
      assert.equal(behind.resolver.stats().entries, 0);
      const { logger: after, lines: said } = captured();
      const later = make({ wall: WALL + 40_000 });
      assert.equal(await fileFor(later, path, { ...options, logger: after }).load(), 1);
      assert.equal(said[0]?.['writtenAgoMs'], 40_000, 'by the wall clock, as long ago as the boot');
    });

    it('times another boot from PID 1’s start where that is later than the kernel’s, as in a container that boots with a boot id of its own (P-438’s narrow check)', async () => {
      // systemd-nspawn, or LXC without lxcfs: a new boot id at each of the container's boots, and
      // the host's /proc/uptime. The probe stopped, its container rebooted, and it starts again
      // 25 s after its last write, 10 s into the container's boot, on a host up for 20 days.
      const path = join(scratch(), ANSWER_FILE);
      writeAnswers(path, WALL, [line('a.test', WALL)], {
        bootId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
        monotonicAt: 7_000_000,
      });
      const hostUp = 20 * 86_400_000;
      /** /proc's texts, PID 1 started `pid1AgoMs` ago on a kernel up for `hostUp`. */
      const proc = (pid1AgoMs: number) => (file: string) =>
        Promise.resolve(
          file === '/proc/uptime'
            ? `${(hostUp / 1000).toFixed(2)} 9.00\n`
            : `1 (systemd) S 0 1 1 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 ${String(
                Math.round((hostUp - pid1AgoMs) / 10),
              )} 1 2\n`,
        );
      const sinceBoot = await linuxSinceBootMs(proc(10_000), () => hostUp);
      assert.equal(sinceBoot, 10_000, 'PID 1’s age, not the host’s 20 days');
      const loadAt = async (sinceBootMs: number | undefined) => {
        const { options } = boot('9a8b7c6d-5e4f-3021-1203-4f5e6d7c8b9a', 500, sinceBootMs ?? null);
        const { logger, lines } = captured();
        const loaded = await fileFor(make({ wall: WALL + 25_000 }), path, {
          ...options,
          logger,
        }).load();
        return { loaded, said: lines[0] ?? {} };
      };
      const container = await loadAt(sinceBoot);
      assert.equal(container.loaded, 1);
      assert.equal(container.said['writtenAgoMs'], 25_000);
      // Timed by the host's uptime, as before: refused, saying the clock was put back.
      const host = await loadAt(hostUp);
      assert.equal(host.loaded, 0);
      assert.match(String(host.said['why']), /the clock was put back at the boot/u);
      // On a host: PID 1 started a second into the boot, and the time since it is the kernel's
      // less that second.
      assert.equal(await linuxSinceBootMs(proc(hostUp - 1_000), () => hostUp), hostUp - 1_000);
    });

    it('ages a file from another boot by the wall clock alone where PID 1 cannot be read, never in the future (P-438’s narrow check)', async () => {
      // `ProtectProc=invisible`: /proc/1 is not there for the probe's user. Then nothing says how
      // long ago the boot was, and the file is aged as one with no boot known.
      const hidden = (file: string): Promise<string> =>
        file === '/proc/uptime'
          ? Promise.resolve('1728000.00 9.00\n')
          : Promise.reject(Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }));
      assert.equal(await linuxSinceBootMs(hidden, () => 1_728_000_000), undefined);
      const path = join(scratch(), ANSWER_FILE);
      writeAnswers(path, WALL, [line('a.test', WALL)], {
        bootId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
        monotonicAt: 7_000_000,
      });
      const { options } = boot('9a8b7c6d-5e4f-3021-1203-4f5e6d7c8b9a', 500, null);
      const { logger, lines } = captured();
      assert.equal(
        await fileFor(make({ wall: WALL + 25_000 }), path, { ...options, logger }).load(),
        1,
      );
      assert.equal(lines[0]?.['writtenAgoMs'], 25_000);
      const { logger: future, lines: said } = captured();
      assert.equal(
        await fileFor(make({ wall: WALL - 1_000 }), path, { ...options, logger: future }).load(),
        0,
      );
      assert.match(String(said[0]?.['why']), /^it was written 1000 ms in the future/u);
    });

    it('reads PID 1’s age from /proc as Linux writes it: its start counted after the last parenthesis (P-438’s narrow check)', async () => {
      // A command name may hold blanks and parentheses: the fields are counted from the last.
      const stat =
        '1 (sys (temd) x) S 0 1 1 0 -1 4194560 100 200 3 4 5 6 7 8 20 0 1 0 2500 168 2 18446744073709551615\n';
      assert.equal(pid1AgeMs('1000.50 2000.00\n', stat), 975_500);
      assert.equal(pid1AgeMs('', stat), undefined, 'no uptime');
      assert.equal(pid1AgeMs('-1.00 2.00\n', stat), undefined, 'not an uptime');
      assert.equal(pid1AgeMs('1000.50 2000.00\n', '1 systemd S 0'), undefined, 'no name');
      assert.equal(pid1AgeMs('1000.50 2000.00\n', '1 (systemd) S 0 1'), undefined, 'cut short');
      // lxcfs gives a container its own /proc/uptime, and PID 1's start is the kernel's: the
      // uptime is the container's already.
      const lxcfs = (file: string): Promise<string> =>
        Promise.resolve(file === '/proc/uptime' ? '20.00 9.00\n' : stat);
      assert.equal(await linuxSinceBootMs(lxcfs, () => 20_000), 20_000);
      if (process.platform === 'linux') {
        const real = await linuxSinceBootMs();
        if (real !== undefined) {
          assert.ok(real >= 0 && real <= uptime() * 1000 + 1_000, String(real));
        }
      } else {
        assert.equal(await linuxSinceBootMs(), undefined);
      }
    });

    it('writes this boot’s id and the system’s monotonic clock where Linux gives one, and reads them back', async () => {
      const path = join(scratch(), ANSWER_FILE);
      const made = make();
      await made.answered('a.test');
      const file = new AnswerFile({
        path,
        resolver: made.resolver,
        logger: silent,
        wallNow: () => made.clock.wall,
      });
      await file.save();
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (process.platform === 'linux') {
        assert.equal(
          saved['bootId'],
          readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        );
        assert.ok(Number.isSafeInteger(saved['monotonicAt']));
      } else {
        assert.equal(saved['bootId'], undefined);
        assert.equal(saved['monotonicAt'], undefined);
      }
      const restarted = make({ mono: 0 });
      assert.equal(
        await new AnswerFile({
          path,
          resolver: restarted.resolver,
          logger: silent,
          wallNow: () => restarted.clock.wall,
        }).load(),
        1,
      );
    });

    it('does not keep a name it keeps already, one given twice, any over its bound, or one it cannot use', async () => {
      const made = make({ maxEntries: 3 });
      await made.answered('kept.test');
      const kept = (host: string): KeptAnswer => ({
        host,
        family: 4,
        addresses: B,
        answeredAgoMs: 1_000,
        expiresInMs: ANSWER_MS - 1_000,
      });
      const counts = await made.resolver.restore([
        kept('kept.test'),
        kept('Dup.test'),
        kept('dup.test'),
        kept('n1.test'),
        kept('n2.test'),
        kept('n3.test'),
        kept(''),
        kept('192.0.2.1'),
        { ...kept('none.test'), addresses: [] },
        {
          ...kept('many.test'),
          addresses: Array.from({ length: MAX_ADDRESSES + 1 }, (_, at) => ({
            address: `192.0.2.${String(at + 1)}`,
            family: 4,
          })),
        },
      ]);
      assert.deepEqual(counts, {
        loaded: 2,
        pastGrace: 0,
        hostsFile: 0,
        duplicate: 2,
        overCap: 2,
        invalid: 4,
      });
      // The file's order is kept: most recently asked first, ahead of what was asked before.
      assert.deepEqual(
        made.resolver
          .answersToSave()
          .take(10)
          .map((one) => one.host),
        ['dup.test', 'n1.test', 'kept.test'],
      );
      assert.deepEqual(await made.ask('kept.test'), A, 'what it kept already is not replaced');
    });

    it('counts each saved answer it cannot use, and loads the rest', async () => {
      const path = join(scratch(), ANSWER_FILE);
      const valid = line('ok.test', WALL - ANSWER_MS);
      const cases: [string, unknown][] = [
        ['not an object', 'ok.test'],
        ['null', null],
        ['a list', [valid]],
        ['no name', { ...valid, name: undefined }],
        ['an empty name', { ...valid, name: '' }],
        ['a blank name', { ...valid, name: '  ' }],
        ['a name too long', { ...valid, name: `${'a'.repeat(1_020)}.test` }],
        ['an address for a name', { ...valid, name: '192.0.2.1' }],
        ['an IPv6 address for a name', { ...valid, name: '2001:db8::1' }],
        ['a family that is none', { ...valid, family: 5 }],
        ['a family as text', { ...valid, family: '4' }],
        ['a time that is not whole', { ...valid, answeredAt: WALL - 0.5 }],
        ['a time as text', { ...valid, answeredAt: String(WALL) }],
        ['no expiry', { ...valid, expiresAt: null }],
        ['an expiry that is not whole', { ...valid, expiresAt: WALL + 0.5 }],
        ['answered after the file was written', line('late.test', WALL + 1)],
        ['expiring before it was answered', { ...valid, expiresAt: valid.answeredAt - 1 }],
        [
          'kept longer than an answer is',
          { ...valid, expiresAt: valid.answeredAt + ANSWER_MS + 1 },
        ],
        ['no addresses', { ...valid, addresses: undefined }],
        ['an empty list of addresses', { ...valid, addresses: [] }],
        [
          'too many addresses',
          {
            ...valid,
            addresses: Array.from(
              { length: MAX_ADDRESSES + 1 },
              (_, at) => `192.0.2.${String(at + 1)}`,
            ),
          },
        ],
        ['an address that is a number', { ...valid, addresses: [7] }],
        ['an address that is a name', { ...valid, addresses: ['host.test'] }],
        ['an IPv6 address for IPv4', { ...valid, addresses: ['2001:db8::1'] }],
        ['an IPv4 address for IPv6', { ...valid, family: 6, addresses: ['192.0.2.1'] }],
      ];
      for (const [what, raw] of cases) {
        writeAnswers(path, WALL, [raw, valid]);
        const made = make();
        const { logger, lines } = captured();
        assert.equal(await fileFor(made, path, { logger }).load(), 1, what);
        assert.equal(lines[0]?.['invalid'], 1, what);
      }
      // What it can use, at each edge: any family's addresses for family 0, answered as the file
      // was written, expiring as it was answered, and kept exactly as long as an answer is.
      writeAnswers(path, WALL, [
        { ...valid, name: 'any.test', family: 0, addresses: ['192.0.2.10', '2001:db8::10'] },
        { ...valid, name: 'now.test', answeredAt: WALL, expiresAt: WALL },
        { ...valid, name: 'six.test', family: 6, addresses: ['2001:db8::10'] },
        { ...valid, name: `${'a'.repeat(1_019)}.test` },
        valid,
      ]);
      assert.equal(await fileFor(make(), path).load(), 5);
    });

    it('never throws, and loads nothing when the resolver cannot take what it read', async () => {
      const path = join(scratch(), ANSWER_FILE);
      writeAnswers(path, WALL, [line('a.test', WALL)]);
      const { logger, lines } = captured();
      const file = new AnswerFile({
        path,
        logger,
        wallNow: () => WALL,
        resolver: {
          answersToSave: () => ({ take: () => [] }),
          restore: () => Promise.reject(new Error('the hosts file could not be read')),
        },
      });
      assert.equal(await file.load(), 0);
      assert.equal(file.loaded(), 0);
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.['level'], 40);
      assert.match(
        String(lines[0]['msg']),
        /^the probe’s answer file was not used: it could not be read/,
      );
    });
  });

  describe('a file it does not use: one line, and a cold start', () => {
    /** Loads `path` into a new resolver: what it loaded, the one line it logged, and the resolver. */
    async function loadOnce(path: string, options: Partial<AnswerFileOptions> = {}) {
      const made = make();
      const { logger, lines } = captured();
      const file = fileFor(made, path, { logger, ...options });
      const loaded = await file.load();
      assert.equal(lines.length, 1, `one line: ${JSON.stringify(lines)}`);
      assert.equal(file.loaded(), loaded);
      return { loaded, said: lines[0] ?? {}, made };
    }
    /** A file the probe wrote, as text. */
    async function written(): Promise<string> {
      const path = join(scratch(), ANSWER_FILE);
      const made = make();
      await made.answered('a.test');
      await made.answered('b.test');
      await fileFor(made, path).save();
      return readFileSync(path, 'utf8');
    }
    /** `text` at a new path, at the probe's own mode. */
    function at(text: string): string {
      const path = join(scratch(), ANSWER_FILE);
      writeFileSync(path, text, { mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    }
    async function refused(path: string, why: RegExp, options: Partial<AnswerFileOptions> = {}) {
      const { loaded, said, made } = await loadOnce(path, options);
      assert.equal(loaded, 0);
      assert.equal(made.resolver.stats().entries, 0, 'nothing kept from it');
      assert.equal(said['level'], 40);
      assert.match(String(said['why']), why);
      assert.equal(
        said['msg'],
        `the probe’s answer file was not used: ${String(said['why'])}; every name is asked for the first time`,
      );
    }

    it('says a missing file at info, once: the first start, or a probe that never stopped', async () => {
      const { loaded, said } = await loadOnce(join(scratch(), ANSWER_FILE));
      assert.equal(loaded, 0);
      assert.equal(said['level'], 30);
      assert.equal(
        said['msg'],
        'no answer file from an earlier run: every name is asked for the first time',
      );
    });

    it('reads the probe’s own file whole, and so the one written as a probe that stopped left it', async () => {
      const { loaded } = await loadOnce(at(await written()));
      assert.equal(loaded, 2);
    });

    it('does not use a truncated file, cut anywhere', async () => {
      const text = await written();
      for (const cut of [1, 20, Math.floor(text.length / 2), text.length - 3]) {
        await refused(at(text.slice(0, cut)), /^it is not JSON: a write cut short/);
      }
      await refused(at(''), /^it is not JSON/);
    });

    it('does not use a file that is not the probe’s answer file', async () => {
      await refused(at('not JSON at all'), /^it is not JSON/);
      for (const text of ['[]', 'null', '"text"', '7', '{}', '{"format":"ms-probe-identity"}']) {
        await refused(at(text), /^it is not an answer file$/);
      }
    });

    it('does not use a file in another version of the format: an older layout, or a later build’s', async () => {
      // No build before this one writes the file, so an older probe leaves no file at all, and one
      // downgraded to leaves this build's to age past its grace. These are the layouts that are
      // not this build's: before it, after it, and a file that does not say.
      const saved = JSON.parse(await written()) as Record<string, unknown>;
      for (const [version, said] of [
        [0, '0'],
        [2, '2'],
        ['1', '"1"'],
        [undefined, 'none'],
        [1.5, '1.5'],
        // Cut short (`P-438`'s review): a planted file's version is not the log's to carry.
        ['x'.repeat(10_000), `"${'x'.repeat(39)}…`],
        [
          { list: Array.from({ length: 1_000 }, (_, n) => n) },
          '{"list":[0,1,2,3,4,5,6,7,8,9,10,11,12,13…',
        ],
      ] as const) {
        const literal = said.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        await refused(
          at(JSON.stringify({ ...saved, version })),
          new RegExp(
            `^it is in version ${literal} of the format, written by another build, and this build reads version 1$`,
            'u',
          ),
        );
      }
    });

    it('does not use a file that does not say when it was written, or holds no list', async () => {
      const saved = JSON.parse(await written()) as Record<string, unknown>;
      for (const writtenAt of [undefined, String(WALL), WALL + 0.5]) {
        await refused(
          at(JSON.stringify({ ...saved, writtenAt })),
          /^it says nothing of when it was written$/,
        );
      }
      for (const answers of [undefined, {}, 'a.test']) {
        await refused(at(JSON.stringify({ ...saved, answers })), /^it holds no list of answers$/);
      }
      for (const more of [
        { bootId: 7, monotonicAt: 1 },
        { bootId: 'Not A Boot', monotonicAt: 1 },
        { bootId: 'b'.repeat(65), monotonicAt: 1 },
        { bootId: 'abc-123' },
        { bootId: 'abc-123', monotonicAt: 0.5 },
      ]) {
        await refused(
          at(JSON.stringify({ ...saved, ...more })),
          /^it says when it was written in a way the probe does not write$/,
        );
      }
    });

    it('does not use a file larger than the probe writes, and uses one exactly as large', async () => {
      const text = await written();
      const size = Buffer.byteLength(text);
      await refused(at(text), new RegExp(`^it is larger than the ${String(size - 1)} bytes`, 'u'), {
        maxBytes: size - 1,
      });
      assert.equal((await loadOnce(at(text), { maxBytes: size })).loaded, 2);
    });

    it('does not follow a symbolic link, or read what is not a regular file', async () => {
      const real = at(await written());
      const dir = scratch();
      const link = join(dir, ANSWER_FILE);
      symlinkSync(real, link);
      await refused(link, /^it is a symbolic link, which the probe never writes$/);
      const directory = join(scratch(), ANSWER_FILE);
      mkdirSync(directory);
      await refused(directory, /^it is not a regular file$/);
    });

    it('does not open a FIFO, whose open would wait for a writer, and the probe’s start with it, for good', async (t) => {
      // `P-438`'s review (AF-1).
      const path = join(scratch(), ANSWER_FILE);
      try {
        execFileSync('mkfifo', ['-m', '600', path], { stdio: 'ignore' });
      } catch {
        t.skip('no mkfifo here');
        return;
      }
      try {
        await within(
          5_000,
          'the load of a FIFO to end',
          refused(path, /^it is not a regular file$/),
        );
      } finally {
        // An open still waiting holds a thread, and the test's process: a writer lets it go.
        try {
          closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch {
          // No reader waiting: nothing to let go.
        }
      }
    });

    it('does not use a file another user can read or write', async () => {
      const text = await written();
      for (const mode of [0o644, 0o640, 0o604, 0o602, 0o620]) {
        const path = at(text);
        chmodSync(path, mode);
        await refused(
          path,
          new RegExp(`^its mode is 0${mode.toString(8)}, where the probe writes it 0600$`, 'u'),
        );
      }
      // Readable by the probe alone, if not writable: its own still.
      const path = at(text);
      chmodSync(path, 0o400);
      assert.equal((await loadOnce(path)).loaded, 2);
    });

    it(
      'does not use a file owned by another user',
      { skip: process.geteuid?.() !== 0 ? 'needs root to give a file away' : false },
      async () => {
        const path = at(await written());
        chownSync(path, 4_242, 4_242);
        await refused(path, /^it is owned by uid 4242, not the probe’s 0$/);
      },
    );

    it('does not use a path it cannot look at', async () => {
      const dir = scratch();
      const notADirectory = join(dir, 'spool');
      writeFileSync(notADirectory, 'a file where the spool directory should be');
      await refused(join(notADirectory, ANSWER_FILE), /^it could not be looked at \(.*ENOTDIR/u);
    });
  });

  describe('in the probe as a service manager runs it', () => {
    const skip = !opensslAvailable ? 'openssl is not on PATH' : false;
    let dir = '';
    let core: FakeCore | undefined;
    let corePort = 0;
    const running: RunningProbe[] = [];
    before(async () => {
      if (skip !== false) return;
      dir = mkdtempSync(join(tmpdir(), 'ms-probe-answers-'));
      generateCerts(dir);
      ({ core, port: corePort } = await FakeCore.start(dir, []));
    });
    after(async () => {
      for (const probe of running) await probe.stop().catch(() => undefined);
      await core?.stop();
      if (dir !== '') await rm(dir, { recursive: true, force: true });
    });

    it(
      'loads the file at start, says how many in Probe Health, and writes it again at stop',
      { skip },
      async () => {
        assert.ok(core !== undefined);
        const spoolDir = join(dir, 'spool');
        mkdirSync(spoolDir, { recursive: true });
        const path = answerFilePath(spoolDir);
        // A name no hosts file gives, kept by the probe that stopped a second ago.
        const now = Date.now();
        writeAnswers(path, now - 1_000, [line('kept.ms-probe.test', now - 2_000)]);
        const from = core.received.length;
        const probe = startProbe({
          dir,
          corePort,
          config: {
            probe: {
              displayName: 'probe under test',
              spoolDir,
              workerPoolSize: 2,
              workerPoolMinSize: 1,
            },
          },
        });
        running.push(probe);
        const loaded = await core.waitFor(
          'a heartbeat saying how many answers were loaded',
          (message) =>
            message.type === 'heartbeat' && message.health?.answersLoaded !== undefined
              ? message.health.answersLoaded
              : undefined,
          { from },
        );
        assert.equal(loaded, 1);
        assert.equal(
          probe
            .logs()
            .filter((one) =>
              String(one['msg']).startsWith('the probe’s resolver loaded the answers'),
            ).length,
          1,
        );
        assert.equal(await probe.stop(), 0);
        await pollWithin(5_000, 'the answer file written at stop', () => {
          const said = probe.logs().find((one) => one['when'] === 'stop');
          return said !== undefined;
        });
        const saved = readSaved(path);
        assert.ok(saved.writtenAt >= now, 'written again at stop');
        assert.deepEqual(
          saved.answers.map((one) => one.name),
          ['kept.ms-probe.test'],
          'what it loaded and was not asked for again is kept',
        );
        assert.equal(statSync(path).mode & 0o777, 0o600);
      },
    );
  });
});
