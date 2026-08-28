import ssh2 from 'ssh2';
import type { Server, ServerChannel } from 'ssh2';

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

export class TestSshServer {
  readonly #server: Server;
  #port = 0;
  #behaviour: SshServerBehaviour = { password: 'monitor' };
  readonly #commands = new Map<string, CommandResult>();
  #fallback: CommandResult = { stderr: 'command not found\n', code: 127 };
  /** Every command the server was asked to run, in order. */
  readonly seen: string[] = [];
  /** Connections accepted. What proves the pool reused one rather than opening another. */
  connections = 0;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(hostKey?: string): Promise<TestSshServer> {
    const key = hostKey ?? ssh2.utils.generateKeyPairSync('ed25519').private;
    const server = new ssh2.Server({ hostKeys: [key] });
    const instance = new TestSshServer(server);

    server.on('connection', (connection) => {
      instance.connections += 1;

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
    this.#fallback = { stderr: 'command not found\n', code: 127 };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
      // A server with a client still attached does not always call back; the test process
      // should not hang on shutdown for it.
      setTimeout(resolve, 500).unref();
    });
  }
}

/** A throwaway key pair, for the key-authentication tests. */
export function keyPair(): { private: string; public: string } {
  return ssh2.utils.generateKeyPairSync('ed25519');
}
