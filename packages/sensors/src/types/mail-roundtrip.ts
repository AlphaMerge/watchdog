import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import type { MailConnectionOptions } from '../support/mail/connection.js';

/**
 * Send a message and wait for it to arrive (`T-17`).
 *
 * **The only mail check that measures the thing anybody actually cares about.** SMTP answering,
 * IMAP answering and a mailbox being reachable are three green sensors on a system where mail
 * has not moved for six hours — a queue that accepts and never delivers is *precisely* the
 * failure the other three cannot see, because every component is working and the pipeline is not.
 *
 * **The delivery time is the reading and it is not a response time.** It spans a queue run, a
 * content scanner, a greylist retry — seconds to minutes on a healthy system, and a trend that
 * quietly climbs from four seconds to ninety is the earliest warning a mail platform gives.
 *
 * **Cleanup is not optional and its failure is a check failure.** This sensor puts a message in
 * a real mailbox every scan; one that could not remove them again would add one a minute for
 * ever. It deletes only what it can prove is its own — a token generated per check, searched for
 * in the subject — and a mailbox that ends the check holding leftovers from earlier runs is
 * reported rather than ignored, because that is how a sensor tells you its cleanup has been
 * failing quietly.
 */

const TOKEN_PREFIX = 'ms-roundtrip';

export const mailRoundTrip: SensorType = {
  id: 'mail.roundtrip',
  category: 'Mail',
  // A send, then polling a mailbox until it arrives. The most expensive check in the catalogue.
  costHint: 'heavy',
  credentialKinds: ['mail'],

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['from', 'to'],
    properties: {
      from: {
        type: 'string',
        minLength: 3,
        maxLength: 320,
        title: 'Send from',
        description: 'An address the relay will accept as a sender.',
      },
      to: {
        type: 'string',
        minLength: 3,
        maxLength: 320,
        title: 'Send to',
        description:
          'The address of the mailbox read below. It must be a mailbox nothing else uses — this ' +
          'sensor deletes what it finds of its own, and a human reading the same inbox will ' +
          'watch messages appear and vanish.',
      },
      smtpPort: { type: 'integer', minimum: 0, maximum: 65_535, default: 0, title: 'SMTP port' },
      smtpSecurity: {
        enum: ['none', 'starttls', 'tls'],
        default: 'starttls',
        title: 'SMTP encryption',
      },
      smtpAuth: {
        type: 'boolean',
        default: false,
        title: 'Authenticate to the relay',
        description: 'Uses the mail credential on this device.',
      },
      readWith: {
        enum: ['imap', 'pop3'],
        default: 'imap',
        title: 'Read the mailbox with',
        description:
          'IMAP where there is a choice: it can search the server-side for this check’s own ' +
          'token, where POP3 has to read the headers of every message in the mailbox to find one.',
      },
      readPort: { type: 'integer', minimum: 0, maximum: 65_535, default: 0, title: 'Mailbox port' },
      readSecurity: {
        enum: ['none', 'starttls', 'tls'],
        default: 'starttls',
        title: 'Mailbox encryption',
      },
      mailbox: { type: 'string', maxLength: 255, default: 'INBOX', title: 'Mailbox (IMAP only)' },
      verifyTls: { type: 'boolean', default: true, title: 'Verify certificates' },
      timeoutMs: {
        type: 'integer',
        minimum: 1_000,
        maximum: 60_000,
        default: 20_000,
        title: 'Step timeout',
        description: 'For one step of one conversation, not for the delivery.',
      },
      deliveryTimeoutMs: {
        type: 'integer',
        minimum: 5_000,
        maximum: 900_000,
        default: 120_000,
        title: 'Give up waiting after',
        description:
          'How long delivery may take before this counts as a failure. Greylisting alone is ' +
          'commonly five minutes, so set this above whatever your platform’s slowest legitimate ' +
          'path is — and keep the scan interval well above it in turn.',
      },
      pollSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: 120,
        default: 5,
        title: 'Check the mailbox every',
        description:
          'Every poll is a login. Five seconds resolves a fast delivery well and does not make ' +
          'this sensor the busiest client on the mail server.',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [
      // Seconds to minutes on a healthy system, and a trend from four seconds to ninety is the
      // earliest warning a mail platform gives.
      { key: 'deliveryTime', name: 'Delivery time', unit: 'ms', isPrimary: true },
      { key: 'sendTime', name: 'Accepted by the relay in', unit: 'ms' },
      { key: 'polls', name: 'Mailbox checks', unit: '' },
      // Anything of this sensor's own left over from an earlier scan. Nonzero means the cleanup
      // has been failing, which is otherwise completely silent until the mailbox is full.
      { key: 'leftovers', name: 'Older test messages found', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { SmtpSession } = await import('../support/mail/smtp.js');
    const { readCredential, readTransport } = await import('../support/mail/schema.js');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to connect to');
    const from = text(context.params, 'from').trim();
    const to = text(context.params, 'to').trim();
    if (from === '' || to === '') throw new Error('this sensor needs a sender and a recipient');

    const credential = readCredential(context.credentials);
    const timeoutMs = Number(context.params['timeoutMs'] ?? 20_000);
    const deliveryTimeoutMs = Number(context.params['deliveryTimeoutMs'] ?? 120_000);
    const pollMs = Number(context.params['pollSeconds'] ?? 5) * 1_000;
    const readWith = context.params['readWith'] === 'pop3' ? 'pop3' : 'imap';
    const verifyTls = context.params['verifyTls'] !== false;

    // Unique per check, and the only thing that makes deleting safe: this sensor removes what
    // carries its own token and nothing else.
    const token = `${TOKEN_PREFIX}-${String(context.sensorId)}-${process.hrtime.bigint().toString(36)}`;
    const subject = `${token} monitoring round trip`;

    const smtp = readTransport(
      {
        port: context.params['smtpPort'],
        security: context.params['smtpSecurity'],
        verifyTls,
        timeoutMs,
      },
      host,
      context.target.ipVersion,
      { plain: 587, tls: 465 },
    );
    const read = readTransport(
      {
        port: context.params['readPort'],
        security: context.params['readSecurity'],
        verifyTls,
        timeoutMs,
      },
      host,
      context.target.ipVersion,
      readWith === 'pop3' ? { plain: 110, tls: 995 } : { plain: 143, tls: 993 },
    );

    const sendStarted = process.hrtime.bigint();
    const session = await SmtpSession.open(smtp, context.signal);
    try {
      if (context.params['smtpAuth'] === true) {
        if (credential.username === '') {
          throw new Error(
            'this sensor is set to authenticate to the relay but no mail credential is ' +
              'configured on this device or anything above it',
          );
        }
        await session.authenticate(credential.username, credential.password);
      }
      await session.send(from, to, body(from, to, subject, token, context.sensorId));
      await session.quit();
    } catch (error) {
      session.close();
      throw new Error(`the relay would not take the test message: ${describe(error)}`);
    }
    const sendTime = ms(sendStarted, process.hrtime.bigint());

    if (credential.username === '') {
      throw new Error(
        `the message was accepted by the relay in ${String(sendTime)} ms, but no mail credential ` +
          'is configured, so the mailbox it was sent to cannot be opened to see whether it arrived',
      );
    }

    const deadline = Date.now() + deliveryTimeoutMs;
    let polls = 0;
    for (;;) {
      polls += 1;
      const found =
        readWith === 'pop3'
          ? await collectPop3(read, credential, token, context.signal)
          : await collectImap(
              read,
              credential,
              token,
              text(context.params, 'mailbox', 'INBOX'),
              context.signal,
            );

      if (found.arrived) {
        const deliveryTime = ms(sendStarted, process.hrtime.bigint());
        return {
          channels: [
            { key: 'deliveryTime', value: deliveryTime },
            { key: 'sendTime', value: sendTime },
            { key: 'polls', value: polls },
            { key: 'leftovers', value: found.leftovers },
          ],
          message:
            `delivered in ${String(Math.round(deliveryTime))} ms after ` +
            `${String(polls)} mailbox check${polls === 1 ? '' : 's'}` +
            (found.leftovers === 0
              ? ''
              : `; ${String(found.leftovers)} test message${found.leftovers === 1 ? '' : 's'} ` +
                'from earlier scans were still there and have been removed — this sensor’s ' +
                'cleanup has been failing'),
        };
      }

      if (Date.now() >= deadline) {
        // Never a zero and never a gap: this is a hard failure, because the pipeline did not
        // deliver and there is no reading of "how long it took" for a message that never came.
        throw new Error(
          `the relay accepted the message in ${String(sendTime)} ms and it had not arrived in ` +
            `${to} after ${String(Math.round(deliveryTimeoutMs / 1_000))} s and ` +
            `${String(polls)} mailbox checks — mail is being accepted and not delivered`,
        );
      }
      if (context.signal.aborted) {
        throw new Error('the check was cancelled while waiting for the message to arrive');
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), context.signal);
    }
  },
};

interface Found {
  readonly arrived: boolean;
  /** This sensor's messages from *earlier* scans, which should never exist. */
  readonly leftovers: number;
}

/**
 * IMAP: search the server for this check's token, and delete everything of ours.
 *
 * The search is what makes IMAP the better half of this sensor — the server finds the message,
 * where POP3 makes the client read every mailbox header to do the same job.
 */
async function collectImap(
  transport: MailConnectionOptions,
  credential: { username: string; password: string },
  token: string,
  mailbox: string,
  signal: AbortSignal,
): Promise<Found> {
  const { ImapSession } = await import('../support/mail/imap.js');
  const session = await ImapSession.open(transport, signal);
  try {
    await session.login(credential.username, credential.password);
    await session.select(mailbox);
    const mine = await session.search(`HEADER Subject "${TOKEN_PREFIX}-"`);
    const ours = await session.search(`HEADER Subject "${token}"`);
    const arrived = ours.length > 0;
    // Everything with the prefix goes, not just this check's: a leftover is by definition a
    // message an earlier scan failed to remove, and leaving it would mean it is counted for ever.
    await session.deleteMessages(mine);
    await session.logout();
    return { arrived, leftovers: Math.max(0, mine.length - ours.length) };
  } catch (error) {
    session.close();
    throw error;
  }
}

/** POP3: read the headers of each message, because there is no server-side search. */
async function collectPop3(
  transport: MailConnectionOptions,
  credential: { username: string; password: string },
  token: string,
  signal: AbortSignal,
): Promise<Found> {
  const { Pop3Session } = await import('../support/mail/pop3.js');
  const session = await Pop3Session.open(transport, signal);
  try {
    await session.login(credential.username, credential.password);
    const messages = await session.list();
    let arrived = false;
    let leftovers = 0;
    for (const message of messages) {
      const headers = await session.headers(message.number);
      const subject = headers.find((line) => /^subject:/i.test(line)) ?? '';
      if (!subject.includes(TOKEN_PREFIX)) continue;
      if (subject.includes(token)) arrived = true;
      else leftovers += 1;
      await session.markDeleted(message.number);
    }
    // Only `QUIT` makes a `DELE` real — RFC 1939 §6 — so this is the line that actually cleans up.
    await session.quit();
    return { arrived, leftovers };
  } catch (error) {
    session.close();
    throw error;
  }
}

function body(from: string, to: string, subject: string, token: string, sensorId: number): string {
  return [
    `From: <${from}>`,
    `To: <${to}>`,
    `Subject: ${oneLine(subject)}`,
    `Message-ID: <${token}@monitoring-system>`,
    // RFC 3834: do not send a vacation reply to this, which is how a test message becomes a loop.
    'Auto-Submitted: auto-generated',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Round-trip test from monitoring sensor ${String(sensorId)}. It is deleted automatically.`,
    '',
  ].join('\n');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

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

const ms = (from: bigint, to: bigint): number => Math.round(Number(to - from) / 1e3) / 1e3;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
