import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { Empty, ErrorPanel } from '../src/components/Panels';

describe('ErrorPanel', () => {
  it('says the core is down rather than repeating the browser’s phrasing', () => {
    render(<ErrorPanel error={new ApiError(0, 'UNREACHABLE', 'the core is not reachable')} />);
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('The core is not reachable')).toBeDefined();
    // The one thing that makes it actionable.
    expect(screen.getByText(/dev\/core\.json/)).toBeDefined();
  });

  it('shows the correlation id, which is what ties a failure to a log line', () => {
    render(<ErrorPanel error={new ApiError(500, 'INTERNAL', 'it broke', 'abc-123')} />);
    expect(screen.getByText(/abc-123/)).toBeDefined();
  });
});

describe('Empty', () => {
  it('explains why it is empty, so a blank panel does not read as a bug', () => {
    render(<Empty because="The core registers them when it starts.">No sensor types.</Empty>);
    expect(screen.getByText('No sensor types.')).toBeDefined();
    expect(screen.getByText('The core registers them when it starts.')).toBeDefined();
  });
});
