import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
 * **And what the core writes when it runs**: every line it logs, which is the operator's journal,
 * and the message of every error it builds or throws, which is how a refusal reaches the caller.
 * Those are read from `src` as the web's `operator-text.test.ts` reads its own, since nothing
 * registers them. What a sensor type or the probe says at check time is held by the sensors' and
 * the probe's tests, which read every string of theirs.
 *
 * **Not the OpenAPI document.** Its descriptions are the API reference, for whoever writes a
 * client, and cite tickets by the dozen; `U-92` records that as seen and leaves it to its own
 * ticket. So the route schemas are not read, nor the SQL, whose comments are where a query's
 * ticket goes.
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

/** The methods a pino logger writes a line with, and `child`, whose bindings are on each. */
const LOGS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'child']);

const SRC = join(import.meta.dirname, '..', '..', 'src');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

interface Written {
  readonly file: string;
  readonly line: number;
  readonly how: 'log' | 'error';
  readonly text: string;
}

/**
 * Every string the core's source logs, or builds an error with: in the arguments of a logger's
 * call, of a `new …Error(…)`, and in what a `throw` throws. Comments are not strings, and the
 * OpenAPI schemas and the SQL are neither of these.
 */
function writtenIn(file: string): Written[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: Written[] = [];
  const collect =
    (how: Written['how']) =>
    (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({ file: relative(SRC, file), line: line + 1, how, text: node.text });
      }
      ts.forEachChild(node, collect(how));
    };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LOGS.has(node.expression.name.text)
    ) {
      node.arguments.forEach(collect('log'));
      visit(node.expression);
      return;
    }
    if (ts.isNewExpression(node) && /Error$/u.test(node.expression.getText(source))) {
      node.arguments?.forEach(collect('error'));
      return;
    }
    if (ts.isThrowStatement(node)) {
      collect('error')(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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

  it('cites none in a line the core logs or an error it builds', () => {
    const files = filesUnder(SRC);
    const written = files.flatMap(writtenIn);
    // The walk reaches the start-up log, a migration's, and a refusal's message.
    assert.ok(files.length > 100, String(files.length));
    for (const [file, how, text] of [
      [join('objects', 'sensor-type-gate.ts'), 'log', 'no sensor types are registered'],
      [join('db', 'migrations', '073-channel-declared-shape.ts'), 'log', 'nothing judges'],
      [join('db', 'migrations', '071-legible-delivery-errors.ts'), 'log', 'made legible'],
      [join('auth', 'groups.ts'), 'error', 'cannot be deleted'],
    ] as const) {
      assert.ok(
        written.some((one) => one.file === file && one.how === how && one.text.includes(text)),
        `the walk reaches the ${how} in ${file} that says "${text}"`,
      );
    }
    assert.deepEqual(
      written
        .filter((one) => TICKET.test(one.text))
        .map((one) => `${one.file}:${String(one.line)}: ${one.text.trim()}`),
      [],
    );
  });
});
