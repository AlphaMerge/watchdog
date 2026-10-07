/**
 * The server half of `ssh2`, declared by hand (`P-06`, moved from `T-07`).
 *
 * `ssh2` ships no types and `@types/ssh2` is a large third-party surface for a library this
 * package touches in one file. The same bargain `@ms/sensors` makes for the *client* half:
 * declaring what the simulator actually calls is fifty lines, the compiler checks them against
 * real usage, and replacing the dependency is a change to two files rather than an archaeology
 * exercise.
 *
 * Split from the client declaration rather than shared, because sharing would mean the harness
 * depending on the package it exists to test — which is the closed loop `snmp-agent.ts` explains
 * at length and refuses.
 */
declare module 'ssh2' {
  import type { EventEmitter } from 'node:events';
  import type { Socket } from 'node:net';

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
    /**
     * The socket's errors, re-emitted with `level: 'socket'` and a string `code` and `syscall`,
     * and the protocol's own. A DISCONNECT the client sends for any reason but "by application"
     * arrives with the numeric SSH reason as its `code` (2 protocol error, 3 key exchange
     * failed, …), so `code` is either.
     */
    on(
      event: 'error',
      listener: (
        error: Error & {
          readonly code?: string | number;
          readonly syscall?: string;
          readonly level?: string;
        },
      ) => void,
    ): this;
    on(event: 'session', listener: (accept: () => Session, reject: () => void) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
    end(): void;
  }

  export class Server extends EventEmitter {
    constructor(config: ServerConfig, connectionListener?: (connection: ServerConnection) => void);
    listen(port: number, host: string, callback?: () => void): this;
    address(): { port: number; address: string } | null;
    close(callback?: (error?: Error) => void): this;
    /**
     * `info` names the client's end of the socket, which is how the simulator finds the socket a
     * connection runs on (`P-259`): `ssh2` hands a connection's handler nothing else of it.
     */
    on(
      event: 'connection',
      listener: (
        connection: ServerConnection,
        info: { readonly ip?: string; readonly port?: number },
      ) => void,
    ): this;
    on(event: string, listener: (...args: never[]) => void): this;
    /** Serves a socket accepted elsewhere as though this server's own listener had accepted it. */
    injectSocket(socket: Socket): void;
  }

  export const utils: {
    generateKeyPairSync(
      type: string,
      options?: { bits?: number },
    ): { private: string; public: string };
    /**
     * Declared only so `keyPair()` can sift `generateKeyPairSync`'s output — `ssh2` returns the
     * parse failure rather than throwing it, so the union is the point, and the parsed key
     * itself is never read here.
     */
    parseKey(data: string | Buffer): { type: string } | Error;
  };

  /**
   * `ssh2` is CommonJS with `module.exports = { Client, Server, utils, … }`, so the runtime
   * import is the default one.
   */
  const ssh2: {
    Server: typeof Server;
    utils: typeof utils;
  };
  export default ssh2;
}
