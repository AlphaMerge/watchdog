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
  /**
   * Tell the supervisor the service is stopping, and, with `extendMs`, that the stop may take that
   * long (`P-227`). Sent together in one datagram for the reason `extendTimeout` gives.
   */
  stopping(status?: string, extendMs?: number): void;
  status(text: string): void;
  /**
   * Ask for more time to finish starting (`P-215`), as `EXTEND_TIMEOUT_USEC`.
   *
   * `TimeoutStartSec` is a single deadline, and a service that is legitimately waiting — for a
   * database still in crash recovery — would otherwise be killed at it and counted as a failed
   * start. This does not buy unlimited time: the service must send it again before `ms` runs
   * out, so a wait that stops making progress still ends at systemd's hand. Needs systemd 236.
   *
   * The status travels in the same datagram, because every call here is its own spawn and two
   * spawns are not ordered: `systemctl status` could otherwise show the previous attempt's reason
   * beside this attempt's deadline.
   */
  extendTimeout(ms: number, status?: string): void;
}

const NOOP_NOTIFIER: ServiceNotifier = {
  enabled: false,
  ready: () => undefined,
  watchdog: () => undefined,
  stopping: () => undefined,
  status: () => undefined,
  extendTimeout: () => undefined,
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
    stopping: (status, extendMs) => {
      send(
        [
          pidArg,
          'STOPPING=1',
          ...(extendMs === undefined
            ? []
            : [`EXTEND_TIMEOUT_USEC=${String(Math.max(0, Math.round(extendMs)) * 1000)}`]),
          ...(status === undefined ? [] : [`STATUS=${status}`]),
        ],
        logger,
      );
    },
    status: (text) => {
      send([pidArg, `STATUS=${text}`], logger);
    },
    extendTimeout: (ms, status) => {
      send(
        [
          pidArg,
          `EXTEND_TIMEOUT_USEC=${String(Math.max(0, Math.round(ms)) * 1000)}`,
          ...(status === undefined ? [] : [`STATUS=${status}`]),
        ],
        logger,
      );
    },
  };
}

/**
 * How many pings each `WatchdogSec` holds (`P-243`).
 *
 * **Six, not systemd's advised two.** The ping is a timer on the main thread, and a timer is late
 * by however long the thread was held. At half the interval, one late ping uses the whole margin:
 * `P-216c` held both services' main threads for 7–15 s under CPU starvation at the memory limit,
 * and the probe's timer fired 30.4 s after its last ping against `WatchdogSec=30`. At a sixth the
 * longest gap is the longest block plus 5 s. The ping stays on the main thread deliberately: one
 * sent from anywhere else goes on while the thread it vouches for is hung.
 */
export const WATCHDOG_PINGS_PER_INTERVAL = 6;

/** How often to ping the watchdog, from `WATCHDOG_USEC`, or `null` when there is none. */
export function watchdogIntervalMs(env = process.env): number | null {
  const usec = env['WATCHDOG_USEC'];
  if (usec === undefined) return null;
  const parsed = Number.parseInt(usec, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1_000, Math.floor(parsed / 1000 / WATCHDOG_PINGS_PER_INTERVAL));
}
