import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { staleKeyAction } from '../src/transport/identity.js';

/**
 * What a probe does when the core refuses the key it holds (`P-38`).
 *
 * **The mirror image of `P-37`, and the trap is the remedy.** The core clears a probe's key hash
 * when it is re-approved — deliberately, so a key that leaked before a revocation cannot survive
 * the decision to let the machine back in. But the probe went on presenting the key it still had,
 * which the core no longer knew. So an operator whose probe would not connect re-approved it,
 * which is the documented remedy and the obvious thing to try, and the probe became *less*
 * recoverable: the only exit was deleting `identity.json` on its own disk, which for a remote
 * probe means logging into that machine.
 *
 * A decision rather than the doing, so it can be tested without a live core. Each outcome is a
 * different situation an operator would want named differently, which is the point — a probe
 * that loops in silence is the failure this replaces.
 */
describe('staleKeyAction (P-38)', () => {
  it('falls back to the enrolment key when the core does not know the stored one', () => {
    assert.equal(
      staleKeyAction({ stored: 'issued-months-ago', configured: 'shared', alreadyTried: false }),
      'retry-with-enrolment',
    );
  });

  it('does nothing when the probe is already presenting the configured key', () => {
    // The refusal is then about this probe rather than about which key it holds — revoked, or a
    // configured key that is simply wrong. Retrying the same key changes nothing, and calling it
    // a stale-key problem would send somebody looking in the wrong place.
    assert.equal(
      staleKeyAction({ stored: 'shared', configured: 'shared', alreadyTried: false }),
      'nothing-to-retry',
    );
  });

  it('does nothing when the probe has no key of its own yet', () => {
    // A probe still enrolling already presents the configured key, so there is nothing to
    // abandon. This is the ordinary pending case and must not be reported as a fault.
    assert.equal(
      staleKeyAction({ stored: '', configured: 'shared', alreadyTried: false }),
      'nothing-to-retry',
    );
  });

  it('names the case a probe cannot fix by itself', () => {
    // A stored key the core rejects and no enrolment key to fall back on. There is no retry that
    // helps, and the distinction earns its own outcome so the log can say what to do rather than
    // repeating `bad-access-key` for ever.
    assert.equal(
      staleKeyAction({ stored: 'issued-months-ago', configured: '', alreadyTried: false }),
      'no-enrolment-key',
    );
  });

  it('gives up once rather than hammering a door it was told to stop knocking on', () => {
    // A core that has genuinely revoked this probe refuses the enrolment key too. Retrying it on
    // every reconnect would be a machine arguing with a decision somebody made on purpose.
    assert.equal(
      staleKeyAction({ stored: 'issued-months-ago', configured: 'shared', alreadyTried: true }),
      'already-tried',
    );
  });

  it('re-arms for the next time the core forgets, which it can', () => {
    // `alreadyTried` is reset by a successful handshake, not by time — a second re-approval or a
    // second restored backup is the same situation again and deserves the same recovery. This
    // asserts the decision honours that reset rather than latching for the process's life.
    const afterReset = staleKeyAction({
      stored: 'issued-again',
      configured: 'shared',
      alreadyTried: false,
    });
    assert.equal(afterReset, 'retry-with-enrolment');
  });
});
