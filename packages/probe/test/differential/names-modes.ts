import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import { systemLookup } from '@ms/sensors/system-lookup';
import {
  caresAsker,
  DnsCheck,
  type CheckRoute,
  type DnsAsker,
  type DnsChannel,
} from '../../src/resolver/dns-check.js';
import { ForwardBudget } from '../../src/resolver/forward-budget.js';
import { buildNameResolution, type NameResolution } from '../../src/resolver/name-resolution.js';
import { MAX_ADDRESSES, RESOLVER_LANES, type Family } from '../../src/resolver/name-resolver.js';
import { GlibcNamePolicy } from '../../src/resolver/system-names.js';
import { pollWithin, within } from '../support/within.js';
import type { ModesRun } from './names-differential.js';

/**
 * Recording (B) of D30 and §7.5's regression lookups for one row (`P-432` S8, `P-460`), in a
 * process of its own that `names-replay.ts` forks per row with the row's environment, so that
 * this process's `getaddrinfo` reads the row's nsswitch.conf and gai.conf afresh, as glibc reads
 * them once per process. The replay drives it plan by plan over its IPC channel, and sets the
 * simulator's answers between the steps:
 *
 * 1. `prepare`: a name check of its own (`DnsCheck`, with a budget and c-ares of its own: no lanes
 *    and no helper), and the probe's resolver in `system` mode and in `gate` mode, each new, so
 *    every cache is cold. Each check is proven by its canary before the plan's answers are set, as
 *    the canary is no question of the plan's: the replay has every server answer NXDOMAIN until it
 *    has (`names-walk.ts`).
 * 2. `walk`: `DnsCheck.route` for the row's name, alone: the walk's wire is what the servers see
 *    now, and the route is said back.
 * 3. `answers`: the regression's four lookups at once: through the resolver in each mode, in the
 *    helper's child, and on the probe's own lanes (`systemLookup`), and where gate mode ran it.
 * 4. `release`: everything of the plan stopped, the helper's child with it.
 *
 * A sequence row (`P-462`) names the lookup in each `walk` and `answers`, several in turn after one
 * `prepare`, so that the check's key states carry from one lookup to the next as they would in
 * ms-probe. Without a name, each is of the row's own name and family.
 *
 * Every wait has a bound of its own, shorter than the replay's on this process.
 */

/** A lookup a step is of: the row's own name and family unless the request names one. */
export interface ModesLookup {
  readonly host?: string;
  readonly family?: Family;
}

export type ModesRequest =
  | { readonly op: 'prepare' }
  | ({ readonly op: 'walk' } & ModesLookup)
  | ({ readonly op: 'answers' } & ModesLookup)
  | { readonly op: 'release' }
  | { readonly op: 'exit' };

export type ModesReply =
  | { readonly op: 'prepared'; readonly walkProven: boolean; readonly gateProven: boolean }
  | { readonly op: 'walked'; readonly route: string; readonly ms: number }
  | { readonly op: 'answered'; readonly modes: ModesRun }
  | { readonly op: 'released' }
  | { readonly op: 'failed'; readonly message: string };

/** How long each check may take to be proven by its canary: a reply on loopback. */
const PROVE_MS = 5_000;
/** The walk's bound: its routing wait is 250 ms. */
const WALK_MS = 5_000;
/** The regression's lookups: glibc's own, silent plans at most 28 s. */
const ANSWERS_MS = 100_000;
/** Datagrams the walk sent, given time to reach the simulator before the replay reads its log. */
const SETTLE_MS = 60;
const START_MS = 30_000;
const STOP_MS = 10_000;

const logger = pino({ level: 'error' }, process.stderr);

/** c-ares, every channel kept so that a plan's end closes those still open. */
function tracked(asker: DnsAsker): DnsAsker & { closeAll(): void } {
  const open = new Set<DnsChannel>();
  return {
    channel(server) {
      const channel = asker.channel(server);
      open.add(channel);
      return {
        ask: (name, type) => channel.ask(name, type),
        close() {
          open.delete(channel);
          channel.close();
        },
      };
    },
    closeAll() {
      for (const channel of [...open]) channel.close();
      open.clear();
    },
  };
}

/** `answer:<addresses>` in `getaddrinfo`'s order, or `error:<code>`. */
async function said(
  lookup: () => Promise<readonly { readonly address: string }[]>,
): Promise<string> {
  try {
    const addresses = await lookup();
    return `answer:${addresses.map((one) => one.address).join(',')}`;
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    return `error:${typeof code === 'string' ? code : String(error)}`;
  }
}

function routeOf(route: CheckRoute): string {
  return route.route === 'unvouched' ? `unvouched:${route.why}` : route.route;
}

interface Plan {
  readonly check: DnsCheck;
  readonly asker: ReturnType<typeof tracked>;
  readonly system: NameResolution;
  readonly gate: NameResolution;
  readonly dirs: readonly string[];
}

const [name = '', familyText = '0'] = process.argv.slice(2);
/** As the resolver keys a name: trimmed, lower case, a trailing dot kept. */
const keyed = (text: string): string => text.trim().toLowerCase();
/** The lookup a step is of. */
function lookupOf(asked: ModesLookup): { readonly host: string; readonly family: Family } {
  return {
    host: keyed(asked.host ?? name),
    family: asked.family ?? (Number(familyText) as Family),
  };
}
let plan: Plan | undefined;

async function prepare(): Promise<ModesReply> {
  const policy = new GlibcNamePolicy({ logger, env: process.env });
  await policy.load();
  const asker = tracked(caresAsker());
  const now = (): number => performance.now();
  const check = new DnsCheck({
    logger,
    policy,
    budget: new ForwardBudget({ now }),
    asker,
    now,
  });
  const dirs = [
    mkdtempSync(join(tmpdir(), 'ms-modes-system-')),
    mkdtempSync(join(tmpdir(), 'ms-modes-gate-')),
  ];
  const build = (mode: 'system' | 'gate', spoolDir: string): NameResolution =>
    buildNameResolution({ mode, logger, lanes: RESOLVER_LANES, spoolDir });
  const system = build('system', dirs[0] ?? '');
  const gate = build('gate', dirs[1] ?? '');
  plan = { check, asker, system, gate, dirs };
  check.start();
  await within(START_MS, 'the resolvers to start', Promise.all([system.start(), gate.start()]));
  const proven = async (met: () => boolean): Promise<boolean> => {
    try {
      await pollWithin(PROVE_MS, 'a check to be proven', met);
      return true;
    } catch {
      return false;
    }
  };
  const [walkProven, gateProven] = await Promise.all([
    proven(() => check.stats().proven),
    proven(() => gate.resolver.gateHealth()?.checkState === 1),
  ]);
  return { op: 'prepared', walkProven, gateProven };
}

async function walk(asked: ModesLookup): Promise<ModesReply> {
  const current = plan;
  if (current === undefined) throw new Error('walk before prepare');
  const { host, family } = lookupOf(asked);
  const started = performance.now();
  const route = await within(
    WALK_MS,
    'the walk’s route',
    Promise.resolve(
      current.check.route({
        host,
        family,
        refresh: false,
        known: false,
        lastRanMs: undefined,
        boundMs: undefined,
        ref: {},
        own: false,
      }),
    ),
  );
  const ms = performance.now() - started;
  await sleep(SETTLE_MS);
  current.asker.closeAll();
  return { op: 'walked', route: routeOf(route), ms };
}

async function answers(asked: ModesLookup): Promise<ModesReply> {
  const current = plan;
  if (current === undefined) throw new Error('answers before prepare');
  const { host, family } = lookupOf(asked);
  const gateParts = current.gate.gate;
  if (gateParts === undefined) throw new Error('gate mode built no gate');
  const before = current.gate.resolver.gateHealth();
  const [system, gate, helper, lanes] = await within(
    ANSWERS_MS,
    'the regression’s lookups',
    Promise.all([
      said(() => current.system.resolver.resolve(host, family, {})),
      said(() => current.gate.resolver.resolve(host, family, {})),
      said(
        async () => (await gateParts.helper.ask({ host, family, max: MAX_ADDRESSES })).addresses,
      ),
      said(() => systemLookup(host, family)),
    ]),
  );
  const after = current.gate.resolver.gateHealth();
  const toHelper = (after?.lookupsToHelper ?? 0) - (before?.lookupsToHelper ?? 0);
  return {
    op: 'answered',
    modes: { system, gate, gateRan: toHelper > 0 ? 'helper' : 'lanes', helper, lanes },
  };
}

async function release(): Promise<ModesReply> {
  const current = plan;
  plan = undefined;
  if (current !== undefined) {
    current.check.stop();
    current.asker.closeAll();
    await within(
      STOP_MS,
      'the resolvers to stop',
      Promise.all([current.system.stop(), current.gate.stop()]),
    );
    for (const dir of current.dirs) rmSync(dir, { recursive: true, force: true });
  }
  return { op: 'released' };
}

function reply(message: ModesReply): void {
  process.send?.(message);
}

process.on('message', (message: ModesRequest) => {
  const run = async (): Promise<ModesReply | undefined> => {
    switch (message.op) {
      case 'prepare':
        return prepare();
      case 'walk':
        return walk(message);
      case 'answers':
        return answers(message);
      case 'release':
        return release();
      case 'exit':
        await release();
        process.disconnect();
        process.exit(0);
    }
  };
  run().then(
    (done) => {
      if (done !== undefined) reply(done);
    },
    (error: unknown) => {
      reply({
        op: 'failed',
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    },
  );
});
