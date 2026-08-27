import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import {
  aggregateOf,
  JsonPathError,
  MAX_PATH,
  parsePath,
  selectPath,
  type Aggregate,
} from '../support/json-path.js';
import {
  HTTP_COMMON_SCHEMA,
  HTTP_REQUEST_SCHEMA,
  readRequestExtras,
  runHttp,
} from './http-shared.js';

/**
 * Numbers out of a JSON API, by path (`T-16`).
 *
 * **The difference from `http.content` is the shape of the answer, and it is not cosmetic.** A
 * regular expression over JSON works right up until a field moves, a key is reordered, or a
 * number arrives as a string — none of which is a change to the *data*, and all of which break a
 * pattern. `$.nodes[?(@.state=='down')]` with a `count` says what it means and keeps saying it.
 *
 * **A path selects a set and the aggregate is chosen, never guessed.** "How many nodes are down"
 * and "the worst load on any node" are the same path with a different aggregate; a language that
 * silently took the first match would answer both wrongly and say nothing about it.
 *
 * **Nothing found is a gap, not a zero.** A metric an API stopped publishing is missing data, and
 * drawing it as zero is the one thing this system does not do. A path that matched nothing on
 * *every* channel fails the check instead, because that is not a gap — it is a sensor pointed at
 * the wrong document.
 *
 * **XML too, since `T-24`.** A response is parsed as XML when it says it is, or when it starts
 * like one — and a path beginning with `/` is read as an XPath location path against the same
 * engine. `/prtg/result[1]/value` and `$.queue.depth` are the same machinery with two spellings,
 * because two path languages would be two things to learn and two to get subtly wrong.
 */

const MAX_CHANNELS = 20;
const MAX_EXPECTATIONS = 10;

/** Enough of an API response to find anything worth alarming on, and bounded so a worker lives. */
const DEFAULT_MAX_BODY = 1024 * 1024;

const AGGREGATES: readonly Aggregate[] = ['first', 'last', 'count', 'sum', 'min', 'max', 'avg'];

interface Mapping {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly path: string;
  readonly aggregate: Aggregate;
  readonly scale: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (record: Record<string, unknown>, key: string, fallback = ''): string => {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
};

/** Exported for its own tests: a mapping read wrongly is a channel quietly watching nothing. */
export function readMappings(params: Readonly<Record<string, unknown>>): Mapping[] {
  const raw = params['extract'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Mapping[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = text(entry, 'key').trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const aggregate = text(entry, 'aggregate', 'first') as Aggregate;
    const scale = Number(entry['scale'] ?? 1);
    const name = text(entry, 'name').trim();
    out.push({
      key,
      name: name === '' ? key : name,
      unit: text(entry, 'unit'),
      path: text(entry, 'path'),
      aggregate: AGGREGATES.includes(aggregate) ? aggregate : 'first',
      scale: Number.isFinite(scale) && scale !== 0 ? scale : 1,
    });
  }
  return out;
}

interface Expectation {
  readonly path: string;
  readonly equals: string;
  readonly contains: string;
}

function readExpectations(params: Readonly<Record<string, unknown>>): Expectation[] {
  const raw = params['expect'];
  if (!Array.isArray(raw)) return [];
  const out: Expectation[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const path = text(entry, 'path').trim();
    if (path === '') continue;
    out.push({ path, equals: text(entry, 'equals'), contains: text(entry, 'contains') });
  }
  return out;
}

export const restCustom: SensorType = {
  id: 'rest.custom',
  category: 'Web',
  costHint: 'medium',
  credentialKinds: ['http'],

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['extract'],
    properties: {
      ...HTTP_COMMON_SCHEMA,
      ...HTTP_REQUEST_SCHEMA,
      format: {
        enum: ['auto', 'json', 'xml'],
        default: 'auto',
        title: 'Response format',
        description:
          '`auto` reads XML when the Content-Type says so, when the body opens with an XML ' +
          'declaration, or when it starts with a tag that is not HTML — which covers the ' +
          'appliance serving XML as application/octet-stream and the one serving it as JSON. ' +
          'Set it explicitly only where that guess is wrong.',
      },
      maxBodyBytes: {
        type: 'integer',
        minimum: 1_024,
        maximum: 8 * 1024 * 1024,
        default: DEFAULT_MAX_BODY,
        title: 'Response bound',
        description:
          'How much of the response is read. Passing it fails rather than truncating, because ' +
          'half a document does not parse at all and “unexpected end of input” is a worse ' +
          'diagnosis than “this response is bigger than this sensor reads”.',
      },
      extract: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CHANNELS,
        title: 'Channels',
        description:
          'Each row is one channel. The first is the one the sensor is judged by. A path that ' +
          'finds nothing leaves a gap in its channel rather than a zero — a metric an API ' +
          'stopped publishing is missing data, not a reading of none.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'path'],
          properties: {
            key: {
              type: 'string',
              minLength: 1,
              maxLength: 40,
              pattern: '^[A-Za-z0-9_.-]+$',
              title: 'Channel key',
              description: 'Stable. Renaming it starts a new channel with no history.',
            },
            name: { type: 'string', maxLength: 80, default: '', title: 'Channel name' },
            unit: { type: 'string', maxLength: 20, default: '', title: 'Unit' },
            path: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_PATH,
              title: 'Path',
              description:
                'For JSON: $.queue.depth · $.nodes[0].load · $.nodes[*].load · $..load · ' +
                '$.nodes[?(@.state==“down”)]. For XML, a path starting with a slash is read as ' +
                'XPath: /prtg/result[1]/value · //channel · /result/@state · /result/text() · ' +
                '/result[@state=“down”]/name. **JSONPath counts from zero and XPath from one**, ' +
                'as each language does — the spelling decides. Script expressions are not ' +
                'supported in either, on purpose.',
            },
            aggregate: {
              enum: [...AGGREGATES],
              default: 'first',
              title: 'When the path finds several',
              description:
                'count counts what the path selected; every other aggregate counts only what is ' +
                'a number. “How many nodes are down” and “the worst load on any node” are the ' +
                'same path with a different answer here.',
            },
            scale: {
              type: 'number',
              default: 1,
              title: 'Multiply by',
              description:
                'For an API that reports bytes where you want megabytes, or a fraction where ' +
                'you want a percentage. 0.000001 and 100 are the two everybody needs.',
            },
          },
        },
      },
      expect: {
        type: 'array',
        maxItems: MAX_EXPECTATIONS,
        default: [],
        title: 'Values that must be right',
        description:
          'Checked as text, and the check fails when one is wrong. This is where a status field ' +
          'belongs — “$.status must equal healthy” — because a status is not a number and a ' +
          'channel that encodes one as 1 and 0 loses what it said.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: MAX_PATH, title: 'Path' },
            equals: { type: 'string', maxLength: 500, default: '', title: 'Must equal' },
            contains: { type: 'string', maxLength: 500, default: '', title: 'Must contain' },
          },
        },
      },
    },
  },

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const mappings = readMappings(params);
    if (mappings.length === 0) {
      return [{ key: 'responseTime', name: 'Response time', unit: 'ms', isPrimary: true }];
    }
    return [
      ...mappings.map((mapping, at) => ({
        key: mapping.key,
        name: mapping.name,
        unit: mapping.unit,
        ...(at === 0 ? { isPrimary: true } : {}),
      })),
      // Last, so a REST sensor is still a timing sensor: an API that still answers correctly and
      // takes four seconds to do it is a fault, and nothing in its own numbers would say so.
      { key: 'responseTime', name: 'Response time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const mappings = readMappings(context.params);
    if (mappings.length === 0) throw new Error('this sensor declares no channels to extract');
    const expectations = readExpectations(context.params);

    // Parsed before the request, so a mistyped path is a failure that names itself rather than
    // one discovered after a round trip.
    const compiled = mappings.map((mapping) => ({
      mapping,
      steps: parse(mapping.path, `channel "${mapping.key}"`),
    }));
    const compiledExpectations = expectations.map((expectation) => ({
      expectation,
      steps: parse(expectation.path, 'an expected value'),
    }));

    const maxBodyBytes = Number(context.params['maxBodyBytes'] ?? DEFAULT_MAX_BODY);
    const outcome = await runHttp(context, {
      ...readRequestExtras(context.params, context.credentials, maxBodyBytes + 1),
      maxBodyBytes: maxBodyBytes + 1,
    });
    if (outcome.body.length > maxBodyBytes) {
      throw new Error(
        `the response is larger than the ${String(maxBodyBytes)} bytes this sensor reads — half ` +
          'a document does not parse at all, so this fails rather than truncating',
      );
    }

    const rawType = outcome.headers['content-type'];
    const contentType = typeof rawType === 'string' ? rawType : '';
    const declaredFormat = context.params['format'];
    const format = declaredFormat === 'json' || declaredFormat === 'xml' ? declaredFormat : 'auto';

    const { looksLikeXml, parseXml } = await import('../support/xml.js');
    const asXml =
      format === 'xml' || (format === 'auto' && looksLikeXml(outcome.body, contentType));

    let document: unknown;
    try {
      document = asXml ? parseXml(outcome.body) : (JSON.parse(outcome.body) as unknown);
    } catch (error) {
      throw new Error(
        `${String(outcome.status)}, but the response is not ${asXml ? 'XML' : 'JSON'}: ` +
          (error instanceof Error ? error.message : String(error)) +
          (contentType === '' ? '' : ` (it says Content-Type: ${contentType})`),
      );
    }

    const wrong: string[] = [];
    for (const { expectation, steps } of compiledExpectations) {
      const found = selectPath(document, steps);
      if (found.length === 0) {
        wrong.push(`${expectation.path} is not in the response`);
        continue;
      }
      const actual = asText(found[0]);
      if (expectation.equals !== '' && actual !== expectation.equals) {
        wrong.push(`${expectation.path} is "${actual}" and should be "${expectation.equals}"`);
      }
      if (
        expectation.contains !== '' &&
        !actual.toLowerCase().includes(expectation.contains.toLowerCase())
      ) {
        wrong.push(
          `${expectation.path} is "${actual}" and should contain "${expectation.contains}"`,
        );
      }
    }
    if (wrong.length > 0) {
      throw new Error(`${String(outcome.status)}, but the response says: ${wrong.join('; ')}`);
    }

    const readings: { key: string; value: number }[] = [];
    const missing: string[] = [];
    const notes: string[] = [];
    for (const { mapping, steps } of compiled) {
      const value = aggregateOf(selectPath(document, steps), mapping.aggregate);
      if (value === null) {
        // A gap, not a zero. A metric an API stopped publishing is missing data.
        missing.push(mapping.key);
        continue;
      }
      const scaled = Math.round(value * mapping.scale * 1e6) / 1e6;
      readings.push({ key: mapping.key, value: scaled });
      if (notes.length < 4) notes.push(`${mapping.key}=${String(scaled)}`);
    }

    if (readings.length === 0) {
      // Every path found nothing. That is not a gap — it is a sensor pointed at a document that
      // does not have any of what it is looking for, which reads as flat lines for ever.
      throw new Error(
        `${String(outcome.status)}, and none of this sensor’s ${String(mappings.length)} paths ` +
          `matched anything in the response — the first is ${mappings[0]?.path ?? ''}`,
      );
    }

    return {
      channels: [...readings, { key: 'responseTime', value: responseTimeOf(outcome) }],
      message:
        notes.join(' ') +
        (missing.length === 0 ? '' : `; ${missing.join(', ')} found nothing`) +
        (readings.length > notes.length
          ? ` (+${String(readings.length - notes.length)} more)`
          : ''),
    };
  },
};

/**
 * What a selected value looks like in a message.
 *
 * `String()` on an object gives `[object Object]`, which tells an operator comparing a status
 * field nothing at all about what the API actually said.
 */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  // Never circular: this came out of `JSON.parse`.
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function parse(path: string, where: string): ReturnType<typeof parsePath> {
  try {
    return parsePath(path);
  } catch (error) {
    if (error instanceof JsonPathError) throw new Error(`${where}: ${error.message}`);
    throw error;
  }
}

function responseTimeOf(outcome: {
  readonly channels: readonly { key: string; value: number }[];
}): number {
  return outcome.channels.find((channel) => channel.key === 'responseTime')?.value ?? 0;
}
