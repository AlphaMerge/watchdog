import { strict as assert } from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { close, listen } from '../src/net.js';
import { renderMessage, sendTcp, sendUdp } from '../src/syslog-sender.js';
import { pollWithin } from './support/within.js';

/**
 * The sender's own tests (`P-06`), asserting the **bytes**.
 *
 * That is the whole reason this sender renders its own messages rather than calling the parser's
 * renderer: what a syslog receiver has to get right is the wire format, and a harness that
 * produced its input with the code under test would prove only that the parser can read what the
 * renderer wrote — which passes whether or not either matches RFC 3164 or RFC 5424.
 */

describe('the syslog sender', () => {
  describe('what it renders', () => {
    it('writes an RFC 5424 message with a computed priority', () => {
      // auth.error is facility 4, severity 3, so priority 35. Getting this arithmetic wrong is
      // the single most common syslog bug, and it is invisible until somebody filters on it.
      const line = renderMessage({
        facility: 4,
        severity: 3,
        hostname: 'gw',
        tag: 'sshd',
        message: 'failed password',
        timestamp: new Date('2026-08-27T09:15:00Z'),
      });
      assert.match(line, /^<35>1 2026-08-27T09:15:00\.000Z gw sshd - - - failed password$/);
    });

    it('space-pads a single-digit day in RFC 3164, which is where a 5424 parser trips', () => {
      // `Mmm _d hh:mm:ss` — two spaces before a single-digit day. A parser written against 5424
      // alone splits on whitespace and reads the day as the hostname.
      const line = renderMessage({
        format: 'rfc3164',
        timestamp: new Date('2026-08-05T09:15:00Z'),
        hostname: 'gw',
        tag: 'app',
        message: 'hello',
      });
      assert.match(line, /^<14>Aug {2}5 09:15:00 gw app: hello$/);
    });

    it('does not pad a two-digit day', () => {
      const line = renderMessage({
        format: 'rfc3164',
        timestamp: new Date('2026-08-27T09:15:00Z'),
      });
      assert.match(line, /^<14>Aug 27 09:15:00 /);
    });
  });

  describe('over the wire', () => {
    const collectUdp = async (): Promise<{
      port: number;
      lines: string[];
      socket: UdpSocket;
    }> => {
      const lines: string[] = [];
      const socket = createSocket('udp4');
      socket.on('message', (data) => lines.push(data.toString('utf8')));
      const port = await new Promise<number>((resolve) => {
        socket.bind(0, '127.0.0.1', () => {
          resolve(socket.address().port);
        });
      });
      return { port, lines, socket };
    };

    /**
     * `ended` turns true when the sender's end of the connection arrives, which `sendTcp` sends
     * only after its last write: everything it sent, and anything it sent in excess, is in
     * `chunks` by then.
     */
    const collectTcp = async (): Promise<{
      port: number;
      chunks: string[];
      ended: () => boolean;
      server: Server;
    }> => {
      const chunks: string[] = [];
      let ended = false;
      const server = createServer((connection: Socket) => {
        connection.on('data', (data: Buffer) => chunks.push(data.toString('utf8')));
        connection.on('end', () => {
          ended = true;
        });
      });
      const port = await listen(server);
      return { port, chunks, ended: () => ended, server };
    };

    /**
     * Until what was sent has arrived, rather than a fixed 120 ms after the send returned: a
     * loaded machine can take longer, and an idle one wastes the rest. Each caller closes its
     * collector in a `finally`, which a failure here no longer falls through to.
     */
    const arrived = (what: () => string, met: () => boolean): Promise<void> =>
      pollWithin(5_000, what, met);

    /**
     * How long UDP is watched for a datagram past the expected count (`P-373`). UDP has no end to
     * wait for, so this is a window, and it is short because it has little to cover: `sendUdp`
     * returns only once every send's callback has fired, so an excess datagram has left the
     * sender before the window opens, and on loopback it is already queued for the collector,
     * which needs only a turn of the event loop to read it. A machine slow enough to outrun the
     * window lets an excess datagram go unseen — the check weakens, it never fails a correct
     * sender — and the cases over TCP, which wait for the connection's end, do not depend on it.
     */
    const QUIET_MS = 100;

    it('sends one datagram per message over UDP', async () => {
      const { port, lines, socket } = await collectUdp();
      try {
        await sendUdp(port, [{ message: 'first' }, { message: 'second' }]);
        await arrived(
          () => `2 datagrams; got ${String(lines.length)}`,
          () => lines.length >= 2,
        );
        await sleep(QUIET_MS);
      } finally {
        socket.close();
      }

      assert.equal(lines.length, 2);
      assert.match(lines[0] ?? '', /first$/);
      assert.match(lines[1] ?? '', /second$/);
    });

    it('frames TCP by octet count, which is RFC 6587 and unambiguous', async () => {
      const { port, chunks, ended, server } = await collectTcp();
      try {
        await sendTcp(port, [{ message: 'counted' }], { framing: 'octet-counting' });
        await arrived(
          () => `the connection's end after the frame; got ${JSON.stringify(chunks.join(''))}`,
          ended,
        );
      } finally {
        await close(server);
      }

      const wire = chunks.join('');
      const [length] = wire.split(' ', 1);
      assert.ok(length !== undefined);
      assert.equal(Number(length), wire.length - length.length - 1, 'the count is the byte count');
    });

    it('frames TCP by a trailing newline when asked, which is the other legal framing', async () => {
      // A receiver that assumes the wrong one silently corrupts message boundaries — which gets
      // blamed on the sender for weeks. Being able to send both is how that is tested.
      const { port, chunks, ended, server } = await collectTcp();
      try {
        await sendTcp(port, [{ message: 'one' }, { message: 'two' }], {
          framing: 'non-transparent',
        });
        await arrived(
          () => `the connection's end after two frames; got ${JSON.stringify(chunks.join(''))}`,
          ended,
        );
      } finally {
        await close(server);
      }

      const wire = chunks.join('');
      assert.equal(wire.split('\n').filter((line) => line !== '').length, 2);
      assert.equal(/^\d+ </.test(wire), false, 'no octet count on this framing');
    });

    it('splits a frame across two writes when asked, because TCP is a stream', async () => {
      // A receiver that assumes one `data` event is one message works perfectly until the day
      // the network disagrees. This makes that day reproducible.
      const { port, chunks, ended, server } = await collectTcp();
      try {
        await sendTcp(port, [{ message: 'split me down the middle' }], { splitAt: 12 });
        await arrived(
          () => `the connection's end after the message; got ${JSON.stringify(chunks.join(''))}`,
          ended,
        );
      } finally {
        await close(server);
      }

      const wire = chunks.join('');
      assert.equal(
        wire.match(/<\d+>1 /g)?.length,
        1,
        `one message, whole: ${JSON.stringify(wire)}`,
      );
      assert.match(wire, /split me down the middle$/);
      assert.ok(
        chunks.length >= 2,
        `expected the send to arrive in pieces, got ${String(chunks.length)}`,
      );
    });

    it('sends every message down one connection, so boundaries are exercised', async () => {
      const { port, chunks, ended, server } = await collectTcp();
      try {
        await sendTcp(port, [{ message: 'a' }, { message: 'b' }, { message: 'c' }]);
        await arrived(
          () => `the connection's end after three messages; got ${JSON.stringify(chunks.join(''))}`,
          ended,
        );
      } finally {
        await close(server);
      }

      assert.equal(chunks.join('').match(/<\d+>1 /g)?.length, 3);
    });
  });
});
