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
  /**
   * Why this build leaves a sensor type out, or undefined when it carries it (`H-12`).
   *
   * **Withheld is not unknown.** A v1 build has no Windows types, and the shipped Windows server
   * template names three of them beside its ping. Refused whole, that template would take the
   * ping with it and log an error on every start of every v1 installation. So a withheld type's
   * sensors are left out of the template, and said so; a type nobody ever built is still
   * refused by name.
   */
  withheld?: (id: string) => string | undefined;
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

  const register = (template: DeviceTemplate, source: string): void => {
    catalogue.register(withoutWithheld(template, source, options.withheld, logger), source);
  };

  for (const template of BUILT_IN_DEVICE_TEMPLATES) register(template, 'built-in');

  if (options.directory !== undefined && options.directory !== '') {
    await loadDirectory(register, options.directory, logger);
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

/** `template` without the sensors of any type this build withholds, and a line saying which. */
function withoutWithheld(
  template: DeviceTemplate,
  source: string,
  withheld: ((id: string) => string | undefined) | undefined,
  logger: Logger,
): DeviceTemplate {
  // A file's template has not been validated yet; one without a sensor list is the catalogue's
  // to refuse, with the reason, and nothing here to trim.
  if (withheld === undefined || !Array.isArray(template.sensors)) return template;
  // Nor are its specs: one that is not an object with a type is likewise left for the catalogue.
  const typeOf = (spec: unknown): string | undefined =>
    typeof spec === 'object' && spec !== null && 'type' in spec && typeof spec.type === 'string'
      ? spec.type
      : undefined;
  const leftOut = template.sensors
    .map((spec: unknown) => typeOf(spec))
    .filter((type): type is string => type !== undefined && withheld(type) !== undefined);
  if (leftOut.length === 0) return template;
  logger.info(
    { id: template.id, source, left: leftOut, because: [...new Set(leftOut.map(withheld))] },
    'a device template leaves out sensor types this build does not carry',
  );
  return {
    ...template,
    sensors: template.sensors.filter((spec: unknown) => {
      const type = typeOf(spec);
      return type === undefined || withheld(type) === undefined;
    }),
  };
}

async function loadDirectory(
  register: (template: DeviceTemplate, source: string) => void,
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
      register({ id: '', name: '', description: '', match: {}, sensors: [] }, path);
      logger.error({ ...describeError(error), path }, 'a device template file is not JSON');
      continue;
    }
    // An array so one file can hold a related set, which is how anybody writes them: a vendor's
    // switches, routers and firewalls belong together.
    for (const one of Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]) {
      register(one as DeviceTemplate, path);
    }
  }
}
