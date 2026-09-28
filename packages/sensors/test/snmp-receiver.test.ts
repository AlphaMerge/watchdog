import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import snmp from 'net-snmp';
import {
  normaliseTrap,
  openTrapReceiver,
  type ReceivedTrap,
} from '../src/support/snmp/receiver.js';

/**
 * A real socket, a real sender, and both wire formats.
 *
 * The decode is where `T-06` can be silently wrong: a receiver that mishandles one version looks
 * exactly like a network on which nothing is happening. Every assertion below therefore goes
 * over UDP through `net-snmp`'s own sender rather than through a fabricated PDU — the fabricated
 * ones are in `normaliseTrap`'s unit tests further down, where the point is the edge cases a
 * sender will not produce on request.
 */

const LINK_DOWN = '1.3.6.1.6.3.1.1.5.3';
const PORT = 11_762;

let received: ReceivedTrap[] = [];
let malformed: string[] = [];
let receiver: { close(): Promise<void> };
/** Set to make the next notification's handler throw, as a defect downstream would. */
let throwNext = false;

/** Waits for the receiver to have `count` notifications, or gives up. */
async function settle(count: number, withinMs = 3_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (received.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

before(() => {
  receiver = openTrapReceiver({
    port: PORT,
    address: '127.0.0.1',
    transport: 'udp4',
    onTrap: (trap) => {
      if (throwNext) {
        throwNext = false;
        throw new Error('a defect in whatever handles the trap');
      }
      received.push(trap);
    },
    onMalformed: (reason) => {
      malformed.push(reason);
    },
  });
});

after(async () => {
  await receiver.close();
});

function sender(version: number): snmp.Session {
  return snmp.createSession('127.0.0.1', 'public', {
    port: PORT,
    trapPort: PORT,
    version,
  });
}

describe('receiving notifications over a real socket', () => {
  it('receives a v1 trap and maps it onto its v2c equivalent', async () => {
    received = [];
    const session = sender(snmp.Version1);
    session.trap(2 /* linkDown */, () => undefined);
    await settle(1);
    session.close();

    const [trap] = received;
    assert.ok(trap, 'no v1 trap arrived');
    assert.equal(trap.detail.version, 'v1');
    assert.equal(trap.detail.kind, 'trap');
    // The whole point of normalising: a rule written for linkDown catches it either way.
    assert.equal(trap.detail.trapOid, LINK_DOWN);
    assert.equal(trap.detail.generic, 2);
    assert.equal(trap.community, 'public');
  });

  it('receives a v2c trap and reads its OID out of the varbinds', async () => {
    received = [];
    const session = sender(snmp.Version2c);
    session.trap(LINK_DOWN, [], () => undefined);
    await settle(1);
    session.close();

    const [trap] = received;
    assert.ok(trap, 'no v2c trap arrived');
    assert.equal(trap.detail.version, 'v2c');
    assert.equal(trap.detail.trapOid, LINK_DOWN);
  });

  it('acknowledges an inform, which is the whole difference from a trap', async () => {
    // An unacknowledged inform is retransmitted until the sender gives up, so a receiver that
    // only counted them would turn one event into a burst. The assertion is the *sender's*
    // callback reporting success — nothing else proves the acknowledgement went back.
    received = [];
    const session = sender(snmp.Version2c);
    const acked = await new Promise<boolean>((resolve) => {
      session.inform(LINK_DOWN, [], (error: Error | null) => {
        resolve(error === null);
      });
      setTimeout(() => {
        resolve(false);
      }, 3_000);
    });
    session.close();

    assert.equal(acked, true, 'the sender never saw an acknowledgement');
    const [trap] = received;
    assert.ok(trap);
    assert.equal(trap.detail.kind, 'inform');
  });

  it('carries the varbinds a device sent, decoded', async () => {
    received = [];
    const session = sender(snmp.Version2c);
    session.trap(
      LINK_DOWN,
      [
        {
          oid: '1.3.6.1.4.1.9999.1.1',
          type: snmp.ObjectType['OctetString'] ?? 4,
          value: 'disk failed',
        },
      ],
      () => undefined,
    );
    await settle(1);
    session.close();

    const [trap] = received;
    assert.ok(trap);
    const payload = trap.detail.varbinds.find((v) => v.oid === '1.3.6.1.4.1.9999.1.1');
    assert.ok(payload, 'the device’s own varbind did not survive the decode');
    // An OctetString is bytes on the wire; a receiver that did not decode it would put
    // "[object Object]" in every message an operator reads.
    assert.equal(payload.value, 'disk failed');
    assert.equal(payload.type, 'OctetString');
  });

  it('survives a datagram that is not SNMP at all', async () => {
    // Port 162 accepts from anything on the network. A receiver whose error path throws is a
    // probe killed by one stray packet, and this port sees scanners.
    malformed = [];
    const { createSocket } = await import('node:dgram');
    const socket = createSocket('udp4');
    await new Promise<void>((resolve) => {
      socket.send(Buffer.from([0x00, 0x01, 0x02, 0x03]), PORT, '127.0.0.1', () => {
        resolve();
      });
    });
    const deadline = Date.now() + 2_000;
    while (malformed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    socket.close();

    assert.equal(malformed.length, 1, 'the garbage should have been reported, not thrown');

    // And the receiver is still usable, which is the assertion that matters.
    received = [];
    const session = sender(snmp.Version2c);
    session.trap(LINK_DOWN, [], () => undefined);
    await settle(1);
    session.close();
    assert.equal(received.length, 1, 'the receiver stopped working after a bad packet');
  });
});

describe('a handler that throws (P-217)', () => {
  it('costs one notification, not the probe', async () => {
    // `net-snmp` calls the receiver's callback outside its own `try`, from its UDP `message`
    // handler, so a throw there was an `uncaughtException` — the probe down, with every check it
    // was running, for one trap from anything that can reach port 162.
    malformed = [];
    throwNext = true;
    const first = sender(snmp.Version2c);
    first.trap(LINK_DOWN, [], () => undefined);
    const deadline = Date.now() + 3_000;
    while (malformed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    first.close();
    assert.deepEqual(malformed, ['handling a trap threw: a defect in whatever handles the trap']);

    received = [];
    const second = sender(snmp.Version2c);
    second.trap(LINK_DOWN, [], () => undefined);
    await settle(1);
    second.close();
    assert.equal(received.length, 1, 'the receiver stopped working after a handler threw');
  });
});

describe('normalising a PDU the sender will not produce on request', () => {
  it('refuses a v2c notification with no snmpTrapOID.0', () => {
    // RFC 3416 requires it. Without one there is nothing to filter on, and inventing a trap OID
    // would make a rule match something nobody wrote it for.
    assert.equal(
      normaliseTrap({ type: snmp.PduType.TrapV2, varbinds: [], community: 'public' }),
      null,
    );
  });

  it('refuses a PDU that is not a notification', () => {
    // What a poller pointed at the wrong port looks like. Accepted as an empty trap it would
    // count towards somebody's alarm.
    assert.equal(normaliseTrap({ type: snmp.PduType['GetRequest'] ?? 160, varbinds: [] }), null);
  });

  it('reads a v3 notification as v3, which is how the user name reaches the message', () => {
    const detail = normaliseTrap({
      type: snmp.PduType.TrapV2,
      user: 'ops',
      varbinds: [{ oid: '1.3.6.1.6.3.1.1.4.1.0', type: 6, value: LINK_DOWN }],
    });
    assert.equal(detail?.version, 'v3');
  });

  it('defaults a v1 trap with no generic number to enterprise-specific', () => {
    const detail = normaliseTrap({
      type: snmp.PduType.Trap,
      enterprise: '1.3.6.1.4.1.9',
      specific: 17,
      varbinds: [],
    });
    assert.equal(detail?.trapOid, '1.3.6.1.4.1.9.0.17');
  });
});
