import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { NotificationRequestView } from '../src/api/types';
import { NotificationRow } from '../src/routes/LogsView';

function entry(overrides: Partial<NotificationRequestView> = {}): NotificationRequestView {
  return {
    id: 1,
    at: '2026-09-28T20:00:00.000Z',
    sensorId: 7,
    sensorName: 'Ping',
    templateId: 3,
    templateName: 'On call',
    method: 'email',
    triggerKind: 'state',
    reason: 'initial',
    state: 'down',
    message: 'no ICMP reply',
    status: 'sent',
    disposition: 'immediate',
    attempts: 1,
    deliveredAt: '2026-09-28T20:00:01.000Z',
    nextAttemptAt: null,
    lastError: null,
    skippedRecipients: '',
    ...overrides,
  };
}

function show(view: NotificationRequestView): void {
  render(
    <MemoryRouter>
      <ul>
        <NotificationRow entry={view} />
      </ul>
    </MemoryRouter>,
  );
}

describe('a notification in the log', () => {
  it('says who a sent message missed, so "sent" is not taken to mean everybody (M-19)', () => {
    show(entry({ skippedRecipients: '"bob" in group "NOC" (disabled)' }));
    expect(screen.getByText('Not sent to "bob" in group "NOC" (disabled)')).toBeTruthy();
  });

  it('says nothing more when it reached everybody it named', () => {
    show(entry());
    expect(screen.queryByText(/Not sent to/)).toBeNull();
  });
});
