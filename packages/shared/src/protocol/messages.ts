import { Ajv, type ErrorObject } from 'ajv';
import { AppError } from '../errors/app-error.js';
import { MAX_EXCEPTION_ADDRESSES } from '../net/target-policy.js';
import { fitResult, RESULT_LIMITS } from './result-fit.js';
import {
  PATTERN_MESSAGE,
  patternMessageKeyword,
  patternMessageOf,
} from '../schema/pattern-message.js';
import { isProtocolCompatible, MIN_PROTOCOL_VERSION } from './capability-versions.js';

/**
 * The core↔probe wire protocol.
 *
 * Phase 0 carried a versioned handshake and a heartbeat; version 2 added check results and their
 * acknowledgement (S-07); version 3 added the configuration push (R-04); version 4 adds the
 * discovery sweep (D-01). The rest of spool replay arrives later as new members of these
 * unions — which is why they are discriminated unions rather than one message type with
 * optional fields.
 */

/**
 * Bumped whenever a change is not backwards compatible. Negotiated in the handshake.
 *
 * Version 2 added `results`, `results-ack` and `results-nack`. A version-2 probe talking to a
 * version-1 core would send results the core cannot parse, so the bump is what turns that into
 * a clean rejection at the handshake instead of a dropped connection later.
 *
 * Version 3 added the configuration push (R-04). The core will not send `config-*` to a peer
 * below 3 — an older probe simply scans nothing, which is what it did before the push existed.
 *
 * Version 4 added the discovery sweep (D-01). Same rule: the core will not send `sweep-*` to a
 * peer below 4, and a discovery run assigned to such a probe fails saying which probe and what
 * version it is running, rather than waiting for progress that will never come.
 *
 * Version 5 added identification (D-02), which is the sweep's second stage and follows the same
 * shape: a job with a cursor, progress that carries findings, and one finish.
 *
 * Version 6 added approval (R-01). A `welcome` now says whether the probe is *approved*, and a
 * probe that is not gets an identity, a heartbeat and no configuration — so it waits in an
 * administrator's queue instead of being trusted for having reached the port. The same message
 * may carry a per-probe `accessKey`, issued once at approval, which is what makes revoking one
 * probe possible without rotating the enrolment key every other probe shares.
 *
 * Version 7 added probe health reporting (`P-13`). The heartbeat may now carry the probe's own
 * scheduler, pool and spool numbers, which is the half of Probe Health only the probe knows. An
 * older probe simply omits it, and its Probe Health sensor reports the half the *core* knows —
 * connected or not, heartbeat age, protocol skew — and says in its message why the rest is
 * missing. That is the `R-06` rule applied again: a capability the peer does not have is
 * reported in words, never silently absent.
 *
 * Version 33 adds `notStarted` on a check result, under `checkNotStarted` (`P-265`): the probe
 * could not start the check (its process did not get as far as running it), so the device was
 * never asked. Only `true`, only beside `outcome: 'error'` with no readings, as `withheld` is. The
 * core holds the sensor Unknown with cause `probe` until its next result, behind the probe's one
 * alarm, rather than counting a failed scan. A core below 33 is sent the result without it and
 * reads it as the failed check it always did, with the reason in its message.
 *
 * Version 32 adds three counters under one capability, `unsendableReadings` (`P-283`):
 * `resultChannelsDropped`, the channel readings `fitResult` took out of this probe's results
 * because the wire could not carry them, and `spoolRejected` and `spoolOversized`, the spooled
 * results the drain discarded because the core refused their batch as invalid or because one was
 * larger than a frame. A core below 32 is sent none of them, and a probe below 32 sends none and
 * their channels gap. With them, `instanceId`: an identifier the probe process chose when it
 * started, so the core can tell a restart from growth exactly when it counts a running total over
 * five minutes (`P-284`, and its review) — a restart inside a link gap longer than the old
 * process's uptime leaves both the total and the uptime higher, and only this says so.
 *
 * Version 31 adds six counters under two capabilities. `listenerEarlier` (`P-270`):
 * `trapEarlier`, `syslogEarlier` and `flowEarlier`, what each listener received that a sensor's
 * first scan after a probe restart or a cut configuration push named as `earlier` — before its
 * window, neither read nor lost — once a record. `scriptGroups` (`P-275`): `scriptGroupsEnded`,
 * `scriptGroupsRefused` and `scriptGroupsRecycled`, the script process groups the child-process
 * runner ended after their check process died, refused because `/proc` did not show them to be
 * that process's own, or left alone because their id had passed to something else. A core below
 * 31 is sent none of them, and a probe below 31 sends none and the six channels gap.
 *
 * Version 30 adds `workerStartupFailed` (`P-263`): check workers that never said ready — still
 * loading the probe's sensor types when the pool's start-up bound passed, so the pool terminated
 * them, or dead while loading. One new field in a closed schema under one capability,
 * `workerStartup`: a core below 30 is not sent it, and a probe below 30 does not send it and the
 * channel gaps.
 *
 * Version 29 adds `childStartupFailed` and `childStartupMs` (`P-260`): checks whose child process
 * never got as far as running them — still loading the probe's sensor types at the start-up bound,
 * unable to load them, or ended before it was ready — and how long a child takes to start. The check's own timeout now runs
 * from the moment its process is ready, so the start-up is reported here rather than spent out of
 * the check. Two new fields in a closed schema under one capability, `childStartup`: a core below
 * 29 is sent neither, and a probe below 29 sends neither and both channels gap.
 *
 * Version 28 adds `targetPolicyException` (`A-64`): an assignment's `target` may carry
 * `policyException`, the addresses of that one device its probe may connect to although the
 * probe's target policy refuses them, set by an administrator on the device and never inherited.
 * `target` is a closed schema, so the core sends the field only to a probe at 28; an older probe
 * is sent the assignment without it and refuses those addresses as its policy says, as it did
 * before. Nothing else changes shape.
 *
 * Version 27 adds `databaseAddressPinning` (`A-62`): a probe's PostgreSQL, MySQL and SQL Server
 * sensors connect to the address the probe checked, on a socket the driver is handed, where an
 * older probe's drivers resolve the device's name themselves. Nothing on the wire changes. It
 * is 24's `credentialAddressPinning` for the `database` kind: the core sends a database set
 * whose targets leave a named device to its probe only to a probe at 27, and holds the sensor
 * Unknown on an older one, which would connect by name.
 *
 * Version 26 adds `trapOverwritten` and `syslogOverwritten` (`B-14`): what the trap and the
 * syslog listener each received and overwrote in its buffer before a sensor had read it, running
 * totals since the listener started, as 25's is for flows. Two new fields in a closed schema
 * under one capability, `listenerOverwritten`: a core below 26 is sent neither, and a probe below
 * 26 sends neither and both channels gap.
 *
 * Version 25 adds `flowOverwritten` (`B-11`): flow records the probe's collector received and
 * its buffer overwrote before a sensor had read them, a running total since the collector
 * started, as `flowMissed` is. A new field in a closed schema, so gated and stripped like 23's:
 * a core below 25 is not sent it, and a probe below 25 does not send it and the channel gaps.
 *
 * Version 24 adds `credentialAddressPinning` (`A-41c`): a probe resolves a device's host name
 * once, checks every address it answers with against a credential set's address and range
 * targets, and connects to one of the addresses it checked. An older probe resolves the name when
 * it connects, which whoever runs the name's DNS can answer differently from the check, so the
 * core sends such a set only to a probe at 24 and holds the sensor Unknown on an older one. A
 * check result gains `withheld`: the probe refused to use the set, and the sensor reads Unknown
 * with the message rather than Down. Only a probe sent such a set writes the field, and only a
 * core at 24 sends one, so an older core never meets it; `resultsForPeer` strips it regardless.
 *
 * Version 23 adds `flowCounters` (`B-07`): the first version whose heartbeat may carry
 * `flowReceived`, `flowRejected`, `flowMalformed`, `flowMissed` and `flowUndecodable`. The fields
 * themselves are older — `B-02` added them to the health schema at 16 with no capability — and
 * were never sent, because no shipped probe constructed the flow collector. A core between 16 and
 * 22 may or may not know them, so none is sent them: gated and stripped like 21's.
 *
 * Version 22 adds `credentialHostKeys` (`A-41b`): an SSH credential set's `hostKeys`, the list
 * of server keys it may be used with, beside the one `hostKeyFingerprint`. Nothing on the wire
 * changes shape, since a set's values were always free-form; what changes is what a probe does
 * with them. An older probe reads the one fingerprint and would ignore the list, so the core
 * sends a set that has one only to a probe at 22, and holds the sensor Unknown on an older one.
 *
 * Version 21 adds `logDropped` and `logBacklogBytes` (`P-216` part 3): the lines the probe's log
 * output has dropped since it started, a running total the core turns into a count per reading,
 * and what the output holds that its reader has not taken. Gated and stripped like 19's.
 *
 * Version 20 adds `memorySinceLastReport` (`P-219`): a new meaning for the memory health fields
 * rather than a new field. From 20 a report's machine-memory and limit fields are the lowest since
 * the last heartbeat the core acknowledged, and the core folds every report between two Probe
 * Health records into the second, so each low is recorded once. Below 20 they are the lowest of
 * the last thirty seconds and the core records the latest.
 *
 * Version 19 adds `poolCeiling`, `poolMemoryCap` and `poolHeldBack` (`P-236`): the check pool's
 * ceiling in force, the most workers the probe's memory can hold, and how many the ceiling would
 * allow and memory does not. Gated and stripped like 17's and 18's.
 *
 * Version 18 adds `memoryLimitUsagePercent` and `memoryLimitMb` (`P-210`): how close the probe's
 * cgroup is to the memory ceiling the kernel enforces on it. Gated the same way as 17's pair, and
 * stripped separately, so a v17 core still gets 17's fields.
 *
 * Version 17 adds `memoryAvailablePercent` and `memoryAvailableMb` to the heartbeat's health
 * (`P-208`): how much the probe's *machine* has left, beside what the probe itself holds. **The
 * first health field since `P-178`, so the first one the probe has to gate.** Every earlier health
 * field was added when a newer probe was refused at the handshake by an older core, so a probe
 * never met a core that did not know its fields; now it is served at the older version, and an
 * ungated field would have that core reject every heartbeat. `healthForPeer` strips them.
 *
 * Version 16 adds `final` on a chunked configuration push and `sentAt` on a results batch
 * (`P-168`, `P-169`) — both gated through `capabilitiesFor`, because `additionalProperties:
 * false` sits on the *receiver's* copy of every schema and an unknown field is a rejected
 * message rather than an ignored one. `P-166` learned that the hard way: it added `final`
 * without a bump, and every probe not upgraded in lockstep rejected each configuration message,
 * closed the connection and reconnected into the same wall.
 *
 * **A bump is no longer a fleet-wide upgrade** (`P-178`). Both ends negotiate down to the older
 * of the two versions and every gate reads that number, so a peer ahead of this build is served
 * what this build speaks rather than refused. Before that, bumping this constant *was* the
 * outage: a v15 probe refused a v16 core's welcome, destroyed the socket and reconnected for
 * ever, while the core opened a session, restored every sensor under that probe and sent a full
 * push on each attempt. The rule the bump exists for is unchanged — a new field still needs a
 * version and a capability — but the cost of obeying it is now one end at a time.
 *
 * Version 15 adds `spoolUnwritten` (`P-78`), version 14 `checksCompleting` and
 * `checksBehind` (`P-76`), version 13 the listeners'
 * throughput counters (`P-64`, named `listenerCounters` since `P-294`), version 12 the worker pool's
 * `discarded` count and `poolState` (`P-62`), version 11 the child-process runner's counters
 * (`P-61`), version 10 the session-pool counters (`P-36`), and version 9 `spoolStalledMs`
 * (`H-01`). **The bump is required by `additionalProperties: false` on
 * the health schema**, not by the fields themselves: a newer probe sending them to an older core
 * would have every heartbeat rejected by validation, with nothing to say why. `isProtocolCompatible` refuses a peer above this build's version at the
 * handshake instead, which is the same trade version 2 made — a clean rejection where an
 * operator can see it, rather than a peer that misbehaves later. An *older* probe simply omits
 * the field and the channel gaps, which is the `R-06` rule again: absent is absent, never zero.
 */
export const PROTOCOL_VERSION = 33;

/**
 * The floor, and the one test against it, live in `capability-versions.ts` so that the browser
 * can read them too (`U-33`): the add-sensor form says a probe was refused over its version by
 * the same rule the handshake refuses it by.
 */
export { isProtocolCompatible, MIN_PROTOCOL_VERSION };

/**
 * One sensor a probe has been told to scan, with everything needed to scan it.
 *
 * Self-contained on purpose: the probe holds no copy of the object tree and does no lookups of
 * its own. `target` comes from the sensor's parent device and `intervalSeconds` from the
 * resolved settings chain — both are the core's to work out, so that moving a device or changing
 * an inherited interval is one recomputation in one place rather than a rule the probe has to
 * reimplement and keep in step.
 */
export interface SensorAssignment {
  sensorId: number;
  sensorType: string;
  params: Record<string, unknown>;
  target: {
    host: string;
    ipVersion: 'auto' | 'v4' | 'v6';
    /**
     * The addresses of this device its probe may connect to although the probe's target policy
     * refuses them (`A-64`): the device's own `targetPolicyException`, which only an
     * administrator sets and which is never inherited. Absent when the device has none, and
     * always absent for a probe below protocol 28 (`targetPolicyException`), which would refuse
     * the whole message for an unknown field. Addresses only; the probe matches each address a
     * lookup answers with, and never excepts a metadata service whatever this says.
     */
    policyException?: string[];
  };
  intervalSeconds: number;
  timeoutMs: number;
  /**
   * Decrypted credential sets for the kinds this sensor's type declared (`A-05`).
   *
   * **Secrets on the wire, deliberately, and only on this wire.** The probe is the thing that
   * authenticates to the device, so it has to hold them; the alternatives are giving every probe
   * the vault key or moving the protocol into the core, and both are worse. What bounds it: the
   * channel is mutual TLS, only the kinds a sensor's type declares are sent, and only to the
   * probe that owns that sensor — a Ping probe never receives an SNMP community string.
   *
   * The probe keeps assignments in memory and writes none of them to disk. Its only file is the
   * result spool, which carries check outcomes and never parameters.
   */
  credentials?: Record<string, Record<string, unknown>>;
}

/**
 * Something the core wants a probe to do **now**, with an API call waiting on the answer
 * (`R-09`).
 *
 * A discriminated union rather than a name and a bag of arguments, so a second query kind is a
 * new member the compiler makes both ends handle rather than a string one end has never heard
 * of. There is one kind today; `T-02`'s interface picker and `T-04`'s table-row picker are the
 * next two, and each is a member here rather than a parameter of this one.
 */
export type ProbeQuery = {
  /** Run one check and hand back its result, storing nothing. */
  kind: 'check';
  /**
   * Exactly what a scheduled scan of this sensor would run.
   *
   * The whole assignment, not a subset, and that is the point of this shape: an operator pressing
   * "check now" is asking what the *sensor* does, so a query built from different parameters
   * would answer a question nobody asked — and would be the version that works when the real one
   * does not.
   */
  assignment: SensorAssignment;
};

/**
 * Why a query produced no answer.
 *
 * Separated because an operator does something different about each: `offline` waits, `too-old`
 * upgrades a probe, `busy` retries, `timeout` looks at the device, and `failed` is the check
 * itself reporting — which is a successful *query* about a failing target, and the one case that
 * is not a fault in this mechanism at all.
 */
export type QueryFailure = 'offline' | 'too-old' | 'busy' | 'timeout' | 'unsupported' | 'failed';

/** A single channel's reading inside a check result. */
export interface ChannelReading {
  /** Stable within the sensor, assigned by the sensor type — not the display name. */
  key: string;
  value: number;
  /**
   * The exact counter, as decimal text, for a channel its type declared a counter (`T-02`).
   *
   * Text and not a number, and this is the whole reason the field exists: `ifHCInOctets` is the
   * counter designed to go past 2^53 — about nine days on a 100 Gbit/s link — and that is where
   * a double starts dropping low bits. A rate computed from a rounded counter is wrong by
   * whatever was rounded away, quietly, on exactly the busy links anyone is watching.
   *
   * `value` is still sent, and is the same number lossily: it is what a build that does not know
   * about counters would store, and what a log line shows. The core uses this field.
   */
  counter?: string;
  /**
   * The width the device's counter actually was, when it differs from what the type declared.
   *
   * Discovered rather than declared: `snmp.traffic` prefers `ifHCInOctets` and falls back to the
   * 32-bit counters per device, so a channel created as 64-bit can legitimately be fed 32-bit
   * values. Getting this wrong is not a rounding error — a 32-bit wrap read as a 64-bit counter
   * looks exactly like a device that rebooted, so every wrap would be a gap in the graph rather
   * than a rate, and on a gigabit link that is every thirty-four seconds.
   */
  counterBits?: 32 | 64;
  /**
   * Display metadata, sent so the core can create the channel the first time it sees it.
   * Absent on every subsequent result; the core already has it.
   */
  name?: string;
  unit?: string;
}

/**
 * One check execution, as the probe saw it.
 *
 * `outcome` is what happened to the *check*, not what state the sensor is in. Limits, lookups
 * and the state machine are the core's business (WORKFLOW.MD §4) — a probe that decided states
 * for itself could not have its thresholds edited without a config push, and two probes could
 * disagree about the same rule.
 */
export interface CheckResult {
  sensorId: number;
  /** When the check ran, ISO-8601. The probe's clock; the core does not rewrite it. */
  at: string;
  outcome: 'ok' | 'error';
  message: string;
  durationMs: number;
  /** Empty on a failed check: a Down sensor records no channel values (CLAUDE.md). */
  channels: ChannelReading[];
  /**
   * The probe refused to run this check because of where its credentials may go (`A-41c`): the
   * device's name resolved to an address outside their allowed targets, or to nothing. Only ever
   * `true`, and only beside `outcome: 'error'`. **Not a failure of the device**: nothing was
   * sent to it, so the core holds the sensor Unknown with `message` instead of counting a failed
   * scan. Protocol 24; absent on every other result.
   */
  withheld?: true;
  /**
   * The probe could not start this check (`P-265`): the process that was to run it did not get as
   * far as running it. Only ever `true`, and only beside `outcome: 'error'` with no readings.
   * **Not a failure of the device**: nothing was asked of it. The core holds the sensor Unknown
   * with cause `probe` and `message`, behind the probe's one alarm, until its next result.
   * Protocol 33; never beside `withheld`.
   */
  notStarted?: true;
}

/**
 * A sweep a probe has been told to run (`D-01`).
 *
 * **The range is sent as text and parsed on the probe**, rather than as a list of addresses.
 * 65,536 addresses is about a megabyte of JSON to say what forty characters say, it would have
 * to be re-sent on every resume, and `@ms/shared` gives both ends the same parser — so the two
 * cannot disagree about what the text means.
 */
export interface SweepJob {
  runId: number;
  /** The range, in the spelling the operator typed. Parsed by `parseIpRange` at both ends. */
  range: string;
  /**
   * Where to start, as a count of addresses already offered.
   *
   * **This is the whole of resumability.** A restarted probe, a reconnect and a core failover
   * all resume by sending the cursor the core has durably recorded; an iterator would survive
   * none of them. Re-sweeping a few addresses after a crash is free — a host found twice is the
   * same host — so the cursor is advanced on acknowledgement rather than on send.
   */
  cursor: number;
  /** Milliseconds a single address waits for a reply before it counts as no answer. */
  timeoutMs: number;
  /**
   * How many addresses may be in flight at once.
   *
   * Bounded here rather than by the probe alone so an operator sweeping a lab can go faster and
   * one sweeping a production VLAN can go slower. It is a ceiling either way: the probe also
   * yields to its own check pool, because a discovery run that delays live checks has traded a
   * one-off convenience for the thing the system exists to do.
   */
  concurrency: number;
  /** Addresses per second, averaged. Zero means the concurrency bound is the only limit. */
  ratePerSecond: number;
}

/** One address a sweep found alive, with what it cost to find out. */
export interface SweepHost {
  /** Dotted-quad. Text rather than the integer, because everything downstream reads it. */
  address: string;
  rttMs: number;
}

/**
 * An identification pass a probe has been told to run (`D-02`).
 *
 * **The addresses are sent, unlike the sweep's range**, and the difference is not an
 * inconsistency. A range is a rule that generates addresses and compresses to forty characters; a
 * list of *live* hosts is data the core holds and the probe does not, and there is no rule that
 * regenerates it. It is also far smaller — the hosts a /24 sweep found, not the 254 it tried.
 */
export interface IdentifyJob {
  runId: number;
  /** Dotted-quads, in the order the core wants them tried. */
  addresses: string[];
  /** Where to resume: how many of `addresses` have already been offered. */
  cursor: number;
  /** Per-probe budget, applied to each source rather than to the whole host. */
  timeoutMs: number;
  concurrency: number;
  /**
   * TCP ports to ask about, from the run's level (`D-06`).
   *
   * Sent rather than left to the probe's own default, so the level decides in one place and the
   * estimate an operator was shown is about the run that actually happens. Absent on a probe
   * built before `D-06`, which falls back to its own list — the standard set, which is what
   * such a probe would have used anyway.
   */
  ports?: number[];
  /**
   * The SNMP community to try, or empty to skip SNMP.
   *
   * The one credential identification has. A community is not a secret in any useful sense —
   * it travels unencrypted in every v2c packet — but it is still an operator's configuration, so
   * it goes over the same mutual-TLS channel every other credential does.
   */
  community: string;
}

/** Why a sweep stopped. Only `done` means the range was covered. */
export type SweepEnding = 'done' | 'cancelled' | 'failed' | 'superseded';

/** Why a batch of results was refused. Every one of these is retryable except `invalid`. */
export type NackReason =
  'queue-full' | 'shutting-down' | 'storage-error' | 'unavailable' | 'invalid';

export type RejectCode =
  | 'protocol-version'
  | 'bad-access-key'
  | 'not-approved'
  | 'revoked'
  | 'source-not-allowed'
  | 'internal-error';

/**
 * The reject codes that mean a probe's trust was **withdrawn** — the core knows exactly who this
 * is and will not have it.
 *
 * Exactly the codes `rejectionStopsMonitoring` answers `true` for, which is a correspondence a
 * test pins rather than the type system: the function is an exhaustive `switch` so that adding a
 * code is a compile error there, and deriving one from the other would trade that away.
 */
export type WithdrawnCode = 'revoked' | 'not-approved' | 'source-not-allowed';

/**
 * Whether a rejection means the probe should **stop checking things**, rather than keep going.
 *
 * **Losing the core is not the same as being told to go away, and the probe cannot tell them
 * apart from the socket alone.** A dropped link is an ordinary condition it is built to survive:
 * it keeps scanning and spools to disk (`R-02`), so an outage costs no data. Applying that to a
 * rejection would mean a revoked machine carried on probing devices on somebody's network for as
 * long as its process happened to live — the operator having done the one thing available to
 * stop it. `P-189` closes the connection when a decision has to reach a probe, and a bare close
 * is exactly what a blip looks like, so the code is what carries the difference.
 *
 * The split is by what a person would have to do about it:
 *
 * - **Trust withdrawn** — somebody decided this machine is not part of the installation, or is
 *   not where it is allowed to be. Scanning on would be work nobody asked for and nobody will
 *   accept.
 * - **Cannot agree, or cannot ask** — a version skew, a key out of step, a registry that is
 *   briefly unreachable. Nobody has said this machine must stop; an operator fixes one end and
 *   it comes back. Here the spool is exactly right: the probe keeps checking, keeps the results
 *   on disk, and drains them once the two ends can talk again, so an upgrade or a mistyped key
 *   costs minutes of graphs rather than a hole in them.
 *
 * A `switch` with no `default`, so adding a code is a type error here rather than a silent
 * assignment to whichever side happened to be the fallback.
 */
export function rejectionStopsMonitoring(code: RejectCode): boolean {
  switch (code) {
    case 'revoked':
    case 'not-approved':
    case 'source-not-allowed':
      return true;
    case 'protocol-version':
    case 'bad-access-key':
    case 'internal-error':
      return false;
  }
}

/**
 * What a probe knows about itself and the core does not (`P-13`, `P-04`).
 *
 * **Sent on the heartbeat rather than as its own message**, because it is the same fact the
 * heartbeat already carries — "I am here and this is how I am" — and a second periodic message
 * would be a second thing to keep in step with the first.
 *
 * Every field is optional at the *type* level rather than the schema level being loose: a probe
 * with no spool configured has no spool numbers to report, and absent is a **gap** on that
 * channel rather than a zero. Reporting `spoolDepth: 0` for "there is no spool" and for "the
 * spool is empty" would make the two indistinguishable, which is the one thing this system does
 * not do with missing data.
 */
export interface ProbeHealthReport {
  /** Sensors the wheel currently has scheduled. Compared against what the core assigned. */
  scheduled?: number;
  /** Tick lateness over the last 1,024 ticks, in milliseconds. Only the wheel can measure it. */
  schedulerLagMs?: { p50: number; p95: number; p99: number; max: number };
  /** Ticks the wheel skipped entirely, and clock jumps it resynchronised against. */
  skippedTicks?: number;
  clockJumps?: number;
  /** Worker slots, and how many are busy right now. */
  poolSize?: number;
  poolBusy?: number;
  /**
   * The pool's ceiling in force: the most workers it will grow to now (`P-236`). The derived or
   * configured ceiling, or fewer where memory binds.
   */
  poolCeiling?: number;
  /**
   * The most workers the memory this probe may use can hold (`P-236`), whether or not it is
   * enforced. Absent where memory cannot be read. Since protocol 19.
   */
  poolMemoryCap?: number;
  /**
   * Workers the ceiling would allow and memory does not (`P-236`). Above zero, a saturated pool is
   * waiting on memory rather than on its ceiling, and checks wait and are refused rather than the
   * probe growing until the kernel kills it. Since protocol 19.
   */
  poolHeldBack?: number;
  /** Checks waiting for a slot. Rising queue depth is backpressure before anything is refused. */
  queued?: number;
  /** How long a check waited for a slot, in milliseconds. */
  queueWaitMs?: { p50: number; p95: number; p99: number; max: number };
  /** Checks skipped because the previous scan of that sensor had not finished. Monotonic. */
  deferred?: number;
  /** Checks refused because the queue was full. Monotonic, and never silent. */
  refused?: number;
  timedOut?: number;
  /**
   * Checks the worker pool threw away because it has given up (`P-62`).
   *
   * Not `refused`, which is a full queue on a pool that still works. This is a pool that will run
   * nothing until the probe restarts, and each count is a scan that produced no reading anywhere.
   */
  discarded?: number;
  /**
   * Whether the worker pool is still running checks: 0 alive, 1 given up.
   *
   * **A state, not a measurement**, for the same reason `connected` is one. A pool that has
   * latched off answers nothing and reports `poolBusy: 0`, which reads as an idle probe — while
   * every sensor under it keeps its last state indefinitely, because the core re-evaluates on an
   * arriving result and none arrive. Absent from an older probe, and absent must stay absent:
   * "this build cannot tell you whether its pool is alive" is not "the pool is alive".
   */
  poolState?: number;
  workerCrashes?: number;
  /**
   * Check workers that never said ready (`P-263`): still loading the probe's sensor types when the
   * pool's start-up bound passed, so the pool terminated them, or dead while loading. A running
   * total. Sent only to a core at protocol 30.
   *
   * **Not `workerCrashes`**, which names a check type that fell over. A worker that hangs while
   * loading ran no check and crashed nothing: the pool gave up on it and started another. One that
   * dies while loading is in both, as it was in `workerCrashes` before this field existed.
   */
  workerStartupFailed?: number;
  /**
   * Session-pool counters, summed across the probe's check workers (`P-36`).
   *
   * **Absent together or present together**, and absent on a probe whose registry keeps no
   * session pools at all. `sessionOverflows` is the one with a threshold: the pools open past
   * their bound rather than fail a check, which is the right trade and is only defensible while
   * somebody can see it happening.
   */
  sessionsOpen?: number;
  sessionOverflows?: number;
  sessionsEvicted?: number;
  sessionsOpened?: number;
  /**
   * The child-process runner (`P-61`).
   *
   * EXE and Script checks run in a process of their own rather than a worker, so they have their
   * own ceiling, their own queue and their own counters — and until `P-61` none of them reached
   * a health sensor at all. A probe saturated by slow shell-outs reported a perfectly healthy
   * pool while it deferred and refused every check.
   *
   * **Absent together**, and absent on a probe that runs no isolated sensor types, so the
   * channels gap rather than reading a confident zero on a build with nothing to say.
   */
  childSlots?: number;
  childBusy?: number;
  childQueued?: number;
  childDeferred?: number;
  childRefused?: number;
  childTimedOut?: number;
  childCrashes?: number;
  /**
   * Checks whose child process never got as far as running them (`P-260`): still loading the
   * probe's sensor types when the start-up bound passed, unable to load them, or exited or was
   * killed while loading them. A running total.
   * Sent only to a core at protocol 29, and absent with the rest of the child block.
   *
   * **Not `childTimedOut`**, which counts checks that ran and ran out of time. A probe starved of
   * CPU fails its scripts here, and an operator reading `childTimedOut` would go to the scripts.
   */
  childStartupFailed?: number;
  /**
   * How long a child process takes from its spawn to being ready to run its check, in
   * milliseconds, over its last 256 starts (`P-260`). Absent until one has started or been given
   * up. Sent only to a core at protocol 29.
   */
  childStartupMs?: { p50: number; p95: number; p99: number; max: number };
  /**
   * Script process groups a check process started and left open when it went, which the runner
   * then ended with `SIGKILL` (`P-266`): the check process was killed outright, ran out of heap or
   * crashed, and so never ended its script. A running total, absent with the rest of the child
   * block, and sent only to a core at protocol 31 (`P-275`).
   */
  scriptGroupsEnded?: number;
  /**
   * Groups a check process named on its stdout that `/proc` did not show to be its own (`P-266`):
   * a forged line, or a check process killed so soon after its script's spawn that the script was
   * orphaned before the line was read. Never signalled. Sent only to a core at protocol 31.
   */
  scriptGroupsRefused?: number;
  /**
   * Groups left open whose id named something else by the time the check process had gone
   * (`P-266`): the leader's pid reused, or, the leader reaped, a member outside the script's
   * session or of another uid. Never signalled. Sent only to a core at protocol 31.
   */
  scriptGroupsRecycled?: number;
  /**
   * The SNMP-trap and syslog listeners (`P-64`), each absent unless this probe runs that one.
   * From protocol 13, the `listenerCounters` capability (`P-294`).
   *
   * **`rejected` is the one worth having.** A message turned away by the community or sender
   * allow-list never reaches the ring, so it produces no batch, no `dropped` and no `unmatched` —
   * and it is deliberately not logged, because a misconfigured device retries for ever. Without
   * this the sensor drains nothing, throws nothing, and renders "no traps since …": a green
   * sensor reporting a quiet network at a receiver turning everything away. `received` is what
   * separates a live listener from a dead socket when no sensor is draining, and `malformed` is
   * ordinary on a public port. None of the three is an alarm; they are what turns "my trap sensor
   * reads zero" into a diagnosis.
   */
  trapReceived?: number;
  trapRejected?: number;
  trapMalformed?: number;
  syslogReceived?: number;
  syslogRejected?: number;
  syslogMalformed?: number;
  /**
   * Notifications and messages a listener received and its buffer overwrote before a sensor that
   * was following the buffer had read them (`B-14`). Sent only to a core at protocol 26.
   *
   * **Each listener's own backpressure**, as `flowOverwritten` is the flow collector's: what
   * arrived, was counted in `received`, and was lost to `bufferSize`. A running total since the
   * listener started, counted once a record however many sensors were behind it, and zero while
   * no sensor of that kind is assigned. Each absent with the listener it belongs to.
   */
  trapOverwritten?: number;
  syslogOverwritten?: number;
  /**
   * What a listener received that a sensor's first scan after a probe restart, or after a cut
   * configuration push took it off the scheduler, named as `earlier` (`P-254`, `P-270`): it
   * arrived before that scan's window, which reaches one interval back, so it is neither in the
   * reading nor in the scan's `dropped`. A running total since the listener started, counted once
   * a record however many sensors named it — as `trapOverwritten` counts a loss once however many
   * sensors had it — and absent with the listener it belongs to. Sent only to a core at protocol
   * 31.
   *
   * **Not a loss, and not in `trapOverwritten`.** What the ring overwrote before it could tell
   * when it arrived (`undated`) is a loss and is counted there; this is what it could date and
   * kept out of the scan, because a scan covering hours of an outage as one reading would trip
   * every limit set per interval at once.
   */
  trapEarlier?: number;
  syslogEarlier?: number;
  /**
   * The flow collector's counters (`B-02`), absent unless this probe runs it — and sent only to a
   * core at protocol 23 (`B-07`), where `healthForPeer` leaves them in.
   */
  flowReceived?: number;
  flowRejected?: number;
  flowMalformed?: number;
  /**
   * Flows an exporter's own running sequence says it sent and this probe never received (`B-02`).
   *
   * **Unlike every other counter here, this one measures an absence.** NetFlow rides UDP, which
   * drops silently, so a collector cannot notice loss by looking at what arrived — the exporter's
   * `flowSequence` is the only evidence there is. Without it a link dropping a third of its flow
   * export looks exactly like a quiet network.
   */
  flowMissed?: number;
  /** Flow records this collector had no template for (`B-03`). */
  flowUndecodable?: number;
  /**
   * Flow records this probe received and its buffer overwrote before a sensor that was following
   * the buffer had read them (`B-11`). Sent only to a core at protocol 25.
   *
   * **The collector's own backpressure, which `flowMissed` is not.** That one is what the network
   * lost on the way here; this is what arrived, was counted in `flowReceived`, and was lost to
   * `flowListener.bufferSize`. A running total since the collector started, counted once a
   * record however many sensors were behind it.
   */
  flowOverwritten?: number;
  /** The flow collector's `earlier` (`P-270`), as `trapEarlier` is the trap listener's. */
  flowEarlier?: number;
  /**
   * Whether this probe is getting back the checks it dispatches (`P-76`): 1 yes, 0 no.
   *
   * **The half `P-74` cannot see.** The core can tell whether a probe is delivering *anything*,
   * from arrival times. It cannot tell whether the probe is dispatching checks that never come
   * back while others complete, because the probe looks perfectly healthy from outside. Only the
   * probe sees dispatch and completion on one thread against a monotonic clock.
   */
  checksCompleting?: number;
  /**
   * Sensors whose last completed check is older than four of their own scan intervals.
   *
   * A count rather than a state, and a Warning rather than Down: the probe *is* working, and some
   * of what it carries is not being checked. Marking those sensors Unknown is the core's decision
   * and not the probe's, and marking the rest would be a false claim about sensors that are fine.
   */
  checksBehind?: number;
  /** Checks accepted by a runner and not yet settled, and how long the oldest has waited. */
  checksOutstanding?: number;
  checkStalledMs?: number;
  /** Results written to disk and not yet acknowledged by the core. */
  spoolPending?: number;
  spoolBytes?: number;
  /** Results evicted to stay inside the spool cap. The number that must never be a surprise. */
  spoolDropped?: number;
  /** Spool lines that did not parse — a torn write at a crash boundary. */
  spoolCorrupt?: number;
  /**
   * Results the spool was given and could not write (`P-78`).
   *
   * Not `spoolDropped`, which is eviction at the cap — that is a full disk, decided with the
   * results already written. This is a write that failed, so the readings were lost before the
   * spool held them at all. A probe that cannot write its spool is losing every check it runs,
   * and this is the only number that says so.
   */
  spoolUnwritten?: number;
  /**
   * How long the spool has held results with the link up and nothing moving (`H-01`).
   *
   * Zero while the drain is making progress or has nothing to make progress on. Non-zero means
   * the one failure `615c9f3` was: a connected probe, a spool that will not move, and no other
   * signal saying so — depth alone cannot tell a stall from a legitimate catch-up.
   */
  spoolStalledMs?: number;
  /**
   * Channel readings taken out of this probe's results because the wire could not carry them
   * (`P-277`, `P-283`): a key or a value `fitResult` cannot send, or channels past the limit. Each
   * is a reading that exists nowhere; the probe's log names the sensor. A running total of both
   * runners and the drain's refit, so always present at protocol 32. Sent only to a core there.
   */
  resultChannelsDropped?: number;
  /**
   * Spooled results the drain discarded because the core refused their batch as `invalid` — today
   * only a probe the core has not approved (`P-283`). A running total, absent with the drain.
   * Sent only to a core at protocol 32.
   */
  spoolRejected?: number;
  /**
   * Spooled results the drain discarded because one alone was larger than a frame (`P-277`,
   * `P-283`). A running total, absent with the drain. Sent only to a core at protocol 32.
   */
  spoolOversized?: number;
  /**
   * A random identifier the probe process chose when it started, the same on every heartbeat it
   * sends and different on every start (`P-284` review). The core reads a running total's growth
   * against it: two readings with different ones are two processes, whatever the totals and the
   * uptimes say. Sent only to a core at protocol 32, with the three above.
   */
  instanceId?: string;
  /** The probe process itself: percentage of one core, resident megabytes, seconds since start. */
  cpuPercent?: number;
  memoryMb?: number;
  uptimeSeconds?: number;
  /**
   * The probe's *machine*: what the operating system says is available, as a percentage of its
   * total and in megabytes — the lowest in the last thirty seconds, not the latest (`P-208`), and
   * from protocol 20 the lowest since the last heartbeat the core acknowledged (`P-219`).
   *
   * Absent where the platform cannot say, so the channels gap: a kernel without `MemAvailable`,
   * or anything but Linux and Windows. Since protocol 17, and stripped for an older core.
   */
  memoryAvailablePercent?: number;
  memoryAvailableMb?: number;
  /**
   * The probe's *cgroup*: its working set as a percentage of the ceiling the kernel enforces on it
   * — the lower of `memory.high` and `memory.max` — and that ceiling in megabytes (`P-210`). The
   * highest over the same span as the machine's, and **above 100 past the ceiling**, which a cgroup can be:
   * the kernel throttles it past `memory.high` rather than stopping it there.
   *
   * Absent where there is no ceiling, on cgroup v1, and off Linux. Since protocol 18.
   */
  memoryLimitUsagePercent?: number;
  memoryLimitMb?: number;
  /**
   * Log lines the probe dropped since it started: refused at its output's bound while the journal
   * was not reading, or lost to an output that closed (`P-216` part 3). **A running total**, so a
   * report the core never got loses nothing; the core records the growth between two readings.
   * Since protocol 21.
   */
  logDropped?: number;
  /** Bytes of log the output holds that its reader has not taken yet. Since protocol 21. */
  logBacklogBytes?: number;
}

export type ProbeToCoreMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      /** Stable probe identity (CAPABILITIES.MD §8). Empty on a probe's very first connection. */
      gid: string;
      displayName: string;
      agentVersion: string;
      accessKey: string;
      /**
       * Fingerprint of the configuration this probe is currently running, or `''` if it has
       * none. The core answers `config-unchanged` when it matches, which is what stops a
       * reconnect after a blip from re-sending five thousand assignments that did not change.
       *
       * Held in memory, deliberately not persisted: a restarted probe has no configuration to
       * keep the fingerprint of, so persisting one would only let it claim to be up to date
       * while scanning nothing.
       */
      configVersion?: string;
    }
  | { type: 'heartbeat'; seq: number; sentAt: string; health?: ProbeHealthReport }
  | {
      type: 'results';
      /**
       * Identifies this batch so the acknowledgement can name it. The probe holds the batch in
       * its spool until it is acked, so a lost ack costs a duplicate write, never a lost
       * reading — and duplicates are free, because the unique index on (channel_id, time) makes
       * the write idempotent.
       */
      batchId: string;
      results: CheckResult[];
      /**
       * Results still on disk *after* this batch, or absent when the probe does not track it.
       *
       * Only the probe knows this, and without it the core cannot tell a live batch from a
       * probe replaying an hour of backlog — so it has to slow both down alike, which is
       * precisely how a catch-up stalls everyone else's live ingestion (R-03).
       */
      backlog?: number;
      /**
       * When the probe sent this batch, by the probe's own clock (`P-169`).
       *
       * **The half that makes a replay answerable.** `CheckResult.at` is the probe's clock too,
       * so `sentAt - max(result.at)` is a duration measured entirely on one machine: seconds for
       * a live batch, hours for a spool drain, and correct however far the probe's clock is from
       * the core's. Comparing the results against the *core's* now instead — `P-146`'s original
       * test — makes a probe five minutes slow look like a permanent replay, which is `R17`.
       *
       * `backlog` is not a substitute and was wrongly used as one (`P-169`): it counts rows
       * still on disk after this batch, so a busy live probe whose scan tick outruns one batch
       * reports thousands of them. It is a pacing signal, which is what `R-03` added it for.
       *
       * Absent from a probe below protocol 16, and then the core falls back to its own clock.
       */
      sentAt?: string;
    }
  | {
      type: 'config-ack';
      version: string;
      /** How many assignments the probe now has scheduled. The core logs any disagreement. */
      scheduled: number;
    }
  | {
      /**
       * How far a sweep has got, and what it found (`D-01`).
       *
       * Progress and findings in one message on purpose. They are the same fact — "these
       * addresses have been offered, and these of them answered" — and splitting them would let
       * the core record a cursor past a host whose reply had not arrived yet, which is a host
       * silently missed on the one run that mattered.
       */
      type: 'sweep-progress';
      runId: number;
      /** Addresses offered so far, counted from the start of the range, not of this session. */
      cursor: number;
      /** Alive since the last progress message. Empty is an ordinary and common message. */
      found: SweepHost[];
      /** Addresses that could not be attempted at all — no route, no permission to ping. */
      failed: number;
    }
  | {
      type: 'sweep-finished';
      runId: number;
      ending: SweepEnding;
      cursor: number;
      /** Empty unless `ending` is `failed`, where it is what to tell the operator. */
      message: string;
    }
  | {
      /**
       * Hosts identified since the last message (`D-02`).
       *
       * Fingerprints and the cursor together, for the reason the sweep sends hosts and its cursor
       * together: they are the same fact, and a cursor recorded past a fingerprint that had not
       * arrived is a host that never gets identified and never gets asked again.
       */
      type: 'identify-progress';
      runId: number;
      cursor: number;
      /** JSON, validated against the fingerprint shape by the core rather than by the schema. */
      found: unknown[];
    }
  | {
      type: 'identify-finished';
      runId: number;
      ending: SweepEnding;
      cursor: number;
      message: string;
    }
  | {
      /**
       * The answer to one `query` (`R-09`).
       *
       * **Always sent, including when the probe cannot do the thing.** The core has an API call
       * waiting on this id: a query that is simply not answered becomes a request that hangs
       * until the timeout for a reason nobody can see, where a refusal arrives immediately and
       * says what to do about it.
       */
      type: 'query-result';
      queryId: string;
      /** The check's own result. Present when `failure` is absent, and never both. */
      result?: CheckResult;
      /** Why there is no result. `failed` is the check reporting a fault at the target. */
      failure?: QueryFailure;
      message?: string;
    }
  | { type: 'bye'; reason: string };

export type CoreToProbeMessage =
  | {
      type: 'welcome';
      protocolVersion: number;
      coreVersion: string;
      /** Identity the core assigned; the probe persists it and presents it next time. */
      gid: string;
      heartbeatIntervalMs: number;
      /**
       * Whether an administrator has approved this probe (`R-01`).
       *
       * **A welcome rather than a rejection, and that is deliberate.** An unapproved probe is
       * not an attacker — it is a machine somebody has just installed — so it is let in far
       * enough to be *seen*: it gets its identity, it heartbeats, and it appears in the
       * approval queue with the name and version it reported. What it does not get is any
       * configuration, so it scans nothing at all until a person says so. Rejecting it instead
       * would leave the administrator approving something they cannot see, and would make the
       * probe re-enrol under a new identity on every retry.
       *
       * Optional so a version-5 core, which never sends it, still reads as approved — that
       * core had no notion of approval and trusted whatever presented the access key.
       */
      approved?: boolean;
      /**
       * A key issued to this probe alone, sent once, at the moment it is approved.
       *
       * The probe persists it and presents it from then on instead of the shared enrolment key.
       * That is the whole point of issuing one: revoking a single probe otherwise means
       * rotating the key every probe in the installation shares, which nobody does, which means
       * in practice nothing is ever revoked. The core keeps only a hash.
       */
      accessKey?: string;
    }
  | { type: 'reject'; code: RejectCode; message: string }
  | { type: 'heartbeat-ack'; seq: number }
  | {
      type: 'results-ack';
      batchId: string;
      /**
       * Readings actually written. Fewer than were sent is normal on replay — the duplicates
       * were already there — and is worth surfacing rather than hiding.
       */
      storedSamples: number;
      /**
       * Backpressure, before it becomes a refusal. Zero means "keep going"; anything else asks
       * the probe to wait that long before offering more. Sending it on the *ack* is what makes
       * the signal gradual: by the time batches are being refused outright it is already too
       * late to be polite about it.
       */
      retryAfterMs: number;
    }
  | {
      type: 'results-nack';
      batchId: string;
      reason: NackReason;
      retryAfterMs: number;
    }
  /** The whole assignment set. Sent on connect, and whenever a delta would be larger. */
  | { type: 'config-set'; version: string; sensors: SensorAssignment[]; final?: boolean }
  /**
   * What changed since the version the probe is holding.
   *
   * Only ever sent to a probe the core has already sent a `config-set` to *on this connection*:
   * a delta is relative to state the core knows the peer has, and the core only knows that while
   * the session is alive. After a disconnect the answer is a snapshot or `config-unchanged`,
   * never a delta against a guess.
   */
  /**
   * `final: false` says another message of this push is still coming (`R18`).
   *
   * **A version is only true when the whole push has landed.** A push above the message cap is
   * a `config-set` plus N-1 deltas at one version, and the probe stamped itself as holding that
   * version on the first of them — so a link that dropped between chunks left it with part of
   * the change and a fingerprint that says it is current. It reconnects, the fingerprint
   * matches, the core answers `config-unchanged`, and nothing re-pushes: an operator's pause of
   * three thousand sensors half-lands and nothing anywhere disagrees. The ack check (`P-149`)
   * cannot rescue it, because the acks for the missing chunks never arrive — the connection is
   * what broke.
   *
   * Absent means final, so an older core that does not send it still gets a probe that stamps.
   */
  | {
      type: 'config-delta';
      version: string;
      upserted: SensorAssignment[];
      removed: number[];
      final?: boolean;
    }
  /** The probe's fingerprint already matches. Nothing to send, and nothing to apply. */
  | { type: 'config-unchanged'; version: string }
  /** Start or resume a sweep (`D-01`). Sending one for a run already running resumes it. */
  | { type: 'sweep-start'; job: SweepJob }
  /**
   * Stop a sweep.
   *
   * Cancellation is a message rather than a disconnect because a sweep must stop *promptly* —
   * an operator who typed the wrong range wants the pings to stop now, not when the last of
   * 65,536 timeouts expires.
   */
  | { type: 'sweep-cancel'; runId: number }
  /** Identify the hosts a sweep found (`D-02`). Resent to resume, exactly as `sweep-start` is. */
  | { type: 'identify-start'; job: IdentifyJob }
  | { type: 'identify-cancel'; runId: number }
  /**
   * Run this now and answer on `queryId` (`R-09`).
   *
   * The only message in this protocol the core *waits* for. Everything else is one-way — the
   * core tells a probe what to scan and the probe reports what it found, each on its own clock —
   * which is why `D-02` went down the asynchronous discovery path instead of this one. What
   * makes this different is that a person is looking at a spinner.
   */
  | { type: 'query'; queryId: string; query: ProbeQuery; timeoutMs: number }
  /**
   * Stop caring about a query.
   *
   * Sent when the core's own deadline passes, so the probe abandons work whose answer nothing
   * is waiting for any more. Advisory: a probe that has already replied, or has never heard of
   * this id, does nothing and says nothing.
   */
  | { type: 'query-cancel'; queryId: string }
  | { type: 'bye'; reason: string };

export type ProtocolMessage = ProbeToCoreMessage | CoreToProbeMessage;

export class ProtocolError extends AppError {
  constructor(message: string, context?: Record<string, string | number>) {
    super('PROTOCOL_INVALID', message, { context: context ?? {} });
    this.name = 'ProtocolError';
  }
}

// --- Schemas -------------------------------------------------------------------------------
// CLAUDE.md: validate at boundaries with JSON Schema — API inputs, sensor params, config files
// and probe messages. A peer is a boundary even when it is our own code on the other end.

/**
 * The percentile bundle the health fields that are timings share.
 *
 * Bounded rather than open: these arrive on every heartbeat from a peer that is, by definition,
 * not fully trusted, and an unbounded number is a chart axis somebody else controls.
 */
const PERCENTILES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['p50', 'p95', 'p99', 'max'],
  properties: {
    p50: { type: 'number', minimum: 0, maximum: 86_400_000 },
    p95: { type: 'number', minimum: 0, maximum: 86_400_000 },
    p99: { type: 'number', minimum: 0, maximum: 86_400_000 },
    max: { type: 'number', minimum: 0, maximum: 86_400_000 },
  },
} as const;

/**
 * The probe's own numbers, on the heartbeat (`P-13`).
 *
 * Nothing is required. A probe with no spool has no spool numbers, and a field that is absent is
 * a **gap** on its channel rather than a zero — which is the difference between "there is no
 * spool" and "the spool is empty".
 */
const PROBE_HEALTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scheduled: { type: 'integer', minimum: 0 },
    schedulerLagMs: PERCENTILES_SCHEMA,
    skippedTicks: { type: 'integer', minimum: 0 },
    clockJumps: { type: 'integer', minimum: 0 },
    poolSize: { type: 'integer', minimum: 0 },
    poolBusy: { type: 'integer', minimum: 0 },
    poolCeiling: { type: 'integer', minimum: 0 },
    poolMemoryCap: { type: 'integer', minimum: 0 },
    poolHeldBack: { type: 'integer', minimum: 0 },
    queued: { type: 'integer', minimum: 0 },
    queueWaitMs: PERCENTILES_SCHEMA,
    deferred: { type: 'integer', minimum: 0 },
    refused: { type: 'integer', minimum: 0 },
    timedOut: { type: 'integer', minimum: 0 },
    discarded: { type: 'integer', minimum: 0 },
    poolState: { type: 'integer', minimum: 0, maximum: 1 },
    workerCrashes: { type: 'integer', minimum: 0 },
    workerStartupFailed: { type: 'integer', minimum: 0 },
    sessionsOpen: { type: 'integer', minimum: 0 },
    sessionOverflows: { type: 'integer', minimum: 0 },
    sessionsEvicted: { type: 'integer', minimum: 0 },
    sessionsOpened: { type: 'integer', minimum: 0 },
    childSlots: { type: 'integer', minimum: 0 },
    childBusy: { type: 'integer', minimum: 0 },
    childQueued: { type: 'integer', minimum: 0 },
    childDeferred: { type: 'integer', minimum: 0 },
    childRefused: { type: 'integer', minimum: 0 },
    childTimedOut: { type: 'integer', minimum: 0 },
    childCrashes: { type: 'integer', minimum: 0 },
    childStartupFailed: { type: 'integer', minimum: 0 },
    childStartupMs: PERCENTILES_SCHEMA,
    scriptGroupsEnded: { type: 'integer', minimum: 0 },
    scriptGroupsRefused: { type: 'integer', minimum: 0 },
    scriptGroupsRecycled: { type: 'integer', minimum: 0 },
    trapReceived: { type: 'integer', minimum: 0 },
    trapRejected: { type: 'integer', minimum: 0 },
    trapMalformed: { type: 'integer', minimum: 0 },
    syslogReceived: { type: 'integer', minimum: 0 },
    syslogRejected: { type: 'integer', minimum: 0 },
    syslogMalformed: { type: 'integer', minimum: 0 },
    trapOverwritten: { type: 'integer', minimum: 0 },
    syslogOverwritten: { type: 'integer', minimum: 0 },
    trapEarlier: { type: 'integer', minimum: 0 },
    syslogEarlier: { type: 'integer', minimum: 0 },
    flowReceived: { type: 'integer', minimum: 0 },
    flowRejected: { type: 'integer', minimum: 0 },
    flowMalformed: { type: 'integer', minimum: 0 },
    flowMissed: { type: 'integer', minimum: 0 },
    flowUndecodable: { type: 'integer', minimum: 0 },
    flowOverwritten: { type: 'integer', minimum: 0 },
    flowEarlier: { type: 'integer', minimum: 0 },
    checksCompleting: { type: 'integer', minimum: 0, maximum: 1 },
    checksBehind: { type: 'integer', minimum: 0 },
    checksOutstanding: { type: 'integer', minimum: 0 },
    checkStalledMs: { type: 'integer', minimum: 0 },
    spoolPending: { type: 'integer', minimum: 0 },
    spoolBytes: { type: 'integer', minimum: 0 },
    spoolDropped: { type: 'integer', minimum: 0 },
    spoolCorrupt: { type: 'integer', minimum: 0 },
    spoolUnwritten: { type: 'integer', minimum: 0 },
    spoolStalledMs: { type: 'integer', minimum: 0 },
    resultChannelsDropped: { type: 'integer', minimum: 0 },
    spoolRejected: { type: 'integer', minimum: 0 },
    spoolOversized: { type: 'integer', minimum: 0 },
    // A UUID, and nothing longer: the core holds it per probe for as long as it runs.
    instanceId: {
      type: 'string',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      [PATTERN_MESSAGE]:
        'must be a UUID in lowercase hexadecimal, such as 0f8fad5b-d9cb-469f-a165-70867728950e',
    },
    cpuPercent: { type: 'number', minimum: 0 },
    memoryMb: { type: 'number', minimum: 0 },
    uptimeSeconds: { type: 'number', minimum: 0 },
    memoryAvailablePercent: { type: 'number', minimum: 0, maximum: 100 },
    memoryAvailableMb: { type: 'number', minimum: 0 },
    // No maximum: past `memory.high` the working set stands above the ceiling while it is throttled.
    memoryLimitUsagePercent: { type: 'number', minimum: 0 },
    memoryLimitMb: { type: 'number', minimum: 0 },
    logDropped: { type: 'integer', minimum: 0 },
    logBacklogBytes: { type: 'integer', minimum: 0 },
  },
} as const;

/**
 * Every field the heartbeat's health may carry, for the test that holds `healthForPeer` to them: a
 * field added here and not gated there is one an older core refuses, on every heartbeat.
 */
export const PROBE_HEALTH_FIELDS: readonly string[] = Object.keys(PROBE_HEALTH_SCHEMA.properties);

/**
 * One check result on the wire. Its bounds are `RESULT_LIMITS`, which `fitResult` makes every
 * result a runner settles fit before it is spooled (`P-277`).
 *
 * Extracted so `results` and `R-09`'s `query-result` cannot drift: an on-demand check answers
 * with the same shape a scheduled one reports, and two copies of this would eventually disagree
 * about a field in exactly the case an operator was using to find out why the real one failed.
 */
const CHECK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    sensorId: { type: 'integer', minimum: 1 },
    at: { type: 'string', minLength: 1, maxLength: 64 },
    outcome: { type: 'string', enum: ['ok', 'error'] },
    message: { type: 'string', maxLength: RESULT_LIMITS.message },
    durationMs: { type: 'number', minimum: 0 },
    // Only `true` (`A-41c`): a check the probe refused over where its credentials may go.
    withheld: { const: true },
    // Only `true` (`P-265`): a check the probe could not start.
    notStarted: { const: true },
    channels: {
      type: 'array',
      maxItems: RESULT_LIMITS.channels,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', minLength: 1, maxLength: RESULT_LIMITS.key },
          // No NaN and no Infinity: JSON cannot carry them, and a channel whose value is not a
          // number is a gap, which is the absence of a reading.
          value: { type: 'number' },
          // The exact counter and the width it was read at (`T-02`). Text because an unsigned
          // 64-bit counter does not survive a double, and 20 digits is the most one can have.
          counter: {
            type: 'string',
            pattern: '^[0-9]{1,20}$',
            [PATTERN_MESSAGE]: 'must be an unsigned integer written in 1 to 20 decimal digits',
          },
          counterBits: { type: 'integer', enum: [32, 64] },
          name: { type: 'string', minLength: 1, maxLength: RESULT_LIMITS.name },
          unit: { type: 'string', maxLength: RESULT_LIMITS.unit },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['sensorId', 'at', 'outcome', 'message', 'durationMs', 'channels'],
  additionalProperties: false,
  // **A refused check is an error with no readings, and the schema says so** (`A-41c`). The mark
  // takes a result out of the batch before the state machine sees it, so on anything else it
  // would drop a reading, or hide a result that measured something. Refused here, a probe build
  // that marks what it should not is told at the boundary instead of being quietly believed.
  // `withheld: true` is there for strict mode (`P-379`), whose `strictRequired` looks for a
  // required property among the `properties` beside it: `true` constrains nothing, so what this
  // accepts and every error it gives are as they were.
  //
  // **A check the probe could not start is the same shape** (`P-265`), and never also refused:
  // the two marks are two different holds, and a result that carried both could not be put in
  // either.
  allOf: [
    {
      if: { properties: { withheld: true }, required: ['withheld'] },
      then: {
        properties: { outcome: { const: 'error' }, channels: { type: 'array', maxItems: 0 } },
      },
    },
    {
      if: { properties: { notStarted: true }, required: ['notStarted'] },
      then: {
        properties: { outcome: { const: 'error' }, channels: { type: 'array', maxItems: 0 } },
        // Only of an object: of anything else `required` holds vacuously, and `not` would add an
        // error to the one that says it is not an object.
        not: { type: 'object', required: ['withheld'] },
      },
    },
  ],
} as const;

const QUERY_FAILURES = ['offline', 'too-old', 'busy', 'timeout', 'unsupported', 'failed'] as const;

/**
 * A dotted-quad IPv4 address and nothing else (`A-69`): four octets from 0 to 255, no leading
 * zero, no mask, no space. What `toText` in `net/ip-range.ts` renders, what PostgreSQL's `host()`
 * renders of an IPv4 `inet`, and what Node's `isIPv4` accepts. Exported for the test that holds
 * it to the other two.
 */
export const IPV4_ADDRESS_PATTERN =
  '^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$';

/** What a value `IPV4_ADDRESS_PATTERN` refuses is told, in a log line's reason (`P-376`). */
const IPV4_ADDRESS_MESSAGE =
  'must be a dotted-quad IPv4 address, such as 192.0.2.10: four numbers from 0 to 255, ' +
  'with no leading zero, mask or space';

const probeToCoreSchema = {
  type: 'object',
  // For strict mode's `strictRequired` (`P-379`), as `withheld` is above: each branch says what
  // `type` must be, and `true` here adds no constraint and no error.
  properties: { type: true },
  required: ['type'],
  discriminator: { propertyName: 'type' },
  oneOf: [
    {
      properties: {
        type: { const: 'hello' },
        protocolVersion: { type: 'integer', minimum: 0 },
        gid: { type: 'string', maxLength: 128 },
        displayName: { type: 'string', minLength: 1, maxLength: 240 },
        agentVersion: { type: 'string', maxLength: 64 },
        accessKey: { type: 'string', maxLength: 512 },
        // Optional, not required: a version-2 probe does not send one, and its hello must still
        // validate rather than being refused for speaking the version it advertised.
        configVersion: { type: 'string', maxLength: 128 },
      },
      required: ['type', 'protocolVersion', 'gid', 'displayName', 'agentVersion', 'accessKey'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'heartbeat' },
        seq: { type: 'integer', minimum: 0 },
        sentAt: { type: 'string', minLength: 1, maxLength: 64 },
        // Optional, so a probe below version 7 still validates (`P-13`). Every field inside is
        // optional too: absent is a gap on that channel, never a zero.
        health: PROBE_HEALTH_SCHEMA,
      },
      required: ['type', 'seq', 'sentAt'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'results' },
        batchId: { type: 'string', minLength: 1, maxLength: 128 },
        // Optional, so a version-3 probe that does not report one still validates. Absent is
        // read as "unknown", which is paced like a live batch — the behaviour before R-03.
        backlog: { type: 'integer', minimum: 0 },
        // Shaped like the heartbeat's `sentAt` rather than with `format: 'date-time'`: this
        // validator runs without ajv-formats, where an unknown format is silently no
        // validation at all.
        sentAt: { type: 'string', minLength: 1, maxLength: 64 },
        results: {
          type: 'array',
          // Bounded here as well as by the 4 MB frame cap, so a malformed peer is refused by
          // the schema with a message rather than by the decoder with a socket reset.
          maxItems: 5000,
          items: CHECK_RESULT_SCHEMA,
        },
      },
      required: ['type', 'batchId', 'results'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'config-ack' },
        version: { type: 'string', maxLength: 128 },
        scheduled: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'version', 'scheduled'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'sweep-progress' },
        runId: { type: 'integer', minimum: 1 },
        cursor: { type: 'integer', minimum: 0 },
        found: {
          type: 'array',
          // A batch bound rather than a run bound: a /16 where everything answers is 65,534
          // hosts, and they arrive across many progress messages.
          maxItems: 4096,
          items: {
            type: 'object',
            properties: {
              // **Dotted-quad IPv4, by pattern** (`A-73`), as `identify-start` has it (`A-69`).
              // The lengths alone took any seven to fifteen characters, cast to `inet` by the
              // core: `fe80::1` got a row, and a string that is no address failed the insert
              // for the whole batch. No protocol number, because nothing a probe sends stops
              // being valid: the one sender is `SweepRunner`, which reports `toText` of a
              // position in an IPv4 range and nothing else.
              address: {
                type: 'string',
                minLength: 7,
                maxLength: 15,
                pattern: IPV4_ADDRESS_PATTERN,
                [PATTERN_MESSAGE]: IPV4_ADDRESS_MESSAGE,
              },
              rttMs: { type: 'number', minimum: 0 },
            },
            required: ['address', 'rttMs'],
            additionalProperties: false,
          },
        },
        failed: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'runId', 'cursor', 'found', 'failed'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'sweep-finished' },
        runId: { type: 'integer', minimum: 1 },
        ending: { type: 'string', enum: ['done', 'cancelled', 'failed', 'superseded'] },
        cursor: { type: 'integer', minimum: 0 },
        message: { type: 'string', maxLength: 2000 },
      },
      required: ['type', 'runId', 'ending', 'cursor', 'message'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'identify-progress' },
        runId: { type: 'integer', minimum: 1 },
        cursor: { type: 'integer', minimum: 0 },
        // `unknown` items, validated by the core rather than here. A fingerprint is a growing
        // shape — `D-03` will want fields this build has not thought of — and a wire schema that
        // enumerated them would refuse a newer probe's perfectly good answer outright, which is
        // the one failure mode a version negotiation is supposed to prevent.
        found: { type: 'array', maxItems: 1024 },
      },
      required: ['type', 'runId', 'cursor', 'found'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'identify-finished' },
        runId: { type: 'integer', minimum: 1 },
        ending: { type: 'string', enum: ['done', 'cancelled', 'failed', 'superseded'] },
        cursor: { type: 'integer', minimum: 0 },
        message: { type: 'string', maxLength: 2000 },
      },
      required: ['type', 'runId', 'ending', 'cursor', 'message'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'query-result' },
        queryId: { type: 'string', minLength: 1, maxLength: 64 },
        // Neither is required, and both are optional rather than a `oneOf`: a result with no
        // failure is an answer, a failure with no result is a refusal, and a peer that sends
        // neither is a probe reporting that it did nothing — which the core reads as a failure
        // it can name rather than as a promise it must keep waiting on.
        result: CHECK_RESULT_SCHEMA,
        failure: { type: 'string', enum: QUERY_FAILURES },
        message: { type: 'string', maxLength: 2000 },
      },
      required: ['type', 'queryId'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'bye' },
        reason: { type: 'string', maxLength: 512 },
      },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
  ],
} as const;

/**
 * One assignment on the wire.
 *
 * `params` is `additionalProperties: true` because a sensor type's own `paramsSchema` is what
 * validates it, and that schema lives in the catalogue rather than here. What this bounds is the
 * shape and the size — a peer is a boundary even when it is our own code (CLAUDE.md).
 */
const sensorAssignmentSchema = {
  type: 'object',
  properties: {
    sensorId: { type: 'integer', minimum: 1 },
    sensorType: { type: 'string', minLength: 1, maxLength: 100 },
    params: { type: 'object', additionalProperties: true },
    target: {
      type: 'object',
      properties: {
        host: { type: 'string', maxLength: 255 },
        ipVersion: { type: 'string', enum: ['auto', 'v4', 'v6'] },
        // One device's exception to the target policy (`A-64`, protocol 28). Bounded here as
        // the core bounds it; what each entry may be is `exceptionProblem`'s, which the probe
        // applies again when it matches one.
        policyException: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_EXCEPTION_ADDRESSES,
          items: { type: 'string', minLength: 2, maxLength: 64 },
        },
      },
      required: ['host', 'ipVersion'],
      additionalProperties: false,
    },
    intervalSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 3600000 },
    // Decrypted credential sets, keyed by kind (`A-05`). `additionalProperties: true` inside
    // each, because a kind's own schema is what validates it and that lives in the catalogue —
    // the same division `params` above follows.
    credentials: {
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: true },
    },
  },
  required: ['sensorId', 'sensorType', 'params', 'target', 'intervalSeconds', 'timeoutMs'],
  additionalProperties: false,
} as const;

const coreToProbeSchema = {
  type: 'object',
  // For strict mode's `strictRequired` (`P-379`), as in `probeToCoreSchema`.
  properties: { type: true },
  required: ['type'],
  discriminator: { propertyName: 'type' },
  oneOf: [
    {
      properties: {
        type: { const: 'welcome' },
        protocolVersion: { type: 'integer', minimum: 0 },
        coreVersion: { type: 'string', maxLength: 64 },
        gid: { type: 'string', minLength: 1, maxLength: 128 },
        heartbeatIntervalMs: { type: 'integer', minimum: 1000, maximum: 300000 },
        approved: { type: 'boolean' },
        accessKey: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: ['type', 'protocolVersion', 'coreVersion', 'gid', 'heartbeatIntervalMs'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'reject' },
        code: {
          type: 'string',
          enum: [
            'protocol-version',
            'bad-access-key',
            'not-approved',
            'revoked',
            'source-not-allowed',
            'internal-error',
          ],
        },
        message: { type: 'string', maxLength: 512 },
      },
      required: ['type', 'code', 'message'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'heartbeat-ack' },
        seq: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'seq'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'results-ack' },
        batchId: { type: 'string', minLength: 1, maxLength: 128 },
        storedSamples: { type: 'integer', minimum: 0 },
        retryAfterMs: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'batchId', 'storedSamples', 'retryAfterMs'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'results-nack' },
        batchId: { type: 'string', minLength: 1, maxLength: 128 },
        reason: {
          type: 'string',
          enum: ['queue-full', 'shutting-down', 'storage-error', 'unavailable', 'invalid'],
        },
        retryAfterMs: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'batchId', 'reason', 'retryAfterMs'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'config-set' },
        version: { type: 'string', maxLength: 128 },
        sensors: {
          type: 'array',
          // The same bound as a result batch, and for the same reason: refused by the schema
          // with a message rather than by the decoder with a socket reset.
          maxItems: 5000,
          items: sensorAssignmentSchema,
        },
        // Optional, so an older core that does not send it still parses (`R18`).
        final: { type: 'boolean' },
      },
      required: ['type', 'version', 'sensors'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'config-delta' },
        version: { type: 'string', maxLength: 128 },
        upserted: { type: 'array', maxItems: 5000, items: sensorAssignmentSchema },
        removed: { type: 'array', maxItems: 5000, items: { type: 'integer', minimum: 1 } },
        final: { type: 'boolean' },
      },
      required: ['type', 'version', 'upserted', 'removed'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'config-unchanged' },
        version: { type: 'string', maxLength: 128 },
      },
      required: ['type', 'version'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'sweep-start' },
        job: {
          type: 'object',
          properties: {
            runId: { type: 'integer', minimum: 1 },
            // The range as text, bounded: a comma-separated list long enough to exceed this is
            // an operator pasting something that is not a range.
            range: { type: 'string', minLength: 1, maxLength: 4000 },
            cursor: { type: 'integer', minimum: 0 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
            concurrency: { type: 'integer', minimum: 1, maximum: 512 },
            ratePerSecond: { type: 'number', minimum: 0, maximum: 100000 },
          },
          required: ['runId', 'range', 'cursor', 'timeoutMs', 'concurrency', 'ratePerSecond'],
          additionalProperties: false,
        },
      },
      required: ['type', 'job'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'sweep-cancel' },
        runId: { type: 'integer', minimum: 1 },
      },
      required: ['type', 'runId'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'identify-start' },
        job: {
          type: 'object',
          properties: {
            runId: { type: 'integer', minimum: 1 },
            // The hosts a sweep found, which is bounded by the sweep's own maximum range.
            //
            // **Dotted-quad IPv4, by pattern** (`A-69`). The lengths alone let through any
            // seven to fifteen characters: a name, or `fe80::1`. No protocol number, because
            // nothing a core sends stops being valid: the core reads these from an `inet`
            // column through `host()`, IPv4 rows only, and a sweep is over an IPv4 range. A
            // probe that identifies a name resolves it, and no core has a name to send.
            addresses: {
              type: 'array',
              maxItems: 65536,
              items: {
                type: 'string',
                minLength: 7,
                maxLength: 15,
                pattern: IPV4_ADDRESS_PATTERN,
                [PATTERN_MESSAGE]: IPV4_ADDRESS_MESSAGE,
              },
            },
            cursor: { type: 'integer', minimum: 0 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
            concurrency: { type: 'integer', minimum: 1, maximum: 128 },
            community: { type: 'string', maxLength: 128 },
            // Optional, so a probe and a core one version apart still agree on the message.
            ports: {
              type: 'array',
              maxItems: 64,
              items: { type: 'integer', minimum: 1, maximum: 65535 },
            },
          },
          required: ['runId', 'addresses', 'cursor', 'timeoutMs', 'concurrency', 'community'],
          additionalProperties: false,
        },
      },
      required: ['type', 'job'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'identify-cancel' },
        runId: { type: 'integer', minimum: 1 },
      },
      required: ['type', 'runId'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'query' },
        queryId: { type: 'string', minLength: 1, maxLength: 64 },
        query: {
          type: 'object',
          // For strict mode's `strictRequired` (`P-379`): the branch says what `kind` must be.
          properties: { kind: true },
          required: ['kind'],
          discriminator: { propertyName: 'kind' },
          oneOf: [
            {
              properties: {
                kind: { const: 'check' },
                assignment: sensorAssignmentSchema,
              },
              required: ['kind', 'assignment'],
              additionalProperties: false,
            },
          ],
        },
        // Bounded well below the frame's own limits: this is a person waiting, and a query that
        // may run for an hour is a connection slot held for an hour on a probe that has scans to
        // get on with.
        timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 },
      },
      required: ['type', 'queryId', 'query', 'timeoutMs'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'query-cancel' },
        queryId: { type: 'string', minLength: 1, maxLength: 64 },
      },
      required: ['type', 'queryId'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'bye' },
        reason: { type: 'string', maxLength: 512 },
      },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
  ],
} as const;

/**
 * The one Ajv every protocol schema is compiled by, the core's and the probe's alike: both parse
 * through the functions below, and neither compiles these schemas anywhere else.
 *
 * **A pattern says a sentence, never its expression (`P-376`).** What this Ajv refuses is said in
 * a log line: the `ProtocolError` a connection closes on, a heartbeat's unusable health field, a
 * result fitted or refused. `verbose` puts the failing keyword's schema on each error as
 * `parentSchema`, where `x-patternMessage` is read from (`saidOf`). It puts the refused value there
 * too, as `data`: nothing here reads it, because every message below is built from the error's
 * path and `saidOf` alone, and no error object leaves this module.
 *
 * A factory, and exported, for the test that holds it to strict mode (`P-379`): it builds an Ajv
 * the same way and has it compile a mistyped schema. Not for compiling protocol schemas elsewhere.
 */
export function protocolAjv(): Ajv {
  return new Ajv({
    allErrors: true,
    discriminator: true,
    // **Strict (`P-379`)**: a mistyped keyword (`maxLenght`) refuses the schema when this module
    // loads, where it used to be ignored and constrain nothing. Strict also refuses NaN and
    // Infinity as a `number`; every value this validates came out of `JSON.parse`, which makes
    // neither.
    strict: true,
    verbose: true,
    keywords: [patternMessageKeyword()],
  });
}

const ajv = protocolAjv();

const validateProbeToCore = ajv.compile<ProbeToCoreMessage>(probeToCoreSchema);
const validateCoreToProbe = ajv.compile<CoreToProbeMessage>(coreToProbeSchema);

/**
 * The schemas the protocol's Ajv compiles, for the test that holds every pattern in them to a
 * sentence (`P-376`). The check result is inside both `results` and `query-result`; it is listed
 * on its own because it is compiled on its own as well.
 */
export const PROTOCOL_SCHEMAS: Readonly<Record<string, unknown>> = {
  probeToCore: probeToCoreSchema,
  coreToProbe: coreToProbeSchema,
  checkResult: CHECK_RESULT_SCHEMA,
};

/** What one error says: a pattern's sentence (`P-376`), or Ajv's words for any other keyword. */
function saidOf(error: ErrorObject): string {
  return patternMessageOf(error) ?? error.message ?? 'invalid';
}

function describeErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => `${e.instancePath === '' ? '(root)' : e.instancePath}: ${saidOf(e)}`)
    .join('; ');
}

/** A health field a heartbeat carried and the core could not use, and why (`P-224`). */
export interface UnusableHealthField {
  readonly field: string;
  /** What was sent, when it was a number; otherwise its type. A peer's string is not logged. */
  readonly value: number | string;
  readonly reason: string;
}

/**
 * A result the core took out of a `results` batch, or a `query-result`, because it cannot be made
 * to fit (`P-281`, `P-289`).
 */
export interface RefusedResult {
  /** The result's `sensorId` when it was a positive integer, or null. */
  readonly sensorId: number | null;
  /**
   * The result's `at` when it was a string the schema's length takes, or null: with the sensor's
   * id, what names the result when it is sent again (`P-288`).
   */
  readonly at: string | null;
  /** The schema's words, relative to the result: `/outcome: must be equal to one of …`. */
  readonly reason: string;
}

/** A result the core kept after fitting it, and what fitting changed that is worth saying. */
export interface FittedReceivedResult {
  readonly sensorId: number;
  /** The result's `at`, which with its sensor names it when it is sent again (`P-288`). */
  readonly at: string;
  /** What the schema said of the result as sent, or `''` when it fitted the schema as sent. */
  readonly reason: string;
  /** `fitResult`'s problems: readings dropped, or fields of them left off. */
  readonly problems: readonly string[];
  /** Readings dropped, of those the result carried. */
  readonly droppedChannels: number;
}

/**
 * What `parseProbeToCore` did to a `results` batch's results to take the rest (`P-281`), or to a
 * `query-result`'s one result (`P-289`).
 */
export interface UnfitResults {
  readonly refused: readonly RefusedResult[];
  readonly fitted: readonly FittedReceivedResult[];
}

export interface ParseProbeToCoreOptions {
  /** Told of every heartbeat that lost a health field. The heartbeat itself was kept. */
  readonly onUnusableHealth?: (fields: readonly UnusableHealthField[]) => void;
  /**
   * Told of every `results` batch from which a result was refused, or in which one was changed
   * by more than the removal of NULs and lone surrogates (`P-281`). The batch itself was kept.
   * Told of a `query-result` the same way (`P-289`): kept, without its result when that was
   * refused.
   */
  readonly onUnfitResults?: (unfit: UnfitResults) => void;
}

/**
 * Parses a decoded frame from a probe. Throws `ProtocolError` on anything unrecognised.
 *
 * **Except a health number the core cannot use, which is dropped and the heartbeat kept**
 * (`P-224`). Every other field on this wire is the conversation itself, and a peer that gets one
 * wrong is refused. The health report is a set of optional readings about the probe, each of which
 * is already allowed to be absent — that is how a channel gaps — so one out of range becomes
 * exactly that: a gap on its channel. Refusing the frame instead cost the link, and on every
 * heartbeat, because the probe sends its worst reading of the last thirty seconds each time: a
 * probe in a container whose `/proc/meminfo` claimed more available than total reconnected into
 * the same refusal indefinitely, over a number that should have been one empty channel.
 *
 * Only a *value* is forgiven, and only of a field the schema declares. A field it does not know is
 * still refused: that is a protocol skew, which `healthForPeer` exists to prevent, and silence
 * about it is how a skew becomes lost data. So is anything wrong outside `health`.
 *
 * **And except a result in a `results` batch, which is fitted or refused alone** (`P-281`):
 * `parseResults` says why. **And a `query-result`'s result likewise** (`P-289`):
 * `parseQueryResult` says why.
 */
export function parseProbeToCore(
  value: unknown,
  options: ParseProbeToCoreOptions = {},
): ProbeToCoreMessage {
  if (isRecord(value) && value['type'] === 'results' && Array.isArray(value['results'])) {
    return parseResults(value, value['results'], options);
  }
  if (isRecord(value) && value['type'] === 'query-result' && value['result'] !== undefined) {
    return parseQueryResult(value, value['result'], options);
  }
  if (validateProbeToCore(value)) return value;
  const errors = validateProbeToCore.errors ?? [];
  const usable = withoutUnusableHealth(value, errors);
  if (usable !== null && validateProbeToCore(usable.message)) {
    options.onUnusableHealth?.(usable.dropped);
    return usable.message;
  }
  throw new ProtocolError(`unrecognised message from probe: ${describeErrors(errors)}`);
}

/**
 * `/health/memoryAvailablePercent`, or beneath it: `/health/schedulerLagMs/p99`. Only a declared
 * field's value is ever reported at such a path; a field `health` does not declare is reported at
 * `/health` itself, by `additionalProperties`, so it never matches and is still refused.
 */
const HEALTH_VALUE = /^\/health\/([^/]+)(?:\/|$)/;

/** The heartbeat without the health fields the errors name, or `null` when any is elsewhere. */
function withoutUnusableHealth(
  value: unknown,
  errors: readonly ErrorObject[],
): { readonly message: unknown; readonly dropped: UnusableHealthField[] } | null {
  if (!isRecord(value) || value['type'] !== 'heartbeat' || errors.length === 0) return null;
  const health = value['health'];
  if (!isRecord(health)) return null;
  const reasons = new Map<string, string>();
  for (const error of errors) {
    const field = HEALTH_VALUE.exec(error.instancePath)?.[1];
    if (field === undefined) return null;
    if (!reasons.has(field)) {
      reasons.set(field, `${error.instancePath}: ${saidOf(error)}`);
    }
  }
  const kept = Object.fromEntries(Object.entries(health).filter(([key]) => !reasons.has(key)));
  const dropped = [...reasons].map(([field, reason]) => {
    const sent = health[field];
    return { field, value: typeof sent === 'number' ? sent : typeof sent, reason };
  });
  return { message: { ...value, health: kept }, dropped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One result alone, for a result the batch's validation found wrong and `fitResult` changed. */
const validateCheckResult = ajv.compile<CheckResult>(CHECK_RESULT_SCHEMA);

/** `/results/3/channels/0/key`: the result's index, and the path within it. */
const RESULT_ERROR = /^\/results\/(\d+)(\/.*)?$/;

/** `/result/channels/0/key`: a `query-result`'s result, and the path within it (`P-289`). */
const QUERY_RESULT_ERROR = /^\/result(\/.*)?$/;

/** One error under a result, and its path within the result. */
interface ResultError {
  readonly error: ErrorObject;
  readonly within: string;
}

/**
 * Whether `fitResult` makes what this error names fit by the same rules a probe applies before it
 * sends (`P-277`): anything inside a channel (a key or value that cannot be sent drops the
 * channel; a counter, width, name or unit is left off or clipped; an unknown field is not
 * copied), too many channels, a message too long, a negative duration. **Not** a field missing,
 * a field of the wrong type, or anything about the result's identity: `sensorId`, `at`,
 * `outcome`, `withheld`, a field the schema does not know, or the `withheld` rule, which is
 * reported at the result itself. Fitting those would be inventing a result rather than fitting
 * one, so a result with any of them is refused.
 */
function fittable(error: ErrorObject, within: string): boolean {
  if (within.startsWith('/channels/')) return true;
  if (within === '/channels') return error.keyword === 'maxItems';
  if (within === '/message') return error.keyword === 'maxLength';
  if (within === '/durationMs') return error.keyword === 'minimum';
  return false;
}

/** Errors under one result, at most five of them, by their path within it. */
function describeResultErrors(errors: readonly ResultError[]): string {
  const shown = errors
    .slice(0, 5)
    .map(({ error, within }) => `${within === '' ? '(result)' : within}: ${saidOf(error)}`);
  const more = errors.length - shown.length;
  return shown.join('; ') + (more > 0 ? `; and ${String(more)} more` : '');
}

function sensorIdOf(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const id = raw['sensorId'];
  return typeof id === 'number' && Number.isInteger(id) && id >= 1 ? id : null;
}

/** A refused result's `at`, when it is a string of the length the schema takes; else null. */
function atOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const at = raw['at'];
  return typeof at === 'string' && at.length >= 1 && at.length <= 64 ? at : null;
}

/**
 * A `results` batch, each result checked and fitted on its own (`P-281`).
 *
 * **One result that does not fit costs that result, not the batch.** A batch the schema refused
 * whole was a protocol violation: the connection closed, the probe reconnected and sent the same
 * batch from its spool, and was closed on again, for ever, with every sensor on it going stale.
 * A probe has fitted every result since `P-277`, but one built before it (`v1.0.0-rc.2`), or any
 * peer that does not, could still wedge itself on one script's message. Now:
 *
 * - **What is wrong outside the results is still a protocol violation**, as the boundary has it:
 *   a missing `batchId`, a field the message does not have, more results than a batch holds.
 *   Those are the conversation, and a peer that gets them wrong is refused.
 * - **A result is fitted by `fitResult`**, the one the probe runs, so the core takes from an
 *   older probe what a current one would have sent of the same result: a message clipped, a
 *   channel that cannot be sent dropped. Every result, the ones the schema took as well: text
 *   PostgreSQL cannot hold is taken out of what is stored (U+0000, which failed the write with
 *   `22021` and had the batch retried for ever) or replaced as it would store it (a lone
 *   surrogate), and a key holding either is dropped with its channel.
 * - **A result fitting cannot mend is refused**, alone: the rest of the batch is kept and the
 *   batch is acknowledged, so the probe's spool moves on. Said through `onUnfitResults`, which
 *   the core counts and logs with the sensor's id.
 */
function parseResults(
  value: Record<string, unknown>,
  given: readonly unknown[],
  options: ParseProbeToCoreOptions,
): ProbeToCoreMessage {
  const byIndex = new Map<number, ResultError[]>();
  if (!validateProbeToCore(value)) {
    const errors = validateProbeToCore.errors ?? [];
    for (const error of errors) {
      const at = RESULT_ERROR.exec(error.instancePath);
      if (at === null) {
        throw new ProtocolError(`unrecognised message from probe: ${describeErrors(errors)}`);
      }
      const index = Number(at[1]);
      const list = byIndex.get(index) ?? [];
      list.push({ error, within: at[2] ?? '' });
      byIndex.set(index, list);
    }
  }
  const results: CheckResult[] = [];
  const refused: RefusedResult[] = [];
  const fitted: FittedReceivedResult[] = [];
  for (const [index, raw] of given.entries()) {
    const received = receiveResult(raw, byIndex.get(index));
    if (received.kind === 'refused') {
      refused.push(received.refused);
      continue;
    }
    results.push(received.result);
    if (received.fitted !== undefined) fitted.push(received.fitted);
  }
  if (refused.length > 0 || fitted.length > 0) options.onUnfitResults?.({ refused, fitted });
  // Everything outside `results` passed the schema (any error there threw above), and every
  // result kept either passed it as sent or was checked again once fitted; `fitResult` of a
  // result the schema takes is one it takes too, which `result-fit.test.ts` holds by property.
  return { ...value, results } as ProbeToCoreMessage;
}

/** One result as the core takes it: kept, fitted when that changed it, or refused. */
type ReceivedResult =
  | { readonly kind: 'kept'; readonly result: CheckResult; readonly fitted?: FittedReceivedResult }
  | { readonly kind: 'refused'; readonly refused: RefusedResult };

/**
 * One result, given the schema's errors under it (none when it passed): fitted by `fitResult`, or
 * refused when any error is one fitting cannot mend (`P-281`). The one path for a result in a
 * `results` batch and for a `query-result`'s (`P-289`), so the two cannot take different results.
 */
function receiveResult(raw: unknown, errors: readonly ResultError[] | undefined): ReceivedResult {
  const reason = errors === undefined ? '' : describeResultErrors(errors);
  if (errors !== undefined && !errors.every(({ error, within }) => fittable(error, within))) {
    return { kind: 'refused', refused: { sensorId: sensorIdOf(raw), at: atOf(raw), reason } };
  }
  // A record: a result without errors passed the schema, and one whose errors are all fittable
  // has none at the result itself, where "not an object" would be reported.
  const fit = fitResult(raw as CheckResult);
  if (errors !== undefined && !validateCheckResult(fit.result)) {
    // Not expected: every error was one `fitResult` mends. Refused rather than trusted.
    return {
      kind: 'refused',
      refused: {
        sensorId: sensorIdOf(raw),
        at: atOf(raw),
        reason: `${reason}; and fitted it is still refused: ${describeErrors(validateCheckResult.errors)}`,
      },
    };
  }
  if (errors === undefined && fit.problems.length === 0)
    return { kind: 'kept', result: fit.result };
  const sent = isRecord(raw) && Array.isArray(raw['channels']) ? raw['channels'].length : 0;
  return {
    kind: 'kept',
    result: fit.result,
    fitted: {
      sensorId: fit.result.sensorId,
      at: fit.result.at,
      reason,
      problems: fit.problems,
      droppedChannels: sent - fit.result.channels.length,
    },
  };
}

/**
 * A `query-result` whose result is checked and fitted as one in a `results` batch is (`P-289`).
 *
 * **One result that does not fit costs that answer, not the link.** The answer was validated
 * whole, so a result its schema refused closed the connection: the operator who pressed "check
 * now" was told the probe had disconnected, every other query in flight on that probe failed
 * with it, and pressing again did the same. Now what is wrong outside the result is still a
 * protocol violation (a `queryId`, a `failure` that is not one), and the result itself is
 * fitted as `parseResults` fits one, by the same function: the operator sees what a scheduled
 * scan would have stored. A result fitting cannot mend is taken out, and the answer kept without
 * it; `onUnfitResults` says so, and the core answers the query with why.
 */
function parseQueryResult(
  value: Record<string, unknown>,
  given: unknown,
  options: ParseProbeToCoreOptions,
): ProbeToCoreMessage {
  const errors: ResultError[] = [];
  if (!validateProbeToCore(value)) {
    const all = validateProbeToCore.errors ?? [];
    for (const error of all) {
      const at = QUERY_RESULT_ERROR.exec(error.instancePath);
      if (at === null) {
        throw new ProtocolError(`unrecognised message from probe: ${describeErrors(all)}`);
      }
      errors.push({ error, within: at[1] ?? '' });
    }
  }
  const received = receiveResult(given, errors.length === 0 ? undefined : errors);
  if (received.kind === 'refused') {
    options.onUnfitResults?.({ refused: [received.refused], fitted: [] });
    // Everything but the result passed the schema, and none of it is required but the type and
    // the id, which it holds: the answer without its result is a message the schema takes.
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'result'),
    ) as ProbeToCoreMessage;
  }
  if (received.fitted !== undefined) {
    options.onUnfitResults?.({ refused: [], fitted: [received.fitted] });
  }
  return { ...value, result: received.result } as ProbeToCoreMessage;
}

/** Parses a decoded frame from the core. */
export function parseCoreToProbe(value: unknown): CoreToProbeMessage {
  if (!validateCoreToProbe(value)) {
    throw new ProtocolError(
      `unrecognised message from core: ${describeErrors(validateCoreToProbe.errors)}`,
    );
  }
  return value;
}

/**
 * The version two peers actually speak: the older of the two (`P-178`).
 *
 * Computed independently at each end from the other's declared version, so both arrive at the
 * same number without another round trip. **Every capability gate reads this**, never
 * `PROTOCOL_VERSION` directly — a gate that asks what *this* build can do rather than what the
 * pair can do is how an unknown field reaches a peer whose schema will refuse it.
 */
export function negotiatedVersion(peerVersion: number): number {
  if (!Number.isInteger(peerVersion)) return MIN_PROTOCOL_VERSION;
  return Math.min(PROTOCOL_VERSION, Math.max(MIN_PROTOCOL_VERSION, peerVersion));
}
