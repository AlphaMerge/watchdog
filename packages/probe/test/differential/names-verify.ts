import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  digestOf,
  parseRun,
  recordingsFile,
  verify,
  type ImageRun,
  type RowsFile,
} from './names-differential.js';

/**
 * The differential's verdict (`P-432` S8): `names-verify <rows.json> <run.json>…`. Prints the
 * recordings file on stdout when every row of every image verified, and exits 0; otherwise prints
 * every problem on stderr and exits 1, with nothing on stdout. Every image the rows name must be
 * among the runs: an unverified row fails the run (D30). Each run must have replayed this rows file
 * and loaded this build of the policy (`dist/src/resolver/system-names.js`), by sha256. A run file
 * that is not a run (a replay that stopped leaves it empty) is a problem of its own, and the others
 * are judged all the same.
 */
const POLICY = fileURLToPath(new URL('../../src/resolver/system-names.js', import.meta.url));

const [rowsPath, ...runPaths] = process.argv.slice(2);
if (rowsPath === undefined || runPaths.length === 0) {
  process.stderr.write('usage: names-verify <rows.json> <run.json>...\n');
  process.exit(2);
}
const rowsBytes = readFileSync(rowsPath);
const rows = JSON.parse(rowsBytes.toString('utf8')) as RowsFile;
const runs: ImageRun[] = [];
const unread: string[] = [];
for (const path of runPaths) {
  const parsed = parseRun(path, readFileSync(path, 'utf8'));
  if ('run' in parsed) runs.push(parsed.run);
  else unread.push(parsed.problem);
}
const verified = verify(rows, runs, {
  rowsDigest: digestOf(rowsBytes),
  policyDigest: digestOf(readFileSync(POLICY)),
});
for (const [image, count] of Object.entries(verified.counts)) {
  process.stderr.write(
    `${image}: ${String(count.rows)} rows, ${String(count.plans)} plans recorded\n`,
  );
}
const problems = [...unread, ...verified.problems];
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`DISAGREES ${problem}\n`);
  process.stderr.write(`${String(problems.length)} problems: nothing recorded\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(recordingsFile(runs, verified), null, 2)}\n`);
