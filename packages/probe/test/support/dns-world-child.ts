import { systemLookup } from '@ms/sensors/system-lookup';
import { runHelperChild, type ChildLookup } from '../../src/resolver/lookup-helper-child.js';
import { glibcLookup, readWorld, WORLD_ENV } from './glibc-model.js';

/**
 * The lookup helper's child in the name gate's perf arms (`P-432` S7, §7.6): the production
 * child's `runHelperChild`, asking the perf world's `getaddrinfo` model (`glibc-model.ts`) in
 * place of the system's, so that the helper's questions reach the DNS simulator's forwarder as
 * the probe's own lanes' do. The world is read from `PERF_DNS_WORLD`.
 *
 * - Its self-test name, `127.1`, and every name of digits and dots, is the system's, as glibc
 *   parses those before NSS.
 * - A name the world's `crash` pattern matches crashes it, as a `getaddrinfo` that crashes on a
 *   name would (P6): a line on stderr, then SIGABRT from outside the runtime.
 */

const world = readWorld(process.env[WORLD_ENV]);
const model = glibcLookup({
  server: world.server,
  localAddress: world.localAddress,
  schedule: world.schedule,
});
const crash = world.crash === undefined ? undefined : new RegExp(world.crash, 'u');

const lookup: ChildLookup = (host, family) => {
  if (/^[\d.]+$/u.test(host)) return systemLookup(host, family);
  if (crash?.test(host) === true) {
    process.stderr.write(`perf crash: ${host}\n`);
    process.kill(process.pid, 'SIGABRT');
  }
  return model.lookup(host, family);
};

runHelperChild(lookup);
