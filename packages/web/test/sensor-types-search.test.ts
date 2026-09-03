import { describe, expect, it } from 'vitest';
import type { SensorTypeSummary } from '../src/api/types';
import { matchRange, parametersOf, searchTypes, suggest } from '../src/routes/sensor-types-model';

/**
 * The catalogue search — the only way to answer "which types take a `verifyTls`?" without
 * reading forty-three schemas.
 *
 * The fixture is a slice of the real catalogue, ids and all, because the ranking's whole job is
 * to cope with names that overlap the way these do: `core.factory` and `ms.core.health` both
 * contain "core" and only one of them starts with it.
 */

function type(
  id: string,
  category: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): SensorTypeSummary {
  return {
    id,
    category,
    costHint: 'light',
    hasPreview: false,
    paramsSchema: { type: 'object', properties, required },
  };
}

const FACTORY = type('core.factory', 'Custom', {
  channels: { type: 'array', title: 'Channels' },
  maxAgeSeconds: { type: 'integer', title: 'Maximum age', default: 600 },
});
const HTTP = type('http.request', 'Web', {
  url: { type: 'string', title: 'URL' },
  verifyTls: { type: 'boolean', title: 'Verify TLS', default: true },
  password: { type: 'string', title: 'Password', writeOnly: true },
});
const PING = type('icmp.ping', 'Availability', { host: { type: 'string', title: 'Host' } }, [
  'host',
]);
const CORE_HEALTH = type('ms.core.health', 'System');
const TRAFFIC = type('snmp.traffic', 'SNMP', { community: { type: 'string', title: 'Community' } });
const UPTIME = type('snmp.uptime', 'SNMP');
const VOLUME = type('windows.volume', 'Windows', {
  verifyTls: { type: 'boolean', title: 'Verify TLS' },
});

const CATALOGUE: SensorTypeSummary[] = [FACTORY, HTTP, PING, CORE_HEALTH, TRAFFIC, UPTIME, VOLUME];

describe('reading a paramsSchema', () => {
  it('carries the annotations the table renders, and JSON for the defaults', () => {
    const parameters = parametersOf(HTTP);
    expect(parameters.map((p) => p.name)).toEqual(['url', 'verifyTls', 'password']);
    expect(parameters[1]).toMatchObject({ type: 'boolean', defaultJson: 'true', required: false });
    // Null, not "no default": `false` and `0` are defaults, and a truthiness test would drop them.
    expect(parameters[0]?.defaultJson).toBeNull();
    expect(parameters[2]?.writeOnly).toBe(true);
  });

  it('marks the required ones, which is the only thing the asterisk means', () => {
    expect(parametersOf(PING)[0]).toMatchObject({ name: 'host', required: true });
  });

  it('survives a schema with no properties at all', () => {
    expect(parametersOf(CORE_HEALTH)).toEqual([]);
  });
});

describe('searching the catalogue', () => {
  it('keeps every type, in the server’s order, for an empty query', () => {
    const all = searchTypes(CATALOGUE, '   ');
    expect(all.map((m) => m.type.id)).toEqual(CATALOGUE.map((t) => t.id));
    expect(all.every((m) => m.matchedParameters.length === 0)).toBe(true);
  });

  it('puts an id that starts with the query above one that merely contains it', () => {
    expect(searchTypes(CATALOGUE, 'core').map((m) => m.type.id)).toEqual([
      'core.factory',
      'ms.core.health',
    ]);
  });

  it('finds a type by its category, and says the parameters were not why', () => {
    const found = searchTypes(CATALOGUE, 'availability');
    expect(found.map((m) => m.type.id)).toEqual(['icmp.ping']);
    expect(found[0]?.matchedParameters).toEqual([]);
  });

  it('finds types by a parameter, and names the parameter that matched', () => {
    // The question this page exists to answer, and the reason the hit is worth opening.
    const found = searchTypes(CATALOGUE, 'verifytls');
    expect(found.map((m) => m.type.id)).toEqual(['http.request', 'windows.volume']);
    expect(found[0]?.matchedParameters).toEqual(['verifyTls']);
  });

  it('names no parameter on a type that is here because of its own name', () => {
    // Half the SNMP types have a parameter titled "SNMP version". Reporting that on a search
    // for `snmp` would open all nine cards to show a row nobody asked about.
    const withVersion = type('snmp.cpu', 'SNMP', {
      version: { type: 'string', title: 'SNMP version' },
    });
    const found = searchTypes([withVersion], 'snmp');
    expect(found.map((m) => m.type.id)).toEqual(['snmp.cpu']);
    expect(found[0]?.matchedParameters).toEqual([]);
  });

  it('matches a parameter by its title as well as its name', () => {
    // The add-sensor form labels it "Verify TLS"; somebody who has only seen the form types that.
    expect(searchTypes(CATALOGUE, 'verify tls').map((m) => m.type.id)).toEqual([
      'http.request',
      'windows.volume',
    ]);
  });

  it('ranks an id hit above a category hit above a parameter-only hit', () => {
    // `snmp` is in two ids, is a category of its own, and is in nothing else here.
    expect(searchTypes(CATALOGUE, 'snmp').map((m) => m.type.id)).toEqual([
      'snmp.traffic',
      'snmp.uptime',
    ]);
    // A query that can only be a category keeps the types it names, ranked below any id hit.
    expect(searchTypes(CATALOGUE, 'system').map((m) => m.type.id)).toEqual(['ms.core.health']);
  });

  it('is case-insensitive, and returns nothing for a miss', () => {
    expect(searchTypes(CATALOGUE, 'HTTP').map((m) => m.type.id)).toEqual(['http.request']);
    expect(searchTypes(CATALOGUE, 'nothing here')).toEqual([]);
  });

  it('does not reshuffle the list as a search is narrowed one keystroke at a time', () => {
    const ids = (q: string): string[] => searchTypes(CATALOGUE, q).map((m) => m.type.id);
    expect(ids('c')[0]).toBe(ids('co')[0]);
    expect(ids('co')[0]).toBe(ids('core')[0]);
  });
});

describe('what the search box suggests', () => {
  it('lists every category when nothing has been typed — the browse menu', () => {
    const empty = suggest(CATALOGUE, '');
    expect(empty.every((s) => s.kind === 'category')).toBe(true);
    expect(empty.map((s) => s.value)).toEqual([
      'Availability',
      'Custom',
      'SNMP',
      'System',
      'Web',
      'Windows',
    ]);
    // The count is the reason to pick one.
    expect(empty.find((s) => s.value === 'SNMP')?.detail).toBe('2 types');
  });

  it('is not truncated by the limit while it is the browse menu', () => {
    // Eleven categories against a ten-suggestion shortlist: truncating hides exactly the
    // category somebody could not name.
    const many = Array.from({ length: 14 }, (_, i) => type(`t.${String(i)}`, `Cat${String(i)}`));
    expect(suggest(many, '')).toHaveLength(14);
  });

  it('offers the category before the ids it would filter to', () => {
    expect(suggest(CATALOGUE, 'snmp').map((s) => [s.kind, s.value])).toEqual([
      ['category', 'SNMP'],
      ['type', 'snmp.traffic'],
      ['type', 'snmp.uptime'],
    ]);
  });

  it('offers a prefix match ahead of a substring match of the same kind', () => {
    expect(suggest(CATALOGUE, 'core').map((s) => s.value)).toEqual([
      'core.factory',
      'ms.core.health',
    ]);
  });

  it('suggests a parameter name, with how many types take it', () => {
    expect(suggest(CATALOGUE, 'verify')).toEqual([
      { kind: 'parameter', value: 'verifyTls', detail: 'parameter · 2 types' },
    ]);
  });

  it('counts a parameter once per type, however many types share the name', () => {
    expect(suggest(CATALOGUE, 'host')[0]?.detail).toBe('parameter · 1 type');
  });

  it('honours the limit once something has been typed', () => {
    expect(suggest(CATALOGUE, '.', 2)).toHaveLength(2);
  });
});

describe('marking the match', () => {
  it('finds where to draw the mark, case-insensitively', () => {
    expect(matchRange('snmp.traffic', 'TRAF')).toEqual([5, 9]);
  });

  it('is null when there is nothing to mark, so no empty <mark> is rendered', () => {
    expect(matchRange('snmp.traffic', '')).toBeNull();
    expect(matchRange('snmp.traffic', '   ')).toBeNull();
    expect(matchRange('snmp.traffic', 'ssh')).toBeNull();
  });
});
