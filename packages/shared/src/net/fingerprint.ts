/**
 * What a discovery run learnt about one address (`D-02`).
 *
 * **Shared, and the shape is the contract between three places.** The probe collects it, the
 * core stores it, and `D-03`'s templates match on it — so it lives here rather than in any of
 * them. Every field is optional and absent means *not known*, never *not present*: a host that
 * did not answer SNMP and a host with no SNMP agent are different facts, and a template that
 * treated them alike would create SNMP sensors on machines that have none.
 */

/** A port that answered, and what it said if it said anything. */
export interface OpenPort {
  port: number;
  /** TCP only for now; UDP is asked about by protocol rather than by connecting. */
  transport: 'tcp' | 'udp';
  /** The first line a service volunteered — an SSH version, an SMTP greeting. Often absent. */
  banner?: string;
}

export interface Fingerprint {
  /** The address this describes, dotted-quad. */
  address: string;
  /** The PTR record, when there is one. Often the single most informative field. */
  reverseName?: string;
  ports: OpenPort[];
  /** `sysDescr`, verbatim. A vendor string that identifies a model and a firmware version. */
  sysDescr?: string;
  /** `sysObjectID`, the vendor's own identifier for the model. Precise where sysDescr is prose. */
  sysObjectId?: string;
  sysName?: string;
  /** The server header of an HTTP response, when one answered. */
  httpServer?: string;
  /**
   * What this looks like, in a small fixed vocabulary.
   *
   * Small deliberately: `D-03` maps these to sensor sets, and a vocabulary that grew a member
   * per vendor would be a mapping table nobody could keep current. Vendor detail stays in
   * `sysDescr` and `vendor`, where a template can match on it if it wants to.
   */
  kind: DeviceKind;
  /**
   * How sure the classification is, 0–100.
   *
   * Reported rather than thresholded here, because "create sensors automatically" and "show me
   * what you found" want different bars and neither belongs in the classifier.
   */
  confidence: number;
  /** The vendor, where something said so plainly. Free text; there is no registry worth using. */
  vendor?: string;
  /** Why the classifier decided what it did, in words. Shown to an operator who disagrees. */
  evidence: string[];
  /**
   * Why nothing was asked of this address: the probe's target policy refuses it (`A-63`).
   *
   * Present only then, and it is the whole sentence an operator reads: the address, the policy
   * and how to allow it. A host with this is not one that said nothing. It answered the sweep,
   * and identification sent it nothing, so `ports` is empty and `kind` is `unknown` because
   * nobody looked, not because nothing was there. No protocol version: a fingerprint's fields
   * are left open on the wire, and a core that has never heard of this one stores it and shows
   * the same sentence from `evidence`.
   */
  refused?: string;
}

/**
 * The vocabulary `D-03` maps to sensor sets.
 *
 * `unknown` is a real answer and the most important one: a host that answered a ping and nothing
 * else is a host that exists, and creating a Ping sensor for it is the right thing to do. Guessing
 * at it would create sensors that fail from the first scan, which is how an operator learns to
 * distrust discovery.
 */
export type DeviceKind =
  'windows' | 'linux' | 'network' | 'printer' | 'hypervisor' | 'nas' | 'unknown';

/** The ports a sweep asks about. Bounded, and each one earns its place. */
export const IDENTIFY_PORTS: readonly { port: number; why: string }[] = [
  // The three that classify almost everything.
  {
    port: 22,
    why: 'SSH — a Unix-like host, and its banner names the distribution as often as not',
  },
  { port: 445, why: 'SMB — Windows, or a NAS pretending to be one' },
  {
    port: 3389,
    why: 'RDP — Windows, and a desktop or a terminal server rather than a headless box',
  },
  // The ones that say what a host is *for*, which is what a template needs.
  { port: 80, why: 'HTTP — a management interface on a switch as often as a web server' },
  { port: 443, why: 'HTTPS — and the only one many appliances answer at all' },
  { port: 5985, why: 'WinRM — a Windows machine that T-09 can actually reach' },
  { port: 9100, why: 'JetDirect — a printer, and almost nothing else listens here' },
  { port: 631, why: 'IPP — a printer, or a Unix host running CUPS' },
  { port: 3306, why: 'MySQL — a database sensor set rather than a bare host' },
  { port: 5432, why: 'PostgreSQL — likewise' },
  { port: 1433, why: 'SQL Server — likewise, and it corroborates Windows' },
  { port: 25, why: 'SMTP — a mail relay, which is worth its own sensors' },
];

/**
 * What a host looks like, from what was collected.
 *
 * **Pure, and separate from collecting any of it**, because this is where a wrong answer is
 * expensive and invisible: a misclassified host gets the wrong sensor set, every one of those
 * sensors fails from its first scan, and an operator concludes that discovery does not work. It
 * is also the only part that can be tested without a network.
 *
 * **Ordered by how much a signal is worth, not by how easy it is to check.** `sysObjectID` is a
 * vendor saying what its own product is and outranks everything; `sysDescr` is prose written by
 * the same vendor and is nearly as good; a port is a guess. Evidence accumulates rather than the
 * first match winning, so an operator can see what the answer rested on.
 */
export function classify(evidence: Evidence): Fingerprint {
  const notes: string[] = [];
  const ports = new Set(evidence.ports.map((one) => one.port));
  const descr = (evidence.sysDescr ?? '').toLowerCase();
  const name = (evidence.reverseName ?? '').toLowerCase();
  const banner = evidence.ports.find((one) => one.port === 22)?.banner?.toLowerCase() ?? '';
  const http = (evidence.httpServer ?? '').toLowerCase();

  let kind: DeviceKind = 'unknown';
  let confidence = 0;
  let vendor: string | undefined;

  // --- sysObjectID: a vendor's own identifier for the model. The strongest signal there is.
  const enterprise = enterpriseOf(evidence.sysObjectId);
  if (enterprise !== null) {
    vendor = ENTERPRISES[enterprise.id];
    if (vendor !== undefined) {
      notes.push(`sysObjectID is under ${vendor}'s enterprise number (${String(enterprise.id)})`);
      const implied = ENTERPRISE_KINDS[enterprise.id];
      if (implied !== undefined) {
        kind = implied;
        confidence = 85;
      }
    } else {
      notes.push(
        `sysObjectID is under enterprise ${String(enterprise.id)}, which is not a vendor this knows`,
      );
      // An SNMP agent with an enterprise OID is *something* managed, and on a network that is
      // overwhelmingly a switch, a router or an appliance rather than a general-purpose host.
      kind = 'network';
      confidence = 40;
    }
  }

  // --- sysDescr: prose, but written by the vendor and very consistent per product line.
  for (const rule of DESCR_RULES) {
    if (!rule.match.test(descr)) continue;
    notes.push(`sysDescr says ${rule.why}`);
    if (rule.confidence > confidence) {
      kind = rule.kind;
      confidence = rule.confidence;
    }
    vendor ??= rule.vendor;
    break;
  }

  // --- The SSH banner names the distribution about as often as not.
  if (banner !== '') {
    notes.push(`SSH offered "${banner.slice(0, 60)}"`);
    if (/windows/.test(banner) && confidence < 70) {
      kind = 'windows';
      confidence = 70;
    } else if (confidence < 60) {
      kind = 'linux';
      confidence = 60;
    }
  }

  // --- Ports. A guess, and treated as one: they only decide when nothing better has.
  if (confidence < 60) {
    if (ports.has(9100) || ports.has(631)) {
      // Almost nothing but a printer listens on 9100, and a printer that also serves IPP is
      // not in doubt.
      kind = 'printer';
      confidence = ports.has(9100) && ports.has(631) ? 75 : 55;
      notes.push(
        ports.has(9100) ? 'port 9100 is open, which is JetDirect' : 'port 631 is open (IPP)',
      );
    } else if (ports.has(3389) || ports.has(5985)) {
      kind = 'windows';
      confidence = 65;
      notes.push(ports.has(3389) ? 'RDP is open' : 'WinRM is open');
    } else if (ports.has(445) && !ports.has(22)) {
      // SMB without SSH is Windows; SMB *with* SSH is usually a Linux box running Samba, which
      // is why the pair is not read as Windows.
      kind = 'windows';
      confidence = 50;
      notes.push('SMB is open and SSH is not');
    } else if (ports.has(22)) {
      kind = 'linux';
      confidence = 45;
      notes.push('SSH is open');
    }
  }

  // --- The reverse name, last: it is what somebody typed years ago and is the weakest evidence
  // of what a host *is*, while being the most useful thing to show an operator.
  if (name !== '') {
    notes.push(`reverse DNS says "${evidence.reverseName ?? ''}"`);
    for (const rule of NAME_RULES) {
      if (!rule.match.test(name)) continue;
      notes.push(`the name looks like ${rule.why}`);
      if (confidence < rule.confidence) {
        kind = rule.kind;
        confidence = rule.confidence;
      }
      break;
    }
  }

  if (http !== '' && kind === 'unknown') {
    notes.push(`HTTP identified itself as "${evidence.httpServer ?? ''}"`);
  }

  if (kind === 'unknown') {
    // Not a failure, and the note says so. A host that answered a ping and nothing else exists,
    // and a Ping sensor is the right thing to create for it — guessing would create sensors that
    // fail from their first scan, which is how an operator learns to distrust discovery.
    notes.push('nothing identified this host beyond the fact that it answered');
  }

  return {
    address: evidence.address,
    ...(evidence.reverseName === undefined ? {} : { reverseName: evidence.reverseName }),
    ports: evidence.ports,
    ...(evidence.sysDescr === undefined ? {} : { sysDescr: evidence.sysDescr }),
    ...(evidence.sysObjectId === undefined ? {} : { sysObjectId: evidence.sysObjectId }),
    ...(evidence.sysName === undefined ? {} : { sysName: evidence.sysName }),
    ...(evidence.httpServer === undefined ? {} : { httpServer: evidence.httpServer }),
    kind,
    confidence,
    ...(vendor === undefined ? {} : { vendor }),
    evidence: notes,
  };
}

/** Everything collected about one address, before anything is concluded from it. */
export interface Evidence {
  address: string;
  reverseName?: string;
  ports: OpenPort[];
  sysDescr?: string;
  sysObjectId?: string;
  sysName?: string;
  httpServer?: string;
}

/**
 * IANA private-enterprise numbers, for the vendors an operator is most likely to have.
 *
 * A short list on purpose. There are tens of thousands of registered enterprises and shipping a
 * copy of the registry would be a file nobody updates and a lookup that is wrong about the
 * vendors it does not have. What matters is that an *unrecognised* enterprise still tells us
 * something — a host with an enterprise sysObjectID is managed equipment — and that is handled
 * above rather than by growing this table.
 */
const ENTERPRISES: Readonly<Record<number, string>> = {
  2: 'IBM',
  9: 'Cisco',
  11: 'HP',
  23: 'Novell',
  42: 'Sun/Oracle',
  43: '3Com',
  171: 'D-Link',
  311: 'Microsoft',
  318: 'APC',
  789: 'NetApp',
  1588: 'Brocade',
  1751: 'Fortinet',
  1916: 'Extreme Networks',
  1991: 'Foundry',
  2011: 'Huawei',
  2021: 'Net-SNMP',
  2435: 'Brother',
  2636: 'Juniper',
  4526: 'Netgear',
  6027: 'Force10',
  6486: 'Alcatel-Lucent',
  6876: 'VMware',
  8072: 'Net-SNMP',
  10002: 'Ubiquiti',
  12356: 'Fortinet',
  14988: 'MikroTik',
  25506: 'H3C',
  30065: 'Arista',
  41112: 'Ubiquiti',
};

/** Where a vendor's enterprise number is enough to say what the thing is. */
const ENTERPRISE_KINDS: Readonly<Record<number, DeviceKind>> = {
  9: 'network',
  43: 'network',
  171: 'network',
  311: 'windows',
  789: 'nas',
  1588: 'network',
  1751: 'network',
  1916: 'network',
  1991: 'network',
  2011: 'network',
  2435: 'printer',
  2636: 'network',
  4526: 'network',
  6027: 'network',
  6486: 'network',
  6876: 'hypervisor',
  10002: 'network',
  14988: 'network',
  25506: 'network',
  30065: 'network',
  41112: 'network',
};

interface DescrRule {
  match: RegExp;
  kind: DeviceKind;
  confidence: number;
  why: string;
  vendor?: string;
}

/**
 * `sysDescr` patterns, most specific first.
 *
 * The first match wins, so order is the rule: "VMware ESXi" contains neither "linux" nor
 * "windows" but a Net-SNMP agent on an ESXi host reports a Linux-looking string, and a rule
 * ordered the other way round would classify every hypervisor as a Linux server.
 */
const DESCR_RULES: readonly DescrRule[] = [
  {
    match: /vmware esxi/,
    kind: 'hypervisor',
    confidence: 95,
    why: 'VMware ESXi',
    vendor: 'VMware',
  },
  { match: /\bproxmox\b/, kind: 'hypervisor', confidence: 90, why: 'Proxmox', vendor: 'Proxmox' },
  {
    match: /\bjetdirect\b|laserjet|officejet|\bkyocera\b|\bricoh\b|\blexmark\b/,
    kind: 'printer',
    confidence: 90,
    why: 'a printer',
  },
  { match: /\bsynology\b/, kind: 'nas', confidence: 92, why: 'Synology DSM', vendor: 'Synology' },
  {
    match: /\bqnap\b|\btruenas\b|\bfreenas\b/,
    kind: 'nas',
    confidence: 90,
    why: 'a NAS appliance',
  },
  { match: /\bnetapp\b/, kind: 'nas', confidence: 90, why: 'NetApp ONTAP', vendor: 'NetApp' },
  {
    match: /cisco ios|cisco nx-os|cisco adaptive security/,
    kind: 'network',
    confidence: 95,
    why: 'Cisco IOS or NX-OS',
    vendor: 'Cisco',
  },
  { match: /junos/, kind: 'network', confidence: 95, why: 'Juniper Junos', vendor: 'Juniper' },
  {
    match: /\bfortigate\b|fortios/,
    kind: 'network',
    confidence: 92,
    why: 'FortiOS',
    vendor: 'Fortinet',
  },
  {
    match: /\bmikrotik\b|routeros/,
    kind: 'network',
    confidence: 92,
    why: 'MikroTik RouterOS',
    vendor: 'MikroTik',
  },
  {
    match: /\barubaos\b|procurve|\baruba\b/,
    kind: 'network',
    confidence: 90,
    why: 'Aruba or ProCurve',
    vendor: 'HPE',
  },
  {
    match: /\bpfsense\b|\bopnsense\b/,
    kind: 'network',
    confidence: 88,
    why: 'pfSense or OPNsense',
  },
  {
    match: /\bubnt\b|\bunifi\b|edgeos/,
    kind: 'network',
    confidence: 88,
    why: 'Ubiquiti',
    vendor: 'Ubiquiti',
  },
  { match: /windows/, kind: 'windows', confidence: 90, why: 'Windows', vendor: 'Microsoft' },
  {
    match: /\blinux\b|\bubuntu\b|\bdebian\b|\bcentos\b|red hat|\brhel\b/,
    kind: 'linux',
    confidence: 88,
    why: 'Linux',
  },
  {
    match: /freebsd|openbsd|netbsd|\bsunos\b|\bsolaris\b|\baix\b|darwin/,
    kind: 'linux',
    confidence: 80,
    why: 'a Unix',
  },
  // **After the operating-system rules, and that ordering is the whole of this entry.**
  // `sysDescr` very often contains the host's own name, so `FreeBSD firewall.example.com
  // 13.2-RELEASE` matches `firewall` — and read before the Unix rule it turns every server
  // somebody named after its job into network equipment, with a switch's sensor set. An OS name
  // is the vendor describing the software; a bare noun may be describing nothing at all.
  {
    match: /\bswitch\b|\brouter\b|\bfirewall\b/,
    kind: 'network',
    confidence: 60,
    why: 'network equipment',
  },
];

/**
 * Reverse-DNS name patterns.
 *
 * Weak on purpose — a name is what somebody typed years ago — so these only ever *raise* a
 * classification that nothing better has decided, and they never outrank a vendor's own string.
 */
const NAME_RULES: readonly { match: RegExp; kind: DeviceKind; confidence: number; why: string }[] =
  [
    {
      match: /(^|[.\-_])(sw|switch|rtr|router|fw|firewall|gw)([.\-_0-9]|$)/,
      kind: 'network',
      confidence: 40,
      why: 'network equipment',
    },
    {
      match: /(^|[.\-_])(prn|print|printer)([.\-_0-9]|$)/,
      kind: 'printer',
      confidence: 40,
      why: 'a printer',
    },
    {
      match: /(^|[.\-_])(esxi?|vmhost|hyperv)([.\-_0-9]|$)/,
      kind: 'hypervisor',
      confidence: 40,
      why: 'a hypervisor',
    },
    { match: /(^|[.\-_])(nas|storage)([.\-_0-9]|$)/, kind: 'nas', confidence: 40, why: 'storage' },
  ];

/**
 * The enterprise number out of a sysObjectID.
 *
 * `1.3.6.1.4.1.<enterprise>.<whatever the vendor likes>`. Only the prefix is standard; everything
 * after the enterprise number is the vendor's own business, which is exactly why this reads the
 * number and stops.
 */
export function enterpriseOf(oid: string | undefined): { id: number; rest: string } | null {
  if (oid === undefined) return null;
  const trimmed = oid.trim().replace(/^\./, '');
  const prefix = '1.3.6.1.4.1.';
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  const dot = rest.indexOf('.');
  const head = dot < 0 ? rest : rest.slice(0, dot);
  if (!/^\d+$/.test(head)) return null;
  return { id: Number(head), rest: dot < 0 ? '' : rest.slice(dot + 1) };
}
