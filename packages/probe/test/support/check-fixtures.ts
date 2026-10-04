import { resourceLimits } from 'node:worker_threads';
import type { CheckContext, CheckExecution, CheckRegistry } from '../../src/runner/types.js';

/**
 * Checks that behave badly on purpose.
 *
 * These live in the test tree rather than in shipped code because the pool imports its registry
 * by path — which is exactly what makes "a check that ignores its abort signal" testable without
 * a check that ignores its abort signal existing in the product.
 */
const registry: CheckRegistry = {
  async execute(sensorType: string, context: CheckContext): Promise<CheckExecution> {
    const delayMs = Number(context.params['delayMs'] ?? 20);

    switch (sensorType) {
      case 'test.ok':
        return {
          channels: [{ key: 'value', value: 42, name: 'Value', unit: 'ms' }],
          message: 'all well',
        };

      case 'test.slow':
        // Honours the signal, which is what CLAUDE.md requires of every check.
        await abortable(delayMs, context.signal);
        return { channels: [{ key: 'value', value: delayMs }], message: 'eventually' };

      case 'test.hang':
        // Does not. The case termination exists for.
        await new Promise<never>(() => {
          /* forever */
        });
        throw new Error('unreachable');

      case 'test.stuck':
        // Also does not — and holds the event loop while it refuses, which `test.hang` does not.
        // In a *worker* that distinction does not exist: the thread stays alive for messages
        // either way. In a *process* it is everything, because a Node process whose loop empties
        // simply exits, so an unsettled promise with no handles is not a hang at all. This is the
        // one the kill timer is actually for.
        await new Promise<never>(() => {
          setInterval(() => {
            /* keeps this process alive, and ignores the abort signal on purpose */
          }, 50);
        });
        throw new Error('unreachable');

      case 'test.throw':
        throw new Error('the check failed on purpose');

      case 'test.withheld':
        // What `@ms/sensors` raises when a check may not use its credentials where its device
        // points (`A-41c`). The same code, so the runners classify it the same way.
        throw Object.assign(new Error('Not scanned: outside the allowed targets'), {
          code: 'CREDENTIALS_WITHHELD',
        });

      case 'test.resolve-hangs':
        // A name that has to be checked against a set's address targets, and a resolver that
        // never answers (`A-41c`). The real `pinTarget`, as the catalogue calls it before a type
        // runs, with the timeout the runner handed the check.
        //
        // Imported here and not at the top: these tests time how fast a worker and a process
        // start, and a fixture that loaded `@ms/shared`'s validators into every one of them made
        // five of those tests fail. By its own path for the same reason: the package's index
        // loads every sensor type and its libraries.
        await (
          await import('@ms/sensors/pinned-target')
        ).pinTarget(
          {
            sensorId: context.sensorId,
            target: { host: 'switch.invalid', ipVersion: 'auto' },
            credentials: { snmp: { community: 'public', allowedTargets: ['10.20.0.0/16'] } },
            pinnedKinds: ['snmp'],
            signal: context.signal,
            ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
          },
          () =>
            new Promise<never>(() => {
              /* a resolver that is not answering */
            }),
        );
        throw new Error('unreachable');

      case 'test.load-resolver':
        // Loads what `test.resolve-hangs` imports, and nothing else, so that a test can load it
        // into a worker before the check it times (`P-258`). A probe's worker has its catalogue,
        // `pinTarget` included, loaded before it says ready, so the check's timeout and the
        // resolution's bound start within a millisecond of each other. The import above starts
        // the resolution's bound only once it is done, and on a loaded machine it took up to 5.7 s
        // of a 6 s check.
        await import('@ms/sensors/pinned-target');
        return { channels: [{ key: 'value', value: 1 }], message: 'loaded' };

      case 'test.limits':
        // What the thread running this check was started with (`P-207`). `resourceLimits` is empty
        // in the main thread, which is how a test tells a worker that was capped from one that was
        // not.
        return {
          channels: [{ key: 'youngMb', value: resourceLimits.maxYoungGenerationSizeMb ?? 0 }],
          message: 'limits',
        };

      case 'test.crash':
        // Takes the worker thread down mid-check.
        process.exit(7);
        break;

      case 'test.uncaught':
        // Also takes the thread down, but by the *other* route, and the difference is the whole
        // of `P-73`. `process.exit` fires `exit` alone; an uncaught exception fires `error` and
        // then `exit`, so a pool that treats both as "a worker died" counts one death twice and
        // spawns two replacements for it.
        setTimeout(() => {
          throw new Error('a library threw where nobody could catch it');
        }, 5);
        await new Promise<never>(() => {
          /* until the throw above takes the thread down */
        });
        throw new Error('unreachable');

      case 'test.abort':
        // A *hard* crash — SIGABRT, which is what a native module segfaulting looks like from the
        // outside. `P-03` exists for this one: a worker thread cannot survive it and takes the
        // whole probe with it, where a child process is one dead process and one Down sensor.
        process.abort();
        break;

      case 'test.print':
        // A library that prints. Sensor types must not (CLAUDE.md), but the modules they import
        // do, and the process runner's result marker has to survive it.
        process.stdout.write('a third-party module says hello\n');
        return { channels: [{ key: 'value', value: 1 }], message: 'printed anyway' };

      case 'test.spoof':
        // Prints something that looks like the runner's own protocol before returning a real
        // answer. A check that runs somebody's script can end up echoing text it does not
        // control, and the runner must take the *last* marker rather than the first.
        process.stdout.write('ms-check-result:{"ok":true,"durationMs":0,"message":"spoofed"}\n');
        return { channels: [{ key: 'value', value: 2 }], message: 'the real answer' };

      case 'test.echo':
        // Hands back what the check was given, so a test can prove credentials arrived without
        // ever appearing in argv.
        return {
          channels: [
            { key: 'params', value: Object.keys(context.params).length },
            { key: 'credentials', value: Object.keys(context.credentials).length },
            { key: 'sensorId', value: context.sensorId },
          ],
          message: JSON.stringify({
            host: context.target.host,
            kinds: Object.keys(context.credentials).sort(),
            secret:
              typeof context.credentials['test']?.['password'] === 'string'
                ? context.credentials['test']['password']
                : '',
          }),
        };

      default:
        break;
    }
    // Same signal the real registry raises, so the pool classifies it the same way: a type
    // nothing has registered is a configuration error, not a check that failed.
    throw Object.assign(new Error(`no such check type: ${sensorType}`), {
      code: 'UNKNOWN_SENSOR_TYPE',
    });
  },
};

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

export default registry;
