import { connect as netConnect, isIP, Socket, type LookupFunction } from 'node:net';
import { pinnedPeerRefusal, type PinnedAddress } from '../pinned-target.js';
import { DbEncryptionRefusedError, type DbConnectOptions } from './driver.js';

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

/**
 * Whether `mysql2` is about to verify a certificate for a device given as an address (`A-70`).
 *
 * `mysql2` upgrades the socket it has with `tls.connect({ socket, servername })`, and gives a
 * server name only for a name (`lib/base/connection.js` `startTLS`). It takes no identity check
 * of ours: under `verifyIdentity` it hands Node `tls.checkServerIdentity` and nothing else. With
 * no server name and no host, what Node checks the certificate against is, in order, the
 * socket's own record of the host it was told to connect to, and then the literal `localhost`
 * (`onConnectSecure` in Node's `lib/_tls_wrap.js`). A socket connected to an address keeps no
 * such record, so the certificate of a server at `10.0.0.5` was checked against `localhost`.
 */
function verifiesAnAddress(options: DbConnectOptions): boolean {
  return options.verifyTls && options.encrypt !== 'disable' && isIP(options.host) !== 0;
}

/**
 * Tells Node which host a socket was connected to, where it was an address: the record a
 * socket connected by name already has, and the one Node reads when a TLS upgrade names nobody.
 *
 * **The one place here that leans on something Node does not document**, because `mysql2`
 * leaves no other: without it the choice is between `localhost` and no verification. The
 * tests are what hold it: a certificate that lists the address passes, and one for `localhost`
 * or for another address is refused. The day Node stops reading it they fail, on the side of
 * refusing.
 */
function recordHost(socket: Socket, host: string): void {
  Object.defineProperty(socket, '_host', { value: host, writable: true, configurable: true });
}

/** For `mysql2`'s `stream`: already connecting, as the one it makes itself is. */
export function connectingSocket(options: DbConnectOptions): (() => Socket) | undefined {
  const lookup = options.lookup;
  const address = verifiesAnAddress(options);
  if (lookup === undefined && !address) return undefined;
  return () => {
    const socket =
      lookup === undefined
        ? netConnect({ host: options.host, port: options.port })
        : netConnect(destination(options, lookup));
    if (address) recordHost(socket, options.host);
    holdToPin(socket, options.host, options.pinned);
    // What `mysql2` sets on a socket of its own, and not on one it is handed.
    socket.setNoDelay(true);
    return socket;
  };
}

/** PRELOGIN's ENCRYPTION option, and the two answers under which `tedious` starts TLS. */
const PRELOGIN_ENCRYPTION = 0x01;
const PRELOGIN_END = 0xff;
const ENCRYPT_ON = 0x01;
const ENCRYPT_REQ = 0x03;
/** More than any PRELOGIN answer is: a server still sending past this is not answering one. */
const PRELOGIN_MAX_BYTES = 65_536;

/**
 * The encryption a server's PRELOGIN answer names, from the bytes received so far (`A-70`):
 * the value, `incomplete` while the message has not all arrived, and undefined when it has and
 * names none that can be read.
 *
 * A TDS packet is eight bytes of header (type, status, length in two bytes, and four more)
 * and its payload; a message ends at the packet whose status has the low bit set. A PRELOGIN
 * payload is a list of options, five bytes each (token, offset, length), ended by `0xff`, and
 * then the data the offsets point into.
 */
export function preloginEncryption(received: Buffer): number | undefined | 'incomplete' {
  const parts: Buffer[] = [];
  for (let at = 0; ;) {
    if (received.length - at < 8) return 'incomplete';
    const length = received.readUInt16BE(at + 2);
    if (length < 8) return undefined;
    if (received.length - at < length) return 'incomplete';
    parts.push(received.subarray(at + 8, at + length));
    const last = (received.readUInt8(at + 1) & 0x01) !== 0;
    at += length;
    if (last) break;
  }
  const body = Buffer.concat(parts);
  for (let option = 0; option < body.length; option += 5) {
    const token = body.readUInt8(option);
    if (token === PRELOGIN_END || option + 5 > body.length) return undefined;
    if (token !== PRELOGIN_ENCRYPTION) continue;
    const offset = body.readUInt16BE(option + 1);
    const size = body.readUInt16BE(option + 3);
    if (size < 1 || offset >= body.length) return undefined;
    return body.readUInt8(offset);
  }
  return undefined;
}

/**
 * Ends a connection whose server answers PRELOGIN saying it will not encrypt, before
 * `tedious` can log in on it (`A-70`).
 *
 * **`tedious` takes that answer at its word.** Its `encrypt` is a boolean: it asks for
 * encryption, and starts TLS only if the answer says ON or REQ (`lib/connection.js`,
 * `performTlsNegotiation`). For NOT_SUP or OFF it starts none, raises nothing, and sends
 * LOGIN7, with the password, on the bare socket. The answer is clear text, so anyone on the
 * path between the probe and the server chooses it by rewriting one byte. Under `require`
 * with the certificate verified, that was a login in clear and nothing verified.
 *
 * **Refused here, on the socket, because here is before the login.** This listens first, so
 * it reads each chunk in the same turn `tedious`'s own reader is handed it, and `tedious`
 * writes its login only in a later one. A socket destroyed in that turn sends nothing after.
 * Checking once `tedious` says it has connected would be checking after the password left.
 *
 * An answer that cannot be read is refused too: under `require` nothing is assumed.
 */
function holdToEncryption(socket: Socket, where: string): void {
  let received: Buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    received = Buffer.concat([received, chunk]);
    const answer = preloginEncryption(received);
    if (answer === 'incomplete' && received.length <= PRELOGIN_MAX_BYTES) return;
    socket.removeListener('data', onData);
    if (answer !== ENCRYPT_ON && answer !== ENCRYPT_REQ) {
      socket.destroy(new DbEncryptionRefusedError(where));
    }
  };
  socket.on('data', onData);
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
 * of its own, or refuses it for a set whose bounds do not cover it.
 *
 * What `tedious` 20 does, from `lib/connection.js`: `performSentLogin7WithStandardLogin`
 * (2364-2390) returns the routing a login was answered with, `initialiseConnection` (1141-1145)
 * goes to `performReRouting` (2323-2335), which destroys the socket and starts over, and
 * `connectOnPort` (1253-1260) then calls the connector with `routingData.server` and
 * `routingData.port` as the host and port of its first argument.
 */
export function tdsConnector(
  options: DbConnectOptions,
): ((...asked: readonly unknown[]) => Promise<Socket>) | undefined {
  // **Handed over whenever a redirect has to be asked about**, which is not only when the
  // device's name was resolved: a device given as an address has no lookup, and left to itself
  // `tedious` would resolve the server it is routed to and connect there unchecked.
  // And whenever encryption is required: the socket is the one place a server that says it
  // has none can be refused before the login is written to it (`holdToEncryption`).
  const lookup = options.lookup;
  const required = options.encrypt === 'require';
  if (lookup === undefined && options.redirect === undefined && !required) return undefined;
  return async (...asked) => {
    const to = asked[0] as { host?: unknown; port?: unknown } | undefined;
    const signal = asked[2] instanceof AbortSignal ? asked[2] : undefined;
    const host = typeof to?.host === 'string' && to.host !== '' ? to.host : options.host;
    const port = typeof to?.port === 'number' ? to.port : options.port;
    const elsewhere = nameOf(host) !== nameOf(options.host);
    // Handed over for the encryption check alone, with nothing checked (`none`, no bounds),
    // a redirect is followed as the driver itself would have: unresolved, by the socket.
    const unchecked = lookup === undefined && options.redirect === undefined;
    const through = elsewhere && !unchecked ? await redirected(options, host) : lookup;

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
          if (required) holdToEncryption(socket, `${host}:${String(port)}`);
          resolve(socket);
        });
      };
      const timer = setTimeout(() => {
        giveUp(
          Object.assign(
            new Error(`connect to ${host}:${String(port)} timed out`),
            // `describeDbError` reads this as the firewall that drops packets, and names the
            // server the login was routed to when it is not the device that did not answer.
            {
              code: 'ETIMEDOUT',
              ...(elsewhere || port !== options.port
                ? { routedTo: `${host}:${String(port)}` }
                : {}),
            },
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
