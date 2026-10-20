import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BUILT_IN_SENSOR_TYPES, CREDENTIAL_KINDS, withheldReason } from '@ms/sensors';
import { DISCOVERY_LEVELS, PATTERN_MESSAGE } from '@ms/shared';
import { BUILT_IN_DEVICE_TEMPLATES } from '../src/device-templates/built-in.js';
import { BUILT_IN_LOOKUPS } from '../src/lookups/built-in.js';
import { notificationMethods } from '../src/notifications/methods.js';
import { describeSummarisationModes } from '../src/notifications/summarisation.js';
import { coreCatalogue } from '../src/profile.js';
import { settingRegistry } from '../src/settings/registry.js';
import { triggerKinds } from '../src/triggers/definition.js';

/**
 * No internal ticket in what the API serves an operator to read (`U-92`).
 *
 * Walked in a browser (`U-23`), a sensor's form told the operator why its packets are 0.2 s apart
 * "(`P-07`)", and an SSH set's host keys what they bound "(`A-41b`)": tickets of this repository,
 * which nobody running the product can look up. Removing the three found is half the fix; this
 * is the other half, so a new one cannot creep in. It walks what the routes serve, as they serve
 * it — every sensor type's parameters and channels, a type the build leaves out and why, every
 * credential kind, notification method, trigger kind, summarisation mode, setting, lookup,
 * device template and discovery level — and fails on a ticket in any title, description, name,
 * text, unit, pattern sentence or limit message.
 *
 * **Not the OpenAPI document.** Its descriptions are the API reference, for whoever writes a
 * client, and cite tickets by the dozen; `U-92` records that as seen and leaves it to its own
 * ticket. Nor a problem a route builds when it refuses: none in the source cites one, and those
 * found were fixed with their own tests (`map-images.test.ts`, the sensors' `netflow5.test.ts`).
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

interface Read {
  readonly where: string;
  readonly text: string;
}

/** Every string under a key in `READ`, anywhere in a value, by its path. */
function readIn(value: unknown, where: string): Read[] {
  if (Array.isArray(value)) {
    return value.flatMap((one, index) => readIn(one, `${where}[${String(index)}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]): Read[] =>
    typeof child === 'string'
      ? READ.has(key)
        ? [{ where: `${where}.${key}`, text: child }]
        : []
      : readIn(child, `${where}.${key}`),
  );
}

/** What the API serves for an operator to read, as each route serves it. */
function served(): Read[] {
  const catalogue = coreCatalogue('full');
  return [
    // `GET /sensor-types`, and each sensor's channels as its detail lists them.
    ...catalogue
      .summaries()
      .flatMap((type) => [
        ...readIn(type, `sensor type ${type.id}`),
        ...readIn(catalogue.channelsFor(type.id, {}), `channels of ${type.id}`),
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
  ];
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
    const texts = served();
    // The walk reaches every part of it: a parameter's description, a channel's name, a reason
    // a type is left out, a method's setting, a trigger's, a mode's, a setting's, a lookup's
    // state text, a template's description and a discovery level's.
    assert.ok(texts.length > 1_000, String(texts.length));
    for (const part of [
      /^sensor type icmp\.ping\.paramsSchema\.properties\.intervalSeconds\.description$/u,
      /^channels of icmp\.ping\[\d+\]\.name$/u,
      /^why v1 leaves out flow\.netflow$/u,
      /^credential kinds\[\d+\]\.schema\.properties\.hostKeys\.description$/u,
      /^notification methods\[\d+\]\.settingsSchema\.properties\.secretArgs\.title$/u,
      /^trigger kinds\[\d+\]\.description$/u,
      /^summarisation modes\[\d+\]\.description$/u,
      /^settings\[\d+\]\.description$/u,
      /^lookups\[\d+\]\.entries\[\d+\]\.text$/u,
      /^device templates\[\d+\]\.description$/u,
      /^discovery levels\[\d+\]\.description$/u,
    ]) {
      assert.ok(
        texts.some((one) => part.test(one.where)),
        `the walk reaches ${part.source}`,
      );
    }
    assert.deepEqual(
      texts.filter((one) => TICKET.test(one.text)).map((one) => `${one.where}: ${one.text}`),
      [],
    );
  });
});
