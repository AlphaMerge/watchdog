import { describe, expect, it } from 'vitest';
import { initial, seed } from '../src/routes/templates-model';
import { seedFrom } from '../src/routes/detail/model';
import type { NotificationMethod, TemplateView } from '../src/api/types';

function method(id: string, settingsSchema: Record<string, unknown>): NotificationMethod {
  return {
    id,
    name: id,
    description: 'a method',
    settingsSchema,
    usesRecipients: true,
    summarisable: true,
  };
}

const EMAIL_SCHEMA = {
  type: 'object',
  properties: {
    format: { enum: ['plain', 'html'], default: 'plain' },
    senderOverride: { type: ['string', 'null'], maxLength: 320, default: null },
  },
};

describe('seeding a method’s settings', () => {
  it('takes the defaults the schema declares', () => {
    expect(seed(EMAIL_SCHEMA)).toEqual({ format: 'plain', senderOverride: null });
  });

  it('never invents a credential', () => {
    // A `writeOnly` field with a default would otherwise be seeded with that default and PUT,
    // which writes a secret nobody typed. The core's own defaulting is the right place for it.
    const withSecret = seed({
      type: 'object',
      properties: {
        url: { type: 'string', default: 'https://example.invalid/hook' },
        token: { type: 'string', writeOnly: true, default: 'placeholder' },
      },
    });
    expect(withSecret).toEqual({ url: 'https://example.invalid/hook' });
    expect(Object.keys(withSecret)).not.toContain('token');
  });

  it('falls back to the first choice for an enum, which is what the select would show', () => {
    // `defaultFor` decides this (`U-08`): a select renders its first option whether or not the
    // schema declared a default, so seeding anything else would show one value and save another.
    expect(seed({ type: 'object', properties: { format: { enum: ['plain', 'html'] } } })).toEqual({
      format: 'plain',
    });
  });

  it('leaves out a string with no default rather than inventing an empty one', () => {
    expect(seed({ type: 'object', properties: { host: { type: 'string' } } })).toEqual({});
  });

  it('seeds nothing for a method that takes no settings', () => {
    expect(seed(undefined)).toEqual({});
    expect(seed({})).toEqual({});
  });

  it('reaches a default nested inside an object property', () => {
    // `fieldsOf` returns a tree, and the loop this replaced walked only its top level: a nested
    // default was declared, drawn as an empty control, and never saved. All three seeding forms
    // had their own copy of that loop, so all three had the bug.
    expect(
      seed({
        type: 'object',
        properties: {
          auth: {
            type: 'object',
            properties: {
              scheme: { type: 'string', default: 'bearer' },
              token: { type: 'string', writeOnly: true, default: 'nope' },
            },
          },
        },
      }),
    ).toEqual({ auth: { scheme: 'bearer' } });
  });
});

describe('the draft a new template starts from', () => {
  it('uses the first method and seeds its defaults', () => {
    const draft = initial(undefined, [method('email', EMAIL_SCHEMA), method('webhook', {})]);
    expect(draft.method).toBe('email');
    expect(draft.settings).toEqual({ format: 'plain', senderOverride: null });
  });

  it('offers placeholders in the subject, because an empty one teaches nothing', () => {
    const draft = initial(undefined, [method('email', EMAIL_SCHEMA)]);
    expect(draft.subject).toContain('%sensor');
    expect(draft.body).toContain('%lastmessage');
    expect(draft.name).toBe('');
  });

  it('survives a core that offers no methods at all', () => {
    const draft = initial(undefined, []);
    expect(draft.method).toBe('email');
    expect(draft.settings).toEqual({});
  });
});

describe('the draft an existing template is edited from', () => {
  const stored: TemplateView = {
    id: 4,
    name: 'On-call email',
    description: 'the rota',
    method: 'email',
    methodName: 'Email',
    settings: { format: 'html' },
    redactedSettings: ['smtpPassword'],
    subject: '%sitename: %sensor is %status',
    body: '%lastmessage',
    recipients: [{ kind: 'address', value: 'ops@example.invalid' }],
    priority: 1,
    enabled: true,
    summary: 'email to 1 recipient',
    summarisable: true,
    summarisation: 'none',
    summaryWindowSeconds: 300,
    scheduleId: 2,
    scheduleName: 'Out of hours',
    whenInactive: 'drop',
    createdAt: '2026-08-25T10:00:00Z',
    updatedAt: '2026-08-25T10:00:00Z',
  };

  it('carries every field the write takes, so editing one does not clear the rest', () => {
    // The PUT replaces the template. A draft that dropped `scheduleId` would silently detach the
    // schedule the first time somebody fixed a typo in the subject line.
    const draft = initial(stored, [method('email', EMAIL_SCHEMA)]);
    expect(draft.scheduleId).toBe(2);
    expect(draft.whenInactive).toBe('drop');
    expect(draft.summaryWindowSeconds).toBe(300);
    expect(draft.priority).toBe(1);
    expect(draft.recipients).toEqual([{ kind: 'address', value: 'ops@example.invalid' }]);
  });

  it('keeps the stored settings rather than re-seeding over them', () => {
    expect(initial(stored, [method('email', EMAIL_SCHEMA)]).settings).toEqual({ format: 'html' });
  });

  it('holds no redacted secret, and does not fabricate a key for one', () => {
    // `redactedSettings` says the value is set and withheld. The draft must not carry a key for
    // it: an absent key keeps the stored secret, and an empty string would replace it with one.
    const draft = initial(stored, [method('email', EMAIL_SCHEMA)]);
    expect(Object.keys(draft.settings)).not.toContain('smtpPassword');
    expect(JSON.stringify(draft)).not.toContain('smtpPassword');
  });

  it('does not carry the read-only fields the write would refuse', () => {
    const draft = initial(stored, [method('email', EMAIL_SCHEMA)]);
    for (const key of ['id', 'methodName', 'summary', 'scheduleName', 'createdAt', 'updatedAt']) {
      expect(Object.keys(draft)).not.toContain(key);
    }
  });
});

describe('seeding a trigger kind’s settings', () => {
  it('takes the defaults the kind declares', () => {
    expect(
      seedFrom({
        id: 'state',
        name: 'State trigger',
        description: 'when a sensor changes state',
        settingsSchema: {
          type: 'object',
          properties: {
            state: { enum: ['down', 'warning'], default: 'down' },
            afterSeconds: { type: 'integer', default: 0 },
          },
        },
      }),
    ).toEqual({ state: 'down', afterSeconds: 0 });
  });

  it('seeds nothing before a kind has been chosen', () => {
    expect(seedFrom(undefined)).toEqual({});
  });
});
