import type { ReceivedNotification } from '../../contract.js';

/**
 * What an SNMP notification is, once both versions have been made to look the same (`T-06`).
 *
 * **v1 and v2c traps are different messages, and everything downstream is easier if only one
 * place knows that.** A v1 trap carries an enterprise OID, a generic number 0–6, a specific
 * number and an agent address in the PDU header. A v2c trap and an inform carry none of those:
 * they put `sysUpTime.0` and `snmpTrapOID.0` at the front of the varbind list instead. A filter
 * rule written against one shape would silently never match the other, which is the worst
 * possible failure for a receiver — it looks exactly like a quiet network.
 *
 * RFC 3584 §3.1 is the mapping, and it is not a convention this invented:
 *
 * - generic 0…5 become `1.3.6.1.6.3.1.1.5.{generic + 1}` — coldStart, warmStart, linkDown,
 *   linkUp, authenticationFailure, egpNeighborLoss;
 * - generic 6, `enterpriseSpecific`, becomes `{enterprise}.0.{specific}`.
 *
 * The zero is there on purpose and is the part everybody drops: it is what keeps a vendor's
 * specific-trap OIDs from colliding with the objects in the same subtree.
 *
 * This module is pure. The probe's listener builds the notification from a datagram; everything
 * that *decides* anything — matching, counting, retaining — happens here and in the sensor type,
 * against plain data, with no socket in the test.
 */

/** `snmpTraps`, the subtree the six generic v1 traps map into. */
const SNMP_TRAPS = '1.3.6.1.6.3.1.1.5';

/** `snmpTrapOID.0`, where a v2c trap puts the thing a v1 trap puts in its header. */
export const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';

/** `sysUpTime.0`, the other varbind RFC 3416 requires at the front of a v2c notification. */
export const SYS_UPTIME_0 = '1.3.6.1.2.1.1.3.0';

/** The six generic traps, by their v1 generic number, for a readable message. */
export const GENERIC_TRAPS: readonly string[] = [
  'coldStart',
  'warmStart',
  'linkDown',
  'linkUp',
  'authenticationFailure',
  'egpNeighborLoss',
];

export type TrapVersion = 'v1' | 'v2c' | 'v3';
export type TrapKind = 'trap' | 'inform';

export interface TrapVarbind {
  readonly oid: string;
  readonly type: string;
  readonly value: string;
}

/** The `detail` an `snmp-trap` notification carries. Plain data: it crosses a worker boundary. */
export interface TrapDetail {
  readonly trapOid: string;
  readonly version: TrapVersion;
  readonly kind: TrapKind;
  /** v1 only: the enterprise OID from the PDU header. */
  readonly enterprise?: string;
  /** v1 only: the agent address from the PDU header, which may differ from the sender. */
  readonly agentAddress?: string;
  /** v1 only, 0–6. */
  readonly generic?: number;
  /** v1 only. */
  readonly specific?: number;
  readonly varbinds: readonly TrapVarbind[];
}

/** The name for a trap OID, when it is one of the six the RFC names. */
export function genericNameOf(trapOid: string): string | null {
  if (!trapOid.startsWith(`${SNMP_TRAPS}.`)) return null;
  const tail = trapOid.slice(SNMP_TRAPS.length + 1);
  if (!/^[1-6]$/.test(tail)) return null;
  return GENERIC_TRAPS[Number(tail) - 1] ?? null;
}

/**
 * The v2c trap OID a v1 trap is equivalent to (RFC 3584 §3.1).
 *
 * Exported and tested on its own because it is the single point where the two wire formats stop
 * being different, and getting it wrong produces a filter that matches nothing with no error
 * anywhere.
 */
export function trapOidFromV1(enterprise: string, generic: number, specific: number): string {
  if (generic >= 0 && generic <= 5) return `${SNMP_TRAPS}.${String(generic + 1)}`;
  // The `.0` is required and is the part everybody drops. Without it a vendor's specific traps
  // collide with the ordinary objects in the same subtree.
  return `${enterprise}.0.${String(specific)}`;
}

/** The trap OID a v2c notification declares, from the varbind RFC 3416 puts second. */
export function trapOidFromVarbinds(varbinds: readonly TrapVarbind[]): string | null {
  return varbinds.find((varbind) => varbind.oid === SNMP_TRAP_OID)?.value ?? null;
}

/**
 * A filter rule, as an operator writes it.
 *
 * Every field is optional and they are **and**-ed: an empty rule matches everything, which is
 * what a sensor watching one device wants, and adding a field only ever narrows. The alternative
 * — a rule that must be complete — makes the common case the most typing.
 */
export interface TrapRule {
  /** Matched against the sender's address. Exact, or a `10.1.` style prefix ending in a dot. */
  readonly source?: string;
  /** The trap OID, exactly or as a subtree when it ends in a dot. */
  readonly trapOid?: string;
  /** A substring of the rendered line, matched case-insensitively. */
  readonly contains?: string;
}

const oidMatches = (wanted: string, actual: string): boolean =>
  wanted.endsWith('.') ? actual.startsWith(wanted) || `${actual}.` === wanted : actual === wanted;

const sourceMatches = (wanted: string, actual: string): boolean =>
  wanted.endsWith('.') ? actual.startsWith(wanted) : actual === wanted;

/** Whether one notification satisfies one rule. Every field present must match. */
export function ruleMatches(rule: TrapRule, notification: ReceivedNotification): boolean {
  const detail = notification.detail as Partial<TrapDetail>;

  if (rule.source !== undefined && rule.source !== '') {
    if (!sourceMatches(rule.source, notification.source)) return false;
  }
  if (rule.trapOid !== undefined && rule.trapOid !== '') {
    const trapOid = typeof detail.trapOid === 'string' ? detail.trapOid : '';
    if (!oidMatches(rule.trapOid, trapOid)) return false;
  }
  if (rule.contains !== undefined && rule.contains !== '') {
    if (!notification.text.toLowerCase().includes(rule.contains.toLowerCase())) return false;
  }
  return true;
}

/** Reads a rule out of already-validated params, defensively — it crossed two boundaries. */
export function readRule(value: unknown): TrapRule | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const found = record[key];
    return typeof found === 'string' && found.trim() !== '' ? found.trim() : undefined;
  };
  const rule: TrapRule = {
    ...(text('source') === undefined ? {} : { source: text('source') as string }),
    ...(text('trapOid') === undefined ? {} : { trapOid: text('trapOid') as string }),
    ...(text('contains') === undefined ? {} : { contains: text('contains') as string }),
  };
  return rule;
}

/** One line for a trap, for retention and for the sensor message. */
export function renderTrap(source: string, detail: TrapDetail): string {
  const name = genericNameOf(detail.trapOid);
  const head = `${source} ${detail.kind} ${detail.version} ${name ?? detail.trapOid}`;
  // The two RFC 3416 varbinds are on every v2c notification and say nothing an operator wants;
  // the trap OID is already in the head and the uptime is not the interesting part.
  const payload = detail.varbinds.filter(
    (varbind) => varbind.oid !== SNMP_TRAP_OID && varbind.oid !== SYS_UPTIME_0,
  );
  if (payload.length === 0) return head;
  return `${head} [${payload.map((v) => `${v.oid}=${v.value}`).join(' ')}]`;
}
