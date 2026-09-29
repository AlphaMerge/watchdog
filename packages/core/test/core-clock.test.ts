import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { coreHealth } from '@ms/sensors';
import {
  CORE_CLOCK_BEHIND_SECONDS,
  judgeCoreClock,
  remoteClockOffsets,
} from '../src/health/core-clock.js';
import { DEFAULT_MAX_FUTURE_SKEW_MS } from '../src/ingestion/service.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';

const MINUTE = 60_000;

describe('whether the core’s own clock is behind (P-247)', () => {
  // Offsets as the core measures them: positive is a probe behind, negative one ahead.
  const table: {
    readonly name: string;
    readonly offsets: readonly (number | null)[];
    readonly behindSeconds: number | null;
    readonly owned: boolean;
  }[] = [
    { name: 'no probes', offsets: [], behindSeconds: null, owned: false },
    { name: 'one probe far ahead', offsets: [-20 * MINUTE], behindSeconds: null, owned: false },
    {
      name: 'two probes, one not yet measured',
      offsets: [-20 * MINUTE, null],
      behindSeconds: null,
      owned: false,
    },
    {
      name: 'two probes far ahead',
      offsets: [-20 * MINUTE, -21 * MINUTE],
      behindSeconds: 1_200,
      owned: true,
    },
    {
      name: 'the smallest lead is the reading',
      offsets: [-5 * MINUTE, -2 * MINUTE, -9 * MINUTE],
      behindSeconds: 120,
      owned: true,
    },
    {
      name: 'one probe not ahead',
      offsets: [-20 * MINUTE, -20 * MINUTE, 3_000],
      behindSeconds: 0,
      owned: false,
    },
    {
      name: 'one probe exactly on time',
      offsets: [-20 * MINUTE, 0],
      behindSeconds: 0,
      owned: false,
    },
    { name: 'all a little ahead', offsets: [-30_000, -45_000], behindSeconds: 30, owned: false },
    {
      name: 'exactly a minute is not over it',
      offsets: [-MINUTE, -2 * MINUTE],
      behindSeconds: 60,
      owned: false,
    },
    { name: 'just over a minute', offsets: [-61_000, -2 * MINUTE], behindSeconds: 61, owned: true },
    { name: 'tenths kept', offsets: [-61_240, -70_000], behindSeconds: 61.2, owned: true },
  ];
  for (const row of table) {
    it(`reads ${row.name}`, () => {
      assert.deepEqual(judgeCoreClock(row.offsets), {
        behindSeconds: row.behindSeconds,
        owned: row.owned,
      });
    });
  }

  it('leaves out the local probe and any probe not connected', () => {
    const at = new Date();
    const link = (offset: number | null): ProbeLink => ({
      connected: true,
      gid: 'g',
      protocolVersion: 1,
      connectedAt: at,
      lastHeartbeatAt: at,
      approved: true,
      agentVersion: '1',
      assignedSensors: 0,
      cadenceSeconds: null,
      lastResultsAt: null,
      configSentAt: null,
      connectedForMs: 0,
      sinceResultsMs: null,
      sinceConfigMs: null,
      configured: true,
      configurable: true,
      clockOffsetMs: offset,
    });
    const links = new Map<number, ProbeLink>([
      [1, link(0)],
      [2, link(-20 * MINUTE)],
      [3, { connected: false }],
      [4, link(-21 * MINUTE)],
    ]);
    assert.deepEqual(
      remoteClockOffsets([1, 2, 3, 4], new Set([1]), (id) => links.get(id) ?? { connected: false }),
      [-20 * MINUTE, -21 * MINUTE],
    );
  });

  it('warns where Probe Health’s clock warning is, and errors where ingestion refuses all', () => {
    const limits = coreHealth.channels({}).find((channel) => channel.key === 'clockBehind')?.limits;
    assert.ok(limits !== undefined, 'clockBehind declares limits');
    assert.equal(limits.upperWarning, CORE_CLOCK_BEHIND_SECONDS);
    assert.equal(limits.upperError, DEFAULT_MAX_FUTURE_SKEW_MS / 1_000);
  });
});
