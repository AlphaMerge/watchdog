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

const written = (over: Partial<CredentialWrite> = {}): CredentialWrite => ({
  ...OWN_SNMP,
  withholds: 0,
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
  preview?: CredentialWrite | { status: number; body: unknown };
  write?: CredentialWrite;
  removalPreview?: CredentialRemoval | { status: number; body: unknown };
  removal?: CredentialRemoval;
  unbounded?: UnboundedCredential[];
}

function stubApi(stub: Stub): { calls: Call[] } {
  const calls: Call[] = [];
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
    if (path.endsWith('/objects/20/credentials')) return reply(200, { items: stub.sets ?? [] });
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
        preview: written({ withholds: 6 }),
        write: written({ withholds: 6 }),
      });
      narrow(form);

      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      expect(
        within(confirm).getByText(
          "After this save, 6 sensors beneath Rack A are outside this set's bounds. They are not sent the set and read Unknown until the bounds include them.",
        ),
      ).toBeDefined();
      // Asked, and not yet done: one request, and it is the preview.
      expect(writes(calls).map((call) => call.path)).toEqual([
        '/api/v1/objects/20/credentials/snmp?dryRun=true',
      ]);
      // The fields are held as they were previewed.
      expect(within(form).getByLabelText<HTMLSelectElement>('SNMP version').disabled).toBe(true);
      expect(document.activeElement).toBe(confirm);

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
        'Saved the SNMP set on Rack A. 6 sensors beneath Rack A are outside its bounds and read Unknown.',
      );
      expect(status.getAttribute('role')).toBe('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
    });

    it('writes nothing when the operator goes back, and lets the fields be changed again', async () => {
      const { calls, form } = await editSnmp({ preview: written({ withholds: 1 }) });
      narrow(form);
      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      expect(
        within(confirm).getByText(/After this save, 1 sensor beneath Rack A is outside/u),
      ).toBeDefined();

      fireEvent.click(within(confirm).getByRole('button', { name: 'Go back' }));
      expect(screen.queryByRole('group', { name: 'Confirm this save' })).toBeNull();
      expect(writes(calls)).toHaveLength(1);
      expect(within(form).getByLabelText<HTMLSelectElement>('SNMP version').disabled).toBe(false);
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
      expect(writes(calls)).toHaveLength(1);

      fireEvent.click(within(confirm).getByRole('button', { name: 'Save anyway' }));
      expect(
        await screen.findByText(
          'Saved the SNMP set on Rack A. Cleared because the set may now go further: Community string. Enter it again, or the sensors using this set cannot authenticate.',
        ),
      ).toBeDefined();
    });

    it('shows what the write answered, not what the preview did, when they differ', async () => {
      const { form } = await editSnmp({
        preview: written({ withholds: 1 }),
        write: written({ withholds: 3 }),
      });
      narrow(form);
      const confirm = await screen.findByRole('group', { name: 'Confirm this save' });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Save anyway' }));
      expect(
        await screen.findByText(/3 sensors beneath Rack A are outside its bounds/u),
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
      expect(document.activeElement).toBe(confirm);

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
      expect(
        within(row('SNMP')).getByRole('button', { name: 'Remove SNMP credentials' }),
      ).toBeDefined();
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
