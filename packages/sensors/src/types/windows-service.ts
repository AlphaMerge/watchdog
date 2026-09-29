import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { WINDOWS_SCHEMA, fieldNumber, fieldText, queryCim } from './windows-shared.js';

/**
 * Whether a Windows service is running (`T-10`).
 *
 * **One service, one sensor**, which is PRTG's model and the right one here: an alarm that says
 * "a service on this machine is stopped" sends somebody to look, where an alarm that names the
 * service sends somebody to fix it. A machine with four services worth watching is four sensors
 * and four independently acknowledgeable alarms.
 *
 * **It does not restart anything.** A monitoring system that restarts a service turns an
 * incident into an intermittent one — the service dies, is restarted, and the graph shows a
 * blip nobody investigates until the fourth time. The state history is the record that makes
 * "it has restarted itself eleven times this week" a visible fact.
 *
 * **Start mode is a second channel and not a threshold.** A service set to Manual and stopped is
 * a machine working as configured; the same service set to Automatic and stopped is an
 * incident. `expected` is the channel that carries that difference, so an operator sets one
 * limit rather than remembering which services are which.
 */

export const windowsService: SensorType = {
  id: 'windows.service',
  category: 'Windows',
  costHint: 'medium',
  credentialKinds: ['windows'],
  // Where the set goes besides the host (`A-41`): another machine, or Basic, which sends the
  // password itself.
  secretDestinations: { 'kind:windows': ['authentication', 'host'] },

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['service'],
    properties: {
      ...WINDOWS_SCHEMA,
      service: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        title: 'Service name',
        description:
          'The service *name*, not its display name — `Spooler`, not `Print Spooler`. ' +
          '`Get-Service | Select Name, DisplayName` on the machine lists both. The display name ' +
          'is localised and changes with the machine’s language; the name does not.',
        // Defence in depth (`S-21`): the name never enters the script, but no service needs a
        // quote of any kind, a backtick, a slash or a control character, and each is something
        // PowerShell or WQL reads. `$` stays: `MSSQL$SQLEXPRESS` is an ordinary service name.
        pattern: String.raw`^[^'"\u0060\u2018-\u201F\\/\u0000-\u001F\u007F]+$`,
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [
      { key: 'running', name: 'Running', unit: '', isPrimary: true },
      { key: 'expected', name: 'Running as configured', unit: '' },
      { key: 'processId', name: 'Process id', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const service =
      typeof context.params['service'] === 'string' ? context.params['service'].trim() : '';
    if (service === '') throw new Error('this sensor names no service to check');

    const rows = await queryCim(
      context,
      'Win32_Service',
      ['Name', 'DisplayName', 'State', 'StartMode', 'Status', 'ProcessId'],
      { field: 'Name', equals: service },
    );
    const row = rows[0];
    if (row === undefined) {
      // Not installed is a failed check rather than a reading of nought: a service that was
      // uninstalled and one that is stopped need different people, and reporting 0 would make
      // them look identical on the graph for ever after.
      throw new Error(
        `there is no service called "${service}" on this machine — the name is not the display ` +
          'name, so `Get-Service | Select Name, DisplayName` is where to check the spelling',
      );
    }

    const state = fieldText(row, 'State');
    const startMode = fieldText(row, 'StartMode');
    const running = state === 'Running' ? 1 : 0;
    // `Auto` in `Win32_Service.StartMode`, and `Automatic` in some documentation and in
    // `Get-Service`. Both are accepted rather than one being right.
    const shouldRun = startMode === 'Auto' || startMode === 'Automatic';
    const processId = fieldNumber(row, 'ProcessId');

    return {
      channels: [
        { key: 'running', value: running },
        // 1 when the service is doing what its configuration says it should. A Manual service
        // that is stopped scores 1; an Automatic one that is stopped scores 0, and that is the
        // channel a single limit goes on across an estate of mixed configurations.
        { key: 'expected', value: shouldRun === (running === 1) ? 1 : 0 },
        ...(processId === null || processId === 0 ? [] : [{ key: 'processId', value: processId }]),
      ],
      message:
        `${fieldText(row, 'DisplayName') || service} is ${state || 'in an unknown state'}` +
        ` (start mode ${startMode || 'unknown'})` +
        (fieldText(row, 'Status') === 'OK' || fieldText(row, 'Status') === ''
          ? ''
          : `, status ${fieldText(row, 'Status')}`),
    };
  },
};
