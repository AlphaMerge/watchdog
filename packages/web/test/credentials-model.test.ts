import { describe, expect, it } from 'vitest';
import { ApiError, type Loadable } from '../src/api/client';
import type {
  CredentialView,
  CredentialWrite,
  CredentialWriteCounts,
  EffectiveAccess,
} from '../src/api/types';
import type { Session } from '../src/auth/session';
import { isMultiline, type JsonSchema } from '../src/forms/schema';
import {
  asksForRight,
  boundsSentence,
  channelLinkFor,
  clearedSentence,
  draftFor,
  isDirty,
  kindsToAdd,
  mayWrite,
  needsConfirmation,
  OUTSIDE_MEANS,
  ownerName,
  ownerOf,
  publicRows,
  reasonsPhrase,
  refusedFields,
  removalSentence,
  savedSentence,
  secretChanges,
  secretChangeSentence,
  secretLabels,
} from '../src/routes/detail/credentials-model';
import { tabsFor } from '../src/routes/detail/model';

/**
 * The credential tab's judgements, without a tab (`U-21`).
 *
 * Each of these is a place the tab could be wrong while looking right: offering a control the
 * core will refuse, naming an owner the reader was not granted, calling a save harmless, or
 * wording a count so that it reads as a different count.
 */

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    username: { type: 'string', title: 'User name' },
    password: { type: 'string', writeOnly: true, title: 'Password' },
    privateKey: { type: 'string', writeOnly: true, maxLength: 32_768, title: 'Private key' },
    hostKeyPolicy: {
      enum: ['strict', 'accept-any'],
      default: 'strict',
      title: 'Host key checking',
    },
    allowedTargets: { type: 'array', items: { type: 'string' }, title: 'Allowed targets' },
  },
};

const SET: CredentialView = {
  kind: 'ssh',
  publicParams: { username: 'monitor', hostKeyPolicy: 'strict', allowedTargets: ['10.0.0.0/8'] },
  source: { kind: 'own', objectId: 20 },
  updatedAt: '2026-09-30T08:00:00.000Z',
  bounded: true,
  secretsSet: ['password'],
};

const ready = (right: EffectiveAccess['right']): Loadable<EffectiveAccess> => ({
  status: 'ready',
  data: { right },
});
const LOADING: Loadable<EffectiveAccess> = { status: 'loading' };
const signedIn = (requireAuthentication: boolean): Session => ({
  kind: 'signed-in',
  requireAuthentication,
  principal: { userId: 1, login: 'pat', role: 'readwrite', mustChangePassword: false },
});

describe('who is offered the controls', () => {
  it('asks the core only where the core holds accounts to grants', () => {
    expect(asksForRight(signedIn(true))).toBe(true);
    expect(asksForRight(signedIn(false))).toBe(false);
    expect(asksForRight({ kind: 'anonymous', requireAuthentication: false })).toBe(false);
    expect(asksForRight({ kind: 'anonymous', requireAuthentication: true })).toBe(false);
  });

  it('follows the right the core answered, as a table', () => {
    const table: [Session, Loadable<EffectiveAccess>, boolean][] = [
      [signedIn(true), ready('full'), true],
      [signedIn(true), ready('write'), true],
      [signedIn(true), ready('read'), false],
      [signedIn(true), ready('none'), false],
      // Not answered yet, or not answerable: read-only rather than a control that is refused.
      [signedIn(true), LOADING, false],
      [signedIn(true), { status: 'error', error: new ApiError(500, 'X', 'x') }, false],
      // The layer is off, so nobody's grants apply, whoever is or is not signed in.
      [signedIn(false), LOADING, true],
      [{ kind: 'anonymous', requireAuthentication: false }, LOADING, true],
      // Nobody is signed in and somebody has to be: the login form is up, and nothing is offered.
      [{ kind: 'anonymous', requireAuthentication: true }, LOADING, false],
      [{ kind: 'unknown' }, ready('full'), false],
      [{ kind: 'unreachable', error: new ApiError(0, 'UNREACHABLE', 'x') }, ready('full'), false],
    ];
    for (const [session, access, expected] of table) {
      expect(mayWrite(session, access), JSON.stringify([session.kind, access.status])).toBe(
        expected,
      );
    }
  });
});

describe('where a set comes from', () => {
  const ancestors = [
    { id: 10, name: 'Local probe' },
    { id: 15, name: 'Datacentre' },
  ];

  it('is here when the set is stored on the object asked about', () => {
    expect(ownerOf({ kind: 'own', objectId: 20 }, 20, ancestors)).toEqual({ kind: 'here' });
  });

  it('is the ancestor, by name, when the reader can see it', () => {
    expect(ownerOf({ kind: 'inherited', objectId: 15, depth: 1 }, 20, ancestors)).toEqual({
      kind: 'ancestor',
      id: 15,
      name: 'Datacentre',
    });
  });

  it('is outside the view when the breadcrumb does not hold it, or has not loaded', () => {
    expect(ownerOf({ kind: 'inherited', objectId: 1, depth: 3 }, 20, ancestors)).toEqual({
      kind: 'outside',
    });
    expect(ownerOf({ kind: 'inherited', objectId: 15, depth: 1 }, 20, null)).toEqual({
      kind: 'outside',
    });
  });

  it('is named in a sentence without an id for an owner outside the view', () => {
    const object = { name: 'Rack A' };
    expect(ownerName({ kind: 'here' }, object)).toBe('Rack A');
    expect(ownerName({ kind: 'ancestor', id: 15, name: 'Datacentre' }, object)).toBe('Datacentre');
    expect(ownerName({ kind: 'outside' }, object)).toBe('an object outside your view');
  });
});

describe('what a set shows', () => {
  it('lists the public fields that hold something, in the kind’s order, with the form’s labels', () => {
    expect(
      publicRows(SCHEMA, { allowedTargets: ['a.example', '10.0.0.0/8'], username: 'monitor' }),
    ).toEqual([
      { name: 'username', label: 'User name', value: 'monitor' },
      { name: 'allowedTargets', label: 'Allowed targets', value: 'a.example, 10.0.0.0/8' },
    ]);
  });

  it('leaves out an empty value, an empty list and a secret, whatever the read carries', () => {
    expect(
      publicRows(SCHEMA, { username: '', allowedTargets: [], password: 'never', privateKey: 'no' }),
    ).toEqual([]);
  });

  it('shows a field the catalogue does not declare under its own name', () => {
    expect(publicRows(SCHEMA, { port: 22 })).toEqual([
      { name: 'port', label: 'port', value: '22' },
    ]);
  });
});

describe('what a form starts from', () => {
  it('is the kind’s defaults for a new set, and never a secret', () => {
    expect(draftFor(SCHEMA, null)).toEqual({ hostKeyPolicy: 'strict' });
  });

  it('is the stored public half for an existing one, copied', () => {
    const draft = draftFor(SCHEMA, SET);
    expect(draft).toEqual(SET.publicParams);
    expect(draft).not.toBe(SET.publicParams);
  });

  it('offers the kinds the object stores no set of, an inherited kind included', () => {
    const kinds = ['snmp', 'ssh', 'http'].map((id) => ({
      id,
      name: id.toUpperCase(),
      description: '',
      schema: {},
    }));
    const inherited: CredentialView = {
      ...SET,
      kind: 'snmp',
      source: { kind: 'inherited', objectId: 10, depth: 1 },
    };
    expect(kindsToAdd(kinds, [SET, inherited]).map((kind) => kind.id)).toEqual(['snmp', 'http']);
  });
});

describe('what a save does to each secret', () => {
  it('keeps one left alone, replaces one typed, removes one set to null, stores a new one', () => {
    expect(secretChanges(SCHEMA, { username: 'monitor' }, ['password'])).toEqual({
      replaced: [],
      cleared: [],
      added: [],
    });
    expect(secretChanges(SCHEMA, { password: 'new' }, ['password'])).toEqual({
      replaced: ['Password'],
      cleared: [],
      added: [],
    });
    expect(secretChanges(SCHEMA, { password: null, privateKey: 'key' }, ['password'])).toEqual({
      replaced: [],
      cleared: ['Password'],
      added: ['Private key'],
    });
    // Clearing what was never stored, and an empty box, change nothing.
    expect(secretChanges(SCHEMA, { privateKey: null, password: '' }, [])).toEqual({
      replaced: [],
      cleared: [],
      added: [],
    });
  });

  it('says so in one sentence, or says nothing', () => {
    expect(secretChangeSentence({ replaced: [], cleared: [], added: [] })).toBeNull();
    expect(
      secretChangeSentence({ added: ['Private key'], replaced: ['Password'], cleared: ['Token'] }),
    ).toBe(
      'On save: Private key will be stored; Password will be replaced; Token will be removed.',
    );
  });

  it('is dirty for a new set, a changed public field or a changed secret, and for nothing else', () => {
    expect(isDirty({}, null, SCHEMA)).toBe(true);
    expect(isDirty({ ...SET.publicParams }, SET, SCHEMA)).toBe(false);
    // The order of keys is not a change.
    expect(
      isDirty(
        { allowedTargets: ['10.0.0.0/8'], hostKeyPolicy: 'strict', username: 'monitor' },
        SET,
        SCHEMA,
      ),
    ).toBe(false);
    expect(isDirty({ ...SET.publicParams, username: 'other' }, SET, SCHEMA)).toBe(true);
    expect(isDirty({ ...SET.publicParams, allowedTargets: [] }, SET, SCHEMA)).toBe(true);
    expect(isDirty({ ...SET.publicParams, password: 'new' }, SET, SCHEMA)).toBe(true);
    expect(isDirty({ ...SET.publicParams, password: null }, SET, SCHEMA)).toBe(true);
    // Clearing a secret the set never held sends nothing new.
    expect(isDirty({ ...SET.publicParams, privateKey: null }, SET, SCHEMA)).toBe(false);
  });
});

describe('what a previewed save says', () => {
  const NONE = { withholds: 0, withheldBefore: 0, newlyWithheld: 0, noLongerWithheld: 0 };
  /**
   * A write's answer. Unless a test says otherwise, every sensor that is outside is on a device
   * the targets do not cover, which is what the counts were before they were split (`A-59`).
   */
  const answer = (
    over: Partial<CredentialWrite>,
    unpinnable: Partial<CredentialWriteCounts> = {},
  ): CredentialWrite => {
    const all = { ...NONE, ...over };
    const named = { ...NONE, ...unpinnable };
    return {
      ...SET,
      ...all,
      byReason: {
        outside: {
          withholds: all.withholds - named.withholds,
          withheldBefore: all.withheldBefore - named.withheldBefore,
          newlyWithheld: all.newlyWithheld - named.newlyWithheld,
          noLongerWithheld: all.noLongerWithheld - named.noLongerWithheld,
        },
        unpinnable: named,
      },
      secretsCleared: [],
      ...over,
    };
  };

  it('needs confirming when it puts a sensor outside or clears a secret, and only then', () => {
    expect(needsConfirmation(answer({}))).toBe(false);
    expect(needsConfirmation(answer({ withholds: 1, newlyWithheld: 1 }))).toBe(true);
    expect(needsConfirmation(answer({ secretsCleared: ['password'] }))).toBe(true);
    // `A-55`: sensors that were outside already, or that the save brings back, are not a reason
    // to stop. A set with some outside asked on every save, whatever the save changed.
    expect(needsConfirmation(answer({ withholds: 6, withheldBefore: 6 }))).toBe(false);
    expect(needsConfirmation(answer({ withheldBefore: 6, noLongerWithheld: 6 }))).toBe(false);
  });

  it('says how many sensors the save puts outside, in the singular and the plural', () => {
    expect(boundsSentence(answer({}), 'Rack A', 'will')).toBeNull();
    expect(boundsSentence(answer({}), 'Rack A', 'now')).toBeNull();
    const one = answer({ withholds: 1, newlyWithheld: 1 });
    const six = answer({ withholds: 6, newlyWithheld: 6 });
    expect(boundsSentence(one, 'Rack A', 'will')).toBe(
      "This save puts 1 sensor beneath Rack A outside this set's bounds: on a device the allowed targets do not cover. That sensor is not sent the set after the save and reads Unknown until the bounds include it.",
    );
    expect(boundsSentence(six, 'Rack A', 'will')).toBe(
      "This save puts 6 sensors beneath Rack A outside this set's bounds: all on devices the allowed targets do not cover. Those sensors are not sent the set after the save and read Unknown until the bounds include them.",
    );
    expect(boundsSentence(one, 'Rack A', 'now')).toBe(
      'This save put 1 sensor beneath Rack A outside its bounds: on a device the allowed targets do not cover. That sensor is not sent the set and reads Unknown.',
    );
    expect(boundsSentence(six, 'Rack A', 'now')).toBe(
      'This save put 6 sensors beneath Rack A outside its bounds: all on devices the allowed targets do not cover. Those sensors are not sent the set and read Unknown.',
    );
  });

  it('says why the sensors are outside: how many for each of the two reasons (A-59)', () => {
    // The phrase alone: both reasons with their numbers, one reason without, none at all.
    expect(reasonsPhrase(4, 2)).toBe(
      ': 4 on devices the allowed targets do not cover, and 2 on devices entered by name, with a sensor type that cannot be held to a checked address',
    );
    expect(reasonsPhrase(1, 1)).toBe(
      ': 1 on a device the allowed targets do not cover, and 1 on a device entered by name, with a sensor type that cannot be held to a checked address',
    );
    expect(reasonsPhrase(0, 3)).toBe(
      ': all on devices entered by name, with a sensor type that cannot be held to a checked address',
    );
    expect(reasonsPhrase(0, 1)).toBe(
      ': on a device entered by name, with a sensor type that cannot be held to a checked address',
    );
    expect(reasonsPhrase(2, 0)).toBe(': all on devices the allowed targets do not cover');
    expect(reasonsPhrase(0, 0)).toBe('');

    // Six put outside, two of them for the name.
    const mixed = answer({ withholds: 6, newlyWithheld: 6 }, { withholds: 2, newlyWithheld: 2 });
    expect(boundsSentence(mixed, 'Rack A', 'will')).toBe(
      "This save puts 6 sensors beneath Rack A outside this set's bounds: 4 on devices the allowed targets do not cover, and 2 on devices entered by name, with a sensor type that cannot be held to a checked address. Those sensors are not sent the set after the save and read Unknown until the bounds include them.",
    );
    expect(boundsSentence(mixed, 'Rack A', 'now')).toBe(
      'This save put 6 sensors beneath Rack A outside its bounds: 4 on devices the allowed targets do not cover, and 2 on devices entered by name, with a sensor type that cannot be held to a checked address. Those sensors are not sent the set and read Unknown.',
    );
    // One put outside, for the name.
    const named = answer({ withholds: 1, newlyWithheld: 1 }, { withholds: 1, newlyWithheld: 1 });
    expect(boundsSentence(named, 'Rack A', 'will')).toBe(
      "This save puts 1 sensor beneath Rack A outside this set's bounds: on a device entered by name, with a sensor type that cannot be held to a checked address. That sensor is not sent the set after the save and reads Unknown until the bounds include it.",
    );
    // Two put outside for their address beside three that stay outside, one of those for the
    // name: each number is said with the reason of the sensors it counts, and no other.
    const beside = answer(
      { withholds: 5, withheldBefore: 3, newlyWithheld: 2 },
      { withholds: 1, withheldBefore: 1 },
    );
    expect(boundsSentence(beside, 'Rack A', 'will')).toBe(
      "This save puts 2 sensors beneath Rack A outside this set's bounds: all on devices the allowed targets do not cover. Those sensors are not sent the set after the save and read Unknown until the bounds include them. 3 sensors beneath Rack A are outside already and this save leaves them there: 2 on devices the allowed targets do not cover, and 1 on a device entered by name, with a sensor type that cannot be held to a checked address.",
    );
    expect(boundsSentence(beside, 'Rack A', 'now')).toBe(
      'This save put 2 sensors beneath Rack A outside its bounds: all on devices the allowed targets do not cover. Those sensors are not sent the set and read Unknown. 3 sensors beneath Rack A were outside already and still are: 2 on devices the allowed targets do not cover, and 1 on a device entered by name, with a sensor type that cannot be held to a checked address.',
    );
    // A sensor that stays outside for another reason than before is said under the reason
    // that holds after the save: the two named ones are simply not covered now.
    const changed: CredentialWrite = {
      ...answer({ withholds: 2, withheldBefore: 2 }),
      byReason: {
        outside: { withholds: 2, withheldBefore: 0, newlyWithheld: 0, noLongerWithheld: 0 },
        unpinnable: { withholds: 0, withheldBefore: 2, newlyWithheld: 0, noLongerWithheld: 0 },
      },
    };
    expect(boundsSentence(changed, 'Rack A', 'will')).toBe(
      '2 sensors beneath Rack A are outside already and this save leaves them there: all on devices the allowed targets do not cover.',
    );
  });

  it('never says "it" where a listener could take it for the device, the targets or the save', () => {
    // Read aloud in one line, each sentence after the first has to name what it is about.
    const everything = answer(
      { withholds: 3, withheldBefore: 3, newlyWithheld: 1, noLongerWithheld: 1 },
      { withholds: 1, withheldBefore: 1 },
    );
    for (const tense of ['will', 'now'] as const) {
      const said = boundsSentence(everything, 'Rack A', tense) ?? '';
      const sentences = said.split(/(?<=\.) /u);
      expect(sentences).toHaveLength(4);
      for (const sentence of sentences.slice(1)) {
        expect(sentence).not.toMatch(/^(It|They) /u);
      }
      expect(said).not.toMatch(/after it\b/u);
      expect(sentences[1]).toMatch(/^That sensor is not sent the set/u);
      expect(sentences[2]).toMatch(/^The save also /u);
    }
  });

  it('says the sensors that were outside already apart from the ones the save puts there', () => {
    const standing = answer({ withholds: 6, withheldBefore: 6 });
    expect(boundsSentence(standing, 'Rack A', 'will')).toBe(
      '6 sensors beneath Rack A are outside already and this save leaves them there: all on devices the allowed targets do not cover.',
    );
    expect(boundsSentence(standing, 'Rack A', 'now')).toBe(
      '6 sensors beneath Rack A were outside already and still are: all on devices the allowed targets do not cover.',
    );
    const single = answer({ withholds: 1, withheldBefore: 1 });
    expect(boundsSentence(single, 'Rack A', 'will')).toBe(
      '1 sensor beneath Rack A is outside already and this save leaves it there: on a device the allowed targets do not cover.',
    );
    expect(boundsSentence(single, 'Rack A', 'now')).toBe(
      '1 sensor beneath Rack A was outside already and still is: on a device the allowed targets do not cover.',
    );
    // Two more on top of four: the two are the save's, the four are not.
    const more = answer({ withholds: 6, withheldBefore: 4, newlyWithheld: 2 });
    expect(boundsSentence(more, 'Rack A', 'will')).toBe(
      "This save puts 2 sensors beneath Rack A outside this set's bounds: all on devices the allowed targets do not cover. Those sensors are not sent the set after the save and read Unknown until the bounds include them. 4 sensors beneath Rack A are outside already and this save leaves them there: all on devices the allowed targets do not cover.",
    );
    expect(boundsSentence(more, 'Rack A', 'now')).toBe(
      'This save put 2 sensors beneath Rack A outside its bounds: all on devices the allowed targets do not cover. Those sensors are not sent the set and read Unknown. 4 sensors beneath Rack A were outside already and still are: all on devices the allowed targets do not cover.',
    );
  });

  it('says the sensors the save brings back, alone and beside the ones it puts outside', () => {
    const back = answer({ withheldBefore: 3, noLongerWithheld: 3 });
    expect(boundsSentence(back, 'Rack A', 'will')).toBe(
      'This save brings 3 sensors beneath Rack A back inside, to be sent the set again.',
    );
    expect(boundsSentence(back, 'Rack A', 'now')).toBe(
      'This save brought 3 sensors beneath Rack A back inside.',
    );
    // The bounds moved: as many outside as before, and not the same ones.
    const moved = answer({
      withholds: 1,
      withheldBefore: 1,
      newlyWithheld: 1,
      noLongerWithheld: 1,
    });
    expect(boundsSentence(moved, 'Rack A', 'will')).toBe(
      "This save puts 1 sensor beneath Rack A outside this set's bounds: on a device the allowed targets do not cover. That sensor is not sent the set after the save and reads Unknown until the bounds include it. The save also brings 1 sensor back inside, to be sent the set again.",
    );
    expect(boundsSentence(moved, 'Rack A', 'now')).toBe(
      'This save put 1 sensor beneath Rack A outside its bounds: on a device the allowed targets do not cover. That sensor is not sent the set and reads Unknown. The save also brought 1 sensor back inside.',
    );
  });

  it('says in words that a named device can be outside whatever its name resolves to', () => {
    expect(OUTSIDE_MEANS).toBe(
      "A sensor is outside a set's bounds when its device's address is not one the allowed targets cover. A sensor is also outside when its device is entered by name, the targets are addresses, and the sensor's type cannot be held to an address its probe has checked: whatever the name resolves to, the set is not sent.",
    );
  });

  it('names the secrets a widening clears by the form’s labels', () => {
    expect(secretLabels(SCHEMA, ['privateKey', 'password', 'unknownField'])).toEqual([
      'Private key',
      'Password',
      'unknownField',
    ]);
    expect(clearedSentence([], 'will')).toBeNull();
    expect(clearedSentence(['Password', 'Private key'], 'will')).toBe(
      'This save lets the set go further than before, so Password and Private key will be cleared. Go back and enter them again to keep them.',
    );
    expect(clearedSentence(['Password', 'Private key', 'Token'], 'now')).toBe(
      'Cleared because the set may now go further: Password, Private key and Token. Enter them again, or the sensors using this set cannot authenticate.',
    );
  });

  it('says what the write answered once it is saved', () => {
    expect(savedSentence('SSH', 'Rack A', answer({}), SCHEMA)).toBe('Saved the SSH set on Rack A.');
    expect(
      savedSentence(
        'SSH',
        'Rack A',
        answer({ withholds: 2, newlyWithheld: 2, secretsCleared: ['password'] }),
        SCHEMA,
      ),
    ).toBe(
      'Saved the SSH set on Rack A. This save put 2 sensors beneath Rack A outside its bounds: all on devices the allowed targets do not cover. Those sensors are not sent the set and read Unknown. Cleared because the set may now go further: Password. Enter it again, or the sensors using this set cannot authenticate.',
    );
  });
});

describe('what a removal says', () => {
  const object = { id: 20, name: 'Rack A' };
  const ancestors = [{ id: 10, name: 'Local probe' }];
  const from = (objectId: number): CredentialView => ({
    ...SET,
    source: { kind: 'inherited', objectId, depth: 1 },
  });

  it('says nothing loses a credential when no sensor uses the set', () => {
    expect(
      removalSentence('SSH', object, { sensors: 0, nowInherited: from(10) }, ancestors, 'will'),
    ).toBe('No sensor beneath Rack A uses this set, so nothing loses a credential.');
    expect(
      removalSentence('SSH', object, { sensors: 0, nowInherited: null }, ancestors, 'now'),
    ).toBe('No sensor beneath Rack A was using it.');
  });

  it('names the set that comes into force, by its owner', () => {
    expect(
      removalSentence('SSH', object, { sensors: 3, nowInherited: from(10) }, ancestors, 'will'),
    ).toBe(
      '3 sensors beneath Rack A use this set and will lose it. They will use the set on Local probe instead.',
    );
    expect(
      removalSentence('SSH', object, { sensors: 1, nowInherited: from(10) }, ancestors, 'now'),
    ).toBe('1 sensor beneath Rack A lost it. It now uses the set on Local probe.');
  });

  it('does not name an owner outside the reader’s view', () => {
    expect(
      removalSentence('SSH', object, { sensors: 1, nowInherited: from(1) }, ancestors, 'will'),
    ).toBe(
      '1 sensor beneath Rack A uses this set and will lose it. It will use the set on an object outside your view instead.',
    );
  });

  it('says the sensors are left with none when nothing above defines one', () => {
    expect(
      removalSentence('SSH', object, { sensors: 2, nowInherited: null }, ancestors, 'will'),
    ).toBe(
      '2 sensors beneath Rack A use this set and will lose it. Nothing above defines SSH credentials, so they will have none and their checks will fail to authenticate.',
    );
    expect(
      removalSentence('SSH', object, { sensors: 1, nowInherited: null }, ancestors, 'now'),
    ).toBe(
      '1 sensor beneath Rack A lost it. Nothing above defines SSH credentials, so it has none.',
    );
  });
});

describe('a refused write', () => {
  it('lands on the field the vault names, at the path the form gave it', () => {
    const error = new ApiError(
      400,
      'CREDENTIAL_INVALID',
      'allowed target 3: nope',
      undefined,
      {},
      {
        kind: 'snmp',
        field: 'allowedTargets/2',
      },
    );
    expect(refusedFields(error)).toEqual([
      { path: 'allowedTargets.2', message: 'allowed target 3: nope' },
    ]);
  });

  it('lands nowhere when the refusal is about the whole document, or names nothing', () => {
    expect(
      refusedFields(
        new ApiError(400, 'CREDENTIAL_INVALID', 'x', undefined, {}, { field: 'values' }),
      ),
    ).toEqual([]);
    expect(refusedFields(new ApiError(403, 'AUTH_FORBIDDEN', 'x'))).toEqual([]);
  });

  it('reads the request schema’s problems too, without the body’s own prefix', () => {
    const error = new ApiError(400, 'VALIDATION', 'x', undefined, {
      problems: [
        { instancePath: '/values/version', message: 'must be one of' },
        { instancePath: '/values', message: 'must be object' },
      ],
    });
    expect(refusedFields(error)).toEqual([{ path: 'version', message: 'must be one of' }]);
  });
});

describe('the way from Core Health to the list', () => {
  it('links that channel on that type, and nothing else', () => {
    expect(channelLinkFor('ms.core.health', 'credentialsUnbounded')).toEqual({
      to: '/credentials/unbounded',
      label: 'Which sets',
    });
    expect(channelLinkFor('ms.core.health', 'credentialsToReenter')).toBeNull();
    expect(channelLinkFor('script.custom', 'credentialsUnbounded')).toBeNull();
    expect(channelLinkFor(undefined, 'credentialsUnbounded')).toBeNull();
  });
});

describe('the object page’s tabs', () => {
  const ids = (kind: string): string[] => tabsFor({ kind }).map((tab) => tab.id);

  it('has Credentials on everything that can store a set, and not on a sensor', () => {
    for (const kind of ['root', 'probe', 'group', 'device']) {
      expect(ids(kind), kind).toEqual([
        'overview',
        'log',
        'settings',
        'credentials',
        'triggers',
        'changes',
      ]);
    }
    expect(ids('sensor')).toEqual([
      'overview',
      'history',
      'log',
      'settings',
      'triggers',
      'changes',
    ]);
  });
});

describe('a secret that holds more than a line', () => {
  it('is told by the length its schema allows', () => {
    expect(isMultiline({ type: 'string', maxLength: 32_768 })).toBe(true);
    expect(isMultiline({ type: 'string', maxLength: 4_096 })).toBe(false);
    expect(isMultiline({ type: 'string', maxLength: 1_024 })).toBe(false);
    expect(isMultiline({ type: 'string' })).toBe(false);
  });
});
