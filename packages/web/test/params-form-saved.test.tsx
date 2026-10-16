import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectDetail, SensorTypeSummary } from '../src/api/types';
import { ParamsForm } from '../src/routes/detail/ParamsForm';
import { expectQuiet } from './support/refusal-region';

/**
 * A save of a sensor's parameters the core accepted, said (`U-36`).
 *
 * When the sensor's type cannot answer for its stored parameters, the core leaves each lookup the
 * edit would have moved as it is and names those channels in its reply (`P-311`). The form says
 * so after *Saved*, naming each channel in text, in a polite region that is there and empty
 * before the save — one added with its text already in it is not reliably announced (`U-41`).
 * The page re-reads the sensor on a save and keeps the form mounted through it, so the form is
 * driven here the way the page drives it: `onSaved` hands it the newer detail.
 */

const TYPE: SensorTypeSummary = {
  id: 'snmp.custom',
  category: 'SNMP',
  costHint: 'medium',
  hasPreview: false,
  paramsSchema: { type: 'object', properties: { unit: { type: 'string', title: 'Unit' } } },
};

const DETAIL = {
  id: 43,
  kind: 'sensor',
  name: 'Uptime',
  version: 1,
  sensorType: 'snmp.custom',
  params: { unit: '' },
  redactedParams: [],
} as unknown as ObjectDetail;

const SAVED = 'Saved. The probe picks the change up on its next configuration push.';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The core: every `PATCH` is accepted, its reply carrying `lookupsKept` when given. */
function core(lookupsKept?: string[]): void {
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    const sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      params: Record<string, unknown>;
    };
    const reply = {
      ...DETAIL,
      version: 2,
      params: sent.params,
      ...(lookupsKept === undefined ? {} : { lookupsKept }),
    };
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

/** The page, as far as the form sees it: a re-read on a save, with the form kept mounted. */
function Page(): React.JSX.Element {
  const [detail, setDetail] = useState(DETAIL);
  return (
    <ParamsForm
      detail={detail}
      type={TYPE}
      onSaved={() => {
        // What the re-read answers: the next version, the edit in it, nothing about the save.
        setDetail({ ...DETAIL, version: 2, params: { unit: 'C' } });
      }}
    />
  );
}

/** The form, its status region, and a change saved. */
function saveAChange(): HTMLElement {
  render(<Page />);
  const region = screen.getByRole('status');
  expectQuiet(region, ['mt-2', 'empty:mt-0'], 'polite');
  fireEvent.change(screen.getByRole('textbox', { name: 'Unit' }), { target: { value: 'C' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
  return region;
}

describe('a save the core accepted (U-36)', () => {
  it('says the save in the region that was there empty, and nothing about lookups when none were kept', async () => {
    core();
    const region = saveAChange();
    await waitFor(() => {
      expect(region.textContent).toBe(SAVED);
    });
    expect(screen.getByRole('status')).toBe(region);
    expect(within(region).queryByRole('list')).toBeNull();
    // Started again from the version saved: not a changed form, so nothing to save.
    expect(screen.getByRole('button', { name: 'Save parameters' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('names the one channel whose lookup the edit kept, after Saved', async () => {
    core(['value']);
    const region = saveAChange();
    await waitFor(() => {
      expect(region.textContent).toContain('One channel kept its lookup:');
    });
    expect(region.textContent.startsWith(SAVED)).toBe(true);
    expect(region.textContent).toContain('could not be told from the one the type set');
    expect(region.textContent).toContain('left it as it was');
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Channel value']);
    // In text ink, not the success colour alone and not a series of coloured words.
    const said = within(region).getByText(/kept its lookup/u);
    expect(said.closest('.text-text')).not.toBeNull();
    expect(screen.queryAllByRole('alert').filter((one) => one.textContent !== '')).toEqual([]);
  });

  it('names every channel when there were several', async () => {
    core(['in', 'out']);
    const region = saveAChange();
    await waitFor(() => {
      expect(region.textContent).toContain('2 channels kept their lookup:');
    });
    expect(region.textContent).toContain('left them as they were');
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Channel in', 'Channel out']);
  });

  it('is emptied by the next change', async () => {
    core(['value']);
    const region = saveAChange();
    await waitFor(() => {
      expect(region.textContent).toContain('kept its lookup');
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Unit' }), { target: { value: 'F' } });
    expect(region.matches(':empty')).toBe(true);
    expect(screen.getByRole('status')).toBe(region);
  });
});

/**
 * The page, with the sensor's version moved by something other than this form: a channel's
 * lookup set in the table above it (`U-82`), or somebody else's edit of the parameters.
 */
function Moved({
  reread = { unit: 'C' },
}: {
  /** The parameters the re-read after this form's save answers. */
  reread?: Record<string, unknown>;
}): React.JSX.Element {
  const [detail, setDetail] = useState(DETAIL);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDetail((was) => ({ ...was, version: was.version + 1 }));
        }}
      >
        A lookup set
      </button>
      <button
        type="button"
        onClick={() => {
          setDetail((was) => ({ ...was, version: was.version + 1, params: { unit: 'K' } }));
        }}
      >
        The parameters edited elsewhere
      </button>
      <ParamsForm
        detail={detail}
        type={TYPE}
        onSaved={() => {
          setDetail((was) => ({ ...was, version: was.version + 1, params: reread }));
        }}
      />
    </>
  );
}

describe('a version moved by something other than this form (U-82)', () => {
  const unit = (): HTMLInputElement =>
    screen.getByRole('textbox', { name: 'Unit' }) as unknown as HTMLInputElement;

  it('keeps what was typed when the parameters did not move, and saves it held to the new version', async () => {
    const tags: (string | null)[] = [];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      tags.push(new Headers(init?.headers).get('if-match'));
      return Promise.resolve(
        new Response(JSON.stringify({ ...DETAIL, version: 3, params: { unit: 'F' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    render(<Moved />);
    fireEvent.change(unit(), { target: { value: 'F' } });
    fireEvent.click(screen.getByRole('button', { name: 'A lookup set' }));
    expect(unit().value).toBe('F');
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    await waitFor(() => {
      expect(tags).toEqual(['W/"2"']);
    });
  });

  it('starts again from parameters that moved, as from a save', () => {
    render(<Moved />);
    fireEvent.change(unit(), { target: { value: 'F' } });
    fireEvent.click(screen.getByRole('button', { name: 'The parameters edited elsewhere' }));
    expect(unit().value).toBe('K');
  });

  it('starts again from its own save, and keeps what is typed after it through a lookup set', async () => {
    core();
    render(<Moved />);
    fireEvent.change(unit(), { target: { value: 'C' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(SAVED);
    });
    expect(unit().value).toBe('C');
    fireEvent.change(unit(), { target: { value: 'D' } });
    fireEvent.click(screen.getByRole('button', { name: 'A lookup set' }));
    expect(unit().value).toBe('D');
  });

  it('starts again from its own save when the core kept the parameters as they were', async () => {
    // A value the core normalised back to what it held: the version moved and the parameters did
    // not, and the form shows what is stored rather than calling itself changed.
    core();
    render(<Moved reread={{ unit: '' }} />);
    fireEvent.change(unit(), { target: { value: 'C' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(SAVED);
    });
    expect(unit().value).toBe('');
    expect(screen.getByRole('button', { name: 'Save parameters' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
