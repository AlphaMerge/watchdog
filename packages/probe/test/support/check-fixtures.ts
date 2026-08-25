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

      case 'test.throw':
        throw new Error('the check failed on purpose');

      case 'test.crash':
        // Takes the worker thread down mid-check.
        process.exit(7);
        break;

      default:
        break;
    }
    throw new Error(`no such check type: ${sensorType}`);
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
