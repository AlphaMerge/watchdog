import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { pino } from 'pino';
import { DnsCheck, type DnsAsker } from '../../src/resolver/dns-check.js';
import { ForwardBudget } from '../../src/resolver/forward-budget.js';
import { GlibcNamePolicy, SYSTEM_FILES } from '../../src/resolver/system-names.js';
import { pollWithin } from '../support/within.js';
import { BuildWatch } from './names-build.js';
import {
  ATON_SERVER,
  OFF_CASES,
  STUB,
  boundIn,
  nameserversOf,
  type OffCase,
  type OffRun,
} from './names-differential.js';

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
 * And §7.5's other rows the check is off for (`P-462`). The first three write their hosts: line
 * as an operator would, with no action group, so that the rule is seen naming the source:
 * - `sss-first`: `hosts: sss files dns`, with libnss-sss installed.
 * - `mdns4-first`: `hosts: mdns4_minimal files dns`, with libnss-mdns installed.
 * - `files-resolve-dns`: `hosts: files resolve dns`, with libnss-resolve installed.
 * - `stub-refused`: in a box the script boots, resolv.conf a file of its own holding resolved's
 *   stub file as resolved wrote it with the stub listening (`nameserver 127.0.0.53`), then
 *   systemd-resolved restarted with `DNSStubListener=no`, and the hosts: line libnss-resolve wrote,
 *   which has an action group: the stub refuses, and glibc asks resolved over varlink. Not the stub
 *   file itself: with the stub off, systemd 255 makes it a link to its uplink file, which names the
 *   uplink servers and no stub (the first narrowed run of `P-462` read 192.168.65.7 there).
 * - `localdomain-empty`: `LOCALDOMAIN` set and empty, which glibc reads as no search list; the
 *   hosts: line is the image's own.
 * - `nameserver-aton`: resolv.conf naming `10.1` alone, an `inet_aton` form glibc reads as
 *   10.0.0.1, which the policy does not take; the hosts: line is the image's own.
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
const run = promisify(execFile);
/** Where a distribution keeps its NSS modules, for every architecture the boxes build for. */
const LIBRARY_DIRS = [
  '/lib/aarch64-linux-gnu',
  '/usr/lib/aarch64-linux-gnu',
  '/lib/x86_64-linux-gnu',
  '/usr/lib/x86_64-linux-gnu',
  '/usr/lib64',
  '/lib64',
];
/** The hosts: line each case writes, beside the rest of nsswitch.conf as the box has it. */
const HOSTS_LINES: Partial<Record<OffCase, string>> = {
  'sss-first': 'sss files dns',
  'mdns4-first': 'mdns4_minimal files dns',
  'files-resolve-dns': 'files resolve dns',
};
const STUB_OFF = '/etc/systemd/resolved.conf.d/ms-stub-off.conf';
const STUB_FILE = '/run/systemd/resolve/stub-resolv.conf';

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

/** Every `libnss_<name>.so.2` in the library directories, by name. */
function nssModules(): string[] {
  const found = new Set<string>();
  for (const dir of LIBRARY_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^libnss_(.+)\.so\.2$/u.exec(entry);
      if (match?.[1] !== undefined) found.add(match[1]);
    }
  }
  return [...found].sort();
}

/** Whether anything is bound to the stub's address, port 53, over UDP or listening over TCP. */
function stubListening(): boolean {
  return (
    boundIn(readOr('/proc/net/udp') ?? '', STUB, 53, 'udp') ||
    boundIn(readOr('/proc/net/tcp') ?? '', STUB, 53, 'tcp')
  );
}

/** `systemctl is-active systemd-resolved`, or undefined where systemctl does not run. */
async function resolvedState(): Promise<string | undefined> {
  try {
    const { stdout } = await run('systemctl', ['is-active', 'systemd-resolved'], {
      timeout: 10_000,
    });
    return stdout.trim();
  } catch (error: unknown) {
    const said = (error as { stdout?: unknown }).stdout;
    return typeof said === 'string' && said.trim() !== '' ? said.trim() : undefined;
  }
}

/** nsswitch.conf with its hosts: line replaced, or added, as an operator edits it. */
function withHostsLine(text: string, line: string): string {
  const lines = text.split('\n').filter((each) => !/^[ \t]*hosts:/u.test(each));
  const body = lines.join('\n').replace(/\n*$/u, '');
  return `${body === '' ? '' : `${body}\n`}hosts: ${line}\n`;
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
      own: false,
    }),
  );
  check.stop();
  const said = route.route === 'unvouched' ? `unvouched:${route.why}` : route.route;
  const resolved = await resolvedState();
  const resolvConf = readOr(SYSTEM_FILES.resolvConf);
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
    ...(process.env['LOCALDOMAIN'] === undefined
      ? {}
      : { localDomain: process.env['LOCALDOMAIN'] }),
    ...(resolvConf === undefined ? {} : { resolvConf }),
    stubListening: stubListening(),
    ...(resolved === undefined ? {} : { resolved }),
    nssModules: nssModules(),
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
    case 'sss-first':
    case 'mdns4-first':
    case 'files-resolve-dns': {
      const line = HOSTS_LINES[which] ?? '';
      try {
        const text = readOr(SYSTEM_FILES.nsswitchConf) ?? '';
        writeFileSync(SYSTEM_FILES.nsswitchConf, withHostsLine(text, line));
      } catch (error: unknown) {
        setup.push(`could not write the hosts: line ${line}: ${String(error)}`);
      }
      break;
    }
    case 'stub-refused':
      setup.push(...(await stubOff()));
      break;
    case 'localdomain-empty':
      env['LOCALDOMAIN'] = '';
      break;
    case 'nameserver-aton':
      try {
        writeResolvConf(`nameserver ${ATON_SERVER}\n`);
      } catch (error: unknown) {
        setup.push(`could not write resolv.conf: ${String(error)}`);
      }
      break;
  }
  return { env, setup };
}

/**
 * resolv.conf as a file of its own holding `text`: a link to it, as Ubuntu links it to resolved's
 * stub file, is removed first, since a write through the link would be the file's owner's to
 * overwrite.
 */
function writeResolvConf(text: string): void {
  if (lstatSync(SYSTEM_FILES.resolvConf, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    unlinkSync(SYSTEM_FILES.resolvConf);
  }
  writeFileSync(SYSTEM_FILES.resolvConf, text);
}

/**
 * resolved's stub file read while the stub listens, and written as resolv.conf, a file of its own
 * (`writeResolvConf`); then systemd-resolved restarted with its stub off. Not the symlink to the
 * stub file an Ubuntu host has: with the stub off, systemd 255 makes the stub file a link to its
 * uplink file, which names the uplink servers and no stub. What could not be done is returned.
 */
async function stubOff(): Promise<string[]> {
  try {
    // The stub file as resolved writes it with the stub listening, kept as resolv.conf: what an
    // operator's resolv.conf copied from it holds.
    await pollWithin(
      20_000,
      'systemd-resolved to be active',
      async () => (await resolvedState()) === 'active',
      500,
    );
    await pollWithin(10_000, 'resolved’s stub file', () => existsSync(STUB_FILE));
    const stub = readFileSync(STUB_FILE, 'utf8');
    if (!isDeepStrictEqual(nameserversOf(stub), [STUB])) {
      return [`resolved’s stub file names ${JSON.stringify(nameserversOf(stub))}, not ${STUB}`];
    }
    writeResolvConf(stub);
    mkdirSync('/etc/systemd/resolved.conf.d', { recursive: true });
    writeFileSync(STUB_OFF, '[Resolve]\nDNSStubListener=no\n');
    await run('systemctl', ['restart', 'systemd-resolved'], { timeout: 30_000 });
    await pollWithin(
      20_000,
      'systemd-resolved to be active again',
      async () => (await resolvedState()) === 'active',
      500,
    );
    return [];
  } catch (error: unknown) {
    return [`could not turn resolved’s stub off: ${String(error)}`];
  }
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
