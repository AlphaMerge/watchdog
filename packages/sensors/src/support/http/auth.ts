/**
 * The `Authorization` header a stored HTTP credential produces (`T-13`, shared by `T-15`).
 *
 * **Both schemes in one place because the choice is the credential's, not the sensor's.** An
 * operator who swaps a device from basic authentication to a bearer token should not have to
 * edit every sensor under it, and two sensor types deciding that separately is two chances to
 * decide it differently.
 */
export function authorizationFor(credential: Readonly<Record<string, unknown>>): string | null {
  const token = credential['token'];
  if (typeof token === 'string' && token.trim() !== '') return `Bearer ${token.trim()}`;

  const username = credential['username'];
  const password = credential['password'];
  if (typeof username === 'string' && username !== '') {
    const encoded = Buffer.from(
      `${username}:${typeof password === 'string' ? password : ''}`,
    ).toString('base64');
    return `Basic ${encoded}`;
  }
  return null;
}

/**
 * The secret strings a credential holds, for scrubbing out of anything an operator will read.
 *
 * `T-15` substitutes credential values into request bodies and paths, and every failure message
 * a sensor produces is stored on the state log and returned by the API. "Credentials are
 * write-only" has to survive that: a password in the message of a check that failed is a
 * password the API hands to anybody who can read a sensor.
 */
export function secretsOf(credential: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const key of ['password', 'token']) {
    const value = credential[key];
    if (typeof value === 'string' && value !== '') out.push(value);
  }
  return out;
}

/** Replaces every known secret with a marker. Longest first, so one secret inside another goes. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('••••••');
  }
  return out;
}
