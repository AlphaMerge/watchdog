import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { checkedTarget, familyOf, guardOf, lookupFor } from '../support/checked-target.js';

/**
 * The certificate a device presents, and how long it has left (`T-11`).
 *
 * **Days-until-expiry is the primary channel, and that is the whole design.** An expired
 * certificate is not an incident to detect — it is one to have prevented, and the only thing
 * that prevents it is a number counting down where somebody can set a limit on it weeks out.
 * Every other channel here is context for the day it fires.
 *
 * **The chain is checked, not just the leaf.** An expiring *intermediate* takes a site down
 * exactly as an expiring leaf does, renews on a different schedule, and is the one nobody is
 * watching — so `daysRemaining` is the soonest expiry anywhere in the chain, and the message
 * says which certificate it belongs to when that is not the leaf.
 *
 * **The handshake does not verify, on purpose.** A client that refused to complete would report
 * nothing at all: the sensor would go Down with a TLS error rather than counting down the days,
 * which is the one thing it exists to do. So the connection accepts anything and the verdict —
 * trusted, expired, wrong host — becomes channels.
 */
export const tlsCertificate: SensorType = {
  id: 'tls.certificate',
  category: 'Web',
  costHint: 'medium',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      port: { type: 'integer', minimum: 1, maximum: 65_535, default: 443, title: 'Port' },
      servername: {
        type: 'string',
        maxLength: 255,
        default: '',
        title: 'Server name (SNI)',
        description:
          'Empty uses the device’s host. Set it when the device is addressed by IP but serves a ' +
          'named certificate, which is most of the modern web — without a name to ask for, the ' +
          'server answers with whatever its default site is.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 500,
        maximum: 120_000,
        default: 10_000,
        title: 'Timeout',
      },
    },
  },

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(): readonly ChannelDef[] {
    return [
      // The number somebody sets a limit on weeks out. Everything else is context for the day
      // that limit fires.
      { key: 'daysRemaining', name: 'Days until expiry', unit: 'days', isPrimary: true },
      { key: 'daysSinceIssued', name: 'Days since issued', unit: 'days' },
      { key: 'trusted', name: 'Chain is trusted', unit: '' },
      { key: 'hostMatches', name: 'Host name matches', unit: '' },
      { key: 'chainLength', name: 'Certificates in chain', unit: '' },
      { key: 'handshakeTime', name: 'Handshake time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { handshake, inspectCertificate } = await import('../support/tls/handshake.js');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to connect to');
    const port = Number(context.params['port'] ?? 443);
    const declared = context.params['servername'];
    const servername =
      typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : host;
    const timeoutMs = Number(context.params['timeoutMs'] ?? 10_000);
    // Over the device's IP version only (`A-85`): asked of the guard, so an address of the other
    // family is neither judged nor connected to, and of the socket's lookup under `none`.
    const family = familyOf(context.target.ipVersion);
    // Resolved once and checked against the probe's target policy; every handshake of this
    // check then goes to an address that lookup answered with (`A-57`).
    const startedAt = process.hrtime.bigint();
    const checked = await checkedTarget({
      ...guardOf(context.target),
      family,
      timeoutMs,
      signal: context.signal,
      verb: 'connect to',
      doing: `connecting to ${host}:${String(port)}`,
    });

    const result = await handshake(
      {
        host,
        port,
        servername,
        timeoutMs,
        startedAt,
        ...(family === 0 ? {} : { family }),
        ...lookupFor(host, checked, family),
      },
      context.signal,
    );
    const leaf = result.certificate;
    if (Object.keys(leaf).length === 0) {
      throw new Error(
        `${host}:${String(port)} completed a TLS handshake but presented no certificate — that ` +
          'is an anonymous cipher suite, which nothing should be offering',
      );
    }

    const verdict = inspectCertificate(leaf, servername);

    const notes: string[] = [];
    if (verdict.soonestSubject !== null) {
      notes.push(
        `the soonest expiry is an intermediate, "${verdict.soonestSubject}", not the leaf — it ` +
          'renews on its own schedule and is the one nobody watches',
      );
    }
    if (!verdict.hostMatches) {
      // Its addresses beside its names (`A-75`): since `A-71` an address is what this sensor may
      // have asked for, and a note naming only DNS names would hide the address it does list.
      const listed = [...verdict.names.slice(0, 4), ...verdict.addresses.slice(0, 4)];
      notes.push(
        `the certificate is for ${listed.join(', ') || 'no name or address at all'} and ` +
          `this sensor asked for ${servername}`,
      );
    }
    if (!result.authorized && result.authorizationError !== null) {
      notes.push(`the chain is not trusted: ${result.authorizationError}`);
    }
    if (verdict.daysRemaining < 0) {
      notes.push(`it expired ${String(-verdict.daysRemaining)} days ago`);
    }

    return {
      channels: [
        { key: 'daysRemaining', value: verdict.daysRemaining },
        { key: 'daysSinceIssued', value: verdict.daysSinceIssued },
        // Reported as numbers rather than as a failed check: an untrusted or mismatched
        // certificate is a fact to alarm on with a limit, and failing the check would lose the
        // expiry countdown at exactly the moment somebody needs it.
        { key: 'trusted', value: result.authorized ? 1 : 0 },
        { key: 'hostMatches', value: verdict.hostMatches ? 1 : 0 },
        { key: 'chainLength', value: verdict.chainLength },
        { key: 'handshakeTime', value: result.elapsedMs },
      ],
      message: [
        `${String(verdict.daysRemaining)} days left, issued by ${verdict.issuer}, ` +
          `${String(verdict.chainLength)} in chain`,
        ...notes,
      ].join('; '),
    };
  },
};
