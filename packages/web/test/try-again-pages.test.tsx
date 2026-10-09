import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type {
  HistorySeries,
  NotificationMethod,
  ObjectDetail,
  TemplateView,
} from '../src/api/types';
import { SessionContext, type SessionContextValue } from '../src/auth/session';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';
import { TemplatesView } from '../src/routes/TemplatesView';
import { HistoryPanel } from '../src/routes/detail/HistoryPanel';
import { core, fail, roundTrip } from './support/try-again';

/**
 * *Try again* on the object page's and the Templates page's first read (`U-68`, converted after
 * the round's other changes to both pages landed).
 *
 * Both pages are only the error panel until their first read succeeds, so there is no heading
 * on the page while it is out: the panel has to stay, its button keeping focus, and the heading
 * that comes with the answer takes the focus the panel is owed.
 */

// The object page opens a socket for its live state, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const GROUP: ObjectDetail = {
  id: 5,
  parentId: 1,
  kind: 'group',
  name: 'Core switches',
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: false,
  comments: '',
  inheritsTriggers: true,
  childCount: 0,
  createdAt: '2026-10-09T08:00:00.000Z',
  updatedAt: '2026-10-09T08:00:00.000Z',
};

const TEMPLATE: TemplateView = {
  id: 9,
  name: 'Alert hook',
  description: '',
  method: 'webhook',
  methodName: 'Webhook',
  settings: {},
  redactedSettings: [],
  subject: '%sensor is %status',
  body: '%lastmessage',
  recipients: [],
  priority: 3,
  enabled: true,
  summary: 'a webhook',
  summarisable: false,
  summarisation: 'first-down-and-up',
  summaryWindowSeconds: 0,
  scheduleId: null,
  scheduleName: null,
  whenInactive: 'queue',
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

const METHOD: NotificationMethod = {
  id: 'webhook',
  name: 'Webhook',
  description: 'Posts to a URL.',
  settingsSchema: { type: 'object', properties: {} },
  usesRecipients: false,
  summarisable: false,
};

const SESSION: SessionContextValue = {
  session: { kind: 'anonymous', requireAuthentication: false },
  signedIn: () => undefined,
  signOut: () => Promise.resolve(),
  refresh: () => undefined,
  askingToSignIn: false,
  askToSignIn: () => undefined,
};

describe('a first read that failed (U-68)', () => {
  it('the object page', async () => {
    const { asked } = core({ '/objects/5': [fail('req-1'), fail('req-2'), { ok: GROUP }] });
    render(
      <MemoryRouter initialEntries={['/objects/5']}>
        <Routes>
          <Route path="/objects/:id" element={<ObjectDetailView />} />
        </Routes>
      </MemoryRouter>,
    );
    await roundTrip({
      heading: 'Core switches',
      answered: () => screen.getByRole('heading', { level: 1, name: 'Core switches' }),
      reads: () => asked('/objects/5'),
    });
  });

  it('the Templates page', async () => {
    const { asked } = core({
      '/templates': [fail('req-1'), fail('req-2'), { ok: { items: [TEMPLATE] } }],
      '/notification-methods': [{ ok: { items: [METHOD] } }],
      '/notification-placeholders': [{ ok: { items: [] } }],
      '/summarisation-modes': [{ ok: { items: [] } }],
      '/schedules': [{ ok: { items: [] } }],
    });
    render(
      <SessionContext.Provider value={SESSION}>
        <MemoryRouter initialEntries={['/templates']}>
          <TemplatesView />
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    await roundTrip({
      heading: 'Notification templates',
      answered: () => screen.getByText('Alert hook'),
      reads: () => asked('/templates'),
    });
  });

  it('the History tab, with no series held', async () => {
    const empty: HistorySeries = {
      sensorId: 9,
      from: '2026-10-09T11:00:00.000Z',
      to: '2026-10-09T12:00:00.000Z',
      resolutionSeconds: 60,
      bucketCount: 0,
      source: 'sample',
      buckets: [],
      channels: [],
      segments: [],
      adjustments: [],
    };
    const { asked } = core({ '/sensors/9/history': [fail('req-1'), fail('req-2'), { ok: empty }] });
    render(
      <MemoryRouter>
        {/* The object page's heading, which is on the page while its History tab reads. */}
        <h1 tabIndex={-1}>Storage table</h1>
        <HistoryPanel sensorId={9} hideRetired={false} onHideRetiredChange={() => undefined} />
      </MemoryRouter>,
    );
    await roundTrip({
      heading: 'Storage table',
      answered: () => screen.getByText('No channels to chart.'),
      reads: () => asked('/sensors/9/history'),
    });
  });
});
