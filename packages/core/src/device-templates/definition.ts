import type { DeviceKind, Fingerprint } from '@ms/shared';

/**
 * What a device template is (`D-03`).
 *
 * A template says *this kind of device gets these sensors*. It is the mechanism
 * `CAPABILITIES.MD §3.7` chooses over PRTG's dozens of hardcoded vendor sensor types: a template
 * plus SNMP Custom and SNMP Table covers a vendor's whole product line for the cost of a data
 * file, and an operator can add their own vendor without waiting for a release.
 *
 * **Pure data and pure functions.** Loading them is `loader.ts`, holding them is `catalogue.ts`,
 * and creating the objects is `D-04`. The split matters because matching is where a mistake is
 * expensive and silent — a template that matches too widely puts SNMP sensors on a printer that
 * has no agent, every one of them fails from its first scan, and an operator concludes discovery
 * does not work.
 *
 * **Matching is data, never an expression.** Every criterion below is a list or a bounded
 * pattern, and a template that could evaluate something would be an operator-supplied expression
 * running in the core — the same argument `T-21`'s formula language makes, for the same process.
 */

/** `ms.linux`, `acme.switch`. The same shape as a sensor type id and a lookup id. */
export const TEMPLATE_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/**
 * What a fingerprint has to look like.
 *
 * **Every field that is present must match — they are ANDed.** A template that ORed its criteria
 * would widen as it was made more specific, which is the opposite of what anybody writing one
 * expects. An absent field is not a criterion at all.
 */
export interface TemplateMatch {
  /** Any of these device kinds. */
  kind?: readonly DeviceKind[];
  /** Any of these vendors, compared case-insensitively. */
  vendor?: readonly string[];
  /** A regular expression against `sysDescr`, case-insensitive. Bounded; validated at load. */
  sysDescr?: string;
  /** Any of these `sysObjectID` prefixes. A vendor's own identifier for a product line. */
  sysObjectIdPrefix?: readonly string[];
  /** Every one of these ports must be open. */
  portsAll?: readonly number[];
  /** At least one of these ports must be open. */
  portsAny?: readonly number[];
  /** The classifier must have been at least this sure. */
  minConfidence?: number;
}

/**
 * One sensor a template creates.
 *
 * **`requires` is per sensor, not only per template**, and that is what stops a template being a
 * lie. "Linux server" is a reasonable thing to match, and an SSH Disk Free sensor on a Linux
 * server with SSH firewalled off is a sensor that fails for ever — so the spec that needs port
 * 22 says so, and `D-04` creates the rest.
 */
export interface SensorSpec {
  /** A sensor type id. Validated against the catalogue at load, so a typo fails loudly. */
  readonly type: string;
  /** Display name. Absent uses the type's own, which is what a hand-added sensor gets. */
  readonly name?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Extra conditions on the fingerprint, beyond the template's own. */
  readonly requires?: TemplateMatch;
  /**
   * A credential kind this sensor cannot work without.
   *
   * **Declared so that a sensor is not created when nothing can authenticate it.** A discovery
   * that creates twelve SNMP sensors on a device whose group has no SNMP credential produces
   * twelve sensors that fail from their first scan, and that is how an operator learns to
   * distrust discovery (`WORKFLOW.MD §1`: credentials belong *before* discovery for exactly
   * this reason).
   */
  readonly credential?: string;
  /**
   * This sensor becomes the device's **master object** (`D-05`, `M-11`).
   *
   * `WORKFLOW.MD §2` says auto-discovery sets each device's Ping sensor as master object for the
   * parent device, so the whole sensor set pauses when the device is unreachable — one outage,
   * one alarm, which is the rule the whole system is built around.
   *
   * **A template property rather than a hardcoded sensor type**, because "the reachability
   * sensor" is not always a Ping. A switch reached only over SNMP has none; an appliance behind
   * a firewall that drops ICMP is monitored by its HTTPS certificate. A template written for
   * those says which of its sensors goes Down when the device is gone, and a template that says
   * nothing gets no master — which is honest, and better than picking one by a rule nobody can
   * see in the file.
   *
   * At most one per plan. `applicableSensors` filters before this is read, so a master whose
   * port is closed or whose credential is missing is simply not there — and a device is left
   * with no master rather than one that cannot scan, which would pause every sensor on it for
   * ever.
   */
  readonly master?: boolean;
}

export interface DeviceTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** What this template applies to. An empty object matches every fingerprint. */
  readonly match: TemplateMatch;
  readonly sensors: readonly SensorSpec[];
  /**
   * Added to every device this template creates, so an operator can find them later.
   *
   * Discovery is the one thing in this system that creates objects nobody asked for
   * individually, and "which of these did the machine make" is the first question somebody asks
   * when a discovery went wrong.
   */
  readonly tags?: readonly string[];
}

/** How specific each criterion is. The sum is a template's score, and the highest wins. */
const WEIGHTS = {
  sysObjectIdPrefix: 50,
  sysDescr: 40,
  vendor: 30,
  kind: 20,
  portsAll: 10,
  portsAny: 5,
  minConfidence: 1,
} as const;

/**
 * Whether a fingerprint matches, and how specifically.
 *
 * Null for no match; otherwise a score. **The score is the sum of what matched, not a count**, so
 * a template pinned to a `sysObjectID` prefix outranks one that only says "network device" — and
 * the ordering falls out of how specific each criterion is rather than out of an order somebody
 * has to maintain by hand.
 *
 * A template with no criteria scores zero and matches everything, which is exactly what the
 * generic fallback needs: it applies to every device and is beaten by anything that knows more.
 */
export function matchScore(fingerprint: Fingerprint, match: TemplateMatch): number | null {
  let score = 0;
  const openPorts = new Set(fingerprint.ports.map((one) => one.port));

  if (match.kind !== undefined) {
    if (!match.kind.includes(fingerprint.kind)) return null;
    score += WEIGHTS.kind;
  }
  if (match.vendor !== undefined) {
    const vendor = (fingerprint.vendor ?? '').toLowerCase();
    if (vendor === '' || !match.vendor.some((one) => one.toLowerCase() === vendor)) return null;
    score += WEIGHTS.vendor;
  }
  if (match.sysDescr !== undefined) {
    // Compiled fresh rather than cached on the template: a `RegExp` with the `g` flag carries
    // `lastIndex` between calls, and a shared one would make the same fingerprint match or not
    // depending on what was tested before it.
    if (!new RegExp(match.sysDescr, 'i').test(fingerprint.sysDescr ?? '')) return null;
    score += WEIGHTS.sysDescr;
  }
  if (match.sysObjectIdPrefix !== undefined) {
    const oid = (fingerprint.sysObjectId ?? '').replace(/^\./, '');
    if (oid === '' || !match.sysObjectIdPrefix.some((one) => underOid(oid, one))) return null;
    score += WEIGHTS.sysObjectIdPrefix;
  }
  if (match.portsAll !== undefined) {
    if (!match.portsAll.every((port) => openPorts.has(port))) return null;
    score += WEIGHTS.portsAll * match.portsAll.length;
  }
  if (match.portsAny !== undefined) {
    if (!match.portsAny.some((port) => openPorts.has(port))) return null;
    score += WEIGHTS.portsAny;
  }
  if (match.minConfidence !== undefined) {
    if (fingerprint.confidence < match.minConfidence) return null;
    score += WEIGHTS.minConfidence;
  }
  return score;
}

/**
 * Whether an OID is under a prefix, on component boundaries.
 *
 * `startsWith` would make `1.3.6.1.4.1.9` match `1.3.6.1.4.1.99`, which is Cisco's arc matching
 * an entirely unrelated vendor's — the same class of mistake as a substring match on a hostname,
 * and just as invisible once a template has been written against it.
 */
function underOid(oid: string, prefix: string): boolean {
  const clean = prefix.replace(/^\./, '').replace(/\.$/, '');
  return oid === clean || oid.startsWith(`${clean}.`);
}

/** A template that matched, with its score. */
export interface TemplateMatchResult {
  readonly template: DeviceTemplate;
  readonly score: number;
}

/**
 * Every template that applies, most specific first.
 *
 * All of them rather than only the best, because a device is genuinely several things at once: a
 * Linux server that also serves HTTP wants both sets, and picking one would mean an operator
 * writing "Linux server that also serves HTTP" and then "…and also PostgreSQL". `D-04` decides
 * what to do with the list; deduplicating the sensors is its problem, not this function's.
 */
export function matchTemplates(
  fingerprint: Fingerprint,
  templates: readonly DeviceTemplate[],
): TemplateMatchResult[] {
  const found: TemplateMatchResult[] = [];
  for (const template of templates) {
    const score = matchScore(fingerprint, template.match);
    if (score !== null) found.push({ template, score });
  }
  // Ties broken by id so the order is stable: a discovery that produced sensors in a different
  // order on two runs would make its own diff unreadable.
  return found.sort((a, b) => b.score - a.score || a.template.id.localeCompare(b.template.id));
}

/**
 * The sensors a template would actually create for this device.
 *
 * Two filters, and both exist to avoid creating a sensor that cannot work. `requires` is the
 * fingerprint's side — no SSH sensor on a host with port 22 closed — and `credential` is the
 * configuration's: a sensor whose kind nothing in this device's ancestry can authenticate is
 * left out rather than created and left failing.
 */
export function applicableSensors(
  template: DeviceTemplate,
  fingerprint: Fingerprint,
  availableCredentials: ReadonlySet<string> = new Set(),
): SensorSpec[] {
  return template.sensors.filter((spec) => {
    if (spec.requires !== undefined && matchScore(fingerprint, spec.requires) === null)
      return false;
    if (spec.credential !== undefined && !availableCredentials.has(spec.credential)) return false;
    return true;
  });
}

/**
 * What is wrong with a template, in words, or nothing.
 *
 * Returns every problem rather than the first, because a template is written by hand and being
 * told about one typo at a time is how a five-minute job becomes an afternoon.
 */
export function validateTemplate(
  template: DeviceTemplate,
  knownSensorType: (id: string) => boolean,
  /**
   * Whether a spec's parameters would actually make that sensor.
   *
   * **Added after provisioning failed on a built-in template**, which named `snmp.diskfree`
   * without the mount point that type requires. Checking only that the *type* exists is checking
   * half of it: the create call fails at provisioning time, once per device, long after anybody
   * is looking at the template. Optional so a caller with no catalogue can still validate the
   * shape.
   */
  validateParams?: (id: string, params: Readonly<Record<string, unknown>>) => string[],
): string[] {
  const problems: string[] = [];
  if (!TEMPLATE_ID.test(template.id)) {
    problems.push(`"${template.id}" is not a template id — they look like ms.linux or acme.switch`);
  }
  if (template.name.trim() === '') problems.push('a template needs a name');
  if (template.sensors.length === 0) {
    problems.push('a template with no sensors would create a device and nothing to watch it with');
  }

  const masters = template.sensors.filter((spec) => spec.master === true);
  if (masters.length > 1) {
    // Which one won would depend on the order they happen to be written in, and a dependency
    // that moves when somebody reorders a file is worse than no dependency at all.
    problems.push(
      `${String(masters.length)} sensors are marked as the device's master object; at most one can be`,
    );
  }

  const seen = new Set<string>();
  for (const spec of template.sensors) {
    if (!knownSensorType(spec.type)) {
      // Loudly, and by name. A template naming a sensor type that does not exist silently
      // creates fewer sensors than it says it will, which nobody notices until the day the
      // device it mattered on goes down.
      problems.push(`there is no sensor type called "${spec.type}"`);
    } else if (validateParams !== undefined) {
      for (const problem of validateParams(spec.type, spec.params ?? {})) {
        problems.push(`"${spec.type}" cannot be created as configured: ${problem}`);
      }
    }
    // The same type twice is legitimate — two HTTP sensors on different paths — so the key
    // includes the parameters. Two *identical* specs are a copy-paste mistake.
    const key = `${spec.type}:${JSON.stringify(spec.params ?? {})}:${spec.name ?? ''}`;
    if (seen.has(key)) problems.push(`"${spec.type}" appears twice with the same settings`);
    seen.add(key);
  }

  for (const [where, match] of [
    ['the template', template.match] as const,
    ...template.sensors.map((spec) => [`"${spec.type}"`, spec.requires] as const),
  ]) {
    if (match?.sysDescr === undefined) continue;
    if (match.sysDescr.length > 200) {
      problems.push(`${where} has a sysDescr pattern longer than 200 characters`);
      continue;
    }
    try {
      new RegExp(match.sysDescr, 'i');
    } catch (error) {
      problems.push(
        `${where} has a sysDescr pattern that is not a regular expression: ` +
          (error instanceof Error ? error.message : 'unreadable'),
      );
    }
  }

  return problems;
}
