import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { TrapListener } from '../src/listeners/trap-listener.js';
import type { ReceivedTrap, TrapReceiverOptions } from '@ms/sensors/snmp';
import type { TrapDetail } from '@ms/sensors';
import { pino } from 'pino';

/**
 * The ring buffer and the cursors, with no socket anywhere.
 *
 * That is the point of the injected opener: everything in this class is about what a *probe*
 * does with what arrived — bounding memory, giving each sensor what it has not seen, counting
 * what it could not keep — and none of it should need a UDP port to exercise. The protocol half
 * is tested against a real socket in `@ms/sensors`, where a real socket is the point.
 */

const silent = pino({ level: 'silent' });

let deliver: (trap: ReceivedTrap) => void;
let reportMalformed: (reason: string) => void;
let closed = 0;

function fakeReceiver(options: TrapReceiverOptions) {
  deliver = options.onTrap;
  reportMalformed = options.onMalformed;
  return {
    close: (): Promise<void> => {
      closed += 1;
      return Promise.resolve();
    },
  };
}

let clock = 0;

async function listener(bufferSize = 4, communities: string[] = []): Promise<TrapListener> {
  const instance = new TrapListener({
    logger: silent,
    port: 0,
    address: '127.0.0.1',
    transport: 'udp4',
    communities,
    bufferSize,
    now: () => new Date(1_800_000_000_000 + clock++ * 1_000),
    open: fakeReceiver,
  });
  await instance.start();
  return instance;
}

function trap(over: Partial<ReceivedTrap> = {}): ReceivedTrap {
  const detail: TrapDetail = {
    trapOid: '1.3.6.1.6.3.1.1.5.3',
    version: 'v2c',
    kind: 'trap',
    varbinds: [],
  };
  return { source: '10.1.2.3', detail, community: 'public', ...over };
}

beforeEach(() => {
  clock = 0;
  closed = 0;
});

describe('handing each sensor what it has not seen', () => {
  it('hands a sensor held across a restart what arrived before its first scan (`P-254`)', async () => {
    // `H-15`: three traps after the restart, counted in `trapReceived` and by no sensor, because
    // the first scan made its cursor at the current sequence. The probe was told it holds sensor
    // 1 (and a ping sensor, 9) before the traps came, and sensor 1 had not scanned yet.
    const trapListener = await listener();
    trapListener.retain([1, 9]);
    deliver(trap());
    deliver(trap());
    deliver(trap());

    const first = trapListener.drain(1);
    assert.equal(first.items.length, 3);
    assert.equal(first.dropped, 0);
    assert.equal(first.listener, 'snmp-trap');
    assert.equal(
      first.since,
      new Date(1_800_000_000_000).toISOString(),
      'since the listener began',
    );
    assert.equal(trapListener.stats().received, 3);
  });

  it('counts what a sensor held across a restart lost before its first scan (`P-254`)', async () => {
    const trapListener = await listener(4);
    trapListener.retain([1]);
    for (let at = 0; at < 7; at += 1) deliver(trap());

    const first = trapListener.drain(1, 60_000);
    assert.equal(first.items.length, 4);
    assert.equal(first.dropped, 3, 'received, lost to the buffer, and said so');
    assert.equal(trapListener.stats().overwrittenUnread, 3, 'and on Probe Health');
  });

  it('reads one interval back after a restart, and names what came before (`P-254`)', async () => {
    // The clock here moves a second a reading. Five traps, then two minutes, then two: a sensor
    // that scans every minute reads the two, as any scan of it would, and is told of the five.
    const trapListener = await listener();
    trapListener.retain([1]);
    for (let at = 0; at < 5; at += 1) deliver(trap());
    clock += 120;
    deliver(trap());
    deliver(trap());

    const first = trapListener.drain(1, 60_000);
    assert.equal(first.items.length, 2);
    assert.equal(first.earlier, 5);
    assert.equal(first.dropped, 0);
  });

  it('returns what arrived since the last drain, and only that', async () => {
    const trapListener = await listener();
    trapListener.drain(1);

    deliver(trap({ source: '10.0.0.1' }));
    deliver(trap({ source: '10.0.0.2' }));
    assert.deepEqual(
      trapListener.drain(1).items.map((item) => item.source),
      ['10.0.0.1', '10.0.0.2'],
    );

    // Nothing new, so nothing again — not the same two a second time.
    assert.deepEqual(trapListener.drain(1).items, []);
  });

  it('gives two sensors the same notification, each on its own cursor', async () => {
    // One socket, many sensors: a trap that two sensors both want must reach both, and a
    // shared read position would give it to whichever scanned first.
    const trapListener = await listener();
    trapListener.drain(1);
    trapListener.drain(2);

    deliver(trap());
    assert.equal(trapListener.drain(1).items.length, 1);
    assert.equal(trapListener.drain(2).items.length, 1);
  });

  it('lets a sensor that registered later miss what came before it', async () => {
    const trapListener = await listener();
    trapListener.retain([1]);
    trapListener.drain(1);
    deliver(trap());
    // Sensor 2 is new to a probe that was already running, and first drains here, so it starts
    // from now rather than replaying history it was never configured to watch.
    trapListener.retain([1, 2]);
    trapListener.drain(2);
    deliver(trap());

    assert.equal(trapListener.drain(1).items.length, 2);
    assert.equal(trapListener.drain(2).items.length, 1);
  });
});

describe('the bound on memory, and what it costs', () => {
  it('counts what the ring overwrote instead of returning a quietly shorter list', async () => {
    // A device in a loop sends thousands a second. The buffer has to be bounded or the probe
    // dies during exactly the incident it was bought for — but a sensor that silently
    // under-reported the flood would be the worst version of surviving it.
    const trapListener = await listener(4);
    trapListener.drain(1);

    for (let at = 0; at < 10; at += 1) deliver(trap({ source: `10.0.0.${String(at)}` }));

    const batch = trapListener.drain(1);
    assert.equal(batch.items.length, 4, 'only the buffer’s worth survives');
    assert.equal(batch.dropped, 6, 'and the rest is counted, not forgotten');
    // The four kept are the newest, which is what an operator reading the message wants.
    assert.deepEqual(
      batch.items.map((item) => item.source),
      ['10.0.0.6', '10.0.0.7', '10.0.0.8', '10.0.0.9'],
    );
  });

  it('catches a lagging sensor up in one scan rather than replaying for ever', async () => {
    const trapListener = await listener(4);
    trapListener.drain(1);
    for (let at = 0; at < 10; at += 1) deliver(trap());

    assert.equal(trapListener.drain(1).dropped, 6);
    // The cursor moved to now, so the next scan is clean — a sensor does not keep reporting the
    // same drop every interval after one flood.
    const next = trapListener.drain(1);
    assert.equal(next.dropped, 0);
    assert.equal(next.items.length, 0);
  });

  it('reports nothing dropped when the sensor kept up', async () => {
    const trapListener = await listener(4);
    trapListener.drain(1);
    deliver(trap());
    deliver(trap());
    assert.equal(trapListener.drain(1).dropped, 0);
  });

  it('counts what was overwritten unread apart from everything that was overwritten (`B-14`)', async () => {
    // The number Probe Health carries. `overwritten` rises with every trap on a buffer that has
    // filled once, nearly always for one every sensor had read; this is what a sensor lost.
    const trapListener = await listener(4);
    trapListener.drain(1);
    for (let at = 0; at < 4; at += 1) deliver(trap());
    assert.equal(trapListener.drain(1).items.length, 4);
    for (let at = 0; at < 4; at += 1) deliver(trap());
    assert.equal(trapListener.stats().overwritten, 4, 'four did leave the buffer');
    assert.equal(trapListener.stats().overwrittenUnread, 0, 'and all four had been read');

    // Read again, and then ten with no scan among them: the first four push out the four just
    // read, and the other six push out six of themselves.
    assert.equal(trapListener.drain(1).items.length, 4);
    for (let at = 0; at < 10; at += 1) deliver(trap());
    assert.equal(trapListener.stats().overwritten, 14);
    assert.equal(trapListener.stats().overwrittenUnread, 6);
    assert.equal(trapListener.drain(1).dropped, 6, 'the same six, from the sensor’s side');
  });

  it('counts a notification once however many sensors were behind, and none with no sensor (`B-14`)', async () => {
    const unread = await listener(4);
    unread.retain([]); // the probe holds no trap sensor
    for (let at = 0; at < 10; at += 1) deliver(trap());
    assert.equal(unread.stats().overwritten, 6);
    assert.equal(unread.stats().overwrittenUnread, 0, 'nobody was waiting for them');

    unread.retain([1, 2]); // two arrive on a running probe
    unread.drain(1);
    unread.drain(2);
    for (let at = 0; at < 7; at += 1) deliver(trap());
    assert.equal(unread.stats().overwrittenUnread, 3, 'three lost, not three for each sensor');
    // A rejected community never reaches the buffer, so it overwrites nothing.
    const strict = await listener(4, ['public']);
    strict.drain(1);
    for (let at = 0; at < 10; at += 1) deliver(trap({ community: 'other' }));
    assert.equal(strict.stats().overwrittenUnread, 0);
  });
});

describe('what the listener accepts', () => {
  it('turns away a community that is not on the list, and counts it', async () => {
    const trapListener = await listener(4, ['secret']);
    trapListener.drain(1);

    deliver(trap({ community: 'public' }));
    deliver(trap({ community: 'secret' }));

    assert.equal(trapListener.drain(1).items.length, 1);
    const stats = trapListener.stats();
    // Counted rather than logged per trap: a misconfigured device retries for ever, and one log
    // line per trap is how a disk fills up during an incident.
    assert.equal(stats.rejected, 1);
    assert.equal(stats.received, 1);
  });

  it('accepts any community when none is configured', async () => {
    const trapListener = await listener(4, []);
    trapListener.drain(1);
    deliver(trap({ community: 'anything' }));
    assert.equal(trapListener.drain(1).items.length, 1);
  });

  it('counts a malformed datagram without letting it through', async () => {
    const trapListener = await listener();
    trapListener.drain(1);
    reportMalformed('not a BER message');
    assert.equal(trapListener.stats().malformed, 1);
    assert.equal(trapListener.drain(1).items.length, 0);
  });
});

describe('housekeeping', () => {
  it('renders each notification once, when it arrives', async () => {
    // Rendering per drain would repeat the work for every sensor that wanted the same trap.
    const trapListener = await listener();
    trapListener.drain(1);
    deliver(trap());
    const [item] = trapListener.drain(1).items;
    assert.ok(item);
    assert.equal(item.text, '10.1.2.3 trap v2c linkDown');
    assert.equal(item.source, '10.1.2.3');
  });

  it('drops the cursors of sensors the probe no longer holds', async () => {
    const trapListener = await listener();
    trapListener.drain(1);
    trapListener.drain(2);
    trapListener.drain(3);
    assert.equal(trapListener.stats().cursors, 3);

    trapListener.retain([1, 3]);
    assert.equal(trapListener.stats().cursors, 2);
    // And the survivor kept its position rather than being reset.
    deliver(trap());
    assert.equal(trapListener.drain(1).items.length, 1);
  });

  it('starts once and stops once', async () => {
    const trapListener = await listener();
    assert.equal(trapListener.running, true);
    await trapListener.start();

    await trapListener.stop();
    assert.equal(trapListener.running, false);
    await trapListener.stop();
    assert.equal(closed, 1, 'stopping twice should close one socket, not two');
  });
});
