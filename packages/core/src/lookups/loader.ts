import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { describeError, type Logger } from '@ms/shared';
import { BUILT_IN_LOOKUPS } from './built-in.js';
import { LookupCatalogue } from './catalogue.js';
import type { LookupDefinition } from './definition.js';

export interface LoadLookupsOptions {
  /** Where an operator's own definitions live. Absent or missing is normal, not an error. */
  directory?: string;
  logger: Logger;
}

/**
 * Builds the catalogue: what this build ships, then what the operator wrote (`M-06`).
 *
 * Order is the whole mechanism. Built-ins register first, so a custom file with the same id
 * replaces one — `CAPABILITIES.MD §1.2`'s override-by-id, which is how an operator fixes a
 * shipped lookup for a device that disagrees with the RFC without waiting for a release.
 *
 * **A missing directory is not a problem.** Most installations never write a lookup, and a
 * warning on every start for a directory nobody needs is a warning everyone learns to ignore.
 * A directory that exists and cannot be read *is* reported: that is a permissions mistake, and
 * the sensors that depend on it will be judged by nothing.
 */
export async function loadLookups(options: LoadLookupsOptions): Promise<LookupCatalogue> {
  const catalogue = new LookupCatalogue();
  const logger = options.logger.child({ component: 'lookups' });

  for (const definition of BUILT_IN_LOOKUPS) {
    if (!catalogue.register(definition, 'built-in', true)) {
      // A built-in that fails its own validation is a programming error, not an operator's.
      logger.error({ id: definition.id }, 'a built-in lookup is invalid and was not registered');
    }
  }

  const directory = options.directory;
  if (directory !== undefined) {
    for (const file of await listJson(directory, logger)) {
      const path = join(directory, file);
      const definition = await readDefinition(path, catalogue, logger);
      if (definition === null) continue;
      if (catalogue.register(definition, path)) {
        logger.info({ id: definition.id, path }, 'loaded a lookup');
      }
    }
  }

  const problems = catalogue.problems();
  if (problems.length > 0) {
    // Loudly, once, with everything wrong in it. A lookup that failed to load leaves its
    // channels judged by nothing, and a sensor reading Up for that reason is the worst outcome
    // this whole file exists to avoid.
    logger.error(
      { count: problems.length, problems },
      'some lookups were refused; sensors using them will have no lookup state',
    );
  }
  logger.info({ loaded: catalogue.ids().length, refused: problems.length }, 'lookups ready');
  return catalogue.seal();
}

async function listJson(directory: string, logger: Logger): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.json')
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    logger.error(
      { directory, err: describeError(error) },
      'could not read the lookup directory; only built-in lookups are available',
    );
    return [];
  }
}

async function readDefinition(
  path: string,
  catalogue: LookupCatalogue,
  logger: Logger,
): Promise<LookupDefinition | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    logger.error({ path, err: describeError(error) }, 'could not read a lookup file');
    return null;
  }

  try {
    // Cast, then validated: `register` runs the schema over it before it is held, so the only
    // thing assumed here is that it parsed.
    return JSON.parse(text) as LookupDefinition;
  } catch (error: unknown) {
    // Recorded rather than logged alone, so `GET /lookups` shows it beside the ones that
    // loaded. An operator debugging a lookup should not have to read the journal.
    catalogue.refuse(path, path, [`not valid JSON: ${describeError(error).message}`]);
    logger.error({ path, err: describeError(error) }, 'a lookup file is not valid JSON');
    return null;
  }
}
