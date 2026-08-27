import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { HTTP_COMMON_SCHEMA, httpChannels, runHttp } from './http-shared.js';

/**
 * An HTTP request with headers, a body and credentials (`T-13`).
 *
 * **Separate from `http.request` rather than folded into it**, because the plain form is the one
 * most sensors are, and a form with fifteen fields makes the common case the hardest to fill in.
 * The split is PRTG's and it is the right one: this is the sensor for an API endpoint, and that
 * is a different job from "is the web server up".
 *
 * **Credentials come from the device, not from these parameters.** The `http` credential kind is
 * inherited (`A-05`), so a hundred sensors against one API rotate their token in one place — and
 * a token typed into a sensor's parameters would be a hundred places to rotate it, each of them
 * returned by the API to anybody who can read a sensor.
 *
 * **Response headers are validated because a header is often the whole answer.** A cache that
 * stopped setting `Cache-Control`, an API that stopped sending `X-Request-Id`, a site that lost
 * its `Strict-Transport-Security` — each is a real regression that a status code and a response
 * time report as perfectly healthy.
 */

const MAX_HEADERS = 20;

interface HeaderRule {
  readonly name: string;
  readonly contains: string;
}

function readPairs(value: unknown, keyName: string, valueName: string): HeaderRule[] {
  if (!Array.isArray(value)) return [];
  const out: HeaderRule[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const raw = record[keyName];
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '') continue;
    const held = record[valueName];
    out.push({ name, contains: typeof held === 'string' ? held : '' });
  }
  return out;
}

export const httpAdvanced: SensorType = {
  id: 'http.advanced',
  category: 'Web',
  costHint: 'medium',
  credentialKinds: ['http'],

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...HTTP_COMMON_SCHEMA,
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
        maxItems: MAX_HEADERS,
        default: [],
        title: 'Request headers',
        description:
          'Sent with the request. An Authorization header does *not* belong here — set an HTTP ' +
          'credential on the device instead, so a hundred sensors against one API rotate their ' +
          'token in one place rather than a hundred.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200, title: 'Header' },
            value: { type: 'string', maxLength: 2_048, default: '', title: 'Value' },
          },
        },
      },
      expectHeaders: {
        type: 'array',
        maxItems: MAX_HEADERS,
        default: [],
        title: 'Expected response headers',
        description:
          'The check fails unless each of these is present and contains the text given. Leave a ' +
          'value empty to require only that the header is there. A cache that stopped setting ' +
          'Cache-Control reports as perfectly healthy by status code alone.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200, title: 'Header' },
            contains: { type: 'string', maxLength: 2_048, default: '', title: 'Contains' },
          },
        },
      },
    },
  },

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    return httpChannels(params['method'] !== 'HEAD');
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const methodRaw = context.params['method'];
    const method = typeof methodRaw === 'string' ? methodRaw : 'GET';
    const bodyRaw = context.params['body'];
    const body = typeof bodyRaw === 'string' ? bodyRaw : '';

    const headers: Record<string, string> = {};
    for (const header of readPairs(context.params['requestHeaders'], 'name', 'value')) {
      headers[header.name.toLowerCase()] = header.contains;
    }

    // The device's credential, inherited. Absent is fine — plenty of endpoints need none.
    const credential = context.credentials['http'];
    if (credential !== undefined) {
      const authorization = authorizationFor(credential);
      if (authorization !== null) headers['authorization'] = authorization;
    }

    const outcome = await runHttp(context, { method, headers, body, maxBodyBytes: 0 });

    const missing: string[] = [];
    for (const rule of readPairs(context.params['expectHeaders'], 'name', 'contains')) {
      const actual = outcome.headers[rule.name.toLowerCase()];
      const text = Array.isArray(actual) ? actual.join(', ') : (actual ?? '');
      if (actual === undefined) {
        missing.push(`${rule.name} is missing`);
      } else if (
        rule.contains !== '' &&
        !text.toLowerCase().includes(rule.contains.toLowerCase())
      ) {
        missing.push(`${rule.name} is "${text}" and should contain "${rule.contains}"`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `${String(outcome.status)}, but the response headers are wrong: ${missing.join('; ')}`,
      );
    }

    return {
      channels: outcome.channels,
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
    };
  },
};

/**
 * The `Authorization` header a stored credential produces, or null.
 *
 * Both schemes in one place because the choice is the credential's, not the sensor's: an
 * operator who swaps a device from basic auth to a bearer token should not have to edit every
 * sensor under it.
 */
function authorizationFor(credential: Readonly<Record<string, unknown>>): string | null {
  const token = credential['token'];
  if (typeof token === 'string' && token.trim() !== '') return `Bearer ${token.trim()}`;

  const username = credential['username'];
  const password = credential['password'];
  if (typeof username === 'string' && username !== '') {
    const encoded = Buffer.from(
      `${username}:${typeof password === 'string' ? password : ''}`,
    ).toString('base64');
    return `Basic ${encoded}`;
  }
  return null;
}
