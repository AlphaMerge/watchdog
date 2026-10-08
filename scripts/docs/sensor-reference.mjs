#!/usr/bin/env node
// Generates `docs/sensor-reference.md` from the catalogue (TASKS.md H-07).
//
//     node scripts/docs/sensor-reference.mjs            # write
//     node scripts/docs/sensor-reference.mjs --check    # exit 1 if it is out of date
//
// **Generated rather than written**, and the reason is the failure mode of the alternative. A
// hand-written sensor reference is correct on the day it is written and drifts silently from then
// on: a parameter renamed, a default changed, a channel added. Nobody notices, because nothing
// fails. `--check` runs in the test suite, so the reference cannot go stale without the build
// going red.
//
// It is deliberately thin on prose. What a type is *for* belongs in its own file, where the
// author is; what belongs here is the shape — parameters, defaults, channels, cost, credentials —
// which is exactly the part nobody keeps in their head across forty-three types.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { standardCatalogue } from '../../packages/sensors/dist/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = join(root, 'docs', 'sensor-reference.md');
const catalogue = standardCatalogue();

const collapse = (text) => String(text).replace(/\s+/gu, ' ').trim();

function typeOf(schema) {
  if (Array.isArray(schema.enum)) return schema.enum.map((one) => `\`${String(one)}\``).join(' · ');
  if (schema.type === 'array') return `array of ${schema.items?.type ?? 'value'}`;
  return schema.type ?? '—';
}

function defaultOf(schema) {
  if (schema.default === undefined) return '';
  if (schema.default === '') return '_(empty)_';
  if (Array.isArray(schema.default)) return schema.default.length === 0 ? '_(none)_' : '…';
  return `\`${JSON.stringify(schema.default)}\``;
}

function boundsOf(schema) {
  const parts = [];
  if (schema.minimum !== undefined) parts.push(`≥ ${String(schema.minimum)}`);
  if (schema.maximum !== undefined) parts.push(`≤ ${String(schema.maximum)}`);
  if (schema.minLength) parts.push(`≥ ${String(schema.minLength)} chars`);
  if (schema.maxLength !== undefined) parts.push(`≤ ${String(schema.maxLength)} chars`);
  if (schema.minItems !== undefined) parts.push(`≥ ${String(schema.minItems)} entries`);
  if (schema.maxItems !== undefined) parts.push(`≤ ${String(schema.maxItems)} entries`);
  return parts.join(', ');
}

/**
 * Params built to find out whether a type's channel list depends on its parameters.
 *
 * Four types build their channels out of what the operator typed — `rest.custom` from its
 * mappings, `core.factory` and `exe.script.advanced` from their channel names, `snmp.table` from
 * its columns — and every one of them returns a *placeholder* channel when asked with no
 * parameters at all. Printing that placeholder as though it were the type's channel list would be
 * the exact failure this generator exists to prevent, so the shape is probed rather than assumed:
 * every string gets a marker value, every array of objects gets one marked element, and a channel
 * list that changes under that is a channel list the parameters decide.
 *
 * Returns the params and a marker → parameter-path map, so the page can name *which* parameter
 * declares the channels instead of vaguely saying that one does.
 */
function probeFor(schema) {
  const params = {};
  const markers = new Map();
  const marker = (path) => {
    const value = `msdocs-${path.replace(/[^a-z]/giu, '-')}`;
    markers.set(value, path);
    return value;
  };
  const scalar = (prop, path) => {
    if (Array.isArray(prop.enum)) return prop.enum[0];
    if (prop.type === 'string') return marker(path);
    if (prop.type === 'integer' || prop.type === 'number') return prop.minimum ?? 1;
    if (prop.type === 'boolean') return prop.default ?? false;
    return undefined;
  };

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.type === 'array' && prop.items?.type === 'object') {
      const item = {};
      for (const [inner, innerProp] of Object.entries(prop.items.properties ?? {})) {
        const value = scalar(innerProp, `${key}[].${inner}`);
        if (value !== undefined) item[inner] = value;
      }
      params[key] = [item];
      continue;
    }
    const value = scalar(prop, key);
    if (value !== undefined) params[key] = value;
  }
  return { params, markers };
}

function channelRow(channel) {
  const notes = [];
  if (channel.isPrimary === true) notes.push('**primary**');
  if (channel.counter !== undefined) notes.push(`${String(channel.counter.bits)}-bit counter → rate`);
  if (channel.lookup !== undefined) notes.push(`lookup \`${channel.lookup}\``);
  if (channel.limits !== undefined) {
    const bounds = [];
    const { lowerError, lowerWarning, upperWarning, upperError } = channel.limits;
    if (lowerError !== undefined) bounds.push(`error below ${String(lowerError)}`);
    if (lowerWarning !== undefined) bounds.push(`warn below ${String(lowerWarning)}`);
    if (upperWarning !== undefined) bounds.push(`warn above ${String(upperWarning)}`);
    if (upperError !== undefined) bounds.push(`error above ${String(upperError)}`);
    notes.push(`default limits: ${bounds.join(', ')}`);
  }
  const unit = channel.unit === undefined || channel.unit === '' ? '—' : channel.unit;
  return `| \`${channel.key}\` | ${channel.name} | ${unit} | ${notes.join('; ') || '—'} |`;
}

const lines = [];
const say = (...text) => lines.push(...text);

say('# Sensor reference', '');
say(
  '**Generated from the catalogue by `scripts/docs/sensor-reference.mjs`. Do not edit.** ' +
    '`packages/core/test/build-hygiene.test.ts` fails when this file and the code disagree, ' +
    'which is the only way a reference like this stays true.',
  '',
);
say(
  'What a type is *for* is documented where its author wrote it, in ' +
    '`packages/sensors/src/types/`, and how to add one is `docs/adding-a-sensor-type.md`. What ' +
    'is here is the shape: the parameters an operator fills in, what they default to, the ' +
    'channels that come back, and what the type needs in order to run.',
  '',
);

const summaries = catalogue.summaries();
const byCategory = new Map();
for (const summary of summaries) {
  byCategory.set(summary.category, [...(byCategory.get(summary.category) ?? []), summary]);
}
const categories = [...byCategory.keys()].sort();

// A category that is in the catalogue but not in every release, said where a reader meets it:
// in the index and under its heading. 1.0 is Linux-only (`H-10`, `H-16`), and these types need a
// probe running on Windows.
const RELEASE_NOTES = {
  Windows: {
    short: 'not in 1.0 — release 1.1',
    long:
      '**Not in 1.0, which is Linux-only.** These types run PowerShell’s CIM cmdlets from a ' +
      'probe *on* Windows, and 1.0 installs no probe there, so the v1 build profile leaves them ' +
      'out of its catalogue (`H-12`). They are release 1.1’s, once `T-25` has run them against ' +
      'Windows — none of their queries ever has.',
  },
};

say(`${String(summaries.length)} types in ${String(categories.length)} categories.`, '');
for (const category of categories) {
  const ids = byCategory.get(category).map((one) => `\`${one.id}\``);
  const release = RELEASE_NOTES[category];
  say(`- **${category}** — ${ids.join(', ')}${release === undefined ? '' : ` (${release.short})`}`);
}
say('', '---', '');

for (const category of categories) {
  say(`## ${category}`, '');
  if (RELEASE_NOTES[category] !== undefined) say(RELEASE_NOTES[category].long, '');

  for (const summary of byCategory.get(category)) {
    const declaration = catalogue.declaration(summary.id);
    say(`### \`${summary.id}\``, '');

    const facts = [`cost: **${summary.costHint}**`];
    if (declaration.credentialKinds?.length) {
      facts.push(`credentials: ${declaration.credentialKinds.map((k) => `\`${k}\``).join(', ')}`);
    }
    if (declaration.listener !== undefined) {
      facts.push(`fed by the \`${declaration.listener}\` listener, not polled`);
    }
    if (declaration.isolation === 'process') facts.push('runs in a child process');
    if (declaration.evaluatedBy === 'core') facts.push('evaluated by the core, never by a probe');
    if (summary.hasPreview) facts.push('paths can be previewed against a pasted document');
    say(facts.join(' · '), '');

    // Channels, and whether the parameters decide them. See `probeFor`.
    const fixed = declaration.channels({});
    const { params, markers } = probeFor(summary.paramsSchema);
    let probed = fixed;
    try {
      probed = declaration.channels(params);
    } catch {
      probed = fixed;
    }
    const declaresChannels = JSON.stringify(fixed) !== JSON.stringify(probed);

    if (declaresChannels) {
      // Two different things hide behind "the channels changed": a parameter that *names* the
      // channels (a mapping list, a column list) and one that *adds* a channel when it is set
      // (`banner`, `requireAuth`). They read differently to an operator, so they are separated —
      // by probing one parameter at a time, which attributes the change rather than guessing it.
      const found = [...markers]
        .filter(([mark]) => JSON.stringify(probed).includes(mark))
        .map(([, path]) => path);
      // An array parameter gives one channel per entry; a scalar one names the single channel it
      // produces. Same mechanism, and they read nothing alike.
      const perEntry = [...new Set(found.filter((one) => one.includes('[]')).map((one) => one.replace(/\[\]\..*$/u, '')))];
      const byName = [...new Set(found.filter((one) => !one.includes('[]')))];
      const naming = [...perEntry, ...byName];
      const fixedKeys = new Set(fixed.map((one) => one.key));
      const adding = [];
      for (const [key, value] of Object.entries(params)) {
        if (naming.includes(key)) continue;
        let alone;
        try {
          alone = declaration.channels({ [key]: value });
        } catch {
          continue;
        }
        const extra = alone.filter((one) => !fixedKeys.has(one.key));
        if (extra.length > 0) adding.push({ key, extra });
      }

      const list = (paths) => paths.map((one) => `\`${one}\``).join(', ');
      const sentences = [];
      if (perEntry.length > 0) {
        sentences.push(`**The parameters declare the channels** — one per entry in ${list(perEntry)}.`);
      }
      if (byName.length > 0) {
        sentences.push(
          perEntry.length > 0
            ? `${list(byName)} name others.`
            : `**The parameters name this sensor's channel** — see ${list(byName)}.`,
        );
      }
      if (adding.length > 0) {
        sentences.push(
          adding
            .map(
              ({ key, extra }) =>
                `Setting \`${key}\` adds ${extra.map((one) => `\`${one.key}\``).join(', ')}.`,
            )
            .join(' '),
        );
      }
      if (sentences.length === 0) {
        sentences.push('**Which channels this sensor has depends on its parameters.**');
      }
      say(sentences.join(' '), '');

      const keys = new Set(probed.map((one) => one.key));
      const always = fixed.filter((one) => keys.has(one.key));
      if (always.length > 0) {
        say('Every sensor of this type has:', '');
        say('| Channel | Name | Unit | Notes |', '| --- | --- | --- | --- |');
        for (const channel of always) say(channelRow(channel));
        say('');
      }
    } else {
      say('| Channel | Name | Unit | Notes |', '| --- | --- | --- | --- |');
      for (const channel of fixed) say(channelRow(channel));
      say('');
    }

    const properties = summary.paramsSchema.properties ?? {};
    const required = new Set(summary.paramsSchema.required ?? []);
    const keys = Object.keys(properties);
    if (keys.length === 0) {
      say('Takes no parameters.', '');
      continue;
    }

    say('| Parameter | Type | Default | Bounds | |', '| --- | --- | --- | --- | --- |');
    for (const key of keys) {
      const schema = properties[key];
      const flags = [];
      if (required.has(key)) flags.push('**required**');
      if (schema.writeOnly === true) flags.push('**write-only**');
      // `U-34`: what the edit form shows read-only, and the core refuses to change.
      if (schema['x-createOnly'] === true) flags.push('**fixed once created**');
      say(
        `| \`${key}\` | ${typeOf(schema)} | ${defaultOf(schema)} | ${boundsOf(schema)} | ${flags.join(' ')} |`,
      );
    }
    say('');

    // Descriptions below the table rather than inside it. Several run to a paragraph, and a table
    // cell is where a paragraph goes to become unreadable — but truncating them to a first
    // sentence loses the half that says what the parameter is for.
    for (const key of keys) {
      const schema = properties[key];
      if (typeof schema.description !== 'string') continue;
      const label = typeof schema.title === 'string' ? `**${schema.title}** (\`${key}\`)` : `\`${key}\``;
      say(`- ${label} — ${collapse(schema.description)}`);
    }
    say('');
  }
}

const generated = `${lines.join('\n').trimEnd()}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = '';
  }
  if (current !== generated) {
    process.stderr.write(
      'docs/sensor-reference.md is out of date.\nRun: node scripts/docs/sensor-reference.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write('docs/sensor-reference.md is current\n');
} else {
  writeFileSync(target, generated, 'utf8');
  process.stdout.write(`wrote ${target}\n`);
}
