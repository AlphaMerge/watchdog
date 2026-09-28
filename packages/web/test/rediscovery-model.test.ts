import { describe, expect, it } from 'vitest';
import type { RediscoveryRule } from '../src/api/types';
import {
  EMPTY_RULE,
  atFromMinute,
  createBody,
  draftFromRule,
  ifMatch,
  isStale,
  minuteOf,
  patchBody,
  ruleStatus,
  whyNotSavable,
  type RuleDraft,
} from '../src/routes/rediscovery-model';

/**
 * The rediscovery form's decisions (`D-11`): how a time reads for each cadence, what an edit
 * sends, and what the stored community becomes when the form was never shown it.
 */

const RULE: RediscoveryRule = {
  id: 5,
  groupId: 20,
  probeId: 10,
  name: 'Nightly',
  enabled: true,
  range: '10.0.0.0/29',
  level: 'standard',
  templates: ['linux'],
  timeoutMs: 1_000,
  concurrency: 32,
  ratePerSecond: 0,
  cadence: 'daily',
  cadenceMinute: 210,
  cadenceWeekday: 0,
  timezone: 'Europe/Berlin',
  autoProvision: false,
  scheduleId: null,
  lastRunAt: null,
  lastRunId: null,
  lastProblem: '',
  nextRunAt: '2026-09-29T01:30:00.000Z',
  description: 'every day at 03:30',
  version: 3,
};

const ready: RuleDraft = {
  ...EMPTY_RULE,
  name: 'Nightly',
  probeId: 10,
  groupId: 20,
  range: '10.0.0.0/29',
};

describe('a time, for each cadence', () => {
  it.each([
    ['daily', 210, '03:30'],
    ['weekly', 0, '00:00'],
    ['daily', 1_439, '23:59'],
    ['hourly', 30, '30'],
    ['hourly', 0, '0'],
  ] as const)('%s minute %d reads as %s and back', (cadence, minute, text) => {
    expect(atFromMinute(cadence, minute)).toBe(text);
    expect(minuteOf(cadence, text)).toBe(minute);
  });

  it.each([
    ['daily', '24:00'],
    ['daily', '3:60'],
    ['daily', '90'],
    ['weekly', ''],
    ['hourly', '60'],
    ['hourly', '03:00'],
    ['hourly', '-1'],
  ] as const)('refuses %s "%s" rather than guessing', (cadence, text) => {
    expect(minuteOf(cadence, text)).toBeNull();
  });

  it('takes a single-digit hour', () => {
    expect(minuteOf('daily', '3:05')).toBe(185);
  });
});

describe('why a rule cannot be saved yet', () => {
  it('names the first box to fix, in the order they appear', () => {
    expect(whyNotSavable(EMPTY_RULE)).toBe('Give the rule a name.');
    expect(whyNotSavable({ ...ready, probeId: null })).toBe('Choose a probe.');
    expect(whyNotSavable({ ...ready, groupId: null })).toBe('Choose a group.');
    expect(whyNotSavable({ ...ready, range: '  ' })).toBe('Enter a range.');
    expect(whyNotSavable({ ...ready, at: '25:00' })).toMatch(/HH:MM/u);
    expect(whyNotSavable({ ...ready, cadence: 'hourly', at: '75' })).toMatch(/0 to 59/u);
    expect(whyNotSavable({ ...ready, communityChange: 'replace' })).toMatch(/new SNMP community/u);
    expect(whyNotSavable(ready)).toBeNull();
  });
});

describe('what a new rule sends', () => {
  it('sends no switch, so it is created off, and no community when none was typed', () => {
    const body = createBody({ ...ready, at: '04:15', timezone: ' ' });
    expect(body).not.toHaveProperty('enabled');
    expect(body).not.toHaveProperty('snmpCommunity');
    expect(body['cadenceMinute']).toBe(255);
    expect(body['timezone']).toBeNull();
    expect(body['autoProvision']).toBe(false);
  });

  it('sends a community that was typed', () => {
    expect(createBody({ ...ready, community: 'public' })['snmpCommunity']).toBe('public');
  });
});

describe('what an edit sends', () => {
  it('sends nothing for a form nobody changed', () => {
    expect(patchBody(RULE, draftFromRule(RULE))).toEqual({});
  });

  it('sends what changed, and only that', () => {
    const draft = { ...draftFromRule(RULE), name: 'Nightly, later', at: '04:30' };
    expect(patchBody(RULE, draft)).toEqual({ name: 'Nightly, later', cadenceMinute: 270 });
  });

  it('sends a new probe, which is how a rule refused on firing is put right', () => {
    expect(patchBody(RULE, { ...draftFromRule(RULE), probeId: 11 })).toEqual({ probeId: 11 });
  });

  it('never sends the group, which an edit cannot change', () => {
    expect(patchBody(RULE, { ...draftFromRule(RULE), groupId: 99 })).toEqual({});
  });

  it('keeps, replaces or clears the community it was never shown', () => {
    const draft = draftFromRule(RULE);
    expect(draft.community).toBe('');
    expect(patchBody(RULE, draft)).not.toHaveProperty('snmpCommunity');
    expect(patchBody(RULE, { ...draft, communityChange: 'replace', community: 'private' })).toEqual(
      { snmpCommunity: 'private' },
    );
    expect(patchBody(RULE, { ...draft, communityChange: 'clear' })).toEqual({ snmpCommunity: '' });
  });

  it('carries the version it was made against, as the core writes it', () => {
    expect(ifMatch(RULE)).toEqual({ 'if-match': 'W/"3"' });
  });
});

describe('a save refused because somebody else saved first', () => {
  it('is a 412 or a 409, and nothing else', () => {
    expect(isStale({ status: 412 })).toBe(true);
    expect(isStale({ status: 409 })).toBe(true);
    expect(isStale({ status: 400 })).toBe(false);
    expect(isStale({ status: 404 })).toBe(false);
  });
});

describe('the line that says what a rule does next', () => {
  const at = (iso: string): string => iso.slice(11, 16);

  it('puts a refused firing before anything else', () => {
    const status = ruleStatus({ ...RULE, lastProblem: 'the probe is wrong' }, at);
    expect(status.tone).toBe('problem');
    expect(status.text).toContain('the probe is wrong');
  });

  it('says a rule that is off will not run', () => {
    expect(ruleStatus({ ...RULE, enabled: false }, at).tone).toBe('off');
  });

  it('says when a rule that is on runs next, and flags one with nothing booked', () => {
    expect(ruleStatus(RULE, at).text).toBe('Next run 01:30.');
    expect(ruleStatus({ ...RULE, nextRunAt: null }, at).tone).toBe('problem');
  });
});
