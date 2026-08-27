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

  /* ---------------------------------------------------------------------------------------
   * The server half, used only by the test harness — `T-07`'s tests need a real SSH server
   * that can refuse a password, present a chosen host key and hang on a command.
   * ------------------------------------------------------------------------------------- */

  export interface ServerConfig {
    hostKeys: (string | Buffer)[];
    ident?: string;
  }

  export interface AuthContext {
    readonly method: string;
    readonly username: string;
    readonly password?: string;
    readonly key?: { algo: string; data: Buffer };
    accept(): void;
    reject(methods?: string[], partial?: boolean): void;
  }

  export interface ServerChannel extends EventEmitter {
    write(chunk: string | Buffer): boolean;
    stderr: { write(chunk: string | Buffer): boolean };
    exit(code: number | string): void;
    end(): void;
    close(): void;
  }

  export interface Session extends EventEmitter {
    on(
      event: 'exec',
      listener: (
        accept: () => ServerChannel,
        reject: () => void,
        info: { command: string },
      ) => void,
    ): this;
    on(event: string, listener: (...args: never[]) => void): this;
  }

  export interface ServerConnection extends EventEmitter {
    on(event: 'authentication', listener: (context: AuthContext) => void): this;
    on(event: 'ready' | 'close' | 'end', listener: () => void): this;
    on(event: 'session', listener: (accept: () => Session, reject: () => void) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
    end(): void;
  }

  export class Server extends EventEmitter {
    constructor(config: ServerConfig, connectionListener?: (connection: ServerConnection) => void);
    listen(port: number, host: string, callback?: () => void): this;
    address(): { port: number; address: string } | null;
    close(callback?: (error?: Error) => void): this;
    on(event: 'connection', listener: (connection: ServerConnection) => void): this;
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
    Server: typeof Server;
    utils: typeof utils;
  };
  export default ssh2;
}
