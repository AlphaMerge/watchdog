import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorTypeSummary } from '../src/api/types';
import { SensorTypesView } from '../src/routes/SensorTypesView';

/**
 * The catalogue page, driven the way somebody looking for a sensor type drives it.
 *
 * **Shut is the default, and it is the point.** Forty-three types with every schema on screen is
 * a page you cannot see the list of types in; the rendered assertions below are about what is
 * *not* there until it is asked for.
 */

const ITEMS: SensorTypeSummary[] = [
  {
    id: 'http.request',
    category: 'Web',
    costHint: 'light',
    hasPreview: false,
    paramsSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', title: 'URL' },
        verifyTls: { type: 'boolean', title: 'Verify TLS', default: true },
        password: { type: 'string', title: 'Password', writeOnly: true },
      },
    },
  },
  {
    id: 'icmp.ping',
    category: 'Availability',
    costHint: 'light',
    hasPreview: false,
    paramsSchema: { type: 'object', properties: { host: { type: 'string', title: 'Host' } } },
  },
  {
    id: 'snmp.traffic',
    category: 'SNMP',
    costHint: 'medium',
    hasPreview: false,
    paramsSchema: { type: 'object', properties: {} },
  },
];

function stubCatalogue(items: SensorTypeSummary[] = ITEMS): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

async function show(items?: SensorTypeSummary[]): Promise<void> {
  stubCatalogue(items);
  render(
    <MemoryRouter>
      <SensorTypesView />
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /http\.request/ })).toBeDefined();
  });
}

const card = (id: string): HTMLElement => screen.getByRole('button', { name: new RegExp(id) });
const search = (): HTMLElement => screen.getByRole('combobox');
const typeInto = (text: string): void => {
  fireEvent.focus(search());
  fireEvent.change(search(), { target: { value: text } });
};

describe('the catalogue page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists every type shut, with enough on the row to decide whether to open it', async () => {
    await show();
    expect(card('http.request').getAttribute('aria-expanded')).toBe('false');
    // The row says what the card would cost you to open.
    expect(card('http.request').textContent).toContain('Web');
    expect(card('http.request').textContent).toContain('3 parameters');
    // And no schema is on screen until one is asked for.
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('opens one card without opening the rest', async () => {
    await show();
    fireEvent.click(card('http.request'));

    expect(card('http.request').getAttribute('aria-expanded')).toBe('true');
    expect(card('icmp.ping').getAttribute('aria-expanded')).toBe('false');
    const table = screen.getByRole('table');
    expect(within(table).getByText('verifyTls')).toBeDefined();
    // The annotation that keeps a credential out of every read path (P-05).
    expect(within(table).getByText('write-only')).toBeDefined();
  });

  it('shuts the same card again', async () => {
    await show();
    fireEvent.click(card('http.request'));
    fireEvent.click(card('http.request'));
    expect(card('http.request').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('says a type takes no parameters rather than showing an empty table', async () => {
    await show();
    fireEvent.click(card('snmp.traffic'));
    expect(screen.getByText('Takes no parameters.')).toBeDefined();
  });

  it('opens and shuts everything at once', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByRole('table')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });
});

describe('searching it', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters to what matches, and says how many that is', async () => {
    await show();
    typeInto('snmp');
    expect(screen.queryByRole('button', { name: /http\.request/ })).toBeNull();
    expect(card('snmp.traffic')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('1 type matching');
  });

  it('opens a card the query matched on a parameter, and says which one', async () => {
    // Somebody who typed `verifyTls` wants the row, not the card that happens to contain it.
    await show();
    typeInto('verifyTls');
    expect(card('http.request').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/matches verifyTls/)).toBeDefined();
  });

  it('leaves a card matched by its own id shut — the name was the answer', async () => {
    await show();
    typeInto('icmp');
    expect(card('icmp.ping').getAttribute('aria-expanded')).toBe('false');
  });

  it('shuts what the search opened once the search is cleared', async () => {
    // What a search opens belongs to the search. Cards left open with nothing on screen saying
    // why is how the page gets back to being a mile of tables.
    await show();
    typeInto('verifyTls');
    expect(card('http.request').getAttribute('aria-expanded')).toBe('true');

    typeInto('');
    expect(card('http.request').getAttribute('aria-expanded')).toBe('false');
  });

  it('lets a card the search opened be shut by hand, and keeps it that way', async () => {
    await show();
    typeInto('verifyTls');
    fireEvent.click(card('http.request'));
    expect(card('http.request').getAttribute('aria-expanded')).toBe('false');
  });

  it('explains an empty result instead of showing a blank page', async () => {
    await show();
    typeInto('nothing here');
    expect(screen.getByText(/Nothing in the catalogue matches/)).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('0 types matching');
  });

  it('suggests categories before anything is typed, and filters when one is taken', async () => {
    await show();
    fireEvent.focus(search());
    const offered = screen.getAllByRole('option').map((option) => option.textContent);
    expect(offered).toHaveLength(3);
    // Alphabetical, each with the count that is the reason to pick it.
    expect(offered[0]).toMatch(/Availability.*1 type/);
    expect(offered[1]).toMatch(/SNMP.*1 type/);
    expect(offered[2]).toMatch(/Web.*1 type/);

    fireEvent.click(screen.getByRole('option', { name: /SNMP/ }));
    expect((search() as HTMLInputElement).value).toBe('SNMP');
    expect(screen.queryByRole('button', { name: /http\.request/ })).toBeNull();
  });

  it('says why nothing is registered rather than showing an empty list', async () => {
    stubCatalogue([]);
    render(
      <MemoryRouter>
        <SensorTypesView />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/No sensor types are registered/)).toBeDefined();
    });
  });
});
