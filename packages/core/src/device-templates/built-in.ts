import type { DeviceTemplate } from './definition.js';

/**
 * The templates every installation gets (`D-03`).
 *
 * **Deliberately few, and deliberately cautious.** The failure this set is written to avoid is a
 * discovery that creates thirty sensors per device, twenty of which fail from their first scan —
 * which is how an operator learns to distrust the feature and turns it off. So every sensor here
 * either needs nothing (Ping), or names the port it needs (`requires`), or names the credential
 * it needs (`credential`), and `applicableSensors` leaves out anything that would not work.
 *
 * **`ms.generic` matches everything and scores zero**, which is what makes the rest safe: there
 * is always at least a Ping sensor, so a device nothing recognised is still monitored rather than
 * created bare.
 *
 * Vendor-specific templates are the *shape* rather than the coverage: `CAPABILITIES.MD §3.7`
 * chooses templates plus SNMP Custom over hardcoded vendor sensor types precisely so an operator
 * can add their own, and shipping a hundred here would be claiming a coverage nobody has tested.
 * Two are included as worked examples of the two ways to pin one — a vendor name and an
 * enterprise OID prefix.
 */
export const BUILT_IN_DEVICE_TEMPLATES: readonly DeviceTemplate[] = [
  {
    id: 'ms.generic',
    name: 'Generic device',
    description:
      'Reachability, and nothing else. Matches every device, scores zero, and is beaten by ' +
      'anything that knows more — so a host nothing recognised is still monitored.',
    match: {},
    sensors: [{ type: 'icmp.ping', name: 'Ping' }],
    tags: ['auto-discovered'],
  },

  {
    id: 'ms.linux',
    name: 'Linux / Unix server',
    description:
      'Ping, plus SSH and SNMP sets where the host actually offers them. Nothing here is ' +
      'created without the port that serves it and the credential that authenticates it.',
    match: { kind: ['linux'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      {
        type: 'ssh.load',
        name: 'Load average',
        requires: { portsAll: [22] },
        credential: 'ssh',
      },
      {
        type: 'ssh.meminfo',
        name: 'Memory',
        requires: { portsAll: [22] },
        credential: 'ssh',
      },
      {
        type: 'ssh.diskfree',
        name: 'Disk free',
        requires: { portsAll: [22] },
        credential: 'ssh',
      },
      // SNMP is the alternative rather than the addition: a host that answers both gets both,
      // and one that answers only SNMP is still covered. The `sysDescr` requirement is how a
      // spec says "only if SNMP actually answered" — a fingerprint has one exactly when it did.
      { type: 'snmp.cpu', name: 'CPU load', requires: { sysDescr: '.' }, credential: 'snmp' },
      {
        type: 'snmp.memory',
        name: 'Memory (SNMP)',
        requires: { sysDescr: '.' },
        credential: 'snmp',
      },
      {
        type: 'snmp.diskfree',
        name: 'Root filesystem',
        // A mount point is required, and a template has to name one: `/` is the filesystem
        // every Unix has and the one that takes the machine down when it fills. Whichever
        // *other* filesystems a host has cannot be guessed from a fingerprint — `hrStorageDescr`
        // is only readable once the SNMP credential works — so those are an operator's to add.
        params: { mountPoint: '/' },
        requires: { sysDescr: '.' },
        credential: 'snmp',
      },
      { type: 'snmp.uptime', name: 'Uptime', requires: { sysDescr: '.' }, credential: 'snmp' },
    ],
    tags: ['auto-discovered', 'linux'],
  },

  {
    id: 'ms.windows',
    name: 'Windows server',
    description:
      'Ping, plus the WMI set where WinRM is reachable. `T-09` needs a Windows-hosted probe, so ' +
      'these are created only when port 5985 or 5986 answered — on a Linux-only installation ' +
      'that is never, which is the honest outcome rather than four failing sensors.',
    match: { kind: ['windows'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      {
        type: 'windows.cpu',
        name: 'CPU load',
        requires: { portsAny: [5985, 5986] },
        credential: 'windows',
      },
      {
        type: 'windows.memory',
        name: 'Memory',
        requires: { portsAny: [5985, 5986] },
        credential: 'windows',
      },
      {
        type: 'windows.volume',
        name: 'Disk free',
        requires: { portsAny: [5985, 5986] },
        credential: 'windows',
      },
    ],
    tags: ['auto-discovered', 'windows'],
  },

  {
    id: 'ms.network',
    name: 'Network device',
    description:
      'Switches, routers and firewalls. Uptime is the one that matters most: a device that ' +
      'rebooted is the explanation for everything else that went strange at the same moment.',
    match: { kind: ['network'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      { type: 'snmp.uptime', name: 'Uptime', credential: 'snmp' },
      { type: 'snmp.cpu', name: 'CPU load', credential: 'snmp' },
      { type: 'snmp.memory', name: 'Memory', credential: 'snmp' },
    ],
    tags: ['auto-discovered', 'network'],
  },

  {
    id: 'ms.printer',
    name: 'Printer',
    description:
      'Reachability and uptime. Toner and paper are per-vendor OIDs and belong in a template ' +
      'somebody writes for the printers they actually have — which is what the SNMP Custom ' +
      'sensor and this file being data are for.',
    match: { kind: ['printer'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      { type: 'snmp.uptime', name: 'Uptime', credential: 'snmp' },
      {
        type: 'http.request',
        name: 'Web interface',
        params: { path: '/' },
        requires: { portsAny: [80] },
      },
    ],
    tags: ['auto-discovered', 'printer'],
  },

  {
    id: 'ms.hypervisor',
    name: 'Hypervisor',
    description:
      'ESXi and Proxmox hosts. The guest-level detail is `D-05`’s VMware transport in v2; what ' +
      'is here is the host itself, which is what takes the guests with it when it goes.',
    match: { kind: ['hypervisor'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      { type: 'snmp.uptime', name: 'Uptime', credential: 'snmp' },
      { type: 'snmp.cpu', name: 'CPU load', credential: 'snmp' },
      { type: 'snmp.memory', name: 'Memory', credential: 'snmp' },
      {
        type: 'tls.certificate',
        name: 'Management certificate',
        requires: { portsAny: [443] },
      },
    ],
    tags: ['auto-discovered', 'hypervisor'],
  },

  {
    id: 'ms.nas',
    name: 'Storage / NAS',
    description: 'Free space first: a NAS that filled up is the outage, not the symptom.',
    match: { kind: ['nas'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      // `/volume1` is Synology's and QNAP's first share and covers most of what anybody has;
      // a NAS that names its volumes differently needs a template of its own, which is what
      // this file being data is for.
      {
        type: 'snmp.diskfree',
        name: 'Volume 1',
        params: { mountPoint: '/volume1' },
        credential: 'snmp',
      },
      { type: 'snmp.uptime', name: 'Uptime', credential: 'snmp' },
      { type: 'snmp.memory', name: 'Memory', credential: 'snmp' },
    ],
    tags: ['auto-discovered', 'storage'],
  },

  {
    id: 'ms.web-server',
    name: 'Web server',
    description:
      'Added to whatever else a device is, rather than instead of it: a Linux box serving HTTP ' +
      'gets both sets, which is why `matchTemplates` returns every match rather than the best.',
    match: { portsAny: [80, 443] },
    sensors: [
      {
        type: 'http.request',
        name: 'HTTP',
        params: { scheme: 'http', port: 80 },
        requires: { portsAll: [80] },
      },
      {
        type: 'tls.certificate',
        name: 'Certificate expiry',
        params: { port: 443 },
        requires: { portsAll: [443] },
      },
    ],
    tags: ['auto-discovered', 'web'],
  },

  {
    id: 'ms.cisco',
    name: 'Cisco device',
    description:
      'A worked example of pinning a template to an enterprise OID prefix, which is the most ' +
      'specific criterion there is. Add the per-model OIDs your estate actually uses with SNMP ' +
      'Custom sensors — that is what this mechanism is for.',
    match: { sysObjectIdPrefix: ['1.3.6.1.4.1.9'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      { type: 'snmp.uptime', name: 'Uptime', credential: 'snmp' },
      { type: 'snmp.cpu', name: 'CPU load', credential: 'snmp' },
      { type: 'snmp.memory', name: 'Memory', credential: 'snmp' },
    ],
    tags: ['auto-discovered', 'network', 'cisco'],
  },

  {
    id: 'ms.synology',
    name: 'Synology NAS',
    description:
      'The other way to pin a template: a vendor name, which the classifier reads out of ' +
      '`sysDescr`. Less precise than an OID prefix and easier to write.',
    match: { vendor: ['Synology'] },
    sensors: [
      { type: 'icmp.ping', name: 'Ping' },
      {
        type: 'snmp.diskfree',
        name: 'Volume 1',
        params: { mountPoint: '/volume1' },
        credential: 'snmp',
      },
      { type: 'snmp.uptime', name: 'Uptime', credential: 'snmp' },
      { type: 'snmp.cpu', name: 'CPU load', credential: 'snmp' },
      {
        type: 'tls.certificate',
        name: 'DSM certificate',
        params: { port: 5001 },
        requires: { portsAny: [443] },
      },
    ],
    tags: ['auto-discovered', 'storage', 'synology'],
  },
];
