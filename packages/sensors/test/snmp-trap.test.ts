import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { snmpTrap } from '../src/types/snmp-trap.js';
import {
  genericNameOf,
  renderTrap,
  ruleMatches,
  trapOidFromV1,
  trapOidFromVarbinds,
  type TrapDetail,
} from '../src/support/snmp/trap.js';
import type {
  CheckContext,
  CheckExecution,
  ReceivedBatch,
  ReceivedNotification,
} from '../src/contract.js';

const LINK_DOWN = '1.3.6.1.6.3.1.1.5.3';
const CISCO = '1.3.6.1.4.1.9';

function detail(over: Partial<TrapDetail> = {}): TrapDetail {
  return {
    trapOid: LINK_DOWN,
    version: 'v2c',
    kind: 'trap',
    varbinds: [],
    ...over,
  };
}

function notification(over: Partial<ReceivedNotification> = {}): ReceivedNotification {
  const base = {
    at: '2026-08-27T03:00:00.000Z',
    source: '10.1.2.3',
    text: '10.1.2.3 trap v2c linkDown',
    detail: detail() as unknown as Readonly<Record<string, unknown>>,
  };
  return { ...base, ...over };
}

function batch(items: readonly ReceivedNotification[], over: Partial<ReceivedBatch> = {}) {
  return {
    listener: 'snmp-trap',
    items,
    dropped: 0,
    since: '2026-08-27T02:59:00.000Z',
    ...over,
  } satisfies ReceivedBatch;
}

/** `null` means no listener is attached at all, which is not the same as an empty batch. */
function run(
  params: Record<string, unknown> = {},
  received: ReceivedBatch | null = batch([]),
  host = '10.1.2.3',
): Promise<CheckExecution> {
  const context: CheckContext = {
    sensorId: 1,
    target: { host, ipVersion: 'v4' },
    params,
    credentials: {},
    signal: new AbortController().signal,
    ...(received === null ? {} : { received }),
  };
  return snmpTrap.execute(context);
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('making v1 and v2c traps the same shape (RFC 3584 §3.1)', () => {
  it('maps the six generic v1 traps onto their standard OIDs', () => {
    // The mapping the whole receiver rests on: a rule written for linkDown has to catch it
    // whichever way a device chose to send it, and a v1 trap carries a number where a v2c trap
    // carries an OID.
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].map((generic) => trapOidFromV1('1.3.6.1.4.1.9', generic, 0)),
      [
        '1.3.6.1.6.3.1.1.5.1',
        '1.3.6.1.6.3.1.1.5.2',
        '1.3.6.1.6.3.1.1.5.3',
        '1.3.6.1.6.3.1.1.5.4',
        '1.3.6.1.6.3.1.1.5.5',
        '1.3.6.1.6.3.1.1.5.6',
      ],
    );
  });

  it('puts the zero in an enterprise-specific trap OID', () => {
    // The part everybody drops. Without it a vendor's specific traps collide with the ordinary
    // objects in the same subtree, and a subtree rule would match objects that are not traps.
    assert.equal(trapOidFromV1(CISCO, 6, 17), '1.3.6.1.4.1.9.0.17');
  });

  it('reads the trap OID a v2c notification declares', () => {
    assert.equal(
      trapOidFromVarbinds([
        { oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: '49' },
        { oid: '1.3.6.1.6.3.1.1.4.1.0', type: 'OID', value: LINK_DOWN },
      ]),
      LINK_DOWN,
    );
    assert.equal(trapOidFromVarbinds([]), null);
  });

  it('names the six generic traps and nothing else', () => {
    assert.equal(genericNameOf(LINK_DOWN), 'linkDown');
    assert.equal(genericNameOf('1.3.6.1.6.3.1.1.5.1'), 'coldStart');
    assert.equal(genericNameOf('1.3.6.1.6.3.1.1.5.7'), null);
    assert.equal(genericNameOf('1.3.6.1.4.1.9.0.17'), null);
  });
});

describe('rendering a trap for a person to read', () => {
  it('names the generic trap rather than printing its OID', () => {
    assert.match(renderTrap('10.1.2.3', detail()), /^10\.1\.2\.3 trap v2c linkDown$/);
  });

  it('drops the two varbinds RFC 3416 puts on every v2c notification', () => {
    // `sysUpTime.0` and `snmpTrapOID.0` are on every one of them and say nothing an operator
    // wants: the trap is already named, and the uptime is not the interesting part.
    const line = renderTrap(
      '10.1.2.3',
      detail({
        varbinds: [
          { oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: '49' },
          { oid: '1.3.6.1.6.3.1.1.4.1.0', type: 'OID', value: LINK_DOWN },
          { oid: '1.3.6.1.2.1.2.2.1.1', type: 'Integer', value: '7' },
        ],
      }),
    );
    assert.match(line, /\[1\.3\.6\.1\.2\.1\.2\.2\.1\.1=7\]$/);
    assert.ok(!line.includes('1.3.6.1.2.1.1.3.0'));
  });
});

describe('filter rules', () => {
  it('matches everything when the rule is empty', () => {
    assert.equal(ruleMatches({}, notification()), true);
  });

  it('ands the fields within one rule, so adding one always narrows', () => {
    const item = notification();
    assert.equal(ruleMatches({ source: '10.1.2.3', trapOid: LINK_DOWN }, item), true);
    assert.equal(ruleMatches({ source: '10.1.2.3', trapOid: '1.3.6.1.6.3.1.1.5.4' }, item), false);
  });

  it('takes a trailing dot as a subtree, for both the OID and the sender', () => {
    const cisco = notification({
      detail: detail({ trapOid: '1.3.6.1.4.1.9.0.17' }) as unknown as Record<string, unknown>,
    });
    assert.equal(ruleMatches({ trapOid: '1.3.6.1.4.1.9.' }, cisco), true);
    // Arc by arc, not text: 1.3.6.1.4.1.99 must not match the 1.3.6.1.4.1.9 subtree.
    const other = notification({
      detail: detail({ trapOid: '1.3.6.1.4.1.99.0.1' }) as unknown as Record<string, unknown>,
    });
    assert.equal(ruleMatches({ trapOid: '1.3.6.1.4.1.9.' }, other), false);
    assert.equal(ruleMatches({ source: '10.1.' }, notification()), true);
    assert.equal(ruleMatches({ source: '10.2.' }, notification()), false);
  });

  it('matches text case-insensitively against the rendered line', () => {
    const item = notification({ text: '10.1.2.3 trap v1 coldStart [1.3.6.1.4.1.9.1=DISK FAILED]' });
    assert.equal(ruleMatches({ contains: 'disk failed' }, item), true);
    assert.equal(ruleMatches({ contains: 'fan' }, item), false);
  });
});

describe('snmp.trap', () => {
  it('fails rather than reporting zero when no listener is running', async () => {
    // The one failure a trap sensor must never have. A confident zero here makes a receiver
    // that was never switched on look exactly like a quiet, healthy network.
    await assert.rejects(() => run({}, null), /no trap listener is running on this probe/);
  });

  it('refuses a batch from a different listener', async () => {
    await assert.rejects(
      () => run({}, batch([], { listener: 'syslog' })),
      /handed a batch from the "syslog" listener/,
    );
  });

  it('counts only the device’s own notifications by default', async () => {
    const execution = await run(
      {},
      batch([notification({ source: '10.1.2.3' }), notification({ source: '10.9.9.9' })]),
    );
    assert.equal(valueOf(execution, 'count'), 1);
    // Not discarded quietly: this is how an operator finds out a device is sending traps that
    // no sensor on this installation is catching.
    assert.equal(valueOf(execution, 'unmatched'), 1);
  });

  it('resolves a device addressed by name, because a trap’s sender is an address', async () => {
    // Found by pointing the first sensor at the dev target, whose host is `ms-target`: a trap
    // arrives from an IP, the device is named, and a direct comparison counts zero for ever —
    // which is indistinguishable from a quiet network, the one failure this type must not have.
    const execution = await run(
      {},
      batch([notification({ source: '127.0.0.1' }), notification({ source: '10.9.9.9' })]),
      'localhost',
    );
    assert.equal(valueOf(execution, 'count'), 1);
    assert.equal(valueOf(execution, 'unmatched'), 1);
  });

  it('fails rather than counting nothing when the device’s name will not resolve', async () => {
    await assert.rejects(
      () => run({}, batch([notification()]), 'no-such-device.invalid'),
      /did not resolve to any address/,
    );
  });

  it('needs no name resolution at all when it watches every sender', async () => {
    const execution = await run(
      { sourceIsDevice: false },
      batch([notification()]),
      'no-such-device.invalid',
    );
    assert.equal(valueOf(execution, 'count'), 1);
  });

  it('counts every sender when told to, which is what a collector sensor is', async () => {
    const execution = await run(
      { sourceIsDevice: false },
      batch([notification({ source: '10.1.2.3' }), notification({ source: '10.9.9.9' })]),
    );
    assert.equal(valueOf(execution, 'count'), 2);
    assert.equal(valueOf(execution, 'unmatched'), 0);
  });

  it('ors the rules, so a second rule only ever widens', async () => {
    const items = [
      notification({
        detail: detail({ trapOid: LINK_DOWN }) as unknown as Record<string, unknown>,
      }),
      notification({
        detail: detail({ trapOid: '1.3.6.1.6.3.1.1.5.4' }) as unknown as Record<string, unknown>,
      }),
      notification({
        detail: detail({ trapOid: '1.3.6.1.4.1.9.0.17' }) as unknown as Record<string, unknown>,
      }),
    ];
    const one = await run({ rules: [{ trapOid: LINK_DOWN }] }, batch(items));
    assert.equal(valueOf(one, 'count'), 1);

    const two = await run(
      { rules: [{ trapOid: LINK_DOWN }, { trapOid: '1.3.6.1.6.3.1.1.5.4' }] },
      batch(items),
    );
    assert.equal(valueOf(two, 'count'), 2);
  });

  it('ignores a rule with every field blank rather than letting it match everything', async () => {
    // A half-finished row in the form, which would otherwise silently widen the sensor to
    // everything and make every other rule pointless.
    const items = [
      notification({
        detail: detail({ trapOid: LINK_DOWN }) as unknown as Record<string, unknown>,
      }),
      notification({
        detail: detail({ trapOid: '1.3.6.1.4.1.9.0.17' }) as unknown as Record<string, unknown>,
      }),
    ];
    const execution = await run(
      { rules: [{ trapOid: LINK_DOWN }, { source: '', trapOid: '', contains: '' }] },
      batch(items),
    );
    assert.equal(valueOf(execution, 'count'), 1);
  });

  it('counts informs separately, because they are acknowledged and traps are not', async () => {
    const execution = await run(
      {},
      batch([
        notification(),
        notification({ detail: detail({ kind: 'inform' }) as unknown as Record<string, unknown> }),
      ]),
    );
    assert.equal(valueOf(execution, 'count'), 2);
    assert.equal(valueOf(execution, 'informs'), 1);
  });

  it('fails when the listener overwrote notifications before this sensor read them', async () => {
    // A trap sensor quietly under-reporting the flood it exists to report is worse than a failed
    // check. A throw records no values at all, which is the honest reading for a count that is
    // known to be short.
    await assert.rejects(
      () => run({}, batch([notification()], { dropped: 42 })),
      /42 notifications reached this probe but were overwritten.*short by that much/s,
    );
  });

  it('reports the miss as a channel instead when the operator turned that off', async () => {
    const execution = await run({ warnOnDropped: false }, batch([notification()], { dropped: 42 }));
    assert.equal(valueOf(execution, 'dropped'), 42);
    assert.equal(valueOf(execution, 'count'), 1);
  });

  it('says how long it has been quiet rather than just saying nothing', async () => {
    const execution = await run({}, batch([]));
    assert.match(execution.message ?? '', /no traps since 2026-08-27T02:59:00Z/);
    assert.equal(valueOf(execution, 'count'), 0);
  });

  it('shows the newest traps first, and bounds the message', async () => {
    const many = Array.from({ length: 60 }, (_, at) =>
      notification({ text: `10.1.2.3 trap v2c linkDown seq${String(at)}` }),
    );
    const execution = await run({}, batch(many));
    assert.equal(valueOf(execution, 'count'), 60);
    const message = execution.message ?? '';
    assert.match(message, /^60 traps;/);
    assert.match(message, /seq59/, 'the newest should be first');
    assert.ok(message.length <= 520, `message was ${String(message.length)} characters`);
  });

  it('declares one primary channel and needs no credentials', () => {
    assert.deepEqual(
      snmpTrap
        .channels({})
        .filter((channel) => channel.isPrimary === true)
        .map((c) => c.key),
      ['count'],
    );
    assert.deepEqual(snmpTrap.credentialKinds, []);
  });

  it('declares the listener that feeds it, which is how the probe knows not to poll it', () => {
    assert.equal(snmpTrap.listener, 'snmp-trap');
  });
});
