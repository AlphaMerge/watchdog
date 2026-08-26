import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  describePlaceholders,
  placeholderNames,
  render,
  substitute,
  unknownPlaceholdersIn,
  type MessageContext,
} from '../src/notifications/placeholders.js';

const AT = new Date('2026-08-26T14:30:00.000Z');
const SINCE = new Date('2026-08-26T12:15:45.000Z');

function context(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    sensorId: 42,
    sensorName: 'Ping',
    deviceName: 'edge-router',
    groupName: 'Frankfurt',
    probeName: 'Local probe',
    host: '192.0.2.7',
    location: 'DC1, rack 14',
    comments: 'replaced the SFP in March',
    tags: ['core', 'wan'],
    priority: 2,
    state: 'down',
    previousState: 'up',
    message: 'no ICMP reply from 192.0.2.7',
    lastValue: 812,
    at: AT,
    since: SINCE,
    publicUrl: 'https://monitoring.example.test',
    siteName: 'Acme production',
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The list CAPABILITIES.MD §5.2 names.
// -------------------------------------------------------------------------------------------

describe('the placeholders', () => {
  it('has every name the scope contract lists', () => {
    // §5.2's list, verbatim. A placeholder quietly dropped from this build is a template that
    // stops working, so the contract is asserted rather than assumed.
    const required = [
      'sensor',
      'device',
      'group',
      'probe',
      'status',
      'laststatus',
      'lastmessage',
      'lastvalue',
      'datetime',
      'since',
      'linksensor',
      'priority',
      'comments',
      'objecttags',
      'host',
      'location',
      'sitename',
    ];
    const known = placeholderNames();
    for (const name of required) {
      assert.ok(known.includes(name), `%${name} is in CAPABILITIES.MD §5.2 and not in this build`);
    }
  });

  it('describes each one, for the form that helps somebody write a template', () => {
    for (const { name, description } of describePlaceholders()) {
      assert.ok(description.length > 0, `%${name} has no description`);
    }
  });

  it('resolves each one from the context', () => {
    const c = context();
    const cases: [string, string][] = [
      ['%sensor', 'Ping'],
      ['%device', 'edge-router'],
      ['%group', 'Frankfurt'],
      ['%probe', 'Local probe'],
      ['%host', '192.0.2.7'],
      ['%location', 'DC1, rack 14'],
      ['%comments', 'replaced the SFP in March'],
      ['%objecttags', 'core, wan'],
      ['%priority', '2'],
      ['%status', 'down'],
      ['%laststatus', 'up'],
      ['%lastmessage', 'no ICMP reply from 192.0.2.7'],
      ['%lastvalue', '812'],
      ['%datetime', '2026-08-26T14:30:00Z'],
      ['%since', '2026-08-26T12:15:45Z'],
      ['%linksensor', 'https://monitoring.example.test/objects/42'],
      ['%sitename', 'Acme production'],
    ];
    for (const [token, expected] of cases) {
      assert.equal(substitute(token, c).text, expected, token);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Case-insensitivity — one of the two rules the ticket names.
// -------------------------------------------------------------------------------------------

describe('case', () => {
  it('treats every casing of a name as the same placeholder', () => {
    // An operator writing a sentence capitalises the first word, and a system that blanked
    // "%Sensor is down" would be punishing correct English.
    const c = context();
    for (const token of ['%sensor', '%Sensor', '%SENSOR', '%SeNsOr']) {
      assert.equal(substitute(token, c).text, 'Ping', token);
    }
  });

  it('reports an unknown name in lower case, however it was written', () => {
    assert.deepEqual(unknownPlaceholdersIn('%LastVlaue and %lastvlaue'), ['lastvlaue']);
  });
});

// -------------------------------------------------------------------------------------------
// Unknown placeholders — the other rule, and the one that is easy to get wrong.
// -------------------------------------------------------------------------------------------

describe('an unknown placeholder', () => {
  it('is left exactly as written, never blanked', () => {
    // A message that quietly loses `%lastvlaue` reads perfectly and says nothing. One that keeps
    // it is a message an operator can look at and see immediately what is wrong.
    const result = substitute('%sensor is %lastvlaue', context());
    assert.equal(result.text, 'Ping is %lastvlaue');
    assert.deepEqual(result.unknown, ['lastvlaue']);
  });

  it('is reported once however often it appears', () => {
    const result = substitute('%nope %nope %nope', context());
    assert.deepEqual(result.unknown, ['nope']);
  });

  it('does not stop the rest of the message being built', () => {
    const result = substitute('%device: %nope (%status)', context());
    assert.equal(result.text, 'edge-router: %nope (down)');
  });

  it('finds nothing in a template that uses only known names', () => {
    assert.deepEqual(unknownPlaceholdersIn('%sensor on %device is %status since %since'), []);
  });
});

// -------------------------------------------------------------------------------------------
// What is and is not a placeholder.
// -------------------------------------------------------------------------------------------

describe('parsing', () => {
  it('leaves a per cent sign that is not a placeholder alone', () => {
    // "CPU at 90% used" has to survive, and it does: the `%` is followed by a space.
    const result = substitute('CPU at 90% used, 50% free', context());
    assert.equal(result.text, 'CPU at 90% used, 50% free');
    assert.deepEqual(result.unknown, []);
  });

  it('reads %% as a literal per cent sign', () => {
    // The escape, and the only way to write a per cent immediately before a word.
    const result = substitute('disk is at 90%%full', context());
    assert.equal(result.text, 'disk is at 90%full');
    assert.deepEqual(result.unknown, []);
  });

  it('does not treat an escaped per cent as the start of a placeholder', () => {
    assert.deepEqual(unknownPlaceholdersIn('100%%uptime'), []);
  });

  it('stops a name at the first character that is not a letter', () => {
    const c = context();
    assert.equal(substitute('%sensor: down', c).text, 'Ping: down');
    assert.equal(substitute('[%sensor]', c).text, '[Ping]');
    assert.equal(substitute('%sensor,%device', c).text, 'Ping,edge-router');
    // Digits end a name too, which is why there is no `%channel1`.
    assert.deepEqual(unknownPlaceholdersIn('%sensor1'), []);
  });

  it('substitutes a value that itself contains a per cent sign without rescanning it', () => {
    // The classic bug in a substituting renderer: a message reading "disk 90% full" gets
    // re-parsed and its own text starts being treated as placeholders.
    const result = substitute('%lastmessage', context({ message: 'disk at 90%full' }));
    assert.equal(result.text, 'disk at 90%full');
    assert.deepEqual(result.unknown, [], 'the substituted text is output, not input');
  });
});

// -------------------------------------------------------------------------------------------
// The values that are not there.
// -------------------------------------------------------------------------------------------

describe('missing values', () => {
  it('does not render a missing reading as zero', () => {
    // No-data is not zero (CLAUDE.md). "%lastvalue ms" reading "0 ms" would be a measurement
    // nobody took.
    assert.equal(substitute('%lastvalue', context({ lastValue: null })).text, '—');
  });

  it('does not invent a previous state for a sensor that has never had one', () => {
    assert.equal(substitute('%laststatus', context({ previousState: null })).text, '—');
  });

  it('renders a link as the bare id when no public URL is configured', () => {
    // A link built from what the core binds to would point at a loopback address nobody
    // receiving the alarm can reach — worse than no link, because it looks like one.
    assert.equal(substitute('%linksensor', context({ publicUrl: '' })).text, 'sensor 42');
  });

  it('does not double the slash when the public URL has a trailing one', () => {
    assert.equal(
      substitute('%linksensor', context({ publicUrl: 'https://x.test/' })).text,
      'https://x.test/objects/42',
    );
  });

  it('renders an empty field as empty rather than as a placeholder', () => {
    const result = substitute('[%location]', context({ location: '' }));
    assert.equal(result.text, '[]');
    assert.deepEqual(result.unknown, [], 'empty is a value, not a failure');
  });
});

// -------------------------------------------------------------------------------------------
// Rendering a whole template.
// -------------------------------------------------------------------------------------------

describe('rendering a template', () => {
  it('substitutes the subject and the body, and pools what it did not know', () => {
    // Two distinct unknown names, spelled without digits: a name stops at the first character
    // that is not a letter, so `%nope1` would be `%nope` followed by a literal 1.
    const rendered = render(
      { subject: '%sensor on %device is %status', body: '%lastmessage — %alpha %beta' },
      context(),
    );
    assert.equal(rendered.subject, 'Ping on edge-router is down');
    assert.equal(rendered.body, 'no ICMP reply from 192.0.2.7 — %alpha %beta');
    assert.deepEqual([...rendered.unknown].sort(), ['alpha', 'beta']);
  });

  it('deduplicates a name that is unknown in both the subject and the body', () => {
    const rendered = render({ subject: '%nope', body: '%nope' }, context());
    assert.deepEqual(rendered.unknown, ['nope']);
  });

  it('handles an empty template without complaint', () => {
    assert.deepEqual(render({ subject: '', body: '' }, context()), {
      subject: '',
      body: '',
      unknown: [],
    });
  });
});
