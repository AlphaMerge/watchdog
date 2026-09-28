import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { ConfigError } from '../src/errors/app-error.js';
import { waitForLocalAddress } from '../src/lifecycle/address-wait.js';
import { EX_CONFIG, startFailure } from '../src/lifecycle/exit.js';
import type { Logger } from '../src/logging/logger.js';

describe('startFailure (P-222)', () => {
  it('exits 78 for a refusal only a person can fix, which the units do not restart', () => {
    const { status, line } = startFailure(new ConfigError('PostgreSQL refused the password'));
    assert.equal(status, EX_CONFIG);
    assert.equal(status, 78);
    assert.equal(line, 'Configuration error: PostgreSQL refused the password\n');
  });

  it('exits 1 for anything else, which systemd restarts', () => {
    const { status, line } = startFailure(new Error('the unexpected'));
    assert.equal(status, 1);
    assert.equal(line, 'fatal: the unexpected\n');
  });
});

describe('waitForLocalAddress (P-222)', () => {
  function harness(appearsAfterMs: number | null, maxWaitMs = 60_000) {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'info' },
      { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    ) as unknown as Logger;
    const extended: { status: string; ms: number }[] = [];
    let clock = 0;
    const result = waitForLocalAddress({
      address: '10.1.2.3',
      what: 'syslog listener',
      logger,
      starting: (status, ms) => extended.push({ status, ms }),
      maxWaitMs,
      addresses: () =>
        appearsAfterMs !== null && clock >= appearsAfterMs
          ? ['127.0.0.1', '10.1.2.3']
          : ['127.0.0.1'],
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    });
    return { lines, extended, result, clock: () => clock };
  }

  for (const address of ['0.0.0.0', '::', 'localhost', '127.0.0.1', '127.0.1.1', '::1']) {
    it(`returns at once for ${address}`, async () => {
      await waitForLocalAddress({
        address,
        what: 'API',
        logger: pino({ level: 'silent' }),
        addresses: () => [],
        sleep: () => Promise.reject(new Error('should not wait')),
      });
    });
  }

  // The smoke box: `os.networkInterfaces()` throws `uv_interface_addresses returned Unknown system
  // error 97` there, and the core's API on 127.0.0.1 exited 1 before it bound anything.
  it('does not wait, or fail the start, when the host cannot say what addresses it has', async () => {
    const lines: Record<string, unknown>[] = [];
    await waitForLocalAddress({
      address: '10.1.2.3',
      what: 'syslog listener',
      logger: pino(
        { level: 'info' },
        { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
      ),
      addresses: () => {
        throw new Error(
          'A system error occurred: uv_interface_addresses returned Unknown system error 97',
        );
      },
      sleep: () => Promise.reject(new Error('should not wait')),
    });
    assert.ok(lines.some((line) => /cannot read this host's addresses/.test(String(line['msg']))));
  });

  it('waits for an address assigned late at boot, keeping systemd waiting and saying why', async () => {
    const h = harness(40_000);
    await h.result;
    assert.equal(h.clock(), 40_000);
    // One report at once and one per fifteen seconds, each asking for the next report's worth.
    assert.equal(h.extended.length, 3);
    assert.match(
      h.extended[0]?.status ?? '',
      /waiting for 10\.1\.2\.3 to be assigned to this host, for the syslog listener/,
    );
    assert.ok(h.extended.every((call) => call.ms === 20_000));
    assert.ok(
      h.lines.some((line) => line['level'] === 30 && /is assigned/.test(String(line['msg']))),
    );
  });

  it('gives up at the bound, so the process exits and systemd starts it again', async () => {
    const h = harness(null, 30_000);
    await assert.rejects(
      h.result,
      /10\.1\.2\.3, which the syslog listener is configured to listen on, did not appear/,
    );
    assert.equal(h.clock(), 30_000);
  });
});
