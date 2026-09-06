import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SessionProvider } from '../src/auth/SessionProvider';

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

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('do not match');
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

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('12 characters');
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

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('current password was not accepted');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Change your password' })).toBeDefined();
    });
  });
});
