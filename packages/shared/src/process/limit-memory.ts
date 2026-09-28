import { readFileSync } from 'node:fs';
import type { AvailableMemory } from './memory-watch.js';

/**
 * How close this process's cgroup is to the memory ceiling the kernel enforces on it (`P-210`).
 *
 * **Not the machine's memory, which `P-208` reports.** `ms-probe.service` sets `MemoryHigh=4G` and
 * `MemoryMax=6G`, and the kernel applies those to the service's cgroup whatever the machine has
 * left: on a 64 GiB host the probe reaches its ceiling with `memoryAvailable` reading 80%.
 *
 * **The ceiling is the lower of `memory.high` and `memory.max`, because the lower one acts
 * first.** Past `memory.high` the kernel throttles every allocation, and past `memory.max` it
 * kills. On the stock unit that makes the probe's ceiling 4 GiB, not 6 — and throttled is not a
 * milder kind of working: measured under the shipped unit with no swap, the probe was stalled on
 * memory 73% of the time within 17 seconds and its own watchdog killed it within 25, 2 GiB short of
 * where the kernel would have (`docs/findings/2026-09-27-memory-limit.md`).
 *
 * **Measured against the working set — `memory.current` less `inactive_file` — never
 * `memory.current`.** The kernel lets page cache fill a cgroup up to `memory.high` on purpose and
 * reclaims it there for almost nothing: writing 400 MB through a 200 MiB `memory.high` held
 * `memory.current` at 198 MiB and counted 425 `high` events, with a working set of 6 MiB and the
 * cgroup never stalled (`docs/findings/2026-09-27-cgroup-high-behaviour.jsonl`). A probe replaying its spool would read "at its ceiling" on
 * `memory.current` while perfectly well. The working set is also what Kubernetes evicts on.
 *
 * **Every level up to the root, and the tightest wins.** A limit on `system.slice` binds the probe
 * as surely as one on its own unit, and each level's `memory.current` already includes everything
 * beneath it — siblings too, which is correct for a limit they share.
 *
 * **A gap** — `null` — where there is no ceiling (`max` all the way up), on cgroup v1 (RHEL 8 and
 * its rebuilds by default, where `MemoryHigh=` does not exist and whether `MemoryMax=` is applied
 * depends on the systemd version), and anywhere but Linux: WinSW sets no memory limit. A gap, not
 * a zero, because no ceiling is not the same thing as a ceiling nothing is near.
 *
 * `availableBytes` is the ceiling less the working set, negative past it.
 */

/** Where the files come from, injectable so a test does not read the cgroup it runs in. */
export interface LimitMemorySources {
  readonly platform: NodeJS.Platform;
  /** Throws when the file does not exist, as `readFileSync` does. */
  readonly readFile: (path: string) => string;
}

const LIVE: LimitMemorySources = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, 'utf8'),
};

const ROOT = '/sys/fs/cgroup';

export function readLimitMemory(sources: LimitMemorySources = LIVE): AvailableMemory | null {
  if (sources.platform !== 'linux') return null;
  const own = unifiedPath(attempt(() => sources.readFile('/proc/self/cgroup')));
  if (own === null) return null;

  let binding: AvailableMemory | null = null;
  for (const path of ancestry(own)) {
    const directory = path === '/' ? ROOT : `${ROOT}${path}`;
    const read = (file: string): string | null =>
      attempt(() => sources.readFile(`${directory}/${file}`));
    const ceiling = lower(bytes(read('memory.high')), bytes(read('memory.max')));
    const current = bytes(read('memory.current'));
    // No ceiling at this level, or not a level this process can read: the next one up may have.
    if (ceiling === null || current === null) continue;
    const inactiveFile = statValue(read('memory.stat'), 'inactive_file') ?? 0;
    const workingSet = Math.max(0, current - inactiveFile);
    const available = ceiling - workingSet;
    if (binding === null || available < binding.availableBytes) {
      binding = { availableBytes: available, totalBytes: ceiling };
    }
  }
  return binding;
}

/**
 * The cgroup v2 path from `/proc/self/cgroup`, or `null` on v1.
 *
 * v2 is the one line `0::/path`. A hybrid host has that line too, but its memory controller is on
 * v1, so the files under `/sys/fs/cgroup/<path>` are not there and every level is skipped — which
 * is the gap it should be.
 */
function unifiedPath(text: string | null): string | null {
  if (text === null) return null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('0::')) continue;
    const path = line.slice(3).trim();
    // A cgroup outside this namespace reads as a relative climb; there is nothing to read there.
    if (!path.startsWith('/') || path.split('/').includes('..')) return null;
    return path;
  }
  return null;
}

/** `/a/b/c`, `/a/b`, `/a`, `/` — own cgroup first. */
function ancestry(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const paths: string[] = [];
  for (let length = parts.length; length > 0; length -= 1) {
    paths.push(`/${parts.slice(0, length).join('/')}`);
  }
  paths.push('/');
  return paths;
}

/** A byte count, or `null` for `max` — no limit — and for anything that is not a number. */
function bytes(text: string | null): number | null {
  const value = text?.trim();
  if (value === undefined || value === '' || value === 'max') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function lower(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** One key from `memory.stat`'s `key value` lines. */
function statValue(text: string | null, key: string): number | null {
  if (text === null) return null;
  for (const line of text.split('\n')) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key) return bytes(value ?? null);
  }
  return null;
}

function attempt(read: () => string): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}
