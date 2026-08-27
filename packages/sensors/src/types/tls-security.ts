import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';

/**
 * Which TLS versions a device still accepts, scored (`T-12`).
 *
 * **It works by trying, because asking is not a thing TLS lets you do.** There is no query for
 * "what do you support"; a client offers a range and the server picks one. So this is one
 * handshake per version, each pinned to exactly that version, and what completed is what is
 * offered. Four connections a scan — which is why the default interval for this wants to be
 * hours rather than a minute, and why it says so in the parameter.
 *
 * **The score is the weakest thing still accepted, not an average.** An endpoint offering TLS
 * 1.3 *and* TLS 1.0 is a TLS 1.0 endpoint as far as an attacker is concerned, because the
 * attacker picks. Averaging would let a good new protocol hide a bad old one, which is the exact
 * mistake that makes a security dashboard reassuring and wrong.
 *
 * `[V1]` in `CAPABILITIES.MD §3.3`. Cipher *suite* enumeration per version is deliberately not
 * here: it is another dozen handshakes, and the version is what actually gets a device flagged
 * in an audit.
 */

/** Weakest first, so the first success is the score. */
const VERSIONS = [
  { id: 'TLSv1', label: 'TLS 1.0', score: 10 },
  { id: 'TLSv1.1', label: 'TLS 1.1', score: 30 },
  { id: 'TLSv1.2', label: 'TLS 1.2', score: 80 },
  { id: 'TLSv1.3', label: 'TLS 1.3', score: 100 },
] as const;

export const tlsSecurity: SensorType = {
  id: 'tls.security',
  category: 'Web',
  // Four handshakes rather than one. Not `heavy` — it holds no process — but far from free.
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
        description: 'Empty uses the device’s host.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 500,
        maximum: 60_000,
        default: 8_000,
        title: 'Timeout per version',
        description:
          'Applied to each handshake separately. This sensor makes one per TLS version, so a ' +
          'wholly unreachable host costs four of these — set the scan interval in hours, not ' +
          'minutes. What it measures changes when somebody edits a configuration file, not ' +
          'from one minute to the next.',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [
      // The weakest thing still accepted, because that is what an attacker gets to pick.
      { key: 'score', name: 'Weakest accepted', unit: '', isPrimary: true },
      { key: 'tls10', name: 'TLS 1.0 accepted', unit: '' },
      { key: 'tls11', name: 'TLS 1.1 accepted', unit: '' },
      { key: 'tls12', name: 'TLS 1.2 accepted', unit: '' },
      { key: 'tls13', name: 'TLS 1.3 accepted', unit: '' },
      { key: 'versions', name: 'Versions accepted', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { handshake } = await import('../support/tls/handshake.js');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to connect to');
    const port = Number(context.params['port'] ?? 443);
    const declared = context.params['servername'];
    const servername =
      typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : host;
    const timeoutMs = Number(context.params['timeoutMs'] ?? 8_000);
    const target = { host, port, servername, timeoutMs };

    const accepted = new Map<string, boolean>();
    let cipher: string | null = null;
    let anyReachable = false;
    let lastFailure = '';

    for (const version of VERSIONS) {
      if (context.signal.aborted) throw new Error(`the check was cancelled while probing ${host}`);
      try {
        const result = await handshake(target, context.signal, {
          // Pinned to exactly this version: a range would let the server pick its best and this
          // would learn nothing about the others.
          minVersion: version.id,
          maxVersion: version.id,
        });
        accepted.set(version.id, true);
        anyReachable = true;
        // The cipher from the *strongest* accepted version, which is what a real client gets.
        // Typed as definite; empty for an anonymous suite, which nothing should offer.
        cipher = result.cipher.standardName || result.cipher.name || cipher;
      } catch (error) {
        accepted.set(version.id, false);
        lastFailure = error instanceof Error ? error.message : String(error);
        // A refused *version* is the reading. A refused connection is a broken check, and the
        // two look different: one leaves the others succeeding.
      }
    }

    if (!anyReachable) {
      throw new Error(
        `${host}:${String(port)} accepted no TLS version at all — either it does not speak TLS ` +
          `on this port, or it is unreachable. The last attempt said: ${lastFailure}`,
      );
    }

    const weakest = VERSIONS.find((version) => accepted.get(version.id) === true);
    const count = [...accepted.values()].filter(Boolean).length;
    const offered = VERSIONS.filter((v) => accepted.get(v.id) === true).map((v) => v.label);

    const notes: string[] = [];
    if (accepted.get('TLSv1') === true || accepted.get('TLSv1.1') === true) {
      // Deprecated by RFC 8996 in March 2021, and the thing an audit flags first.
      notes.push('TLS 1.0 and 1.1 were deprecated by RFC 8996 and are what an audit flags first');
    }
    if (cipher !== null) notes.push(`strongest handshake used ${cipher}`);

    return {
      channels: [
        { key: 'score', value: weakest?.score ?? 0 },
        { key: 'tls10', value: accepted.get('TLSv1') === true ? 1 : 0 },
        { key: 'tls11', value: accepted.get('TLSv1.1') === true ? 1 : 0 },
        { key: 'tls12', value: accepted.get('TLSv1.2') === true ? 1 : 0 },
        { key: 'tls13', value: accepted.get('TLSv1.3') === true ? 1 : 0 },
        { key: 'versions', value: count },
      ],
      message: [`accepts ${offered.join(', ')}`, ...notes].join('; '),
    };
  },
};
