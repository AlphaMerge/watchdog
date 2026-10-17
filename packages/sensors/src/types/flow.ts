import type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  ReceivedNotification,
  SensorType,
} from '../contract.js';
import { earlierNote, withEarlierNote } from '../support/earlier.js';

/**
 * What the probe's flow collector received for this exporter since this sensor last looked
 * (`B-04`).
 *
 * **The third listener sensor, on `T-06`'s contract unchanged.** The probe owns one socket, a
 * check runs in whichever worker is free and only while it is running, and `CheckContext.received`
 * hands each sensor what it has not seen. Nothing about that needed changing for a third protocol
 * — which is the whole return on having written a contract rather than a syslog listener.
 *
 * **Rates, not totals, and that is not a preference.** A sensor whose reading doubles when the
 * scan interval doubles is a sensor whose limits mean nothing: "alarm above 500" would have to be
 * re-derived every time somebody changed the schedule. Every traffic channel here is per second,
 * computed against the window `ReceivedBatch.since` opens, so the same link reads the same number
 * at any interval.
 *
 * **Silence is a failure by default, and this is the one real decision in the file.** A flow
 * exporter with nothing to report sends nothing at all — there is no heartbeat, no empty
 * datagram, no keepalive. So an interval with no flows in it is *either* an idle link *or* an
 * exporter that has stopped, been reconfigured, or lost its route to this collector, and no
 * amount of looking at what arrived can tell those apart. Reporting zero would pick the
 * flattering one silently and draw a confident line along the floor, which is `CLAUDE.md`'s
 * "no-data is not zero" exactly. Failing says the true thing: this sensor does not know. The
 * escape hatch is `silenceIsIdle`, for a link that genuinely is quiet much of the time and whose
 * operator has decided which reading they want.
 *
 * **Two other things it refuses to call zero**, both borrowed from `T-06` and `T-20` because the
 * reasoning transfers unchanged: a collector that is not running on this probe, and a buffer that
 * overwrote flows before this sensor read them. A receiver nobody switched on must not look like
 * a quiet network, and a count known to be short is a number nobody should act on.
 */

export const FLOW_LISTENER = 'flow';

/** IANA protocol numbers, for the per-protocol channels. */
const TCP = 6;
const UDP = 17;
const ICMP = 1;

/** More than this many user channels and the sensor list stops being readable. */
const MAX_CUSTOM_CHANNELS = 10;

interface FlowRule {
  readonly field: string;
  readonly equals: string;
  readonly contains: string;
  readonly cidr: string;
}

interface CustomChannel {
  readonly key: string;
  readonly name: string;
  readonly rules: readonly FlowRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * The user's channel definitions — `CAPABILITIES.MD §3.9`'s "custom flow variants".
 *
 * Exported for its own tests: a definition read wrongly is a channel counting the wrong traffic,
 * which looks exactly like a channel counting the right traffic.
 */
export function readCustomChannels(
  params: Readonly<Record<string, unknown>>,
): readonly CustomChannel[] {
  const raw = params['channels'];
  if (!Array.isArray(raw)) return [];
  const out: CustomChannel[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = text(entry, 'key');
    // A key that collides with a built-in would silently replace it in the reading array, so the
    // built-in name wins and the custom one is dropped rather than quietly shadowing it.
    if (key === '' || seen.has(key) || BUILT_IN_KEYS.has(key)) continue;
    seen.add(key);

    const rules: FlowRule[] = [];
    const rawRules = entry['match'];
    if (Array.isArray(rawRules)) {
      for (const rule of rawRules) {
        if (!isRecord(rule)) continue;
        const field = text(rule, 'field') || 'dstAddr';
        const equals = text(rule, 'equals');
        const contains = text(rule, 'contains');
        const cidr = text(rule, 'cidr');
        if (equals === '' && contains === '' && cidr === '') continue;
        rules.push({ field, equals, contains, cidr });
      }
    }

    out.push({ key, name: text(entry, 'name') || key, rules });
    if (out.length >= MAX_CUSTOM_CHANNELS) break;
  }
  return out;
}

const BUILT_IN_KEYS = new Set([
  'bytes',
  'packets',
  'flows',
  'tcp',
  'udp',
  'icmp',
  'other',
  'hosts',
]);

/** One flow field, as text, for a rule to match against. */
function fieldOf(notification: ReceivedNotification, field: string): string {
  const value = notification.detail[field];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (field === 'exporter' || field === 'source') return notification.source;
  return '';
}

/**
 * Whether an address is inside a CIDR block.
 *
 * **Here rather than a `contains` on the dotted quad**, which is the trap this replaces: a rule
 * written `contains: "10.0."` also matches 110.0.4.1 and 210.0.9.7, and the operator who wrote it
 * will never notice, because the channel keeps reporting a plausible number.
 */
export function inCidr(address: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) return false;
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const network = toWord(cidr.slice(0, slash));
  const candidate = toWord(address);
  if (network === null || candidate === null) return false;
  if (bits === 0) return true;

  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (network & mask) >>> 0 === (candidate & mask) >>> 0;
}

function toWord(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

/**
 * Whether a flow satisfies every rule.
 *
 * **All of them, not any** — the same reasoning `T-20` states: a rule list reading "protocol is 6"
 * and "dstPort is 443" means HTTPS, and if it meant "or", adding a second rule would *widen* the
 * channel, which is the opposite of what anybody typing one intends.
 */
export function matchesFlow(
  notification: ReceivedNotification,
  rules: readonly FlowRule[],
): boolean {
  return rules.every((rule) => {
    const value = fieldOf(notification, rule.field);
    if (rule.equals !== '' && value !== rule.equals) return false;
    if (rule.contains !== '' && !value.includes(rule.contains)) return false;
    if (rule.cidr !== '' && !inCidr(value, rule.cidr)) return false;
    return true;
  });
}

export const flowCollector: SensorType = {
  id: 'flow.netflow',
  category: 'Traffic',
  costHint: 'light',
  listener: FLOW_LISTENER,

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sourceIsDevice: {
        type: 'boolean',
        default: true,
        title: 'Only this exporter',
        description:
          'Counts only flows exported by the device this sensor sits under. Turn it off for a ' +
          'sensor watching every exporter that reaches this probe, which is what you want on a ' +
          'single site-wide traffic sensor and not what you want on a per-router one. A device ' +
          'addressed by name is looked up on the probe, and one whose name resolves to nothing ' +
          'fails the check rather than reporting no flows.',
      },
      silenceIsIdle: {
        type: 'boolean',
        default: false,
        title: 'Treat silence as an idle link',
        description:
          'Off by default, and deliberately. A flow exporter with nothing to report sends ' +
          'nothing at all — there is no heartbeat — so an interval with no flows is either an ' +
          'idle link or an exporter that has stopped, and nothing in what arrived can tell them ' +
          'apart. Left off, the check fails and says so. Turn it on for a link that is genuinely ' +
          'quiet much of the time, and accept that a stopped exporter will then read as zero.',
      },
      warnOnDropped: {
        type: 'boolean',
        default: true,
        title: 'Fail when the buffer overflowed',
        description:
          'Flows that reached this probe but were overwritten before this sensor read them make ' +
          'every count short by an unknown amount. Failing is the honest reading; turn this off ' +
          'only for an exporter whose flood is expected and whose totals you do not act on.',
      },
      channels: {
        type: 'array',
        maxItems: MAX_CUSTOM_CHANNELS,
        default: [],
        title: 'Extra channels',
        description:
          'Your own channels, each counting the traffic that satisfies **all** of its rules — ' +
          'what `CAPABILITIES.MD` calls custom flow variants. Each reports bytes per second, ' +
          'beside the built-in channels rather than instead of them.',
        items: {
          title: 'Channel',
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: {
            key: {
              type: 'string',
              maxLength: 40,
              pattern: '^[A-Za-z][A-Za-z0-9_]*$',
              'x-patternMessage':
                'must start with a letter, then letters, digits and underscores only',
              title: 'Key',
              description:
                'Stable identifier, used in the stored data. Cannot be one of the built-in ' +
                'channel keys, and changing it later starts a new channel rather than renaming ' +
                'this one.',
            },
            name: { type: 'string', maxLength: 60, default: '', title: 'Name' },
            match: {
              type: 'array',
              maxItems: 10,
              default: [],
              title: 'Rules',
              description: 'A flow must satisfy all of these. Empty counts every flow.',
              items: {
                title: 'Rule',
                type: 'object',
                additionalProperties: false,
                properties: {
                  field: {
                    type: 'string',
                    maxLength: 40,
                    default: 'dstAddr',
                    title: 'Field',
                    description:
                      'srcAddr · dstAddr · nextHop · srcPort · dstPort · protocol · inputIf · ' +
                      'outputIf · tos · srcAs · dstAs · exporter.',
                  },
                  equals: { type: 'string', maxLength: 60, default: '', title: 'Equals' },
                  contains: { type: 'string', maxLength: 60, default: '', title: 'Contains' },
                  cidr: {
                    type: 'string',
                    maxLength: 43,
                    default: '',
                    title: 'Inside CIDR',
                    description:
                      'For address fields: 10.0.0.0/8. Use this rather than “contains 10.0.”, ' +
                      'which also matches 110.0.4.1 and reports a plausible wrong number for ever.',
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  // Every reading is keyed by a channel `channels(params)` names for the same parameters, so one
  // an edit no longer names is retired (`P-310`).
  declaresEveryChannel: true,

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    return [
      // Bytes is primary: traffic volume is what a limit on a link is written against.
      { key: 'bytes', name: 'Traffic', unit: 'B/s', isPrimary: true },
      { key: 'packets', name: 'Packets', unit: '/s' },
      { key: 'flows', name: 'Flows', unit: '/s' },
      // Per protocol, because "the link is busy" and "the link is busy with UDP" are different
      // findings and only the second one tells anybody what to do next.
      { key: 'tcp', name: 'TCP', unit: 'B/s' },
      { key: 'udp', name: 'UDP', unit: 'B/s' },
      { key: 'icmp', name: 'ICMP', unit: 'B/s' },
      { key: 'other', name: 'Other protocols', unit: 'B/s' },
      // Distinct sources, which is the per-host signal that fits in a fixed channel set. A
      // channel per host would be unbounded, and the object model has devices for that.
      { key: 'hosts', name: 'Distinct sources', unit: '' },
      ...readCustomChannels(params).map((channel) => ({
        key: channel.key,
        name: channel.name,
        unit: 'B/s',
      })),
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const batch = context.received;
    if (batch === undefined || batch.listener !== FLOW_LISTENER) {
      // Never a zero. A collector nobody switched on must not look like a silent network.
      throw new Error(
        'this probe’s flow collector is not running, so there is nothing to count — set ' +
          '`flowListener.enabled` to true in the probe’s configuration and restart it. A sensor ' +
          'reporting zero here would ' +
          'say the link carried no traffic, which is not what is being observed',
      );
    }

    if (batch.dropped > 0 && context.params['warnOnDropped'] !== false) {
      // With what a resuming scan did not read: a flood the ring could not date always leaves a
      // full buffer dropped, so this is where `undated` lands (`P-274`).
      throw new Error(
        `${String(batch.dropped)} flow${batch.dropped === 1 ? '' : 's'} reached this probe but ` +
          'were overwritten before this sensor read them, so every count below is short by an ' +
          'unknown amount — the probe’s flow buffer is smaller than the export it is seeing, ' +
          'or this sensor scans too rarely for the volume' +
          earlierNote(batch, 'flow records'),
      );
    }

    const onlyThisDevice = context.params['sourceIsDevice'] !== false;
    const custom = readCustomChannels(context.params);
    // An exporter is an address and a device's host is often a name (`P-246`). Compared as
    // strings, a router addressed by name matched none of its own flows, and failed every scan
    // with "no flows arrived" while they did. The name is resolved, and one that resolves to
    // nothing fails naming the host rather than blaming the exporter. Resolved with the check's
    // own resolver, signal and bound (`P-425`).
    const isDevice = onlyThisDevice
      ? await withEarlierNote(batch, 'flow records', async () => {
          const { fromDevice, senderLookup } = await import('../support/sender.js');
          return fromDevice(context.target.host, 'flows', senderLookup(context));
        })
      : null;
    const mine =
      isDevice === null ? batch.items : batch.items.filter((item) => isDevice(item.source));

    if (mine.length === 0 && context.params['silenceIsIdle'] !== true) {
      // **The decision this file exists to make.** See the note on the module: there is no
      // heartbeat in NetFlow, so silence is unreadable rather than zero. After a restart, what
      // came before the window is named too: flows until a few minutes ago say the exporter
      // stopped recently, not that the link has been idle for hours (`P-274`).
      throw new Error(
        `no flows arrived from ${onlyThisDevice ? context.target.host : 'any exporter'} since ` +
          `${batch.since}. A flow exporter with nothing to report sends nothing at all, so ` +
          'this is either an idle link or an exporter that has stopped — and reporting zero ' +
          'would pick one of those silently. Set “Treat silence as an idle link” if this link ' +
          'is quiet by nature' +
          earlierNote(batch, 'flow records'),
      );
    }

    // **The window the rate is over, taken from the batch and not from this sensor's clock.**
    // `since`..`until` is what the listener actually drained; measuring to `Date.now()` instead
    // would include the wait for a free worker, so the same link would read slower on a busy
    // probe than on a quiet one and the dilution would look like a network change.
    const elapsedMs = Math.max(1, Date.parse(batch.until) - Date.parse(batch.since));
    const perSecond = (total: number): number => (total * 1_000) / elapsedMs;

    let bytes = 0;
    let packets = 0;
    let sampled = 0;
    const protocols = new Map<number, number>();
    const hosts = new Set<string>();
    const customBytes = new Map<string, number>(custom.map((channel) => [channel.key, 0]));

    for (const item of mine) {
      // **Scaled by what each record stands for** (`B-06`). sFlow sends one packet in N — 2,048
      // is an ordinary setting — and NetFlow v5 can sample too. Summing the raw octets would
      // under-report a sampled exporter by exactly N, silently, and the number would look
      // entirely plausible on the busiest link in the building. What comes out is an estimate,
      // which is what sampling gives you and what the message below says it is.
      const rate = Math.max(1, Number(item.detail['samplingRate'] ?? 1));
      if (rate > 1) sampled += 1;
      const octets = Number(item.detail['octets'] ?? 0) * rate;
      const count = Number(item.detail['packets'] ?? 0) * rate;
      const protocol = Number(item.detail['protocol'] ?? -1);
      bytes += octets;
      packets += count;
      protocols.set(protocol, (protocols.get(protocol) ?? 0) + octets);
      const src = item.detail['srcAddr'];
      if (typeof src === 'string') hosts.add(src);

      for (const channel of custom) {
        if (matchesFlow(item, channel.rules)) {
          customBytes.set(channel.key, (customBytes.get(channel.key) ?? 0) + octets);
        }
      }
    }

    const tcp = protocols.get(TCP) ?? 0;
    const udp = protocols.get(UDP) ?? 0;
    const icmp = protocols.get(ICMP) ?? 0;
    const other = bytes - tcp - udp - icmp;

    return {
      channels: [
        { key: 'bytes', value: perSecond(bytes) },
        { key: 'packets', value: perSecond(packets) },
        { key: 'flows', value: perSecond(mine.length) },
        { key: 'tcp', value: perSecond(tcp) },
        { key: 'udp', value: perSecond(udp) },
        { key: 'icmp', value: perSecond(icmp) },
        { key: 'other', value: perSecond(other) },
        { key: 'hosts', value: hosts.size },
        ...custom.map((channel) => ({
          key: channel.key,
          value: perSecond(customBytes.get(channel.key) ?? 0),
        })),
      ],
      message:
        `${String(mine.length)} flow${mine.length === 1 ? '' : 's'}, ` +
        `${formatRate(perSecond(bytes))} from ${String(hosts.size)} source` +
        `${hosts.size === 1 ? '' : 's'} since ${batch.since}` +
        // Said out loud, because an estimate from one packet in two thousand deserves to be
        // read as one — and because an operator comparing this against an interface counter
        // needs to know why the two do not agree exactly.
        (sampled === 0 ? '' : `; estimated from ${String(sampled)} sampled`) +
        earlierNote(batch, 'flow records'),
    };
  },
};

/** Bytes per second, in the unit an operator would say out loud. */
function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1_000) return `${(bytesPerSecond / 1_000).toFixed(1)} kB/s`;
  return `${bytesPerSecond.toFixed(0)} B/s`;
}
