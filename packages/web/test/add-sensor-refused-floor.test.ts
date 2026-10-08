import { describe, expect, it, vi } from 'vitest';
import type * as CapabilityVersions from '@ms/shared/capability-versions';
import type { ProbeHealthView } from '../src/api/types';
import { listenerNotice } from '../src/routes/add-sensor-model';

/**
 * The add-sensor form under a raised protocol floor (`U-33`).
 *
 * The floor is 1 today, so the only version a hello is refused over is 0, below every listener's.
 * The day it is raised, a refused version can sit above a listener's own number, and one below
 * the floor can be one a core took before the floor moved. Raised here to 20 by replacing the
 * table the form and the handshake both read, so these say what the form does then: the refusal
 * is read from the floor, not from the number being 0, and it comes before the listener's version.
 */
vi.mock('@ms/shared/capability-versions', async (importOriginal) => ({
  ...(await importOriginal<typeof CapabilityVersions>()),
  MIN_PROTOCOL_VERSION: 20,
  isProtocolCompatible: (version: number): boolean => Number.isInteger(version) && version >= 20,
}));

const downAt = (
  lastProtocolVersion: number | null,
  lastProtocolVersionAt: string | null = null,
): ProbeHealthView => ({
  at: '2026-10-02T10:00:00.000Z',
  probeId: 2,
  message: 'not connected to the core',
  numbersUnavailable: { reason: 'not-connected' },
  protocolVersion: null,
  lastProtocolVersion,
  lastProtocolVersionAt,
  channels: { connected: 0, scheduled: null, syslogReceived: null, flowReceived: null },
});

const say = (listener: string, health: ProbeHealthView): string =>
  listenerNotice(listener, 'Berlin', health)?.text ?? '';

describe('the add-sensor form when the protocol floor is raised (U-33)', () => {
  it('says a version below the floor was refused, even one above the listener’s own', () => {
    // 14 carries syslog's counter (13), and the core refuses it, so it will not report at all.
    expect(say('syslog', downAt(14))).toContain(
      'It has not connected since its hello was refused over its version: it spoke protocol ' +
        '14, and this core accepts protocol 20 or newer, so unless it has been upgraded since, ' +
        'it will be refused again when it tries.',
    );
    expect(say('syslog', downAt(12))).toContain('it spoke protocol 12, and this core accepts');
  });

  it('keeps "when it last connected" for a version at or above the floor', () => {
    // 22 without a time: recorded before the core kept one, and accepted then.
    expect(say('flow', downAt(22))).toContain('When it last connected it spoke protocol 22,');
    expect(say('syslog', downAt(22))).toContain('This updates when it connects.');
    expect(say('flow', downAt(22))).not.toContain('refused');
  });
});
