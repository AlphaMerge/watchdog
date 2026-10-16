import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateLogEntry } from '../src/api/types';
import { FailurePhase } from '../src/components/FailurePhase';
import { failureWords } from '../src/components/failure-words';
import { StateLogPanel } from '../src/routes/detail/StateLogPanel';
import { LogsView } from '../src/routes/LogsView';
import { core } from './support/try-again';

/**
 * Where a check failed, as a person reads it (`P-285`): the transport's phase as what it was
 * doing and the host after it, the runner's as what happened, and a phase nobody listed as
 * itself — a new sensor type's transport is read without a change here.
 */
describe('where a check failed, in words', () => {
  it('says what a transport was doing, and to which host', () => {
    expect(failureWords({ phase: 'connect', target: '192.0.2.7:22' })).toEqual({
      lead: 'Failed while connecting to',
      target: '192.0.2.7:22',
    });
    expect(failureWords({ phase: 'host-key', target: 'switch-3' }).lead).toBe(
      'Failed while checking the host key of',
    );
    expect(failureWords({ phase: 'getBulk', target: '192.0.2.7:161' }).lead).toBe(
      'Failed while reading from',
    );
    // With no host, a lead that does not end waiting for one.
    expect(failureWords({ phase: 'connect' })).toEqual({
      lead: 'Failed while connecting',
      target: null,
    });
    expect(failureWords({ phase: 'exec' }).lead).toBe('Failed while running its command');
  });

  it('says what happened when the runner settled it', () => {
    expect(failureWords({ phase: 'timeout' }).lead).toBe('Did not finish within its timeout');
    expect(failureWords({ phase: 'startup' }).lead).toBe('The probe could not start it');
    // Said of a check process that could not be started or answered unreadably as much as of a
    // worker that died, so it names none of them.
    expect(failureWords({ phase: 'worker-crash' }).lead).toBe(
      'The probe got no answer it could use from the check',
    );
    expect(failureWords({ phase: 'unknown-type' }).lead).toBe(
      'The probe does not have its sensor type',
    );
  });

  it('says a phase nobody listed as itself, and never reads one off the prototype', () => {
    expect(failureWords({ phase: 'handshake', target: 'mail.example' })).toEqual({
      lead: 'Failed in “handshake” on',
      target: 'mail.example',
    });
    expect(failureWords({ phase: 'handshake' }).lead).toBe('Failed in “handshake”');
    expect(failureWords({ phase: 'constructor' }).lead).toBe('Failed in “constructor”');
    expect(failureWords({ phase: 'toString' }).lead).toBe('Failed in “toString”');
  });

  it('is text, with the host in the face the Host field uses', () => {
    const { container } = render(
      <FailurePhase failure={{ phase: 'authenticate', target: '192.0.2.7:22' }} />,
    );
    expect(container.textContent).toBe('Failed while authenticating to 192.0.2.7:22');
    expect(screen.getByText('192.0.2.7:22').className).toBe('font-mono');
    // Nothing only a pointer can reach (WCAG 1.3.1, 2.1.1).
    expect(container.querySelector('[title]')).toBeNull();
  });
});

describe('the state log’s message, after where the check failed (P-285)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const entry = (overrides: Partial<StateLogEntry>): StateLogEntry => ({
    at: '2026-10-17T08:00:00.000Z',
    sensorId: 7,
    sensorName: 'Load',
    state: 'down',
    previousState: 'warning',
    cause: 'scan',
    message: 'the connection was lost while running uptime',
    failure: null,
    durationMs: 60_000,
    carried: false,
    ...overrides,
  });

  it('starts the Message cell with it, and leaves a row nothing named as it was', async () => {
    core({
      '/state-log': [
        {
          ok: {
            items: [
              entry({ failure: { phase: 'exec', target: '192.0.2.7:22' } }),
              entry({
                at: '2026-10-17T07:59:00.000Z',
                state: 'warning',
                previousState: 'up',
                message: 'timed out',
              }),
            ],
            nextBefore: null,
          },
        },
      ],
    });
    render(
      <MemoryRouter>
        <StateLogPanel objectId={7} isSensor />
      </MemoryRouter>,
    );
    const failed = await screen.findByText('192.0.2.7:22');
    const cell = failed.closest('td');
    expect(cell?.textContent).toBe(
      'Failed while running its command on 192.0.2.7:22the connection was lost while running uptime',
    );
    const rows = screen.getAllByRole('row');
    // The header, then the two transitions; the second's message cell is its words alone.
    expect(rows).toHaveLength(3);
    expect(rows[2]?.querySelector('td:last-child')?.textContent).toBe('timed out');
  });

  it('reads a row from a core older than the field as its words alone', async () => {
    const { failure: _absent, ...older } = entry({ message: 'no reply from 192.0.2.7' });
    core({ '/state-log': [{ ok: { items: [older], nextBefore: null } }] });
    render(
      <MemoryRouter>
        <StateLogPanel objectId={7} isSensor />
      </MemoryRouter>,
    );
    const said = await screen.findByText('no reply from 192.0.2.7');
    expect(said.closest('td')?.textContent).toBe('no reply from 192.0.2.7');
  });

  it('starts the Logs page’s Message cell with it too', async () => {
    core({
      '/state-log': [
        { ok: { items: [entry({ failure: { phase: 'timeout' } })], nextBefore: null } },
      ],
    });
    render(
      <MemoryRouter initialEntries={['/logs']}>
        <Routes>
          <Route path="/logs" element={<LogsView />} />
        </Routes>
      </MemoryRouter>,
    );
    const said = await screen.findByText('Did not finish within its timeout');
    expect(said.closest('td')?.textContent).toBe(
      'Did not finish within its timeoutthe connection was lost while running uptime',
    );
  });
});
