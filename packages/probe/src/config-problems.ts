import type { BuildProfile, ConfigFindings, ProbeConfig } from '@ms/shared';
import { LISTENER_ID as FLOW_LISTENER_ID } from './listeners/flow-listener.js';
import { rootScriptsNote } from './root-scripts.js';

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

/**
 * What `config check` says of `probe.nameResolver: gate` (`P-432`): a note, since the probe starts
 * and resolves with it, naming where its names are asked. Its name check (S6) asks each name's
 * DNS servers first: a name they answer within 250 ms is asked on the probe's own lanes, one they
 * do not in the lookup helper, as is every name while the check is off. Whether the system's
 * settings let the check vouch for them (`nscd`, an NSS module, `LD_PRELOAD`, ...) is a property
 * of the host this command does not read, so the probe logs it at start and reports it as
 * `nameCheckState`.
 */
export const GATE_NOTE =
  'probe.nameResolver: is gate: a name its DNS servers answer within 250 ms is asked on the ' +
  "probe's own lookup lanes, and one they do not in the lookup helper (ms-probe: lookups), as is " +
  "every name while the name check is off. The probe logs at start what the system's name " +
  'settings say of the check, and Probe Health reports it as nameCheckState';

export function buildFindings(
  config: Pick<ProbeConfig, 'flowListener'> & {
    probe: Pick<
      ProbeConfig['probe'],
      'processUid' | 'processGid' | 'scriptDir' | 'allowScriptsAsRoot'
    > &
      Partial<Pick<ProbeConfig['probe'], 'nameResolver'>>;
  },
  listenerFor: ReadonlyMap<string, string>,
  profile: BuildProfile,
): ConfigFindings {
  const warnings: string[] = [];
  // A note and not a warning: whether it applies depends on the account the probe runs as,
  // which the file does not say (`P-276`).
  const asRoot = rootScriptsNote(config.probe);
  const notes = asRoot === undefined ? [] : [asRoot];
  if (config.probe.nameResolver === 'gate') notes.push(GATE_NOTE);
  if (config.flowListener.enabled && !carriesFlow(listenerFor)) {
    warnings.push(
      `flowListener.enabled: is true, and this build (the ${profile} profile) carries no flow ` +
        `sensor type — the probe starts, opens no flow port (${String(config.flowListener.port)}) ` +
        'and refuses every flow sensor by name. Set it to false, or install a build that carries ' +
        'flow monitoring',
    );
  }
  return { warnings, notes };
}
