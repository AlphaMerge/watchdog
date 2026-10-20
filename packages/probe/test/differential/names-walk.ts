import { replies, type DnsBehaviour, type DnsQueryRecord, type DnsSimulator } from '@ms/simulators';
import {
  optOf,
  wireOf,
  type Asked,
  type ModesRun,
  type SequenceRow,
  type WalkRun,
} from './names-differential.js';
import type { ModesReply, ModesRequest } from './names-modes.js';

/**
 * Recording (B) of a plan, and its regression lookups, after glibc's (`P-432` S8, `P-460`): the
 * steps `names-replay.ts` takes with a row's `names-modes` process and the simulator, kept here
 * apart from the replay so that their order is unit-tested (`names-differential.test.ts`).
 *
 * 1. Every server of the simulator is set to `NEUTRAL`, so that each check's canary is answered
 *    under no plan's answers. Every behaviour the replay sets is a server's fallback, so this
 *    leaves none of the plan's (A) set.
 * 2. `prepare`: each check proven by its canary.
 * 3. The plan's answers set, the log cleared, and, through systemd-resolved, its cache flushed
 *    and the stub's capture on.
 * 4. `walk`: the check routes the name alone, and the wire is what the servers saw since 3.
 * 5. `answers`, then `release`.
 *
 * A sequence row (`walkSequence`, `P-462`) takes the same steps with each of its lookups in turn
 * through the one check proven in 2: each walk with the log cleared before it, so its wire is its
 * own, then each lookup's regression in the same order, then `release`.
 */

/** What every server answers while the checks are proven: NXDOMAIN, as one no plan has set. */
export const NEUTRAL: DnsBehaviour = { reply: replies.nxdomain };

/** The simulator, as the walk's steps use it. */
export type WalkSimulator = Pick<DnsSimulator, 'set' | 'clearLog' | 'log'>;

/** A row's `names-modes` process, as the walk's steps use it. */
export interface ModesChannel {
  request<K extends ModesReply['op']>(
    message: ModesRequest,
    op: K,
  ): Promise<Extract<ModesReply, { op: K }>>;
}

/** Through systemd-resolved: its cache flushed, and what the stub is sent read off `lo`. */
export interface StubSteps {
  flush(): Promise<void>;
  capture(): Promise<{ stop(): Promise<Asked[]> }>;
}

export interface Recorded {
  readonly walk: WalkRun;
  readonly modes: ModesRun;
  readonly setup: string[];
}

/** The questions the servers saw, resolved's own upstream ones aside. */
export function askedOf(log: readonly DnsQueryRecord[]): Asked[] {
  return log
    .filter((entry) => !entry.server.startsWith('upstream:'))
    .map((entry) => ({
      server: entry.server,
      qname: entry.qname,
      qtype: entry.qtype,
      transport: entry.transport,
      opt: entry.opt,
    }));
}

/**
 * Recording (B) of a plan, and its regression lookups: every server of `servers` neutral, the
 * checks proven, then the plan's answers set and the log cleared, so the wire is the walk's alone.
 */
export async function walkAndModes(
  modes: ModesChannel,
  sim: WalkSimulator,
  servers: readonly string[],
  setPlan: () => Promise<void>,
  stub: StubSteps | undefined,
): Promise<Recorded> {
  const setup: string[] = [];
  for (const server of servers) await sim.set({ fallback: true }, NEUTRAL, server);
  const prepared = await modes.request({ op: 'prepare' }, 'prepared');
  if (!prepared.walkProven) setup.push('the walk’s check was not proven by its canary');
  if (!prepared.gateProven) setup.push('gate mode’s check was not proven by its canary');
  await setPlan();
  await sim.clearLog();
  await stub?.flush();
  const capture = stub === undefined ? undefined : await stub.capture();
  const walked = await modes.request({ op: 'walk' }, 'walked');
  const stubbed = capture === undefined ? [] : await capture.stop();
  const asked = [...stubbed, ...askedOf(await sim.log())];
  const answered = await modes.request({ op: 'answers' }, 'answered');
  await modes.request({ op: 'release' }, 'released');
  return {
    walk: { route: walked.route, wire: wireOf(asked), opt: optOf(asked), ms: walked.ms },
    modes: answered.modes,
    setup,
  };
}

/** The simulator, as a sequence row's answers are set on it. */
export type PlanSimulator = Pick<DnsSimulator, 'set' | 'prime'>;

/**
 * A sequence row's answers (`P-462`): each server's behaviour as its fallback, and its cache
 * primed with the row's own entries, each name's addresses and TTL as the row writes them, so
 * that what glibc and the walk are answered is what the answer rows' digest names.
 */
export async function setSequencePlan(
  sim: PlanSimulator,
  row: Pick<SequenceRow, 'servers'>,
): Promise<void> {
  for (const server of row.servers) {
    await sim.set({ fallback: true }, server.behaviour, server.address);
    if (server.cached !== undefined) await sim.prime(server.cached, server.address);
  }
}

/** A sequence row's lookups played after glibc's, as `walkAndModes` plays one plan's. */
export interface RecordedSequence {
  readonly walks: readonly WalkRun[];
  readonly modes: readonly ModesRun[];
  readonly setup: string[];
}

/**
 * Recording (B) of a sequence row's lookups, and their regression lookups (`P-462`): every server
 * of `servers` neutral, the checks proven, then the row's answers set, and each lookup walked in
 * turn by the one check, the log cleared before each so that each wire is that walk's alone; then
 * each lookup's regression in the same order.
 */
export async function walkSequence(
  modes: ModesChannel,
  sim: WalkSimulator,
  servers: readonly string[],
  setPlan: () => Promise<void>,
  lookups: readonly { readonly host: string; readonly family: 0 | 4 | 6 }[],
): Promise<RecordedSequence> {
  const setup: string[] = [];
  for (const server of servers) await sim.set({ fallback: true }, NEUTRAL, server);
  const prepared = await modes.request({ op: 'prepare' }, 'prepared');
  if (!prepared.walkProven) setup.push('the walk’s check was not proven by its canary');
  if (!prepared.gateProven) setup.push('gate mode’s check was not proven by its canary');
  await setPlan();
  const walks: WalkRun[] = [];
  for (const lookup of lookups) {
    await sim.clearLog();
    const walked = await modes.request({ op: 'walk', ...lookup }, 'walked');
    const asked = askedOf(await sim.log());
    walks.push({ route: walked.route, wire: wireOf(asked), opt: optOf(asked), ms: walked.ms });
  }
  const answered: ModesRun[] = [];
  for (const lookup of lookups) {
    answered.push((await modes.request({ op: 'answers', ...lookup }, 'answered')).modes);
  }
  await modes.request({ op: 'release' }, 'released');
  return { walks, modes: answered, setup };
}
