import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { DnsCheck, type DnsAsker } from '../../src/resolver/dns-check.js';
import { ForwardBudget } from '../../src/resolver/forward-budget.js';
import { GlibcNamePolicy, SYSTEM_FILES } from '../../src/resolver/system-names.js';
import { pollWithin } from '../support/within.js';
import { BuildWatch } from './names-build.js';
import { OFF_CASES, type OffCase, type OffRun } from './names-differential.js';

/**
 * A box with the name check off (`P-461`): the policy loaded in situ, against the box as the
 * distribution or the operator left it, must say the check is off by the rule the case names, and
 * the check, started as the probe starts it, must route a name unvouched and ask nothing from its
 * start to its stop: not its canary, which `start` sends, nor a walk. `names-off --case <case>
 * --image <image>` sets the case up as an operator would and runs itself again (`--in-situ`) in a
 * process started after it, so ld.so, the environment and nscd are what that process meets:
 *
 * - `nscd`: nscd started, its socket waited for.
 * - `resolve`, `mdns4_minimal`: nothing; the box's image has the module installed, and its
 *   package's own hosts: line.
 * - `ld-preload`: `LD_PRELOAD` set to libresolv, which ld.so loads harmlessly.
 * - `ld-so-preload`: /etc/ld.so.preload naming libresolv.
 *
 * Prints the case's `OffRun` as JSON, with the build it loaded (`names-build.ts`).
 */

const SELF = fileURLToPath(import.meta.url);
const PRELOADED = [
  '/lib/aarch64-linux-gnu/libresolv.so.2',
  '/usr/lib/aarch64-linux-gnu/libresolv.so.2',
  '/lib/x86_64-linux-gnu/libresolv.so.2',
  '/usr/lib/x86_64-linux-gnu/libresolv.so.2',
  '/usr/lib64/libresolv.so.2',
  '/lib64/libresolv.so.2',
];
const PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function hostsLine(): string | undefined {
  try {
    const line = readFileSync(SYSTEM_FILES.nsswitchConf, 'utf8')
      .split('\n')
      .find((each) => /^[ \t]*hosts:/u.test(each));
    return line?.replace(/^[ \t]*hosts:[ \t]*/u, '').trim();
  } catch {
    return undefined;
  }
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Past the canary's send: `start` sends it at once, and asks again only every `CANARY_EVERY_MS`
 * (60 s), so a check that would ask has asked by then.
 */
const STARTED_MS = 300;

/** The policy in this process, against the box as it is, and the check's route for one name. */
async function inSitu(which: OffCase, image: string): Promise<Omit<OffRun, 'buildDigest'>> {
  const logger = pino({ level: 'silent' });
  const policy = new GlibcNamePolicy({ logger });
  await policy.load();
  const described = policy.describe();
  const asked: string[] = [];
  // An asker that records what it is asked: with the check off it must be asked nothing.
  const asker: DnsAsker = {
    channel(server) {
      return {
        ask(name, type) {
          asked.push(`${server} ${name} ${type}`);
          return Promise.resolve('timeout');
        },
        close() {},
      };
    },
  };
  const now = (): number => performance.now();
  const check = new DnsCheck({ logger, policy, budget: new ForwardBudget({ now }), asker, now });
  // As the probe starts it: its canary would go now.
  check.start();
  await sleep(STARTED_MS);
  const route = await Promise.resolve(
    check.route({
      host: 'sw1.example.test',
      family: 0,
      refresh: false,
      known: false,
      lastRanMs: undefined,
      boundMs: undefined,
      ref: {},
    }),
  );
  check.stop();
  const said = route.route === 'unvouched' ? `unvouched:${route.why}` : route.route;
  return {
    kind: 'off',
    case: which,
    image,
    check: described.check,
    ...(described.shapeOff === undefined
      ? {}
      : { off: { code: described.shapeOff.code, why: described.shapeOff.why } }),
    hostsLine: hostsLine(),
    nscdSocket: existsSync(SYSTEM_FILES.nscdSocket),
    ldPreload: process.env['LD_PRELOAD'],
    ldSoPreload: readOr(SYSTEM_FILES.ldSoPreload),
    route: said,
    asked,
  };
}

function again(
  which: OffCase,
  image: string,
  env: Record<string, string>,
): Promise<Omit<OffRun, 'buildDigest'>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, '--case', which, '--image', image, '--in-situ'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the in-situ process did not end within 60 s'));
    }, 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as Omit<OffRun, 'buildDigest'>);
      } catch {
        reject(
          new Error(
            `the in-situ process exited ${String(code)} saying ${JSON.stringify(out + err)}`,
          ),
        );
      }
    });
  });
}

async function setUp(which: OffCase): Promise<{ env: Record<string, string>; setup: string[] }> {
  const env: Record<string, string> = { PATH };
  const setup: string[] = [];
  const library = PRELOADED.find((path) => existsSync(path));
  switch (which) {
    case 'nscd': {
      mkdirSync('/var/run/nscd', { recursive: true });
      const nscd = spawn('nscd', [], { stdio: 'ignore' });
      nscd.on('error', (error) => setup.push(`nscd did not start: ${String(error)}`));
      try {
        await pollWithin(10_000, 'nscd’s socket', () => existsSync(SYSTEM_FILES.nscdSocket));
      } catch (error: unknown) {
        setup.push(String(error));
      }
      break;
    }
    case 'ld-preload':
      if (library === undefined) setup.push('no libresolv.so.2 to preload');
      else env['LD_PRELOAD'] = library;
      break;
    case 'ld-so-preload':
      if (library === undefined) setup.push('no libresolv.so.2 to preload');
      else writeFileSync(SYSTEM_FILES.ldSoPreload, `${library}\n`);
      break;
    case 'resolve':
    case 'mdns4_minimal':
      break;
  }
  return { env, setup };
}

const argv = process.argv.slice(2);
const which = argv[argv.indexOf('--case') + 1] as OffCase;
const image = argv[argv.indexOf('--image') + 1] ?? 'unknown';
if (!Object.hasOwn(OFF_CASES, which)) {
  throw new Error(`usage: names-off --case ${Object.keys(OFF_CASES).join('|')} --image <image>`);
}
if (argv.includes('--in-situ')) {
  process.stdout.write(`${JSON.stringify(await inSitu(which, image))}\n`);
} else {
  const build = new BuildWatch();
  const { env, setup } = await setUp(which);
  const found = await again(which, image, env);
  build.look('at the end');
  const run: OffRun = {
    ...found,
    ...(setup.length > 0 ? { setup: [...(found.setup ?? []), ...setup] } : {}),
    ...build.fields(),
  };
  process.stdout.write(`${JSON.stringify(run)}\n`);
  // nscd forked itself away; the box is thrown away with it.
  process.exit(0);
}
