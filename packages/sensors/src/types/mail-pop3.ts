import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { MAIL_TRANSPORT_SCHEMA } from '../support/mail/schema.js';

/**
 * Whether a mailbox can be opened, and how full it is (`T-17`).
 *
 * **The message count is the reading that matters, not the login time.** A POP3 server answering
 * in four milliseconds with 40,000 messages in the mailbox is a delivery pipeline that stopped
 * collecting a week ago — and every check that only asks "does it answer" reports it as healthy
 * right up until the disk fills.
 *
 * **Read-only, always.** No `DELE` here: this sensor exists to look, and a monitoring check that
 * deletes somebody's mail because a threshold moved is a fault of a kind that cannot be undone.
 * The round-trip sensor deletes, and only ever its own messages.
 */
export const mailPop3: SensorType = {
  id: 'mail.pop3',
  category: 'Mail',
  costHint: 'light',
  credentialKinds: ['mail'],
  // Where the set goes besides the host (`A-41`): a port, and whether it is encrypted and checked.
  secretDestinations: { 'kind:mail': ['port', 'security', 'verifyTls'] },

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...MAIL_TRANSPORT_SCHEMA,
      port: {
        type: 'integer',
        minimum: 0,
        maximum: 65_535,
        default: 0,
        title: 'Port',
        description: 'Zero uses 110 for none/starttls and 995 for implicit TLS.',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [
      // First and primary. A mailbox nobody is collecting is the fault this sensor finds, and it
      // is invisible to anything that only measures whether the server answered.
      { key: 'messages', name: 'Messages waiting', unit: '', isPrimary: true },
      { key: 'mailboxSize', name: 'Mailbox size', unit: 'B' },
      { key: 'loginTime', name: 'Login time', unit: 'ms' },
      { key: 'totalTime', name: 'Total time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { Pop3Session } = await import('../support/mail/pop3.js');
    const { readCredential, readTransport, securityNote } =
      await import('../support/mail/schema.js');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to connect to');
    const transport = readTransport(context.params, host, context.target.ipVersion, {
      plain: 110,
      tls: 995,
    });
    const { username, password } = readCredential(context.credentials);
    if (username === '') {
      throw new Error(
        'no mail credential is configured on this device or anything above it, and a mailbox ' +
          'cannot be opened without one',
      );
    }

    const started = process.hrtime.bigint();
    const session = await Pop3Session.open(transport, context.signal);
    try {
      await session.login(username, password);
      const loggedInAt = process.hrtime.bigint();
      const { count, bytes } = await session.stat();
      await session.quit();

      const total = ms(started, process.hrtime.bigint());
      return {
        channels: [
          { key: 'messages', value: count },
          { key: 'mailboxSize', value: bytes },
          { key: 'loginTime', value: ms(started, loggedInAt) },
          { key: 'totalTime', value: total },
        ],
        message: [
          `${String(count)} message${count === 1 ? '' : 's'} waiting (${String(bytes)} bytes) ` +
            `in ${String(total)} ms`,
          ...securityNote(transport.security, transport.verifyTls),
        ].join('; '),
      };
    } catch (error) {
      session.close();
      throw error;
    }
  },
};

const ms = (from: bigint, to: bigint): number => Math.round(Number(to - from) / 1e3) / 1e3;
