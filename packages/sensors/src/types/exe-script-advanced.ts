import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { scrubberOf } from '../support/secrets.js';
import { SCRIPT_SCHEMA, SCRIPT_SECRET_DESTINATIONS, runScript } from './exe-script-shared.js';

/**
 * Many numbers from a program this probe was told it may run (`T-19`).
 *
 * **Separate from `exe.script` for the reason `http.advanced` is separate from `http.request`:**
 * most script sensors report one number, and a form that made everybody declare a channel list
 * would make the common case the awkward one.
 *
 * **The channels come from the program, not from this form**, which is the whole point — a script
 * that starts reporting a new metric gets a new channel on its next scan, because the core
 * creates channels the first time a sensor mentions them (`S-07`). What the form does declare is
 * *which* channel the sensor is judged by, because that one cannot be discovered: a sensor with
 * no primary is a sensor nothing alarms on.
 *
 * **Three shapes are accepted, and two of them are not ours.** This system's
 * `{"channels":[…]}`, PRTG's `{"prtg":{"result":[…]}}`, and — since `T-24` — the XML form,
 * `<prtg><result><channel>…`, which is what PRTG's own EXE and Script Advanced sensors emit *by
 * default*. Accepting all three costs one branch and saves rewriting every script an installation
 * already has. The format is decided by what the program printed rather than by a setting: a
 * document starting with `<` is XML and everything else is JSON, so nobody has to describe their
 * own script to the form.
 */
export const exeScriptAdvanced: SensorType = {
  id: 'exe.script.advanced',
  category: 'Custom',
  costHint: 'medium',
  isolation: 'process',
  secretDestinations: SCRIPT_SECRET_DESTINATIONS,

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['program'],
    properties: {
      ...SCRIPT_SCHEMA,
      primaryChannel: {
        type: 'string',
        minLength: 1,
        maxLength: 40,
        pattern: '^[A-Za-z0-9_.-]+$',
        default: 'value',
        title: 'Primary channel',
        description:
          'The key of the channel this sensor is judged by. The program must return it every ' +
          'scan; the rest of what it returns becomes channels on their own the first time they ' +
          'appear. For a PRTG-format script this is the first channel’s name in lower case with ' +
          'spaces as underscores — “Free Space” is `free_space`.',
      },
      primaryName: {
        type: 'string',
        maxLength: 60,
        default: '',
        title: 'Primary channel name',
        description: 'Empty uses whatever the program calls it.',
      },
      primaryUnit: { type: 'string', maxLength: 20, default: '', title: 'Primary channel unit' },
    },
  },

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const key = typeof params['primaryChannel'] === 'string' ? params['primaryChannel'] : 'value';
    const name = typeof params['primaryName'] === 'string' ? params['primaryName'].trim() : '';
    const unit = typeof params['primaryUnit'] === 'string' ? params['primaryUnit'] : '';
    return [
      { key, name: name === '' ? key : name, unit, isPrimary: true },
      { key: 'runtime', name: 'Run time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { parseAdvanced } = await import('../support/script/parse.js');
    const primary =
      typeof context.params['primaryChannel'] === 'string'
        ? context.params['primaryChannel']
        : 'value';

    const run = await runScript(context);
    const output = parseAdvanced(run.stdout, primary, scrubberOf(context));

    const readings = output.channels
      // `runtime` is this sensor's own, so a script cannot overwrite it with something else.
      .filter((channel) => channel.key !== 'runtime')
      .map((channel) => ({
        key: channel.key,
        value: channel.value,
        ...(channel.name === undefined ? {} : { name: channel.name }),
        ...(channel.unit === undefined ? {} : { unit: channel.unit }),
      }));

    return {
      channels: [...readings, { key: 'runtime', value: run.durationMs }],
      message:
        output.message === ''
          ? `${String(readings.length)} channel${readings.length === 1 ? '' : 's'} in ` +
            `${String(run.durationMs)} ms`
          : output.message,
    };
  },
};
