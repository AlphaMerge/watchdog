import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { sshParamsSchema } from '../support/ssh/schema.js';

/**
 * An arbitrary command or script over SSH (`T-08`).
 *
 * **The type that makes the long tail somebody else's problem**, the way `snmp.custom` does for
 * SNMP. `CAPABILITIES.MD §15` puts the full 250-sensor catalogue out of scope because the long
 * tail is vendor wrappers; anything a shell can measure is a sensor without anybody writing a
 * type for it.
 *
 * **The channels are declared here, not discovered from the output**, and that is a constraint
 * rather than a preference: `channels(params)` runs in the core before the sensor has ever run,
 * which is what lets a channel be created with a primary and a unit. A script that reports a key
 * nobody declared has its reading counted and named in the message rather than dropped — that is
 * how an operator finds out their script and their sensor have drifted apart.
 *
 * **A non-zero exit fails the check**, with whatever the script wrote to stderr. That is the
 * contract every monitoring script already assumes, and it means a script can refuse to answer —
 * "the database is not running, I cannot measure query time" — instead of reporting a zero that
 * would be graphed.
 */
const MAX_CHANNELS = 20;

interface Declared {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
}

function readChannels(params: Readonly<Record<string, unknown>>): Declared[] {
  const raw = params['channels'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const declared: Declared[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record['key'] === 'string' ? record['key'].trim() : '';
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    declared.push({
      key,
      name: name === '' ? key : name,
      unit: typeof record['unit'] === 'string' ? record['unit'] : '',
    });
  }
  return declared;
}

export const sshScript: SensorType = {
  id: 'ssh.script',
  category: 'SSH',
  // Holds a channel on a shared connection for as long as the script runs, which is the
  // operator's to decide. Not `heavy` — it is not a process on this machine.
  costHint: 'medium',
  credentialKinds: ['ssh'],
  // Where the set goes besides the host (`A-41`): the port.
  secretDestinations: { 'kind:ssh': ['port'] },

  paramsSchema: sshParamsSchema(
    {
      command: {
        type: 'string',
        minLength: 1,
        maxLength: 4_096,
        title: 'Command',
        description:
          'Run by the login shell on the device, so a pipeline and a redirect work. It should ' +
          'print one reading per line — “queue:12” — or a bare number, or a JSON object; see ' +
          'the sensor documentation. Exiting non-zero fails the check with whatever it wrote ' +
          'to standard error, which is how a script refuses to answer rather than reporting a ' +
          'zero somebody would graph.',
      },
      channels: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CHANNELS,
        title: 'Channels',
        description:
          'What the script reports. The keys have to match what it prints; the first is the one ' +
          'the sensor is judged by. A script printing a key that is not here is reported in the ' +
          'message rather than ignored, which is how you find out the two have drifted apart.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: {
            key: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              title: 'Key',
              description: 'As the script prints it. “value” is what a bare number is called.',
            },
            name: { type: 'string', maxLength: 200, default: '', title: 'Channel name' },
            unit: { type: 'string', maxLength: 50, default: '', title: 'Unit' },
          },
        },
      },
    },
    ['command', 'channels'],
  ),

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const declared = readChannels(params);
    if (declared.length === 0) {
      // Only reachable with no parameters: `channels` is required with at least one entry. The
      // catalogue asks every type for its shape with `{}` and wants exactly one primary.
      return [{ key: 'value', name: 'Value', isPrimary: true }];
    }
    return declared.map((channel, at) => ({
      key: channel.key,
      name: channel.name,
      unit: channel.unit,
      ...(at === 0 ? { isPrimary: true } : {}),
    }));
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { sshCheck, hostKeyNote, parseScriptOutput, clip } =
      await import('../support/ssh/index.js');

    const asked = context.params['command'];
    const command = typeof asked === 'string' ? asked.trim() : '';
    if (command === '') throw new Error('this sensor has no command to run');

    const declared = readChannels(context.params);
    if (declared.length === 0) throw new Error('this sensor declares no channels');
    const wanted = new Set(declared.map((channel) => channel.key));

    return sshCheck(context, async (session, signal) => {
      const result = await session.exec(command, signal);

      if (result.code !== 0) {
        // The script's own words, because it knows what went wrong and this type does not.
        const said = clip(result.stderr.trim() === '' ? result.stdout : result.stderr);
        throw new Error(
          `${command} exited ${String(result.code ?? -1)} on ${context.target.host}` +
            (said === '' ? '' : `: ${said}`),
        );
      }

      const output = parseScriptOutput(result.stdout);
      const notes: string[] = [];

      const readings: { key: string; value: number }[] = [];
      const reported = new Set<string>();
      for (const reading of output.readings) {
        reported.add(reading.key);
        if (!wanted.has(reading.key)) continue;
        readings.push({ key: reading.key, value: reading.value });
      }

      const extra = output.readings
        .filter((reading) => !wanted.has(reading.key))
        .map((reading) => reading.key);
      if (extra.length > 0) {
        notes.push(
          `the script also reported ${extra.join(', ')}, which this sensor has no channel for`,
        );
      }
      const missing = declared
        .filter((channel) => !reported.has(channel.key))
        .map((channel) => channel.key);
      if (missing.length > 0) {
        // Gapped rather than zeroed: a channel the script stopped printing is missing data, and
        // a zero would draw a reassuring flat line (CLAUDE.md).
        notes.push(`the script reported nothing for ${missing.join(', ')}`);
      }

      if (readings.length === 0) {
        throw new Error(
          `${command} produced no reading this sensor declares a channel for — it reported ` +
            (extra.length === 0 ? 'nothing' : extra.join(', ')),
        );
      }

      const message = [
        output.message === '' ? `${command} → ${String(readings.length)} readings` : output.message,
        ...notes,
        hostKeyNote(session, context.target.host),
      ].filter((part): part is string => part !== null && part !== '');

      return { channels: readings, message: message.join('; ') };
    });
  },
};
