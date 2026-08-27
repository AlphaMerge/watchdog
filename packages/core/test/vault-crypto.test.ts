import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { VaultKeyring, VaultKeyError } from '../src/vault/keyring.js';
import { VaultSealer, VaultSealError } from '../src/vault/sealer.js';

function key(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

function sealer(...keys: { id: string; key: Buffer }[]): VaultSealer {
  return new VaultSealer(
    VaultKeyring.fromKeys(keys.length === 0 ? [{ id: 'k1', key: key(1) }] : keys),
  );
}

const SCOPE = { objectId: 7, kind: 'snmp' };

describe('sealing a credential', () => {
  it('round-trips what was put in', () => {
    const vault = sealer();
    const sealed = vault.seal({ community: 'public', authKey: 'hunter2' }, SCOPE);
    assert.deepEqual(vault.open(sealed.bytes, sealed.keyId, SCOPE), {
      community: 'public',
      authKey: 'hunter2',
    });
  });

  it('does not leave the plaintext in the record', () => {
    const vault = sealer();
    const sealed = vault.seal({ community: 'a-very-distinctive-community' }, SCOPE);
    assert.equal(sealed.bytes.includes(Buffer.from('a-very-distinctive-community')), false);
    assert.equal(sealed.bytes.includes(Buffer.from('community')), false);
  });

  it('produces different bytes for the same secret each time', () => {
    // A fresh IV per record. Without one, two devices sharing a community string would have
    // byte-identical rows, so anybody with read access to the table could see which devices
    // share credentials without decrypting anything.
    const vault = sealer();
    const first = vault.seal({ community: 'public' }, SCOPE);
    const second = vault.seal({ community: 'public' }, SCOPE);
    assert.equal(first.bytes.equals(second.bytes), false);
  });

  it('records which key sealed it', () => {
    const vault = sealer({ id: 'k-2026', key: key(9) });
    assert.equal(vault.seal({ community: 'public' }, SCOPE).keyId, 'k-2026');
  });
});

describe('opening a credential that has been tampered with', () => {
  it('refuses a record whose ciphertext was altered', () => {
    // The reason for an authenticated mode. Confidentiality alone lets somebody with database
    // access *change* a credential without being able to read it.
    const vault = sealer();
    const sealed = vault.seal({ community: 'public' }, SCOPE);
    const altered = Buffer.from(sealed.bytes);
    altered.writeUInt8((altered.readUInt8(altered.length - 1) ^ 0xff) & 0xff, altered.length - 1);
    assert.throws(() => vault.open(altered, sealed.keyId, SCOPE), VaultSealError);
  });

  it('refuses a record copied onto a different object', () => {
    // The attack that needs no key at all: copy the `secret` cell from a device you may read
    // onto one you may not, and it authenticates as the first. The AAD binds the two.
    const vault = sealer();
    const sealed = vault.seal({ community: 'public' }, SCOPE);
    assert.throws(
      () => vault.open(sealed.bytes, sealed.keyId, { objectId: 8, kind: 'snmp' }),
      VaultSealError,
    );
  });

  it('refuses a record copied onto a different kind', () => {
    const vault = sealer();
    const sealed = vault.seal({ community: 'public' }, SCOPE);
    assert.throws(
      () => vault.open(sealed.bytes, sealed.keyId, { objectId: 7, kind: 'ssh' }),
      VaultSealError,
    );
  });

  it('refuses a record sealed with a different key', () => {
    const a = sealer({ id: 'k1', key: key(1) });
    const b = sealer({ id: 'k1', key: key(2) });
    const sealed = a.seal({ community: 'public' }, SCOPE);
    assert.throws(() => b.open(sealed.bytes, sealed.keyId, SCOPE), VaultSealError);
  });

  it('refuses a truncated record instead of reading past its end', () => {
    const vault = sealer();
    const sealed = vault.seal({ community: 'public' }, SCOPE);
    assert.throws(() => vault.open(sealed.bytes.subarray(0, 10), sealed.keyId, SCOPE), /truncated/);
  });

  it('refuses a record in a format this build does not know', () => {
    const vault = sealer();
    const sealed = vault.seal({ community: 'public' }, SCOPE);
    const future = Buffer.from(sealed.bytes);
    future[0] = 99;
    assert.throws(() => vault.open(future, sealed.keyId, SCOPE), /format 99/);
  });

  it('says which key is missing rather than only that it failed', () => {
    // "The key that encrypted this is not in the file" and "the key file is wrong" look
    // identical from a failed decryption, and only the first says which backup to find.
    const retired = sealer({ id: 'k-gone', key: key(3) });
    const sealed = retired.seal({ community: 'public' }, SCOPE);

    const vault = sealer({ id: 'k1', key: key(1) });
    assert.throws(
      () => vault.open(sealed.bytes, sealed.keyId, SCOPE),
      (error: unknown) => error instanceof VaultKeyError && /"k-gone"/.test(error.message),
    );
  });
});

describe('several keys', () => {
  it('encrypts with the current one and still opens the old one', () => {
    // What `credential_set.key_id` has been in the schema for since migration 001: rotation
    // without decrypting everything up front under a lock.
    const old = sealer({ id: 'k1', key: key(1) });
    const sealed = old.seal({ community: 'public' }, SCOPE);

    const rotated = new VaultSealer(
      VaultKeyring.fromKeys(
        [
          { id: 'k1', key: key(1) },
          { id: 'k2', key: key(2) },
        ],
        'k2',
      ),
    );
    assert.equal(rotated.currentKeyId, 'k2');
    assert.deepEqual(rotated.open(sealed.bytes, 'k1', SCOPE), { community: 'public' });
    assert.equal(rotated.seal({ community: 'public' }, SCOPE).keyId, 'k2');
    assert.equal(rotated.isCurrent('k1'), false);
    assert.equal(rotated.isCurrent('k2'), true);
  });
});

describe('the key file', () => {
  function dir(): string {
    return mkdtempSync(join(tmpdir(), 'ms-vault-'));
  }

  it('creates one at first start, and only readable by its owner', () => {
    const path = join(dir(), 'vault.key');
    const keyring = VaultKeyring.load(path);
    assert.equal(keyring.size, 1);
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });

  it('generates a random key rather than defaulting to one', () => {
    // A key derived from something the installer already knows, or a constant with a "change
    // this" comment, produces an installation that is encrypted in form and not in fact.
    const first = readFileSync(
      (() => {
        const path = join(dir(), 'vault.key');
        VaultKeyring.load(path);
        return path;
      })(),
      'utf8',
    );
    const second = readFileSync(
      (() => {
        const path = join(dir(), 'vault.key');
        VaultKeyring.load(path);
        return path;
      })(),
      'utf8',
    );
    assert.notEqual(first, second);
  });

  it('reads back the key it wrote', () => {
    const path = join(dir(), 'vault.key');
    const created = new VaultSealer(VaultKeyring.load(path));
    const sealed = created.seal({ community: 'public' }, SCOPE);

    const reloaded = new VaultSealer(VaultKeyring.load(path));
    assert.deepEqual(reloaded.open(sealed.bytes, sealed.keyId, SCOPE), { community: 'public' });
  });

  it(
    'refuses a file other users on the machine can read',
    { skip: process.platform === 'win32' },
    () => {
      // Checked on every load, not only on the one this created: a key file gets restored from a
      // backup, copied between hosts and edited by hand, and any of those can widen the mode.
      const path = join(dir(), 'vault.key');
      VaultKeyring.load(path);
      chmodSync(path, 0o644);
      assert.throws(() => VaultKeyring.load(path), /chmod 600/);
    },
  );

  it('refuses to start when told not to create one and there is none', () => {
    const path = join(dir(), 'absent.key');
    assert.throws(() => VaultKeyring.load(path, { create: false }), /no vault key file/);
  });

  it('refuses an unreadable file rather than quietly making a new key', () => {
    // Regenerating would orphan every stored credential while reporting a healthy start.
    const path = join(dir(), 'vault.key');
    writeFileSync(path, 'not json at all', { mode: 0o600 });
    assert.throws(() => VaultKeyring.load(path), /not valid JSON/);
  });

  it('refuses a key of the wrong length', () => {
    const path = join(dir(), 'vault.key');
    writeFileSync(
      path,
      JSON.stringify({
        currentId: 'k1',
        keys: [{ id: 'k1', key: randomBytes(16).toString('base64') }],
      }),
      { mode: 0o600 },
    );
    assert.throws(() => VaultKeyring.load(path), /AES-256/);
  });

  it('refuses a file with no keys in it', () => {
    const path = join(dir(), 'vault.key');
    writeFileSync(path, JSON.stringify({ currentId: 'k1', keys: [] }), { mode: 0o600 });
    assert.throws(() => VaultKeyring.load(path), /holds no keys/);
  });

  it('refuses a current id that names no key', () => {
    const path = join(dir(), 'vault.key');
    writeFileSync(
      path,
      JSON.stringify({
        currentId: 'k-missing',
        keys: [{ id: 'k1', key: key(1).toString('base64') }],
      }),
      { mode: 0o600 },
    );
    assert.throws(() => VaultKeyring.load(path), /not in the keyring/);
  });
});
