import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingView } from '../src/api/types';
import { SettingsPanel } from '../src/routes/detail/SettingsPanel';
import { expectCorrelation } from './support/refusal-region';

/**
 * An inheritable setting's problem, announced and tied to its control (`U-46`).
 *
 * The same rules `U-41` and `U-45` hold the parameter form to: the region exists, empty and
 * polite, before anything is wrong — a live region added with its text already in it is not
 * announced — names the control's description and makes it `aria-invalid` only while it says
 * something, and takes no space while it says nothing. jsdom lays nothing out, so what is asserted
 * is what the layout rests on.
 */

function interval(own: number | null): SettingView {
  return {
    key: 'scan.intervalSeconds',
    description: 'How often a sensor runs.',
    schema: { type: 'integer', minimum: 30 },
    effective:
      own === null
        ? { value: 300, source: { kind: 'default' } }
        : { value: own, source: { kind: 'own', objectId: 7 } },
    inherited: { value: 300, source: { kind: 'default' } },
    own: own === null ? null : { value: own },
  };
}

function renderPanel(setting: SettingView): HTMLInputElement {
  render(
    <SettingsPanel objectId={7} items={[setting]} ancestors={[]} onChanged={() => undefined} />,
  );
  return screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Interval seconds' });
}

function regionOf(box: HTMLElement): HTMLElement {
  const region = document.getElementById(`${box.id}-problem`);
  if (region === null) throw new Error('the problem region should exist before a problem');
  return region;
}

function describedBy(box: HTMLElement): string[] {
  return (box.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
}

describe('an inheritable setting’s problem (U-46)', () => {
  it('is one region, there empty before the problem, saying it, and empty again after', () => {
    const box = renderPanel(interval(60));
    const region = regionOf(box);
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.matches(':empty')).toBe(true);
    expect(describedBy(box)).not.toContain(region.id);
    expect(box.hasAttribute('aria-invalid')).toBe(false);

    fireEvent.change(box, { target: { value: '10' } });
    expect(document.getElementById(`${box.id}-problem`)).toBe(region);
    expect(region.textContent).toBe('must be 30 or more');
    expect(screen.getByText('must be 30 or more')).toBe(region);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(box)).toContain(region.id);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(box, { target: { value: '45' } });
    expect(document.getElementById(`${box.id}-problem`)).toBe(region);
    expect(region.matches(':empty')).toBe(true);
    expect(describedBy(box)).not.toContain(region.id);
    expect(box.hasAttribute('aria-invalid')).toBe(false);
  });

  it.each([
    ['overridden', 60],
    ['inherited', null],
  ] as const)('is in the DOM while empty and takes no space, %s', (_label, own) => {
    const region = regionOf(renderPanel(interval(own)));
    expect(region.matches(':empty')).toBe(true);
    expect(region.classList.contains('mt-1')).toBe(true);
    expect(region.classList.contains('empty:mt-0')).toBe(true);
    // Outside any stack: `space-y-*` puts a margin on every child but the last.
    expect(region.parentElement?.className ?? '').not.toContain('space-y-');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.hidden).toBe(false);
    expect(region.hasAttribute('aria-hidden')).toBe(false);
    expect(region.classList.contains('hidden')).toBe(false);
    expect(region.classList.contains('sr-only')).toBe(false);
    expect(getComputedStyle(region).display).not.toBe('none');
  });
});

describe('a save the core refused (U-48)', () => {
  // A refusal comes back while focus is on Save, and nothing moves it, so a live region is the
  // only thing that says the save did not happen; one added with its text already in it is not
  // reliably announced, so it has to be there, empty, first.
  const REFUSED = 'scan.intervalSeconds cannot be overridden on this object';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The core: each request takes the next answer, `null` for an accepted save. */
  function core(...answers: (string | null)[]): unknown[] {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', (_path: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined);
      const refusal = answers.shift();
      return Promise.resolve(
        refusal === null || refusal === undefined
          ? new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(JSON.stringify({ error: { code: 'CONFLICT', message: refusal } }), {
              status: 409,
              headers: { 'content-type': 'application/json' },
            }),
      );
    });
    return bodies;
  }

  function alertOf(): HTMLElement {
    return screen.getByRole('alert');
  }

  it('is there empty before, says the core’s words after, and empties on the next save', async () => {
    const bodies = core(REFUSED, null);
    const changed = vi.fn();
    render(
      <SettingsPanel objectId={7} items={[interval(60)]} ancestors={[]} onChanged={changed} />,
    );
    const box = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Interval seconds' });
    const save = screen.getByRole('button', { name: 'Save' });

    // Before anything was sent: present, empty, assertive by its role.
    const region = alertOf();
    expect(region.matches(':empty')).toBe(true);
    expect(region.hasAttribute('aria-live')).toBe(false);

    fireEvent.change(box, { target: { value: '45' } });
    save.focus();
    fireEvent.click(save);
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    // The same node: its text changed, which is what is announced.
    expect(alertOf()).toBe(region);
    expect(screen.getByText(REFUSED)).toBe(region);
    expect(changed).not.toHaveBeenCalled();

    // The next attempt empties it as it starts, so a refusal in the same words would be a change
    // again; this one is accepted, and it stays empty.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    expect(alertOf()).toBe(region);
    expect(region.matches(':empty')).toBe(true);
    expect(bodies).toStrictEqual([{ value: 45 }, { value: 45 }]);
  });

  it('says a second refusal in the same words by emptying first', async () => {
    core(REFUSED, REFUSED);
    render(
      <SettingsPanel
        objectId={7}
        items={[interval(60)]}
        ancestors={[]}
        onChanged={() => undefined}
      />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Interval seconds' }), {
      target: { value: '45' },
    });
    const region = alertOf();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    expect(alertOf()).toBe(region);
  });

  it('gives the correlation id beside the message, as the parameter form does (U-51)', async () => {
    // What finds this refusal in the core's log; the operator reading it out to whoever reads
    // the log has nothing else to give them.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 'CONFLICT', message: REFUSED, correlationId: 'req-51' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    renderPanel(interval(60));
    const region = alertOf();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Interval seconds' }), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(region.textContent).toBe(`${REFUSED} req-51`);
    });
    // In the alert itself, in `CorrelationId` (`U-65`): said with the message, after a space, so
    // a screen reader does not run it into the message's last word.
    expectCorrelation(region, 'req-51');
    expect(alertOf()).toBe(region);
    // The spacing `U-46` gave the line is unchanged by what it holds.
    expect(region.classList.contains('mt-1.5')).toBe(true);
    expect(region.classList.contains('empty:mt-0')).toBe(true);
  });

  it('says the message alone when the core gives no correlation id', async () => {
    core(REFUSED);
    renderPanel(interval(60));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Interval seconds' }), {
      target: { value: '45' },
    });
    const region = alertOf();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(region.textContent).toBe(REFUSED);
    });
    expect(region.querySelector('span')).toBeNull();
  });

  it.each([
    ['overridden', 60],
    ['inherited', null],
  ] as const)('is in the DOM while empty and takes no space, %s', (_label, own) => {
    renderPanel(interval(own));
    const region = alertOf();
    expect(region.matches(':empty')).toBe(true);
    // The spacing `U-46` gave it, taken away while it says nothing (`U-45`).
    expect(region.classList.contains('mt-1.5')).toBe(true);
    expect(region.classList.contains('empty:mt-0')).toBe(true);
    expect(region.parentElement?.className ?? '').not.toContain('space-y-');
    expect(region.hidden).toBe(false);
    expect(region.hasAttribute('aria-hidden')).toBe(false);
    expect(region.classList.contains('hidden')).toBe(false);
    expect(region.classList.contains('sr-only')).toBe(false);
    expect(getComputedStyle(region).display).not.toBe('none');
  });
});
