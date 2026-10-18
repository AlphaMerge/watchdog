import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { connect, isIPv6 } from 'node:net';
import { avoidingPorts, bindUdp, closeUdp } from './net.js';
import { Worker } from 'node:worker_threads';
import {
  decodeMessage,
  Deframer,
  DNS_TYPES,
  encodeQuery,
  frame,
  rcodeName,
  typeCode,
  WireError,
  type DnsMessage,
  type DnsRecord,
  type EdnsOption,
} from './dns-wire.js';

/**
 * A recursive DNS server on loopback, run in a worker thread, whose zones answer, are slow, are
 * silent, refuse or answer from a cache, as a test says (`P-432` S5, the design's §7.1).
 *
 * **Why a worker.** The probe's DNS check asks with c-ares on the probe's own event loop and
 * judges a reply by whether it arrived before a deadline. A server on that same loop could only
 * answer when the code under test let it, so "the reply was already in the socket when the main
 * thread came back from a 2 s block" (the channel experiment) would be untestable, and every
 * slow-zone case would measure the test's own scheduling. In a worker the server answers on time
 * whatever the main thread is doing, and `waitForReplies` lets a test block the main thread until
 * the worker has answered, without a race: a reply counts only once its datagram is out.
 *
 * **Deterministic by configuration.** A behaviour is chosen per name or per zone, and everything
 * this simulator decides by time (the recursion cache's TTLs, the forwarder's 10 s hold, the
 * limiter's window) runs on its clock, which a test may make manual and move with `advance`. Only
 * `delayMs`, a slow zone's own delay, and a background client's rate run on real timers; a
 * question that must wait for the test is `held` and answered with `answer`.
 *
 * **What it models**, server by server (several run in one worker, each on its own port):
 * - per name or zone: addresses with a TTL, NXDOMAIN, NODATA, SERVFAIL, REFUSED, NOTIMP, FORMERR,
 *   silence, a delay, a CNAME (into a silent zone too), per-type replies (A answered and AAAA
 *   SERVFAIL), dropping the first N datagrams of a question, dropping or refusing queries that
 *   carry OPT, and TC over UDP with the TCP retry answered, reset or left silent;
 * - a recursion cache with per-name TTLs, `prime` and `flush`, for names answered from cache
 *   while their zone is silent;
 * - dnsmasq's forward table (`forwarder`): a slot held per distinct UDP question until the
 *   upstream answers or `holdMs` passes, identical questions merged per question or only per
 *   client, and a question refused (or left unanswered) and counted when every slot is held; a
 *   TCP question takes no slot, as dnsmasq's `tcp_request` child does not;
 * - Pi-hole's per-client limiter (`limiter`), keyed by source address, refusing everything from
 *   a client past its count until its window ends, with each trip logged;
 * - a dead server: silent, or with nothing bound, so a client gets ECONNREFUSED;
 * - a query log per datagram, the distinct questions held now, and `peakHeld` per port class.
 *
 * **Both loopbacks, one port** (`P-442`'s lesson). Each server binds UDP and TCP on its IPv4
 * loopback (127.0.0.1 unless set) and on ::1 with the same port number, retrying an ephemeral
 * port on a collision, so nothing else can hold that port on the other loopback and answer a
 * client that reaches it by name. A machine with no ::1 is reported (`ipv6` undefined), not
 * failed. A fixed port (53 for glibc) that is taken fails the start, naming it.
 */

/** What one question type is answered with. `delayMs` holds the reply that long (real time). */
export type DnsReply =
  | { readonly kind: 'addresses'; readonly addresses: readonly string[]; readonly delayMs?: number }
  | { readonly kind: 'nxdomain'; readonly delayMs?: number }
  | { readonly kind: 'nodata'; readonly delayMs?: number }
  | {
      readonly kind: 'rcode';
      readonly rcode: 'SERVFAIL' | 'REFUSED' | 'NOTIMP' | 'FORMERR';
      readonly delayMs?: number;
    }
  | { readonly kind: 'cname'; readonly target: string; readonly delayMs?: number }
  | { readonly kind: 'silent' }
  /**
   * Holds the forward slot, as silence does, until the test answers it with `answer`: "held,
   * then answered when the test says", with no real-time delay to race.
   */
  | { readonly kind: 'held' };

/** Shorthands for `DnsReply`. */
export const replies: {
  readonly addresses: (...addresses: string[]) => DnsReply;
  readonly cname: (target: string) => DnsReply;
  readonly nxdomain: DnsReply;
  readonly nodata: DnsReply;
  readonly servfail: DnsReply;
  readonly refused: DnsReply;
  readonly notimp: DnsReply;
  readonly formerr: DnsReply;
  readonly silent: DnsReply;
  readonly held: DnsReply;
} = {
  addresses: (...addresses) => ({ kind: 'addresses', addresses }),
  cname: (target) => ({ kind: 'cname', target }),
  nxdomain: { kind: 'nxdomain' },
  nodata: { kind: 'nodata' },
  servfail: { kind: 'rcode', rcode: 'SERVFAIL' },
  refused: { kind: 'rcode', rcode: 'REFUSED' },
  notimp: { kind: 'rcode', rcode: 'NOTIMP' },
  formerr: { kind: 'rcode', rcode: 'FORMERR' },
  silent: { kind: 'silent' },
  held: { kind: 'held' },
};

export interface DnsBehaviour {
  /**
   * Every type's reply unless `a`, `aaaa` or `other` says otherwise. `addresses` answers A with
   * its IPv4 ones and AAAA with its IPv6 ones (NODATA when there are none) and other types
   * NODATA. Unset, a type is NODATA.
   */
  readonly reply?: DnsReply;
  readonly a?: DnsReply;
  readonly aaaa?: DnsReply;
  readonly other?: DnsReply;
  /** The answers' TTL in seconds, and how long the recursion cache keeps them. Default 300. */
  readonly ttl?: number;
  /** Every reply's delay unless the reply has its own. Real time. */
  readonly delayMs?: number;
  /** A query carrying OPT is answered (default), dropped (an EDNS-deaf path) or refused FORMERR. */
  readonly onOpt?: 'answer' | 'drop' | 'formerr';
  /**
   * The first N datagrams asking this question (name and type) are lost before the server sees
   * them. Counted per server from its start, and from 0 again only when a `set` changes the
   * behaviour covering this name on that server: its own, a zone it is under, or the fallback.
   * A `set` for another name, zone or server leaves the count alone.
   */
  readonly dropFirst?: number;
  /**
   * Over UDP, answer TC with no records; over TCP answer in full (`tcp`), reset the connection
   * (`tcp-reset`) or never answer (`tcp-silent`). ECONNREFUSED is the server's `tcp: 'closed'`.
   */
  readonly truncate?: 'tcp' | 'tcp-reset' | 'tcp-silent';
}

/** Behaviours by exact name, by zone (the apex and every name under it), and otherwise. */
export interface DnsLayer {
  readonly names?: Readonly<Record<string, DnsBehaviour>>;
  readonly zones?: Readonly<Record<string, DnsBehaviour>>;
  /** For a name no entry matches. Default NXDOMAIN. */
  readonly fallback?: DnsBehaviour;
}

/** Which behaviour `set` replaces. Names and zones are matched case-insensitively. */
export type DnsTarget =
  { readonly name: string } | { readonly zone: string } | { readonly fallback: true };

export interface DnsForwarderOptions {
  /** dnsmasq's `dns-forward-max`. Default unlimited, so the gauge still counts. */
  readonly forwardMax?: number;
  /** How long a slot is held for an upstream that does not answer. Default 10,000 ms. */
  readonly holdMs?: number;
  /**
   * `question`: an identical question from any client joins the held one (dnsmasq 2.83 on).
   * `client`: only a client's own retransmission, by (address, port, ID), joins it.
   */
  readonly merge?: 'question' | 'client';
  /**
   * What a new question gets when every slot is held. `refused` (default) is dnsmasq 2.86 and
   * later: "table full - flags == 0, return REFUSED" in forward.c, the question echoed, OPT only
   * if the query had one. `silent` is dnsmasq 2.85 and older (RHEL 8 and 9), which stops reading
   * its listener while the table is full; here the question is never answered, where that
   * dnsmasq reads it late, once a slot frees. Either way it is counted as `dropped`.
   */
  readonly whenFull?: 'refused' | 'silent';
}

/** Pi-hole's `RATE_LIMIT`: `{ queries: 1000, windowMs: 60_000 }` is its believed default. */
export interface DnsLimiterOptions {
  readonly queries: number;
  readonly windowMs: number;
}

export interface DnsServerPolicy {
  readonly forwarder?: DnsForwarderOptions;
  /** A recursion cache. Off unless set, so a row is cold unless it is about caching. */
  readonly cache?: boolean;
  readonly limiter?: DnsLimiterOptions;
  /** `closed` binds no TCP, so a TCP retry gets ECONNREFUSED. Default `listen`. */
  readonly tcp?: 'listen' | 'closed';
}

export type DnsDead = false | 'silent' | 'refused';

export interface DnsServerSpec extends DnsLayer, DnsServerPolicy {
  readonly name: string;
  /**
   * The IPv4 address to bind. Default 127.0.0.1; another loopback for a row that needs one, such
   * as 127.0.0.2 for resolved's `DNS=` or 127.0.0.53 for its stub (Linux has all of 127/8).
   */
  readonly address?: string;
  /** A fixed port: 53 for glibc, which asks no other. Default an ephemeral one. */
  readonly port?: number;
  /** Bind ::1 too, on the same port. Default the simulator's `ipv6`. */
  readonly ipv6?: boolean;
  /** `silent` drops every datagram; `refused` binds nothing, so clients get ECONNREFUSED. */
  readonly dead?: DnsDead;
}

export interface DnsSimulatorOptions extends DnsLayer, DnsServerPolicy {
  /** The servers, each on its own port. Their layers sit over the shared one. Default one, `ns1`. */
  readonly servers?: readonly DnsServerSpec[];
  /** `manual` starts at 0 and moves only by `advance`. Default `real`. */
  readonly clock?: 'real' | 'manual';
  /** Bind ::1 too where the machine has it. Default true. */
  readonly ipv6?: boolean;
  /** Query-log entries kept; past it they are counted. Default 200,000. */
  readonly logLimit?: number;
  /** How long a control call may take before it fails naming itself. Default 10,000 ms. */
  readonly callTimeoutMs?: number;
}

export interface DnsServerInfo {
  readonly name: string;
  readonly port: number;
  /** 127.0.0.1, unless the spec named another address. */
  readonly ipv4: string;
  /** `::1`, unless this machine has no IPv6 loopback or `ipv6` was false. */
  readonly ipv6: '::1' | undefined;
}

export type DnsOutcome =
  /**
   * Sent upstream. Over UDP it takes a forward slot. Over TCP it takes none, merges with nothing
   * and is never dropped, as dnsmasq's `tcp_request` child never touches its forward table.
   */
  | 'forwarded'
  /** Joined a held question from another client, or another ID. */
  | 'merged'
  /** The same client's retransmission of a held question. */
  | 'retry'
  | 'cache'
  /** Answered by the server itself: `localhost`, FORMERR, NOTIMP. */
  | 'local'
  /** Every forward slot held: answered REFUSED, or nothing under `whenFull: 'silent'`. */
  | 'dropped'
  /** Refused by the limiter. */
  | 'limited'
  /** Seen and not answered: a dead server, or a dropped OPT query or TCP retry. */
  | 'ignored'
  /** `dropFirst`: lost before the server saw it. */
  | 'lost'
  /** `tcp-reset`. */
  | 'reset'
  /** The server failed on it and answered SERVFAIL rather than stop: see the entry's `fault`. */
  | 'fault';

export interface DnsReplyRecord {
  /** On the simulator's clock. */
  readonly at: number;
  /** Real milliseconds from receipt to reply, whatever the clock. */
  readonly afterMs: number;
  readonly rcode: string;
  readonly answers: number;
  readonly tc: boolean;
}

export interface DnsQueryRecord {
  readonly seq: number;
  /** On the simulator's clock: epoch milliseconds, or the manual clock. */
  readonly at: number;
  readonly server: string;
  /** Which loopback it arrived on. */
  readonly family: 4 | 6;
  readonly transport: 'udp' | 'tcp';
  readonly client: { readonly address: string; readonly port: number };
  /** `tagPort`'s class for the client's port, if any. */
  readonly portClass: string | undefined;
  readonly id: number;
  /** As asked, case kept. */
  readonly qname: string;
  readonly qtype: string;
  readonly opt: boolean;
  /**
   * The EDNS option codes the query's OPT carried, in order: 10 is a cookie (RFC 7873). Node's
   * `dns.Resolver` sends no OPT at all, so the walk's entries read `opt` false and `[]` here.
   */
  readonly ednsOptions: readonly number[];
  readonly outcome: DnsOutcome;
  /** Set once a reply is with the kernel (UDP) or written (TCP); never for silence. */
  readonly reply: DnsReplyRecord | undefined;
  /**
   * Why the server answered SERVFAIL instead, when it could not build the reply (a CNAME target
   * with a label over 63 bytes) or failed on the query. The worker never throws out of a socket.
   */
  readonly fault: string | undefined;
}

/** A forward slot held now: a distinct question the upstream has not answered. */
export interface DnsHeldQuestion {
  readonly server: string;
  readonly qname: string;
  readonly qtype: string;
  readonly since: number;
  readonly waiters: number;
  readonly classes: readonly string[];
}

export interface DnsGauge {
  readonly server: string;
  readonly received: number;
  readonly outcomes: Readonly<Record<DnsOutcome, number>>;
  /** Forward slots held now, background slots included. */
  readonly heldNow: number;
  /** Distinct (name, type) among them: below `heldNow` only under `merge: 'client'`. */
  readonly distinctHeld: number;
  /** The most slots held at once since start or the last `resetPeak`. */
  readonly peakHeld: number;
  /** The same per port class; untagged ports are `other`, background slots `background`. */
  readonly peakHeldByClass: Readonly<Record<string, number>>;
  readonly heldByClass: Readonly<Record<string, number>>;
  readonly background: number;
  /** Questions dropped because every slot was held. */
  readonly dropped: number;
  readonly limited: number;
  readonly cached: number;
  /** Queries the server failed on and answered SERVFAIL, or could not answer at all. */
  readonly faults: number;
}

export interface DnsLimiterTrip {
  readonly server: string;
  readonly client: string;
  readonly at: number;
  readonly windowEndsAt: number;
  /** The query that went over. */
  readonly count: number;
}

export interface DnsPrimeEntry {
  readonly name: string;
  /** IPv4 ones are cached for A, IPv6 ones for AAAA; a family with none is cached as NODATA. */
  readonly addresses: readonly string[];
  readonly ttl: number;
}

export interface DnsClientSpec {
  readonly name: string;
  readonly ratePerSecond: number;
  readonly qnames: readonly string[];
  /** The server asked. Default the first. */
  readonly server?: string;
  /** The source address. Default 127.0.0.1: the probe's, so one limiter counts both. */
  readonly source?: string;
  readonly qtype?: 'A' | 'AAAA' | 'both';
}

export interface DnsClientStats {
  readonly name: string;
  readonly port: number;
  readonly sent: number;
  readonly answered: number;
  readonly refused: number;
  readonly otherRcodes: number;
  readonly unanswered: number;
}

/** @internal The control protocol between `DnsSimulator` and its worker. */
export type DnsControl =
  | {
      readonly op: 'set';
      readonly target: DnsTarget;
      readonly behaviour?: DnsBehaviour;
      readonly server?: string;
    }
  | { readonly op: 'setDead'; readonly server: string; readonly dead: DnsDead }
  | { readonly op: 'advance'; readonly ms: number }
  | { readonly op: 'now' }
  | { readonly op: 'prime'; readonly entries: readonly DnsPrimeEntry[]; readonly server?: string }
  | { readonly op: 'flush'; readonly server?: string; readonly name?: string }
  | { readonly op: 'tagPort'; readonly port: number; readonly portClass?: string }
  | { readonly op: 'occupy'; readonly count: number; readonly server?: string }
  | { readonly op: 'release'; readonly server?: string }
  | { readonly op: 'startClient'; readonly spec: DnsClientSpec }
  | { readonly op: 'stopClient'; readonly name: string }
  | { readonly op: 'clients' }
  | { readonly op: 'log'; readonly since?: number; readonly server?: string }
  | { readonly op: 'clearLog' }
  | { readonly op: 'held'; readonly server?: string }
  | { readonly op: 'gauge'; readonly server?: string; readonly resetPeak?: boolean }
  | { readonly op: 'trips'; readonly server?: string }
  | {
      readonly op: 'answer';
      readonly qname: string;
      readonly reply: DnsReply;
      readonly qtype?: string;
      readonly server?: string;
    }
  | { readonly op: 'stop' };

/** @internal What each control returns. */
export interface DnsControlResults {
  set: null;
  setDead: null;
  advance: number;
  now: number;
  prime: null;
  flush: null;
  tagPort: null;
  occupy: null;
  release: null;
  startClient: number;
  stopClient: DnsClientStats;
  clients: DnsClientStats[];
  log: { entries: DnsQueryRecord[]; dropped: number };
  clearLog: null;
  held: DnsHeldQuestion[];
  gauge: DnsGauge[];
  trips: DnsLimiterTrip[];
  answer: number;
  stop: null;
}

/** @internal */
export type DnsWorkerMessage =
  | { readonly t: 'ready'; readonly servers: readonly DnsServerInfo[] }
  | { readonly t: 'failed'; readonly message: string }
  | { readonly t: 'result'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: 'result'; readonly id: number; readonly ok: false; readonly message: string };

/** @internal */
export interface DnsWorkerData {
  readonly options: DnsSimulatorOptions;
  /** One Int32: replies sent, for `waitForReplies`. */
  readonly replies: SharedArrayBuffer;
}

const WORKER = new URL('./dns-server-worker.js', import.meta.url);

interface Pending {
  readonly op: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class DnsSimulator {
  readonly servers: readonly DnsServerInfo[];
  readonly #worker: Worker;
  readonly #replies: Int32Array;
  readonly #pending = new Map<number, Pending>();
  readonly #callTimeoutMs: number;
  #next = 1;
  #gone: Error | undefined;

  private constructor(
    worker: Worker,
    replies: Int32Array,
    servers: readonly DnsServerInfo[],
    callTimeoutMs: number,
  ) {
    this.#worker = worker;
    this.#replies = replies;
    this.servers = servers;
    this.#callTimeoutMs = callTimeoutMs;
    worker.on('message', (message: DnsWorkerMessage) => {
      if (message.t !== 'result') return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#settled(message.id, pending);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(`the DNS simulator refused ${pending.op}: ${message.message}`));
    });
    const gone = (error: Error): void => {
      this.#gone ??= error;
      for (const [id, pending] of this.#pending) {
        this.#settled(id, pending);
        pending.reject(this.#gone);
      }
    };
    worker.on('error', gone);
    worker.on('exit', (code) => {
      gone(new Error(`the DNS simulator's worker exited (code ${String(code)})`));
    });
    // Held open only while a call is out, so a simulator a test forgot to stop cannot keep the
    // test file's process alive, and a call in flight is never cut off by the loop emptying.
    worker.unref();
  }

  /** Binds every server and resolves once all of them answer, or rejects saying why not. */
  static async start(options: DnsSimulatorOptions = {}): Promise<DnsSimulator> {
    const shared = new SharedArrayBuffer(4);
    const data: DnsWorkerData = { options, replies: shared };
    const worker = new Worker(WORKER, { workerData: data });
    const callTimeoutMs = options.callTimeoutMs ?? 10_000;
    try {
      const servers = await new Promise<readonly DnsServerInfo[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`the DNS simulator did not bind within ${String(callTimeoutMs)} ms`));
        }, callTimeoutMs);
        worker.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`the DNS simulator's worker exited at start (code ${String(code)})`));
        });
        worker.on('message', function ready(message: DnsWorkerMessage) {
          if (message.t !== 'ready' && message.t !== 'failed') return;
          clearTimeout(timer);
          worker.off('message', ready);
          if (message.t === 'ready') resolve(message.servers);
          else reject(new Error(`the DNS simulator could not start: ${message.message}`));
        });
      });
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
      return new DnsSimulator(worker, new Int32Array(shared), servers, callTimeoutMs);
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }

  /** A server by name; the first unless named. */
  server(name?: string): DnsServerInfo {
    const found = name === undefined ? this.servers[0] : this.servers.find((s) => s.name === name);
    if (found === undefined) throw new Error(`the DNS simulator has no server ${name ?? ''}`);
    return found;
  }

  /** Where to send a question: the server's address on that loopback, and its port. */
  target(name?: string, family: 4 | 6 = 4): { readonly address: string; readonly port: number } {
    const server = this.server(name);
    if (family === 6 && server.ipv6 === undefined) {
      throw new Error(`the DNS simulator's ${server.name} has no IPv6 loopback here`);
    }
    return { address: family === 6 ? '::1' : server.ipv4, port: server.port };
  }

  /** The servers as `dns.Resolver#setServers` takes them, in order: `127.0.0.1:5353`. */
  serverList(names?: readonly string[], family: 4 | 6 = 4): string[] {
    return (names ?? this.servers.map((server) => server.name)).map((name) => {
      const { address, port } = this.target(name, family);
      return family === 6 ? `[${address}]:${String(port)}` : `${address}:${String(port)}`;
    });
  }

  /**
   * Replies sent so far, every server and transport, the background client's included, read
   * without a round trip. A reply counts once it is with the kernel: from the UDP send's callback,
   * or the TCP write's, never when it is built.
   */
  get repliesSent(): number {
    return Atomics.load(this.#replies, 0);
  }

  /**
   * Blocks this thread until the worker has sent `count` replies in all, or `timeoutMs` passes.
   * The channel experiment's tool: the main thread never yields, and a reply counts only once its
   * datagram is with the kernel, so whatever the worker counted is sitting in the client's socket
   * when this returns, for the next poll phase to read. True when the count was reached.
   */
  waitForReplies(count: number, timeoutMs: number): boolean {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const seen = Atomics.load(this.#replies, 0);
      if (seen >= count) return true;
      const left = deadline - performance.now();
      if (left <= 0) return false;
      Atomics.wait(this.#replies, 0, seen, left);
    }
  }

  /** Replaces one behaviour, shared or on one server; `undefined` removes it. */
  async set(
    target: DnsTarget,
    behaviour: DnsBehaviour | undefined,
    server?: string,
  ): Promise<void> {
    await this.#call({
      op: 'set',
      target,
      ...(behaviour === undefined ? {} : { behaviour }),
      ...(server === undefined ? {} : { server }),
    });
  }

  /** A zone, apex and names, goes silent. Cached names keep answering until they expire. */
  async silence(zone: string, server?: string): Promise<void> {
    await this.set({ zone }, { reply: replies.silent }, server);
  }

  async setDead(server: string, dead: DnsDead): Promise<void> {
    await this.#call({ op: 'setDead', server, dead });
  }

  /** Moves a manual clock on and returns it. */
  advance(ms: number): Promise<number> {
    return this.#call({ op: 'advance', ms });
  }

  now(): Promise<number> {
    return this.#call({ op: 'now' });
  }

  async prime(entries: readonly DnsPrimeEntry[], server?: string): Promise<void> {
    await this.#call({ op: 'prime', entries, ...(server === undefined ? {} : { server }) });
  }

  /** Empties the recursion cache, or drops one name from it. Every server unless named. */
  async flush(options: { readonly server?: string; readonly name?: string } = {}): Promise<void> {
    await this.#call({ op: 'flush', ...options });
  }

  /** Counts a client port's held questions under `portClass` (`undefined` untags it). */
  async tagPort(port: number, portClass: string | undefined): Promise<void> {
    await this.#call({ op: 'tagPort', port, ...(portClass === undefined ? {} : { portClass }) });
  }

  /** A background client holds `count` more forward slots, until `release`. */
  async occupy(count: number, server?: string): Promise<void> {
    await this.#call({ op: 'occupy', count, ...(server === undefined ? {} : { server }) });
  }

  async release(server?: string): Promise<void> {
    await this.#call({ op: 'release', ...(server === undefined ? {} : { server }) });
  }

  /**
   * A background client in the worker, asking `qnames` in turn at `ratePerSecond` from one
   * socket on `source` (127.0.0.1 unless set): the ping binary's own lookups beside the probe's,
   * counted by the same limiter. Resolves its port, which is tagged with its name.
   */
  client(
    name: string,
    ratePerSecond: number,
    qnames: readonly string[],
    options: Omit<DnsClientSpec, 'name' | 'ratePerSecond' | 'qnames'> = {},
  ): Promise<number> {
    return this.#call({ op: 'startClient', spec: { ...options, name, ratePerSecond, qnames } });
  }

  stopClient(name: string): Promise<DnsClientStats> {
    return this.#call({ op: 'stopClient', name });
  }

  clients(): Promise<DnsClientStats[]> {
    return this.#call({ op: 'clients' });
  }

  /** The query log from `since` (a `seq`, exclusive), every server unless named. */
  async log(
    options: { readonly since?: number; readonly server?: string } = {},
  ): Promise<DnsQueryRecord[]> {
    return (await this.#call({ op: 'log', ...options })).entries;
  }

  /** Log entries not kept because `logLimit` was reached. */
  async logDropped(): Promise<number> {
    return (await this.#call({ op: 'log', since: Number.MAX_SAFE_INTEGER })).dropped;
  }

  async clearLog(): Promise<void> {
    await this.#call({ op: 'clearLog' });
  }

  /** The distinct questions each server holds a slot for now. */
  held(server?: string): Promise<DnsHeldQuestion[]> {
    return this.#call({ op: 'held', ...(server === undefined ? {} : { server }) });
  }

  /** One gauge per server, or the named one's alone. `resetPeak` starts the peaks again after. */
  gauge(server?: string, options: { readonly resetPeak?: boolean } = {}): Promise<DnsGauge[]> {
    return this.#call({ op: 'gauge', ...options, ...(server === undefined ? {} : { server }) });
  }

  trips(server?: string): Promise<DnsLimiterTrip[]> {
    return this.#call({ op: 'trips', ...(server === undefined ? {} : { server }) });
  }

  /**
   * Answers every waiter on the slots held for `qname` (any type unless `qtype` is given, every
   * server unless one is named) with `reply`, now: what a `held` reply waits for, and it frees a
   * silent or slow slot too. TCP questions held on a `held` reply are answered as well. Resolves
   * how many waiters were answered; the reply's own `delayMs` is not applied.
   */
  answer(
    qname: string,
    reply: DnsReply,
    options: { readonly qtype?: string; readonly server?: string } = {},
  ): Promise<number> {
    return this.#call({ op: 'answer', qname, reply, ...options });
  }

  /** Every server's port: what a client opened beside them must not draw (`openClient`). */
  get ports(): number[] {
    return this.servers.map((server) => server.port);
  }

  /**
   * A `DnsClient` whose port is none of the servers' (F4): a server that is dead keeps its port
   * number with nothing bound, and a client holding that number would take its ECONNREFUSED.
   */
  openClient(options: { readonly localAddress?: string } = {}): Promise<DnsClient> {
    return DnsClient.open({ ...options, avoid: this.ports });
  }

  /** Closes every socket and ends the worker. Safe to call twice. */
  async stop(): Promise<void> {
    if (this.#gone === undefined) {
      try {
        await this.#call({ op: 'stop' });
      } catch {
        // Gone already, or wedged: terminate either way.
      }
    }
    this.#gone ??= new Error('the DNS simulator was stopped');
    await this.#worker.terminate();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  #settled(id: number, pending: Pending): void {
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (this.#pending.size === 0) this.#worker.unref();
  }

  #call<C extends DnsControl>(control: C): Promise<DnsControlResults[C['op']]> {
    if (this.#gone !== undefined) return Promise.reject(this.#gone);
    const id = this.#next++;
    return new Promise<DnsControlResults[C['op']]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#settled(id, pending);
        reject(
          new Error(
            `the DNS simulator did not answer ${control.op} within ${String(this.#callTimeoutMs)} ms`,
          ),
        );
      }, this.#callTimeoutMs);
      this.#pending.set(id, {
        op: control.op,
        // The worker answers each control with that control's result (`dns-server-worker.ts`).
        resolve: (value) => {
          resolve(value as DnsControlResults[C['op']]);
        },
        reject,
        timer,
      });
      this.#worker.ref();
      this.#worker.postMessage({ id, control });
    });
  }
}

/** What a client heard: a reply, nothing by its bound, or a socket error such as ECONNREFUSED. */
export type DnsQueryResult =
  | {
      readonly kind: 'reply';
      readonly transport: 'udp' | 'tcp';
      readonly rcode: string;
      readonly tc: boolean;
      readonly opt: boolean;
      readonly answers: readonly DnsRecord[];
      /** The A and AAAA answers' addresses, in order. */
      readonly addresses: readonly string[];
      readonly message: DnsMessage;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

export interface DnsQueryOptions {
  /** Default random. */
  readonly id?: number;
  /** Carry OPT, with these EDNS options if given. Default false. */
  readonly opt?: boolean | { readonly options: readonly EdnsOption[] };
  /** How long to wait for a reply. Default 2,000 ms. */
  readonly timeoutMs?: number;
  /** The source address. Default the kernel's choice on that loopback. */
  readonly localAddress?: string;
  /** Default `udp`. */
  readonly transport?: 'udp' | 'tcp';
  /** Ask again over TCP when a UDP reply has TC set, as a stub does. Default true. */
  readonly followTruncation?: boolean;
  /**
   * UDP source ports not to draw, such as `sim.ports`: the socket is bound before it connects
   * and drawn again if the kernel hands it one of these. TCP's source port is not checked.
   */
  readonly avoid?: readonly number[];
}

export interface DnsEndpoint {
  readonly address: string;
  readonly port: number;
}

function readReply(buf: Buffer, transport: 'udp' | 'tcp'): DnsQueryResult {
  try {
    const message = decodeMessage(buf);
    return {
      kind: 'reply',
      transport,
      rcode: rcodeName(message.header.rcode),
      tc: message.header.tc,
      opt: message.opt !== undefined,
      answers: message.answers,
      addresses: message.answers
        .filter((record) => record.type === DNS_TYPES.A || record.type === DNS_TYPES.AAAA)
        .map((record) => record.data ?? ''),
      message,
    };
  } catch (error) {
    if (error instanceof WireError) {
      return { kind: 'error', code: 'EBADRESP', message: error.message };
    }
    throw error;
  }
}

function socketError(error: unknown): DnsQueryResult {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'EUNKNOWN';
  return { kind: 'error', code, message: error instanceof Error ? error.message : String(error) };
}

const randomId = (): number => Math.floor(Math.random() * 0x10000);

/**
 * One question to one server, as a stub asks it: over UDP from a connected socket, so a port
 * with nothing bound reads as ECONNREFUSED, and again over TCP when the reply is truncated.
 * Never rejects for anything the network does: silence is `timeout`.
 */
export async function dnsQuery(
  target: DnsEndpoint,
  name: string,
  type: string,
  options: DnsQueryOptions = {},
): Promise<DnsQueryResult> {
  const query = encodeQuery({
    id: options.id ?? randomId(),
    name,
    type: typeCode(type),
    opt: options.opt ?? false,
  });
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (options.transport === 'tcp') return askTcp(target, query, timeoutMs, options.localAddress);
  const udp = await askUdp(target, query, timeoutMs, options.localAddress, options.avoid ?? []);
  if (udp.kind === 'reply' && udp.tc && options.followTruncation !== false) {
    return askTcp(target, query, timeoutMs, options.localAddress);
  }
  return udp;
}

async function askUdp(
  target: DnsEndpoint,
  query: Buffer,
  timeoutMs: number,
  localAddress: string | undefined,
  avoid: readonly number[],
): Promise<DnsQueryResult> {
  const id = query.readUInt16BE(0);
  const type = isIPv6(target.address) ? 'udp6' : 'udp4';
  let socket: UdpSocket;
  if (localAddress === undefined && avoid.length === 0) {
    socket = createSocket(type);
  } else {
    try {
      const address = localAddress ?? (type === 'udp6' ? '::1' : '127.0.0.1');
      socket = await avoidingPorts(
        () => bindUdp(type, address, 0),
        (bound) => bound.address().port,
        closeUdp,
        avoid,
      );
    } catch (error) {
      return socketError(error);
    }
  }
  return new Promise<DnsQueryResult>((resolve) => {
    let done = false;
    const finish = (result: DnsQueryResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' });
    }, timeoutMs);
    socket.on('error', (error) => {
      finish(socketError(error));
    });
    socket.on('message', (reply) => {
      if (reply.length >= 2 && reply.readUInt16BE(0) === id) finish(readReply(reply, 'udp'));
    });
    socket.connect(target.port, target.address, () => {
      socket.send(query, (error) => {
        if (error !== null) finish(socketError(error));
      });
    });
  });
}

function askTcp(
  target: DnsEndpoint,
  query: Buffer,
  timeoutMs: number,
  localAddress: string | undefined,
): Promise<DnsQueryResult> {
  return new Promise<DnsQueryResult>((resolve) => {
    const socket = connect({
      host: target.address,
      port: target.port,
      ...(localAddress === undefined ? {} : { localAddress }),
    });
    const deframer = new Deframer();
    let done = false;
    const finish = (result: DnsQueryResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' });
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(frame(query));
    });
    socket.on('data', (chunk: Buffer) => {
      const [first] = deframer.push(chunk);
      if (first !== undefined) finish(readReply(first, 'tcp'));
    });
    socket.on('error', (error) => {
      finish(socketError(error));
    });
    socket.on('close', () => {
      finish({ kind: 'error', code: 'ECONNRESET', message: 'the server closed the connection' });
    });
  });
}

/**
 * One UDP socket that asks many questions and can resend one with its own ID, as glibc's stub
 * does: what a `getaddrinfo` model sends from, so its port can be tagged and its questions told
 * from the walk's in `peakHeld`. A reply that arrives before `reply` asks for it is kept.
 */
export class DnsClient {
  readonly #socket: UdpSocket;
  readonly #early = new Map<number, Buffer>();
  readonly #waiting = new Map<number, ((reply: Buffer) => void)[]>();
  #unmatched = 0;

  private constructor(socket: UdpSocket) {
    this.#socket = socket;
    socket.on('message', (reply) => {
      if (reply.length < 2) return;
      const id = reply.readUInt16BE(0);
      const waiters = this.#waiting.get(id);
      const waiter = waiters?.shift();
      if (waiters?.length === 0) this.#waiting.delete(id);
      if (waiter !== undefined) waiter(reply);
      else if (this.#early.has(id)) this.#unmatched += 1;
      else this.#early.set(id, reply);
    });
  }

  /** `avoid`: ports not to draw, such as `sim.ports` (`DnsSimulator#openClient` passes them). */
  static async open(
    options: { readonly localAddress?: string; readonly avoid?: readonly number[] } = {},
  ): Promise<DnsClient> {
    const localAddress = options.localAddress ?? '127.0.0.1';
    const type = isIPv6(localAddress) ? 'udp6' : 'udp4';
    const socket = await avoidingPorts(
      () => bindUdp(type, localAddress, 0),
      (bound) => bound.address().port,
      closeUdp,
      options.avoid ?? [],
    );
    socket.on('error', () => undefined);
    return new DnsClient(socket);
  }

  get port(): number {
    return this.#socket.address().port;
  }

  /** Replies no `reply` call was waiting for, past the one kept per ID. */
  get unmatched(): number {
    return this.#unmatched;
  }

  /**
   * Sends without waiting for a reply, resolving once the datagram is with the kernel: a socket
   * that is not connected sends on a later tick, so a test that blocks its thread straight after
   * `send` would block the send too. A resend is the same call with the same `id`.
   */
  send(
    target: DnsEndpoint,
    name: string,
    type: string,
    options: { readonly id: number; readonly opt?: DnsQueryOptions['opt'] },
  ): Promise<void> {
    const query = encodeQuery({
      id: options.id,
      name,
      type: typeCode(type),
      opt: options.opt ?? false,
    });
    return new Promise((resolve, reject) => {
      this.#socket.send(query, target.port, target.address, (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    });
  }

  /** The next reply with this ID, or `timeout`. */
  reply(id: number, timeoutMs: number): Promise<DnsQueryResult> {
    const early = this.#early.get(id);
    if (early !== undefined) {
      this.#early.delete(id);
      return Promise.resolve(readReply(early, 'udp'));
    }
    return new Promise<DnsQueryResult>((resolve) => {
      const waiter = (reply: Buffer): void => {
        clearTimeout(timer);
        resolve(readReply(reply, 'udp'));
      };
      const timer = setTimeout(() => {
        const waiters = this.#waiting.get(id) ?? [];
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        if (waiters.length === 0) this.#waiting.delete(id);
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      this.#waiting.set(id, [...(this.#waiting.get(id) ?? []), waiter]);
    });
  }

  async ask(
    target: DnsEndpoint,
    name: string,
    type: string,
    options: {
      readonly id?: number;
      readonly opt?: DnsQueryOptions['opt'];
      readonly timeoutMs?: number;
    } = {},
  ): Promise<DnsQueryResult> {
    const id = options.id ?? randomId();
    const reply = this.reply(id, options.timeoutMs ?? 2_000);
    await this.send(target, name, type, {
      id,
      ...(options.opt === undefined ? {} : { opt: options.opt }),
    });
    return reply;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#socket.close(() => {
        resolve();
      });
    });
  }
}
