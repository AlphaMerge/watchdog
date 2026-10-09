import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SessionProvider } from '../src/auth/SessionProvider';
import { SAY_AGAIN_MS } from '../src/components/refusal';
import { alertSaying, expectQuiet } from './support/refusal-region';

/**
 * The password the operator did not choose (`U-17`).
 *
 * `mustChangePassword` is a flag on a principal and nothing on the core refuses a request
 * because of it. If the client does not act on it, the generated password written to
 * `first-admin-password` stays a live credential for as long as the installation runs — so the
 * form is forced, and the only thing that takes it down is the core saying the flag is gone.
 */

const SESSION = '/api/v1/auth/session';
const PASSWORD = '/api/v1/auth/password';

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown> | undefined;
}

const principal = (mustChangePassword: boolean): unknown => ({
  requireAuthentication: true,
  authenticated: true,
  principal: { userId: 1, login: 'admin', role: 'admin', mustChangePassword },
});

/**
 * `sessions` is read one entry per `GET /auth/session`, repeating the last — so a case can say
 * "the flag is set, and set no longer once the change lands".
 */
function stubFetch(sessions: unknown[], change: { status: number; body: unknown }): Call[] {
  const asked: Call[] = [];
  const queue = [...sessions];
  vi.stubGlobal('fetch', (url: string, init?: { body?: string }) => {
    asked.push({
      url,
      body:
        init?.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>),
    });
    if (url === SESSION) {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve(
        new Response(JSON.stringify(next), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url === PASSWORD) {
      return Promise.resolve(
        new Response(JSON.stringify(change.body), {
          status: change.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return new Promise<Response>(() => undefined);
  });
  return asked;
}

async function type(label: string, value: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText(label), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

function mount(): void {
  render(
    <MemoryRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('a password somebody else chose', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands the application over only once the core says the flag is gone', async () => {
    const asked = stubFetch([principal(true), principal(false)], {
      status: 200,
      body: { endedSessions: 2 },
    });
    mount();

    await screen.findByRole('heading', { name: 'Change your password' });
    await type('Current password', 'the-generated-one');
    await type('New password', 'a-password-of-my-own');
    await type('New password again', 'a-password-of-my-own');
    submit();

    await screen.findByRole('link', { name: 'Skip to content' });
    expect(asked.find((call) => call.url === PASSWORD)?.body).toEqual({
      currentPassword: 'the-generated-one',
      newPassword: 'a-password-of-my-own',
    });
    // Asked again rather than assumed: the flag lives on the account, so the copy this client
    // holds is stale the moment the change lands.
    expect(asked.filter((call) => call.url === SESSION)).toHaveLength(2);
  });

  it('catches a mistyped confirmation without spending a request', async () => {
    // The confirmation field has no server side at all. It exists so a typo in something nobody
    // can read back does not become a lockout.
    const asked = stubFetch([principal(true)], { status: 200, body: { endedSessions: 0 } });
    mount();

    await screen.findByRole('heading', { name: 'Change your password' });
    await type('Current password', 'the-generated-one');
    await type('New password', 'a-password-of-my-own');
    await type('New password again', 'a-password-of-my-owm');
    submit();

    await alertSaying('do not match');
    expect(asked.some((call) => call.url === PASSWORD)).toBe(false);
  });

  it('refuses a new password the core would refuse, before asking it', async () => {
    const asked = stubFetch([principal(true)], { status: 200, body: { endedSessions: 0 } });
    mount();

    await screen.findByRole('heading', { name: 'Change your password' });
    await type('Current password', 'the-generated-one');
    await type('New password', 'short');
    await type('New password again', 'short');
    submit();

    await alertSaying('12 characters');
    expect(asked.some((call) => call.url === PASSWORD)).toBe(false);
  });

  it('stays put and says so when the current password is wrong', async () => {
    stubFetch([principal(true)], {
      status: 400,
      body: {
        error: {
          code: 'ACCOUNT_PASSWORD_WRONG',
          message: 'the current password was not accepted',
        },
      },
    });
    mount();

    await screen.findByRole('heading', { name: 'Change your password' });
    await type('Current password', 'not-the-generated-one');
    await type('New password', 'a-password-of-my-own');
    await type('New password again', 'a-password-of-my-own');
    submit();

    await alertSaying('current password was not accepted');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Change your password' })).toBeDefined();
    });
  });
});

/**
 * The refusal, announced (`U-54`): in the tree and empty before anything is sent, every refusal —
 * the form's own and the core's — in that same node, emptied by an attempt that is accepted, and
 * said again in the same words: after a round trip, or a moment after the form decides it.
 */
describe('a refused password change (U-54)', () => {
  const WRONG = 'the current password was not accepted';
  const refused = {
    status: 400,
    body: { error: { code: 'ACCOUNT_PASSWORD_WRONG', message: WRONG } },
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function fill(confirm = 'a-password-of-my-own'): Promise<void> {
    await type('Current password', 'the-generated-one');
    await type('New password', 'a-password-of-my-own');
    await type('New password again', confirm);
  }

  it('is there empty before, says a refusal in the same node, and an accepted change empties it', async () => {
    // Still forced after the change, so the form stays to be looked at.
    stubFetch([principal(true)], { status: 200, body: { endedSessions: 0 } });
    mount();
    await screen.findByRole('heading', { name: 'Change your password' });

    const region = screen.getByRole('alert');
    expectQuiet(region, ['mt-3', 'empty:mt-0']);

    await fill('a-password-of-my-owm');
    submit();
    expect(await alertSaying('do not match')).toBe(region);

    await fill();
    submit();
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Change password' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    expect(region.matches(':empty')).toBe(true);
    expect(screen.getByRole('alert')).toBe(region);
  });

  it('empties as an attempt starts, so the core refusing twice in the same words is said twice', async () => {
    stubFetch([principal(true)], refused);
    mount();
    await screen.findByRole('heading', { name: 'Change your password' });
    const region = screen.getByRole('alert');
    await fill();
    submit();
    await waitFor(() => {
      expect(region.textContent).toBe(WRONG);
    });

    submit();
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(WRONG);
    });
    expect(screen.getByRole('alert')).toBe(region);
  });

  it('says its own refusal again, emptied first and filled a moment later', async () => {
    stubFetch([principal(true)], refused);
    mount();
    await screen.findByRole('heading', { name: 'Change your password' });
    const region = screen.getByRole('alert');
    await fill('a-password-of-my-owm');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      submit();
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS);
      });
      expect(region.textContent).toBe('Those two do not match.');

      submit();
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS - 1);
      });
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(region.textContent).toBe('Those two do not match.');
      expect(screen.getByRole('alert')).toBe(region);
    } finally {
      vi.useRealTimers();
    }
  });
});
