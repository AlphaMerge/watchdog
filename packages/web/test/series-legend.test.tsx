import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SeriesLegend } from '../src/charts/SeriesLegend';
import type { ChartSeries } from '../src/charts/time-series-model';

function series(...labels: string[]): ChartSeries[] {
  return labels.map((label, slot) => ({ label, slot, avg: [1], min: [1], max: [1] }));
}

describe('the series legend', () => {
  it('is absent for a single series, because the panel heading names it', () => {
    const { container } = render(
      <SeriesLegend series={series('Response time')} latest={['1 ms']} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('is present from two series up', () => {
    render(<SeriesLegend series={series('In', 'Out')} latest={['1 kbit/s', '2 kbit/s']} />);
    expect(screen.getByText('In')).toBeDefined();
    expect(screen.getByText('Out')).toBeDefined();
  });

  it('carries one value per series — a direct label, not a number on every point', () => {
    render(<SeriesLegend series={series('In', 'Out')} latest={['1 kbit/s', '2 kbit/s']} />);
    expect(screen.getByText('1 kbit/s')).toBeDefined();
    expect(screen.getByText('2 kbit/s')).toBeDefined();
  });

  it('says a series ending in a gap has no value rather than showing zero', () => {
    render(<SeriesLegend series={series('In', 'Out')} latest={['1 kbit/s', null]} />);
    expect(screen.getByText('—')).toBeDefined();
  });

  it('keeps the label in text ink and the colour in the key', () => {
    // Three of the eight light slots sit below 3:1 on white; a label painted in its series
    // colour would be genuinely hard to read, so the key carries identity and the ink the words.
    // The key names a custom property rather than a resolved colour, so a theme change repaints
    // it without React having to re-render — the bug that would otherwise leave a legend in the
    // old palette while the canvas beside it rebuilt in the new one.
    const { container } = render(<SeriesLegend series={series('In', 'Out')} latest={['1', '2']} />);
    const label = screen.getByText('In');
    expect(label.getAttribute('style')).toBeNull();
    const keys = container.querySelectorAll('[aria-hidden="true"]');
    expect(keys).toHaveLength(2);
    expect((keys[0] as HTMLElement).style.background).toBe('var(--ms-series-1)');
    expect((keys[1] as HTMLElement).style.background).toBe('var(--ms-series-2)');
  });
});
