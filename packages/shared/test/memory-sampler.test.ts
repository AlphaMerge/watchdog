import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  AvailableMemoryWatch,
  MEMORY_SAMPLE_INTERVAL_MS,
  MemorySampler,
  type AvailableMemory,
} from '../src/index.js';

/**
 * The timer both services read memory on (`P-218`).
 *
 * What it has to get right is small and easy to get wrong in the caller: read at once rather than
 * an interval later, read the machine and the ceiling at the same moment, keep going on its own,
 * and stop.
 */
describe('reading memory on a timer of its own', () => {
  function counting(): { watch: AvailableMemoryWatch; reads: () => number } {
    let reads = 0;
    const read = (): AvailableMemory => {
      reads += 1;
      return { availableBytes: 50, totalBytes: 100 };
    };
    return { watch: new AvailableMemoryWatch({ read }), reads: () => reads };
  }

  it('reads both at once when started, then both every interval, until stopped', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const machine = counting();
    const limit = counting();
    const sampler = new MemorySampler({ machine: machine.watch, limit: limit.watch });

    sampler.start();
    // At once: a service that has just started has a reading before its first report.
    assert.deepEqual([machine.reads(), limit.reads()], [1, 1]);
    t.mock.timers.tick(MEMORY_SAMPLE_INTERVAL_MS * 5);
    assert.deepEqual([machine.reads(), limit.reads()], [6, 6]);

    sampler.stop();
    t.mock.timers.tick(MEMORY_SAMPLE_INTERVAL_MS * 5);
    assert.deepEqual([machine.reads(), limit.reads()], [6, 6]);
  });

  it('starts one timer however often it is started', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const machine = counting();
    const sampler = new MemorySampler({ machine: machine.watch, limit: counting().watch });
    sampler.start();
    sampler.start();
    t.mock.timers.tick(MEMORY_SAMPLE_INTERVAL_MS);
    assert.equal(machine.reads(), 2);
    sampler.stop();
  });
});
