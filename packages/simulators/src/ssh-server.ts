import { createServer, type Server as TcpServer, type Socket } from 'node:net';
import ssh2 from 'ssh2';
import type { Server, ServerChannel, ServerConnection } from 'ssh2';

/**
 * A real SSH server, on a real socket, that misbehaves on request.
 *
 * **Built on `ssh2.Server` rather than hand-written, and the reasoning differs from the SNMP
 * harness on purpose.** `test/support/snmp-agent.ts` is written by hand because the interesting
 * cases there are things a *well-behaved agent will not do* — walking backwards, never
 * answering, returning a subtree with no end — and pointing our session layer at `net-snmp`'s
 * own agent would have tested the library against itself in a closed loop.
 *
 * SSH is the other way round. The cases worth testing are all things a correct server does:
 * refusing a password, presenting a host key that is not the expected one, taking too long,
 * exiting non-zero, writing to stderr. A hand-written server would have to implement key
 * exchange and the transport layer faithfully in order to be wrong about any of them, and a
 * wrong reimplementation would prove nothing about our side. So the protocol is real and only
 * the *behaviour* is scripted.
 */

export interface SshServerBehaviour {
  /** Accept this password. Anything else is refused, as a real server refuses it. */
  readonly password?: string;
  /** Accept any public key offered. For the key-authentication path. */
  readonly acceptAnyKey?: boolean;
  /** Refuse every authentication attempt, whatever it is. */
  readonly refuseAuth?: boolean;
  /** Never answer an `exec`, so the command timeout is what ends it. */
  readonly hang?: boolean;
  /** Refuse to open a session channel at all. */
  readonly refuseSession?: boolean;
}

export interface CommandResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  /** Bytes of `x` to write instead of `stdout`, for the output-bound test. */
  readonly bulkBytes?: number;
}

/**
 * The host key every simulated server presents, unless a test hands `start()` another one.
 *
 * **A fixture, not a secret.** It is checked into the repository in plain text, it protects
 * nothing, and no real host has ever presented it — it has exactly the standing of the password
 * `'monitor'` a few lines below. Nothing outside this file should ever see it.
 *
 * It is a constant because `ssh2.utils.generateKeyPairSync('ed25519')` is not reliable. Roughly
 * one key in 256 comes back with a 31-byte public key inside the OpenSSH blob — a leading zero
 * byte trimmed where the format wants it kept — and `new ssh2.Server` then throws
 * `Cannot parse privateKey: Malformed OpenSSH private key`. Generating one per `start()` made
 * that a 1-in-256 throw *per server started*, which a whole-workspace run loses often enough to
 * redden every SSH suite for a reason that has nothing to do with SSH. Measured at 10 bad keys
 * in 3,000: `docs/findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md`.
 */
const SIMULATOR_HOST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACBofyri6ZKOGNkNqE/h3uJbL42tQUzwC6taWDnnylbQbQAA
AIhdCfPoXQnz6AAAAAtzc2gtZWQyNTUxOQAAACBofyri6ZKOGNkNqE/h3uJbL42t
QUzwC6taWDnnylbQbQAAAEAsKSM2JV6B10rca+MOmWSiJARTGMh5PfGrIeBvBja0
kmh/KuLpko4Y2Q2oT+He4lsvja1BTPALq1pYOefKVtBtAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`;

export class TestSshServer {
  readonly #server: Server;
  /**
   * Live connections, so `stop()` can end them rather than give up on them (`P-70`).
   *
   * `P-63` swept the HTTP and mail simulators for teardowns that wait on connections they never
   * close, saw the 500 ms escape hatch here, and left it — reading "does not hang" as "fixed".
   * It is not: the timer made `stop()` *resolve* while the server was still listening and its
   * sockets still open, so a suite moved on believing a fixture was gone.
   */
  readonly #connections = new Set<ServerConnection>();
  #port = 0;
  #behaviour: SshServerBehaviour = { password: 'monitor' };
  readonly #commands = new Map<string, CommandResult>();
  #fallback: CommandResult = { stderr: 'command not found\n', code: 127 };
  /** Every command the server was asked to run, in order. */
  readonly seen: string[] = [];
  /** Connections accepted. What proves the pool reused one rather than opening another. */
  connections = 0;
  /**
   * What the connections reported going wrong, in order (`P-257`). A client that vanishes is
   * an ordinary event for a server, and this is where it lands instead of in the test process.
   */
  readonly connectionErrors: { readonly code: string | undefined; readonly message: string }[] = [];

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(hostKey?: string): Promise<TestSshServer> {
    const key = hostKey ?? SIMULATOR_HOST_KEY;
    const server = new ssh2.Server({ hostKeys: [key] });
    const instance = new TestSshServer(server);

    server.on('connection', (connection) => {
      instance.connections += 1;
      instance.#connections.add(connection);
      connection.on('close', () => {
        instance.#connections.delete(connection);
      });
      // **Heard, because nothing else would hear it** (`P-257`). `ssh2` re-emits every error on
      // the socket as an 'error' on the connection, and an 'error' nobody listens for is thrown
      // — here, in the test process, where `node:test` fails whichever test or hook started the
      // write. `stop()` ending a connection writes a DISCONNECT, and a client that has already
      // gone — a probe worker terminated with its session open, as `ssh-shared-open` does — sent
      // a reset that makes that write fail with ECONNRESET or EPIPE. The same path carries a
      // reset that arrives mid-command, and the keepalive timeout `ssh2` raises on a client that
      // stops answering. Recorded, so a test can still see it.
      connection.on('error', (error) => {
        instance.connectionErrors.push({ code: error.code, message: error.message });
      });

      connection.on('authentication', (context) => {
        const behaviour = instance.#behaviour;
        if (behaviour.refuseAuth === true) {
          context.reject();
          return;
        }
        if (context.method === 'publickey') {
          if (behaviour.acceptAnyKey === true) context.accept();
          else context.reject();
          return;
        }
        if (context.method === 'password') {
          if (behaviour.password !== undefined && context.password === behaviour.password) {
            context.accept();
          } else {
            context.reject();
          }
          return;
        }
        // `none` is the probe asking what is on offer. Refusing it names the methods, which is
        // what makes a client try a password at all.
        context.reject(['password', 'publickey']);
      });

      connection.on('session', (accept, reject) => {
        if (instance.#behaviour.refuseSession === true) {
          reject();
          return;
        }
        const session = accept();
        session.on('exec', (acceptExec, rejectExec, info) => {
          instance.seen.push(info.command);
          if (instance.#behaviour.hang === true) {
            // Accept the channel and then say nothing at all, which is what a script that has
            // wedged looks like from the client's side.
            acceptExec();
            return;
          }
          const result = instance.#commands.get(info.command) ?? instance.#fallback;
          const channel: ServerChannel = acceptExec();
          if (result.bulkBytes !== undefined) {
            // Written in chunks so the client's bound is hit mid-stream, which is where it has
            // to work — a single write would be one `data` event and prove less.
            const chunk = 'x'.repeat(8_192);
            let written = 0;
            while (written < result.bulkBytes) {
              channel.write(chunk);
              written += chunk.length;
            }
          } else if (result.stdout !== undefined) {
            channel.write(result.stdout);
          }
          if (result.stderr !== undefined) channel.stderr.write(result.stderr);
          channel.exit(result.code ?? 0);
          channel.end();
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      // Port 0 so tests never collide; 127.0.0.1 so nothing leaves the machine.
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    instance.#port = server.address()?.port ?? 0;
    return instance;
  }

  get port(): number {
    return this.#port;
  }

  get host(): string {
    return '127.0.0.1';
  }

  behave(behaviour: SshServerBehaviour): void {
    this.#behaviour = behaviour;
  }

  /** What a command should answer with. Anything not listed gets the fallback. */
  answer(command: string, result: CommandResult): void {
    this.#commands.set(command, result);
  }

  reset(): void {
    this.#commands.clear();
    this.#behaviour = { password: 'monitor' };
    this.seen.length = 0;
    this.connections = 0;
    this.connectionErrors.length = 0;
    this.#fallback = { stderr: 'command not found\n', code: 127 };
  }

  async stop(): Promise<void> {
    // Ended first, for the reason `close()` alone was not enough: it waits for every open
    // connection, and a client that is still attached keeps it waiting. Ending them is what makes
    // the callback below actually arrive, rather than being raced by a timer that resolved while
    // the server was still up (`P-70`).
    for (const connection of this.#connections) connection.end();
    this.#connections.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }
}

/**
 * An SSH server that accepts a connection and never speaks (`A-73`).
 *
 * **A mode of the simulator and not of `ssh2.Server`, because `ssh2.Server` cannot be silent**:
 * it writes its identification line the moment a socket arrives, and a client that has read
 * that line is already past the wait this is for. What a handshake that never starts looks
 * like from the client is a TCP connection that was accepted and says nothing — a firewall that
 * completes the handshake for a host that is gone, a service wedged before its banner — and
 * the client's connect timeout, or its caller's cancellation, is the only thing that ends it.
 *
 * `A-65` and `A-69` each stood up a bare listener for this in their own test file. It is here so
 * the next test that needs one does not write a third.
 *
 * What the client sends is read and thrown away, so its own closing is heard: a socket nobody
 * reads holds what it was sent and never reports the end that follows it.
 */
export class MuteSshServer {
  readonly #server: TcpServer;
  readonly #sockets = new Set<Socket>();
  #port = 0;
  /** Connections accepted since `start`. What proves a client did, or did not, connect. */
  connections = 0;

  private constructor(server: TcpServer) {
    this.#server = server;
  }

  static async start(): Promise<MuteSshServer> {
    const server = createServer();
    const instance = new MuteSshServer(server);
    server.on('connection', (socket) => {
      instance.connections += 1;
      instance.#sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        instance.#sockets.delete(socket);
      });
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Port 0 so tests never collide; 127.0.0.1 so nothing leaves the machine.
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const at = server.address();
    instance.#port = typeof at === 'object' && at !== null ? at.port : 0;
    return instance;
  }

  get port(): number {
    return this.#port;
  }

  get host(): string {
    return '127.0.0.1';
  }

  /** Connections open now. */
  get open(): number {
    return this.#sockets.size;
  }

  /**
   * The connection accepted next, and a promise of its closing — from either end. Ask before
   * the client connects: a connection already accepted is not the next one.
   */
  next(): Promise<{ socket: Socket; closed: Promise<void> }> {
    return new Promise((resolve) => {
      this.#server.once('connection', (socket: Socket) => {
        const closed = new Promise<void>((done) => {
          if (socket.destroyed) done();
          else
            socket.once('close', () => {
              done();
            });
        });
        resolve({ socket, closed });
      });
    });
  }

  /** Destroys every connection and stops listening. Resolves once the port is free. */
  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }
}

/**
 * A throwaway key pair, for the key-authentication tests.
 *
 * Sifted rather than trusted, for the reason `SIMULATOR_HOST_KEY` is a constant: about one
 * ed25519 key in 256 comes out of `ssh2` unparseable, and a client key that will not parse fails
 * the test as a refused login — a key-generation bug wearing authentication's name. Fresh per
 * call because these tests want a key nothing else has seen; valid because it is checked here.
 */
export function keyPair(): { private: string; public: string } {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519');
    if (!(ssh2.utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  // Sixteen in a row at 1-in-256 each is not bad luck; it is `ssh2` behaving differently from
  // what this function assumes, and saying so beats handing the caller a key that will not parse.
  throw new Error('ssh2 returned 16 unparseable ed25519 key pairs in a row');
}
