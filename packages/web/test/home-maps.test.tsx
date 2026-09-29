import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapSummary } from '../src/api/types';
import { MapPriority } from '../src/maps/MapPriority';
import { HOME_LIMIT, HOME_PRIORITY, starredMaps } from '../src/routes/home-maps';

/**
 * Five-star maps on the home screen (`G-09`, `CAPABILITIES.MD §2`).
 *
 * Two halves, and the second is the one that makes the first reachable: which maps surface, and
 * the control that lets anybody star one. Without the control the rule is unreachable — every map
 * is created at three stars and nothing in the product could ever change that.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function map(id: number, priority: number, name = `map-${String(id)}`): MapSummary {
  return {
    id,
    name,
    description: '',
    priority,
    layout: { widgets: [] },
    version: 4,
    createdAt: '2026-09-09T09:00:00.000Z',
    updatedAt: '2026-09-09T09:00:00.000Z',
  };
}

describe('which maps reach the home screen', () => {
  it('takes the five-star ones and nothing else', () => {
    // Not "four or more". The point of the top of the scale is that reaching it is a decision.
    const { shown } = starredMaps([map(1, 5), map(2, 4), map(3, 5), map(4, 1)]);
    expect(shown.map((one) => one.id)).toEqual([1, 3]);
  });

  it('keeps the order the core gave them', () => {
    // `GET /maps` already answers priority-first then by name; a second ordering here is a second
    // thing that eventually disagrees with the first.
    const { shown } = starredMaps([map(9, 5, 'zulu'), map(1, 5, 'alpha')]);
    expect(shown.map((one) => one.name)).toEqual(['zulu', 'alpha']);
  });

  it('says how many did not fit rather than stopping quietly', () => {
    const many = Array.from({ length: HOME_LIMIT + 3 }, (_, i) => map(i + 1, HOME_PRIORITY));
    const { shown, hidden } = starredMaps(many);
    expect(shown).toHaveLength(HOME_LIMIT);
    expect(hidden).toBe(3);
  });

  it('hides nothing when they all fit', () => {
    expect(starredMaps([map(1, 5), map(2, 5)]).hidden).toBe(0);
  });

  it('answers empty for an installation with no starred maps', () => {
    const { shown, hidden } = starredMaps([map(1, 3), map(2, 1)]);
    expect(shown).toHaveLength(0);
    expect(hidden).toBe(0);
  });
});

describe('starring one', () => {
  const subject = (
    priority: number,
    onSaved: (updated: MapSummary) => void = () => undefined,
  ): void => {
    render(
      <MemoryRouter>
        <MapPriority map={map(4, priority)} version={() => 7} onSaved={onSaved} />
      </MemoryRouter>,
    );
  };

  it('says whether this map is on the home screen, and how to put it there', () => {
    subject(3);
    expect(screen.getByText(/appears on the Overview page/)).toBeDefined();
  });

  it('says so differently once it is starred', () => {
    subject(HOME_PRIORITY);
    expect(screen.getByText('On the Overview page, because it is starred.')).toBeDefined();
  });

  it('sends the change with the version it was made against', async () => {
    // A priority is a small field and the concurrency rule is not about the field's size: two
    // people with the designer open is the ordinary case.
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(map(4, 5)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const saved: MapSummary[] = [];
    subject(3, (updated) => {
      saved.push(updated);
    });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '5' } });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(JSON.parse((calls[0]?.init.body ?? '{}') as string)).toEqual({ priority: 5 });
    expect((calls[0]?.init.headers as Record<string, string>)['if-match']).toBe('7');
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
  });

  it('puts the number back when the core refuses the change', async () => {
    // **The screen must not claim a change that did not happen.** A select left showing five
    // stars after a rejected save is a map somebody believes is on the home screen.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'MAP_CHANGED', message: 'moved on' } }), {
          status: 412,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    subject(3);
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '5' } });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('MAP_CHANGED');
    });
    expect(screen.getByLabelText<HTMLSelectElement>('Priority').value).toBe('3');
  });
});
