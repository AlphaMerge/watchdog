import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import { RefusalLog } from '../src/runner/refusal-log.js';
import { pollWithin } from './support/within.js';

/**
 * Refusals logged once per episode (`P-216` part 3). `P-216c`'s probe wrote a line per refused
 * check, 99.4% of everything it logged, each saying what the `refused` channel already counts.
 */

function capture(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  ) as unknown as Logger;
  return { logger, lines };
}

/** Waits for a condition, not for a time (`P-234`). */
function until(condition: () => boolean, what: string): Promise<void> {
  return pollWithin(5_000, what, condition, 5);
}

const check = (sensorId: number) => ({
  sensorId,
  sensorType: 'port.tcp',
  queued: 1_000,
  queueMax: 1_000,
});

describe('RefusalLog (P-216 part 3)', () => {
  it('logs the first refusal in full and none of the rest', () => {
    const { logger, lines } = capture();
    const log = new RefusalLog(logger, 'check queue is full, refusing a check', {
      summaryMs: 60_000,
    });
    for (let sensor = 1; sensor <= 5_000; sensor += 1) log.refused(check(sensor));
    assert.equal(lines.length, 1, 'one line for five thousand refusals');
    const first = lines[0] ?? {};
    // The context only the first line can carry: which sensor, of which type, and the bound.
    assert.equal(first['sensorId'], 1);
    assert.equal(first['sensorType'], 'port.tcp');
    assert.equal(first['queueMax'], 1_000);
    assert.equal(first['level'], 40);
    assert.match(String(first['msg']), /^check queue is full, refusing a check; /);
    log.stop();
  });

  it('summarises with counts only while refusing goes on, and ends with one line', async () => {
    const { logger, lines } = capture();
    const log = new RefusalLog(logger, 'check queue is full, refusing a check', { summaryMs: 40 });
    log.refused(check(1));
    log.refused(check(2));
    log.refused(check(3));
    await until(() => lines.length >= 2, 'a summary');
    const summary = lines[1] ?? {};
    assert.equal(summary['msg'], 'still refusing checks at a full queue');
    assert.equal(summary['refused'], 2, 'what was refused since the last line');
    assert.equal(summary['refusedInEpisode'], 3);
    // Counts only: the sensor that happened to be refused last says nothing about the episode.
    assert.equal('sensorId' in summary, false);
    // A quiet interval, and the episode is over.
    await until(() => !log.refusing, 'the episode to end');
    const end = lines.at(-1) ?? {};
    assert.equal(end['msg'], 'no longer refusing checks');
    assert.equal(end['refusedInEpisode'], 3);
    assert.equal(lines.length, 3);
  });

  it('opens a new episode, in full again, after one has ended', async () => {
    const { logger, lines } = capture();
    const log = new RefusalLog(logger, 'process-runner queue is full, refusing a check', {
      summaryMs: 20,
    });
    log.refused(check(7));
    await until(() => !log.refusing, 'the first episode to end');
    log.refused(check(8));
    const opened = lines.filter((line) => 'sensorId' in line);
    assert.deepEqual(
      opened.map((line) => line['sensorId']),
      [7, 8],
    );
    log.stop();
    assert.equal(lines.at(-1)?.['msg'], 'no longer refusing checks', 'stop ends it with its line');
  });
});
