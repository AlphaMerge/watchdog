import { describe, expect, it } from 'vitest';
import { fieldFor } from '../src/routes/detail/model';
import { problemsFor } from '../src/forms/validate';
import type { SettingView } from '../src/api/types';

function setting(key: string, schema: Record<string, unknown>): SettingView {
  return {
    key,
    description: 'a setting',
    schema,
    effective: { value: null, source: { kind: 'default' } },
    inherited: { value: null, source: { kind: 'default' } },
    own: null,
  };
}

describe('the control a setting gets', () => {
  it('reads its type from the registry schema', () => {
    expect(fieldFor(setting('scan.intervalSeconds', { type: 'integer' }), 'scan').kind).toBe(
      'integer',
    );
    expect(fieldFor(setting('object.location', { type: 'string' }), 'object').kind).toBe('string');
    expect(fieldFor(setting('x.flag', { type: 'boolean' }), 'x').kind).toBe('boolean');
  });

  it('keeps the dotted key as one path, because the dots are a namespace', () => {
    // `scan.intervalSeconds` is one value at one key. Running it through the params form's path
    // machinery would read it as `{ scan: { intervalSeconds } }`, which is not what the API takes.
    const field = fieldFor(setting('scan.intervalSeconds', { type: 'integer' }), 'scan');
    expect(field.path).toBe('scan.intervalSeconds');
    expect(field.children).toEqual([]);
  });

  it('labels from the part after the prefix, since the heading carries the prefix', () => {
    expect(fieldFor(setting('scan.intervalSeconds', { type: 'integer' }), 'scan').label).toBe(
      'Interval seconds',
    );
    expect(fieldFor(setting('dependency.masterId', { type: 'integer' }), 'dependency').label).toBe(
      'Master id',
    );
  });

  it('does not call a nullable setting required, because null is one of its values', () => {
    // `schedule.id: null` means "always". Marking it required would make that unreachable
    // through the control.
    const nullable = fieldFor(
      setting('schedule.id', { type: ['integer', 'null'], minimum: 1 }),
      'schedule',
    );
    expect(nullable.required).toBe(false);
    expect(nullable.kind).toBe('integer');
    expect(problemsFor(nullable, undefined)).toEqual([]);
  });

  it('holds a non-nullable setting to its bounds', () => {
    const interval = fieldFor(
      setting('scan.intervalSeconds', { type: 'integer', minimum: 1, maximum: 86_400 }),
      'scan',
    );
    expect(interval.required).toBe(true);
    expect(problemsFor(interval, 0)[0]?.message).toBe('must be 1 or more');
    expect(problemsFor(interval, 86_401)[0]?.message).toBe('must be 86400 or less');
    expect(problemsFor(interval, 60)).toEqual([]);
  });

  it('is never write-only: a setting is not a credential', () => {
    // Credentials live on the object as their own thing (`S-03`), not among inheritable
    // settings, so nothing here should ever render the write-only control.
    expect(fieldFor(setting('object.location', { type: 'string' }), 'object').writeOnly).toBe(
      false,
    );
  });

  it('falls back to a JSON box for a shape the controls do not cover', () => {
    expect(fieldFor(setting('x.blob', { type: 'array' }), 'x').kind).toBe('json');
  });
});
