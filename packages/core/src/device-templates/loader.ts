import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { describeError, type Logger } from '@ms/shared';
import { BUILT_IN_DEVICE_TEMPLATES } from './built-in.js';
import { DeviceTemplateCatalogue } from './catalogue.js';
import type { DeviceTemplate } from './definition.js';

export interface LoadDeviceTemplatesOptions {
  /** Where an operator's own templates live. Absent or missing is normal, not an error. */
  directory?: string;
  logger: Logger;
  /** So a template naming a sensor type that does not exist is refused by name (`D-03`). */
  knownSensorType: (id: string) => boolean;
  /** And so one naming a type it cannot supply the required parameters for is refused too. */
  validateParams?: (id: string, params: Readonly<Record<string, unknown>>) => string[];
}

/**
 * Builds the catalogue: what this build ships, then what the operator wrote (`D-03`).
 *
 * Identical in shape to `loadLookups`, and deliberately so — an operator who has learnt where
 * lookups go and how an override works knows this too. Order is the mechanism: built-ins
 * register first, so a file with the same id replaces one, which is how somebody fixes a shipped
 * template for the devices they actually have without waiting for a release.
 *
 * **A missing directory is not a problem**; a directory that exists and cannot be read is, and
 * is reported, because that is a permissions mistake and the templates it holds will silently
 * not apply.
 */
export async function loadDeviceTemplates(
  options: LoadDeviceTemplatesOptions,
): Promise<DeviceTemplateCatalogue> {
  const catalogue = new DeviceTemplateCatalogue(options.knownSensorType, options.validateParams);
  const logger = options.logger.child({ component: 'device-templates' });

  for (const template of BUILT_IN_DEVICE_TEMPLATES) catalogue.register(template, 'built-in');

  if (options.directory !== undefined && options.directory !== '') {
    await loadDirectory(catalogue, options.directory, logger);
  }

  const problems = catalogue.problems();
  if (problems.length > 0) {
    for (const problem of problems) {
      logger.error(
        { id: problem.id, source: problem.source, problems: problem.problems },
        'a device template was refused',
      );
    }
  }
  logger.info(
    { templates: catalogue.all().length, refused: problems.length },
    'device templates loaded',
  );
  return catalogue.seal();
}

async function loadDirectory(
  catalogue: DeviceTemplateCatalogue,
  directory: string,
  logger: Logger,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.error(
      { ...describeError(error), directory },
      'the device template directory could not be read',
    );
    return;
  }

  for (const entry of entries.sort()) {
    if (extname(entry).toLowerCase() !== '.json') continue;
    const path = join(directory, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      catalogue.register({ id: '', name: '', description: '', match: {}, sensors: [] }, path);
      logger.error({ ...describeError(error), path }, 'a device template file is not JSON');
      continue;
    }
    // An array so one file can hold a related set, which is how anybody writes them: a vendor's
    // switches, routers and firewalls belong together.
    for (const one of Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]) {
      catalogue.register(one as DeviceTemplate, path);
    }
  }
}
