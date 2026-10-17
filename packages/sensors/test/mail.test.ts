import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { mailImap } from '../src/types/mail-imap.js';
import { mailPop3 } from '../src/types/mail-pop3.js';
import { mailRoundTrip } from '../src/types/mail-roundtrip.js';
import { mailSmtp } from '../src/types/mail-smtp.js';
import { Mailbox, imapServer, pop3Server, smtpServer, type RunningServer } from '@ms/simulators';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';
import { assertDeclaresEveryKey } from './support/declared-keys.js';
import { failedIn, rejectionOf } from './support/failed-in.js';

/**
 * The four mail sensors against the in-house simulators.
 *
 * What is worth asserting is not that a healthy server works — it is what happens when a relay
 * accepts a connection and then refuses at `RCPT TO`, when a server does not offer `STARTTLS`,
 * and when `QUIT` fails so a deletion never actually happened. None of that is reachable against
 * a real server behaving normally, which is why the simulators exist.
 */

const CREDENTIAL = { mail: { username: 'ops', password: 'hunter2' } };
const mailbox = new Mailbox();
const running: RunningServer[] = [];
let certificate: { key: string; cert: string } | undefined;
let dir = '';
// The certificate below is trusted for as long as this file runs, so that a case can verify it
// (`A-71`). Absent on a Node that cannot be told to trust one, and then that case skips.
const setTrusted = (tls as { setDefaultCACertificates?: (certs: string[]) => void })
  .setDefaultCACertificates;
const getTrusted = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
let trustedBefore: string[] | undefined;

before(() => {
  try {
    dir = mkdtempSync(join(tmpdir(), 'ms-mail-'));
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'k.pem'),
      '-out',
      join(dir, 'c.pem'),
      '-days',
      '30',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    certificate = {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
    };
  } catch {
    certificate = undefined;
  }
  if (certificate !== undefined && setTrusted !== undefined && getTrusted !== undefined) {
    trustedBefore = getTrusted('default');
    setTrusted([...trustedBefore, certificate.cert]);
  }
});

after(async () => {
  if (trustedBefore !== undefined && setTrusted !== undefined) setTrusted(trustedBefore);
  for (const server of running) await server.close();
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mailbox.reset();
});

async function start(
  make: (options: Parameters<typeof smtpServer>[0]) => Promise<RunningServer>,
  options: Partial<Parameters<typeof smtpServer>[0]> = {},
): Promise<number> {
  const server = await make({ mailbox, username: 'ops', password: 'hunter2', ...options });
  running.push(server);
  return server.port;
}

function run(
  type: SensorType,
  params: Record<string, unknown>,
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return type.execute({
    sensorId: 7,
    target: { host: '127.0.0.1', ipVersion: 'v4' },
    params: { security: 'none', timeoutMs: 5_000, ...params },
    credentials: CREDENTIAL,
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('mail.smtp', () => {
  it('greets and reports the greeting separately from the total', async () => {
    // The greeting is where reverse-DNS and RBL checks happen: a relay under load answers the
    // handshake instantly and 220 slowly, and one "response time" hides exactly that.
    const port = await start(smtpServer);
    const execution = await run(mailSmtp, { port });
    assert.ok((valueOf(execution, 'greetingTime') ?? -1) >= 0);
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= (valueOf(execution, 'greetingTime') ?? 0));
    assert.equal(valueOf(execution, 'sendTime'), undefined, 'no message was asked for');
    assert.match(execution.message ?? '', /greeted in/);
  });

  it('actually puts a message through when given an address', async () => {
    // The difference between "the relay answers" and "the relay delivers".
    const port = await start(smtpServer);
    const execution = await run(mailSmtp, {
      port,
      from: 'a@example.invalid',
      to: 'b@example.invalid',
    });
    assert.ok((valueOf(execution, 'sendTime') ?? -1) >= 0);
    assert.equal(mailbox.live.length, 1);
    // The acceptance line carries the queue id, which is what makes a message traceable in the
    // relay's own log when somebody asks where it went.
    assert.match(execution.message ?? '', /delivered in .*accepted: .*queued as SIM12345/s);
  });

  it('catches a relay that accepts a connection and refuses the mail', async () => {
    // A queue that has filled up answers 452 at MAIL FROM, and a Port sensor calls that healthy.
    const port = await start(smtpServer, { refuseAt: 'mail-from' });
    await assert.rejects(
      () => run(mailSmtp, { port, from: 'a@example.invalid', to: 'b@example.invalid' }),
      /the sender a@example.invalid was refused: 452/,
    );
  });

  it('names the recipient when it is the recipient that was refused', async () => {
    const port = await start(smtpServer, { refuseAt: 'rcpt-to' });
    await assert.rejects(
      () => run(mailSmtp, { port, from: 'a@example.invalid', to: 'b@example.invalid' }),
      /the recipient b@example.invalid was refused: 550/,
    );
  });

  it('refuses to continue in the clear when STARTTLS was required and is not offered', async () => {
    // A sensor that downgraded silently would report a healthy relay while sending the password
    // in plain text.
    const port = await start(smtpServer, { offerStartTls: false });
    await assert.rejects(
      () => run(mailSmtp, { port, security: 'starttls' }),
      /does not offer STARTTLS, and this sensor was told to require it/,
    );
  });

  it('upgrades in place when STARTTLS is offered', async (t) => {
    if (certificate === undefined) {
      t.skip('openssl is not on this machine');
      return;
    }
    if (trustedBefore === undefined) {
      t.skip('this Node has no tls.setDefaultCACertificates to trust a test certificate with');
      return;
    }
    // Verified (`A-71`). This case turned verification off, under a certificate that lists the
    // very address it connects to, because the upgrade used to check a device given by address
    // against the name `localhost` (`A-67` fixed that) and no certificate for an address passed.
    const port = await start(smtpServer, { offerStartTls: true, tls: certificate });
    const execution = await run(mailSmtp, {
      port,
      security: 'starttls',
      verifyTls: true,
      requireAuth: true,
    });
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= 0);
    assert.doesNotMatch(execution.message ?? '', /not being verified/);
  });

  it('upgrades without verifying when told to, and says so on every scan', async (t) => {
    if (certificate === undefined) {
      t.skip('openssl is not on this machine');
      return;
    }
    // A certificate nothing trusts and that lists another address: only an unverified upgrade
    // gets through it, and the same one is refused the moment verification is on.
    const other = join(dir, 'other');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${other}.key`,
        '-out',
        `${other}.crt`,
        '-days',
        '30',
        '-subj',
        '/CN=127.0.0.2',
        '-addext',
        'subjectAltName=IP:127.0.0.2',
      ],
      { stdio: 'ignore' },
    );
    const untrusted = {
      key: readFileSync(`${other}.key`, 'utf8'),
      cert: readFileSync(`${other}.crt`, 'utf8'),
    };
    const port = await start(smtpServer, { offerStartTls: true, tls: untrusted });
    const params = { port, security: 'starttls', requireAuth: true };
    const execution = await run(mailSmtp, { ...params, verifyTls: false });
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= 0);
    // Said on every scan rather than once at configuration time.
    assert.match(execution.message ?? '', /certificate is not being verified/);
    await assert.rejects(() => run(mailSmtp, { ...params, verifyTls: true }));
  });

  it('authenticates, and says so when it cannot', async () => {
    const port = await start(smtpServer);
    await run(mailSmtp, { port, requireAuth: true });
    await assert.rejects(
      () =>
        run(
          mailSmtp,
          { port, requireAuth: true },
          { credentials: { mail: { username: 'ops', password: 'wrong' } } },
        ),
      /authentication was refused: 535/,
    );
  });

  it('reports a relay that requires a login it was not told to make', async () => {
    // Not a fault of the network and not a fault of the relay: the sensor is configured wrongly,
    // and the 530 says so plainly enough to act on.
    const port = await start(smtpServer, { requireAuth: true });
    await assert.rejects(
      () => run(mailSmtp, { port, from: 'a@example.invalid', to: 'b@example.invalid' }),
      /was refused: 530 5\.7\.0 authentication required/,
    );
  });

  it('says which credential is missing rather than failing to authenticate later', async () => {
    const port = await start(smtpServer);
    await assert.rejects(
      () => run(mailSmtp, { port, requireAuth: true }, { credentials: {} }),
      /no mail credential is configured on this device or anything above it/,
    );
  });

  it('gives up on a server that accepts a connection and never speaks', async () => {
    const port = await start(smtpServer, { greetingDelayMs: 5_000 });
    await assert.rejects(
      () => run(mailSmtp, { port, timeoutMs: 1_000 }),
      /did not finish the greeting within 1000 ms \(it sent nothing at all\)/,
    );
  });

  it('refuses an address with a line break in it, which is command injection', async () => {
    // `MAIL FROM:<a@x\r\nRCPT TO:<victim>>` ends the command and lets what follows be read as
    // another one — and the address is a sensor parameter, so this is injection through a form.
    const port = await start(smtpServer);
    await assert.rejects(
      () =>
        run(mailSmtp, {
          port,
          from: 'a@example.invalid',
          to: 'b@example.invalid\r\nRCPT TO:<victim@example.invalid>',
        }),
      /the recipient address contains a line break/,
    );
  });

  it('folds a subject with a newline in it rather than injecting a header', async () => {
    // A subject is operator-supplied and goes straight into a header block. Folded rather than
    // refused: a stray newline is a typo in almost every case, and failing the check is the
    // wrong answer to a typo.
    const port = await start(smtpServer);
    await run(mailSmtp, {
      port,
      from: 'a@example.invalid',
      to: 'b@example.invalid',
      subject: 'nightly check\r\nBcc: somebody@else.invalid',
    });
    const raw = mailbox.live[0]?.raw ?? '';
    assert.ok(!/^bcc:/im.test(raw), `a header was injected:\n${raw}`);
    assert.match(raw, /^Subject: nightly check Bcc: somebody@else\.invalid$/m);
  });

  it('refuses a recipient with no sender, before opening anything', async () => {
    await assert.rejects(
      () => run(mailSmtp, { port: 1, to: 'b@example.invalid' }),
      /every message needs a MAIL FROM/,
    );
  });
});

describe('mail.pop3', () => {
  it('reports the mailbox depth, which is the reading that matters', async () => {
    // A POP3 server answering in four milliseconds with 40,000 messages waiting is a delivery
    // pipeline that stopped collecting a week ago.
    mailbox.deliver('Subject: one\n\nbody');
    mailbox.deliver('Subject: two\n\nbody');
    const port = await start(pop3Server);
    const execution = await run(mailPop3, { port });
    assert.equal(valueOf(execution, 'messages'), 2);
    assert.ok((valueOf(execution, 'mailboxSize') ?? 0) > 0);
    assert.match(execution.message ?? '', /2 messages waiting/);
  });

  it('makes the message count the channel the sensor is judged by', () => {
    assert.deepEqual(
      mailPop3
        .channels({})
        .filter((channel) => channel.isPrimary === true)
        .map((c) => c.key),
      ['messages'],
    );
  });

  it('deletes nothing, ever', async () => {
    mailbox.deliver('Subject: keep me\n\nbody');
    const port = await start(pop3Server);
    await run(mailPop3, { port });
    assert.equal(mailbox.live.length, 1, 'a look must never be a delete');
  });

  it('says which credential is missing', async () => {
    await assert.rejects(
      () => run(mailPop3, { port: 1 }, { credentials: {} }),
      /no mail credential is configured/,
    );
  });

  it('reports a refused password as a refused password', async () => {
    const port = await start(pop3Server);
    await assert.rejects(
      () => run(mailPop3, { port }, { credentials: { mail: { username: 'ops', password: 'no' } } }),
      /authentication was refused/,
    );
  });
});

describe('mail.imap', () => {
  it('reports unread separately from the total', async () => {
    // A shared mailbox somebody is working through has messages and no backlog; the same mailbox
    // abandoned has 900 unread, and the total cannot tell those apart.
    mailbox.deliver('Subject: one\n\nbody');
    const port = await start(imapServer);
    const execution = await run(mailImap, { port });
    assert.equal(valueOf(execution, 'messages'), 1);
    assert.equal(valueOf(execution, 'unseen'), 1);
    assert.deepEqual(
      mailImap
        .channels({})
        .filter((channel) => channel.isPrimary === true)
        .map((c) => c.key),
      ['unseen'],
    );
  });

  it('logs in with a password containing a quote', async () => {
    // IMAP quoting, and the case that otherwise produces a login failure nobody can explain.
    const port = await start(imapServer, { password: 'he said "no"' });
    const execution = await run(
      mailImap,
      { port },
      { credentials: { mail: { username: 'ops', password: 'he said "no"' } } },
    );
    assert.equal(valueOf(execution, 'messages'), 0);
  });

  it('refuses to continue in the clear when STARTTLS was required and is not offered', async () => {
    const port = await start(imapServer, { offerStartTls: false });
    await assert.rejects(
      () => run(mailImap, { port, security: 'starttls' }),
      /refused STARTTLS.*would send the password in plain text/s,
    );
  });
});

describe('mail.roundtrip', () => {
  it('sends a message and waits for it to arrive', async () => {
    const smtpPort = await start(smtpServer);
    const readPort = await start(imapServer);
    mailbox.deliverAfterMs = 300;

    const execution = await run(mailRoundTrip, {
      from: 'a@example.invalid',
      to: 'b@example.invalid',
      smtpPort,
      readPort,
      smtpSecurity: 'none',
      readSecurity: 'none',
      pollSeconds: 1,
      deliveryTimeoutMs: 10_000,
    });
    assert.ok((valueOf(execution, 'deliveryTime') ?? 0) >= 300, 'it waited for the delivery');
    assert.ok((valueOf(execution, 'polls') ?? 0) >= 1);
    assert.equal(valueOf(execution, 'leftovers'), 0);
    assert.match(execution.message ?? '', /delivered in \d+ ms after \d+ mailbox check/);
  });

  it('cleans up after itself, which is the whole reason it may touch a mailbox', async () => {
    const smtpPort = await start(smtpServer);
    const readPort = await start(imapServer);
    await run(mailRoundTrip, {
      from: 'a@example.invalid',
      to: 'b@example.invalid',
      smtpPort,
      readPort,
      smtpSecurity: 'none',
      readSecurity: 'none',
      deliveryTimeoutMs: 10_000,
    });
    assert.equal(mailbox.live.length, 0, 'a sensor that could not clean up adds a message a scan');
  });

  it('counts and removes what earlier scans left behind', async () => {
    // Nonzero here means the cleanup has been failing, which is otherwise completely silent
    // until the mailbox is full.
    mailbox.deliver('Subject: ms-roundtrip-7-oldone monitoring round trip\n\nbody');
    mailbox.deliver('Subject: ms-roundtrip-7-olderone monitoring round trip\n\nbody');
    mailbox.deliver('Subject: a real message\n\nbody');
    const smtpPort = await start(smtpServer);
    const readPort = await start(imapServer);

    const execution = await run(mailRoundTrip, {
      from: 'a@example.invalid',
      to: 'b@example.invalid',
      smtpPort,
      readPort,
      smtpSecurity: 'none',
      readSecurity: 'none',
      deliveryTimeoutMs: 10_000,
    });
    assert.equal(valueOf(execution, 'leftovers'), 2);
    assert.match(execution.message ?? '', /this sensor’s cleanup has been failing/);
    // Somebody else's mail is untouched. This sensor deletes only what carries its own token.
    assert.deepEqual(
      mailbox.live.map((message) => message.subject),
      ['a real message'],
    );
  });

  it('fails when mail is accepted and never delivered', async () => {
    // The failure the other three sensors cannot see: every component works and the pipeline
    // does not.
    const smtpPort = await start(smtpServer);
    const readPort = await start(imapServer);
    mailbox.deliverAfterMs = 60_000;

    await assert.rejects(
      () =>
        run(mailRoundTrip, {
          from: 'a@example.invalid',
          to: 'b@example.invalid',
          smtpPort,
          readPort,
          smtpSecurity: 'none',
          readSecurity: 'none',
          pollSeconds: 1,
          deliveryTimeoutMs: 5_000,
        }),
      /accepted the message in .* and it had not arrived in b@example.invalid after 5 s/s,
    );
  });

  it('works over POP3 too, where finding a message means reading every header', async () => {
    const smtpPort = await start(smtpServer);
    const readPort = await start(pop3Server);
    mailbox.deliver('Subject: somebody else\n\nbody');

    const execution = await run(mailRoundTrip, {
      from: 'a@example.invalid',
      to: 'b@example.invalid',
      readWith: 'pop3',
      smtpPort,
      readPort,
      smtpSecurity: 'none',
      readSecurity: 'none',
      deliveryTimeoutMs: 10_000,
    });
    assert.ok((valueOf(execution, 'deliveryTime') ?? -1) >= 0);
    assert.deepEqual(
      mailbox.live.map((message) => message.subject),
      ['somebody else'],
    );
  });

  it('notices when POP3 accepted the deletions and then refused to commit them', async () => {
    // RFC 1939 §6: DELE marks, QUIT deletes. A sensor that ignored a failed QUIT would report a
    // clean round trip while leaving its own message behind, once a minute, for ever.
    const smtpPort = await start(smtpServer);
    const readPort = await start(pop3Server, { refuseAt: 'quit' });

    await assert.rejects(
      () =>
        run(mailRoundTrip, {
          from: 'a@example.invalid',
          to: 'b@example.invalid',
          readWith: 'pop3',
          smtpPort,
          readPort,
          smtpSecurity: 'none',
          readSecurity: 'none',
          deliveryTimeoutMs: 5_000,
        }),
      /refused QUIT.*has not been deleted/s,
    );
  });

  it('notices when IMAP flagged the messages and then would not expunge them', async () => {
    const smtpPort = await start(smtpServer);
    const readPort = await start(imapServer, { refuseAt: 'quit' });

    await assert.rejects(
      () =>
        run(mailRoundTrip, {
          from: 'a@example.invalid',
          to: 'b@example.invalid',
          smtpPort,
          readPort,
          smtpSecurity: 'none',
          readSecurity: 'none',
          deliveryTimeoutMs: 5_000,
        }),
      /flagged but not removed.*fills a mailbox one message a minute/s,
    );
  });

  it('reports the relay’s own refusal as the relay’s, not as a delivery failure', async () => {
    const smtpPort = await start(smtpServer, { refuseAt: 'rcpt-to' });
    const readPort = await start(imapServer);
    await assert.rejects(
      () =>
        run(mailRoundTrip, {
          from: 'a@example.invalid',
          to: 'b@example.invalid',
          smtpPort,
          readPort,
          smtpSecurity: 'none',
          readSecurity: 'none',
        }),
      /the relay would not take the test message: the recipient .* was refused: 550/,
    );
  });
});

describe('where a mail check failed (P-406)', () => {
  const at = (phase: string): { phase: string; target: string } => ({
    phase,
    target: '127.0.0.1',
  });
  const wrong = { credentials: { mail: { username: 'ops', password: 'wrong' } } };
  const send = { from: 'a@example.invalid', to: 'b@example.invalid' };
  /** A raw server on 127.0.0.1, closed by `stop`, for what no simulator does. */
  const listen = (server: NetServer): Promise<number> =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  const stop = (server: NetServer): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });

  it('names the connection when nothing listens, the greeting is refused, or never comes', async () => {
    const refusing = await start(smtpServer, { refuseAt: 'greeting' });
    const silent = await start(smtpServer, { greetingDelayMs: 5_000 });
    for (const [params, words] of [
      [{ port: 1 }, /nothing is listening/],
      [{ port: refusing }, /greeted with 554/],
      [{ port: silent, timeoutMs: 1_000 }, /did not finish the greeting/],
    ] as const) {
      const error = await rejectionOf(() => run(mailSmtp, params));
      assert.match(String(error), words);
      assert.deepEqual(failedIn(error), at('connect'), String(error));
    }
  });

  it('names the handshake when STARTTLS was required and is not offered, in each protocol', async () => {
    for (const [type, make] of [
      [mailSmtp, smtpServer],
      [mailPop3, pop3Server],
      [mailImap, imapServer],
    ] as const) {
      const port = await start(make, { offerStartTls: false });
      const error = await rejectionOf(() => run(type, { port, security: 'starttls' }));
      assert.deepEqual(failedIn(error), at('handshake'), `${type.id}: ${String(error)}`);
    }
  });

  it('names the login when the password is refused, in each protocol', async () => {
    const smtp = await start(smtpServer);
    const pop3 = await start(pop3Server);
    const imap = await start(imapServer);
    for (const [type, params] of [
      [mailSmtp, { port: smtp, requireAuth: true }],
      [mailPop3, { port: pop3 }],
      [mailImap, { port: imap }],
    ] as const) {
      const error = await rejectionOf(() => run(type, params, wrong));
      assert.match(String(error), /authentication was refused/, type.id);
      assert.deepEqual(failedIn(error), at('authenticate'), `${type.id}: ${String(error)}`);
    }
  });

  it('names the step a reset came in, in the socket’s own words', async () => {
    // A POP3 server that greets, takes the user name, and resets the connection at the
    // password: no reply to read, only the socket's own error, while logging in.
    const resetting = createNetServer((socket) => {
      socket.on('error', () => undefined);
      socket.write('+OK ready\r\n');
      let said = '';
      socket.on('data', (chunk: Buffer) => {
        said += chunk.toString('latin1');
        if (/^PASS /m.test(said)) socket.resetAndDestroy();
        else if (said.endsWith('\r\n')) socket.write('+OK\r\n');
      });
    });
    const port = await listen(resetting);
    try {
      const error = await rejectionOf(() => run(mailPop3, { port }));
      assert.match(String(error), /ECONNRESET/);
      assert.deepEqual(failedIn(error), at('authenticate'), String(error));
    } finally {
      await stop(resetting);
    }
  });

  it('names the handshake over implicit TLS once connected, and the connection before', async () => {
    // A plain-text server where TLS was expected: it answers the client’s hello with a greeting.
    const plain = await start(smtpServer);
    const spoken = await rejectionOf(() => run(mailSmtp, { port: plain, security: 'tls' }));
    assert.deepEqual(failedIn(spoken), at('handshake'), String(spoken));

    // One that takes the connection and never answers: the handshake runs out of time, and a
    // cancel during it is the handshake as well.
    const silent = createNetServer((socket) => {
      socket.resume();
      socket.on('error', () => undefined);
    });
    const port = await listen(silent);
    try {
      const timedOut = await rejectionOf(() =>
        run(mailSmtp, { port, security: 'tls', timeoutMs: 1_000 }),
      );
      assert.match(String(timedOut), /did not complete a TLS handshake within 1000 ms/);
      assert.deepEqual(failedIn(timedOut), at('handshake'), String(timedOut));

      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 200);
      const cancelled = await rejectionOf(() =>
        run(mailSmtp, { port, security: 'tls' }, { signal: controller.signal }),
      );
      assert.match(String(cancelled), /cancelled during the TLS handshake/);
      assert.deepEqual(failedIn(cancelled), at('handshake'), String(cancelled));
    } finally {
      await stop(silent);
    }

    const refused = await rejectionOf(() => run(mailSmtp, { port: 1, security: 'tls' }));
    assert.deepEqual(failedIn(refused), at('connect'), String(refused));
  });

  it('names the sending when the relay refuses the message, and keeps it through the round trip', async () => {
    const port = await start(smtpServer, { refuseAt: 'rcpt-to' });
    const direct = await rejectionOf(() => run(mailSmtp, { port, ...send }));
    assert.deepEqual(failedIn(direct), at('send'), String(direct));

    const readPort = await start(imapServer);
    const round = await rejectionOf(() =>
      run(mailRoundTrip, {
        ...send,
        smtpPort: port,
        readPort,
        smtpSecurity: 'none',
        readSecurity: 'none',
      }),
    );
    assert.match(String(round), /the relay would not take the test message/);
    assert.deepEqual(failedIn(round), at('send'), String(round));
  });

  it('names the mailbox when its cleanup is refused, over IMAP and POP3', async () => {
    const smtpPort = await start(smtpServer);
    for (const [readWith, make] of [
      ['imap', imapServer],
      ['pop3', pop3Server],
    ] as const) {
      const readPort = await start(make, { refuseAt: 'quit' });
      const error = await rejectionOf(() =>
        run(mailRoundTrip, {
          ...send,
          readWith,
          smtpPort,
          readPort,
          smtpSecurity: 'none',
          readSecurity: 'none',
          deliveryTimeoutMs: 5_000,
        }),
      );
      assert.deepEqual(failedIn(error), at('query'), `${readWith}: ${String(error)}`);
    }
  });
});

describe('the keys the mailbox types report (P-320)', () => {
  it('are keys their declaration names for the same parameters', async () => {
    mailbox.deliver('Subject: one\n\nbody');
    const pop3 = { port: await start(pop3Server) };
    assertDeclaresEveryKey('mail.pop3', pop3, await run(mailPop3, pop3));
    const imap = { port: await start(imapServer), mailbox: 'INBOX' };
    assertDeclaresEveryKey('mail.imap', imap, await run(mailImap, imap));
    for (const [readWith, server] of [
      ['imap', imapServer],
      ['pop3', pop3Server],
    ] as const) {
      const params = {
        from: 'a@example.invalid',
        to: 'b@example.invalid',
        readWith,
        smtpPort: await start(smtpServer),
        readPort: await start(server),
        smtpSecurity: 'none',
        readSecurity: 'none',
        pollSeconds: 1,
        deliveryTimeoutMs: 10_000,
      };
      assertDeclaresEveryKey('mail.roundtrip', params, await run(mailRoundTrip, params));
    }
  });
});
