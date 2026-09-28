/**
 * The sources the core's own producers report results under (`P-228`).
 *
 * They call `IngestionService.acceptResults` directly and are trusted, because they run in this
 * process and compute sensors no probe runs. A probe reaches ingestion only through
 * `acceptProbeResults`, so a probe that called itself `factory` could not borrow that trust — but
 * it would still read as one in every log line and in the replay pacer. So the registry will not
 * enrol a probe under any of these names, and a producer added here is reserved with them.
 */
export const IN_PROCESS_SOURCE = {
  factory: 'factory',
  coreHealth: 'core-health',
  probeHealth: 'probe-health',
} as const;

export const IN_PROCESS_SOURCES: ReadonlySet<string> = new Set(Object.values(IN_PROCESS_SOURCE));
