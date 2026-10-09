import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { MAIL_TRANSPORT_SCHEMA } from '../support/mail/schema.js';

/**
 * Whether a mailbox can be opened, how full it is, and how much of it is unread (`T-17`).
 *
 * **Unseen is the channel POP3 cannot offer**, and it is usually the one worth alarming on: a
 * shared mailbox that support is working through has messages and no backlog, while the same
 * mailbox with 900 unseen has been abandoned. The count alone cannot tell those apart.
 *
 * **`STATUS`, not `SELECT`.** RFC 3501 §6.3.10 exists precisely so a client can ask for counts
 * without opening the mailbox — selecting it clears `\Recent` on the messages inside, so a
 * monitoring check running every minute would quietly change the state of somebody's mailbox as
 * a side effect of looking at it.
 */
export const mailImap: SensorType = {
  id: 'mail.imap',
  category: 'Mail',
  costHint: 'light',
  credentialKinds: ['mail'],
  pinnedKinds: ['mail'],
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
        description: 'Zero uses 143 for none/starttls and 993 for implicit TLS.',
      },
      mailbox: {
        type: 'string',
        maxLength: 255,
        default: 'INBOX',
        title: 'Mailbox',
        description: 'INBOX unless you are watching a folder something files into.',
      },
    },
  },

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(): readonly ChannelDef[] {
    return [
      // Unseen first: a mailbox somebody is working through has messages and no backlog, and the
      // same mailbox abandoned has 900 unread. The total cannot tell those apart.
      { key: 'unseen', name: 'Unread', unit: '', isPrimary: true },
      { key: 'messages', name: 'Messages', unit: '' },
      { key: 'recent', name: 'Recent', unit: '' },
      { key: 'loginTime', name: 'Login time', unit: 'ms' },
      { key: 'totalTime', name: 'Total time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { ImapSession } = await import('../support/mail/imap.js');
    const { readCredential, readTransport, securityNote } =
      await import('../support/mail/schema.js');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to connect to');
    const transport = readTransport(context.params, context.target, {
      plain: 143,
      tls: 993,
    });
    const { username, password } = readCredential(context.credentials);
    if (username === '') {
      throw new Error(
        'no mail credential is configured on this device or anything above it, and a mailbox ' +
          'cannot be opened without one',
      );
    }
    const mailbox = text(context.params, 'mailbox', 'INBOX');

    const started = process.hrtime.bigint();
    const session = await ImapSession.open(transport, context.signal);
    try {
      await session.login(username, password);
      const loggedInAt = process.hrtime.bigint();
      const status = await session.status(mailbox);
      await session.logout();

      const total = ms(started, process.hrtime.bigint());
      return {
        channels: [
          { key: 'unseen', value: status.unseen },
          { key: 'messages', value: status.messages },
          { key: 'recent', value: status.recent },
          { key: 'loginTime', value: ms(started, loggedInAt) },
          { key: 'totalTime', value: total },
        ],
        message: [
          `${mailbox}: ${String(status.messages)} message${status.messages === 1 ? '' : 's'}, ` +
            `${String(status.unseen)} unread, in ${String(total)} ms`,
          ...securityNote(transport.security, transport.verifyTls),
        ].join('; '),
      };
    } catch (error) {
      session.close();
      throw error;
    }
  },
};

/** A string parameter, or the fallback. `String(params[…])` would happily print [object Object]. */
function text(params: Readonly<Record<string, unknown>>, key: string, fallback = ''): string {
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

const ms = (from: bigint, to: bigint): number => Math.round(Number(to - from) / 1e3) / 1e3;
