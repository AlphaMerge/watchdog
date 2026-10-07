import { readdirSync, readFileSync } from 'node:fs';
import { GROUP_MARKER } from './types.js';

/**
 * The script groups a check process has started, as its runner knows them (`P-266`).
 *
 * A script runs in a process group of its own, so the runner's kill of the check process's group
 * does not reach it, and a check process that dies outright leaves it running. The check process
 * names each group as it starts and ends it (`GROUP_MARKER`), and once the check process has gone
 * the runner ends what is still open.
 *
 * **The lines are a claim, never a fact.** Whatever controls the check process can write to its
 * stdout — not a script through `/proc/$PPID/fd/1`, since Node's stdio pipes are socket pairs
 * that cannot be reopened there, but a script that may `ptrace` its parent (Yama's scope 0) or
 * take the descriptor with `pidfd_getfd` — and the runner may be root, running checks as
 * `processUid`. A line taken on its syntax alone would let a script's
 * author have the probe `SIGKILL` the database, `sshd` or the core. So a group is recorded only
 * when `/proc` shows it is one the check process started, and killed only when `/proc` shows it
 * is still that group. Where there is no `/proc` (macOS, a development machine), nothing is
 * recorded and nothing is killed: production is Linux.
 */

/** What the runner reads of a process in `/proc`. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgrp: number;
  readonly session: number;
  /** Field 22 of `/proc/<pid>/stat`: clock ticks after boot. With the pid, it names one process. */
  readonly starttime: string;
  /** The real uid, from `/proc/<pid>/status`. */
  readonly uid: number;
}

/** How a signal to a group went: sent, `ESRCH`, or refused with the error's code. */
export type GroupSignal = 'sent' | 'gone' | { readonly refused: string };

/** What the runner may ask of the system about a group. Injectable, so a test can lie to it. */
export interface ProcessView {
  /** The process, or null when there is none by that pid or it cannot be read. */
  read(pid: number): ProcessEntry | null;
  /**
   * Every process whose group is `pgid`, read as `read` reads one. A scan of all of `/proc`, so it
   * is asked only when a group's leader has gone, which is rare.
   */
  members(pgid: number): ProcessEntry[];
  /** `kill(-pgid, signal)`. */
  signalGroup(pgid: number, signal: 0 | 'SIGKILL'): GroupSignal;
}

/** `/proc` on Linux, or null anywhere else: no `/proc`, no verifying, so no killing. */
export function linuxProcessView(): ProcessView | null {
  if (process.platform !== 'linux') return null;
  try {
    readFileSync('/proc/self/stat', 'latin1');
  } catch {
    return null;
  }
  return {
    read: readProc,
    members: readGroup,
    signalGroup: (pgid, signal) => {
      try {
        process.kill(-pgid, signal);
        return 'sent';
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        return code === 'ESRCH' ? 'gone' : { refused: code };
      }
    },
  };
}

/**
 * One process's `stat` and real uid, read synchronously.
 *
 * Synchronous on the probe's main thread on purpose: `/proc` is generated from kernel memory and
 * never waits on a disk, and a read that resolved later could arrive after the line saying the
 * group had ended. The number of reads per check process is bounded (`MAX_GROUPS_PER_CHECK`).
 */
export function readProc(pid: number): ProcessEntry | null {
  let stat: string;
  let status: string;
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'latin1');
    status = readFileSync(`/proc/${String(pid)}/status`, 'latin1');
  } catch {
    return null;
  }
  return parseProc(stat, status);
}

/**
 * The members of group `pgid`, from every `/proc/<pid>/stat`, and the `status` of those only.
 * A process that ends during the scan is left out, as it would be a moment later anyway.
 */
export function readGroup(pgid: number): ProcessEntry[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const members: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'latin1');
    } catch {
      continue;
    }
    // The group first, with a stand-in uid, so `status` is read only for the members.
    if (parseProc(stat, 'Uid:\t0\n')?.pgrp !== pgid) continue;
    const member = readProc(Number(name));
    if (member !== null && member.pgrp === pgid) members.push(member);
  }
  return members;
}

/**
 * `stat` after its command name, which is in parentheses and may hold anything, parentheses and
 * spaces included — so the fields are counted from the *last* `)`, never split from the start.
 */
export function parseProc(stat: string, status: string): ProcessEntry | null {
  const close = stat.lastIndexOf(')');
  const open = stat.indexOf(' (');
  if (close === -1 || open === -1) return null;
  // From field 3 (state) on: [0] state, [1] ppid, [2] pgrp, [3] session, … [19] starttime.
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(' ');
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  const starttime = fields[19];
  const numbers = [stat.slice(0, open), fields[1], fields[2], fields[3], uid].map((field) =>
    field !== undefined && /^\d+$/.test(field) ? Number(field) : NaN,
  );
  if (numbers.some(Number.isNaN) || starttime === undefined || !/^\d+$/.test(starttime))
    return null;
  const [pid = NaN, ppid = NaN, pgrp = NaN, session = NaN, realUid = NaN] = numbers;
  return { pid, ppid, pgrp, session, starttime, uid: realUid };
}

/** A group line, read. */
export interface GroupEvent {
  readonly event: 'started' | 'ended';
  readonly pgid: number;
}

/**
 * Reads a check process's group lines (`GROUP_MARKER`) out of its stdout.
 *
 * A whole line, from its start: `started` or `ended`, a space and a pid of at most ten digits
 * with no sign or leading zero. Never 0 or 1, and never this process: `kill(-1)` is every process
 * the probe's user may signal. That is the syntax, which keeps nonsense out; it does not make a
 * line true, which is `ScriptGroups`' job. Holds at most one such line's length, however much the
 * child writes, as `ReadyLine` does.
 */
export class GroupLines {
  static readonly #longest = GROUP_MARKER.length + 'started '.length + 10;
  #line = '';
  #overlong = false;

  push(text: string): GroupEvent[] {
    const events: GroupEvent[] = [];
    let rest = text;
    for (;;) {
      const end = rest.indexOf('\n');
      if (!this.#overlong) {
        this.#line += end === -1 ? rest : rest.slice(0, end);
        if (this.#line.length > GroupLines.#longest) {
          this.#overlong = true;
          this.#line = '';
        }
      }
      if (end === -1) return events;
      const event = this.#overlong ? null : read(this.#line);
      if (event !== null) events.push(event);
      this.#line = '';
      this.#overlong = false;
      rest = rest.slice(end + 1);
    }
  }
}

function read(line: string): GroupEvent | null {
  if (!line.startsWith(GROUP_MARKER)) return null;
  const said = /^(started|ended) ([1-9][0-9]{0,9})$/.exec(line.slice(GROUP_MARKER.length));
  if (said === null) return null;
  const pgid = Number(said[2]);
  if (pgid <= 1 || pgid === process.pid) return null;
  return { event: said[1] === 'started' ? 'started' : 'ended', pgid };
}

/**
 * How many `started` lines one check process may have checked against `/proc`. A script check
 * starts one program; a flood of forged lines is refused past this rather than read.
 */
export const MAX_GROUPS_PER_CHECK = 16;

/** What ending the left-behind groups came to. */
export interface LeftBehind {
  /** Groups sent `SIGKILL`. */
  readonly ended: number[];
  /**
   * Groups not killed because their id now names something else: the leader's pid another
   * process, or, the leader gone, a member outside the script's session or of another uid.
   */
  readonly recycled: number[];
  /** Groups the kill was refused for, with the error's code. */
  readonly failed: { pgid: number; code: string }[];
}

/**
 * The groups one check process has started, verified (`P-266`).
 *
 * **At `started`**, `/proc/<N>` must show a process that is its own session and group leader
 * (`pid == pgrp == session`: what `runProgram`'s `detached` spawn makes, by `setsid`), whose parent
 * is this check process, and, when the runner sets a uid for its checks, whose real uid is that
 * one. Its `starttime` is recorded. A parent cannot be forged — the kernel sets it at `fork`, and
 * a process cannot choose to be another's child — and the only children of a check process are
 * what it spawned. A named process that fails any of these is refused and counted: that is a
 * forgery, or a check process killed so soon after its spawn that the script was orphaned before
 * its line was read. A named process that is not there at all is passed over, uncounted: a script
 * that ended at once, whose `ended` follows.
 *
 * **At the end**, for each recorded group still open:
 * - `/proc/<N>` there with the recorded `starttime`: the same leader, alive or a zombie not yet
 *   reaped, so its group is the script's. Killed. A leader cannot leave its group or session.
 * - `/proc/<N>` there with another `starttime`: the leader is gone and `N` names a new process.
 *   Not killed; counted.
 * - `/proc/<N>` not there: the leader has been reaped, and `N` is only the script's while the
 *   group has had a member all along — a pid stays allocated while any process has it as its
 *   group or session id. Only an `ended` line says the group emptied, and the check process
 *   writes that line: one controlled by somebody else can keep it back, let the group empty and
 *   `N` pass to, say, a root service's intermediate child, which runs `setsid`, forks its daemon
 *   and exits. So the members are read from all of `/proc`: killed only when every one is in
 *   session `N` (the script's, which nothing outside it can join) and, with a uid set, has that
 *   real uid. A group with a member that is not is left alone and counted as recycled, since
 *   its id now names somebody else's group; one with no members is gone.
 */
export class ScriptGroups {
  readonly #view: ProcessView;
  readonly #checkPid: number;
  readonly #uid: number | undefined;
  readonly #lines = new GroupLines();
  /** Group id → its leader's `starttime`, as recorded at `started`. */
  readonly #recorded = new Map<number, string>();
  #checked = 0;
  readonly refused: number[] = [];

  constructor(view: ProcessView, checkPid: number, uid?: number) {
    this.#view = view;
    this.#checkPid = checkPid;
    this.#uid = uid;
  }

  push(text: string): void {
    for (const { event, pgid } of this.#lines.push(text)) {
      if (event === 'ended') this.#recorded.delete(pgid);
      else this.#started(pgid);
    }
  }

  /** The groups recorded and not seen to end, oldest first. */
  open(): number[] {
    return [...this.#recorded.keys()];
  }

  #started(pgid: number): void {
    if (this.#recorded.has(pgid)) return;
    this.#checked += 1;
    if (this.#checked > MAX_GROUPS_PER_CHECK) {
      this.refused.push(pgid);
      return;
    }
    const entry = this.#view.read(pgid);
    if (entry === null) return;
    const own =
      entry.pid === pgid &&
      entry.pgrp === pgid &&
      entry.session === pgid &&
      entry.ppid === this.#checkPid &&
      (this.#uid === undefined || entry.uid === this.#uid);
    if (own) this.#recorded.set(pgid, entry.starttime);
    else this.refused.push(pgid);
  }

  /** Ends each recorded group still open, as the class comment says. Once the check process is gone. */
  endLeftBehind(): LeftBehind {
    const result: LeftBehind = { ended: [], recycled: [], failed: [] };
    for (const [pgid, starttime] of this.#recorded) {
      const now = this.#view.read(pgid);
      if (now !== null && now.starttime !== starttime) {
        result.recycled.push(pgid);
        continue;
      }
      if (now === null) {
        const members = this.#view.members(pgid);
        if (members.length === 0) continue;
        const ours = members.every(
          (member) =>
            member.session === pgid && (this.#uid === undefined || member.uid === this.#uid),
        );
        if (!ours) {
          result.recycled.push(pgid);
          continue;
        }
      }
      const sent = this.#view.signalGroup(pgid, 'SIGKILL');
      if (sent === 'sent') result.ended.push(pgid);
      else if (sent !== 'gone') result.failed.push({ pgid, code: sent.refused });
    }
    this.#recorded.clear();
    return result;
  }
}
