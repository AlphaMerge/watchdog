import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { POWERSHELL_ENV } from '../src/support/windows/index.js';
import { windowsCpu } from '../src/types/windows-cpu.js';
import { windowsMemory } from '../src/types/windows-memory.js';
import { windowsService } from '../src/types/windows-service.js';
import { windowsVolume } from '../src/types/windows-volume.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';
import { installFakePowerShell } from './support/fake-powershell.js';

/**
 * The four Windows sensors (`T-10`).
 *
 * **Driven by recorded output, and that is the honest limit of what these can prove.** No
 * PowerShell runs here and no `Get-CimInstance` is executed — the fixtures below are the shapes
 * those classes actually return, written out by hand from their documented types, and the fake
 * hands them back. So these prove the parsing, the units, the gaps and the failures, which is
 * where the bugs in a sensor of this kind live. What they cannot prove is that the *query* is
 * right, which needs a Windows machine — recorded in `TASKS.md` as an open verification rather
 * than left as an implied pass.
 *
 * The shapes carry two traits that are not obvious and are the reason for recording rather than
 * inventing: `Win32_OperatingSystem` counts memory in **kibibytes**, and `Win32_LogicalDisk`
 * sends 64-bit sizes as **strings** through PowerShell 5.1's serialiser about as often as it
 * sends them as numbers. Both appear below.
 */

let FAKE = '';

before(() => {
  FAKE = installFakePowerShell();
  process.env[POWERSHELL_ENV] = FAKE;
});

after(() => {
  process.env[POWERSHELL_ENV] = '';
  rmSync(dirname(FAKE), { recursive: true, force: true });
});

/**
 * Runs a sensor against a canned answer.
 *
 * The directive rides in the sensor's own snippet, which the transport embeds verbatim — so the
 * fake sees the real script and the sensor sees the real transport. The only thing replaced is
 * the interpreter.
 */
function run(
  type: SensorType,
  answer: unknown,
  params: Record<string, unknown> = {},
): Promise<CheckExecution> {
  const context: CheckContext = {
    sensorId: 1,
    target: { host: 'server01', ipVersion: 'v4' },
    // The directive is smuggled through a parameter the snippet interpolates: the service name
    // and the drive list both end up in the script, and `host` always does.
    params: { host: `server01 #FAKE:ok ${JSON.stringify(answer)}`, ...params },
    credentials: { windows: { username: 'CORP\\svc', password: 'x' } },
    signal: new AbortController().signal,
  };
  return type.execute(context);
}

const failing = (type: SensorType, directive: string, params: Record<string, unknown> = {}) =>
  type.execute({
    sensorId: 1,
    target: { host: 'server01', ipVersion: 'v4' },
    params: { host: `server01 ${directive}`, ...params },
    credentials: { windows: { username: 'CORP\\svc', password: 'x' } },
    signal: new AbortController().signal,
  });

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('windows.cpu', () => {
  // What Win32_PerfFormattedData_PerfOS_Processor returns on a four-core machine: an instance
  // per logical processor and one called _Total, which is the machine's own average rather than
  // one computed from the parts.
  const FOUR_CORES = [
    { Name: '0', PercentProcessorTime: 12 },
    { Name: '1', PercentProcessorTime: 8 },
    { Name: '2', PercentProcessorTime: 95 },
    { Name: '3', PercentProcessorTime: 5 },
    { Name: '_Total', PercentProcessorTime: 30 },
  ];

  it('reads the total the machine reported, not one it worked out', async () => {
    // 12+8+95+5 averages to 30 here by construction, and that is a coincidence worth not
    // relying on: the counter is an interval average and the instances are sampled separately.
    const execution = await run(windowsCpu, FOUR_CORES);
    assert.equal(valueOf(execution, 'total'), 30);
  });

  it('creates a channel per logical processor', async () => {
    const execution = await run(windowsCpu, FOUR_CORES);
    assert.equal(valueOf(execution, 'core_0'), 12);
    assert.equal(valueOf(execution, 'core_2'), 95);
    assert.equal(execution.channels.length, 5);
  });

  it('turns them off when asked, because sixty-four cores is sixty-four channels', async () => {
    const execution = await run(windowsCpu, FOUR_CORES, { perCore: false });
    assert.equal(execution.channels.length, 1);
    assert.equal(valueOf(execution, 'total'), 30);
  });

  it('names a pinned core in the message, which the total hides', async () => {
    assert.match((await run(windowsCpu, FOUR_CORES)).message ?? '', /core 2 is at 95%/);
  });

  it('reads the processor-group names a machine with many cores uses', async () => {
    // Above sixty-four logical processors the instance names are `0,0`, `0,1`, `1,0` — a group
    // and an index. Two cores called `0` in different groups are two cores.
    const execution = await run(windowsCpu, [
      { Name: '0,0', PercentProcessorTime: 10 },
      { Name: '1,0', PercentProcessorTime: 20 },
      { Name: '_Total', PercentProcessorTime: 15 },
    ]);
    assert.equal(valueOf(execution, 'core_0_0'), 10);
    assert.equal(valueOf(execution, 'core_1_0'), 20);
  });

  it('fails rather than reporting an idle machine when the counters are gone', async () => {
    // Corrupted performance counters are a real and common Windows fault, and they return
    // nothing rather than an error. Reporting 0% would be reporting an idle machine on the
    // strength of no evidence at all.
    await assert.rejects(() => run(windowsCpu, []), /counters returned nothing.*lodctr \/R/s);
  });

  it('fails when there is no _Total rather than averaging the parts', async () => {
    await assert.rejects(
      () => run(windowsCpu, [{ Name: '0', PercentProcessorTime: 10 }]),
      /and no _Total/,
    );
  });
});

describe('windows.memory', () => {
  // Win32_OperatingSystem counts every one of these in kibibytes. A sensor that stored them as
  // reported would be off by a factor of 1024 and still look plausible on a graph.
  const SIXTEEN_GIB = {
    TotalVisibleMemorySize: 16_777_216,
    FreePhysicalMemory: 4_194_304,
    TotalVirtualMemorySize: 33_554_432,
    FreeVirtualMemory: 12_582_912,
    Caption: 'Microsoft Windows Server 2022 Standard',
  };

  it('converts kibibytes to bytes', async () => {
    const execution = await run(windowsMemory, SIXTEEN_GIB);
    assert.equal(valueOf(execution, 'total'), 16 * 1024 ** 3);
    assert.equal(valueOf(execution, 'available'), 4 * 1024 ** 3);
  });

  it('makes the percentage the primary, because that is where a limit belongs', async () => {
    const execution = await run(windowsMemory, SIXTEEN_GIB);
    assert.equal(valueOf(execution, 'availablePercent'), 25);
    assert.equal(windowsMemory.channels({}).find((one) => one.isPrimary)?.key, 'availablePercent');
  });

  it('reports virtual memory too, since commit pressure is invisible in the physical figures', async () => {
    const execution = await run(windowsMemory, SIXTEEN_GIB);
    assert.equal(valueOf(execution, 'virtualAvailable'), 12 * 1024 ** 3);
    assert.equal(valueOf(execution, 'virtualAvailablePercent'), 37.5);
  });

  it('reads the figures as strings, which 5.1’s serialiser sends about as often', async () => {
    const execution = await run(windowsMemory, {
      TotalVisibleMemorySize: '16777216',
      FreePhysicalMemory: '4194304',
    });
    assert.equal(valueOf(execution, 'total'), 16 * 1024 ** 3);
    assert.equal(valueOf(execution, 'availablePercent'), 25);
  });

  it('gaps the virtual channels rather than zeroing them when they are absent', async () => {
    // The rule the whole system is built on. A machine with no pagefile is not a machine with
    // no virtual memory available.
    const execution = await run(windowsMemory, {
      TotalVisibleMemorySize: 16_777_216,
      FreePhysicalMemory: 4_194_304,
    });
    assert.equal(valueOf(execution, 'virtualAvailable'), undefined);
    assert.equal(valueOf(execution, 'availablePercent'), 25);
  });

  it('gaps the percentage when the total is zero rather than reporting infinity', async () => {
    // A Hyper-V guest mid-migration and a machine answering from a half-initialised WMI both
    // report a zero total. Dividing by it produces Infinity, which is a number, which stores
    // and draws — the shape of wrongness this system is built to refuse.
    const execution = await run(windowsMemory, {
      TotalVisibleMemorySize: 0,
      FreePhysicalMemory: 0,
    });
    assert.equal(valueOf(execution, 'availablePercent'), undefined);
    assert.equal(valueOf(execution, 'total'), 0);
  });

  it('fails when the physical figures are missing, rather than reading zero', async () => {
    await assert.rejects(
      () => run(windowsMemory, { Caption: 'Windows' }),
      /nothing to report.*no memory left/s,
    );
    await assert.rejects(() => run(windowsMemory, []), /returned no rows/);
  });
});

describe('windows.volume', () => {
  // Win32_LogicalDisk sends 64-bit sizes as strings through PowerShell 5.1 about as often as it
  // sends them as numbers, so the fixture has both — an installation meets whichever its
  // machines happen to produce.
  const THREE_DISKS = [
    {
      DeviceID: 'C:',
      VolumeName: 'System',
      Size: '107374182400',
      FreeSpace: '10737418240',
      DriveType: 3,
    },
    {
      DeviceID: 'D:',
      VolumeName: 'Data',
      Size: 1_099_511_627_776,
      FreeSpace: 549_755_813_888,
      DriveType: 3,
    },
    { DeviceID: 'E:', VolumeName: '', Size: '53687091200', FreeSpace: '2684354560', DriveType: 3 },
  ];

  it('makes the lowest free percentage the primary, so one limit covers the machine', async () => {
    // Six drives as six sensors would be six alarms for one outage when the machine goes.
    const execution = await run(windowsVolume, THREE_DISKS);
    assert.equal(valueOf(execution, 'lowest'), 5, 'E: at 5% is the tightest');
    assert.match(execution.message ?? '', /lowest 5% free on E:/);
  });

  it('gives each volume a percentage, a free figure and a size', async () => {
    const execution = await run(windowsVolume, THREE_DISKS);
    assert.equal(valueOf(execution, 'free_c'), 10);
    assert.equal(valueOf(execution, 'freebytes_c'), 10_737_418_240);
    assert.equal(valueOf(execution, 'size_c'), 107_374_182_400);
    assert.equal(valueOf(execution, 'free_d'), 50);
  });

  it('watches only the drives it was given', async () => {
    const execution = await run(windowsVolume, THREE_DISKS, { drives: ['C:', 'D'] });
    assert.equal(valueOf(execution, 'free_c'), 10);
    assert.equal(valueOf(execution, 'free_e'), undefined);
    assert.equal(valueOf(execution, 'lowest'), 10);
  });

  it('takes a drive letter however an operator spelt it', async () => {
    for (const spelling of ['C:', 'c', 'C:\\', 'c:']) {
      const execution = await run(windowsVolume, THREE_DISKS, { drives: [spelling] });
      assert.equal(valueOf(execution, 'free_c'), 10, spelling);
    }
  });

  it('gaps a volume that reports no size, and says which', async () => {
    // A locked BitLocker volume or a disconnected mapped drive. Zero would read as a full disk
    // and page somebody at three in the morning.
    const execution = await run(windowsVolume, [
      { DeviceID: 'C:', Size: '107374182400', FreeSpace: '10737418240', DriveType: 3 },
      { DeviceID: 'X:', Size: null, FreeSpace: null, DriveType: 3 },
    ]);
    assert.equal(valueOf(execution, 'free_x'), undefined);
    assert.equal(valueOf(execution, 'lowest'), 10);
    assert.match(execution.message ?? '', /X: reported no size/);
  });

  it('asks the machine to do the filtering, not this process', async () => {
    // A hundred mapped drives should not cross the network to be discarded here.
    const execution = await run(windowsVolume, THREE_DISKS, { includeNetwork: true });
    assert.equal(valueOf(execution, 'lowest'), 5);
  });

  it('fails when the drives it watches are not there', async () => {
    await assert.rejects(
      () => run(windowsVolume, THREE_DISKS, { drives: ['Z:'] }),
      /none of the volumes this sensor watches \(z\)/,
    );
    await assert.rejects(() => run(windowsVolume, []), /no local fixed disks/);
  });
});

describe('windows.service', () => {
  const SPOOLER = {
    Name: 'Spooler',
    DisplayName: 'Print Spooler',
    State: 'Running',
    StartMode: 'Auto',
    Status: 'OK',
    ProcessId: 2144,
  };

  it('reads a running service', async () => {
    const execution = await run(windowsService, SPOOLER, { service: 'Spooler' });
    assert.equal(valueOf(execution, 'running'), 1);
    assert.equal(valueOf(execution, 'expected'), 1);
    assert.equal(valueOf(execution, 'processId'), 2144);
    assert.match(execution.message ?? '', /Print Spooler is Running \(start mode Auto\)/);
  });

  it('reads a stopped one', async () => {
    const execution = await run(
      windowsService,
      { ...SPOOLER, State: 'Stopped', ProcessId: 0 },
      { service: 'Spooler' },
    );
    assert.equal(valueOf(execution, 'running'), 0);
    assert.equal(valueOf(execution, 'expected'), 0, 'Automatic and stopped is not as configured');
    assert.equal(valueOf(execution, 'processId'), undefined, 'a stopped service has no pid');
  });

  it('separates "stopped" from "stopped and that is fine"', async () => {
    // A Manual service that is stopped is a machine working as configured; the same service set
    // to Automatic is an incident. One limit on `expected` covers an estate of mixed
    // configurations, where a limit on `running` would need a different one per service.
    const manual = await run(
      windowsService,
      { ...SPOOLER, State: 'Stopped', StartMode: 'Manual', ProcessId: 0 },
      { service: 'Spooler' },
    );
    assert.equal(valueOf(manual, 'running'), 0);
    assert.equal(valueOf(manual, 'expected'), 1);

    const disabledButRunning = await run(
      windowsService,
      { ...SPOOLER, StartMode: 'Disabled' },
      { service: 'Spooler' },
    );
    assert.equal(valueOf(disabledButRunning, 'expected'), 0);
  });

  it('accepts both spellings of the automatic start mode', async () => {
    for (const startMode of ['Auto', 'Automatic']) {
      const execution = await run(
        windowsService,
        { ...SPOOLER, StartMode: startMode },
        {
          service: 'Spooler',
        },
      );
      assert.equal(valueOf(execution, 'expected'), 1, startMode);
    }
  });

  it('reports a service in trouble that is nonetheless running', async () => {
    const execution = await run(
      windowsService,
      { ...SPOOLER, Status: 'Degraded' },
      { service: 'Spooler' },
    );
    assert.match(execution.message ?? '', /status Degraded/);
  });

  it('fails when the service is not installed, rather than reading nought', async () => {
    // A service that was uninstalled and one that is stopped need different people, and a 0
    // would make them identical on the graph for ever after.
    await assert.rejects(
      () => run(windowsService, [], { service: 'Sploolerr' }),
      /no service called "Sploolerr".*Get-Service/s,
    );
  });

  it('refuses an empty service name', async () => {
    await assert.rejects(() => run(windowsService, [], { service: '   ' }), /names no service/);
  });
});

describe('what every Windows sensor does with a transport failure', () => {
  it('carries PowerShell’s diagnosis through, with the likely cause in front of it', async () => {
    for (const type of [windowsCpu, windowsMemory]) {
      await assert.rejects(
        () => failing(type, '#FAKE:error AuthenticationError|Access is denied.'),
        /Remote Management Users.*Access is denied/s,
        type.id,
      );
    }
  });

  it('does not report a reading when the machine did not answer', async () => {
    await assert.rejects(
      () => failing(windowsVolume, '#FAKE:error ConnectionError|WinRM cannot process the request.'),
      /winrm quickconfig/,
    );
  });
});
