import { connect, type Socket } from 'node:net';
import {
  classify,
  IDENTIFY_PORTS,
  type Evidence,
  type Fingerprint,
  type OpenPort,
  type TargetPolicy,
} from '@ms/shared';
import { checkedTarget, TargetRefusedError, type ResolveHost } from '@ms/sensors';

/**
 * What one address is (`D-02`).
 *
 * **Collecting only.** Every conclusion is drawn by `classify` in `@ms/shared`, which is pure and
 * has the tests; this file opens sockets. The split is not tidiness — a classifier that could
 * only be exercised by pointing it at a network would be a classifier nobody could change safely,
 * and it is the half where a wrong answer costs an operator a whole sensor set.
 *
 * **Four sources, and the order matters for cost rather than for quality.** Reverse DNS and the
 * port probes run together and cost almost nothing; SNMP costs one UDP round trip and is asked
 * of everything, because it is the single most informative answer available and a host that has
 * no agent simply times out. The SSH banner and the HTTP header are read from ports already
 * found open, so they cost nothing extra.
 *
 * **Nothing here authenticates.** Identification runs before an operator has told the system
 * anything about a host, so it uses what is public: a PTR record, a TCP handshake, a banner a
 * service volunteers, and — for SNMP — the community an operator configured on the run, which is
 * the one credential it has. A host that refuses all of that is reported as it is, with `unknown`
 * and the evidence that led there.
 *
 * **Held to the probe's target policy** (`A-63`), as every sensor that connects is (`A-57`). The
 * address goes through `checkedTarget` once, before any source is asked, and one the policy
 * refuses is sent nothing at all: no SNMP get, no TCP connect, no PTR query about it. What comes
 * back says so in `refused`, which is a different answer from a host that said nothing. The ping
 * that found the address is outside the policy on purpose (`ping-probe.ts`): an echo carries no
 * credential and brings back no content, where a community string is a credential and a banner
 * is content.
 */

export interface IdentifyOptions {
  /** How long each individual probe waits. Applied per source, not to the whole host. */
  readonly timeoutMs: number;
  /** The SNMP community to try, or empty to skip SNMP entirely. */
  readonly community: string;
  /** Ports to try, defaulting to the bounded list in `@ms/shared`. */
  readonly ports?: readonly number[];
  /** `probe.targetPolicy`. Absent, the default (`link-local`), as it is for a check. */
  readonly policy?: TargetPolicy;
}

export interface IdentifyDeps {
  /** The PTR record for an address, or null. Injected so the tests need no resolver. */
  readonly reverseLookup: (address: string, timeoutMs: number) => Promise<string | null>;
  /** sysDescr, sysObjectID and sysName, or null when nothing answered. */
  readonly snmpSystem: (
    address: string,
    community: string,
    timeoutMs: number,
  ) => Promise<{ sysDescr?: string; sysObjectId?: string; sysName?: string } | null>;
  /** Whether a TCP port accepts, and the first thing it says if it says anything unprompted. */
  readonly tcpProbe?: (
    address: string,
    port: number,
    timeoutMs: number,
  ) => Promise<OpenPort | null>;
  /** The `Server` header of an HTTP response, or null. */
  readonly httpServer?: (
    address: string,
    port: number,
    timeoutMs: number,
  ) => Promise<string | null>;
  /** What resolves a target given as a name. Absent, the system's resolver. */
  readonly resolve?: ResolveHost;
}

/** A lookup here is ended by its own bound, like every source: nothing cancels one host. */
const NEVER_ABORTED = new AbortController().signal;

/**
 * Where the sources may connect, or the refusal.
 *
 * **One lookup a target, and for most targets none**: a discovery run walks a range, so its
 * targets are addresses, and an address is checked as it stands and resolved by nobody. A name
 * is resolved once, every answer is checked, and the sources are handed the first address
 * rather than the name, so nothing resolves it a second time and is answered differently.
 */
async function whereToConnect(
  address: string,
  options: IdentifyOptions,
  deps: IdentifyDeps,
): Promise<{ connectTo: string } | { refused: string } | null> {
  try {
    const checked = await checkedTarget({
      host: address,
      // Every source speaks IPv4 (`family: 4`, `ipVersion: 'v4'`), so that is what is asked for.
      family: 4,
      timeoutMs: options.timeoutMs,
      signal: NEVER_ABORTED,
      verb: 'identify',
      doing: `identifying ${address}`,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(deps.resolve === undefined ? {} : { resolve: deps.resolve }),
    });
    return { connectTo: checked?.addresses[0]?.address ?? address };
  } catch (error) {
    if (error instanceof TargetRefusedError) return { refused: `not identified: ${error.message}` };
    // A name that did not resolve: there is nowhere to connect, and that is a host that said
    // nothing, as a source that fails is.
    return null;
  }
}

/** Identifies one address. Never throws: an unidentifiable host is a result, not a failure. */
export async function identify(
  target: string,
  options: IdentifyOptions,
  deps: IdentifyDeps,
): Promise<Fingerprint> {
  const tcp = deps.tcpProbe ?? probeTcp;
  const http = deps.httpServer ?? readHttpServer;
  const wanted = options.ports ?? IDENTIFY_PORTS.map((one) => one.port);

  const where = await whereToConnect(target, options, deps);
  if (where === null) return classify({ address: target, ports: [] });
  if ('refused' in where) {
    // In `evidence` as well as in its own field: a core built before the field shows an
    // operator the evidence, and the reason must not depend on which core reads it.
    return {
      ...classify({ address: target, ports: [] }),
      evidence: [where.refused],
      refused: where.refused,
    };
  }
  const address = where.connectTo;

  // All at once. Twelve ports plus a PTR plus an SNMP get, run in series at a one-second
  // timeout, is fourteen seconds a host — which on a /24 of two hundred hosts is nearly an hour
  // for something a network answers in a moment.
  const [reverseName, snmp, openPorts] = await Promise.all([
    settle(deps.reverseLookup(address, options.timeoutMs), null),
    options.community === ''
      ? Promise.resolve(null)
      : settle(deps.snmpSystem(address, options.community, options.timeoutMs), null),
    Promise.all(wanted.map((port) => settle(tcp(address, port, options.timeoutMs), null))).then(
      (found) => found.filter((one): one is OpenPort => one !== null),
    ),
  ]);

  // Read from ports already found open, so they cost nothing extra.
  const web = openPorts.find((one) => one.port === 80 || one.port === 443);
  const httpServer =
    web === undefined ? null : await settle(http(address, web.port, options.timeoutMs), null);

  const evidence: Evidence = {
    address: target,
    ports: openPorts,
    ...(reverseName === null ? {} : { reverseName }),
    ...(snmp?.sysDescr === undefined ? {} : { sysDescr: snmp.sysDescr }),
    ...(snmp?.sysObjectId === undefined ? {} : { sysObjectId: snmp.sysObjectId }),
    ...(snmp?.sysName === undefined ? {} : { sysName: snmp.sysName }),
    ...(httpServer === null ? {} : { httpServer }),
  };
  return classify(evidence);
}

/**
 * A source that fails is a source that said nothing.
 *
 * **The whole error policy of identification, in one function.** A refused connection, a
 * resolver with no PTR zone and a host that ignores SNMP are all ordinary and all mean "this
 * told me nothing" — and a run that failed a host because one of a dozen probes threw would
 * report an estate as unidentifiable on the strength of a firewall rule.
 */
async function settle<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

/**
 * Whether a TCP port accepts, and what it volunteers.
 *
 * **A connect, and then a short listen — not a scan.** Half-open SYN scanning is faster and needs
 * a raw socket, which is the privilege `ADR-001` decided the default path would not require; it
 * is also what makes a tool look like an attacker to an intrusion-detection system. A completed
 * handshake followed by a clean close is what any client does.
 *
 * The listen is what gets the SSH version string, which is the best single piece of evidence
 * about a Unix host and arrives unprompted within milliseconds. Nothing is ever *sent*: a probe
 * that spoke first would be guessing at a protocol, and guessing wrong on a serial-console
 * server or a printer is how a discovery run reboots something.
 */
async function probeTcp(
  address: string,
  port: number,
  timeoutMs: number,
): Promise<OpenPort | null> {
  return new Promise<OpenPort | null>((resolve) => {
    let socket: Socket | null = null;
    let banner = '';
    let settled = false;

    const finish = (result: OpenPort | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      clearTimeout(listen);
      socket?.destroy();
      resolve(result);
    };

    const overall = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    // How long an open port is given to volunteer something. Short: SSH sends its version on
    // connect, and everything that does not is not going to.
    let listen: NodeJS.Timeout = setTimeout(() => undefined, 0);
    clearTimeout(listen);

    socket = connect({ host: address, port, family: 4 });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      listen = setTimeout(
        () => {
          finish({ port, transport: 'tcp', ...(banner === '' ? {} : { banner }) });
        },
        Math.min(300, timeoutMs),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      banner += chunk.toString('utf8').slice(0, 200);
      if (banner.includes('\n')) {
        finish({ port, transport: 'tcp', banner: printable(banner.split('\n')[0] ?? '') });
      }
    });
    socket.on('timeout', () => {
      finish(null);
    });
    socket.on('error', () => {
      finish(null);
    });
    socket.on('close', () => {
      finish(null);
    });
  });
}

/**
 * The `Server` header, from a plain HTTP request.
 *
 * `HEAD /` rather than `GET /`, because the header is all that is wanted and a management
 * interface's home page can be a megabyte of JavaScript. Written by hand rather than through
 * `fetch` because this runs against an address, not a name: TLS on 443 would fail its hostname
 * check against every device in the estate, so the request is unencrypted on 80 and skipped on
 * 443 — a `Server` header is not worth a certificate exception.
 */
async function readHttpServer(
  address: string,
  port: number,
  timeoutMs: number,
): Promise<string | null> {
  if (port !== 80) return null;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let received = '';
    const socket = connect({ host: address, port, family: 4 });

    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.write(`HEAD / HTTP/1.0\r\nHost: ${address}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      // Bounded: a device that answers with a megabyte of headers is not one to keep reading.
      if (received.length > 8_192 || received.includes('\r\n\r\n')) {
        finish(serverHeaderOf(received));
      }
    });
    socket.on('timeout', () => {
      finish(null);
    });
    socket.on('error', () => {
      finish(null);
    });
    socket.on('close', () => {
      finish(serverHeaderOf(received));
    });
  });
}

/**
 * A banner fit to store and to show.
 *
 * **`\u0000` is the one that matters, and it is not hypothetical.** A service that answers a
 * TCP connect with a binary protocol — measured on the development network, where an SNMP
 * simulator's port did exactly this — puts NUL bytes in the first thing it says. PostgreSQL's
 * `jsonb` cannot hold `\u0000` at all: the write fails with `22P05`, the whole batch of
 * fingerprints is lost, and every other host in it is lost with it. Every control character goes
 * for the same reason a terminal-corrupting banner in a log line does.
 *
 * A banner is *evidence*, not data anybody parses further, so replacing the unprintable parts
 * with nothing loses nothing that mattered — and a banner that was entirely binary becomes an
 * empty string, which is reported as "this port is open and said nothing intelligible".
 */
export function printable(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- the point of this function is control chars.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .trim()
      .slice(0, 200)
  );
}

/** Exported for its own test: header parsing is where a stray colon changes the answer. */
export function serverHeaderOf(response: string): string | null {
  for (const line of response.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== 'server') continue;
    // Everything after the *first* colon: `Server: Apache/2.4 (Unix) mod_ssl/2.4 OpenSSL/1.1`
    // has no further colons, but `Server: nginx: custom build` does, and splitting on every
    // colon would report `nginx` for one and `Apache/2.4 (Unix) mod_ssl/2.4 OpenSSL/1.1` for the
    // other — the same field read two different ways.
    const value = line.slice(colon + 1).trim();
    return value === '' ? null : value.slice(0, 200);
  }
  return null;
}
