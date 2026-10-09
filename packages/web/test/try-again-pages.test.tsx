import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type {
  HistorySeries,
  NotificationMethod,
  ObjectDetail,
  SensorValues,
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

const SENSOR: ObjectDetail = {
  ...GROUP,
  id: 9,
  kind: 'sensor',
  name: 'Storage table',
  sensorType: 'snmp.table',
  params: {},
  redactedParams: [],
};

const NO_READINGS: SensorValues = {
  sensorId: 9,
  readAt: '2026-10-09T12:00:00.000Z',
  notBefore: '2026-10-09T11:57:00.000Z',
  intervalSeconds: 60,
  channels: [],
};

/** The sensor page, every read answered but the ones `script` says otherwise. */
function sensorPage(at: string, script: Parameters<typeof core>[0]): ReturnType<typeof core> {
  const scripted = core({
    '/objects/9': [{ ok: SENSOR }],
    '/objects/9/ancestors': [{ ok: { items: [] } }],
    '/objects/9/channels': [{ ok: { items: [] } }],
    '/sensors/9/values': [{ ok: NO_READINGS }],
    '/sensor-types': [{ ok: { items: [] } }],
    '/lookups': [{ ok: { items: [] } }],
    ...script,
  });
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/objects/:id" element={<ObjectDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
  return scripted;
}

/**
 * A panel inside one of the sensor page's tabs (`U-76`). The page's heading is above the header,
 * the tab strip and every card before the one that failed, so when the panel goes, focus goes to
 * the tab's own panel instead: focusable, named by its tab, and where the operator was.
 */
describe('a panel in a sensor page tab hands focus to the tab (U-76)', () => {
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
    const { asked } = sensorPage('/objects/9?tab=history', {
      '/sensors/9/history': [fail('req-1'), fail('req-2'), { ok: empty }],
    });
    await roundTrip({
      heading: 'Storage table',
      landsOn: () => document.getElementById('panel-history'),
      answered: () => screen.getByText('No channels to chart.'),
      reads: () => asked('/sensors/9/history'),
    });
  });

  it('an Overview card, the sensor type’s', async () => {
    const { asked } = sensorPage('/objects/9', {
      '/sensor-types': [fail('req-1'), fail('req-2'), { ok: { items: [] } }],
    });
    await roundTrip({
      heading: 'Storage table',
      landsOn: () => document.getElementById('panel-overview'),
      answered: () => screen.getByText(/is not a registered sensor type/u),
      reads: () => asked('/sensor-types'),
    });
  });
});
