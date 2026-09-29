import type { Migration } from './types.js';

/**
 * Who a message did not reach, counted by reason, and out of the error (`A-44`).
 *
 * **The notification log named accounts to anybody who could read the sensor.** `M-19` kept who
 * a message missed as `skipped_recipients` — `"bob" in group "NOC" (disabled)` — and a message
 * that reached nobody carried the same names in `last_error`, after "nobody to send to: ". The log
 * serves both to every reader of the sensor, while `M-20` makes the logins, the groups and who is
 * in them an administrator's. The log now shows an administrator the names and anybody else
 * `skipped_counts`, which this adds: how many were skipped for each reason, and nothing about who.
 *
 * **The names leave the error for the column that holds them.** A row whose error is "nobody to
 * send to: <names>" becomes "nobody to send to", with the names in `skipped_recipients`, which is
 * where a build from here on writes them for a failure as for a partial send. Left in the error,
 * they would reach every reader of the log for as long as the row is kept.
 *
 * **The counts of rows written before this are read back from the names.** Each clause ends with
 * its reason in brackets, so a reason followed by the next clause or the end is counted. A name
 * that itself holds " (disabled), " miscounts, and a clause the 2,000-character column cut short
 * is not counted: the counts of old rows are the best the text allows, and the new rows' are
 * exact.
 *
 * **The rollback is lossless but for one thing.** It puts the names back after "nobody to send
 * to: " and clears the column, which is what the build before this wrote, and drops the counts,
 * which that build never had. What it cannot restore is the names of a message that missed so many
 * people that they ran past 2,000 characters: the error had no limit and the column has, so this
 * keeps the first 2,000 and the rollback returns those. The newer rows are the same, because this
 * build writes the names only to the column.
 */
export const migration065: Migration = {
  id: 65,
  name: 'skipped-counts',

  up: `
    ALTER TABLE notification_request
      ADD COLUMN skipped_counts jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(skipped_counts) = 'object');

    -- "nobody to send to: " is nineteen characters, so the names start at the twentieth. At least
    -- one character after it, or there are no names to move and the row is left as it was.
    UPDATE notification_request
      SET skipped_recipients = left(substr(last_error, 20), 2000),
          last_error = 'nobody to send to'
      WHERE last_error LIKE 'nobody to send to: _%' AND skipped_recipients = '';

    -- Brackets for the literal parentheses, so the pattern needs no escaping to survive the
    -- string it is written in.
    UPDATE notification_request r
      SET skipped_counts = c.counts
      FROM (
        SELECT id, jsonb_object_agg(reason, n) AS counts
        FROM (
          SELECT one.id, m.parts[1] AS reason, count(*)::int AS n
          FROM notification_request one,
               regexp_matches(
                 one.skipped_recipients,
                 ' [(](no such account|no such group|no members|disabled|no email address|may not see this sensor)[)](?=, |$)',
                 'g'
               ) AS m(parts)
          WHERE one.skipped_recipients <> ''
          GROUP BY one.id, m.parts[1]
        ) per_reason
        GROUP BY id
      ) c
      WHERE r.id = c.id;
  `,

  down: `
    UPDATE notification_request
      SET last_error = 'nobody to send to: ' || skipped_recipients,
          skipped_recipients = ''
      WHERE last_error = 'nobody to send to' AND skipped_recipients <> '';

    ALTER TABLE notification_request DROP COLUMN IF EXISTS skipped_counts;
  `,
};
