import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pino } from 'pino';
import { DnsSimulator, dnsQuery, replies } from '@ms/simulators';
import { buildNameResolution } from '../../src/resolver/name-resolution.js';
import { RESOLVER_LANES } from '../../src/resolver/name-resolver.js';
import { pollWithin, within } from '../support/within.js';
import {
  BUDGET_BOXES,
  BUDGET_FORWARD_MAX,
  BUDGET_NAMES,
  type BudgetArm,
  type BudgetArmName,
  type BudgetRun,
  type Forwarder,
} from './names-differential.js';

/**
 * §7.5's budget rows (`P-460`), in a box of their own: a forwarder in front of a zone whose
 * servers do not answer, the probe's resolver asking every one of its 150 names at once, and how
 * many distinct questions the forwarder then holds upstream, in each mode.
 *
 * - `--forwarder dnsmasq` (Debian 12's dnsmasq, `dnsmasq-base`): at `dns-forward-max=30`, in
 *   `system` mode, in `gate` mode, and in `gate` mode with the helper's child SIGKILLed 5 s in. Its
 *   own log says whether its forward table was ever full.
 * - `--forwarder resolved` (Ubuntu 24.04's systemd-resolved, booted by the script, its upstream the
 *   simulator at 127.0.0.2): `system` and `gate`, through its stub.
 *
 * The upstream is the S5 simulator at 127.0.0.2, modelling dnsmasq's own forward record, a slot
 * held per distinct question for 10 s, so that its gauge's `peakHeld` is the distinct questions
 * the forwarder had open upstream at once. Each arm runs on a fresh simulator and forwarder (or
 * restarted resolved), and in a process of its own (`names-budget arm …`) with
 * `UV_THREADPOOL_SIZE` 16 as ms-probe's unit sets it, ended at the window's close, as an outage
 * still going would be. Prints the box's `BudgetRun` as JSON.
 */

const run = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const UPSTREAM = '127.0.0.2';
const ZONE = 'silent.test';
const FAMILY = 0;
/** Long enough for P-426's lanes to give up twice over (10 s a lookup) and a loss's transient. */
const WINDOW_MS = 30_000;
const KILL_AT_MS = 5_000;
const ARM_BOUND_MS = WINDOW_MS + 60_000;
const DNSMASQ_LOG = '/tmp/ms-dnsmasq.log';
const STUB_RESOLV = 'nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n';

const nameAt = (k: number): string => `dev-${String(k).padStart(3, '0')}.${ZONE}`;

// --- one arm, in its own process ----------------------------------------------------------------

interface ArmSaid {
  readonly lookups: number;
  readonly checkState?: number;
  readonly helperLosses?: number;
  readonly questionsPeak?: number;
}

async function arm(mode: 'system' | 'gate', killAtMs: number | undefined): Promise<void> {
  const logger = pino({ level: 'error' }, process.stderr);
  const spoolDir = mkdtempSync(join(tmpdir(), 'ms-budget-'));
  const names = buildNameResolution({ mode, logger, lanes: RESOLVER_LANES, spoolDir });
  await within(30_000, 'the resolver to start', names.start());
  if (mode === 'gate') {
    try {
      await pollWithin(
        5_000,
        'the check to be proven',
        () => names.resolver.gateHealth()?.checkState === 1,
      );
    } catch {
      // Said in the arm's result: a gate arm whose check was not on measures nothing of it.
    }
  }
  let questionsPeak = 0;
  const sampler = setInterval(() => {
    questionsPeak = Math.max(questionsPeak, names.questionsPeak?.peek() ?? 0);
  }, 50);
  for (let k = 1; k <= BUDGET_NAMES; k += 1) {
    // A check's bound of 10 s: the waiter gives up then, and the lookup goes on.
    names.resolver.resolve(nameAt(k), FAMILY, { waitMs: 10_000 }).catch(() => undefined);
  }
  if (killAtMs !== undefined) {
    setTimeout(() => {
      const pid = names.gate?.helper.pid();
      if (pid !== undefined) process.kill(pid, 'SIGKILL');
    }, killAtMs);
  }
  await sleep(WINDOW_MS);
  clearInterval(sampler);
  const health = names.resolver.gateHealth();
  const said: ArmSaid = {
    lookups: BUDGET_NAMES,
    ...(health === undefined ? {} : { checkState: health.checkState }),
    ...(names.gate === undefined
      ? {}
      : { helperLosses: names.gate.helper.stats().losses, questionsPeak }),
  };
  process.stdout.write(`${JSON.stringify(said)}\n`);
  // Ended as an outage still going would leave it: the lookups in flight die with the process.
  process.exit(0);
}

// --- the box ------------------------------------------------------------------------------------

function runArm(mode: 'system' | 'gate', kill: boolean): Promise<ArmSaid> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SELF, 'arm', mode, ...(kill ? ['--kill-at', String(KILL_AT_MS)] : [])],
      {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', UV_THREADPOOL_SIZE: '16' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err = `${err}${chunk.toString()}`.slice(-4_000)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the ${mode} arm did not end within ${String(ARM_BOUND_MS)} ms: ${err}`));
    }, ARM_BOUND_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as ArmSaid);
      } catch {
        reject(
          new Error(`the ${mode} arm exited ${String(code)} saying ${JSON.stringify(out + err)}`),
        );
      }
    });
  });
}

async function upstream(): Promise<DnsSimulator> {
  return DnsSimulator.start({
    servers: [
      {
        name: 'upstream',
        address: UPSTREAM,
        port: 53,
        ipv6: false,
        forwarder: { holdMs: 10_000 },
        zones: { [ZONE]: { reply: replies.silent } },
        fallback: { reply: replies.nxdomain },
      },
    ],
    ipv6: false,
  });
}

/** dnsmasq in front of the upstream, on 127.0.0.1:53, logging every query and nothing cached. */
async function startDnsmasq(): Promise<ChildProcess> {
  rmSync(DNSMASQ_LOG, { force: true });
  const child = spawn(
    'dnsmasq',
    [
      '--keep-in-foreground',
      '--no-resolv',
      '--no-hosts',
      '--no-poll',
      `--server=${UPSTREAM}`,
      '--listen-address=127.0.0.1',
      '--bind-interfaces',
      '--port=53',
      `--dns-forward-max=${String(BUDGET_FORWARD_MAX)}`,
      '--cache-size=0',
      '--log-queries',
      `--log-facility=${DNSMASQ_LOG}`,
      '--user=root',
      '--group=root',
      '--pid-file=',
    ],
    { stdio: 'ignore' },
  );
  await pollWithin(10_000, 'dnsmasq to answer', async () => {
    const said = await dnsQuery({ address: '127.0.0.1', port: 53 }, 'localhost', 'A', {
      timeoutMs: 500,
    });
    return said.kind === 'reply';
  });
  return child;
}

async function stopDnsmasq(child: ChildProcess): Promise<number> {
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  child.kill('SIGTERM');
  try {
    await within(10_000, 'dnsmasq to stop', exited);
  } catch {
    child.kill('SIGKILL');
  }
  const log = existsSync(DNSMASQ_LOG) ? readFileSync(DNSMASQ_LOG, 'utf8') : '';
  return log
    .split('\n')
    .filter((line) => line.includes('Maximum number of concurrent DNS queries reached')).length;
}

async function restartResolved(): Promise<void> {
  await run('systemctl', ['restart', 'systemd-resolved'], { timeout: 30_000 });
  await pollWithin(20_000, 'systemd-resolved to be active', async () => {
    try {
      const { stdout } = await run('systemctl', ['is-active', 'systemd-resolved'], {
        timeout: 5_000,
      });
      return stdout.trim() === 'active';
    } catch {
      return false;
    }
  });
  await run('resolvectl', ['flush-caches'], { timeout: 10_000 });
}

async function measure(forwarder: Forwarder, name: BudgetArmName): Promise<BudgetArm> {
  const sim = await upstream();
  let dnsmasq: ChildProcess | undefined;
  try {
    if (forwarder === 'dnsmasq') dnsmasq = await startDnsmasq();
    else await restartResolved();
    await sim.clearLog();
    await sim.gauge('upstream', { resetPeak: true });
    const said = await runArm(name === 'system' ? 'system' : 'gate', name === 'gate-kill');
    const [gauge] = await sim.gauge('upstream');
    const log = await sim.log({ server: 'upstream' });
    const distinct = new Set(
      log
        .filter((entry) => entry.qname.toLowerCase().endsWith(ZONE))
        .map((entry) => `${entry.qname.toLowerCase()} ${entry.qtype}`),
    ).size;
    const maxReached = dnsmasq === undefined ? undefined : await stopDnsmasq(dnsmasq);
    dnsmasq = undefined;
    return {
      arm: name,
      lookups: said.lookups,
      peakHeld: gauge?.peakHeld ?? 0,
      distinct,
      ...(maxReached === undefined ? {} : { maxReached }),
      ...(said.checkState === undefined ? {} : { checkState: said.checkState }),
      ...(said.helperLosses === undefined ? {} : { helperLosses: said.helperLosses }),
      ...(said.questionsPeak === undefined ? {} : { questionsPeak: said.questionsPeak }),
    };
  } finally {
    if (dnsmasq !== undefined) await stopDnsmasq(dnsmasq);
    await sim.stop();
  }
}

async function versionOf(forwarder: Forwarder): Promise<string> {
  try {
    const { stdout } =
      forwarder === 'dnsmasq'
        ? await run('dnsmasq', ['--version'], { timeout: 5_000 })
        : await run('resolvectl', ['--version'], { timeout: 5_000 });
    return stdout.split('\n')[0]?.trim() ?? '';
  } catch (error: unknown) {
    return `unknown (${String(error)})`;
  }
}

async function box(forwarder: Forwarder, image: string): Promise<void> {
  const setup: string[] = [];
  try {
    writeFileSync('/etc/hosts', '127.0.0.1 localhost\n');
    writeFileSync(
      '/etc/resolv.conf',
      forwarder === 'dnsmasq' ? 'nameserver 127.0.0.1\n' : STUB_RESOLV,
    );
    writeFileSync('/etc/nsswitch.conf', 'hosts: files dns\n');
    writeFileSync('/etc/gai.conf', '');
    writeFileSync('/proc/sys/kernel/hostname', 'probe-1');
  } catch (error: unknown) {
    setup.push(`could not set the box up: ${String(error)}`);
  }
  const arms: BudgetArm[] = [];
  for (const name of BUDGET_BOXES[forwarder]) {
    const started = performance.now();
    try {
      const measured = await measure(forwarder, name);
      arms.push(measured);
      process.stderr.write(
        `${forwarder} ${name}: peak ${String(measured.peakHeld)} held, ${String(measured.distinct)} distinct (${String(Math.round(performance.now() - started))} ms)\n`,
      );
    } catch (error: unknown) {
      setup.push(
        `the ${name} arm failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const result: BudgetRun = {
    kind: 'budget',
    forwarder,
    image,
    version: await versionOf(forwarder),
    names: BUDGET_NAMES,
    family: FAMILY,
    windowMs: WINDOW_MS,
    arms,
    ...(setup.length > 0 ? { setup } : {}),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const argv = process.argv.slice(2);
if (argv[0] === 'arm') {
  const mode = argv[1] === 'gate' ? 'gate' : 'system';
  const at = argv.indexOf('--kill-at');
  await arm(mode, at === -1 ? undefined : Number(argv[at + 1]));
} else {
  const forwarder = argv[argv.indexOf('--forwarder') + 1];
  const image = argv[argv.indexOf('--image') + 1] ?? 'unknown';
  if (forwarder !== 'dnsmasq' && forwarder !== 'resolved') {
    throw new Error('usage: names-budget --forwarder dnsmasq|resolved --image <name>');
  }
  await box(forwarder, image);
}
