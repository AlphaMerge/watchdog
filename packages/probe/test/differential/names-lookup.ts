import { systemLookup, type SystemFamily } from '@ms/sensors/system-lookup';

/**
 * One `getaddrinfo`, as the probe makes it (`systemLookup`, the call behind `systemResolve` and the
 * lookup helper), in a process of its own: the differential's replay (`names-replay.ts`) runs one
 * per plan, so that each reads nsswitch.conf and gai.conf afresh. Prints `{ outcome, ms }`:
 * `answer:<count>`, or the error's code.
 */
const [name = '', familyText = '0'] = process.argv.slice(2);
const family = Number(familyText) as SystemFamily;
const started = performance.now();
let outcome: string;
try {
  outcome = `answer:${String((await systemLookup(name, family)).length)}`;
} catch (error: unknown) {
  const code = (error as { code?: unknown }).code;
  outcome = typeof code === 'string' ? code : String(error);
}
process.stdout.write(`${JSON.stringify({ outcome, ms: performance.now() - started })}\n`);
