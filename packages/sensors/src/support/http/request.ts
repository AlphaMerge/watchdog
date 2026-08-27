import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

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
  let redirects = 0;
  let size = 0;
  let body = '';
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
            method: options.method,
            signal,
            ...(options.scheme === 'https'
              ? { rejectUnauthorized: options.verifyTls, servername: options.host }
              : {}),
            headers: {
              accept: '*/*',
              // No keep-alive: a pooled connection would make the connect time these sensors
              // measure depend on whether the last scan happened to leave one open.
              connection: 'close',
              ...options.headers,
              ...(options.body === ''
                ? {}
                : { 'content-length': String(Buffer.byteLength(options.body)) }),
            },
          },
          (res) => {
            timing.firstByteAt ??= process.hrtime.bigint();
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (body.length < options.maxBodyBytes) {
                body += chunk.toString('utf8').slice(0, options.maxBodyBytes - body.length);
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
        if (options.body !== '') req.write(options.body);
        req.end();
      },
    ).catch((error: unknown) => {
      throw describeFailure(error, options, path);
    });

    status = outcome.status;
    headers = outcome.headers;
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
    // A redirect's body is not the body anybody asked about.
    body = '';
    size = 0;
  }

  const totalMs = round(Number(process.hrtime.bigint() - started) / 1e6);
  return {
    status,
    headers,
    size,
    body,
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
  host: string,
): Omit<HttpRequestOptions, 'headers' | 'body' | 'method' | 'maxBodyBytes'> {
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
  };
}
