import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `scripts/lib/release-docs.txt`, which says what a release ships of `docs/` (`H-51`), read the
 * way `package.sh` reads it, with each line it would refuse.
 */
export interface ReleaseDocs {
  readonly ship: readonly string[];
  readonly keep: readonly string[];
  readonly problems: readonly string[];
}

export function parseReleaseDocs(text: string): ReleaseDocs {
  const ship: string[] = [];
  const keep: string[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const [verdict, path, ...rest] = line.split(/\s+/u);
    const where = `line ${String(index + 1)}`;
    if (path === undefined || rest.length > 0) problems.push(`${where}: "${line}"`);
    else if (verdict === 'ship') ship.push(path);
    else if (verdict === 'keep') keep.push(path);
    else problems.push(`${where}: "${verdict ?? ''}" is neither ship nor keep`);
  });
  return { ship, keep, problems };
}

/** The list in the repository at `repoRoot`. */
export function releaseDocs(repoRoot: string): ReleaseDocs {
  return parseReleaseDocs(
    readFileSync(join(repoRoot, 'scripts', 'lib', 'release-docs.txt'), 'utf8'),
  );
}
