import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readLimitMemory, type LimitMemorySources } from '../src/index.js';

/**
 * How close a process's cgroup is to its memory ceiling (`P-210`).
 *
 * The mistakes this guards against each produce a confident wrong number: `memory.current` read as
 * usage, which page cache fills to the ceiling on purpose; `memory.max` read as the ceiling on a
 * unit whose `MemoryHigh` stops the process first; and a limit on a parent slice missed because
 * only the process's own cgroup was read.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** A cgroup filesystem as a map of path to contents. A path not in it does not exist. */
function cgroups(files: Record<string, string>): LimitMemorySources {
  return {
    platform: 'linux',
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return contents;
    },
  };
}

const SERVICE = '/sys/fs/cgroup/system.slice/ms-probe.service';
const SLICE = '/sys/fs/cgroup/system.slice';

function stat(inactiveFile: number): string {
  return [
    `anon ${String(2 * GIB)}`,
    `file ${String(inactiveFile)}`,
    `inactive_file ${String(inactiveFile)}`,
  ].join('\n');
}

/** The stock `ms-probe.service` since `P-213`: `MemoryMax=6G`, and no `MemoryHigh`. */
function stockUnit(current: number, inactiveFile = 0): Record<string, string> {
  return {
    '/proc/self/cgroup': '0::/system.slice/ms-probe.service\n',
    [`${SERVICE}/memory.high`]: 'max\n',
    [`${SERVICE}/memory.max`]: `${String(6 * GIB)}\n`,
    [`${SERVICE}/memory.current`]: `${String(current)}\n`,
    [`${SERVICE}/memory.stat`]: stat(inactiveFile),
    [`${SLICE}/memory.high`]: 'max\n',
    [`${SLICE}/memory.max`]: 'max\n',
    [`${SLICE}/memory.current`]: `${String(9 * GIB)}\n`,
    [`${SLICE}/memory.stat`]: stat(0),
    // The real root has no memory.max, memory.high or memory.current at all.
  };
}

describe('reading how close a cgroup is to its ceiling', () => {
  it('measures the stock unit against MemoryMax, its only ceiling', () => {
    const memory = readLimitMemory(cgroups(stockUnit(3 * GIB)));
    assert.deepEqual(memory, { availableBytes: 3 * GIB, totalBytes: 6 * GIB });
  });

  it('takes a MemoryHigh below MemoryMax as the ceiling, because it acts first', () => {
    // Past memory.high the kernel throttles; past memory.max it kills. The stock units set no
    // MemoryHigh (`P-213`), but an operator's drop-in may, and the probe stops working there.
    const files = stockUnit(3 * GIB);
    files[`${SERVICE}/memory.high`] = `${String(4 * GIB)}\n`;
    assert.deepEqual(readLimitMemory(cgroups(files)), {
      availableBytes: 1 * GIB,
      totalBytes: 4 * GIB,
    });
  });

  it('measures the working set, not memory.current, because page cache fills to the ceiling', () => {
    // Measured: 400 MB written through a 200 MiB memory.high held memory.current at 198 MiB with a
    // working set of 6 MiB and the cgroup never stalled.
    const memory = readLimitMemory(cgroups(stockUnit(4 * GIB, 3.5 * GIB)));
    assert.deepEqual(memory, { availableBytes: 5.5 * GIB, totalBytes: 6 * GIB });
  });

  it('reads past the ceiling as negative, because a throttled cgroup stands above it', () => {
    // Measured: 234 MiB against a 200 MiB memory.high, 30 seconds into being throttled.
    const files = stockUnit(0);
    files['/proc/self/cgroup'] = '0::/\n';
    files['/sys/fs/cgroup/memory.high'] = String(200 * MIB);
    files['/sys/fs/cgroup/memory.max'] = String(600 * MIB);
    files['/sys/fs/cgroup/memory.current'] = String(234 * MIB);
    files['/sys/fs/cgroup/memory.stat'] = 'inactive_file 0\n';
    assert.deepEqual(readLimitMemory(cgroups(files)), {
      availableBytes: -34 * MIB,
      totalBytes: 200 * MIB,
    });
  });

  it('finds a tighter limit on a parent slice, measured against everything under it', () => {
    // A slice limit binds the probe as surely as its own, and the slice's usage includes siblings.
    const files = stockUnit(1 * GIB);
    files[`${SLICE}/memory.high`] = `${String(10 * GIB)}\n`;
    files[`${SLICE}/memory.current`] = `${String(9.5 * GIB)}\n`;
    assert.deepEqual(readLimitMemory(cgroups(files)), {
      availableBytes: 0.5 * GIB,
      totalBytes: 10 * GIB,
    });
  });

  it('reads a container’s own limit at the root of its namespace', () => {
    // `docker run --memory=512m`, measured: /proc/self/cgroup is `0::/`, memory.max is 536870912.
    const memory = readLimitMemory(
      cgroups({
        '/proc/self/cgroup': '0::/\n',
        '/sys/fs/cgroup/memory.high': 'max\n',
        '/sys/fs/cgroup/memory.max': '536870912\n',
        '/sys/fs/cgroup/memory.current': '1777664\n',
        '/sys/fs/cgroup/memory.stat': 'inactive_file 0\n',
      }),
    );
    assert.deepEqual(memory, { availableBytes: 536_870_912 - 1_777_664, totalBytes: 536_870_912 });
  });

  it('is a gap where nothing up the tree has a limit', () => {
    const files = stockUnit(1 * GIB);
    files[`${SERVICE}/memory.max`] = 'max\n';
    assert.equal(readLimitMemory(cgroups(files)), null);
  });

  it('is a gap on cgroup v1, which has no MemoryHigh', () => {
    const memory = readLimitMemory(
      cgroups({
        '/proc/self/cgroup': '11:memory:/system.slice/ms-probe.service\n1:name=systemd:/\n',
      }),
    );
    assert.equal(memory, null);
  });

  it('is a gap on a hybrid host, whose v2 hierarchy carries no memory controller', () => {
    const memory = readLimitMemory(
      cgroups({
        '/proc/self/cgroup':
          '11:memory:/system.slice/ms-probe.service\n0::/system.slice/ms-probe.service\n',
      }),
    );
    assert.equal(memory, null);
  });

  it('is a gap for a cgroup outside this namespace, rather than reading somewhere else', () => {
    const memory = readLimitMemory(cgroups({ '/proc/self/cgroup': '0::/../../elsewhere\n' }));
    assert.equal(memory, null);
  });

  it('is a gap off Linux, where WinSW sets no limit', () => {
    const memory = readLimitMemory({
      platform: 'win32',
      readFile: () => assert.fail('nothing to read on Windows'),
    });
    assert.equal(memory, null);
  });

  it('reads the cgroup it is running in without throwing', () => {
    // Not a claim about the number, which is this machine's; a claim that the live path works.
    const memory = readLimitMemory();
    if (memory !== null) assert.ok(memory.totalBytes > 0);
  });
});
