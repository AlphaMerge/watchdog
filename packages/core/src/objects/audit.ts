import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { AccessRight } from '../auth/access.js';
import type { ChannelLimits } from '../state/limits.js';
import type { LibraryNode } from '../libraries/nodes.js';
import type { ImageMediaType } from '../maps/images.js';
import type { ChannelDeclaration } from './redeclare.js';
import type { ChannelProcessing } from './types.js';
import type {
  CloneCounts,
  CountsByKind,
  CredentialKind,
  ObjectDetail,
  ObjectId,
  ObjectKind,
  ObjectRef,
  SiblingMove,
} from './types.js';

/**
 * Every kind of actor: `audit_log_actor_kind_check` in migration 005 (`P-351`).
 *
 * The pause's and the acknowledgement's copies of the kind (`object_pause.actor_kind`,
 * `sensor_runtime.acknowledged_by_kind`) have no CHECK of their own, but every write of one is
 * audited in the same transaction, so a kind the audit log refuses rolls back with it.
 */
export const ACTOR_KINDS = ['user', 'token', 'system', 'anonymous'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * Who made a change. Anonymous until accounts exist (A-01); the shape is already right so
 * A-01 fills it in at one place rather than threading a user through every service method.
 */
export type Actor =
  | { kind: 'user'; userId: number; login: string }
  | { kind: 'token'; tokenId: number }
  | { kind: 'system'; component: string }
  | { kind: 'anonymous'; remoteAddress: string };

/** Compiles only while `ACTOR_KINDS` and the union name the same kinds. */
const actorKindsMatch: [
  Exclude<ActorKind, Actor['kind']>,
  Exclude<Actor['kind'], ActorKind>,
] extends [never, never]
  ? true
  : never = true;
void actorKindsMatch;

/**
 * What changed, as a typed union rather than `Record<string, unknown>`.
 *
 * Nothing here can carry a plaintext secret: credential changes are recorded by *kind*, and
 * the ciphertext is never read in the first place.
 */
export type Mutation =
  | { action: 'object.created'; objectId: ObjectId; kind: ObjectKind; after: ObjectDetail }
  | {
      action: 'object.updated';
      objectId: ObjectId;
      kind: ObjectKind;
      /** Redacted, like everything the sink is handed. */
      before: ObjectDetail;
      after: ObjectDetail;
      /**
       * Which sensor parameters changed, computed by the service from the *unredacted* values.
       *
       * Without this, rotating a `writeOnly` parameter would be invisible: both sides redact to
       * the same absence, so a diff of what the sink can see reports no change at all. The name
       * is the auditable fact; the value is the thing that must not be here.
       */
      changedParams: readonly string[];
      /**
       * The `writeOnly` parameters the edit cleared by changing where they are sent without
       * sending them again (`A-40`). They are in `changedParams` too; this says why.
       */
      secretsCleared?: readonly string[];
    }
  | {
      action: 'object.moved';
      objectId: ObjectId;
      kind: ObjectKind;
      fromParentId: ObjectId;
      toParentId: ObjectId;
      movedCount: number;
      /** R-04 diffs a probe's configuration subtree on exactly this. */
      fromProbeId: ObjectId | null;
      toProbeId: ObjectId | null;
    }
  | {
      action: 'object.reordered';
      objectId: ObjectId;
      kind: ObjectKind;
      parentId: ObjectId;
      move: SiblingMove;
      fromIndex: number;
      toIndex: number;
    }
  | {
      action: 'object.cloned';
      objectId: ObjectId;
      kind: ObjectKind;
      sourceId: ObjectId;
      clonedCount: CloneCounts;
      droppedCredentialKinds: readonly CredentialKind[];
    }
  | {
      action: 'object.deleted';
      objectId: ObjectId;
      kind: ObjectKind;
      before: ObjectDetail;
      deleted: CountsByKind;
      /** Every destroyed object. WORKFLOW.MD §12 wants a diff, and there is no recycle bin. */
      destroyed: readonly ObjectRef[];
    }
  | {
      /**
       * A channel's thresholds changed (`M-04`).
       *
       * Audited because a limit is what decides an alarm: a sensor that went Down with cause
       * `limit` is answerable only if the log says who set the limit and to what. Nothing here
       * can carry a secret — four numbers and two operator-written notes.
       */
      action: 'channel.limits.set';
      /** The sensor. Channels have no identity of their own in the object tree. */
      objectId: ObjectId;
      kind: ObjectKind;
      channelKey: string;
      before: ChannelLimits;
      after: ChannelLimits;
    }
  | {
      /**
       * A channel was pointed at a different lookup, or at none (`M-06`).
       *
       * Its own action rather than a field inside `channel.limits.set`: they are the two
       * different ways a channel's state is decided, and "who changed what this channel is
       * judged by" is a question with two distinct answers.
       */
      action: 'channel.lookup.set';
      objectId: ObjectId;
      kind: ObjectKind;
      channelKey: string;
      before: string | null;
      after: string | null;
    }
  | {
      /**
       * A channel's scaling, spike filter or decimal places changed (`M-07`).
       *
       * Everything that happens to a reading between arriving and being judged or shown. Its
       * own action beside `channel.limits.set` and `channel.lookup.set`, because a graph that
       * suddenly reads eight times higher is answered by knowing who changed the factor — and
       * a diff that named only "the channel" would not answer it.
       */
      action: 'channel.processing.set';
      objectId: ObjectId;
      kind: ObjectKind;
      channelKey: string;
      before: ChannelProcessing;
      after: ChannelProcessing;
    }
  | {
      /**
       * An edit to a sensor's parameters changed what its type declares for a channel, and the
       * channel was written to match (`P-303`): its name, unit, lookup or counter width, or
       * whether it is the sensor's primary channel (`P-309`).
       *
       * Its own entry beside the sensor's `object.updated`, which says which parameter moved:
       * this says what that did to the channel, and it is a `channel.*` action, so the result
       * path forgets what it cached of the channel (`M-04`). A lookup changed this way is not
       * also a `channel.lookup.set`, which is a person pointing a channel somewhere.
       */
      action: 'channel.redeclared';
      objectId: ObjectId;
      kind: ObjectKind;
      channelKey: string;
      before: ChannelDeclaration;
      after: ChannelDeclaration;
    }
  | {
      /**
       * An object was paused (`M-08`).
       *
       * `sensorsAffected` is the count that makes the entry answerable: "somebody paused the
       * London group" is a different event from "somebody paused the London group and four
       * thousand sensors stopped being monitored", and only the number distinguishes them.
       */
      action: 'object.paused';
      objectId: ObjectId;
      kind: ObjectKind;
      /**
       * When it takes effect (`M-10`).
       *
       * Later than the entry's own timestamp for a maintenance window, and the reason the entry
       * is worth keeping separately from the one the sweep writes when the window opens: one
       * records who scheduled the outage and when they did it, the other that it happened.
       */
      from: Date;
      /** `null` is indefinite. */
      until: Date | null;
      message: string;
      sensorsAffected: number;
    }
  | {
      action: 'object.resumed';
      objectId: ObjectId;
      kind: ObjectKind;
      sensorsAffected: number;
    }
  | {
      /**
       * An operator acknowledged an alarm (`M-13`).
       *
       * Audited because it is the one action that makes a system deliberately stop telling
       * anybody about an outage. "Who silenced this, when, for how long, and what did they say
       * they were doing about it" is the whole reason the entry exists.
       *
       * `objectId` is what the operator clicked — a sensor, or a device whose Down sensors were
       * acknowledged together — and `sensorsAffected` is how many alarms that turned out to be.
       */
      action: 'sensor.acknowledged';
      objectId: ObjectId;
      kind: ObjectKind;
      /** `null` is indefinite: until it recovers, or somebody clears it. */
      until: Date | null;
      message: string;
      sensorsAffected: number;
    }
  | {
      action: 'sensor.acknowledgementCleared';
      objectId: ObjectId;
      kind: ObjectKind;
      sensorsAffected: number;
    }
  | {
      /**
       * An operator forced sensors Down, or lifted the force (`M-14`).
       *
       * The most consequential button in the system: a simulated error fires the real
       * notification chain at real people, which is exactly what it is for. "Who did this, to
       * how many sensors, and what did they say they were testing" is the entry.
       */
      action: 'sensor.simulatedError';
      objectId: ObjectId;
      kind: ObjectKind;
      simulated: boolean;
      message: string;
      sensorsAffected: number;
    }
  | {
      /**
       * A notification trigger was created, changed or removed (`N-01`).
       *
       * Audited because a trigger decides who finds out about an outage: somebody deleting one
       * is somebody deciding a class of alarm stops reaching anyone, and that is exactly the
       * change nobody notices until the night it matters. `objectId` is what it was defined on,
       * so the entry lands on the object's own history tab.
       */
      action: 'trigger.created' | 'trigger.updated' | 'trigger.deleted';
      objectId: ObjectId;
      triggerId: number;
      triggerKind: string;
      /** The one-line description an operator sees on the tab, so the entry reads like it. */
      summary: string;
      /**
       * What it said before, when there was a before.
       *
       * A diff that repeats itself on both sides tells the reader nothing, and "who changed the
       * escalation to four hours" is the question this log exists to answer.
       */
      previousSummary?: string;
    }
  | {
      /**
       * A notification template was created, changed or removed (`N-05`).
       *
       * `objectId` is null because a template is not in the object tree: it is a library object
       * that many triggers reference and none contains — the same shape as a schedule.
       *
       * Audited because a template decides what leaves the building and who receives it.
       * Somebody changing an address is redirecting every alarm that names this template, and
       * the name and the method are what make the entry readable. **The settings are not
       * recorded**: they carry the webhook URLs and the secret headers, and an audit log is
       * exactly the wrong place to keep a copy of a credential that no API will return.
       */
      action: 'template.created' | 'template.updated' | 'template.deleted';
      // Null for the reason a schedule's is, and typed so every consumer that reads `objectId`
      // off a mutation keeps compiling.
      objectId: null;
      templateId: number;
      name: string;
      method: string;
      /**
       * The secrets an update cleared because it changed where they were sent (`A-40`). Paths
       * only, such as `secretHeaders`; absent when there were none.
       */
      secretsCleared?: readonly string[];
    }
  | {
      /**
       * A test send (`N-14`).
       *
       * Recorded even though it changes nothing, because it is the one read-shaped action in
       * this system that puts a real message in front of real people: somebody testing an
       * on-call template at three in the morning has paged whoever is on call. "Who woke me up"
       * deserves an answer.
       */
      action: 'template.tested';
      objectId: null;
      templateId: number;
      name: string;
      method: string;
      delivered: boolean;
    }
  | { action: 'setting.set'; objectId: ObjectId; key: string; before: unknown; after: unknown }
  | { action: 'setting.reverted'; objectId: ObjectId; key: string; before: unknown }
  | {
      /**
       * A credential set was stored or replaced (`A-05`).
       *
       * **There is no field here a secret could occupy, and that is the point of giving this its
       * own shape** rather than reusing `setting.set`'s `before`/`after: unknown`. An audit row
       * is permanent and readable through the history API, so a diff carrying values would be a
       * plaintext archive of every credential this installation has ever held — the exact thing
       * encrypting the column was for. `secretsSet` is field *names*: enough to answer "was the
       * community string rotated, or only the SNMP version corrected".
       */
      action: 'credential.set';
      objectId: ObjectId;
      credentialKind: string;
      created: boolean;
      secretsSet: readonly string[];
      secretsKept: readonly string[];
      /**
       * Names of the secrets this write cleared because it widened where the set may go and did
       * not send them again (`A-41b`). Absent when there were none.
       */
      secretsCleared?: readonly string[];
      /**
       * How many sensors beneath the set its targets now keep it from (`A-41b`), counted after
       * the write. Absent for a set with no targets, which keeps it from none.
       */
      withholds?: number;
      /**
       * How many sensors the write put outside the set's targets, and how many it brought back
       * inside (`A-59`): what the write changed, where `withholds` is how things stand after
       * it. **Whole, like `withholds`**, whatever the writer could see: this is the
       * installation's record, and `DatabaseAuditSink` stores none of the three, since an
       * object's history is read by accounts that may not see every sensor beneath it.
       * `newlyWithheld` is absent for a set with no targets; `noLongerWithheld` is present
       * for one too when the write brought any back.
       */
      newlyWithheld?: number;
      noLongerWithheld?: number;
      /** The half stored in the clear — an SNMP version, a user name. Never a key. */
      publicParams: Readonly<Record<string, unknown>>;
    }
  | { action: 'credential.deleted'; objectId: ObjectId; credentialKind: string }
  | {
      /**
       * A boot recorded who vouches for one kind's sets, after an upgrade (`A-41`). One entry per
       * kind, never one per sensor: the first boot after migration 060 records the installation
       * for every pair in use, and a release that changes where a type says it sends a kind moves
       * every such fingerprint at once.
       */
      action: 'credential.adopted';
      objectId: null;
      credentialKind: string;
      /** Pairs nobody had vouched for, recorded as the installation's: the first boot only. */
      installation: number;
      /** Pairs the new recipe moved, whose record matched the old one: carried, voucher kept. */
      carried: number;
      /** Pairs whose record matched neither recipe: left withheld until somebody vouches. */
      withheld: number;
    }
  | {
      /**
       * A report was rendered through somebody's visibility scope (`E-08`).
       *
       * **The auditable fact is the act-as, not the render.** `§6` lets a report run under a named
       * account's scope, which means data that account can see leaves the building on a schedule,
       * started by nobody. `requestedBy` is who asked and `runAs` is whose eyes it used; they are
       * routinely different accounts, and the second is the one that decides what the document
       * contains.
       *
       * `E-03` deferred this here because until something ran a report there was no event:
       * resolving a security context on an API read is not one.
       *
       * `objectId` is null for the reason a schedule's is — a report is not a tree object
       * (`E-01`) — and the subjects it covered live in the report rather than being copied into
       * every audit row it writes.
       */
      action: 'report.ran';
      objectId: null;
      reportId: number;
      runId: number;
      reportName: string;
      trigger: 'manual' | 'scheduled';
      /** Who asked. Empty for the scheduler, which is nobody. */
      requestedBy: string;
      /** Whose visibility it rendered through — the act-as fact, and the one that matters. */
      runAs: string;
      spanLabel: string;
      outcome: 'succeeded' | 'failed';
      errorCode: string;
    }
  | {
      /**
       * A schedule was created, changed or removed (`M-09`).
       *
       * `objectId` is null because a schedule is not in the object tree: it is a library object
       * that many objects reference and none contains. The audit column is nullable for exactly
       * this, and the schedule's own id travels in the summary.
       *
       * Auditable because editing a schedule silently changes when several thousand sensors are
       * watched — a wider blast radius than most single-object edits, and one nobody would
       * think to look for after the fact.
       */
      action: 'schedule.created';
      objectId: null;
      scheduleId: number;
      after: ScheduleAudit;
    }
  | {
      action: 'schedule.updated';
      objectId: null;
      scheduleId: number;
      before: ScheduleAudit;
      after: ScheduleAudit;
    }
  | {
      action: 'schedule.deleted';
      objectId: null;
      scheduleId: number;
      before: ScheduleAudit;
    }
  | {
      /**
       * A library was created, changed or removed (`L-01`).
       *
       * `objectId` is null for the reason a schedule's is: a library is not a tree object, and the
       * objects its rules name live in the library rather than being copied into every row.
       *
       * Audited because a library decides what a group of people are shown. Somebody narrowing a
       * node's rule has decided that a class of sensor stops appearing in front of whoever works
       * from that library — the change nobody notices until the day a failure is not on the
       * screen. Its grants are `grant.set` and `grant.revoked`, as every grant is (`A-17`).
       */
      action: 'library.created';
      objectId: null;
      libraryId: number;
      after: LibraryAudit;
    }
  | {
      action: 'library.updated';
      objectId: null;
      libraryId: number;
      before: LibraryAudit;
      after: LibraryAudit;
    }
  | {
      action: 'library.deleted';
      objectId: null;
      libraryId: number;
      before: LibraryAudit;
    }
  | {
      /**
       * A group was granted a right on something, or had one changed (`A-17`).
       *
       * **One action for all four kinds of grant**, because "who gave that group `full`?" is one
       * question whatever the thing is, and a person asking it should not need to know which of
       * four tables to search. `subject` says what the grant is on. `objectId` is set for an
       * object grant alone, so the entry also appears in that object's own history; a map, a
       * report and a library are not tree objects and their grants carry null, as their edits do.
       *
       * `before` is null when the group held no grant here — a new grant, rather than a change
       * of one. Granting `none` is not revoking: `none` overrides what the group inherits, and a
       * revoke restores it (`AccessService.revoke`), so the two are different entries.
       */
      action: 'grant.set';
      objectId: ObjectId | null;
      subject: GrantSubject;
      groupId: number;
      groupName: string;
      before: AccessRight | null;
      after: AccessRight;
    }
  | {
      /** A group's grant was taken away. A revoke that found nothing to take writes no entry. */
      action: 'grant.revoked';
      objectId: ObjectId | null;
      subject: GrantSubject;
      groupId: number;
      groupName: string;
      before: AccessRight;
    }
  | {
      /**
       * A grant on a clone's source that its copy did not carry, because its maker may not grant
       * (`A-76`). `objectId` is the copy, so the entry is in the copy's history beside the grants
       * it did carry, and "why does that group not have `write` here like it has on the
       * original?" is answered there. Under `grant`, so it is shown to whoever the grants are.
       */
      action: 'grant.notCarried';
      objectId: ObjectId;
      subject: GrantSubject;
      groupId: number;
      groupName: string;
      /** What the group holds on the source, which it does not on the copy. */
      onSource: AccessRight;
    }
  | {
      /**
       * A map was created, changed or removed (`A-17`).
       *
       * Unaudited from `G-01` until here, while the repository's header said "rights and audit
       * in the service". `objectId` is null for the reason a library's is.
       */
      action: 'map.created';
      objectId: null;
      mapId: number;
      after: MapAudit;
    }
  | {
      action: 'map.updated';
      objectId: null;
      mapId: number;
      before: MapAudit;
      after: MapAudit;
    }
  | {
      action: 'map.deleted';
      objectId: null;
      mapId: number;
      before: MapAudit;
    }
  | {
      /** A background was stored, replacing whatever was there (`G-05`). The file, never its bytes. */
      action: 'map.background.set';
      objectId: null;
      mapId: number;
      before: MapBackgroundAudit | null;
      after: MapBackgroundAudit;
    }
  | {
      action: 'map.background.removed';
      objectId: null;
      mapId: number;
      before: MapBackgroundAudit;
    }
  | {
      /**
       * A public link was minted (`G-06`). **A grant to everybody**, so it is audited as surely as
       * a grant to a group — and it carries the label, the prefix and the expiry, never the
       * token: a share link in the audit log is a share link in every backup of it.
       */
      action: 'map.share.created';
      objectId: null;
      mapId: number;
      shareId: number;
      label: string;
      prefix: string;
      expiresAt: Date;
    }
  | {
      action: 'map.share.revoked';
      objectId: null;
      mapId: number;
      shareId: number;
    }
  | {
      /**
       * A report was created, changed or removed (`A-17`).
       *
       * `report.ran` records a report rendering through somebody's eyes; these record who pointed
       * it there. `runAs` is in the diff for that reason — changing it is the edit that decides
       * what the next scheduled document contains.
       */
      action: 'report.created';
      objectId: null;
      reportId: number;
      after: ReportAudit;
    }
  | {
      action: 'report.updated';
      objectId: null;
      reportId: number;
      before: ReportAudit;
      after: ReportAudit;
    }
  | {
      action: 'report.deleted';
      objectId: null;
      reportId: number;
      before: ReportAudit;
    }
  | {
      /**
       * A probe was approved onto a branch of the tree (`A-20`).
       *
       * **As much a grant as anything `A-17` records**: approving admits a machine that runs
       * checks with the core's credentials. Named by its gid, the name it reported and the address
       * it last called from — the facts the decision was taken on — and never by a key: not the
       * enrolment key, not its own, and not the hash of either. `objectId` is the probe object it
       * is bound to, so the decision appears in that object's history.
       */
      action: 'probe.approved';
      objectId: ObjectId;
      probe: ProbeIdentity;
      local: boolean;
      /**
       * The probe object that was the local probe until this approval made `objectId` it
       * (`P-382`): one object is local, and the one that was had no probe bound any more. It is
       * deletable from here on, which is why it is said.
       */
      localTakenFrom?: ObjectId;
      before: ProbeTrustAudit;
      after: ProbeTrustAudit;
    }
  | {
      /** A probe was refused from now on. `objectId` is the branch it held, now released. */
      action: 'probe.revoked';
      objectId: ObjectId | null;
      probe: ProbeIdentity;
      before: ProbeTrustAudit;
      after: ProbeTrustAudit;
    }
  | {
      /** Where one probe may connect from was changed. */
      action: 'probe.allowFrom.set';
      objectId: ObjectId | null;
      probe: ProbeIdentity;
      before: ProbeTrustAudit;
      after: ProbeTrustAudit;
    }
  | {
      /** A probe was forgotten: if it connects again it enrols as a stranger. */
      action: 'probe.deleted';
      objectId: ObjectId | null;
      probe: ProbeIdentity;
      before: ProbeTrustAudit;
    }
  | {
      /**
       * A discovery run was started (`A-20`).
       *
       * **An action, audited as `report.ran` is**, because "who swept that subnet?" is a security
       * question and is asked of the audit log. The run's own `created_by` says it too, but a run
       * goes with its group when the group is deleted, and the question outlives both. A run a
       * rediscovery schedule started is recorded as the system's, with the schedule's id.
       * `objectId` is the group it provisions into. The SNMP community is recorded as present or
       * not, never as itself.
       */
      action: 'discovery.started';
      objectId: ObjectId;
      runId: number;
      probeId: number;
      range: string;
      level: string;
      templates: string;
      community: boolean;
      scheduleId: number | null;
    }
  | {
      /** A discovery run was stopped by somebody, rather than finishing or failing. */
      action: 'discovery.cancelled';
      objectId: ObjectId;
      runId: number;
      range: string;
    }
  | {
      /**
       * A discovery run was ended for a reason the core found, rather than one the probe reported
       * (`A-41`): its rule was deleted, so nobody stands behind the addresses it found.
       */
      action: 'discovery.failed';
      objectId: ObjectId;
      runId: number;
      range: string;
      reason: string;
    }
  | {
      /**
       * A rediscovery schedule was created, changed or removed (`A-20`).
       *
       * Standing configuration that creates objects on a timer, so audited as configuration.
       * `objectId` is the group it provisions into, where somebody would look for it.
       */
      action: 'discovery.schedule.created';
      objectId: ObjectId;
      scheduleId: number;
      after: RediscoveryScheduleAudit;
    }
  | {
      action: 'discovery.schedule.updated';
      objectId: ObjectId;
      scheduleId: number;
      before: RediscoveryScheduleAudit;
      after: RediscoveryScheduleAudit;
      /**
       * One community replaced by another (`D-11`). `community` says only whether there is one,
       * so a replacement is `true` on both sides and would leave no trace; this says it happened
       * without saying what either was.
       */
      communityReplaced?: boolean;
      /**
       * The community cleared because the edit moved the range or the probe without sending one
       * (`A-40`). `community` going from `true` to `false` shows that it went; this says why, so
       * the person whose scans stopped answering can tell it from someone clearing it on purpose.
       */
      communityLeftBehind?: boolean;
    }
  | {
      action: 'discovery.schedule.deleted';
      objectId: ObjectId;
      scheduleId: number;
      before: RediscoveryScheduleAudit;
    }
  | {
      /**
       * An account was created, changed or removed (`A-18`).
       *
       * **The role is the change this exists for.** A `readonly` account made `readwrite` can now
       * change the tree, and until `A-18` that left no record anywhere durable; `before` and
       * `after` carry the role beside everything else an administrator can set. Never a password
       * or its hash — those are `account.passwordChanged`, which records only that one happened.
       *
       * `objectId` is null: an account is not a tree object, and its entries are found by
       * `accountId` in the summary or by filtering on the `account` category.
       */
      action: 'account.created';
      objectId: null;
      accountId: number;
      after: AccountAudit;
    }
  | {
      action: 'account.updated';
      objectId: null;
      accountId: number;
      before: AccountAudit;
      after: AccountAudit;
    }
  | {
      action: 'account.deleted';
      objectId: null;
      accountId: number;
      before: AccountAudit;
    }
  | {
      /**
       * A password was replaced — by its owner, or reset by an administrator (`reset`).
       *
       * **That it happened, and nothing about it.** Not the password, not the hash, not its
       * length: a hash in the audit log is a hash in every backup of the audit log, and an offline
       * guess against it needs nothing else.
       */
      action: 'account.passwordChanged';
      objectId: null;
      accountId: number;
      login: string;
      reset: boolean;
    }
  | {
      /**
       * A second factor was confirmed, and with it the first set of recovery codes (`A-18`).
       *
       * The count of codes, never a code and never the TOTP secret: either one is a way in.
       */
      action: 'account.mfaEnabled';
      objectId: null;
      accountId: number;
      login: string;
      recoveryCodes: number;
    }
  | {
      action: 'account.mfaDisabled';
      objectId: null;
      accountId: number;
      login: string;
    }
  | {
      /** A fresh set of recovery codes replaced the old one. The count, never the codes. */
      action: 'account.recoveryCodesRegenerated';
      objectId: null;
      accountId: number;
      login: string;
      recoveryCodes: number;
    }
  | {
      /**
       * A user group was created, changed or removed (`A-18`).
       *
       * `isAdmin` is in the diff because turning it on makes every member an administrator of the
       * installation at once — the same escalation as adding each of them to Administrators.
       */
      action: 'group.created';
      objectId: null;
      groupId: number;
      after: GroupAudit;
    }
  | {
      action: 'group.updated';
      objectId: null;
      groupId: number;
      before: GroupAudit;
      after: GroupAudit;
    }
  | {
      /** Its members are named, because the cascade takes their memberships with it. */
      action: 'group.deleted';
      objectId: null;
      groupId: number;
      before: GroupAudit;
      members: readonly string[];
    }
  | {
      /**
       * An account joined a group (`A-18`).
       *
       * **Adding an account to an administrator group is the largest escalation this system has**,
       * so `administers` says so in the entry itself: nobody reading the log afterwards should have
       * to know which group ids confer administration. `primary` is whether the group became the
       * account's primary one.
       */
      action: 'group.memberAdded';
      objectId: null;
      groupId: number;
      groupName: string;
      administers: boolean;
      accountId: number;
      login: string;
      primary: boolean;
    }
  | {
      action: 'group.memberRemoved';
      objectId: null;
      groupId: number;
      groupName: string;
      administers: boolean;
      accountId: number;
      login: string;
      wasPrimary: boolean;
    }
  | {
      /**
       * An account's primary group moved — which group owns what it creates. `before` is null when
       * it had none.
       */
      action: 'group.primarySet';
      objectId: null;
      accountId: number;
      login: string;
      before: GroupRef | null;
      after: GroupRef;
    }
  | {
      /**
       * An API token was issued (`A-18`).
       *
       * **The prefix, never the token**, the rule `map.share.created` follows: the prefix is what
       * the owner sees in their list and is not enough to authenticate with. `accountId` is the
       * owner, which need not be the actor.
       */
      action: 'token.issued';
      objectId: null;
      tokenId: number;
      accountId: number;
      login: string;
      name: string;
      prefix: string;
      scope: AccessRight;
      expiresAt: Date | null;
    }
  | {
      action: 'token.revoked';
      objectId: null;
      tokenId: number;
      accountId: number;
      login: string;
      name: string;
      prefix: string;
    };

/**
 * Which probe a trust decision was about (`A-20`): the facts an administrator decided on.
 *
 * Deliberately no key material of any kind. The gid is the identity; the name and the address
 * are what the queue showed when somebody chose.
 */
export interface ProbeIdentity {
  readonly gid: string;
  readonly name: string;
  readonly address: string;
}

/** What was decided about a probe, as the audit log records it (`A-20`). */
export interface ProbeTrustAudit {
  readonly status: string;
  /** The probe object it is bound to, or null for none. */
  readonly objectId: number | null;
  /** The address filter, one range after another; empty means anywhere. */
  readonly allowFrom: string;
  readonly note: string;
}

/**
 * A rediscovery schedule as the audit log records it (`A-20`).
 *
 * The cadence as the sentence the UI shows (`every Sunday at 03:00`), and the SNMP community as
 * whether one is set: it is a credential, and `P-55` already keeps it out of every response.
 */
export interface RediscoveryScheduleAudit {
  readonly name: string;
  readonly probeId: number;
  readonly range: string;
  readonly level: string;
  readonly templates: string;
  readonly community: boolean;
  readonly cadence: string;
  readonly timezone: string;
  readonly window: number | null;
  readonly autoProvision: boolean;
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly ratePerSecond: number;
}

/** What a grant is on (`A-17`). */
export type GrantSubject =
  | { readonly kind: 'object'; readonly id: number }
  | { readonly kind: 'map'; readonly id: number }
  | { readonly kind: 'report'; readonly id: number }
  | { readonly kind: 'library'; readonly id: number };

/**
 * A map as the audit log records it.
 *
 * The layout one item per line, each as its own JSON: a canvas has no shape a sentence fits, and
 * a line per widget still lets a diff be read as "this tile moved" rather than as one changed blob.
 */
export interface MapAudit {
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly layout: string;
}

/** A background as the audit log records it: what the file was, never what was in it. */
export interface MapBackgroundAudit {
  /**
   * One of `IMAGE_MEDIA_TYPES` when written (`P-370`): it is the stored background's, which the
   * sniffer named and `map_background_media_type_check` holds. The audit entry that carries it is
   * history, served as a diff whose `before` and `after` are open for every field.
   */
  readonly mediaType: ImageMediaType;
  readonly digest: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/**
 * A report as the audit log records it.
 *
 * The structured parts as compact JSON: they are small, a person can read them, and a text
 * rendering of each would be a second description of the report to keep in step with the first.
 */
export interface ReportAudit {
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly subjects: string;
  readonly span: string;
  readonly outputs: string;
  readonly schedule: string;
  readonly runAs: string;
}

/**
 * A library as the audit log records it.
 *
 * The nodes as text, one line each, rather than as the stored document: a diff is read by a
 * person, and "Customer A › Routers: types snmp.traffic; states down" is a change somebody can
 * recognise where a `jsonb` blob is not. `L-01`'s `describeNodes` writes it.
 *
 * **The document rides along, and decides whether the nodes changed** (`L-06`). The text is
 * lossy — tags `core` and `berlin` and a single tag `core, berlin` read alike, and so do two ids
 * behind one name — and comparing it recorded a real change as `diff: []`. So the diff compares
 * `document`, and records the text when that says what moved.
 */
export interface LibraryAudit {
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly nodes: string;
  readonly document: readonly LibraryNode[];
}

/**
 * A schedule as the audit log records it.
 *
 * The periods in their text form rather than as intervals: a diff is read by a person, and
 * `fr:19:00-mo:06:00` is a change somebody can recognise where `[{"start":6900,...}]` is not.
 */
export interface ScheduleAudit {
  readonly name: string;
  readonly description: string;
  readonly polarity: 'active' | 'inactive';
  readonly timezone: string | null;
  readonly periods: string;
}

/**
 * An account as the audit log records it (`A-18`): everything an administrator can set on one,
 * and nothing that authenticates. No password, no hash, no lock-out counters.
 */
export interface AccountAudit {
  readonly login: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly disabled: boolean;
  readonly mayAcknowledge: boolean;
  readonly mustChangePassword: boolean;
}

/** A user group as the audit log records it (`A-18`). */
export interface GroupAudit {
  readonly name: string;
  readonly description: string;
  readonly isAdmin: boolean;
}

/** A group by id and by the name it had at the time, which a later rename does not rewrite. */
export interface GroupRef {
  readonly groupId: number;
  readonly groupName: string;
}

export interface AuditSink {
  /**
   * Called **inside** the mutation's transaction, so an audit entry can never exist for a
   * change that rolled back, nor a change exist without its entry. That property is what makes
   * S-10 a sink swap rather than a rewrite.
   */
  record(q: Queryable, actor: Actor, mutations: readonly Mutation[], at: Date): Promise<void>;
}

/** The default until S-10 ships a table. Structured, correlated, and never a secret. */
export class LoggingAuditSink implements AuditSink {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ component: 'audit' });
  }

  record(_q: Queryable, actor: Actor, mutations: readonly Mutation[], at: Date): Promise<void> {
    for (const mutation of mutations) {
      this.#logger.info(
        { actor, at: at.toISOString(), ...summarise(mutation) },
        `audit ${mutation.action}`,
      );
    }
    return Promise.resolve();
  }
}

/** Log lines stay bounded: a subtree delete enumerates thousands of objects. */
function summarise(mutation: Mutation): Record<string, unknown> {
  switch (mutation.action) {
    case 'object.deleted':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        kind: mutation.kind,
        deleted: mutation.deleted,
        destroyedCount: mutation.destroyed.length,
      };
    case 'object.created':
      return { action: mutation.action, objectId: mutation.objectId, kind: mutation.kind };
    case 'object.updated':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        kind: mutation.kind,
        ...(mutation.secretsCleared === undefined
          ? {}
          : { secretsCleared: [...mutation.secretsCleared] }),
      };
    case 'object.moved':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        fromParentId: mutation.fromParentId,
        toParentId: mutation.toParentId,
        movedCount: mutation.movedCount,
      };
    case 'object.reordered':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        parentId: mutation.parentId,
        move: mutation.move,
        fromIndex: mutation.fromIndex,
        toIndex: mutation.toIndex,
      };
    case 'object.cloned':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        sourceId: mutation.sourceId,
        clonedCount: mutation.clonedCount,
      };
    case 'channel.limits.set':
    case 'channel.lookup.set':
    case 'channel.processing.set':
    case 'channel.redeclared':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        channelKey: mutation.channelKey,
      };
    case 'object.paused':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        kind: mutation.kind,
        from: mutation.from.toISOString(),
        until: mutation.until?.toISOString() ?? null,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'object.resumed':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        kind: mutation.kind,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'setting.set':
    case 'setting.reverted':
      return { action: mutation.action, objectId: mutation.objectId, key: mutation.key };
    case 'credential.set':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        credentialKind: mutation.credentialKind,
        created: mutation.created,
        secretsSet: [...mutation.secretsSet],
        secretsKept: [...mutation.secretsKept],
        ...(mutation.secretsCleared === undefined
          ? {}
          : { secretsCleared: [...mutation.secretsCleared] }),
        ...(mutation.withholds === undefined ? {} : { withholds: mutation.withholds }),
        ...(mutation.newlyWithheld === undefined ? {} : { newlyWithheld: mutation.newlyWithheld }),
        ...(mutation.noLongerWithheld === undefined
          ? {}
          : { noLongerWithheld: mutation.noLongerWithheld }),
        publicParams: mutation.publicParams,
      };
    case 'credential.deleted':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        credentialKind: mutation.credentialKind,
      };
    case 'credential.adopted':
      return {
        action: mutation.action,
        credentialKind: mutation.credentialKind,
        installation: mutation.installation,
        carried: mutation.carried,
        withheld: mutation.withheld,
      };
    case 'sensor.acknowledged':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        until: mutation.until?.toISOString() ?? null,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'sensor.acknowledgementCleared':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'sensor.simulatedError':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        simulated: mutation.simulated,
        sensorsAffected: mutation.sensorsAffected,
      };
    case 'trigger.created':
    case 'trigger.updated':
    case 'trigger.deleted':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        triggerId: mutation.triggerId,
        triggerKind: mutation.triggerKind,
      };
    case 'template.created':
    case 'template.updated':
    case 'template.deleted':
      return {
        action: mutation.action,
        templateId: mutation.templateId,
        name: mutation.name,
        method: mutation.method,
        ...(mutation.secretsCleared === undefined
          ? {}
          : { secretsCleared: [...mutation.secretsCleared] }),
      };
    case 'template.tested':
      return {
        action: mutation.action,
        templateId: mutation.templateId,
        name: mutation.name,
        method: mutation.method,
        delivered: mutation.delivered,
      };
    case 'report.ran':
      return {
        action: mutation.action,
        reportId: mutation.reportId,
        runId: mutation.runId,
        trigger: mutation.trigger,
        requestedBy: mutation.requestedBy,
        runAs: mutation.runAs,
        outcome: mutation.outcome,
      };
    case 'schedule.created':
    case 'schedule.deleted':
      return {
        action: mutation.action,
        scheduleId: mutation.scheduleId,
        name: 'after' in mutation ? mutation.after.name : mutation.before.name,
      };
    case 'schedule.updated':
      return {
        action: mutation.action,
        scheduleId: mutation.scheduleId,
        name: mutation.after.name,
      };
    // The name and nothing else: a library's nodes are a paragraph each, and the database row
    // holds them for whoever needs the diff.
    case 'library.created':
    case 'library.deleted':
      return {
        action: mutation.action,
        libraryId: mutation.libraryId,
        name: 'after' in mutation ? mutation.after.name : mutation.before.name,
      };
    case 'library.updated':
      return {
        action: mutation.action,
        libraryId: mutation.libraryId,
        name: mutation.after.name,
      };
    case 'grant.set':
      return {
        action: mutation.action,
        subject: mutation.subject,
        groupId: mutation.groupId,
        before: mutation.before,
        after: mutation.after,
      };
    case 'grant.revoked':
      return {
        action: mutation.action,
        subject: mutation.subject,
        groupId: mutation.groupId,
        before: mutation.before,
      };
    case 'grant.notCarried':
      return {
        action: mutation.action,
        subject: mutation.subject,
        groupId: mutation.groupId,
        onSource: mutation.onSource,
      };
    case 'map.created':
    case 'map.deleted':
      return {
        action: mutation.action,
        mapId: mutation.mapId,
        name: 'after' in mutation ? mutation.after.name : mutation.before.name,
      };
    case 'map.updated':
      return { action: mutation.action, mapId: mutation.mapId, name: mutation.after.name };
    case 'map.background.set':
      return { action: mutation.action, mapId: mutation.mapId, digest: mutation.after.digest };
    case 'map.background.removed':
      return { action: mutation.action, mapId: mutation.mapId, digest: mutation.before.digest };
    case 'map.share.created':
      return {
        action: mutation.action,
        mapId: mutation.mapId,
        shareId: mutation.shareId,
        label: mutation.label,
        expiresAt: mutation.expiresAt.toISOString(),
      };
    case 'map.share.revoked':
      return { action: mutation.action, mapId: mutation.mapId, shareId: mutation.shareId };
    case 'report.created':
    case 'report.deleted':
      return {
        action: mutation.action,
        reportId: mutation.reportId,
        name: 'after' in mutation ? mutation.after.name : mutation.before.name,
      };
    case 'report.updated':
      return { action: mutation.action, reportId: mutation.reportId, name: mutation.after.name };
    case 'probe.approved':
    case 'probe.revoked':
    case 'probe.allowFrom.set':
    case 'probe.deleted':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        gid: mutation.probe.gid,
        name: mutation.probe.name,
      };
    case 'discovery.started':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        runId: mutation.runId,
        range: mutation.range,
        scheduleId: mutation.scheduleId,
      };
    case 'discovery.cancelled':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        runId: mutation.runId,
        range: mutation.range,
      };
    case 'discovery.failed':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        runId: mutation.runId,
        range: mutation.range,
        reason: mutation.reason,
      };
    case 'discovery.schedule.created':
    case 'discovery.schedule.deleted':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        scheduleId: mutation.scheduleId,
        name: 'after' in mutation ? mutation.after.name : mutation.before.name,
      };
    case 'discovery.schedule.updated':
      return {
        action: mutation.action,
        objectId: mutation.objectId,
        scheduleId: mutation.scheduleId,
        name: mutation.after.name,
        ...(mutation.communityLeftBehind === true ? { communityLeftBehind: true } : {}),
      };
    case 'account.created':
    case 'account.deleted':
      return {
        action: mutation.action,
        accountId: mutation.accountId,
        login: 'after' in mutation ? mutation.after.login : mutation.before.login,
      };
    case 'account.updated':
      return {
        action: mutation.action,
        accountId: mutation.accountId,
        login: mutation.after.login,
        roleBefore: mutation.before.role,
        roleAfter: mutation.after.role,
      };
    case 'account.passwordChanged':
      return {
        action: mutation.action,
        accountId: mutation.accountId,
        login: mutation.login,
        reset: mutation.reset,
      };
    case 'account.mfaEnabled':
    case 'account.mfaDisabled':
    case 'account.recoveryCodesRegenerated':
      return { action: mutation.action, accountId: mutation.accountId, login: mutation.login };
    case 'group.created':
    case 'group.deleted':
      return {
        action: mutation.action,
        groupId: mutation.groupId,
        name: 'after' in mutation ? mutation.after.name : mutation.before.name,
      };
    case 'group.updated':
      return {
        action: mutation.action,
        groupId: mutation.groupId,
        name: mutation.after.name,
        isAdmin: mutation.after.isAdmin,
      };
    case 'group.memberAdded':
    case 'group.memberRemoved':
      return {
        action: mutation.action,
        groupId: mutation.groupId,
        accountId: mutation.accountId,
        administers: mutation.administers,
      };
    case 'group.primarySet':
      return {
        action: mutation.action,
        accountId: mutation.accountId,
        groupId: mutation.after.groupId,
      };
    case 'token.issued':
    case 'token.revoked':
      return {
        action: mutation.action,
        tokenId: mutation.tokenId,
        accountId: mutation.accountId,
        prefix: mutation.prefix,
      };
  }
}
