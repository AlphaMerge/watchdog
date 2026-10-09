import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SensorTypeSummary } from '../src/api/types';
import { AddSensor } from '../src/routes/AddSensor';
import { expectCorrelation } from './support/refusal-region';

/**
 * A create the core refused, announced (`U-52`).
 *
 * Focus is on *Create sensor* when the refusal comes back, and nothing moves it, so a live region
 * is the only thing that says the sensor was not created. The rules `U-48` holds the settings
 * panel's refusal to: there, empty, before anything is sent — a region added with its text already
 * in it is not reliably announced (`U-41`) — the core's words in that same node after, emptied as
 * the next attempt starts, taking no space while empty (`U-45`), and the correlation id beside the
 * message (`U-51`). jsdom lays nothing out, so what is asserted is what the layout rests on.
 */

const REFUSED = 'sensor params are not valid for "icmp.ping"';

const TYPE: SensorTypeSummary = {
  id: 'icmp.ping',
  category: 'Availability',
  costHint: 'light',
  hasPreview: false,
  paramsSchema: { type: 'object', properties: {} },
};

const DEVICE = { id: 4, parentId: 3, kind: 'device', name: 'edge-1', version: 1 };

/** A refusal the core sends, or `null` for a create it accepts. */
type Answer = { readonly status: number; readonly correlationId?: string } | null;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The core: reads answered, and each `POST /objects` takes the next answer. */
function core(...answers: Answer[]): { creates: () => number } {
  let creates = 0;
  const respond = (status: number, body: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    if ((init?.method ?? 'GET') === 'GET') {
      if (path === '/sensor-types') return respond(200, { items: [TYPE] });
      if (path === '/objects/4') return respond(200, DEVICE);
      return respond(404, { error: { code: 'NOT_FOUND', message: 'no' } });
    }
    creates += 1;
    const answer = answers.shift();
    if (answer === null || answer === undefined) {
      return respond(201, { ...DEVICE, id: 9, parentId: 4, kind: 'sensor', name: 'Ping' });
    }
    return respond(answer.status, {
      error: {
        code: 'OBJECT_INVALID',
        message: REFUSED,
        ...(answer.correlationId === undefined ? {} : { correlationId: answer.correlationId }),
      },
    });
  });
  return { creates: () => creates };
}

/** The form, filled in and ready to create. */
async function open(): Promise<HTMLElement> {
  render(
    <MemoryRouter initialEntries={['/objects/4/add-sensor']}>
      <Routes>
        <Route path="/objects/:id/add-sensor" element={<AddSensor />} />
        <Route path="/objects/:id" element={<p>created</p>} />
      </Routes>
    </MemoryRouter>,
  );
  const type = await screen.findByLabelText('Sensor type');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ping' } });
  fireEvent.change(type, { target: { value: 'icmp.ping' } });
  return screen.getByRole('button', { name: 'Create sensor' });
}

describe('a create the core refused (U-52)', () => {
  it('is there empty before, says the core’s words after, and empties on the next attempt', async () => {
    const { creates } = core({ status: 400, correlationId: 'req-52' }, null);
    const create = await open();

    // Before anything was sent: present, empty, assertive by its role.
    const region = screen.getByRole('alert');
    expect(region.matches(':empty')).toBe(true);
    expect(region.hasAttribute('aria-live')).toBe(false);

    create.focus();
    fireEvent.click(create);
    await waitFor(() => {
      expect(region.textContent).toBe(`${REFUSED} req-52`);
    });
    // The same node: its text changed, which is what is announced.
    expect(screen.getByRole('alert')).toBe(region);
    // The id in the alert itself, in `CorrelationId` (`U-65`): said with the message, after a
    // space, so a screen reader does not run it into the message's last word.
    expectCorrelation(region, 'req-52');
    expect(creates()).toBe(1);

    // The next attempt empties it as it starts; this one is accepted, and the page moves on.
    fireEvent.click(screen.getByRole('button', { name: 'Create sensor' }));
    expect(region.matches(':empty')).toBe(true);
    await screen.findByText('created');
    expect(creates()).toBe(2);
  });

  it('says a second refusal in the same words by emptying first', async () => {
    core({ status: 409 }, { status: 409 });
    const create = await open();
    const region = screen.getByRole('alert');
    fireEvent.click(create);
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create sensor' }));
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    expect(screen.getByRole('alert')).toBe(region);
  });

  it('says the message alone when the core gives no correlation id', async () => {
    core({ status: 409 });
    fireEvent.click(await open());
    const region = screen.getByRole('alert');
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    expect(region.querySelector('span')).toBeNull();
  });

  it('is in the DOM while empty and takes no space', async () => {
    core();
    await open();
    const region = screen.getByRole('alert');
    expect(region.matches(':empty')).toBe(true);
    // Its own margin, taken away while it says nothing (`U-45`).
    expect(region.classList.contains('mt-5')).toBe(true);
    expect(region.classList.contains('empty:mt-0')).toBe(true);
    // And the last child of a block that is not a stack: `space-y-*` puts a margin on every child
    // but the last, which would sit under the buttons while the line is empty.
    expect(region.parentElement?.className ?? '').not.toContain('space-y-');
    expect(region.parentElement?.lastElementChild).toBe(region);
    expect(region.parentElement?.parentElement?.lastElementChild).toBe(region.parentElement);
    expect(region.hidden).toBe(false);
    expect(region.hasAttribute('aria-hidden')).toBe(false);
    expect(region.classList.contains('hidden')).toBe(false);
    expect(region.classList.contains('sr-only')).toBe(false);
    expect(getComputedStyle(region).display).not.toBe('none');
  });
});
