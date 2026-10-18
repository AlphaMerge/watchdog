import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import { within } from './support/within.js';
import {
  NameResolver,
  systemResolverFiles,
  type Family,
  type WatchedReading,
} from '../src/resolver/name-resolver.js';
import {
  digestOf,
  DIGEST_ABSENT,
  GlibcNamePolicy,
  hostsTable,
  inetAton,
  inetPton4,
  inetPton6,
  NARROWINGS,
  nssModuleLook,
  POLICY_LOAD_MS,
  POLICY_LOOK_MS,
  readNsswitch,
  readResolvConf,
  searchCandidates,
  SYSTEM_FILES,
  type Environment,
  type ModuleLook,
  type NameClass,
  type Narrowing,
  type OffCode,
  type QType,
  type ResolverOptions,
  type SystemFiles,
} from '../src/resolver/system-names.js';

/**
 * The gate's allowlist of the system's name lookups (`P-432` S4): the shapes of resolv.conf,
 * nsswitch.conf and the environment the check is on with, one row for each shape it is off for, the
 * classes a name falls in and the candidates the walk asks, the hosts file, and what turns the
 * check off after load. Every fixture is file contents and an environment handed in: nothing here
 * reads the host's own /etc.
 *
 * **Every row is this policy's reading of glibc's source, not a recording of glibc.** So every row
 * the check is on for, and that it walks or calls `local`, is also exported for the differential
 * (S8) to replay against real glibc: `test/fixtures/system-names-rows.json`, checked here to be the
 * tables' rows as the policy reads them now, and written afresh with `MS_WRITE_S8_ROWS=1` (then
 * `prettier --write` it). A row the check is off for, or cannot vouch for, claims nothing about the
 * wire and is not exported. Its schema (2):
 *
 * - `images`: the images S8 replays in, by name, with their upstream glibc.
 * - `texts`: each file's contents, once, by id (`t` and the first 12 hex digits of its sha256).
 * - `rows`, each:
 *   - `id`: the first 16 hex digits of the sha256 of the row's `world` and `question` as JSON with
 *     sorted keys, so a row keeps its id however the tables move, and another row gets another;
 *   - `title`: what the row is about;
 *   - `world`: `glibc`, the version the row is stated at; `hostname`; `env`; `files`, each system
 *     path to a text id (a path not listed is absent); `missingModules`, the NSS modules to leave
 *     uninstalled; `addresses`, the addresses the container must answer DNS on (the row's servers);
 *     and `ipv6`, whether it needs IPv6 for them;
 *   - `question`: `name` and `family` (0, 4 or 6), as `getaddrinfo` is asked with hints 0;
 *   - `expect`, at `world.glibc`: `class` (`local` or `walk`), `via` for a local name, and for a
 *     walked one the `candidates` in order and the `types` asked of each, A first; the `servers`
 *     in order, `rotate`, and the `plans`;
 *   - `byImage`: the expectation in an image where it is not `expect`, or null where the check is
 *     off in that image, which then does not replay the row.
 * - A plan is what the simulator answers and what glibc should send. `answers` gives each server's
 *   reply to each type: `nxdomain`, `servfail`, `refused`, `silent`, or `address` (an A or AAAA
 *   record). `wire` is the questions glibc sends, in order, as `[server, name, type, try]`, `try`
 *   from 1; for a `local` row it is empty. Under `rotate` with more than one server glibc starts
 *   each send at the server after the last send's start, from a random first one
 *   (resolv/res_send.c `nameserver_offset`), so `wireByOffset[k]` is the wire when the first send
 *   starts at server k. Every walked row has a plan in which every server answers NXDOMAIN, each
 *   candidate then asked of one server and the next candidate after it (`__res_context_search`
 *   goes on after HOST_NOT_FOUND), and plans in which every server but the last fails, by SERVFAIL,
 *   REFUSED or silence, and the last answers, each server then asked in turn for the first
 *   candidate (resolv/res_send.c `send_dg` goes to the next server on SERVFAIL, NOTIMP or REFUSED,
 *   and on a timeout); with one server, a plan in which it answers.
 * - S8 sets up each row's world in each image, plays each plan with the S5 simulator, records the
 *   questions glibc sends, and writes what it verified to the recordings file. A row whose
 *   recording disagrees is fixed in the policy, or turns the check off, before the cut.
 *
 * **Recordings** (`test/fixtures/system-names-recordings.json`, schema 1) are S8's, never this
 * test's: each `{ id, image, plan, offset?, wire }` is the wire glibc sent for a row's plan in an
 * image. For every one, this test asserts that the row is still exported under that id, is still
 * replayed in that image, and still expects that wire, so a regeneration cannot paper over a
 * regression.
 */

const silent = pino({ level: 'silent' });

const FILES: SystemFiles = {
  hosts: '/fixture/etc/hosts',
  resolvConf: '/fixture/etc/resolv.conf',
  nsswitchConf: '/fixture/etc/nsswitch.conf',
  gaiConf: '/fixture/etc/gai.conf',
  ldSoPreload: '/fixture/etc/ld.so.preload',
  nscdSocket: '/fixture/run/nscd/socket',
};

const SERVER = 'nameserver 10.0.0.53\n';
const CORP = 'nameserver 10.0.0.53\nsearch corp.example\n';
/** systemd-resolved's stub file, as Ubuntu ships it. */
const STUB = 'nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n';
const FD = 'hosts: files dns\n';
const FDM = 'hosts: files dns myhostname\n';
const FMD = 'hosts: files myhostname dns\n';

const HOSTS = [
  '127.0.0.1 localhost',
  '::1 localhost ip6-localhost ip6-loopback',
  '::ffff:192.0.2.20 mapped4',
  '::192.0.2.21 compat6',
  '192.0.2.10 printer Printer-Alias',
  '192.0.2.11 nas.lan',
  'fe80::1%eth0 router',
  'fe80::2 router6',
  '010.0.0.1 oldbox',
  '10.1 shortbox',
  '192.0.2.13 _gateway',
  '2001:db8::5 v6only',
  '192.0.2.14 both # a comment names nothing',
  '2001:db8::14 both',
  '   192.0.2.15   indented',
  '192.0.2.16 dotted.',
  '# 192.0.2.17 commented',
  '192.0.2.18',
  '',
].join('\n');

interface Fixture {
  readonly resolv?: string;
  readonly nsswitch?: string;
  readonly hosts?: string;
  readonly gai?: string;
  /** /etc/ld.so.preload's text: absent unless given. */
  readonly preload?: string;
  readonly env?: Environment;
  /** glibc's runtime version; null off glibc. */
  readonly glibc?: string | null;
  readonly platform?: string;
  /** The hostname, or how to read it now. */
  readonly hostname?: string | (() => string);
  readonly nscd?: boolean;
  readonly unreadable?: readonly string[];
  /** Files that are not there (ENOENT); `''` is an empty file. */
  readonly absent?: readonly string[];
  /** NSS modules not installed: every other one is. */
  readonly missingModules?: readonly string[];
  /** NSS modules whose presence cannot be told. */
  readonly unknownModules?: readonly string[];
}

function policyFor(
  f: Fixture = {},
  logger: Logger = silent,
): {
  policy: GlibcNamePolicy;
  nscd: { present: boolean };
  modules: { missing: Set<string>; unknown: Set<string>; asked: string[] };
} {
  const texts = new Map<string, string>([
    [FILES.resolvConf, f.resolv ?? SERVER],
    [FILES.nsswitchConf, f.nsswitch ?? FD],
    [FILES.hosts, f.hosts ?? HOSTS],
    [FILES.gaiConf, f.gai ?? ''],
  ]);
  const nscd = { present: f.nscd ?? false };
  const modules = {
    missing: new Set(f.missingModules ?? []),
    unknown: new Set(f.unknownModules ?? []),
    asked: [] as string[],
  };
  const policy = new GlibcNamePolicy({
    logger,
    files: FILES,
    env: f.env ?? {},
    platform: f.platform ?? 'linux',
    glibcVersion: () => (f.glibc === null ? undefined : (f.glibc ?? '2.39')),
    nodeVersion: 'v24.0.0-test',
    hostname: hostnameOf(f.hostname),
    readText: (path) =>
      Promise.resolve(
        f.unreadable?.includes(path) === true
          ? undefined
          : f.absent?.includes(path) === true ||
              (path === FILES.ldSoPreload && f.preload === undefined)
            ? null
            : path === FILES.ldSoPreload
              ? f.preload
              : (texts.get(path) ?? ''),
      ),
    socketExists: () => Promise.resolve(nscd.present),
    moduleLook: (name) => {
      modules.asked.push(name);
      return Promise.resolve<ModuleLook>(
        modules.unknown.has(name)
          ? { state: 'unknown', why: `whether libnss_${name}.so.2 loads is not known (test)` }
          : { state: modules.missing.has(name) ? 'absent' : 'installed' },
      );
    },
  });
  return { policy, nscd, modules };
}

async function loaded(f: Fixture = {}, logger: Logger = silent): Promise<GlibcNamePolicy> {
  const { policy } = policyFor(f, logger);
  await policy.load();
  return policy;
}

/** Every module installed. */
const installed = (): Promise<ModuleLook> => Promise.resolve({ state: 'installed' });

/** The fixture's hostname as the policy reads it: `probe-1` unless the fixture says. */
function hostnameOf(hostname: Fixture['hostname']): () => string {
  if (typeof hostname === 'function') return hostname;
  return () => hostname ?? 'probe-1';
}

/** A file as one look of the watch hands it on: null when it is absent, undefined when unreadable. */
function reading(file: string, text: string | null | undefined): WatchedReading {
  if (text === null) return { file, text: '', digest: DIGEST_ABSENT };
  if (text === undefined) return { file, text, digest: 'unreadable:EACCES' };
  return { file, text, digest: digestOf(text) };
}

/** A class as one word: `local:hosts`, `cannotVouch:localhost`, `off:nscd`, `walk:a.corp,a`. */
function verdict(c: NameClass): string {
  switch (c.kind) {
    case 'local':
      return `local:${c.via}`;
    case 'cannotVouch':
      return `cannotVouch:${c.reason}`;
    case 'off':
      return `off:${c.reason.code}`;
    case 'walk':
      return `walk:${c.candidates.join(',')}`;
  }
}

/** The code the check is off for, or `on`. */
const offOf = (policy: GlibcNamePolicy): string => policy.view().off?.code ?? 'on';

const FAMILIES: readonly Family[] = [0, 4, 6];
const TYPES: Readonly<Record<Family, readonly QType[]>> = {
  0: ['A', 'AAAA'],
  4: ['A'],
  6: ['AAAA'],
};

/** mulberry32: the same runs every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function capture(level: 'warn' | 'error' = 'warn'): {
  logger: Logger;
  lines: () => Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines: () => lines };
}

// --- rule 2: the resolv.conf shapes the check is on with ----------------------------------------

const DEFAULT_OPTIONS: ResolverOptions = {
  ndots: 1,
  timeout: 5,
  attempts: 2,
  rotate: false,
  edns0: false,
  trustAd: false,
};

interface ResolvRow {
  readonly name: string;
  readonly resolv: string;
  readonly hostname?: string;
  readonly glibc?: string;
  readonly servers: readonly string[];
  readonly search: readonly string[];
  readonly searchFrom: string;
  readonly options?: Partial<ResolverOptions>;
}

// resolv/res_init.c `res_vinit_1` and `res_setoptions`; resolv/resolv_conf.c `update_from_conf`.
const RESOLV_ROWS: readonly ResolvRow[] = [
  {
    name: 'one IPv4 server, no search list, a hostname with no dot',
    resolv: SERVER,
    servers: ['10.0.0.53'],
    search: [],
    searchFrom: 'none',
  },
  {
    name: 'the first MAXNS (3) servers (update_from_conf)',
    resolv: 'nameserver 10.0.0.1\nnameserver 10.0.0.2\nnameserver 10.0.0.3\nnameserver 10.0.0.4\n',
    servers: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
    search: [],
    searchFrom: 'none',
  },
  {
    name: 'a fourth server is never asked, so it may repeat the first',
    resolv: 'nameserver 10.0.0.1\nnameserver 10.0.0.2\nnameserver 10.0.0.3\nnameserver 10.0.0.1\n',
    servers: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
    search: [],
    searchFrom: 'none',
  },
  {
    name: 'IPv6 servers by inet_pton, as c-ares takes them',
    resolv: 'nameserver ::1\nnameserver 2001:DB8:0:0:0:0:0:1\nnameserver ::ffff:10.0.0.1\n',
    servers: ['::1', '2001:db8::1', '::ffff:a00:1'],
    search: [],
    searchFrom: 'none',
  },
  {
    name: 'a tab after the keyword, blanks between words and after them (MATCH, the cut)',
    resolv: 'nameserver\t10.0.0.53 \t\nsearch  corp.example\tlab.example  \n',
    servers: ['10.0.0.53'],
    search: ['corp.example', 'lab.example'],
    searchFrom: 'search',
  },
  {
    name: 'comments with # and ;, blank lines and lines of blanks',
    resolv:
      '# written by hand\n; nameserver bogus\n\n   \n\t\noptions\tndots:2\n# options no-aaaa\nnameserver 10.0.0.53\n',
    servers: ['10.0.0.53'],
    search: [],
    searchFrom: 'none',
    options: { ndots: 2 },
  },
  {
    name: 'search, then domain: the last line wins (search_list_clear)',
    resolv: 'search a.example b.example\ndomain c.example\nnameserver 10.0.0.53\n',
    servers: ['10.0.0.53'],
    search: ['c.example'],
    searchFrom: 'domain',
  },
  {
    name: 'domain, then search: the last line wins',
    resolv: 'domain c.example\nsearch a.example b.example\nnameserver 10.0.0.53\n',
    servers: ['10.0.0.53'],
    search: ['a.example', 'b.example'],
    searchFrom: 'search',
  },
  {
    name: 'systemd-resolved’s stub file: search . is the root (root_on_list)',
    resolv: STUB,
    servers: ['127.0.0.53'],
    search: ['.'],
    searchFrom: 'search',
    options: { edns0: true, trustAd: true },
  },
  {
    name: 'no search line: the hostname’s domain (domain_from_hostname)',
    resolv: SERVER,
    hostname: 'probe-1.lab.example',
    servers: ['10.0.0.53'],
    search: ['lab.example'],
    searchFrom: 'hostname',
  },
  {
    name: 'a search line overrides the hostname’s domain',
    resolv: CORP,
    hostname: 'probe-1.lab.example',
    servers: ['10.0.0.53'],
    search: ['corp.example'],
    searchFrom: 'search',
  },
  {
    name: 'a long search list (unlimited since 2.26)',
    resolv:
      'nameserver 10.0.0.53\nsearch a.example b.example c.example d.example e.example f.example g.example h.example\n',
    servers: ['10.0.0.53'],
    search: [
      'a.example',
      'b.example',
      'c.example',
      'd.example',
      'e.example',
      'f.example',
      'g.example',
      'h.example',
    ],
    searchFrom: 'search',
  },
  {
    name: 'options ndots:0, the lowest',
    resolv: 'nameserver 10.0.0.53\nsearch corp.example\noptions ndots:0\n',
    servers: ['10.0.0.53'],
    search: ['corp.example'],
    searchFrom: 'search',
    options: { ndots: 0 },
  },
  {
    name: 'options ndots:15, the highest (RES_MAXNDOTS)',
    resolv: 'nameserver 10.0.0.53\nsearch corp.example\noptions ndots:15\n',
    servers: ['10.0.0.53'],
    search: ['corp.example'],
    searchFrom: 'search',
    options: { ndots: 15 },
  },
  {
    name: 'timeout and attempts capped at 30 and 5 (RES_MAXRETRANS, RES_MAXRETRY)',
    resolv: 'nameserver 10.0.0.53\noptions timeout:31 attempts:9\n',
    servers: ['10.0.0.53'],
    search: [],
    searchFrom: 'none',
    options: { timeout: 30, attempts: 5 },
  },
  {
    name: 'timeout:0, held as 1 since send_dg floors each try at 1 s, and attempts:1',
    resolv: 'nameserver 10.0.0.53\noptions timeout:0 attempts:1\n',
    servers: ['10.0.0.53'],
    search: [],
    searchFrom: 'none',
    options: { timeout: 1, attempts: 1 },
  },
  {
    name: 'rotate, edns0 and trust-ad, with three servers',
    resolv:
      'nameserver 10.0.0.1\nnameserver 10.0.0.2\nnameserver 10.0.0.3\nsearch corp.example\noptions rotate edns0 trust-ad\n',
    servers: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
    search: ['corp.example'],
    searchFrom: 'search',
    options: { rotate: true, edns0: true, trustAd: true },
  },
  {
    name: 'rotate with two servers',
    resolv: 'nameserver 10.0.0.1\nnameserver 10.0.0.2\nsearch corp.example\noptions rotate\n',
    servers: ['10.0.0.1', '10.0.0.2'],
    search: ['corp.example'],
    searchFrom: 'search',
    options: { rotate: true },
  },
  {
    name: 'a later option word wins, over lines',
    resolv: 'nameserver 10.0.0.53\noptions ndots:2 timeout:3\noptions ndots:4\n',
    servers: ['10.0.0.53'],
    search: [],
    searchFrom: 'none',
    options: { ndots: 4, timeout: 3 },
  },
  {
    name: 'an options line with no words',
    resolv: 'nameserver 10.0.0.53\noptions \n',
    servers: ['10.0.0.53'],
    search: [],
    searchFrom: 'none',
  },
  {
    name: 'the last line with no newline (getline)',
    resolv: 'search corp.example\nnameserver 10.0.0.53',
    servers: ['10.0.0.53'],
    search: ['corp.example'],
    searchFrom: 'search',
  },
  {
    name: 'at glibc 2.28, the oldest',
    resolv: CORP,
    glibc: '2.28',
    servers: ['10.0.0.53'],
    search: ['corp.example'],
    searchFrom: 'search',
  },
  {
    name: 'at glibc 2.42, the newest',
    resolv: CORP,
    glibc: '2.42',
    servers: ['10.0.0.53'],
    search: ['corp.example'],
    searchFrom: 'search',
  },
];

const resolvFixture = (row: ResolvRow): Fixture => ({
  resolv: row.resolv,
  ...(row.hostname === undefined ? {} : { hostname: row.hostname }),
  ...(row.glibc === undefined ? {} : { glibc: row.glibc }),
});

describe('rule 2: the resolv.conf shapes the check is on with', () => {
  for (const row of RESOLV_ROWS) {
    it(row.name, async () => {
      assert.deepEqual(readResolvConf(row.resolv, row.hostname ?? 'probe-1'), {
        ok: true,
        value: {
          servers: row.servers,
          search: row.search,
          searchFrom: row.searchFrom,
          options: { ...DEFAULT_OPTIONS, ...row.options },
        },
      });
      const policy = await loaded(resolvFixture(row));
      assert.equal(offOf(policy), 'on');
      assert.deepEqual(policy.describe().servers, row.servers);
      assert.equal(verdict(policy.classify('sw1', 0)).startsWith('walk:'), true);
    });
  }
});

// --- every rule, one row for each shape it is off for --------------------------------------------

interface OffRow {
  readonly name: string;
  readonly fixture: Fixture;
  readonly code: OffCode;
  /** What the reason names. */
  readonly why: string;
  /** The narrowing the reason names, for a shape every glibc reads alike (`NARROWINGS`). */
  readonly narrowing?: Narrowing;
}

const ns = (options: string): Fixture => ({ resolv: `${SERVER}options ${options}\n` });
const nsLine = (line: string): Fixture => ({ resolv: `${line}\n` });

const OFF_ROWS: readonly OffRow[] = [
  // Rule 1.
  { name: 'darwin', fixture: { platform: 'darwin' }, code: 'platform', why: 'darwin, not Linux' },
  { name: 'win32', fixture: { platform: 'win32' }, code: 'platform', why: 'win32' },
  { name: 'musl: no glibc version', fixture: { glibc: null }, code: 'libc', why: 'not glibc' },
  {
    name: 'glibc 2.27',
    fixture: { glibc: '2.27' },
    code: 'glibc',
    why: 'glibc 2.27 is outside 2.28 to 2.42',
  },
  { name: 'glibc 2.43', fixture: { glibc: '2.43' }, code: 'glibc', why: 'glibc 2.43' },
  { name: 'glibc 3.0', fixture: { glibc: '3.0' }, code: 'glibc', why: 'glibc 3.0' },
  // Rule 2.
  {
    name: 'resolv.conf unreadable',
    fixture: { unreadable: [FILES.resolvConf] },
    code: 'unreadable',
    why: FILES.resolvConf,
  },
  {
    name: 'resolv.conf absent',
    fixture: { absent: [FILES.resolvConf] },
    code: 'resolv',
    why: 'absent',
    narrowing: 'no-server',
  },
  {
    name: 'resolv.conf empty',
    fixture: { resolv: '' },
    code: 'resolv',
    why: 'names no name server',
    narrowing: 'no-server',
  },
  {
    name: 'a search line and no server',
    fixture: { resolv: 'search corp.example\n' },
    code: 'resolv',
    why: 'names no name server',
    narrowing: 'no-server',
  },
  {
    name: 'a NUL after a server (V3-7)',
    fixture: { resolv: 'nameserver 10.0.0.2\0\n' },
    code: 'resolv',
    why: 'NUL',
  },
  {
    name: 'a NUL among options (V3-7)',
    fixture: { resolv: `${SERVER}options rotate\0 no-aaaa\n` },
    code: 'resolv',
    why: 'NUL',
  },
  {
    name: 'a DOS line ending (GRF-4, F3)',
    fixture: { resolv: 'nameserver 10.0.0.53\r\n' },
    code: 'resolv',
    why: 'CR',
  },
  {
    name: 'options -no-aaaa (GRF-1)',
    fixture: ns('-no-aaaa'),
    code: 'resolv',
    why: 'options -no-aaaa',
  },
  {
    name: 'options -rotate (GRF-1)',
    fixture: ns('-rotate'),
    code: 'resolv',
    why: 'options -rotate',
  },
  {
    name: 'options no-aaaa (GRF-5, F2)',
    fixture: ns('no-aaaa'),
    code: 'resolv',
    why: 'options no-aaaa',
  },
  {
    name: 'options strict-error with one server (V3-2, T1)',
    fixture: ns('strict-error'),
    code: 'resolv',
    why: 'options strict-error',
  },
  {
    name: 'options strict-error with two servers (GRF-2)',
    fixture: { resolv: 'nameserver 10.0.0.2\nnameserver 10.0.0.3\noptions strict-error\n' },
    code: 'resolv',
    why: 'options strict-error',
  },
  {
    name: 'options single-request, which freezes a thread’s resolv.conf below 2.40 (V3-1)',
    fixture: ns('single-request'),
    code: 'resolv',
    why: 'options single-request',
  },
  {
    name: 'options single-request-reopen',
    fixture: ns('single-request-reopen'),
    code: 'resolv',
    why: 'single-request-reopen',
  },
  { name: 'options no-reload (GRF-3)', fixture: ns('no-reload'), code: 'resolv', why: 'no-reload' },
  { name: 'options use-vc', fixture: ns('use-vc'), code: 'resolv', why: 'use-vc' },
  { name: 'options inet6', fixture: ns('inet6'), code: 'resolv', why: 'inet6' },
  {
    name: 'options no-tld-query',
    fixture: ns('no-tld-query'),
    code: 'resolv',
    why: 'no-tld-query',
  },
  {
    name: 'options no_tld_query',
    fixture: ns('no_tld_query'),
    code: 'resolv',
    why: 'no_tld_query',
  },
  {
    name: 'options rotatex, which glibc matches as rotate by its prefix',
    fixture: ns('rotatex'),
    code: 'resolv',
    why: 'options rotatex',
  },
  {
    name: 'options ndots:16, which glibc takes as 15',
    fixture: ns('ndots:16'),
    code: 'resolv',
    why: 'ndots:16',
    narrowing: 'ndots-over-15',
  },
  {
    name: 'options ndots:999999999, the most digits the check reads',
    fixture: ns('ndots:999999999'),
    code: 'resolv',
    why: 'ndots:999999999',
    narrowing: 'ndots-over-15',
  },
  { name: 'options ndots:-1 (GRF-7)', fixture: ns('ndots:-1'), code: 'resolv', why: 'ndots:-1' },
  {
    name: 'options ndots:2147483648, stored as 0 (GRF-7, F8)',
    fixture: ns('ndots:2147483648'),
    code: 'resolv',
    why: 'ndots:2147483648',
  },
  { name: 'options ndots:x', fixture: ns('ndots:x'), code: 'resolv', why: 'ndots:x' },
  { name: 'options ndots: with no number', fixture: ns('ndots:'), code: 'resolv', why: 'ndots:' },
  { name: 'options ndots:01', fixture: ns('ndots:01'), code: 'resolv', why: 'ndots:01' },
  {
    name: 'options ndots: 2, a blank after the colon',
    fixture: ns('ndots: 2'),
    code: 'resolv',
    why: 'options ndots: ',
  },
  {
    name: 'options attempts:0, which asks no server (GRF-8)',
    fixture: ns('attempts:0'),
    code: 'resolv',
    why: 'attempts:0',
  },
  {
    name: 'options timeout: with ten digits',
    fixture: ns('timeout:1234567890'),
    code: 'resolv',
    why: 'timeout:1234567890',
  },
  {
    name: 'a good word, then a bad one',
    fixture: ns('rotate edns1'),
    code: 'resolv',
    why: 'options edns1',
  },
  {
    name: 'a sortlist line',
    fixture: { resolv: `${SERVER}sortlist 10.0.0.0/255.0.0.0\n` },
    code: 'resolv',
    why: 'sortlist',
  },
  {
    name: 'an unknown keyword',
    fixture: { resolv: `${SERVER}lookup file bind\n` },
    code: 'resolv',
    why: 'lookup file bind',
  },
  {
    name: 'an indented keyword',
    fixture: nsLine(' nameserver 10.0.0.53'),
    code: 'resolv',
    why: 'is no nameserver',
  },
  {
    name: 'a capitalised keyword',
    fixture: nsLine('Nameserver 10.0.0.53'),
    code: 'resolv',
    why: 'Nameserver',
  },
  {
    name: 'a keyword alone',
    fixture: { resolv: `${SERVER}nameserver\n` },
    code: 'resolv',
    why: 'line 2, "nameserver", is no',
  },
  {
    name: 'an indented comment',
    fixture: { resolv: `${SERVER}  # a note\n` },
    code: 'resolv',
    why: 'is no nameserver',
  },
  {
    name: 'nameserver 10.1, an inet_aton form (O-OS-11)',
    fixture: nsLine('nameserver 10.1'),
    code: 'resolv',
    why: 'one IPv4 or IPv6 address',
  },
  {
    name: 'nameserver 010.0.0.1, octal to inet_aton',
    fixture: nsLine('nameserver 010.0.0.1'),
    code: 'resolv',
    why: 'one IPv4',
  },
  {
    name: 'nameserver 0x7f.0.0.1',
    fixture: nsLine('nameserver 0x7f.0.0.1'),
    code: 'resolv',
    why: 'one IPv4',
  },
  {
    name: 'nameserver 2130706433',
    fixture: nsLine('nameserver 2130706433'),
    code: 'resolv',
    why: 'one IPv4',
  },
  {
    name: 'nameserver 300.1.1.1',
    fixture: nsLine('nameserver 300.1.1.1'),
    code: 'resolv',
    why: 'one IPv4',
  },
  {
    name: 'nameserver bogus',
    fixture: nsLine('nameserver bogus'),
    code: 'resolv',
    why: 'one IPv4',
  },
  {
    name: 'a scope id',
    fixture: nsLine('nameserver fe80::1%eth0'),
    code: 'resolv',
    why: 'no scope',
  },
  {
    name: 'text after the address',
    fixture: nsLine('nameserver 10.0.0.53 # the site resolver'),
    code: 'resolv',
    why: 'nothing after it',
  },
  {
    name: 'one server named twice',
    fixture: { resolv: 'nameserver 10.0.0.1\nnameserver 10.0.0.2\nnameserver 10.0.0.1\n' },
    code: 'resolv',
    why: 'name server 10.0.0.1 is named twice',
  },
  {
    name: 'one IPv6 server written two ways',
    fixture: { resolv: 'nameserver ::1\nnameserver 0:0:0:0:0:0:0:1\n' },
    code: 'resolv',
    why: 'name server ::1 is named twice',
  },
  {
    name: 'domain with two words',
    fixture: { resolv: `${SERVER}domain a.example b.example\n` },
    code: 'resolv',
    why: 'a domain line names one domain',
    narrowing: 'domain-words',
  },
  {
    name: 'a blank domain line (T7)',
    fixture: { resolv: `${SERVER}domain \n` },
    code: 'resolv',
    why: 'a domain line',
    narrowing: 'blank-search',
  },
  {
    name: 'a blank search line (T7)',
    fixture: { resolv: `${SERVER}search \t\n` },
    code: 'resolv',
    why: 'a search line',
    narrowing: 'blank-search',
  },
  {
    name: 'a capitalised search domain',
    fixture: { resolv: `${SERVER}search Corp.example\n` },
    code: 'resolv',
    why: '"Corp.example"',
    narrowing: 'search-shape',
  },
  {
    name: 'a search domain with a trailing dot',
    fixture: { resolv: `${SERVER}search corp.example.\n` },
    code: 'resolv',
    why: '"corp.example."',
    narrowing: 'search-shape',
  },
  {
    name: 'a search domain with a leading dot',
    fixture: { resolv: `${SERVER}search .corp\n` },
    code: 'resolv',
    why: '".corp"',
    narrowing: 'search-shape',
  },
  {
    name: 'a search domain with an underscore',
    fixture: { resolv: `${SERVER}search _sip.example\n` },
    code: 'resolv',
    why: '"_sip.example"',
    narrowing: 'search-shape',
  },
  {
    name: 'a search domain with an empty label',
    fixture: { resolv: `${SERVER}search a..b\n` },
    code: 'resolv',
    why: '"a..b"',
    narrowing: 'search-shape',
  },
  {
    name: 'a search domain with a label of 64',
    fixture: { resolv: `${SERVER}search ${'a'.repeat(64)}.example\n` },
    code: 'resolv',
    why: 'a search line',
    narrowing: 'search-shape',
  },
  {
    name: 'no search line and a capitalised hostname domain',
    fixture: { hostname: 'probe-1.Lab.example' },
    code: 'resolv',
    why: 'the hostname’s domain, "Lab.example"',
    narrowing: 'search-shape',
  },
  // Rule 3.
  {
    name: 'LOCALDOMAIN',
    fixture: { env: { LOCALDOMAIN: 'corp.example' } },
    code: 'env',
    why: 'LOCALDOMAIN',
  },
  {
    name: 'LOCALDOMAIN empty, the root (O-OS-11)',
    fixture: { env: { LOCALDOMAIN: '' } },
    code: 'env',
    why: 'LOCALDOMAIN',
  },
  {
    name: 'RES_OPTIONS',
    fixture: { env: { RES_OPTIONS: 'ndots:2' } },
    code: 'env',
    why: 'RES_OPTIONS',
  },
  {
    name: 'RES_OPTIONS=-no-aaaa (GRF-1)',
    fixture: { env: { RES_OPTIONS: '-no-aaaa' } },
    code: 'env',
    why: 'RES_OPTIONS',
  },
  {
    name: 'HOSTALIASES',
    fixture: { env: { HOSTALIASES: '/etc/host.aliases' } },
    code: 'env',
    why: 'HOSTALIASES',
  },
  {
    name: 'LD_LIBRARY_PATH set',
    fixture: { env: { LD_LIBRARY_PATH: '/opt/lib' } },
    code: 'env',
    why: 'LD_LIBRARY_PATH',
  },
  {
    name: 'LD_PRELOAD set, whose library may answer getaddrinfo itself',
    fixture: { env: { LD_PRELOAD: '/opt/lib/libresolv-shim.so' } },
    code: 'env',
    why: 'LD_PRELOAD is set',
  },
  {
    name: 'LD_AUDIT set',
    fixture: { env: { LD_AUDIT: '/opt/lib/audit.so' } },
    code: 'env',
    why: 'LD_AUDIT is set',
  },
  {
    name: '/etc/ld.so.preload names a library',
    fixture: { preload: '/usr/lib/libresolv-shim.so\n' },
    code: 'env',
    why: `${FILES.ldSoPreload} is not empty`,
  },
  {
    name: '/etc/ld.so.preload with a comment alone, not empty all the same',
    fixture: { preload: '# nothing preloaded\n' },
    code: 'env',
    why: 'is not empty',
  },
  {
    name: '/etc/ld.so.preload unreadable, which ld.so passes over',
    fixture: { unreadable: [FILES.ldSoPreload] },
    code: 'unreadable',
    why: `${FILES.ldSoPreload} could not be read (unknown)`,
    narrowing: 'unreadable-as-absent',
  },
  // Rule 4.
  {
    name: 'nsswitch.conf unreadable',
    fixture: { unreadable: [FILES.nsswitchConf] },
    code: 'unreadable',
    why: FILES.nsswitchConf,
  },
  {
    name: 'nsswitch.conf absent',
    fixture: { absent: [FILES.nsswitchConf] },
    code: 'nsswitch',
    why: 'absent',
  },
  {
    name: 'no hosts: line',
    fixture: { nsswitch: 'passwd: files\n' },
    code: 'nsswitch',
    why: 'no hosts: line',
  },
  {
    name: 'only a Hosts: line, no hosts line to strcmp',
    fixture: { nsswitch: 'Hosts: files dns\n' },
    code: 'nsswitch',
    why: 'no hosts: line',
  },
  {
    name: 'two hosts: lines',
    fixture: { nsswitch: 'hosts: files dns\nhosts: files dns\n' },
    code: 'nsswitch',
    why: 'two hosts: lines',
  },
  {
    name: 'a bare hosts line after it, no sources to 2.33 and later',
    fixture: { nsswitch: 'hosts: files dns\nhosts\n' },
    code: 'nsswitch',
    why: 'two hosts: lines',
  },
  {
    name: 'the hosts: line last, with no newline',
    fixture: { nsswitch: 'passwd: files\nhosts: files dns' },
    code: 'nsswitch',
    why: 'no newline',
  },
  {
    name: 'a # after the sources (F1, NSS-1)',
    fixture: { nsswitch: 'hosts: files dns # mdns4\n' },
    code: 'nsswitch',
    why: 'has a #',
  },
  {
    name: 'a # alone after them',
    fixture: { nsswitch: 'hosts: files dns #\n' },
    code: 'nsswitch',
    why: 'has a #',
  },
  {
    name: 'myhostname [SUCCESS=continue] (F5)',
    fixture: { nsswitch: 'hosts: files myhostname [SUCCESS=continue] dns\n' },
    code: 'nsswitch',
    why: 'action group',
  },
  {
    name: 'files [NOTFOUND=return] dns',
    fixture: { nsswitch: 'hosts: files [NOTFOUND=return] dns\n' },
    code: 'nsswitch',
    why: 'action group',
  },
  {
    name: 'Debian’s mdns4_minimal line',
    fixture: { nsswitch: 'hosts: files mdns4_minimal [NOTFOUND=return] dns myhostname\n' },
    code: 'nsswitch',
    why: 'action group',
  },
  {
    name: 'Ubuntu’s resolve line (T3)',
    fixture: { nsswitch: 'hosts: files resolve [!UNAVAIL=return] dns\n' },
    code: 'nsswitch',
    why: 'action group',
  },
  {
    name: 'files resolve dns (V3-4, T6)',
    fixture: { nsswitch: 'hosts: files resolve dns\n' },
    code: 'nsswitch',
    why: 'names "resolve"',
  },
  {
    name: 'files mdns4_minimal dns',
    fixture: { nsswitch: 'hosts: files mdns4_minimal dns\n' },
    code: 'nsswitch',
    why: 'names "mdns4_minimal"',
  },
  {
    name: 'sss before files',
    fixture: { nsswitch: 'hosts: sss files dns\n' },
    code: 'nsswitch',
    why: 'names "sss"',
  },
  {
    name: 'mymachines after dns',
    fixture: { nsswitch: 'hosts: files dns mymachines\n' },
    code: 'nsswitch',
    why: 'names "mymachines"',
  },
  {
    name: 'dns before files',
    fixture: { nsswitch: 'hosts: dns files\n' },
    code: 'nsswitch',
    why: 'is "dns files"',
  },
  {
    name: 'files alone',
    fixture: { nsswitch: 'hosts: files\n' },
    code: 'nsswitch',
    why: 'is "files"',
  },
  { name: 'dns alone', fixture: { nsswitch: 'hosts: dns\n' }, code: 'nsswitch', why: 'is "dns"' },
  {
    name: 'myhostname first',
    fixture: { nsswitch: 'hosts: myhostname files dns\n' },
    code: 'nsswitch',
    why: 'is "myhostname files dns"',
  },
  {
    name: 'dns twice',
    fixture: { nsswitch: 'hosts: files dns dns\n' },
    code: 'nsswitch',
    why: 'is "files dns dns"',
  },
  { name: 'no sources', fixture: { nsswitch: 'hosts:\n' }, code: 'nsswitch', why: 'is ""' },
  {
    name: 'hosts::files dns (NSS-4)',
    fixture: { nsswitch: 'hosts::files dns\n' },
    code: 'nsswitch',
    why: 'names ":files"',
  },
  {
    name: 'hosts: :files dns (NSS-4)',
    fixture: { nsswitch: 'hosts: :files dns\n' },
    code: 'nsswitch',
    why: 'names ":files"',
  },
  {
    name: 'hosts :files dns (NSS-4)',
    fixture: { nsswitch: 'hosts :files dns\n' },
    code: 'nsswitch',
    why: 'is not "hosts:"',
  },
  {
    name: 'hosts files dns, with no colon',
    fixture: { nsswitch: 'hosts files dns\n' },
    code: 'nsswitch',
    why: 'is not "hosts:"',
  },
  {
    name: 'a DOS line ending',
    fixture: { nsswitch: 'hosts: files dns\r\n' },
    code: 'nsswitch',
    why: 'names "dns\\r"',
  },
  {
    name: 'a bad action group on another line, at 2.36, where the whole file then fails',
    fixture: { glibc: '2.36', nsswitch: 'passwd: files [NOTFOUND=retrun]\nhosts: files dns\n' },
    code: 'nsswitch',
    why: 'line 1 has an action group',
  },
  {
    name: 'a bad action group on another line, at 2.32, which skips that line alone',
    fixture: { glibc: '2.32', nsswitch: 'passwd: files [NOTFOUND=retrun]\nhosts: files dns\n' },
    code: 'nsswitch',
    why: 'line 1 has an action group',
  },
  {
    name: 'a good action group on another line, after the hosts: line',
    fixture: { nsswitch: 'hosts: files dns\ngroup: files [SUCCESS=merge] systemd\n' },
    code: 'nsswitch',
    why: 'line 2 has an action group',
  },
  {
    name: 'an action group in a comment',
    fixture: { nsswitch: '# [NOTFOUND=return] stops the search\nhosts: files dns\n' },
    code: 'nsswitch',
    why: 'line 1 has an action group',
  },
  {
    name: 'myhostname not installed (NSS-3)',
    fixture: { nsswitch: FMD, missingModules: ['myhostname'] },
    code: 'module',
    why: 'libnss_myhostname.so.2',
  },
  {
    name: 'myhostname after dns, not installed',
    fixture: { nsswitch: FDM, missingModules: ['myhostname'] },
    code: 'module',
    why: 'libnss_myhostname.so.2',
  },
  {
    name: 'whether myhostname loads cannot be told',
    fixture: { nsswitch: FMD, unknownModules: ['myhostname'] },
    code: 'module',
    why: 'is not known (test)',
  },
  {
    name: 'dns not installed at 2.33, where it is a module (T7)',
    fixture: { glibc: '2.33', missingModules: ['dns'] },
    code: 'module',
    why: 'libnss_dns.so.2',
  },
  {
    name: 'files not installed at 2.28',
    fixture: { glibc: '2.28', missingModules: ['files'] },
    code: 'module',
    why: 'libnss_files.so.2',
  },
  // Rule 5.
  { name: 'nscd running', fixture: { nscd: true }, code: 'nscd', why: FILES.nscdSocket },
  // Rule 6, at load.
  {
    name: 'the hosts file unreadable',
    fixture: { unreadable: [FILES.hosts] },
    code: 'unreadable',
    why: `${FILES.hosts} could not be read (unknown)`,
    narrowing: 'unreadable-as-absent',
  },
  {
    name: 'gai.conf unreadable',
    fixture: { unreadable: [FILES.gaiConf] },
    code: 'unreadable',
    why: FILES.gaiConf,
    narrowing: 'unreadable-as-absent',
  },
  // The first rule that fails is the one named.
  {
    name: 'two rules fail: the first is named',
    fixture: {
      resolv: `${SERVER}options no-aaaa\n`,
      nsswitch: 'hosts: files resolve dns\n',
      nscd: true,
    },
    code: 'resolv',
    why: 'no-aaaa',
  },
  {
    name: 'rules 3 and 4 fail: rule 3 is named',
    fixture: { env: { LOCALDOMAIN: 'x' }, nsswitch: 'hosts: sss files dns\n' },
    code: 'env',
    why: 'LOCALDOMAIN',
  },
];

describe('the shapes the check is off for, each naming the first rule that failed', () => {
  it('every narrowing has its rows, and says what glibc does instead', () => {
    for (const [name, what] of Object.entries(NARROWINGS)) {
      assert.ok(
        OFF_ROWS.some((row) => row.narrowing === name),
        `a row the check is off for by ${name}`,
      );
      assert.match(what, /: glibc /u, name);
    }
    assert.equal(
      'narrowing' in readResolvConf(`${SERVER}options no-aaaa\n`, 'probe-1'),
      false,
      'a shape glibc versions read apart is no narrowing',
    );
  });

  for (const row of OFF_ROWS) {
    it(row.name, async () => {
      const policy = await loaded(row.fixture);
      const off = policy.view().off;
      assert.ok(off !== undefined, 'off');
      assert.equal(off.code, row.code, off.why);
      assert.ok(off.why.includes(row.why), `${off.why} names ${row.why}`);
      assert.equal(off.narrowing, row.narrowing, 'the narrowing named, or none');
      assert.equal(policy.describe().check, 'off');
      assert.deepEqual(policy.describe().off, off);
      // Nothing is walked, and nothing is local.
      for (const [name, family] of [
        ['sw1', 0],
        ['printer', 4],
        ['10.1', 4],
        ['probe-1', 0],
      ] as const) {
        assert.equal(verdict(policy.classify(name, family)), `off:${row.code}`, name);
      }
    });
  }
});

/** Shapes near the ones off that the check is on with. */
const ON_ROWS: readonly { readonly name: string; readonly fixture: Fixture }[] = [
  {
    name: 'LD_LIBRARY_PATH empty (elf/dl-load.c _dl_init_paths)',
    fixture: { env: { LD_LIBRARY_PATH: '' } },
  },
  {
    name: 'an environment the resolver does not read',
    fixture: { env: { PATH: '/usr/bin', LANG: 'C' } },
  },
  {
    name: 'a Hosts: line beside the hosts: line (strcmp)',
    fixture: { nsswitch: 'Hosts: mdns4\nhosts: files dns\n' },
  },
  {
    name: 'a hostsx: line beside it',
    fixture: { nsswitch: 'hostsx: files mdns\nhosts: files dns\n' },
  },
  {
    name: 'comments and other databases around it',
    fixture: {
      nsswitch: '# hosts: files mdns4\npasswd: files systemd\nhosts: files dns\ngroup: files # x\n',
    },
  },
  { name: 'blanks and tabs aside', fixture: { nsswitch: '  hosts:\tfiles \t dns  \n' } },
  { name: 'no blank after the colon', fixture: { nsswitch: 'hosts:files dns\n' } },
  { name: 'a NUL on another line', fixture: { nsswitch: 'passwd: files\0x\nhosts: files dns\n' } },
  { name: 'files dns myhostname', fixture: { nsswitch: FDM } },
  { name: 'files myhostname dns', fixture: { nsswitch: FMD } },
  {
    name: 'myhostname not installed, and not on the line',
    fixture: { missingModules: ['myhostname'] },
  },
  {
    name: 'dns not installed at 2.34, where it is libc’s own',
    fixture: { glibc: '2.34', missingModules: ['dns', 'files'] },
  },
  { name: 'every module installed at 2.33', fixture: { glibc: '2.33', nsswitch: FMD } },
  { name: 'the hosts file absent', fixture: { absent: [FILES.hosts] } },
  { name: 'gai.conf absent', fixture: { absent: [FILES.gaiConf] } },
  { name: 'gai.conf with reload yes', fixture: { gai: 'reload yes\n' } },
  { name: 'LD_PRELOAD and LD_AUDIT empty', fixture: { env: { LD_PRELOAD: '', LD_AUDIT: '' } } },
  { name: '/etc/ld.so.preload empty', fixture: { preload: '' } },
  {
    name: 'another database’s line with no action group',
    fixture: { nsswitch: 'sudoers: files sss\npasswd: files systemd\nhosts: files dns\n' },
  },
];

describe('the shapes near those that the check is on with', () => {
  for (const row of ON_ROWS) {
    it(row.name, async () => {
      const policy = await loaded(row.fixture);
      assert.equal(offOf(policy), 'on', policy.view().off?.why);
      assert.equal(verdict(policy.classify('sw1', 0)), 'walk:sw1');
    });
  }

  it('reads the hosts: line with its own reader, and resolv.conf with its own', () => {
    assert.deepEqual(readNsswitch('hosts: files myhostname dns\n'), {
      ok: true,
      value: 'files myhostname dns',
    });
    assert.deepEqual(readNsswitch(null), {
      ok: false,
      why: 'nsswitch.conf is absent: glibc uses its built-in default',
    });
    assert.deepEqual(readResolvConf('options rotate\n', 'probe-1'), {
      ok: false,
      why: 'resolv.conf names no name server: glibc then asks the local host',
      narrowing: 'no-server',
    });
    // An object's own names are no option words.
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(readResolvConf(`${SERVER}options ${word}\n`, 'probe-1').ok, false, word);
    }
  });
});

// --- the classes a name falls in, crossed with the allowed shapes and the families --------------

const LONG = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(50)}`;
const w = (...candidates: string[]): string => `walk:${candidates.join(',')}`;
const all = (v: string): readonly [string, string, string] => [v, v, v];
const NUMERIC = ['local:numeric', 'local:numeric', 'cannotVouch:numeric-family-6'] as const;
const H = 'local:hosts';

/** Each name's class for families 0, 4 and 6 under `CORP`, glibc 2.39 and a hostname `probe-1`. */
const NAMES: readonly (readonly [string, readonly [string, string, string]])[] = [
  ['10.1', NUMERIC],
  ['192.0.2.1', NUMERIC],
  ['0x7f.1', NUMERIC],
  [
    '1.2.3.256',
    [
      w('1.2.3.256', '1.2.3.256.corp.example'),
      'local:numeric',
      w('1.2.3.256', '1.2.3.256.corp.example'),
    ],
  ],
  ['localhost', all(H)],
  ['localhost.localdomain', all('cannotVouch:localhost')],
  ['printer', [H, H, w('printer.corp.example', 'printer')]],
  ['printer-alias', [H, H, w('printer-alias.corp.example', 'printer-alias')]],
  ['v6only', [H, w('v6only.corp.example', 'v6only'), H]],
  // Asked for AF_INET, files reads ::1 as 127.0.0.1 and ::ffff:a.b.c.d as a.b.c.d (LINE_PARSER).
  ['ip6-localhost', all(H)],
  ['ip6-loopback', all(H)],
  ['mapped4', all(H)],
  ['compat6', [H, w('compat6.corp.example', 'compat6'), H]],
  ['both', all(H)],
  ['router', all(w('router.corp.example', 'router'))],
  ['shortbox', all(w('shortbox.corp.example', 'shortbox'))],
  ['oldbox', all(w('oldbox.corp.example', 'oldbox'))],
  ['indented', [H, H, w('indented.corp.example', 'indented')]],
  ['dotted.', [H, H, w('dotted')]],
  ['dotted', all(w('dotted.corp.example', 'dotted'))],
  ['commented', all(w('commented.corp.example', 'commented'))],
  ['probe-1', all(w('probe-1.corp.example', 'probe-1'))],
  ['probe-1.', all(w('probe-1'))],
  ['_gateway', all('cannotVouch:systemd-name')],
  ['_outbound', all('cannotVouch:systemd-name')],
  ['-dash', all('local:refused')],
  ['sw1', all(w('sw1.corp.example', 'sw1'))],
  ['a.b', all(w('a.b', 'a.b.corp.example'))],
  ['a.b.', all(w('a.b'))],
  ['nas.local', all(w('nas.local', 'nas.local.corp.example'))],
  ['host name', all('cannotVouch:not-a-dns-name')],
  ['UPPER', all('cannotVouch:not-a-dns-name')],
  [LONG, all('cannotVouch:candidate')],
];

/** nss-myhostname answers the hostname before DNS only under `files myhostname dns`. */
const MYHOSTNAME_FIRST: Readonly<Record<string, readonly [string, string, string]>> = {
  'probe-1': ['local:myhostname', 'local:myhostname', w('probe-1.corp.example', 'probe-1')],
  'probe-1.': ['local:myhostname', 'local:myhostname', w('probe-1')],
};

/** At 2.28 `dns` asks a name beginning with `-` (no `check_name` before 2.29). */
const BEFORE_CHECK_NAME: Readonly<Record<string, readonly [string, string, string]>> = {
  '-dash': all(w('-dash.corp.example', '-dash')),
};

interface ClassWorld {
  readonly title: string;
  readonly fixture: Fixture;
  readonly overrides?: Readonly<Record<string, readonly [string, string, string]>>;
  /** Exported for S8: the other worlds differ only by a glibc an image already stands for. */
  readonly exported: boolean;
}

const CLASS_WORLDS: readonly ClassWorld[] = [
  { title: 'files dns', fixture: { nsswitch: FD, resolv: CORP }, exported: true },
  { title: 'files dns myhostname', fixture: { nsswitch: FDM, resolv: CORP }, exported: true },
  {
    title: 'files myhostname dns',
    fixture: { nsswitch: FMD, resolv: CORP },
    overrides: MYHOSTNAME_FIRST,
    exported: true,
  },
  {
    title: 'files dns at 2.28',
    fixture: { nsswitch: FD, resolv: CORP, glibc: '2.28' },
    overrides: BEFORE_CHECK_NAME,
    exported: false,
  },
  {
    title: 'files myhostname dns at 2.33',
    fixture: { nsswitch: FMD, resolv: CORP, glibc: '2.33' },
    overrides: MYHOSTNAME_FIRST,
    exported: false,
  },
  {
    title: 'files dns myhostname at 2.42',
    fixture: { nsswitch: FDM, resolv: CORP, glibc: '2.42' },
    exported: false,
  },
];

describe('the classes a name falls in, by hosts: line, glibc and family', () => {
  for (const world of CLASS_WORLDS) {
    for (const [name, base] of NAMES) {
      it(`${world.title}: ${name.length > 40 ? `${name.slice(0, 20)}… (${String(name.length)})` : name}`, async () => {
        const policy = await loaded(world.fixture);
        assert.equal(offOf(policy), 'on');
        const expected = world.overrides?.[name] ?? base;
        for (const [k, family] of FAMILIES.entries()) {
          const c = policy.classify(name, family);
          assert.equal(verdict(c), expected[k], `family ${String(family)}`);
          if (c.kind === 'walk') assert.deepEqual(c.types, TYPES[family]);
        }
      });
    }
  }
});

/** The hostname's rows: nss-myhostname compares it exactly, as `gethostname` gives it. */
const HOSTNAME_ROWS: readonly {
  readonly name: string;
  readonly hostname: string;
  readonly host: string;
  readonly expect: readonly [string, string, string];
}[] = [
  {
    name: 'a mixed-case hostname is not answered for the lower-case name (O-OS-7)',
    hostname: 'Probe-1',
    host: 'probe-1',
    expect: all(w('probe-1')),
  },
  {
    name: 'a dotted hostname, its own domain searched',
    hostname: 'probe-1.lab.example',
    host: 'probe-1.lab.example',
    expect: [
      'local:myhostname',
      'local:myhostname',
      w('probe-1.lab.example', 'probe-1.lab.example.lab.example'),
    ],
  },
  {
    name: 'the short name of a dotted hostname is not it',
    hostname: 'probe-1.lab.example',
    host: 'probe-1',
    expect: all(w('probe-1.lab.example', 'probe-1')),
  },
];

describe('the hostname, under files myhostname dns', () => {
  for (const row of HOSTNAME_ROWS) {
    it(row.name, async () => {
      const policy = await loaded({ nsswitch: FMD, hostname: row.hostname });
      for (const [k, family] of FAMILIES.entries()) {
        assert.equal(
          verdict(policy.classify(row.host, family)),
          row.expect[k],
          `family ${String(family)}`,
        );
      }
    });
  }

  it('reads the hostname at each ask', async () => {
    let now = 'probe-1';
    const policy = await loaded({ nsswitch: FMD, hostname: () => now });
    assert.equal(verdict(policy.classify('probe-1', 4)), 'local:myhostname');
    now = 'probe-2';
    assert.equal(verdict(policy.classify('probe-1', 4)), w('probe-1'));
    assert.equal(verdict(policy.classify('probe-2', 4)), 'local:myhostname');
  });
});

// --- the candidates glibc asks, in order (__res_context_search) ----------------------------------

const CANDIDATE_ROWS: readonly {
  readonly host: string;
  readonly search: readonly string[];
  readonly ndots: number;
  readonly expect: readonly string[];
}[] = [
  { host: 'sw1', search: ['corp'], ndots: 1, expect: ['sw1.corp', 'sw1'] },
  { host: 'a.b', search: ['corp'], ndots: 1, expect: ['a.b', 'a.b.corp'] },
  { host: 'a.b', search: ['corp'], ndots: 2, expect: ['a.b.corp', 'a.b'] },
  { host: 'a.b.', search: ['corp'], ndots: 1, expect: ['a.b'] },
  { host: 'sw1.', search: ['corp'], ndots: 0, expect: ['sw1'] },
  { host: 'sw1', search: ['.'], ndots: 1, expect: ['sw1'] },
  { host: 'sw1', search: ['corp', '.'], ndots: 1, expect: ['sw1.corp', 'sw1'] },
  { host: 'sw1', search: ['.', 'corp'], ndots: 1, expect: ['sw1', 'sw1.corp'] },
  { host: 'a.b', search: ['.'], ndots: 1, expect: ['a.b', 'a.b'] },
  { host: 'sw1', search: [], ndots: 1, expect: ['sw1'] },
  { host: 'sw1', search: ['a', 'b', 'c'], ndots: 0, expect: ['sw1', 'sw1.a', 'sw1.b', 'sw1.c'] },
  { host: 'a.b.c', search: ['corp'], ndots: 15, expect: ['a.b.c.corp', 'a.b.c'] },
  { host: 'a.b.c', search: ['corp'], ndots: 3, expect: ['a.b.c.corp', 'a.b.c'] },
];

describe('the candidates glibc asks, in order (__res_context_search)', () => {
  for (const row of CANDIDATE_ROWS) {
    it(`${row.host} with search ${row.search.join(' ') || '(none)'} and ndots ${String(row.ndots)}`, () => {
      assert.deepEqual(searchCandidates(row.host, row.search, row.ndots), row.expect);
    });
  }

  it('through the policy: the search list and ndots it read', async () => {
    const ndots2 = await loaded({ resolv: `${CORP}options ndots:2\n` });
    assert.equal(verdict(ndots2.classify('a.b', 0)), w('a.b.corp.example', 'a.b'));
    const root = await loaded({ resolv: STUB });
    assert.equal(verdict(root.classify('sw1', 0)), w('sw1'));
    const hostname = await loaded({ hostname: 'probe-1.lab.example' });
    assert.equal(verdict(hostname.classify('sw1', 6)), w('sw1.lab.example', 'sw1'));
  });

  it('the name as it is is asked once unless the root is on the list, and the ndots rule holds', () => {
    const random = seeded(4320);
    const labels = ['a', 'dev-4', 'zone-b', 'x_y', 'test'];
    const domains = ['corp', 'lab.example', '.', 'eng', 'example'];
    const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)] as T;
    for (let run = 0; run < 3_000; run += 1) {
      const count = 1 + Math.floor(random() * 4);
      const bare = Array.from({ length: count }, () => pick(labels)).join('.');
      const trailing = random() < 0.2;
      const host = trailing ? `${bare}.` : bare;
      const search = Array.from({ length: Math.floor(random() * 4) }, () => pick(domains));
      const ndots = Math.floor(random() * 4);
      const asked = searchCandidates(host, search, ndots);
      const dots = count - 1;
      const label = `${host} search=${search.join(',')} ndots=${String(ndots)}`;
      if (trailing) {
        assert.deepEqual(asked, [bare], label);
        continue;
      }
      // Each root entry asks the name again; with none, it is asked once, first or last.
      const roots = search.filter((d) => d === '.').length;
      const asIs = asked.filter((name) => name === bare).length;
      assert.equal(asIs, roots === 0 ? 1 : roots + (dots >= ndots ? 1 : 0), label);
      if (dots >= ndots) assert.equal(asked[0], bare, label);
      else if (search.length > 0 && search[0] !== '.') assert.notEqual(asked[0], bare, label);
      // Every other candidate is the name in a search domain, in the list's order.
      const expected = search.filter((d) => d !== '.').map((d) => `${bare}.${d}`);
      assert.deepEqual(
        asked.filter((name) => name !== bare),
        expected,
        label,
      );
    }
  });
});

// --- what getaddrinfo settles before NSS, and the hosts file -------------------------------------

describe('numeric names and the hosts file', () => {
  it('inet_aton forms of a random address are local for families 0 and 4, and not IP literals', async () => {
    const policy = await loaded();
    const random = seeded(432);
    const write = (n: number): string => {
      const base = Math.floor(random() * 3);
      if (base === 1) return `0${n.toString(8)}`;
      if (base === 2) return `0x${n.toString(16)}`;
      return String(n);
    };
    for (let run = 0; run < 2_000; run += 1) {
      const address = Math.floor(random() * 2 ** 32);
      const shape = 1 + Math.floor(random() * 4);
      const parts =
        shape === 1
          ? [address]
          : shape === 2
            ? [address >>> 24, address & 0xffffff]
            : shape === 3
              ? [address >>> 24, (address >>> 16) & 0xff, address & 0xffff]
              : [address >>> 24, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff];
      const text = parts.map(write).join('.');
      assert.equal(inetAton(text), address, text);
      if (isIP(text) !== 0) {
        // A plain dotted quad: an IP literal the resolver answers before any policy.
        assert.equal(shape, 4, text);
        continue;
      }
      assert.equal(verdict(policy.classify(text, 0)), 'local:numeric', text);
      assert.equal(verdict(policy.classify(text, 4)), 'local:numeric', text);
      assert.equal(verdict(policy.classify(text, 6)), 'cannotVouch:numeric-family-6', text);
    }
  });

  it('inet_aton forms glibc reads', () => {
    const rows: readonly (readonly [string, number])[] = [
      ['127.1', 0x7f000001],
      ['0x7f.1', 0x7f000001],
      ['0177.1', 0x7f000001],
      ['2130706433', 0x7f000001],
      ['017700000001', 0x7f000001],
      ['0x7f000001', 0x7f000001],
      ['10.1.2', 0x0a010002],
      ['0', 0],
      ['00', 0],
      ['0x0', 0],
      ['0xffffffff', 0xffffffff],
      ['1.0xffffff', 0x01ffffff],
      ['1.2.0xffff', 0x0102ffff],
      ['255.255.255.255', 0xffffffff],
    ];
    for (const [text, address] of rows) assert.equal(inetAton(text), address, text);
  });

  it('near-misses glibc refuses are no inet_aton forms: never numeric for family 0 (O-OS-11)', async () => {
    const policy = await loaded();
    const nearMisses = [
      '08.1',
      '09',
      '0x',
      '0x1g',
      '10.1x',
      '1.2.3.256',
      '1.16777216',
      '1.2.65536',
      '4294967296',
      '0x100000000',
      '1.2.3.0x100',
      '10.1.',
      '1.2.3.4.5',
      '1.2.3.4.0',
      '1..2',
      '.1',
      '-1',
      '+1',
      '1.-2',
    ];
    for (const text of nearMisses) {
      assert.equal(inetAton(text), undefined, text);
      assert.notEqual(verdict(policy.classify(text, 0)), 'local:numeric', text);
      // For family 4, digits_dots refuses a name of digits and dots unasked: local.
      const refused = /^[0-9][0-9.]*$/u.test(text) && !text.endsWith('.');
      assert.equal(verdict(policy.classify(text, 4)) === 'local:numeric', refused, text);
    }
  });

  it('a family-4 name of digits and dots that begins with one and ends with none is local', async () => {
    const policy = await loaded();
    const random = seeded(4321);
    for (let run = 0; run < 2_000; run += 1) {
      const length = 1 + Math.floor(random() * 12);
      const text = Array.from({ length }, () =>
        random() < 0.25 ? '.' : String(Math.floor(random() * 10)),
      ).join('');
      const shaped = /^[0-9]/u.test(text) && !text.endsWith('.');
      assert.equal(verdict(policy.classify(text, 4)) === 'local:numeric', shaped, text);
      assert.equal(
        verdict(policy.classify(text, 0)) === 'local:numeric',
        inetAton(text) !== undefined,
        text,
      );
    }
  });

  it('parses addresses as glibc’s inet_pton, not Node’s isIP', () => {
    assert.equal(isIP('fe80::1%eth0'), 6, 'Node takes a zone id');
    assert.equal(inetPton6('fe80::1%eth0'), undefined, 'inet_pton6 does not');
    assert.equal(inetPton4('010.0.0.1'), undefined);
    assert.equal(inetPton4('1.2.3.4.'), undefined);
    assert.equal(inetPton4('1.2.3'), undefined);
    assert.deepEqual([...(inetPton4('192.0.2.1') ?? [])], [192, 0, 2, 1]);
    assert.ok(inetPton6('::ffff:192.0.2.1') !== undefined);
    assert.ok(inetPton6('::') !== undefined);
    for (const bad of [
      ':1',
      '1:',
      '1::2::3',
      '1:2:3:4:5:6:7:8::',
      '12345::',
      '1:2:3:4:5:6:7:8:9',
      'g::1',
      '::1.2.3',
    ]) {
      assert.equal(inetPton6(bad), undefined, bad);
    }
  });

  it('reads the hosts file as glibc’s files module does (files-hosts.c, nss_readline.c)', () => {
    const table = hostsTable(HOSTS);
    const has = (name: string): string => {
      const entry = table.get(name);
      return entry === undefined ? '-' : `${entry.v4 ? '4' : ''}${entry.v6 ? '6' : ''}`;
    };
    assert.equal(has('localhost'), '46');
    assert.equal(has('printer-alias'), '4', 'names in lower case (strcasecmp)');
    assert.equal(has('router'), '-', 'a %scope is no address to inet_pton');
    assert.equal(has('router6'), '6');
    assert.equal(has('ip6-localhost'), '46', '::1 is 127.0.0.1 for AF_INET');
    assert.equal(has('ip6-loopback'), '46');
    assert.equal(has('mapped4'), '46', '::ffff:a.b.c.d is a.b.c.d for AF_INET');
    assert.equal(has('compat6'), '6', 'an IPv4-compatible address is neither');
    for (const address of ['::2', '1::1', '::ff00:c000:201', '::ff:c000:201', '1::ffff:c000:201']) {
      assert.equal(hostsTable(`${address} other\n`).get('other')?.v4, false, `nor is ${address}`);
    }
    assert.equal(hostsTable('::ffff:c000:201 hex\n').get('hex')?.v4, true, 'mapped, in hex');
    assert.equal(has('oldbox'), '-', 'an inet_aton form is no address to inet_pton');
    assert.equal(has('shortbox'), '-');
    assert.equal(has('both'), '46');
    assert.equal(has('a'), '-', 'a # ends the line (F4)');
    assert.equal(has('comment'), '-');
    assert.equal(has('commented'), '-');
    assert.equal(has('indented'), '4', 'leading blanks on an ended line');
    assert.equal(has('dotted.'), '4');
    assert.equal(has('dotted'), '-', 'the trailing dot kept (D17)');
    // A NUL ends a line; an unended indented line is read with its end twice (NSS-2).
    const odd = hostsTable('192.0.2.1 before\0after\n192.0.2.2 next\n  192.0.2.3 printer');
    assert.equal(odd.has('before'), true);
    assert.equal(odd.has('after'), false);
    assert.equal(odd.has('next'), true);
    assert.equal(odd.has('printer'), false);
    assert.equal(hostsTable('192.0.2.3 printer').has('printer'), true, 'unended, not indented');
    assert.equal(hostsTable('  192.0.2.3 printer\n').has('printer'), true, 'indented, ended');
  });
});

// --- rule 6: what moves after load turns the check off until restart -----------------------------

describe('rule 6: what moves after load turns the check off until restart', () => {
  it('a resolv.conf change turns it off, logged once, and putting it back does not turn it on (V3-1)', async () => {
    const { logger, lines } = capture();
    const policy = await loaded({ resolv: CORP }, logger);
    assert.equal(offOf(policy), 'on');
    const change = await policy.looked([reading(FILES.resolvConf, 'nameserver 10.0.0.54\n')]);
    assert.deepEqual(change, { applied: [], moved: [FILES.resolvConf], nscdChanged: false });
    assert.equal(offOf(policy), 'skew');
    assert.ok(
      policy.view().off?.why.includes(`${FILES.resolvConf} changed since ms-probe started`),
    );
    assert.equal(verdict(policy.classify('printer', 4)), 'off:skew', 'nothing local either');
    await policy.looked([reading(FILES.resolvConf, CORP)]);
    assert.equal(offOf(policy), 'skew', 'until restart');
    assert.equal(lines().length, 1, 'warned once');
    assert.equal(policy.describe().check, 'off');
  });

  it('the same contents read again move nothing: contents decide, not identity (RT-1, V3-5)', async () => {
    const policy = await loaded({ resolv: CORP });
    for (let k = 0; k < 3; k += 1) {
      assert.deepEqual(await policy.looked([reading(FILES.resolvConf, CORP)]), {
        applied: [],
        moved: [],
        nscdChanged: false,
      });
    }
    assert.equal(offOf(policy), 'on');
  });

  it('resolv.conf going absent, empty or unreadable is a change (PWH-1), said as what it is now', async () => {
    const was = `contents sha256:${digestOf(CORP).slice(0, 12)}`;
    for (const [text, now] of [
      [null, 'absent'],
      ['', `contents sha256:${digestOf('').slice(0, 12)}`],
      [undefined, 'unreadable (EACCES)'],
    ] as const) {
      const policy = await loaded({ resolv: CORP });
      await policy.looked([reading(FILES.resolvConf, text)]);
      assert.equal(offOf(policy), 'skew', String(text));
      const why = policy.view().off?.why ?? '';
      assert.ok(
        why.includes(`${FILES.resolvConf} changed since ms-probe started, from ${was} to ${now}:`),
        why,
      );
    }
  });

  it('an /etc/ld.so.preload change turns it off, and a helper started now preloads otherwise', async () => {
    const policy = await loaded();
    assert.equal(offOf(policy), 'on');
    assert.equal(policy.skewed(), false);
    await policy.looked([reading(FILES.ldSoPreload, '/usr/lib/libresolv-shim.so\n')]);
    assert.equal(offOf(policy), 'skew');
    assert.equal(policy.skewed(), true, 'ld.so reads it once, as a process starts');
    assert.ok(
      policy
        .view()
        .off?.why.includes(
          `${FILES.ldSoPreload} changed since ms-probe started, from absent to contents`,
        ),
    );
  });

  it('an nsswitch.conf change: at 2.32, read once (V3-3), and at 2.39, read again', async () => {
    for (const [glibc, readOnce] of [
      ['2.32', true],
      ['2.39', false],
    ] as const) {
      const policy = await loaded({ glibc });
      assert.equal(offOf(policy), 'on', glibc);
      await policy.looked([reading(FILES.nsswitchConf, 'hosts: files dns\n# edited\n')]);
      assert.equal(offOf(policy), 'skew', glibc);
      assert.equal(policy.skewed(), readOnce, glibc);
    }
  });

  it('a gai.conf change turns it off, and a helper started now reads otherwise unless reload yes', async () => {
    const plain = await loaded({ gai: '# the default\n' });
    await plain.looked([reading(FILES.gaiConf, 'precedence ::ffff:0:0/96 100\n')]);
    assert.equal(offOf(plain), 'skew');
    assert.equal(plain.skewed(), true);
    await plain.looked([reading(FILES.gaiConf, '# the default\n')]);
    assert.equal(plain.skewed(), false, 'put back as this process read it');
    assert.equal(offOf(plain), 'skew', 'and still off until restart');
    const reloads = await loaded({ gai: 'reload yes\n' });
    await reloads.looked([reading(FILES.gaiConf, 'reload yes\nlabel ::1/128 0\n')]);
    assert.equal(offOf(reloads), 'skew');
    assert.equal(reloads.skewed(), false);
  });

  it('the hostname’s domain moving, with no search line, is a change (PWH-2, T7)', async () => {
    let now = 'probe-1.lab.example';
    const policy = await loaded({ hostname: () => now });
    assert.deepEqual(policy.describe().search, ['lab.example']);
    now = 'probe-2.lab.example';
    await policy.looked([]);
    assert.equal(offOf(policy), 'on', 'the same domain');
    now = 'probe-1.eng.example';
    await policy.looked([]);
    assert.equal(offOf(policy), 'skew');
    assert.ok(policy.view().off?.why.includes('from lab.example to eng.example'));
    now = 'probe-1.lab.example';
    await policy.looked([]);
    assert.equal(offOf(policy), 'skew', 'until restart');
  });

  it('a domain appearing on a hostname that had none is a change too (T7)', async () => {
    let now = 'probe-1';
    const policy = await loaded({ hostname: () => now });
    assert.equal(policy.describe().searchFrom, 'none');
    now = 'probe-1.lab.example';
    await policy.looked([]);
    assert.equal(offOf(policy), 'skew');
  });

  it('with a search line, the hostname’s domain is not searched and may move', async () => {
    let now = 'probe-1.lab.example';
    const policy = await loaded({ resolv: CORP, hostname: () => now });
    now = 'probe-1.eng.example';
    await policy.looked([]);
    assert.equal(offOf(policy), 'on');
  });

  it('a module the hosts: line needs that goes, or comes into doubt, is a change (NSS-3)', async () => {
    const gone = policyFor({ nsswitch: FMD });
    await gone.policy.load();
    assert.equal(verdict(gone.policy.classify('probe-1', 4)), 'local:myhostname');
    gone.modules.missing.add('myhostname');
    await gone.policy.looked([]);
    assert.equal(offOf(gone.policy), 'skew');
    assert.ok(
      gone.policy
        .view()
        .off?.why.includes(
          'libnss_myhostname.so.2 changed since ms-probe started, from installed to absent',
        ),
    );
    gone.modules.missing.delete('myhostname');
    await gone.policy.looked([]);
    // glibc keeps a module it failed to load failed (nss_module_failed).
    assert.equal(offOf(gone.policy), 'skew');
    const doubt = policyFor({ nsswitch: FMD });
    await doubt.policy.load();
    doubt.modules.unknown.add('myhostname');
    await doubt.policy.looked([]);
    assert.equal(offOf(doubt.policy), 'skew');
    const dns = policyFor({ glibc: '2.33' });
    await dns.policy.load();
    dns.modules.missing.add('dns');
    await dns.policy.looked([]);
    assert.equal(offOf(dns.policy), 'skew');
  });

  it('a module the line does not need may come and go', async () => {
    const { policy, modules } = policyFor({ nsswitch: FD });
    await policy.load();
    modules.missing.add('myhostname');
    await policy.looked([]);
    assert.equal(offOf(policy), 'on');
    const built = policyFor({ glibc: '2.34' });
    await built.policy.load();
    assert.deepEqual(built.modules.asked, ['myhostname'], 'files and dns are libc’s own from 2.34');
    const old = policyFor({ glibc: '2.33' });
    await old.policy.load();
    assert.deepEqual(old.modules.asked, ['files', 'dns', 'myhostname']);
  });

  it('the first move is the one named, and the warning is logged once', async () => {
    const { logger, lines } = capture();
    const policy = await loaded({ gai: '' }, logger);
    await policy.looked([
      reading(FILES.gaiConf, 'reload yes\n'),
      reading(FILES.nsswitchConf, 'hosts: files dns myhostname\n'),
    ]);
    assert.ok(policy.view().off?.why.includes(FILES.gaiConf));
    await policy.looked([reading(FILES.resolvConf, 'nameserver 10.0.0.9\n')]);
    assert.ok(policy.view().off?.why.includes(FILES.gaiConf));
    assert.equal(lines().length, 1);
    assert.equal(lines()[0]?.['why'], policy.view().off?.why);
  });

  it('a move after an earlier rule failed leaves that rule named', async () => {
    const { policy, nscd } = policyFor();
    await policy.load();
    nscd.present = true;
    await policy.looked([]);
    assert.equal(offOf(policy), 'nscd');
    await policy.looked([reading(FILES.resolvConf, 'nameserver 10.0.0.9\n')]);
    assert.equal(offOf(policy), 'nscd');
    nscd.present = false;
    await policy.looked([]);
    assert.equal(offOf(policy), 'skew', 'and the move outlasts it');
  });

  it('nscd is looked for at every look, and followed both ways', async () => {
    const { policy, nscd } = policyFor();
    await policy.load();
    nscd.present = true;
    assert.deepEqual(await policy.looked([]), { applied: [], moved: [], nscdChanged: true });
    assert.equal(offOf(policy), 'nscd');
    nscd.present = false;
    assert.equal((await policy.looked([])).nscdChanged, true);
    assert.equal(offOf(policy), 'on');
  });

  it('the hosts file is followed, and the text handed to load is the one used (L-N3)', async () => {
    const { policy } = policyFor({ hosts: '192.0.2.1 from-the-file\n' });
    await policy.load({ hosts: '192.0.2.2 from-the-resolver\n' });
    assert.equal(verdict(policy.classify('from-the-resolver', 4)), 'local:hosts');
    assert.equal(verdict(policy.classify('from-the-file', 4)), w('from-the-file'));
    const change = await policy.looked([reading(FILES.hosts, '192.0.2.3 added\n')]);
    assert.deepEqual(change, { applied: [FILES.hosts], moved: [], nscdChanged: false });
    assert.equal(verdict(policy.classify('added', 4)), 'local:hosts');
    assert.equal(verdict(policy.classify('from-the-resolver', 4)), w('from-the-resolver'));
    assert.equal(offOf(policy), 'on');
  });

  it('a hosts file that becomes unreadable is off while it lasts, and absent is empty (PWH-1)', async () => {
    const policy = await loaded();
    await policy.looked([reading(FILES.hosts, undefined)]);
    assert.equal(offOf(policy), 'unreadable');
    assert.equal(policy.view().off?.narrowing, 'unreadable-as-absent', 'after load, as at it');
    await policy.looked([reading(FILES.hosts, HOSTS)]);
    assert.equal(verdict(policy.classify('printer', 4)), 'local:hosts');
    await policy.looked([reading(FILES.hosts, null)]);
    assert.equal(offOf(policy), 'on');
    assert.equal(verdict(policy.classify('printer', 4)), w('printer'));
  });

  it('builds the hosts table again only when the hosts file changed (PWH-6)', async () => {
    const { policy, nscd } = policyFor();
    await policy.load();
    const table = policy.view().hosts;
    nscd.present = true;
    await policy.looked([reading(FILES.hosts, HOSTS)]);
    assert.equal(offOf(policy), 'nscd');
    assert.equal(policy.view().hosts, table, 'the same table');
    await policy.looked([reading(FILES.hosts, '192.0.2.3 added\n')]);
    assert.notEqual(policy.view().hosts, table);
  });

  it('classes by the new view while the nscd socket is still being looked for (PWH-4)', async () => {
    const gate: { open?: () => void } = {};
    let hold = false;
    const policy = new GlibcNamePolicy({
      logger: silent,
      files: FILES,
      env: {},
      platform: 'linux',
      glibcVersion: () => '2.39',
      hostname: () => 'probe-1',
      readText: (path) =>
        Promise.resolve(
          path === FILES.hosts
            ? '192.0.2.1 gone\n'
            : path === FILES.nsswitchConf
              ? FD
              : path === FILES.resolvConf
                ? SERVER
                : '',
        ),
      socketExists: () =>
        hold
          ? new Promise<boolean>((resolve) => {
              gate.open = () => {
                resolve(false);
              };
            })
          : Promise.resolve(false),
      moduleLook: installed,
    });
    await policy.load();
    assert.equal(verdict(policy.classify('gone', 4)), 'local:hosts');
    hold = true;
    const looking = policy.looked([reading(FILES.hosts, '192.0.2.2 kept\n')]);
    assert.equal(verdict(policy.classify('gone', 4)), w('gone'), 'before the socket is known');
    assert.ok(gate.open !== undefined, 'the socket is being looked for');
    gate.open();
    await looking;
    assert.equal(verdict(policy.classify('kept', 4)), 'local:hosts');
  });

  it('a look before the load changes nothing until the load, which compares it', async () => {
    const { policy } = policyFor();
    assert.deepEqual(await policy.looked([reading(FILES.resolvConf, 'nameserver 10.9.9.9\n')]), {
      applied: [],
      moved: [],
      nscdChanged: false,
    });
    assert.equal(verdict(policy.classify('sw1', 0)), 'off:unloaded');
    await policy.load();
    assert.equal(offOf(policy), 'skew', 'told once, before the load read the file');
  });

  it('a look the watch makes while load reads is compared when load has read (round 3)', async () => {
    const during = async (readings: readonly WatchedReading[]): Promise<GlibcNamePolicy> => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const policy = new GlibcNamePolicy({
        logger: silent,
        files: FILES,
        env: {},
        platform: 'linux',
        glibcVersion: () => '2.39',
        hostname: () => 'probe-1',
        readText: async (path) => {
          if (path === FILES.resolvConf) await held;
          if (path === FILES.ldSoPreload) return null;
          return path === FILES.nsswitchConf ? FD : path === FILES.hosts ? HOSTS : SERVER;
        },
        socketExists: () => Promise.resolve(false),
        moduleLook: installed,
      });
      const loading = policy.load();
      assert.deepEqual(await policy.looked(readings), {
        applied: [],
        moved: [],
        nscdChanged: false,
      });
      release();
      await loading;
      return policy;
    };
    // The resolver tells a reading once: dropped here, it would never come again.
    const moved = await during([reading(FILES.resolvConf, 'nameserver 10.9.9.9\n')]);
    assert.equal(offOf(moved), 'skew', 'resolv.conf moved between the two reads');
    assert.match(moved.view().off?.why ?? '', /from contents sha256:\w+ to contents sha256:/u);
    const hosts = await during([reading(FILES.hosts, `${HOSTS}192.0.2.30 added.test\n`)]);
    assert.equal(offOf(hosts), 'on');
    assert.equal(
      verdict(hosts.classify('added.test', 0)),
      'local:hosts',
      'the hosts reading applied',
    );
    const same = await during([reading(FILES.resolvConf, SERVER), reading(FILES.hosts, HOSTS)]);
    assert.equal(offOf(same), 'on', 'what load read too moves nothing');
  });

  it('a load that fails turns the check off and does not reject', async () => {
    const { logger, lines } = capture('error');
    const policy = new GlibcNamePolicy({
      logger,
      files: FILES,
      env: {},
      platform: 'linux',
      glibcVersion: () => {
        throw new Error('no report');
      },
      hostname: () => 'probe-1',
      readText: () => Promise.resolve(''),
      socketExists: () => Promise.resolve(false),
      moduleLook: installed,
    });
    await policy.load();
    assert.equal(verdict(policy.classify('sw1', 0)), 'off:fault');
    assert.equal(lines().length, 1);
  });

  /**
   * A policy whose looks can be held, through a resolver's watch (re-check of 508f3fcc): while
   * `hold(true)`, a look's nscd look waits until `held` settles it, and the modules look absent,
   * so that a look let go that kept what it found would leave nscd or a move behind.
   */
  function heldLooks(): {
    policy: GlibcNamePolicy;
    look: (what: string) => Promise<boolean>;
    hold: (on: boolean) => void;
    held: { resolve: (present: boolean) => void; reject: (error: Error) => void }[];
    looks: () => number;
    warnings: () => Record<string, unknown>[];
    errors: () => Record<string, unknown>[];
  } {
    const { logger, lines } = capture('warn');
    const held: { resolve: (present: boolean) => void; reject: (error: Error) => void }[] = [];
    let holding = false;
    let looks = 0;
    const policy = new GlibcNamePolicy({
      logger,
      files: FILES,
      env: {},
      platform: 'linux',
      glibcVersion: () => '2.39',
      hostname: () => 'probe-1',
      readText: (path) =>
        Promise.resolve(
          path === FILES.ldSoPreload ? null : path === FILES.nsswitchConf ? FD : SERVER,
        ),
      socketExists: () => {
        looks += 1;
        if (!holding) return Promise.resolve(false);
        return new Promise<boolean>((resolve, reject) => held.push({ resolve, reject }));
      },
      moduleLook: () => Promise.resolve<ModuleLook>({ state: holding ? 'absent' : 'installed' }),
      lookMs: 50,
    });
    const resolver = new NameResolver({
      logger: silent,
      watch: { files: [], everyMs: 60_000, onLook: (readings) => policy.looked(readings) },
    });
    return {
      policy,
      look: (what) => within(2_000, what, resolver.checkFiles()),
      hold: (on) => {
        holding = on;
      },
      held,
      looks: () => looks,
      warnings: () => lines().filter((line) => line['level'] === 40),
      errors: () => lines().filter((line) => line['level'] === 50),
    };
  }

  it('a look past its bound is let go and the check off only until the next look, which drops what it found', async () => {
    const rig = heldLooks();
    await rig.policy.load();
    assert.equal(offOf(rig.policy), 'on');
    assert.equal(await rig.look('a look that ends'), false);
    await sleep(120);
    assert.equal(offOf(rig.policy), 'on', 'a look that ended is not timed out later');
    const snapshot = rig.policy.snapshot();
    rig.hold(true);
    const started = performance.now();
    assert.equal(await rig.look('the watch let go of a slow look'), false);
    assert.ok(performance.now() - started < 1_500, 'at the bound, not when the look ends');
    assert.equal(offOf(rig.policy), 'slow', 'off for now, not until restart');
    assert.equal(Object.keys(snapshot.digests).length, 2, 'gai.conf and ld.so.preload');
    assert.deepEqual(rig.policy.snapshot(), snapshot, 'what load read stands while slow');
    assert.match(rig.policy.view().off?.why ?? '', /a look .* did not end within 50 ms/u);
    assert.equal(rig.warnings().length, 1, 'logged once');
    // It ends late, having found nscd and the modules gone: dropped, or the check would stay off.
    rig.hold(false);
    for (const each of rig.held) each.resolve(true);
    await sleep(10);
    assert.equal(offOf(rig.policy), 'slow', 'what the slow look found is dropped');
    assert.equal(await rig.look('the next look'), false);
    assert.equal(offOf(rig.policy), 'on', 'the next look looks again, and turns the check back on');
    assert.equal(rig.errors().length, 0);
  });

  it('a look the next look finds still not ended is a hang: off until restart, named and logged once', async () => {
    const rig = heldLooks();
    await rig.policy.load();
    rig.hold(true);
    assert.equal(await rig.look('a slow look'), false);
    assert.equal(offOf(rig.policy), 'slow');
    assert.equal(await rig.look('the next look, the slow one not ended'), false);
    assert.equal(offOf(rig.policy), 'fault');
    const why = /a look .* did not end within 50 ms, nor by the next look/u;
    assert.match(rig.policy.view().off?.why ?? '', why);
    assert.equal(rig.errors().length, 1);
    // It ends at last, by failing: the hang stays named, logged once.
    for (const each of rig.held) each.reject(new Error('stat failed late'));
    await sleep(10);
    assert.match(rig.policy.view().off?.why ?? '', why, 'the first reason stands');
    assert.equal(rig.errors().length, 1, 'logged once');
    const before = rig.looks();
    rig.hold(false);
    assert.equal(await rig.look('a look while off'), false);
    assert.equal(
      rig.looks(),
      before,
      'off until restart: no look to pile up behind one that hangs',
    );
    assert.equal(offOf(rig.policy), 'fault');
  });

  it('a look past its bound that ends by failing is dropped like any other end it comes to', async () => {
    const rig = heldLooks();
    await rig.policy.load();
    rig.hold(true);
    assert.equal(await rig.look('a slow look'), false);
    rig.hold(false);
    for (const each of rig.held) each.reject(new Error('stat failed late'));
    await sleep(10);
    assert.equal(offOf(rig.policy), 'slow', 'not a fault: the look it came from was let go');
    assert.equal(rig.errors().length, 0);
    assert.equal(await rig.look('the next look'), false);
    assert.equal(offOf(rig.policy), 'on');
  });

  it('a look past its bound after a move leaves the move named', async () => {
    const rig = heldLooks();
    await rig.policy.load();
    await rig.policy.looked([reading(FILES.resolvConf, 'nameserver 10.9.9.9\n')]);
    assert.equal(offOf(rig.policy), 'skew');
    rig.hold(true);
    assert.equal(await rig.look('a slow look'), false);
    assert.equal(offOf(rig.policy), 'skew', 'off until restart already, and named so');
    assert.equal(rig.warnings().length, 2, 'the move and the slow look, each logged');
  });

  /**
   * A policy whose load waits on resolv.conf until `ends` settles it, bounded at 50 ms, and then
   * reads `resolv` there.
   */
  function heldLoad(resolv = SERVER): {
    policy: GlibcNamePolicy;
    ends: { finish: () => void; fail: (error: Error) => void };
    warnings: () => Record<string, unknown>[];
    errors: () => Record<string, unknown>[];
  } {
    const { logger, lines } = capture('warn');
    const ends: { finish: () => void; fail: (error: Error) => void } = {
      finish: () => undefined,
      fail: () => undefined,
    };
    const held = new Promise<void>((resolve, reject) => {
      ends.finish = resolve;
      ends.fail = reject;
    });
    const policy = new GlibcNamePolicy({
      logger,
      files: FILES,
      env: {},
      platform: 'linux',
      glibcVersion: () => '2.39',
      hostname: () => 'probe-1',
      readText: async (path) => {
        if (path === FILES.resolvConf) {
          await held;
          return resolv;
        }
        return path === FILES.ldSoPreload ? null : path === FILES.nsswitchConf ? FD : SERVER;
      },
      socketExists: () => Promise.resolve(false),
      moduleLook: installed,
      loadMs: 50,
    });
    return {
      policy,
      ends,
      warnings: () => lines().filter((line) => line['level'] === 40),
      errors: () => lines().filter((line) => line['level'] === 50),
    };
  }

  it('a load past its bound is let go, off for now, and builds its view when it ends', async () => {
    const rig = heldLoad();
    const started = performance.now();
    await within(2_000, 'a slow load, let go', rig.policy.load());
    assert.ok(performance.now() - started < 1_500, 'at the bound, not when the load ends');
    assert.equal(offOf(rig.policy), 'slow');
    assert.match(rig.policy.view().off?.why ?? '', /a load .* did not end within 50 ms/u);
    assert.equal(rig.warnings().length, 1, 'logged once');
    rig.ends.finish();
    await sleep(10);
    assert.equal(offOf(rig.policy), 'on', 'slow, not hung: its view is built');
    await rig.policy.looked([]);
    assert.equal(offOf(rig.policy), 'on', 'and the next look looks as ever');
    assert.equal(rig.errors().length, 0);
  });

  it('a load the first look finds still not ended is a hang: off until restart, named and logged once', async () => {
    const failing = heldLoad();
    await within(2_000, 'a slow load, let go', failing.policy.load());
    assert.equal(offOf(failing.policy), 'slow');
    await failing.policy.looked([reading(FILES.hosts, '192.0.2.9 x\n')]);
    assert.equal(offOf(failing.policy), 'fault');
    const why = /a load .* did not end within 50 ms, nor by the next look/u;
    assert.match(failing.policy.view().off?.why ?? '', why);
    assert.equal(failing.errors().length, 1);
    // It ends at last, by failing: the hang stays named, logged once.
    failing.ends.fail(new Error('read failed late'));
    await sleep(10);
    assert.match(failing.policy.view().off?.why ?? '', why, 'the first reason stands');
    assert.equal(failing.errors().length, 1, 'logged once');
    // Or it ends, having read what another rule turns the check off for: the hang stays named.
    const ending = heldLoad(`${SERVER}options inet6\n`);
    await within(2_000, 'a slow load, let go', ending.policy.load());
    await ending.policy.looked([]);
    ending.ends.finish();
    await sleep(10);
    assert.equal(offOf(ending.policy), 'fault', 'a load that ends after its hang is named');
    assert.match(ending.policy.view().off?.why ?? '', why);
  });

  it('bounds a load by POLICY_LOAD_MS and a look by POLICY_LOOK_MS unless a test says', async (t) => {
    assert.equal(POLICY_LOOK_MS, 10_000, 'a hang detector, not a budget');
    assert.equal(POLICY_LOAD_MS, 30_000);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const turn = (): Promise<void> =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });
    let release: () => void = () => undefined;
    const policy = new GlibcNamePolicy({
      logger: silent,
      files: FILES,
      env: {},
      platform: 'linux',
      glibcVersion: () => '2.39',
      hostname: () => 'probe-1',
      readText: (path) =>
        Promise.resolve(
          path === FILES.ldSoPreload ? null : path === FILES.nsswitchConf ? FD : SERVER,
        ),
      socketExists: () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            resolve(false);
          };
        }),
      moduleLook: installed,
    });
    const loading = policy.load();
    await turn();
    t.mock.timers.tick(POLICY_LOAD_MS - 1);
    assert.equal(offOf(policy), 'unloaded', 'a load inside its bound');
    t.mock.timers.tick(1);
    assert.equal(offOf(policy), 'slow', 'a load at its bound');
    release();
    await loading;
    await turn();
    assert.equal(offOf(policy), 'on');
    const looking = policy.looked([]);
    await turn();
    t.mock.timers.tick(POLICY_LOOK_MS - 1);
    assert.equal(offOf(policy), 'on', 'a look inside its bound');
    t.mock.timers.tick(1);
    assert.equal(offOf(policy), 'slow', 'a look at its bound');
    release();
    await looking;
  });

  it('a look that fails keeps the check off until restart', async () => {
    let fail = false;
    const policy = new GlibcNamePolicy({
      logger: silent,
      files: FILES,
      env: {},
      platform: 'linux',
      glibcVersion: () => '2.39',
      hostname: () => 'probe-1',
      readText: (path) =>
        Promise.resolve(
          path === FILES.ldSoPreload ? null : path === FILES.nsswitchConf ? FD : SERVER,
        ),
      socketExists: () =>
        fail ? Promise.reject(new Error('stat failed')) : Promise.resolve(false),
      moduleLook: installed,
    });
    await policy.load();
    assert.equal(offOf(policy), 'on');
    fail = true;
    await policy.looked([]);
    assert.equal(offOf(policy), 'fault');
    fail = false;
    await policy.looked([reading(FILES.hosts, '192.0.2.9 x\n')]);
    assert.equal(offOf(policy), 'fault');
  });

  it('reads glibc’s version from process.report with its network section left out (F6)', async (t) => {
    const reporter = process.report as NodeJS.ProcessReport & {
      excludeNetwork?: boolean | undefined;
    };
    const before = reporter.excludeNetwork;
    const seen: unknown[] = [];
    t.mock.method(reporter, 'getReport', () => {
      seen.push(reporter.excludeNetwork);
      return { header: { glibcVersionRuntime: '2.39' } };
    });
    const policy = new GlibcNamePolicy({
      logger: silent,
      files: FILES,
      env: {},
      platform: 'linux',
      hostname: () => 'probe-1',
      readText: (path) =>
        Promise.resolve(
          path === FILES.ldSoPreload ? null : path === FILES.nsswitchConf ? FD : SERVER,
        ),
      socketExists: () => Promise.resolve(false),
      moduleLook: installed,
    });
    await policy.load();
    assert.deepEqual(seen, [true], 'no reverse lookup of open sockets');
    assert.equal(reporter.excludeNetwork, before, 'put back as it was');
    assert.equal(policy.describe().glibc, '2.39');
    assert.equal(offOf(policy), 'on');
  });
});

describe('the helper’s snapshot of the read-once files (D28)', () => {
  it('carries node, glibc and the load’s digests of gai.conf and, below 2.33, nsswitch.conf', async () => {
    const policy = await loaded({ glibc: '2.32', gai: '# the default\n' });
    assert.deepEqual(policy.snapshot(), {
      node: 'v24.0.0-test',
      glibc: '2.32',
      digests: {
        [FILES.nsswitchConf]: digestOf(FD),
        [FILES.gaiConf]: digestOf('# the default\n'),
        [FILES.ldSoPreload]: 'absent',
      },
    });
    const now = await loaded({ gai: 'reload no\nreload yes\n' });
    assert.deepEqual(
      now.snapshot().digests,
      { [FILES.ldSoPreload]: 'absent' },
      'nothing read once but what ld.so preloads, as the process starts',
    );
    const back = await loaded({ gai: 'reload yes\nreload no\n' });
    assert.deepEqual(
      Object.keys(back.snapshot().digests),
      [FILES.gaiConf, FILES.ldSoPreload],
      'the last reload wins',
    );
    const other = await loaded({ gai: 'reload true\n' });
    assert.deepEqual(
      Object.keys(other.snapshot().digests),
      [FILES.gaiConf, FILES.ldSoPreload],
      'only yes',
    );
    const preload = await loaded({ preload: '' });
    assert.equal(preload.snapshot().digests[FILES.ldSoPreload], digestOf(''), 'empty, not absent');
  });

  it('digests as S2’s readOnceDigest does: bytes, absent, unreadable:<code> (PWH-8)', async () => {
    assert.equal(DIGEST_ABSENT, 'absent');
    const empty = await loaded({ gai: '' });
    assert.deepEqual(empty.snapshot().digests, {
      [FILES.gaiConf]: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      [FILES.ldSoPreload]: 'absent',
    });
    const absent = await loaded({ absent: [FILES.gaiConf] });
    assert.deepEqual(absent.snapshot().digests, {
      [FILES.gaiConf]: 'absent',
      [FILES.ldSoPreload]: 'absent',
    });
    const unreadable = await loaded({ unreadable: [FILES.gaiConf] });
    assert.deepEqual(unreadable.snapshot().digests, {
      [FILES.gaiConf]: 'unreadable:unknown',
      [FILES.ldSoPreload]: 'absent',
    });
    await absent.looked([reading(FILES.gaiConf, '')]);
    assert.equal(absent.skewed(), true, 'empty is not absent');
    await absent.looked([reading(FILES.gaiConf, undefined)]);
    assert.equal(absent.skewed(), true, 'unreadable is not absent');
    await absent.looked([reading(FILES.gaiConf, null)]);
    assert.equal(absent.skewed(), false);
  });

  it('digests a file’s bytes as read, not its text decoded (PWH-8)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-system-names-bytes-'));
    try {
      const files: SystemFiles = {
        hosts: join(dir, 'hosts'),
        resolvConf: join(dir, 'resolv.conf'),
        nsswitchConf: join(dir, 'nsswitch.conf'),
        gaiConf: join(dir, 'gai.conf'),
        ldSoPreload: join(dir, 'ld.so.preload'),
        nscdSocket: join(dir, 'nscd.socket'),
      };
      // A Latin-1 byte, which UTF-8 decoding turns into U+FFFD.
      const gai = Buffer.from([0x23, 0x20, 0xe9, 0x0a]);
      writeFileSync(files.gaiConf, gai);
      writeFileSync(files.nsswitchConf, FD);
      writeFileSync(files.resolvConf, SERVER);
      writeFileSync(files.hosts, HOSTS);
      const again = async (): Promise<GlibcNamePolicy> => {
        const fresh = new GlibcNamePolicy({
          logger: silent,
          files,
          env: {},
          platform: 'linux',
          glibcVersion: () => '2.39',
          hostname: () => 'probe-1',
          socketExists: () => Promise.resolve(false),
          moduleLook: installed,
        });
        await fresh.load();
        return fresh;
      };
      const policy = await again();
      assert.deepEqual(policy.snapshot().digests, {
        [files.gaiConf]: digestOf(gai),
        [files.ldSoPreload]: 'absent',
      });
      assert.notEqual(digestOf(gai), digestOf(gai.toString('utf8')));
      assert.equal(offOf(policy), 'on');
      rmSync(files.gaiConf);
      assert.deepEqual((await again()).snapshot().digests, {
        [files.gaiConf]: 'absent',
        [files.ldSoPreload]: 'absent',
      });
      mkdirSync(files.gaiConf);
      const unreadable = await again();
      assert.deepEqual(unreadable.snapshot().digests, {
        [files.gaiConf]: 'unreadable:EISDIR',
        [files.ldSoPreload]: 'absent',
      });
      assert.equal(offOf(unreadable), 'unreadable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('whether glibc would load an NSS module (NSS-3)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ms-system-names-modules-'));
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  let made = 0;

  /** An ELF header: class (1 32-bit, 2 64-bit), little-endian, and `e_machine`. */
  function elf(elfClass: number, machine: number): Buffer {
    const head = Buffer.alloc(64);
    head.writeUInt32BE(0x7f454c46, 0);
    head[4] = elfClass;
    head[5] = 1;
    head.writeUInt16LE(machine, 18);
    return head;
  }

  function tree(entries: Readonly<Record<string, Buffer | 'dir'>>): string {
    made += 1;
    const at = join(root, String(made));
    for (const [path, content] of Object.entries(entries)) {
      const full = join(at, path);
      if (content === 'dir') {
        mkdirSync(full, { recursive: true });
      } else {
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content);
      }
    }
    mkdirSync(at, { recursive: true });
    return at;
  }

  async function stateOf(name: string, at: string, arch = 'x64'): Promise<string> {
    return (await nssModuleLook(name, { arch, root: at })).state;
  }

  it('Debian’s multiarch directories, for this machine', async () => {
    const at = tree({
      'usr/lib/x86_64-linux-gnu': 'dir',
      'lib/x86_64-linux-gnu/libnss_myhostname.so.2': elf(2, 62),
      'usr/lib/x86_64-linux-gnu/libnss_resolve.so.2': elf(2, 62),
      'lib/libnss_wins.so.2': elf(2, 62),
      'usr/lib/libnss_nis.so.2': elf(2, 62),
      'usr/lib64/libnss_mdns.so.2': elf(2, 62),
    });
    assert.equal(await stateOf('myhostname', at), 'installed');
    assert.equal(await stateOf('resolve', at), 'installed');
    assert.equal(await stateOf('wins', at), 'installed', '/lib is searched too');
    assert.equal(await stateOf('nis', at), 'installed', '/usr/lib is searched too');
    assert.equal(await stateOf('mdns', at), 'absent', 'lib64 is not where Debian’s loader looks');
    assert.equal(await stateOf('sss', at), 'absent');
  });

  it('RHEL’s lib64 directories, and an object for another machine or class is none', async () => {
    const bigEndian = elf(2, 62);
    bigEndian[5] = 2;
    const script = elf(2, 62);
    script.write('#!/b', 0, 'latin1');
    const at = tree({
      'usr/lib64/libnss_myhostname.so.2': elf(2, 62),
      'lib64/libnss_resolve.so.2': elf(2, 62),
      'usr/lib64/libnss_files.so.2': elf(1, 62),
      'usr/lib64/libnss_nis.so.2': bigEndian,
      'usr/lib64/libnss_mdns4_minimal.so.2': elf(2, 183),
      'usr/lib64/libnss_wins.so.2': script,
      'usr/lib64/libnss_ldap.so.2': Buffer.from('\x7fELF\x02\x01'),
      'lib/x86_64-linux-gnu/libnss_sss.so.2': elf(2, 62),
      'usr/lib/libnss_dns.so.2': elf(2, 62),
    });
    assert.equal(await stateOf('myhostname', at), 'installed');
    assert.equal(await stateOf('resolve', at), 'installed');
    assert.equal(await stateOf('files', at), 'absent', '32-bit');
    assert.equal(await stateOf('nis', at), 'absent', 'big-endian');
    assert.equal(await stateOf('mdns4_minimal', at), 'absent', 'another machine');
    assert.equal(await stateOf('mdns4_minimal', at, 'arm64'), 'installed');
    assert.equal(await stateOf('wins', at), 'absent', 'no ELF magic');
    assert.equal(await stateOf('ldap', at), 'absent', 'too short');
    assert.equal(await stateOf('sss', at), 'absent', 'no multiarch tree here');
    assert.equal(await stateOf('dns', at), 'absent', 'nor /usr/lib');
  });

  it('cannot tell where ld.so.cache names the file, or cannot be read', async () => {
    const at = tree({
      'usr/lib64/libnss_myhostname.so.2': elf(2, 62),
      'etc/ld.so.cache': Buffer.from(
        'glibc-ld.so.cache1.1\0libnss_sss.so.2\0/opt/sssd/lib/libnss_sss.so.2\0',
        'latin1',
      ),
    });
    assert.equal(await stateOf('myhostname', at), 'installed');
    assert.equal(await stateOf('resolve', at), 'absent', 'the cache does not name it');
    assert.deepEqual(await nssModuleLook('sss', { arch: 'x64', root: at }), {
      state: 'unknown',
      why: 'libnss_sss.so.2 is in none of /lib64, /usr/lib64, and /etc/ld.so.cache names it',
    });
    const unreadable = tree({ 'etc/ld.so.cache/x': Buffer.from('') });
    assert.equal(await stateOf('resolve', unreadable), 'unknown');
  });

  it('another architecture’s directories are not known: cannot tell', async () => {
    const at = tree({ 'usr/lib64/libnss_myhostname.so.2': elf(2, 62) });
    assert.deepEqual(await nssModuleLook('myhostname', { arch: 'ia32', root: at }), {
      state: 'unknown',
      why: 'where the loader looks for libnss_myhostname.so.2 on ia32 is not known',
    });
  });
});

describe('rule 6 through the resolver’s watch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-system-names-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  let made = 0;

  function world(glibc: string): {
    files: SystemFiles;
    policy: GlibcNamePolicy;
    resolver: NameResolver;
    nscdLooks: () => number;
  } {
    made += 1;
    const root = join(dir, String(made));
    mkdirSync(root, { recursive: true });
    const files: SystemFiles = {
      hosts: join(root, 'hosts'),
      resolvConf: join(root, 'resolv.conf'),
      nsswitchConf: join(root, 'nsswitch.conf'),
      gaiConf: join(root, 'gai.conf'),
      ldSoPreload: join(root, 'ld.so.preload'),
      nscdSocket: join(root, 'nscd.socket'),
    };
    writeFileSync(files.hosts, '127.0.0.1 localhost\n192.0.2.9 printer\n');
    writeFileSync(files.resolvConf, SERVER);
    writeFileSync(files.nsswitchConf, FD);
    writeFileSync(files.gaiConf, '');
    let looks = 0;
    const policy = new GlibcNamePolicy({
      logger: silent,
      files,
      env: {},
      platform: 'linux',
      glibcVersion: () => glibc,
      hostname: () => 'probe-1',
      socketExists: () => {
        looks += 1;
        return Promise.resolve(false);
      },
      moduleLook: installed,
    });
    const resolver = new NameResolver({
      logger: silent,
      watch: {
        files: [files.hosts, files.resolvConf, files.nsswitchConf, ...policy.watchedFiles()],
        everyMs: 60_000,
        onLook: (readings) => policy.looked(readings),
      },
    });
    return { files, policy, resolver, nscdLooks: () => looks };
  }

  it('adds gai.conf and /etc/ld.so.preload to the resolver’s watch in gate mode, which has the rest (§1.12)', () => {
    const { files, policy } = world('2.39');
    assert.deepEqual(policy.watchedFiles(), [files.gaiConf, files.ldSoPreload]);
    assert.deepEqual(new GlibcNamePolicy({ logger: silent }).watchedFiles(), [
      SYSTEM_FILES.gaiConf,
      SYSTEM_FILES.ldSoPreload,
    ]);
    if (process.platform !== 'win32') {
      assert.deepEqual(systemResolverFiles(), [
        SYSTEM_FILES.hosts,
        SYSTEM_FILES.resolvConf,
        SYSTEM_FILES.nsswitchConf,
      ]);
    }
  });

  it('a gai.conf change seen by the watch turns the check off and skews the helper', async () => {
    const { files, policy, resolver, nscdLooks } = world('2.39');
    await policy.load();
    assert.equal(await resolver.checkFiles(), false, 'the baseline');
    assert.equal(offOf(policy), 'on', 'the first look tells what load read');
    assert.equal(nscdLooks(), 2, 'the load, and the look');
    writeFileSync(files.gaiConf, 'precedence ::ffff:0:0/96 100\n');
    assert.equal(await resolver.checkFiles(), true);
    assert.equal(offOf(policy), 'skew');
    assert.equal(policy.skewed(), true);
    assert.equal(await resolver.checkFiles(), false, 'nothing new');
    assert.equal(nscdLooks(), 4, 'the socket is looked for at every look');
  });

  it('an nsswitch.conf change seen by the watch turns it off at 2.33 too', async () => {
    const { files, policy, resolver } = world('2.33');
    await policy.load();
    await resolver.checkFiles();
    writeFileSync(files.nsswitchConf, 'hosts: files sss dns\n');
    await resolver.checkFiles();
    assert.equal(offOf(policy), 'skew');
    assert.equal(policy.skewed(), false, 'glibc 2.33 reads it again: a new helper does not differ');
  });

  it('resolv.conf renamed into place with the same contents moves nothing (RT-1)', async () => {
    const { files, policy, resolver } = world('2.39');
    await policy.load();
    await resolver.checkFiles();
    writeFileSync(`${files.resolvConf}.new`, SERVER);
    renameSync(`${files.resolvConf}.new`, files.resolvConf);
    await resolver.checkFiles();
    assert.equal(offOf(policy), 'on');
    writeFileSync(files.resolvConf, 'nameserver 10.0.0.54\n');
    await resolver.checkFiles();
    assert.equal(offOf(policy), 'skew');
  });

  it('a hosts edit reaches the policy from the resolver’s own reading', async () => {
    const { files, policy, resolver } = world('2.39');
    await policy.load();
    await resolver.checkFiles();
    writeFileSync(files.hosts, '127.0.0.1 localhost\n192.0.2.9 added.test\n');
    await resolver.checkFiles();
    assert.equal(verdict(policy.classify('added.test', 0)), 'local:hosts');
  });

  it('a hosts file that becomes unreadable reaches the policy, and so does its return (PWH-1)', async () => {
    const { files, policy, resolver } = world('2.39');
    await policy.load();
    await resolver.checkFiles();
    assert.equal(verdict(policy.classify('printer', 4)), 'local:hosts');
    // A directory where the file was: unreadable (EISDIR), as root too.
    const text = readFileSync(files.hosts, 'utf8');
    rmSync(files.hosts);
    mkdirSync(files.hosts);
    await resolver.checkFiles();
    assert.equal(verdict(policy.classify('printer', 4)), 'off:unreadable');
    assert.ok(policy.view().off?.why.includes(`${files.hosts} could not be read (EISDIR)`));
    rmSync(files.hosts, { recursive: true });
    writeFileSync(files.hosts, text);
    await resolver.checkFiles();
    assert.equal(
      verdict(policy.classify('printer', 4)),
      'local:hosts',
      'the same text, told again',
    );
  });

  it('tells onLook what is new, by digest; a failing onLook fails nothing', async () => {
    const dirOf = join(dir, 'tell');
    mkdirSync(dirOf, { recursive: true });
    const a = join(dirOf, 'hosts');
    const b = join(dirOf, 'resolv.conf');
    writeFileSync(a, '127.0.0.1 localhost\n');
    writeFileSync(b, SERVER);
    const told: string[][] = [];
    const { logger, lines } = capture('error');
    const resolver = new NameResolver({
      logger,
      watch: {
        files: [a, b],
        everyMs: 60_000,
        onLook: (readings) => {
          told.push(
            readings.map((r) => {
              const name = r.file === a ? 'a' : 'b';
              if (r.text === undefined || r.digest === DIGEST_ABSENT) return `${name}:${r.digest}`;
              assert.equal(r.digest, digestOf(r.text), 'the digest of the bytes read');
              return `${name}=${r.text.trim()}`;
            }),
          );
          return told.length === 3
            ? Promise.reject(new Error('the policy fell over'))
            : Promise.resolve();
        },
      },
    });
    await resolver.checkFiles();
    writeFileSync(b, 'nameserver 10.9.9.9\n');
    await resolver.checkFiles();
    assert.equal(await resolver.checkFiles(), false);
    // The same contents renamed into place: a new inode, and nothing to tell.
    writeFileSync(`${b}.new`, 'nameserver 10.9.9.9\n');
    renameSync(`${b}.new`, b);
    assert.equal(await resolver.checkFiles(), false, 'nothing changed for the resolver');
    rmSync(a);
    mkdirSync(a);
    await resolver.checkFiles();
    rmSync(b);
    assert.equal(await resolver.checkFiles(), true, 'gone, for the resolver too');
    writeFileSync(b, '');
    assert.equal(await resolver.checkFiles(), false, 'an empty file says what an absent one did');
    assert.deepEqual(told, [
      ['a=127.0.0.1 localhost', `b=${SERVER.trim()}`],
      ['b=nameserver 10.9.9.9'],
      [],
      [],
      ['a:unreadable:EISDIR'],
      ['b:absent'],
      ['b='],
    ]);
    assert.equal(lines().length, 1, 'logged');
  });
});

describe('the description logged at start', () => {
  it('names the servers, search, options, the hosts: line, the modules and why the check is off', async () => {
    const policy = await loaded({
      resolv: 'nameserver 10.0.0.53\nsearch corp.example\noptions rotate trust-ad ndots:2\n',
      nsswitch: FMD,
      glibc: '2.30',
      nscd: true,
    });
    assert.deepEqual(policy.describe(), {
      check: 'off',
      off: { code: 'nscd', why: `nscd is running (${FILES.nscdSocket})` },
      platform: 'linux',
      glibc: '2.30',
      servers: ['10.0.0.53'],
      search: ['corp.example'],
      searchFrom: 'search',
      options: { ...DEFAULT_OPTIONS, ndots: 2, rotate: true, trustAd: true },
      hostsLine: 'files myhostname dns',
      nscd: true,
      modules: ['dns', 'files', 'myhostname'],
      readOnce: [FILES.nsswitchConf, FILES.gaiConf, FILES.ldSoPreload],
      skewed: false,
    });
    const bad = await loaded({ resolv: 'options bogus\n' });
    assert.deepEqual(
      { ...bad.describe(), off: undefined },
      {
        check: 'off',
        off: undefined,
        platform: 'linux',
        glibc: '2.39',
        servers: [],
        search: [],
        searchFrom: undefined,
        options: undefined,
        hostsLine: 'files dns',
        nscd: false,
        modules: ['myhostname'],
        readOnce: [FILES.gaiConf, FILES.ldSoPreload],
        skewed: false,
      },
    );
  });
});

// --- S8: the rows the check is on for, exported for the differential ----------------------------

const IMAGES: Readonly<Record<string, string>> = {
  rocky8: '2.28',
  rocky9: '2.34',
  ubuntu2204: '2.35',
  debian12: '2.36',
  ubuntu2404: '2.39',
  debian13: '2.41',
};

type Reply = 'nxdomain' | 'servfail' | 'refused' | 'silent' | 'address';
type Wire = readonly [string, string, QType, number];

interface S8Plan {
  readonly plan: string;
  readonly answers: Readonly<Record<string, Readonly<Partial<Record<QType, Reply>>>>>;
  readonly wire?: readonly Wire[];
  readonly wireByOffset?: readonly (readonly Wire[])[];
}

interface S8Expect {
  readonly class: NameClass['kind'];
  readonly via?: string;
  readonly reason?: string;
  readonly candidates?: readonly string[];
  readonly types?: readonly QType[];
  readonly servers: readonly string[];
  readonly rotate: boolean;
  readonly plans: readonly S8Plan[];
}

interface S8Row {
  readonly id: string;
  readonly title: string;
  readonly world: Readonly<Record<string, unknown>>;
  readonly question: { readonly name: string; readonly family: Family };
  readonly expect: S8Expect;
  readonly byImage: Readonly<Record<string, S8Expect | null>>;
}

interface Recording {
  readonly id: string;
  readonly image: string;
  readonly plan: string;
  readonly offset?: number;
  readonly wire: readonly Wire[];
}

/** One row as the differential replays it: a world, and one name asked of it. */
interface S8Source {
  readonly title: string;
  readonly fixture: Fixture;
  readonly name: string;
  readonly family: Family;
}

const S8_SOURCES: readonly S8Source[] = [
  ...CLASS_WORLDS.filter((world) => world.exported).flatMap((world) =>
    NAMES.flatMap(([name]) =>
      FAMILIES.map((family) => ({
        title: `${world.title}: ${name}, family ${String(family)}`,
        fixture: world.fixture,
        name,
        family,
      })),
    ),
  ),
  ...HOSTNAME_ROWS.flatMap((row) =>
    FAMILIES.map((family) => ({
      title: `${row.name}, family ${String(family)}`,
      fixture: { nsswitch: FMD, hostname: row.hostname },
      name: row.host,
      family,
    })),
  ),
  ...RESOLV_ROWS.map((row): S8Source => ({
    title: row.name,
    fixture: resolvFixture(row),
    name: 'sw1',
    family: 0,
  })),
];

/** JSON with every object's keys in order: what a row's id is the digest of. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, each]) => [key, sorted(each)]),
  );
}

function answersOf(
  servers: readonly string[],
  types: readonly QType[],
  reply: (index: number) => Reply,
): Record<string, Partial<Record<QType, Reply>>> {
  return Object.fromEntries(
    servers.map((server, k) => [server, Object.fromEntries(types.map((type) => [type, reply(k)]))]),
  );
}

/** The plans for an expectation, each with the wire glibc should send (see the header). */
function plansOf(e: Omit<S8Expect, 'plans'>): S8Plan[] {
  const servers = e.servers;
  const n = servers.length;
  const types: readonly QType[] = e.types ?? ['A', 'AAAA'];
  const candidates = e.candidates;
  if (e.class !== 'walk' || candidates === undefined) {
    return [{ plan: 'nxdomain', answers: answersOf(servers, types, () => 'nxdomain'), wire: [] }];
  }
  const rotating = e.rotate && n > 1;
  const at = (offset: number, k: number): string => servers[(offset + k) % n] ?? '';
  const wires = (wireAt: (offset: number) => Wire[]): Pick<S8Plan, 'wire' | 'wireByOffset'> =>
    rotating ? { wireByOffset: servers.map((_, k) => wireAt(k)) } : { wire: wireAt(0) };
  const nxdomain = (offset: number): Wire[] =>
    candidates.flatMap((name, j) =>
      types.map((type): Wire => [at(offset, rotating ? j : 0), name, type, 1]),
    );
  const lastAnswers = (offset: number): Wire[] => {
    const order = servers.map((_, k) => at(offset, k));
    const asked = order.slice(0, order.indexOf(servers[n - 1] ?? '') + 1);
    return asked.flatMap((server) =>
      types.map((type): Wire => [server, candidates[0] ?? '', type, 1]),
    );
  };
  const plans: S8Plan[] = [
    { plan: 'nxdomain', answers: answersOf(servers, types, () => 'nxdomain'), ...wires(nxdomain) },
  ];
  if (n === 1) {
    plans.push({
      plan: 'answer',
      answers: answersOf(servers, types, () => 'address'),
      ...wires(lastAnswers),
    });
  }
  for (const failure of n > 1 ? (['servfail', 'refused', 'silent'] as const) : []) {
    plans.push({
      plan: `last-answers-after-${failure}`,
      answers: answersOf(servers, types, (k) => (k === n - 1 ? 'address' : failure)),
      ...wires(lastAnswers),
    });
  }
  return plans;
}

/** What the policy expects of a row at a glibc: null while the check is off. */
async function expectationOf(
  fixture: Fixture,
  name: string,
  family: Family,
): Promise<S8Expect | null> {
  const policy = await loaded(fixture);
  const c = policy.classify(name, family);
  const conf = policy.view().conf;
  if (c.kind === 'off' || conf === undefined) return null;
  const e = {
    class: c.kind,
    ...(c.kind === 'local' ? { via: c.via } : {}),
    ...(c.kind === 'cannotVouch' ? { reason: c.reason } : {}),
    ...(c.kind === 'walk' ? { candidates: c.candidates, types: c.types } : {}),
    servers: conf.servers,
    rotate: conf.options.rotate,
  };
  return { ...e, plans: plansOf(e) };
}

const SYSTEM_PATH: Readonly<Record<'hosts' | 'resolv' | 'nsswitch' | 'gai', string>> = {
  hosts: SYSTEM_FILES.hosts,
  resolv: SYSTEM_FILES.resolvConf,
  nsswitch: SYSTEM_FILES.nsswitchConf,
  gai: SYSTEM_FILES.gaiConf,
};

interface S8Export {
  readonly schema: number;
  readonly images: Readonly<Record<string, string>>;
  readonly texts: Readonly<Record<string, string>>;
  readonly rows: readonly S8Row[];
}

let exporting: Promise<S8Export> | undefined;

/** The rows as the policy reads them now, built once for the tests below. */
function exportRows(): Promise<S8Export> {
  exporting ??= buildRows();
  return exporting;
}

async function buildRows(): Promise<S8Export> {
  const texts = new Map<string, string>();
  const rows: S8Row[] = [];
  for (const source of S8_SOURCES) {
    const f = source.fixture;
    const expect = await expectationOf(f, source.name, source.family);
    if (expect === null || (expect.class !== 'local' && expect.class !== 'walk')) continue;
    const files: Record<string, string> = {};
    const given = {
      hosts: f.hosts ?? HOSTS,
      resolv: f.resolv ?? SERVER,
      nsswitch: f.nsswitch ?? FD,
      gai: f.gai ?? '',
    };
    for (const key of ['hosts', 'resolv', 'nsswitch', 'gai'] as const) {
      const at = {
        hosts: FILES.hosts,
        resolv: FILES.resolvConf,
        nsswitch: FILES.nsswitchConf,
        gai: FILES.gaiConf,
      }[key];
      if (f.absent?.includes(at) === true) continue;
      const id = `t${digestOf(given[key]).slice(0, 12)}`;
      texts.set(id, given[key]);
      files[SYSTEM_PATH[key]] = id;
    }
    const world = {
      glibc: f.glibc ?? '2.39',
      hostname: typeof f.hostname === 'string' ? f.hostname : 'probe-1',
      env: f.env ?? {},
      files,
      missingModules: [...(f.missingModules ?? [])],
      addresses: expect.servers,
      ipv6: expect.servers.some((server) => isIP(server) === 6),
    };
    const question = { name: source.name, family: source.family };
    const byImage: Record<string, S8Expect | null> = {};
    for (const [image, glibc] of Object.entries(IMAGES)) {
      const there = await expectationOf({ ...f, glibc }, source.name, source.family);
      if (!isDeepStrictEqual(there, expect)) byImage[image] = there;
    }
    rows.push({
      id: digestOf(JSON.stringify(sorted({ world, question }))).slice(0, 16),
      title: source.title,
      world,
      question,
      expect,
      byImage,
    });
  }
  return {
    schema: 2,
    images: IMAGES,
    texts: Object.fromEntries([...texts].sort(([a], [b]) => (a < b ? -1 : 1))),
    rows,
  };
}

/** Why a recording no longer holds for the rows exported now, or undefined when it does. */
function recordingProblem(rows: readonly S8Row[], recording: Recording): string | undefined {
  const row = rows.find((each) => each.id === recording.id);
  if (row === undefined) return `row ${recording.id} is no longer exported`;
  if (!Object.hasOwn(IMAGES, recording.image))
    return `${recording.image} is no image S8 replays in`;
  const e = Object.hasOwn(row.byImage, recording.image) ? row.byImage[recording.image] : row.expect;
  if (e === null || e === undefined)
    return `row ${recording.id} is not replayed in ${recording.image}`;
  const plan = e.plans.find((each) => each.plan === recording.plan);
  if (plan === undefined) return `row ${recording.id} has no plan ${recording.plan}`;
  const wire = plan.wire ?? plan.wireByOffset?.[recording.offset ?? 0];
  return isDeepStrictEqual(wire, recording.wire)
    ? undefined
    : `row ${recording.id} in ${recording.image}, ${recording.plan}: the policy expects ${JSON.stringify(wire)}, glibc sent ${JSON.stringify(recording.wire)}`;
}

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));

describe('S8: the rows the check is on for, exported for the differential', () => {
  it('the committed rows are the tables’ rows, as the policy reads them now', async () => {
    const exported = await exportRows();
    const path = fixturePath('system-names-rows.json');
    if (process.env['MS_WRITE_S8_ROWS'] === '1') {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `${JSON.stringify(exported, null, 2)}\n`);
    }
    const committed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(exported)));
  });

  it('exports only rows the check is on for and that it walks or calls local, each id once', async () => {
    const { rows } = await exportRows();
    assert.ok(rows.length > 150, String(rows.length));
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'ids are unique');
    assert.ok(rows.every((row) => row.expect.class === 'walk' || row.expect.class === 'local'));
    const walks = rows.filter((row) => row.expect.class === 'walk');
    for (const row of walks) {
      const names = row.expect.plans.map((plan) => plan.plan);
      assert.equal(names[0], 'nxdomain', row.title);
      assert.ok(names.length >= 2, row.title);
    }
    assert.ok(walks.some((row) => row.expect.servers.length === 3 && row.expect.rotate));
    assert.ok(
      rows.every((row) => Object.values(row.byImage).every((e) => e !== null)),
      'no exported row is off in an image',
    );
    // The 2.28 image walks a name beginning with -, which later ones refuse unasked.
    const dash = rows.find((row) => row.question.name === '-dash' && row.question.family === 4);
    assert.ok(dash !== undefined);
    assert.equal(dash.expect.class, 'local');
    assert.equal(dash.byImage['rocky8']?.class, 'walk');
    assert.deepEqual(Object.keys(dash.byImage), ['rocky8']);
  });

  it('a plan’s wire: NXDOMAIN walks the candidates at one server, failures walk the servers', () => {
    const plans = plansOf({
      class: 'walk',
      candidates: ['sw1.corp', 'sw1'],
      types: ['A', 'AAAA'],
      servers: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
      rotate: false,
    });
    assert.deepEqual(
      plans.map((plan) => plan.plan),
      [
        'nxdomain',
        'last-answers-after-servfail',
        'last-answers-after-refused',
        'last-answers-after-silent',
      ],
    );
    assert.deepEqual(plans[0]?.wire, [
      ['10.0.0.1', 'sw1.corp', 'A', 1],
      ['10.0.0.1', 'sw1.corp', 'AAAA', 1],
      ['10.0.0.1', 'sw1', 'A', 1],
      ['10.0.0.1', 'sw1', 'AAAA', 1],
    ]);
    assert.deepEqual(plans[2]?.answers, {
      '10.0.0.1': { A: 'refused', AAAA: 'refused' },
      '10.0.0.2': { A: 'refused', AAAA: 'refused' },
      '10.0.0.3': { A: 'address', AAAA: 'address' },
    });
    assert.deepEqual(plans[2].wire, [
      ['10.0.0.1', 'sw1.corp', 'A', 1],
      ['10.0.0.1', 'sw1.corp', 'AAAA', 1],
      ['10.0.0.2', 'sw1.corp', 'A', 1],
      ['10.0.0.2', 'sw1.corp', 'AAAA', 1],
      ['10.0.0.3', 'sw1.corp', 'A', 1],
      ['10.0.0.3', 'sw1.corp', 'AAAA', 1],
    ]);
    const rotated = plansOf({
      class: 'walk',
      candidates: ['sw1.corp', 'sw1'],
      types: ['A'],
      servers: ['10.0.0.1', '10.0.0.2'],
      rotate: true,
    });
    assert.deepEqual(rotated[0]?.wireByOffset, [
      [
        ['10.0.0.1', 'sw1.corp', 'A', 1],
        ['10.0.0.2', 'sw1', 'A', 1],
      ],
      [
        ['10.0.0.2', 'sw1.corp', 'A', 1],
        ['10.0.0.1', 'sw1', 'A', 1],
      ],
    ]);
    assert.deepEqual(rotated[1]?.wireByOffset, [
      [
        ['10.0.0.1', 'sw1.corp', 'A', 1],
        ['10.0.0.2', 'sw1.corp', 'A', 1],
      ],
      [['10.0.0.2', 'sw1.corp', 'A', 1]],
    ]);
    const local = plansOf({ class: 'local', via: 'hosts', servers: ['10.0.0.1'], rotate: false });
    assert.deepEqual(local, [
      { plan: 'nxdomain', answers: { '10.0.0.1': { A: 'nxdomain', AAAA: 'nxdomain' } }, wire: [] },
    ]);
  });

  it('every recording S8 has made still holds', async () => {
    const parsed = JSON.parse(
      readFileSync(fixturePath('system-names-recordings.json'), 'utf8'),
    ) as {
      readonly schema?: unknown;
      readonly recordings?: unknown;
    };
    assert.equal(parsed.schema, 1);
    assert.ok(Array.isArray(parsed.recordings));
    const { rows } = await exportRows();
    for (const recording of parsed.recordings as Recording[]) {
      assert.equal(recordingProblem(rows, recording), undefined);
    }
  });

  it('a recording that no longer holds is caught: a moved wire, a lost row, an image now off', async () => {
    const { rows } = await exportRows();
    const row = rows.find(
      (each) => each.expect.class === 'walk' && each.expect.servers.length === 1,
    );
    assert.ok(row !== undefined);
    const wire = row.expect.plans[0]?.wire ?? [];
    const good: Recording = { id: row.id, image: 'debian12', plan: 'nxdomain', wire };
    assert.equal(recordingProblem(rows, good), undefined);
    assert.match(recordingProblem(rows, { ...good, wire: wire.slice(1) }) ?? '', /glibc sent/u);
    assert.match(
      recordingProblem(rows, { ...good, id: '0000000000000000' }) ?? '',
      /no longer exported/u,
    );
    assert.match(recordingProblem(rows, { ...good, plan: 'servfail' }) ?? '', /no plan/u);
    assert.match(recordingProblem(rows, { ...good, image: 'alpine' }) ?? '', /no image/u);
    const off = { ...row, byImage: { debian12: null } };
    assert.match(recordingProblem([off], good) ?? '', /not replayed/u);
  });
});
