import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';

/**
 * Whether this device's address is on a DNS blocklist (`T-23`).
 *
 * **The worked example for `docs/adding-a-sensor-type.md`**, and a real sensor rather than a toy:
 * a mail relay that lands on Spamhaus stops delivering to half the internet, and it does so
 * silently — every other sensor on that host stays green while the mail queue backs up. Finding
 * out from a customer is the normal way this is discovered.
 *
 * **How a DNSBL works**, because the reversal is the only surprising part: to ask about
 * `192.0.2.42` you look up an `A` record for `42.2.0.192.zen.spamhaus.org`. `NXDOMAIN` means not
 * listed; an answer — conventionally in `127.0.0.0/8` — means listed, and *which* address encodes
 * why. IPv6 reverses nibble by nibble instead, which almost no list supports; this says so rather
 * than quietly querying something that will always answer `NXDOMAIN`.
 *
 * **Listed is a *reading*, not a check failure.** The channel is a count and the primary, so an
 * upper error limit of zero is what says "alarm if we are on any list" — visible and editable,
 * where a sensor that went Down on its own would be a threshold baked into code. A *lookup* that
 * fails is the failure: a resolver that cannot answer means this sensor knows nothing, and
 * reporting zero would be reporting "we are on no lists" on the strength of no evidence.
 */

/** Enough for the lists anybody actually watches, and bounded so one sensor is one small burst. */
const MAX_ZONES = 12;

export const dnsBlocklist: SensorType = {
  id: 'dns.blocklist',
  category: 'Network',
  // A handful of UDP lookups, run together.
  costHint: 'light',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['zones'],
    properties: {
      zones: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ZONES,
        title: 'Blocklists',
        description:
          'The zones to ask, one per entry — zen.spamhaus.org, bl.spamcop.net, b.barracuda' +
          'central.org. Check each list’s terms before pointing a monitoring system at it: most ' +
          'refuse queries from public resolvers and several rate-limit by source address.',
        items: { type: 'string', minLength: 3, maxLength: 253 },
      },
      address: {
        type: 'string',
        maxLength: 45,
        default: '',
        title: 'Address to check',
        description:
          'Empty uses this device’s own host, which must then be an IPv4 address rather than a ' +
          'name. Fill it in when the address that sends mail is not the address this device is ' +
          'reached on — which is the usual arrangement behind NAT.',
      },
      resolver: {
        type: 'string',
        maxLength: 45,
        default: '',
        title: 'Resolver',
        description:
          'Empty uses this probe’s own. Most blocklists refuse queries arriving from a public ' +
          'resolver, so a sensor answering “not listed” from 8.8.8.8 may be answering about the ' +
          'resolver’s quota rather than about this address.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 500,
        maximum: 60_000,
        default: 5_000,
        title: 'Timeout',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [
      // A count, not a verdict: an upper error limit of zero is what says "alarm if we are on
      // any list", and it is then visible and editable rather than baked into this file.
      { key: 'listings', name: 'Blocklists listing this address', unit: '', isPrimary: true },
      { key: 'checked', name: 'Blocklists checked', unit: '' },
      { key: 'lookupTime', name: 'Lookup time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { Resolver } = await import('node:dns/promises');

    const declared =
      typeof context.params['address'] === 'string' ? context.params['address'].trim() : '';
    const address = declared === '' ? context.target.host : declared;
    const reversed = reverseIpv4(address);
    if (reversed === null) {
      throw new Error(
        `"${address}" is not an IPv4 address, and a DNS blocklist is queried by reversing one — ` +
          'set the address explicitly if this device is reached by name, or if the address that ' +
          'sends mail is not the address it is reached on',
      );
    }

    const zones = readZones(context.params['zones']);
    if (zones.length === 0) throw new Error('this sensor names no blocklists to check');

    // `tries: 1`, and this is not a detail. Node's resolver retries **four times** by default
    // and `timeout` is per *try*, so a check configured for five seconds takes twenty — measured
    // here as a test that asked for 700 ms and waited nine seconds. A monitoring check has its
    // own scan interval and its own deadline; retrying inside one turns a configured timeout
    // into a number that means nothing.
    const resolver = new Resolver({
      timeout: Number(context.params['timeoutMs'] ?? 5_000),
      tries: 1,
    });
    const declaredResolver =
      typeof context.params['resolver'] === 'string' ? context.params['resolver'].trim() : '';
    if (declaredResolver !== '') resolver.setServers([declaredResolver]);

    const startedAt = process.hrtime.bigint();
    const listed: string[] = [];
    const failed: string[] = [];

    // All at once: a dozen sequential lookups at a five-second timeout is a minute of wall clock
    // in the case that matters, which is every list being slow because the resolver is unwell.
    const onAbort = (): void => {
      resolver.cancel();
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.all(
        zones.map(async (zone) => {
          try {
            const answers = await resolver.resolve4(`${reversed}.${zone}`);
            if (answers.length > 0) listed.push(`${zone} (${answers.join(', ')})`);
          } catch (error: unknown) {
            const raw = (error as { code?: unknown }).code;
            const code = typeof raw === 'string' ? raw : '';
            if (code === 'ENOTFOUND' || code === 'ENODATA') {
              // NXDOMAIN is the protocol's way of saying "not listed" — **and also what a zone
              // that does not exist answers.** A typo in a list name would otherwise be a sensor
              // that cheerfully reports "not listed" for ever, which is the exact failure this
              // type's own reversal test guards against in the other direction. Found live: two
              // zones queried, one of them fictional, both counted as clean.
              //
              // So an unlisted answer is confirmed by asking whether the zone itself exists. One
              // extra lookup per clean zone, which is the common case and still a small burst.
              if (await zoneExists(resolver, zone)) return;
              failed.push(`${zone}: that zone does not exist — check the spelling`);
              return;
            }
            failed.push(
              `${zone}: ${code === '' ? (error instanceof Error ? error.message : 'failed') : code}`,
            );
          }
        }),
      );
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }

    if (context.signal.aborted) throw new Error('the check was cancelled while querying');

    if (failed.length === zones.length) {
      // Every lookup failed, so this sensor knows nothing. Reporting zero listings would be
      // reporting "we are on no lists" on the strength of no evidence at all.
      throw new Error(
        `none of the ${String(zones.length)} blocklists could be queried — ${failed.join('; ')}`,
      );
    }

    const lookupTime = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e3) / 1e3;
    return {
      channels: [
        { key: 'listings', value: listed.length },
        { key: 'checked', value: zones.length - failed.length },
        { key: 'lookupTime', value: lookupTime },
      ],
      message:
        (listed.length === 0
          ? `${address} is on none of ${String(zones.length - failed.length)} blocklists`
          : `${address} is listed on ${listed.join(', ')}`) +
        (failed.length === 0 ? '' : `; ${String(failed.length)} could not be queried`),
    };
  },
};

/**
 * `192.0.2.42` becomes `42.2.0.192`, which is how a DNSBL is asked.
 *
 * Exported for its own test: the reversal is the one piece of this that is easy to get backwards,
 * and getting it backwards produces a sensor that always answers "not listed".
 */
export function reverseIpv4(address: string): string | null {
  const parts = address.trim().split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets.reverse().join('.');
}

/**
 * Whether a blocklist zone is a zone at all.
 *
 * `SOA` rather than `NS`, because a list served as a subdomain of a larger zone has its own SOA
 * and may have no NS records of its own. A lookup that fails for any *other* reason is treated as
 * "the zone is there" — this exists to catch a typo, not to second-guess a resolver having a bad
 * moment, and turning a transient into "your list name is wrong" would be worse than the problem.
 */
async function zoneExists(
  resolver: { resolveSoa(name: string): Promise<unknown> },
  zone: string,
): Promise<boolean> {
  try {
    await resolver.resolveSoa(zone);
    return true;
  } catch (error: unknown) {
    const raw = (error as { code?: unknown }).code;
    return !(raw === 'ENOTFOUND');
  }
}

function readZones(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_ZONES)) {
    if (typeof entry !== 'string') continue;
    const zone = entry.trim().toLowerCase().replace(/\.$/, '');
    if (zone === '' || seen.has(zone)) continue;
    seen.add(zone);
    out.push(zone);
  }
  return out;
}
