import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { connect } from 'node:net';
import { openSyslogReceiver, type ReceivedSyslog } from '../src/support/syslog/receiver.js';
import { drain } from '../src/support/syslog/receiver.js';
import { sendTcp, sendUdp } from '@ms/simulators';
import { parseSyslog, renderSyslog } from '../src/support/syslog/parse.js';
import { matches, readRules, syslogReceiver, SYSLOG_LISTENER } from '../src/types/syslog.js';
import type { CheckContext, CheckExecution, ReceivedNotification } from '../src/contract.js';

/**
 * The syslog parser, the framings and the sensor.
 *
 * Real lines from real senders, because that is where a syslog receiver goes wrong: the format
 * an RFC describes and the format a 2014 switch emits are related but not the same, and a parser
 * tested only against its own output would pass while reading nothing on a real network.
 */

describe('RFC 5424', () => {
  it('reads the example from the RFC', () => {
    const message = parseSyslog(
      '<34>1 2003-10-11T22:14:15.003Z mymachine.example.com su - ID47 - ' +
        "'su root' failed for lonvick on /dev/pts/8",
    );
    assert.equal(message.format, '5424');
    assert.equal(message.facility, 4);
    assert.equal(message.facilityName, 'auth');
    assert.equal(message.severity, 2);
    assert.equal(message.severityName, 'critical');
    assert.equal(message.hostname, 'mymachine.example.com');
    assert.equal(message.appName, 'su');
    assert.equal(message.msgId, 'ID47');
    assert.equal(message.timestamp, '2003-10-11T22:14:15.003Z');
    assert.match(message.message, /failed for lonvick/);
  });

  it('reads structured data, flattened so a filter can name a field', () => {
    const message = parseSyslog(
      '<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 ' +
        '[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"] the message',
    );
    assert.equal(message.structured['exampleSDID@32473.iut'], '3');
    assert.equal(message.structured['exampleSDID@32473.eventSource'], 'Application');
    assert.equal(message.message, 'the message');
  });

  it('unescapes a structured value and is not fooled by a bracket inside one', () => {
    // §6.3.3: `"`, `]` and `\` are escaped. A closing bracket inside a quoted value would end the
    // element early for a naive scan, and everything after it would land in the message.
    const message = parseSyslog(
      '<13>1 2026-08-27T10:00:00Z host app - - [x@1 path="C:\\\\logs\\]" note="say \\"hi\\""] body',
    );
    assert.equal(message.structured['x@1.path'], 'C:\\logs]');
    assert.equal(message.structured['x@1.note'], 'say "hi"');
    assert.equal(message.message, 'body');
  });

  it('reads NIL as absent rather than as a hyphen', () => {
    const message = parseSyslog('<13>1 - - - - - - nothing but a body');
    assert.equal(message.hostname, '');
    assert.equal(message.appName, '');
    assert.equal(message.timestamp, null);
    assert.equal(message.message, 'nothing but a body');
  });
});

describe('RFC 3164', () => {
  it('reads what a switch bought in 2014 still sends', () => {
    const message = parseSyslog('<34>Oct 11 22:14:15 mymachine su: failed for lonvick');
    assert.equal(message.format, '3164');
    assert.equal(message.hostname, 'mymachine');
    assert.equal(message.appName, 'su');
    assert.equal(message.message, 'failed for lonvick');
  });

  it('splits the tag from the pid, which is what makes either filterable', () => {
    // RFC 3164 §4.1.3: the tag ends at the first non-alphanumeric. Without this, `sshd[1234]` is
    // one field nobody can write a rule against.
    const message = parseSyslog('<38>Aug 27 09:15:00 gw sshd[1234]: Failed password for root');
    assert.equal(message.appName, 'sshd');
    assert.equal(message.procId, '1234');
    assert.equal(message.message, 'Failed password for root');
  });

  it('guesses a December message arriving in January as last year, not next', () => {
    // A year in the future is a line nothing looking at a time range will ever find again.
    const message = parseSyslog('<13>Dec 31 23:59:00 host app: nearly midnight');
    assert.ok(message.timestamp !== null);
    const stamped = new Date(message.timestamp);
    assert.ok(
      stamped.getTime() - Date.now() < 86_400_000,
      `it stamped ${message.timestamp}, which is in the future`,
    );
  });
});

describe('malformed input', () => {
  it('keeps a line with no priority rather than dropping it', () => {
    // The devices that emit malformed syslog are disproportionately the ones going wrong.
    const message = parseSyslog('something went wrong and nobody framed it');
    assert.equal(message.format, 'raw');
    assert.equal(message.message, 'something went wrong and nobody framed it');
    assert.equal(message.severityName, 'notice');
  });

  it('keeps a priority it cannot make a header out of', () => {
    const message = parseSyslog('<13>this is not a header at all');
    assert.equal(message.format, 'raw');
    assert.equal(message.facilityName, 'user');
    assert.equal(message.message, 'this is not a header at all');
  });

  it('refuses to read a priority above 191 as one', () => {
    assert.equal(parseSyslog('<999>whatever').format, 'raw');
  });
});

describe('TCP framing (RFC 6587)', () => {
  const collect = (buffer: string): { rest: string; messages: ReceivedSyslog[]; bad: string[] } => {
    const messages: ReceivedSyslog[] = [];
    const bad: string[] = [];
    const rest = drain(buffer, '10.0.0.1', {
      onMessage: (one) => messages.push(one),
      onMalformed: (reason) => bad.push(reason),
    });
    return { rest, messages, bad };
  };

  it('reads octet-counted frames, §3.4.1', () => {
    const one = '<34>1 2026-08-27T10:00:00Z a b - - - first';
    const two = '<34>1 2026-08-27T10:00:01Z a b - - - second';
    const { rest, messages } = collect(`${String(one.length)} ${one}${String(two.length)} ${two}`);
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((one) => one.message.message),
      ['first', 'second'],
    );
    assert.equal(rest, '');
  });

  it('holds a partial octet-counted frame rather than reading half of it', () => {
    // Guessing wrong here turns one message into several with the count glued to the front,
    // which is the kind of corruption that gets blamed on the sender for weeks.
    const { rest, messages } = collect('40 <34>1 2026-08-27T10:00:00Z a b');
    assert.equal(messages.length, 0);
    assert.equal(rest, '40 <34>1 2026-08-27T10:00:00Z a b');
  });

  it('reads newline-separated frames, §3.4.2', () => {
    const { rest, messages } = collect('<13>one\n<13>two\r\n<13>partial');
    assert.equal(messages.length, 2);
    assert.equal(rest, '<13>partial');
  });

  it('ignores blank lines a device pads its stream with', () => {
    const { messages } = collect('\n\n<13>real\n\n');
    assert.equal(messages.length, 1);
  });
});

/**
 * A receiver on UDP and TCP at once, on whatever port is free.
 *
 * Port 0 is not usable here: UDP and TCP must be the same port, which is what a syslog receiver
 * is. Bound in a retry loop instead, because a fixed port can be taken. `offset` keeps two
 * receivers in one run off each other's candidates.
 */
async function openOnFreePort(
  handlers: Pick<Parameters<typeof openSyslogReceiver>[0], 'onMessage' | 'onMalformed'>,
  offset = 0,
): Promise<{ receiver: Awaited<ReturnType<typeof openSyslogReceiver>>; port: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 20_000 + offset + Math.floor(attempt * 37 + (process.pid % 500));
    try {
      const receiver = await openSyslogReceiver({
        port: candidate,
        address: '127.0.0.1',
        udp: true,
        tcp: true,
        ipVersion: 'udp4',
        ...handlers,
      });
      return { receiver, port: candidate };
    } catch {
      // Taken. Try the next.
    }
  }
  throw new Error('could not bind a syslog port for the test');
}

describe('the sockets', () => {
  let receiver: Awaited<ReturnType<typeof openSyslogReceiver>>;
  let port = 0;
  const seen: ReceivedSyslog[] = [];

  before(async () => {
    ({ receiver, port } = await openOnFreePort({
      onMessage: (one) => seen.push(one),
      onMalformed: () => undefined,
    }));
  });

  after(async () => {
    await receiver.close();
  });

  it('receives over UDP', async () => {
    seen.length = 0;
    await sendUdp(port, [
      {
        format: 'rfc3164',
        facility: 4,
        severity: 6,
        hostname: 'gw',
        tag: 'sshd[1]',
        message: 'over udp',
        timestamp: new Date('2026-08-27T09:15:00Z'),
      },
    ]);
    await until(() => seen.length === 1);
    assert.deepEqual(
      seen.map((one) => [one.transport, one.message.message]),
      [['udp', 'over udp']],
    );
  });

  it('receives over TCP, and takes a last line with no newline on close', async () => {
    // A device that writes one line and hangs up is common enough to matter, and discarding it
    // would lose exactly the message somebody sent by hand to test the receiver.
    seen.length = 0;
    await new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.end('<13>Aug 27 09:15:00 gw app: over tcp with no newline', () => {
          resolve();
        });
      });
    });
    await until(() => seen.length === 1);
    assert.deepEqual(
      seen.map((one) => [one.transport, one.message.message]),
      [['tcp', 'over tcp with no newline']],
    );
  });

  it('reads both of RFC 6587’s TCP framings off one connection', async () => {
    // **Reachable because `P-06`'s sender can produce both.** Guessing the framing wrong is not
    // a parse error — it silently corrupts message boundaries, and the sender gets blamed for
    // weeks. Three messages down one connection is what makes a boundary bug visible at all.
    for (const framing of ['octet-counting', 'non-transparent'] as const) {
      seen.length = 0;
      await sendTcp(port, [{ message: 'one' }, { message: 'two' }, { message: 'three' }], {
        framing,
      });
      await until(() => seen.length === 3);
      assert.deepEqual(
        seen.map((one) => one.message.message),
        ['one', 'two', 'three'],
        `${framing} lost a boundary`,
      );
    }
  });

  it('reassembles a frame that arrived in two pieces', async () => {
    // TCP is a stream: a receiver that assumes one `data` event is one message works perfectly
    // until the network disagrees. The sender's `splitAt` makes that day reproducible, and the
    // pause between the halves is what stops the two writes being coalesced into one segment.
    seen.length = 0;
    await sendTcp(port, [{ message: 'a message split down the middle' }], {
      framing: 'non-transparent',
      splitAt: 20,
    });
    await until(() => seen.length === 1);
    assert.equal(seen[0]?.message.message, 'a message split down the middle');
  });
});

describe('a handler that throws (P-217)', () => {
  // `dgram` and `net` call the receiver's handlers from their own event loops, so a throw in one
  // was an `uncaughtException`: the probe down, with every check it was running, for one message
  // from anything that can reach the port. Now it costs that message — and, on TCP, that sender's
  // connection, because where its next frame starts is no longer known.
  let receiver: Awaited<ReturnType<typeof openSyslogReceiver>>;
  let port = 0;
  const seen: string[] = [];
  const malformed: string[] = [];

  before(async () => {
    ({ receiver, port } = await openOnFreePort(
      {
        onMessage: (one) => {
          if (one.message.message.includes('boom')) throw new Error('a defect downstream');
          seen.push(`${one.transport}:${one.message.message}`);
        },
        onMalformed: (reason) => malformed.push(reason),
      },
      1_000,
    ));
  });

  after(async () => {
    await receiver.close();
  });

  it('reports a throw on UDP and reads the next datagram', async () => {
    seen.length = 0;
    malformed.length = 0;
    await sendUdp(port, [{ message: 'boom' }, { message: 'and the next one is still read' }]);
    await until(() => seen.length === 1);
    assert.deepEqual(malformed, ['handling a message threw: a defect downstream']);
    assert.deepEqual(seen, ['udp:and the next one is still read']);
  });

  it('closes only the TCP connection that threw', async () => {
    seen.length = 0;
    malformed.length = 0;
    await sendTcp(port, [{ message: 'boom' }], { framing: 'non-transparent' });
    await until(() => malformed.length === 1);
    assert.deepEqual(malformed, ['handling a message threw: a defect downstream']);

    await sendTcp(port, [{ message: 'a new connection is read' }], {
      framing: 'non-transparent',
    });
    await until(() => seen.length === 1);
    assert.deepEqual(seen, ['tcp:a new connection is read']);
  });
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A notification exactly as the probe's listener builds one. */
function notification(
  over: Partial<{
    source: string;
    severity: number;
    severityName: string;
    message: string;
    appName: string;
    hostname: string;
    structured: Record<string, string>;
  }> = {},
): ReceivedNotification {
  const parsed = parseSyslog(
    `<${String(8 + (over.severity ?? 3))}>Aug 27 09:15:00 ${over.hostname ?? 'gw'} ` +
      `${over.appName ?? 'sshd'}[1]: ${over.message ?? 'Failed password for root'}`,
  );
  return {
    at: '2026-08-27T09:15:00.000Z',
    source: over.source ?? 'device.example.invalid',
    text: renderSyslog(over.source ?? 'device.example.invalid', parsed),
    detail: {
      ...parsed,
      severity: over.severity ?? 3,
      severityName: over.severityName ?? 'error',
      structured: over.structured ?? {},
    },
  };
}

function run(
  params: Record<string, unknown>,
  items: ReceivedNotification[],
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return syslogReceiver.execute({
    sensorId: 1,
    target: { host: 'device.example.invalid', ipVersion: 'auto' },
    params,
    credentials: {},
    signal: new AbortController().signal,
    received: {
      listener: SYSLOG_LISTENER,
      items,
      dropped: 0,
      since: '2026-08-27T09:14:00.000Z',
      until: '2026-08-27T09:15:00.000Z',
    },
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('syslog.receiver', () => {
  it('counts by severity, which is what a limit is actually set on', async () => {
    // A single count goes Down on a busy night and Up on a quiet one. "More than five errors a
    // minute" is the thing an operator means.
    const execution = await run({}, [
      notification({ severity: 3, severityName: 'error' }),
      notification({ severity: 3, severityName: 'error' }),
      notification({ severity: 6, severityName: 'informational' }),
    ]);
    assert.equal(valueOf(execution, 'messages'), 3);
    assert.equal(valueOf(execution, 'error'), 2);
    assert.equal(valueOf(execution, 'informational'), 1);
    assert.equal(valueOf(execution, 'critical'), 0);
  });

  it('ignores anything less severe than the floor', async () => {
    // Asserted per severity, not on the total: "keep the severe ones" and "keep the mild ones"
    // both yield two out of three here, and only the breakdown tells them apart.
    const execution = await run({ minSeverity: 'warning' }, [
      notification({ severity: 2, severityName: 'critical' }),
      notification({ severity: 4, severityName: 'warning' }),
      notification({ severity: 6, severityName: 'informational' }),
    ]);
    assert.equal(valueOf(execution, 'messages'), 2);
    assert.equal(valueOf(execution, 'critical'), 1);
    assert.equal(valueOf(execution, 'warning'), 1);
    assert.equal(valueOf(execution, 'informational'), 0);
  });

  it('requires every rule, not any of them', async () => {
    // If this meant "or", adding a second rule would widen the sensor, which is the opposite of
    // what anybody typing one intends.
    const items = [
      notification({ appName: 'sshd', message: 'Failed password for root' }),
      notification({ appName: 'sshd', message: 'Accepted password for ops' }),
      notification({ appName: 'cron', message: 'Failed to run job' }),
    ];
    const execution = await run(
      {
        match: [
          { field: 'appName', equals: 'sshd' },
          { field: 'message', contains: 'failed' },
        ],
      },
      items,
    );
    assert.equal(valueOf(execution, 'messages'), 1);
  });

  it('matches on structured data by its flattened name', async () => {
    const execution = await run({ match: [{ field: 'structured.x@1.iut', equals: '3' }] }, [
      notification({ structured: { 'x@1.iut': '3' } }),
      notification({ structured: { 'x@1.iut': '9' } }),
      notification({}),
    ]);
    assert.equal(valueOf(execution, 'messages'), 1);
  });

  it('counts only this device by default, and everything when told to', async () => {
    // A relay forwards other hosts' messages under its own address, so "which host said this"
    // and "which host sent it to us" are different questions.
    const items = [
      notification({ source: 'device.example.invalid' }),
      notification({ source: '10.0.0.9' }),
    ];
    assert.equal(valueOf(await run({}, items), 'messages'), 1);
    assert.equal(valueOf(await run({ sourceIsDevice: false }, items), 'messages'), 2);
    assert.equal(valueOf(await run({ sourceIsDevice: false }, items), 'senders'), 2);
  });

  it('shows the last few matching lines, bounded', async () => {
    const execution = await run({ retain: 2 }, [
      notification({ message: 'one' }),
      notification({ message: 'two' }),
      notification({ message: 'three' }),
    ]);
    assert.match(execution.message ?? '', /two.*three/s);
    assert.ok(!(execution.message ?? '').includes(': one'), execution.message);
  });

  it('fails rather than reporting zero when the listener is not running', async () => {
    // A receiver that was never switched on must not look like a quiet network.
    await assert.rejects(
      () =>
        syslogReceiver.execute({
          sensorId: 1,
          target: { host: 'device.example.invalid', ipVersion: 'auto' },
          params: {},
          credentials: {},
          signal: new AbortController().signal,
        }),
      /syslog listener is not running/,
    );
  });

  it('fails rather than undercounting when the buffer wrapped', async () => {
    await assert.rejects(
      () =>
        run({}, [], {
          received: {
            listener: SYSLOG_LISTENER,
            items: [],
            dropped: 412,
            since: '2026-08-27T09:14:00.000Z',
            until: '2026-08-27T09:15:00.000Z',
          },
        }),
      /412 messages were overwritten/,
    );
  });

  it('reports zero when the network really was quiet', async () => {
    // The distinction the whole sensor turns on: nothing arrived is a reading; nothing was
    // listening is not.
    const execution = await run({}, []);
    assert.equal(valueOf(execution, 'messages'), 0);
    assert.match(execution.message ?? '', /0 messages since/);
  });
});

describe('rules', () => {
  it('drops a rule that asks for nothing', () => {
    assert.equal(readRules({ match: [{ field: 'message' }] }).length, 0);
  });

  it('defaults an unnamed field to the message', () => {
    assert.equal(readRules({ match: [{ contains: 'x' }] })[0]?.field, 'message');
  });

  it('matches everything when there are no rules', () => {
    assert.ok(matches(notification({}), []));
  });
});
