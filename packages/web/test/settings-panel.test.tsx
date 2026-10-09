import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SettingView } from '../src/api/types';
import { SettingsPanel } from '../src/routes/detail/SettingsPanel';

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
