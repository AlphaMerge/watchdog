import type { Logger } from '@ms/shared';
import type { Queryable } from '../pool.js';

/**
 * Migrations are TypeScript modules rather than loose `.sql` files.
 *
 * The tarball ships compiled JavaScript and nothing else, so a migration that lives in a `.sql`
 * file is one more thing the packaging step can forget to copy — and a schema change that is
 * missing at run time is the worst possible failure. As modules they are compiled, type-checked
 * and linted with everything else, and they cannot go missing.
 */
export interface Migration {
  /** Monotonic and stable. Never renumber a migration that has shipped. */
  readonly id: number;
  readonly name: string;
  /**
   * Applied inside a transaction, unless `transactional` is false.
   *
   * **Checksummed, every byte of it, once it has shipped** — messages and hints included. The
   * migrator stores a hash of `id`, `name` and `up`, and a database whose record disagrees with
   * the build refuses to start as drifted. So a shipped migration's `RAISE … HINT` cannot be
   * improved: rewording 004's licence hint would have stopped every installed core (`H-21`).
   * Better advice goes in the docs, or in code that runs outside a migration.
   */
  readonly up: string;
  /**
   * Every schema change ships with a tested rollback (CLAUDE.md). `null` means the change is
   * genuinely irreversible — data loss on the way back — and must be justified in a comment.
   */
  readonly down: string | null;
  /**
   * A few statements cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`, some
   * TimescaleDB policy calls). Those migrations give up atomicity and must be written so that
   * a partial application is safe to re-run.
   */
  readonly transactional?: boolean;
  /**
   * Rewrites existing rows in JavaScript, after `up` and before the migration is recorded
   * (`N-28`). For a rewrite SQL cannot say faithfully — one that has to be exactly what a
   * function of the application computes — and that is large enough to need batches.
   *
   * - **Only with `transactional: false`**, which the migrator checks: the step commits as it
   *   goes, so a failure leaves `up` applied and the migration unrecorded, and the next run
   *   applies `up` and this again. Both must be safe to run twice.
   * - **Batched by the step**, each statement its own, so that it holds no lock for longer than
   *   one batch takes. The migrator reports progress for as long as it runs.
   * - **Not in the checksum.** It is compiled code, and its text changes with the compiler; and
   *   what it calls may change after it ships. So it has to be a rewrite whose result may follow
   *   the code it calls, and that leaves its own output as it is.
   */
  readonly data?: (context: { readonly db: Queryable; readonly logger: Logger }) => Promise<void>;
}
