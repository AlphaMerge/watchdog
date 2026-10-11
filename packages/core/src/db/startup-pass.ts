import { createHash } from 'node:crypto';
import type { Queryable } from './pool.js';

/**
 * Whether a start-up pass has anything to do, by the rules it last finished under (`P-333`).
 *
 * **Only for a pass that applies rules.** S-18's declared limits and P-323's declared primaries
 * bring stored rows up to what this build declares; on every start but the first after a change
 * they found nothing, having read every sensor to find it. Two passes stay on every start, by the
 * user's decision of 2026-10-12, because what they look for is not a rule:
 * - P-177's alarm reconciliation repairs what a crash, or a restart mid-drain, lost. A lost arm
 *   is a fact about the last stop, and no version of anything says whether one happened.
 * - P-358's stored-parameters check writes nothing, and what it finds is held in memory, as Core
 *   Health's `sensorsWithInvalidParams` and the `?invalidParams=true` list: skipped, both would
 *   say "not known" until the next change. It also judges a hand edit of `sensor_config`.
 *
 * `rules` is whatever the pass says its rules are, as a string it can compute at start: a hash of
 * what it applies when that is data (S-18), or the exact build when it is code (P-323). Null is
 * "cannot say": the pass runs, and nothing is recorded, so the next start runs it again.
 */
export interface StartupPassRules {
  readonly name: string;
  readonly rules: string | null;
}

/** A short, fixed-length `rules` for anything a pass can describe as JSON. */
export function rulesDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}`;
}

/** True unless this pass last finished under exactly these rules. */
export async function passIsDue(
  q: Pick<Queryable, 'query'>,
  pass: StartupPassRules,
): Promise<boolean> {
  if (pass.rules === null) return true;
  const rows = await q.query<{ rules: string }>('SELECT rules FROM startup_pass WHERE name = $1', [
    pass.name,
  ]);
  return rows[0]?.rules !== pass.rules;
}

/**
 * Records that the pass finished under these rules. Called only once it has, so a pass that
 * stopped short, failed, or left anything for later runs again at the next start.
 */
export async function recordPass(
  q: Pick<Queryable, 'query'>,
  pass: StartupPassRules,
): Promise<void> {
  if (pass.rules === null) return;
  await q.query(
    `INSERT INTO startup_pass (name, rules, completed_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET rules = EXCLUDED.rules, completed_at = EXCLUDED.completed_at`,
    [pass.name, pass.rules],
  );
}
