import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, useApi } from '../src/api/client';
import type { ObjectKind, ObjectSummary, SensorTypeSummary } from '../src/api/types';
import { ErrorPanel, Loading } from '../src/components/Panels';
import { AddSensor } from '../src/routes/AddSensor';
import { LogsView } from '../src/routes/LogsView';
import { SensorTypesView } from '../src/routes/SensorTypesView';
import { TreeView } from '../src/routes/TreeView';
import { FAILED, core, fail, roundTrip, watchFocus } from './support/try-again';

/**
 * *Try again* keeps focus (`U-68`, WCAG 2.4.3).
 *
 * Every error panel's *Try again* used to give way to a loading line as it was pressed, so the
 * focus it held fell to the page. Now the panel stays while it re-reads, the same button holding
 * focus and `aria-disabled`, with the message out of the alert until the next failure puts it
 * back (so the same words are said again); and when a read that succeeds takes the panel away,
 * focus goes to the page's heading. `fireEvent` moves no focus, so each button is focused before
 * it is pressed, as a keyboard press would leave it.
 */

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the error panel’s own part', () => {
  /** A caller that holds its failure while it re-reads, as `useApi`'s `retry` does. */
  function Holding({ onRetry }: { onRetry: () => void }): React.JSX.Element {
    const [error, setError] = useState(new ApiError(500, 'INTERNAL', FAILED, 'req-1'));
    return (
      <>
        <h1 tabIndex={-1}>Page</h1>
        <ErrorPanel error={error} retry={onRetry} />
        <button
          type="button"
          onClick={() => {
            setError(new ApiError(500, 'INTERNAL', FAILED, 'req-2'));
          }}
        >
          fail again
        </button>
      </>
    );
  }

  it('keeps the button, unavailable, while it re-reads, and says a second failure again', () => {
    const asked = vi.fn();
    render(<Holding onRetry={asked} />);
    const alert = screen.getByRole('alert');
    const button = within(alert).getByRole('button', { name: 'Try again' });
    button.focus();

    fireEvent.click(button);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(alert.textContent).toBe('Trying again…');
    fireEvent.click(button);
    expect(asked).toHaveBeenCalledTimes(1);

    // A new failure is a new error: the message comes back into the same region.
    fireEvent.click(screen.getByRole('button', { name: 'fail again' }));
    expect(screen.getByRole('alert')).toBe(alert);
    expect(alert.textContent).toContain(FAILED);
    expect(alert.textContent).toContain('req-2');
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(button.textContent).toBe('Try again');
    fireEvent.click(button);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  /** A caller whose retry goes back to a loading line, as every caller's did. */
  function Replacing({ heading }: { heading: boolean }): React.JSX.Element {
    const [failed, setFailed] = useState(true);
    return (
      <>
        {heading && <h1 tabIndex={-1}>Page</h1>}
        <input aria-label="elsewhere" />
        {failed ? (
          <ErrorPanel
            error={new ApiError(500, 'INTERNAL', FAILED)}
            retry={() => {
              setFailed(false);
            }}
          />
        ) : (
          <Loading what="it" />
        )}
      </>
    );
  }

  it('puts focus on the page’s heading when it goes with focus in it', () => {
    render(<Replacing heading />);
    const button = screen.getByRole('button', { name: 'Try again' });
    button.focus();
    const focus = watchFocus();
    fireEvent.click(button);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Page' }));
    expect(focus.lost()).toBe(0);
    focus.stop();
  });

  it('leaves focus alone when it was somewhere else', () => {
    render(<Replacing heading />);
    const button = screen.getByRole('button', { name: 'Try again' });
    const elsewhere = screen.getByRole('textbox', { name: 'elsewhere' });
    elsewhere.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('waits for a heading that comes with the answer', async () => {
    function Arriving(): React.JSX.Element {
      const [failed, setFailed] = useState(true);
      if (failed) {
        return (
          <ErrorPanel
            error={new ApiError(500, 'INTERNAL', FAILED)}
            retry={() => {
              setFailed(false);
            }}
          />
        );
      }
      return <h1 tabIndex={-1}>Arrived</h1>;
    }
    render(<Arriving />);
    const button = screen.getByRole('button', { name: 'Try again' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Arrived' }));
    });
  });
});

describe('useApi’s retry', () => {
  function Reader(): React.JSX.Element {
    const read = useApi<{ name: string }>('/thing');
    if (read.status === 'loading') return <Loading what="the thing" />;
    if (read.status === 'error') return <ErrorPanel error={read.error} retry={read.retry} />;
    return <p>{read.data.name}</p>;
  }

  it('stays `error`, with the same error, until the next read answers', async () => {
    const { asked } = core({ '/thing': [fail('req-1'), fail('req-2'), { ok: { name: 'Thing' } }] });
    render(
      <>
        <h1 tabIndex={-1}>Things</h1>
        <Reader />
      </>,
    );
    await roundTrip({
      heading: 'Things',
      answered: () => screen.getByText('Thing'),
      reads: () => asked('/thing'),
    });
  });
});

describe('the callers (U-68)', () => {
  it('the sensor types page', async () => {
    const items: SensorTypeSummary[] = [
      {
        id: 'icmp.ping',
        category: 'Availability',
        costHint: 'light',
        hasPreview: false,
        paramsSchema: { type: 'object', properties: {} },
      },
    ];
    const { asked } = core({ '/sensor-types': [fail('req-1'), fail('req-2'), { ok: { items } }] });
    render(
      <MemoryRouter>
        <SensorTypesView />
      </MemoryRouter>,
    );
    await roundTrip({
      heading: 'Sensor types',
      answered: () => screen.getByRole('button', { name: /icmp\.ping/u }),
      reads: () => asked('/sensor-types'),
    });
  });

  it('adding a sensor, whose heading comes with the answer', async () => {
    const type: SensorTypeSummary = {
      id: 'icmp.ping',
      category: 'Availability',
      costHint: 'light',
      hasPreview: false,
      paramsSchema: { type: 'object', properties: {} },
    };
    const device = { id: 4, parentId: 3, kind: 'device', name: 'edge-1', version: 1 };
    const { asked } = core({
      '/objects/4': [fail('req-1'), fail('req-2'), { ok: device }],
      '/sensor-types': [{ ok: { items: [type] } }],
    });
    render(
      <MemoryRouter initialEntries={['/objects/4/add-sensor']}>
        <Routes>
          <Route path="/objects/:id/add-sensor" element={<AddSensor />} />
        </Routes>
      </MemoryRouter>,
    );
    await roundTrip({
      heading: 'Add a sensor to edge-1',
      answered: () => screen.getByLabelText('Sensor type'),
      reads: () => asked('/objects/4'),
    });
  });

  it('the status log, read a page at a time', async () => {
    const { asked } = core({
      '/state-log': [fail('req-1'), fail('req-2'), { ok: { items: [], nextBefore: null } }],
    });
    render(
      <MemoryRouter initialEntries={['/logs']}>
        <Routes>
          <Route path="/logs" element={<LogsView />} />
        </Routes>
      </MemoryRouter>,
    );
    await roundTrip({
      heading: 'Logs',
      answered: () => screen.getByText('No status changes match.'),
      reads: () => asked('/state-log'),
    });
  });

  it('the tree, read again from its first level', async () => {
    vi.stubGlobal(
      'WebSocket',
      class {
        onopen = null;
        onclose = null;
        onerror = null;
        onmessage = null;
        send(): void {}
        close(): void {}
      },
    );
    const summary = (
      id: number,
      parentId: number | null,
      kind: ObjectKind,
      name: string,
    ): ObjectSummary => ({
      id,
      parentId,
      kind,
      name,
      tags: [],
      priority: 3,
      version: 1,
      hasChildren: kind !== 'sensor',
    });
    const { asked } = core({
      '/objects/tops': [{ ok: { items: [summary(1, null, 'root', 'Root')] } }],
      '/objects': [
        fail('req-1'),
        fail('req-2'),
        { ok: { items: [summary(2, 1, 'probe', 'Local probe')], nextCursor: null } },
      ],
    });
    render(
      <MemoryRouter>
        <TreeView />
      </MemoryRouter>,
    );
    await roundTrip({
      heading: 'Tree',
      answered: () => screen.getByText('Local probe'),
      reads: () => asked('/objects?parentId=1'),
    });
  });
});
