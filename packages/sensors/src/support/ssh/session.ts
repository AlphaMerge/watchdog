// Default import, not named: `ssh2` is CommonJS, and Node's ESM loader cannot see named
// exports through it at runtime even though TypeScript resolves them. Same as `net-snmp`.
import ssh2 from 'ssh2';
import type { Client, ClientChannel } from 'ssh2';
import { connect as netConnect, isIP, type LookupFunction, type Socket } from 'node:net';
import {
  checkedLookup,
  connectFailure,
  familyLookup,
  familyOf,
  socketUnresolved,
} from '../checked-target.js';
import type { PinnedAddress } from '../pinned-target.js';
import { describeCredentials, type SshCredentials } from './credentials.js';
import { describeVerdict, verifyHostKey, type HostKeyVerdict } from './host-key.js';

/**
 * One SSH connection to one host (`T-07`).
 *
 * **The only file in `packages/` that imports `ssh2`**, for the reason `session.ts` next door
 * records about `net-snmp`: ADR-001 Decision 6 wants the cost of replacing a protocol library to
 * be a change to one file, and that only holds if there is one file. `ssh2.d.ts` beside this
 * declares the surface actually used — about a hundred lines — which is the other half of that
 * bargain.
 *
 * **A connection is not a session, and the difference is what makes reuse worth having.** An SSH
 * handshake is TCP, key exchange and authentication — hundreds of milliseconds against SNMP's
 * single datagram — while a *channel* on an established connection is nearly free. So a device
 * with a dozen SSH sensors pays for one handshake, and `exec` opens a channel per check. The
 * server's own `MaxSessions` bounds how many at once (OpenSSH defaults to 10), which is why the
 * pool exists rather than one connection being enough.
 *
 * **Abort closes the channel, never the connection.** The connection belongs to every sensor on
 * the device; tearing it down because *this* check ran out of time would fail the others in
 * flight on it — the same rule the SNMP session follows for the same reason.
 */

/**
 * Where a connection or a command failed. `resolve` is the device's name having no address the
 * connection would use (`A-85`): one of its family, where it names one, or none at all.
 */
export type SshPhase = 'resolve' | 'connect' | 'authenticate' | 'host-key' | 'exec';

export interface SshTarget {
  readonly host: string;
  readonly port?: number;
  /**
   * The device's IP version (`CheckTarget.ipVersion`, `A-85`). A name is connected to over this
   * family only, on a socket of this session's own making, whether or not the target policy
   * checked it: `checked` then holds only addresses of it, and under `none` the socket resolves
   * the name for it alone. In the pool's key. Absent, or `auto`, as it always connected.
   */
  readonly ipVersion?: 'auto' | 'v4' | 'v6';
  /**
   * The address to connect to in place of resolving `host` (`A-41c`): the one checked against
   * the credential set's targets. The server is still identified by its host key, and `host`
   * stays the name every message uses.
   */
  readonly pinned?: PinnedAddress;
  /**
   * The addresses `host` resolved to, each checked against the probe's target policy (`A-57`),
   * when no credential set pinned one. The connection is made to one of them, through a socket
   * whose `lookup` answers with these and nothing else, so the name is never resolved again.
   */
  readonly checked?: readonly PinnedAddress[];
  /**
   * Asked by the pool when, and only when, it has to open a connection: the probe's target
   * policy over `host` (`A-57`). It refuses by throwing, and answers with the checked addresses
   * to connect to, or nothing when the connection is made as it always was (an address, a
   * pinned target, the `none` policy). Not asked for a connection the pool already holds.
   *
   * It is handed the signal the open runs under (`A-69`), which is the pool's: aborted when
   * every check waiting for this connection has been cancelled, and not when one has.
   */
  readonly guard?: (signal?: AbortSignal) => Promise<readonly PinnedAddress[] | undefined>;
  /**
   * The device's exception to the target policy that `guard` was built with (`A-64`). Read only
   * for the pool's key: a connection opened under an exception is not handed to a check once the
   * exception is withdrawn or changed, since the pool does not ask `guard` about one it holds.
   */
  readonly exception?: readonly string[];
}

export interface SshSessionOptions {
  /** The whole handshake: TCP, key exchange and authentication. */
  readonly connectTimeoutMs?: number;
  /** One command. Separate, because a slow login and a slow script are different faults. */
  readonly commandTimeoutMs?: number;
  /**
   * The most output one command may produce before it is failed.
   *
   * A bound rather than a nicety: `exec` streams into memory, a check runs in a worker shared by
   * hundreds of sensors, and `cat /var/log/syslog` by mistake is a probe that stops. Failing is
   * right where truncating is not — a script whose output was cut in half parses into a number
   * that is wrong rather than absent, and `T-08` will parse these.
   */
  readonly maxOutputBytes?: number;
}

/** What a handshake is given when nobody says. The pool reads it too (`A-65`). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

const DEFAULTS = {
  connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
  commandTimeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
} as const;

export interface SshExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Null when the command was killed by a signal rather than exiting, or when a server that
   * sends no exit status closed the channel. Never because the connection went: that is an
   * `SshError` (`P-259`).
   */
  readonly code: number | null;
  readonly signal: string | null;
}

/**
 * A failure with enough in it to diagnose without the host in front of you.
 *
 * CLAUDE.md: "ETIMEDOUT" alone is not a diagnosis. Which host, which phase and which command
 * separate "the password is wrong" from "the script does not exist" from "the box is gone" —
 * and none of these ever carries the credential.
 */
export class SshError extends Error {
  readonly host: string;
  readonly phase: SshPhase;
  readonly command: string | undefined;

  constructor(
    message: string,
    context: { host: string; phase: SshPhase; command?: string; cause?: unknown },
  ) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = 'SshError';
    this.host = context.host;
    this.phase = context.phase;
    this.command = context.command;
  }
}

export class SshSession {
  readonly #client: Client;
  readonly #host: string;
  readonly #options: Required<SshSessionOptions>;
  readonly #verdict: HostKeyVerdict;
  #closed = false;
  /** What the connection reported as it went, for a command it took with it (`P-259`). */
  #lost: Error | undefined;
  /**
   * The commands running now, each told the moment the connection goes (`P-259`), so it can
   * note whether the server had already finished its channel. Only that moment can tell:
   * once `ssh2` has torn the channels down, every one looks closed.
   */
  readonly #running = new Set<() => void>();

  private constructor(
    client: Client,
    host: string,
    options: Required<SshSessionOptions>,
    verdict: HostKeyVerdict,
  ) {
    this.#client = client;
    this.#host = host;
    this.#options = options;
    this.#verdict = verdict;
    // A client that emits 'error' with nothing listening throws on the next tick and takes the
    // worker down — one unreachable host would kill checks for hundreds of others.
    client.on('error', (error: Error) => {
      this.#lost ??= error;
      this.#gone();
    });
    client.on('close', () => {
      this.#gone();
    });
    client.on('end', () => {
      this.#gone();
    });
  }

  /**
   * The connection has gone, by whichever event said so first. Synchronous with that event,
   * which `ssh2` emits after parsing everything the server sent before it and before it tears
   * the channels down (`P-259`).
   */
  #gone(): void {
    this.#closed = true;
    for (const told of [...this.#running]) told();
    this.#running.clear();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** What the host key check concluded, for the sensor message. Never null on a live session. */
  get hostKey(): HostKeyVerdict {
    return this.#verdict;
  }

  /**
   * Opens a connection: TCP, key exchange and authentication.
   *
   * **`signal` ends it** (`A-69`). Aborted during the handshake, the socket is destroyed and the
   * open rejects at once, where it used to run to `connectTimeoutMs`: a cancelled check held a
   * socket to a host that was not answering for as long as fifteen seconds. Once the session is
   * open the signal means nothing to it: a connection is shared, and `exec` takes a signal of
   * its own that closes one channel. The pool passes a signal of its own here and not a check's,
   * so one check being cancelled does not end a handshake another is waiting for.
   */
  static open(
    target: SshTarget,
    credentials: SshCredentials,
    options: SshSessionOptions = {},
    signal?: AbortSignal,
  ): Promise<SshSession> {
    const host = target.host.trim();
    if (host === '') {
      return Promise.reject(
        new SshError('the device has no host to connect to', { host: '', phase: 'connect' }),
      );
    }
    if (signal?.aborted === true) return Promise.reject(connectCancelled(host));

    const resolved: Required<SshSessionOptions> = {
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      commandTimeoutMs: options.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
    };

    const port = target.port ?? 22;
    // The family a name is connected over (`A-85`), and the words a name that has no address of
    // it fails in: the guard's, whether or not the guard asked.
    const family = familyOf(target.ipVersion ?? 'auto');

    return new Promise<SshSession>((resolve, reject) => {
      const client = new ssh2.Client();
      let settled = false;
      // Set by the host-key callback, which runs during the handshake and before 'ready'.
      let verdict: HostKeyVerdict = { kind: 'unchecked', presented: '' };

      /** Ends the handshake where it stands: the socket is destroyed, not asked to leave. */
      const abandon = (): void => {
        if (settled) return;
        settled = true;
        try {
          client.destroy();
        } catch {
          // Already gone, which is the state wanted.
        }
        // A socket of this session's own making, which `ssh2` may not have taken yet.
        sock?.destroy();
        reject(connectCancelled(host));
      };

      const fail = (error: SshError): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abandon);
        try {
          client.end();
        } catch {
          // Already gone. Nothing to do, and nothing worth reporting over the real failure.
        }
        reject(error);
      };

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abandon);
        resolve(new SshSession(client, host, resolved, verdict));
      });

      client.on('error', (error: Error & { level?: string; code?: unknown }) => {
        // ssh2 reports an authentication failure as an ordinary error with a level, so the
        // phase — and therefore the message an operator reads — comes from that.
        const authentication = error.level === 'client-authentication';
        // A name whose every address failed is read by the one that got furthest, and names
        // each (`connectFailure`): the error Node ends the socket with says nothing at all.
        const failure = connectFailure(error);
        // A name the socket's lookup found no address for (`A-85`), where nothing checked it: under
        // `none`, of the device's family alone. Said as the guard says it, in its phase.
        const unresolved = authentication
          ? undefined
          : socketUnresolved(
              failure.code,
              family,
              `connecting to ${host}:${String(port)} over SSH`,
            );
        if (unresolved !== undefined) {
          fail(new SshError(unresolved, { host, phase: 'resolve', cause: error }));
          return;
        }
        fail(
          new SshError(
            authentication
              ? `${host} refused the credentials for ${describeCredentials(credentials)} — the ` +
                  'user name, the password or the key is wrong, or the server does not allow this ' +
                  'method for that user'
              : `could not connect to ${host}: ${failure.message}${failure.tried}`,
            {
              host,
              phase: authentication ? 'authenticate' : 'connect',
              cause: error,
            },
          ),
        );
      });

      // **A socket of this session's own making, for the addresses the target policy checked**
      // (`A-57`). `ssh2` takes no `lookup`, and connecting by name would resolve it a second
      // time. The socket is still told the name, so Node walks the checked addresses as it
      // would have walked the name's, and a first address that is dead is passed.
      // **And for a name nothing checked, where the device names a family** (`A-85`): under
      // `none`, `ssh2` connecting by name would take whichever family the name answers first.
      // Its `forceIPv4`/`forceIPv6` would have it make a lookup of its own, a second way of
      // connecting beside the checked one; a socket of ours is the one way, checked or not.
      // It is given `familyLookup`, never the family itself: a socket told the family asks for
      // one address and connects to that alone, where one given a lookup asks for all of that
      // family and walks them, passing a first that is dead.
      const sock =
        target.pinned !== undefined
          ? undefined
          : target.checked !== undefined
            ? ownSocket(host, port, checkedLookup(host, target.checked))
            : family !== 0 && isIP(host) === 0
              ? ownSocket(host, port, familyLookup(family))
              : undefined;

      const config = {
        // **The checked address, never the name, when there is one** (`A-41c`): `ssh2` resolves a
        // name when it connects, and that second answer is the one nobody checked.
        host: target.pinned?.address ?? host,
        port,
        username: credentials.username,
        ...(sock === undefined ? {} : { sock }),
        readyTimeout: resolved.connectTimeoutMs,
        // Every key exchange and cipher ssh2 offers by default. Narrowing them is a policy
        // decision an operator should make about their estate, not one a monitoring tool should
        // make for them by failing to connect to older hardware.
        ...(credentials.method === 'key'
          ? {
              privateKey: credentials.privateKey,
              ...(credentials.passphrase === undefined
                ? {}
                : { passphrase: credentials.passphrase }),
            }
          : { password: credentials.password }),
        /**
         * Runs during the handshake, before authentication — which is the point. Returning
         * false here means the credentials are never sent, so a host that failed its key check
         * does not receive the password anyway.
         */
        hostVerifier: (key: Buffer): boolean => {
          verdict = verifyHostKey(credentials.hostKeyPolicy, credentials.hostKeys, key);
          if (verdict.kind === 'trusted' || verdict.kind === 'unchecked') return true;
          fail(
            new SshError(describeVerdict(host, verdict) ?? 'the host key was rejected', {
              host,
              phase: 'host-key',
            }),
          );
          return false;
        },
      };

      signal?.addEventListener('abort', abandon, { once: true });
      try {
        client.connect(config);
      } catch (error) {
        // `ssh2` never took the socket, so nothing else will close it.
        sock?.destroy();
        fail(
          new SshError(`could not connect to ${host}: ${describe(error)}`, {
            host,
            phase: 'connect',
            cause: error,
          }),
        );
      }
    });
  }

  /**
   * Runs one command and collects what it wrote.
   *
   * A non-zero exit is **not** an error here: `df` returning 1 and a script reporting a problem
   * are results a sensor type has to interpret, and turning them into throws would make every
   * caller catch to get at the exit code. What *is* an error is not being able to run it at all.
   */
  async exec(command: string, signal: AbortSignal): Promise<SshExecResult> {
    if (this.#closed) {
      throw new SshError(`the SSH connection to ${this.#host} is closed`, {
        host: this.#host,
        phase: 'exec',
        command,
      });
    }
    if (signal.aborted) {
      throw new SshError(`the check was cancelled before running a command on ${this.#host}`, {
        host: this.#host,
        phase: 'exec',
        command,
      });
    }

    return new Promise<SshExecResult>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      // A holder rather than a bare `let`: the timeout's callback needs `finish` and `stop`,
      // and `finish` needs to clear the timeout, so one of the three has to be reached
      // indirectly.
      const pending: { timer?: NodeJS.Timeout } = {};
      let channel: ClientChannel | undefined;
      /** Whether an exit status or signal had arrived, from the channel's `exit` event. */
      let exited = false;
      /**
       * Whether the server had finished this channel when the connection went (`P-259`). Read
       * then, and only then: once `ssh2` has torn the channels down, every one looks closed.
       *
       * **Finished is a CLOSE, or an EOF with the exit status already in.** The exit status
       * alone is no answer: a server may send it before the last of the output (RFC 4254 does
       * not order them, and OpenSSH sends it as soon as the command is reaped). EOF alone is no
       * answer either: the status may follow it — Dropbear sends data, EOF, exit status, CLOSE —
       * and a command whose status was lost would reach a sensor as `code: null`, which
       * `ssh.script` reads as the script's failure. A CLOSE with no status is a server that
       * sends none, and its answer is whole.
       */
      let finishedByServer = false;
      const onGone = (): void => {
        const state = channel?.incoming.state;
        finishedByServer = state === 'closed' || (state === 'eof' && exited);
      };
      this.#running.add(onGone);

      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        signal.removeEventListener('abort', onAbort);
        this.#running.delete(onGone);
        outcome();
      };

      /** Ends the channel, never the connection: it is shared with every other sensor here. */
      const stop = (): void => {
        try {
          channel?.close();
        } catch {
          // The channel is already gone, which is the state we wanted.
        }
      };

      const onAbort = (): void => {
        stop();
        finish(() => {
          reject(
            new SshError(`the check was cancelled while running a command on ${this.#host}`, {
              host: this.#host,
              phase: 'exec',
              command,
            }),
          );
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });

      pending.timer = setTimeout(() => {
        stop();
        finish(() => {
          reject(
            new SshError(
              `${command} did not finish on ${this.#host} within ` +
                `${String(this.#options.commandTimeoutMs)} ms`,
              { host: this.#host, phase: 'exec', command },
            ),
          );
        });
      }, this.#options.commandTimeoutMs);
      pending.timer.unref();

      this.#client.exec(command, (error, stream) => {
        if (error !== null && error !== undefined) {
          finish(() => {
            reject(
              new SshError(`could not run ${command} on ${this.#host}: ${error.message}`, {
                host: this.#host,
                phase: 'exec',
                command,
                cause: error,
              }),
            );
          });
          return;
        }
        channel = stream;
        stream.on('exit', () => {
          exited = true;
        });

        const take = (chunk: Buffer, onto: 'out' | 'err'): void => {
          bytes += chunk.length;
          if (bytes > this.#options.maxOutputBytes) {
            stop();
            finish(() => {
              reject(
                new SshError(
                  `${command} produced more than ${String(this.#options.maxOutputBytes)} bytes ` +
                    `on ${this.#host} and was stopped — a truncated answer parses into a number ` +
                    'that is wrong rather than absent, so this fails instead',
                  { host: this.#host, phase: 'exec', command },
                ),
              );
            });
            return;
          }
          if (onto === 'out') stdout += chunk.toString('utf8');
          else stderr += chunk.toString('utf8');
        };

        stream.on('data', (chunk: Buffer) => {
          take(chunk, 'out');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          take(chunk, 'err');
        });
        stream.on('close', (code?: number | null, sig?: string | null) => {
          // **A channel the connection took with it is a failure, not a result** (`P-259`).
          // `ssh2` closes every channel when the socket goes, with whatever exit status had
          // arrived, so a command running when the device reset the connection used to resolve
          // here — as `code: null` and an empty answer, or as `code: 0` and half of one. What
          // decides is whether the server finished the channel before the connection went,
          // whatever the code says: a channel it finished is a whole answer, and a connection
          // closed straight after one, or a server that sends no exit status, does not change
          // that.
          if (this.#closed && !finishedByServer) {
            // Which of the two had not arrived, said as it was: a status can come first.
            const when = exited
              ? 'after the command reported an exit status but before the server finished ' +
                'its output'
              : 'before the command reported an exit status';
            finish(() => {
              reject(
                new SshError(
                  `the connection to ${this.#host} was lost while running ${command}, ${when} ` +
                    '— what it wrote may be incomplete, so nothing of it is used: ' +
                    (this.#lost?.message ?? 'the server closed the connection'),
                  { host: this.#host, phase: 'exec', command, cause: this.#lost },
                ),
              );
            });
            return;
          }
          finish(() => {
            resolve({
              stdout,
              stderr,
              code: typeof code === 'number' ? code : null,
              signal: typeof sig === 'string' ? sig : null,
            });
          });
        });
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    // So that a command still running on it is not reported as the server's doing.
    this.#lost = new Error('this probe closed the connection');
    this.#gone();
    try {
      this.#client.end();
    } catch {
      // Closing twice, or closing a connection that already died, is not worth a failed check.
    }
  }
}

/** What a caller is told when its check was cancelled before the connection was open. */
export function connectCancelled(host: string): SshError {
  return new SshError(`the check was cancelled while connecting to ${host}`, {
    host,
    phase: 'connect',
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A socket connecting to `host` through `lookup`: the addresses the target policy checked
 * (`A-57`), or, where nothing checked the name, the system's of the device's family alone
 * (`A-85`). Made on the tick `ssh2` is handed it, so every event of it is `ssh2`'s to hear.
 *
 * **A lookup, and never a family.** A socket told a family asks its lookup for one address,
 * where without one it asks for all and walks them, passing a first address that is dead.
 */
function ownSocket(host: string, port: number, lookup: LookupFunction): Socket {
  const socket = netConnect({ host, port, lookup });
  // What `ssh2` does to a socket it makes itself, and not to one it is handed.
  socket.setMaxListeners(0);
  return socket;
}
