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
