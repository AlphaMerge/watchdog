import { execFile, spawn } from 'node:child_process';
import { readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pino } from 'pino';
import {
  DnsSimulator,
  replies,
  type DnsBehaviour,
  type DnsReply,
  type DnsServerSpec,
} from '@ms/simulators';
import { GlibcNamePolicy } from '../../src/resolver/system-names.js';
import { startCapture } from './names-capture.js';
import {
  NAMESERVER,
  STUB,
  digestOf,
  expectationIn,
  listenerOf,
  nameserversOf,
  pcapQuestions,
  resolvedObserved,
  unplayable,
  wireOf,
  type Asked,
  type Expectation,
  type ImageRun,
  type InImage,
  type Plan,
  type PlanRun,
  type Reply,
  type Row,
  type RowRun,
  type RowsFile,
} from './names-differential.js';

/**
 * The differential's replay in one image (`P-432` S8, D30): run as root in a box from
 * `scripts/smoke/Dockerfile.names`, privileged and with no network, by
 * `scripts/smoke/name-gate-differential.sh`. Prints the image's run (`ImageRun`) as JSON on stdout,
 * and a line per row on stderr.
 *
 * For each row S4 exported (`system-names-rows.json`) that the image replays:
 * 1. **The world.** The row's hosts file, resolv.conf, nsswitch.conf and gai.conf are written over
 *    the image's own (in place, as Docker's bind-mounted ones cannot be replaced), the hostname is
 *    set, and every server its resolv.conf names, not only the 3 glibc asks, is put on `lo`.
 * 2. **The policy, in the image.** `GlibcNamePolicy` is loaded against those real files, this
 *    glibc, the modules installed and the environment the lookup gets, and its class for the
 *    question is kept, so that a row is judged by what the policy reads here, not only by the
 *    export.
 * 3. **Each plan.** The S5 simulator is every server the resolv.conf names, on port 53, answering
 *    as the plan says, and is also 127.0.0.1 and ::1 (when no row server is), to catch a question
 *    sent where no server was named. glibc is asked in a child process of its own (`names-lookup`),
 *    through `systemLookup`, the one call `systemResolve` and the lookup helper make, so each
 *    lookup reads nsswitch.conf and gai.conf afresh, as they are read once per process, and starts
 *    `rotate` at a random server. Every cache is cold: there is no nscd, the simulator caches
 *    nothing, and systemd-resolved runs with `Cache=no`.
 *
 * **systemd-resolved** (`--via-resolved`, Ubuntu 24.04): the box boots systemd with resolved
 * running, and a row whose server is its stub, 127.0.0.53, is played through it. resolved's
 * upstream is the simulator at 127.0.0.2, answering as the plan says the stub does, and the
 * questions glibc sends the stub are read from a capture on `lo` (`tcpdump`), since no simulator
 * can hold the stub's address. Every other row runs beside resolved as it would on such a host. The
 * run says resolved served the stub only where it saw it: every plan that asked the stub had
 * resolved ask the simulator (`resolvedObserved`).
 *
 * The run carries the sha256 of the rows file and of the policy's build it loaded
 * (`dist/src/resolver/system-names.js`), which the verdict holds to the files it judges by.
 */

const run = promisify(execFile);
const logger = pino({ level: 'silent' });

const LOOKUP = fileURLToPath(new URL('./names-lookup.js', import.meta.url));
const POLICY = fileURLToPath(new URL('../../src/resolver/system-names.js', import.meta.url));
const UPSTREAM = '127.0.0.2';
const SYSTEM_PATHS = ['/etc/hosts', '/etc/resolv.conf', '/etc/nsswitch.conf', '/etc/gai.conf'];
/** A lookup that has not ended by then is a fault of the run, not a wire. */
const LOOKUP_BOUND_MS = 120_000;
/** Datagrams glibc sent before it returned, given time to reach the simulator's worker. */
const SETTLE_MS = 60;
/** A capture given time to be on before the lookup, and to write what it saw before it stops. */
const CAPTURE_SETTLE_MS = 300;
/** A capture that has not said it is listening, or has not stopped, by then is a fault of the run. */
const CAPTURE_BOUND_MS = 10_000;

interface Args {
  readonly rows: string;
  readonly image: string;
  readonly viaResolved: boolean;
  readonly only: readonly string[] | undefined;
}

function args(argv: readonly string[]): Args {
  let rows = '';
  let image = '';
  let viaResolved = false;
  let only: string[] | undefined;
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    if (arg === '--rows') rows = argv[++k] ?? '';
    else if (arg === '--image') image = argv[++k] ?? '';
    else if (arg === '--via-resolved') viaResolved = true;
    else if (arg === '--only') only = (argv[++k] ?? '').split(',').filter((id) => id !== '');
    else throw new Error(`unknown argument ${String(arg)}`);
  }
  if (rows === '' || image === '') {
    throw new Error('usage: names-replay --rows <file> --image <name> [--via-resolved]');
  }
  return { rows, image, viaResolved, only };
}

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

const added = new Set<string>();

/** Puts an address on `lo` once: all of 127/8 is there already, and ::1 when IPv6 is on. */
async function onLoopback(address: string, v6: boolean): Promise<void> {
  if (added.has(address) || (!v6 && address.startsWith('127.')) || address === '::1') return;
  const argv = v6
    ? ['-6', 'addr', 'add', `${address}/128`, 'dev', 'lo', 'nodad']
    : ['addr', 'add', `${address}/32`, 'dev', 'lo'];
  try {
    await run('ip', argv);
  } catch (error: unknown) {
    const said = (error as { stderr?: unknown }).stderr;
    if (typeof said !== 'string' || !said.includes('File exists')) throw error;
  }
  added.add(address);
}

function enableIpv6(): boolean {
  for (const which of ['all', 'default', 'lo']) {
    try {
      writeFileSync(`/proc/sys/net/ipv6/conf/${which}/disable_ipv6`, '0');
    } catch {
      // A box with no IPv6 at all: rows that need it are unverified, and say so.
    }
  }
  return existsSync('/proc/sys/net/ipv6/conf/lo');
}

/** Writes the row's world over the image's files, and its hostname. What could not be is returned. */
function writeWorld(rows: RowsFile, row: Row): string[] {
  const problems: string[] = [];
  const paths = new Set([...SYSTEM_PATHS, ...Object.keys(row.world.files)]);
  for (const path of paths) {
    const id = row.world.files[path];
    try {
      if (id === undefined) {
        if (existsSync(path)) unlinkSync(path);
        continue;
      }
      const text = rows.texts[id];
      if (text === undefined) {
        problems.push(`the rows have no text ${id} for ${path}`);
        continue;
      }
      writeFileSync(path, text);
    } catch (error: unknown) {
      problems.push(`could not set ${path} up: ${String(error)}`);
    }
  }
  if (row.world.missingModules.length > 0) {
    problems.push(`removing NSS modules (${row.world.missingModules.join(', ')}) is not built`);
  }
  try {
    writeFileSync('/proc/sys/kernel/hostname', row.world.hostname);
  } catch (error: unknown) {
    problems.push(`could not set the hostname: ${String(error)}`);
  }
  return problems;
}

function childEnv(row: Row): Record<string, string> {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', ...row.world.env };
}

/** What the policy, loaded here against the world as written, makes of the question. */
async function inImage(row: Row): Promise<{ inImage: InImage; glibc: string | undefined }> {
  const policy = new GlibcNamePolicy({ logger, env: childEnv(row) });
  await policy.load();
  const glibc = policy.describe().glibc ?? undefined;
  const c = policy.classify(row.question.name, row.question.family);
  const conf = policy.view().conf;
  if (c.kind === 'off')
    return { inImage: { class: 'off', off: `${c.reason.code}: ${c.reason.why}` }, glibc };
  if (conf === undefined)
    return { inImage: { class: 'off', off: 'resolv.conf has no view' }, glibc };
  return {
    inImage: {
      class: c.kind,
      ...(c.kind === 'local' ? { via: c.via } : {}),
      ...(c.kind === 'cannotVouch' ? { reason: c.reason } : {}),
      ...(c.kind === 'walk' ? { candidates: c.candidates, types: c.types } : {}),
      servers: conf.servers,
      rotate: conf.options.rotate,
      timeout: conf.options.timeout,
      attempts: conf.options.attempts,
    },
    glibc,
  };
}

interface Servers {
  /** Every server the row names, canonical, in order. */
  readonly named: readonly string[];
  readonly specs: DnsServerSpec[];
  /** The simulator server that answers for each row server's address. */
  readonly answering: Map<string, string>;
  readonly throughStub: boolean;
}

/** The simulator's servers for a world: every server named, the strays, and resolved's upstream. */
async function serversFor(
  rows: RowsFile,
  row: Row,
  viaResolved: boolean,
  ipv6: boolean,
): Promise<Servers> {
  const resolvId = row.world.files['/etc/resolv.conf'];
  const named = nameserversOf(resolvId === undefined ? '' : (rows.texts[resolvId] ?? ''));
  for (const address of row.world.addresses) if (!named.includes(address)) named.push(address);
  const specs: DnsServerSpec[] = [];
  const answering = new Map<string, string>();
  let throughStub = false;
  let spare = 1;
  const spareV4 = (): string => `127.0.1.${String(spare++)}`;
  for (const address of named) {
    if (viaResolved && address === STUB) {
      throughStub = true;
      specs.push({
        ...NAMESERVER,
        name: `upstream:${UPSTREAM}`,
        address: UPSTREAM,
        port: 53,
        ipv6: false,
      });
      answering.set(address, `upstream:${UPSTREAM}`);
      continue;
    }
    const listener = listenerOf(address);
    if (listener.v4 !== undefined) {
      await onLoopback(listener.v4, false);
      specs.push({ ...NAMESERVER, name: address, address: listener.v4, port: 53, ipv6: false });
    } else if (listener.v6 !== undefined) {
      await onLoopback(listener.v6, true);
      specs.push({
        ...NAMESERVER,
        name: address,
        address: spareV4(),
        port: 53,
        address6: listener.v6,
      });
    }
    answering.set(address, address);
  }
  const v4s = new Set(specs.map((spec) => spec.address));
  const v6s = new Set(specs.map((spec) => spec.address6).filter((a) => a !== undefined));
  if (!v4s.has('127.0.0.1')) {
    specs.push({ ...NAMESERVER, name: '127.0.0.1', address: '127.0.0.1', port: 53, ipv6: false });
  }
  if (ipv6 && !v6s.has('::1')) {
    specs.push({ ...NAMESERVER, name: '::1', address: spareV4(), port: 53, address6: '::1' });
  }
  return { named, specs, answering, throughStub };
}

function replyOf(reply: Reply | undefined, type: 'A' | 'AAAA'): DnsReply {
  switch (reply ?? 'nxdomain') {
    case 'nxdomain':
      return replies.nxdomain;
    case 'servfail':
      return replies.servfail;
    case 'refused':
      return replies.refused;
    case 'silent':
      return replies.silent;
    case 'address':
      return replies.addresses(type === 'A' ? '192.0.2.53' : '2001:db8::53');
  }
}

async function answerAsPlanned(sim: DnsSimulator, servers: Servers, plan: Plan): Promise<void> {
  for (const spec of servers.specs) {
    const address = [...servers.answering].find(([, name]) => name === spec.name)?.[0];
    const answers = address === undefined ? {} : (plan.answers[address] ?? {});
    const behaviour: DnsBehaviour = {
      a: replyOf(answers.A, 'A'),
      aaaa: replyOf(answers.AAAA, 'AAAA'),
      other: replies.nxdomain,
    };
    await sim.set({ fallback: true }, behaviour, spec.name);
  }
}

interface Lookup {
  readonly outcome: string;
  readonly ms: number;
}

/** `getaddrinfo` in a process of its own, with the row's environment and nothing else. */
function lookUp(row: Row): Promise<Lookup> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [LOOKUP, row.question.name, String(row.question.family)],
      { env: childEnv(row), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the lookup did not end within ${String(LOOKUP_BOUND_MS)} ms`));
    }, LOOKUP_BOUND_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as Lookup);
      } catch {
        reject(new Error(`the lookup exited ${String(code)} saying ${JSON.stringify(out + err)}`));
      }
    });
  });
}

interface StubCapture {
  stop(): Promise<Asked[]>;
}

/** What glibc sends the stub, read off `lo`: the one server a simulator cannot be. */
async function captureStub(): Promise<StubCapture> {
  const file = '/tmp/ms-names-stub.pcap';
  rmSync(file, { force: true });
  const filter = `udp and dst host ${STUB} and dst port 53`;
  // `--immediate-mode`: libpcap otherwise holds packets in its ring until a block fills or times
  // out, and a capture stopped within that time writes none of them.
  const capture = await startCapture({
    command: 'tcpdump',
    argv: ['-i', 'lo', '-n', '--immediate-mode', '-U', '-Z', 'root', '-w', file, filter],
    ready: 'listening on',
    startBoundMs: CAPTURE_BOUND_MS,
    stopBoundMs: CAPTURE_BOUND_MS,
    settleMs: CAPTURE_SETTLE_MS,
  });
  return {
    async stop(): Promise<Asked[]> {
      await capture.stop();
      return pcapQuestions(readFileSync(file)).filter((one) => one.server === STUB);
    },
  };
}

async function playRow(
  rows: RowsFile,
  row: Row,
  e: Expectation,
  viaResolved: boolean,
  ipv6: boolean,
): Promise<{ run: RowRun; glibc: string | undefined }> {
  const setup = writeWorld(rows, row);
  const read = await inImage(row);
  const servers = await serversFor(rows, row, viaResolved, ipv6);
  if (row.world.ipv6 && !ipv6) setup.push('the row needs IPv6, which this box does not have');
  const cannot = unplayable(row.question.name, servers.named, viaResolved);
  if (cannot !== undefined) {
    return {
      run: { id: row.id, inImage: read.inImage, plans: [], setup: [...setup, cannot] },
      glibc: read.glibc,
    };
  }
  const plans: PlanRun[] = [];
  const sim = await DnsSimulator.start({ servers: servers.specs, ipv6: false });
  try {
    for (const plan of e.plans) {
      await answerAsPlanned(sim, servers, plan);
      await sim.clearLog();
      if (servers.throughStub) await run('resolvectl', ['flush-caches']);
      const capture = servers.throughStub ? await captureStub() : undefined;
      const looked = await lookUp(row);
      await sleep(SETTLE_MS);
      const stub = capture === undefined ? [] : await capture.stop();
      const log = await sim.log();
      const upstream = log.filter((entry) => entry.server.startsWith('upstream:'));
      const asked = log
        .filter((entry) => !entry.server.startsWith('upstream:'))
        .map((entry) => ({
          server: entry.server,
          qname: entry.qname,
          qtype: entry.qtype,
          transport: entry.transport,
        }));
      plans.push({
        plan: plan.plan,
        wire: wireOf([...stub, ...asked]),
        outcome: looked.outcome,
        ms: looked.ms,
        ...(servers.throughStub
          ? {
              upstream: wireOf(
                upstream.map((entry) => ({
                  server: UPSTREAM,
                  qname: entry.qname,
                  qtype: entry.qtype,
                  transport: entry.transport,
                })),
              ),
            }
          : {}),
      });
    }
  } finally {
    await sim.stop();
  }
  return {
    run: { id: row.id, inImage: read.inImage, plans, ...(setup.length > 0 ? { setup } : {}) },
    glibc: read.glibc,
  };
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  const rowsBytes = readFileSync(a.rows);
  const rows = JSON.parse(rowsBytes.toString('utf8')) as RowsFile;
  if (!Object.hasOwn(rows.images, a.image)) throw new Error(`${a.image} is no image of the rows`);
  const ipv6 = enableIpv6();
  const runs: RowRun[] = [];
  let glibc: string | undefined;
  for (const row of rows.rows) {
    if (a.only !== undefined && !a.only.includes(row.id)) continue;
    const e = expectationIn(row, a.image);
    if (e === null) continue;
    const started = performance.now();
    const played = await playRow(rows, row, e, a.viaResolved, ipv6);
    glibc ??= played.glibc;
    runs.push(played.run);
    say(
      `${a.image} ${row.id} ${row.title}: ${played.run.plans.map((p) => `${p.plan} ${String(p.wire.length)}q`).join(', ')} ` +
        `(${String(Math.round(performance.now() - started))} ms)`,
    );
  }
  const image: ImageRun = {
    image: a.image,
    glibc,
    node: process.version,
    base: process.env['MS_DIFF_BASE'] ?? 'unknown',
    digest: process.env['MS_DIFF_DIGEST'] ?? 'unknown',
    rowsDigest: digestOf(rowsBytes),
    policyDigest: digestOf(readFileSync(POLICY)),
    resolved: a.viaResolved && resolvedObserved(runs),
    rows: runs,
  };
  process.stdout.write(`${JSON.stringify(image)}\n`);
}

await main();
