import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
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
 * **And what the core writes when it runs**, which nothing registers: the message its own sensors
 * carry — Core Health's, Probe Health's — and the one a state is written with when a probe is lost
 * or changes or a parent is paused, each of which is the sensor's message, its state-log entry and
 * every notification carrying `%lastmessage`; every line it logs, which is the operator's journal;
 * and every refusal it builds. They are built from constants, from functions that assemble a
 * sentence and from property after property, so no list of the places they are written reaches
 * all of them. Every string under `src` is read instead, as the web's `operator-text.test.ts`
 * reads its own, except three kinds of text written for somebody else: a SQL comment, a
 * migration's SQL and the API reference (`leftOut`). What a sensor type or the probe says at check
 * time is held by the sensors' and the probe's tests, which read every string of theirs.
 */

/**
 * A ticket as the repository names them: one capital letter, a hyphen, digits and perhaps a
 * letter (`P-07`, `A-41b`); `V2-01`; and a decision record (`ADR-003`). Not any capitals before a
 * hyphen, which would refuse `SHA-256`, `AES-256` and `UTF-8`, words an operator needs.
 */
const TICKET = /\b(?:[A-Z]|V2|ADR)-\d+[a-z]?\b/u;

/** The keys whose string an operator reads. Everything else is an id, a value or a type. */
const READ = new Set([
  'title',
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
 * subject is the sent mail's too), and an example, an enum's values and a constant are drawn.
 */
const SHOWN = new Set(['default', 'examples', 'enum', 'const']);

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

const API = `api${sep}`;
const MIGRATIONS = `${join('db', 'migrations')}${sep}`;

/**
 * Whether a property holds text written for somebody other than the operator, and so not read.
 *
 * - **A migration's `up` and `down`**, its SQL. The migrator checksums `up` byte for byte once it
 *   ships, so nothing in it can be reworded: 004's licence hint names the decision record it sends
 *   the operator to, a file the release ships in `docs/`, and changing a word of it would stop
 *   every installed core as drifted (`db/migrations/types.ts`). Its `COMMENT ON` text is the
 *   database's own documentation. A migration's name and what it logs are read; a `RAISE` in a
 *   new one's SQL is the operator's and is not, its words written knowing they cannot change.
 * - **A `description` and a `summary` under `api/`**: the OpenAPI document, which is the API
 *   reference for whoever writes a client and cites tickets by the dozen; `U-92` records it as
 *   seen and leaves it to a ticket of its own. Everything else a route says is read.
 *
 * The third kind is a SQL comment, anywhere, which `textsIn` takes out of the string it is in.
 */
function leftOut(node: ts.Node, file: string): boolean {
  if (!ts.isPropertyAssignment(node)) return false;
  const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
  if (file.startsWith(MIGRATIONS)) return key === 'up' || key === 'down';
  if (file.startsWith(API)) return key === 'description' || key === 'summary';
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

  it('takes a SQL comment out of a string, and leaves a flag and the query', () => {
    const strip = (text: string): string => text.replace(SQL_COMMENT, '');
    assert.equal(strip('SELECT 1 -- why (P-01)\nFROM t'), 'SELECT 1 \nFROM t');
    assert.equal(strip('  -- a whole line (M-08)\n  sr.state'), '  \n  sr.state');
    assert.equal(strip('run it with --config /etc/ms'), 'run it with --config /etc/ms');
  });

  it('cites none in what the core writes: a sensor’s message, a log line, a refusal', () => {
    const files = filesUnder(SRC);
    const texts = files.flatMap(textsIn);
    const reads = (file: string, text: string): boolean =>
      texts.some((one) => one.file === file && one.text.includes(text));
    assert.ok(files.length > 100, String(files.length));
    assert.ok(texts.length > 10_000, String(texts.length));
    for (const [file, text] of [
      // A line it logs, a migration's among them, and a refusal.
      [join('objects', 'sensor-type-gate.ts'), 'no sensor types are registered'],
      [join('db', 'migrations', '073-channel-declared-shape.ts'), 'nothing judges'],
      [join('db', 'migrations', '071-legible-delivery-errors.ts'), 'made legible'],
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
      // And what a template's placeholder holds.
      [join('timeseries', 'store.ts'), 'AND channel_id = ANY($4::int[])'],
    ] as const) {
      assert.ok(reads(file, text), `the walk reaches "${text}" in ${file}`);
    }
    // And leaves out what is written for somebody else: a query's comment, a migration's SQL and
    // the API reference.
    for (const [file, text] of [
      [join('objects', 'repository.ts'), 'The clock, not just the row'],
      [join('db', 'migrations', '004-rollups.ts'), 'Set timescaledb.license'],
      [join('api', 'routes', 'access.ts'), 'it cannot be told from one that is not there'],
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
