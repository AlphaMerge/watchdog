import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { HTTP_COMMON_SCHEMA, runHttp } from './http-shared.js';
import { MAX_PATTERN } from '../support/pattern.js';

/**
 * Numbers pulled out of what a page or an API returned (`T-14`).
 *
 * **This is the type that monitors an application rather than a web server.** A status code and
 * a response time say the server answered; they say nothing about the queue depth on the status
 * page, the build number that should have changed after a deploy, or the word "healthy" that
 * stopped appearing. Anything an endpoint is willing to print is a channel here without anybody
 * writing a sensor type for it.
 *
 * **The body is bounded and the bound fails rather than truncates.** A pattern matched against
 * half a document finds nothing and reports it as a value that is missing, which is a different
 * and much more confusing fault than "this page is bigger than this sensor will read".
 *
 * **The matching runs in a sandbox with a watchdog** — `support/pattern.ts`, written for `T-03`
 * and moved out of `support/snmp/` when this became its third caller. An operator-supplied
 * regular expression against remote-supplied text cannot be interrupted any other way:
 * JavaScript has no interruptible regex, so `ctx.signal` does not help and a mistyped pattern
 * would hold a worker until the pool terminated it.
 */

const MAX_CHANNELS = 10;

/** Enough of a page to find anything worth alarming on, and bounded so a worker survives. */
const DEFAULT_MAX_BODY = 512 * 1024;

interface Extraction {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly pattern: string;
}

/**
 * The key every content sensor reports of its own, which `channels()` declares after the
 * extractions' (`P-348`). The schema refuses it as an `extract` key.
 */
export const HTTP_CONTENT_OWN_KEYS = ['responseTime'] as const;

function readExtractions(params: Readonly<Record<string, unknown>>): Extraction[] {
  const raw = params['extract'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Extraction[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record['key'] === 'string' ? record['key'].trim() : '';
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    out.push({
      key,
      name: name === '' ? key : name,
      unit: typeof record['unit'] === 'string' ? record['unit'] : '',
      pattern: typeof record['pattern'] === 'string' ? record['pattern'] : '',
    });
  }
  return out;
}

export const httpContent: SensorType = {
  id: 'http.content',
  category: 'Web',
  costHint: 'medium',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...HTTP_COMMON_SCHEMA,
      mustContain: {
        type: 'string',
        maxLength: 500,
        default: '',
        title: 'Must contain',
        description:
          'Plain text the response has to contain, ignoring case. The cheapest useful check ' +
          'there is: a page that returns 200 with a stack trace in it is Up by every other ' +
          'measure.',
      },
      mustNotContain: {
        type: 'string',
        maxLength: 500,
        default: '',
        title: 'Must not contain',
        description:
          'Plain text that fails the check when present — “Exception”, “Under maintenance”, ' +
          '“Database error”.',
      },
      extract: {
        type: 'array',
        maxItems: MAX_CHANNELS,
        default: [],
        title: 'Numbers to extract',
        description:
          'Each becomes a channel. The pattern is a regular expression; its first capture group ' +
          'is the number, or the whole match when it captures nothing. The first entry is the ' +
          'channel the sensor is judged by.',
        items: {
          // The singular, for `U-12`'s repeating control (`U-88`).
          title: 'Number to extract',
          type: 'object',
          additionalProperties: false,
          required: ['key', 'pattern'],
          properties: {
            key: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              // Not the sensor's own (`P-348`), with the spaces `readExtractions` trims: a result
              // would carry two readings under it, and `channels()` would declare it twice.
              pattern: `^(?!\\s*(?:${HTTP_CONTENT_OWN_KEYS.join('|')})\\s*$)`,
              'x-patternMessage': `must not be ${HTTP_CONTENT_OWN_KEYS.join(', ')}, the sensor’s own channel`,
              title: 'Key',
              description: `Not ${HTTP_CONTENT_OWN_KEYS.map((key) => `\`${key}\``).join(', ')}: the sensor’s own channel.`,
            },
            name: { type: 'string', maxLength: 200, default: '', title: 'Channel name' },
            unit: { type: 'string', maxLength: 50, default: '', title: 'Unit' },
            pattern: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_PATTERN,
              title: 'Pattern',
              description:
                'For example `"queue":\\s*(\\d+)` against a JSON status endpoint, or ' +
                '`Version ([0-9.]+)` against a page footer.',
            },
          },
        },
      },
      maxBodyBytes: {
        type: 'integer',
        minimum: 1_024,
        maximum: 8_388_608,
        default: DEFAULT_MAX_BODY,
        title: 'Read at most',
        description:
          'How much of the response to read. Passing it fails the check rather than truncating: ' +
          'a pattern matched against half a document finds nothing and reports a value as ' +
          'missing, which is a far more confusing fault than “this page is bigger than this ' +
          'sensor will read”.',
      },
    },
  },

  // Every reading is keyed by a channel `channels(params)` names for the same parameters, so one
  // an edit no longer names is retired (`P-310`).
  declaresEveryChannel: true,

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const extractions = readExtractions(params);
    if (extractions.length === 0) {
      // A sensor doing only contains/not-contains still needs something to be judged by, and
      // "did the whole check pass" is exactly what its state already says — so the useful
      // number is the one every HTTP sensor has.
      return [{ key: 'responseTime', name: 'Response time', unit: 'ms', isPrimary: true }];
    }
    return [
      ...extractions.map((extraction, at) => ({
        key: extraction.key,
        name: extraction.name,
        unit: extraction.unit,
        ...(at === 0 ? { isPrimary: true } : {}),
      })),
      { key: 'responseTime', name: 'Response time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { compilePattern, extract } = await import('../support/pattern.js');

    const extractions = readExtractions(context.params);
    // Checked before the request, so a bad pattern fails without troubling the server — and
    // fails with the same sentence every scan rather than intermittently.
    for (const extraction of extractions) compilePattern(extraction.pattern);

    const maxBodyBytes = Number(context.params['maxBodyBytes'] ?? DEFAULT_MAX_BODY);
    const must = text(context.params['mustContain']).trim();
    const mustNot = text(context.params['mustNotContain']).trim();

    const outcome = await runHttp(context, {
      method: 'GET',
      headers: {},
      body: '',
      // One more than the bound, so "it was exactly at the limit" and "it went past" are
      // distinguishable rather than both looking full.
      maxBodyBytes: maxBodyBytes + 1,
    });

    if (outcome.body.length > maxBodyBytes) {
      throw new Error(
        `the response is larger than the ${String(maxBodyBytes)} bytes this sensor reads — a ` +
          'pattern matched against half a document reports a value as missing, which is a more ' +
          'confusing fault than this one, so it fails instead',
      );
    }

    const body = outcome.body;
    if (must !== '' && !body.toLowerCase().includes(must.toLowerCase())) {
      throw new Error(`the response does not contain "${must}"`);
    }
    if (mustNot !== '' && body.toLowerCase().includes(mustNot.toLowerCase())) {
      throw new Error(`the response contains "${mustNot}"`);
    }

    const readings: { key: string; value: number }[] = [];
    const notes: string[] = [];
    for (const extraction of extractions) {
      // The whole body it was allowed to read, not `pattern.ts`'s 4 KB default: that bound is
      // right for a string an SNMP agent returned and wrong for a page, where a number below the
      // fold would silently read as a value that is missing.
      const found = extract(body, extraction.pattern, 'number', undefined, maxBodyBytes);
      if (found.kind === 'too-slow') {
        throw new Error(
          `matching /${extraction.pattern}/ was still running after ${String(found.afterMs)} ms ` +
            'and was stopped — the pattern backtracks on what this endpoint returns; a nested ' +
            'quantifier such as (a+)+ is the usual cause',
        );
      }
      if (found.kind === 'value') {
        readings.push({ key: extraction.key, value: found.value });
        continue;
      }
      // Gapped rather than zeroed: a number that stopped appearing is missing data, and a zero
      // would draw a reassuring flat line (CLAUDE.md).
      notes.push(
        found.kind === 'no-match'
          ? `${extraction.key} was not found`
          : `${extraction.key} matched "${found.matched}", which is not a number`,
      );
    }

    if (extractions.length > 0 && readings.length === 0) {
      throw new Error(`the response matched none of this sensor’s patterns: ${notes.join('; ')}`);
    }

    const responseTime = outcome.channels.find((channel) => channel.key === 'responseTime');
    return {
      channels: [...readings, ...(responseTime === undefined ? [] : [responseTime])],
      message: [
        readings.length === 0
          ? `${String(outcome.status)}, content checks passed`
          : readings.map((reading) => `${reading.key}=${String(reading.value)}`).join(' '),
        ...notes,
      ].join('; '),
    };
  },
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
