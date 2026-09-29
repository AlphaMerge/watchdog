import { sensorTypesFor, standardCatalogue, type SensorCatalogue } from '@ms/sensors';
import type { BuildProfile } from '@ms/shared';
import type { ApiServerOptions } from './api/server.js';
import { CompositeAuditSink } from './audit/store.js';
import { LibraryRepository } from './libraries/repository.js';
import { LibraryService } from './libraries/service.js';
import { MapRepository } from './maps/repository.js';
import { MapResolver } from './maps/resolver.js';
import { MapService } from './maps/service.js';
import { libraryAuditSinks, mapAuditSinks } from './objects/audit-composition.js';
import type { Reporting, ReportingOptions, startReporting } from './reports/wiring.js';

/**
 * What a core build constructs, by its profile (`H-12`).
 *
 * **One answer, asked by `main.ts` and by the test of the candidate's surface** (`H-13`). That
 * test builds a v1 server without a database and compares what it answers with the table in
 * `docs/runbook-field-test.md`. If the profile were decided inline in `main.ts`, the test would
 * have to repeat the decision, and it would then be testing its own copy.
 */

/**
 * The sensor types this core offers: its profile's share of the built-in set.
 *
 * It is the set its probes carry, so a v1 core never offers a type that a v1 probe would refuse.
 * Registered once and then sealed, because a type appearing later would leave two probes
 * disagreeing about what a sensor is.
 */
export function coreCatalogue(profile: BuildProfile): SensorCatalogue {
  return standardCatalogue(sensorTypesFor(profile));
}

/** The v2 subsystems that share `main` with the release candidate, where the build has them. */
export interface V2Subsystems {
  readonly maps?: MapService;
  readonly mapResolver?: MapResolver;
  readonly libraries?: LibraryService;
  readonly reporting?: Reporting;
}

/**
 * Maps, libraries and reports, constructed and started, in the full profile only.
 *
 * **The v1 build constructs none of them**: no routes, no public-map prefix, no report sweep, no
 * `recover()` and no formatter pool. `ApiServer` already registers nothing for a service it is
 * not given, so leaving them out covers the whole of the API's part. Any profile that is not
 * `full` gets nothing. A third profile starts empty and has to ask for each subsystem.
 */
export async function startV2Subsystems(
  profile: BuildProfile,
  options: ReportingOptions,
): Promise<V2Subsystems> {
  if (profile !== 'full') return {};
  const reports = await loadReporting();
  const { db, logger, access, history, auditSinks } = options;
  return {
    // **The maps API, which `G-01` wrote and nothing mounted.** `ApiServer` takes the service as
    // an option and does not register the routes without it. A build with no maps therefore
    // has no maps API, which is not the same as having no maps. The shape was right and the
    // wiring was wrong: until `main.ts` passed one, only a test did, so every route `G-01`
    // shipped answered 404 in the service somebody actually ran.
    maps: new MapService({
      db,
      repository: new MapRepository(),
      audit: new CompositeAuditSink(mapAuditSinks(auditSinks)),
      logger,
    }),
    // Reads through the same `AccessService` as the object API and the same `HistoryService` as
    // the sensor pages. A widget must not become a second, more permissive way to read a sensor,
    // and a tile's number must not look fresher than the detail page's.
    mapResolver: new MapResolver({ db, access, history }),
    // Mounted with the routes, for the reason given for maps above (`L-01`).
    libraries: new LibraryService({
      db,
      repository: new LibraryRepository(),
      audit: new CompositeAuditSink(libraryAuditSinks(auditSinks)),
      logger,
    }),
    // Built in their own module, so that one call either starts reports or does not (`E-01`…`E-12`).
    reporting: await reports.startReporting(options),
  };
}

/**
 * The reports module, loaded only when a build asks for it (`H-19`).
 *
 * **Imported dynamically, so that a v1 core never loads `pdfkit` and `fontkit`.** A static import
 * here put the PDF stack into every build's start-up, whether or not it constructed a report.
 * Exported so that `module-graph.test.ts` loads the full profile's graph the way this module does.
 */
export async function loadReporting(): Promise<{ readonly startReporting: typeof startReporting }> {
  return import('./reports/wiring.js');
}

/** What `ApiServer` is given of them: each one that exists, and nothing for one that does not. */
export function v2ApiOptions(
  v2: V2Subsystems,
): Pick<ApiServerOptions, 'maps' | 'mapResolver' | 'libraries' | 'reports'> {
  return {
    ...(v2.maps === undefined ? {} : { maps: v2.maps }),
    ...(v2.mapResolver === undefined ? {} : { mapResolver: v2.mapResolver }),
    ...(v2.libraries === undefined ? {} : { libraries: v2.libraries }),
    ...(v2.reporting === undefined ? {} : { reports: v2.reporting.api }),
  };
}
