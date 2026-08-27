import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
// Type-only, and therefore erased: `node:dns` itself is loaded inside `execute`, where the
// resolver is actually built.
import type { Resolver as DnsResolver } from 'node:dns/promises';

/**
 * One DNS lookup, timed and checked (`P-11`).
 *
 * **Resolution is the dependency nothing else in a monitoring system can see failing.** Every
 * other check that names a host resolves it first, so a broken resolver turns into a hundred
 * sensors going Down at once with a hundred different-looking errors — and the one thing they
 * have in common is invisible. This is the sensor that says it in one line.
 *
 * **The resolver is configurable and defaults to the system's**, because those answer different
 * questions. Against the system resolver this is "can this probe resolve names at all", which is
 * what the hundred sensors depend on. Pointed at a specific server it is "is *that* nameserver
 * answering correctly", which is what you watch a DNS server with. Both are worth having and
 * they are the same sensor with one field changed.
 *
 * **The expected value is compared against every record**, not the first: a name with two A
 * records answers in either order, and a check that read `records[0]` would flap between them
 * for ever with nothing wrong.
 */

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'] as const;

export const dnsRecord: SensorType = {
  id: 'dns.record',
  category: 'Availability',
  costHint: 'light',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        maxLength: 255,
        default: '',
        title: 'Name to look up',
        description:
          'The name to resolve. Leave it empty to look up the device’s own host, which is what ' +
          'makes this sensor answer “can this probe still resolve this device”.',
      },
      recordType: {
        enum: [...RECORD_TYPES],
        default: 'A',
        title: 'Record type',
      },
      resolver: {
        type: 'string',
        maxLength: 64,
        default: '',
        title: 'Resolver',
        description:
          'The nameserver to ask, as an address. Empty uses the probe’s own system resolver, ' +
          'which is what every other sensor uses — so an empty one here is checking the thing ' +
          'the rest of your monitoring depends on. Naming a server instead watches that server.',
      },
      expected: {
        type: 'string',
        maxLength: 255,
        default: '',
        title: 'Expected value',
        description:
          'Optional. The check fails unless one of the records matches this, ignoring case — ' +
          '“10.0.0.5” for an A record, “mail.example.com” for MX. Compared against every record ' +
          'returned, because a name with two addresses answers in either order.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 60_000,
        default: 5_000,
        title: 'Timeout',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [
      { key: 'responseTime', name: 'Response time', unit: 'ms', isPrimary: true },
      // A name that resolves to nothing and a name that resolves to three addresses are
      // different facts, and a count is how a quietly-emptied record set becomes visible.
      { key: 'records', name: 'Records returned', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { Resolver } = await import('node:dns/promises');

    const asked = context.params['name'];
    const named = typeof asked === 'string' ? asked.trim() : '';
    const name = named === '' ? context.target.host : named;
    if (name === '') throw new Error('this sensor names nothing to look up');

    const typeRaw = context.params['recordType'];
    const recordType = typeof typeRaw === 'string' ? typeRaw.toUpperCase() : 'A';
    const serverRaw = context.params['resolver'];
    const server = typeof serverRaw === 'string' ? serverRaw.trim() : '';
    const expectedRaw = context.params['expected'];
    const expected = typeof expectedRaw === 'string' ? expectedRaw.trim() : '';
    const timeoutMs = Number(context.params['timeoutMs'] ?? 5_000);

    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    if (server !== '') {
      try {
        resolver.setServers([server]);
      } catch {
        throw new Error(
          `"${server}" is not an address this resolver can be pointed at — a resolver is an IP ` +
            'address, optionally with a port, not a host name',
        );
      }
    }

    const started = process.hrtime.bigint();
    let records: string[];
    try {
      records = await Promise.race([
        resolveAs(resolver, name, recordType),
        // `Resolver.cancel()` is the only way out, and it makes the pending lookup reject; the
        // race is what turns the check's own abort into that.
        abortRace(context.signal, resolver, name),
      ]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const where = server === '' ? 'the probe’s system resolver' : server;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        throw new Error(
          `${where} has no ${recordType} record for ${name} — the name resolves to nothing of ` +
            'that type, which is different from the lookup failing',
        );
      }
      throw new Error(
        `looking up the ${recordType} record for ${name} against ${where} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const responseTime = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100;
    const where = server === '' ? 'the system resolver' : server;

    if (records.length === 0) {
      throw new Error(`${where} returned no ${recordType} record for ${name}`);
    }

    if (expected !== '') {
      const wanted = expected.toLowerCase();
      const matched = records.some((record) => record.toLowerCase() === wanted);
      if (!matched) {
        throw new Error(
          `the ${recordType} record for ${name} is ${records.join(', ')}, and this sensor ` +
            `expects ${expected}`,
        );
      }
    }

    return {
      channels: [
        { key: 'responseTime', value: responseTime },
        { key: 'records', value: records.length },
      ],
      message:
        `${recordType} ${name} → ${records.slice(0, 4).join(', ')}` +
        (records.length > 4 ? ` and ${String(records.length - 4)} more` : '') +
        ` in ${String(responseTime)} ms via ${where}`,
    };
  },
};

/** The record types as text, since each of `Resolver`'s methods returns a different shape. */
async function resolveAs(
  resolver: DnsResolver,
  name: string,
  recordType: string,
): Promise<string[]> {
  switch (recordType) {
    case 'AAAA':
      return resolver.resolve6(name);
    case 'CNAME':
      return resolver.resolveCname(name);
    case 'MX':
      // Priority included: an MX set that kept its hosts and reordered their priorities is a
      // change worth seeing, and it is invisible if only the exchange is compared.
      return (await resolver.resolveMx(name)).map((mx) => `${String(mx.priority)} ${mx.exchange}`);
    case 'NS':
      return resolver.resolveNs(name);
    case 'PTR':
      return resolver.resolvePtr(name);
    case 'SOA': {
      const soa = await resolver.resolveSoa(name);
      return [`${soa.nsname} ${soa.hostmaster} ${String(soa.serial)}`];
    }
    case 'SRV':
      return (await resolver.resolveSrv(name)).map(
        (srv) => `${String(srv.priority)} ${String(srv.weight)} ${String(srv.port)} ${srv.name}`,
      );
    case 'TXT':
      // A TXT record is a list of strings that a resolver splits at 255 bytes; joining them is
      // what the record actually says, and comparing the fragments would be comparing an
      // encoding detail.
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
    default:
      return resolver.resolve4(name);
  }
}

/** Turns the check's abort into the resolver's own cancellation. */
function abortRace(signal: AbortSignal, resolver: DnsResolver, name: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      resolver.cancel();
      reject(new Error(`the check was cancelled before looking up ${name}`));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        resolver.cancel();
        reject(new Error(`the check was cancelled while looking up ${name}`));
      },
      { once: true },
    );
  });
}
