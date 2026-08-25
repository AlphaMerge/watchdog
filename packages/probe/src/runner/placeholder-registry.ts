import type { CheckContext, CheckExecution, CheckRegistry } from './types.js';

/**
 * The registry a probe has until `P-05` ships the real one.
 *
 * It refuses everything, by name. A probe running this cannot check anything — which is the
 * truth, and better said out loud than discovered as a missing function at the first scan.
 */
const placeholder: CheckRegistry = {
  execute(sensorType: string, _context: CheckContext): Promise<CheckExecution> {
    return Promise.reject(
      new Error(
        `no sensor type registry is installed, so "${sensorType}" cannot run (P-05 provides it)`,
      ),
    );
  },
};

export default placeholder;
