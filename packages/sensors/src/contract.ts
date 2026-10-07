import type { ChannelReading, TargetPolicy } from '@ms/shared';
import type { PinnedAddress, ResolveHost } from './support/pinned-target.js';

/**
 * A JSON Schema document. Deliberately not a structural type: `paramsSchema` is handed to Ajv,
 * shipped to the UI to generate a form, and written by people adding sensor types — pinning it
 * to a hand-rolled interface would reject valid schemas without adding safety.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * How expensive a check is, which is how the pool decides what to place where.
 *
 * Not a duration: a `heavy` check is heavy because of what it holds — a spawned process, a
 * large walk, an open connection — not because it is slow. A slow `light` check is still light.
 */
export type CostHint = 'light' | 'medium' | 'heavy';

/**
 * A channel a sensor produces, declared before the sensor has ever run.
 *
 * Declaring up front is what lets the core create channels at sensor-creation time, show the
 * form and the graph legend before the first result, and know which channel a sensor is judged
 * by. `S-07` created channels lazily from whatever arrived on the wire and could not set
 * `isPrimary`, because nothing had said which one it was.
 */
/**
 * Thresholds a type declares for one of its channels (`S-18`).
 *
 * **For channels whose badness is a number, and only those.** A type that can judge a condition
 * itself should judge it and fail the check; this is for the ones where the fault is "too high"
 * or "too low" and the boundary is a matter of degree — scheduler lag, queue depth, rollup lag.
 *
 * They are a **default, not a policy**: written once when the channel is created, and never
 * again. An operator who changes or clears them owns them from then on, because a default that
 * reappeared after somebody deliberately removed it is worse than no default at all.
 *
 * At least one bound is required — a declaration with none would be a value that reads as
 * configured and does nothing — and the catalogue refuses one whose bounds contradict each other
 * at registration rather than at the first reading.
 */
export interface ChannelLimitDefaults {
  readonly upperError?: number;
  readonly upperWarning?: number;
  readonly lowerWarning?: number;
  readonly lowerError?: number;
  /** Appended to the sensor's message when the error bound is crossed. Say what to do. */
  readonly errorMessage?: string;
  readonly warningMessage?: string;
}

export interface ChannelDef {
  /** Stable within the sensor and matched against `ChannelReading.key`. Never the label. */
  readonly key: string;
  readonly name: string;
  readonly unit?: string;
  /**
   * The channel this sensor is judged by — the number in a list, the line in a summary graph.
   * At most one per sensor; the catalogue rejects a type that declares two.
   */
  readonly isPrimary?: boolean;
  /**
   * The lookup that turns this channel's readings into a state (`M-06`).
   *
   * For a channel whose value is a status code rather than a measurement: SNMP `ifOperStatus`
   * is `1`, `2` or `7`, and "warn above 1.5" is not a threshold anybody should have to write.
   * The core resolves the id against its lookup catalogue; a type may name one this
   * installation has not loaded, and that is reported rather than fatal.
   *
   * An operator can override it per channel. The declaration is the sensible default, not a
   * rule — the whole point of lookups being files is that a device can disagree with its RFC.
   */
  readonly lookup?: string;
  /**
   * This channel reports a *counter*, not a measurement, and the core turns it into a rate
   * (`T-02`).
   *
   * An interface reports octets since it was last reset. Declaring the width here is what lets
   * the core divide two readings by the time between them — and the width matters, because a
   * 32-bit counter going backwards has wrapped (2^32 octets is thirty-four seconds of gigabit)
   * while a 64-bit one going backwards is a device that rebooted.
   *
   * A counter channel's readings carry `ChannelReading.counter` — the exact value as text —
   * rather than being read from `value`, which cannot hold `ifHCInOctets` without losing its
   * low bits. The stored sample is the rate, in this channel's own unit per second.
   */
  readonly counter?: { readonly bits: 32 | 64 };
  /**
   * Thresholds this channel starts life with (`S-18`).
   *
   * Absent for almost every channel, and that is right: a threshold on a response time depends
   * on what is being measured and belongs to the operator. Declare one only where the number
   * means the same thing on every installation — which is nearly always a channel about *this
   * system* rather than about a monitored device.
   *
   * Applied when the channel is created and never re-applied. See `ChannelLimitDefaults`.
   */
  readonly limits?: ChannelLimitDefaults;
}

/**
 * What a check points at.
 *
 * It comes from the sensor's parent device, not from its own parameters: one device, one host,
 * and moving a device re-targets every sensor under it at once. A sensor type that asked for a
 * host in its `paramsSchema` would let the two disagree, which is how a device gets renamed and
 * half its sensors keep checking the old address.
 */
export interface CheckTarget {
  /** The device's `host`: a hostname or a literal address. Never resolved by the core. */
  readonly host: string;
  readonly ipVersion: 'auto' | 'v4' | 'v6';
  /**
   * The address this check must connect to, when `host` is a name that was checked against a
   * credential set's address targets (`A-41c`). Set by the catalogue and by nothing else, from
   * `pinTarget`, which resolved the name once and checked every address it has.
   *
   * **A transport handed this never resolves `host` itself.** It connects to the address, or
   * answers its socket's `lookup` with it (`pinnedLookup`), and keeps `host` for what names the
   * server: SNI, the `Host` header, the certificate check, the sensor's messages. Resolving the
   * name again is the hole this closes, since whoever runs its DNS can answer the second lookup
   * with another machine. Absent for every check that needs no pin, which then behaves as it
   * always has.
   */
  readonly pinned?: PinnedAddress;
  /**
   * How a transport resolves `host` when it has to check the addresses itself and nothing above
   * pinned one (`A-54`): the HTTP target-policy guard, which resolves once, checks every answer
   * and connects to an address it checked. Set by the catalogue to the resolver `pinTarget`
   * uses, so a test that injects one sees every lookup a check makes. Absent, the system's.
   */
  readonly resolve?: ResolveHost;
  /**
   * What this probe's sensors may connect to (`A-09`, `A-57`): the probe's `targetPolicy`, set
   * by the catalogue for every check. A transport that connects to `host` hands this, `pinned`
   * and `resolve` to `checkedTarget` (`support/checked-target.ts`) and connects to an address
   * that answered. Absent, where a test calls a type directly, the default: `link-local`.
   */
  readonly policy?: TargetPolicy;
  /**
   * The addresses of this device the probe may connect to although `policy` refuses them
   * (`A-64`): the device's own exception, set by an administrator, never inherited, and sent by
   * the core from protocol 28. Handed to `checkedTarget` with `policy` (`guardOf`), and matched
   * there against each address a lookup answered with: a name is let through only as far as every
   * address it has is. A metadata service is refused whatever this says.
   */
  readonly policyException?: readonly string[];
}

/** What a check is handed when it runs. */
export interface CheckContext {
  readonly sensorId: number;
  readonly target: CheckTarget;
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * The credential sets this type declared, resolved and decrypted for this sensor (`A-05`).
   *
   * Keyed by kind, and holding only the kinds `credentialKinds` names — a Ping sensor is never
   * handed an SSH key. Each is the *inherited* answer: set once on the device, or on the group
   * above it, and every sensor underneath gets it. A kind that is declared but not configured
   * anywhere up the tree is simply absent, which a type should report as a check failure naming
   * the kind rather than as an authentication error twenty seconds later.
   *
   * These are secrets. They exist in this worker for the duration of the check and are not
   * logged, not spooled and not returned in a result.
   */
  readonly credentials: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Not optional and not advisory. CLAUDE.md requires every check to honour it; one that does
   * not gets its worker terminated, which costs strictly more than returning.
   */
  readonly signal: AbortSignal;
  /**
   * How long the check has, when the runner says (`A-41c`). `signal` is still what ends it; this
   * is for giving one phase a share of the time, as the catalogue does for resolving a name it
   * has to check before the type runs. Absent in a test that builds its own context.
   */
  readonly timeoutMs?: number;
  /**
   * What a probe-side listener collected for this sensor since its last check (`T-06`).
   *
   * The second shape of sensor. Everything else here *asks* a device a question on a schedule;
   * a trap or syslog sensor is asked questions *by* devices, continuously, and its scan is the
   * moment it reports what arrived. The socket cannot live in the check — a check runs in
   * whichever worker is free and only while it is running — so the probe holds one listener and
   * hands each sensor the notifications it has not seen yet.
   *
   * **The listener knows nothing about sensors and the sensor type does all the deciding.**
   * Filter rules, buckets and retention are `params`, so they belong to the type, in one file,
   * where they are testable against a fabricated batch with no socket anywhere. The listener
   * decodes, normalises and remembers a cursor per sensor. That split is what keeps a listener
   * sensor an ordinary plugin rather than a special case wired through the probe.
   *
   * Absent for every polling type, and absent on the first check after a probe restart — which
   * `since` is how a type tells apart "no traps arrived" from "I have not been listening".
   */
  readonly received?: ReceivedBatch;
  /**
   * Replaces every secret this check holds with a marker (`S-21`). Set by the catalogue.
   *
   * **A type that clips somebody else's words into a message clips what this returns.** The
   * catalogue scrubs every message as it leaves (`S-19`), but a clip made first can cut a secret
   * in two, and the half before the cut is no longer the value the scrub looks for. Absent where a
   * test calls a type directly, and then nothing is scrubbed; `scrubberOf` reads it either way.
   */
  readonly scrub?: (text: string) => string;
}

/**
 * One thing a listener received (`T-06`).
 *
 * Crosses a worker-thread boundary, so it is plain structured-cloneable data and nothing else.
 * `detail` is deliberately loose: an SNMP trap puts its trap OID, version and varbinds there and
 * a syslog message (`T-20`) will put its facility and severity, and a contract that enumerated
 * both would have to change every time a listener is added. A type reads it defensively, exactly
 * as it reads `params`.
 */
export interface ReceivedNotification {
  /** When the probe received it, ISO-8601. The probe's clock, like every other result. */
  readonly at: string;
  /** The sender, as an address. Never resolved — a reverse lookup per trap is a trap flood. */
  readonly source: string;
  /** One line, already rendered, for retention and for the sensor message. */
  readonly text: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ReceivedBatch {
  /** Which listener produced this. A type checks it before trusting `detail`. */
  readonly listener: string;
  /** Oldest first. */
  readonly items: readonly ReceivedNotification[];
  /**
   * Notifications this sensor never saw because the listener's buffer wrapped first.
   *
   * Counted rather than dropped quietly: CLAUDE.md's rule is that backpressure is visible, and a
   * trap sensor that silently missed the flood it exists to report is the worst version of it.
   */
  readonly dropped: number;
  /**
   * On a sensor's first scan after a probe restart, or after a cut configuration push took it off
   * the scheduler, only: what the listener received before this batch's window, which reaches
   * one interval back, and after the sensor's last scan or the listener's start (`P-254`).
   *
   * Neither this sensor's count nor its loss. No scan of it was there to cover that time — the
   * probe had just started, could not yet reach its core, or was not scanning it — so a count of
   * it would be several intervals as one reading, and every limit set per interval would alarm on
   * the one outage; and calling it `dropped` would fail every sensor that does not tolerate a
   * loss, the same storm by another channel. What the buffer overwrote inside the window is
   * `dropped` and never this. A type names it in its message, so it is not lost silently.
   * Absent on every other scan.
   */
  readonly earlier?: number;
  /**
   * On the same scans only, and only when it is not zero: what the listener's buffer overwrote
   * before it could tell when it arrived — after a flood of more than twice the buffer inside the
   * window (`P-254`). It may have arrived inside the window or hours before it, so it is neither
   * this scan's count nor its `dropped`; a type names it in its message, and Probe Health counts
   * it as a loss.
   */
  readonly undated?: number;
  /** When this sensor's cursor was last reset, ISO-8601. Moves on a probe restart. */
  readonly since: string;
  /**
   * When the listener drained this batch, ISO-8601 — so `since`..`until` is the window it covers.
   *
   * **Added by `B-04`, because a rate needs a window and only the listener knows it.** A type
   * computing one from its own `Date.now()` measures until the check *ran*, which includes
   * however long it waited for a free worker — so a busy probe would report lower traffic than a
   * quiet one for the same link, and the dilution would look like a network change.
   *
   * Types that count rather than rate ignore it, which is why it arrived at the third listener
   * sensor and not the first.
   */
  readonly until: string;
}

export interface CheckExecution {
  channels: ChannelReading[];
  message?: string;
}

/**
 * A dry run of a type's mapping language against a document the operator pasted (`U-13`).
 *
 * **Only types with a mapping language declare one.** `rest.custom` has an `extract` array whose
 * entries are paths into a response, and writing those blind against an API you cannot see is the
 * part people give up on. A Ping has nothing to preview and says so by not implementing this.
 *
 * **No I/O.** Everything it needs is in the input, which is what lets it run in the core against
 * a body the operator supplied rather than on a probe against a device. A type whose preview
 * fetched anything would be a second, unaudited request path with the sensor's credentials in it.
 */
export interface PreviewInput {
  /** The response, verbatim, as it was pasted. */
  readonly document: string;
  /** What the server called it, where the operator knows. Empty is honest, and common. */
  readonly contentType: string;
  /** The parameters as the form currently holds them — not assumed to be valid or complete. */
  readonly params: Readonly<Record<string, unknown>>;
}

/** One node a path selected, rendered the way the type reads it. */
export interface PreviewSelection {
  readonly text: string;
  /** Whether an aggregate could use it. A path selecting ten strings produces no reading. */
  readonly numeric: boolean;
}

/** What one mapping — one channel — would do with this document. */
export interface PreviewRow {
  /** The mapping's key, or empty while the operator is still filling the row in. */
  readonly key: string;
  readonly path: string;
  /** Why this row could not be evaluated. An unparseable path names itself here. */
  readonly error?: string;
  /** Bounded: a wildcard over a large document selects more than anybody reads. */
  readonly selected: readonly PreviewSelection[];
  /** How many were selected in total, which is the number `count` would report. */
  readonly selectedCount: number;
  /** The reading, aggregated and scaled. `null` is the gap this channel would record. */
  readonly value: number | null;
}

/** One expected value, checked the same way — a wrong one fails the check, channels or no. */
export interface PreviewExpectation {
  readonly path: string;
  readonly error?: string;
  /** What the path found, as text. Empty when it found nothing. */
  readonly actual: string;
  readonly ok: boolean;
}

export interface PreviewResult {
  /** How the document was read. `auto` resolves to one of these, and seeing which one matters. */
  readonly format: string;
  /** Set when the document itself did not parse; `rows` is then empty. */
  readonly error?: string;
  readonly rows: readonly PreviewRow[];
  readonly expectations: readonly PreviewExpectation[];
  /**
   * Why this check would fail on this document, even where every row above has a value.
   *
   * The preview exists to answer "what will this sensor do", and a list of green rows above a
   * check that fails on an expectation would answer it wrongly.
   */
  readonly problems: readonly string[];
}

/**
 * A sensor type, per ADR-001 Decision 7.
 *
 * One type is one file. `execute` is the only member the probe uses and the only one the core
 * does not — a type with heavy or native dependencies must `await import()` them *inside*
 * `execute`, so that loading the catalogue in the core costs nothing.
 */
export interface SensorType {
  /** Dotted, lowercase, stable forever: it is written into `sensor_config.type`. */
  readonly id: string;
  /** Groups the add-sensor picker. Free text, but reuse an existing one where it fits. */
  readonly category: string;
  /** Validates the API, generates the UI form, and marks secrets `writeOnly`. */
  readonly paramsSchema: JsonSchema;
  readonly costHint: CostHint;
  /**
   * Credential kinds this type needs, resolved from the sensor's ancestors and handed to
   * `execute` in `ctx.credentials` (`A-05`).
   *
   * Declared rather than discovered, and the reason is what the core does with it: it decrypts
   * exactly these kinds for exactly these sensors and sends them to the probe that owns them. A
   * type that did not say would have to be sent everything, so every probe would hold every
   * credential in the installation to run a Ping.
   */
  readonly credentialKinds?: readonly string[];
  /**
   * Where each `writeOnly` parameter is sent, as the other parameters that say so (`A-40`).
   *
   * **A secret stays with where it is sent.** A read never returns a secret, so an edit that
   * leaves it out keeps the stored one — and without this, anyone with `write` on the sensor
   * could keep the secret and change where it goes: point a script's secret at a program that
   * prints its environment somewhere they can read it. So an edit that changes any parameter
   * named here and does not send the secret again clears it, and the audit entry says which.
   *
   * Required for every `writeOnly` parameter, and the catalogue refuses a type that leaves one
   * out: a secret nobody has said the destination of is one a new type would carry anywhere.
   * `[]` says no parameter chooses it — it goes to the device the sensor is on, and nowhere
   * else — which is what a credential the sensor holds for its own device should say. Each
   * destination is a dotted path to a plain property that is not itself `writeOnly`.
   *
   * **And one `kind:<id>` entry for every kind in `credentialKinds`** (`A-41`): the parameters
   * that choose where an inherited credential set of that kind is sent, beside the device's host
   * and the probe. `'kind:ssh': ['port']`. The core fingerprints that destination, and a write
   * that moves it needs a voucher with `write` on the object the set is stored on. Name every
   * parameter that decides who can receive the credential — a port, an override of the host, and
   * whatever turns encryption or its verification off — since each is a listener of its own.
   */
  readonly secretDestinations?: Readonly<Record<string, readonly string[]>>;
  /**
   * The credential kinds this type sends only to `CheckTarget.pinned` when there is one
   * (`A-41c`): every connection it makes with a set of that kind goes to the pinned address, and
   * none of them resolves the device's name.
   *
   * **A promise about the transport, and what lets a restricted set reach a named device.** A
   * set whose `allowedTargets` name only addresses is sent to a device named by host name only
   * when the sensor's type lists the kind here; the probe then resolves the name once, checks
   * every address, and pins one. A type that leaves a kind out is not sent such a set, and one
   * that listed a kind and still connected by name would hand the set to whoever answers the
   * second lookup. List a kind only where the transport takes an address to connect to or a
   * `lookup` for its socket: SNMP, SSH, HTTP and mail do, and the database drivers are handed
   * a socket that has one (`A-62`, from protocol 27: the core asks `pinningCapabilityFor` which
   * version of a probe pins a kind). PowerShell resolves the name itself, and stays off this
   * list.
   *
   * Each must be one of `credentialKinds`; the catalogue refuses a type that lists another.
   */
  readonly pinnedKinds?: readonly string[];
  /**
   * The probe-side listener this type is fed by, instead of polling (`T-06`).
   *
   * Declared rather than discovered, and the probe reads it from the catalogue rather than
   * matching on the type id: a probe that hardcoded `'snmp.trap'` would need editing for every
   * listener sensor added after it, and `T-20`'s syslog receiver is already the second.
   *
   * A type that names one is handed `CheckContext.received` when its check runs, and is handed
   * nothing when that listener is not running on this probe — which it must report as a failure,
   * never as a reading of zero.
   */
  readonly listener?: string;
  /**
   * Where this type's checks run on the probe (`P-03`).
   *
   * Absent means the shared worker pool, which is right for every check that talks to a device
   * over a socket. `'process'` puts each check in a child process of its own, and CLAUDE.md's
   * rule for when that is needed is "if a check can hang" — which understates it. A worker
   * thread is terminable and even has its own heap limit, so hanging and leaking are both
   * survivable there. What is *not* survivable in a worker is a hard crash: a segmentation fault
   * in a native module, or an `abort()` from something a user's script loaded, takes the whole
   * probe down with it. And a worker cannot run as a different OS user.
   *
   * So this is for checks that execute code somebody else wrote — `T-19`'s EXE/Script sensors —
   * where "a fault in the check kills every other sensor on this probe" is not an acceptable
   * failure mode. It costs a Node start-up per check, which is why it is opt-in and declared by
   * the type rather than configured per sensor.
   */
  readonly isolation?: 'process';
  /**
   * Set when the **core** computes this sensor's readings rather than a probe (`T-21`).
   *
   * There is exactly one of these and there should stay that way: a Sensor Factory's inputs are
   * channel values the core already holds, and asking a probe to compute them would mean
   * shipping other sensors' history out to every probe that had one. Declared rather than
   * matched on the id, for the reason `listener` is: the probe configuration path reads this to
   * leave such a sensor out of every assignment list, and a hardcoded id there would be a rule
   * to keep in step by hand.
   */
  readonly evaluatedBy?: 'core';
  /**
   * The objects this sensor's parameters name, other than its own place in the tree (`A-29`).
   *
   * **A sensor that reads another object's data republishes it** to whoever can read the sensor.
   * So whoever writes one has to be able to read what it names, and the core asks the type
   * rather than knowing its parameters. `ObjectService` checks what this returns on every create,
   * edit, move and clone, and the core checks it again, through the eyes of whoever last vouched
   * for the sensor, every time it evaluates one.
   *
   * Called with already-validated params, in the core. Must be pure. A reference the parameters
   * cannot state — a formula that does not parse — is left out: the sensor fails on its own for
   * that, and a check cannot be about an id nobody can read out of it.
   *
   * **The catalogue refuses a type the core evaluates that declares neither this nor
   * `requires`.** The core evaluates exactly the types whose readings come from what it already
   * holds, which is the case this exists for.
   */
  references?(params: Readonly<Record<string, unknown>>): readonly SensorReference[];
  /**
   * A bar on writing one at all (`A-29`), for a type whose readings describe the whole
   * installation rather than anything in it. `'installation'` is read on the root — the bar
   * `/core-health` and the Prometheus scrape already have — checked where `references` is.
   */
  readonly requires?: 'installation';
  /**
   * How long a return to Up must last before a state trigger's alarm over this sensor is over, in
   * seconds (`M-18`). Absent means none: the alarm ends at the return, as it does for every type
   * whose own two-step Down already confirms an outage.
   *
   * **For a type whose outages arrive in bursts the core samples between.** A relapse inside the
   * hold is the same outage, and resumes its alarm rather than arming a second. Probe Health is
   * the case: a probe killed and restarted connects for seconds a round, and its link reads Up
   * between kills. Declared rather than matched on the id, for the reason `listener` is. A
   * trigger that sets its own `recoveryHoldSeconds` overrides it, either way.
   */
  readonly recoveryHoldSeconds?: number;
  /**
   * What the schema cannot say about these parameters (`A-42`): each problem as the JSON Pointer
   * of the value at fault and a sentence an operator can act on. Empty, or absent, when there is
   * nothing to refuse.
   *
   * `SensorCatalogue.validate` calls it once the schema has passed, with the defaults filled in.
   * Every write goes through that call: a create, an edit, a clone, a device template, a
   * discovery. So a refusal here is a refusal everywhere, in the same shape as a schema's.
   * Must be pure: it runs in the core.
   *
   * **A row written before the rule never passed it.** A rule that makes a stored sensor unsafe
   * to run belongs in `execute` too, refusing by the same words, never quietly repairing.
   */
  paramProblems?(
    params: Readonly<Record<string, unknown>>,
  ): readonly { readonly path: string; readonly message: string }[];
  /** Called with already-validated params. Must be pure — it runs in the core, not the probe. */
  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[];
  execute(context: CheckContext): Promise<CheckExecution>;
  /**
   * A dry run against a pasted document (`U-13`), for types with a mapping language.
   *
   * Optional, and absent for almost every type. It runs **in the core**, like `channels`, so it
   * must do no I/O — but it is `async` so that a type can still `await import()` a parser it
   * would otherwise load into every probe at startup.
   *
   * It must not throw for bad input: a half-typed path is the normal state of the form this
   * feeds, and the row says so in its `error` instead.
   */
  preview?(input: PreviewInput): Promise<PreviewResult>;
}

/**
 * An object a sensor's parameters name (`A-29`).
 *
 * `param` says where, so a refusal can point at the field — `probeId`, `channels[2].formula` —
 * without saying anything about the object it could not find.
 */
export type SensorReference =
  /** Named by id. `expects` is the kind it has to be, checked only once it is known to be readable. */
  | {
      readonly kind: 'object';
      readonly objectId: number;
      readonly expects: 'sensor' | 'probe';
      readonly param: string;
    }
  /** The probe this sensor sits under, whatever it is: Probe Health with no `probeId`. */
  | { readonly kind: 'enclosing-probe'; readonly param: string };

/** A type as the core sees it: everything except the half that does I/O. */
export type SensorTypeDeclaration = Omit<SensorType, 'execute'>;
