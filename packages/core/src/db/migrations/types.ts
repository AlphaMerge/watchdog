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
  /** Applied inside a transaction, unless `transactional` is false. */
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
}
