/**
 * The `ssh2` surface this codebase uses, declared by hand (`T-07`).
 *
 * `ssh2` ships no types of its own and `@types/ssh2` is a large third-party surface for a
 * library we touch in one file. Declaring what `session.ts` actually calls is about a hundred
 * lines, it is checked by the compiler against real usage, and it is the other half of ADR-001
 * Decision 6's bargain: replacing the dependency is a change to one file plus this one, rather
 * than an archaeology exercise.
 *
 * The same reasoning, and the same shape, as `net-snmp.d.ts`.
 *
 * **The client half only.** The server half moved to `@ms/simulators` with the SSH simulator that
 * is its one caller (`P-06`) — a declaration for a surface this package never touches is exactly
 * the kind of thing that rots without anybody noticing, because nothing compiles against it.
 */
declare module 'ssh2' {
  import type { EventEmitter } from 'node:events';
  import type { Readable } from 'node:stream';

  export interface ConnectConfig {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    /** The whole handshake, in milliseconds — not one command. */
    readyTimeout?: number;
    /**
     * Called with the server's public key during key exchange, **before** authentication.
     * Returning false aborts, so a host that fails its key check never receives the password.
     */
    hostVerifier?: (key: Buffer) => boolean;
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    algorithms?: Record<string, unknown>;
  }

  /** One `exec` channel. `stderr` is a separate stream, as it is on the wire. */
  export interface ClientChannel extends Readable {
    readonly stderr: Readable;
    close(): void;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'close', listener: (code?: number | null, signal?: string | null) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): this;
    exec(
      command: string,
      callback: (error: Error | null | undefined, channel: ClientChannel) => void,
    ): boolean;
    end(): this;
    on(event: 'ready' | 'close' | 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error & { level?: string }) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
  }

  export const utils: {
    generateKeyPairSync(
      type: string,
      options?: { bits?: number },
    ): { private: string; public: string };
  };

  /**
   * `ssh2` is CommonJS with `module.exports = { Client, Server, utils, … }`, so the runtime
   * import is the default one. Declared here so `import ssh2 from 'ssh2'` type-checks against
   * the same surface the named exports above describe.
   */
  const ssh2: {
    Client: typeof Client;
    utils: typeof utils;
  };
  export default ssh2;
}
