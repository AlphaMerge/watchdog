import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { scrubberOf } from '../support/secrets.js';
import { SCRIPT_SCHEMA, SCRIPT_SECRET_DESTINATIONS, runScript } from './exe-script-shared.js';

/**
 * One number from a program this probe was told it may run (`T-19`).
 *
 * **The escape hatch, and the reason the plugin contract does not have to cover everything.**
 * Every sensor type in this catalogue answers a question somebody anticipated. This one answers
 * the question nobody did: a vendor's CLI, a business metric out of a report, a licence count, a
 * queue depth from an application with no API. It is what stops "we need a sensor for X" being a
 * release.
 *
 * **The program comes from a directory the operator configured on the probe**, never from a path
 * in these parameters — `support/script/resolve.ts` is the whole of that argument. Without it,
 * anyone who may add a sensor may run any command as the account the probe holds its credentials
 * in.
 *
 * **Nothing is run through a shell**, ever. Arguments go one per entry, so a space or a quote in
 * one is a character rather than a syntax.
 *
 * **A non-zero exit is a failed check, and Warning is not one of the outcomes.** PRTG's format
 * has a Warning code and this system does not honour it, deliberately: Warning here comes from a
 * limit on a channel (`M-04`), which is visible, editable and inheritable — where a Warning baked
 * into a script is a threshold nobody can see or change without editing the script on every
 * probe. The code the script asked for is named in the message rather than dropped.
 */
export const exeScript: SensorType = {
  id: 'exe.script',
  category: 'Custom',
  costHint: 'medium',
  // The reason `P-03` exists. A fault in code somebody else wrote must not take the probe down.
  isolation: 'process',
  secretDestinations: SCRIPT_SECRET_DESTINATIONS,

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['program'],
    properties: {
      ...SCRIPT_SCHEMA,
      format: {
        enum: ['prtg', 'number', 'json'],
        default: 'prtg',
        title: 'Output format',
        description:
          '`prtg` reads `returncode:value:message`, which is what an existing PRTG EXE script ' +
          'already prints. `number` reads the whole of stdout as one number, which is what a ' +
          'one-line shell script naturally produces. `json` reads {"value":…,"message":…}.',
      },
      valueName: {
        type: 'string',
        maxLength: 60,
        default: 'Value',
        title: 'Channel name',
        description: 'What to call the reading on the graph. The channel key is always `value`.',
      },
      unit: { type: 'string', maxLength: 20, default: '', title: 'Unit' },
    },
  },

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const name = typeof params['valueName'] === 'string' ? params['valueName'].trim() : '';
    return [
      { key: 'value', name: name === '' ? 'Value' : name, unit: unitOf(params), isPrimary: true },
      // Not the reading, but worth having: a script that took four seconds yesterday and forty
      // today is a fault, and nothing in the value it returns would say so.
      { key: 'runtime', name: 'Run time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { parseSimple } = await import('../support/script/parse.js');
    const raw = context.params['format'];
    const format = raw === 'number' || raw === 'json' ? raw : 'prtg';

    const run = await runScript(context);
    const output = parseSimple(run.stdout, format, 'value', scrubberOf(context));
    const value = output.channels[0]?.value ?? 0;

    return {
      channels: [
        { key: 'value', value },
        { key: 'runtime', value: run.durationMs },
      ],
      message:
        output.message === ''
          ? `${String(value)}${unitOf(context.params)} in ${String(run.durationMs)} ms`
          : output.message,
    };
  },
};

function unitOf(params: Readonly<Record<string, unknown>>): string {
  return typeof params['unit'] === 'string' ? params['unit'] : '';
}
