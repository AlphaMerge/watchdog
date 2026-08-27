import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';

/**
 * One HTTP request against the device (`P-09`).
 *
 * **The host comes from the device, never from a URL in the parameters.** A sensor type that
 * asked for a whole URL would let the two disagree, which is how a device gets renamed and half
 * its sensors keep checking the old address (CLAUDE.md). So this takes a scheme, a port and a
 * path, and the host is whatever the device says it is today.
 *
 * **Two timings, because they fail differently.** Time to first byte is connect, TLS and the
 * server thinking; the total adds transferring the body. A page that got slower because a query
 * got slower moves the first, and one that got slower because it got bigger moves only the
 * second — and a single "response time" cannot tell an operator which happened.
 *
 * **The body is counted, not kept.** Size is a channel worth having — a page that suddenly
 * halves is a broken deploy — but a check runs in a worker shared by hundreds of sensors, and
 * buffering an accidental multi-gigabyte download would take all of them down with it. `T-14`
 * needs the content and can bound what it keeps; this needs only the count.
 *
 * **A redirect off this device is reported, not silently followed into.** Following one means
 * the reading is no longer about the device the sensor sits under, and nothing in the graph
 * would say so.
 */

/** Redirect hops. Five is more than any sane site and short enough to notice a loop. */
const MAX_REDIRECTS = 5;

export const httpRequest: SensorType = {
  // Dotted, as the catalogue requires: `T-13`…`T-16` add `http.advanced`, `http.content` and
  // `http.transaction` beside it.
  id: 'http.request',
  category: 'Web',
  costHint: 'medium',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scheme: { enum: ['http', 'https'], default: 'https', title: 'Scheme' },
      port: {
        type: 'integer',
        minimum: 0,
        maximum: 65_535,
        default: 0,
        title: 'Port',
        description: 'Zero uses the scheme’s own — 80 for http, 443 for https.',
      },
      path: {
        type: 'string',
        maxLength: 2_048,
        default: '/',
        title: 'Path',
        description:
          'The path and query, starting with a slash. Point it at something cheap that still ' +
          'proves the application works — a health endpoint that touches the database beats the ' +
          'front page, which a cache can serve long after the application has stopped.',
      },
      method: {
        enum: ['GET', 'HEAD', 'POST'],
        default: 'GET',
        title: 'Method',
        description:
          'HEAD is the cheapest and gives no size to measure. POST sends the body below.',
      },
      body: {
        type: 'string',
        maxLength: 8_192,
        default: '',
        title: 'Request body',
        description: 'For POST. Sent as-is; set the content type below to match it.',
      },
      contentType: {
        type: 'string',
        maxLength: 200,
        default: 'application/json',
        title: 'Content type',
        description: 'The `Content-Type` sent with a POST body.',
      },
      expectStatus: {
        type: 'string',
        maxLength: 32,
        pattern: '^$|^[1-5](?:[0-9]{2}|xx)(?:-[1-5][0-9]{2})?$',
        default: '',
        title: 'Expected status',
        description:
          'Empty accepts any 2xx, and any 3xx when redirects are not being followed. Otherwise ' +
          'an exact code (404), a class (2xx) or a range (200-204) — a sensor that is *supposed* ' +
          'to see a 401 or a 404 is a real thing to watch, and it should be Up when it does.',
      },
      followRedirects: {
        type: 'boolean',
        default: true,
        title: 'Follow redirects',
        description:
          'Up to five hops. A redirect that leaves this device is never followed whatever this ' +
          'says: the reading would stop being about the device the sensor sits under, and ' +
          'nothing on the graph would say so.',
      },
      verifyTls: {
        type: 'boolean',
        default: true,
        title: 'Verify the certificate',
        description:
          'On by default. Turning it off means the connection is encrypted against nobody in ' +
          'particular, so the sensor says so in its message on every scan rather than once here.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 300_000,
        default: 10_000,
        title: 'Timeout',
      },
      userAgent: {
        type: 'string',
        maxLength: 200,
        default: '',
        title: 'User agent',
        description:
          'Empty sends this monitoring system’s own, which is what you want in a server log ' +
          'when somebody asks who is making these requests every minute.',
      },
    },
  },

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    return [
      { key: 'responseTime', name: 'Response time', unit: 'ms', isPrimary: true },
      // Where the slowness lives. A query that got slower moves this; a page that got bigger
      // does not, and one "response time" cannot tell those apart.
      { key: 'timeToFirstByte', name: 'Time to first byte', unit: 'ms' },
      { key: 'statusCode', name: 'Status code', unit: '' },
      // HEAD has no body to measure, and a channel that is always zero is a line that never
      // says anything.
      ...(params['method'] === 'HEAD'
        ? []
        : [{ key: 'size', name: 'Response size', unit: 'B' } satisfies ChannelDef]),
      { key: 'redirects', name: 'Redirects followed', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { request: httpReq } = await import('node:http');
    const { request: httpsReq } = await import('node:https');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to request');

    const text = (key: string, fallback = ''): string => {
      const value = context.params[key];
      return typeof value === 'string' ? value : fallback;
    };

    const scheme = text('scheme', 'https') === 'http' ? 'http' : 'https';
    const declaredPort = Number(context.params['port'] ?? 0);
    const port = declaredPort > 0 ? declaredPort : scheme === 'http' ? 80 : 443;
    const method = ['HEAD', 'POST'].includes(text('method', 'GET')) ? text('method') : 'GET';
    const timeoutMs = Number(context.params['timeoutMs'] ?? 10_000);
    const verifyTls = context.params['verifyTls'] !== false;
    const follow = context.params['followRedirects'] !== false;
    const expect = text('expectStatus').trim();
    const userAgent = text('userAgent').trim();
    const body = text('body');

    let path = text('path', '/');
    if (path === '' || !path.startsWith('/')) path = `/${path}`;

    const started = process.hrtime.bigint();
    // A holder rather than a bare `let`: it is assigned inside the response callback, which the
    // checker cannot see running, so a plain variable stays narrowed to `null` out here and the
    // comparison below reads as always-true. Same reason `session.ts` returns its walk outcome
    // through the promise rather than through a variable.
    const timing: { firstByteAt?: bigint } = {};
    let redirects = 0;
    let size = 0;
    let status = 0;
    let location: string | null = null;

    for (;;) {
      const send = scheme === 'https' ? httpsReq : httpReq;
      const outcome = await new Promise<{ status: number; location: string | null }>(
        (resolve, reject) => {
          const req = send(
            {
              host,
              port,
              path,
              method,
              signal: context.signal,
              ...(scheme === 'https' ? { rejectUnauthorized: verifyTls, servername: host } : {}),
              headers: {
                // Sent so that whoever reads a server log at 3 a.m. can tell what is making a
                // request every sixty seconds.
                'user-agent': userAgent === '' ? 'MonitoringSystem/1.0 (+sensor)' : userAgent,
                accept: '*/*',
                // No keep-alive: a pooled connection would make the connect time this sensor
                // measures depend on whether the last scan happened to leave one open.
                connection: 'close',
                ...(method === 'POST'
                  ? {
                      'content-type': text('contentType', 'application/json'),
                      'content-length': String(Buffer.byteLength(body)),
                    }
                  : {}),
              },
            },
            (res) => {
              timing.firstByteAt ??= process.hrtime.bigint();
              // Counted, never accumulated: an accidental multi-gigabyte download must not take
              // down a worker shared by hundreds of sensors.
              res.on('data', (chunk: Buffer) => {
                size += chunk.length;
              });
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  location: res.headers.location ?? null,
                });
              });
              res.on('error', reject);
            },
          );

          req.setTimeout(timeoutMs, () => {
            req.destroy(
              new Error(
                `${scheme}://${host}:${String(port)}${path} did not answer within ` +
                  `${String(timeoutMs)} ms`,
              ),
            );
          });
          req.on('error', reject);
          if (method === 'POST' && body !== '') req.write(body);
          req.end();
        },
      ).catch((error: unknown) => {
        throw describeFailure(error, scheme, host, port, path, verifyTls);
      });

      status = outcome.status;
      location = outcome.location;

      const redirecting = status >= 300 && status < 400 && location !== null;
      if (!follow || !redirecting) break;

      if (redirects >= MAX_REDIRECTS) {
        throw new Error(
          `${host} redirected more than ${String(MAX_REDIRECTS)} times from ${path} — the last ` +
            `pointed at ${location ?? 'nowhere'}, which is usually a redirect loop`,
        );
      }

      const next = resolveRedirect(location, host, scheme, port);
      if (next === null) {
        // Deliberately not followed. Reported as the reading rather than chased, because a
        // reading taken somewhere else is not a reading about this device.
        break;
      }
      path = next;
      redirects += 1;
    }

    const totalMs = round(Number(process.hrtime.bigint() - started) / 1e6);
    const ttfbMs =
      timing.firstByteAt === undefined
        ? totalMs
        : round(Number(timing.firstByteAt - started) / 1e6);

    if (!statusAccepted(status, expect, follow)) {
      throw new Error(
        `${scheme}://${host}:${String(port)}${path} answered ${String(status)}` +
          (expect === '' ? '' : `, and this sensor expects ${expect}`) +
          (location === null ? '' : ` (it points at ${location})`),
      );
    }

    const notes: string[] = [];
    if (!verifyTls && scheme === 'https') {
      // Said on every scan rather than once at configuration time: a connection encrypted
      // against nobody in particular is a standing decision, and this is where it stays visible.
      notes.push('the certificate is not being verified');
    }
    if (redirects > 0)
      notes.push(`after ${String(redirects)} redirect${redirects === 1 ? '' : 's'}`);
    if (status >= 300 && status < 400 && location !== null && follow) {
      notes.push(`it redirects to ${location}, which is off this device and was not followed`);
    }

    return {
      channels: [
        { key: 'responseTime', value: totalMs },
        { key: 'timeToFirstByte', value: ttfbMs },
        { key: 'statusCode', value: status },
        ...(method === 'HEAD' ? [] : [{ key: 'size', value: size }]),
        { key: 'redirects', value: redirects },
      ],
      message: [
        `${String(status)} in ${String(totalMs)} ms (${String(ttfbMs)} ms to first byte` +
          (method === 'HEAD' ? ')' : `, ${String(size)} bytes)`),
        ...notes,
      ].join('; '),
    };
  },
};

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Whether this status is the one the sensor is watching for.
 *
 * Empty means "any 2xx", plus 3xx when redirects are not being followed — an unfollowed
 * redirect is the server answering correctly, and calling it a failure would make "check that
 * this still redirects" impossible to express.
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
function describeFailure(
  error: unknown,
  scheme: string,
  host: string,
  port: number,
  path: string,
  verifyTls: boolean,
): Error {
  const where = `${scheme}://${host}:${String(port)}${path}`;
  const code = (error as NodeJS.ErrnoException).code ?? '';
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'ABORT_ERR') return new Error(`the check was cancelled while requesting ${where}`);
  if (code === 'ECONNREFUSED') return new Error(`nothing is listening at ${where}`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(`the device’s host name did not resolve, requesting ${where}`);
  }
  if (code === 'CERT_HAS_EXPIRED') {
    return new Error(`the certificate at ${where} has expired`);
  }
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return new Error(
      `the certificate at ${where} is self-signed and this sensor verifies certificates — turn ` +
        'that off if it is meant to be, or use a TLS Certificate sensor to watch it properly',
    );
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new Error(`the certificate at ${where} is not valid for ${host}`);
  }
  if (verifyTls && code.startsWith('UNABLE_TO_')) {
    return new Error(`the certificate at ${where} could not be verified: ${message}`);
  }
  return new Error(`requesting ${where} failed: ${message}`);
}
