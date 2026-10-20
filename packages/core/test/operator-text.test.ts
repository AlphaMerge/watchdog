import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import ts from 'typescript';
import {
  BUILT_IN_SENSOR_TYPES,
  CREDENTIAL_KINDS,
  withheldReason,
  type ChannelDef,
  type JsonSchema,
} from '@ms/sensors';
import { DISCOVERY_LEVELS, PATTERN_MESSAGE } from '@ms/shared';
import { BUILT_IN_DEVICE_TEMPLATES } from '../src/device-templates/built-in.js';
import { BUILT_IN_LOOKUPS } from '../src/lookups/built-in.js';
import { notificationMethods } from '../src/notifications/methods.js';
import { describePlaceholders } from '../src/notifications/placeholders.js';
import { describeSummarisationModes } from '../src/notifications/summarisation.js';
import { coreCatalogue } from '../src/profile.js';
import { builtInSchedules } from '../src/schedules/built-in.js';
import { settingRegistry } from '../src/settings/registry.js';
import { triggerKinds } from '../src/triggers/definition.js';
import { within } from './support/within.js';

/**
 * No internal ticket in what the API serves an operator to read (`U-92`).
 *
 * Walked in a browser (`U-23`), a sensor's form told the operator why its packets are 0.2 s apart
 * "(`P-07`)", and an SSH set's host keys what they bound "(`A-41b`)": tickets of this repository,
 * which nobody running the product can look up. Removing the three found is half the fix; this
 * is the other half, so a new one cannot creep in. It walks what the routes serve, as they serve
 * it — every sensor type's parameters, and its channels for `{}` and for parameters that turn on
 * the ones only some values declare; a type the build leaves out and why; every credential kind,
 * notification method, trigger kind, summarisation mode, setting, lookup, device template,
 * discovery level, message placeholder and built-in schedule — and fails on a ticket in any
 * title, description, name, text, unit, pattern sentence or limit message, or in any default,
 * example, enum value or constant, which a form shows as it is.
 *
 * **And the API's own reference** (`U-93`): the OpenAPI document `GET /api/v1/openapi.json`
 * serves and `docs/api-reference.md` is rendered from, built as `build-hygiene.test.ts` builds it.
 * It cited tickets 126 times — "(`A-49`)", "the answer `D-04` will act on" — to whoever writes a
 * client, who cannot look one up either. Every summary, description, title, name and pattern
 * sentence in it is read, and every example, default, enum value and constant, as the reference
 * shows them. **And the page itself**, read whole: the renderer writes prose of its own — the
 * lead, the conventions, how to read a field table — and the stream's WebSocket reaches the page
 * from its schema, which no document carries.
 *
 * **And what the core writes when it runs**, which nothing registers: the message its own sensors
 * carry — Core Health's, Probe Health's — and the one a state is written with when a probe is lost
 * or changes or a parent is paused, each of which is the sensor's message, its state-log entry and
 * every notification carrying `%lastmessage`; every line it logs, which is the operator's journal,
 * its fields as well as its message; and every refusal it builds. They are built from constants,
 * from functions that assemble a sentence and from property after property, so no list of the
 * places they are written reaches all of them. Every string under `src` is read instead, as the
 * web's `operator-text.test.ts` reads its own, except two kinds of text written for somebody else:
 * a SQL comment and a migration's SQL (`leftOut`). What a sensor type or the probe says at check
 * time is held by the sensors' and the probe's tests, which read every string of theirs.
 */

/**
 * A ticket as the repository names them: one capital letter, a hyphen, digits and perhaps a
 * letter (`P-07`, `A-41b`); `V2-01`; and a decision record (`ADR-003`). Not any capitals before a
 * hyphen, which would refuse `SHA-256`, `AES-256` and `UTF-8`, words an operator needs.
 */
const TICKET = /\b(?:[A-Z]|V2|ADR)-\d+[a-z]?\b/u;

/**
 * The keys whose string an operator reads, or a client's author: an OpenAPI operation's `summary`
 * is the heading the reference gives a route. Everything else is an id, a value or a type.
 */
const READ = new Set([
  'title',
  'summary',
  'description',
  'name',
  'text',
  'unit',
  PATTERN_MESSAGE,
  'errorMessage',
  'warningMessage',
]);

/**
 * The keys whose every string is shown as it is: a default fills the form's control (`mail.smtp`'s
 * subject is the sent mail's too), and an example, an enum's values and a constant are drawn. An
 * OpenAPI document spells an example both ways, JSON Schema's `examples` and its own `example`.
 */
const SHOWN = new Set(['default', 'examples', 'example', 'enum', 'const']);

interface Read {
  readonly where: string;
  readonly text: string;
}

/** Every string anywhere in a value, by its path. */
function everyString(value: unknown, where: string): Read[] {
  if (typeof value === 'string') return [{ where, text: value }];
  if (Array.isArray(value)) {
    return value.flatMap((one, index) => everyString(one, `${where}[${String(index)}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => everyString(child, `${where}.${key}`));
}

/** Every string under a key in `READ`, and every one under a key in `SHOWN`, by its path. */
function readIn(value: unknown, where: string): Read[] {
  if (Array.isArray(value)) {
    return value.flatMap((one, index) => readIn(one, `${where}[${String(index)}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]): Read[] => {
    if (SHOWN.has(key)) return everyString(child, `${where}.${key}`);
    if (typeof child === 'string') {
      return READ.has(key) ? [{ where: `${where}.${key}`, text: child }] : [];
    }
    return readIn(child, `${where}.${key}`);
  });
}

type Schema = Readonly<Record<string, unknown>>;

const propertiesOf = (schema: Schema): [string, Schema][] =>
  Object.entries((schema['properties'] ?? {}) as Record<string, Schema>);

/**
 * Parameters that turn on the channels only some values declare.
 *
 * `port.tcp`'s *Banner matched* is there only when a banner is asked for, and `mail.smtp`'s
 * *Message accepted in* only when there is a recipient, so `{}` reaches neither. As
 * `scripts/docs/sensor-reference.mjs` probes a type's channels: a string is a word of its own
 * path, so no two channels a type names after them share a key; a number is its least; a list
 * has one entry and an object its properties. Booleans are tried all on and all off, and each
 * value of an enum on its own over the first.
 */
function probesOf(schema: JsonSchema): Record<string, unknown>[] {
  const valueOf = (prop: Schema, path: string, on: boolean): unknown => {
    const choices = prop['enum'];
    if (Array.isArray(choices)) return (choices as readonly unknown[])[0];
    switch (prop['type']) {
      case 'string':
        return `probe-${path.replace(/[^a-z]/giu, '-')}`;
      case 'integer':
      case 'number':
        return typeof prop['minimum'] === 'number' ? prop['minimum'] : 1;
      case 'boolean':
        return on;
      case 'array': {
        const items = prop['items'];
        if (typeof items !== 'object' || items === null) return undefined;
        const item = valueOf(items as Schema, `${path}[]`, on);
        return item === undefined ? undefined : [item];
      }
      case 'object':
        return objectOf(prop, path, on);
      default:
        return undefined;
    }
  };
  const objectOf = (of: Schema, at: string, on: boolean): Record<string, unknown> =>
    Object.fromEntries(
      propertiesOf(of).flatMap(([key, prop]) => {
        const value = valueOf(prop, at === '' ? key : `${at}.${key}`, on);
        return value === undefined ? [] : [[key, value]];
      }),
    );

  const probes = [objectOf(schema, '', true), objectOf(schema, '', false)];
  for (const [key, prop] of propertiesOf(schema)) {
    const choices = prop['enum'];
    if (!Array.isArray(choices)) continue;
    for (const choice of choices as readonly unknown[]) {
      for (const base of probes.slice(0, 2)) probes.push({ ...base, [key]: choice });
    }
  }
  return probes;
}

/** A type's channels for `{}` and for each probe, each once, by key. */
function channelsOf(
  catalogue: ReturnType<typeof coreCatalogue>,
  id: string,
  schema: JsonSchema,
  refused: string[],
): Read[] {
  const sets: (readonly ChannelDef[])[] = [catalogue.channelsFor(id, {})];
  // A `fixedChannels` type answers every parameter set as it answers `{}`, and is held to it.
  if (catalogue.declaration(id).fixedChannels !== true) {
    for (const params of probesOf(schema)) {
      try {
        sets.push(catalogue.channelsFor(id, params));
      } catch (error) {
        refused.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const seen = new Set<string>();
  return sets
    .flatMap((defs) => readIn(Object.fromEntries(defs.map((def) => [def.key, def])), id))
    .filter((one) => {
      const once = `${one.where}\u0000${one.text}`;
      if (seen.has(once)) return false;
      seen.add(once);
      return true;
    })
    .map((one) => ({ ...one, where: `channels of ${one.where}` }));
}

/** What the API serves for an operator to read, as each route serves it. */
function served(): { readonly texts: Read[]; readonly refused: string[] } {
  const catalogue = coreCatalogue('full');
  const refused: string[] = [];
  const texts = [
    // `GET /sensor-types`, and each sensor's channels as its detail lists them.
    ...catalogue
      .summaries()
      .flatMap((type) => [
        ...readIn(type, `sensor type ${type.id}`),
        ...channelsOf(catalogue, type.id, type.paramsSchema, refused),
      ]),
    // A probe asked for a type this build leaves out says why, in the sensor's message.
    ...BUILT_IN_SENSOR_TYPES.flatMap((type) => {
      const why = withheldReason('v1', type.id);
      return why === undefined ? [] : [{ where: `why v1 leaves out ${type.id}`, text: why }];
    }),
    ...readIn(CREDENTIAL_KINDS, 'credential kinds'),
    ...readIn(
      notificationMethods.all().map(({ id, name, description, settingsSchema }) => ({
        id,
        name,
        description,
        settingsSchema,
      })),
      'notification methods',
    ),
    ...readIn(
      triggerKinds.all().map(({ id, name, description, settingsSchema }) => ({
        id,
        name,
        description,
        settingsSchema,
      })),
      'trigger kinds',
    ),
    ...readIn(describeSummarisationModes(), 'summarisation modes'),
    ...readIn(settingRegistry.definitions(), 'settings'),
    ...readIn(BUILT_IN_LOOKUPS, 'lookups'),
    ...readIn(BUILT_IN_DEVICE_TEMPLATES, 'device templates'),
    ...readIn(DISCOVERY_LEVELS, 'discovery levels'),
    // `GET /notification-placeholders`, listed beside the template editor.
    ...readIn(describePlaceholders(), 'placeholders'),
    // Seeded at start and served by `GET /schedules`, on every new installation.
    ...readIn(builtInSchedules(), 'built-in schedules'),
  ];
  return { texts, refused };
}

const REPO = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * The OpenAPI document, as `GET /api/v1/openapi.json` serves it: built by the generator the
 * reference is rendered by, from the live route set with every optional route group, as
 * `build-hygiene.test.ts` builds it. A child process, so its wait has a bound of its own: the
 * child is killed at it, and `within` fails the wait if it is not.
 */
async function buildOpenApiDocument(): Promise<unknown> {
  const { stdout } = await within(
    90_000,
    'the OpenAPI document from scripts/docs/api-reference.mjs --openapi',
    promisify(execFile)(
      process.execPath,
      [join(REPO, 'scripts', 'docs', 'api-reference.mjs'), '--openapi'],
      {
        cwd: REPO,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 80_000,
        killSignal: 'SIGKILL',
      },
    ),
  );
  return JSON.parse(stdout) as unknown;
}

let built: Promise<unknown> | undefined;

/** The document, built once for the tests that read it: each build is seconds of work. */
function openApiDocument(): Promise<unknown> {
  built ??= buildOpenApiDocument();
  return built;
}

/**
 * The API reference page as it is committed, which is the rendering: `build-hygiene.test.ts` runs
 * the generator's `--check`, which fails unless this file is what the generator renders now from
 * the document and the routes the document hides. So reading it reads what a reader is given,
 * with no second rendering here to disagree with the first.
 */
const PAGE = join(REPO, 'docs', 'api-reference.md');

interface Operation {
  readonly description?: string;
  readonly responses?: Readonly<
    Record<string, { readonly content?: Readonly<Record<string, { readonly schema?: Schema }>> }>
  >;
}

interface OpenApi {
  readonly paths?: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
}

/** The JSON body a route answers with at a status. */
function bodyOf(doc: OpenApi, path: string, method: string, status: string): Schema | undefined {
  return doc.paths?.[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
}

/** A field of an object schema by its dotted path, `outputs.delivery`, if it has one. */
function fieldOf(schema: Schema | undefined, path: string): Schema | undefined {
  return path
    .split('.')
    .reduce<Schema | undefined>(
      (at, key) => (at?.['properties'] as Readonly<Record<string, Schema>> | undefined)?.[key],
      schema,
    );
}

const SRC = join(import.meta.dirname, '..', '..', 'src');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * A SQL comment, from `--` to the end of its line: where a query's ticket goes, as a comment is
 * where the code's goes. Not `--` before a word, which is a command-line flag (`--config`).
 */
const SQL_COMMENT = /(?<=^|\s)--(?=\s|$)[^\n]*/gu;

const MIGRATIONS = `${join('db', 'migrations')}${sep}`;

/**
 * Whether a property holds text written for somebody other than the operator, and so not read:
 * **a migration's `up` and `down`**, its SQL. The migrator checksums `up` byte for byte once it
 * ships, so nothing in it can be reworded: 004's licence hint names the decision record it sends
 * the operator to, a file the release ships in `docs/`, and changing a word of it would stop every
 * installed core as drifted (`db/migrations/types.ts`). Its `COMMENT ON` text is the database's
 * own documentation. A migration's name and what it logs are read; a `RAISE` in a new one's SQL is
 * the operator's and is not, its words written knowing they cannot change.
 *
 * A route's `summary` and `description` are read, as everything else under `api/` is (`U-93`):
 * they are the API reference, and the one route the OpenAPI document cannot carry, the stream's
 * WebSocket, is read here as it is written and on the page as it is rendered.
 *
 * The other kind is a SQL comment, anywhere, which `textsIn` takes out of the string it is in.
 */
function leftOut(node: ts.Node, file: string): boolean {
  if (!ts.isPropertyAssignment(node)) return false;
  const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
  if (file.startsWith(MIGRATIONS)) return key === 'up' || key === 'down';
  return false;
}

interface Text {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Every string a file of the core's source holds, outside its comments and what `leftOut` leaves,
 * with the line it starts on and its SQL comments taken out. A template is one text, its parts
 * joined where the placeholders were, so that a SQL comment running past one is still a comment;
 * what a placeholder holds is read for itself.
 */
function textsIn(path: string): Text[] {
  const file = relative(SRC, path);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: Text[] = [];
  const add = (node: ts.Node, text: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file, line: line + 1, text: text.replace(SQL_COMMENT, '') });
  };
  const visit = (node: ts.Node): void => {
    if (leftOut(node, file)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head, ...node.templateSpans.map((span) => span.literal)];
      add(node, parts.map((part) => part.text).join(' '));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A ticket with the words around it, enough to find it by in a long query or sentence. */
function around(text: string): string {
  const at = text.search(TICKET);
  return text
    .slice(Math.max(0, at - 60), at + 20)
    .replace(/\s+/gu, ' ')
    .trim();
}

describe('the text the API serves an operator (U-92)', () => {
  it('names a ticket by the pattern, and nothing an operator needs', () => {
    for (const ticket of ['(`P-07`)', '(`A-41b`)', 'is v2 (`V2-01`)', '(ADR-003)', 'B-03']) {
      assert.match(ticket, TICKET, ticket);
    }
    for (const word of ['SHA-256', 'AES-256', 'UTF-8', 'IF-MIB', 'ms.snmp.if-oper-status']) {
      assert.doesNotMatch(word, TICKET, word);
    }
  });

  it('cites no ticket, in any of it', () => {
    const { texts, refused } = served();
    // The walk reaches every part of it: a parameter's description and default, a channel's
    // name, one only a parameter turns on, a reason a type is left out, a method's setting, a
    // trigger's, a mode's, a setting's, a lookup's state text, a template's description, a
    // discovery level's, a placeholder's and a built-in schedule's.
    assert.ok(texts.length > 1_000, String(texts.length));
    for (const part of [
      /^sensor type icmp\.ping\.paramsSchema\.properties\.intervalSeconds\.description$/u,
      /^sensor type mail\.smtp\.paramsSchema\.properties\.subject\.default$/u,
      /^channels of icmp\.ping\.\w+\.name$/u,
      /^channels of port\.tcp\.bannerMatched\.name$/u,
      /^channels of mail\.smtp\.sendTime\.name$/u,
      /^why v1 leaves out flow\.netflow$/u,
      /^credential kinds\[\d+\]\.schema\.properties\.hostKeys\.description$/u,
      /^notification methods\[\d+\]\.settingsSchema\.properties\.secretArgs\.title$/u,
      /^trigger kinds\[\d+\]\.description$/u,
      /^summarisation modes\[\d+\]\.description$/u,
      /^settings\[\d+\]\.description$/u,
      /^lookups\[\d+\]\.entries\[\d+\]\.text$/u,
      /^device templates\[\d+\]\.description$/u,
      /^discovery levels\[\d+\]\.description$/u,
      /^placeholders\[\d+\]\.description$/u,
      /^built-in schedules\[\d+\]\.name$/u,
      /^built-in schedules\[\d+\]\.description$/u,
    ]) {
      assert.ok(
        texts.some((one) => part.test(one.where)),
        `the walk reaches ${part.source}`,
      );
    }
    // A probe a type's channels refused would be channels the walk never read.
    assert.deepEqual(refused, []);
    assert.deepEqual(
      texts.filter((one) => TICKET.test(one.text)).map((one) => `${one.where}: ${one.text}`),
      [],
    );
  });

  it('reads what the API reference shows of a route, and not its ids or types (U-93)', () => {
    const read = readIn(
      {
        info: { title: 'The API', description: 'What it is' },
        paths: {
          '/things': {
            get: {
              operationId: 'listThings',
              summary: 'Every thing',
              description: 'Newest first',
              parameters: [
                {
                  in: 'query',
                  name: 'kind',
                  description: 'Which kind',
                  schema: {
                    type: 'string',
                    format: 'hostname',
                    example: 'big',
                    examples: ['small'],
                    default: 'any',
                    enum: ['any', 'big', 'small'],
                  },
                },
              ],
              responses: { 200: { description: 'The things' } },
            },
          },
        },
      },
      'doc',
    ).map((one) => `${one.where} = ${one.text}`);
    assert.deepEqual(read, [
      'doc.info.title = The API',
      'doc.info.description = What it is',
      'doc.paths./things.get.summary = Every thing',
      'doc.paths./things.get.description = Newest first',
      'doc.paths./things.get.parameters[0].name = kind',
      'doc.paths./things.get.parameters[0].description = Which kind',
      'doc.paths./things.get.parameters[0].schema.example = big',
      'doc.paths./things.get.parameters[0].schema.examples[0] = small',
      'doc.paths./things.get.parameters[0].schema.default = any',
      'doc.paths./things.get.parameters[0].schema.enum[0] = any',
      'doc.paths./things.get.parameters[0].schema.enum[1] = big',
      'doc.paths./things.get.parameters[0].schema.enum[2] = small',
      'doc.paths./things.get.responses.200.description = The things',
    ]);
  });

  it('cites none in the API reference: the OpenAPI document the core serves (U-93)', async () => {
    const texts = readIn(await openApiDocument(), 'openapi');
    // The walk reaches every part of it a reader reads: the document's own description, a
    // route's summary and description, a query parameter's, a request body field's, a response
    // field's, a shared schema's field, a response's description, a default and an enum value.
    assert.ok(texts.length > 1_000, String(texts.length));
    for (const part of [
      /^openapi\.info\.description$/u,
      /^openapi\.paths\.\/api\/v1\/probes\.get\.summary$/u,
      /^openapi\.paths\.\/api\/v1\/probes\/\{gid\}\/approve\.post\.description$/u,
      /^openapi\.paths\.\/api\/v1\/objects\.get\.parameters\[\d+\]\.description$/u,
      /^openapi\.paths\.\/api\/v1\/probes\/\{gid\}\/approve\.post\.requestBody\..+\.local\.description$/u,
      /^openapi\.paths\.\/api\/v1\/probes\.get\.responses\.200\..+\.items\.properties\.skew\.description$/u,
      /^openapi\.components\.schemas\.[\w-]+\.properties\.counterBits\.description$/u,
      /^openapi\.paths\.\/api\/v1\/objects\.get\.responses\.200\.description$/u,
      /^openapi\.paths\.[^ ]+\.parameters\[\d+\]\.schema\.default$/u,
      /^openapi\.paths\.\/api\/v1\/probes\.get\.parameters\[\d+\]\.schema\.enum\[\d+\]$/u,
    ]) {
      assert.ok(
        texts.some((one) => part.test(one.where)),
        `the walk reaches ${part.source}`,
      );
    }
    assert.deepEqual(
      texts
        .filter((one) => TICKET.test(one.text))
        .map((one) => `${one.where}: ${around(one.text)}`),
      [],
    );
  });

  it('cites none on the API reference page: its own prose and the route no document carries (U-93)', () => {
    const lines = readFileSync(PAGE, 'utf8').split('\n');
    // Every line, which reaches what neither walk does: the renderer's lead, its conventions, how
    // to read a field table and the schemas' lead, written in `scripts/docs`; and the stream's
    // WebSocket, rendered from its schema, whose description the source walk reads with a SQL
    // comment taken out, so a ticket after a spaced double dash would pass it.
    assert.ok(lines.length > 1_000, String(lines.length));
    for (const part of [
      '**Generated from the OpenAPI document by ',
      '- **Everything is under `/api/v1`.**',
      '- **Every level is listed.**',
      'The shapes routes share',
      '### `GET /api/v1/stream`',
      'A WebSocket. Send ',
    ]) {
      assert.ok(
        lines.some((line) => line.startsWith(part)),
        `the page holds a line starting "${part}"`,
      );
    }
    assert.deepEqual(
      lines.flatMap((line, index) =>
        TICKET.test(line) ? [`docs/api-reference.md:${String(index + 1)}: …${around(line)}…`] : [],
      ),
      [],
    );
  });

  it('says where a report run’s document goes in the fields that hold it (U-93)', async () => {
    // Rewritten for `U-93`, and first written naming the report's `delivery`, which a report does
    // not have: its mode is `outputs.delivery`, and the `delivery` beside the description, in the
    // run it answers, is whether the run's was sent.
    const doc = (await openApiDocument()) as OpenApi;
    const description = doc.paths?.['/api/v1/reports/{id}/runs']?.['post']?.description ?? '';
    const owners: Readonly<Record<string, Schema | undefined>> = {
      report: bodyOf(doc, '/api/v1/reports/{id}', 'get', '200'),
      run: bodyOf(doc, '/api/v1/reports/{id}/runs', 'post', '201'),
    };
    const named = [...description.matchAll(/\b(report|run)’s `([\w.]+)`/gu)].map(
      ([, owner = '', path = '']) => ({ owner, path }),
    );
    // A field of each, so the sentence cannot pass by naming none.
    assert.ok(
      named.some(({ owner }) => owner === 'report'),
      description,
    );
    assert.ok(
      named.some(({ owner }) => owner === 'run'),
      description,
    );
    for (const { owner, path } of named) {
      assert.notEqual(fieldOf(owners[owner], path), undefined, `the ${owner} has no \`${path}\``);
    }
    // And it explains every mode the report's field takes, as the report's schema lists them.
    const modes = fieldOf(owners['report'], 'outputs.delivery')?.['enum'];
    assert.ok(Array.isArray(modes) && modes.length > 0, JSON.stringify(modes));
    for (const mode of modes as readonly unknown[]) {
      assert.ok(description.includes(`\`${String(mode)}\``), `it explains \`${String(mode)}\``);
    }
  });

  it('takes a SQL comment out of a string, and leaves a flag and the query', () => {
    const strip = (text: string): string => text.replace(SQL_COMMENT, '');
    assert.equal(strip('SELECT 1 -- why (P-01)\nFROM t'), 'SELECT 1 \nFROM t');
    assert.equal(strip('  -- a whole line (M-08)\n  sr.state'), '  \n  sr.state');
    assert.equal(strip('run it with --config /etc/ms'), 'run it with --config /etc/ms');
  });

  it('cites none in what the core writes: a sensor’s message, a log line and its fields, a refusal', () => {
    const files = filesUnder(SRC);
    const texts = files.flatMap(textsIn);
    const reads = (file: string, text: string): boolean =>
      texts.some((one) => one.file === file && one.text.includes(text));
    assert.ok(files.length > 100, String(files.length));
    assert.ok(texts.length > 10_000, String(texts.length));
    for (const [file, text] of [
      // A line it logs, a migration's among them, a field of one, and a refusal.
      [join('objects', 'sensor-type-gate.ts'), 'no sensor types are registered'],
      [join('db', 'migrations', '073-channel-declared-shape.ts'), 'nothing judges'],
      [join('db', 'migrations', '071-legible-delivery-errors.ts'), 'made legible'],
      [join('state', 'declared-limits.ts'), 'declare-channels-on-ingest'],
      [join('auth', 'groups.ts'), 'cannot be deleted'],
      // A migration's name, which the migrator logs as it applies it.
      [join('db', 'migrations', '071-legible-delivery-errors.ts'), 'legible-delivery-errors'],
      // Its own sensors' messages: a check result's, written as it is and assembled by a function.
      [join('health', 'core-health.ts'), 'Core Health could not read its own numbers: '],
      [join('health', 'probe-health.ts'), 'not connected to the core'],
      [join('health', 'probe-health.ts'), 'its heartbeats arrive without them'],
      // The message a state is written with, as an argument and from a constant.
      [join('probes', 'reachability.ts'), 'the probe carrying this sensor changed'],
      [join('probes', 'reachability.ts'), 'the probe carrying this sensor stopped answering'],
      [join('objects', 'service.ts'), 'created under a paused parent'],
      // What a route says that is not its schema's, a description outside `api/`, and a query.
      [join('api', 'routes', 'stream.ts'), 'this account may not read that object'],
      [join('settings', 'registry.ts'), 'How often a sensor is scanned'],
      [join('objects', 'repository.ts'), 'AS has_children'],
      // A route's description and summary, which are the API reference: the stream's are in
      // the reference and not in the OpenAPI document, so this walk reads them as they are
      // written, and the page's test as they are rendered.
      [join('api', 'routes', 'access.ts'), 'it cannot be told from one that is not there'],
      [join('api', 'routes', 'stream.ts'), 'Live sensor state changes'],
      [join('api', 'routes', 'stream.ts'), 'A WebSocket. Send'],
      // And what a template's placeholder holds.
      [join('timeseries', 'store.ts'), 'AND channel_id = ANY($4::int[])'],
    ] as const) {
      assert.ok(reads(file, text), `the walk reaches "${text}" in ${file}`);
    }
    // And leaves out what is written for somebody else: a query's comment and a migration's SQL.
    for (const [file, text] of [
      [join('objects', 'repository.ts'), 'The clock, not just the row'],
      [join('db', 'migrations', '004-rollups.ts'), 'Set timescaledb.license'],
    ] as const) {
      assert.ok(!reads(file, text), `the walk leaves out "${text}" in ${file}`);
    }
    assert.deepEqual(
      texts
        .filter((one) => TICKET.test(one.text))
        .map((one) => `${one.file}:${String(one.line)}: …${around(one.text)}…`),
      [],
    );
  });
});
