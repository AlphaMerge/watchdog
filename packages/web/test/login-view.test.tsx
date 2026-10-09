import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SessionProvider } from '../src/auth/SessionProvider';
import { SAY_AGAIN_MS } from '../src/components/refusal';
import { alertSaying, expectQuiet } from './support/refusal-region';

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

/**
 * A refusal in the shape the core actually emits.
 *
 * **`context`, not `details`.** `toHttpError` gives an `AuthError`'s values to the envelope's
 * `context` and leaves `details` at `{}`. The first version of this helper put them in `details`
 * — the shape the client happened to read — so all four MFA and throttle cases below passed
 * against a body no server produces, and went on passing with the client reading a key that was
 * never there. `packages/core/test/auth-api.test.ts` pins the real shape, because nothing in
 * this package can see it.
 */
const refusal = (status: number, code: string, message: string, context = {}): Reply => ({
  status,
  body: { error: { code, message, context, details: {} } },
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

    await alertSaying('not accepted');
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

    await alertSaying('administrator');
    // No field appears that this account has nothing to type into, and the button stops
    // offering an attempt that will answer the same way for ever.
    expect(screen.queryByLabelText('Authenticator code')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in' })).toHaveProperty('disabled', true);
    });
  });

  it('lets the operator try another account after a refusal that cannot succeed', async () => {
    // `stuck` disables the only submit control, and a disabled default button swallows Enter
    // too. If it outlived the account it was about, the form would be dead for every other
    // account until the page was reloaded.
    stubFetch([
      refusal(
        401,
        'MFA_REQUIRED',
        'a group this account belongs to requires multi-factor authentication, and it has not ' +
          'been set up yet',
        { enrolled: 'false' },
      ),
      accepted,
    ]);
    mount();

    await type('Login', 'locked-out');
    await type('Password', 'a-real-password');
    submit();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in' })).toHaveProperty('disabled', true);
    });

    await type('Login', 'ops');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in' })).toHaveProperty('disabled', false);
    });

    submit();
    await screen.findByRole('link', { name: 'Skip to content' });
  });

  it('does not spend a request on an empty form, or show Ajv the operator', async () => {
    // Both fields are minLength: 1 in the route's body schema, so this would be a 400 whose
    // message is a JSON Pointer.
    const asked = stubFetch([]);
    mount();

    await screen.findByLabelText('Login');
    submit();

    await alertSaying('Type a login and a password');
    expect(asked.some((call) => call.url === LOGIN)).toBe(false);
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

    await alertSaying('30 seconds');
  });
});

/**
 * The refusal, announced (`U-54`): in the tree and empty before anything is sent, the refusal in
 * that same node, emptied as the next attempt starts or a field is edited, and said again when it
 * is the same words — after a round trip from the core, or a moment after the form decides it.
 */
describe('a refused login (U-54)', () => {
  const REJECTED = 'that login and password were not accepted';

  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is there empty before, says the refusal in the same node, and empties on an edit', async () => {
    stubFetch([refusal(401, 'AUTH_REJECTED', REJECTED)]);
    mount();
    await screen.findByLabelText('Login');

    const region = screen.getByRole('alert');
    expectQuiet(region, ['mt-3', 'empty:mt-0']);

    await type('Login', 'ops');
    await type('Password', 'wrong');
    submit();
    expect(await alertSaying(REJECTED)).toBe(region);
    expect(region.textContent).toBe(REJECTED);

    await type('Password', 'right');
    expect(region.matches(':empty')).toBe(true);
    expect(screen.getByRole('alert')).toBe(region);
  });

  it('empties as an attempt starts, so a second refusal in the same words is said again', async () => {
    stubFetch([refusal(401, 'AUTH_REJECTED', REJECTED), refusal(401, 'AUTH_REJECTED', REJECTED)]);
    mount();
    await type('Login', 'ops');
    await type('Password', 'wrong');
    const region = screen.getByRole('alert');
    submit();
    await waitFor(() => {
      expect(region.textContent).toBe(REJECTED);
    });

    submit();
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(REJECTED);
    });
    expect(screen.getByRole('alert')).toBe(region);
  });

  it('says an empty form again, emptied first and filled a moment later', async () => {
    stubFetch([]);
    mount();
    await screen.findByLabelText('Login');
    const region = screen.getByRole('alert');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      submit();
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS);
      });
      expect(region.textContent).toBe('Type a login and a password.');

      // The same refusal again: emptied as the button is pressed, and only then filled.
      submit();
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS - 1);
      });
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(region.textContent).toBe('Type a login and a password.');
      expect(screen.getByRole('alert')).toBe(region);

      // An edit before it is said drops it: nothing is said about what was there before.
      submit();
      fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'ops' } });
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS);
      });
      expect(region.matches(':empty')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
