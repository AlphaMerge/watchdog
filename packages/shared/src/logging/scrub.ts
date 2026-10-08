/**
 * Keeping a secret out of somebody else's words (`S-19`, `A-44`).
 *
 * A check's message and a notification program's output are both text this system did not write
 * — a script's last lines, a driver's error, a server's banner — and both are read widely: the
 * state log and the notification log by every account that can read the sensor, the journal by
 * whoever runs the service. Either may repeat the secret it was just given. Shared, because a
 * sensor type on the probe and a delivery method in the core both need exactly this, and neither
 * should have a version of its own.
 *
 * **What it is, exactly, and no more:** every *exact* value it is handed, replaced wherever it
 * appears. It does not catch a secret that was encoded, split, hashed, or quoted with escapes; a
 * script that prints its key base64-encoded prints it, unless the caller hands it the secret's
 * `encodedForms` too, as a check's scrubber does. And it skips values shorter than
 * `MIN_SCRUBBED_LENGTH`: a three-character community string would otherwise turn every occurrence
 * of those three letters in every message into a marker, and a message nobody can read is a
 * diagnosis lost for a secret that was never much of one.
 */

/** Values shorter than this are left in the text; see above. */
export const MIN_SCRUBBED_LENGTH = 4;

export const SCRUBBED = '••••••';

/** Replaces every secret with the marker. Longest first, so one secret inside another goes too. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < MIN_SCRUBBED_LENGTH) continue;
    out = out.split(secret).join(SCRUBBED);
  }
  return out;
}

/**
 * A secret, and the forms a server echoes a request back in (`A-42`).
 *
 * A server that logs or reflects what it was sent does so encoded as the request carried it: a
 * query string percent-encoded, a form body with `+` for a space, a header in base64, a page
 * HTML-escaped, a JSON reply with its quotes escaped. Each is the secret, as readable to anybody
 * who decodes it as the secret is to anybody at all. The forms that are the secret unchanged
 * collapse into it.
 */
export function encodedForms(secret: string): string[] {
  const uri = encodeURIComponent(secret);
  const base64 = Buffer.from(secret, 'utf8').toString('base64');
  return [
    ...new Set([
      secret,
      uri,
      uri.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
      uri.replace(/%20/g, '+'),
      base64,
      base64.replace(/=+$/, ''),
      Buffer.from(secret, 'utf8').toString('base64url'),
      secret
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
      JSON.stringify(secret).slice(1, -1),
    ]),
  ];
}
