import type { BuildProfile, ProbeConfig } from '@ms/shared';
import { LISTENER_ID as FLOW_LISTENER_ID } from './listeners/flow-listener.js';

/**
 * What this build cannot do with a configuration its schema accepts (`B-08`).
 *
 * **The schema is one and the builds are two.** `flowListener` is a key in every probe's schema,
 * and a v1 probe carries no sensor type a flow collector could feed (`H-12`), so
 * `flowListener.enabled: true` validates there, binds nothing, and — until this — was mentioned
 * once, in a warning in a log nobody reads until a flow sensor has already failed. `config check`
 * is run by a person, or by an installer that shows a person its output, so it is where this
 * belongs.
 *
 * **Asked of the build's own dispatch tables, not of the profile's name.** `carriesFlow` is the
 * question `main.ts` asks before it constructs the listener, and both read it from here: a check
 * that matched on `'v1'` would go on reporting after a profile gained flow, and stay silent for a
 * third profile that has none.
 */

/** Whether this build has a sensor type the flow collector feeds. */
export function carriesFlow(listenerFor: ReadonlyMap<string, string>): boolean {
  return [...listenerFor.values()].includes(FLOW_LISTENER_ID);
}

export function buildProblems(
  config: Pick<ProbeConfig, 'flowListener'>,
  listenerFor: ReadonlyMap<string, string>,
  profile: BuildProfile,
): readonly string[] {
  const problems: string[] = [];
  if (config.flowListener.enabled && !carriesFlow(listenerFor)) {
    problems.push(
      `flowListener.enabled: is true, and this build (the ${profile} profile) carries no flow ` +
        `sensor type — the probe would start, open no flow port (${String(config.flowListener.port)}) ` +
        'and refuse every flow sensor by name. Set it to false, or install a build that carries ' +
        'flow monitoring',
    );
  }
  return problems;
}
