import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { SNMP_SECRET_DESTINATIONS, snmpParamsSchema } from '../support/snmp/schema.js';
// Type-only, and therefore erased: no `net-snmp` reaches the core, which loads this catalogue
// for schemas and channel declarations and never runs a check.
import type { SnmpSession, SnmpVarbind } from '../support/snmp/session.js';

/**
 * Interface traffic over SNMP (`T-02`) — the second most-used sensor type there is.
 *
 * **Reports counters and lets the core turn them into rates.** An interface reports octets since
 * it was last reset, and the difference between two readings divided by the time between them is
 * the rate. Doing that here would need per-sensor state on the probe, which a check cannot have:
 * it runs in whichever worker is free, and every probe restart would lose the baseline for every
 * interface on the box. So the channels are declared `counter` and `ingestion/counters.ts` does
 * the arithmetic against a baseline in the database. See that file for the wrap and reset rules.
 *
 * **64-bit counters by default, and it says when it could not get them.** `ifHCInOctets` is a
 * `Counter64`; the 32-bit `ifInOctets` wraps every 4.29 GB, which a gigabit link passes in
 * thirty-four seconds — so across a one-minute scan it goes round *twice* and a single wrap
 * correction under-reports by exactly 2^32 with nothing in the reading to say so. RFC 2863 says
 * as much: the HC counters exist because the originals are unusable above about 20 Mbit/s. A
 * device that offers only the 32-bit ones is still monitored, because a v1 agent on a 10 Mbit/s
 * link is fine and refusing would help nobody, but the message names which was used.
 */
const IF_DESCR = '1.3.6.1.2.1.2.2.1.2';
const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';
const IF_ALIAS = '1.3.6.1.2.1.31.1.1.1.18';

const IF_OPER_STATUS = '1.3.6.1.2.1.2.2.1.8';
const IF_SPEED = '1.3.6.1.2.1.2.2.1.5';
const IF_HIGH_SPEED = '1.3.6.1.2.1.31.1.1.1.15';

/** The 64-bit pair, and the 32-bit pair to fall back to. */
const HC_IN = '1.3.6.1.2.1.31.1.1.1.6';
const HC_OUT = '1.3.6.1.2.1.31.1.1.1.10';
const IN = '1.3.6.1.2.1.2.2.1.10';
const OUT = '1.3.6.1.2.1.2.2.1.16';

export const snmpTraffic: SensorType = {
  id: 'snmp.traffic',
  category: 'SNMP',
  // Holds a UDP session for the length of a few round trips. Not `light`, because a device that
  // has stopped answering holds it for the whole timeout.
  costHint: 'medium',
  secretDestinations: SNMP_SECRET_DESTINATIONS,
  // The community string or v3 user lives on the device, inherited by every SNMP sensor under
  // it (`A-05`). It is deliberately not a parameter of this type: forty interfaces on a router
  // is forty sensors, and forty copies of a credential is forty places to rotate it.
  credentialKinds: ['snmp'],

  paramsSchema: snmpParamsSchema(
    {
      ifIndex: {
        type: 'integer',
        minimum: 1,
        maximum: 2_147_483_647,
        title: 'Interface index',
        description:
          'The SNMP index of the interface (`ifIndex`). Fast — one request per scan — but not ' +
          'stable on every device: some renumber their interfaces across a reboot or a module ' +
          'change, after which this sensor is watching a different port with no sign that ' +
          'anything happened. Use the interface name instead where that is a risk.',
      },
      interfaceName: {
        type: 'string',
        maxLength: 255,
        title: 'Interface name',
        description:
          'Matched against `ifName`, `ifDescr` and `ifAlias` — for example "GigabitEthernet0/1". ' +
          'Costs one walk of the interface table per scan and survives a device renumbering its ' +
          'indexes, which an index cannot. Given both, the name wins and the index is the hint ' +
          'used to check it first.',
      },
      counterWidth: {
        enum: ['auto', '64', '32'],
        default: 'auto',
        title: 'Counter width',
        description:
          '`auto` uses the 64-bit counters and falls back to the 32-bit ones if the device has ' +
          'no `ifHCInOctets`. Force 32 only for a device that answers the 64-bit OIDs with ' +
          'something wrong; above about 20 Mbit/s they wrap faster than a scan interval and ' +
          'under-report.',
      },
    },
    [],
  ),

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    // Every counter here is octets, and the channel is octets *per second* — the core divides.
    // Bits are one `scale_mul: 8` away and are the operator's choice to make (`M-07`), not this
    // type's to bake in: a link budget is quoted in bits and a transfer quota in bytes, and both
    // readings of the same channel are legitimate.
    const bits = params['counterWidth'] === '32' ? 32 : 64;
    return [
      {
        key: 'in',
        name: 'Traffic in',
        unit: 'octets/s',
        isPrimary: true,
        counter: { bits },
      },
      { key: 'out', name: 'Traffic out', unit: 'octets/s', counter: { bits } },
      {
        // Not a counter, and not the sum of the two above computed here either: `in` and `out`
        // are rates the *core* produced, and this type never sees them. Summing the raw counters
        // is exactly equivalent — (Δin + Δout)/Δt is (Δin/Δt) + (Δout/Δt) — and it is what a
        // "total throughput" limit should fire on.
        key: 'total',
        name: 'Traffic total',
        unit: 'octets/s',
        counter: { bits },
      },
      {
        // A status code is not a measurement, so it is judged by a lookup rather than by a
        // threshold (`M-06`). "Warn above 1.5" is not a rule anybody should have to write for
        // up(1) / down(2) / testing(3).
        key: 'status',
        name: 'Interface status',
        lookup: 'ms.snmp.if-oper-status',
      },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    // Imported inside `execute`: the core loads this catalogue for schemas and channel
    // declarations and never runs a check, so it must not pay for a UDP stack
    // (`docs/adding-a-sensor-type.md`).
    const { snmpCheck, numberOf, stringOf, isException, indexUnder, parseOid } =
      await import('../support/snmp/index.js');

    const host = context.target.host;
    const named = context.params['interfaceName'];
    const wantedName = typeof named === 'string' ? named.trim() : '';
    const hintIndex = Number(context.params['ifIndex'] ?? 0);
    if (wantedName === '' && !Number.isInteger(hintIndex)) {
      throw new Error('this sensor names neither an interface index nor an interface name');
    }
    if (wantedName === '' && hintIndex < 1) {
      throw new Error('this sensor names neither an interface index nor an interface name');
    }

    const declared = context.params['counterWidth'];
    const width = typeof declared === 'string' ? declared : 'auto';

    return snmpCheck(context, async (session, signal) => {
      // 1. Which interface. A name is resolved every scan on purpose: the whole reason to name
      //    one is that the index may move, so caching the index would reintroduce the problem.
      let index = hintIndex;
      let resolvedBy = 'index';
      if (wantedName !== '') {
        const found = await findInterface(session, signal, wantedName, hintIndex, {
          stringOf,
          isException,
          indexUnder,
          parseOid,
        });
        if (found === null) {
          throw new Error(
            `no interface on ${host} is called "${wantedName}" — it was matched against ` +
              'ifName, ifDescr and ifAlias',
          );
        }
        index = found;
        resolvedBy = 'name';
      }

      // 2. The counters, the status and the speed, in one request.
      const use64 = width !== '32';
      const inOid = `${use64 ? HC_IN : IN}.${String(index)}`;
      const outOid = `${use64 ? HC_OUT : OUT}.${String(index)}`;
      const statusOid = `${IF_OPER_STATUS}.${String(index)}`;
      const speedOid = `${use64 ? IF_HIGH_SPEED : IF_SPEED}.${String(index)}`;

      let varbinds = await session.get([inOid, outOid, statusOid, speedOid], signal);
      let usedBits: 32 | 64 = use64 ? 64 : 32;
      let fellBack = false;

      // 3. `auto` falls back once. A device with no ifXTable answers the HC OIDs with
      //    noSuchObject rather than with an error, so this is a varbind check and not a catch.
      if (use64 && width === 'auto' && varbinds.slice(0, 2).some((v) => isException(v))) {
        varbinds = await session.get(
          [
            `${IN}.${String(index)}`,
            `${OUT}.${String(index)}`,
            statusOid,
            `${IF_SPEED}.${String(index)}`,
          ],
          signal,
        );
        usedBits = 32;
        fellBack = true;
      }

      const [inBind, outBind, statusBind, speedBind] = varbinds;
      if (inBind === undefined || outBind === undefined) {
        throw new Error(`${host} returned no counters for interface ${String(index)}`);
      }
      if (isException(inBind) || isException(outBind)) {
        throw new Error(
          `${host} has no interface ${String(index)} — it answered its traffic counters with ` +
            '"no such object", which is what an agent says about an index that does not exist',
        );
      }

      const inCounter = stringOf(inBind);
      const outCounter = stringOf(outBind);
      if (inCounter === null || outCounter === null) {
        throw new Error(`${host} returned unreadable counters for interface ${String(index)}`);
      }
      const total = (BigInt(inCounter) + BigInt(outCounter)) % (1n << BigInt(usedBits));

      const status =
        statusBind === undefined || isException(statusBind) ? null : numberOf(statusBind);
      const speed = speedBind === undefined || isException(speedBind) ? null : numberOf(speedBind);

      const channels = [
        // `value` is the lossy copy every reading carries; `counter` is the exact one the core
        // divides. `ifHCInOctets` passes 2^53 in about nine days on a 100 Gbit/s link, which is
        // where a double starts dropping low bits.
        // `counterBits` is on the *reading* and not only on the channel, because which width
        // was used is discovered here rather than declared. `auto` prefers the 64-bit counters
        // and falls back per device, so a channel declared 64-bit can legitimately be fed
        // 32-bit values — and a 32-bit wrap read as a 64-bit one looks like a device reset, so
        // every wrap would become a gap in the graph instead of a rate.
        { key: 'in', value: Number(inCounter), counter: inCounter, counterBits: usedBits },
        { key: 'out', value: Number(outCounter), counter: outCounter, counterBits: usedBits },
        {
          key: 'total',
          value: Number(total),
          counter: total.toString(),
          counterBits: usedBits,
        },
        ...(status === null ? [] : [{ key: 'status', value: status }]),
      ];

      return {
        channels,
        message: describe({ index, resolvedBy, usedBits, fellBack, status, speed, width }),
      };
    });
  },
};

interface Helpers {
  stringOf: (varbind: SnmpVarbind) => string | null;
  isException: (varbind: SnmpVarbind) => boolean;
  indexUnder: (prefix: readonly number[], oid: readonly number[]) => number[] | null;
  parseOid: (text: string) => number[];
}

/**
 * The index of the interface with this name, or null.
 *
 * Checks the hinted index first, so a device that has *not* renumbered costs one request rather
 * than three walks — which is the common case, and the walk is what makes naming an interface
 * expensive. Only when the hint disagrees does it look for the name properly.
 *
 * Three tables, in the order a person would: `ifName` is what an operator types
 * ("GigabitEthernet0/1"), `ifDescr` is what an agent volunteers and is sometimes the only one
 * populated, and `ifAlias` is the description someone configured on the port, which on a
 * well-run network is the most meaningful of the three.
 */
async function findInterface(
  session: SnmpSession,
  signal: AbortSignal,
  wanted: string,
  hint: number,
  h: Helpers,
): Promise<number | null> {
  const target = wanted.toLowerCase();

  if (Number.isInteger(hint) && hint > 0) {
    const probes = [`${IF_NAME}.${String(hint)}`, `${IF_DESCR}.${String(hint)}`];
    const found = await session.get(probes, signal).catch(() => []);
    for (const varbind of found) {
      if (h.isException(varbind)) continue;
      if ((h.stringOf(varbind) ?? '').trim().toLowerCase() === target) return hint;
    }
  }

  for (const column of [IF_NAME, IF_DESCR, IF_ALIAS]) {
    const rows = await session.walk(column, signal).catch(() => []);
    const prefix = h.parseOid(column);
    for (const varbind of rows) {
      if ((h.stringOf(varbind) ?? '').trim().toLowerCase() !== target) continue;
      const suffix = h.indexUnder(prefix, h.parseOid(varbind.oid));
      const index = suffix?.[0];
      if (index !== undefined && index > 0) return index;
    }
  }
  return null;
}

/** What an operator reads under the graph. Says which counters were used and why. */
function describe(facts: {
  index: number;
  resolvedBy: string;
  usedBits: 32 | 64;
  fellBack: boolean;
  status: number | null;
  speed: number | null;
  width: string;
}): string {
  const parts = [`interface ${String(facts.index)}`];
  if (facts.resolvedBy === 'name') parts.push('found by name');
  parts.push(`${String(facts.usedBits)}-bit counters`);
  if (facts.fellBack) {
    // Worth a sentence rather than a flag: this is the condition under which the numbers on the
    // graph may be quietly too low, and nothing else in the system can tell.
    parts.push(
      'the device has no 64-bit counters, so a link above about 20 Mbit/s may under-report',
    );
  }
  if (facts.status !== null) parts.push(`oper status ${String(facts.status)}`);
  if (facts.speed !== null && facts.speed > 0) {
    parts.push(
      facts.usedBits === 64 ? `${String(facts.speed)} Mbit/s` : `${String(facts.speed)} bit/s`,
    );
  }
  return parts.join(', ');
}
