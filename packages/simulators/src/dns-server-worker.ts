import type { RemoteInfo, Socket as UdpSocket } from 'node:dgram';
import {
  createServer,
  isIPv4,
  isIPv6,
  type Server as TcpServer,
  type Socket as TcpSocket,
} from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import type {
  DnsBehaviour,
  DnsClientSpec,
  DnsClientStats,
  DnsControl,
  DnsControlResults,
  DnsDead,
  DnsGauge,
  DnsHeldQuestion,
  DnsLayer,
  DnsLimiterOptions,
  DnsLimiterTrip,
  DnsOutcome,
  DnsQueryRecord,
  DnsReply,
  DnsServerInfo,
  DnsServerSpec,
  DnsTarget,
  DnsWorkerData,
  DnsWorkerMessage,
} from './dns-server.js';
import {
  decodeMessage,
  Deframer,
  DNS_RCODES,
  DNS_TYPES,
  encodeQuery,
  encodeReply,
  frame,
  rcodeName,
  typeCode,
  typeName,
  WireError,
  type DnsMessage,
  type DnsQuestion,
  type ReplyAnswer,
} from './dns-wire.js';
import { avoidingPorts, bindUdp, closeUdp } from './net.js';

/**
 * The DNS simulator's server, in its own thread (`dns-server.ts` says why). It owns every socket,
 * every behaviour and every count, and answers `DnsSimulator`'s controls over `postMessage`.
 *
 * A query goes through these steps in order, and the first that applies decides its outcome:
 * a dead server ignores it; the limiter refuses it; the server answers `localhost`, FORMERR and
 * NOTIMP itself; the behaviour may drop or refuse OPT, lose the first datagrams, or reset or
 * ignore a TCP retry; the cache answers it; otherwise, over UDP, it joins a held forward or takes
 * a slot, and is refused (or, under `whenFull: 'silent'`, ignored) and counted as dropped when
 * every slot is held. Over TCP it goes straight upstream, with no slot. The upstream's reply (the
 * zone's behaviour, following CNAMEs) goes to every client waiting on it, after its delay, or
 * when the test calls `answer` for a held one. A query the server fails on is answered SERVFAIL.
 */

const control = parentPort;
if (control === null)
  throw new Error('dns-server-worker.js runs only as the DNS simulator’s worker');
const data = workerData as DnsWorkerData;
const options = data.options;
const repliesSent = new Int32Array(data.replies);

const manual = options.clock === 'manual';
let manualNow = 0;
const now = (): number => (manual ? manualNow : performance.timeOrigin + performance.now());

const normal = (name: string): string => name.toLowerCase().replace(/\.$/u, '');

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type LogEntry = Mutable<DnsQueryRecord>;

const LOG_LIMIT = options.logLimit ?? 200_000;
const log: LogEntry[] = [];
let logDropped = 0;
let seq = 0;
const portClasses = new Map<number, string>();
const trips: DnsLimiterTrip[] = [];

const NODATA: DnsReply = { kind: 'nodata' };
const NXDOMAIN: DnsReply = { kind: 'nxdomain' };

class Layer {
  readonly names = new Map<string, DnsBehaviour>();
  readonly zones = new Map<string, DnsBehaviour>();
  fallback: DnsBehaviour | undefined;

  constructor(spec: DnsLayer) {
    for (const [name, behaviour] of Object.entries(spec.names ?? {})) {
      this.names.set(normal(name), behaviour);
    }
    for (const [zone, behaviour] of Object.entries(spec.zones ?? {})) {
      this.zones.set(normal(zone), behaviour);
    }
    this.fallback = spec.fallback;
  }

  set(target: DnsTarget, behaviour: DnsBehaviour | undefined): void {
    if ('fallback' in target) {
      this.fallback = behaviour;
      return;
    }
    const [map, key] = 'name' in target ? [this.names, target.name] : [this.zones, target.zone];
    if (behaviour === undefined) map.delete(normal(key));
    else map.set(normal(key), behaviour);
  }
}

const shared = new Layer(options);

/** The reply for one type: a per-type one, else `reply`, where addresses mean NODATA off A/AAAA. */
function replyFor(behaviour: DnsBehaviour | undefined, qtype: number): DnsReply {
  if (behaviour === undefined) return NXDOMAIN;
  const specific =
    qtype === DNS_TYPES.A
      ? behaviour.a
      : qtype === DNS_TYPES.AAAA
        ? behaviour.aaaa
        : behaviour.other;
  if (specific !== undefined) return specific;
  const reply = behaviour.reply ?? NODATA;
  if (reply.kind === 'addresses' && qtype !== DNS_TYPES.A && qtype !== DNS_TYPES.AAAA) {
    return reply.delayMs === undefined ? NODATA : { kind: 'nodata', delayMs: reply.delayMs };
  }
  return reply;
}

type Upstream =
  | { readonly kind: 'silent' }
  | { readonly kind: 'held' }
  | {
      readonly kind: 'reply';
      readonly rcode: number;
      readonly answers: readonly ReplyAnswer[];
      readonly delayMs: number;
      /** The chain's shortest TTL, in seconds: how long the cache keeps it. */
      readonly ttl: number;
    };

interface Via {
  readonly transport: 'udp' | 'tcp';
  readonly family: 4 | 6;
  readonly address: string;
  readonly port: number;
  /** Sends a reply; `sent` runs once it is with the kernel, and never if the send failed. */
  send(message: Buffer, sent: () => void): void;
  reset(): void;
}

interface Waiter {
  readonly key: string;
  readonly entry: LogEntry;
  readonly realAt: number;
  readonly via: Via;
  readonly portClass: string;
  readonly id: number;
  readonly rd: boolean;
  readonly opcode: number;
  readonly question: DnsQuestion | undefined;
  readonly opt: boolean;
  /** The largest UDP reply this client takes: 512, or what its OPT says. */
  readonly udpLimit: number;
  readonly truncate: boolean;
  /** Set once a reply is built for it, so a fault after that answers nothing more. */
  answered: boolean;
  /** The outcome counted for it, so a fault can move the count to `fault`. */
  outcome: DnsOutcome | undefined;
}

interface Forward {
  readonly key: string;
  readonly qkey: string;
  readonly qname: string;
  readonly qtype: number;
  readonly since: number;
  readonly expiresAt: number;
  live: boolean;
  readonly waiters: Waiter[];
  readonly waiterKeys: Set<string>;
  readonly classes: Set<string>;
  timer: NodeJS.Timeout | undefined;
}

interface Cached {
  readonly rcode: number;
  readonly answers: readonly ReplyAnswer[];
  readonly expiresAt: number;
}

const OUTCOMES: readonly DnsOutcome[] = [
  'forwarded',
  'merged',
  'retry',
  'cache',
  'local',
  'dropped',
  'limited',
  'ignored',
  'lost',
  'reset',
  'fault',
];

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function listenTcp(
  host: string,
  port: number,
  onSocket: (socket: TcpSocket) => void,
): Promise<TcpServer> {
  const server = createServer(onSocket);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true, ipv6Only: host === '::1' }, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

const closeTcp = (server: TcpServer): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

class Server {
  readonly name: string;
  readonly layer: Layer;
  readonly #forwardMax: number;
  readonly #holdMs: number;
  readonly #merge: 'question' | 'client';
  readonly #whenFull: 'refused' | 'silent';
  readonly #cacheOn: boolean;
  readonly #limiter: DnsLimiterOptions | undefined;
  readonly #tcpMode: 'listen' | 'closed';
  /** The IPv4 address bound: 127.0.0.1 unless the spec names another loopback. */
  readonly address: string;
  /** A fixed port, or 0 for an ephemeral one. */
  readonly fixedPort: number;
  dead: DnsDead;
  port = 0;
  #ipv6: boolean | undefined;
  #udp: UdpSocket[] = [];
  #tcp: TcpServer[] = [];
  readonly #connections = new Set<TcpSocket>();
  readonly #records = new Map<string, Forward>();
  #fifo: Forward[] = [];
  #fifoHead = 0;
  #background = 0;
  readonly #heldByClass = new Map<string, number>();
  #peakByClass = new Map<string, number>();
  #peak = 0;
  readonly #cache = new Map<string, Cached>();
  readonly #windows = new Map<string, { start: number; count: number; tripped: boolean }>();
  readonly #dropSeen = new Map<string, number>();
  #received = 0;
  #faults = 0;
  readonly #outcomes = new Map<DnsOutcome, number>(OUTCOMES.map((outcome) => [outcome, 0]));
  /** TCP questions waiting on a `held` upstream: they take no slot, so they are kept here. */
  readonly #tcpHeld: { readonly waiter: Waiter; readonly qkey: string; readonly qtype: number }[] =
    [];
  /** TCP questions waiting out a slow upstream's delay. */
  readonly #tcpTimers = new Set<NodeJS.Timeout>();
  /**
   * Answers `answer` gave as TC, by client address and question, with how many TCP retries are
   * still owed one: the retry is given that answer, not held again.
   */
  readonly #retries = new Map<
    string,
    { readonly upstream: Extract<Upstream, { kind: 'reply' }>; left: number }
  >();

  constructor(spec: DnsServerSpec) {
    this.name = spec.name;
    this.layer = new Layer(spec);
    const forwarder = spec.forwarder ?? options.forwarder ?? {};
    this.#forwardMax = forwarder.forwardMax ?? Number.POSITIVE_INFINITY;
    this.#holdMs = forwarder.holdMs ?? 10_000;
    this.#merge = forwarder.merge ?? 'question';
    this.#whenFull = forwarder.whenFull ?? 'refused';
    this.#cacheOn = spec.cache ?? options.cache ?? false;
    this.#limiter = spec.limiter ?? options.limiter;
    this.#tcpMode = spec.tcp ?? options.tcp ?? 'listen';
    this.dead = spec.dead ?? false;
    this.address = spec.address ?? '127.0.0.1';
    this.fixedPort = spec.port ?? 0;
    this.#ipv6 = (spec.ipv6 ?? options.ipv6) === false ? false : undefined;
  }

  info(): DnsServerInfo {
    return {
      name: this.name,
      port: this.port,
      ipv4: this.address,
      ipv6: this.#ipv6 === true ? '::1' : undefined,
    };
  }

  /**
   * UDP and TCP on the IPv4 address (127.0.0.1 unless set) and ::1, all on one port (`P-442`):
   * the IPv4 UDP socket takes the port and the rest must get the same one, or everything is
   * closed and, for an ephemeral port, tried again.
   */
  async bind(fixed: number): Promise<void> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const udp: UdpSocket[] = [];
      const tcp: TcpServer[] = [];
      try {
        const udp4 = await bindUdp('udp4', this.address, fixed);
        udp.push(udp4);
        const port = udp4.address().port;
        if (this.#ipv6 !== false) {
          try {
            udp.push(await bindUdp('udp6', '::1', port));
            this.#ipv6 = true;
          } catch (error) {
            const code = errorCode(error);
            const noV6 = code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT';
            if (!noV6 || this.#ipv6 === true) throw error;
            this.#ipv6 = false;
          }
        }
        if (this.#tcpMode === 'listen') {
          const accept = (socket: TcpSocket): void => {
            this.#accept(socket);
          };
          tcp.push(await listenTcp(this.address, port, accept));
          if (this.#ipv6) tcp.push(await listenTcp('::1', port, accept));
        }
        for (const socket of udp) {
          const family = socket.address().family === 'IPv6' ? 6 : 4;
          socket.on('message', (message, remote) => {
            this.#datagram(socket, family, message, remote);
          });
          socket.on('error', () => undefined);
        }
        this.port = port;
        this.#udp = udp;
        this.#tcp = tcp;
        return;
      } catch (error) {
        await Promise.all([...udp.map(closeUdp), ...tcp.map(closeTcp)]);
        if (errorCode(error) === 'EADDRINUSE' && fixed === 0) continue;
        throw error;
      }
    }
    throw new Error(`no port was free on both loopbacks for ${this.name} in 64 tries`);
  }

  async unbind(): Promise<void> {
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    const udp = this.#udp;
    const tcp = this.#tcp;
    this.#udp = [];
    this.#tcp = [];
    await Promise.all([...udp.map(closeUdp), ...tcp.map(closeTcp)]);
  }

  async setDead(dead: DnsDead): Promise<void> {
    if (dead !== false) this.stop();
    if (dead === 'refused' && this.#udp.length > 0) await this.unbind();
    if (dead !== 'refused' && this.#udp.length === 0) {
      try {
        await this.bind(this.port);
      } catch (error) {
        if (errorCode(error) !== 'EADDRINUSE') throw error;
        throw new Error(
          `${this.name}'s port ${String(this.port)} was taken while the server was dead, so it ` +
            `cannot be bound again (${describe(error)})`,
        );
      }
    }
    this.dead = dead;
  }

  #accept(socket: TcpSocket): void {
    this.#connections.add(socket);
    const deframer = new Deframer();
    const via: Via = {
      transport: 'tcp',
      family: isIPv6(socket.localAddress ?? '') ? 6 : 4,
      address: socket.remoteAddress ?? '',
      port: socket.remotePort ?? 0,
      send: (message, sent) => {
        if (socket.destroyed) return;
        socket.write(frame(message), (error) => {
          if (error === null || error === undefined) sent();
        });
      },
      reset: () => {
        socket.resetAndDestroy();
      },
    };
    socket.on('data', (chunk: Buffer) => {
      for (const message of deframer.push(chunk)) this.#safely(message, via);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.#connections.delete(socket);
      // A held question whose connection has gone has no one to answer (L4).
      for (let at = this.#tcpHeld.length - 1; at >= 0; at -= 1) {
        if (this.#tcpHeld[at]?.waiter.via === via) this.#tcpHeld.splice(at, 1);
      }
    });
  }

  #datagram(socket: UdpSocket, family: 4 | 6, message: Buffer, remote: RemoteInfo): void {
    this.#safely(message, {
      transport: 'udp',
      family,
      address: remote.address,
      port: remote.port,
      send: (reply, sent) => {
        try {
          // The callback runs once the datagram is with the kernel. An unconnected socket sends
          // on a later tick, so a count taken before this would run ahead of the datagram (F1).
          socket.send(reply, remote.port, remote.address, (error) => {
            if (error === null) sent();
          });
        } catch {
          // Closed under a delayed reply by `setDead` or `stop`: a dead server answers nothing.
        }
      },
      reset: () => undefined,
    });
  }

  /** The last guard on a socket's handler: the worker never throws out of one (W5). */
  #safely(message: Buffer, via: Via): void {
    try {
      this.#query(message, via);
    } catch {
      this.#faults += 1;
    }
  }

  #entry(
    via: Via,
    id: number,
    question: DnsQuestion | undefined,
    opt: boolean,
    ednsOptions: readonly number[],
  ): LogEntry {
    seq += 1;
    const entry: LogEntry = {
      seq,
      at: now(),
      server: this.name,
      family: via.family,
      transport: via.transport,
      client: { address: via.address, port: via.port },
      portClass: portClasses.get(via.port),
      id,
      qname: question?.name ?? '',
      qtype: typeName(question?.type ?? 0),
      opt,
      ednsOptions,
      outcome: 'ignored',
      reply: undefined,
      fault: undefined,
    };
    if (log.length < LOG_LIMIT) log.push(entry);
    else logDropped += 1;
    return entry;
  }

  #outcome(waiter: Waiter, outcome: DnsOutcome): void {
    const before = waiter.outcome;
    if (before !== undefined) this.#outcomes.set(before, (this.#outcomes.get(before) ?? 1) - 1);
    waiter.outcome = outcome;
    waiter.entry.outcome = outcome;
    this.#outcomes.set(outcome, (this.#outcomes.get(outcome) ?? 0) + 1);
  }

  /**
   * The server failed on a query (W5): it records why and answers SERVFAIL, unless a reply went
   * already or the server is silent, rather than throw out of the socket's handler.
   */
  #fault(waiter: Waiter, error: unknown): void {
    this.#faults += 1;
    waiter.entry.fault = describe(error);
    this.#outcome(waiter, 'fault');
    if (!waiter.answered && this.dead !== 'silent') this.#answer(waiter, DNS_RCODES.SERVFAIL, []);
  }

  #query(buf: Buffer, via: Via): void {
    this.#expire();
    this.#received += 1;
    let message: DnsMessage;
    try {
      message = decodeMessage(buf);
    } catch (error) {
      const waiter = this.#waiter(via, buf.length >= 2 ? buf.readUInt16BE(0) : 0, undefined, false);
      if (!(error instanceof WireError)) {
        this.#fault(waiter, error);
        return;
      }
      const answer = this.dead !== 'silent' && buf.length >= 12;
      this.#outcome(waiter, answer ? 'local' : 'ignored');
      if (answer) this.#answer(waiter, DNS_RCODES.FORMERR, []);
      return;
    }
    if (message.header.qr) return;
    const question = message.questions.length === 1 ? message.questions[0] : undefined;
    const opt = message.opt !== undefined;
    const udpLimit = Math.max(512, Math.min(message.opt?.udpSize ?? 512, 4096));
    const name = normal(question?.name ?? '');
    const behaviour = question === undefined ? undefined : this.#behaviour(name);
    const waiter = this.#waiter(via, message.header.id, question, opt, {
      rd: message.header.rd,
      opcode: message.header.opcode,
      udpLimit,
      truncate: via.transport === 'udp' && behaviour?.truncate !== undefined,
      ednsOptions: message.opt?.options ?? [],
    });
    try {
      this.#route(waiter, message, question, name, behaviour);
    } catch (error) {
      this.#fault(waiter, error);
    }
    this.#notePeak();
  }

  /** Where a decoded query goes: the steps the file's header lists, in order. */
  #route(
    waiter: Waiter,
    message: DnsMessage,
    question: DnsQuestion | undefined,
    name: string,
    behaviour: DnsBehaviour | undefined,
  ): void {
    const via = waiter.via;
    const opt = waiter.opt;
    if (this.dead === 'silent') {
      this.#outcome(waiter, 'ignored');
      return;
    }
    if (this.#limited(via.address)) {
      this.#outcome(waiter, 'limited');
      this.#answer(waiter, DNS_RCODES.REFUSED, []);
      return;
    }
    if (message.header.opcode !== 0 || question === undefined) {
      this.#outcome(waiter, 'local');
      this.#answer(waiter, question === undefined ? DNS_RCODES.FORMERR : DNS_RCODES.NOTIMP, []);
      return;
    }
    if (name === 'localhost' && !this.#named('localhost')) {
      // RFC 6761: a recursor answers `localhost` itself. The probe's canary asks it.
      this.#outcome(waiter, 'local');
      const address =
        question.type === DNS_TYPES.A ? '127.0.0.1' : question.type === DNS_TYPES.AAAA ? '::1' : '';
      const answers: ReplyAnswer[] =
        address === ''
          ? []
          : [{ name: question.name, type: isIPv4(address) ? 'A' : 'AAAA', ttl: 0, data: address }];
      this.#answer(waiter, DNS_RCODES.NOERROR, answers);
      return;
    }
    if (opt && behaviour?.onOpt === 'drop') {
      this.#outcome(waiter, 'ignored');
      return;
    }
    if (opt && behaviour?.onOpt === 'formerr') {
      this.#outcome(waiter, 'local');
      this.#answer(waiter, DNS_RCODES.FORMERR, [], { opt: false });
      return;
    }
    const qkey = `${name}|${String(question.type)}`;
    const dropFirst = behaviour?.dropFirst ?? 0;
    if (dropFirst > 0) {
      const seen = this.#dropSeen.get(qkey) ?? 0;
      if (seen < dropFirst) {
        this.#dropSeen.set(qkey, seen + 1);
        this.#outcome(waiter, 'lost');
        return;
      }
    }
    if (via.transport === 'tcp' && behaviour?.truncate === 'tcp-reset') {
      this.#outcome(waiter, 'reset');
      via.reset();
      return;
    }
    if (via.transport === 'tcp' && behaviour?.truncate === 'tcp-silent') {
      this.#outcome(waiter, 'ignored');
      return;
    }
    const cached = this.#cacheOn ? this.#cached(qkey) : undefined;
    if (cached !== undefined) {
      this.#outcome(waiter, 'cache');
      this.#answer(waiter, cached.rcode, cached.answers, { upstream: true });
      return;
    }
    if (via.transport === 'tcp') this.#forwardTcp(waiter, question, qkey);
    else this.#forward(waiter, question, qkey);
  }

  #waiter(
    via: Via,
    id: number,
    question: DnsQuestion | undefined,
    opt: boolean,
    more: Partial<Pick<Waiter, 'rd' | 'opcode' | 'udpLimit' | 'truncate'>> & {
      readonly ednsOptions?: readonly number[];
    } = {},
  ): Waiter {
    return {
      key: `${via.transport}|${via.address}|${String(via.port)}|${String(id)}`,
      entry: this.#entry(via, id, question, opt, more.ednsOptions ?? []),
      realAt: performance.now(),
      via,
      portClass: portClasses.get(via.port) ?? 'other',
      id,
      rd: more.rd ?? false,
      opcode: more.opcode ?? 0,
      question,
      opt,
      udpLimit: more.udpLimit ?? 512,
      truncate: more.truncate ?? false,
      answered: false,
      outcome: undefined,
    };
  }

  #behaviour(name: string): DnsBehaviour | undefined {
    const layers = [this.layer, shared];
    for (const layer of layers) {
      const named = layer.names.get(name);
      if (named !== undefined) return named;
    }
    const labels = name === '' ? [] : name.split('.');
    for (let at = 0; at <= labels.length; at += 1) {
      const zone = labels.slice(at).join('.');
      for (const layer of layers) {
        const zoned = layer.zones.get(zone);
        if (zoned !== undefined) return zoned;
      }
    }
    return this.layer.fallback ?? shared.fallback;
  }

  #named(name: string): boolean {
    return [this.layer, shared].some((layer) => layer.names.has(name) || layer.zones.has(name));
  }

  /**
   * The upstream's answer: the zone's behaviour, following CNAMEs for at most 8 hops. `first`
   * stands for the name's own reply (what `answer` gives); the hops after it are the zones'.
   */
  #upstream(qname: string, qtype: number, first?: DnsReply): Upstream {
    let name = qname;
    const answers: ReplyAnswer[] = [];
    let delayMs = 0;
    let ttl = Number.POSITIVE_INFINITY;
    for (let hop = 0; hop <= 8; hop += 1) {
      const behaviour = this.#behaviour(normal(name));
      const reply =
        hop === 0 && first !== undefined
          ? replyFor({ reply: first }, qtype)
          : replyFor(behaviour, qtype);
      if (reply.kind === 'silent') return { kind: 'silent' };
      if (reply.kind === 'held') return { kind: 'held' };
      delayMs += reply.delayMs ?? behaviour?.delayMs ?? 0;
      const recordTtl = behaviour?.ttl ?? 300;
      ttl = Math.min(ttl, recordTtl);
      const done = (rcode: number, kept: readonly ReplyAnswer[] = answers): Upstream => ({
        kind: 'reply',
        rcode,
        answers: kept,
        delayMs,
        ttl,
      });
      switch (reply.kind) {
        case 'addresses': {
          const v4 = qtype === DNS_TYPES.A;
          for (const address of reply.addresses) {
            if (v4 ? isIPv4(address) : isIPv6(address)) {
              answers.push({ name, type: v4 ? 'A' : 'AAAA', ttl: recordTtl, data: address });
            }
          }
          return done(DNS_RCODES.NOERROR);
        }
        case 'nodata':
          return done(DNS_RCODES.NOERROR);
        case 'nxdomain':
          return done(DNS_RCODES.NXDOMAIN);
        case 'rcode':
          return done(DNS_RCODES[reply.rcode], []);
        case 'cname':
          answers.push({ name, type: 'CNAME', ttl: recordTtl, data: reply.target });
          if (qtype === DNS_TYPES.CNAME) return done(DNS_RCODES.NOERROR);
          name = reply.target;
      }
    }
    return { kind: 'reply', rcode: DNS_RCODES.SERVFAIL, answers: [], delayMs, ttl: 0 };
  }

  #forward(waiter: Waiter, question: DnsQuestion, qkey: string): void {
    const key =
      this.#merge === 'question'
        ? qkey
        : `${waiter.via.address}|${String(waiter.via.port)}|${String(waiter.id)}|${qkey}`;
    const held = this.#records.get(key);
    if (held !== undefined) {
      const again = held.waiterKeys.has(waiter.key);
      this.#outcome(waiter, again ? 'retry' : 'merged');
      if (!again) {
        held.waiters.push(waiter);
        held.waiterKeys.add(waiter.key);
      }
      this.#addClass(held, waiter.portClass);
      return;
    }
    if (this.#heldNow() >= this.#forwardMax) {
      this.#outcome(waiter, 'dropped');
      // dnsmasq 2.86 and later answer REFUSED ("table full - flags == 0, return REFUSED" in
      // forward.c); 2.85 and older stop reading the listener, which `silent` stands for (W1).
      if (this.#whenFull === 'refused') this.#answer(waiter, DNS_RCODES.REFUSED, []);
      return;
    }
    this.#outcome(waiter, 'forwarded');
    const since = now();
    const record: Forward = {
      key,
      qkey,
      qname: question.name,
      qtype: question.type,
      since,
      expiresAt: since + this.#holdMs,
      live: true,
      waiters: [waiter],
      waiterKeys: new Set([waiter.key]),
      classes: new Set(),
      timer: undefined,
    };
    this.#records.set(key, record);
    this.#fifo.push(record);
    this.#addClass(record, waiter.portClass);
    const upstream = this.#upstream(question.name, question.type);
    // A held upstream keeps the slot until `answer`; one slower than the hold is a silent one,
    // since the forwarder has let the slot go by the time it answers.
    if (upstream.kind !== 'reply' || upstream.delayMs >= this.#holdMs) return;
    if (upstream.delayMs <= 0) {
      this.#answered(record, upstream);
      return;
    }
    record.timer = setTimeout(() => {
      // On the manual clock the hold may have passed while the delay ran: let it go first.
      this.#expire();
      if (record.live) this.#answered(record, upstream);
    }, upstream.delayMs);
  }

  /**
   * A TCP question goes straight upstream (W6): dnsmasq answers TCP in a `tcp_request` child that
   * never touches the forward table, so it takes no slot, joins no held question and is never
   * dropped when the table is full. A held one waits for `answer`; a silent one for nothing.
   */
  #forwardTcp(waiter: Waiter, question: DnsQuestion, qkey: string): void {
    this.#outcome(waiter, 'forwarded');
    const upstream = this.#upstream(question.name, question.type);
    if (upstream.kind === 'silent') return;
    if (upstream.kind === 'held') {
      const key = `${waiter.via.address}|${qkey}`;
      const retry = this.#retries.get(key);
      if (retry === undefined) {
        this.#tcpHeld.push({ waiter, qkey, qtype: question.type });
        return;
      }
      // The retry of an answer `answer` sent truncated: the upstream has answered it already.
      retry.left -= 1;
      if (retry.left === 0) this.#retries.delete(key);
      this.#deliver(qkey, [waiter], retry.upstream);
      return;
    }
    if (upstream.delayMs <= 0) {
      this.#deliver(qkey, [waiter], upstream);
      return;
    }
    const timer = setTimeout(() => {
      this.#tcpTimers.delete(timer);
      this.#deliver(qkey, [waiter], upstream);
    }, upstream.delayMs);
    this.#tcpTimers.add(timer);
  }

  /** Whether the recursion cache keeps this reply: NOERROR or NXDOMAIN with a TTL, cache on. */
  #caches(upstream: Extract<Upstream, { kind: 'reply' }>): boolean {
    const cacheable =
      upstream.rcode === DNS_RCODES.NOERROR || upstream.rcode === DNS_RCODES.NXDOMAIN;
    return this.#cacheOn && cacheable && upstream.ttl > 0;
  }

  /** Answers a slot's waiters; returns those whose reply went truncated. */
  #answered(record: Forward, upstream: Extract<Upstream, { kind: 'reply' }>): Waiter[] {
    this.#remove(record);
    return this.#deliver(record.qkey, record.waiters, upstream);
  }

  /**
   * The upstream's reply to everyone waiting on it, cached first when the server caches. Returns
   * the waiters whose reply went truncated, so `answer` can owe their TCP retries the reply.
   */
  #deliver(
    qkey: string,
    waiters: readonly Waiter[],
    upstream: Extract<Upstream, { kind: 'reply' }>,
  ): Waiter[] {
    if (this.#caches(upstream)) {
      this.#cache.set(qkey, {
        rcode: upstream.rcode,
        answers: upstream.answers,
        expiresAt: now() + upstream.ttl * 1_000,
      });
    }
    return waiters.filter((waiter) =>
      this.#answer(waiter, upstream.rcode, upstream.answers, { upstream: true }),
    );
  }

  /**
   * Builds and sends one reply; true when it went truncated. A reply that cannot be built (a
   * CNAME target with a label over 63 bytes) is a fault and goes as SERVFAIL. The reply is
   * counted, and `waitForReplies` woken, only from the send's callback, once the datagram is with
   * the kernel (F1). A behaviour's `truncate` applies only to the upstream's answer (`upstream`):
   * what the server makes itself (REFUSED, FORMERR, NOTIMP, SERVFAIL, `localhost`) goes without
   * TC, as dnsmasq's `setup_reply` clears it (L2). Any reply too big for UDP still goes as TC.
   */
  #answer(
    waiter: Waiter,
    rcode: number,
    answers: readonly ReplyAnswer[],
    options: { readonly upstream?: boolean; readonly opt?: boolean } = {},
  ): boolean {
    if (waiter.answered) return false;
    waiter.answered = true;
    const opt = options.opt ?? waiter.opt;
    const udp = waiter.via.transport === 'udp';
    const build = (code: number, kept: readonly ReplyAnswer[], tc: boolean): Buffer =>
      encodeReply({
        id: waiter.id,
        opcode: waiter.opcode,
        rd: waiter.rd,
        rcode: code,
        tc,
        question: waiter.question,
        answers: tc ? [] : kept,
        opt,
      });
    let code = rcode;
    let kept = answers;
    let tc = udp && options.upstream === true && waiter.truncate;
    let reply: Buffer;
    try {
      reply = build(code, kept, tc);
      // What does not fit the client's UDP size goes as TC, as RFC 1035 §4.2.1 says.
      if (udp && !tc && reply.length > waiter.udpLimit) {
        tc = true;
        reply = build(code, kept, true);
      }
    } catch (error) {
      this.#faults += 1;
      waiter.entry.fault = describe(error);
      this.#outcome(waiter, 'fault');
      code = DNS_RCODES.SERVFAIL;
      kept = [];
      tc = false;
      try {
        reply = build(code, kept, false);
      } catch {
        return false;
      }
    }
    waiter.via.send(reply, () => {
      waiter.entry.reply = {
        at: now(),
        afterMs: performance.now() - waiter.realAt,
        rcode: rcodeName(code),
        answers: tc ? 0 : kept.length,
        tc,
      };
      Atomics.add(repliesSent, 0, 1);
      Atomics.notify(repliesSent, 0);
    });
    return tc;
  }

  #cached(qkey: string): { rcode: number; answers: ReplyAnswer[] } | undefined {
    const entry = this.#cache.get(qkey);
    if (entry === undefined) return undefined;
    const left = entry.expiresAt - now();
    if (left <= 0) {
      this.#cache.delete(qkey);
      return undefined;
    }
    const ttl = Math.ceil(left / 1_000);
    return { rcode: entry.rcode, answers: entry.answers.map((answer) => ({ ...answer, ttl })) };
  }

  #limited(address: string): boolean {
    const limiter = this.#limiter;
    if (limiter === undefined) return false;
    const at = now();
    let window = this.#windows.get(address);
    if (window === undefined || at >= window.start + limiter.windowMs) {
      window = { start: at, count: 0, tripped: false };
      this.#windows.set(address, window);
    }
    window.count += 1;
    if (window.count <= limiter.queries) return false;
    if (!window.tripped) {
      window.tripped = true;
      trips.push({
        server: this.name,
        client: address,
        at,
        windowEndsAt: window.start + limiter.windowMs,
        count: window.count,
      });
    }
    return true;
  }

  #addClass(record: Forward, portClass: string): void {
    if (record.classes.has(portClass)) return;
    record.classes.add(portClass);
    this.#heldByClass.set(portClass, (this.#heldByClass.get(portClass) ?? 0) + 1);
  }

  #remove(record: Forward): void {
    if (!record.live) return;
    record.live = false;
    clearTimeout(record.timer);
    this.#records.delete(record.key);
    for (const portClass of record.classes) {
      this.#heldByClass.set(portClass, (this.#heldByClass.get(portClass) ?? 1) - 1);
    }
  }

  #heldNow(): number {
    return this.#records.size + this.#background;
  }

  /** Taken once a query or control is done, so a question answered at once is never a peak. */
  #notePeak(): void {
    this.#peak = Math.max(this.#peak, this.#heldNow());
    for (const [portClass, held] of this.#heldByClass) {
      this.#peakByClass.set(portClass, Math.max(this.#peakByClass.get(portClass) ?? 0, held));
    }
  }

  /** Lets go of every slot past its hold. Holds are taken in order, so the queue's head is next. */
  #expire(): void {
    const at = now();
    while (this.#fifoHead < this.#fifo.length) {
      const head = this.#fifo[this.#fifoHead];
      if (head === undefined || (head.live && head.expiresAt > at)) break;
      this.#remove(head);
      this.#fifoHead += 1;
    }
    if (this.#fifoHead > 1_024 && this.#fifoHead * 2 > this.#fifo.length) {
      this.#fifo = this.#fifo.slice(this.#fifoHead);
      this.#fifoHead = 0;
    }
  }

  prime(entries: readonly { name: string; addresses: readonly string[]; ttl: number }[]): void {
    if (!this.#cacheOn) throw new Error(`${this.name} has no recursion cache to prime`);
    for (const entry of entries) {
      const name = normal(entry.name);
      const expiresAt = now() + entry.ttl * 1_000;
      for (const [type, test, label] of [
        [DNS_TYPES.A, isIPv4, 'A'],
        [DNS_TYPES.AAAA, isIPv6, 'AAAA'],
      ] as const) {
        this.#cache.set(`${name}|${String(type)}`, {
          rcode: DNS_RCODES.NOERROR,
          answers: entry.addresses
            .filter((address) => test(address))
            .map((address) => ({ name: entry.name, type: label, ttl: entry.ttl, data: address })),
          expiresAt,
        });
      }
    }
  }

  flush(name: string | undefined): void {
    if (name === undefined) {
      this.#cache.clear();
      return;
    }
    const prefix = `${normal(name)}|`;
    for (const key of [...this.#cache.keys()]) if (key.startsWith(prefix)) this.#cache.delete(key);
  }

  /**
   * `target`'s behaviour changed on this server: `dropFirst` counts from 0 again for the names it
   * covers, and only those (F5). A name is the name; a zone is the names under it; the fallback
   * is the names no name or zone of either layer covers.
   */
  changed(target: DnsTarget): void {
    const covers = (name: string): boolean => {
      if ('name' in target) return name === normal(target.name);
      if ('zone' in target) {
        const zone = normal(target.zone);
        return zone === '' || name === zone || name.endsWith('.' + zone);
      }
      const labels = name === '' ? [] : name.split('.');
      return ![this.layer, shared].some(
        (layer) =>
          layer.names.has(name) ||
          layer.zones.has('') ||
          labels.some((_, at) => layer.zones.has(labels.slice(at).join('.'))),
      );
    };
    for (const key of [...this.#dropSeen.keys()]) {
      if (covers(key.slice(0, key.lastIndexOf('|')))) this.#dropSeen.delete(key);
    }
  }

  /**
   * Answers every waiter held on `qname` (of `qtype`, or any type) with `reply`, now: the UDP
   * slots, silent, held or slow, and the TCP questions held on a `held` reply whose connection is
   * open. Returns how many were given a reply. A waiter whose reply went truncated is owed the
   * same reply for its TCP retry, which would otherwise find the name held again.
   */
  answer(qname: string, reply: DnsReply, qtype: number | undefined): number {
    if (reply.kind === 'silent' || reply.kind === 'held') {
      throw new Error('answer needs a reply that answers, not ' + reply.kind);
    }
    this.#expire();
    const name = normal(qname);
    const matches = (asked: string, type: number): boolean =>
      normal(asked) === name && (qtype === undefined || type === qtype);
    const upstreams = new Map<number, Extract<Upstream, { kind: 'reply' }>>();
    const upstreamFor = (type: number): Extract<Upstream, { kind: 'reply' }> => {
      const known = upstreams.get(type);
      if (known !== undefined) return known;
      const upstream = this.#upstream(qname, type, reply);
      if (upstream.kind !== 'reply') {
        throw new Error(
          'the reply answer was given for ' + qname + ' leads into a ' + upstream.kind + ' zone',
        );
      }
      upstreams.set(type, upstream);
      return upstream;
    };
    const records = [...this.#records.values()].filter((record) =>
      matches(record.qname, record.qtype),
    );
    const tcp = this.#tcpHeld.filter(
      (held) =>
        held.waiter.question !== undefined && matches(held.waiter.question.name, held.qtype),
    );
    // Every reply is worked out before any is sent, so a reply that leads nowhere answers nothing.
    for (const record of records) upstreamFor(record.qtype);
    for (const held of tcp) upstreamFor(held.qtype);
    let answered = 0;
    for (const record of records) {
      answered += record.waiters.length;
      const upstream = upstreamFor(record.qtype);
      const truncated = this.#answered(record, upstream);
      // A cached answer serves the retry itself, ahead of the forward.
      if (this.#caches(upstream)) continue;
      for (const waiter of truncated) {
        const key = `${waiter.via.address}|${record.qkey}`;
        const owed = this.#retries.get(key);
        if (owed === undefined) this.#retries.set(key, { upstream, left: 1 });
        else owed.left += 1;
      }
    }
    for (const held of tcp) {
      this.#tcpHeld.splice(this.#tcpHeld.indexOf(held), 1);
      answered += 1;
      this.#deliver(held.qkey, [held.waiter], upstreamFor(held.qtype));
    }
    return answered;
  }

  occupy(count: number): void {
    // A hold that has lapsed is no longer held, so it is no part of the peak taken here (F2).
    this.#expire();
    this.#background += count;
    this.#heldByClass.set('background', (this.#heldByClass.get('background') ?? 0) + count);
    this.#notePeak();
  }

  release(): void {
    this.#expire();
    this.#heldByClass.set(
      'background',
      (this.#heldByClass.get('background') ?? 0) - this.#background,
    );
    this.#background = 0;
  }

  held(): DnsHeldQuestion[] {
    this.#expire();
    return [...this.#records.values()].map((record) => ({
      server: this.name,
      qname: record.qname,
      qtype: typeName(record.qtype),
      since: record.since,
      waiters: record.waiters.length,
      classes: [...record.classes],
    }));
  }

  gauge(resetPeak: boolean): DnsGauge {
    this.#expire();
    let cached = 0;
    const at = now();
    for (const entry of this.#cache.values()) if (entry.expiresAt > at) cached += 1;
    const gauge: DnsGauge = {
      server: this.name,
      received: this.#received,
      outcomes: Object.fromEntries(this.#outcomes) as Record<DnsOutcome, number>,
      heldNow: this.#heldNow(),
      distinctHeld: new Set([...this.#records.values()].map((record) => record.qkey)).size,
      peakHeld: this.#peak,
      peakHeldByClass: Object.fromEntries(this.#peakByClass),
      heldByClass: Object.fromEntries(this.#heldByClass),
      background: this.#background,
      dropped: this.#outcomes.get('dropped') ?? 0,
      limited: this.#outcomes.get('limited') ?? 0,
      cached,
      faults: this.#faults,
      tcpHeld: this.#tcpHeld.length,
    };
    if (resetPeak) {
      this.#peak = this.#heldNow();
      this.#peakByClass = new Map(this.#heldByClass);
    }
    return gauge;
  }

  /** Lets go of every question waiting: a dead or stopped server answers none of them. */
  stop(): void {
    for (const record of [...this.#records.values()]) this.#remove(record);
    for (const timer of this.#tcpTimers) clearTimeout(timer);
    this.#tcpTimers.clear();
    this.#tcpHeld.length = 0;
    this.#retries.clear();
  }
}

/** A client in this thread asking at a steady rate from one socket: the ping binary's lookups. */
class Background {
  readonly spec: DnsClientSpec;
  readonly #socket: UdpSocket;
  readonly #target: { address: string; port: number };
  readonly #types: readonly number[];
  readonly #startedAt = performance.now();
  readonly #timer: NodeJS.Timeout;
  #sent = 0;
  #answered = 0;
  #refused = 0;
  #other = 0;
  #nextId = Math.floor(Math.random() * 0x10000);

  private constructor(
    spec: DnsClientSpec,
    socket: UdpSocket,
    target: { address: string; port: number },
  ) {
    this.spec = spec;
    this.#socket = socket;
    this.#target = target;
    const qtype = spec.qtype ?? 'A';
    this.#types =
      qtype === 'both'
        ? [DNS_TYPES.A, DNS_TYPES.AAAA]
        : [qtype === 'A' ? DNS_TYPES.A : DNS_TYPES.AAAA];
    socket.on('message', (reply) => {
      if (reply.length < 4) return;
      const rcode = reply.readUInt16BE(2) & 0xf;
      if (rcode === DNS_RCODES.NOERROR) this.#answered += 1;
      else if (rcode === DNS_RCODES.REFUSED) this.#refused += 1;
      else this.#other += 1;
    });
    socket.on('error', () => undefined);
    this.#timer = setInterval(() => {
      this.#tick();
    }, 5);
  }

  /** `avoid`: every server's port, which this client must not hold while one is dead (F4). */
  static async start(
    spec: DnsClientSpec,
    server: Server,
    avoid: readonly number[],
  ): Promise<Background> {
    const source = spec.source ?? '127.0.0.1';
    const v6 = isIPv6(source);
    const socket = await avoidingPorts(
      () => bindUdp(v6 ? 'udp6' : 'udp4', source, 0),
      (bound) => bound.address().port,
      closeUdp,
      avoid,
    );
    portClasses.set(socket.address().port, spec.name);
    return new Background(spec, socket, {
      address: v6 ? '::1' : server.address,
      port: server.port,
    });
  }

  get port(): number {
    return this.#socket.address().port;
  }

  #tick(): void {
    const due = Math.floor(
      ((performance.now() - this.#startedAt) * this.spec.ratePerSecond) / 1_000,
    );
    while (this.#sent < due && this.spec.qnames.length > 0) {
      const name =
        this.spec.qnames[Math.floor(this.#sent / this.#types.length) % this.spec.qnames.length];
      const type = this.#types[this.#sent % this.#types.length];
      if (name === undefined || type === undefined) return;
      this.#nextId = (this.#nextId + 1) & 0xffff;
      this.#socket.send(
        encodeQuery({ id: this.#nextId, name, type }),
        this.#target.port,
        this.#target.address,
      );
      this.#sent += 1;
    }
  }

  stats(): DnsClientStats {
    const replies = this.#answered + this.#refused + this.#other;
    return {
      name: this.spec.name,
      port: this.port,
      sent: this.#sent,
      answered: this.#answered,
      refused: this.#refused,
      otherRcodes: this.#other,
      unanswered: Math.max(0, this.#sent - replies),
    };
  }

  async stop(): Promise<DnsClientStats> {
    clearInterval(this.#timer);
    const stats = this.stats();
    await closeUdp(this.#socket);
    return stats;
  }
}

const servers: Server[] = (options.servers ?? [{ name: 'ns1' }]).map((spec) => new Server(spec));
const clients = new Map<string, Background>();

function serverNamed(name: string | undefined): Server {
  const found = name === undefined ? servers[0] : servers.find((server) => server.name === name);
  if (found === undefined) throw new Error(`there is no server ${name ?? ''}`);
  return found;
}

const each = (name: string | undefined): Server[] =>
  name === undefined ? servers : [serverNamed(name)];

const result = <K extends keyof DnsControlResults>(
  _op: K,
  value: DnsControlResults[K],
): DnsControlResults[K] => value;

async function handle(request: DnsControl): Promise<unknown> {
  switch (request.op) {
    case 'set': {
      const layer = request.server === undefined ? shared : serverNamed(request.server).layer;
      layer.set(request.target, request.behaviour);
      for (const server of each(request.server)) server.changed(request.target);
      return result('set', null);
    }
    case 'setDead':
      await serverNamed(request.server).setDead(request.dead);
      return result('setDead', null);
    case 'advance':
      if (!manual) throw new Error('advance needs the manual clock');
      if (request.ms < 0) throw new Error('the clock does not go back');
      manualNow += request.ms;
      return result('advance', manualNow);
    case 'now':
      return result('now', now());
    case 'prime':
      serverNamed(request.server).prime(request.entries);
      return result('prime', null);
    case 'flush':
      for (const server of each(request.server)) server.flush(request.name);
      return result('flush', null);
    case 'tagPort':
      if (request.portClass === undefined) portClasses.delete(request.port);
      else portClasses.set(request.port, request.portClass);
      return result('tagPort', null);
    case 'occupy':
      serverNamed(request.server).occupy(request.count);
      return result('occupy', null);
    case 'release':
      serverNamed(request.server).release();
      return result('release', null);
    case 'startClient': {
      if (clients.has(request.spec.name))
        throw new Error(`a client ${request.spec.name} runs already`);
      const client = await Background.start(request.spec, serverNamed(request.spec.server), [
        ...servers.map((server) => server.port),
        ...(request.spec.avoid ?? []),
      ]);
      clients.set(request.spec.name, client);
      return result('startClient', client.port);
    }
    case 'stopClient': {
      const client = clients.get(request.name);
      if (client === undefined) throw new Error(`there is no client ${request.name}`);
      clients.delete(request.name);
      return result('stopClient', await client.stop());
    }
    case 'clients':
      return result(
        'clients',
        [...clients.values()].map((client) => client.stats()),
      );
    case 'log': {
      const since = request.since ?? 0;
      const entries = log.filter(
        (entry) =>
          entry.seq > since && (request.server === undefined || entry.server === request.server),
      );
      return result('log', { entries, dropped: logDropped });
    }
    case 'clearLog':
      log.length = 0;
      return result('clearLog', null);
    case 'held':
      return result(
        'held',
        each(request.server).flatMap((server) => server.held()),
      );
    case 'gauge':
      return result(
        'gauge',
        each(request.server).map((server) => server.gauge(request.resetPeak === true)),
      );
    case 'answer': {
      const qtype = request.qtype === undefined ? undefined : typeCode(request.qtype);
      let answered = 0;
      for (const server of each(request.server)) {
        answered += server.answer(request.qname, request.reply, qtype);
      }
      return result('answer', answered);
    }
    case 'trips':
      return result(
        'trips',
        trips.filter((trip) => request.server === undefined || trip.server === request.server),
      );
    case 'stop':
      await Promise.all([...clients.values()].map((client) => client.stop()));
      clients.clear();
      for (const server of servers) server.stop();
      await Promise.all(servers.map((server) => server.unbind()));
      return result('stop', null);
  }
}

const post = (message: DnsWorkerMessage): void => {
  control.postMessage(message);
};

control.on('message', (message: { readonly id: number; readonly control: DnsControl }) => {
  handle(message.control).then(
    (value) => {
      post({ t: 'result', id: message.id, ok: true, value });
    },
    (error: unknown) => {
      post({
        t: 'result',
        id: message.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
});

try {
  const names = new Set(servers.map((server) => server.name));
  if (names.size !== servers.length) throw new Error('two servers have the same name');
  // Every server binds before any lets go, so no sibling can draw a refused server's port (L1).
  for (const server of servers) await server.bind(server.fixedPort);
  for (const server of servers) {
    // A server that starts refused keeps its port number and binds nothing (ECONNREFUSED).
    if (server.dead === 'refused') await server.unbind();
  }
  post({ t: 'ready', servers: servers.map((server) => server.info()) });
} catch (error) {
  await Promise.all(servers.map((server) => server.unbind()));
  post({ t: 'failed', message: error instanceof Error ? error.message : String(error) });
}
