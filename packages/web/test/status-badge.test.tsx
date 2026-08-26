import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '../src/components/StatusBadge';
import type { SensorState } from '../src/api/types';

const ALL: SensorState[] = [
  'up',
  'warning',
  'down',
  'down_acknowledged',
  'paused',
  'unknown',
  'unusual',
  'down_partial',
];

describe('StatusBadge', () => {
  it('names every state in text, not only in colour', () => {
    // WCAG 1.4.1: colour cannot be the only way a state is conveyed. A screen reader gets the
    // word, and so does anyone who cannot tell the red from the green.
    for (const state of ALL) {
      const { unmount } = render(<StatusBadge state={state} />);
      expect(screen.getByText(/Up|Warning|Down|Paused|Unknown|Unusual/)).toBeDefined();
      unmount();
    }
  });

  it('hides the decorative glyph from assistive technology', () => {
    const { container } = render(<StatusBadge state="down" />);
    const glyph = container.querySelector('[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    // The glyph is redundant with the label; announcing "black square Down" helps nobody.
    expect(glyph?.textContent).toBe('■');
  });

  it('distinguishes acknowledged from plain Down', () => {
    render(<StatusBadge state="down_acknowledged" />);
    expect(screen.getByText('Down (acknowledged)')).toBeDefined();
  });

  it('gives every state a distinct glyph', () => {
    const glyphs = new Set<string>();
    for (const state of ALL) {
      const { container, unmount } = render(<StatusBadge state={state} />);
      glyphs.add(container.querySelector('[aria-hidden="true"]')?.textContent ?? '');
      unmount();
    }
    expect(glyphs.size).toBe(ALL.length);
  });

  it('says what a rolled-up badge means, when it is told', () => {
    // A group's badge is the worst state beneath it. Announcing a bare "Down" on a group says
    // the group is down, which is a different and usually false claim (`U-03`).
    render(<StatusBadge state="down" describedAs="worst state below Berlin: down" />);
    expect(screen.getByRole('img', { name: 'worst state below Berlin: down' })).toBeDefined();
  });

  it('stays a plain reading when nothing overrides it', () => {
    const { container } = render(<StatusBadge state="down" />);
    expect(container.querySelector('[role="img"]')).toBeNull();
  });
});
