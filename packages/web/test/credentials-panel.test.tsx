import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelRecord,
  CredentialKindSummary,
  CredentialRemoval,
  CredentialView,
  CredentialWrite,
  ObjectRef,
  UnboundedCredential,
} from '../src/api/types';
import { SessionContext, type Session, type SessionContextValue } from '../src/auth/session';
import { ChannelTable } from '../src/routes/detail/ChannelTable';
import { CredentialsPanel } from '../src/routes/detail/CredentialsPanel';
import { OUTSIDE_MEANS } from '../src/routes/detail/credentials-model';
import { UnboundedCredentialsView } from '../src/routes/UnboundedCredentialsView';

/**
 * The Credentials tab, rendered (`U-21`).
 *
 * `credentials-model.test.ts` proves the sentences and the judgements; these prove the tab acts on
 * them — what it sends, in what order, and what it shows of what came back. The order is the
 * point of half of them: a save is previewed before it is made, a removal is asked about before
 * it is confirmed, and nothing is written until somebody says so.
 */

const SECRET = 'a-very-distinctive-community';

const KINDS: CredentialKindSummary[] = [
  {
    id: 'snmp',
    name: 'SNMP',
    description: 'Used by every SNMP sensor on this object and everything below it.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { enum: ['v1', 'v2c', 'v3'], default: 'v2c', title: 'SNMP version' },
        community: { type: 'string', maxLength: 255, writeOnly: true, title: 'Community string' },
        allowedTargets: {
          type: 'array',
          maxItems: 64,
          items: { type: 'string', minLength: 1, maxLength: 255 },
          title: 'Allowed targets',
        },
      },
    },
  },
  {
    id: 'ssh',
    name: 'SSH',
    description: 'Used by every SSH sensor on this object and everything below it.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        username: { type: 'string', maxLength: 255, title: 'User name' },
        password: { type: 'string', maxLength: 1024, writeOnly: true, title: 'Password' },
        privateKey: { type: 'string', maxLength: 32768, writeOnly: true, title: 'Private key' },
        hostKeys: {
          type: 'array',
          maxItems: 64,
          items: { type: 'string', minLength: 1, maxLength: 128 },
          title: 'Host keys',
        },
      },
    },
  },
];

const GROUP = { id: 20, name: 'Rack A', kind: 'group' };
/** The breadcrumb as the core trims it: the probe is visible, the root (#1) is not. */
const ANCESTORS: ObjectRef[] = [{ id: 10, kind: 'probe', name: 'Local probe' }];

const OWN_SNMP: CredentialView = {
  kind: 'snmp',
  publicParams: { version: 'v2c', allowedTargets: ['10.0.0.0/24'] },
  source: { kind: 'own', objectId: 20 },
  updatedAt: '2026-09-30T08:00:00.000Z',
  bounded: true,
  secretsSet: ['community'],
};
const INHERITED_SSH: CredentialView = {
  kind: 'ssh',
  publicParams: { username: 'monitor' },
  source: { kind: 'inherited', objectId: 10, depth: 1 },
  updatedAt: '2026-09-29T08:00:00.000Z',
  bounded: false,
};

/** Stored here with a private key, and bounded by the host key it lists. */
const OWN_SSH: CredentialView = {
  kind: 'ssh',
  publicParams: { username: 'monitor', hostKeys: ['SHA256:abc'] },
  source: { kind: 'own', objectId: 20 },
  updatedAt: '2026-09-29T08:00:00.000Z',
  bounded: true,
  secretsSet: ['privateKey'],
};

const written = (over: Partial<CredentialWrite> = {}): CredentialWrite => ({
  ...OWN_SNMP,
  withholds: 0,
  withheldBefore: 0,
  newlyWithheld: 0,
  noLongerWithheld: 0,
  secretsCleared: [],
  ...over,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Stub {
  sets?: CredentialView[];
  kinds?: CredentialKindSummary[];
  /** What `GET …/access/effective` answers; a number is a refusal with that status. */
  right?: 'none' | 'read' | 'write' | 'full' | number;
  preview?: CredentialWrite | Refused;
  write?: CredentialWrite | Refused;
  removalPreview?: CredentialRemoval | Refused;
  removal?: CredentialRemoval | Refused;
  unbounded?: UnboundedCredential[];
  /**
   * What each read of the object's sets answers, by its number from 1. In place of `sets`, for a
   * list that changes after a save, fails to be read again, or takes its time.
   */
  listing?: (read: number) => CredentialView[] | Refused | Promise<CredentialView[]>;
}

interface Refused {
  status: number;
  body: unknown;
}

const REFUSED: Refused = {
  status: 403,
  body: { error: { code: 'AUTH_FORBIDDEN', message: 'needs write on that probe' } },
};
const UNREADABLE: Refused = {
  status: 500,
  body: { error: { code: 'INTERNAL', message: 'the database went away' } },
};

function stubApi(stub: Stub): { calls: Call[] } {
  const calls: Call[] = [];
  let reads = 0;
  const reply = (status: number, data: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const staged = (answer: unknown): Promise<Response> =>
    typeof answer === 'object' && answer !== null && 'status' in answer && 'body' in answer
      ? reply((answer as { status: number }).status, (answer as { body: unknown }).body)
      : reply(200, answer);

  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path, body });
    const dry = path.endsWith('?dryRun=true');
    if (method === 'PUT') return staged(dry ? (stub.preview ?? written()) : stub.write);
    if (method === 'DELETE') return staged(dry ? stub.removalPreview : stub.removal);
    if (path.endsWith('/credentials/unbounded')) return reply(200, { items: stub.unbounded });
    if (path.endsWith('/credential-kinds')) return reply(200, { items: stub.kinds ?? KINDS });
    if (path.endsWith('/access/effective')) {
      return typeof stub.right === 'number'
        ? reply(stub.right, { error: { code: 'AUTH_FORBIDDEN', message: 'refused' } })
        : reply(200, { right: stub.right ?? 'write', inherited: false, viaAdminGroup: false });
    }
    if (path.endsWith('/objects/20/credentials')) {
      if (stub.listing === undefined) return reply(200, { items: stub.sets ?? [] });
      reads += 1;
      return Promise.resolve(stub.listing(reads)).then((answer) =>
        Array.isArray(answer) ? reply(200, { items: answer }) : staged(answer),
      );
    }
    throw new Error(`no stub for ${method} ${path}`);
  });
  return { calls };
}

const OPEN: Session = { kind: 'anonymous', requireAuthentication: false };
const SIGNED_IN: Session = {
  kind: 'signed-in',
  requireAuthentication: true,
  principal: { userId: 7, login: 'pat', role: 'readwrite', mustChangePassword: false },
};

function inSession(session: Session, children: React.ReactNode): React.JSX.Element {
  const value: SessionContextValue = {
    session,
    signedIn: () => undefined,
    signOut: () => Promise.resolve(),
    refresh: () => undefined,
    askingToSignIn: false,
    askToSignIn: () => undefined,
  };
  return (
    <SessionContext.Provider value={value}>
      <MemoryRouter>{children}</MemoryRouter>
    </SessionContext.Provider>
  );
}

async function show(stub: Stub, session: Session = OPEN): Promise<{ calls: Call[] }> {
  const api = stubApi(stub);
  render(inSession(session, <CredentialsPanel object={GROUP} ancestors={ANCESTORS} />));
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Credential sets' })).toBeDefined();
  });
  return api;
}

const writes = (calls: Call[]): Call[] => calls.filter((call) => call.method !== 'GET');
const row = (name: string): HTMLElement => {
  const heading = screen.getByRole('heading', { name, level: 3 });
  const item = heading.closest('li');
  if (item === null) throw new Error(`no row for ${name}`);
  return item;
};

/** Opens the SNMP set's form, stored with a community. */
async function editSnmp(stub: Stub = {}): Promise<{ calls: Call[]; form: HTMLElement }> {
  const api = await show({ sets: [OWN_SNMP], ...stub });
  fireEvent.click(within(row('SNMP')).getByRole('button', { name: 'Edit SNMP credentials' }));
  return { ...api, form: screen.getByRole('form', { name: 'Editing SNMP credentials' }) };
}

describe('the credentials tab', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('what it lists', () => {
    it('shows the set stored here and the ones inherited, each with its kind, its public fields and its owner', async () => {
      await show({ sets: [OWN_SNMP, INHERITED_SSH] });

      const snmp = within(row('SNMP'));
      expect(snmp.getByText('stored here')).toBeDefined();
      expect(snmp.getByText('SNMP version')).toBeDefined();
      expect(snmp.getByText('v2c')).toBeDefined();
      expect(snmp.getByText('Allowed targets')).toBeDefined();
      expect(snmp.getByText('10.0.0.0/24')).toBeDefined();
      // Which secrets it holds, by the name its form gives them. Never a value.
      expect(snmp.getByText('Stored and never shown: Community string.')).toBeDefined();

      const ssh = within(row('SSH'));
      const owner = ssh.getByRole('link', { name: 'inherited from Local probe' });
      expect(owner.getAttribute('href')).toBe('/objects/10?tab=credentials');
      expect(ssh.getByText('monitor')).toBeDefined();
      // An inherited set is changed where it is stored, so it has no controls here.
      expect(ssh.queryByRole('button', { name: /Edit|Remove/u })).toBeNull();
    });

    it('says a set comes from outside the reader’s view, without a name, a link or an id', async () => {
      await show({
        sets: [{ ...INHERITED_SSH, source: { kind: 'inherited', objectId: 1, depth: 2 } }],
      });
      const ssh = within(row('SSH'));
      expect(ssh.getByText('inherited from an object outside your view')).toBeDefined();
      expect(ssh.queryByRole('link', { name: /inherited from/u })).toBeNull();
      expect(row('SSH').innerHTML.includes('/objects/1')).toBe(false);
      expect(ssh.getByText(/write on an object outside your view is trust with it/u)).toBeDefined();
    });

    it('never renders a public parameter its kind marks write-only, whatever the read holds', async () => {
      await show({
        sets: [{ ...OWN_SNMP, publicParams: { version: 'v2c', community: SECRET } }],
      });
      expect(document.body.innerHTML.includes(SECRET)).toBe(false);
    });

    it('says so when nothing is in force, and offers to store a set', async () => {
      await show({ sets: [] });
      expect(screen.getByText('No credential sets are in force here.')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Add SNMP credentials' })).toBeDefined();
    });

    it('offers nothing to store on a core with no vault', async () => {
      await show({ sets: [], kinds: [] });
      expect(
        screen.getByText('This core has no credential vault, so no set can be stored.'),
      ).toBeDefined();
      expect(screen.queryByRole('button', { name: /^Add/u })).toBeNull();
    });
  });

  describe('a set with no bounds', () => {
    it('is flagged in words, with whose write is trust with it and the list of the others', async () => {
      await show({ sets: [OWN_SNMP, INHERITED_SSH] });

      const ssh = within(row('SSH'));
      expect(ssh.getByText('No bounds')).toBeDefined();
      expect(
        ssh.getByText(
          /This set has no allowed targets and lists no host keys, so write on Local probe is trust with it/u,
        ),
      ).toBeDefined();
      expect(ssh.getByRole('link', { name: 'Every set without bounds' }).getAttribute('href')).toBe(
        '/credentials/unbounded',
      );

      // The bounded one says that instead, and carries neither the flag nor the sentence.
      const snmp = within(row('SNMP'));
      expect(snmp.getByText('Bounded')).toBeDefined();
      expect(snmp.queryByText('No bounds')).toBeNull();
      expect(snmp.queryByText(/is trust with it/u)).toBeNull();
    });

    it('names this object when the unbounded set is stored here', async () => {
      await show({ sets: [{ ...OWN_SNMP, bounded: false, publicParams: { version: 'v2c' } }] });
      expect(
        within(row('SNMP')).getByText(
          /This set has no allowed targets, so write on Rack A is trust with it/u,
        ),
      ).toBeDefined();
    });
  });

  describe('a reader without write', () => {
    it('sees the sets and no control that changes one', async () => {
      const api = await show({ sets: [OWN_SNMP, INHERITED_SSH], right: 'read' }, SIGNED_IN);
      await waitFor(() => {
        expect(api.calls.some((call) => call.path.endsWith('/objects/20/access/effective'))).toBe(
          true,
        );
      });
      expect(within(row('SNMP')).getByText('10.0.0.0/24')).toBeDefined();
      expect(
        await screen.findByText(
          'You can read these sets. Changing them needs write on this group.',
        ),
      ).toBeDefined();
      expect(screen.queryByRole('button', { name: /Edit|Remove|Add/u })).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
    });

    it('is offered the controls once the core says it may write', async () => {
      await show({ sets: [OWN_SNMP], right: 'write' }, SIGNED_IN);
      // Nothing is said about reading only while the answer is still on its way.
      expect(screen.queryByText(/You can read these sets/u)).toBeNull();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Edit SNMP credentials' })).toBeDefined();
      });
      expect(screen.queryByText(/You can read these sets/u)).toBeNull();
    });

    it('stays read-only when the core will not say', async () => {
      const api = await show({ sets: [OWN_SNMP], right: 500 }, SIGNED_IN);
      expect(await screen.findByText(/You can read these sets/u)).toBeDefined();
      expect(api.calls.some((call) => call.path.endsWith('/access/effective'))).toBe(true);
      expect(screen.queryByRole('button', { name: /Edit|Remove|Add/u })).toBeNull();
    });

    it('is not asked about at all where the core holds nobody to grants', async () => {
      const api = await show({ sets: [OWN_SNMP] }, OPEN);
      expect(screen.getByRole('button', { name: 'Edit SNMP credentials' })).toBeDefined();
      expect(api.calls.some((call) => call.path.endsWith('/access/effective'))).toBe(false);
    });
  });

  describe('a secret in the form', () => {
    it('is kept by a save that leaves it alone: the request does not carry the field', async () => {
      const { calls, form } = await editSnmp({ write: written() });
      // Shown as set, with no box holding anything.
      expect(within(form).getByText('set, write-only')).toBeDefined();
      expect(form.querySelector('input[type="password"]')).toBeNull();

      fireEvent.change(within(form).getByLabelText('SNMP version'), { target: { value: 'v1' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => {
        expect(writes(calls)).toHaveLength(2);
      });
      for (const call of writes(calls)) {
        expect(call.body).toEqual({ values: { version: 'v1', allowedTargets: ['10.0.0.0/24'] } });
      }
    });

    it('is replaced by a value typed after Replace, sent in the body and never in the address', async () => {
      const { calls, form } = await editSnmp({ write: written() });
      fireEvent.click(within(form).getByRole('button', { name: 'Replace' }));
      const box = within(form).getByLabelText('Community string');
      expect(box.getAttribute('type')).toBe('password');
      fireEvent.change(box, { target: { value: SECRET } });
      expect(within(form).getByText('On save: Community string will be replaced.')).toBeDefined();

      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => {
        expect(writes(calls)).toHaveLength(2);
      });
      const [preview, real] = writes(calls);
      expect((real?.body as { values: Record<string, unknown> }).values['community']).toBe(SECRET);
      expect(preview?.body).toEqual(real?.body);
      expect(calls.some((call) => call.path.includes(SECRET))).toBe(false);
      // And once saved it is on screen nowhere.
      await waitFor(() => {
        expect(screen.queryByRole('form')).toBeNull();
      });
      expect(document.body.innerHTML.includes(SECRET)).toBe(false);
    });

    it('goes back to kept when Replace is abandoned', async () => {
      const { calls, form } = await editSnmp({ write: written() });
      fireEvent.click(within(form).getByRole('button', { name: 'Replace' }));
      fireEvent.change(within(form).getByLabelText('Community string'), {
        target: { value: SECRET },
      });
      fireEvent.click(within(form).getByRole('button', { name: 'Keep the current one' }));
      expect(within(form).queryByText(/On save/u)).toBeNull();

      fireEvent.change(within(form).getByLabelText('SNMP version'), { target: { value: 'v1' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => {
        expect(writes(calls)).toHaveLength(2);
      });
      expect('community' in (writes(calls)[1]?.body as { values: object }).values).toBe(false);
    });

    it('is cleared by Clear: the request carries null, which is the unset', async () => {
      const { calls, form } = await editSnmp({ write: written() });
      fireEvent.click(within(form).getByRole('button', { name: 'Clear' }));
      expect(within(form).getByText('On save: Community string will be removed.')).toBeDefined();

      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => {
        expect(writes(calls)).toHaveLength(2);
      });
      expect(writes(calls)[1]?.body).toEqual({
        values: { version: 'v2c', allowedTargets: ['10.0.0.0/24'], community: null },
      });
    });

    it('has nothing to save until something changes', async () => {
      const { form } = await editSnmp();
      const save = within(form).getByRole('button', { name: 'Save changes' });
      expect((save as HTMLButtonElement).disabled).toBe(true);
      expect(within(form).getByText('Nothing has changed yet.')).toBeDefined();
    });

    it('keeps the line breaks of a private key, in a box that holds more than a line', async () => {
      const api = await show({ sets: [], write: written({ kind: 'ssh' }) });
      fireEvent.change(screen.getByLabelText('Store a set here'), { target: { value: 'ssh' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add SSH credentials' }));
      const form = screen.getByRole('form', { name: 'New SSH credentials' });

      const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';
      const box = within(form).getByLabelText('Private key');
      expect(box.tagName).toBe('TEXTAREA');
      fireEvent.change(box, { target: { value: key } });
      // A password stays a single masked line.
      expect(within(form).getByLabelText('Password').getAttribute('type')).toBe('password');

      fireEvent.click(within(form).getByRole('button', { name: 'Store SSH credentials' }));
      await waitFor(() => {
        expect(writes(api.calls)).toHaveLength(2);
      });
      const real = writes(api.calls)[1];
      expect(real?.path.endsWith('/objects/20/credentials/ssh')).toBe(true);
      expect((real?.body as { values: Record<string, unknown> }).values['privateKey']).toBe(key);
    });

    it('never fills that box from what is stored, and takes what was typed with it on a save', async () => {
      const key =
        '-----BEGIN OPENSSH PRIVATE KEY-----\ntyped-just-now\n-----END OPENSSH PRIVATE KEY-----\n';
      const api = await show({ sets: [OWN_SSH], write: written({ ...OWN_SSH }) });
      fireEvent.click(within(row('SSH')).getByRole('button', { name: 'Edit SSH credentials' }));
      const form = screen.getByRole('form', { name: 'Editing SSH credentials' });

      // A stored key is a sentence saying one is stored: there is no box to hold it.
      expect(form.querySelector('textarea')).toBeNull();
      expect(within(form).getByText('set, write-only')).toBeDefined();

      // Asked to replace it, the box opens empty.
      fireEvent.click(within(form).getByRole('button', { name: 'Replace' }));
      const box = within(form).getByLabelText<HTMLTextAreaElement>('Private key');
      expect(box.tagName).toBe('TEXTAREA');
      expect(box.value).toBe('');
      fireEvent.change(box, { target: { value: key } });

      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => {
        expect(writes(api.calls)).toHaveLength(2);
      });
      // Saved: the form is gone, and what was typed is in the document nowhere.
      await waitFor(() => {
        expect(screen.queryByRole('form')).toBeNull();
      });
      expect(document.querySelector('textarea')).toBeNull();
      expect(document.body.innerHTML.includes('typed-just-now')).toBe(false);
      expect(api.calls.some((call) => call.path.includes('typed-just-now'))).toBe(false);

      // And a form opened again starts from nothing typed.
      await waitFor(() => {
        expect(
          within(row('SSH')).getByRole<HTMLButtonElement>('button', {
            name: 'Edit SSH credentials',
          }).disabled,
        ).toBe(false);
      });
      fireEvent.click(within(row('SSH')).getByRole('button', { name: 'Edit SSH credentials' }));
      const again = screen.getByRole('form', { name: 'Editing SSH credentials' });
      expect(again.querySelector('textarea')).toBeNull();
      fireEvent.click(within(again).getByRole('button', { name: 'Replace' }));
      expect(within(again).getByLabelText<HTMLTextAreaElement>('Private key').value).toBe('');
    });

    it('takes what was typed with it when the tab is left', async () => {
      const api = stubApi({ sets: [OWN_SSH] });
      const view = render(
        inSession(OPEN, <CredentialsPanel object={GROUP} ancestors={ANCESTORS} />),
      );
      await screen.findByRole('heading', { name: 'Credential sets' });
      fireEvent.click(within(row('SSH')).getByRole('button', { name: 'Edit SSH credentials' }));
      const form = screen.getByRole('form', { name: 'Editing SSH credentials' });
      fireEvent.click(within(form).getByRole('button', { name: 'Replace' }));
      fireEvent.change(within(form).getByLabelText('Private key'), {
        target: { value: 'typed-and-abandoned' },
      });

      // Another tab is another panel: this one is unmounted, as `ObjectDetailView` does it.
      view.unmount();
      render(inSession(OPEN, <CredentialsPanel object={GROUP} ancestors={ANCESTORS} />));
      await screen.findByRole('heading', { name: 'Credential sets' });
      expect(screen.queryByRole('form')).toBeNull();
      expect(document.body.innerHTML.includes('typed-and-abandoned')).toBe(false);
      fireEvent.click(within(row('SSH')).getByRole('button', { name: 'Edit SSH credentials' }));
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
      expect(screen.getByLabelText<HTMLTextAreaElement>('Private key').value).toBe('');
      expect(writes(api.calls)).toEqual([]);
    });
  });

  describe('a save', () => {
    /** Narrows the set to one more target, which is what the staged preview answers about. */
    const narrow = (form: HTMLElement): void => {
      fireEvent.click(within(form).getByRole('button', { name: 'Add allowed targets' }));
      fireEvent.change(within(form).getByLabelText('Allowed targets 2'), {
        target: { value: '10.9.0.0/16' },
      });
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    };

    it('says how many sensors it takes to Unknown before anything is written, and writes on confirmation', async () => {
      const { calls, form } = await editSnmp({
        preview: written({ withholds: 6, newlyWithheld: 6 }),
        write: written({ withholds: 6, newlyWithheld: 6 }),
      });
      narrow(form);

      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      expect(
        within(confirm).getByText(
          "This save puts 6 sensors beneath Rack A outside this set's bounds. They are not sent the set after it and read Unknown until the bounds include them.",
        ),
      ).toBeDefined();
      // And what "outside" covers, the named device included, where the decision is made.
      expect(within(confirm).getByText(OUTSIDE_MEANS)).toBeDefined();
      // Asked, and not yet done: one request, and it is the preview.
      expect(writes(calls).map((call) => call.path)).toEqual([
        '/api/v1/objects/20/credentials/snmp?dryRun=true',
      ]);
      // The fields are held as they were previewed.
      expect(within(form).getByLabelText<HTMLSelectElement>('SNMP version').disabled).toBe(true);
      // Waited for: the group is in the document a moment before the effect that focuses it.
      await waitFor(() => {
        expect(document.activeElement).toBe(confirm);
      });

      fireEvent.click(within(confirm).getByRole('button', { name: 'Save anyway' }));
      await waitFor(() => {
        expect(writes(calls)).toHaveLength(2);
      });
      const [preview, real] = writes(calls);
      expect(real?.method).toBe('PUT');
      expect(real?.path).toBe('/api/v1/objects/20/credentials/snmp');
      expect(real?.body).toEqual(preview?.body);
      expect(real?.body).toEqual({
        values: { version: 'v2c', allowedTargets: ['10.0.0.0/24', '10.9.0.0/16'] },
      });

      // What the write answered, said where a screen reader hears it.
      const status = await screen.findByText(
        'Saved the SNMP set on Rack A. This save put 6 sensors beneath Rack A outside its bounds: they are not sent the set and read Unknown.',
      );
      expect(status.getAttribute('role')).toBe('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
    });

    it('writes nothing when the operator goes back, and lets the fields be changed again', async () => {
      const { calls, form } = await editSnmp({
        preview: written({ withholds: 1, newlyWithheld: 1 }),
      });
      narrow(form);
      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      expect(
        within(confirm).getByText(/This save puts 1 sensor beneath Rack A outside/u),
      ).toBeDefined();

      fireEvent.click(within(confirm).getByRole('button', { name: 'Go back' }));
      expect(screen.queryByRole('group', { name: 'Confirm this save' })).toBeNull();
      expect(writes(calls)).toHaveLength(1);
      expect(within(form).getByLabelText<HTMLSelectElement>('SNMP version').disabled).toBe(false);
      // Focus goes to the button the confirmation stood in for, not to the document.
      expect(document.activeElement).toBe(
        within(form).getByRole('button', { name: 'Save changes' }),
      );
    });

    it('returns focus to the save button when a confirmed save is refused', async () => {
      const { calls, form } = await editSnmp({
        preview: written({ withholds: 1, newlyWithheld: 1 }),
        write: REFUSED,
      });
      narrow(form);
      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      const anyway = within(confirm).getByRole('button', { name: 'Save anyway' });
      anyway.focus();
      fireEvent.click(anyway);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('needs write on that probe');
      expect(writes(calls)).toHaveLength(2);
      expect(screen.queryByRole('group', { name: 'Confirm this save' })).toBeNull();
      // Waited for: the alert is in the document a moment before the effect that moves focus.
      await waitFor(() => {
        expect(document.activeElement).toBe(
          within(form).getByRole('button', { name: 'Save changes' }),
        );
      });
    });

    it('returns focus to the control that opened a form when the form is cancelled', async () => {
      const { form } = await editSnmp();
      fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('form')).toBeNull();
      expect(document.activeElement).toBe(
        within(row('SNMP')).getByRole('button', { name: 'Edit SNMP credentials' }),
      );

      // And a new set's form goes back to the button that offered it.
      fireEvent.click(screen.getByRole('button', { name: 'Add SSH credentials' }));
      const fresh = screen.getByRole('form', { name: 'New SSH credentials' });
      fireEvent.click(within(fresh).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('form')).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Add SSH credentials' }),
      );
    });

    /** The row's Edit button, which is how the tab says whether a form may be opened. */
    const editButton = (name: string): HTMLButtonElement =>
      within(row(name)).getByRole<HTMLButtonElement>('button', {
        name: `Edit ${name} credentials`,
      });

    it('opens no form on the set as it was, until the list has been read again', async () => {
      const saved: CredentialView = {
        ...OWN_SNMP,
        publicParams: { version: 'v2c', allowedTargets: ['10.0.0.0/24', '10.9.0.0/16'] },
      };
      let land: (sets: CredentialView[]) => void = () => undefined;
      const { calls, form } = await editSnmp({
        preview: written(),
        write: written(saved),
        listing: (read) =>
          read === 1
            ? [OWN_SNMP]
            : new Promise<CredentialView[]>((resolve) => {
                land = resolve;
              }),
      });
      narrow(form);
      expect(await screen.findByText('Saved the SNMP set on Rack A.')).toBeDefined();
      expect(writes(calls)).toHaveLength(2);

      // The list on screen is the one from before the save, and nothing opens on it.
      expect(editButton('SNMP').disabled).toBe(true);
      expect(
        within(row('SNMP')).getByRole<HTMLButtonElement>('button', {
          name: 'Remove SNMP credentials',
        }).disabled,
      ).toBe(true);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Add / }).disabled).toBe(true);
      fireEvent.click(editButton('SNMP'));
      expect(screen.queryByRole('form')).toBeNull();

      land([saved]);
      await waitFor(() => {
        expect(editButton('SNMP').disabled).toBe(false);
      });
      // Opened now, the form starts from what was saved: nothing in it to put the old set back.
      fireEvent.click(editButton('SNMP'));
      const reopened = screen.getByRole('form', { name: 'Editing SNMP credentials' });
      expect(within(reopened).getByLabelText<HTMLInputElement>('Allowed targets 2').value).toBe(
        '10.9.0.0/16',
      );
      expect(within(reopened).getByText('Nothing has changed yet.')).toBeDefined();
    });

    it('keeps saying what was saved when the list cannot be read again, and offers to read it', async () => {
      let failing = true;
      const { calls, form } = await editSnmp({
        preview: written(),
        write: written(),
        listing: (read) => (read === 1 || !failing ? [OWN_SNMP] : UNREADABLE),
      });
      narrow(form);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('the database went away');
      // The save was made, and the tab still says so, with the list it had.
      expect(screen.getByText('Saved the SNMP set on Rack A.').getAttribute('role')).toBe('status');
      expect(screen.getByRole('heading', { name: 'Credential sets' })).toBeDefined();
      expect(
        screen.getByText(/could not be read again, so it may not show the last change/u),
      ).toBeDefined();
      expect(row('SNMP')).toBeDefined();
      // A list that may be the old one is not edited from.
      expect(editButton('SNMP').disabled).toBe(true);

      failing = false;
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      await waitFor(() => {
        expect(screen.queryByRole('alert')).toBeNull();
      });
      expect(editButton('SNMP').disabled).toBe(false);
      expect(screen.getByText('Saved the SNMP set on Rack A.')).toBeDefined();
      expect(
        calls.filter((call) => call.method === 'GET' && call.path.endsWith('/20/credentials')),
      ).toHaveLength(3);
    });

    it('goes straight through when the preview has nothing to say', async () => {
      const { calls, form } = await editSnmp({ preview: written(), write: written() });
      narrow(form);
      await waitFor(() => {
        expect(writes(calls)).toHaveLength(2);
      });
      expect(screen.queryByRole('group', { name: 'Confirm this save' })).toBeNull();
      expect(await screen.findByText('Saved the SNMP set on Rack A.')).toBeDefined();
      // And the list is read again, so it shows what is now stored.
      await waitFor(() => {
        expect(
          calls.filter((call) => call.method === 'GET' && call.path.endsWith('/20/credentials')),
        ).toHaveLength(2);
      });
    });

    it('says which secrets a widening will clear before it is confirmed, and that they were cleared after', async () => {
      const { calls, form } = await editSnmp({
        preview: written({ secretsCleared: ['community'] }),
        write: written({ secretsCleared: ['community'] }),
      });
      narrow(form);

      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      expect(
        within(confirm).getByText(
          'This save lets the set go further than before, so Community string will be cleared. Go back and enter it again to keep it.',
        ),
      ).toBeDefined();
      expect(within(confirm).queryByText(/outside this set's bounds/u)).toBeNull();
      expect(within(confirm).queryByText(OUTSIDE_MEANS)).toBeNull();
      expect(writes(calls)).toHaveLength(1);

      fireEvent.click(within(confirm).getByRole('button', { name: 'Save anyway' }));
      expect(
        await screen.findByText(
          'Saved the SNMP set on Rack A. Cleared because the set may now go further: Community string. Enter it again, or the sensors using this set cannot authenticate.',
        ),
      ).toBeDefined();
    });

    it('saves without asking when the sensors outside were outside already, and says so after', async () => {
      // `A-55`: six outside before and six after, none put there by this save. Nothing to
      // confirm, and the sentence afterwards does not call them the save's.
      const standing = written({ withholds: 6, withheldBefore: 6 });
      const { calls, form } = await editSnmp({ preview: standing, write: standing });
      narrow(form);
      const status = await screen.findByText(
        'Saved the SNMP set on Rack A. 6 sensors beneath Rack A were outside already and still are.',
      );
      expect(status.getAttribute('role')).toBe('status');
      expect(screen.queryByRole('group', { name: 'Confirm this save' })).toBeNull();
      expect(writes(calls).map((call) => call.path)).toEqual([
        '/api/v1/objects/20/credentials/snmp?dryRun=true',
        '/api/v1/objects/20/credentials/snmp',
      ]);
    });

    it('says what the save adds apart from what was outside already and what it brings back', async () => {
      const { form } = await editSnmp({
        preview: written({
          withholds: 5,
          withheldBefore: 4,
          newlyWithheld: 2,
          noLongerWithheld: 1,
        }),
      });
      narrow(form);
      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      expect(
        within(confirm).getByText(
          "This save puts 2 sensors beneath Rack A outside this set's bounds. They are not sent the set after it and read Unknown until the bounds include them. It brings 1 sensor back inside, to be sent the set again. 3 sensors beneath Rack A are outside already, and this save leaves them there.",
        ),
      ).toBeDefined();
    });

    it('says the sensors still outside beside a secret a widening clears', async () => {
      // Asked about for the secret; the sensors that stay outside are said, and what outside
      // means with them, though the save puts none there.
      const { form } = await editSnmp({
        preview: written({ withholds: 2, withheldBefore: 2, secretsCleared: ['community'] }),
      });
      narrow(form);
      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      expect(
        within(confirm).getByText(
          '2 sensors beneath Rack A are outside already, and this save leaves them there.',
        ),
      ).toBeDefined();
      expect(within(confirm).getByText(OUTSIDE_MEANS)).toBeDefined();
    });

    it('shows what the write answered, not what the preview did, when they differ', async () => {
      const { form } = await editSnmp({
        preview: written({ withholds: 1, newlyWithheld: 1 }),
        write: written({ withholds: 3, newlyWithheld: 3 }),
      });
      narrow(form);
      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Save anyway' }));
      expect(
        await screen.findByText(/This save put 3 sensors beneath Rack A outside its bounds/u),
      ).toBeDefined();
    });

    it('puts a refused preview on the field it names, and writes nothing', async () => {
      const { calls, form } = await editSnmp({
        preview: {
          status: 400,
          body: {
            error: {
              code: 'CREDENTIAL_INVALID',
              message: 'allowed target 2: "10.9.0.0/160" is not a host name, an address or a range',
              context: { kind: 'snmp', field: 'allowedTargets/1' },
            },
          },
        },
      });
      narrow(form);
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('allowed target 2');
      const entry = within(form).getByLabelText('Allowed targets 2');
      const describedBy = entry.getAttribute('aria-describedby') ?? '';
      expect(describedBy).not.toBe('');
      expect(document.getElementById(describedBy.trim())?.textContent).toContain(
        'allowed target 2',
      );
      expect(writes(calls)).toHaveLength(1);
      // Still open, with what was typed, for the operator to put right.
      expect((entry as HTMLInputElement).value).toBe('10.9.0.0/16');
    });
  });

  describe('removing a set', () => {
    const PREVIEW: CredentialRemoval = {
      kind: 'snmp',
      removed: true,
      sensors: 2,
      nowInherited: {
        kind: 'snmp',
        publicParams: {},
        source: { kind: 'inherited', objectId: 10, depth: 1 },
        updatedAt: '2026-09-01T00:00:00.000Z',
        bounded: false,
      },
    };

    const askToRemove = async (stub: Stub): Promise<{ calls: Call[] }> => {
      const api = await show({ sets: [OWN_SNMP], ...stub });
      fireEvent.click(within(row('SNMP')).getByRole('button', { name: 'Remove SNMP credentials' }));
      return api;
    };

    it('asks first, saying what loses the set and what those sensors will use', async () => {
      const { calls } = await askToRemove({ removalPreview: PREVIEW, removal: PREVIEW });
      const confirm = await screen.findByRole('group', {
        name: 'Confirm removing SNMP credentials',
      });
      expect(within(confirm).getByText('Remove the SNMP set from Rack A?')).toBeDefined();
      expect(
        within(confirm).getByText(
          '2 sensors beneath Rack A use this set and will lose it. They will use the set on Local probe instead.',
        ),
      ).toBeDefined();
      // Only asked about so far: the one request is the preview, and the set is still listed.
      expect(writes(calls).map((call) => `${call.method} ${call.path}`)).toEqual([
        'DELETE /api/v1/objects/20/credentials/snmp?dryRun=true',
      ]);
      // Waited for: the group is in the document a moment before the effect that focuses it.
      await waitFor(() => {
        expect(document.activeElement).toBe(confirm);
      });

      fireEvent.click(within(confirm).getByRole('button', { name: 'Remove the set' }));
      await waitFor(() => {
        expect(writes(calls)).toHaveLength(2);
      });
      expect(writes(calls)[1]?.path).toBe('/api/v1/objects/20/credentials/snmp');
      expect(
        await screen.findByText(
          'Removed the SNMP set from Rack A. 2 sensors beneath Rack A lost it. They now use the set on Local probe.',
        ),
      ).toBeDefined();
    });

    it('says the sensors will have no credential when nothing above defines one', async () => {
      await askToRemove({ removalPreview: { ...PREVIEW, sensors: 1, nowInherited: null } });
      const confirm = await screen.findByRole('group', {
        name: 'Confirm removing SNMP credentials',
      });
      expect(
        within(confirm).getByText(
          '1 sensor beneath Rack A uses this set and will lose it. Nothing above defines SNMP credentials, so it will have none and its checks will fail to authenticate.',
        ),
      ).toBeDefined();
    });

    it('removes nothing when the operator keeps it', async () => {
      const { calls } = await askToRemove({ removalPreview: PREVIEW });
      const confirm = await screen.findByRole('group', {
        name: 'Confirm removing SNMP credentials',
      });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
      expect(screen.queryByRole('group', { name: 'Confirm removing SNMP credentials' })).toBeNull();
      expect(writes(calls)).toHaveLength(1);
      // Focus goes back to the button that asked, not to the document.
      expect(document.activeElement).toBe(
        within(row('SNMP')).getByRole('button', { name: 'Remove SNMP credentials' }),
      );
    });

    it('returns focus to the Remove button when a confirmed removal is refused', async () => {
      const { calls } = await askToRemove({ removalPreview: PREVIEW, removal: REFUSED });
      const confirm = await screen.findByRole('group', {
        name: 'Confirm removing SNMP credentials',
      });
      const sure = within(confirm).getByRole('button', { name: 'Remove the set' });
      sure.focus();
      fireEvent.click(sure);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('needs write on that probe');
      expect(writes(calls)).toHaveLength(2);
      expect(screen.queryByRole('group', { name: 'Confirm removing SNMP credentials' })).toBeNull();
      await waitFor(() => {
        expect(document.activeElement).toBe(
          within(row('SNMP')).getByRole('button', { name: 'Remove SNMP credentials' }),
        );
      });
    });

    it('opens no form while a removal is waiting to be confirmed, so confirming it discards nothing', async () => {
      const api = await show({
        sets: [OWN_SNMP, OWN_SSH],
        kinds: [...KINDS, { ...KINDS[0], id: 'windows', name: 'Windows' } as CredentialKindSummary],
        removalPreview: PREVIEW,
      });
      const controls = (): HTMLButtonElement[] => [
        within(row('SSH')).getByRole<HTMLButtonElement>('button', { name: 'Edit SSH credentials' }),
        within(row('SSH')).getByRole<HTMLButtonElement>('button', {
          name: 'Remove SSH credentials',
        }),
        screen.getByRole<HTMLButtonElement>('button', { name: 'Add Windows credentials' }),
      ];
      expect(controls().map((control) => control.disabled)).toEqual([false, false, false]);

      fireEvent.click(within(row('SNMP')).getByRole('button', { name: 'Remove SNMP credentials' }));
      const confirm = await screen.findByRole('group', {
        name: 'Confirm removing SNMP credentials',
      });
      // Every other way into a form or a second confirmation is closed, and says why.
      expect(controls().map((control) => control.disabled)).toEqual([true, true, true]);
      expect(screen.getByLabelText<HTMLSelectElement>('Store a set here').disabled).toBe(true);
      expect(
        screen.getByText('Answer the removal above before storing another set.'),
      ).toBeDefined();
      for (const control of controls()) fireEvent.click(control);
      expect(screen.queryByRole('form')).toBeNull();
      expect(writes(api.calls)).toHaveLength(1);

      fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
      expect(controls().map((control) => control.disabled)).toEqual([false, false, false]);
      expect(screen.queryByText('Answer the removal above before storing another set.')).toBeNull();
    });

    it('keeps saying what was removed when the list cannot be read again', async () => {
      await askToRemove({
        removalPreview: PREVIEW,
        removal: PREVIEW,
        listing: (read) => (read === 1 ? [OWN_SNMP] : UNREADABLE),
      });
      const confirm = await screen.findByRole('group', {
        name: 'Confirm removing SNMP credentials',
      });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Remove the set' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('the database went away');
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBeDefined();
      expect(
        screen.getByText(
          'Removed the SNMP set from Rack A. 2 sensors beneath Rack A lost it. They now use the set on Local probe.',
        ),
      ).toBeDefined();
      expect(screen.getByRole('heading', { name: 'Credential sets' })).toBeDefined();
    });

    it('says why when the core would refuse the removal, before anything is confirmed', async () => {
      const { calls } = await askToRemove({
        removalPreview: {
          status: 403,
          body: {
            error: {
              code: 'AUTH_FORBIDDEN',
              message:
                "bringing the snmp credentials on probe 'Local probe' (#10) to 10.0.0.1:161 needs write on that probe",
            },
          },
        },
      });
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('needs write on that probe');
      expect(screen.queryByRole('group', { name: 'Confirm removing SNMP credentials' })).toBeNull();
      expect(writes(calls)).toHaveLength(1);
    });
  });
});

describe('the list of sets without bounds', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names each set’s object, links to its Credentials tab, and says whose view it is', async () => {
    stubApi({
      unbounded: [
        {
          objectId: 20,
          objectKind: 'group',
          objectName: 'Rack A',
          kind: 'ssh',
          updatedAt: '2026-09-29T08:00:00.000Z',
        },
        {
          objectId: 31,
          objectKind: 'device',
          objectName: 'router',
          kind: 'snmp',
          updatedAt: '2026-09-29T08:00:00.000Z',
        },
      ],
    });
    render(inSession(OPEN, <UnboundedCredentialsView />));
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'Rack A' }).getAttribute('href')).toBe(
      '/objects/20?tab=credentials',
    );
    expect(within(table).getByRole('link', { name: 'router' }).getAttribute('href')).toBe(
      '/objects/31?tab=credentials',
    );
    await waitFor(() => {
      expect(within(table).getByText('SSH')).toBeDefined();
    });
    expect(screen.getByText('2 sets without bounds, among the objects you can see.')).toBeDefined();
    expect(screen.getByText(/write on that object is trust with the\s+set/u)).toBeDefined();
  });

  it('says there are none it can show, and why Core Health may still count some', async () => {
    stubApi({ unbounded: [] });
    render(inSession(OPEN, <UnboundedCredentialsView />));
    expect(await screen.findByText('No set you can see is without bounds.')).toBeDefined();
    expect(screen.getByText(/counted there and not listed here/u)).toBeDefined();
  });
});

describe('Core Health’s count of sets without bounds', () => {
  const channel = (id: number, key: string, name: string): ChannelRecord => ({
    id,
    key,
    name,
    unit: 'sets',
    isPrimary: false,
    scaleMul: '1',
    scaleDiv: '1',
    decimals: null,
    limits: {
      enabled: false,
      upperError: null,
      upperWarning: null,
      lowerWarning: null,
      lowerError: null,
      errorMessage: '',
      warningMessage: '',
    },
    spikeMin: null,
    spikeMax: null,
    lookupId: null,
  });
  const CHANNELS = [
    channel(1, 'credentialsUnbounded', 'Credential sets without targets'),
    channel(2, 'credentialsToReenter', 'Credential sets to re-enter'),
  ];

  it('links to the list of them, from that channel and no other', () => {
    render(
      <MemoryRouter>
        <ChannelTable
          channels={CHANNELS}
          sensorType="ms.core.health"
          values={null}
          lookups={null}
          now={0}
        />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/credentials/unbounded');
    expect(links[0]?.closest('tr')?.textContent).toContain('Credential sets without targets');
  });

  it('gives no link to a channel that only shares the key on another type', () => {
    render(
      <MemoryRouter>
        <ChannelTable
          channels={CHANNELS}
          sensorType="script.custom"
          values={null}
          lookups={null}
          now={0}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
