import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectDetail } from '../src/api/types';
import { SessionContext, type Session, type SessionContextValue } from '../src/auth/session';
import { addressesFrom, mayExcept } from '../src/routes/detail/exception-model';
import { TargetPolicyException } from '../src/routes/detail/TargetPolicyException';
import { expectCorrelation, expectQuiet } from './support/refusal-region';

/**
 * A device's exception to its probe's target policy, on the device page (`A-79`).
 *
 * It could be set and read only through the API (`A-64`). Everyone who may read the device sees
 * the list; the editor is offered where the core would take the write: an administrator, or
 * anybody on a core with sign-in off. The core judges every entry, so what is typed is sent as it
 * is and a refusal is shown in its words.
 */

const DEVICE = {
  id: 21,
  kind: 'device',
  name: 'apipa-box',
  version: 4,
  host: '169.254.10.5',
} as unknown as ObjectDetail;

const principal = (
  role: 'admin' | 'readwrite' | 'readonly',
  requireAuthentication = true,
): Session => ({
  kind: 'signed-in',
  requireAuthentication,
  principal: { userId: 3, login: 'sam', role, mustChangePassword: false },
});
const ADMIN = principal('admin');
const WRITER = principal('readwrite');
const OPEN: Session = { kind: 'anonymous', requireAuthentication: false };

interface Call {
  method: string;
  url: string;
  body: unknown;
  ifMatch: string | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The core: each `PUT` answered by `answer`, and every call kept. */
function core(answer: (addresses: string[]) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      addresses: string[];
    };
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body,
      ifMatch: new Headers(init?.headers).get('if-match'),
    });
    return Promise.resolve(answer(body.addresses));
  });
  return calls;
}

const accepted = (addresses: string[]): Response =>
  new Response(
    JSON.stringify({
      ...DEVICE,
      version: 5,
      ...(addresses.length === 0 ? {} : { targetPolicyException: addresses }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** What the page's re-read after a save answers: the device with the list last written. */
const reread: { exception: string[] } = { exception: [] };

/** The page, as far as the card sees it: a re-read on a save, with the card kept mounted. */
function Page({ start }: { start: ObjectDetail }): React.JSX.Element {
  const [detail, setDetail] = useState(start);
  return (
    <TargetPolicyException
      detail={detail}
      onSaved={() => {
        const { targetPolicyException: _dropped, ...rest } = start;
        setDetail({
          ...rest,
          version: start.version + 1,
          ...(reread.exception.length === 0 ? {} : { targetPolicyException: reread.exception }),
        });
      }}
    />
  );
}

function show(session: Session | null, start: ObjectDetail = DEVICE): void {
  const page = <Page start={start} />;
  if (session === null) {
    render(page);
    return;
  }
  const value: SessionContextValue = {
    session,
    signedIn: () => undefined,
    signOut: () => Promise.resolve(),
    refresh: () => undefined,
    askingToSignIn: false,
    askToSignIn: () => undefined,
  };
  render(<SessionContext.Provider value={value}>{page}</SessionContext.Provider>);
}

describe('who is offered the editor (A-79)', () => {
  it('is the bar the core holds: an administrator, or anybody with sign-in off', () => {
    expect(mayExcept(ADMIN)).toBe(true);
    expect(mayExcept(OPEN)).toBe(true);
    expect(mayExcept(principal('readwrite', false))).toBe(true);
    expect(mayExcept(WRITER)).toBe(false);
    expect(mayExcept(principal('readonly'))).toBe(false);
    expect(mayExcept({ kind: 'anonymous', requireAuthentication: true })).toBe(false);
    expect(mayExcept({ kind: 'unknown' })).toBe(false);
    expect(mayExcept(undefined)).toBe(false);
  });

  it('reads one address per line, or by commas or spaces, and drops the empty', () => {
    expect(addressesFrom(' 169.254.10.5\n\nfe80::1 , 10.0.0.1\t')).toEqual([
      '169.254.10.5',
      'fe80::1',
      '10.0.0.1',
    ]);
    expect(addressesFrom('  \n ')).toEqual([]);
  });
});

describe('the device’s exception, on its page (A-79)', () => {
  it('is shown to whoever may read the device, with no editor for an account that may not change it', () => {
    show(WRITER, { ...DEVICE, targetPolicyException: ['169.254.10.5', 'fe80::1'] });
    const list = screen.getByRole('list', { name: 'Excepted addresses' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['169.254.10.5', 'fe80::1']);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Only an administrator can change it.')).toBeTruthy();
  });

  it('says there is none, and offers nothing with no session at all', () => {
    show(null);
    expect(
      screen.getByText('None. The probe’s target policy holds for every address of this device.'),
    ).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('sends an administrator’s addresses with the version it was built from, and says it was saved', async () => {
    reread.exception = ['169.254.10.5', 'fe80::1'];
    const calls = core(accepted);
    show(ADMIN);
    const status = screen.getByRole('status');
    expectQuiet(status, ['mt-2', 'empty:mt-0'], 'polite');
    expectQuiet(screen.getByRole('alert'), ['mt-2', 'empty:mt-0']);
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save exception' });
    expect(save.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Clear exception' })).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Excepted addresses' }), {
      target: { value: '169.254.10.5\nfe80::1\n' },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => {
      expect(status.textContent).toBe(
        'Saved. The probe picks the change up on its next configuration push; no restart is ' +
          'needed.',
      );
    });
    expect(calls).toEqual([
      {
        method: 'PUT',
        url: '/api/v1/objects/21/target-policy-exception',
        body: { addresses: ['169.254.10.5', 'fe80::1'] },
        ifMatch: 'W/"4"',
      },
    ]);
    // The page re-read the device: the list is the saved one, and nothing is left to save.
    expect(
      within(screen.getByRole('list', { name: 'Excepted addresses' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['169.254.10.5', 'fe80::1']);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save exception' }).disabled).toBe(
      true,
    );
  });

  it('clears it with an empty list, on a core with sign-in off', async () => {
    reread.exception = [];
    const calls = core(accepted);
    show(OPEN, { ...DEVICE, targetPolicyException: ['169.254.10.5'] });
    fireEvent.click(screen.getByRole('button', { name: 'Clear exception' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/^Cleared\. /u);
    });
    expect(calls.map((call) => call.body)).toEqual([{ addresses: [] }]);
    expect(
      screen.getByText('None. The probe’s target policy holds for every address of this device.'),
    ).toBeTruthy();
  });

  it('shows the core’s refusal in its words, with its correlation id', async () => {
    core(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'OBJECT_INVALID',
              message:
                '“169.254.169.254” cannot be excepted from the target policy: it is a cloud ' +
                'instance-metadata service, which no exception reaches',
              correlationId: 'req-79',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    show(ADMIN);
    fireEvent.change(screen.getByRole('textbox', { name: 'Excepted addresses' }), {
      target: { value: '169.254.169.254' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save exception' }));
    const alert = screen.getByRole('alert');
    await waitFor(() => {
      expect(alert.textContent).toContain('which no exception reaches');
    });
    expectCorrelation(alert, 'req-79');
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
