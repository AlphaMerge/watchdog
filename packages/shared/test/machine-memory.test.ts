import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  AvailableMemoryWatch,
  readMachineMemory,
  type MachineMemory,
  type MachineMemorySources,
} from '../src/index.js';

/**
 * What the machine has left (`P-208`).
 *
 * The two ways this goes wrong are both a confident wrong number rather than an error: `MemFree`
 * read as available, which on a database host is a fraction of the truth, and a reading the
 * platform could not give turned into a zero — which on a channel with a lower limit is the alarm.
 */

const MIB = 1024 * 1024;

// `P-206`'s VM, from the dev toolchain container: 7,936 MiB, 6,096 of it available, 1,485 free.
const MEMINFO = [
  'MemTotal:        8126464 kB',
  'MemFree:         1520640 kB',
  'MemAvailable:    6242304 kB',
  'Buffers:           94208 kB',
  'Cached:          4403200 kB',
  'HugePages_Total:       0',
].join('\n');

function linux(meminfo: string | (() => string)): MachineMemorySources {
  return {
    platform: 'linux',
    readMeminfo: typeof meminfo === 'string' ? () => meminfo : meminfo,
    freemem: () => assert.fail('Linux reads /proc/meminfo, not os.freemem()'),
    totalmem: () => assert.fail('Linux reads /proc/meminfo, not os.totalmem()'),
  };
}

describe('reading what the machine has left', () => {
  it('reads MemAvailable on Linux, not MemFree', () => {
    assert.deepEqual(readMachineMemory(linux(MEMINFO)), {
      availableBytes: 6_096 * MIB,
      totalBytes: 7_936 * MIB,
    });
  });

  it('gaps a kernel without MemAvailable rather than falling back to MemFree', () => {
    // Older than 3.14. libuv's os.freemem() falls back to MemFree here without saying so, which
    // is exactly why Linux does not go through it.
    const old = 'MemTotal:        8126464 kB\nMemFree:         1520640 kB\n';
    assert.equal(readMachineMemory(linux(old)), null);
  });

  it('gaps a machine with no /proc to read', () => {
    const missing = linux(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
    assert.equal(readMachineMemory(missing), null);
  });

  it('gaps a reading with more available than total, which a virtualised meminfo gives (P-224)', () => {
    // lxcfs and OpenVZ have both served one. 100% would be a reading nobody took, and the
    // protocol's bound on the percentage made it worse than wrong: the core dropped the link.
    const lxc = MEMINFO.replace('MemAvailable:    6242304 kB', 'MemAvailable:    8150000 kB');
    assert.equal(readMachineMemory(linux(lxc)), null);
    // Exactly the total is a machine with nothing in use, which is odd but not impossible.
    const idle = MEMINFO.replace('MemAvailable:    6242304 kB', 'MemAvailable:    8126464 kB');
    assert.deepEqual(readMachineMemory(linux(idle)), {
      availableBytes: 7_936 * MIB,
      totalBytes: 7_936 * MIB,
    });
    assert.equal(
      readMachineMemory({
        platform: 'win32',
        readMeminfo: () => assert.fail('Windows has no /proc/meminfo'),
        freemem: () => 17_000 * MIB,
        totalmem: () => 16_000 * MIB,
      }),
      null,
      'the same rule off Linux',
    );
  });

  it('uses what Windows calls available', () => {
    const memory = readMachineMemory({
      platform: 'win32',
      readMeminfo: () => assert.fail('Windows has no /proc/meminfo'),
      freemem: () => 3_000 * MIB,
      totalmem: () => 16_000 * MIB,
    });
    assert.deepEqual(memory, { availableBytes: 3_000 * MIB, totalBytes: 16_000 * MIB });
  });

  it('gaps a platform whose free count is not what is available', () => {
    // macOS counts free pages — MemFree's mistake — and is not a platform this is installed on.
    const memory = readMachineMemory({
      platform: 'darwin',
      readMeminfo: () => assert.fail('no /proc on macOS'),
      freemem: () => 1,
      totalmem: () => 2,
    });
    assert.equal(memory, null);
  });

  it('reads the machine it is running on without throwing', () => {
    // Not a claim about the number, which is this machine's; a claim that the live path works.
    const memory = readMachineMemory();
    if (process.platform === 'linux' || process.platform === 'win32') {
      assert.ok(memory !== null && memory.availableBytes <= memory.totalBytes);
    } else {
      assert.equal(memory, null);
    }
  });
});

describe('the lowest reading in the window', () => {
  function watch(script: (MachineMemory | null)[]): {
    watch: AvailableMemoryWatch;
    advance: (ms: number) => void;
  } {
    let now = 0;
    let index = 0;
    const read = (): MachineMemory | null => {
      const next = script[index];
      index += 1;
      return next === undefined ? null : next;
    };
    return {
      watch: new AvailableMemoryWatch({ windowMs: 30_000, read, now: () => now }),
      advance: (ms) => {
        now += ms;
      },
    };
  }

  const total = 7_936 * MIB;
  const at = (mib: number): MachineMemory => ({ availableBytes: mib * MIB, totalBytes: total });

  it('reports the low of the window, not the latest', () => {
    // `P-206`'s squeeze: 675 MiB, 30 MiB and a kernel kill, then 2,230 MiB once the kill had
    // freed the memory — which is the only number a latest-value channel would have recorded.
    const { watch: w, advance } = watch([at(675), at(30), at(2_230)]);
    w.sample();
    advance(2_000);
    w.sample();
    advance(2_000);
    w.sample();
    assert.deepEqual(w.lowest(), {
      availablePercent: 0.4,
      availableBytes: 30 * MIB,
      totalBytes: total,
    });
  });

  it('forgets a low once it is older than the window', () => {
    const { watch: w, advance } = watch([at(30), at(2_230)]);
    w.sample();
    advance(31_000);
    w.sample();
    assert.equal(w.lowest()?.availableBytes, 2_230 * MIB);
  });

  it('takes the lowest since it was last taken, each reading once, however long ago (P-219)', () => {
    // The probe's report at protocol 20: each heartbeat takes what was read since the one before,
    // so that the core, folding the reports between two records, puts each low in one record.
    const { watch: w, advance } = watch([at(675), at(30), at(2_230), at(1_000), null]);
    assert.equal(w.takeLow(), null, 'nothing read yet');
    w.sample();
    advance(2_000);
    w.sample();
    advance(2_000);
    w.sample();
    assert.equal(w.takeLow()?.availableBytes, 30 * MIB);
    assert.equal(w.takeLow(), null, 'taken, so not taken twice');
    // Longer than the window ago, as across an outage: still taken, because nothing took it.
    advance(60_000);
    w.sample();
    advance(60_000);
    w.sample();
    assert.equal(w.lowest(), null, 'the window has nothing: the last reading was a gap');
    assert.deepEqual(w.takeLow(), {
      availablePercent: 12.6,
      availableBytes: 1_000 * MIB,
      totalBytes: total,
    });
  });

  it('is a gap before the first reading, and when the platform cannot say', () => {
    const { watch: w } = watch([null, null]);
    assert.equal(w.lowest(), null, 'nothing sampled yet');
    w.sample();
    w.sample();
    assert.equal(w.lowest(), null, 'nothing a platform could give');
  });

  it('becomes a gap again once its last reading has aged out', () => {
    // A probe whose heartbeat stopped while it was disconnected must not report a thirty-second
    // low from before the outage as though it were current.
    const { watch: w, advance } = watch([at(1_000)]);
    w.sample();
    advance(30_001);
    assert.equal(w.lowest(), null);
  });

  it('reads past a total as negative, which a throttled cgroup can be', () => {
    // `P-210`: past `memory.high` the kernel throttles a cgroup rather than stopping it, so its
    // working set stands above the ceiling. Clamping that to zero would hide how far past it is.
    const { watch: w } = watch([{ availableBytes: -34 * MIB, totalBytes: 200 * MIB }]);
    w.sample();
    assert.equal(w.lowest()?.availablePercent, -17);
  });

  it('gives the percentage of the same reading the bytes came from', () => {
    const { watch: w } = watch([at(1_860)]);
    w.sample();
    assert.equal(w.lowest()?.availablePercent, 23.4);
  });
});
