import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
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
  /** Each `POST /templates` (a create): refused with these in turn, then accepted. */
  creates?: Refusal[];
  /** Each save or create waits for this before it is answered. */
  holdSave?: Promise<void>;
  /** Counts the saves and creates sent. */
  written?: { count: number };
  tests?: Refusal[];
  deletes?: Refusal[];
  /** Each DELETE waits for this before it is answered. */
  hold?: Promise<void>;
  /** Counts the DELETEs sent. */
  deleted?: { count: number };
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
      if (script.written !== undefined) script.written.count += 1;
      const next = script.saves?.shift();
      return (script.holdSave ?? Promise.resolve()).then(() =>
        next === undefined ? reply(200, TEMPLATE) : refuse(next, 'the template was refused'),
      );
    }
    if (method === 'POST' && path === '/templates') {
      if (script.written !== undefined) script.written.count += 1;
      const next = script.creates?.shift();
      return (script.holdSave ?? Promise.resolve()).then(() =>
        next === undefined
          ? reply(201, { ...TEMPLATE, id: 10 })
          : refuse(next, 'the template was refused'),
      );
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
      if (script.deleted !== undefined) script.deleted.count += 1;
      const next = script.deletes?.shift();
      return (script.hold ?? Promise.resolve()).then(() =>
        next === undefined
          ? new Response(null, { status: 204 })
          : refuse(next, 'a trigger still names this template'),
      );
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

async function open(at = '/templates?id=9', heading = 'Editing Alert hook'): Promise<void> {
  render(
    <SessionContext.Provider value={SESSION}>
      <MemoryRouter initialEntries={[at]}>
        <TemplatesView />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
  await screen.findByRole('heading', { name: heading });
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
      expect(save.getAttribute('aria-disabled')).toBe('false');
    });

    fireEvent.click(save);
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe('the template was refused req-56b');
    });
    expect(within(form).getAllByRole('alert').at(-1)).toBe(region);
    await waitFor(() => {
      expect(save.getAttribute('aria-disabled')).toBe('false');
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

/**
 * Focus through a refused save or create (`U-73`).
 *
 * *Save template* and *Create template* were `disabled` while the request was out, and a button
 * disabled while it has focus can lose it, so the refusal could come back to focus on the page.
 * They are `aria-disabled` instead, as *Yes, delete* is (`U-64`): focus stays on the button
 * throughout, it says *Saving…*, and pressing it again, or Enter in a field submitting the form,
 * sends nothing more.
 */
describe('focus through a refused save or create (U-73)', () => {
  /** Holds every save until `answer` is called. */
  function held(): { hold: Promise<void>; answer: () => void } {
    let answer: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      answer = resolve;
    });
    return { hold, answer };
  }

  async function refusedKeepsFocus(name: 'Save template' | 'Create template'): Promise<void> {
    const written = { count: 0 };
    const { hold, answer } = held();
    core({ saves: [{ id: 'req-73' }], creates: [{ id: 'req-73' }], holdSave: hold, written });
    if (name === 'Save template') {
      await open();
    } else {
      await open('/templates?new=1', 'New template');
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pager' } });
    }
    const pressed = button(name);
    const form = pressed.closest('form');
    if (form === null) throw new Error('no form');
    pressed.focus();
    expect(document.activeElement).toBe(pressed);
    fireEvent.click(pressed);
    await waitFor(() => {
      expect(written.count).toBe(1);
    });

    // Out: the same button, saying so, unavailable but not disabled, and still focused.
    expect(button('Saving…')).toBe(pressed);
    expect(pressed.getAttribute('aria-disabled')).toBe('true');
    expect(pressed.disabled).toBe(false);
    expect(document.activeElement).toBe(pressed);

    // Pressed again, and the form submitted as Enter in a field would: nothing more is sent.
    fireEvent.click(pressed);
    fireEvent.submit(form);
    expect(written.count).toBe(1);

    answer();
    await alertSaying('the template was refused');
    expect(document.activeElement).toBe(pressed);
    await waitFor(() => {
      expect(pressed.getAttribute('aria-disabled')).toBe('false');
    });
    expect(button(name)).toBe(pressed);
    expect(document.activeElement).toBe(pressed);
    expect(written.count).toBe(1);

    // Available again: a press sends one more.
    fireEvent.click(pressed);
    await waitFor(() => {
      expect(written.count).toBe(2);
    });
  }

  it('keeps focus on Save template while it saves and when it is refused', async () => {
    await refusedKeepsFocus('Save template');
  });

  it('keeps focus on Create template while it creates and when it is refused', async () => {
    await refusedKeepsFocus('Create template');
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

/**
 * Focus after a refused delete (`U-64`).
 *
 * The refusal takes the question's place, so *Yes, delete* — which had focus — is removed with it,
 * and focus fell to the page. It goes to *Close*, the control the refusal leaves, described by the
 * region so the refusal is said with it; *Close* and *Keep it* send it back to *Delete*. An
 * operator who moved elsewhere while the core answered keeps their focus where they took it.
 * `fireEvent.click` does not move focus in jsdom, so each button is focused first, as a keyboard
 * or a screen reader would.
 */
describe('focus after a refused template delete (U-64)', () => {
  const press = (name: string): void => {
    const one = button(name);
    one.focus();
    expect(document.activeElement).toBe(one);
    fireEvent.click(one);
  };

  it('goes to Close, which the refusal describes, and from Close and Keep it back to Delete', async () => {
    core({ deletes: [{ id: 'req-64' }, { id: 'req-64b' }] });
    await open();
    const wrapper = button('Delete').parentElement;
    if (wrapper === null) throw new Error('no delete');
    const region = within(wrapper).getByRole('alert');

    press('Delete');
    press('Yes, delete');
    expect(await alertSaying('a trigger still names this template')).toBe(region);
    expect(screen.queryByRole('button', { name: 'Yes, delete' })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Close'));
    });
    // Described by the region, so a reader whose focus change cut the alert short hears it.
    expect(region.id).not.toBe('');
    expect(button('Close').getAttribute('aria-describedby')).toBe(region.id);
    expect(region.textContent).toBe('a trigger still names this template req-64');

    // Close goes, and so would its focus: it is given to Delete, which takes its place.
    press('Close');
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Delete'));
    });

    // Keep it, likewise.
    press('Delete');
    press('Keep it');
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Delete'));
    });

    // Refused again: Close again.
    press('Delete');
    press('Yes, delete');
    await waitFor(() => {
      expect(region.textContent).toBe('a trigger still names this template req-64b');
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Close'));
    });
  });

  it('is left where the operator took it while the core answered', async () => {
    core({ deletes: [{ id: 'req-64' }] });
    await open();
    press('Delete');
    press('Yes, delete');
    // Moved on before the answer: the refusal is said, and focus stays in the subject box.
    const subject = screen.getByLabelText('Subject');
    subject.focus();
    await alertSaying('a trigger still names this template');
    expect(button('Close')).toBeDefined();
    expect(document.activeElement).toBe(subject);
  });

  it('puts it on Keep it when the question is asked, which the question describes', async () => {
    core({});
    await open();
    press('Delete');
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Keep it'));
    });
    const asked = screen.getByText('Delete it?');
    expect(asked.id).not.toBe('');
    expect(button('Keep it').getAttribute('aria-describedby')).toBe(asked.id);
  });

  it('never leaves it on the page while a delete is out, refused or asked again', async () => {
    let answer: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const deleted = { count: 0 };
    core({ deletes: [{ id: 'req-64' }], hold, deleted });
    await open();
    const onPage = (): boolean =>
      document.activeElement === null || document.activeElement === document.body;

    press('Delete');
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Keep it'));
    });
    press('Yes, delete');
    await waitFor(() => {
      expect(deleted.count).toBe(1);
    });

    // Out: Keep it is not offered, since the request cannot be called back; Yes, delete keeps
    // focus, says so, and sends nothing more.
    const out = screen.getByRole('button', { name: 'Deleting…' });
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull();
    expect(out.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(out);
    fireEvent.click(out);
    expect(deleted.count).toBe(1);

    // Refused: Close. Closed: Delete. Asked again: the question, and Keep it.
    answer();
    await alertSaying('a trigger still names this template');
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Close'));
    });
    press('Close');
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Delete'));
    });
    press('Delete');
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Keep it'));
    });
    expect(screen.getByText('Delete it?')).toBeDefined();
    expect(onPage()).toBe(false);
  });

  // `U-81`: the case the two tests above met about one run in eight under load. *Delete* is
  // pressed in the moment after the commit that draws it and before React has run that commit's
  // passive effects. Outside `act`, a fetch's answer renders at the default priority, so those
  // effects wait for a later task, while a MutationObserver's callback runs in the microtask right
  // after the commit: pressing from there lands in that window every time. A focus effect that
  // runs then took the press's intent before *Keep it* was drawn, and focus stayed on the page.
  it('puts it on Keep it when Delete is pressed before the page’s effects have run (U-81)', async () => {
    core({});
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const named = (name: string): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === name);
    try {
      let early = false;
      const pressed = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          const del = named('Delete');
          if (del === undefined) return;
          observer.disconnect();
          // Pressed in the commit's own microtask: nothing has run Delete's effects yet.
          early = named('Keep it') === undefined;
          del.focus();
          // A native click, not `fireEvent`: that wraps it in `act`, which runs the waiting
          // effects first and hides the case.
          del.click();
          resolve();
        });
        observer.observe(container, { childList: true, subtree: true });
      });
      root.render(
        <SessionContext.Provider value={SESSION}>
          <MemoryRouter initialEntries={['/templates?id=9']}>
            <TemplatesView />
          </MemoryRouter>
        </SessionContext.Provider>,
      );
      await pressed;
      expect(early).toBe(true);
      // Every effect has had its turn.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const keep = named('Keep it');
      expect(keep).toBeDefined();
      expect(document.activeElement).toBe(keep);
    } finally {
      root.unmount();
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });
});

/**
 * An accepted delete (`U-64` review).
 *
 * It closes the editor and takes *Yes, delete* with it. Focus goes to *New template*, and a polite
 * region that was there, empty, from the start says which template went — the same node
 * throughout, since the list is held while it is read again rather than the page going back to
 * *Loading templates…*. Opening an editor empties it.
 */
describe('an accepted template delete (U-64)', () => {
  it('puts focus on New template and says the template was deleted', async () => {
    core({});
    await open();
    const newTemplate = button('New template');
    const region = newTemplate.parentElement?.nextElementSibling;
    if (!(region instanceof HTMLElement)) throw new Error('no deleted region');
    expectQuiet(region, ['mt-2', 'empty:mt-0'], 'polite');

    button('Delete').focus();
    fireEvent.click(button('Delete'));
    button('Yes, delete').focus();
    fireEvent.click(button('Yes, delete'));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Editing Alert hook' })).toBeNull();
    });
    expect(document.activeElement).toBe(newTemplate);
    await waitFor(() => {
      expect(region.textContent).toBe('Template Alert hook deleted.');
    });
    expect(newTemplate.parentElement?.nextElementSibling).toBe(region);
    expect(button('New template')).toBe(newTemplate);
    expect(speaking()).toEqual([]);

    // Opening an editor empties it.
    fireEvent.click(button('Alert hook'));
    await screen.findByRole('heading', { name: 'Editing Alert hook' });
    expect(region.matches(':empty')).toBe(true);
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
