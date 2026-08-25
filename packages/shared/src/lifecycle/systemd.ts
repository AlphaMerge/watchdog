import { execFile } from 'node:child_process';
import type { Logger } from '../logging/logger.js';

/**
 * `sd_notify` support.
 *
 * Node has no way to write to an `AF_UNIX`/`SOCK_DGRAM` socket — `node:dgram` is UDP only and
 * `node:net` speaks `SOCK_STREAM` — so there is no in-process way to reach `$NOTIFY_SOCKET`
 * without a native addon. We shell out to `systemd-notify`, which ships with systemd itself and
 * keeps the dependency list at zero. The unit sets `NotifyAccess=all` so notifications from the
 * helper process are accepted.
 *
 * This interface is deliberately narrow: if the spawn cost ever matters, swapping in a native
 * addon touches this file and nothing else.
 */
export interface ServiceNotifier {
  readonly enabled: boolean;
  /** Tell the supervisor start-up finished. */
  ready(status?: string): void;
  /** Watchdog keep-alive. Must arrive more often than `WatchdogSec`. */
  watchdog(): void;
  stopping(status?: string): void;
  status(text: string): void;
}

const NOOP_NOTIFIER: ServiceNotifier = {
  enabled: false,
  ready: () => undefined,
  watchdog: () => undefined,
  stopping: () => undefined,
  status: () => undefined,
};

function send(args: string[], logger: Logger): void {
  execFile('systemd-notify', args, (err) => {
    if (err) {
      logger.debug({ err: err.message, args }, 'systemd-notify failed');
    }
  });
}

export function createServiceNotifier(logger: Logger, env = process.env): ServiceNotifier {
  const socket = env['NOTIFY_SOCKET'];
  if (socket === undefined || socket === '') return NOOP_NOTIFIER;

  const pidArg = `--pid=${String(process.pid)}`;
  return {
    enabled: true,
    ready: (status) => {
      send([pidArg, 'READY=1', ...(status === undefined ? [] : [`STATUS=${status}`])], logger);
    },
    watchdog: () => {
      send([pidArg, 'WATCHDOG=1'], logger);
    },
    stopping: (status) => {
      send([pidArg, 'STOPPING=1', ...(status === undefined ? [] : [`STATUS=${status}`])], logger);
    },
    status: (text) => {
      send([pidArg, `STATUS=${text}`], logger);
    },
  };
}

/**
 * The watchdog interval systemd expects, derived from `WATCHDOG_USEC`. systemd's own advice is
 * to notify at half the configured interval.
 */
export function watchdogIntervalMs(env = process.env): number | null {
  const usec = env['WATCHDOG_USEC'];
  if (usec === undefined) return null;
  const parsed = Number.parseInt(usec, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1_000, Math.floor(parsed / 1000 / 2));
}
