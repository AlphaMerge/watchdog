import type { Migration } from './types.js';

/**
 * A map's background image (`G-05`, `ADR-003`).
 *
 * **The bytes live here rather than on disk, and `ADR-003` Decision 1 is why.** The short version:
 * an operator who backs up the database has backed up their maps, and the moment a background is a
 * file under the data directory that stops being true — a restored database renders every map with
 * a hole in it and nobody finds out until the day they restore. Deletion becomes a foreign key
 * rather than a reaper, and `V2-06`'s clustering replicates rows but not one node's disk.
 *
 * **A table of its own, not a column on `map`.** `map` is read on every list and every view, and
 * `SELECT *` over a row carrying two megabytes of TOASTed image is a cost paid by every caller who
 * did not want it. Separating them also makes "has a background" a cheap `EXISTS` and makes
 * replacing one an insert-and-delete rather than an update to the row everything else reads.
 *
 * **One per map**, so the primary key is the map id. A gallery is a different feature.
 */
export const migration045: Migration = {
  id: 45,
  name: 'map-background',

  up: `
    CREATE TABLE map_background (
      map_id      bigint PRIMARY KEY REFERENCES map(id) ON DELETE CASCADE,

      -- The sniffed format, never the declared one (ADR-003 Decision 2). The check is the
      -- allow-list itself: a row that is not one of these cannot exist, so a future reader does
      -- not have to trust that every writer validated.
      media_type  text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),

      -- SHA-256 of the bytes, hex. The strong ETag the serving route answers with, and what makes
      -- "the same image" a fact rather than bookkeeping (ADR-003 Decision 4).
      digest      text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),

      width       integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
      height      integer NOT NULL CHECK (height BETWEEN 1 AND 4096),

      -- 2 MiB, and the constraint is here as well as in the service because the database is the
      -- last place that can refuse. An upload endpoint is where a caller who is merely
      -- authenticated decides how much disk to use.
      bytes       bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 2097152),

      uploaded_at timestamptz NOT NULL DEFAULT now(),
      -- No foreign key to user_account, the same as map_access: who uploaded it should outlive
      -- the account being deleted.
      uploaded_by text NOT NULL DEFAULT '' CHECK (length(uploaded_by) <= 64)
    );

    COMMENT ON TABLE map_background IS
      'One background image per map, stored as bytes (ADR-003). Separate from map so that '
      'listing maps never reads the image.';
  `,

  down: `
    DROP TABLE IF EXISTS map_background;
  `,
};
