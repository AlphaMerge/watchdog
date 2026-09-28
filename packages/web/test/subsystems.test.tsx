import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SessionProvider } from '../src/auth/SessionProvider';
import { EVERYTHING, offerOf, subsystemsOf } from '../src/build/subsystems';

/**
 * The UI offers what the core built, and asks it rather than guessing (`H-12`).
 *
 * A v1 build constructs no maps and no reports, and says so at `GET /build`. The failure this
 * guards against is a link or a page for a subsystem with no routes behind it — every click an
 * error — and, in the other direction, a full build losing working pages because the question
 * went unanswered.
 */

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** Answers the scripted URLs; everything else hangs, so no view resolves on its own. */
function stubFetch(replies: Record<string, Reply>): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    const reply = replies[url];
    if (reply === undefined) return new Promise<Response>(() => undefined);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
}

const SESSION = {
  '/api/v1/auth/session': {
    status: 200,
    body: {
      requireAuthentication: true,
      authenticated: true,
      principal: { userId: 1, login: 'admin', role: 'admin', mustChangePassword: false },
    },
  },
};

const build = (subsystems: Record<string, boolean>): Record<string, Reply> => ({
  '/api/v1/build': {
    status: 200,
    body: {
      version: '1.0.0-rc.1',
      commit: null,
      dirty: false,
      profile: subsystems['maps'] === true ? 'full' : 'v1',
      subsystems,
    },
  },
});

const V1 = build({ maps: false, reports: false, libraries: false });
const FULL = build({ maps: true, reports: true, libraries: true });

function mount(at = '/'): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const sections = (): HTMLElement => screen.getByRole('navigation', { name: 'Sections' });

/** Lets an answered request's render land, for assertions about what did *not* appear. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('the subsystems the core built', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers no maps or reports on a v1 build', async () => {
    const asked = stubFetch({ ...SESSION, ...V1 });
    mount();

    await screen.findByRole('link', { name: 'Skip to content' });
    await waitFor(() => {
      expect(asked).toContain('/api/v1/build');
    });
    await settle();
    expect(within(sections()).getByRole('link', { name: 'Tree' })).toBeDefined();
    expect(within(sections()).queryByRole('link', { name: 'Maps' })).toBeNull();
    expect(within(sections()).queryByRole('link', { name: 'Reports' })).toBeNull();
  });

  it('sends a bookmark to a page the build does not have home, without asking for it', async () => {
    const asked = stubFetch({ ...SESSION, ...V1 });
    mount('/maps/3');

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeDefined();
    expect(asked.some((url) => url.startsWith('/api/v1/maps'))).toBe(false);
  });

  it('offers both on a full build', async () => {
    stubFetch({ ...SESSION, ...FULL });
    mount();

    expect(await within(await screenSections()).findByRole('link', { name: 'Maps' })).toBeDefined();
    expect(within(sections()).getByRole('link', { name: 'Reports' })).toBeDefined();
  });

  it('keeps a deep link on a full build while the question is in flight', async () => {
    // The build answer never comes. Neither a redirect nor a request: the page waits.
    const asked = stubFetch({ ...SESSION });
    mount('/reports/7');

    await screen.findByRole('link', { name: 'Skip to content' });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Overview' })).toBeNull();
    expect(asked.some((url) => url.startsWith('/api/v1/reports'))).toBe(false);
    // And no link to a subsystem nobody has confirmed.
    expect(within(sections()).queryByRole('link', { name: 'Maps' })).toBeNull();
  });

  it('offers everything when the core cannot say, as this UI did before it asked', async () => {
    stubFetch({ ...SESSION, '/api/v1/build': { status: 500, body: { error: 'boom' } } });
    mount();

    expect(await within(await screenSections()).findByRole('link', { name: 'Maps' })).toBeDefined();
    expect(within(sections()).getByRole('link', { name: 'Reports' })).toBeDefined();
  });
});

/** The nav, once the layout has rendered. */
async function screenSections(): Promise<HTMLElement> {
  return screen.findByRole('navigation', { name: 'Sections' });
}

describe('reading the answer', () => {
  it('takes a page away only on an explicit false', () => {
    expect(subsystemsOf({ subsystems: { maps: false, reports: true, libraries: true } })).toEqual({
      maps: false,
      reports: true,
      libraries: true,
    });
    // A core from before `H-12` says nothing about subsystems, and had every one of them.
    expect(subsystemsOf({ version: '0.1.0', commit: null, dirty: false })).toEqual(EVERYTHING);
    expect(subsystemsOf(null)).toEqual(EVERYTHING);
    expect(subsystemsOf({ subsystems: { maps: 'no' } })).toEqual(EVERYTHING);
  });

  it('knows the difference between absent and not yet known', () => {
    expect(offerOf(undefined, 'maps')).toBe('unknown');
    expect(offerOf({ ...EVERYTHING, maps: false }, 'maps')).toBe('absent');
    expect(offerOf(EVERYTHING, 'maps')).toBe('offered');
  });
});
