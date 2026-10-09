import assert from 'node:assert/strict';
import type { CheckExecution } from '../../src/contract.js';
import { standardCatalogue } from '../../src/index.js';

const catalogue = standardCatalogue();

/**
 * That `typeId` promises every key it reports is one it declares, and that this execution kept
 * the promise (`P-310`, `P-320`).
 *
 * `params` are the ones the execution ran with, and the declaration is the catalogue's for them,
 * which is what the core asks when it decides a channel is retired. An execution that reported
 * nothing proves nothing, so it fails here too.
 */
export function assertDeclaresEveryKey(
  typeId: string,
  params: Readonly<Record<string, unknown>>,
  execution: CheckExecution,
): void {
  assert.equal(catalogue.declaration(typeId).declaresEveryChannel, true, `${typeId} is flagged`);
  const declared = new Set(catalogue.channelsFor(typeId, params).map((def) => def.key));
  assert.ok(execution.channels.length > 0, `${typeId} reported a reading`);
  for (const reading of execution.channels) {
    assert.ok(
      declared.has(reading.key),
      `${typeId} reported "${reading.key}", which channels() does not declare for ` +
        JSON.stringify(params),
    );
  }
}
