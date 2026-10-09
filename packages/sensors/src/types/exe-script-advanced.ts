import { clipText, RESULT_LIMITS } from '@ms/shared';
import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { scrubberOf } from '../support/secrets.js';
import { SCRIPT_SCHEMA, SCRIPT_SECRET_DESTINATIONS, runScript } from './exe-script-shared.js';

/** This type's own channel: how long the program took. */
const RUNTIME = 'runtime';

/** What `withRuntimeNotKept` appends. The key only, which is ours: never the program's value. */
export const RUNTIME_NOT_KEPT =
  ' (the program’s own “runtime” channel was not kept: runtime is how long the program took)';

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
        // Not `runtime`, this sensor's own channel (`P-349`): the type's reading would replace
        // the program's, and the sensor would be judged by how long the program took.
        pattern: '^(?!runtime$)[A-Za-z0-9_.-]+$',
        'x-patternMessage':
          'must be letters, digits, "_", "." and "-", and not runtime, the sensor’s own channel',
        default: 'value',
        title: 'Primary channel',
        description:
          'The key of the channel this sensor is judged by. The program must return it every ' +
          'scan; the rest of what it returns becomes channels on their own the first time they ' +
          'appear. For a PRTG-format script this is the first channel’s name in lower case with ' +
          'spaces as underscores — “Free Space” is `free_space`. Not `runtime`, which is the ' +
          'sensor’s own: how long the program took.',
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

  // Not `declaresEveryChannel` (`P-320`, `P-350`).
  channelsFromWhatItReads:
    'every key but the primary and `runtime` is one the program printed, which no parameter names',

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const key = typeof params['primaryChannel'] === 'string' ? params['primaryChannel'] : 'value';
    const name = typeof params['primaryName'] === 'string' ? params['primaryName'].trim() : '';
    const unit = typeof params['primaryUnit'] === 'string' ? params['primaryUnit'] : '';
    return [
      { key, name: name === '' ? key : name, unit, isPrimary: true },
      { key: RUNTIME, name: 'Run time', unit: 'ms' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { parseAdvanced } = await import('../support/script/parse.js');
    const primary =
      typeof context.params['primaryChannel'] === 'string'
        ? context.params['primaryChannel']
        : 'value';

    const run = await runScript(context);
    const scrub = scrubberOf(context);
    const output = parseAdvanced(run.stdout, primary, scrub);

    // `runtime` is this sensor's own, so a script cannot overwrite it with something else — and
    // the message says so when it tried (`P-359`), since the reading is otherwise simply absent.
    const theirs = output.channels.some((channel) => channel.key === RUNTIME);
    const readings = output.channels
      .filter((channel) => channel.key !== RUNTIME)
      .map((channel) => ({
        key: channel.key,
        value: channel.value,
        ...(channel.name === undefined ? {} : { name: channel.name }),
        ...(channel.unit === undefined ? {} : { unit: channel.unit }),
      }));

    const message =
      output.message === ''
        ? `${String(readings.length)} channel${readings.length === 1 ? '' : 's'} in ` +
          `${String(run.durationMs)} ms`
        : output.message;
    return {
      channels: [...readings, { key: RUNTIME, value: run.durationMs }],
      message: theirs ? withRuntimeNotKept(message, scrub) : message,
    };
  },
};

/**
 * The message, saying that the program's own `runtime` reading was not kept (`P-359`).
 *
 * **In the message, as `P-292` says a channel the wire could not carry**: the person looking at
 * the sensor wonders why the program's number is not on it, and the sensor's page is where they
 * look. **Not the state**: the reading has been dropped since `T-19`, and a Warning for it would
 * change alarm volume for a script that otherwise works; renaming the channel is the fix, and a
 * state change does not make it. Named by key, which is this type's constant, never with the
 * value the program printed.
 *
 * **The note survives the wire's clip** (`RESULT_LIMITS.message`), as `withDropped`'s does: the
 * program's words end in the ellipsis instead, cut by that same clip, so an astral character
 * across the cut is left out whole rather than halved (`P-359` review). A clip of the program's words is scrubbed first
 * (`CheckContext.scrub`): a cut can leave half a secret the catalogue's scrub no longer finds.
 */
function withRuntimeNotKept(message: string, scrub: (text: string) => string): string {
  // `clipText` is the wire's own clip (`P-277`): never ends in half a surrogate pair, which
  // `fitResult` would store as U+FFFD.
  return (
    clipText(scrub(message), RESULT_LIMITS.message - RUNTIME_NOT_KEPT.length) + RUNTIME_NOT_KEPT
  );
}
