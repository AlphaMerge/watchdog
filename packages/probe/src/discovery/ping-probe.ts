import { pingCommand, pingPlatform, parsePingOutput, runPing, summarise } from '@ms/sensors/ping';

/**
 * One address, one ping, one answer (`D-01`).
 *
 * Separate from `SweepRunner` so the sweep's scheduling — the cursor, the yielding, the token
 * bucket — is testable without a network, and so this is the one place that knows a sweep asks a
 * different question from a Ping sensor.
 *
 * **One packet, not the sensor's default of four.** A sweep asks "is anything here", and the
 * answer to that arrives on the first reply; the sensor asks "how healthy is this link", which
 * needs a sample. Four packets across a /16 is 262,136 packets and four times the wall clock for
 * an answer that has not improved.
 *
 * **A host that does not answer is not a host that is not there**, and this returns `null`
 * rather than pretending otherwise. Windows firewalls block ICMP by default, and so does any
 * hardened Linux build — `D-02` is where a non-answering address gets a second opinion from its
 * open ports. What this must not do is confuse "did not answer" with "could not be asked": a
 * missing `ping` binary or a network with no route throws, and the sweep counts those
 * separately, because a firewalled network and an empty one look identical otherwise.
 */
export async function pingOnce(
  address: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<number | null> {
  const { command, args } = pingCommand(
    pingPlatform(process.platform),
    { host: address, ipVersion: 'v4' },
    { count: 1, packetSize: 56, timeoutMs },
  );
  const run = await runPing(command, args, signal);
  const outcome = parsePingOutput(run.output, 1);
  // `times` holds one entry per *timed echo reply*, which is not what the summary line says:
  // `P-08` measured Windows reporting `Received = 2, Lost = 0` for a host that is not there,
  // because it counts a "Destination host unreachable" as received. Believing the summary would
  // put every unreachable address in a sweep's found list.
  if (outcome.times.length === 0) return null;
  return summarise(outcome).rttMs;
}
