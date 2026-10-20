import { readdirSync } from 'node:fs';
import type { Group } from './name-gate-judge.js';

/**
 * What the name gate's perf arms read and print without asserting (`P-432` S7, round 2's §7.6
 * list, which round 3's keeps): the process's file descriptors across an arm, its resident set
 * across it, the resolver's most running and queued, the walk's channels, and the lookups each of
 * the helper's children was asked. Each is formatted here so that what an arm prints is tested.
 */

const MIB = 1024 * 1024;

/** File descriptors this process holds now, from `/proc/self/fd`; none read where there is none. */
export function openFds(): number | undefined {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return undefined;
  }
}

/** A count by group, as the rows print it: the groups with any, or `none`. */
export function byGroup(of: Readonly<Partial<Record<Group, number>>>): string {
  return (
    (['answering', 'silent', 'cached', 'crash'] as const)
      .filter((group) => (of[group] ?? 0) > 0)
      .map((group) => `${group} ${String(of[group])}`)
      .join(', ') || 'none'
  );
}

export interface WorldReads {
  /** The process's resident set at the wheel's start, its most at a 1 s sample, and at the drain. */
  readonly rss: { readonly start: number; readonly peak: number; readonly end: number };
  /** The resolver's most lookups running and queued, both lane sets, at a 1 s sample. */
  readonly resolverPeak: { readonly running: number; readonly queued: number };
  /** The walk's channels opened, and the most in any one second. */
  readonly channels: { readonly opened: number; readonly busiestSecond: number };
  /** Gate mode: the lookups each of the helper's children was asked, by group, in fork order. */
  readonly children?: readonly Readonly<Partial<Record<Group, number>>>[];
}

const mib = (bytes: number): string => `${(bytes / MIB).toFixed(0)} MiB`;

/** The lines an arm prints of what it read while it ran. */
export function readsLines(reads: WorldReads): string[] {
  const { rss, resolverPeak, channels, children } = reads;
  return [
    `the process's resident set: ${mib(rss.start)} at the start, ${mib(rss.peak)} at most, ${mib(rss.end)} at the drain; the resolver's most running ${String(resolverPeak.running)} and queued ${String(resolverPeak.queued)}; the walk's channels ${String(channels.opened)}, busiest second ${String(channels.busiestSecond)}`,
    ...(children === undefined
      ? []
      : [
          `the helper's children's lookups: ${children.map((asked, child) => `#${String(child + 1)} ${byGroup(asked)}`).join('; ') || 'no child'}`,
        ]),
  ];
}

/** The line an arm prints once torn down: file descriptors, and the lane lookups left open. */
export function teardownLine(
  fds: { readonly before: number | undefined; readonly after: number | undefined },
  laneLookupsLeft: number,
): string {
  const { before, after } = fds;
  const change =
    before === undefined || after === undefined
      ? 'unread (no /proc)'
      : `${String(before)} before, ${String(after)} after (${after - before >= 0 ? '+' : ''}${String(after - before)})`;
  return `torn down: file descriptors ${change}; lookups left on the probe's lanes ${String(laneLookupsLeft)}`;
}
