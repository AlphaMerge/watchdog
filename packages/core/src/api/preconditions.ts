import { isExactBuild, type BuildIdentity } from '@ms/shared';
import { ObjectError } from '../objects/errors.js';
import type { Precondition } from '../objects/types.js';

/**
 * `W/"<version>"`, or `W/"<version>-<chain>"` when the response carries inherited content.
 *
 * Weak, because the byte representation varies with `?include=`: the tag identifies the state
 * behind the response rather than one serialisation of it.
 *
 * The compound form is what makes a conditional GET safe for inherited settings and credentials
 * (S-13). An object's own version does not move when an *ancestor* changes, so a validator built
 * from it alone would let a 304 hide a revoked credential or a changed scan interval. The chain
 * part covers the ancestors; see `ObjectRepository.chainValidator`.
 *
 * Both halves are load-bearing and they are read by different requests. `If-None-Match` compares
 * the whole string, so an ancestor's change invalidates the cache. `If-Match` reads only the
 * version, because a PATCH to *this* object is an edit to this object — blocking it because
 * something changed three levels up would be an optimistic-lock failure with no conflict behind
 * it.
 */
export function etagFor(version: number, chain?: string): string {
  return chain === undefined ? `W/"${String(version)}"` : `W/"${String(version)}-${chain}"`;
}

/**
 * What the chain validator is salted with, so that one build never revalidates a response
 * another build rendered (`S-13`, `H-11`).
 *
 * The last input to a resolved setting is its registry default, which lives in code — so the
 * salt has to change whenever the code might have. The version could not stand for the code:
 * every build said `0.1.0`, and an upgrade between two of them served a `304` for a default the
 * new build had changed. **An exact build is salted with its commit.** A build that cannot say
 * what it is — no commit, or uncommitted changes on top of one — is salted with the process that
 * issued the validator: the tag then dies with that process, which costs a client one full
 * response after a restart and never costs it a stale one.
 */
export function validatorSalt(build: BuildIdentity, instance: string): string {
  return isExactBuild(build)
    ? `${build.version}+${build.commit}`
    : `${build.version}+instance:${instance}`;
}

const ETAG = /^(?:W\/)?"(\d+)(?:-[0-9a-f]{1,64})?"$/;

/**
 * Parses `If-Match`.
 *
 * Required on PATCH. Two operators on one sensor's settings form is the realistic collision,
 * and under last-write-wins the second save silently reverts the first — on a channel limit
 * that is a missed alarm, and the audit log would show two clean successes.
 */
export function requireIfMatch(header: string | undefined): Precondition {
  if (header === undefined || header.trim() === '') {
    throw new ObjectError(
      'OBJECT_PRECONDITION_REQUIRED',
      'this request requires an If-Match header carrying the ETag the edit was based on',
      { context: { phase: 'precondition' } },
    );
  }
  return parseIfMatch(header);
}

/** Parses `If-Match` when it is optional — absent means no precondition. */
export function optionalIfMatch(header: string | undefined): Precondition {
  if (header === undefined || header.trim() === '') return { kind: 'none' };
  return parseIfMatch(header);
}

function parseIfMatch(header: string): Precondition {
  const match = ETAG.exec(header.trim());
  if (match === null) {
    // `*` is deliberately not accepted: it is a blind-overwrite opt-out, and if we ever want
    // one it should be a decision rather than a parsing accident.
    throw new ObjectError(
      'OBJECT_INVALID',
      `If-Match must be an ETag of the form W/"<version>", got ${header}`,
      { context: { phase: 'precondition' } },
    );
  }
  return { kind: 'version', expected: Number.parseInt(match[1] ?? '0', 10) };
}
