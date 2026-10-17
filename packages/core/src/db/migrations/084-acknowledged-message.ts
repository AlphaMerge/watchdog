import type { Migration } from './types.js';

/**
 * What the acknowledgement in force said, kept beside it (`P-411`).
 *
 * An acknowledgement's message becomes the sensor's (`CAPABILITIES.MD §5.3`), and until now that
 * was the only place it was kept: `sensor_runtime.message`, which is the sensor's words and which
 * a hold for its probe, or a withholding, replaces with its own. The user decided that a sensor a
 * hold lets go onto Down (Acknowledged) says the acknowledgement's words again, never the hold's,
 * so they have to be somewhere a hold does not write. The history was tried first and is not that
 * place: an acknowledgement accepted on a stored Down while a hold had already been laid writes
 * no transition of its own, one made again in new words writes none either (`P-429`), a
 * retention anchor carries a housekeeping sentence, and rows a release wrote before this carry the
 * hold's words or nothing. The audit log is the acknowledgement's own record, but one entry is
 * written per call, on the object it was made on, and is pruned on its own horizon.
 *
 * **A column beside the other acknowledgement columns**, written with them and cleared with them:
 * on a recovery or an expiry (`writeRuntimes`), a resume (`writeStateChanges`) and a withdrawal
 * (`writeAcknowledgements`). The constraint keeps words from outliving the acknowledgement.
 * Unlike who acknowledged (014), it is on the hot path, because a decision reads it; it is NULL
 * on every row nobody has acknowledged.
 *
 * **The backfill reads each acknowledgement's own records**, both written in its transaction at
 * the instant `acknowledged_at` holds: the audit entry at that instant, when exactly one
 * acknowledgement was audited then (one call covers every sensor it reached), and otherwise the
 * transition into Down (Acknowledged) at that instant, which a retention anchor never is. An
 * acknowledgement neither kept, as one whose audit entry was pruned and whose transition was never
 * written, stays NULL and says nothing, never another's words.
 *
 * The rollback drops the constraint and the column, and the words with them: the sensor's own
 * message is untouched either way.
 */
export const migration084: Migration = {
  id: 84,
  name: 'acknowledged-message',

  up: `
    ALTER TABLE sensor_runtime
      ADD COLUMN acknowledged_message text,
      ADD CONSTRAINT sensor_runtime_acknowledged_message_ck
        CHECK (acknowledged_message IS NULL OR acknowledged_at IS NOT NULL);

    UPDATE sensor_runtime r
    SET acknowledged_message = coalesce(
      (SELECT CASE WHEN count(*) = 1 THEN min(a.summary ->> 'message') END
       FROM audit_log a
       WHERE a.action = 'sensor.acknowledged' AND a.at = r.acknowledged_at),
      (SELECT min(s.message) FROM sensor_state s
       WHERE s.sensor_id = r.object_id AND s.time = r.acknowledged_at
         AND s.state = 'down_acknowledged' AND s.cause = 'user' AND NOT s.carried)
    )
    WHERE r.acknowledged_at IS NOT NULL;

    COMMENT ON COLUMN sensor_runtime.acknowledged_message IS
      'What the acknowledgement in force said (P-411), which a sensor a hold lets go says again; '
      'NULL with no acknowledgement, or for one made before 084 that left no record of it.';
  `,

  down: `
    ALTER TABLE sensor_runtime
      DROP CONSTRAINT IF EXISTS sensor_runtime_acknowledged_message_ck,
      DROP COLUMN IF EXISTS acknowledged_message;
  `,
};
