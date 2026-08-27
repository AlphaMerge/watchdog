/**
 * The part of `net-snmp` we use, declared by us.
 *
 * **Hand-written rather than `@types/net-snmp`**, which is at 3.23 against the 3.26.3 ADR-001
 * names — a types package three minors behind describes a library we are not running, and the
 * gap is silent. This file is also the inventory the ADR's "single maintainer" risk needs: it is
 * the complete list of what we depend on, so the cost of replacing the library is bounded by
 * what is written here rather than by a search through the repository.
 *
 * Only `session.ts` may import it. Nothing else in `packages/` mentions `net-snmp`.
 */
declare module 'net-snmp' {
  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;

  /** Name → numeric id, and the reverse. We only ever index by name. */
  export const AuthProtocols: Readonly<Record<string, number>>;
  export const PrivProtocols: Readonly<Record<string, number>>;
  export const SecurityLevel: Readonly<Record<string, number>>;
  export const ObjectType: Readonly<Record<string, number>>;
  export const ErrorStatus: Readonly<Record<string, number>>;

  export interface Varbind {
    oid: string;
    type: number;
    /** A counter or gauge is a number; an octet string is a Buffer; a counter64 may be either. */
    value: number | string | bigint | Buffer | null;
  }

  export interface SessionOptions {
    port?: number;
    version?: number;
    timeout?: number;
    retries?: number;
    transport?: 'udp4' | 'udp6';
    idBitsSize?: number;
    backwardsGetNexts?: boolean;
    context?: string;
    /**
     * Where `trap` and `inform` send. **Not** `port`, which is where requests go — the two are
     * separate on purpose, since a manager polls 161 and sends notifications to 162.
     */
    trapPort?: number;
  }

  export interface V3User {
    name: string;
    level: number;
    authProtocol?: number;
    authKey?: string;
    privProtocol?: number;
    privKey?: string;
  }

  export interface Session {
    get(oids: string[], callback: (error: Error | null, varbinds: Varbind[]) => void): void;
    getNext(oids: string[], callback: (error: Error | null, varbinds: Varbind[]) => void): void;
    getBulk(
      oids: string[],
      nonRepeaters: number,
      maxRepetitions: number,
      callback: (error: Error | null, varbinds: Varbind[][]) => void,
    ): void;
    /**
     * Walks a subtree, calling `feed` per batch. `feed` returning true asks it to stop, which is
     * how a bounded walk stops an agent with a very large table from filling the probe's heap.
     */
    subtree(
      oid: string,
      maxRepetitions: number,
      feed: (varbinds: Varbind[]) => boolean | undefined,
      done: (error?: Error | null) => void,
    ): void;
    close(): void;
    on(event: 'error' | 'close', listener: (error?: Error) => void): void;
    /**
     * Sends a notification. Declared for the receiver's own tests (`T-06`), which need a real
     * sender on the other end of a real socket; nothing shipped sends traps.
     *
     * `typeOrOid` is a generic trap number for v1 and a trap OID for v2c.
     */
    trap(
      typeOrOid: number | string,
      varbindsOrCallback: Varbind[] | ((error: Error | null) => void),
      callback?: (error: Error | null) => void,
    ): void;
    /** As `trap`, but the receiver acknowledges it and the callback reports whether it did. */
    inform(
      typeOrOid: number | string,
      varbindsOrCallback: Varbind[] | ((error: Error | null) => void),
      callback?: (error: Error | null) => void,
    ): void;
  }

  export function createSession(
    target: string,
    community: string,
    options?: SessionOptions,
  ): Session;

  export function createV3Session(target: string, user: V3User, options?: SessionOptions): Session;

  /** True when the varbind's *type* is an exception — noSuchObject and friends, not an error. */
  export function isVarbindError(varbind: Varbind): boolean;
  /** The sentence for one of those exception varbinds. */
  export function varbindError(varbind: Varbind): string;

  /*
   * The agent, used by tests only.
   *
   * `T-01`'s own agent (`test/support/snmp-agent.ts`) is a hand-written v1/v2c responder that can
   * misbehave on purpose, which is what most of these tests need. It stops at v3: USM is engine
   * discovery, key localisation and a cipher, and a wrong reimplementation of it would prove
   * nothing. So the v3 tests talk to this one, where a real USM conversation is the point.
   */
  export interface AgentOptions {
    port?: number;
    address?: string | null;
    disableAuthorization?: boolean;
    engineID?: string | Buffer;
    accessControlModelType?: number;
  }

  export interface Authorizer {
    addUser(user: V3User): void;
    addCommunity(community: string): void;
  }

  export interface Mib {
    setScalarValue(name: string, value: unknown): void;
    registerProvider(provider: unknown): void;
  }

  export interface Agent {
    getAuthorizer(): Authorizer;
    getMib(): Mib;
    close(callback?: () => void): void;
  }

  export const AccessControlModelType: Readonly<Record<string, number>>;

  export function createAgent(
    options: AgentOptions,
    callback: (error: Error | null, data?: unknown) => void,
    mib?: Mib,
  ): Agent;

  /** Notification PDU types. Trap is v1, TrapV2 and InformRequest are v2c/v3. */
  export const PduType: Readonly<Record<string, number>> & {
    Trap: number;
    TrapV2: number;
    InformRequest: number;
  };

  export interface ReceiverOptions {
    port: number;
    address?: string;
    transport?: 'udp4' | 'udp6';
    disableAuthorization?: boolean;
    includeAuthentication?: boolean;
    engineID?: string;
  }

  export interface NotificationPdu {
    type: number;
    varbinds?: { oid: string; type: number; value: unknown }[];
    enterprise?: string;
    agentAddr?: string;
    generic?: number;
    specific?: number;
    community?: string;
    user?: string;
  }

  export interface Notification {
    pdu: NotificationPdu;
    rinfo: { address: string; port: number };
  }

  export interface Receiver {
    getAuthorizer(): Authorizer;
    close(callback?: () => void): void;
  }

  /**
   * Traps and informs. The receiver acknowledges an inform itself, before the callback runs —
   * which is the whole difference between the two, since an unacknowledged inform is retried.
   */
  export function createReceiver(
    options: ReceiverOptions,
    callback: (error: Error | null, notification?: Notification) => void,
  ): Receiver;
}
