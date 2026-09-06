import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SessionProvider } from '../src/auth/SessionProvider';

/**
 * The login form, end to end against a scripted core (`U-17`).
 *
 * **`POST /auth/login` is one exchange, not two.** There is no half-authenticated state on the
 * core holding a verified password while a code is typed, so the second attempt carries the
 * password again — and a form that dropped it would answer `AUTH_REJECTED` on a password the
 * core had already accepted, which reads to an operator as the code field breaking the login.
 */

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const SESSION = '/api/v1/auth/session';
const LOGIN = '/api/v1/auth/login';

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown> | undefined;
}

/**
 * Answers `/auth/session` once and `/auth/login` from a queue, so a case can script the second
 * attempt differently from the first. Anything else hangs.
 */
function stubFetch(logins: Reply[]): Call[] {
  const asked: Call[] = [];
  const queue = [...logins];
  vi.stubGlobal('fetch', (url: string, init?: { body?: string }) => {
    asked.push({
      url,
      body:
        init?.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>),
    });
    if (url === SESSION) {
      return Promise.resolve(
        new Response(JSON.stringify({ requireAuthentication: true, authenticated: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url === LOGIN) {
      const reply = queue.shift();
      if (reply === undefined) throw new Error('an unscripted login attempt');
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return new Promise<Response>(() => undefined);
  });
  return asked;
}

const refusal = (status: number, code: string, message: string, details = {}): Reply => ({
  status,
  body: { error: { code, message, details } },
});

const accepted: Reply = {
  status: 200,
  body: { userId: 3, login: 'ops', role: 'readwrite', mustChangePassword: false },
};

async function type(label: string, value: string): Promise<void> {
  const field = await screen.findByLabelText(label);
  fireEvent.change(field, { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
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

describe('logging in', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands the application over once the core accepts the password', async () => {
    const asked = stubFetch([accepted]);
    mount();

    await type('Login', 'ops');
    await type('Password', 'a-real-password');
    submit();

    await screen.findByRole('link', { name: 'Skip to content' });
    expect(screen.getByRole('button', { name: 'Log out' })).toBeDefined();
    expect(asked.filter((call) => call.url === LOGIN)).toHaveLength(1);
    // No `code` is sent when none was asked for: the core's schema forbids properties it did
    // not declare, so an empty string here would turn every ordinary login into a 400.
    expect(asked.find((call) => call.url === LOGIN)?.body).toEqual({
      login: 'ops',
      password: 'a-real-password',
    });
  });

  it('asks for a second factor and sends the password again with it', async () => {
    const asked = stubFetch([
      refusal(401, 'MFA_REQUIRED', 'this account needs a second factor', { enrolled: 'true' }),
      accepted,
    ]);
    mount();

    await type('Login', 'ops');
    await type('Password', 'a-real-password');
    submit();

    await type('Authenticator code', '123456');
    submit();

    await screen.findByRole('link', { name: 'Skip to content' });
    const attempts = asked.filter((call) => call.url === LOGIN);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.body).toEqual({
      login: 'ops',
      password: 'a-real-password',
      code: '123456',
    });
  });

  it('keeps the code field, and the password behind it, when a code is refused', async () => {
    stubFetch([
      refusal(401, 'MFA_REQUIRED', 'this account needs a second factor', { enrolled: 'true' }),
      refusal(401, 'MFA_CODE_INVALID', 'that code was not accepted'),
    ]);
    mount();

    await type('Login', 'ops');
    await type('Password', 'a-real-password');
    submit();

    await type('Authenticator code', '000000');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not accepted');
    // The password box is untouched. Emptying it would make somebody retype a credential the
    // core has already told us is right.
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('a-real-password');
    // The code is cleared, because the next attempt needs a different one.
    expect(screen.getByLabelText<HTMLInputElement>('Authenticator code').value).toBe('');
  });

  it('stops asking when the account can never produce a code', async () => {
    stubFetch([
      refusal(
        401,
        'MFA_REQUIRED',
        'a group this account belongs to requires multi-factor authentication, and it has not ' +
          'been set up yet',
        { enrolled: 'false' },
      ),
    ]);
    mount();

    await type('Login', 'ops');
    await type('Password', 'a-real-password');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('administrator');
    // No field appears that this account has nothing to type into, and the button stops
    // offering an attempt that will answer the same way for ever.
    expect(screen.queryByLabelText('Authenticator code')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in' })).toHaveProperty('disabled', true);
    });
  });

  it('reports the throttle with the delay it asked for', async () => {
    stubFetch([
      refusal(429, 'AUTH_THROTTLED', 'too many failed logins from this address', {
        retryAfterSeconds: 30,
      }),
    ]);
    mount();

    await type('Login', 'ops');
    await type('Password', 'wrong');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('30 seconds');
  });
});
