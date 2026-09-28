import { isIP } from 'node:net';
import { describeError } from '../errors/app-error.js';
import { networkInterfaces } from 'node:os';
import type { Logger } from '../logging/logger.js';

/**
 * How long a start waits for a configured listen address to appear, before exiting so that systemd
 * starts it again. The same five minutes as the core's database wait, and for the same reason: a
 * round at least this long puts at most two starts in the units' ten-minute start-limit window,
 * so an address that never appears is retried for ever and never ends the unit in `failed`.
 */
export const ADDRESS_WAIT_MS = 5 * 60_000;

const POLL_MS = 1_000;
/** One log line and one supervisor report per this long, not per poll. */
const REPORT_EVERY_MS = 15_000;
const EXTEND_MARGIN_MS = 5_000;

export interface AddressWaitOptions {
  /** The configured bind address, exactly as the listener will be given it. */
  readonly address: string;
  /** What binds it, for the log and `systemctl status`: `syslog listener`, `API`. */
  readonly what: string;
  readonly logger: Logger;
  /** `Lifecycle.starting`, so systemd keeps waiting while this does. */
  readonly starting?: (status: string, ms: number) => void;
  readonly maxWaitMs?: number;
  /** Injectable for tests: the host's addresses, and a clock and a sleep that need not be real. */
  readonly addresses?: () => readonly string[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function hostAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address);
}

/** `127.0.0.0/8` and `::1`: a host without them has no loopback, and waiting will not give it one. */
function isLoopback(address: string): boolean {
  return address === '::1' || /^127\./.test(address);
}

/**
 * Waits until this host has `address`, when it is a specific IP address it does not have yet
 * (`P-222`).
 *
 * **The one bind failure that fixes itself.** A listener configured on a specific address fails
 * with `EADDRNOTAVAIL` when the host does not have that address, and at boot it may simply not
 * have it *yet*: `network-online.target` does not promise every address, and a DHCP lease on a
 * second interface, a VLAN, a bridge or a virtual IP can arrive later. Before `P-215` that was
 * waited out by restarting every five seconds; under the start limit, five restarts in thirty
 * seconds left the unit `failed` for good. `EADDRINUSE` and `EACCES` are not waited for: another
 * process and a missing capability are still there five minutes later.
 *
 * Returns at once for a wildcard, a host name, a loopback address or an address the host already
 * has, which is every default. Returns too when the host's addresses cannot be read at all —
 * `uv_interface_addresses` fails with `EAFNOSUPPORT` in some containers — because then waiting
 * knows nothing the bind does not, and the bind's own error is the diagnosis. Throws past the
 * bound, and the process exits so that systemd starts it again.
 */
export async function waitForLocalAddress(options: AddressWaitOptions): Promise<void> {
  const { address } = options;
  if (isIP(address) === 0) return;
  if (address === '0.0.0.0' || address === '::' || isLoopback(address)) return;

  const logger = options.logger.child({ component: 'address-wait', address, for: options.what });
  const addresses = options.addresses ?? hostAddresses;
  /** Whether the host has the address, or `undefined` when its addresses cannot be read. */
  const has = (): boolean | undefined => {
    try {
      return addresses().includes(address);
    } catch (error) {
      logger.warn(
        { err: describeError(error) },
        `cannot read this host's addresses; not waiting for ${address}, the listener's bind will say whether it is there`,
      );
      return undefined;
    }
  };
  if (has() !== false) return;

  const maxWaitMs = options.maxWaitMs ?? ADDRESS_WAIT_MS;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const now = options.now ?? ((): number => Number(process.hrtime.bigint() / 1_000_000n));

  const started = now();
  let reported = -Infinity;
  for (;;) {
    const waitedMs = now() - started;
    if (waitedMs >= maxWaitMs) {
      const message =
        `${address}, which the ${options.what} is configured to listen on, did not appear on ` +
        `this host in ${String(Math.round(waitedMs / 1000))} s`;
      logger.error({ waitedMs }, `${message}; exiting so the service manager can start it again`);
      throw new Error(message);
    }
    if (waitedMs - reported >= REPORT_EVERY_MS) {
      reported = waitedMs;
      const status =
        `waiting for ${address} to be assigned to this host, for the ${options.what}` +
        ` (${String(Math.round(waitedMs / 1000))} s)`;
      logger.warn({ waitedMs }, status);
      options.starting?.(status, REPORT_EVERY_MS + EXTEND_MARGIN_MS);
    }
    await sleep(POLL_MS);
    const present = has();
    if (present === undefined) return;
    if (present) {
      logger.info({ waitedMs: now() - started }, `${address} is assigned; continuing start-up`);
      return;
    }
  }
}
