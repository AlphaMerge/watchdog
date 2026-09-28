import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AUDIT_CATEGORIES } from '../src/audit/store.js';

/**
 * The Logs view offers a chip for every category the core files entries under (`A-17`).
 *
 * **Read from the web source rather than imported**, because the two packages do not share code
 * and this is the one list that has to agree across them. It had not: the server gained
 * `credential` and `report` and the chips never did, so an administrator could not filter to a
 * credential change — the entry an audit log is most often opened to find.
 */
describe('audit categories', () => {
  it('are the same list, in the same order, on both sides', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const source = await readFile(
      join(repoRoot, 'packages', 'web', 'src', 'routes', 'LogsView.tsx'),
      'utf8',
    );
    const block = /const CATEGORIES = \[([^\]]*)\] as const;/u.exec(source);
    assert.ok(block !== null, 'LogsView.tsx no longer declares CATEGORIES where this looks');
    const web = [...(block[1] ?? '').matchAll(/'([a-z]+)'/gu)].map(([, name]) => name);
    assert.deepEqual(web, [...AUDIT_CATEGORIES]);
  });
});
