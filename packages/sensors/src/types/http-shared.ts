import type { ChannelDef, CheckContext, CheckExecution, JsonSchema } from '../contract.js';
import { authorizationFor } from '../support/http/auth.js';

/**
 * What the three HTTP sensor types have in common (`P-09`, `T-13`, `T-14`).
 *
 * The schema fragment and the check preamble, for the same reason `support/snmp/check.ts` and
 * `support/ssh/check.ts` exist: three copies of "which scheme, which port, which path, how long
 * to wait, and does an unfollowed redirect count as success" is three chances for them to answer
 * it differently, and an operator who learns one HTTP sensor should not be surprised by the next.
 */

export const HTTP_COMMON_SCHEMA: Readonly<Record<string, JsonSchema>> = {
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
      'The path and query, starting with a slash. Point it at something cheap that still proves ' +
      'the application works — a health endpoint that touches the database beats the front page, ' +
      'which a cache can serve long after the application has stopped.',
  },
  expectStatus: {
    type: 'string',
    maxLength: 32,
    pattern: '^$|^[1-5](?:[0-9]{2}|xx)(?:-[1-5][0-9]{2})?$',
    default: '',
    title: 'Expected status',
    description:
      'Empty accepts any 2xx, and any 3xx when redirects are not being followed. Otherwise an ' +
      'exact code (404), a class (2xx) or a range (200-204) — a sensor that is *supposed* to see ' +
      'a 401 or a 404 is a real thing to watch, and it should be Up when it does.',
  },
  followRedirects: {
    type: 'boolean',
    default: true,
    title: 'Follow redirects',
    description:
      'Up to five hops. A redirect that leaves this device is never followed whatever this says: ' +
      'the reading would stop being about the device the sensor sits under, and nothing on the ' +
      'graph would say so.',
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
      'Empty sends this monitoring system’s own, which is what you want in a server log when ' +
      'somebody asks who is making these requests every minute.',
  },
};

/**
 * Method, body and request headers — what an *API* sensor needs on top of the common block
 * (`T-13`, shared by `T-16`).
 *
 * Separate from `HTTP_COMMON_SCHEMA` because `http.request` and `http.content` want none of it:
 * a form with fifteen fields makes the common case the hardest one to fill in.
 */
export const HTTP_REQUEST_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  method: {
    enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    default: 'GET',
    title: 'Method',
  },
  body: {
    type: 'string',
    maxLength: 16_384,
    default: '',
    title: 'Request body',
    description: 'Sent as-is. Set a Content-Type header below to match it.',
  },
  requestHeaders: {
    type: 'array',
    maxItems: 20,
    default: [],
    title: 'Request headers',
    description:
      'Sent with the request. An Authorization header does *not* belong here — set an HTTP ' +
      'credential on the device instead, so a hundred sensors against one API rotate their ' +
      'token in one place rather than a hundred.',
    items: {
      // The singular, for `U-12`'s repeating control: the fieldset is named for the
      // parameter and an entry inside it wants this.
      title: 'Header',
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200, title: 'Header' },
        value: { type: 'string', maxLength: 2_048, default: '', title: 'Value' },
      },
    },
  },
};

/**
 * The method, body and headers those parameters describe, with the device credential applied.
 *
 * The credential is the device's and inherited, so a hundred sensors against one API rotate
 * their token in one place. Absent is fine — plenty of endpoints need none.
 */
export function readRequestExtras(
  params: Readonly<Record<string, unknown>>,
  credentials: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  maxBodyBytes: number,
): HttpCheckExtras {
  const methodRaw = params['method'];
  const bodyRaw = params['body'];

  const headers: Record<string, string> = {};
  const raw = params['requestHeaders'];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
      if (name === '') continue;
      headers[name.toLowerCase()] = typeof record['value'] === 'string' ? record['value'] : '';
    }
  }

  const credential = credentials['http'];
  if (credential !== undefined) {
    const authorization = authorizationFor(credential);
    if (authorization !== null) headers['authorization'] = authorization;
  }

  return {
    method: typeof methodRaw === 'string' ? methodRaw : 'GET',
    body: typeof bodyRaw === 'string' ? bodyRaw : '',
    headers,
    maxBodyBytes,
  };
}

/** The channels every HTTP sensor reports. `withSize` is false for HEAD, which has no body. */
export function httpChannels(withSize: boolean): ChannelDef[] {
  return [
    { key: 'responseTime', name: 'Response time', unit: 'ms', isPrimary: true },
    // Where the slowness lives. A query that got slower moves this; a page that got bigger does
    // not, and one "response time" cannot tell those apart.
    { key: 'timeToFirstByte', name: 'Time to first byte', unit: 'ms' },
    { key: 'statusCode', name: 'Status code', unit: '' },
    ...(withSize ? [{ key: 'size', name: 'Response size', unit: 'B' }] : []),
    { key: 'redirects', name: 'Redirects followed', unit: '' },
  ];
}

export interface HttpCheckExtras {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly maxBodyBytes: number;
}

export interface HttpCheckOutcome extends CheckExecution {
  /** The body, for a type that asked for one. Empty otherwise. */
  readonly body: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * The request, the status check and the base channels — everything up to what a type does with
 * the answer.
 */
export async function runHttp(
  context: CheckContext,
  extras: HttpCheckExtras,
): Promise<HttpCheckOutcome> {
  const { fetchHttp, readCommon, statusAccepted } = await import('../support/http/request.js');

  const host = context.target.host;
  if (host === '') throw new Error('the device has no host to request');

  const common = readCommon(context.params, host);
  const agent = context.params['userAgent'];
  const userAgent = typeof agent === 'string' && agent.trim() !== '' ? agent.trim() : '';
  const expectRaw = context.params['expectStatus'];
  const expect = typeof expectRaw === 'string' ? expectRaw.trim() : '';

  const response = await fetchHttp(
    {
      ...common,
      method: extras.method,
      body: extras.body,
      maxBodyBytes: extras.maxBodyBytes,
      headers: {
        // Sent so that whoever reads a server log at 3 a.m. can tell what is making a request
        // every sixty seconds.
        'user-agent': userAgent === '' ? 'MonitoringSystem/1.0 (+sensor)' : userAgent,
        ...extras.headers,
      },
    },
    context.signal,
  );

  if (!statusAccepted(response.status, expect, common.followRedirects)) {
    throw new Error(
      `${common.scheme}://${host}:${String(common.port)}${response.finalPath} answered ` +
        String(response.status) +
        (expect === '' ? '' : `, and this sensor expects ${expect}`) +
        (response.unfollowedLocation === null
          ? ''
          : ` (it points at ${response.unfollowedLocation})`),
    );
  }

  const notes: string[] = [];
  if (!common.verifyTls && common.scheme === 'https') {
    // Said on every scan rather than once at configuration time: a connection encrypted against
    // nobody in particular is a standing decision, and this is where it stays visible.
    notes.push('the certificate is not being verified');
  }
  if (response.redirects > 0) {
    notes.push(
      `after ${String(response.redirects)} redirect${response.redirects === 1 ? '' : 's'}`,
    );
  }
  if (response.unfollowedLocation !== null && common.followRedirects) {
    notes.push(
      `it redirects to ${response.unfollowedLocation}, which is off this device and was not ` +
        'followed',
    );
  }

  const withSize = extras.method !== 'HEAD';
  return {
    channels: [
      { key: 'responseTime', value: response.totalMs },
      { key: 'timeToFirstByte', value: response.timeToFirstByteMs },
      { key: 'statusCode', value: response.status },
      ...(withSize ? [{ key: 'size', value: response.size }] : []),
      { key: 'redirects', value: response.redirects },
    ],
    message: [
      `${String(response.status)} in ${String(response.totalMs)} ms ` +
        `(${String(response.timeToFirstByteMs)} ms to first byte` +
        (withSize ? `, ${String(response.size)} bytes)` : ')'),
      ...notes,
    ].join('; '),
    body: response.body,
    status: response.status,
    headers: response.headers,
  };
}
