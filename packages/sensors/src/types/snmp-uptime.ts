import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { SNMP_SECRET_DESTINATIONS, snmpParamsSchema } from '../support/snmp/schema.js';

/**
 * How long the device has been up, and whether it restarted (`T-05`).
 *
 * **`sysUpTime` is the wrong OID and is the one everybody reaches for.** It counts from the last
 * time the *network management subsystem* re-initialised, so restarting `snmpd` resets it while
 * the host keeps running. Measured on the dev target while writing this: `sysUpTime` said 32
 * hours and `hrSystemUptime` said 8.9 days, on a box that had not rebooted. A sensor built on
 * `sysUpTime` would have raised exactly the alarm this type exists to raise, falsely, on the
 * first device it was pointed at. So `hrSystemUptime` is preferred, `sysUpTime` is the fallback
 * for hardware with no HOST-RESOURCES-MIB, and both are read every scan because the *difference*
 * is a real event worth reporting.
 *
 * **Restart detection is a threshold trigger or a lower limit on `uptime`, and that is not a
 * compromise.** A restarted device has a small uptime; "notify when uptime is below 10 minutes"
 * is the condition, and the trigger engine already evaluates it with latency, escalation and
 * summarisation (`M-11`, `N-*`). Detecting the *transition* instead would mean the core keeping
 * a previous reading per channel and synthesising a value the probe never sent — real work, for
 * a strictly narrower answer, since a condition also catches a restart that happened while the
 * sensor was Down and a transition does not. What this type owes that setup is a channel in
 * **seconds** rather than raw ticks, which is what makes `below 600` mean ten minutes.
 */
export const snmpUptime: SensorType = {
  id: 'snmp.uptime',
  category: 'SNMP',
  costHint: 'light',
  secretDestinations: SNMP_SECRET_DESTINATIONS,
  credentialKinds: ['snmp'],
  pinnedKinds: ['snmp'],

  paramsSchema: snmpParamsSchema({}, []),

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(): readonly ChannelDef[] {
    return [
      {
        key: 'uptime',
        name: 'Uptime',
        unit: 's',
        isPrimary: true,
      },
      {
        // Separate rather than a note, because the gap between the two is the thing worth
        // alarming on: an agent that restarted by itself explains a hole in every other SNMP
        // sensor on the device, and nothing else in the system can say why.
        key: 'agentUptime',
        name: 'SNMP agent uptime',
        unit: 's',
      },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { snmpCheck, uptimeOf, humanDuration, TICKS_WRAP_DAYS } =
      await import('../support/snmp/index.js');

    return snmpCheck(context, async (session, signal) => {
      const uptime = await uptimeOf(session, signal);
      if (uptime === null) {
        throw new Error(
          `${context.target.host} answered neither hrSystemUptime nor sysUpTime — it is ` +
            'reachable over SNMP but reports no uptime at all, which is unusual enough to be ' +
            'worth checking the agent rather than the box',
        );
      }

      const notes: string[] = [];
      if (uptime.source === 'agent') {
        // Said out loud because it changes what the number *means*: on this device a restart of
        // the agent alone is indistinguishable from a reboot.
        notes.push(
          'this device has no hrSystemUptime, so this is the SNMP agent’s uptime — restarting ' +
            'the agent will look like a restart of the device',
        );
      } else if (uptime.agentSeconds !== null && uptime.agentSeconds + 60 < uptime.seconds) {
        notes.push(
          `the SNMP agent has been up ${humanDuration(uptime.agentSeconds)}, less than the ` +
            'host — the agent restarted on its own, which explains a gap in this device’s other ' +
            'SNMP sensors',
        );
      }

      if (uptime.seconds > TICKS_WRAP_DAYS * 86_400 * 0.98) {
        // The honest limit rather than a wrong correction: TimeTicks goes round at 2^32
        // centiseconds and the reading does not say how many times it has.
        notes.push(
          `this is near the ${String(TICKS_WRAP_DAYS)}-day point where the device’s counter ` +
            'goes round, after which the reading restarts from zero without the device having',
        );
      }

      const channels = [
        { key: 'uptime', value: uptime.seconds },
        ...(uptime.agentSeconds === null
          ? []
          : [{ key: 'agentUptime', value: uptime.agentSeconds }]),
      ];

      const bootedAt = new Date(Date.now() - uptime.seconds * 1_000);
      return {
        channels,
        message: [
          `up ${humanDuration(uptime.seconds)}, since ${bootedAt.toISOString().slice(0, 16)}Z`,
          ...notes,
        ].join('; '),
      };
    });
  },
};
