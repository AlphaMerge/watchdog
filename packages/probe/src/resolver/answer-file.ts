import { constants, type Stats } from 'node:fs';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { uptime } from 'node:os';
import { join } from 'node:path';
import type { ResolvedAddress } from '@ms/sensors';
import { describeError, type Logger } from '@ms/shared';
import {
  ANSWER_MS,
  MAX_ADDRESSES,
  type KeptAnswer,
  type NameResolver,
  type RestoreCounts,
} from './name-resolver.js';

/**
 * The answers the probe's resolver keeps, kept across a restart (`P-438`).
 *
 * **Why.** The resolver keeps answers in memory (`P-426`), so a probe restarted in the middle of
 * a zone's outage started with nothing kept: the silent zone's first lookups took the lanes, and
 * the answering zones' checks failed behind them until `getaddrinfo` gave up on each, 2,251 of
 * 31,500 at the v1 target in the third quiet window. With this file a restart is a warm start:
 * every name kept before it is served what it had while it is asked again.
 *
 * **What is written**: each answer kept, most recently asked first, with when it was answered and
 * when it expires on the wall clock, and when the file was written, on the wall clock and on the
 * system's monotonic one with its boot (Linux's boot id), and nothing else. Not holds, denials or failures in a row: a
 * restart is what an operator does after fixing DNS, and carrying "this name does not answer" or
 * "this name does not exist" across it would hide the fix for up to a minute, failing a scan that
 * would pass (`P-438`'s outcome argues it). Not the hosts file's names, which `getaddrinfo`
 * answers from the file at once, and whose file may change while the probe is stopped.
 *
 * **When**: every `SAVE_EVERY_MS` and at stop, a slice of answers at a time, each slice written
 * as it is taken and the event loop let go between slices, so the scheduler's ticks never wait for
 * it. Written to a temporary file that is synced and renamed over the last, so a crash mid-write
 * leaves the one before; mode 0600, readable by the probe alone, though it holds no credential:
 * device names and their addresses. Bounded by `ANSWER_FILE_MAX_BYTES`, the most recently asked
 * kept when it would be more.
 *
 * **What is read**, before the first scan: an answer is kept as expired, so it is served while a
 * refresh asks again, and never past its own grace (`NameResolver.restore`). The wall clock's
 * times become the monotonic clock's at the load, and how long ago the file was written is the
 * most that can be known (`P-438`'s review):
 * - **written since this boot**: the monotonic clock's time since, or the wall clock's if it says
 *   longer, so a wall clock stepped back since does not make the answers younger, nor the file
 *   unused;
 * - **written before it**: the wall clock's time since, which cannot be less than the time since
 *   the boot. A wall clock that says less has been put back to about when the probe stopped (a
 *   system with no clock of its own, restoring a clock file at boot), and how long it was off
 *   cannot be told: none is used. Nor when the file says it was written in the future. The time
 *   since the boot is the boot the id is of (`P-438`'s narrow check): under systemd-nspawn, or LXC
 *   without lxcfs, the boot id is the container's, new at each of its boots, and the kernel's
 *   uptime the host's, so the time is PID 1's age when that is less. Where PID 1 cannot be read
 *   (`ProtectProc=invisible`), it is the case below;
 * - **no boot known** (not Linux, a file without one, or no time since the boot): the wall
 *   clock's, and none used of a file written in the future.
 *
 * What cannot be seen: a system with no clock of its own, whose clock file was saved after the
 * probe's last write and whose clock has not been set over the network by the load. The answers
 * then load as about as old as the boot, whatever the time off, and each name's first check goes to
 * the address it had before the stop while its refresh asks (`docs/administration.md`). An answer
 * whose grace is over is not used either.
 *
 * **Every failure to read is a cold start, never a refusal to start**, said in one line: missing
 * (the first start, or a probe that has never stopped since it was installed), unreadable, not a
 * regular file, larger than the probe writes, not the probe's own (owned by another user, or
 * readable or writable by others), not JSON (a write cut short by something other than this code,
 * which renames only a whole file), or of a format or version this build does not read. No build
 * before this one writes the file, so an older probe leaves none; a later build's is not read.
 */

/** The file's name, in the probe's own state directory beside its identity and the spool. */
export const ANSWER_FILE = 'name-answers.json';
/** What the file says it is. */
export const ANSWER_FILE_FORMAT = 'ms-probe-name-answers';
/** The layout this build writes and reads. A file of any other is not read. */
export const ANSWER_FILE_VERSION = 1;
/** The largest file written or read: about 35,000 answers of one address each. */
export const ANSWER_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** How often the answers are written, besides at stop: a crash loses at most this much. */
export const SAVE_EVERY_MS = 60_000;
/** Answers turned to text between two turns of the event loop. */
const SLICE = 500;
/** Room for the file's opening and closing lines around its answers. */
const ENVELOPE_BYTES = 256;

/** Where the answer file is kept for a probe's spool directory, its own writable directory. */
export function answerFilePath(spoolDir: string): string {
  return join(spoolDir, ANSWER_FILE);
}

export interface AnswerFileOptions {
  readonly path: string;
  readonly resolver: Pick<NameResolver, 'answersToSave' | 'restore'>;
  readonly logger: Logger;
  /** The wall clock in milliseconds. `Date.now` unless a test hands one in. */
  readonly wallNow?: () => number;
  readonly everyMs?: number;
  readonly maxBytes?: number;
  /** The longest an answer is kept fresh: a saved one kept longer is not one this build wrote. */
  readonly answerMs?: number;
  /** This boot's id, or undefined where none is known: Linux's `boot_id` unless a test says. */
  readonly bootId?: () => Promise<string | undefined>;
  /** The system's monotonic clock in milliseconds, which runs from its boot. */
  readonly monotonicNow?: () => number;
  /**
   * How long ago the boot `bootId` names was, in milliseconds, or undefined where it cannot be
   * told: `linuxSinceBootMs` unless a test says.
   */
  readonly sinceBootMs?: () => Promise<number | undefined>;
}

/** What one write put in the file. */
export interface SaveCounts {
  readonly saved: number;
  /** Answers left out to keep the file within its bound, the least recently asked. */
  readonly dropped: number;
  readonly bytes: number;
}

/** Why a file was not read. */
type Unread = { readonly kind: 'missing' } | { readonly kind: 'refused'; readonly why: string };

interface Parsed {
  readonly answers: KeptAnswer[];
  readonly invalid: number;
  /** How long ago the file was written, as well as it can be known. */
  readonly writtenAgoMs: number;
}

/** The clocks a load reads the file's times against, each read once. */
interface Clocks {
  readonly wall: number;
  readonly monotonic: number;
  readonly bootId: string | undefined;
  /** How long ago that boot was, where it can be told. */
  readonly sinceBoot: number | undefined;
}

/** A boot id as Linux gives one, and the most of one the file is read with. */
const BOOT_ID = /^[0-9a-f-]{1,64}$/u;

/** Linux's id for this boot, or undefined where there is none. */
async function linuxBootId(): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/** The system's monotonic clock, `CLOCK_MONOTONIC`, in whole milliseconds. */
const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** The clock ticks a second that /proc's process times are counted in: 100 wherever Linux runs. */
const USER_HZ = 100;

/**
 * How long PID 1 has run, in milliseconds, from /proc/uptime and /proc/1/stat's texts, or undefined
 * when either cannot be read as Linux writes it. Its start (field 22, in clock ticks since the
 * kernel's boot) follows the command name, which is in parentheses and may hold anything, so the
 * fields are counted from the last `)`. Less than 0 where /proc/uptime is a container's own (lxcfs)
 * and the start the kernel's.
 */
export function pid1AgeMs(uptimeText: string, statText: string): number | undefined {
  const uptimeS = /^\d+(?:\.\d+)?$/u.exec(uptimeText.trim().split(/\s+/u)[0] ?? '')?.[0];
  const close = statText.lastIndexOf(')');
  if (uptimeS === undefined || close === -1) return undefined;
  // State is field 3, the first after the name: the start is the twentieth.
  const start =
    statText
      .slice(close + 1)
      .trim()
      .split(/\s+/u)[19] ?? '';
  if (!/^\d+$/u.test(start)) return undefined;
  return Math.round(Number(uptimeS) * 1000 - (Number(start) * 1000) / USER_HZ);
}

/**
 * How long ago the boot Linux's `boot_id` names was (`P-438`'s narrow check): the kernel's
 * uptime, or PID 1's age when that is less, as it is under systemd-nspawn and LXC without lxcfs,
 * which give a container a boot id of its own at each of its boots and leave /proc/uptime the
 * host's. Undefined where /proc/1 cannot be read (`ProtectProc=invisible`, or not Linux): the
 * file is then aged by the wall clock alone, rather than refused for an uptime that is not its
 * boot's.
 */
export async function linuxSinceBootMs(
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
  uptimeMs: () => number = () => uptime() * 1000,
): Promise<number | undefined> {
  let age: number | undefined;
  try {
    age = pid1AgeMs(await read('/proc/uptime'), await read('/proc/1/stat'));
  } catch {
    return undefined;
  }
  if (age === undefined) return undefined;
  const kernel = Math.floor(uptimeMs());
  return age < 0 ? kernel : Math.min(kernel, age);
}

/** A version as the refusal says it: a number as it is, anything else cut short. */
function versionSaid(version: unknown): string {
  if (version === undefined) return 'none';
  if (typeof version === 'number' && Number.isSafeInteger(version)) return String(version);
  const text = JSON.stringify(version);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

const refused = (why: string): Unread => ({ kind: 'refused', why });

/**
 * Opened for reading, never through a symbolic link where the platform can say so, and never
 * waiting: a FIFO put there since it was looked at would hold the open, and the start, for good.
 */
const READ_FLAGS =
  process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * One saved answer as the resolver takes it, relative to the clock now, or undefined when it is
 * not one this build could have written: no name, a family other than 0, 4 or 6, times that are
 * not whole milliseconds or that disagree with each other or with when the file was written, or
 * addresses that are not addresses of its family, none, or too many. A name that is an address
 * `NameResolver.restore` refuses itself, and counts with these.
 */
function savedAnswer(
  raw: unknown,
  writtenAt: number,
  wallNow: number,
  answerMs: number,
): KeptAnswer | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { name, family, answeredAt, expiresAt, addresses } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 1_024) return undefined;
  if (family !== 0 && family !== 4 && family !== 6) return undefined;
  if (typeof answeredAt !== 'number' || !Number.isSafeInteger(answeredAt)) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return undefined;
  if (answeredAt > writtenAt || expiresAt < answeredAt || expiresAt - answeredAt > answerMs) {
    return undefined;
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > MAX_ADDRESSES) {
    return undefined;
  }
  const resolved: ResolvedAddress[] = [];
  for (const address of addresses as unknown[]) {
    if (typeof address !== 'string') return undefined;
    const kind = isIP(address);
    if (kind === 0 || (family !== 0 && kind !== family)) return undefined;
    resolved.push({ address, family: kind });
  }
  return {
    host: name,
    family,
    addresses: resolved,
    answeredAgoMs: wallNow - answeredAt,
    expiresInMs: expiresAt - wallNow,
  };
}

export class AnswerFile {
  readonly #path: string;
  readonly #resolver: Pick<NameResolver, 'answersToSave' | 'restore'>;
  readonly #logger: Logger;
  readonly #wallNow: () => number;
  readonly #everyMs: number;
  readonly #maxBytes: number;
  readonly #answerMs: number;
  readonly #bootId: () => Promise<string | undefined>;
  readonly #monotonicNow: () => number;
  readonly #sinceBootMs: () => Promise<number | undefined>;
  #timer: NodeJS.Timeout | undefined;
  /** Writes one at a time: each waits for the one before it. */
  #chain: Promise<unknown> = Promise.resolve();
  #writing = 0;
  #loaded = 0;

  constructor(options: AnswerFileOptions) {
    this.#path = options.path;
    this.#resolver = options.resolver;
    this.#logger = options.logger.child({ component: 'name-answer-file' });
    this.#wallNow = options.wallNow ?? (() => Date.now());
    this.#everyMs = options.everyMs ?? SAVE_EVERY_MS;
    this.#maxBytes = options.maxBytes ?? ANSWER_FILE_MAX_BYTES;
    this.#answerMs = options.answerMs ?? ANSWER_MS;
    this.#bootId = options.bootId ?? linuxBootId;
    this.#monotonicNow = options.monotonicNow ?? monotonicMs;
    this.#sinceBootMs = options.sinceBootMs ?? (() => linuxSinceBootMs());
  }

  /** How many answers the last `load` kept: Probe Health's `answersLoaded`. */
  loaded(): number {
    return this.#loaded;
  }

  /**
   * Reads the file into the resolver, before the first check: how many answers were kept. Never
   * throws: a file that cannot be used is a cold start, said in one line.
   */
  async load(): Promise<number> {
    this.#loaded = 0;
    try {
      const bootId = await this.#boot();
      const sinceBoot = bootId === undefined ? undefined : await this.#sinceBootMs();
      const clocks = {
        wall: this.#wallNow(),
        monotonic: this.#monotonicNow(),
        bootId,
        sinceBoot,
      };
      const read = await this.#read();
      const parsed = typeof read === 'string' ? this.#parse(read, clocks) : read;
      if ('kind' in parsed) {
        if (parsed.kind === 'missing') {
          this.#logger.info(
            { path: this.#path },
            'no answer file from an earlier run: every name is asked for the first time',
          );
        } else {
          this.#logger.warn(
            { path: this.#path, why: parsed.why },
            `the probe’s answer file was not used: ${parsed.why}; every name is asked for the first time`,
          );
        }
        return 0;
      }
      const counts: RestoreCounts = await this.#resolver.restore(parsed.answers);
      this.#loaded = counts.loaded;
      this.#logger.info(
        {
          path: this.#path,
          ...counts,
          invalid: counts.invalid + parsed.invalid,
          writtenAgoMs: parsed.writtenAgoMs,
        },
        'the probe’s resolver loaded the answers it kept before it stopped: each is served while it is asked again',
      );
      return counts.loaded;
    } catch (error: unknown) {
      this.#loaded = 0;
      this.#logger.warn(
        { path: this.#path, err: describeError(error) },
        'the probe’s answer file was not used: it could not be read; every name is asked for the first time',
      );
      return 0;
    }
  }

  /** This boot's id, when one is known and is one a file may hold. */
  async #boot(): Promise<string | undefined> {
    const id = await this.#bootId();
    return id !== undefined && BOOT_ID.test(id) ? id : undefined;
  }

  /** Writes every `everyMs`, unless a write is still under way. */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      if (this.#writing === 0) void this.save('periodic');
    }, this.#everyMs);
    this.#timer.unref();
  }

  /** Stops the timer, and writes once more, after any write under way. */
  async stop(): Promise<SaveCounts | undefined> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    return this.save('stop');
  }

  /**
   * Writes the file now, after any write under way: what it wrote, or undefined when it could
   * not, which it logs. The file before it then stays.
   */
  save(when: 'periodic' | 'stop' | 'now' = 'now'): Promise<SaveCounts | undefined> {
    this.#writing += 1;
    const run = this.#chain
      .then(async () => {
        try {
          const counts = await this.#write();
          const line = { path: this.#path, when, ...counts };
          if (when === 'periodic' && counts.dropped === 0) {
            this.#logger.debug(line, 'the probe’s resolver saved the answers it keeps');
          } else {
            this.#logger.info(line, 'the probe’s resolver saved the answers it keeps');
          }
          return counts;
        } catch (error: unknown) {
          this.#logger.warn(
            { path: this.#path, when, err: describeError(error) },
            'the probe’s answer file could not be written: the one before it stays',
          );
          return undefined;
        }
      })
      .finally(() => {
        this.#writing -= 1;
      });
    this.#chain = run;
    return run;
  }

  async #write(): Promise<SaveCounts> {
    const temporary = `${this.#path}.tmp`;
    // A temporary file a crashed write left keeps its mode when opened again: made anew.
    await rm(temporary, { force: true });
    const handle = await open(temporary, 'wx', 0o600);
    // `writeFile` on a handle writes all it is given from where the last write ended.
    let closed = false;
    try {
      // Whatever the service's umask.
      await handle.chmod(0o600);
      const head = `{"format":${JSON.stringify(ANSWER_FILE_FORMAT)},"version":${String(ANSWER_FILE_VERSION)},"answers":[`;
      await handle.writeFile(head);
      let bytes = Buffer.byteLength(head);
      let budget = this.#maxBytes - ENVELOPE_BYTES;
      let saved = 0;
      let dropped = 0;
      const bootId = await this.#boot();
      let writtenAt = this.#wallNow();
      let monotonicAt = this.#monotonicNow();
      const source = this.#resolver.answersToSave();
      for (;;) {
        const slice = source.take(SLICE);
        if (slice.length === 0) break;
        // The wall clock read with the slice, as its ages were. The file's time is the last of
        // them, written after every answer, so that no answer in it is later than the file.
        const wall = this.#wallNow();
        const monotonic = this.#monotonicNow();
        if (wall >= writtenAt) {
          writtenAt = wall;
          monotonicAt = monotonic;
        }
        let chunk = '';
        for (const answer of slice) {
          const answeredAt = Math.floor(wall - answer.answeredAgoMs);
          const line = JSON.stringify({
            name: answer.host,
            family: answer.family,
            answeredAt,
            expiresAt: answeredAt + Math.floor(answer.answeredAgoMs + answer.expiresInMs),
            addresses: answer.addresses.map(({ address }) => address),
          });
          const size = Buffer.byteLength(line) + 2;
          if (size > budget) {
            dropped += 1;
            continue;
          }
          chunk += `${saved === 0 ? '' : ','}\n${line}`;
          budget -= size;
          saved += 1;
        }
        if (chunk !== '') {
          await handle.writeFile(chunk);
          bytes += Buffer.byteLength(chunk);
        }
        // The scheduler's turn.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      // Its monotonic time is that of the wall clock's reading it is written with.
      const boot =
        bootId === undefined
          ? ''
          : `,"bootId":${JSON.stringify(bootId)},"monotonicAt":${String(monotonicAt)}`;
      const tail = `\n],"writtenAt":${String(writtenAt)}${boot}}\n`;
      await handle.writeFile(tail);
      bytes += Buffer.byteLength(tail);
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporary, this.#path);
      return { saved, dropped, bytes };
    } catch (error: unknown) {
      if (!closed) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** The file's text, or why it was not read. */
  async #read(): Promise<string | Unread> {
    try {
      const link = await lstat(this.#path);
      if (link.isSymbolicLink())
        return refused('it is a symbolic link, which the probe never writes');
      // Not opened at all: a FIFO's open waits for a writer (`P-438`'s review).
      if (!link.isFile()) return refused('it is not a regular file');
    } catch (error: unknown) {
      if (codeOf(error) === 'ENOENT') return { kind: 'missing' };
      return refused(`it could not be looked at (${describeError(error).message})`);
    }
    // Never through a symbolic link put there since, where the platform can say so, nor waiting
    // on what was put there since; and what is looked at is the file open, not the name.
    const handle = await open(this.#path, READ_FLAGS);
    try {
      const unusable = this.#unusable(await handle.stat());
      if (unusable !== undefined) return refused(unusable);
      // Read to one byte past the bound, so that a larger file is seen without reading it all.
      const buffer = Buffer.alloc(this.#maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > this.#maxBytes) {
        return refused(`it is larger than the ${String(this.#maxBytes)} bytes the probe writes`);
      }
      return buffer.toString('utf8', 0, length);
    } finally {
      await handle.close();
    }
  }

  /** Why the file open, with these stats, is not read, or undefined when it may be. */
  #unusable(info: Stats): string | undefined {
    if (!info.isFile())
      return 'it was replaced by something other than a regular file as it was opened';
    // The probe's own, readable by it alone: what it writes. Windows has no such mode bits; its
    // directory's access list is what keeps the file the service's.
    if (process.platform !== 'win32') {
      const uid = process.geteuid?.();
      if (uid !== undefined && info.uid !== uid) {
        return `it is owned by uid ${String(info.uid)}, not the probe’s ${String(uid)}`;
      }
      if ((info.mode & 0o077) !== 0) {
        return `its mode is ${(info.mode & 0o777).toString(8).padStart(4, '0')}, where the probe writes it 0600`;
      }
    }
    return undefined;
  }

  /** The file's answers, relative to the clock now, or why the file is not used. */
  #parse(text: string, now: Clocks): Parsed | Unread {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refused('it is not JSON: a write cut short, or not the probe’s');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return refused('it is not an answer file');
    }
    const { format, version, writtenAt, bootId, monotonicAt, answers } = parsed as Record<
      string,
      unknown
    >;
    if (format !== ANSWER_FILE_FORMAT) return refused('it is not an answer file');
    if (version !== ANSWER_FILE_VERSION) {
      return refused(
        `it is in version ${versionSaid(version)} of the format, written by another build, and ` +
          `this build reads version ${String(ANSWER_FILE_VERSION)}`,
      );
    }
    if (typeof writtenAt !== 'number' || !Number.isSafeInteger(writtenAt)) {
      return refused('it says nothing of when it was written');
    }
    if (
      bootId !== undefined &&
      (typeof bootId !== 'string' ||
        !BOOT_ID.test(bootId) ||
        typeof monotonicAt !== 'number' ||
        !Number.isSafeInteger(monotonicAt))
    ) {
      return refused('it says when it was written in a way the probe does not write');
    }
    const ago = this.#writtenAgo(writtenAt, bootId, monotonicAt, now);
    if (typeof ago === 'string') return refused(ago);
    if (!Array.isArray(answers)) return refused('it holds no list of answers');
    // The wall clock as it would read now had it run on since the file was written.
    const wallNow = writtenAt + ago;
    const kept: KeptAnswer[] = [];
    let invalid = 0;
    for (const raw of answers as unknown[]) {
      const answer = savedAnswer(raw, writtenAt, wallNow, this.#answerMs);
      if (answer === undefined) invalid += 1;
      else kept.push(answer);
    }
    return { answers: kept, invalid, writtenAgoMs: ago };
  }

  /**
   * How long ago a file was written, as well as it can be known (`P-438`'s review), or why it
   * cannot be: since this boot, by the monotonic clock unless the wall clock says longer; before
   * it, by the wall clock, never less than the time since the boot; with no boot known, or no time
   * since it, by the wall clock, never in the future.
   */
  #writtenAgo(
    writtenAt: number,
    bootId: unknown,
    monotonicAt: unknown,
    now: Clocks,
  ): number | string {
    const wallAgo = now.wall - writtenAt;
    if (bootId !== undefined && now.bootId !== undefined) {
      if (bootId === now.bootId && typeof monotonicAt === 'number') {
        const monotonicAgo = now.monotonic - monotonicAt;
        if (monotonicAgo < 0) {
          return 'it says it was written later in this boot than now, which the probe never writes';
        }
        return Math.max(monotonicAgo, wallAgo);
      }
      const sinceBoot = now.sinceBoot;
      if (sinceBoot !== undefined) {
        if (wallAgo < sinceBoot) {
          return (
            `it was written before this boot, ${String(Math.round(sinceBoot / 1000))} s ago, and ` +
            `the clock says ${String(Math.round(wallAgo / 1000))} s ago: the clock was put back ` +
            'at the boot, and how long the probe was off cannot be told'
          );
        }
        return wallAgo;
      }
    }
    if (wallAgo < 0) {
      return (
        `it was written ${String(-wallAgo)} ms in the future: the clock has gone back ` +
        'since, and how old its answers are cannot be told'
      );
    }
    return wallAgo;
  }
}
