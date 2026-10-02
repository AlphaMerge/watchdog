import { connect as netConnect, Socket, type LookupFunction } from 'node:net';
import { pinnedPeerRefusal, type PinnedAddress } from '../pinned-target.js';
import type { DbConnectOptions } from './driver.js';

/**
 * The socket a database driver is handed in place of making its own (`A-62`).
 *
 * `pg`, `mysql2` and `tedious` each resolve a device's name themselves and none of them takes a
 * `lookup`. Each does take the connection: `pg` a `stream` factory whose socket it calls
 * `connect(port, host)` on, `mysql2` a `stream` it uses as it finds it, `tedious` a `connector`
 * that answers with a connected socket. So the name is resolved once, by `checkedTarget`, and
 * the driver is given a socket whose `lookup` answers the name with the addresses that were
 * checked.
 *
 * **The socket still connects to the name**, and the driver still holds the name as its host,
 * which is what each one reads when it upgrades the socket to TLS: the server name it sends and
 * the name the certificate is checked against are the operator's, never the checked address.
 *
 * Read from the installed drivers, not assumed:
 * - `pg` 8.23 `lib/connection.js`: `config.stream`, called when it is a function; then
 *   `stream.connect(port, host)`, and `upgradeToSSL(host)` wraps the same stream with
 *   `servername` set to the host when it is not an address. `lib/client.js` destroys the stream
 *   at `connectionTimeoutMillis` whoever made it, and a client is never connected twice.
 * - `mysql2` 3.24 `lib/base/connection.js`: `config.stream`, a function or a stream, used with
 *   no `connect` call of the driver's own; `startTLS` wraps it with `servername` from
 *   `config.host`; its `connectTimeout` timer runs whoever made the stream. No reconnect.
 * - `tedious` 20 `lib/connection.js` `connectOnPort`: `options.connector`, called in place of
 *   its own connect **and awaited with nothing raced against it**, so the connector must end
 *   itself at the timeout. The TLS it runs inside TDS names `config.server`
 *   (`lib/message-io.js` `startTls`).
 */

/** What the connect has left once the one lookup has been taken out of the sensor's timeout. */
export function connectBudgetMs(options: DbConnectOptions): number {
  return options.connectWithinMs ?? options.connectTimeoutMs;
}

interface Destination {
  host: string;
  port: number;
  lookup: LookupFunction;
}

const destination = (
  to: { readonly host: string; readonly port: number },
  lookup: LookupFunction,
): Destination => ({ host: to.host, port: to.port, lookup });

/**
 * Ends a connection whose far end is not the address a credential set was checked against
 * (`A-41c`), before the driver has said anything on it. Listening first, so it runs first.
 */
function holdToPin(socket: Socket, host: string, pinned: PinnedAddress | undefined): void {
  if (pinned === undefined) return;
  socket.once('connect', () => {
    const refusal = pinnedPeerRefusal(host, pinned, socket.remoteAddress);
    if (refusal !== null) socket.destroy(refusal);
  });
}

/**
 * A socket that has not connected, for a driver that calls `connect(port, host)` on what it is
 * given (`pg`). Wherever the driver says to connect, it connects to the device, through the
 * lookup that answers with the checked addresses.
 */
class CheckedSocket extends Socket {
  readonly #to: Destination;

  constructor(to: Destination) {
    super();
    this.#to = to;
  }

  override connect(): this {
    return super.connect(this.#to);
  }
}

/** For `pg`'s `stream`: not yet connecting. Undefined when the driver connects as it always has. */
export function unconnectedSocket(options: DbConnectOptions): (() => Socket) | undefined {
  const lookup = options.lookup;
  if (lookup === undefined) return undefined;
  return () => {
    const socket = new CheckedSocket(destination(options, lookup));
    holdToPin(socket, options.host, options.pinned);
    return socket;
  };
}

/** For `mysql2`'s `stream`: already connecting, as the one it makes itself is. */
export function connectingSocket(options: DbConnectOptions): (() => Socket) | undefined {
  const lookup = options.lookup;
  if (lookup === undefined) return undefined;
  return () => {
    const socket = netConnect(destination(options, lookup));
    holdToPin(socket, options.host, options.pinned);
    // What `mysql2` sets on a socket of its own, and not on one it is handed.
    socket.setNoDelay(true);
    return socket;
  };
}

/** A name as it is compared: lower case, without one trailing dot. */
function nameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * For `tedious`'s `connector`: a connected socket, or the reason there is none.
 *
 * **`tedious` waits for this and nothing else**, so the connect is ended here: at what is left
 * of the connect timeout, and when the driver's own signal says so.
 *
 * **A redirect is another server, and is checked as one.** SQL Server may answer a login by
 * naming a different server and port (Azure does, from inside its network), and `tedious` then
 * asks the connector again. It passes where to (`{ host, port }`, then its lookup and its
 * signal), which its typings do not say: an argument that is not that shape is taken for the
 * device itself, which is the only place the typed contract connects to. A host that is not
 * the device's is handed to `options.redirect`, which checks it against the policy on a lookup
 * of its own, or refuses it for a set that was pinned.
 */
export function tdsConnector(
  options: DbConnectOptions,
): ((...asked: readonly unknown[]) => Promise<Socket>) | undefined {
  const lookup = options.lookup;
  if (lookup === undefined) return undefined;
  return async (...asked) => {
    const to = asked[0] as { host?: unknown; port?: unknown } | undefined;
    const signal = asked[2] instanceof AbortSignal ? asked[2] : undefined;
    const host = typeof to?.host === 'string' && to.host !== '' ? to.host : options.host;
    const port = typeof to?.port === 'number' ? to.port : options.port;
    const elsewhere = nameOf(host) !== nameOf(options.host);
    const through = elsewhere ? await redirected(options, host) : lookup;

    return new Promise<Socket>((resolve, reject) => {
      const socket =
        through === undefined
          ? netConnect({ host, port })
          : netConnect(destination({ host, port }, through));
      const settle = (outcome: () => void): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.removeListener('error', onError);
        socket.removeListener('connect', onConnect);
        outcome();
      };
      const giveUp = (error: unknown): void => {
        settle(() => {
          socket.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };
      const onError = (error: Error): void => {
        giveUp(error);
      };
      const onAbort = (): void => {
        giveUp(signal?.reason);
      };
      const onConnect = (): void => {
        const refusal =
          options.pinned === undefined || elsewhere
            ? null
            : pinnedPeerRefusal(options.host, options.pinned, socket.remoteAddress);
        if (refusal !== null) {
          giveUp(refusal);
          return;
        }
        settle(() => {
          resolve(socket);
        });
      };
      const timer = setTimeout(() => {
        giveUp(
          Object.assign(
            new Error(`connect to ${host}:${String(port)} timed out`),
            // `describeDbError` reads this as the firewall that drops packets.
            { code: 'ETIMEDOUT' },
          ),
        );
      }, connectBudgetMs(options));
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('error', onError);
      socket.once('connect', onConnect);
      if (signal?.aborted === true) onAbort();
    });
  };
}

async function redirected(
  options: DbConnectOptions,
  host: string,
): Promise<LookupFunction | undefined> {
  if (options.redirect === undefined) {
    throw new Error(
      `${options.host} redirected the connection to ${host}, which nothing has checked, so ` +
        'it was not followed',
    );
  }
  return options.redirect(host);
}
