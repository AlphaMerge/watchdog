import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { scrubberOf } from '../support/secrets.js';

/**
 * Whether a relay is accepting mail (`T-17`).
 *
 * **A TCP connect is not this check.** Port 25 accepts a connection long after the relay behind
 * it has stopped taking mail: a queue that has filled up answers `452 insufficient system
 * storage` at `MAIL FROM`, an anti-spam layer that has lost its licence answers `451` at `RCPT
 * TO`, and both look perfect to a Port sensor. This one greets, identifies itself, optionally
 * authenticates, and — when asked to — puts a message through to a real address.
 *
 * **The greeting time is a channel of its own** because it is where a mail server's trouble shows
 * first. A relay under load answers the TCP handshake instantly and then takes eight seconds to
 * say `220`, since the greeting is where the reverse-DNS and RBL checks happen. One "response
 * time" spanning both hides exactly the number worth watching.
 */
export const mailSmtp: SensorType = {
  id: 'mail.smtp',
  category: 'Mail',
  costHint: 'light',
  credentialKinds: ['mail'],
  // Where the set goes besides the host (`A-41`): a port, and whether it is encrypted and checked.
  secretDestinations: { 'kind:mail': ['port', 'security', 'verifyTls'] },

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      port: {
        type: 'integer',
        minimum: 0,
        maximum: 65_535,
        default: 0,
        title: 'Port',
        description: 'Zero uses 587 for none/starttls and 465 for implicit TLS.',
      },
      security: {
        enum: ['none', 'starttls', 'tls'],
        default: 'starttls',
        title: 'Encryption',
        description:
          '`starttls` connects in the clear and upgrades, and fails when the server does not ' +
          'offer it rather than quietly continuing — a sensor that downgraded silently would ' +
          'report a healthy relay while sending the password in plain text.',
      },
      verifyTls: { type: 'boolean', default: true, title: 'Verify the certificate' },
      timeoutMs: {
        type: 'integer',
        minimum: 1_000,
        maximum: 300_000,
        default: 20_000,
        title: 'Timeout',
        description: 'Per step of the conversation, not for the whole check.',
      },
      requireAuth: {
        type: 'boolean',
        default: false,
        title: 'Authenticate',
        description:
          'Log in with the mail credential on this device. Off by default, because plenty of ' +
          'internal relays accept mail from a known host with no account at all.',
      },
      from: {
        type: 'string',
        maxLength: 320,
        default: '',
        title: 'Test sender',
        description:
          'Filled in together with the recipient below to actually put a message through — ' +
          'which is the difference between “the relay answers” and “the relay delivers”. Leave ' +
          'both empty to stop after the greeting.',
      },
      to: { type: 'string', maxLength: 320, default: '', title: 'Test recipient' },
      subject: {
        type: 'string',
        maxLength: 200,
        default: 'Monitoring test message',
        title: 'Subject',
      },
    },
  },

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const posts = typeof params['to'] === 'string' && params['to'].trim() !== '';
    return [
      { key: 'totalTime', name: 'Total time', unit: 'ms', isPrimary: true },
      // Where a mail server's trouble shows first: the greeting is where reverse-DNS and RBL
      // checks happen, and a relay under load answers the handshake instantly and 220 slowly.
      { key: 'greetingTime', name: 'Greeting', unit: 'ms' },
      ...(posts ? [{ key: 'sendTime', name: 'Message accepted in', unit: 'ms' }] : []),
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const scrub = scrubberOf(context);
    const { SmtpSession } = await import('../support/mail/smtp.js');
    const { readCredential, readTransport, securityNote } =
      await import('../support/mail/schema.js');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to connect to');
    const transport = readTransport(context.params, host, context.target.ipVersion, {
      plain: 587,
      tls: 465,
    });

    const from = text(context.params, 'from').trim();
    const to = text(context.params, 'to').trim();
    if (to !== '' && from === '') {
      throw new Error(
        'a test recipient was given with no sender — every message needs a MAIL FROM',
      );
    }

    const started = process.hrtime.bigint();
    const session = await SmtpSession.open(transport, context.signal);
    const greetedAt = process.hrtime.bigint();
    const notes = securityNote(transport.security, transport.verifyTls);

    try {
      if (context.params['requireAuth'] === true) {
        const { username, password } = readCredential(context.credentials);
        if (username === '') {
          throw new Error(
            'this sensor is set to authenticate but no mail credential is configured on this ' +
              'device or anything above it',
          );
        }
        await session.authenticate(username, password);
      }

      const channels = [{ key: 'greetingTime', value: msSince(started, greetedAt) }];
      if (to !== '') {
        const sendStarted = process.hrtime.bigint();
        const accepted = await session.send(
          from,
          to,
          messageFor(
            from,
            to,
            text(context.params, 'subject', 'Monitoring test message'),
            context.sensorId,
          ),
        );
        channels.push({ key: 'sendTime', value: msSince(sendStarted, process.hrtime.bigint()) });
        notes.push(`the message was accepted: ${scrub(accepted).slice(0, 120)}`);
      }
      await session.quit();

      const total = msSince(started, process.hrtime.bigint());
      return {
        channels: [{ key: 'totalTime', value: total }, ...channels],
        message: [`${to === '' ? 'greeted' : 'delivered'} in ${String(total)} ms`, ...notes].join(
          '; ',
        ),
      };
    } catch (error) {
      session.close();
      throw error;
    }
  },
};

/**
 * One header line's worth of an operator-supplied string.
 *
 * A carriage return in a subject would end the header and make everything after it another one —
 * `Subject: fine\r\nBcc: somebody@else` is a sensor parameter that adds a recipient. Folded to
 * spaces rather than rejected, because a subject with a stray newline in it is a typo and not an
 * attack in almost every case, and failing the check would be the wrong answer to a typo.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** A string parameter, or the fallback. `String(params[…])` would happily print [object Object]. */
function text(params: Readonly<Record<string, unknown>>, key: string, fallback = ''): string {
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

const msSince = (from: bigint, to: bigint): number => Math.round(Number(to - from) / 1e3) / 1e3;

/**
 * The message body.
 *
 * A `Date`, a `Message-ID` and a `From`/`To` are the minimum RFC 5322 headers a relay will not
 * rewrite or reject, and the sensor id in the id makes a message in somebody's inbox traceable
 * back to the sensor that sent it. `Auto-Submitted` is RFC 3834's way of saying "do not send a
 * vacation reply to this", which is how a test message becomes a loop.
 */
function messageFor(from: string, to: string, subject: string, sensorId: number): string {
  return [
    `From: <${from}>`,
    `To: <${to}>`,
    `Subject: ${oneLine(subject)}`,
    `Message-ID: <sensor-${String(sensorId)}.${process.hrtime.bigint().toString(36)}@monitoring-system>`,
    'Auto-Submitted: auto-generated',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Sent by monitoring sensor ${String(sensorId)} to check that this relay accepts mail.`,
    '',
  ].join('\n');
}
