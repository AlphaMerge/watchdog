import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationMethod, TemplateView } from '../src/api/types';
import { SessionContext, type SessionContextValue } from '../src/auth/session';
import { TemplatesView } from '../src/routes/TemplatesView';
import { expectCorrelation, expectQuiet, speaking } from './support/refusal-region';

/**
 * After a template is written (`U-69`), and when the list is then read again and that read fails
 * (`U-67`).
 *
 * An accepted save closes the editor and takes *Save template*, which had focus, with it: focus
 * goes to *New template*, as an accepted delete's does (`U-64`), and the page's polite region says
 * which template was saved. The list is then read again, holding the one it had; a read that
 * fails keeps it and says so in a region of its own beside it, with *Try again*, which keeps focus
 * while it reads.
 */

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

/** How the nth read of the list is answered: at once, refused, or held until `release`. */
let listReply: (read: number) => 'answer' | 'fail' | 'hold' = () => 'answer';
let release: (answer: 'list' | 'fail') => void = () => undefined;
let listReads = 0;

const reply = (status: number, data: unknown): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
const LIST_REFUSED = {
  error: {
    code: 'UNAVAILABLE',
    message: 'restarting',
    correlationId: 'req-67',
    context: {},
    details: {},
  },
};

beforeEach(() => {
  listReply = () => 'answer';
  release = () => undefined;
  listReads = 0;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    const method = init?.method ?? 'GET';
    const body = (): Record<string, unknown> =>
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    if (method === 'POST' && path === '/templates/preview') {
      return reply(200, {
        templateId: 9,
        sensorId: 40,
        subject: 'Ping is Down',
        body: 'timed out',
        unknown: [],
      });
    }
    // The core answers with the template as written, under the name it was given.
    if (method === 'PUT' && path === '/templates/9') return reply(200, { ...TEMPLATE, ...body() });
    if (method === 'POST' && path === '/templates') {
      return reply(201, { ...TEMPLATE, id: 10, ...body() });
    }
    if (path === '/templates') {
      listReads += 1;
      const next = listReply(listReads);
      if (next === 'fail') return reply(503, LIST_REFUSED);
      if (next === 'hold') {
        return new Promise<Response>((resolve) => {
          release = (answer) => {
            void (
              answer === 'fail' ? reply(503, LIST_REFUSED) : reply(200, { items: [TEMPLATE] })
            ).then(resolve);
          };
        });
      }
      return reply(200, { items: [TEMPLATE] });
    }
    if (path === '/notification-methods') return reply(200, { items: [METHOD] });
    if (
      path === '/notification-placeholders' ||
      path === '/summarisation-modes' ||
      path === '/schedules'
    ) {
      return reply(200, { items: [] });
    }
    if (path.startsWith('/objects?kind=sensor')) return reply(200, { items: [] });
    throw new Error(`no stub for ${method} ${path}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const SESSION: SessionContextValue = {
  session: { kind: 'anonymous', requireAuthentication: false },
  signedIn: () => undefined,
  signOut: () => Promise.resolve(),
  refresh: () => undefined,
  askingToSignIn: false,
  askToSignIn: () => undefined,
};

async function open(at: string, heading: string): Promise<void> {
  render(
    <SessionContext.Provider value={SESSION}>
      <MemoryRouter initialEntries={[at]}>
        <TemplatesView />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
  await screen.findByRole('heading', { name: heading });
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name });

/** The page's region below the title, which says what was saved or deleted. */
function doneRegion(): HTMLElement {
  const region = button('New template').parentElement?.nextElementSibling;
  if (!(region instanceof HTMLElement)) throw new Error('no region below the title');
  return region;
}

/** The region beside the list: the first thing in the list's card. */
function listRegion(): HTMLElement {
  const body = button('Alert hook').closest('section')?.lastElementChild;
  const region = body?.firstElementChild?.firstElementChild;
  if (!(region instanceof HTMLElement)) throw new Error('no region beside the list');
  return region;
}

/** Presses `name` as a keyboard would: focused first, since `fireEvent` moves no focus. */
function press(name: string): HTMLButtonElement {
  const one = button(name);
  one.focus();
  expect(document.activeElement).toBe(one);
  fireEvent.click(one);
  return one;
}

describe('an accepted template save (U-69)', () => {
  it('puts focus on New template and says the template was saved, each time', async () => {
    await open('/templates?id=9', 'Editing Alert hook');
    const newTemplate = button('New template');
    const region = doneRegion();
    expectQuiet(region, ['mt-2', 'empty:mt-0'], 'polite');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alert hook v2' } });
    press('Save template');
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Editing Alert hook' })).toBeNull();
    });
    expect(document.activeElement).toBe(newTemplate);
    await waitFor(() => {
      expect(region.textContent).toBe('Template Alert hook v2 saved.');
    });
    expect(doneRegion()).toBe(region);
    expect(speaking()).toEqual([]);

    // Opened again it is emptied; saved again it is said again.
    fireEvent.click(button('Alert hook'));
    await screen.findByRole('heading', { name: 'Editing Alert hook' });
    expect(region.matches(':empty')).toBe(true);
    press('Save template');
    await waitFor(() => {
      expect(region.textContent).toBe('Template Alert hook saved.');
    });
    expect(document.activeElement).toBe(newTemplate);
  });

  it('says a new one was created, and puts focus on New template', async () => {
    await open('/templates?new=1', 'New template');
    const newTemplate = button('New template');
    const region = doneRegion();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pager' } });
    press('Create template');
    await waitFor(() => {
      expect(region.textContent).toBe('Template Pager created.');
    });
    expect(document.activeElement).toBe(newTemplate);
  });
});

const SAID =
  'The template list could not be read again, so this is the one read before and may be out ' +
  'of date: restarting req-67';

describe('a failed re-read of the template list (U-67)', () => {
  it('keeps the list and says so beside it, again in the same words, and Try again keeps focus', async () => {
    // Read once; the read after the save is refused; Try again is held, refused, then answered.
    listReply = (read) => (read === 1 ? 'answer' : read === 2 ? 'fail' : 'hold');
    await open('/templates?id=9', 'Editing Alert hook');
    const region = listRegion();
    expectQuiet(region, ['mb-2', 'empty:mb-0'], 'polite');
    const newTemplate = button('New template');

    press('Save template');
    await waitFor(() => {
      expect(region.textContent).toBe(SAID);
    });
    expectCorrelation(region, 'req-67');
    // The list is still there, and so is everything around it: no error panel took the page.
    expect(listRegion()).toBe(region);
    expect(button('Alert hook')).toBeDefined();
    expect(button('New template')).toBe(newTemplate);
    expect(document.activeElement).toBe(newTemplate);
    await waitFor(() => {
      expect(doneRegion().textContent).toBe('Template Alert hook saved.');
    });
    expect(speaking()).toEqual([]);

    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(region.textContent);
    });
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    try {
      const retry = press('Try again');
      // Emptied as the read starts; the same element stays, unavailable, with focus, and a
      // second press asks nothing.
      expect(region.matches(':empty')).toBe(true);
      expect(button('Try again')).toBe(retry);
      expect(retry.getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(retry);
      await waitFor(() => {
        expect(listReads).toBe(3);
      });
      fireEvent.click(retry);
      expect(listReads).toBe(3);

      // Refused in the same words: said again.
      act(() => {
        release('fail');
      });
      await waitFor(() => {
        expect(region.textContent).toBe(SAID);
      });
      expect(seen).toEqual(['', SAID]);
      expect(document.activeElement).toBe(retry);

      // Read: emptied, Try again goes, and focus goes to New template.
      press('Try again');
      await waitFor(() => {
        expect(listReads).toBe(4);
      });
      act(() => {
        release('list');
      });
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      });
      expect(region.matches(':empty')).toBe(true);
      expect(document.activeElement).toBe(newTemplate);
    } finally {
      observer.disconnect();
    }
  });

  it('leaves focus where the operator took it while the read was out', async () => {
    listReply = (read) => (read === 1 ? 'answer' : read === 2 ? 'fail' : 'hold');
    await open('/templates?id=9', 'Editing Alert hook');
    press('Save template');
    await waitFor(() => {
      expect(listRegion().textContent).toBe(SAID);
    });
    press('Try again');
    await waitFor(() => {
      expect(listReads).toBe(3);
    });
    const other = button('Alert hook');
    other.focus();
    act(() => {
      release('list');
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });
    expect(document.activeElement).toBe(other);
  });
});
