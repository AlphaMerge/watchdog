import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationMethod, ObjectSummary, TemplateView } from '../src/api/types';
import { SessionContext, type SessionContextValue } from '../src/auth/session';
import { TemplatesView } from '../src/routes/TemplatesView';
import { alertSaying, expectCorrelation, expectQuiet, speaking } from './support/refusal-region';

/**
 * The template editor's refusals, announced (`U-56`).
 *
 * A refused save, a refused test send and a refused delete each come back a round trip after the
 * operator pressed the button, with focus on it, so a live region is the only thing that says so.
 * Each is in the tree and empty before (`U-41`), the refusal lands in that same node with the
 * core's id and whatever it listed, and the next attempt empties it as it starts so the same
 * words are said again. The preview's refusal answers the draft as it is typed, so its region is
 * polite, and a different draft refused in the same words empties it and fills it again.
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

const SENSOR: ObjectSummary = {
  id: 40,
  parentId: 30,
  kind: 'sensor',
  name: 'Ping',
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: false,
};

/** A refusal the core sends — with an id when given — or `'unreachable'` for none at all. */
type Refusal = { readonly id?: string; readonly details?: unknown } | 'unreachable';

const UNKNOWN_PLACEHOLDER = 'the draft names a placeholder that does not exist';

interface Script {
  saves?: Refusal[];
  tests?: Refusal[];
  deletes?: Refusal[];
}

function core(script: Script): void {
  const reply = (status: number, data: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const refuse = (next: Refusal, message: string): Promise<Response> =>
    next === 'unreachable'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : reply(409, {
          error: {
            code: 'TEMPLATE_REFUSED',
            message,
            details: next.details ?? {},
            ...(next.id === undefined ? {} : { correlationId: next.id }),
          },
        });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    const method = init?.method ?? 'GET';
    if (method === 'POST' && path === '/templates/preview') {
      const sent = typeof init?.body === 'string' ? init.body : '{}';
      const { template } = JSON.parse(sent) as { template: { subject: string } };
      // A subject naming `%nope…` is refused, in the same words whichever one it is.
      return template.subject.includes('%nope')
        ? reply(400, {
            error: {
              code: 'TEMPLATE_INVALID',
              message: UNKNOWN_PLACEHOLDER,
              details: { problems: [{ message: '%nope is not a placeholder' }] },
            },
          })
        : reply(200, {
            templateId: 9,
            sensorId: 40,
            subject: 'Ping is Down',
            body: 'timed out',
            unknown: [],
          });
    }
    if (method === 'PUT' && path === '/templates/9') {
      const next = script.saves?.shift();
      return next === undefined ? reply(200, TEMPLATE) : refuse(next, 'the template was refused');
    }
    if (method === 'POST' && path === '/templates/9/test') {
      const next = script.tests?.shift();
      return next === undefined
        ? reply(200, {
            templateId: 9,
            templateName: 'Alert hook',
            method: 'webhook',
            methodName: 'Webhook',
            sensorId: 40,
            sensorName: 'Ping',
            subject: 'Ping is Down',
            body: 'timed out',
            delivered: true,
            durationMs: 12,
            detail: '200 OK',
            error: null,
            notes: [],
          })
        : refuse(next, 'the test could not be sent');
    }
    if (method === 'DELETE' && path === '/templates/9') {
      const next = script.deletes?.shift();
      return next === undefined
        ? Promise.resolve(new Response(null, { status: 204 }))
        : refuse(next, 'a trigger still names this template');
    }
    if (path === '/templates') return reply(200, { items: [TEMPLATE] });
    if (path === '/notification-methods') return reply(200, { items: [METHOD] });
    if (
      path === '/notification-placeholders' ||
      path === '/summarisation-modes' ||
      path === '/schedules'
    ) {
      return reply(200, { items: [] });
    }
    if (path.startsWith('/objects?kind=sensor')) return reply(200, { items: [SENSOR] });
    throw new Error(`no stub for ${method} ${path}`);
  });
}

const SESSION: SessionContextValue = {
  session: { kind: 'anonymous', requireAuthentication: false },
  signedIn: () => undefined,
  signOut: () => Promise.resolve(),
  refresh: () => undefined,
  askingToSignIn: false,
  askToSignIn: () => undefined,
};

async function open(): Promise<void> {
  render(
    <SessionContext.Provider value={SESSION}>
      <MemoryRouter initialEntries={['/templates?id=9']}>
        <TemplatesView />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
  await screen.findByRole('heading', { name: 'Editing Alert hook' });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name });

describe('a refused template save (U-56)', () => {
  it('is said in the form’s region with its id and problems, again in the same words, and emptied by one accepted', async () => {
    core({
      saves: [
        { id: 'req-56', details: { problems: [{ message: '/subject must not be empty' }] } },
        { id: 'req-56b' },
      ],
    });
    await open();
    const save = button('Save template');
    const form = save.closest('form');
    if (form === null) throw new Error('no form');
    // The form's last alert; the delete has its own, among the buttons.
    const region = within(form).getAllByRole('alert').at(-1);
    if (region === undefined) throw new Error('no save region');
    expectQuiet(region, ['mt-4', 'empty:mt-0']);

    fireEvent.click(save);
    expect(await alertSaying('the template was refused')).toBe(region);
    expect(region.textContent).toBe('the template was refused req-56/subject must not be empty');
    expectCorrelation(region, 'req-56');
    await waitFor(() => {
      expect(save.disabled).toBe(false);
    });

    fireEvent.click(save);
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe('the template was refused req-56b');
    });
    expect(within(form).getAllByRole('alert').at(-1)).toBe(region);
    await waitFor(() => {
      expect(save.disabled).toBe(false);
    });

    // Accepted: emptied as it starts, and the editor closes.
    fireEvent.click(save);
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Editing Alert hook' })).toBeNull();
    });
    expect(speaking()).toEqual([]);
  });
});

describe('a refused test send (U-56)', () => {
  it('is said in its region with its id, again in the same words, and with none when the core never answered', async () => {
    core({ tests: [{ id: 'req-56' }, 'unreachable'] });
    await open();
    const card = screen.getByRole('heading', { name: 'Test send' }).closest('div');
    if (card === null) throw new Error('no test send');
    const region = within(card).getByRole('alert');
    expectQuiet(region, ['mt-2', 'empty:mt-0']);
    const send = within(card).getByRole<HTMLButtonElement>('button', { name: 'Send a test' });

    fireEvent.click(send);
    expect(await alertSaying('the test could not be sent')).toBe(region);
    expectCorrelation(region, 'req-56');
    await waitFor(() => {
      expect(send.disabled).toBe(false);
    });

    fireEvent.click(send);
    expect(region.matches(':empty')).toBe(true);
    expect(await alertSaying('the core is not reachable')).toBe(region);
    expectCorrelation(region, undefined);
  });
});

describe('a refused template delete (U-56)', () => {
  it('is said in the region that was there before the question, with what still names it', async () => {
    core({
      deletes: [
        {
          id: 'req-56',
          details: { usedBy: [{ objectId: 5, objectName: 'Datacentre', summary: 'on Down' }] },
        },
        'unreachable',
      ],
    });
    await open();
    const wrapper = button('Delete').parentElement;
    if (wrapper === null) throw new Error('no delete');
    const region = within(wrapper).getByRole('alert');
    expectQuiet(region, []);

    fireEvent.click(button('Delete'));
    expect(within(wrapper).getByRole('alert')).toBe(region);
    expect(region.matches(':empty')).toBe(true);

    fireEvent.click(button('Yes, delete'));
    expect(await alertSaying('a trigger still names this template')).toBe(region);
    expectCorrelation(region, 'req-56');
    expect(within(region).getByRole('link', { name: 'Datacentre' })).toBeDefined();
    expect(region.textContent).toContain('on Down');

    // Closed: the same node, emptied, and the question can be asked again.
    fireEvent.click(button('Close'));
    expect(region.matches(':empty')).toBe(true);
    expect(within(wrapper).getByRole('alert')).toBe(region);

    fireEvent.click(button('Delete'));
    fireEvent.click(button('Yes, delete'));
    expect(await alertSaying('the core is not reachable')).toBe(region);
    expectCorrelation(region, undefined);
  });
});

describe('a refused preview (U-56)', () => {
  it('is said politely in a region that was there before, again for a different draft in the same words, and emptied by one accepted', async () => {
    core({});
    await open();
    const panel = screen.getByRole('heading', { name: 'Preview' }).closest('div.border');
    if (!(panel instanceof HTMLElement)) throw new Error('no preview');
    const region = panel.querySelector<HTMLElement>('[aria-live="polite"]');
    if (region === null) throw new Error('no preview region');
    expectQuiet(region, [], 'polite');
    await within(panel).findByText('Ping is Down', undefined, { timeout: 3_000 });

    // Every state the region is seen in, in order.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(region.textContent);
    });
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    try {
      const subject = screen.getByLabelText('Subject');
      fireEvent.change(subject, { target: { value: '%nope1' } });
      await waitFor(
        () => {
          expect(region.textContent).toContain(UNKNOWN_PLACEHOLDER);
        },
        { timeout: 3_000 },
      );
      expect(region.textContent).toBe(`${UNKNOWN_PLACEHOLDER}%nope is not a placeholder`);
      expectCorrelation(region, undefined);
      // The rendering of a draft no longer in the box is not shown beside it.
      expect(within(panel).queryByText('Ping is Down')).toBeNull();

      // A different draft, refused in the same words: emptied, then said again.
      const before = seen.length;
      fireEvent.change(subject, { target: { value: '%nope2' } });
      await waitFor(
        () => {
          expect(seen.slice(before)).toEqual([
            '',
            `${UNKNOWN_PLACEHOLDER}%nope is not a placeholder`,
          ]);
        },
        { timeout: 3_000 },
      );
      expect(panel.querySelector('[aria-live="polite"]')).toBe(region);

      fireEvent.change(subject, { target: { value: '%sensor' } });
      await within(panel).findByText('Ping is Down', undefined, { timeout: 3_000 });
      expect(region.matches(':empty')).toBe(true);
    } finally {
      observer.disconnect();
    }
  });
});
