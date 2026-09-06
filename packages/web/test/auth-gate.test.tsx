import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SessionProvider } from '../src/auth/SessionProvider';
import { onSessionLost, request, send } from '../src/api/client';

/**
 * What stands in front of the application, and when (`U-17`).
 *
 * **The claim under test is that "nobody is logged in" and "a login is needed" are two facts.**
 * An installation running with `api.requireAuthentication` off serves an anonymous caller
 * perfectly well, and a UI that collapsed the two would put a login form in front of an operator
 * the core is happy to answer — which is the same mistake in the opposite direction from the one
 * this ticket exists to fix.
 */

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** Answers `/auth/session` from the script; everything else hangs, so no view resolves. */
function stubFetch(replies: Record<string, Reply>): { url: string; body: unknown }[] {
  const asked: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', (url: string, init?: { body?: string }) => {
    asked.push({
      url,
      body: init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    });
    const reply = replies[url];
    // A route with no script never answers. The application's own views are not what these
    // cases are about, and letting them resolve would make every one of them assert a fixture.
    if (reply === undefined) return new Promise<Response>(() => undefined);
    return Promise.resolve(
      new Response(reply.status === 204 ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
}

const SESSION = '/api/v1/auth/session';

const anonymous = (requireAuthentication: boolean): Reply => ({
  status: 200,
  body: { requireAuthentication, authenticated: false },
});

const signedIn = (mustChangePassword = false): Reply => ({
  status: 200,
  body: {
    requireAuthentication: true,
    authenticated: true,
    principal: { userId: 1, login: 'admin', role: 'admin', mustChangePassword },
  },
});

function mount(at = '/'): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('the login gate', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the core who this browser is before rendering anything', async () => {
    const asked = stubFetch({ [SESSION]: anonymous(true) });
    mount();

    await screen.findByRole('heading', { name: 'Log in' });
    expect(asked.map((call) => call.url)).toContain(SESSION);
  });

  it('shows the login form when the core requires one', async () => {
    stubFetch({ [SESSION]: anonymous(true) });
    mount();

    await screen.findByRole('heading', { name: 'Log in' });
    expect(screen.getByLabelText('Login')).toBeDefined();
    expect(screen.getByLabelText('Password')).toBeDefined();
    // No second factor has been asked for yet, so no field to type one into.
    expect(screen.queryByLabelText('Authenticator code')).toBeNull();
  });

  it('does not demand a login the core does not want', async () => {
    stubFetch({ [SESSION]: anonymous(false) });
    mount();

    // The application, not a form: the header's skip link is the first thing `Layout` renders.
    await screen.findByRole('link', { name: 'Skip to content' });
    expect(screen.queryByRole('heading', { name: 'Log in' })).toBeNull();
  });

  it('offers an optional login anyway, so an anonymous operator can be named in the audit log', async () => {
    stubFetch({ [SESSION]: anonymous(false) });
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }));

    await screen.findByRole('heading', { name: 'Log in' });
    // And it is escapable, because nothing is making them do it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('link', { name: 'Skip to content' });
  });

  it('forces the password change the core only reports', async () => {
    // Nothing on the core refuses a request because `mustChangePassword` is set — it is a flag
    // on a principal and no more. If the client does not act on it, the generated password in
    // `first-admin-password` stays live for as long as the installation does.
    stubFetch({ [SESSION]: signedIn(true) });
    mount();

    await screen.findByRole('heading', { name: 'Change your password' });
    expect(screen.queryByRole('link', { name: 'Skip to content' })).toBeNull();
  });

  it('renders the application for a signed-in operator who chose their own password', async () => {
    stubFetch({ [SESSION]: signedIn(false) });
    mount();

    await screen.findByRole('link', { name: 'Skip to content' });
    expect(screen.getByRole('button', { name: 'Log out' })).toBeDefined();
    // The role sits beside the login: most of what this UI refuses, it refuses by role.
    expect(screen.getByRole('link', { name: /admin \(admin\)/ })).toBeDefined();
  });

  it('says the core is unreachable rather than asking for a password it cannot check', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connection refused')));
    mount();

    await screen.findByRole('heading', { name: 'Cannot reach the core' });
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('offers a retry from the unreachable screen, which is its only exit', async () => {
    // The probe runs once. A core that was restarting when the tab opened would otherwise leave
    // the operator on an error page until they thought to reload by hand.
    let attempt = 0;
    vi.stubGlobal('fetch', (url: string) => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('connection refused'));
      if (url === SESSION) {
        return Promise.resolve(
          new Response(JSON.stringify({ requireAuthentication: true, authenticated: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return new Promise<Response>(() => undefined);
    });
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    await screen.findByRole('heading', { name: 'Log in' });
  });

  it('does not route an anonymous browser to a form the core will always refuse', async () => {
    // `POST /auth/password` needs a principal whatever `api.requireAuthentication` says, so with
    // the guard off the change-password page is reachable and cannot ever succeed.
    stubFetch({ [SESSION]: anonymous(false) });
    mount('/password');

    await screen.findByRole('link', { name: 'Skip to content' });
    expect(screen.queryByLabelText('Current password')).toBeNull();
  });
});

describe('a session that goes away underneath the operator', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts the login form up when an ordinary request answers AUTH_REQUIRED', async () => {
    stubFetch({
      [SESSION]: signedIn(false),
      '/api/v1/objects/1': {
        status: 401,
        body: { error: { code: 'AUTH_REQUIRED', message: 'log in first' } },
      },
    });
    mount();
    await screen.findByRole('link', { name: 'Skip to content' });

    await act(async () => {
      await request('/objects/1').catch(() => undefined);
    });

    await screen.findByRole('heading', { name: 'Log in' });
  });

  it('ends the session at the core when the operator logs out, not only here', async () => {
    const asked = stubFetch({
      [SESSION]: signedIn(false),
      '/api/v1/auth/logout': { status: 204, body: null },
    });
    mount();
    await screen.findByRole('link', { name: 'Skip to content' });

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    // A client that forgot the principal without telling the core would leave the session live
    // until it expired — usable by anybody holding the cookie.
    await screen.findByRole('heading', { name: 'Log in' });
    expect(asked.map((call) => call.url)).toContain('/api/v1/auth/logout');
  });

  it('leaves an anonymous browser alone, because it never had a session to lose', async () => {
    // A route about the caller's own account answers AUTH_REQUIRED even with
    // `api.requireAuthentication` off. Treating that as an expiry would put a login form in
    // front of somebody who never had one and does not need one.
    stubFetch({
      [SESSION]: anonymous(false),
      '/api/v1/auth/mfa': {
        status: 401,
        body: { error: { code: 'AUTH_REQUIRED', message: 'log in first' } },
      },
    });
    mount();
    await screen.findByRole('link', { name: 'Skip to content' });

    await act(async () => {
      await request('/auth/mfa').catch(() => undefined);
    });

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Log in' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeDefined();
  });
});

/**
 * The interceptor's own contract, below the provider.
 *
 * Tested here rather than through the application because the application cannot distinguish
 * the two guards that overlap in it: the login form is only ever shown to a browser that is
 * already anonymous, so a listener that fired on every 401 would be swallowed by the provider's
 * "only from signed-in" rule and look correct. The rule this file is about is the client's —
 * `AUTH_REQUIRED` and nothing else — and it has to be asserted where it lives.
 */
describe('what counts as a lost session', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    onSessionLost(undefined);
  });

  const answering = (code: string, status: number): void => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code, message: 'no' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  };

  it('reports AUTH_REQUIRED, whichever verb met it', async () => {
    let lost = 0;
    onSessionLost(() => {
      lost += 1;
    });

    answering('AUTH_REQUIRED', 401);
    await request('/objects/root').catch(() => undefined);
    await send('POST', '/objects/root/pause').catch(() => undefined);

    expect(lost).toBe(2);
  });

  it('says nothing about the three ways a login itself answers 401', async () => {
    // A password that was not accepted, a second factor the account needs, a code that was
    // wrong. Every one of those is the login form doing its job, and routing them through the
    // session listener would clear the form somebody is part-way through filling in.
    for (const code of ['AUTH_REJECTED', 'MFA_REQUIRED', 'MFA_CODE_INVALID']) {
      let lost = 0;
      onSessionLost(() => {
        lost += 1;
      });
      answering(code, 401);
      await send('POST', '/auth/login', { login: 'ops', password: 'x' }).catch(() => undefined);
      expect(lost, code).toBe(0);
    }
  });
});
