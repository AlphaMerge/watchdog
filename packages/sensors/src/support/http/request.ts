import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import { refuses, type TargetPolicy } from '@ms/shared';
import type { CheckTarget } from '../../contract.js';
import {
  isCredentialsWithheld,
  pinnedLookup,
  pinnedPeerRefusal,
  type PinnedAddress,
} from '../pinned-target.js';

/**
 * One HTTP request, shared by every HTTP sensor type (`P-09`, `T-13`, `T-14`).
 *
 * Extracted the moment there were three callers rather than guessed at with one: `http.request`
 * wants the timings, `http.advanced` adds headers and authentication, `http.content` reads the
 * body. They differ in what they ask for and what they do with the answer, and not at all in how
 * the request is made — which is the part with the redirect rules, the two timings and the bound
 * on how much of a response is kept.
 */

export interface HttpRequestOptions {
  readonly host: string;
  readonly port: number;
  readonly scheme: 'http' | 'https';
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly verifyTls: boolean;
  readonly followRedirects: boolean;
  readonly maxRedirects: number;
  /**
   * How much of the body to keep, in bytes. **Zero keeps none of it and still counts it all.**
   *
   * That distinction is the whole reason this is a parameter: a status-and-timing sensor has no
   * use for the body but does want its size, and buffering an accidental multi-gigabyte download
   * in a worker shared by hundreds of sensors would take all of them down. A content sensor
   * needs the text and bounds how much.
   */
  readonly maxBodyBytes: number;
  /**
   * A cookie jar, read before each request and updated from each response — **including the
   * redirect hops** (`T-15`).
   *
   * That is why it lives here rather than in the transaction sensor that wants it. A login is a
   * POST that answers 302 with a `Set-Cookie` and expects the very next request to carry it; a
   * jar applied only between *steps* would send the session cookie one request too late, and the
   * dashboard would come back as the login page with a perfectly healthy 200 on it.
   *
   * Absent for every other sensor, which want each scan to stand alone.
   */
  readonly cookies?: Map<string, string>;
  /**
   * What this sensor is allowed to reach (`A-09`).
   *
   * **Defaults to `link-local`, and the default is the point.** A monitoring system fetches URLs
   * inside the network it watches — that is the job — so a guard that blocked private addresses
   * would make the HTTP sensor useless and be turned off within the hour. What it blocks is the
   * one range that is never a legitimate monitoring target and is a known credential-theft
   * vector: `169.254.169.254` and its IPv6 equivalents, where every cloud provider parks the
   * instance-metadata service that hands out IAM credentials to anything that asks.
   *
   * An HTTP sensor is a better vector for that than a webhook, because the *response* is stored
   * and rendered — so the credentials end up on a dashboard rather than merely in flight.
   */
  readonly targetPolicy?: TargetPolicy;
  /**
   * The address every connection of this request goes to, in place of resolving `host`
   * (`A-41c`): the one checked against the credential set's targets.
   *
   * Handed to the socket as its `lookup`, so `host` is still what is sent as SNI and as `Host`
   * and what the certificate is checked against. Redirects are followed only on this host, so
   * each hop goes to the same address. Nothing here resolves `host` when this is set, the
   * `targetPolicy` guard included: it checks this address instead.
   */
  readonly pinned?: PinnedAddress;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** Bytes the body actually was, whether or not any were kept. */
  readonly size: number;
  /** As much of the body as `maxBodyBytes` allowed. Empty when it was zero. */
  readonly body: string;
  readonly redirects: number;
  readonly totalMs: number;
  readonly timeToFirstByteMs: number;
  /** The path finally requested, which differs from the first when redirects were followed. */
  readonly finalPath: string;
  /** A `Location` that was *not* followed, so a caller can say where it pointed. */
  readonly unfollowedLocation: string | null;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Refuses a host whose addresses the policy blocks.
 *
 * A literal address needs no resolution and is checked directly; a name is resolved and *every*
 * address it answers with is checked, because a name with an A record inside the network and one
 * pointing at metadata is refused on the second.
 */
async function refuseBlockedTarget(
  host: string,
  policy: TargetPolicy,
  pinned: PinnedAddress | undefined,
): Promise<void> {
  if (policy === 'none') return;

  let addresses: string[];
  // A pinned request goes to one address and resolves nothing (`A-41c`), so that address is the
  // whole of what there is to check, and a second lookup here would be the one nobody checked.
  if (pinned !== undefined) {
    addresses = [pinned.address];
  } else {
    try {
      const resolved = await dnsLookup(host, { all: true });
      addresses = resolved.map((entry) => entry.address);
    } catch {
      // Not this guard's business: a name that will not resolve is the request's own failure,
      // and reporting it here would replace a diagnosis the caller already produces with a
      // worse one.
      return;
    }
  }

  for (const address of addresses) {
    const reason = refuses(policy, address);
    if (reason !== null) {
      throw new Error(
        `refusing to request ${host}: it resolves to ${address}, which is ${reason} — ` +
          'this range is where cloud instance-metadata services live',
      );
    }
  }
}

export async function fetchHttp(
  options: HttpRequestOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const started = process.hrtime.bigint();
  // A holder rather than a bare `let`: it is assigned inside the response callback, which the
  // checker cannot see running, so a plain variable stays narrowed and the comparison below
  // reads as always-true.
  const timing: { firstByteAt?: bigint } = {};

  let path = options.path;
  // A 302 turns a POST into a GET, which is what every browser and `curl -L` do — see RFC 7231
  // §6.4.3, which permits it "for historical reasons" and then describes what everybody actually
  // implements. `T-15` is what surfaced this: a login is a POST that answers 302, and re-sending
  // the form body to the dashboard is a request no application expects. 307 and 308 exist
  // precisely to say "do not do that", so they preserve both.
  let method = options.method;
  let body = options.body;
  // **Checked before the first byte leaves, and the addresses are the thing checked, not the
  // name.** A guard that inspected the hostname would be defeated by any name that resolves to a
  // blocked address, which is a DNS record away.
  const pinned = options.pinned;
  await refuseBlockedTarget(options.host, options.targetPolicy ?? 'link-local', pinned);

  let redirects = 0;
  let size = 0;
  let kept = '';
  let status = 0;
  let headers: IncomingHttpHeaders = {};
  let unfollowed: string | null = null;

  for (;;) {
    const send = options.scheme === 'https' ? httpsRequest : httpRequest;
    const outcome = await new Promise<{ status: number; headers: IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = send(
          {
            host: options.host,
            port: options.port,
            path,
            method,
            signal,
            // **The checked address, answered to the socket's own lookup** (`A-41c`). `host`
            // above stays the name, so it is what `Host` carries, what SNI sends and what the
            // certificate is checked against; only where the bytes go comes from the pin. No
            // agent: one would be free to connect somewhere else on this request's behalf.
            ...(pinned === undefined
              ? {}
              : { lookup: pinnedLookup(options.host, pinned), agent: false as const }),
            ...(options.scheme === 'https'
              ? { rejectUnauthorized: options.verifyTls, servername: options.host }
              : {}),
            headers: {
              accept: '*/*',
              // No keep-alive: a pooled connection would make the connect time these sensors
              // measure depend on whether the last scan happened to leave one open.
              connection: 'close',
              ...(options.cookies === undefined || options.cookies.size === 0
                ? {}
                : { cookie: cookieHeader(options.cookies) }),
              ...options.headers,
              ...(body === '' ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
            },
          },
          (res) => {
            // The far end has to be the address that was checked (`A-41c`). It cannot be
            // anything else through the lookup above; an answer from anywhere else is not used.
            if (pinned !== undefined) {
              const refusal = pinnedPeerRefusal(options.host, pinned, res.socket.remoteAddress);
              if (refusal !== null) {
                req.destroy(refusal);
                reject(refusal);
                return;
              }
            }
            timing.firstByteAt ??= process.hrtime.bigint();
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (kept.length < options.maxBodyBytes) {
                kept += chunk.toString('utf8').slice(0, options.maxBodyBytes - kept.length);
              }
            });
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, headers: res.headers });
            });
            res.on('error', reject);
          },
        );

        req.setTimeout(options.timeoutMs, () => {
          req.destroy(
            new Error(
              `${options.scheme}://${options.host}:${String(options.port)}${path} did not answer ` +
                `within ${String(options.timeoutMs)} ms`,
            ),
          );
        });
        req.on('error', reject);
        if (body !== '') req.write(body);
        req.end();
      },
    ).catch((error: unknown) => {
      throw describeFailure(error, options, path);
    });

    status = outcome.status;
    headers = outcome.headers;
    if (options.cookies !== undefined) absorbCookies(options.cookies, headers['set-cookie']);
    const location = typeof headers.location === 'string' ? headers.location : null;

    const redirecting = status >= 300 && status < 400 && location !== null;
    if (!options.followRedirects || !redirecting) {
      unfollowed = redirecting ? location : null;
      break;
    }
    if (redirects >= options.maxRedirects) {
      throw new Error(
        `${options.host} redirected more than ${String(options.maxRedirects)} times from ` +
          `${options.path} — the last pointed at ${location}, which is usually a ` +
          'redirect loop',
      );
    }

    const next = resolveRedirect(location, options.host, options.scheme, options.port);
    if (next === null) {
      // Deliberately not followed. Reported as the reading rather than chased, because a reading
      // taken somewhere else is not a reading about this device.
      unfollowed = location;
      break;
    }
    path = next;
    redirects += 1;
    if (status !== 307 && status !== 308 && method !== 'HEAD') {
      method = 'GET';
      body = '';
    }
    // A redirect's body is not the body anybody asked about.
    kept = '';
    size = 0;
  }

  const totalMs = round(Number(process.hrtime.bigint() - started) / 1e6);
  return {
    status,
    headers,
    size,
    body: kept,
    redirects,
    totalMs,
    timeToFirstByteMs:
      timing.firstByteAt === undefined
        ? totalMs
        : round(Number(timing.firstByteAt - started) / 1e6),
    finalPath: path,
    unfollowedLocation: unfollowed,
  };
}

/** What to send, in the one format every server has parsed since 1994. */
function cookieHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Merges `Set-Cookie` into the jar.
 *
 * Only the name and the value: paths, domains and `Secure` are a browser's job, and a sensor
 * talking to one host over one scheme has nothing to decide. Expiry is honoured *only* as
 * deletion — `Max-Age=0` or an empty value — because that is a logout, and a transaction that
 * kept sending a cookie the server just cleared would test the wrong thing.
 */
function absorbCookies(jar: Map<string, string>, raw: string | string[] | undefined): void {
  if (raw === undefined) return;
  for (const line of Array.isArray(raw) ? raw : [raw]) {
    const [pair = '', ...attributes] = line.split(';');
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const cleared =
      value === '' || attributes.some((part) => /^\s*max-age\s*=\s*0*\s*$/i.test(part));
    if (cleared) jar.delete(name);
    else jar.set(name, value);
  }
}

/**
 * Whether this status is the one the sensor is watching for.
 *
 * Empty means "any 2xx", plus 3xx when redirects are not being followed — an unfollowed redirect
 * is the server answering correctly, and calling it a failure would make "check that this still
 * redirects" impossible to express.
 */
export function statusAccepted(status: number, expect: string, following: boolean): boolean {
  if (expect === '') {
    if (status >= 200 && status < 300) return true;
    return !following && status >= 300 && status < 400;
  }
  const range = /^([1-5][0-9]{2})-([1-5][0-9]{2})$/.exec(expect);
  if (range !== null) return status >= Number(range[1]) && status <= Number(range[2]);
  if (/^[1-5]xx$/i.test(expect)) return Math.floor(status / 100) === Number(expect[0]);
  return status === Number(expect);
}

/**
 * The path to follow a redirect to, or null when it leaves this device.
 *
 * Null is not a failure and not an oversight: following a redirect to another host means the
 * next reading is about that host, under a sensor named for this one, with nothing on the graph
 * saying the subject changed.
 */
export function resolveRedirect(
  location: string | null,
  host: string,
  scheme: string,
  port: number,
): string | null {
  if (location === null || location.trim() === '') return null;
  const target = location.trim();
  if (target.startsWith('/')) return target;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    // A relative path with no leading slash. Rare and legal; treated as root-relative, which is
    // what every browser does with one.
    return `/${target}`;
  }
  if (url.hostname.toLowerCase() !== host.toLowerCase()) return null;
  // A scheme or port change is still this device, but it is not this *sensor* — it would be
  // measuring a different listener, so it is reported rather than followed.
  if (url.protocol !== `${scheme}:`) return null;
  const targetPort = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (targetPort !== port) return null;
  return `${url.pathname}${url.search}`;
}

/** Turns a socket or TLS failure into something that names the cause. */
function describeFailure(error: unknown, options: HttpRequestOptions, path: string): Error {
  // A refusal over where the credentials may go is not a failure of the request (`A-41c`): it
  // keeps its class, which is what makes the sensor read Unknown rather than Down.
  if (isCredentialsWithheld(error)) return error;
  const where = `${options.scheme}://${options.host}:${String(options.port)}${path}`;
  const code = (error as NodeJS.ErrnoException).code ?? '';
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'ABORT_ERR') return new Error(`the check was cancelled while requesting ${where}`);
  if (code === 'ECONNREFUSED') return new Error(`nothing is listening at ${where}`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(`the device’s host name did not resolve, requesting ${where}`);
  }
  if (code === 'CERT_HAS_EXPIRED') return new Error(`the certificate at ${where} has expired`);
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return new Error(
      `the certificate at ${where} is self-signed and this sensor verifies certificates — turn ` +
        'that off if it is meant to be, or use a TLS Certificate sensor to watch it properly',
    );
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new Error(`the certificate at ${where} is not valid for ${options.host}`);
  }
  if (options.verifyTls && code.startsWith('UNABLE_TO_')) {
    return new Error(`the certificate at ${where} could not be verified: ${message}`);
  }
  return new Error(`requesting ${where} failed: ${message}`);
}

/** The parameters every HTTP sensor shares, so the three forms cannot drift apart. */
export function readCommon(
  params: Readonly<Record<string, unknown>>,
  target: CheckTarget,
): Omit<HttpRequestOptions, 'headers' | 'body' | 'method' | 'maxBodyBytes'> {
  const host = target.host;
  const text = (key: string, fallback = ''): string => {
    const value = params[key];
    return typeof value === 'string' ? value : fallback;
  };
  const scheme = text('scheme', 'https') === 'http' ? 'http' : 'https';
  const declaredPort = Number(params['port'] ?? 0);
  let path = text('path', '/');
  if (path === '' || !path.startsWith('/')) path = `/${path}`;

  return {
    host,
    port: declaredPort > 0 ? declaredPort : scheme === 'http' ? 80 : 443,
    scheme,
    path,
    timeoutMs: Number(params['timeoutMs'] ?? 10_000),
    verifyTls: params['verifyTls'] !== false,
    followRedirects: params['followRedirects'] !== false,
    maxRedirects: 5,
    // The whole target, not its host, so that no HTTP type can read one and forget the other
    // (`A-41c`): the pinned address goes wherever the host goes.
    ...(target.pinned === undefined ? {} : { pinned: target.pinned }),
  };
}
