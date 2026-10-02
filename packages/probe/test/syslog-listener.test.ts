import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { parseSyslog } from '@ms/sensors';
import type { ReceivedSyslog, SyslogReceiverOptions } from '@ms/sensors/syslog';
import {
  SyslogListener,
  LISTENER_ID,
  type SyslogListenerOptions,
} from '../src/listeners/syslog-listener.js';

/**
 * The probe's syslog listener: the ring, the cursors, the counters and the sender filter.
 *
 * No socket anywhere. The protocol half has its own tests against real UDP and TCP, where a real
 * socket is the point; everything here is about what happens to a message *after* it arrives, and
 * none of that should need a port to exercise.
 */

const silent = pino({ level: 'silent' });

/** A listener whose socket is a function this test calls. */
function listenerOf(over: Partial<SyslogListenerOptions> = {}): {
  listener: SyslogListener;
  send: (line: string, source?: string) => void;
} {
  let deliver: ((received: ReceivedSyslog) => void) | undefined;
  const listener = new SyslogListener({
    logger: silent,
    port: 0,
    address: '127.0.0.1',
    udp: true,
    tcp: true,
    ipVersion: 'udp4',
    senders: [],
    bufferSize: 4,
    ...over,
    open: (options: SyslogReceiverOptions) => {
      deliver = options.onMessage;
      return { close: () => Promise.resolve() };
    },
  });
  return {
    listener,
    send: (line, source = '10.0.0.1') => {
      deliver?.({ source, transport: 'udp', message: parseSyslog(line) });
    },
  };
}

/** auth.error: facility 4, severity 3, so priority 4 * 8 + 3. */
const line = (message: string): string => `<35>Aug 27 09:15:00 gw sshd[1]: ${message}`;

describe('syslog listener', () => {
  it('hands a sensor only what arrived since it last looked', async () => {
    const { listener, send } = listenerOf();
    await listener.start();

    // The first drain registers the cursor and returns nothing: a sensor's first scan after a
    // probe restart has genuinely received nothing, and `since` is how the type tells that apart
    // from a quiet network.
    assert.equal(listener.drain(1).items.length, 0);

    send(line('one'));
    send(line('two'));
    const batch = listener.drain(1);
    assert.equal(batch.listener, LISTENER_ID);
    assert.equal(batch.items.length, 2);
    assert.equal(batch.dropped, 0);
    assert.equal(listener.drain(1).items.length, 0, 'the cursor advanced');
    await listener.stop();
  });

  it('gives two sensors the same messages, each from its own cursor', async () => {
    const { listener, send } = listenerOf();
    await listener.start();
    listener.drain(1);
    send(line('shared'));
    listener.drain(2);
    send(line('only for one'));

    assert.equal(listener.drain(1).items.length, 2);
    assert.equal(listener.drain(2).items.length, 1);
    await listener.stop();
  });

  it('counts what the ring overwrote rather than shortening the list quietly', async () => {
    // Backpressure is visible, never silent (CLAUDE.md). The sensor turns this into a failed
    // check rather than an undercount.
    const { listener, send } = listenerOf({ bufferSize: 2 });
    await listener.start();
    listener.drain(1);
    for (let at = 0; at < 5; at += 1) send(line(`message ${String(at)}`));

    const batch = listener.drain(1);
    assert.equal(batch.items.length, 2);
    assert.equal(batch.dropped, 3);
    assert.equal(listener.stats().overwritten, 3);
    await listener.stop();
  });

  it('counts what was overwritten unread apart from everything that was overwritten (`B-14`)', async () => {
    // The number Probe Health carries. `overwritten` rises with every message on a buffer that
    // has filled once, nearly always for one every sensor had read; this is what a sensor lost.
    const { listener, send } = listenerOf({ bufferSize: 4 });
    await listener.start();
    listener.drain(1);
    for (let at = 0; at < 4; at += 1) send(line(`read ${String(at)}`));
    assert.equal(listener.drain(1).items.length, 4);
    for (let at = 0; at < 4; at += 1) send(line(`kept up ${String(at)}`));
    assert.equal(listener.stats().overwritten, 4, 'four did leave the buffer');
    assert.equal(listener.stats().overwrittenUnread, 0, 'and all four had been read');

    // Read again, and then ten with no scan among them: the first four push out the four just
    // read, and the other six push out six of themselves.
    assert.equal(listener.drain(1).items.length, 4);
    for (let at = 0; at < 10; at += 1) send(line(`flood ${String(at)}`));
    assert.equal(listener.stats().overwritten, 14);
    assert.equal(listener.stats().overwrittenUnread, 6);
    assert.equal(listener.drain(1).dropped, 6, 'the same six, from the sensor’s side');
    await listener.stop();
  });

  it('counts a message once however many sensors were behind, and none with no sensor (`B-14`)', async () => {
    const { listener, send } = listenerOf({ bufferSize: 4 });
    await listener.start();
    for (let at = 0; at < 10; at += 1) send(line(`unwatched ${String(at)}`));
    assert.equal(listener.stats().overwritten, 6);
    assert.equal(listener.stats().overwrittenUnread, 0, 'nobody was waiting for them');

    listener.drain(1);
    listener.drain(2);
    for (let at = 0; at < 7; at += 1) send(line(`watched ${String(at)}`));
    assert.equal(listener.stats().overwrittenUnread, 3, 'three lost, not three for each sensor');
    await listener.stop();

    // A sender that is turned away never reaches the buffer, so it overwrites nothing.
    const strict = listenerOf({ bufferSize: 4, senders: ['10.0.0.1'] });
    await strict.listener.start();
    strict.listener.drain(1);
    for (let at = 0; at < 10; at += 1) strict.send(line('refused'), '10.9.9.9');
    assert.equal(strict.listener.stats().overwrittenUnread, 0);
    await strict.listener.stop();
  });

  it('turns a message into a notification the sensor can filter on', async () => {
    const { listener, send } = listenerOf();
    await listener.start();
    listener.drain(1);
    send('<35>1 2026-08-27T09:15:00Z gw sshd 1234 ID9 [x@1 iut="3"] Failed password');

    const item = listener.drain(1).items[0];
    assert.equal(item?.source, '10.0.0.1');
    assert.equal(item.detail['appName'], 'sshd');
    assert.equal(item.detail['procId'], '1234');
    assert.equal(item.detail['severityName'], 'error');
    assert.deepEqual(item.detail['structured'], { 'x@1.iut': '3' });
    assert.match(item.text, /auth\.error from 10\.0\.0\.1 \(gw sshd\): Failed password/);
    await listener.stop();
  });

  it('stamps the probe’s clock, keeping the sender’s own separately', async () => {
    // A device with a wrong clock would otherwise put its messages outside every window a sensor
    // looks at.
    const { listener, send } = listenerOf({ now: () => new Date('2026-08-27T12:00:00.000Z') });
    await listener.start();
    listener.drain(1);
    send('<13>1 2001-01-01T00:00:00Z host app - - - from a device with a wrong clock');

    const item = listener.drain(1).items[0];
    assert.equal(item?.at, '2026-08-27T12:00:00.000Z');
    assert.equal(item.detail['timestamp'], '2001-01-01T00:00:00.000Z');
    await listener.stop();
  });

  it('turns away a sender that is not on the list, and counts it', async () => {
    const { listener, send } = listenerOf({ senders: ['10.0.0.1'] });
    await listener.start();
    listener.drain(1);
    send(line('kept'), '10.0.0.1');
    send(line('turned away'), '10.0.0.2');

    assert.equal(listener.drain(1).items.length, 1);
    assert.equal(listener.stats().rejected, 1);
    assert.equal(listener.stats().received, 1);
    await listener.stop();
  });

  it('forgets the cursor of a sensor the probe no longer holds', async () => {
    const { listener } = listenerOf();
    await listener.start();
    listener.drain(1);
    listener.drain(2);
    assert.equal(listener.stats().cursors, 2);
    listener.retain([1]);
    assert.equal(listener.stats().cursors, 1);
    await listener.stop();
  });

  it('is not running until it is started, and says so', async () => {
    const { listener } = listenerOf();
    assert.equal(listener.running, false);
    await listener.start();
    assert.equal(listener.running, true);
    await listener.stop();
    assert.equal(listener.running, false);
  });
});
