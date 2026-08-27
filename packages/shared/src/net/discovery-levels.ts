import { IDENTIFY_PORTS } from './fingerprint.js';

/**
 * How hard a discovery run looks (`D-06`).
 *
 * **Three levels, and each one is a real trade of time against what it finds** — not a slider
 * with names on it. `CAPABILITIES.MD §7` asks for "standard, ping only" through "detailed, all
 * sensor types", and the honest way to offer that is to say what each costs before somebody
 * starts a run that takes a day.
 *
 * **In `@ms/shared` because both ends need the same numbers.** The core estimates from them and
 * shows the estimate before the run starts; the probe is told the ports and the timeout in the
 * job. One table, so the estimate cannot be about a different run from the one that happens.
 */

export type DiscoveryLevel = 'ping' | 'standard' | 'detailed';

export interface LevelDefinition {
  readonly id: DiscoveryLevel;
  readonly name: string;
  readonly description: string;
  /** Whether hosts are identified at all. `ping` stops after the sweep. */
  readonly identify: boolean;
  /** TCP ports each host is asked about. Empty at `ping`, where nothing is asked. */
  readonly ports: readonly number[];
  /** Per-probe budget during identification. Applied to each source, not to the whole host. */
  readonly identifyTimeoutMs: number;
}

/**
 * Ports `detailed` adds to the standard set.
 *
 * **Chosen because each one changes what gets created, not to make the list longer.** A port
 * that no template mentions and no classifier rule reads costs a connection per host and tells
 * nobody anything — which is the difference between a discovery level and a port scan.
 */
const DETAILED_EXTRA = [
  21, // FTP — still how half the appliances in a building are updated
  23, // Telnet — on a switch, this is a finding rather than a feature
  53, // DNS
  110, // POP3
  135, // RPC endpoint mapper — Windows, and reachable where 445 is blocked
  143, // IMAP
  161, // SNMP over TCP, which a few agents offer and which proves the agent is there
  389, // LDAP — a domain controller
  636, // LDAPS
  993, // IMAPS
  995, // POP3S
  1521, // Oracle
  2049, // NFS
  3000, // The port a hundred management UIs picked
  5986, // WinRM over HTTPS
  6379, // Redis
  8080, // HTTP alternate — the commonest management interface there is
  8443, // HTTPS alternate
  9090, // Another management-UI favourite
  27017, // MongoDB
] as const;

export const DISCOVERY_LEVELS: readonly LevelDefinition[] = [
  {
    id: 'ping',
    name: 'Ping only',
    description:
      'Sweeps the range and creates a device with a Ping sensor for every host that answered. ' +
      'Nothing is asked of the hosts themselves, so it is as fast as the sweep and finds ' +
      'nothing a template could act on.',
    identify: false,
    ports: [],
    identifyTimeoutMs: 0,
  },
  {
    id: 'standard',
    name: 'Standard',
    description:
      'Sweeps, then asks each live host what it is — reverse DNS, a dozen ports, the SNMP ' +
      'system group, and any banner a service volunteers — and applies the templates that ' +
      'match. This is what almost every installation wants.',
    identify: true,
    ports: IDENTIFY_PORTS.map((one) => one.port),
    identifyTimeoutMs: 1_000,
  },
  {
    id: 'detailed',
    name: 'Detailed',
    description:
      'Standard, with three times the ports and twice the patience per probe. Worth it on a ' +
      'network where hosts are slow or firewalls drop rather than refuse — and expensive ' +
      'enough that the estimate is the point of showing it.',
    identify: true,
    ports: [...IDENTIFY_PORTS.map((one) => one.port), ...DETAILED_EXTRA],
    identifyTimeoutMs: 2_000,
  },
];

export function levelDefinition(level: DiscoveryLevel): LevelDefinition {
  const found = DISCOVERY_LEVELS.find((one) => one.id === level);
  // `standard` rather than a throw: an unknown level reaching here means a newer core told an
  // older one about a level it does not have, and doing the sensible thing beats refusing to
  // discover anything at all.
  return found ?? (DISCOVERY_LEVELS[1] as LevelDefinition);
}

export interface EstimateInput {
  readonly level: DiscoveryLevel;
  readonly addresses: number;
  readonly sweepTimeoutMs: number;
  readonly sweepConcurrency: number;
  /** How many hosts identification runs at once. Far below the sweep's; see `D-02`. */
  readonly identifyConcurrency: number;
}

/**
 * How long a run will take, as a range.
 *
 * **A range rather than a number, because the honest answer depends on something nobody knows
 * yet: how many of those addresses are alive.** The two halves of a run pull in opposite
 * directions. An address that does *not* answer the sweep costs a full timeout, so an empty
 * range is the sweep's worst case; an address that *does* answer costs almost nothing there and
 * then has to be identified, which is where the time goes at `standard` and `detailed`.
 *
 * Writing that out with `a` for the fraction alive:
 *
 *     total(a) = (1 - a) · N · sweepTimeout / sweepConcurrency     the sweep
 *              +       a · N · identifyTimeout / identifyConcurrency   the identification
 *
 * It is **linear in `a`**, so every possible outcome lies between the two endpoints and the
 * range is exactly `a = 0` and `a = 1` — no fraction has to be guessed at, and nothing in the
 * middle can escape the bracket. An earlier version added the two halves' extremes together,
 * which reported a range that did not contain the answer for a half-alive network: the honest
 * bracket for a /24 at standard is eight seconds to thirty-two, not thirty-three to thirty-three.
 */
export function estimateSeconds(input: EstimateInput): { min: number; max: number } {
  const level = levelDefinition(input.level);
  const sweepConcurrency = Math.max(1, input.sweepConcurrency);
  const identifyConcurrency = Math.max(1, input.identifyConcurrency);

  // `a = 0`: nothing answered. The sweep pays a full timeout per address and there is nothing
  // left to identify.
  const nothingAlive = (input.addresses * input.sweepTimeoutMs) / sweepConcurrency / 1_000;

  // `a = 1`: everything answered. The sweep is as fast as the replies come back — a few
  // milliseconds each rather than a timeout — and then every host has to be identified. Asking
  // every source at once is why a host costs about one timeout rather than one per port, which
  // is the whole reason `D-02` runs them in parallel.
  //
  // No `if (level.identify)` here, deliberately: a level that does not identify has an
  // identification timeout of zero, which is the same statement made once instead of twice. A
  // mutation run proved the guard was unreachable, and two mechanisms for one rule is one that
  // can drift — so the table's invariant is asserted in the tests instead.
  const everythingAlive =
    (input.addresses * REPLY_MS) / sweepConcurrency / 1_000 +
    (input.addresses * level.identifyTimeoutMs) / identifyConcurrency / 1_000;

  return {
    min: Math.ceil(Math.min(nothingAlive, everythingAlive)),
    max: Math.ceil(Math.max(nothingAlive, everythingAlive)),
  };
}

/**
 * What a host that *is* there costs the sweep.
 *
 * Not zero: a reply still takes a round trip and a process to spawn. Ten milliseconds is a local
 * network being generous to itself, and it exists so a range where everything answers does not
 * estimate at nought seconds — which reads as "instant" and is never true.
 */
const REPLY_MS = 10;
