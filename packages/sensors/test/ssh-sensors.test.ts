import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sshDiskFree } from '../src/types/ssh-disk-free.js';
import { sshLoad } from '../src/types/ssh-load.js';
import { sshMeminfo } from '../src/types/ssh-meminfo.js';
import { sshScript } from '../src/types/ssh-script.js';
import { standardCatalogue } from '../src/index.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';
import { TestSshServer } from '@ms/simulators';
import { assertDeclaresEveryKey } from './support/declared-keys.js';
import { pollWithin, within } from './support/within.js';

let server: TestSshServer;

before(async () => {
  server = await TestSshServer.start();
});

after(async () => {
  await server.stop();
});

beforeEach(() => {
  server.reset();
});

function run(
  type: SensorType,
  params: Record<string, unknown> = {},
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return type.execute({
    sensorId: 1,
    target: { host: server.host, ipVersion: 'v4' },
    params: { port: server.port, connectTimeoutMs: 5_000, commandTimeoutMs: 5_000, ...params },
    credentials: {
      ssh: {
        username: 'monitor',
        password: 'monitor',
        // Checking is exercised in `ssh-session.test.ts`; here the point is what the sensors do
        // with the output, and `accept-any` also proves the note reaches the message.
        hostKeyPolicy: 'accept-any',
      },
    },
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

const DF = [
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  '/dev/sda1        104857600  41943040  62914560      40% /',
].join('\n');

const MEMINFO = [
  'MemTotal:        8126756 kB',
  'MemFree:         2886860 kB',
  'MemAvailable:    5292996 kB',
  'Buffers:           54220 kB',
  'Cached:          2776116 kB',
  'SwapTotal:       1048572 kB',
  'SwapFree:         498612 kB',
].join('\n');

const LOAD_COMMAND =
  '(cat /proc/loadavg 2>/dev/null || uptime); (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo)';

describe('ssh.script', () => {
  const CHANNELS = [
    { key: 'queue', name: 'Queue depth', unit: 'jobs' },
    { key: 'temperature', name: 'Inlet temperature', unit: '°C' },
  ];

  it('reports what the script printed', async () => {
    server.answer('./check.sh', { stdout: 'queue:12\ntemperature:41.5\nmessage:all good\n' });
    const execution = await run(sshScript, { command: './check.sh', channels: CHANNELS });
    assert.equal(valueOf(execution, 'queue'), 12);
    assert.equal(valueOf(execution, 'temperature'), 41.5);
    assert.match(execution.message ?? '', /all good/);
  });

  it('fails with the script’s own words when it exits non-zero', async () => {
    // How a script refuses to answer — "the database is not running, I cannot measure query
    // time" — rather than reporting a zero somebody would graph.
    server.answer('./check.sh', { stderr: 'database is not running\n', code: 2 });
    await assert.rejects(
      () => run(sshScript, { command: './check.sh', channels: CHANNELS }),
      /exited 2 on 127\.0\.0\.1: database is not running/,
    );
  });

  it('says when the script reported a channel this sensor has not got', async () => {
    // How an operator finds out their script and their sensor have drifted apart. Dropping it
    // silently would leave a reading nobody knows is being thrown away.
    server.answer('./check.sh', { stdout: 'queue:12\ntemperature:41\nlatency:8\n' });
    const execution = await run(sshScript, { command: './check.sh', channels: CHANNELS });
    assert.match(
      execution.message ?? '',
      /also reported latency, which this sensor has no channel for/,
    );
  });

  it('gaps a channel the script stopped printing, and says so', async () => {
    server.answer('./check.sh', { stdout: 'queue:12\n' });
    const execution = await run(sshScript, { command: './check.sh', channels: CHANNELS });
    assert.deepEqual(
      execution.channels.map((channel) => channel.key),
      ['queue'],
    );
    assert.match(execution.message ?? '', /reported nothing for temperature/);
  });

  it('fails when nothing it printed matches a declared channel', async () => {
    server.answer('./check.sh', { stdout: 'latency:8\n' });
    await assert.rejects(
      () => run(sshScript, { command: './check.sh', channels: CHANNELS }),
      /produced no reading this sensor declares a channel for — it reported latency/,
    );
  });

  it('takes a bare number against a channel called value', async () => {
    server.answer('./temp.sh', { stdout: '41.5\n' });
    const execution = await run(sshScript, {
      command: './temp.sh',
      channels: [{ key: 'value', name: 'Temperature', unit: '°C' }],
    });
    assert.equal(valueOf(execution, 'value'), 41.5);
  });

  it('makes the first declared channel the one the sensor is judged by', () => {
    const defs = sshScript.channels({ channels: CHANNELS });
    assert.deepEqual(
      defs.filter((def) => def.isPrimary === true).map((def) => def.key),
      ['queue'],
    );
    assert.equal(defs[1]?.unit, '°C');
  });
});

describe('ssh.diskfree', () => {
  it('reports a filesystem in bytes with a percentage the device did not give it', async () => {
    server.answer("df -P -k '/'", { stdout: DF });
    const execution = await run(sshDiskFree, { path: '/' });
    assert.equal(valueOf(execution, 'total'), 100 * 1024 ** 3);
    assert.equal(valueOf(execution, 'used'), 40 * 1024 ** 3);
    assert.equal(valueOf(execution, 'free'), 60 * 1024 ** 3);
    assert.equal(valueOf(execution, 'percentUsed'), 40);
  });

  it('quotes the path, so one with a space is one argument', async () => {
    server.answer("df -P -k '/mnt/my disk'", { stdout: DF });
    await run(sshDiskFree, { path: '/mnt/my disk' });
    assert.deepEqual(server.seen, ["df -P -k '/mnt/my disk'"]);
  });

  it('escapes a quote in the path rather than breaking out of it', async () => {
    // A path is operator input reaching a shell. The single-quote escape is the only form that
    // is safe for every path, and getting it wrong is a command injection.
    await run(sshDiskFree, { path: "/mnt/it's" }).catch(() => undefined);
    assert.deepEqual(server.seen, ["df -P -k '/mnt/it'\\''s'"]);
  });

  it('fails with what df said when it could not read the path', async () => {
    server.answer("df -P -k '/nope'", {
      stderr: 'df: /nope: No such file or directory\n',
      code: 1,
    });
    await assert.rejects(
      () => run(sshDiskFree, { path: '/nope' }),
      /df could not read \/nope on 127\.0\.0\.1: df: \/nope: No such file/,
    );
  });

  it('fails rather than reporting zero when df said nothing it could read', async () => {
    server.answer("df -P -k '/'", { stdout: 'something unexpected\n' });
    await assert.rejects(() => run(sshDiskFree, { path: '/' }), /df reported nothing for \//);
  });

  it('uses the same channel names as the SNMP disk sensor', () => {
    // An operator watching a Linux box over SSH and a switch over SNMP should not have to learn
    // two vocabularies for "how full is it", and a summary graph across both should line up.
    const catalogue = standardCatalogue();
    assert.deepEqual(
      catalogue.channelsFor('ssh.diskfree', {}).map((channel) => channel.key),
      catalogue.channelsFor('snmp.diskfree', { mountPoint: '/' }).map((channel) => channel.key),
    );
  });
});

describe('ssh.load', () => {
  it('divides the load by the processor count, in one round trip', async () => {
    // A load of 4 is idle on a 32-core box and desperate on a single-core one. The per-processor
    // figure is the only one of the four that means the same thing on two machines.
    server.answer(LOAD_COMMAND, { stdout: '2.00 1.50 1.00 1/234 5678\n8\n' });
    const execution = await run(sshLoad);
    assert.equal(valueOf(execution, 'load1'), 2);
    assert.equal(valueOf(execution, 'load5'), 1.5);
    assert.equal(valueOf(execution, 'load15'), 1);
    assert.equal(valueOf(execution, 'processors'), 8);
    assert.equal(valueOf(execution, 'loadPerCpu'), 0.25);
    assert.equal(server.seen.length, 1, 'both facts should come from one command');
  });

  it('gaps the per-processor figure rather than falling back to the raw one', async () => {
    // A per-processor load that is secretly the whole-machine one is a number somebody would
    // set a limit against.
    server.answer(LOAD_COMMAND, { stdout: '2.00 1.50 1.00 1/234 5678\n\n' });
    const execution = await run(sshLoad);
    assert.equal(valueOf(execution, 'loadPerCpu'), undefined);
    assert.equal(valueOf(execution, 'processors'), undefined);
    assert.equal(valueOf(execution, 'load1'), 2);
    assert.match(execution.message ?? '', /did not report a processor count/);
  });

  it('falls back to uptime on a host with no /proc/loadavg', async () => {
    server.answer(LOAD_COMMAND, {
      stdout: '11:04  up 3 days, 2 users, load averages: 1.53 1.72 1.80\n4\n',
    });
    const execution = await run(sshLoad);
    assert.equal(valueOf(execution, 'load1'), 1.53);
    assert.equal(valueOf(execution, 'processors'), 4);
  });

  it('fails rather than guessing when neither answered', async () => {
    server.answer(LOAD_COMMAND, { stdout: '\n\n' });
    await assert.rejects(() => run(sshLoad), /reported no load average/);
  });
});

describe('ssh.meminfo', () => {
  it('uses the kernel’s own MemAvailable, which is the number SNMP has to approximate', async () => {
    // `snmp.memory` measured a 2819 MiB against a true 5169 MiB gap on the same kind of box —
    // 64% used against 35%. Over SSH the kernel answers the right question directly.
    server.answer('cat /proc/meminfo', { stdout: MEMINFO });
    const execution = await run(sshMeminfo);
    assert.equal(valueOf(execution, 'available'), 5_292_996 * 1024);
    assert.equal(valueOf(execution, 'total'), 8_126_756 * 1024);
    assert.equal(valueOf(execution, 'percentUsed'), 34.87);
    assert.match(execution.message ?? '', /available from MemAvailable/);
  });

  it('falls back on a kernel too old for MemAvailable, and says which it used', async () => {
    const old = MEMINFO.split('\n')
      .filter((line) => !line.startsWith('MemAvailable'))
      .join('\n');
    server.answer('cat /proc/meminfo', { stdout: old });
    const execution = await run(sshMeminfo);
    assert.equal(valueOf(execution, 'available'), (2_886_860 + 54_220 + 2_776_116) * 1024);
    assert.match(execution.message ?? '', /MemFree \+ Buffers \+ Cached/);
  });

  it('reports swap as its own pair, and gaps it on a host with none', async () => {
    server.answer('cat /proc/meminfo', { stdout: MEMINFO });
    assert.equal(valueOf(await run(sshMeminfo), 'swapPercentUsed'), 52.45);

    const noSwap = MEMINFO.split('\n')
      .filter((line) => !line.startsWith('Swap'))
      .join('\n');
    server.answer('cat /proc/meminfo', { stdout: noSwap });
    const execution = await run(sshMeminfo);
    assert.equal(valueOf(execution, 'swapPercentUsed'), undefined);
    assert.equal(valueOf(execution, 'swapAvailable'), undefined);
  });

  it('points at the right sensor when the host is not Linux', async () => {
    server.answer('cat /proc/meminfo', {
      stderr: 'cat: /proc/meminfo: No such file or directory\n',
      code: 1,
    });
    await assert.rejects(
      () => run(sshMeminfo),
      /this sensor is for a Linux host; use SSH Script elsewhere/,
    );
  });

  it('uses the same channel names as the SNMP memory sensor', () => {
    const catalogue = standardCatalogue();
    assert.deepEqual(
      catalogue.channelsFor('ssh.meminfo', {}).map((channel) => channel.key),
      catalogue.channelsFor('snmp.memory', {}).map((channel) => channel.key),
    );
  });
});

describe('all four types', () => {
  const types = [sshDiskFree, sshLoad, sshMeminfo, sshScript];

  it('declare exactly one primary channel', () => {
    for (const type of types) {
      assert.equal(type.channels({}).filter((c) => c.isPrimary === true).length, 1, type.id);
    }
  });

  it('report only keys their declaration names, on each path (P-320)', async () => {
    // `ssh.script` included: what the script printed beyond its declared channels is named in
    // the message and never reported, in each of the output forms it reads.
    const script = {
      command: './check.sh',
      channels: [
        { key: 'queue', name: 'Queue depth', unit: 'jobs' },
        { key: 'temperature', name: 'Inlet temperature', unit: '°C' },
      ],
    };
    const noSwap = MEMINFO.split('\n')
      .filter((line) => !line.startsWith('Swap'))
      .join('\n');
    const oldKernel = MEMINFO.split('\n')
      .filter((line) => !line.startsWith('MemAvailable'))
      .join('\n');
    const cases: [SensorType, Record<string, unknown>, string, string][] = [
      [sshScript, script, './check.sh', 'queue:12\ntemperature:41\nlatency:8\n'],
      [sshScript, script, './check.sh', 'queue:12\n'],
      [sshScript, script, './check.sh', '{"channels":{"queue":3,"latency":8},"message":"ok"}\n'],
      [sshScript, { command: './check.sh', channels: [{ key: 'value' }] }, './check.sh', '41.5\n'],
      [sshDiskFree, { path: '/' }, "df -P -k '/'", DF],
      [sshLoad, {}, LOAD_COMMAND, '2.00 1.50 1.00 1/234 5678\n8\n'],
      [sshLoad, {}, LOAD_COMMAND, '2.00 1.50 1.00 1/234 5678\n\n'],
      [sshMeminfo, {}, 'cat /proc/meminfo', MEMINFO],
      [sshMeminfo, {}, 'cat /proc/meminfo', noSwap],
      [sshMeminfo, {}, 'cat /proc/meminfo', oldKernel],
    ];
    for (const [type, params, command, stdout] of cases) {
      server.answer(command, { stdout });
      assertDeclaresEveryKey(type.id, params, await run(type, params));
    }
  });

  it('need SSH credentials and say which kind is missing', async () => {
    for (const type of types) {
      await assert.rejects(
        () => run(type, { command: 'x', channels: [{ key: 'value' }] }, { credentials: {} }),
        /no SSH credentials are set on this device or any group above it/,
        type.id,
      );
    }
  });

  it('say in every message that the host key was not checked', async () => {
    // A connection that authenticates the server not at all is a standing decision, and the
    // sensor message is where somebody might notice and revisit it. Once at configuration time
    // would be a note nobody sees again.
    server.answer('cat /proc/meminfo', { stdout: MEMINFO });
    const execution = await run(sshMeminfo);
    assert.match(execution.message ?? '', /host key not checked/);
  });

  it('fail when the device resets the connection mid-command, rather than reading half an answer (P-259)', async () => {
    // Each answer is one the type could have read, or misread: `ssh.load` reported the load with
    // no processor count, and the others blamed the host — "this sensor is for a Linux host",
    // "df could not read /", "exited -1" — for a connection that went.
    const cases: {
      type: SensorType;
      command: string;
      stdout: string;
      params?: Record<string, unknown>;
    }[] = [
      { type: sshLoad, command: LOAD_COMMAND, stdout: '0.50 0.40 0.30 1/123 4567\n' },
      { type: sshMeminfo, command: 'cat /proc/meminfo', stdout: `${MEMINFO}\n` },
      { type: sshDiskFree, command: "df -P -k '/'", stdout: `${DF}\n` },
      {
        type: sshScript,
        command: './check.sh',
        stdout: 'value:1\n',
        params: { command: './check.sh', channels: [{ key: 'value' }] },
      },
    ];
    for (const { type, command, stdout, params } of cases) {
      server.answer(command, { stdout, reset: 'before-exit-status' });
      await assert.rejects(
        () => run(type, params),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith(
            `the connection to 127.0.0.1 was lost while running ${command}, before the command ` +
              'reported an exit status',
          ),
        type.id,
      );
    }
  });

  it('fail when the exit status arrived before the rest of the output and then the connection went (P-259)', async () => {
    // `ssh.script` read `code: 0` and the first of two lines as a success with a channel
    // missing — a reading built on half an answer.
    server.answer('./check.sh', {
      code: 0,
      stdout: 'queue:12\n',
      reset: 'after-exit-status',
    });
    await assert.rejects(
      () =>
        run(sshScript, {
          command: './check.sh',
          channels: [
            { key: 'queue', name: 'Queue depth', unit: 'jobs' },
            { key: 'temperature', name: 'Inlet temperature', unit: '°C' },
          ],
        }),
      /the connection to 127\.0\.0\.1 was lost while running \.\/check\.sh/,
    );
  });

  it('read an appliance that sends no exit status and disconnects straight after (P-259)', async () => {
    // `ssh.load` ignores the code, so a whole answer from such a device is a reading, and the
    // DISCONNECT that follows it in the same read must not turn it into a failure.
    server.answer(LOAD_COMMAND, {
      stdout: '0.50 0.40 0.30 1/123 4567\n4\n',
      ending: 'close',
      then: 'disconnect-lost',
    });
    const execution = await run(sshLoad);
    assert.equal(valueOf(execution, 'load1'), 0.5);
    assert.equal(valueOf(execution, 'processors'), 4);
  });

  it('return promptly when the check is aborted', async () => {
    // **"Promptly" means the abort ends it, not the 30 s command timeout** (`P-279`). It used to
    // abort on a 100 ms timer and then assert `Date.now() - started < 3_000`: a wall-clock bound a
    // loaded machine can break, with an abort that could land before the command was ever sent.
    // Now the abort comes once the device holds the command and is saying nothing, and the wait
    // for the check to give up is bounded by `within`, well inside that timeout.
    server.behave({ password: 'monitor', hang: true });
    const controller = new AbortController();
    const pending = run(sshMeminfo, { commandTimeoutMs: 30_000 }, { signal: controller.signal });
    // Taken now, so that a check which fails before the abort is a failed assertion below and
    // not an unhandled rejection while the test is still waiting.
    const ended = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await pollWithin(10_000, 'the device to be holding the command', () =>
      server.seen.includes('cat /proc/meminfo'),
    );
    controller.abort();
    const error = await within(10_000, 'the aborted check to give up', ended);
    assert.ok(error instanceof Error, 'the check failed rather than returning a reading');
    assert.equal(
      error.message,
      'the check was cancelled while running a command on 127.0.0.1',
      'cancelled in the command, which is what was aborted',
    );
  });
});
