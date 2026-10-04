/**
 * The `MS_*` variables this product sets or reads itself, none of which is configuration (`H-32`).
 *
 * The prefix is shared. `loadConfig` takes `MS_<SECTION>__<SETTING>` as a setting when its first
 * segment names a section of the schema, and reports every other `MS_*` variable as one the
 * configuration ignored — in the start log (`ignoredEnv`) and in `config check`
 * (`ignored MS_*`) — because a misspelt section, `MS_DATABSE__PASSWORD`, looks exactly like
 * that and is otherwise silent. The variables below are not mistakes, and reporting them taught
 * an operator to skip the line: the packaged launcher exports `MS_BUILD_VERSION`, so every start
 * and every check on every installation named it (found by `H-15`).
 *
 * **One list, with who sets each name**, rather than a special case in the loader. The loader
 * leaves these out of what it reports; `deploy-scripts.test.ts` reads every `MS_*` name in the
 * launcher `scripts/package.sh` writes and in everything under `deploy/`, and fails on one that
 * is neither a setting nor here — so a variable a launcher, a unit or `ms-setup` starts to set
 * cannot become a line every installation reports — and on a name here that nothing reads any
 * more. None of them may name a section, or the loader would read it as a setting.
 */
export const PRODUCT_ENV: ReadonlyMap<string, string> = new Map([
  ['MS_CONFIG_FILE', 'which file to read; set by the units, the WinSW services and the launchers'],
  [
    'MS_BUILD_VERSION',
    'exported by the packaged launcher; the version of a build with no build.json',
  ],
  ['MS_BUILD_PROFILE', 'the profile of a build with no build.json, and package.sh’s input'],
  ['MS_BUILD_COMMIT', 'package.sh’s input: the commit it stamps'],
  ['MS_BUILD_DIRTY', 'package.sh’s input: whether that tree had changes'],
  ['MS_NODE', 'the node binary the launchers run'],
  ['MS_TARGET_POLICY', 'set by the probe from probe.targetPolicy, for its workers'],
  ['MS_POWERSHELL', 'set by the probe from probe.powerShellPath, for its workers'],
  ['MS_SCRIPT_DIR', 'set by the probe from probe.scriptDir, for the programs it runs'],
  ['MS_SETUP_NO_START', 'ms-setup: install, start nothing'],
  ['MS_SETUP_UNIT_DIR', 'ms-setup: where the units go'],
  ['MS_SETUP_LEGACY_UNIT_DIR', 'ms-setup: where an earlier release put them'],
  ['MS_SETUP_PING_RANGE', 'ms-setup: the ping_group_range it reads'],
  ['MS_SETUP_SYSCTL_DIR', 'ms-setup: where it writes the ping sysctl'],
  ['MS_RECOVER_BASE_SEC', 'ms-recover: the first wait'],
  ['MS_RECOVER_CAP_SEC', 'ms-recover: the longest wait'],
  ['MS_RECOVER_HEALTHY_SEC', 'ms-recover: how long up counts as recovered'],
  ['MS_RECOVER_NOW', 'ms-recover: the clock, for its tests'],
  ['MS_RECOVER_SELF', 'ms-recover: where it is installed'],
  ['MS_RECOVER_STATE_DIR', 'ms-recover: where it keeps its state'],
]);

/** Whether `name` is one of the variables above, which `loadConfig` never reports as ignored. */
export function isProductEnv(name: string): boolean {
  return PRODUCT_ENV.has(name);
}
