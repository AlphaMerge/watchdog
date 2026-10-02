import type { BuildProfile, ConfigFindings, ProbeConfig } from '@ms/shared';
import { LISTENER_ID as FLOW_LISTENER_ID } from './listeners/flow-listener.js';

/**
 * What this build cannot do with a configuration its schema accepts (`B-08`).
 *
 * **The schema is one and the builds are two.** `flowListener` is a key in every probe's schema,
 * and a v1 probe carries no sensor type a flow collector could feed (`H-12`), so
 * `flowListener.enabled: true` validates there, binds nothing, and — until this — was mentioned
 * once, in a warning in a log nobody reads until a flow sensor has already failed. `config check`
 * is run by a person, so it is where this belongs.
 *
 * **A warning, not a problem.** The probe starts with this setting and warns; the installer gates
 * an upgrade on the check's exit code; so a finding that failed the check would hold a v1 probe
 * on its old version over a setting that does nothing. It is said and the check passes.
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

export function buildFindings(
  config: Pick<ProbeConfig, 'flowListener'>,
  listenerFor: ReadonlyMap<string, string>,
  profile: BuildProfile,
): ConfigFindings {
  const warnings: string[] = [];
  if (config.flowListener.enabled && !carriesFlow(listenerFor)) {
    warnings.push(
      `flowListener.enabled: is true, and this build (the ${profile} profile) carries no flow ` +
        `sensor type — the probe starts, opens no flow port (${String(config.flowListener.port)}) ` +
        'and refuses every flow sensor by name. Set it to false, or install a build that carries ' +
        'flow monitoring',
    );
  }
  return { warnings };
}
