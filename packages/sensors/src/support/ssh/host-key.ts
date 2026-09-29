import { createHash } from 'node:crypto';

/**
 * Deciding whether to trust the server on the other end (`T-07`).
 *
 * **This is the part of SSH that is easy to get wrong quietly.** A client that accepts any host
 * key authenticates the *server* not at all, which means a password or a private key can be
 * handed to whatever answered on port 22 — and the check still goes green, so nothing about the
 * monitoring says it happened. Most monitoring tools default to accepting anything because the
 * alternative needs somewhere to record what was trusted.
 *
 * **The recording problem is solved by putting a person in the loop rather than by a store.**
 * A probe cannot write back to the core — the config channel is one-way (`R-09`) — so a
 * trust-on-first-use store on the probe would last until the next restart and differ between
 * probes. Instead the expected fingerprint is a field on the credential, and a strict check with
 * no fingerprint yet **fails naming the one the server presented**. The operator reads it out of
 * the failed check, compares it against what the machine actually has, and pastes it in. That is
 * trust-on-first-use with the verification step that makes it worth anything, and it needs no
 * write-back at all.
 *
 * The format is OpenSSH's own — `SHA256:` and unpadded base64 — so what an operator pastes is
 * exactly what `ssh-keygen -lf` and the first-connection prompt show them.
 */

export type HostKeyPolicy = 'strict' | 'accept-any';

/**
 * The fingerprint of a host key, in the form OpenSSH prints.
 *
 * Base64 with the `=` padding stripped, because that is what `ssh-keygen -lf` shows and what a
 * person will paste. Accepting the padded form too would be kind, and `matchesFingerprint`
 * does — but producing it would mean the string we show never matches the one they have.
 */
export function fingerprintOf(hostKey: Buffer): string {
  const digest = createHash('sha256').update(hostKey).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** Whether two fingerprints are the same, forgiving the ways a person may have pasted one. */
export function matchesFingerprint(expected: string, actual: string): boolean {
  return normalise(expected) === normalise(actual);
}

/**
 * Tolerates the `SHA256:` prefix being present or absent, base64 padding, and surrounding
 * space — all of which are the same fingerprint, and none of which are worth a failed check.
 * Case is *not* folded: base64 is case-significant, and two keys differing only in case are two
 * keys.
 */
function normalise(fingerprint: string): string {
  return fingerprint
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
}

export type HostKeyVerdict =
  | { readonly kind: 'trusted' }
  /** No fingerprint recorded yet. The message carries the one to paste in. */
  | { readonly kind: 'unknown'; readonly presented: string }
  | {
      readonly kind: 'mismatch';
      readonly expected: readonly string[];
      readonly presented: string;
    }
  /** Accepted without checking, because the operator asked for that. Still said out loud. */
  | { readonly kind: 'unchecked'; readonly presented: string };

/**
 * What to do about the key this server presented.
 *
 * Pure, and separate from the session, because it is the piece worth being able to read on its
 * own: everything about whether a connection is safe is decided here, from three inputs.
 */
export function verifyHostKey(
  policy: HostKeyPolicy,
  accepted: readonly string[],
  hostKey: Buffer,
): HostKeyVerdict {
  const presented = fingerprintOf(hostKey);
  if (policy === 'accept-any') return { kind: 'unchecked', presented };
  const expected = accepted.map((key) => key.trim()).filter((key) => key !== '');
  if (expected.length === 0) return { kind: 'unknown', presented };
  if (expected.some((key) => matchesFingerprint(key, presented))) return { kind: 'trusted' };
  return { kind: 'mismatch', expected, presented };
}

/**
 * The sentence a failed verdict produces.
 *
 * Written here rather than at the call site because the *unknown* case is not really an error —
 * it is an instruction, and it has to contain the fingerprint or the operator has no way to
 * proceed except by turning the checking off.
 */
export function describeVerdict(host: string, verdict: HostKeyVerdict): string | null {
  switch (verdict.kind) {
    case 'trusted':
    case 'unchecked':
      return null;
    case 'unknown':
      return (
        `${host} presented host key ${verdict.presented} and this credential has no expected ` +
        'fingerprint, so there is nothing to check it against. Compare it against the machine ' +
        '— ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the host itself — and put it in ' +
        'the credential’s host key fingerprint to accept it'
      );
    case 'mismatch':
      return (
        `${host} presented host key ${verdict.presented}, and this credential expects ` +
        `${verdict.expected.length === 1 ? '' : 'one of '}${verdict.expected.join(', ')}. Either the host was rebuilt and its key is new, or something is ` +
        'answering on its address that is not it — telling those apart is exactly what this ' +
        'check is for, so confirm which before changing the fingerprint'
      );
  }
}
