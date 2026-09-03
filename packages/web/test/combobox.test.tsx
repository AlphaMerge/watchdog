import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, type ComboboxOption } from '../src/components/Combobox';

/**
 * The search box's keyboard, which is the half of a combobox that either works or is a trap.
 *
 * What is asserted here is the ARIA authoring practice, not our preferences: focus never leaves
 * the input, the active option is named by `aria-activedescendant`, arrowing does not choose
 * anything, and Escape always gets back out. A sighted mouse user would never notice any of
 * these being wrong.
 */

const CATEGORY: ComboboxOption = { value: 'SNMP', badge: 'category', detail: '9 types' };
const TYPE: ComboboxOption = { value: 'snmp.traffic', badge: 'type', detail: 'SNMP · medium' };
const PARAM: ComboboxOption = {
  value: 'snmpVersion',
  badge: 'param',
  detail: 'parameter · 9 types',
};
const OPTIONS: ComboboxOption[] = [CATEGORY, TYPE, PARAM];

/** The control is controlled, so the test has to hold its value like the page does. */
function Harness({
  options = OPTIONS,
  onPick = (): void => undefined,
  initial = '',
}: {
  options?: ComboboxOption[];
  onPick?: (option: ComboboxOption) => void;
  initial?: string;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <Combobox
      id="search"
      label="Search sensor types"
      placeholder="Search"
      value={value}
      onChange={setValue}
      onPick={onPick}
      options={options}
    />
  );
}

const box = (): HTMLElement => screen.getByRole('combobox');
const active = (): string | null => box().getAttribute('aria-activedescendant');

/**
 * Focus the box the way a user does. `.focus()` rather than `fireEvent.focus`, so that
 * `document.activeElement` means something — and inside `act`, because the state update the
 * focus schedules is React's to flush, not jsdom's.
 */
const focusBox = (): void => {
  act(() => {
    box().focus();
  });
};

describe('the suggestion list', () => {
  it('starts shut, and opens on focus rather than making somebody guess it exists', () => {
    render(<Harness />);
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    focusBox();
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('is named by the input, so the two are one control to a screen reader', () => {
    render(<Harness />);
    focusBox();
    expect(box().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    expect(box().getAttribute('aria-autocomplete')).toBe('list');
  });

  it('stays shut when there is nothing to suggest', () => {
    render(<Harness options={[]} />);
    focusBox();
    expect(screen.queryAllByRole('listbox')).toHaveLength(0);
  });
});

describe('moving through it', () => {
  it('marks the active option without touching what was typed', () => {
    // The point of `aria-activedescendant`: looking at a suggestion is not choosing it, and the
    // half-typed query survives a look down the list.
    render(<Harness initial="snmp" />);
    focusBox();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });

    expect(active()).toBe(screen.getAllByRole('option')[0]?.id);
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
    expect((box() as HTMLInputElement).value).toBe('snmp');
    expect(document.activeElement).toBe(box());
  });

  it('wraps at both ends, because a list of three is a ring and not a wall', () => {
    render(<Harness />);
    focusBox();
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(active()).toBe(screen.getAllByRole('option')[2]?.id);

    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(active()).toBe(screen.getAllByRole('option')[0]?.id);
  });

  it('jumps to the ends with Home and End', () => {
    render(<Harness />);
    focusBox();
    fireEvent.keyDown(box(), { key: 'End' });
    expect(active()).toBe(screen.getAllByRole('option')[2]?.id);
    fireEvent.keyDown(box(), { key: 'Home' });
    expect(active()).toBe(screen.getAllByRole('option')[0]?.id);
  });

  it('never points at an option that a narrowed list no longer has', () => {
    // The bug this prevents is silent: a stale `aria-activedescendant` names an id that is not
    // in the document, and the screen reader announces nothing at all.
    const { rerender } = render(<Harness />);
    focusBox();
    fireEvent.keyDown(box(), { key: 'End' });
    expect(active()).not.toBeNull();

    rerender(<Harness options={[CATEGORY]} />);
    expect(active()).toBeNull();
  });
});

describe('choosing, and getting out', () => {
  it('takes the active suggestion on Enter', () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    focusBox();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(picked).toHaveBeenCalledWith(TYPE);
    expect(box().getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves a bare Enter alone, for a query the list does not contain', () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} initial="anything" />);
    focusBox();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(picked).not.toHaveBeenCalled();
  });

  it('takes a click, and does not let the mousedown close the list first', () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    focusBox();
    const option = screen.getByRole('option', { name: /snmpVersion/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(picked).toHaveBeenCalledWith(PARAM);
  });

  it('shuts on Escape, and clears the field on a second Escape', () => {
    render(<Harness initial="snmp" />);
    focusBox();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect((box() as HTMLInputElement).value).toBe('snmp');

    fireEvent.keyDown(box(), { key: 'Escape' });
    expect((box() as HTMLInputElement).value).toBe('');
  });

  it('shuts when focus leaves the control altogether', () => {
    render(<Harness />);
    focusBox();
    fireEvent.focusOut(box(), { relatedTarget: document.body });
    expect(box().getAttribute('aria-expanded')).toBe('false');
  });

  it('reopens as soon as anything is typed', () => {
    render(<Harness />);
    focusBox();
    fireEvent.keyDown(box(), { key: 'Escape' });
    fireEvent.change(box(), { target: { value: 'snm' } });
    expect(box().getAttribute('aria-expanded')).toBe('true');
    // And nothing is active yet: the first suggestion is not a choice made on your behalf.
    expect(active()).toBeNull();
  });
});
