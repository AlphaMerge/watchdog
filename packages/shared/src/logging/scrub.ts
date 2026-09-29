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
 * script that prints its key base64-encoded prints it. And it skips values shorter than
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
