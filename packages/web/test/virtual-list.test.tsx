import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VirtualList } from '../src/components/VirtualList';

const ROW = 36;
const HEIGHT = 360;

function rows(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function renderList(count: number, overscan = 0, activeIndex?: number) {
  return render(
    <VirtualList
      items={rows(count)}
      rowHeight={ROW}
      height={HEIGHT}
      overscan={overscan}
      keyOf={(item) => item}
      label="Object tree"
      role="tree"
      itemRole="treeitem"
      itemProps={(item) => ({ 'aria-level': (item % 3) + 1 })}
      render={(item) => <span>row {item}</span>}
      {...(activeIndex === undefined ? {} : { activeIndex })}
    />,
  );
}

describe('VirtualList', () => {
  it('renders only the rows a viewport can show', () => {
    renderList(5000);
    // 360px of viewport at 36px a row is ten rows, plus the partial one at the bottom.
    expect(screen.getAllByRole('treeitem')).toHaveLength(11);
    expect(screen.queryByText('row 4999')).toBeNull();
  });

  it('still reports the whole list to a screen reader', () => {
    renderList(5000);
    // The point of the assertion: forty rows exist and "1 of 5000" is still what is announced.
    // A virtualised list that says "1 of 11" has lied about the size of the installation.
    const first = screen.getAllByRole('treeitem')[0];
    expect(first?.getAttribute('aria-setsize')).toBe('5000');
    expect(first?.getAttribute('aria-posinset')).toBe('1');
  });

  it('is a tree, and carries the depth its caller supplies', () => {
    renderList(9);
    expect(screen.getByRole('tree', { name: 'Object tree' })).toBeDefined();
    const levels = screen.getAllByRole('treeitem').map((row) => row.getAttribute('aria-level'));
    expect(levels.slice(0, 4)).toEqual(['1', '2', '3', '1']);
  });

  it('hides the spacers from assistive technology', () => {
    const { container } = renderList(5000);
    const spacers = container.querySelectorAll('[aria-hidden="true"]');
    // Two: the space above the window and the space below it. Announcing either would put two
    // enormous blank elements into the reading order.
    expect(spacers).toHaveLength(2);
    expect((spacers[1] as HTMLElement).style.height).toBe(`${String((5000 - 11) * ROW)}px`);
  });

  it('draws overscan rows outside the viewport', () => {
    renderList(5000, 4);
    expect(screen.getAllByRole('treeitem')).toHaveLength(15);
  });

  it('renders every row when the list is shorter than the viewport', () => {
    renderList(3);
    expect(screen.getAllByRole('treeitem')).toHaveLength(3);
    expect(screen.getByText('row 2')).toBeDefined();
  });

  it('renders nothing rather than an empty row for an empty list', () => {
    renderList(0);
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });
});

describe('the tab stop', () => {
  it('is the container when no row is active, so a plain list is one stop', () => {
    renderList(50);
    expect(screen.getByRole('tree').getAttribute('tabindex')).toBe('0');
    for (const row of screen.getAllByRole('treeitem')) {
      expect(row.hasAttribute('tabindex')).toBe(false);
    }
  });

  it('roves to the active row, and the container gives its stop up', () => {
    // Both halves matter. A container that kept `tabIndex={0}` alongside a roving row would put
    // two stops on one widget, and Tab would land on the box where the arrow keys do nothing.
    renderList(50, 0, 3);
    expect(screen.getByRole('tree').hasAttribute('tabindex')).toBe(false);
    const stops = screen
      .getAllByRole('treeitem')
      .map((row) => row.getAttribute('tabindex'))
      .filter((value) => value === '0');
    expect(stops).toHaveLength(1);
  });

  it('puts it on the active row and takes it off every other', () => {
    renderList(50, 0, 3);
    const rendered = screen.getAllByRole('treeitem');
    expect(rendered[3]?.getAttribute('tabindex')).toBe('0');
    expect(rendered[0]?.getAttribute('tabindex')).toBe('-1');
    expect(rendered[4]?.getAttribute('tabindex')).toBe('-1');
  });

  it('leaves exactly one stop even when the active row is scrolled out of the window', () => {
    // The row for index 400 is not rendered at all. Nothing may carry `tabIndex={0}` in its
    // place: two stops would be a second way into the widget with no way to tell them apart.
    renderList(5000, 0, 400);
    const stops = screen
      .getAllByRole('treeitem')
      .filter((row) => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(0);
    expect(screen.getByRole('tree').hasAttribute('tabindex')).toBe(false);
  });
});
