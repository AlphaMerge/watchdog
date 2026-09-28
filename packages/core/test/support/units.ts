import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A systemd unit file as sections of `Key=value`, the last assignment of a key winning. */
export type UnitFile = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** The shipped unit, read from `deploy/systemd/`, so a test pins the file rather than a copy. */
export function shippedUnit(name: 'ms-core' | 'ms-probe'): UnitFile {
  // dist/test/support → the repository root.
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..');
  return parseUnit(readFileSync(join(repoRoot, 'deploy', 'systemd', `${name}.service`), 'utf8'));
}

export function parseUnit(text: string): UnitFile {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section?.[1] !== undefined) {
      current = sections.get(section[1]) ?? new Map<string, string>();
      sections.set(section[1], current);
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 0 || current === undefined) continue;
    current.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  return sections;
}

/** A systemd time span in milliseconds: `600`, `5s`, `10min`. Enough for the units' own values. */
export function spanMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|sec|min|m)?$/.exec(value);
  if (match?.[1] === undefined) throw new Error(`not a time span this test understands: ${value}`);
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return amount;
    case 'min':
    case 'm':
      return amount * 60_000;
    default:
      return amount * 1_000;
  }
}

/** The start limit and restart delay a unit ships with, read from where systemd reads them. */
export function startLimitOf(unit: UnitFile): {
  intervalMs: number;
  burst: number;
  restartMs: number;
} {
  const interval = unit.get('Unit')?.get('StartLimitIntervalSec');
  const burst = unit.get('Unit')?.get('StartLimitBurst');
  const restart = unit.get('Service')?.get('RestartSec');
  if (interval === undefined || burst === undefined || restart === undefined) {
    throw new Error('the unit sets no start limit in [Unit], or no RestartSec in [Service]');
  }
  return { intervalMs: spanMs(interval), burst: Number(burst), restartMs: spanMs(restart) };
}
