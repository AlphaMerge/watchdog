import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ShareRateLimit, mintShareToken, shareTokenHash } from '../src/maps/shares.js';

/**
 * Minting a share token, and bounding what one link may cost (`G-06`, `ADR-002` Decision 1).
 *
 * Pure, so the awkward half — a window that rolls over, a map of counters an unauthenticated
 * caller chooses the keys of — is asserted here rather than through sixty HTTP requests.
 */

describe('a share token', () => {
  it('is long, random, and stored only as a hash', () => {
    const first = mintShareToken();
    const second = mintShareToken();

    // 32 bytes of randomness, base64url. Guessing is not the threat model at this width; reading
    // a backup is, which is why what goes in the database is the hash.
    assert.ok(first.token.length >= 40, first.token);
    assert.notEqual(first.token, second.token);
    assert.match(first.tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(first.tokenHash, shareTokenHash(first.token));
    assert.notEqual(first.tokenHash, first.token);
  });

  it('keeps a prefix short enough to be useless', () => {
    const minted = mintShareToken();
    assert.equal(minted.prefix.length, 8);
    assert.ok(minted.token.startsWith(minted.prefix));
    // A list has to be readable; a prefix that could be brute-forced into the rest would not be.
    assert.ok(minted.prefix.length * 4 < minted.token.length);
  });

  it('is URL-safe, because it is the URL', () => {
    for (let i = 0; i < 20; i += 1) {
      assert.match(mintShareToken().token, /^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('what one link may cost', () => {
  const at = (ms: number) => (): number => ms;

  it('allows a windowful and refuses the next', () => {
    let clock = 1_000;
    const limit = new ShareRateLimit({ perWindow: 3, windowMs: 1_000, now: () => clock });
    assert.equal(limit.allow('token:a'), true);
    assert.equal(limit.allow('token:a'), true);
    assert.equal(limit.allow('token:a'), true);
    assert.equal(limit.allow('token:a'), false, 'the fourth is over the line');

    clock += 1_000;
    assert.equal(limit.allow('token:a'), true, 'a new window starts');
  });

  it('counts each link separately', () => {
    // A busy wall display must not use up the budget of a link somebody else is opening.
    const limit = new ShareRateLimit({ perWindow: 1, windowMs: 1_000, now: at(0) });
    assert.equal(limit.allow('token:a'), true);
    assert.equal(limit.allow('token:b'), true);
    assert.equal(limit.allow('token:a'), false);
  });

  it('is bounded, because the caller chooses the keys', () => {
    // **The reason this is not a plain Map.** The token is in the URL, so a caller can present a
    // new one every request; an unbounded map of counters is a memory leak with a remote control.
    let clock = 0;
    const limit = new ShareRateLimit({
      perWindow: 5,
      windowMs: 60_000,
      maxKeys: 50,
      now: () => clock,
    });
    for (let i = 0; i < 500; i += 1) {
      clock += 1;
      limit.allow(`token:${String(i)}`);
    }
    assert.equal(limit.size, 50);
  });

  it('drops the window that started longest ago', () => {
    // Which is the right eviction here and would be the wrong one for a cache: the entry being
    // dropped is the one closest to expiring anyway, so evicting it forgives least.
    let clock = 0;
    const limit = new ShareRateLimit({
      perWindow: 1,
      windowMs: 60_000,
      maxKeys: 2,
      now: () => clock,
    });
    limit.allow('token:old');
    clock += 10;
    limit.allow('token:middle');
    clock += 10;
    limit.allow('token:new');

    // **The surviving key is checked first, and that ordering is the test.** Asking about the
    // evicted one re-inserts it, which evicts the next-oldest — so checking `old` first would
    // throw `middle` out and prove nothing about which entry the eviction chose.
    assert.equal(limit.allow('token:middle'), false, 'still counted');
    assert.equal(limit.allow('token:old'), true, 'forgotten, so it starts a fresh window');
  });
});
