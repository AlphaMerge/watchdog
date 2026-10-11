import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelsWithoutLookup } from '../src/api/types';
import { SessionContext, type Session, type SessionContextValue } from '../src/auth/session';
import { ChannelsWithoutLookupView } from '../src/routes/ChannelsWithoutLookupView';
import { summary } from '../src/routes/channels-without-lookup';

/**
 * The channels without the lookup their type declares, as an operator reads the list (`P-308`).
 * What the core puts in it is `channels-without-lookup.test.ts` in the core.
 */

const OPEN: Session = { kind: 'anonymous', requireAuthentication: false };

function inSession(children: React.ReactNode): React.JSX.Element {
  const value: SessionContextValue = {
    session: OPEN,
    signedIn: () => undefined,
    signOut: () => Promise.resolve(),
    refresh: () => undefined,
    askingToSignIn: false,
    askToSignIn: () => undefined,
  };
  return (
    <SessionContext.Provider value={value}>
      <MemoryRouter>{children}</MemoryRouter>
    </SessionContext.Provider>
  );
}

function answering(body: ChannelsWithoutLookup): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (path: string) => {
    asked.push(path);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
}

const row = (sensorId: number, sensorName: string) => ({
  sensorId,
  sensorName,
  sensorType: 'snmp.traffic',
  key: 'status',
  channelName: 'Interface status',
  declaredLookup: 'ms.snmp.if-oper-status',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the channels without their lookup (P-308)', () => {
  it('lists each with its sensor, channel and declared lookup, and says why none is filled', async () => {
    const asked = answering({
      items: [row(31, 'uplink clone'), row(44, 'core switch port 7')],
      total: 2,
      unanswered: 0,
    });
    render(inSession(<ChannelsWithoutLookupView />));
    const table = await screen.findByRole('table');
    expect(asked.some((path) => path.endsWith('/channels/without-lookup'))).toBe(true);
    expect(within(table).getByRole('link', { name: 'uplink clone' }).getAttribute('href')).toBe(
      '/objects/31',
    );
    expect(within(table).getAllByText('ms.snmp.if-oper-status')).toHaveLength(2);
    expect(within(table).getAllByText('Interface status')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe(
      '2 channels without their lookup, among the sensors you can see.',
    );
    expect(screen.getByText(/nothing recorded tells the two apart/u)).toBeDefined();
    expect(screen.queryByText(/not judged here/u)).toBeNull();
  });

  it('says there are none it can show, and counts the sensors it could not judge', async () => {
    answering({ items: [], total: 0, unanswered: 3 });
    render(inSession(<ChannelsWithoutLookupView />));
    expect(
      await screen.findByText('No channel you can see is without the lookup its type declares.'),
    ).toBeDefined();
    expect(
      screen.getByText(/^3 sensors with a channel that has no lookup are not judged/u),
    ).toBeDefined();
  });

  it('says a cut list is the first of more', () => {
    expect(summary(1_000, 1_234)).toBe(
      'The first 1000 of 1234 channels without their lookup, among the sensors you can see.',
    );
    expect(summary(1, 1)).toBe('1 channel without its lookup, among the sensors you can see.');
  });
});
